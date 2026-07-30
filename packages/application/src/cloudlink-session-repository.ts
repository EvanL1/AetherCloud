import type {
  CloudLinkSession,
  CloudLinkSessionChallengeId,
  CloudLinkSessionEpoch,
  CloudLinkSessionId,
  CloudLinkStreamCursor,
  GatewayCredentialBinding,
  GatewayId,
  ProjectId,
  ProtocolVersion,
  TenantId,
  UtcInstant,
} from "@aether-cloud/domain";

export interface GatewayCredentialAssertion {
  readonly credentialId: string;
  readonly proof: string;
}

export type GatewayCredentialVerificationResult =
  | Readonly<{ ok: true; value: GatewayCredentialBinding }>
  | Readonly<{
      ok: false;
      failure: Readonly<{
        code: "invalid-gateway-credential";
        message: string;
      }>;
    }>;

export interface GatewayCredentialVerifier {
  verify(
    assertion: GatewayCredentialAssertion,
  ): Promise<GatewayCredentialVerificationResult>;
}

export interface CloudLinkSessionScope {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

export interface GatewayCredentialClaim {
  readonly gatewayId: GatewayId;
  readonly credentialId: string;
  readonly generation: GatewayCredentialBinding["generation"];
}

export interface GatewayCredentialClaimResolver {
  resolveClaim(
    claim: GatewayCredentialClaim,
  ): Promise<GatewayCredentialBinding | undefined>;
}

export interface CloudLinkSessionChallengeRequestState {
  readonly gatewayId: GatewayId;
  readonly credentialId: string;
  readonly credentialGeneration: GatewayCredentialBinding["generation"];
  readonly offeredProtocolVersions: readonly ProtocolVersion[];
  readonly clientNonce: string;
  readonly resumeCursors: readonly CloudLinkStreamCursor[];
}

export interface CloudLinkSessionChallengeAuthentication {
  readonly keyId: string;
  readonly algorithm: "Ed25519";
  readonly signature: string;
}

export interface CloudLinkSessionChallengeRecord {
  readonly binding: GatewayCredentialBinding;
  readonly request: CloudLinkSessionChallengeRequestState;
  readonly challengeId: CloudLinkSessionChallengeId;
  readonly cloudNonce: string;
  readonly issuedAtMs: string;
  readonly expiresAtMs: string;
  readonly cloudAuthentication: CloudLinkSessionChallengeAuthentication;
}

export interface IssueCloudLinkSessionChallengeRepositoryInput {
  readonly candidate: CloudLinkSessionChallengeRecord;
  readonly evaluationTimeMs: string;
  readonly rateLimitWindowMs: number;
  readonly rateLimitMaximumRequests: number;
}

export type IssueCloudLinkSessionChallengeRepositoryResult =
  | Readonly<{
      outcome: "issued" | "replayed";
      challenge: CloudLinkSessionChallengeRecord;
    }>
  | Readonly<{ outcome: "rate-limited" | "request-conflict" }>;

export interface AcceptCloudLinkSessionChallengeRepositoryInput {
  readonly binding: GatewayCredentialBinding;
  readonly challengeId: CloudLinkSessionChallengeId;
  readonly authenticationFingerprint: string;
  readonly evaluationTimeMs: string;
  readonly sessionId: CloudLinkSessionId;
  readonly protocolVersion: ProtocolVersion;
  readonly openedAt: UtcInstant;
  readonly gatewayKeyId: string;
  readonly heartbeatIntervalMs: string;
}

export type AcceptCloudLinkSessionChallengeRepositoryResult =
  | Readonly<{
      outcome: "opened";
      session: CloudLinkSession;
      fencedSessionId?: CloudLinkSessionId;
    }>
  | Readonly<{ outcome: "replayed"; session: CloudLinkSession }>
  | Readonly<{
      outcome:
        | "not-found"
        | "expired"
        | "consumed-conflict"
        | "binding-conflict";
    }>;

export interface CloudLinkSessionChallengeRepository {
  issue(
    input: IssueCloudLinkSessionChallengeRepositoryInput,
  ): Promise<IssueCloudLinkSessionChallengeRepositoryResult>;
  find(
    binding: GatewayCredentialBinding,
    challengeId: CloudLinkSessionChallengeId,
  ): Promise<CloudLinkSessionChallengeRecord | undefined>;
  acceptAndOpen(
    input: AcceptCloudLinkSessionChallengeRepositoryInput,
  ): Promise<AcceptCloudLinkSessionChallengeRepositoryResult>;
}

export interface OpenCloudLinkSessionRepositoryInput {
  readonly binding: GatewayCredentialBinding;
  readonly requestId: string;
  readonly sessionId: CloudLinkSessionId;
  readonly protocolVersion: ProtocolVersion;
  readonly openedAt: UtcInstant;
}

export type OpenCloudLinkSessionRepositoryResult =
  | Readonly<{
      outcome: "opened";
      session: CloudLinkSession;
      fencedSessionId?: CloudLinkSessionId;
    }>
  | Readonly<{ outcome: "replayed"; session: CloudLinkSession }>
  | Readonly<{ outcome: "idempotency-conflict" }>;

export type CloudLinkSessionReplaceResult =
  | "not-found"
  | "replaced"
  | "version-conflict";

export interface RecordCloudLinkDurableCursorRepositoryInput {
  readonly binding: GatewayCredentialBinding;
  readonly sessionId: CloudLinkSessionId;
  readonly sessionEpoch: CloudLinkSessionEpoch;
  readonly cursor: CloudLinkStreamCursor;
}

export type RecordCloudLinkDurableCursorRepositoryResult =
  | "not-found"
  | "position-gap"
  | "recorded"
  | "replayed"
  | "stale-session";

export interface CloudLinkSessionRepository {
  open(
    input: OpenCloudLinkSessionRepositoryInput,
  ): Promise<OpenCloudLinkSessionRepositoryResult>;
  findById(
    binding: GatewayCredentialBinding,
    sessionId: CloudLinkSessionId,
  ): Promise<CloudLinkSession | undefined>;
  findCurrent(
    scope: CloudLinkSessionScope,
    gatewayId: GatewayId,
  ): Promise<CloudLinkSession | undefined>;
  replace(
    session: CloudLinkSession,
    expectedRevision: number,
  ): Promise<CloudLinkSessionReplaceResult>;
  recordDurableCursor(
    input: RecordCloudLinkDurableCursorRepositoryInput,
  ): Promise<RecordCloudLinkDurableCursorRepositoryResult>;
}

export interface CloudLinkSessionIdGenerator {
  next(): CloudLinkSessionId;
}

export interface CloudLinkSessionHealthLease {
  readonly leaseId: string;
  readonly session: CloudLinkSession;
}

export type LeaseDueCloudLinkSessionHealthResult =
  | Readonly<{
      outcome: "leased";
      leases: readonly CloudLinkSessionHealthLease[];
    }>
  | Readonly<{ outcome: "storage-unavailable" }>;

export interface CompleteCloudLinkSessionHealthInput {
  readonly leaseId: string;
  readonly session: CloudLinkSession;
  readonly expectedRevision: number;
  readonly evidence: Readonly<{
    eventId: string;
    outboxId: string;
    occurredAt: UtcInstant;
    eventName:
      | "cloudlink.session.heartbeat-timed-out.v1"
      | "cloudlink.session.suspected.v1";
  }>;
}

export type CompleteCloudLinkSessionHealthResult =
  | "completed"
  | "lease-lost"
  | "storage-unavailable";

export interface CloudLinkSessionHealthRepository {
  leaseDue(input: {
    readonly leaseId: string;
    readonly evaluatedAt: UtcInstant;
    readonly leaseExpiresAt: UtcInstant;
    readonly limit: number;
  }): Promise<LeaseDueCloudLinkSessionHealthResult>;
  complete(
    input: CompleteCloudLinkSessionHealthInput,
  ): Promise<CompleteCloudLinkSessionHealthResult>;
}

export interface CloudLinkSessionHealthIdGenerator {
  next(): string;
}
