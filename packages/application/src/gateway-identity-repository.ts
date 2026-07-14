import type {
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

export type GatewayInsertResult = "already-exists" | "inserted";
export type GatewayReplaceResult =
  | "not-found"
  | "replaced"
  | "version-conflict";

export interface GatewayIdentityRepository {
  find(
    scope: GatewayScope,
    gatewayId: GatewayId,
  ): Promise<GatewayIdentity | undefined>;
  insert(gateway: GatewayIdentity): Promise<GatewayInsertResult>;
  replace(
    gateway: GatewayIdentity,
    expectedRevision: number,
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
