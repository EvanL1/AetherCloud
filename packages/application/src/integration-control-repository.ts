import type {
  CloudLinkSession,
  CloudLinkSessionEpoch,
  CloudLinkSessionId,
  GatewayCredentialGeneration,
  GatewayId,
  GovernedJobId,
  IntegrationControlDigest,
  IntegrationControlReceipt,
  IntegrationEntityId,
  IntegrationId,
  IntegrationSnapshotGeneration,
  IntegrationTopologySnapshot,
  ProjectId,
  StreamEpoch,
  StreamId,
  StreamPosition,
  TenantId,
  UtcInstant,
} from "@aether-cloud/domain";
import type { IntegrationProjectionRecord } from "./integration-projection-repository.js";

export interface IntegrationControlScope {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

export interface IntegrationControlSessionReader {
  findCurrent(
    scope: IntegrationControlScope,
    gatewayId: GatewayId,
  ): Promise<CloudLinkSession | undefined>;
}

export interface IntegrationControlRuntimeProtocolReader {
  findCurrent(
    scope: IntegrationControlScope,
    gatewayId: GatewayId,
  ): Promise<
    | Readonly<{
        tenantId: TenantId;
        projectId: ProjectId;
        gatewayId: GatewayId;
        manifest: Readonly<{ protocols: readonly string[] }>;
      }>
    | undefined
  >;
}

export interface IntegrationControlProjectionReader {
  findCurrent(
    scope: IntegrationControlScope &
      Readonly<{
        gatewayId: GatewayId;
        integrationId: IntegrationId;
      }>,
  ): Promise<
    | (IntegrationProjectionRecord &
        Readonly<{ topology: IntegrationTopologySnapshot }>)
    | undefined
  >;
}

export interface IntegrationControlActionIntent {
  readonly schema: "aether.integration-control.action-intent.v1alpha1";
  readonly capability_id: "device.power.set.v1";
  readonly target: Readonly<{
    integration_id: IntegrationId;
    snapshot_generation: IntegrationSnapshotGeneration;
    entity_id: IntegrationEntityId;
    point_key: "is_on";
  }>;
  readonly arguments: Readonly<{ value: boolean }>;
  readonly governance: Readonly<{
    execution: "governed-job";
    default_authorization: "deny";
    permission: "integration.device.control";
    risk: "high";
    confirmation: "required";
    idempotency: "required";
    expiry: "required";
    audit: "required";
    edge_final_decision: true;
  }>;
  readonly authorization: Readonly<{
    policy_decision_id: string;
    subject_id: string;
    permission: "integration.device.control";
    authorized_at_ms: string;
  }>;
  readonly confirmation: Readonly<{
    confirmation_id: string;
    subject_id: string;
    confirmed_at_ms: string;
  }>;
}

export interface IntegrationControlOfferSigningProjection {
  readonly schema: "aether.cloudlink.integration-action-offer.v1alpha1";
  readonly protocol: "aether.cloudlink";
  readonly protocol_version: "1.0";
  readonly extension: "aether.cloudlink.integration-control.v1alpha1";
  readonly message_kind: "integration-action-offer";
  readonly gateway_id: GatewayId;
  readonly session_id: CloudLinkSessionId;
  readonly session_epoch: CloudLinkSessionEpoch;
  readonly credential_generation: GatewayCredentialGeneration;
  readonly job_id: GovernedJobId;
  readonly issued_at_ms: string;
  readonly expires_at_ms: string;
  readonly intent_digest: IntegrationControlDigest;
  readonly intent: IntegrationControlActionIntent;
}

export interface IntegrationControlOfferAuthentication {
  readonly keyId: string;
  readonly algorithm: "Ed25519";
  readonly signature: string;
}

export interface IntegrationControlActionOffer extends IntegrationControlOfferSigningProjection {
  readonly cloud_authentication: Readonly<{
    key_id: string;
    algorithm: "Ed25519";
    signature: string;
  }>;
}

export interface IntegrationStoredIntent extends IntegrationControlScope {
  readonly gatewayId: GatewayId;
  readonly jobId: GovernedJobId;
  readonly intentDigest: IntegrationControlDigest;
  readonly intent: IntegrationControlActionIntent;
  readonly expiresAtMs: string;
  readonly createdAt: UtcInstant;
  readonly latestReceipt: IntegrationControlReceipt | undefined;
  readonly revision: number;
}

export interface IntegrationOfferOutboxRecord extends IntegrationControlScope {
  readonly eventId: string;
  readonly gatewayId: GatewayId;
  readonly jobId: GovernedJobId;
  readonly sessionId: CloudLinkSessionId;
  readonly sessionEpoch: CloudLinkSessionEpoch | string;
  readonly intentDigest: IntegrationControlDigest;
  readonly offer: IntegrationControlActionOffer;
  readonly status: "pending" | "published";
  readonly createdAt: UtcInstant;
  readonly publishedAt?: UtcInstant;
}

export interface IntegrationIntentAndOfferPersistenceInput {
  readonly scope: IntegrationControlScope;
  readonly gatewayId: GatewayId;
  readonly requestId: string;
  readonly subjectId: string;
  readonly offer: IntegrationControlActionOffer;
  readonly createdAt: UtcInstant;
}

export type IntegrationIntentAndOfferPersistenceResult =
  | Readonly<{
      outcome: "persisted" | "replayed";
      intent: IntegrationStoredIntent;
      offer: IntegrationOfferOutboxRecord;
    }>
  | Readonly<{
      outcome:
        | "idempotency-conflict"
        | "intent-conflict"
        | "storage-unavailable";
    }>;

export interface IntegrationReofferPersistenceInput {
  readonly scope: IntegrationControlScope;
  readonly gatewayId: GatewayId;
  readonly requestId: string;
  readonly subjectId: string;
  readonly offer: IntegrationControlActionOffer;
  readonly createdAt: UtcInstant;
}

export type IntegrationReofferPersistenceResult =
  | Readonly<{
      outcome: "persisted" | "replayed";
      offer: IntegrationOfferOutboxRecord;
    }>
  | Readonly<{
      outcome: "intent-conflict" | "not-found" | "storage-unavailable";
    }>;

export interface IntegrationControlDelivery {
  readonly streamId: StreamId;
  readonly streamEpoch: StreamEpoch;
  readonly position: StreamPosition;
  readonly batchId: string;
  readonly digest: IntegrationControlDigest;
}

export interface IntegrationControlCommittedDelivery extends IntegrationControlDelivery {
  readonly messageKind: "integration-action-receipt";
  readonly sentAtMs: string;
  readonly expiresAtMs: string | null;
}

export interface IntegrationReceiptPersistenceInput {
  readonly scope: IntegrationControlScope;
  readonly gatewayId: GatewayId;
  readonly requestId: string;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly sessionId: CloudLinkSessionId;
  readonly sessionEpoch: CloudLinkSessionEpoch;
  readonly delivery: IntegrationControlCommittedDelivery;
  readonly receipt: IntegrationControlReceipt;
  readonly receivedAt: UtcInstant;
}

export interface IntegrationControlReceiptEvidence extends IntegrationControlScope {
  readonly gatewayId: GatewayId;
  readonly jobId: GovernedJobId;
  readonly receipt: IntegrationControlReceipt;
  readonly providerAccepted: boolean;
  readonly physicalCompleted: false;
  readonly jobSucceeded: false;
  readonly auditEventId: string;
  readonly receivedAt: UtcInstant;
}

export interface IntegrationControlDurableAcknowledgement extends IntegrationControlScope {
  readonly gatewayId: GatewayId;
  readonly sessionId: CloudLinkSessionId;
  readonly sessionEpoch: CloudLinkSessionEpoch;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly streamId: StreamId;
  readonly streamEpoch: StreamEpoch;
  readonly acknowledgedPosition: StreamPosition;
  readonly batchId: string;
  readonly digest: IntegrationControlDigest;
  readonly receiptId: string;
  readonly acknowledgedAt: UtcInstant;
}

export type IntegrationReceiptPersistenceResult =
  | Readonly<{
      outcome: "persisted" | "replayed";
      evidence: IntegrationControlReceiptEvidence;
      durableAcknowledgement: IntegrationControlDurableAcknowledgement;
    }>
  | Readonly<{
      outcome:
        | "delivery-conflict"
        | "delivery-gap"
        | "intent-conflict"
        | "not-found"
        | "receipt-conflict"
        | "storage-unavailable"
        | "stream-binding-conflict";
    }>;

export type IntegrationOfferPublishedResult = Readonly<{
  outcome: "not-found" | "published" | "replayed" | "storage-unavailable";
}>;

export interface IntegrationControlRepository {
  persistIntentAndOffer(
    input: IntegrationIntentAndOfferPersistenceInput,
  ): Promise<IntegrationIntentAndOfferPersistenceResult>;
  persistReoffer(
    input: IntegrationReofferPersistenceInput,
  ): Promise<IntegrationReofferPersistenceResult>;
  persistReceipt(
    input: IntegrationReceiptPersistenceInput,
  ): Promise<IntegrationReceiptPersistenceResult>;
  findIntent(
    scope: IntegrationControlScope,
    gatewayId: GatewayId,
    jobId: GovernedJobId,
  ): Promise<IntegrationStoredIntent | undefined>;
  listUnresolvedIntents(
    scope: IntegrationControlScope,
    gatewayId: GatewayId,
  ): Promise<readonly IntegrationStoredIntent[]>;
  listDispatchableOffers(
    scope: IntegrationControlScope,
    gatewayId: GatewayId,
  ): Promise<readonly IntegrationOfferOutboxRecord[]>;
  markOfferPublished(
    scope: IntegrationControlScope,
    eventId: string,
    publishedAt: UtcInstant,
  ): Promise<IntegrationOfferPublishedResult>;
}

export interface IntegrationControlIntentDigestor {
  digest(
    intent: IntegrationControlActionIntent,
  ): Promise<IntegrationControlDigest | string>;
}

export interface IntegrationControlOfferSigner {
  sign(
    offer: IntegrationControlOfferSigningProjection,
  ): Promise<IntegrationControlOfferAuthentication>;
}

export interface IntegrationControlReceiptAuthenticationInput {
  readonly gatewayId: GatewayId;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly sessionId: CloudLinkSessionId;
  readonly sessionEpoch: CloudLinkSessionEpoch;
  readonly sentAtMs: string;
  readonly expiresAtMs?: string;
  readonly traceparent?: string;
  readonly delivery: IntegrationControlDelivery;
  readonly messageAuthentication: Readonly<{
    keyId: string;
    algorithm: "Ed25519";
    signature: string;
  }>;
  readonly receipt: IntegrationControlReceipt;
}

export interface IntegrationControlReceiptAuthenticator {
  verify(input: IntegrationControlReceiptAuthenticationInput): Promise<boolean>;
}

export interface IntegrationControlOfferPublisher {
  publish(offer: IntegrationControlActionOffer): Promise<void>;
}
