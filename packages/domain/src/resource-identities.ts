const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const opaqueRequestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const sha256DigestPattern = /^[0-9a-f]{64}$/;

declare const tenantIdBrand: unique symbol;
declare const projectIdBrand: unique symbol;
declare const gatewayIdBrand: unique symbol;
declare const enrollmentClaimIdBrand: unique symbol;
declare const enrollmentRequestIdBrand: unique symbol;
declare const enrollmentTokenDigestBrand: unique symbol;
declare const credentialRequestFingerprintBrand: unique symbol;
declare const utcInstantBrand: unique symbol;

export type TenantId = string & { readonly [tenantIdBrand]: true };
export type ProjectId = string & { readonly [projectIdBrand]: true };
export type GatewayId = string & { readonly [gatewayIdBrand]: true };
export type EnrollmentClaimId = string & {
  readonly [enrollmentClaimIdBrand]: true;
};
export type EnrollmentRequestId = string & {
  readonly [enrollmentRequestIdBrand]: true;
};
export type EnrollmentTokenDigest = string & {
  readonly [enrollmentTokenDigestBrand]: true;
};
export type CredentialRequestFingerprint = string & {
  readonly [credentialRequestFingerprintBrand]: true;
};
export type UtcInstant = string & { readonly [utcInstantBrand]: true };

export class InvalidDomainValueError extends Error {
  readonly code = "invalid-domain-value";
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "InvalidDomainValueError";
    this.field = field;
  }
}

function parseResourceId(input: unknown, field: string): string {
  if (typeof input !== "string" || !canonicalUuidPattern.test(input)) {
    throw new InvalidDomainValueError(
      field,
      `${field} must be a canonical lowercase UUID`,
    );
  }
  return input;
}

function parseSha256Value(input: unknown, field: string): string {
  if (typeof input !== "string" || !sha256DigestPattern.test(input)) {
    throw new InvalidDomainValueError(
      field,
      `${field} must be a lowercase SHA-256 digest`,
    );
  }
  return input;
}

export function parseTenantId(input: unknown): TenantId {
  return parseResourceId(input, "tenantId") as TenantId;
}

export function parseProjectId(input: unknown): ProjectId {
  return parseResourceId(input, "projectId") as ProjectId;
}

export function parseGatewayId(input: unknown): GatewayId {
  return parseResourceId(input, "gatewayId") as GatewayId;
}

export function parseEnrollmentClaimId(input: unknown): EnrollmentClaimId {
  return parseResourceId(input, "enrollmentClaimId") as EnrollmentClaimId;
}

export function parseEnrollmentRequestId(input: unknown): EnrollmentRequestId {
  if (typeof input !== "string" || !opaqueRequestIdPattern.test(input)) {
    throw new InvalidDomainValueError(
      "enrollmentRequestId",
      "enrollmentRequestId must be an opaque 8-128 character identifier",
    );
  }
  return input as EnrollmentRequestId;
}

export function parseEnrollmentTokenDigest(
  input: unknown,
): EnrollmentTokenDigest {
  return parseSha256Value(
    input,
    "enrollmentTokenDigest",
  ) as EnrollmentTokenDigest;
}

export function parseCredentialRequestFingerprint(
  input: unknown,
): CredentialRequestFingerprint {
  return parseSha256Value(
    input,
    "credentialRequestFingerprint",
  ) as CredentialRequestFingerprint;
}

export function parseUtcInstant(input: unknown): UtcInstant {
  if (typeof input !== "string") {
    throw new InvalidDomainValueError(
      "instant",
      "instant must be a canonical UTC timestamp",
    );
  }

  const milliseconds = Date.parse(input);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== input
  ) {
    throw new InvalidDomainValueError(
      "instant",
      "instant must be a canonical UTC timestamp",
    );
  }
  return input as UtcInstant;
}
