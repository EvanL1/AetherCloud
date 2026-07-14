import {
  InvalidDomainValueError,
  parseUtcInstant,
  type UtcInstant,
} from "./resource-identities.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uint64Pattern = /^(?:0|[1-9][0-9]*)$/;
const digestPattern = /^[0-9a-f]{64}$/;
const boundedNamePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const maximumUint64 = 18_446_744_073_709_551_615n;

declare const artifactIdBrand: unique symbol;
declare const artifactRevisionIdBrand: unique symbol;
declare const contentDigestBrand: unique symbol;
declare const artifactRevisionNumberBrand: unique symbol;
declare const artifactContentLengthBrand: unique symbol;

export type ArtifactId = string & { readonly [artifactIdBrand]: true };
export type ArtifactRevisionId = string & {
  readonly [artifactRevisionIdBrand]: true;
};
export type ContentDigest = string & { readonly [contentDigestBrand]: true };
export type ArtifactRevisionNumber = string & {
  readonly [artifactRevisionNumberBrand]: true;
};
export type ArtifactContentLength = string & {
  readonly [artifactContentLengthBrand]: true;
};

export type ArtifactKind =
  | "application"
  | "configuration"
  | "model"
  | "pack"
  | "rule";
export type ArtifactPublicationState =
  | "deprecated"
  | "draft"
  | "published"
  | "validated"
  | "withdrawn";

export interface ArtifactCompatibility {
  readonly runtimeContract: string;
  readonly requiredCapabilities: readonly string[];
}

export interface ArtifactSignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly signatureDigest: ContentDigest;
}

export interface ArtifactRevision {
  readonly artifactId: ArtifactId;
  readonly revisionId: ArtifactRevisionId;
  readonly revisionNumber: ArtifactRevisionNumber;
  readonly kind: ArtifactKind;
  readonly contentDigest: ContentDigest;
  readonly contentLength: ArtifactContentLength;
  readonly compatibility: ArtifactCompatibility;
  readonly dependencies: readonly ArtifactRevisionId[];
  readonly signature: ArtifactSignature;
  readonly state: ArtifactPublicationState;
  readonly createdAt: UtcInstant;
  readonly validatedAt?: UtcInstant;
  readonly publishedAt?: UtcInstant;
  readonly deprecatedAt?: UtcInstant;
  readonly withdrawnAt?: UtcInstant;
  readonly revision: number;
}

export class ArtifactTransitionError extends Error {
  readonly code = "invalid-artifact-publication-transition";

  constructor(message: string) {
    super(message);
    this.name = "ArtifactTransitionError";
  }
}

function parseUuid(input: unknown, field: string): string {
  if (typeof input !== "string" || !uuidPattern.test(input)) {
    throw new InvalidDomainValueError(
      field,
      `${field} must be a canonical lowercase UUID`,
    );
  }
  return input;
}

function parseUint64(
  input: unknown,
  field: string,
  allowZero: boolean,
): string {
  if (
    typeof input !== "string" ||
    !uint64Pattern.test(input) ||
    BigInt(input) > maximumUint64 ||
    (!allowZero && input === "0")
  ) {
    throw new InvalidDomainValueError(
      field,
      `${field} must be a canonical ${allowZero ? "" : "positive "}unsigned 64-bit decimal string`,
    );
  }
  return input;
}

function parseBoundedName(input: unknown, field: string): string {
  if (typeof input !== "string" || !boundedNamePattern.test(input)) {
    throw new InvalidDomainValueError(field, `${field} must be a bounded name`);
  }
  return input;
}

export function parseArtifactId(input: unknown): ArtifactId {
  return parseUuid(input, "artifactId") as ArtifactId;
}

export function parseArtifactRevisionId(input: unknown): ArtifactRevisionId {
  return parseUuid(input, "artifactRevisionId") as ArtifactRevisionId;
}

export function parseContentDigest(input: unknown): ContentDigest {
  if (typeof input !== "string" || !digestPattern.test(input)) {
    throw new InvalidDomainValueError(
      "contentDigest",
      "contentDigest must be a lowercase SHA-256 digest",
    );
  }
  return input as ContentDigest;
}

export function parseArtifactRevisionNumber(
  input: unknown,
): ArtifactRevisionNumber {
  return parseUint64(input, "revisionNumber", false) as ArtifactRevisionNumber;
}

export function parseArtifactContentLength(
  input: unknown,
): ArtifactContentLength {
  return parseUint64(input, "contentLength", true) as ArtifactContentLength;
}

function defineCompatibility(
  input: ArtifactCompatibility,
): ArtifactCompatibility {
  const runtimeContract = parseBoundedName(
    input.runtimeContract,
    "runtimeContract",
  );
  if (
    !Array.isArray(input.requiredCapabilities) ||
    input.requiredCapabilities.length > 64
  ) {
    throw new InvalidDomainValueError(
      "requiredCapabilities",
      "requiredCapabilities must contain at most 64 values",
    );
  }
  const capabilities = input.requiredCapabilities.map((value) =>
    parseBoundedName(value, "requiredCapabilities"),
  );
  if (new Set(capabilities).size !== capabilities.length) {
    throw new InvalidDomainValueError(
      "requiredCapabilities",
      "requiredCapabilities must be unique",
    );
  }
  return Object.freeze({
    runtimeContract,
    requiredCapabilities: Object.freeze(capabilities),
  });
}

function defineSignature(
  input: Readonly<{
    algorithm: string;
    keyId: string;
    signatureDigest: ContentDigest;
  }>,
): ArtifactSignature {
  if (input.algorithm !== "ed25519") {
    throw new InvalidDomainValueError(
      "signature.algorithm",
      "signature algorithm is unsupported",
    );
  }
  return Object.freeze({
    algorithm: input.algorithm,
    keyId: parseBoundedName(input.keyId, "signature.keyId"),
    signatureDigest: parseContentDigest(input.signatureDigest),
  });
}

export function defineArtifactRevisionDraft(
  input: Omit<
    ArtifactRevision,
    | "deprecatedAt"
    | "publishedAt"
    | "revision"
    | "state"
    | "validatedAt"
    | "withdrawnAt"
  >,
): ArtifactRevision {
  const kinds: readonly ArtifactKind[] = [
    "application",
    "configuration",
    "model",
    "pack",
    "rule",
  ];
  if (!kinds.includes(input.kind)) {
    throw new InvalidDomainValueError(
      "artifactKind",
      "artifact kind is unsupported",
    );
  }
  if (!Array.isArray(input.dependencies) || input.dependencies.length > 64) {
    throw new InvalidDomainValueError(
      "dependencies",
      "dependencies must contain at most 64 revision identifiers",
    );
  }
  const dependencies = input.dependencies.map(parseArtifactRevisionId);
  if (new Set(dependencies).size !== dependencies.length) {
    throw new InvalidDomainValueError(
      "dependencies",
      "dependencies must be unique",
    );
  }
  return Object.freeze({
    artifactId: parseArtifactId(input.artifactId),
    revisionId: parseArtifactRevisionId(input.revisionId),
    revisionNumber: parseArtifactRevisionNumber(input.revisionNumber),
    kind: input.kind,
    contentDigest: parseContentDigest(input.contentDigest),
    contentLength: parseArtifactContentLength(input.contentLength),
    compatibility: defineCompatibility(input.compatibility),
    dependencies: Object.freeze(dependencies),
    signature: defineSignature(input.signature),
    state: "draft",
    createdAt: parseUtcInstant(input.createdAt),
    revision: 1,
  });
}

function requireState(
  revision: ArtifactRevision,
  expected: ArtifactPublicationState,
  operation: string,
): void {
  if (revision.state !== expected) {
    throw new ArtifactTransitionError(
      `${operation} requires ${expected} state, received ${revision.state}`,
    );
  }
}

export function validateArtifactRevision(
  revision: ArtifactRevision,
  validatedAt: UtcInstant,
): ArtifactRevision {
  requireState(revision, "draft", "validation");
  return Object.freeze({
    ...revision,
    state: "validated",
    validatedAt: parseUtcInstant(validatedAt),
    revision: revision.revision + 1,
  });
}

export function publishArtifactRevision(
  revision: ArtifactRevision,
  publishedAt: UtcInstant,
): ArtifactRevision {
  requireState(revision, "validated", "publication");
  return Object.freeze({
    ...revision,
    state: "published",
    publishedAt: parseUtcInstant(publishedAt),
    revision: revision.revision + 1,
  });
}

export function deprecateArtifactRevision(
  revision: ArtifactRevision,
  deprecatedAt: UtcInstant,
): ArtifactRevision {
  requireState(revision, "published", "deprecation");
  return Object.freeze({
    ...revision,
    state: "deprecated",
    deprecatedAt: parseUtcInstant(deprecatedAt),
    revision: revision.revision + 1,
  });
}

export function withdrawArtifactRevision(
  revision: ArtifactRevision,
  withdrawnAt: UtcInstant,
): ArtifactRevision {
  if (revision.state !== "published" && revision.state !== "deprecated") {
    throw new ArtifactTransitionError(
      `withdrawal requires published or deprecated state, received ${revision.state}`,
    );
  }
  return Object.freeze({
    ...revision,
    state: "withdrawn",
    withdrawnAt: parseUtcInstant(withdrawnAt),
    revision: revision.revision + 1,
  });
}
