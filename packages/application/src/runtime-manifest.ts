import {
  InvalidDomainValueError,
  defineRuntimeManifestObservation,
  parseGatewayId,
  parseProjectId,
  parseRuntimeManifestGeneration,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";
import type {
  AetherRuntimeManifestV1,
  GatewayId,
  ProjectId,
  RuntimeManifestObservation,
  TenantId,
  UtcInstant,
} from "@aether-cloud/domain";

import {
  GET_GATEWAY_RUNTIME_MANIFEST_QUERY,
  REPORT_GATEWAY_RUNTIME_MANIFEST_COMMAND,
} from "./capability-definition.js";
import type {
  GatewayCredentialAssertion,
  GatewayCredentialVerifier,
} from "./cloudlink-session-repository.js";
import type { ApplicationClock } from "./gateway-identity-repository.js";
import type {
  RuntimeManifestIntegrityVerifier,
  RuntimeManifestRepository,
  RuntimeManifestScope,
} from "./runtime-manifest-repository.js";

type RuntimeManifestFailureCode =
  | "command-expired"
  | "gateway-credential-inactive"
  | "idempotency-conflict"
  | "invalid-gateway-credential"
  | "invalid-input"
  | "permission-denied"
  | "runtime-manifest-generation-conflict"
  | "runtime-manifest-integrity-failed"
  | "runtime-manifest-not-found";

export interface RuntimeManifestApplicationFailure {
  readonly code: RuntimeManifestFailureCode;
  readonly message: string;
}

export type RuntimeManifestApplicationResult<Value> =
  | Readonly<{ ok: true; replayed: boolean; value: Value }>
  | Readonly<{ ok: false; failure: RuntimeManifestApplicationFailure }>;

export type RuntimeManifestQueryResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: RuntimeManifestApplicationFailure }>;

export interface RuntimeManifestView {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly generation: string;
  readonly observedAt: UtcInstant;
  readonly receivedAt: UtcInstant;
  readonly schemaVersion: 1;
  readonly composition: string;
  readonly aetherVersion: string;
  readonly targetTriple: string;
  readonly targetOs: AetherRuntimeManifestV1["targetOs"];
  readonly services: readonly string[];
  readonly cargoFeatures: readonly string[];
  readonly capabilities: readonly string[];
  readonly protocols: readonly string[];
  readonly checksum: AetherRuntimeManifestV1["checksum"];
}

export interface ReportRuntimeManifestValue extends RuntimeManifestView {
  readonly disposition: "accepted-late" | "accepted-latest" | "replayed";
}

interface ManifestCommandContext {
  readonly requestId: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

interface ManifestQueryContext extends RuntimeManifestScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
}

class RuntimeManifestInputError extends Error {}

const manifestKeys = Object.freeze([
  "aether_version",
  "capabilities",
  "cargo_features",
  "checksum",
  "composition",
  "protocols",
  "schema_version",
  "services",
  "target_os",
  "target_triple",
] as const);

function failure(
  code: RuntimeManifestFailureCode,
  message: string,
): Readonly<{ ok: false; failure: RuntimeManifestApplicationFailure }> {
  return { ok: false, failure: { code, message } };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function requireRecord(input: unknown, name: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new RuntimeManifestInputError(`${name} must be an object`);
  }
  return input;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(record).sort();
  const canonicalExpected = [...expected].sort();
  if (
    actual.length !== canonicalExpected.length ||
    actual.some((key, index) => key !== canonicalExpected[index])
  ) {
    throw new RuntimeManifestInputError(
      `${name} must contain exactly: ${canonicalExpected.join(", ")}`,
    );
  }
}

function requireString(input: unknown, name: string, maximum = 128): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > maximum
  ) {
    throw new RuntimeManifestInputError(
      `${name} must be a non-empty bounded string`,
    );
  }
  return input;
}

function requireStringArray(
  input: unknown,
  name: string,
  maximum = 256,
): readonly string[] {
  if (!Array.isArray(input) || input.length > maximum) {
    throw new RuntimeManifestInputError(
      `${name} must contain at most ${String(maximum)} strings`,
    );
  }
  return input.map((value) => requireString(value, name, 256));
}

function parseRequestId(input: unknown): string {
  const value = requireString(input, "idempotencyKey");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new RuntimeManifestInputError(
      "idempotencyKey must be an opaque 8-128 character identifier",
    );
  }
  return value;
}

function decodeCommandContext(input: unknown): ManifestCommandContext {
  const record = requireRecord(input, "command context");
  requireExactKeys(
    record,
    ["expiresAt", "idempotencyKey", "issuedAt"],
    "command context",
  );
  return {
    requestId: parseRequestId(record.idempotencyKey),
    issuedAt: parseUtcInstant(record.issuedAt),
    expiresAt: parseUtcInstant(record.expiresAt),
  };
}

function decodeCredential(input: unknown): GatewayCredentialAssertion {
  const record = requireRecord(input, "gateway credential");
  requireExactKeys(record, ["credentialId", "proof"], "gateway credential");
  return {
    credentialId: requireString(record.credentialId, "credentialId", 256),
    proof: requireString(record.proof, "credential proof", 4096),
  };
}

function targetMatchesTriple(
  targetOs: AetherRuntimeManifestV1["targetOs"],
  targetTriple: string,
): boolean {
  return targetOs === "macos"
    ? targetTriple.includes("apple-darwin")
    : targetTriple.includes(`-${targetOs}`);
}

function decodeManifest(input: unknown): AetherRuntimeManifestV1 {
  const record = requireRecord(input, "runtime manifest");
  requireExactKeys(record, manifestKeys, "runtime manifest");
  if (record.schema_version !== 1) {
    throw new RuntimeManifestInputError("schema_version must be 1");
  }
  const checksum = requireRecord(record.checksum, "runtime manifest checksum");
  requireExactKeys(
    checksum,
    ["algorithm", "digest"],
    "runtime manifest checksum",
  );
  if (checksum.algorithm !== "sha256") {
    throw new RuntimeManifestInputError("checksum algorithm must be sha256");
  }
  const targetOs = requireString(record.target_os, "target_os");
  if (
    !(["freebsd", "linux", "macos", "windows"] as const).some(
      (candidate) => candidate === targetOs,
    )
  ) {
    throw new RuntimeManifestInputError("target_os is unsupported");
  }
  const typedTargetOs = targetOs as AetherRuntimeManifestV1["targetOs"];
  const targetTriple = requireString(
    record.target_triple,
    "target_triple",
    256,
  );
  if (!targetMatchesTriple(typedTargetOs, targetTriple)) {
    throw new RuntimeManifestInputError(
      "target_os must agree with target_triple",
    );
  }
  const manifest: AetherRuntimeManifestV1 = {
    schemaVersion: 1,
    composition: requireString(record.composition, "composition", 256),
    aetherVersion: requireString(record.aether_version, "aether_version"),
    targetTriple,
    targetOs: typedTargetOs,
    services: requireStringArray(record.services, "services"),
    cargoFeatures: requireStringArray(record.cargo_features, "cargo_features"),
    capabilities: requireStringArray(record.capabilities, "capabilities"),
    protocols: requireStringArray(record.protocols, "protocols"),
    checksum: {
      algorithm: "sha256",
      digest: requireString(checksum.digest, "checksum.digest", 64),
    },
  };
  if (
    new TextEncoder().encode(JSON.stringify(record)).byteLength >
    256 * 1024
  ) {
    throw new RuntimeManifestInputError(
      "runtime manifest exceeds the 256 KiB edge contract limit",
    );
  }
  return manifest;
}

function decodeQueryContext(input: unknown): ManifestQueryContext {
  const record = requireRecord(input, "query context");
  requireExactKeys(
    record,
    ["permissions", "projectId", "subjectId", "tenantId"],
    "query context",
  );
  if (
    !Array.isArray(record.permissions) ||
    record.permissions.some((permission) => typeof permission !== "string")
  ) {
    throw new RuntimeManifestInputError(
      "permissions must be an array of strings",
    );
  }
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
    subjectId: requireString(record.subjectId, "subjectId"),
    permissions: new Set(record.permissions),
  };
}

function decodeSafely<Value>(
  decoder: () => Value,
):
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: RuntimeManifestApplicationFailure }> {
  try {
    return { ok: true, value: decoder() };
  } catch (error: unknown) {
    if (
      error instanceof InvalidDomainValueError ||
      error instanceof RuntimeManifestInputError
    ) {
      return {
        ok: false,
        failure: { code: "invalid-input", message: error.message },
      };
    }
    throw error;
  }
}

function validateCommandTime(
  context: ManifestCommandContext,
  now: UtcInstant,
): RuntimeManifestApplicationFailure | undefined {
  if (context.expiresAt <= context.issuedAt || context.issuedAt > now) {
    return { code: "invalid-input", message: "command time window is invalid" };
  }
  if (now >= context.expiresAt) {
    return { code: "command-expired", message: "command has expired" };
  }
  return undefined;
}

function toView(observation: RuntimeManifestObservation): RuntimeManifestView {
  return {
    tenantId: observation.tenantId,
    projectId: observation.projectId,
    gatewayId: observation.gatewayId,
    generation: observation.generation,
    observedAt: observation.observedAt,
    receivedAt: observation.receivedAt,
    schemaVersion: observation.manifest.schemaVersion,
    composition: observation.manifest.composition,
    aetherVersion: observation.manifest.aetherVersion,
    targetTriple: observation.manifest.targetTriple,
    targetOs: observation.manifest.targetOs,
    services: observation.manifest.services,
    cargoFeatures: observation.manifest.cargoFeatures,
    capabilities: observation.manifest.capabilities,
    protocols: observation.manifest.protocols,
    checksum: observation.manifest.checksum,
  };
}

export class ReportGatewayRuntimeManifest {
  static readonly definition = REPORT_GATEWAY_RUNTIME_MANIFEST_COMMAND;

  readonly #repository: RuntimeManifestRepository;
  readonly #credentialVerifier: GatewayCredentialVerifier;
  readonly #integrityVerifier: RuntimeManifestIntegrityVerifier;
  readonly #clock: ApplicationClock;

  constructor(dependencies: {
    readonly repository: RuntimeManifestRepository;
    readonly credentialVerifier: GatewayCredentialVerifier;
    readonly integrityVerifier: RuntimeManifestIntegrityVerifier;
    readonly clock: ApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#credentialVerifier = dependencies.credentialVerifier;
    this.#integrityVerifier = dependencies.integrityVerifier;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<RuntimeManifestApplicationResult<ReportRuntimeManifestValue>> {
    const decoded = decodeSafely(() => {
      const context = decodeCommandContext(rawContext);
      const input = requireRecord(rawInput, "runtime manifest report");
      requireExactKeys(
        input,
        ["credential", "generation", "manifest", "observedAt"],
        "runtime manifest report",
      );
      return {
        context,
        credential: decodeCredential(input.credential),
        generation: parseRuntimeManifestGeneration(input.generation),
        observedAt: parseUtcInstant(input.observedAt),
        manifest: decodeManifest(input.manifest),
      };
    });
    if (!decoded.ok) return decoded;
    const now = this.#clock.now();
    const timeFailure = validateCommandTime(decoded.value.context, now);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    if (decoded.value.observedAt > now) {
      return failure("invalid-input", "observedAt cannot be in the future");
    }
    const verified = await this.#credentialVerifier.verify(
      decoded.value.credential,
    );
    if (!verified.ok) {
      return failure(
        "invalid-gateway-credential",
        "Gateway credential was rejected",
      );
    }
    if (verified.value.status !== "active") {
      return failure(
        "gateway-credential-inactive",
        "Gateway credential is not active",
      );
    }
    if (!(await this.#integrityVerifier.verify(decoded.value.manifest))) {
      return failure(
        "runtime-manifest-integrity-failed",
        "runtime manifest checksum does not match its canonical payload",
      );
    }
    const observation = defineRuntimeManifestObservation({
      tenantId: verified.value.tenantId,
      projectId: verified.value.projectId,
      gatewayId: verified.value.gatewayId,
      generation: decoded.value.generation,
      observedAt: decoded.value.observedAt,
      receivedAt: now,
      manifest: decoded.value.manifest,
    });
    const recorded = await this.#repository.record({
      requestId: decoded.value.context.requestId,
      observation,
    });
    if (recorded.outcome === "idempotency-conflict") {
      return failure(
        "idempotency-conflict",
        "idempotency key was reused with different manifest input",
      );
    }
    if (recorded.outcome === "generation-conflict") {
      return failure(
        "runtime-manifest-generation-conflict",
        "runtime manifest generation was reused with different content",
      );
    }
    const disposition =
      recorded.outcome === "replayed"
        ? "replayed"
        : recorded.outcome === "recorded-late"
          ? "accepted-late"
          : "accepted-latest";
    return {
      ok: true,
      replayed: disposition === "replayed",
      value: { disposition, ...toView(observation) },
    };
  }
}

export class GetGatewayRuntimeManifest {
  static readonly definition = GET_GATEWAY_RUNTIME_MANIFEST_QUERY;

  readonly #repository: RuntimeManifestRepository;

  constructor(dependencies: {
    readonly repository: RuntimeManifestRepository;
  }) {
    this.#repository = dependencies.repository;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<RuntimeManifestQueryResult<RuntimeManifestView>> {
    const decoded = decodeSafely(() => {
      const context = decodeQueryContext(rawContext);
      const input = requireRecord(rawInput, "runtime manifest query");
      requireExactKeys(input, ["gatewayId"], "runtime manifest query");
      return { context, gatewayId: parseGatewayId(input.gatewayId) };
    });
    if (!decoded.ok) return decoded;
    if (
      !decoded.value.context.permissions.has(
        GET_GATEWAY_RUNTIME_MANIFEST_QUERY.permission,
      )
    ) {
      return failure(
        "permission-denied",
        `permission ${GET_GATEWAY_RUNTIME_MANIFEST_QUERY.permission} is required`,
      );
    }
    const observation = await this.#repository.findCurrent(
      decoded.value.context,
      decoded.value.gatewayId,
    );
    return observation === undefined
      ? failure("runtime-manifest-not-found", "runtime manifest was not found")
      : { ok: true, value: toView(observation) };
  }
}
