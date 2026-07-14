import type {
  AlarmFact,
  AlarmOccurrenceId,
  AlarmProjection,
  GatewayCredentialBinding,
  GatewayId,
  ProjectId,
  TenantId,
  UtcInstant,
} from "@aether-cloud/domain";

export interface AlarmProjectionRecord {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly receivedAt: UtcInstant;
  readonly projection: AlarmProjection;
  readonly acknowledgement?: Readonly<{
    subjectId: string;
    acknowledgedAt: UtcInstant;
  }>;
}

export interface AlarmFactDigestor {
  digest(fact: AlarmFact): Promise<string>;
}

export interface AlarmIngestionInput {
  readonly requestId: string;
  readonly binding: GatewayCredentialBinding;
  readonly fact: AlarmFact;
  readonly payloadDigest: string;
  readonly receivedAt: UtcInstant;
}

export type AlarmIngestionResult =
  | Readonly<{
      outcome: "persisted" | "replayed";
      disposition:
        | "accepted-gap"
        | "accepted-late"
        | "accepted-latest"
        | "replayed";
      record: AlarmProjectionRecord;
    }>
  | Readonly<{ outcome: "fact-conflict" }>
  | Readonly<{ outcome: "sequence-conflict" }>
  | Readonly<{ outcome: "storage-unavailable" }>;

export interface AlarmScope {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

export interface AlarmAcknowledgementInput extends AlarmScope {
  readonly occurrenceId: AlarmOccurrenceId;
  readonly requestId: string;
  readonly subjectId: string;
  readonly acknowledgedAt: UtcInstant;
}

export type AlarmAcknowledgementResult =
  | Readonly<{
      outcome: "acknowledged" | "replayed";
      record: AlarmProjectionRecord;
    }>
  | Readonly<{ outcome: "concurrent-modification" }>
  | Readonly<{ outcome: "idempotency-conflict" }>
  | Readonly<{ outcome: "not-found" }>
  | Readonly<{ outcome: "storage-unavailable" }>;

export interface AlarmRepository {
  ingest(input: AlarmIngestionInput): Promise<AlarmIngestionResult>;
  findCurrent(
    scope: AlarmScope,
    occurrenceId: AlarmOccurrenceId,
  ): Promise<AlarmProjectionRecord | undefined>;
  acknowledge(
    input: AlarmAcknowledgementInput,
  ): Promise<AlarmAcknowledgementResult>;
}
