import {
  ArtifactTransitionError,
  InvalidDomainValueError,
  defineArtifactRevisionDraft,
  parseArtifactContentLength,
  parseArtifactId,
  parseArtifactRevisionId,
  parseArtifactRevisionNumber,
  parseContentDigest,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  publishArtifactRevision as publishRevisionInDomain,
  validateArtifactRevision,
} from "@aether-cloud/domain";
import type {
  ArtifactCompatibility,
  ArtifactKind,
  ArtifactRevision,
  ArtifactRevisionId,
  ArtifactSignature,
  UtcInstant,
} from "@aether-cloud/domain";

import {
  GET_ARTIFACT_REVISION_QUERY,
  PUBLISH_ARTIFACT_REVISION_COMMAND,
} from "./capability-definition.js";
import type {
  ArtifactContentStore,
  ArtifactRegistryRepository,
  ArtifactScope,
  ArtifactSignatureVerifier,
} from "./artifact-registry-repository.js";

type ArtifactApplicationFailureCode =
  | "artifact-channel-conflict"
  | "artifact-content-not-found"
  | "artifact-digest-mismatch"
  | "artifact-idempotency-conflict"
  | "artifact-not-found"
  | "artifact-revision-conflict"
  | "artifact-signature-invalid"
  | "artifact-storage-unavailable"
  | "command-expired"
  | "confirmation-required"
  | "invalid-input"
  | "permission-denied";

export interface ArtifactApplicationFailure {
  readonly code: ArtifactApplicationFailureCode;
  readonly message: string;
}

export type ArtifactApplicationResult<Value> =
  | Readonly<{ ok: true; replayed: boolean; value: Value }>
  | Readonly<{ ok: false; failure: ArtifactApplicationFailure }>;

export type ArtifactQueryResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: ArtifactApplicationFailure }>;

export interface ArtifactRevisionView {
  readonly artifactId: string;
  readonly revisionId: string;
  readonly revisionNumber: ReturnType<typeof parseArtifactRevisionNumber>;
  readonly kind: ArtifactKind;
  readonly contentDigest: string;
  readonly contentLength: ReturnType<typeof parseArtifactContentLength>;
  readonly state: ArtifactRevision["state"];
  readonly releaseChannel?: string;
  readonly publishedAt?: UtcInstant;
  readonly revision: ArtifactRevision;
}

export interface ArtifactApplicationClock {
  now(): string;
}

interface ArtifactCommandContext extends ArtifactScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
  readonly confirmation: "confirmed" | "not-confirmed";
  readonly requestId: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

interface ArtifactQueryContext extends ArtifactScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
}

interface DecodedPublicationInput {
  readonly artifactId: ReturnType<typeof parseArtifactId>;
  readonly revisionId: ReturnType<typeof parseArtifactRevisionId>;
  readonly revisionNumber: ReturnType<typeof parseArtifactRevisionNumber>;
  readonly kind: ArtifactKind;
  readonly contentDigest: ReturnType<typeof parseContentDigest>;
  readonly contentLength: ReturnType<typeof parseArtifactContentLength>;
  readonly releaseChannel: string;
  readonly compatibility: ArtifactCompatibility;
  readonly dependencies: readonly ArtifactRevisionId[];
  readonly signature: ArtifactSignature;
}

class ArtifactInputError extends Error {}

function failure(
  code: ArtifactApplicationFailureCode,
  message: string,
): Readonly<{ ok: false; failure: ArtifactApplicationFailure }> {
  return { ok: false, failure: { code, message } };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function requireRecord(input: unknown, name: string): Record<string, unknown> {
  if (!isRecord(input))
    throw new ArtifactInputError(`${name} must be an object`);
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
    throw new ArtifactInputError(
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
    throw new ArtifactInputError(`${name} must be a non-empty bounded string`);
  }
  return input;
}

function requireIdentifier(input: unknown, name: string): string {
  const value = requireString(input, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new ArtifactInputError(`${name} must be a bounded identifier`);
  }
  return value;
}

function decodePermissions(input: unknown): ReadonlySet<string> {
  if (
    !Array.isArray(input) ||
    input.some((entry) => typeof entry !== "string")
  ) {
    throw new ArtifactInputError("permissions must be an array of strings");
  }
  return new Set(input);
}

function decodeScope(record: Record<string, unknown>): ArtifactScope {
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
  };
}

function decodeCommandContext(input: unknown): ArtifactCommandContext {
  const record = requireRecord(input, "artifact command context");
  requireExactKeys(
    record,
    [
      "confirmation",
      "expiresAt",
      "idempotencyKey",
      "issuedAt",
      "permissions",
      "projectId",
      "subjectId",
      "tenantId",
    ],
    "artifact command context",
  );
  if (
    record.confirmation !== "confirmed" &&
    record.confirmation !== "not-confirmed"
  ) {
    throw new ArtifactInputError("confirmation is invalid");
  }
  return {
    ...decodeScope(record),
    subjectId: requireString(record.subjectId, "subjectId"),
    permissions: decodePermissions(record.permissions),
    confirmation: record.confirmation,
    requestId: requireIdentifier(record.idempotencyKey, "idempotencyKey"),
    issuedAt: parseUtcInstant(record.issuedAt),
    expiresAt: parseUtcInstant(record.expiresAt),
  };
}

function decodeQueryContext(input: unknown): ArtifactQueryContext {
  const record = requireRecord(input, "artifact query context");
  requireExactKeys(
    record,
    ["permissions", "projectId", "subjectId", "tenantId"],
    "artifact query context",
  );
  return {
    ...decodeScope(record),
    subjectId: requireString(record.subjectId, "subjectId"),
    permissions: decodePermissions(record.permissions),
  };
}

function decodeCompatibility(input: unknown): ArtifactCompatibility {
  const record = requireRecord(input, "artifact compatibility");
  requireExactKeys(
    record,
    ["requiredCapabilities", "runtimeContract"],
    "artifact compatibility",
  );
  if (
    !Array.isArray(record.requiredCapabilities) ||
    record.requiredCapabilities.some((entry) => typeof entry !== "string")
  ) {
    throw new ArtifactInputError(
      "requiredCapabilities must be an array of strings",
    );
  }
  return {
    runtimeContract: requireIdentifier(
      record.runtimeContract,
      "runtimeContract",
    ),
    requiredCapabilities: record.requiredCapabilities.map((capability) =>
      requireIdentifier(capability, "requiredCapabilities"),
    ),
  };
}

function decodeDependencies(input: unknown): readonly ArtifactRevisionId[] {
  if (!Array.isArray(input)) {
    throw new ArtifactInputError("dependencies must be an array");
  }
  return input.map((entry) => parseArtifactRevisionId(entry));
}

function decodeSignature(input: unknown): ArtifactSignature {
  const record = requireRecord(input, "artifact signature");
  requireExactKeys(
    record,
    ["algorithm", "keyId", "signatureDigest"],
    "artifact signature",
  );
  if (record.algorithm !== "ed25519") {
    throw new ArtifactInputError("signature algorithm is unsupported");
  }
  return {
    algorithm: record.algorithm,
    keyId: requireIdentifier(record.keyId, "signature.keyId"),
    signatureDigest: parseContentDigest(record.signatureDigest),
  };
}

function decodeKind(input: unknown): ArtifactKind {
  if (
    input !== "application" &&
    input !== "configuration" &&
    input !== "model" &&
    input !== "pack" &&
    input !== "rule"
  ) {
    throw new ArtifactInputError("artifact kind is unsupported");
  }
  return input;
}

function decodePublicationInput(input: unknown): DecodedPublicationInput {
  const record = requireRecord(input, "artifact publication input");
  requireExactKeys(
    record,
    [
      "artifactId",
      "compatibility",
      "contentDigest",
      "contentLength",
      "dependencies",
      "kind",
      "releaseChannel",
      "revisionId",
      "revisionNumber",
      "signature",
    ],
    "artifact publication input",
  );
  return {
    artifactId: parseArtifactId(record.artifactId),
    revisionId: parseArtifactRevisionId(record.revisionId),
    revisionNumber: parseArtifactRevisionNumber(record.revisionNumber),
    kind: decodeKind(record.kind),
    contentDigest: parseContentDigest(record.contentDigest),
    contentLength: parseArtifactContentLength(record.contentLength),
    releaseChannel: requireIdentifier(record.releaseChannel, "releaseChannel"),
    compatibility: decodeCompatibility(record.compatibility),
    dependencies: decodeDependencies(record.dependencies),
    signature: decodeSignature(record.signature),
  };
}

function decodeRevisionQuery(input: unknown): {
  readonly artifactId: ReturnType<typeof parseArtifactId>;
  readonly revisionId: ReturnType<typeof parseArtifactRevisionId>;
} {
  const record = requireRecord(input, "artifact revision query");
  requireExactKeys(
    record,
    ["artifactId", "revisionId"],
    "artifact revision query",
  );
  return {
    artifactId: parseArtifactId(record.artifactId),
    revisionId: parseArtifactRevisionId(record.revisionId),
  };
}

function decodeSafely<Value>(
  decoder: () => Value,
):
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: ArtifactApplicationFailure }> {
  try {
    return { ok: true, value: decoder() };
  } catch (error: unknown) {
    if (
      error instanceof InvalidDomainValueError ||
      error instanceof ArtifactInputError ||
      error instanceof ArtifactTransitionError
    ) {
      return {
        ok: false,
        failure: { code: "invalid-input", message: error.message },
      };
    }
    throw error;
  }
}

function authorize(
  permissions: ReadonlySet<string>,
  permission: string,
): ArtifactApplicationFailure | undefined {
  if (permissions.has(permission)) return undefined;
  return {
    code: "permission-denied",
    message: `permission ${permission} is required`,
  };
}

function validateCommandTime(
  context: ArtifactCommandContext,
  now: UtcInstant,
): ArtifactApplicationFailure | undefined {
  if (context.expiresAt <= context.issuedAt || context.issuedAt > now) {
    return { code: "invalid-input", message: "command time window is invalid" };
  }
  if (now >= context.expiresAt) {
    return { code: "command-expired", message: "command has expired" };
  }
  return undefined;
}

function toView(
  revision: ArtifactRevision,
  releaseChannel?: string,
): ArtifactRevisionView {
  return Object.freeze({
    artifactId: revision.artifactId,
    revisionId: revision.revisionId,
    revisionNumber: revision.revisionNumber,
    kind: revision.kind,
    contentDigest: revision.contentDigest,
    contentLength: revision.contentLength,
    state: revision.state,
    ...(releaseChannel === undefined ? {} : { releaseChannel }),
    ...(revision.publishedAt === undefined
      ? {}
      : { publishedAt: revision.publishedAt }),
    revision,
  });
}

export class PublishArtifactRevision {
  static readonly capability = PUBLISH_ARTIFACT_REVISION_COMMAND;

  readonly #repository: ArtifactRegistryRepository;
  readonly #contentStore: ArtifactContentStore;
  readonly #signatureVerifier: ArtifactSignatureVerifier;
  readonly #clock: ArtifactApplicationClock;

  constructor(dependencies: {
    readonly repository: ArtifactRegistryRepository;
    readonly contentStore: ArtifactContentStore;
    readonly signatureVerifier: ArtifactSignatureVerifier;
    readonly clock: ArtifactApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#contentStore = dependencies.contentStore;
    this.#signatureVerifier = dependencies.signatureVerifier;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<ArtifactApplicationResult<ArtifactRevisionView>> {
    const decodedContext = decodeSafely(() => decodeCommandContext(rawContext));
    if (!decodedContext.ok) return decodedContext;
    const context = decodedContext.value;
    const authorizationFailure = authorize(
      context.permissions,
      PublishArtifactRevision.capability.permission,
    );
    if (authorizationFailure !== undefined) {
      return { ok: false, failure: authorizationFailure };
    }
    if (context.confirmation !== "confirmed") {
      return failure(
        "confirmation-required",
        "artifact publication requires explicit confirmation",
      );
    }
    const decodedNow = decodeSafely(() => parseUtcInstant(this.#clock.now()));
    if (!decodedNow.ok) return decodedNow;
    const timeFailure = validateCommandTime(context, decodedNow.value);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };

    const decodedInput = decodeSafely(() => decodePublicationInput(rawInput));
    if (!decodedInput.ok) return decodedInput;
    const input = decodedInput.value;

    const content = await this.#contentStore.verifyContent({
      digest: input.contentDigest,
      byteLength: input.contentLength,
    });
    if (content.outcome !== "verified") {
      if (content.outcome === "digest-mismatch") {
        return failure(
          "artifact-digest-mismatch",
          "artifact content does not match its digest or length",
        );
      }
      if (content.outcome === "missing") {
        return failure(
          "artifact-content-not-found",
          "artifact content was not found",
        );
      }
      return failure(
        "artifact-storage-unavailable",
        "artifact content storage is unavailable",
      );
    }

    const signature = await this.#signatureVerifier.verifySignature({
      contentDigest: input.contentDigest,
      signatureDigest: input.signature.signatureDigest,
      keyId: input.signature.keyId,
      algorithm: input.signature.algorithm,
    });
    if (signature.outcome !== "verified") {
      return signature.outcome === "invalid"
        ? failure("artifact-signature-invalid", "artifact signature is invalid")
        : failure(
            "artifact-storage-unavailable",
            "artifact signature verifier is unavailable",
          );
    }

    const decodedRevision = decodeSafely(() => {
      const draft = defineArtifactRevisionDraft({
        artifactId: input.artifactId,
        revisionId: input.revisionId,
        revisionNumber: input.revisionNumber,
        kind: input.kind,
        contentDigest: input.contentDigest,
        contentLength: input.contentLength,
        compatibility: input.compatibility,
        dependencies: input.dependencies,
        signature: input.signature,
        createdAt: decodedNow.value,
      });
      return publishRevisionInDomain(
        validateArtifactRevision(draft, decodedNow.value),
        decodedNow.value,
      );
    });
    if (!decodedRevision.ok) return decodedRevision;
    const revision = decodedRevision.value;
    const persisted = await this.#repository.publish({
      tenantId: context.tenantId,
      projectId: context.projectId,
      requestId: context.requestId,
      subjectId: context.subjectId,
      revision,
      releaseChannel: input.releaseChannel,
      publishedAt: decodedNow.value,
    });
    if (persisted.outcome === "published") {
      return {
        ok: true,
        replayed: false,
        value: toView(persisted.revision ?? revision, input.releaseChannel),
      };
    }
    if (persisted.outcome === "replayed") {
      return {
        ok: true,
        replayed: true,
        value: toView(persisted.revision, input.releaseChannel),
      };
    }
    const mapped = {
      "channel-conflict": "artifact-channel-conflict",
      "idempotency-conflict": "artifact-idempotency-conflict",
      "revision-conflict": "artifact-revision-conflict",
      "storage-unavailable": "artifact-storage-unavailable",
    } as const;
    return failure(
      mapped[persisted.outcome],
      "artifact publication was rejected",
    );
  }
}

export class GetArtifactRevision {
  static readonly capability = GET_ARTIFACT_REVISION_QUERY;

  readonly #repository: ArtifactRegistryRepository;

  constructor(dependencies: {
    readonly repository: ArtifactRegistryRepository;
  }) {
    this.#repository = dependencies.repository;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<ArtifactQueryResult<ArtifactRevisionView>> {
    const decodedContext = decodeSafely(() => decodeQueryContext(rawContext));
    if (!decodedContext.ok) return decodedContext;
    const authorizationFailure = authorize(
      decodedContext.value.permissions,
      GetArtifactRevision.capability.permission,
    );
    if (authorizationFailure !== undefined) {
      return { ok: false, failure: authorizationFailure };
    }
    const decodedInput = decodeSafely(() => decodeRevisionQuery(rawInput));
    if (!decodedInput.ok) return decodedInput;
    const revision = await this.#repository.findRevision(
      decodedContext.value,
      decodedInput.value.artifactId,
      decodedInput.value.revisionId,
    );
    return revision === undefined
      ? failure("artifact-not-found", "artifact revision was not found")
      : { ok: true, value: toView(revision) };
  }
}
