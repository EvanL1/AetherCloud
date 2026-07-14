import { InvalidDomainValueError } from "./resource-identities.js";
import type {
  CredentialRequestFingerprint,
  EnrollmentClaimId,
  EnrollmentRequestId,
  EnrollmentTokenDigest,
  GatewayId,
  ProjectId,
  TenantId,
  UtcInstant,
} from "./resource-identities.js";

export interface RegisteredGatewayEnrollment {
  readonly state: "registered";
  readonly requestId: EnrollmentRequestId;
  readonly registeredAt: UtcInstant;
}

export interface AwaitingGatewayEnrollmentClaim {
  readonly state: "awaiting-claim";
  readonly requestId: EnrollmentRequestId;
  readonly claim: Readonly<{
    claimId: EnrollmentClaimId;
    tokenDigest: EnrollmentTokenDigest;
    issuedAt: UtcInstant;
    expiresAt: UtcInstant;
  }>;
}

export interface ClaimedGatewayEnrollment {
  readonly state: "claimed";
  readonly claimId: EnrollmentClaimId;
  readonly tokenDigest: EnrollmentTokenDigest;
  readonly requestId: EnrollmentRequestId;
  readonly credentialRequestFingerprint: CredentialRequestFingerprint;
  readonly claimedAt: UtcInstant;
}

export type GatewayEnrollment =
  | AwaitingGatewayEnrollmentClaim
  | ClaimedGatewayEnrollment
  | RegisteredGatewayEnrollment;

export interface GatewayIdentity {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly displayName: string;
  readonly revision: number;
  readonly enrollment: GatewayEnrollment;
}

export interface RegisterGatewayIdentityInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly displayName: string;
  readonly requestId: EnrollmentRequestId;
  readonly registeredAt: UtcInstant;
}

export interface IssueGatewayEnrollmentClaimInput {
  readonly requestId: EnrollmentRequestId;
  readonly claimId: EnrollmentClaimId;
  readonly tokenDigest: EnrollmentTokenDigest;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

export interface ClaimGatewayEnrollmentInput {
  readonly requestId: EnrollmentRequestId;
  readonly credentialRequestFingerprint: CredentialRequestFingerprint;
  readonly claimedAt: UtcInstant;
}

export interface GatewayEnrollmentTransitionFailure {
  readonly code:
    | "enrollment-claim-expired"
    | "invalid-gateway-enrollment-transition";
  readonly message: string;
}

export type GatewayEnrollmentTransitionResult =
  | Readonly<{
      ok: true;
      replayed: boolean;
      value: GatewayIdentity;
    }>
  | Readonly<{
      ok: false;
      failure: GatewayEnrollmentTransitionFailure;
    }>;

function freezeGateway(
  gateway: Omit<GatewayIdentity, "enrollment"> & {
    readonly enrollment: GatewayEnrollment;
  },
): GatewayIdentity {
  return Object.freeze({
    ...gateway,
    enrollment: Object.freeze(gateway.enrollment),
  });
}

function transitionFailure(
  code: GatewayEnrollmentTransitionFailure["code"],
  message: string,
): GatewayEnrollmentTransitionResult {
  return { ok: false, failure: { code, message } };
}

export function registerGatewayIdentity(
  input: RegisterGatewayIdentityInput,
): GatewayIdentity {
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 128) {
    throw new InvalidDomainValueError(
      "displayName",
      "gateway display name must contain 1-128 characters",
    );
  }

  return freezeGateway({
    tenantId: input.tenantId,
    projectId: input.projectId,
    gatewayId: input.gatewayId,
    displayName,
    revision: 1,
    enrollment: {
      state: "registered",
      requestId: input.requestId,
      registeredAt: input.registeredAt,
    },
  });
}

export function issueGatewayEnrollmentClaim(
  gateway: GatewayIdentity,
  input: IssueGatewayEnrollmentClaimInput,
): GatewayEnrollmentTransitionResult {
  if (gateway.enrollment.state === "awaiting-claim") {
    if (
      gateway.enrollment.requestId === input.requestId &&
      gateway.enrollment.claim.claimId === input.claimId &&
      gateway.enrollment.claim.tokenDigest === input.tokenDigest &&
      gateway.enrollment.claim.issuedAt === input.issuedAt &&
      gateway.enrollment.claim.expiresAt === input.expiresAt
    ) {
      return { ok: true, replayed: true, value: gateway };
    }
    return transitionFailure(
      "invalid-gateway-enrollment-transition",
      "gateway already has an active enrollment claim",
    );
  }
  if (gateway.enrollment.state !== "registered") {
    return transitionFailure(
      "invalid-gateway-enrollment-transition",
      "claimed gateway requires an explicit recovery workflow",
    );
  }
  if (input.expiresAt <= input.issuedAt) {
    return transitionFailure(
      "enrollment-claim-expired",
      "gateway enrollment claim must expire after it is issued",
    );
  }

  const enrollment: AwaitingGatewayEnrollmentClaim = {
    state: "awaiting-claim",
    requestId: input.requestId,
    claim: Object.freeze({
      claimId: input.claimId,
      tokenDigest: input.tokenDigest,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    }),
  };
  return {
    ok: true,
    replayed: false,
    value: freezeGateway({
      ...gateway,
      revision: gateway.revision + 1,
      enrollment,
    }),
  };
}

export function claimGatewayEnrollment(
  gateway: GatewayIdentity,
  input: ClaimGatewayEnrollmentInput,
): GatewayEnrollmentTransitionResult {
  if (gateway.enrollment.state === "claimed") {
    if (
      gateway.enrollment.requestId === input.requestId &&
      gateway.enrollment.credentialRequestFingerprint ===
        input.credentialRequestFingerprint
    ) {
      return { ok: true, replayed: true, value: gateway };
    }
    return transitionFailure(
      "invalid-gateway-enrollment-transition",
      "gateway enrollment claim was already consumed",
    );
  }
  if (gateway.enrollment.state !== "awaiting-claim") {
    return transitionFailure(
      "invalid-gateway-enrollment-transition",
      "gateway does not have an active enrollment claim",
    );
  }
  if (
    input.claimedAt < gateway.enrollment.claim.issuedAt ||
    input.claimedAt >= gateway.enrollment.claim.expiresAt
  ) {
    return transitionFailure(
      "enrollment-claim-expired",
      "gateway enrollment claim has expired",
    );
  }

  return {
    ok: true,
    replayed: false,
    value: freezeGateway({
      ...gateway,
      revision: gateway.revision + 1,
      enrollment: {
        state: "claimed",
        claimId: gateway.enrollment.claim.claimId,
        tokenDigest: gateway.enrollment.claim.tokenDigest,
        requestId: input.requestId,
        credentialRequestFingerprint: input.credentialRequestFingerprint,
        claimedAt: input.claimedAt,
      },
    }),
  };
}
