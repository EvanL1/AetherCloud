import { createHash } from "node:crypto";

import type {
  CloudLinkDurableAckClaimResult,
  CloudLinkDurableAckCompletionInput,
  CloudLinkDurableAckCompletionResult,
  CloudLinkDurableAckDeliveryRepository,
  CloudLinkDurableAcknowledgement,
  CloudLinkDurableAcknowledgementIntent,
  CloudLinkDurableAckLeaseInput,
  CloudLinkDurableAckRetryInput,
  CloudLinkDurableAckRetryResult,
  TelemetryHistoryQuery,
  TelemetryPersistenceInput,
  TelemetryPersistenceResult,
  TelemetryRepository,
} from "@aether-cloud/application";
import { TelemetryStorageUnavailableError } from "@aether-cloud/application";
import {
  defineTelemetryBatch,
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseRetentionClass,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
  parseTelemetryStreamEpoch,
  parseTelemetryStreamId,
  parseTelemetryStreamPosition,
  parseTenantId,
  parseTopologyPublicationEpoch,
  parseTopologySnapshotDigest,
  parseUtcInstant,
} from "@aether-cloud/domain";
import type {
  GatewayCredentialBinding,
  PersistedTelemetryRecord,
  TelemetryIngestionReceipt,
  TelemetryRecord,
} from "@aether-cloud/domain";

import type {
  PostgresTelemetryClient,
  PostgresTelemetryFaultInjector,
  PostgresTelemetryPool,
} from "./postgres-telemetry-contracts.js";

const maximumUint64 = 18_446_744_073_709_551_615n;
const defaultMaximumRecordsPerGateway = 100_000;
const maximumCoalescingPositions = 4096;

const setTenantSql = `
SELECT set_config('aethercloud.tenant_id', $1::text, true)
`;

const selectRequestSql = `
SELECT
  request.batch_identity AS request_batch_identity,
  request.payload_digest AS request_payload_digest,
  batch.*,
  to_char(batch.persisted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS persisted_at_text,
  batch.contiguous_position::text AS contiguous_position_text,
  batch.gap_expected_position::text AS gap_expected_position_text,
  batch.gap_received_position::text AS gap_received_position_text
FROM aethercloud.telemetry_ingress_requests AS request
JOIN aethercloud.telemetry_batches AS batch
  ON batch.tenant_id = request.tenant_id
 AND batch.project_id = request.project_id
 AND batch.gateway_id = request.gateway_id
 AND batch.stream_id = request.stream_id
 AND batch.stream_epoch = request.stream_epoch
 AND batch.first_position = request.first_position
WHERE request.tenant_id = $1::uuid
  AND request.project_id = $2::uuid
  AND request.gateway_id = $3::uuid
  AND request.request_id = $4
`;

const selectBatchSql = `
SELECT
  batch.*,
  to_char(batch.persisted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS persisted_at_text,
  batch.contiguous_position::text AS contiguous_position_text,
  batch.gap_expected_position::text AS gap_expected_position_text,
  batch.gap_received_position::text AS gap_received_position_text
FROM aethercloud.telemetry_batches AS batch
WHERE batch.tenant_id = $1::uuid
  AND batch.project_id = $2::uuid
  AND batch.gateway_id = $3::uuid
  AND batch.stream_id = $4
  AND batch.stream_epoch = $5::numeric
  AND batch.first_position = $6::numeric
`;

const selectPositionConflictSql = `
SELECT position::text AS position
FROM aethercloud.telemetry_records
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND stream_id = $4
  AND stream_epoch = $5::numeric
  AND position BETWEEN $6::numeric AND $7::numeric
LIMIT 1
`;

const reserveGatewayQuotaSql = `
INSERT INTO aethercloud.telemetry_gateway_usage (
  tenant_id,
  project_id,
  gateway_id,
  record_count
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint)
ON CONFLICT (tenant_id, project_id, gateway_id) DO UPDATE
SET
  record_count = aethercloud.telemetry_gateway_usage.record_count + EXCLUDED.record_count,
  updated_at = clock_timestamp()
WHERE aethercloud.telemetry_gateway_usage.record_count + EXCLUDED.record_count <= $5::bigint
RETURNING record_count::text AS record_count
`;

const insertStreamSql = `
INSERT INTO aethercloud.telemetry_streams (
  tenant_id,
  project_id,
  gateway_id,
  stream_id,
  stream_epoch
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::numeric)
ON CONFLICT (tenant_id, project_id, gateway_id, stream_id, stream_epoch)
DO NOTHING
`;

const selectStreamForUpdateSql = `
SELECT contiguous_position::text AS contiguous_position
FROM aethercloud.telemetry_streams
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND stream_id = $4
  AND stream_epoch = $5::numeric
FOR UPDATE
`;

const insertBatchSql = `
INSERT INTO aethercloud.telemetry_batches (
  tenant_id,
  project_id,
  gateway_id,
  stream_id,
  stream_epoch,
  first_position,
  last_position,
  batch_identity,
  payload_digest,
  credential_generation,
  record_count,
  received_at,
  persisted_at,
  retention_class,
  topology_publication_epoch,
  topology_snapshot_digest,
  receipt_id,
  audit_event_id,
  outbox_event_id,
  contiguous_position,
  gap_expected_position,
  gap_received_position
) VALUES (
  $1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, $6::numeric,
  $7::numeric, $8, $9, $10::numeric, $11::smallint, $12::timestamptz,
  $13::timestamptz, $14, $15::numeric, $16, $17, $18, $19,
  $20::numeric, $21::numeric, $22::numeric
)
`;

const insertRecordSql = `
INSERT INTO aethercloud.telemetry_records (
  tenant_id,
  project_id,
  gateway_id,
  stream_id,
  stream_epoch,
  position,
  batch_first_position,
  batch_identity,
  source_timestamp_ms,
  record_kind,
  record_payload,
  received_at,
  persisted_at
) VALUES (
  $1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, $6::numeric,
  $7::numeric, $8, $9::numeric, $10, $11::jsonb, $12::timestamptz,
  $13::timestamptz
)
`;

const insertRequestSql = `
INSERT INTO aethercloud.telemetry_ingress_requests (
  tenant_id,
  project_id,
  gateway_id,
  request_id,
  stream_id,
  stream_epoch,
  first_position,
  batch_identity,
  payload_digest,
  recorded_at
) VALUES (
  $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7::numeric,
  $8, $9, $10::timestamptz
)
ON CONFLICT (tenant_id, project_id, gateway_id, request_id) DO NOTHING
RETURNING request_id
`;

const selectFollowingPositionsSql = `
SELECT position::text AS position
FROM aethercloud.telemetry_records
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND stream_id = $4
  AND stream_epoch = $5::numeric
  AND position > $6::numeric
ORDER BY position
LIMIT $7::integer
`;

const updateStreamCursorSql = `
UPDATE aethercloud.telemetry_streams
SET contiguous_position = $6::numeric, updated_at = clock_timestamp()
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND stream_id = $4
  AND stream_epoch = $5::numeric
`;

const insertAuditSql = `
INSERT INTO aethercloud.audit_events (
  event_id,
  tenant_id,
  project_id,
  occurred_at,
  subject_kind,
  subject_id,
  action,
  resource_kind,
  resource_id,
  outcome,
  risk,
  confirmation,
  correlation_id,
  details_digest
) VALUES (
  $1, $2::uuid, $3::uuid, $4::timestamptz, 'gateway', $5,
  'telemetry.batch.ingest', 'telemetry-batch', $6, 'accepted', 'low',
  'not-required', $7, $8
)
`;

const insertIntegrationOutboxSql = `
INSERT INTO aethercloud.outbox_events (
  event_id,
  tenant_id,
  project_id,
  occurred_at,
  event_name,
  aggregate_kind,
  aggregate_id,
  payload
) VALUES (
  $1, $2::uuid, $3::uuid, $4::timestamptz,
  'telemetry.batch-accepted.v1', 'telemetry-batch', $5, $6::jsonb
)
`;

const upsertDurableAckSql = `
INSERT INTO aethercloud.cloudlink_durable_ack_outbox (
  outbox_event_id,
  tenant_id,
  project_id,
  gateway_id,
  session_id,
  session_epoch,
  credential_generation,
  stream_id,
  stream_epoch,
  acknowledged_position,
  telemetry_stream_id,
  telemetry_stream_epoch,
  telemetry_first_position,
  batch_id,
  digest,
  receipt_id,
  acknowledged_at,
  available_at
) VALUES (
  $1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::numeric,
  $7::numeric, $8, $9::numeric, $10::numeric, $11, $12::numeric,
  $13::numeric, $14, $15, $16, $17::timestamptz, $17::timestamptz
)
ON CONFLICT (tenant_id, project_id, outbox_event_id) DO UPDATE
SET
  available_at = LEAST(
    aethercloud.cloudlink_durable_ack_outbox.available_at,
    EXCLUDED.available_at
  ),
  published_at = NULL,
  leased_by = NULL,
  lease_expires_at = NULL,
  last_error_code = NULL
WHERE aethercloud.cloudlink_durable_ack_outbox.tenant_id = EXCLUDED.tenant_id
  AND aethercloud.cloudlink_durable_ack_outbox.project_id = EXCLUDED.project_id
  AND aethercloud.cloudlink_durable_ack_outbox.gateway_id = EXCLUDED.gateway_id
  AND aethercloud.cloudlink_durable_ack_outbox.session_id = EXCLUDED.session_id
  AND aethercloud.cloudlink_durable_ack_outbox.session_epoch = EXCLUDED.session_epoch
  AND aethercloud.cloudlink_durable_ack_outbox.credential_generation = EXCLUDED.credential_generation
  AND aethercloud.cloudlink_durable_ack_outbox.stream_id = EXCLUDED.stream_id
  AND aethercloud.cloudlink_durable_ack_outbox.stream_epoch = EXCLUDED.stream_epoch
  AND aethercloud.cloudlink_durable_ack_outbox.acknowledged_position = EXCLUDED.acknowledged_position
  AND aethercloud.cloudlink_durable_ack_outbox.telemetry_stream_id = EXCLUDED.telemetry_stream_id
  AND aethercloud.cloudlink_durable_ack_outbox.telemetry_stream_epoch = EXCLUDED.telemetry_stream_epoch
  AND aethercloud.cloudlink_durable_ack_outbox.telemetry_first_position = EXCLUDED.telemetry_first_position
  AND aethercloud.cloudlink_durable_ack_outbox.batch_id = EXCLUDED.batch_id
  AND aethercloud.cloudlink_durable_ack_outbox.digest = EXCLUDED.digest
  AND aethercloud.cloudlink_durable_ack_outbox.receipt_id = EXCLUDED.receipt_id
RETURNING
  outbox_event_id,
  tenant_id::text AS tenant_id,
  project_id::text AS project_id,
  gateway_id::text AS gateway_id,
  session_id::text AS session_id,
  session_epoch::text AS session_epoch,
  credential_generation::text AS credential_generation,
  stream_id,
  stream_epoch::text AS stream_epoch,
  acknowledged_position::text AS acknowledged_position,
  batch_id,
  digest,
  receipt_id,
  to_char(acknowledged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS acknowledged_at
`;

const claimDurableAcksSql = `
WITH pending_ack AS (
  SELECT sequence
  FROM aethercloud.cloudlink_durable_ack_outbox
  WHERE tenant_id = $1::uuid
    AND project_id = $2::uuid
    AND published_at IS NULL
    AND available_at <= $4::timestamptz
    AND (lease_expires_at IS NULL OR lease_expires_at <= $4::timestamptz)
  ORDER BY available_at, sequence
  LIMIT $6::integer
  FOR UPDATE SKIP LOCKED
)
UPDATE aethercloud.cloudlink_durable_ack_outbox AS ack
SET
  leased_by = $3,
  lease_expires_at = $5::timestamptz,
  attempt_count = ack.attempt_count + 1
FROM pending_ack
WHERE ack.sequence = pending_ack.sequence
RETURNING
  ack.outbox_event_id,
  ack.tenant_id::text AS tenant_id,
  ack.project_id::text AS project_id,
  ack.gateway_id::text AS gateway_id,
  ack.session_id::text AS session_id,
  ack.session_epoch::text AS session_epoch,
  ack.credential_generation::text AS credential_generation,
  ack.stream_id,
  ack.stream_epoch::text AS stream_epoch,
  ack.acknowledged_position::text AS acknowledged_position,
  ack.batch_id,
  ack.digest,
  ack.receipt_id,
  to_char(ack.acknowledged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS acknowledged_at
`;

const markPublishedSql = `
UPDATE aethercloud.cloudlink_durable_ack_outbox
SET
  published_at = $5::timestamptz,
  leased_by = NULL,
  lease_expires_at = NULL,
  last_error_code = NULL
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND outbox_event_id = $3
  AND leased_by = $4
  AND published_at IS NULL
  AND lease_expires_at > $5::timestamptz
  AND lease_expires_at > clock_timestamp()
RETURNING outbox_event_id
`;

const releaseForRetrySql = `
UPDATE aethercloud.cloudlink_durable_ack_outbox
SET
  available_at = $5::timestamptz,
  leased_by = NULL,
  lease_expires_at = NULL,
  last_error_code = $6
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND outbox_event_id = $3
  AND leased_by = $4
  AND published_at IS NULL
RETURNING outbox_event_id
`;

const selectAckExistenceSql = `
SELECT leased_by
FROM aethercloud.cloudlink_durable_ack_outbox
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND outbox_event_id = $3
`;

const selectHistorySql = `
SELECT
  record.batch_identity,
  record.record_kind,
  record.record_payload,
  to_char(record.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at,
  to_char(record.persisted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS persisted_at,
  batch.retention_class,
  batch.topology_publication_epoch::text AS topology_publication_epoch,
  batch.topology_snapshot_digest
FROM aethercloud.telemetry_records AS record
JOIN aethercloud.telemetry_batches AS batch
  ON batch.tenant_id = record.tenant_id
 AND batch.project_id = record.project_id
 AND batch.gateway_id = record.gateway_id
 AND batch.stream_id = record.stream_id
 AND batch.stream_epoch = record.stream_epoch
 AND batch.first_position = record.batch_first_position
WHERE record.tenant_id = $1::uuid
  AND record.project_id = $2::uuid
  AND record.gateway_id = $3::uuid
  AND record.stream_id = $4
  AND record.stream_epoch = $5::numeric
  AND record.position >= $6::numeric
ORDER BY record.position
LIMIT $7::integer
`;

type Row = Record<string, unknown>;

function stringField(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`PostgreSQL telemetry row has invalid ${field}`);
  }
  return value;
}

function optionalString(row: Row, field: string): string | undefined {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  return stringField(row, field);
}

function stableId(prefix: string, fields: readonly string[]): string {
  const digest = createHash("sha256")
    .update(fields.join("\u0000"), "utf8")
    .digest("hex");
  return `${prefix}:${digest}`;
}

function receiptId(input: TelemetryPersistenceInput): string {
  return stableId("receipt:telemetry", [
    input.binding.tenantId,
    input.binding.projectId,
    input.binding.gatewayId,
    input.batch.batchIdentity,
    input.payloadDigest,
  ]);
}

function acknowledgementReceiptId(batchId: string): string {
  const candidate = `receipt:cloudlink:${batchId}`;
  return candidate.length <= 128
    ? candidate
    : stableId("receipt:cloudlink", [batchId]);
}

function auditEventId(input: TelemetryPersistenceInput): string {
  return stableId("audit:telemetry", [
    input.binding.tenantId,
    input.binding.gatewayId,
    input.batch.batchIdentity,
    input.payloadDigest,
  ]);
}

function integrationOutboxEventId(input: TelemetryPersistenceInput): string {
  return stableId("outbox:telemetry", [
    input.binding.tenantId,
    input.binding.gatewayId,
    input.batch.batchIdentity,
    input.payloadDigest,
  ]);
}

function durableAckEventId(
  binding: GatewayCredentialBinding,
  intent: CloudLinkDurableAcknowledgementIntent,
): string {
  return stableId("outbox:cloudlink-ack", [
    binding.tenantId,
    binding.projectId,
    binding.gatewayId,
    intent.sessionId,
    intent.sessionEpoch,
    intent.streamId,
    intent.streamEpoch,
    intent.acknowledgedPosition,
    intent.batchId,
    intent.digest,
  ]);
}

function decodeReceipt(row: Row): TelemetryIngestionReceipt {
  const contiguousPosition = optionalString(row, "contiguous_position_text");
  const gapExpected = optionalString(row, "gap_expected_position_text");
  const gapReceived = optionalString(row, "gap_received_position_text");
  const recordCount = Number(row.record_count);
  if (!Number.isInteger(recordCount) || recordCount < 1 || recordCount > 256) {
    throw new Error("PostgreSQL telemetry row has invalid record_count");
  }
  if ((gapExpected === undefined) !== (gapReceived === undefined)) {
    throw new Error("PostgreSQL telemetry row has incomplete gap evidence");
  }
  return Object.freeze({
    receiptId: stringField(row, "receipt_id"),
    tenantId: parseTenantId(row.tenant_id),
    projectId: parseProjectId(row.project_id),
    gatewayId: parseGatewayId(row.gateway_id),
    credentialGeneration: parseGatewayCredentialGeneration(
      row.credential_generation,
    ),
    batchIdentity: stringField(row, "batch_identity"),
    payloadDigest: stringField(row, "payload_digest"),
    streamId: parseTelemetryStreamId(row.stream_id),
    streamEpoch: parseTelemetryStreamEpoch(row.stream_epoch),
    firstPosition: parseTelemetryStreamPosition(row.first_position),
    lastPosition: parseTelemetryStreamPosition(row.last_position),
    recordCount,
    persistedAt: parseUtcInstant(row.persisted_at_text),
    ...(contiguousPosition === undefined
      ? {}
      : {
          contiguousPosition: parseTelemetryStreamPosition(contiguousPosition),
        }),
    ...(gapExpected === undefined || gapReceived === undefined
      ? {}
      : {
          gap: Object.freeze({
            expectedPosition: parseTelemetryStreamPosition(gapExpected),
            receivedPosition: parseTelemetryStreamPosition(gapReceived),
          }),
        }),
    auditEventId: stringField(row, "audit_event_id"),
    outboxEventId: stringField(row, "outbox_event_id"),
  });
}

function decodeAcknowledgement(row: Row): CloudLinkDurableAcknowledgement {
  const digest = stringField(row, "digest");
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error("PostgreSQL ACK row has invalid digest");
  }
  return Object.freeze({
    outboxEventId: stringField(row, "outbox_event_id"),
    tenantId: parseTenantId(row.tenant_id),
    projectId: parseProjectId(row.project_id),
    gatewayId: parseGatewayId(row.gateway_id),
    sessionId: parseCloudLinkSessionId(row.session_id),
    sessionEpoch: parseCloudLinkSessionEpoch(row.session_epoch),
    credentialGeneration: parseGatewayCredentialGeneration(
      row.credential_generation,
    ),
    streamId: parseStreamId(row.stream_id),
    streamEpoch: parseStreamEpoch(row.stream_epoch),
    acknowledgedPosition: parseStreamPosition(row.acknowledged_position),
    batchId: stringField(row, "batch_id"),
    digest,
    receiptId: stringField(row, "receipt_id"),
    acknowledgedAt: parseUtcInstant(row.acknowledged_at),
  });
}

function validateAcknowledgementIntent(
  input: TelemetryPersistenceInput,
  intent: CloudLinkDurableAcknowledgementIntent,
): void {
  if (
    intent.credentialGeneration !== input.binding.generation ||
    String(intent.streamId) !== input.batch.streamId ||
    String(intent.streamEpoch) !== input.batch.streamEpoch ||
    intent.acceptedTelemetryPosition !== input.batch.lastPosition
  ) {
    throw new Error("CloudLink ACK intent contradicts telemetry acceptance");
  }
}

function newReceipt(
  input: TelemetryPersistenceInput,
  contiguous: bigint,
  expected: bigint,
  hasGap: boolean,
): TelemetryIngestionReceipt {
  const audit = auditEventId(input);
  const outbox = integrationOutboxEventId(input);
  return Object.freeze({
    receiptId: receiptId(input),
    tenantId: input.binding.tenantId,
    projectId: input.binding.projectId,
    gatewayId: input.binding.gatewayId,
    credentialGeneration: input.binding.generation,
    batchIdentity: input.batch.batchIdentity,
    payloadDigest: input.payloadDigest,
    streamId: input.batch.streamId,
    streamEpoch: input.batch.streamEpoch,
    firstPosition: input.batch.firstPosition,
    lastPosition: input.batch.lastPosition,
    recordCount: input.batch.recordCount,
    persistedAt: input.receivedAt,
    ...(contiguous < 0n
      ? {}
      : {
          contiguousPosition: parseTelemetryStreamPosition(
            contiguous.toString(),
          ),
        }),
    ...(hasGap
      ? {
          gap: Object.freeze({
            expectedPosition: parseTelemetryStreamPosition(expected.toString()),
            receivedPosition: input.batch.firstPosition,
          }),
        }
      : {}),
    auditEventId: audit,
    outboxEventId: outbox,
  });
}

function duplicateMatches(input: TelemetryPersistenceInput, row: Row): boolean {
  return (
    stringField(row, "batch_identity") === input.batch.batchIdentity &&
    stringField(row, "payload_digest") === input.payloadDigest
  );
}

function requestDuplicateMatches(
  input: TelemetryPersistenceInput,
  row: Row,
): boolean {
  return (
    stringField(row, "request_batch_identity") === input.batch.batchIdentity &&
    stringField(row, "request_payload_digest") === input.payloadDigest &&
    duplicateMatches(input, row)
  );
}

function valuesForScope(input: {
  readonly tenantId: string;
  readonly projectId: string;
  readonly gatewayId: string;
}): readonly [string, string, string] {
  return [input.tenantId, input.projectId, input.gatewayId];
}

function recordJson(record: TelemetryRecord): string {
  return JSON.stringify(record);
}

function rowRecord(input: unknown): TelemetryRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("PostgreSQL telemetry record payload is invalid");
  }
  return input as TelemetryRecord;
}

export class PostgresTelemetryRepository
  implements TelemetryRepository, CloudLinkDurableAckDeliveryRepository
{
  readonly #pool: PostgresTelemetryPool;
  readonly #maximumRecordsPerGateway: number;
  readonly #faultInjector: PostgresTelemetryFaultInjector | undefined;

  constructor(
    pool: PostgresTelemetryPool,
    options: {
      readonly maximumRecordsPerGateway?: number;
      readonly faultInjector?: PostgresTelemetryFaultInjector;
    } = {},
  ) {
    this.#pool = pool;
    this.#maximumRecordsPerGateway =
      options.maximumRecordsPerGateway ?? defaultMaximumRecordsPerGateway;
    this.#faultInjector = options.faultInjector;
    if (
      !Number.isSafeInteger(this.#maximumRecordsPerGateway) ||
      this.#maximumRecordsPerGateway < 1
    ) {
      throw new Error(
        "maximumRecordsPerGateway must be a positive safe integer",
      );
    }
  }

  async persist(
    input: TelemetryPersistenceInput,
  ): Promise<TelemetryPersistenceResult> {
    let client: PostgresTelemetryClient | undefined;
    let transactionStarted = false;
    let committed = false;
    try {
      client = await this.#pool.connect();
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(setTenantSql, [input.binding.tenantId]);
      const result = await this.#persistInTransaction(client, input);
      await this.#faultInjector?.beforeCommit?.();
      await client.query("COMMIT");
      committed = true;
      await this.#faultInjector?.afterCommit?.();
      return result;
    } catch {
      if (client !== undefined && transactionStarted && !committed) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The caller receives only the typed storage-unavailable outcome.
        }
      }
      return { outcome: "storage-unavailable" };
    } finally {
      client?.release();
    }
  }

  async #persistInTransaction(
    client: PostgresTelemetryClient,
    input: TelemetryPersistenceInput,
  ): Promise<TelemetryPersistenceResult> {
    const scope = valuesForScope(input.binding);
    const priorRequest = await client.query<Row>(selectRequestSql, [
      ...scope,
      input.requestId,
    ]);
    const requestRow = priorRequest.rows[0];
    if (requestRow !== undefined) {
      if (!requestDuplicateMatches(input, requestRow)) {
        return { outcome: "conflicting-replay" };
      }
      const receipt = decodeReceipt(requestRow);
      const acknowledgement = await this.#upsertAcknowledgement(
        client,
        input,
        receipt,
      );
      return {
        outcome: "duplicate",
        receipt,
        ...(acknowledgement === undefined
          ? {}
          : { durableAcknowledgement: acknowledgement }),
      };
    }

    const priorBatch = await client.query<Row>(selectBatchSql, [
      ...scope,
      input.batch.streamId,
      input.batch.streamEpoch,
      input.batch.firstPosition,
    ]);
    const batchRow = priorBatch.rows[0];
    if (batchRow !== undefined) {
      if (!duplicateMatches(input, batchRow)) {
        return { outcome: "conflicting-replay" };
      }
      await this.#insertRequest(client, input);
      const receipt = decodeReceipt(batchRow);
      const acknowledgement = await this.#upsertAcknowledgement(
        client,
        input,
        receipt,
      );
      return {
        outcome: "duplicate",
        receipt,
        ...(acknowledgement === undefined
          ? {}
          : { durableAcknowledgement: acknowledgement }),
      };
    }

    const conflict = await client.query<Row>(selectPositionConflictSql, [
      ...scope,
      input.batch.streamId,
      input.batch.streamEpoch,
      input.batch.firstPosition,
      input.batch.lastPosition,
    ]);
    if (conflict.rows.length > 0) return { outcome: "position-conflict" };

    const stream = await client.query<Row>(selectStreamForUpdateSql, [
      ...scope,
      input.batch.streamId,
      input.batch.streamEpoch,
    ]);
    const streamRow = stream.rows[0];
    const priorContiguousText =
      streamRow === undefined
        ? undefined
        : optionalString(streamRow, "contiguous_position");
    const priorContiguous =
      priorContiguousText === undefined ? -1n : BigInt(priorContiguousText);
    const expected = priorContiguous + 1n;
    const received = BigInt(input.batch.firstPosition);
    if (received < expected) return { outcome: "position-conflict" };
    if (received - expected > BigInt(maximumCoalescingPositions)) {
      return { outcome: "position-conflict" };
    }
    const hasGap = received > expected;
    let contiguous = hasGap
      ? priorContiguous
      : BigInt(input.batch.lastPosition);
    if (!hasGap) {
      const following = await client.query<Row>(selectFollowingPositionsSql, [
        ...scope,
        input.batch.streamId,
        input.batch.streamEpoch,
        contiguous.toString(),
        maximumCoalescingPositions,
      ]);
      for (const row of following.rows) {
        const position = BigInt(stringField(row, "position"));
        if (position !== contiguous + 1n) break;
        contiguous = position;
        if (contiguous === maximumUint64) break;
      }
    }

    const quota = await client.query<Row>(reserveGatewayQuotaSql, [
      ...scope,
      input.batch.recordCount,
      this.#maximumRecordsPerGateway,
    ]);
    if (quota.rowCount !== 1) return { outcome: "quota-exceeded" };
    await client.query(insertStreamSql, [
      ...scope,
      input.batch.streamId,
      input.batch.streamEpoch,
    ]);
    const receipt = newReceipt(input, contiguous, expected, hasGap);

    await client.query(insertBatchSql, [
      ...scope,
      input.batch.streamId,
      input.batch.streamEpoch,
      input.batch.firstPosition,
      input.batch.lastPosition,
      input.batch.batchIdentity,
      input.payloadDigest,
      input.binding.generation,
      input.batch.recordCount,
      input.receivedAt,
      receipt.persistedAt,
      input.batch.retentionClass,
      input.batch.topology.publicationEpoch,
      input.batch.topology.snapshotDigest,
      receipt.receiptId,
      receipt.auditEventId,
      receipt.outboxEventId,
      contiguous < 0n ? null : contiguous.toString(),
      hasGap ? expected.toString() : null,
      hasGap ? input.batch.firstPosition : null,
    ]);
    for (const record of input.batch.records) {
      await client.query(insertRecordSql, [
        ...scope,
        input.batch.streamId,
        input.batch.streamEpoch,
        record.position,
        input.batch.firstPosition,
        input.batch.batchIdentity,
        record.sourceTimestampMs,
        record.kind,
        recordJson(record),
        input.receivedAt,
        receipt.persistedAt,
      ]);
    }
    await this.#insertRequest(client, input);

    if (!hasGap) {
      await client.query(updateStreamCursorSql, [
        ...scope,
        input.batch.streamId,
        input.batch.streamEpoch,
        contiguous.toString(),
      ]);
    }

    await client.query(insertAuditSql, [
      receipt.auditEventId,
      input.binding.tenantId,
      input.binding.projectId,
      receipt.persistedAt,
      input.binding.gatewayId,
      receipt.receiptId,
      input.requestId,
      input.payloadDigest,
    ]);
    await client.query(insertIntegrationOutboxSql, [
      receipt.outboxEventId,
      input.binding.tenantId,
      input.binding.projectId,
      receipt.persistedAt,
      receipt.receiptId,
      JSON.stringify({
        batchIdentity: input.batch.batchIdentity,
        payloadDigest: input.payloadDigest,
        receiptId: receipt.receiptId,
      }),
    ]);
    const acknowledgement = await this.#upsertAcknowledgement(
      client,
      input,
      receipt,
    );
    return {
      outcome: "persisted",
      receipt,
      ...(acknowledgement === undefined
        ? {}
        : { durableAcknowledgement: acknowledgement }),
    };
  }

  async #insertRequest(
    client: PostgresTelemetryClient,
    input: TelemetryPersistenceInput,
  ): Promise<void> {
    const inserted = await client.query(insertRequestSql, [
      ...valuesForScope(input.binding),
      input.requestId,
      input.batch.streamId,
      input.batch.streamEpoch,
      input.batch.firstPosition,
      input.batch.batchIdentity,
      input.payloadDigest,
      input.receivedAt,
    ]);
    if (inserted.rowCount !== 1) {
      throw new Error("PostgreSQL telemetry request identity was raced");
    }
  }

  async #upsertAcknowledgement(
    client: PostgresTelemetryClient,
    input: TelemetryPersistenceInput,
    receipt: TelemetryIngestionReceipt,
  ): Promise<CloudLinkDurableAcknowledgement | undefined> {
    const intent = input.durableAcknowledgement;
    if (intent === undefined) return undefined;
    validateAcknowledgementIntent(input, intent);
    const stored = await client.query<Row>(upsertDurableAckSql, [
      durableAckEventId(input.binding, intent),
      ...valuesForScope(input.binding),
      intent.sessionId,
      intent.sessionEpoch,
      intent.credentialGeneration,
      intent.streamId,
      intent.streamEpoch,
      intent.acknowledgedPosition,
      input.batch.streamId,
      input.batch.streamEpoch,
      intent.acceptedTelemetryPosition,
      intent.batchId,
      intent.digest,
      acknowledgementReceiptId(intent.batchId),
      intent.acknowledgedAt,
    ]);
    const row = stored.rows[0];
    if (stored.rowCount !== 1 || row === undefined) {
      throw new Error("PostgreSQL durable ACK upsert was rejected");
    }
    const acknowledgement = decodeAcknowledgement(row);
    if (
      acknowledgement.tenantId !== receipt.tenantId ||
      acknowledgement.projectId !== receipt.projectId ||
      acknowledgement.gatewayId !== receipt.gatewayId
    ) {
      throw new Error("PostgreSQL durable ACK scope is invalid");
    }
    return acknowledgement;
  }

  async queryHistory(
    query: TelemetryHistoryQuery,
  ): Promise<readonly PersistedTelemetryRecord[]> {
    let client: PostgresTelemetryClient | undefined;
    let transactionStarted = false;
    try {
      client = await this.#pool.connect();
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(setTenantSql, [query.tenantId]);
      const selected = await client.query<Row>(selectHistorySql, [
        query.tenantId,
        query.projectId,
        query.gatewayId,
        query.streamId,
        query.streamEpoch,
        query.fromPosition,
        query.limit,
      ]);
      const records = selected.rows.map((row) => {
        const topology = {
          publicationEpoch: parseTopologyPublicationEpoch(
            row.topology_publication_epoch,
          ),
          snapshotDigest: parseTopologySnapshotDigest(
            row.topology_snapshot_digest,
          ),
        };
        const record = rowRecord(row.record_payload);
        if (stringField(row, "record_kind") !== record.kind) {
          throw new Error("PostgreSQL telemetry record kind is contradictory");
        }
        const checked = defineTelemetryBatch({
          streamId: query.streamId,
          streamEpoch: query.streamEpoch,
          topology,
          retentionClass: parseRetentionClass(row.retention_class),
          replay: false,
          records: [record],
        }).records[0];
        if (checked === undefined) {
          throw new Error("PostgreSQL telemetry record is missing");
        }
        return Object.freeze({
          tenantId: query.tenantId,
          projectId: query.projectId,
          gatewayId: query.gatewayId,
          streamId: query.streamId,
          streamEpoch: query.streamEpoch,
          topology,
          batchIdentity: stringField(row, "batch_identity"),
          receivedAt: parseUtcInstant(row.received_at),
          persistedAt: parseUtcInstant(row.persisted_at),
          retentionClass: parseRetentionClass(row.retention_class),
          record: checked,
        });
      });
      await client.query("COMMIT");
      transactionStarted = false;
      return Object.freeze(records);
    } catch {
      if (client !== undefined && transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the sanitized storage failure below.
        }
      }
      throw new TelemetryStorageUnavailableError(
        "PostgreSQL telemetry storage is unavailable",
      );
    } finally {
      client?.release();
    }
  }

  claimPending(
    input: CloudLinkDurableAckLeaseInput,
  ): Promise<CloudLinkDurableAckClaimResult> {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      input.leaseExpiresAt <= input.now
    ) {
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    return this.#ackTransaction(input.tenantId, async (client) => {
      const claimed = await client.query<Row>(claimDurableAcksSql, [
        input.tenantId,
        input.projectId,
        input.workerId,
        input.now,
        input.leaseExpiresAt,
        input.limit,
      ]);
      return {
        outcome: "claimed" as const,
        acknowledgements: Object.freeze(
          claimed.rows.map(decodeAcknowledgement),
        ),
      };
    }).then((result) =>
      result.ok ? result.value : { outcome: "storage-unavailable" },
    );
  }

  markPublished(
    input: CloudLinkDurableAckCompletionInput,
  ): Promise<CloudLinkDurableAckCompletionResult> {
    return this.#ackTransaction(input.tenantId, async (client) => {
      const marked = await client.query<Row>(markPublishedSql, [
        input.tenantId,
        input.projectId,
        input.outboxEventId,
        input.workerId,
        input.publishedAt,
      ]);
      if (marked.rowCount === 1) return "marked" as const;
      return this.#missingOrLeaseConflict(client, input);
    }).then((result) => (result.ok ? result.value : "storage-unavailable"));
  }

  releaseForRetry(
    input: CloudLinkDurableAckRetryInput,
  ): Promise<CloudLinkDurableAckRetryResult> {
    return this.#ackTransaction(input.tenantId, async (client) => {
      const released = await client.query<Row>(releaseForRetrySql, [
        input.tenantId,
        input.projectId,
        input.outboxEventId,
        input.workerId,
        input.retryAt,
        input.errorCode,
      ]);
      if (released.rowCount === 1) return "released" as const;
      return this.#missingOrLeaseConflict(client, input);
    }).then((result) => (result.ok ? result.value : "storage-unavailable"));
  }

  async #missingOrLeaseConflict(
    client: PostgresTelemetryClient,
    input: {
      readonly tenantId: string;
      readonly projectId: string;
      readonly outboxEventId: string;
    },
  ): Promise<"lease-conflict" | "not-found"> {
    const found = await client.query<Row>(selectAckExistenceSql, [
      input.tenantId,
      input.projectId,
      input.outboxEventId,
    ]);
    return found.rowCount === 0 ? "not-found" : "lease-conflict";
  }

  async #ackTransaction<Result>(
    tenantId: string,
    operation: (client: PostgresTelemetryClient) => Promise<Result>,
  ): Promise<Readonly<{ ok: true; value: Result }> | Readonly<{ ok: false }>> {
    let client: PostgresTelemetryClient | undefined;
    let transactionStarted = false;
    try {
      client = await this.#pool.connect();
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(setTenantSql, [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      transactionStarted = false;
      return { ok: true, value: result };
    } catch {
      if (client !== undefined && transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Return only the bounded storage failure.
        }
      }
      return { ok: false };
    } finally {
      client?.release();
    }
  }
}
