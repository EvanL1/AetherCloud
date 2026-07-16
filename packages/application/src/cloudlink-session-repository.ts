import type {
  CloudLinkSession,
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
