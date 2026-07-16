import type {
  CloudLinkSessionEpoch,
  CloudLinkSessionId,
  GatewayCredentialGeneration,
  GatewayId,
  ProjectId,
  StreamEpoch,
  StreamId,
  StreamPosition,
  TelemetryStreamPosition,
  TenantId,
  UtcInstant,
} from "@aether-cloud/domain";

export interface CloudLinkDurableAcknowledgementIntent {
  readonly sessionId: CloudLinkSessionId;
  readonly sessionEpoch: CloudLinkSessionEpoch;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly streamId: StreamId;
  readonly streamEpoch: StreamEpoch;
  readonly acknowledgedPosition: StreamPosition;
  readonly acceptedTelemetryPosition: TelemetryStreamPosition;
  readonly batchId: string;
  readonly digest: string;
  readonly acknowledgedAt: UtcInstant;
}

export interface CloudLinkDurableAcknowledgement {
  readonly outboxEventId: string;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly sessionId: CloudLinkSessionId;
  readonly sessionEpoch: CloudLinkSessionEpoch;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly streamId: StreamId;
  readonly streamEpoch: StreamEpoch;
  readonly acknowledgedPosition: StreamPosition;
  readonly batchId: string;
  readonly digest: string;
  readonly receiptId: string;
  readonly acknowledgedAt: UtcInstant;
}

export interface CloudLinkDurableAckLeaseInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly workerId: string;
  readonly now: UtcInstant;
  readonly leaseExpiresAt: UtcInstant;
  readonly limit: number;
}

export type CloudLinkDurableAckClaimResult =
  | Readonly<{
      outcome: "claimed";
      acknowledgements: readonly CloudLinkDurableAcknowledgement[];
    }>
  | Readonly<{ outcome: "storage-unavailable" }>;

export interface CloudLinkDurableAckCompletionInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly workerId: string;
  readonly outboxEventId: string;
  readonly publishedAt: UtcInstant;
}

export type CloudLinkDurableAckCompletionResult =
  | "lease-conflict"
  | "marked"
  | "not-found"
  | "storage-unavailable";

export interface CloudLinkDurableAckRetryInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly workerId: string;
  readonly outboxEventId: string;
  readonly retryAt: UtcInstant;
  readonly errorCode: string;
}

export type CloudLinkDurableAckRetryResult =
  | "lease-conflict"
  | "not-found"
  | "released"
  | "storage-unavailable";

export interface CloudLinkDurableAckDeliveryRepository {
  claimPending(
    input: CloudLinkDurableAckLeaseInput,
  ): Promise<CloudLinkDurableAckClaimResult>;
  markPublished(
    input: CloudLinkDurableAckCompletionInput,
  ): Promise<CloudLinkDurableAckCompletionResult>;
  releaseForRetry(
    input: CloudLinkDurableAckRetryInput,
  ): Promise<CloudLinkDurableAckRetryResult>;
}

export type CloudLinkDurableAckPublishResult =
  | Readonly<{ outcome: "published" }>
  | Readonly<{ outcome: "unavailable"; errorCode: string }>;

export interface CloudLinkDurableAckPublisher {
  publish(
    acknowledgement: CloudLinkDurableAcknowledgement,
  ): Promise<CloudLinkDurableAckPublishResult>;
}
