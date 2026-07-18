import type {
  GatewayCredentialBinding,
  GatewayCredentialGeneration,
  GatewayId,
  CloudLinkSessionEpoch,
  CloudLinkSessionId,
  IntegrationBatchId,
  IntegrationId,
  IntegrationObservation,
  IntegrationObservationBatch,
  IntegrationSnapshotGeneration,
  IntegrationTopologySnapshot,
  ProjectId,
  StreamEpoch,
  StreamId,
  StreamPosition,
  TenantId,
  UtcInstant,
} from "@aether-cloud/domain";

export interface IntegrationProjectionScope {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly integrationId: IntegrationId;
}

export interface IntegrationProjectionRecord extends IntegrationProjectionScope {
  readonly topology: IntegrationTopologySnapshot;
  readonly topologyDigest: string;
  readonly latestObservations: readonly IntegrationObservation[];
  readonly receivedAt: UtcInstant;
  readonly revision: number;
}

export interface IntegrationTopologyHistoryRecord extends IntegrationProjectionScope {
  readonly topology: IntegrationTopologySnapshot;
  readonly topologyDigest: string;
  readonly receivedAt: UtcInstant;
  readonly revision: number;
}

interface IntegrationProjectionPersistenceReceiptBase extends IntegrationProjectionScope {
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly requestId: string;
  readonly payloadDigest: string;
  readonly snapshotGeneration: IntegrationSnapshotGeneration;
  readonly revision: number;
  readonly auditEventId: string;
  readonly outboxEventId: string;
  readonly committedAt: UtcInstant;
}

export interface IntegrationTopologyPersistenceReceipt extends IntegrationProjectionPersistenceReceiptBase {
  readonly kind: "topology";
}

export interface IntegrationObservationPersistenceReceipt extends IntegrationProjectionPersistenceReceiptBase {
  readonly kind: "observations";
  readonly batchId: IntegrationBatchId;
}

export interface IntegrationPayloadDigestor {
  digest(
    payload: IntegrationObservationBatch | IntegrationTopologySnapshot,
  ): Promise<string>;
}

export type IntegrationCloudLinkMessageKind =
  | "integration-observation-batch"
  | "integration-topology-snapshot";

/**
 * Transport evidence that must commit atomically with one Integration fact.
 *
 * `digest` is the `sha256:` CloudLink JCS delivery digest. It is deliberately
 * distinct from the unprefixed normalized Integration `payloadDigest`.
 */
export interface IntegrationCloudLinkDelivery {
  /** Full signed delivery fact; optional only for legacy trusted-connector callers. */
  readonly sentAtMs?: string;
  /** JSON null means the signed wire omitted expires_at_ms. */
  readonly expiresAtMs?: string | null;
  readonly sessionId: CloudLinkSessionId;
  readonly sessionEpoch: CloudLinkSessionEpoch;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly streamId: StreamId;
  readonly streamEpoch: StreamEpoch;
  readonly position: StreamPosition;
  readonly batchId: string;
  readonly digest: string;
  readonly messageKind: IntegrationCloudLinkMessageKind;
}

/**
 * Exact active-session head observed while authenticating a signed uplink.
 * Signed business persistence must compare it with the current head inside
 * the same atomic boundary as its write.
 */
export interface IntegrationCloudLinkSessionFence {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly sessionId: CloudLinkSessionId;
  readonly sessionEpoch: CloudLinkSessionEpoch;
  readonly sessionRevision: number;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly gatewayKeyId: string;
}

export interface IntegrationCloudLinkSessionFenceVerifier {
  isCurrentSessionFence(fence: IntegrationCloudLinkSessionFence): boolean;
}

/**
 * A committed cumulative CloudLink acknowledgement ready for publication.
 *
 * The acknowledgement is bound to the exact current delivery, which must also
 * be the terminal position of a contiguous committed prefix. Absence means no
 * ACK may be published.
 */
export interface IntegrationCloudLinkDurableAcknowledgement extends IntegrationProjectionScope {
  readonly outboxEventId: string;
  readonly receiptId: string;
  readonly sessionId: CloudLinkSessionId;
  readonly sessionEpoch: CloudLinkSessionEpoch;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly streamId: StreamId;
  readonly streamEpoch: StreamEpoch;
  readonly acknowledgedPosition: StreamPosition;
  readonly batchId: string;
  readonly digest: string;
  readonly messageKind: IntegrationCloudLinkMessageKind;
  readonly acknowledgedAt: UtcInstant;
}

export interface IntegrationTopologyPersistenceInput {
  readonly requestId: string;
  readonly binding: GatewayCredentialBinding;
  readonly topology: IntegrationTopologySnapshot;
  readonly payloadDigest: string;
  readonly receivedAt: UtcInstant;
  readonly cloudLinkDelivery?: IntegrationCloudLinkDelivery;
  readonly cloudLinkSessionFence?: IntegrationCloudLinkSessionFence;
}

export type IntegrationTopologyPersistenceResult =
  | Readonly<{
      outcome: "persisted" | "replayed";
      record: IntegrationProjectionRecord;
      receipt: IntegrationTopologyPersistenceReceipt;
      durableAcknowledgement?: IntegrationCloudLinkDurableAcknowledgement;
    }>
  | Readonly<{
      outcome:
        | "delivery-conflict"
        | "delivery-gap"
        | "generation-conflict"
        | "idempotency-conflict"
        | "session-fenced"
        | "stale-generation"
        | "storage-unavailable"
        | "stream-binding-conflict";
    }>;

export interface IntegrationObservationPersistenceInput {
  readonly requestId: string;
  readonly binding: GatewayCredentialBinding;
  readonly batch: IntegrationObservationBatch;
  readonly payloadDigest: string;
  readonly receivedAt: UtcInstant;
  readonly cloudLinkDelivery?: IntegrationCloudLinkDelivery;
  readonly cloudLinkSessionFence?: IntegrationCloudLinkSessionFence;
}

export type IntegrationObservationPersistenceResult =
  | Readonly<{
      outcome: "persisted" | "replayed";
      record: IntegrationProjectionRecord;
      receipt: IntegrationObservationPersistenceReceipt;
      durableAcknowledgement?: IntegrationCloudLinkDurableAcknowledgement;
    }>
  | Readonly<{
      outcome:
        | "batch-conflict"
        | "delivery-conflict"
        | "delivery-gap"
        | "generation-conflict"
        | "idempotency-conflict"
        | "session-fenced"
        | "storage-unavailable"
        | "stream-binding-conflict"
        | "topology-required";
    }>;

export class IntegrationProjectionStorageUnavailableError extends Error {
  override readonly name = "IntegrationProjectionStorageUnavailableError";
}

export interface IntegrationProjectionRepository {
  persistTopology(
    input: IntegrationTopologyPersistenceInput,
  ): Promise<IntegrationTopologyPersistenceResult>;
  persistObservations(
    input: IntegrationObservationPersistenceInput,
  ): Promise<IntegrationObservationPersistenceResult>;
  findCurrent(
    scope: IntegrationProjectionScope,
  ): Promise<IntegrationProjectionRecord | undefined>;
  findTopology(
    scope: IntegrationProjectionScope,
    snapshotGeneration: IntegrationSnapshotGeneration,
  ): Promise<IntegrationTopologyHistoryRecord | undefined>;
}
