import type {
  AuditConfirmation,
  AuditRisk,
  AuditSubjectKind,
  EnrollmentClaimId,
  EnrollmentRequestId,
  EnrollmentTokenDigest,
  GatewayId,
  GatewayIdentity,
  ProjectId,
  TenantId,
  UtcInstant,
} from "@aether-cloud/domain";

export interface GatewayScope {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

export interface GatewayIdentityMutationEvidence {
  readonly requestId: EnrollmentRequestId;
  readonly actor: Readonly<{
    kind: AuditSubjectKind;
    subjectId: string;
  }>;
  readonly occurredAt: UtcInstant;
  readonly action:
    | "fleet.gateway.enrollment.claim"
    | "fleet.gateway.enrollment.issue"
    | "fleet.gateway.register";
  readonly risk: AuditRisk;
  readonly confirmation: AuditConfirmation;
  readonly eventName:
    | "fleet.gateway.enrollment-claimed.v1"
    | "fleet.gateway.enrollment-issued.v1"
    | "fleet.gateway.registered.v1";
}

export interface GatewayIdentityInsertRequest extends GatewayScope {
  readonly gateway: GatewayIdentity;
  readonly evidence: GatewayIdentityMutationEvidence;
}

export interface GatewayIdentityReplaceRequest extends GatewayIdentityInsertRequest {
  readonly expectedRevision: number;
}

export type GatewayFindResult =
  | Readonly<{ outcome: "found"; gateway: GatewayIdentity }>
  | Readonly<{ outcome: "not-found" }>
  | Readonly<{ outcome: "storage-unavailable" }>;

export type GatewayInsertResult =
  | "already-exists"
  | "inserted"
  | "storage-unavailable";
export type GatewayReplaceResult =
  | "not-found"
  | "replaced"
  | "storage-unavailable"
  | "version-conflict";

export interface GatewayIdentityRepository {
  find(scope: GatewayScope, gatewayId: GatewayId): Promise<GatewayFindResult>;
  insert(request: GatewayIdentityInsertRequest): Promise<GatewayInsertResult>;
  replace(
    request: GatewayIdentityReplaceRequest,
  ): Promise<GatewayReplaceResult>;
}

export interface IssueEnrollmentTokenInput extends GatewayScope {
  readonly gatewayId: GatewayId;
  readonly requestId: EnrollmentRequestId;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

export interface IssuedEnrollmentToken {
  readonly claimId: EnrollmentClaimId;
  readonly token: string;
  readonly tokenDigest: EnrollmentTokenDigest;
}

export type IssueEnrollmentTokenResult =
  | Readonly<{ ok: true; value: IssuedEnrollmentToken }>
  | Readonly<{
      ok: false;
      failure: Readonly<{
        code: "idempotency-conflict";
        message: string;
      }>;
    }>;

export interface EnrollmentTokenService {
  issue(input: IssueEnrollmentTokenInput): Promise<IssueEnrollmentTokenResult>;
  matches(
    token: string,
    expectedDigest: EnrollmentTokenDigest,
  ): Promise<boolean>;
}

export interface ApplicationClock {
  now(): UtcInstant;
}
