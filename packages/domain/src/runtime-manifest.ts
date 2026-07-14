import { InvalidDomainValueError } from "./resource-identities.js";
import type {
  GatewayId,
  ProjectId,
  TenantId,
  UtcInstant,
} from "./resource-identities.js";

const canonicalUint64Pattern = /^(?:0|[1-9][0-9]*)$/;
const maximumUint64 = 18_446_744_073_709_551_615n;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const cargoFeaturePattern = /^aether-io\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const semverPattern =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

declare const runtimeManifestGenerationBrand: unique symbol;
export type RuntimeManifestGeneration = string & {
  readonly [runtimeManifestGenerationBrand]: true;
};

export type RuntimeTargetOs = "freebsd" | "linux" | "macos" | "windows";

export interface AetherRuntimeManifestV1 {
  readonly schemaVersion: 1;
  readonly composition: string;
  readonly aetherVersion: string;
  readonly targetTriple: string;
  readonly targetOs: RuntimeTargetOs;
  readonly services: readonly string[];
  readonly cargoFeatures: readonly string[];
  readonly capabilities: readonly string[];
  readonly protocols: readonly string[];
  readonly checksum: Readonly<{
    algorithm: "sha256";
    digest: string;
  }>;
}

export interface RuntimeManifestObservation {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly generation: RuntimeManifestGeneration;
  readonly observedAt: UtcInstant;
  readonly receivedAt: UtcInstant;
  readonly manifest: AetherRuntimeManifestV1;
}

export type RuntimeManifestReportClassification =
  | Readonly<{
      ok: true;
      disposition: "accepted-late" | "accepted-latest" | "replayed";
      updatesLatest: boolean;
    }>
  | Readonly<{
      ok: false;
      failure: Readonly<{
        code: "runtime-manifest-generation-conflict";
        message: string;
      }>;
    }>;

export function parseRuntimeManifestGeneration(
  input: unknown,
): RuntimeManifestGeneration {
  if (
    typeof input !== "string" ||
    !canonicalUint64Pattern.test(input) ||
    BigInt(input) > maximumUint64
  ) {
    throw new InvalidDomainValueError(
      "runtimeManifestGeneration",
      "runtimeManifestGeneration must be a canonical unsigned 64-bit decimal string",
    );
  }
  return input as RuntimeManifestGeneration;
}

function validateIdentifier(value: string, field: string): void {
  if (!identifierPattern.test(value)) {
    throw new InvalidDomainValueError(
      field,
      `${field} must contain a valid Aether runtime identifier`,
    );
  }
}

function canonicalIdentifiers(
  values: readonly string[],
  field: string,
  requireNonEmpty = false,
): readonly string[] {
  if (requireNonEmpty && values.length === 0) {
    throw new InvalidDomainValueError(field, `${field} cannot be empty`);
  }
  for (const value of values) validateIdentifier(value, field);
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous === undefined ||
      current === undefined ||
      previous >= current
    ) {
      throw new InvalidDomainValueError(
        field,
        `${field} must be unique and sorted canonically`,
      );
    }
  }
  return Object.freeze([...values]);
}

function canonicalCargoFeatures(values: readonly string[]): readonly string[] {
  for (const value of values) {
    if (!cargoFeaturePattern.test(value)) {
      throw new InvalidDomainValueError(
        "cargoFeatures",
        "cargoFeatures must use package-qualified aether-io identifiers",
      );
    }
  }
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous === undefined ||
      current === undefined ||
      previous >= current
    ) {
      throw new InvalidDomainValueError(
        "cargoFeatures",
        "cargoFeatures must be unique and sorted canonically",
      );
    }
  }
  return Object.freeze([...values]);
}

function isRuntimeManifestSchemaVersion(value: unknown): value is 1 {
  return value === 1;
}

function isSha256Algorithm(value: unknown): value is "sha256" {
  return value === "sha256";
}

function defineManifest(
  input: AetherRuntimeManifestV1,
): AetherRuntimeManifestV1 {
  if (!isRuntimeManifestSchemaVersion(input.schemaVersion)) {
    throw new InvalidDomainValueError(
      "schemaVersion",
      "only Aether runtime manifest schema version 1 is supported",
    );
  }
  validateIdentifier(input.composition, "composition");
  validateIdentifier(input.targetTriple, "targetTriple");
  if (!semverPattern.test(input.aetherVersion)) {
    throw new InvalidDomainValueError(
      "aetherVersion",
      "aetherVersion must be a semantic version",
    );
  }
  if (
    !(["freebsd", "linux", "macos", "windows"] as const).includes(
      input.targetOs,
    )
  ) {
    throw new InvalidDomainValueError(
      "targetOs",
      "targetOs is not supported by runtime manifest v1",
    );
  }
  if (
    !isSha256Algorithm(input.checksum.algorithm) ||
    !sha256Pattern.test(input.checksum.digest)
  ) {
    throw new InvalidDomainValueError(
      "checksum",
      "runtime manifest checksum must be lowercase SHA-256",
    );
  }
  const services = canonicalIdentifiers(input.services, "services", true);
  const cargoFeatures = canonicalCargoFeatures(input.cargoFeatures);
  const capabilities = canonicalIdentifiers(input.capabilities, "capabilities");
  const protocols = canonicalIdentifiers(input.protocols, "protocols", true);
  return Object.freeze({
    ...input,
    services,
    cargoFeatures,
    capabilities,
    protocols,
    checksum: Object.freeze({ ...input.checksum }),
  });
}

export function defineRuntimeManifestObservation(input: {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly generation: RuntimeManifestGeneration;
  readonly observedAt: UtcInstant;
  readonly receivedAt: UtcInstant;
  readonly manifest: AetherRuntimeManifestV1;
}): RuntimeManifestObservation {
  return Object.freeze({ ...input, manifest: defineManifest(input.manifest) });
}

export function classifyRuntimeManifestReport(
  current: RuntimeManifestObservation | undefined,
  candidate: RuntimeManifestObservation,
): RuntimeManifestReportClassification {
  if (current === undefined) {
    return {
      ok: true,
      disposition: "accepted-latest",
      updatesLatest: true,
    };
  }
  const currentGeneration = BigInt(current.generation);
  const candidateGeneration = BigInt(candidate.generation);
  if (candidateGeneration === currentGeneration) {
    if (
      candidate.manifest.checksum.digest === current.manifest.checksum.digest
    ) {
      return { ok: true, disposition: "replayed", updatesLatest: false };
    }
    return {
      ok: false,
      failure: {
        code: "runtime-manifest-generation-conflict",
        message:
          "runtime manifest generation was reused with different content",
      },
    };
  }
  return candidateGeneration > currentGeneration
    ? {
        ok: true,
        disposition: "accepted-latest",
        updatesLatest: true,
      }
    : { ok: true, disposition: "accepted-late", updatesLatest: false };
}
