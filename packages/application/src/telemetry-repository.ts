import type {
  GatewayCredentialBinding,
  GatewayId,
  PersistedTelemetryRecord,
  ProjectId,
  TelemetryBatch,
  TelemetryIngestionReceipt,
  TelemetryStreamEpoch,
  TelemetryStreamId,
  TelemetryStreamPosition,
  TenantId,
  UtcInstant,
} from "@aether-cloud/domain";

export interface TelemetryBatchDigestor {
  digest(batch: TelemetryBatch): Promise<string>;
}

export interface TelemetryPersistenceInput {
  readonly requestId: string;
  readonly binding: GatewayCredentialBinding;
  readonly batch: TelemetryBatch;
  readonly payloadDigest: string;
  readonly receivedAt: UtcInstant;
}

export type TelemetryPersistenceResult =
  | Readonly<{
      outcome: "duplicate" | "persisted";
      receipt: TelemetryIngestionReceipt;
    }>
  | Readonly<{
      outcome:
        | "conflicting-replay"
        | "position-conflict"
        | "quota-exceeded"
        | "storage-unavailable";
    }>;

export interface TelemetryHistoryQuery {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly streamId: TelemetryStreamId;
  readonly streamEpoch: TelemetryStreamEpoch;
  readonly fromPosition: TelemetryStreamPosition;
  readonly limit: number;
}

export interface TelemetryRepository {
  persist(
    input: TelemetryPersistenceInput,
  ): Promise<TelemetryPersistenceResult>;
  queryHistory(
    query: TelemetryHistoryQuery,
  ): Promise<readonly PersistedTelemetryRecord[]>;
}
