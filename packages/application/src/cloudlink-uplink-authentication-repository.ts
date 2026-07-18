import type {
  CloudLinkSessionEpoch,
  CloudLinkSessionId,
  GatewayCredentialGeneration,
  GatewayId,
  ProjectId,
  TenantId,
} from "@aether-cloud/domain";

export interface CloudLinkUplinkAuthenticationScope {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

interface CloudLinkUplinkAuthenticationIdentity extends CloudLinkUplinkAuthenticationScope {
  readonly gatewayId: GatewayId;
  readonly sessionId: CloudLinkSessionId;
  readonly sessionEpoch: CloudLinkSessionEpoch;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly exactSigningObjectDigest: string;
}

export interface AcceptCloudLinkHeartbeatAuthenticationInput extends CloudLinkUplinkAuthenticationIdentity {
  readonly observedAtMs: string;
}

export type CloudLinkUplinkAuthenticationRepositoryResult = Readonly<{
  readonly outcome: "accepted" | "conflict" | "lower" | "replayed";
}>;

/**
 * Persists the accepted-session heartbeat replay fact.
 *
 * Delivery replay is deliberately not part of this port: the frozen alpha.4
 * identity conflicts with a legitimate resend after a new session changes the
 * exact 13-field signing object. Delivery remains subject to cryptographic,
 * session, freshness, and existing business-idempotency checks until the
 * protocol defines a cross-session replay identity.
 */
export interface CloudLinkUplinkAuthenticationRepository {
  acceptHeartbeat(
    input: AcceptCloudLinkHeartbeatAuthenticationInput,
  ): Promise<CloudLinkUplinkAuthenticationRepositoryResult>;
}
