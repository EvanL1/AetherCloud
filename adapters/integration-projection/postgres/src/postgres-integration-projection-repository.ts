import { createHash } from "node:crypto";

import { IntegrationProjectionStorageUnavailableError } from "@aether-cloud/application";
import type {
  IntegrationCloudLinkDelivery,
  IntegrationCloudLinkDurableAcknowledgement,
  IntegrationCloudLinkMessageKind,
  IntegrationObservationPersistenceInput,
  IntegrationObservationPersistenceReceipt,
  IntegrationObservationPersistenceResult,
  IntegrationProjectionCatalog,
  IntegrationProjectionCatalogQuery,
  IntegrationProjectionCatalogRecord,
  IntegrationProjectionRecord,
  IntegrationProjectionRepository,
  IntegrationProjectionScope,
  IntegrationTopologyPersistenceInput,
  IntegrationTopologyPersistenceReceipt,
  IntegrationTopologyPersistenceResult,
  IntegrationTopologyHistoryRecord,
} from "@aether-cloud/application";
import {
  defineIntegrationObservationBatch,
  defineIntegrationTopologySnapshot,
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseIntegrationBatchId,
  parseIntegrationId,
  parseIntegrationKind,
  parseIntegrationSnapshotGeneration,
  parseProjectId,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
  parseTenantId,
  parseUtcInstant,
  type IntegrationAreaInput,
  type IntegrationDeviceInput,
  type IntegrationEntityInput,
  type IntegrationEntityPointDescriptorInput,
  type IntegrationObservation,
  type IntegrationObservationInput,
  type IntegrationObservedValue,
  type IntegrationSnapshotGeneration,
  type IntegrationTopologySnapshot,
  type TenantId,
} from "@aether-cloud/domain";

import type {
  PostgresIntegrationProjectionClient,
  PostgresIntegrationProjectionFaultInjector,
  PostgresIntegrationProjectionPersistenceStep,
  PostgresIntegrationProjectionPool,
} from "./postgres-integration-projection-contracts.js";

const maximumSafeRevision = Number.MAX_SAFE_INTEGER;
const digestPattern = /^[0-9a-f]{64}$/;

const selectCurrentSql = `
/* integration-projection:select-current */
SELECT
  tenant_id::text AS tenant_id,
  project_id::text AS project_id,
  gateway_id::text AS gateway_id,
  integration_id,
  integration_kind,
  snapshot_generation::text AS snapshot_generation,
  topology_digest,
  topology_payload,
  latest_observations,
  to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at,
  revision::text AS revision
FROM aethercloud.integration_projections
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND integration_id = $4
`;

const selectCurrentForUpdateSql = `
/* integration-projection:select-current-for-update */
SELECT
  tenant_id::text AS tenant_id,
  project_id::text AS project_id,
  gateway_id::text AS gateway_id,
  integration_id,
  integration_kind,
  snapshot_generation::text AS snapshot_generation,
  topology_digest,
  topology_payload,
  latest_observations,
  to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at,
  revision::text AS revision
FROM aethercloud.integration_projections
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND integration_id = $4
FOR UPDATE
`;

const lockCurrentCloudLinkSessionFenceSql = `
/* integration-projection:lock-current-cloudlink-session-fence */
SELECT
  session.session_id::text AS session_id,
  session.epoch::text AS session_epoch,
  session.revision::text AS session_revision,
  session.credential_generation::text AS credential_generation,
  session.gateway_key_id
FROM aethercloud.cloudlink_session_heads AS head
JOIN aethercloud.cloudlink_sessions AS session
  ON session.tenant_id = head.tenant_id
  AND session.project_id = head.project_id
  AND session.gateway_id = head.gateway_id
  AND session.session_id = head.current_session_id
WHERE head.tenant_id = $1::uuid
  AND head.project_id = $2::uuid
  AND head.gateway_id = $3::uuid
  AND session.session_id = $4::uuid
  AND session.epoch = $5::numeric
  AND session.revision = $6::bigint
  AND session.credential_generation = $7::numeric
  AND session.gateway_key_id = $8
  AND session.state = 'active'
FOR SHARE OF head, session
`;

const listCatalogSql = `
/* integration-projection:list-catalog */
SELECT
  tenant_id::text AS tenant_id,
  project_id::text AS project_id,
  gateway_id::text AS gateway_id,
  integration_id,
  integration_kind,
  snapshot_generation::text AS snapshot_generation,
  jsonb_array_length(topology_payload -> 'entities')::text AS entity_count,
  jsonb_array_length(latest_observations)::text AS latest_observation_count,
  to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at,
  revision::text AS revision
FROM aethercloud.integration_projections
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND ($3::uuid IS NULL OR gateway_id = $3::uuid)
  AND (
    $4::uuid IS NULL
    OR gateway_id > $4::uuid
    OR (
      gateway_id = $4::uuid
      AND (integration_id COLLATE "C") > ($5::text COLLATE "C")
    )
  )
ORDER BY gateway_id ASC, integration_id COLLATE "C" ASC
LIMIT $6
`;

const selectInboxSql = `
/* integration-projection:select-inbox */
SELECT
  operation,
  integration_id,
  snapshot_generation::text AS snapshot_generation,
  batch_id,
  payload_digest,
  credential_generation::text AS credential_generation,
  revision::text AS revision,
  audit_event_id,
  outbox_event_id,
  to_char(committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS committed_at
FROM aethercloud.integration_projection_ingress_requests
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND request_id = $4
`;

const selectBatchIdentitySql = `
/* integration-projection:select-batch-identity */
SELECT payload_digest
FROM aethercloud.integration_projection_batches
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND integration_id = $4
  AND snapshot_generation = $5::numeric
  AND batch_id = $6
`;

const selectTopologyHistorySql = `
/* integration-projection:select-topology-history */
SELECT
  tenant_id::text AS tenant_id,
  project_id::text AS project_id,
  gateway_id::text AS gateway_id,
  integration_id,
  integration_kind,
  snapshot_generation::text AS snapshot_generation,
  payload_digest AS topology_digest,
  topology_payload,
  '[]'::jsonb AS latest_observations,
  to_char(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at,
  revision::text AS revision
FROM aethercloud.integration_projection_topologies
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND integration_id = $4
  AND snapshot_generation = $5::numeric
`;

const selectStreamBindingSql = `
/* integration-projection:select-stream-binding */
SELECT
  integration_id,
  message_kind,
  contiguous_position::text AS contiguous_position
FROM aethercloud.integration_projection_cloudlink_streams
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND stream_id = $4
  AND stream_epoch = $5::numeric
FOR UPDATE
`;

const selectDeliverySql = `
/* integration-projection:select-delivery */
SELECT
  integration_id,
  message_kind,
  stream_id,
  stream_epoch::text AS stream_epoch,
  position::text AS position,
  batch_id,
  business_digest,
  request_id,
  projection_audit_event_id,
  projection_outbox_event_id,
  to_char(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS accepted_at
FROM aethercloud.integration_projection_cloudlink_deliveries
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND stream_id = $4
  AND stream_epoch = $5::numeric
  AND position = $6::numeric
`;

const insertCurrentSql = `
/* integration-projection:insert-current */
INSERT INTO aethercloud.integration_projections (
  tenant_id,
  project_id,
  gateway_id,
  integration_id,
  integration_kind,
  snapshot_generation,
  topology_digest,
  topology_payload,
  latest_observations,
  received_at,
  revision
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5,
  $6::numeric,
  $7,
  $8::jsonb,
  $9::jsonb,
  $10::timestamptz,
  $11::bigint
)
`;

const updateTopologyCurrentSql = `
/* integration-projection:update-current */
UPDATE aethercloud.integration_projections
SET
  snapshot_generation = $5::numeric,
  topology_digest = $6,
  topology_payload = $7::jsonb,
  latest_observations = '[]'::jsonb,
  received_at = $8::timestamptz,
  revision = $9::bigint,
  updated_at = clock_timestamp()
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND integration_id = $4
  AND integration_kind = $10
  AND revision = $11::bigint
`;

const updateObservationCurrentSql = `
/* integration-projection:update-current */
UPDATE aethercloud.integration_projections
SET
  latest_observations = $5::jsonb,
  received_at = $6::timestamptz,
  revision = $7::bigint,
  updated_at = clock_timestamp()
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND integration_id = $4
  AND snapshot_generation = $8::numeric
  AND revision = $9::bigint
`;

const insertTopologyIdentitySql = `
/* integration-projection:insert-topology-identity */
INSERT INTO aethercloud.integration_projection_topologies (
  tenant_id,
  project_id,
  gateway_id,
  integration_id,
  integration_kind,
  snapshot_generation,
  payload_digest,
  topology_payload,
  revision,
  accepted_at
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5,
  $6::numeric,
  $7,
  $8::jsonb,
  $9::bigint,
  $10::timestamptz
)
`;

const insertBatchIdentitySql = `
/* integration-projection:insert-batch-identity */
INSERT INTO aethercloud.integration_projection_batches (
  tenant_id,
  project_id,
  gateway_id,
  integration_id,
  snapshot_generation,
  batch_id,
  payload_digest,
  accepted_at
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5::numeric,
  $6,
  $7,
  $8::timestamptz
)
`;

const insertInboxSql = `
/* integration-projection:insert-inbox */
INSERT INTO aethercloud.integration_projection_ingress_requests (
  tenant_id,
  project_id,
  gateway_id,
  request_id,
  operation,
  integration_id,
  snapshot_generation,
  batch_id,
  payload_digest,
  credential_generation,
  revision,
  audit_event_id,
  outbox_event_id,
  committed_at
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5,
  $6,
  $7::numeric,
  $8,
  $9,
  $10::numeric,
  $11::bigint,
  $12,
  $13,
  $14::timestamptz
)
`;

const insertStreamBindingSql = `
/* integration-projection:insert-stream-binding */
INSERT INTO aethercloud.integration_projection_cloudlink_streams (
  tenant_id,
  project_id,
  gateway_id,
  stream_id,
  stream_epoch,
  message_kind,
  integration_id,
  bound_at
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5::numeric,
  $6,
  $7,
  $8::timestamptz
)
`;

const insertDeliverySql = `
/* integration-projection:insert-delivery */
INSERT INTO aethercloud.integration_projection_cloudlink_deliveries (
  tenant_id,
  project_id,
  gateway_id,
  stream_id,
  stream_epoch,
  position,
  integration_id,
  message_kind,
  batch_id,
  business_digest,
  request_id,
  projection_audit_event_id,
  projection_outbox_event_id,
  accepted_at
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5::numeric,
  $6::numeric,
  $7,
  $8,
  $9,
  $10,
  $11,
  $12,
  $13,
  $14::timestamptz
)
`;

const upsertDeliveryAttemptSql = `
/* integration-projection:upsert-delivery-attempt */
INSERT INTO aethercloud.integration_projection_cloudlink_delivery_attempts (
  tenant_id,
  project_id,
  gateway_id,
  stream_id,
  stream_epoch,
  position,
  session_id,
  session_epoch,
  credential_generation,
  received_at
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5::numeric,
  $6::numeric,
  $7::uuid,
  $8::numeric,
  $9::numeric,
  $10::timestamptz
)
ON CONFLICT (
  tenant_id,
  project_id,
  gateway_id,
  stream_id,
  stream_epoch,
  position,
  session_id,
  session_epoch,
  credential_generation
) DO UPDATE
SET received_at = GREATEST(
  aethercloud.integration_projection_cloudlink_delivery_attempts.received_at,
  EXCLUDED.received_at
)
RETURNING position::text AS position
`;

const updateStreamCursorSql = `
/* integration-projection:update-stream-cursor */
UPDATE aethercloud.integration_projection_cloudlink_streams
SET
  contiguous_position = $6::numeric,
  updated_at = clock_timestamp()
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND stream_id = $4
  AND stream_epoch = $5::numeric
  AND contiguous_position IS NOT DISTINCT FROM $7::numeric
RETURNING contiguous_position::text AS contiguous_position
`;

const upsertDurableAckSql = `
/* integration-projection:upsert-durable-ack */
INSERT INTO aethercloud.integration_projection_cloudlink_ack_outbox (
  outbox_event_id,
  tenant_id,
  project_id,
  gateway_id,
  integration_id,
  message_kind,
  session_id,
  session_epoch,
  credential_generation,
  stream_id,
  stream_epoch,
  acknowledged_position,
  batch_id,
  business_digest,
  receipt_id,
  acknowledged_at,
  available_at
) VALUES (
  $1,
  $2::uuid,
  $3::uuid,
  $4::uuid,
  $5,
  $6,
  $7::uuid,
  $8::numeric,
  $9::numeric,
  $10,
  $11::numeric,
  $12::numeric,
  $13,
  $14,
  $15,
  $16::timestamptz,
  $16::timestamptz
)
ON CONFLICT (tenant_id, project_id, outbox_event_id) DO UPDATE
SET outbox_event_id = EXCLUDED.outbox_event_id
WHERE
  aethercloud.integration_projection_cloudlink_ack_outbox.gateway_id = EXCLUDED.gateway_id
  AND aethercloud.integration_projection_cloudlink_ack_outbox.integration_id = EXCLUDED.integration_id
  AND aethercloud.integration_projection_cloudlink_ack_outbox.message_kind = EXCLUDED.message_kind
  AND aethercloud.integration_projection_cloudlink_ack_outbox.session_id = EXCLUDED.session_id
  AND aethercloud.integration_projection_cloudlink_ack_outbox.session_epoch = EXCLUDED.session_epoch
  AND aethercloud.integration_projection_cloudlink_ack_outbox.credential_generation = EXCLUDED.credential_generation
  AND aethercloud.integration_projection_cloudlink_ack_outbox.stream_id = EXCLUDED.stream_id
  AND aethercloud.integration_projection_cloudlink_ack_outbox.stream_epoch = EXCLUDED.stream_epoch
  AND aethercloud.integration_projection_cloudlink_ack_outbox.acknowledged_position = EXCLUDED.acknowledged_position
  AND aethercloud.integration_projection_cloudlink_ack_outbox.batch_id = EXCLUDED.batch_id
  AND aethercloud.integration_projection_cloudlink_ack_outbox.business_digest = EXCLUDED.business_digest
  AND aethercloud.integration_projection_cloudlink_ack_outbox.receipt_id = EXCLUDED.receipt_id
RETURNING
  outbox_event_id,
  tenant_id::text AS tenant_id,
  project_id::text AS project_id,
  gateway_id::text AS gateway_id,
  integration_id,
  message_kind,
  session_id::text AS session_id,
  session_epoch::text AS session_epoch,
  credential_generation::text AS credential_generation,
  stream_id,
  stream_epoch::text AS stream_epoch,
  acknowledged_position::text AS acknowledged_position,
  batch_id,
  business_digest,
  receipt_id,
  to_char(acknowledged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS acknowledged_at
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
  $1,
  $2::uuid,
  $3::uuid,
  $4::timestamptz,
  'gateway',
  $5,
  $6,
  'integration-projection',
  $7,
  'succeeded',
  'low',
  'not-required',
  $8,
  $9
)
`;

const insertOutboxSql = `
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
  $1,
  $2::uuid,
  $3::uuid,
  $4::timestamptz,
  $5,
  'integration-projection',
  $6,
  $7::jsonb
)
`;

type Row = Record<string, unknown>;
type Receipt =
  | IntegrationObservationPersistenceReceipt
  | IntegrationTopologyPersistenceReceipt;
type StepNotifier = (
  step: PostgresIntegrationProjectionPersistenceStep,
) => Promise<void>;

interface CloudLinkBusinessDelivery {
  readonly sentAtMs?: string;
  readonly expiresAtMs?: string | null;
  readonly batchId: string;
  readonly digest: string;
  readonly messageKind: IntegrationCloudLinkMessageKind;
  readonly position: IntegrationCloudLinkDelivery["position"];
  readonly streamEpoch: IntegrationCloudLinkDelivery["streamEpoch"];
  readonly streamId: IntegrationCloudLinkDelivery["streamId"];
}

interface StoredCloudLinkDelivery extends CloudLinkBusinessDelivery {
  readonly streamId: IntegrationCloudLinkDelivery["streamId"];
  readonly streamEpoch: IntegrationCloudLinkDelivery["streamEpoch"];
  readonly position: IntegrationCloudLinkDelivery["position"];
  readonly batchId: string;
  readonly digest: string;
  readonly messageKind: IntegrationCloudLinkMessageKind;
  readonly integrationId: IntegrationProjectionScope["integrationId"];
  readonly requestId: string;
  readonly projectionAuditEventId: string;
  readonly projectionOutboxEventId: string;
}

function requireObject(input: unknown, field: string): Row {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`PostgreSQL integration projection has invalid ${field}`);
  }
  return input as Row;
}

function requireArray(input: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(input)) {
    throw new Error(`PostgreSQL integration projection has invalid ${field}`);
  }
  return input;
}

function requireString(input: unknown, field: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error(`PostgreSQL integration projection has invalid ${field}`);
  }
  return input;
}

function requireText(input: unknown, field: string): string {
  if (typeof input !== "string") {
    throw new Error(`PostgreSQL integration projection has invalid ${field}`);
  }
  return input;
}

function optionalString(input: unknown, field: string): string | undefined {
  return input === undefined ? undefined : requireString(input, field);
}

function nullableString(input: unknown, field: string): string | undefined {
  return input === null || input === undefined
    ? undefined
    : requireString(input, field);
}

function requireOneOf<Value extends string>(
  input: unknown,
  values: readonly Value[],
  field: string,
): Value {
  if (typeof input !== "string" || !values.includes(input as Value)) {
    throw new Error(`PostgreSQL integration projection has invalid ${field}`);
  }
  return input as Value;
}

function requireDigest(input: unknown, field: string): string {
  const digest = requireString(input, field);
  if (!digestPattern.test(digest)) {
    throw new Error(`PostgreSQL integration projection has invalid ${field}`);
  }
  return digest;
}

function requireBoundedIdentifier(
  input: unknown,
  field: string,
  minimum = 8,
): string {
  const value = requireString(input, field);
  let containsControlCharacter = false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x20 || codeUnit === 0x7f) {
      containsControlCharacter = true;
      break;
    }
  }
  if (
    value.length < minimum ||
    value.length > 128 ||
    containsControlCharacter
  ) {
    throw new Error(`PostgreSQL integration projection has invalid ${field}`);
  }
  return value;
}

function parseRevision(input: unknown): number {
  if (typeof input !== "string" || !/^[1-9][0-9]*$/.test(input)) {
    throw new Error("PostgreSQL integration projection has invalid revision");
  }
  const revision = Number(input);
  if (!Number.isSafeInteger(revision)) {
    throw new Error(
      "PostgreSQL integration projection revision exceeds JavaScript safe range",
    );
  }
  return revision;
}

const catalogRowKeys = Object.freeze([
  "entity_count",
  "gateway_id",
  "integration_id",
  "integration_kind",
  "latest_observation_count",
  "project_id",
  "received_at",
  "revision",
  "snapshot_generation",
  "tenant_id",
]);

function requireExactCatalogRow(row: Row): void {
  const keys = Object.keys(row).sort();
  if (
    keys.length !== catalogRowKeys.length ||
    keys.some((key, index) => key !== catalogRowKeys[index])
  ) {
    throw new Error(
      "PostgreSQL integration projection catalog returned unexpected columns",
    );
  }
}

function parseCatalogCount(input: unknown, field: string): number {
  if (typeof input !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(input)) {
    throw new Error(
      `PostgreSQL integration projection catalog has invalid ${field}`,
    );
  }
  const count = Number(input);
  if (!Number.isSafeInteger(count) || count > 65_536) {
    throw new Error(
      `PostgreSQL integration projection catalog has invalid ${field}`,
    );
  }
  return count;
}

function catalogRecordIdentity(
  record: Readonly<{ gatewayId: string; integrationId: string }>,
): string {
  return `${record.gatewayId}\u0000${record.integrationId}`;
}

function decodeCatalogRow(row: Row): IntegrationProjectionCatalogRecord {
  requireExactCatalogRow(row);
  return Object.freeze({
    tenantId: parseTenantId(row.tenant_id),
    projectId: parseProjectId(row.project_id),
    gatewayId: parseGatewayId(row.gateway_id),
    integrationId: parseIntegrationId(row.integration_id),
    integrationKind: parseIntegrationKind(row.integration_kind),
    snapshotGeneration: parseIntegrationSnapshotGeneration(
      row.snapshot_generation,
    ),
    entityCount: parseCatalogCount(row.entity_count, "entity_count"),
    latestObservationCount: parseCatalogCount(
      row.latest_observation_count,
      "latest_observation_count",
    ),
    receivedAt: parseUtcInstant(row.received_at),
    revision: parseRevision(row.revision),
  });
}

function decodeArea(input: unknown): IntegrationAreaInput {
  const area = requireObject(input, "topology.area");
  return {
    areaId: requireString(area.areaId, "topology.area.areaId"),
    name: requireString(area.name, "topology.area.name"),
  };
}

function decodeDevice(input: unknown): IntegrationDeviceInput {
  const device = requireObject(input, "topology.device");
  const areaId = optionalString(device.areaId, "topology.device.areaId");
  const manufacturer = optionalString(
    device.manufacturer,
    "topology.device.manufacturer",
  );
  const model = optionalString(device.model, "topology.device.model");
  const softwareVersion = optionalString(
    device.softwareVersion,
    "topology.device.softwareVersion",
  );
  const hardwareVersion = optionalString(
    device.hardwareVersion,
    "topology.device.hardwareVersion",
  );
  return {
    deviceId: requireString(device.deviceId, "topology.device.deviceId"),
    name: requireString(device.name, "topology.device.name"),
    ...(areaId === undefined ? {} : { areaId }),
    ...(manufacturer === undefined ? {} : { manufacturer }),
    ...(model === undefined ? {} : { model }),
    ...(softwareVersion === undefined ? {} : { softwareVersion }),
    ...(hardwareVersion === undefined ? {} : { hardwareVersion }),
  };
}

function decodePoint(input: unknown): IntegrationEntityPointDescriptorInput {
  const point = requireObject(input, "topology.point");
  const unit = optionalString(point.unit, "topology.point.unit");
  return {
    pointKey: requireString(point.pointKey, "topology.point.pointKey"),
    title: requireString(point.title, "topology.point.title"),
    kind: requireOneOf(
      point.kind,
      ["event", "status", "telemetry"] as const,
      "topology.point.kind",
    ),
    valueType: requireOneOf(
      point.valueType,
      [
        "boolean",
        "bytes",
        "decimal",
        "float64",
        "int64",
        "string",
        "uint64",
      ] as const,
      "topology.point.valueType",
    ),
    ...(unit === undefined ? {} : { unit }),
  };
}

function decodeEntity(input: unknown): IntegrationEntityInput {
  const entity = requireObject(input, "topology.entity");
  const deviceId = optionalString(entity.deviceId, "topology.entity.deviceId");
  const areaId = optionalString(entity.areaId, "topology.entity.areaId");
  return {
    entityId: requireString(entity.entityId, "topology.entity.entityId"),
    sourceAddress: requireString(
      entity.sourceAddress,
      "topology.entity.sourceAddress",
    ),
    name: requireString(entity.name, "topology.entity.name"),
    entityKind: requireString(entity.entityKind, "topology.entity.entityKind"),
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(areaId === undefined ? {} : { areaId }),
    points: requireArray(entity.points, "topology.entity.points").map(
      decodePoint,
    ),
  };
}

function decodeTopology(input: unknown): IntegrationTopologySnapshot {
  const topology = requireObject(input, "topology_payload");
  return defineIntegrationTopologySnapshot({
    schema: requireString(topology.schema, "topology.schema"),
    integrationId: requireString(
      topology.integrationId,
      "topology.integrationId",
    ),
    integrationKind: requireString(
      topology.integrationKind,
      "topology.integrationKind",
    ),
    snapshotGeneration: requireString(
      topology.snapshotGeneration,
      "topology.snapshotGeneration",
    ),
    observedAtMs: requireString(topology.observedAtMs, "topology.observedAtMs"),
    areas: requireArray(topology.areas, "topology.areas").map(decodeArea),
    devices: requireArray(topology.devices, "topology.devices").map(
      decodeDevice,
    ),
    entities: requireArray(topology.entities, "topology.entities").map(
      decodeEntity,
    ),
  });
}

function decodeObservedValue(input: unknown): IntegrationObservedValue {
  const value = requireObject(input, "observation.value");
  const type = requireString(value.type, "observation.value.type");
  switch (type) {
    case "boolean":
      if (typeof value.value !== "boolean") {
        throw new Error(
          "PostgreSQL integration projection has invalid boolean value",
        );
      }
      return { type, value: value.value };
    case "bytes":
      return {
        type,
        encoding: requireOneOf(
          value.encoding,
          ["base64url"] as const,
          "observation.value.encoding",
        ),
        value: requireText(value.value, "observation.value.value"),
      };
    case "decimal":
    case "int64":
    case "uint64":
      return {
        type,
        value: requireString(value.value, "observation.value.value"),
      };
    case "string":
      return {
        type,
        value: requireText(value.value, "observation.value.value"),
      };
    case "float64":
      if (typeof value.value !== "number") {
        throw new Error(
          "PostgreSQL integration projection has invalid float64 value",
        );
      }
      return { type, value: value.value };
    default:
      throw new Error(
        "PostgreSQL integration projection has invalid observation value type",
      );
  }
}

function decodeObservation(input: unknown): IntegrationObservationInput {
  const observation = requireObject(input, "latest_observation");
  const value =
    observation.value === undefined
      ? undefined
      : decodeObservedValue(observation.value);
  const diagnostic = optionalString(
    observation.diagnostic,
    "observation.diagnostic",
  );
  return {
    entityId: requireString(observation.entityId, "observation.entityId"),
    pointKey: requireString(observation.pointKey, "observation.pointKey"),
    observedAtMs: requireString(
      observation.observedAtMs,
      "observation.observedAtMs",
    ),
    quality: requireOneOf(
      observation.quality,
      ["bad", "good", "uncertain", "unavailable"] as const,
      "observation.quality",
    ),
    ...(value === undefined ? {} : { value }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function observationIdentity(observation: IntegrationObservation): string {
  return `${observation.entityId}\u0000${observation.pointKey}`;
}

function decodeLatestObservations(
  input: unknown,
  topology: IntegrationTopologySnapshot,
): readonly IntegrationObservation[] {
  const raw = requireArray(input, "latest_observations");
  if (raw.length === 0) return Object.freeze([]);
  const observations = defineIntegrationObservationBatch(
    {
      schema: "aether.integration.observation-batch.v1alpha1",
      integrationId: topology.integrationId,
      snapshotGeneration: topology.snapshotGeneration,
      batchId: "storage-rehydration",
      observedAtMs: topology.observedAtMs,
      observations: raw.map(decodeObservation),
    },
    topology,
  ).observations;
  const identities = observations.map(observationIdentity);
  if (new Set(identities).size !== identities.length) {
    throw new Error(
      "PostgreSQL integration projection contains duplicate latest observations",
    );
  }
  return observations;
}

function decodeProjectionRow(row: Row): IntegrationProjectionRecord {
  const topology = decodeTopology(row.topology_payload);
  const tenantId = parseTenantId(row.tenant_id);
  const projectId = parseProjectId(row.project_id);
  const gatewayId = parseGatewayId(row.gateway_id);
  const integrationId = parseIntegrationId(row.integration_id);
  const integrationKind = requireString(
    row.integration_kind,
    "integration_kind",
  );
  const generation = parseIntegrationSnapshotGeneration(
    row.snapshot_generation,
  );
  if (
    integrationId !== topology.integrationId ||
    integrationKind !== topology.integrationKind ||
    generation !== topology.snapshotGeneration
  ) {
    throw new Error(
      "PostgreSQL integration projection row contradicts topology payload",
    );
  }
  return Object.freeze({
    tenantId,
    projectId,
    gatewayId,
    integrationId,
    topology,
    topologyDigest: requireDigest(row.topology_digest, "topology_digest"),
    latestObservations: decodeLatestObservations(
      row.latest_observations,
      topology,
    ),
    receivedAt: parseUtcInstant(row.received_at),
    revision: parseRevision(row.revision),
  });
}

function scopeValues(scope: IntegrationProjectionScope): readonly unknown[] {
  return [
    scope.tenantId,
    scope.projectId,
    scope.gatewayId,
    scope.integrationId,
  ];
}

function topologyScope(
  input: IntegrationTopologyPersistenceInput,
): IntegrationProjectionScope {
  return {
    tenantId: input.binding.tenantId,
    projectId: input.binding.projectId,
    gatewayId: input.binding.gatewayId,
    integrationId: input.topology.integrationId,
  };
}

function observationScope(
  input: IntegrationObservationPersistenceInput,
): IntegrationProjectionScope {
  return {
    tenantId: input.binding.tenantId,
    projectId: input.binding.projectId,
    gatewayId: input.binding.gatewayId,
    integrationId: input.batch.integrationId,
  };
}

function stableId(prefix: string, fields: readonly string[]): string {
  const digest = createHash("sha256")
    .update(fields.join("\u0000"), "utf8")
    .digest("hex");
  return `${prefix}:${digest}`;
}

function requireBusinessDigest(input: unknown): string {
  const digest = requireString(input, "business_digest");
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(
      "PostgreSQL integration projection has invalid business_digest",
    );
  }
  return digest;
}

function requireMessageKind(input: unknown): IntegrationCloudLinkMessageKind {
  return requireOneOf(
    input,
    ["integration-observation-batch", "integration-topology-snapshot"] as const,
    "message_kind",
  );
}

function validateDelivery(
  delivery: IntegrationCloudLinkDelivery,
  input:
    | IntegrationObservationPersistenceInput
    | IntegrationTopologyPersistenceInput,
  expectedKind: IntegrationCloudLinkMessageKind,
): boolean {
  parseCloudLinkSessionId(delivery.sessionId);
  parseCloudLinkSessionEpoch(delivery.sessionEpoch);
  parseGatewayCredentialGeneration(delivery.credentialGeneration);
  parseStreamId(delivery.streamId);
  parseStreamEpoch(delivery.streamEpoch);
  parseStreamPosition(delivery.position);
  requireBoundedIdentifier(delivery.batchId, "delivery.batchId", 1);
  requireBusinessDigest(delivery.digest);
  const expectedBatchId =
    expectedKind === "integration-topology-snapshot" && "topology" in input
      ? `topology-${input.topology.snapshotGeneration}`
      : "batch" in input
        ? input.batch.batchId
        : undefined;
  return (
    delivery.messageKind === expectedKind &&
    delivery.credentialGeneration === input.binding.generation &&
    delivery.position !== "0" &&
    delivery.sessionEpoch !== "0" &&
    delivery.credentialGeneration !== "0" &&
    delivery.batchId === expectedBatchId
  );
}

function scopeIdentity(scope: IntegrationProjectionScope): readonly string[] {
  return [
    scope.tenantId,
    scope.projectId,
    scope.gatewayId,
    scope.integrationId,
  ];
}

function aggregateId(scope: IntegrationProjectionScope): string {
  return stableId("integration", scopeIdentity(scope));
}

function businessDeliveryIdentity(
  scope: IntegrationProjectionScope,
  delivery: IntegrationCloudLinkDelivery,
): readonly string[] {
  return [
    ...scopeIdentity(scope),
    delivery.streamId,
    delivery.streamEpoch,
    delivery.position,
    delivery.batchId,
    delivery.digest,
    delivery.messageKind,
  ];
}

function durableAcknowledgement(
  scope: IntegrationProjectionScope,
  delivery: IntegrationCloudLinkDelivery,
  acknowledgedAt: IntegrationProjectionRecord["receivedAt"],
): IntegrationCloudLinkDurableAcknowledgement {
  const businessIdentity = businessDeliveryIdentity(scope, delivery);
  const acknowledgementIdentity = [
    ...businessIdentity,
    delivery.sessionId,
    delivery.sessionEpoch,
    delivery.credentialGeneration,
  ];
  return Object.freeze({
    outboxEventId: stableId(
      "outbox:cloudlink-integration-ack",
      acknowledgementIdentity,
    ),
    receiptId: stableId("receipt:cloudlink-integration", businessIdentity),
    ...scope,
    sessionId: delivery.sessionId,
    sessionEpoch: delivery.sessionEpoch,
    credentialGeneration: delivery.credentialGeneration,
    streamId: delivery.streamId,
    streamEpoch: delivery.streamEpoch,
    acknowledgedPosition: delivery.position,
    batchId: delivery.batchId,
    digest: delivery.digest,
    messageKind: delivery.messageKind,
    acknowledgedAt,
  });
}

function decodeStoredDelivery(
  row: Row,
  scope: IntegrationProjectionScope,
): StoredCloudLinkDelivery {
  const integrationId = parseIntegrationId(row.integration_id);
  if (integrationId !== scope.integrationId) {
    throw new Error(
      "PostgreSQL CloudLink delivery contradicts its integration scope",
    );
  }
  const digest = requireBusinessDigest(row.business_digest);
  parseUtcInstant(row.accepted_at);
  return Object.freeze({
    integrationId,
    streamId: parseStreamId(row.stream_id),
    streamEpoch: parseStreamEpoch(row.stream_epoch),
    position: parseStreamPosition(row.position),
    batchId: requireBoundedIdentifier(row.batch_id, "delivery.batch_id", 1),
    digest,
    messageKind: requireMessageKind(row.message_kind),
    requestId: requireBoundedIdentifier(row.request_id, "delivery.request_id"),
    projectionAuditEventId: requireBoundedIdentifier(
      row.projection_audit_event_id,
      "delivery.projection_audit_event_id",
    ),
    projectionOutboxEventId: requireBoundedIdentifier(
      row.projection_outbox_event_id,
      "delivery.projection_outbox_event_id",
    ),
  });
}

function sameDelivery(
  left: CloudLinkBusinessDelivery,
  right: IntegrationCloudLinkDelivery,
): boolean {
  return (
    left.sentAtMs === right.sentAtMs &&
    left.expiresAtMs === right.expiresAtMs &&
    left.streamId === right.streamId &&
    left.streamEpoch === right.streamEpoch &&
    left.position === right.position &&
    left.batchId === right.batchId &&
    left.digest === right.digest &&
    left.messageKind === right.messageKind
  );
}

function decodeAcknowledgementRow(
  row: Row,
  scope: IntegrationProjectionScope,
  expectedDelivery: IntegrationCloudLinkDelivery,
): IntegrationCloudLinkDurableAcknowledgement {
  const integrationId = parseIntegrationId(row.integration_id);
  const delivery: IntegrationCloudLinkDelivery = Object.freeze({
    sessionId: parseCloudLinkSessionId(row.session_id),
    sessionEpoch: parseCloudLinkSessionEpoch(row.session_epoch),
    credentialGeneration: parseGatewayCredentialGeneration(
      row.credential_generation,
    ),
    streamId: parseStreamId(row.stream_id),
    streamEpoch: parseStreamEpoch(row.stream_epoch),
    position: parseStreamPosition(row.acknowledged_position),
    batchId: requireBoundedIdentifier(row.batch_id, "ack.batch_id", 1),
    digest: requireBusinessDigest(row.business_digest),
    messageKind: requireMessageKind(row.message_kind),
  });
  if (
    parseTenantId(row.tenant_id) !== scope.tenantId ||
    parseProjectId(row.project_id) !== scope.projectId ||
    parseGatewayId(row.gateway_id) !== scope.gatewayId ||
    integrationId !== scope.integrationId ||
    !sameDelivery(delivery, expectedDelivery) ||
    delivery.sessionId !== expectedDelivery.sessionId ||
    delivery.sessionEpoch !== expectedDelivery.sessionEpoch ||
    delivery.credentialGeneration !== expectedDelivery.credentialGeneration
  ) {
    throw new Error(
      "PostgreSQL CloudLink durable ACK contradicts its delivery",
    );
  }
  return Object.freeze({
    outboxEventId: requireBoundedIdentifier(
      row.outbox_event_id,
      "ack.outbox_event_id",
    ),
    receiptId: requireBoundedIdentifier(row.receipt_id, "ack.receipt_id"),
    ...scope,
    sessionId: delivery.sessionId,
    sessionEpoch: delivery.sessionEpoch,
    credentialGeneration: delivery.credentialGeneration,
    streamId: delivery.streamId,
    streamEpoch: delivery.streamEpoch,
    acknowledgedPosition: delivery.position,
    batchId: delivery.batchId,
    digest: delivery.digest,
    messageKind: delivery.messageKind,
    acknowledgedAt: parseUtcInstant(row.acknowledged_at),
  });
}

function topologyReceipt(
  input: IntegrationTopologyPersistenceInput,
  revision: number,
): IntegrationTopologyPersistenceReceipt {
  const scope = topologyScope(input);
  const identity = [
    ...scopeIdentity(scope),
    input.topology.snapshotGeneration,
    input.payloadDigest,
  ];
  return Object.freeze({
    kind: "topology",
    ...scope,
    credentialGeneration: input.binding.generation,
    requestId: input.requestId,
    payloadDigest: input.payloadDigest,
    snapshotGeneration: input.topology.snapshotGeneration,
    revision,
    auditEventId: stableId("audit:integration-topology", identity),
    outboxEventId: stableId("outbox:integration-topology", identity),
    committedAt: input.receivedAt,
  });
}

function observationReceipt(
  input: IntegrationObservationPersistenceInput,
  revision: number,
): IntegrationObservationPersistenceReceipt {
  const scope = observationScope(input);
  const identity = [
    ...scopeIdentity(scope),
    input.batch.snapshotGeneration,
    input.batch.batchId,
    input.payloadDigest,
  ];
  return Object.freeze({
    kind: "observations",
    ...scope,
    credentialGeneration: input.binding.generation,
    requestId: input.requestId,
    payloadDigest: input.payloadDigest,
    snapshotGeneration: input.batch.snapshotGeneration,
    batchId: input.batch.batchId,
    revision,
    auditEventId: stableId("audit:integration-observations", identity),
    outboxEventId: stableId("outbox:integration-observations", identity),
    committedAt: input.receivedAt,
  });
}

function decodeInboxReceipt(
  row: Row,
  scope: IntegrationProjectionScope,
  requestId: string,
): Receipt {
  const operation = requireOneOf(
    row.operation,
    ["observations", "topology"] as const,
    "inbox.operation",
  );
  const integrationId = parseIntegrationId(row.integration_id);
  if (integrationId !== scope.integrationId) {
    throw new Error(
      "PostgreSQL integration projection inbox has contradictory integration",
    );
  }
  const common = {
    ...scope,
    credentialGeneration: parseGatewayCredentialGeneration(
      row.credential_generation,
    ),
    requestId,
    payloadDigest: requireDigest(row.payload_digest, "inbox.payload_digest"),
    snapshotGeneration: parseIntegrationSnapshotGeneration(
      row.snapshot_generation,
    ),
    revision: parseRevision(row.revision),
    auditEventId: requireBoundedIdentifier(
      row.audit_event_id,
      "inbox.audit_event_id",
    ),
    outboxEventId: requireBoundedIdentifier(
      row.outbox_event_id,
      "inbox.outbox_event_id",
    ),
    committedAt: parseUtcInstant(row.committed_at),
  };
  if (operation === "topology") {
    if (row.batch_id !== null && row.batch_id !== undefined) {
      throw new Error(
        "PostgreSQL integration projection topology receipt has batch identity",
      );
    }
    return Object.freeze({ kind: operation, ...common });
  }
  return Object.freeze({
    kind: operation,
    ...common,
    batchId: parseIntegrationBatchId(row.batch_id),
  });
}

function inboxMatchesTopology(
  receipt: Receipt,
  input: IntegrationTopologyPersistenceInput,
  current: IntegrationProjectionRecord,
): receipt is IntegrationTopologyPersistenceReceipt {
  return (
    receipt.kind === "topology" &&
    receipt.requestId === input.requestId &&
    receipt.integrationId === input.topology.integrationId &&
    receipt.snapshotGeneration === input.topology.snapshotGeneration &&
    receipt.payloadDigest === input.payloadDigest &&
    receipt.credentialGeneration === input.binding.generation &&
    current.topology.snapshotGeneration === input.topology.snapshotGeneration &&
    current.topologyDigest === input.payloadDigest
  );
}

function inboxMatchesObservations(
  receipt: Receipt,
  input: IntegrationObservationPersistenceInput,
): receipt is IntegrationObservationPersistenceReceipt {
  return (
    receipt.kind === "observations" &&
    receipt.requestId === input.requestId &&
    receipt.integrationId === input.batch.integrationId &&
    receipt.snapshotGeneration === input.batch.snapshotGeneration &&
    receipt.batchId === input.batch.batchId &&
    receipt.payloadDigest === input.payloadDigest &&
    receipt.credentialGeneration === input.binding.generation
  );
}

function freezeRecord(
  record: IntegrationProjectionRecord,
): IntegrationProjectionRecord {
  return Object.freeze({
    ...record,
    latestObservations: Object.freeze([...record.latestObservations]),
  });
}

function mergeLatestObservations(
  current: readonly IntegrationObservation[],
  incoming: readonly IntegrationObservation[],
): readonly IntegrationObservation[] {
  const latest = new Map(
    current.map((observation) => [
      observationIdentity(observation),
      observation,
    ]),
  );
  for (const observation of incoming) {
    const identity = observationIdentity(observation);
    const prior = latest.get(identity);
    if (
      prior === undefined ||
      BigInt(observation.observedAtMs) >= BigInt(prior.observedAtMs)
    ) {
      latest.set(identity, observation);
    }
  }
  return Object.freeze(
    [...latest.values()].sort((left, right) =>
      observationIdentity(left).localeCompare(observationIdentity(right)),
    ),
  );
}

function inboxValues(receipt: Receipt): readonly unknown[] {
  return [
    receipt.tenantId,
    receipt.projectId,
    receipt.gatewayId,
    receipt.requestId,
    receipt.kind,
    receipt.integrationId,
    receipt.snapshotGeneration,
    receipt.kind === "observations" ? receipt.batchId : null,
    receipt.payloadDigest,
    receipt.credentialGeneration,
    receipt.revision,
    receipt.auditEventId,
    receipt.outboxEventId,
    receipt.committedAt,
  ];
}

async function setTenantScope(
  client: PostgresIntegrationProjectionClient,
  tenantId: TenantId,
): Promise<void> {
  await client.query("SELECT set_config('aethercloud.tenant_id', $1, true)", [
    tenantId,
  ]);
}

async function lockScope(
  client: PostgresIntegrationProjectionClient,
  scope: IntegrationProjectionScope,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    JSON.stringify(scopeIdentity(scope)),
  ]);
}

async function lockCurrentCloudLinkSessionFence(
  client: PostgresIntegrationProjectionClient,
  input:
    | IntegrationObservationPersistenceInput
    | IntegrationTopologyPersistenceInput,
): Promise<boolean> {
  const fence = input.cloudLinkSessionFence;
  const delivery = input.cloudLinkDelivery;
  if (fence === undefined) return true;
  if (
    delivery === undefined ||
    fence.tenantId !== input.binding.tenantId ||
    fence.projectId !== input.binding.projectId ||
    fence.gatewayId !== input.binding.gatewayId ||
    fence.credentialGeneration !== input.binding.generation ||
    fence.sessionId !== delivery.sessionId ||
    fence.sessionEpoch !== delivery.sessionEpoch ||
    fence.credentialGeneration !== delivery.credentialGeneration
  ) {
    return false;
  }
  const selected = await client.query<Row>(
    lockCurrentCloudLinkSessionFenceSql,
    [
      fence.tenantId,
      fence.projectId,
      fence.gatewayId,
      fence.sessionId,
      fence.sessionEpoch,
      fence.sessionRevision,
      fence.credentialGeneration,
      fence.gatewayKeyId,
    ],
  );
  if (
    selected.rows.length > 1 ||
    (selected.rowCount !== null && selected.rowCount !== selected.rows.length)
  ) {
    throw new Error("PostgreSQL CloudLink session fence is contradictory");
  }
  const row = selected.rows[0];
  return (
    row !== undefined &&
    parseCloudLinkSessionId(row.session_id) === fence.sessionId &&
    parseCloudLinkSessionEpoch(row.session_epoch) === fence.sessionEpoch &&
    parseRevision(row.session_revision) === fence.sessionRevision &&
    parseGatewayCredentialGeneration(row.credential_generation) ===
      fence.credentialGeneration &&
    row.gateway_key_id === fence.gatewayKeyId
  );
}

async function lockDeliveryStream(
  client: PostgresIntegrationProjectionClient,
  scope: IntegrationProjectionScope,
  delivery: IntegrationCloudLinkDelivery,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    JSON.stringify([
      scope.tenantId,
      scope.projectId,
      scope.gatewayId,
      delivery.streamId,
      delivery.streamEpoch,
    ]),
  ]);
}

async function selectCurrent(
  client: PostgresIntegrationProjectionClient,
  scope: IntegrationProjectionScope,
  forUpdate: boolean,
): Promise<IntegrationProjectionRecord | undefined> {
  const query = await client.query<Row>(
    forUpdate ? selectCurrentForUpdateSql : selectCurrentSql,
    scopeValues(scope),
  );
  const row = query.rows[0];
  if (query.rows.length > 1) {
    throw new Error(
      "PostgreSQL integration projection returned duplicate current rows",
    );
  }
  return row === undefined ? undefined : decodeProjectionRow(row);
}

async function selectCatalog(
  client: PostgresIntegrationProjectionClient,
  query: IntegrationProjectionCatalogQuery,
): Promise<readonly IntegrationProjectionCatalogRecord[]> {
  const selected = await client.query<Row>(listCatalogSql, [
    query.tenantId,
    query.projectId,
    query.gatewayId ?? null,
    query.after?.gatewayId ?? null,
    query.after?.integrationId ?? null,
    query.limit,
  ]);
  if (
    selected.rows.length > query.limit ||
    (selected.rowCount !== null && selected.rowCount !== selected.rows.length)
  ) {
    throw new Error(
      "PostgreSQL integration projection catalog returned an invalid row count",
    );
  }
  const records = selected.rows.map(decodeCatalogRow);
  let prior =
    query.after === undefined ? undefined : catalogRecordIdentity(query.after);
  for (const record of records) {
    if (
      record.tenantId !== query.tenantId ||
      record.projectId !== query.projectId ||
      (query.gatewayId !== undefined && record.gatewayId !== query.gatewayId) ||
      (prior !== undefined && catalogRecordIdentity(record) <= prior)
    ) {
      throw new Error(
        "PostgreSQL integration projection catalog returned data outside its scope or order",
      );
    }
    prior = catalogRecordIdentity(record);
  }
  return Object.freeze(records);
}

async function selectInbox(
  client: PostgresIntegrationProjectionClient,
  scope: IntegrationProjectionScope,
  requestId: string,
): Promise<Receipt | undefined> {
  const query = await client.query<Row>(selectInboxSql, [
    scope.tenantId,
    scope.projectId,
    scope.gatewayId,
    requestId,
  ]);
  const row = query.rows[0];
  if (query.rows.length > 1) {
    throw new Error(
      "PostgreSQL integration projection returned duplicate inbox rows",
    );
  }
  return row === undefined
    ? undefined
    : decodeInboxReceipt(row, scope, requestId);
}

async function selectTopologyHistory(
  client: PostgresIntegrationProjectionClient,
  scope: IntegrationProjectionScope,
  snapshotGeneration: IntegrationTopologyPersistenceReceipt["snapshotGeneration"],
): Promise<IntegrationTopologyHistoryRecord | undefined> {
  const query = await client.query<Row>(selectTopologyHistorySql, [
    ...scopeValues(scope),
    snapshotGeneration,
  ]);
  if (query.rows.length > 1) {
    throw new Error(
      "PostgreSQL integration projection returned duplicate topology history",
    );
  }
  const row = query.rows[0];
  if (row === undefined) return undefined;
  const projection = decodeProjectionRow(row);
  return Object.freeze({
    tenantId: projection.tenantId,
    projectId: projection.projectId,
    gatewayId: projection.gatewayId,
    integrationId: projection.integrationId,
    topology: projection.topology,
    topologyDigest: projection.topologyDigest,
    receivedAt: projection.receivedAt,
    revision: projection.revision,
  });
}

async function selectStreamBinding(
  client: PostgresIntegrationProjectionClient,
  scope: IntegrationProjectionScope,
  delivery: IntegrationCloudLinkDelivery,
): Promise<
  | Readonly<{
      integrationId: IntegrationProjectionScope["integrationId"];
      messageKind: IntegrationCloudLinkMessageKind;
      contiguousPosition?: IntegrationCloudLinkDelivery["position"];
    }>
  | undefined
> {
  const query = await client.query<Row>(selectStreamBindingSql, [
    scope.tenantId,
    scope.projectId,
    scope.gatewayId,
    delivery.streamId,
    delivery.streamEpoch,
  ]);
  if (query.rows.length > 1) {
    throw new Error(
      "PostgreSQL integration projection returned duplicate stream bindings",
    );
  }
  const row = query.rows[0];
  if (row === undefined) return undefined;
  const contiguousPosition = nullableString(
    row.contiguous_position,
    "stream.contiguous_position",
  );
  return Object.freeze({
    integrationId: parseIntegrationId(row.integration_id),
    messageKind: requireMessageKind(row.message_kind),
    ...(contiguousPosition === undefined
      ? {}
      : {
          contiguousPosition: parseStreamPosition(contiguousPosition),
        }),
  });
}

async function selectStoredDelivery(
  client: PostgresIntegrationProjectionClient,
  scope: IntegrationProjectionScope,
  delivery: IntegrationCloudLinkDelivery,
): Promise<StoredCloudLinkDelivery | undefined> {
  const query = await client.query<Row>(selectDeliverySql, [
    scope.tenantId,
    scope.projectId,
    scope.gatewayId,
    delivery.streamId,
    delivery.streamEpoch,
    delivery.position,
  ]);
  if (query.rows.length > 1) {
    throw new Error(
      "PostgreSQL integration projection returned duplicate deliveries",
    );
  }
  const row = query.rows[0];
  return row === undefined ? undefined : decodeStoredDelivery(row, scope);
}

async function insertEvidence(
  client: PostgresIntegrationProjectionClient,
  receipt: Receipt,
  afterStep: StepNotifier,
): Promise<void> {
  const observations = receipt.kind === "observations";
  const resourceId = aggregateId(receipt);
  await client.query(insertAuditSql, [
    receipt.auditEventId,
    receipt.tenantId,
    receipt.projectId,
    receipt.committedAt,
    receipt.gatewayId,
    observations
      ? "integration.observations.report"
      : "integration.topology.report",
    resourceId,
    receipt.requestId,
    receipt.payloadDigest,
  ]);
  await afterStep("audit-written");
  await client.query(insertOutboxSql, [
    receipt.outboxEventId,
    receipt.tenantId,
    receipt.projectId,
    receipt.committedAt,
    observations
      ? "integration.projection-observations-changed.v1"
      : "integration.projection-topology-changed.v1",
    resourceId,
    JSON.stringify(receipt),
  ]);
  await afterStep("outbox-written");
}

async function persistTopologyInTransaction(
  client: PostgresIntegrationProjectionClient,
  input: IntegrationTopologyPersistenceInput,
  afterStep: StepNotifier,
  scopeLocked = false,
): Promise<IntegrationTopologyPersistenceResult> {
  requireBoundedIdentifier(input.requestId, "requestId");
  requireDigest(input.payloadDigest, "payloadDigest");
  const scope = topologyScope(input);
  if (!scopeLocked) await lockScope(client, scope);
  const current = await selectCurrent(client, scope, true);
  if (
    current !== undefined &&
    BigInt(input.topology.snapshotGeneration) <
      BigInt(current.topology.snapshotGeneration)
  ) {
    return { outcome: "stale-generation" };
  }
  if (
    current !== undefined &&
    current.topology.integrationKind !== input.topology.integrationKind
  ) {
    return { outcome: "generation-conflict" };
  }

  const priorRequest = await selectInbox(client, scope, input.requestId);
  if (priorRequest !== undefined) {
    return current !== undefined &&
      inboxMatchesTopology(priorRequest, input, current)
      ? {
          outcome: "replayed",
          record: current,
          receipt: priorRequest,
        }
      : { outcome: "idempotency-conflict" };
  }
  if (
    current !== undefined &&
    current.topology.snapshotGeneration === input.topology.snapshotGeneration
  ) {
    return { outcome: "generation-conflict" };
  }
  if (current?.revision === maximumSafeRevision) {
    return { outcome: "storage-unavailable" };
  }

  const revision = (current?.revision ?? 0) + 1;
  const record = freezeRecord({
    ...scope,
    topology: input.topology,
    topologyDigest: input.payloadDigest,
    latestObservations: [],
    receivedAt: input.receivedAt,
    revision,
  });
  if (current === undefined) {
    await client.query(insertCurrentSql, [
      ...scopeValues(scope),
      input.topology.integrationKind,
      input.topology.snapshotGeneration,
      input.payloadDigest,
      JSON.stringify(input.topology),
      "[]",
      input.receivedAt,
      revision,
    ]);
  } else {
    const updated = await client.query(updateTopologyCurrentSql, [
      ...scopeValues(scope),
      input.topology.snapshotGeneration,
      input.payloadDigest,
      JSON.stringify(input.topology),
      input.receivedAt,
      revision,
      input.topology.integrationKind,
      current.revision,
    ]);
    if (updated.rowCount !== 1) {
      throw new Error(
        "PostgreSQL integration topology lost its locked revision",
      );
    }
  }
  await afterStep("projection-written");
  await client.query(insertTopologyIdentitySql, [
    ...scopeValues(scope),
    input.topology.integrationKind,
    input.topology.snapshotGeneration,
    input.payloadDigest,
    JSON.stringify(input.topology),
    revision,
    input.receivedAt,
  ]);
  await afterStep("identity-written");

  const receipt = topologyReceipt(input, revision);
  await client.query(insertInboxSql, inboxValues(receipt));
  await afterStep("inbox-written");
  await insertEvidence(client, receipt, afterStep);
  return { outcome: "persisted", record, receipt };
}

async function persistObservationsInTransaction(
  client: PostgresIntegrationProjectionClient,
  input: IntegrationObservationPersistenceInput,
  afterStep: StepNotifier,
  scopeLocked = false,
): Promise<IntegrationObservationPersistenceResult> {
  requireBoundedIdentifier(input.requestId, "requestId");
  requireDigest(input.payloadDigest, "payloadDigest");
  const scope = observationScope(input);
  if (!scopeLocked) await lockScope(client, scope);
  const current = await selectCurrent(client, scope, true);
  if (current === undefined) {
    return { outcome: "topology-required" };
  }
  if (current.topology.snapshotGeneration !== input.batch.snapshotGeneration) {
    return { outcome: "generation-conflict" };
  }
  const priorRequest = await selectInbox(client, scope, input.requestId);
  if (priorRequest !== undefined) {
    return inboxMatchesObservations(priorRequest, input)
      ? {
          outcome: "replayed",
          record: current,
          receipt: priorRequest,
        }
      : { outcome: "idempotency-conflict" };
  }
  const priorBatch = await client.query<Row>(selectBatchIdentitySql, [
    ...scopeValues(scope),
    input.batch.snapshotGeneration,
    input.batch.batchId,
  ]);
  if (priorBatch.rows.length > 0) {
    return { outcome: "batch-conflict" };
  }
  if (current.revision === maximumSafeRevision) {
    return { outcome: "storage-unavailable" };
  }

  const latestObservations = mergeLatestObservations(
    current.latestObservations,
    input.batch.observations,
  );
  const revision = current.revision + 1;
  const record = freezeRecord({
    ...scope,
    topology: current.topology,
    topologyDigest: current.topologyDigest,
    latestObservations,
    receivedAt: input.receivedAt,
    revision,
  });
  const updated = await client.query(updateObservationCurrentSql, [
    ...scopeValues(scope),
    JSON.stringify(latestObservations),
    input.receivedAt,
    revision,
    input.batch.snapshotGeneration,
    current.revision,
  ]);
  if (updated.rowCount !== 1) {
    throw new Error(
      "PostgreSQL integration observations lost their locked revision",
    );
  }
  await afterStep("projection-written");
  await client.query(insertBatchIdentitySql, [
    ...scopeValues(scope),
    input.batch.snapshotGeneration,
    input.batch.batchId,
    input.payloadDigest,
    input.receivedAt,
  ]);
  await afterStep("identity-written");

  const receipt = observationReceipt(input, revision);
  await client.query(insertInboxSql, inboxValues(receipt));
  await afterStep("inbox-written");
  await insertEvidence(client, receipt, afterStep);
  return { outcome: "persisted", record, receipt };
}

interface PreparedCloudLinkDelivery {
  readonly contiguousPosition?: IntegrationCloudLinkDelivery["position"];
  readonly streamBindingMissing: boolean;
  readonly storedDelivery?: StoredCloudLinkDelivery;
  readonly failure?:
    | "delivery-conflict"
    | "delivery-gap"
    | "stream-binding-conflict";
}

async function prepareCloudLinkDelivery(
  client: PostgresIntegrationProjectionClient,
  scope: IntegrationProjectionScope,
  delivery: IntegrationCloudLinkDelivery,
): Promise<PreparedCloudLinkDelivery> {
  await lockScope(client, scope);
  await lockDeliveryStream(client, scope, delivery);
  const streamBinding = await selectStreamBinding(client, scope, delivery);
  if (
    streamBinding !== undefined &&
    (streamBinding.integrationId !== scope.integrationId ||
      streamBinding.messageKind !== delivery.messageKind)
  ) {
    return {
      streamBindingMissing: false,
      failure: "stream-binding-conflict",
    };
  }
  const storedDelivery = await selectStoredDelivery(client, scope, delivery);
  if (storedDelivery !== undefined && !sameDelivery(storedDelivery, delivery)) {
    return {
      streamBindingMissing: false,
      failure: "delivery-conflict",
    };
  }
  const contiguousPosition = streamBinding?.contiguousPosition;
  if (storedDelivery !== undefined) {
    if (
      contiguousPosition === undefined ||
      BigInt(storedDelivery.position) > BigInt(contiguousPosition)
    ) {
      throw new Error(
        "PostgreSQL CloudLink delivery exceeds its contiguous cursor",
      );
    }
  } else {
    const expected =
      (contiguousPosition === undefined ? 0n : BigInt(contiguousPosition)) + 1n;
    const received = BigInt(delivery.position);
    if (received !== expected) {
      return {
        streamBindingMissing: streamBinding === undefined,
        failure: received > expected ? "delivery-gap" : "delivery-conflict",
      };
    }
  }
  return {
    streamBindingMissing: streamBinding === undefined,
    ...(contiguousPosition === undefined ? {} : { contiguousPosition }),
    ...(storedDelivery === undefined ? {} : { storedDelivery }),
  };
}

async function replayStoredCloudLinkDelivery(
  client: PostgresIntegrationProjectionClient,
  scope: IntegrationProjectionScope,
  stored: StoredCloudLinkDelivery,
  expectedReceiptKind: Receipt["kind"],
): Promise<
  Readonly<{
    record: IntegrationProjectionRecord;
    receipt: Receipt;
  }>
> {
  const receipt = await selectInbox(client, scope, stored.requestId);
  if (
    receipt === undefined ||
    receipt.kind !== expectedReceiptKind ||
    receipt.auditEventId !== stored.projectionAuditEventId ||
    receipt.outboxEventId !== stored.projectionOutboxEventId
  ) {
    throw new Error(
      "PostgreSQL CloudLink delivery is missing committed projection evidence",
    );
  }
  let record: IntegrationProjectionRecord;
  if (receipt.kind === "topology") {
    const historical = await selectTopologyHistory(
      client,
      scope,
      receipt.snapshotGeneration,
    );
    if (
      historical === undefined ||
      historical.revision !== receipt.revision ||
      historical.topology.snapshotGeneration !== receipt.snapshotGeneration ||
      historical.topologyDigest !== receipt.payloadDigest
    ) {
      throw new Error(
        "PostgreSQL CloudLink delivery is missing its projection record",
      );
    }
    record = freezeRecord({
      ...historical,
      latestObservations: [],
    });
  } else {
    const current = await selectCurrent(client, scope, true);
    if (current === undefined) {
      throw new Error(
        "PostgreSQL CloudLink delivery is missing its projection record",
      );
    }
    record = current;
  }
  return {
    record,
    receipt,
  };
}

async function insertCloudLinkDelivery(
  client: PostgresIntegrationProjectionClient,
  scope: IntegrationProjectionScope,
  input:
    | IntegrationObservationPersistenceInput
    | IntegrationTopologyPersistenceInput,
  receipt: Receipt,
  delivery: IntegrationCloudLinkDelivery,
  streamBindingMissing: boolean,
  contiguousPosition: IntegrationCloudLinkDelivery["position"] | undefined,
  afterStep: StepNotifier,
): Promise<IntegrationCloudLinkDurableAcknowledgement> {
  if (streamBindingMissing) {
    await client.query(insertStreamBindingSql, [
      scope.tenantId,
      scope.projectId,
      scope.gatewayId,
      delivery.streamId,
      delivery.streamEpoch,
      delivery.messageKind,
      scope.integrationId,
      input.receivedAt,
    ]);
    await afterStep("stream-binding-written");
  }
  await client.query(insertDeliverySql, [
    scope.tenantId,
    scope.projectId,
    scope.gatewayId,
    delivery.streamId,
    delivery.streamEpoch,
    delivery.position,
    scope.integrationId,
    delivery.messageKind,
    delivery.batchId,
    delivery.digest,
    input.requestId,
    receipt.auditEventId,
    receipt.outboxEventId,
    input.receivedAt,
  ]);
  await afterStep("delivery-written");
  await upsertCloudLinkDeliveryAttempt(
    client,
    scope,
    delivery,
    input.receivedAt,
    afterStep,
  );
  await advanceCloudLinkCursor(
    client,
    scope,
    delivery,
    contiguousPosition,
    afterStep,
  );
  return upsertCloudLinkAcknowledgement(
    client,
    scope,
    delivery,
    input.receivedAt,
    afterStep,
  );
}

async function upsertCloudLinkDeliveryAttempt(
  client: PostgresIntegrationProjectionClient,
  scope: IntegrationProjectionScope,
  delivery: IntegrationCloudLinkDelivery,
  receivedAt: IntegrationProjectionRecord["receivedAt"],
  afterStep: StepNotifier,
): Promise<void> {
  const stored = await client.query<Row>(upsertDeliveryAttemptSql, [
    scope.tenantId,
    scope.projectId,
    scope.gatewayId,
    delivery.streamId,
    delivery.streamEpoch,
    delivery.position,
    delivery.sessionId,
    delivery.sessionEpoch,
    delivery.credentialGeneration,
    receivedAt,
  ]);
  const row = stored.rows[0];
  if (
    stored.rowCount !== 1 ||
    row === undefined ||
    parseStreamPosition(row.position) !== delivery.position
  ) {
    throw new Error(
      "PostgreSQL CloudLink delivery attempt upsert was rejected",
    );
  }
  await afterStep("delivery-attempt-written");
}

async function advanceCloudLinkCursor(
  client: PostgresIntegrationProjectionClient,
  scope: IntegrationProjectionScope,
  delivery: IntegrationCloudLinkDelivery,
  priorPosition: IntegrationCloudLinkDelivery["position"] | undefined,
  afterStep: StepNotifier,
): Promise<void> {
  const prior = priorPosition === undefined ? 0n : BigInt(priorPosition);
  const received = BigInt(delivery.position);
  if (received !== prior + 1n) {
    throw new Error("PostgreSQL CloudLink cursor advance is not contiguous");
  }

  const updated = await client.query<Row>(updateStreamCursorSql, [
    scope.tenantId,
    scope.projectId,
    scope.gatewayId,
    delivery.streamId,
    delivery.streamEpoch,
    delivery.position,
    priorPosition ?? null,
  ]);
  const row = updated.rows[0];
  const position =
    row === undefined
      ? undefined
      : parseStreamPosition(row.contiguous_position);
  if (
    updated.rowCount !== 1 ||
    position === undefined ||
    position !== delivery.position
  ) {
    throw new Error(
      "PostgreSQL CloudLink contiguous cursor update was rejected",
    );
  }
  await afterStep("cursor-written");
}

async function recordCloudLinkDeliveryAttempt(
  client: PostgresIntegrationProjectionClient,
  scope: IntegrationProjectionScope,
  delivery: IntegrationCloudLinkDelivery,
  receivedAt: IntegrationProjectionRecord["receivedAt"],
  afterStep: StepNotifier,
): Promise<IntegrationCloudLinkDurableAcknowledgement> {
  await upsertCloudLinkDeliveryAttempt(
    client,
    scope,
    delivery,
    receivedAt,
    afterStep,
  );
  return upsertCloudLinkAcknowledgement(
    client,
    scope,
    delivery,
    receivedAt,
    afterStep,
  );
}

async function upsertCloudLinkAcknowledgement(
  client: PostgresIntegrationProjectionClient,
  scope: IntegrationProjectionScope,
  delivery: IntegrationCloudLinkDelivery,
  acknowledgedAt: IntegrationProjectionRecord["receivedAt"],
  afterStep: StepNotifier,
): Promise<IntegrationCloudLinkDurableAcknowledgement> {
  const acknowledgement = durableAcknowledgement(
    scope,
    delivery,
    acknowledgedAt,
  );
  const stored = await client.query<Row>(upsertDurableAckSql, [
    acknowledgement.outboxEventId,
    acknowledgement.tenantId,
    acknowledgement.projectId,
    acknowledgement.gatewayId,
    acknowledgement.integrationId,
    acknowledgement.messageKind,
    acknowledgement.sessionId,
    acknowledgement.sessionEpoch,
    acknowledgement.credentialGeneration,
    acknowledgement.streamId,
    acknowledgement.streamEpoch,
    acknowledgement.acknowledgedPosition,
    acknowledgement.batchId,
    acknowledgement.digest,
    acknowledgement.receiptId,
    acknowledgement.acknowledgedAt,
  ]);
  const row = stored.rows[0];
  if (stored.rowCount !== 1 || row === undefined) {
    throw new Error("PostgreSQL CloudLink durable ACK upsert was rejected");
  }
  const persisted = decodeAcknowledgementRow(row, scope, delivery);
  if (
    persisted.receiptId !== acknowledgement.receiptId ||
    persisted.outboxEventId !== acknowledgement.outboxEventId
  ) {
    throw new Error(
      "PostgreSQL CloudLink durable ACK identity is contradictory",
    );
  }
  await afterStep("durable-ack-written");
  return persisted;
}

export interface PostgresIntegrationProjectionRepositoryOptions {
  readonly faultInjector?: PostgresIntegrationProjectionFaultInjector;
}

export class PostgresIntegrationProjectionRepository
  implements IntegrationProjectionRepository, IntegrationProjectionCatalog
{
  readonly #pool: PostgresIntegrationProjectionPool;
  readonly #faultInjector:
    | PostgresIntegrationProjectionFaultInjector
    | undefined;

  constructor(
    pool: PostgresIntegrationProjectionPool,
    options: PostgresIntegrationProjectionRepositoryOptions = {},
  ) {
    this.#pool = pool;
    this.#faultInjector = options.faultInjector;
  }

  persistTopology(
    input: IntegrationTopologyPersistenceInput,
  ): Promise<IntegrationTopologyPersistenceResult> {
    if (
      input.cloudLinkSessionFence !== undefined &&
      input.cloudLinkDelivery === undefined
    ) {
      return Promise.resolve({ outcome: "session-fenced" });
    }
    if (input.cloudLinkDelivery !== undefined) {
      return this.persistTopologyDelivery(input, input.cloudLinkDelivery);
    }
    return this.transaction(
      input.binding.tenantId,
      { outcome: "storage-unavailable" },
      (client) =>
        persistTopologyInTransaction(client, input, this.afterStep.bind(this)),
    );
  }

  persistObservations(
    input: IntegrationObservationPersistenceInput,
  ): Promise<IntegrationObservationPersistenceResult> {
    if (
      input.cloudLinkSessionFence !== undefined &&
      input.cloudLinkDelivery === undefined
    ) {
      return Promise.resolve({ outcome: "session-fenced" });
    }
    if (input.cloudLinkDelivery !== undefined) {
      return this.persistObservationDelivery(input, input.cloudLinkDelivery);
    }
    return this.transaction(
      input.binding.tenantId,
      { outcome: "storage-unavailable" },
      (client) =>
        persistObservationsInTransaction(
          client,
          input,
          this.afterStep.bind(this),
        ),
    );
  }

  private persistTopologyDelivery(
    input: IntegrationTopologyPersistenceInput,
    delivery: IntegrationCloudLinkDelivery,
  ): Promise<IntegrationTopologyPersistenceResult> {
    return this.transaction<IntegrationTopologyPersistenceResult>(
      input.binding.tenantId,
      { outcome: "storage-unavailable" },
      async (client) => {
        if (!(await lockCurrentCloudLinkSessionFence(client, input))) {
          return { outcome: "session-fenced" };
        }
        if (
          !validateDelivery(delivery, input, "integration-topology-snapshot")
        ) {
          return { outcome: "delivery-conflict" };
        }
        const scope = topologyScope(input);
        const prepared = await prepareCloudLinkDelivery(
          client,
          scope,
          delivery,
        );
        if (prepared.failure !== undefined) {
          return { outcome: prepared.failure };
        }
        if (prepared.storedDelivery !== undefined) {
          const replay = await replayStoredCloudLinkDelivery(
            client,
            scope,
            prepared.storedDelivery,
            "topology",
          );
          if (replay.receipt.kind !== "topology") {
            throw new Error(
              "PostgreSQL CloudLink topology delivery has wrong receipt",
            );
          }
          const acknowledgement = await recordCloudLinkDeliveryAttempt(
            client,
            scope,
            delivery,
            input.receivedAt,
            this.afterStep.bind(this),
          );
          return {
            outcome: "replayed",
            ...replay,
            receipt: replay.receipt,
            durableAcknowledgement: acknowledgement,
          };
        }
        const projection = await persistTopologyInTransaction(
          client,
          input,
          this.afterStep.bind(this),
          true,
        );
        switch (projection.outcome) {
          case "delivery-conflict":
          case "delivery-gap":
          case "generation-conflict":
          case "idempotency-conflict":
          case "session-fenced":
          case "stale-generation":
          case "storage-unavailable":
          case "stream-binding-conflict":
            return { outcome: projection.outcome };
          case "persisted":
          case "replayed":
            break;
        }
        const acknowledgement = await insertCloudLinkDelivery(
          client,
          scope,
          input,
          projection.receipt,
          delivery,
          prepared.streamBindingMissing,
          prepared.contiguousPosition,
          this.afterStep.bind(this),
        );
        return {
          ...projection,
          durableAcknowledgement: acknowledgement,
        };
      },
    );
  }

  private persistObservationDelivery(
    input: IntegrationObservationPersistenceInput,
    delivery: IntegrationCloudLinkDelivery,
  ): Promise<IntegrationObservationPersistenceResult> {
    return this.transaction<IntegrationObservationPersistenceResult>(
      input.binding.tenantId,
      { outcome: "storage-unavailable" },
      async (client) => {
        if (!(await lockCurrentCloudLinkSessionFence(client, input))) {
          return { outcome: "session-fenced" };
        }
        if (
          !validateDelivery(delivery, input, "integration-observation-batch")
        ) {
          return { outcome: "delivery-conflict" };
        }
        const scope = observationScope(input);
        const prepared = await prepareCloudLinkDelivery(
          client,
          scope,
          delivery,
        );
        if (prepared.failure !== undefined) {
          return { outcome: prepared.failure };
        }
        if (prepared.storedDelivery !== undefined) {
          const replay = await replayStoredCloudLinkDelivery(
            client,
            scope,
            prepared.storedDelivery,
            "observations",
          );
          if (replay.receipt.kind !== "observations") {
            throw new Error(
              "PostgreSQL CloudLink observation delivery has wrong receipt",
            );
          }
          const acknowledgement = await recordCloudLinkDeliveryAttempt(
            client,
            scope,
            delivery,
            input.receivedAt,
            this.afterStep.bind(this),
          );
          return {
            outcome: "replayed",
            ...replay,
            receipt: replay.receipt,
            durableAcknowledgement: acknowledgement,
          };
        }
        const projection = await persistObservationsInTransaction(
          client,
          input,
          this.afterStep.bind(this),
          true,
        );
        switch (projection.outcome) {
          case "batch-conflict":
          case "delivery-conflict":
          case "delivery-gap":
          case "generation-conflict":
          case "idempotency-conflict":
          case "session-fenced":
          case "storage-unavailable":
          case "stream-binding-conflict":
          case "topology-required":
            return { outcome: projection.outcome };
          case "persisted":
          case "replayed":
            break;
        }
        const acknowledgement = await insertCloudLinkDelivery(
          client,
          scope,
          input,
          projection.receipt,
          delivery,
          prepared.streamBindingMissing,
          prepared.contiguousPosition,
          this.afterStep.bind(this),
        );
        return {
          ...projection,
          durableAcknowledgement: acknowledgement,
        };
      },
    );
  }

  async list(
    query: IntegrationProjectionCatalogQuery,
  ): Promise<readonly IntegrationProjectionCatalogRecord[]> {
    try {
      parseTenantId(query.tenantId);
      parseProjectId(query.projectId);
      if (query.gatewayId !== undefined) parseGatewayId(query.gatewayId);
      if (query.after !== undefined) {
        parseGatewayId(query.after.gatewayId);
        parseIntegrationId(query.after.integrationId);
      }
      if (
        !Number.isSafeInteger(query.limit) ||
        query.limit < 1 ||
        query.limit > 101 ||
        (query.gatewayId !== undefined &&
          query.after !== undefined &&
          query.gatewayId !== query.after.gatewayId)
      ) {
        throw new Error("invalid catalog query");
      }
    } catch {
      throw new IntegrationProjectionStorageUnavailableError(
        "PostgreSQL integration projection catalog is unavailable",
      );
    }
    const records = await this.transaction<
      readonly IntegrationProjectionCatalogRecord[] | undefined
    >(query.tenantId, undefined, (client) => selectCatalog(client, query));
    if (records === undefined) {
      throw new IntegrationProjectionStorageUnavailableError(
        "PostgreSQL integration projection catalog is unavailable",
      );
    }
    return records;
  }

  findCurrent(
    scope: IntegrationProjectionScope,
  ): Promise<IntegrationProjectionRecord | undefined> {
    return this.transaction(scope.tenantId, undefined, (client) =>
      selectCurrent(client, scope, false),
    );
  }

  findTopology(
    scope: IntegrationProjectionScope,
    snapshotGeneration: IntegrationSnapshotGeneration,
  ): Promise<IntegrationTopologyHistoryRecord | undefined> {
    return this.transaction(scope.tenantId, undefined, (client) =>
      selectTopologyHistory(client, scope, snapshotGeneration),
    );
  }

  private afterStep(
    step: PostgresIntegrationProjectionPersistenceStep,
  ): Promise<void> {
    return Promise.resolve(this.#faultInjector?.afterStep?.(step));
  }

  private async transaction<Result>(
    tenantId: TenantId,
    unavailable: Result,
    operation: (client: PostgresIntegrationProjectionClient) => Promise<Result>,
  ): Promise<Result> {
    let client: PostgresIntegrationProjectionClient | undefined;
    let began = false;
    let committed = false;
    try {
      client = await this.#pool.connect();
      await client.query("BEGIN");
      began = true;
      await setTenantScope(client, tenantId);
      const result = await operation(client);
      await this.#faultInjector?.beforeCommit?.();
      await client.query("COMMIT");
      committed = true;
      await this.#faultInjector?.afterCommit?.();
      return result;
    } catch {
      if (client !== undefined && began && !committed) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The typed storage outcome remains authoritative if rollback transport fails.
        }
      }
      return unavailable;
    } finally {
      client?.release();
    }
  }
}
