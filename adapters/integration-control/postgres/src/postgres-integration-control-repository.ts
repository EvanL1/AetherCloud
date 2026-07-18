import { createHash } from "node:crypto";

import type {
  IntegrationControlActionOffer,
  IntegrationControlDurableAcknowledgement,
  IntegrationControlRepository,
  IntegrationControlScope,
  IntegrationIntentAndOfferPersistenceInput,
  IntegrationIntentAndOfferPersistenceResult,
  IntegrationOfferOutboxRecord,
  IntegrationOfferPublishedResult,
  IntegrationReceiptPersistenceInput,
  IntegrationReceiptPersistenceResult,
  IntegrationReofferPersistenceInput,
  IntegrationReofferPersistenceResult,
  IntegrationStoredIntent,
} from "@aether-cloud/application";
import type {
  GatewayId,
  GovernedJobId,
  TenantId,
  UtcInstant,
} from "@aether-cloud/domain";

import {
  canonicalJson,
  decodeIntentPayload,
  decodeOfferRow,
  decodeReceiptEvidenceRow,
  decodeStoredDeliveryRow,
  decodeStoredIntentRow,
  integrationControlFingerprint,
  sameJson,
} from "./integration-control-codec.js";
import type {
  PostgresIntegrationControlClient,
  PostgresIntegrationControlFaultInjector,
  PostgresIntegrationControlPersistenceStep,
  PostgresIntegrationControlPool,
} from "./postgres-integration-control-contracts.js";

interface RepositoryOptions {
  readonly faultInjector?: PostgresIntegrationControlFaultInjector;
}

interface AuditWrite {
  readonly eventId: string;
  readonly scope: IntegrationControlScope;
  readonly occurredAt: UtcInstant;
  readonly subjectKind: "gateway" | "system" | "user";
  readonly subjectId: string;
  readonly action:
    | "integration-control.intent-created"
    | "integration-control.offer-published"
    | "integration-control.offer-staged"
    | "integration-control.receipt-persisted";
  readonly jobId: GovernedJobId;
  readonly outcome: "accepted" | "succeeded";
  readonly correlationId: string;
  readonly detailsDigest: string;
}

interface IntentIdentity {
  readonly digest: string;
  readonly intent: ReturnType<typeof decodeIntentPayload>;
}

const selectRequestSql = `
/* integration-control:select-request */
SELECT request_fingerprint, offer_event_id
FROM aethercloud.integration_control_requests
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND request_id = $4
`;

const selectIntentSql = `
/* integration-control:select-intent */
SELECT
  tenant_id::text AS tenant_id,
  project_id::text AS project_id,
  gateway_id::text AS gateway_id,
  job_id::text AS job_id,
  intent_digest,
  intent_payload,
  expires_at_ms::text AS expires_at_ms,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  latest_receipt_payload,
  revision::text AS revision
FROM aethercloud.integration_control_intents
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND job_id = $4::uuid
`;

const selectIntentForUpdateSql = `
/* integration-control:select-intent-for-update */
SELECT
  tenant_id::text AS tenant_id,
  project_id::text AS project_id,
  gateway_id::text AS gateway_id,
  job_id::text AS job_id,
  intent_digest,
  intent_payload,
  expires_at_ms::text AS expires_at_ms,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  latest_receipt_payload,
  revision::text AS revision
FROM aethercloud.integration_control_intents
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND job_id = $4::uuid
FOR UPDATE
`;

const selectIntentIdentityForUpdateSql = `
/* integration-control:select-intent-for-update */
SELECT intent_digest, intent_payload
FROM aethercloud.integration_control_intents
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND job_id = $4::uuid
FOR UPDATE
`;

const offerColumns = `
  sequence::text AS sequence,
  event_id,
  tenant_id::text AS tenant_id,
  project_id::text AS project_id,
  gateway_id::text AS gateway_id,
  job_id::text AS job_id,
  session_id::text AS session_id,
  session_epoch::text AS session_epoch,
  intent_digest,
  offer_payload,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  CASE
    WHEN published_at IS NULL THEN NULL
    ELSE to_char(
      published_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  END AS published_at
`;

const selectOfferForUpdateSql = `
/* integration-control:select-offer-for-update */
SELECT ${offerColumns}
FROM aethercloud.integration_control_offer_outbox
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND job_id = $4::uuid
  AND session_id = $5::uuid
  AND session_epoch = $6::numeric
FOR UPDATE
`;

const selectOfferByEventSql = `
/* integration-control:select-offer-by-event */
SELECT ${offerColumns}
FROM aethercloud.integration_control_offer_outbox
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND event_id = $4
`;

const selectOfferPublishForUpdateSql = `
/* integration-control:select-offer-publish-for-update */
SELECT ${offerColumns}
FROM aethercloud.integration_control_offer_outbox
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND event_id = $3
FOR UPDATE
`;

const insertIntentSql = `
/* integration-control:insert-intent */
INSERT INTO aethercloud.integration_control_intents (
  tenant_id,
  project_id,
  gateway_id,
  job_id,
  intent_digest,
  intent_payload,
  expires_at_ms,
  created_at,
  latest_receipt_payload,
  latest_receipt_id,
  revision
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4::uuid,
  $5,
  $6::jsonb,
  $7::numeric,
  $8::timestamptz,
  NULL,
  NULL,
  1
)
`;

const insertRequestSql = `
/* integration-control:insert-request */
INSERT INTO aethercloud.integration_control_requests (
  tenant_id,
  project_id,
  gateway_id,
  request_id,
  operation,
  request_fingerprint,
  job_id,
  offer_event_id,
  created_at
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5,
  $6,
  $7::uuid,
  $8,
  $9::timestamptz
)
`;

const insertOfferSql = `
/* integration-control:insert-offer */
INSERT INTO aethercloud.integration_control_offer_outbox (
  event_id,
  tenant_id,
  project_id,
  gateway_id,
  job_id,
  session_id,
  session_epoch,
  intent_digest,
  offer_payload,
  created_at
) VALUES (
  $1,
  $2::uuid,
  $3::uuid,
  $4::uuid,
  $5::uuid,
  $6::uuid,
  $7::numeric,
  $8,
  $9::jsonb,
  $10::timestamptz
)
`;

const selectStreamBindingForUpdateSql = `
/* integration-control:select-stream-binding-for-update */
SELECT stream_id
FROM aethercloud.integration_control_receipt_stream_bindings
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
FOR UPDATE
`;

const selectStreamForUpdateSql = `
/* integration-control:select-stream-for-update */
SELECT contiguous_position::text AS contiguous_position
FROM aethercloud.integration_control_receipt_streams
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND stream_id = $4
  AND stream_epoch = $5::numeric
FOR UPDATE
`;

const selectDeliverySql = `
/* integration-control:select-delivery */
SELECT
  delivery.stream_id,
  delivery.stream_epoch::text AS stream_epoch,
  delivery.position::text AS position,
  delivery.batch_id,
  delivery.business_digest,
  receipt.job_id::text AS job_id,
  receipt.receipt_payload,
  receipt.provider_accepted,
  receipt.physical_completed,
  receipt.job_succeeded,
  receipt.audit_event_id,
  to_char(
    receipt.received_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) AS received_at
FROM aethercloud.integration_control_receipt_deliveries AS delivery
JOIN aethercloud.integration_control_receipts AS receipt
  ON receipt.tenant_id = delivery.tenant_id
  AND receipt.project_id = delivery.project_id
  AND receipt.gateway_id = delivery.gateway_id
  AND receipt.job_id = delivery.job_id
  AND receipt.receipt_id = delivery.receipt_id
WHERE delivery.tenant_id = $1::uuid
  AND delivery.project_id = $2::uuid
  AND delivery.gateway_id = $3::uuid
  AND delivery.stream_id = $4
  AND delivery.stream_epoch = $5::numeric
  AND delivery.position = $6::numeric
`;

const receiptEvidenceColumns = `
  tenant_id::text AS tenant_id,
  project_id::text AS project_id,
  gateway_id::text AS gateway_id,
  job_id::text AS job_id,
  receipt_payload,
  provider_accepted,
  physical_completed,
  job_succeeded,
  audit_event_id,
  to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at
`;

const selectReceiptByIdSql = `
/* integration-control:select-receipt-by-id */
SELECT ${receiptEvidenceColumns}
FROM aethercloud.integration_control_receipts
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND job_id = $4::uuid
  AND receipt_id = $5::uuid
`;

const selectReceiptBySequenceSql = `
/* integration-control:select-receipt-by-sequence */
SELECT ${receiptEvidenceColumns}
FROM aethercloud.integration_control_receipts
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND job_id = $4::uuid
  AND receipt_sequence = $5::numeric
`;

const insertStreamBindingSql = `
/* integration-control:insert-stream-binding */
INSERT INTO aethercloud.integration_control_receipt_stream_bindings (
  tenant_id,
  project_id,
  gateway_id,
  stream_id,
  bound_at
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5::timestamptz
)
`;

const insertStreamSql = `
/* integration-control:insert-stream */
INSERT INTO aethercloud.integration_control_receipt_streams (
  tenant_id,
  project_id,
  gateway_id,
  stream_id,
  stream_epoch,
  contiguous_position,
  opened_at
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5::numeric,
  0,
  $6::timestamptz
)
`;

const insertReceiptSql = `
/* integration-control:insert-receipt */
INSERT INTO aethercloud.integration_control_receipts (
  tenant_id,
  project_id,
  gateway_id,
  job_id,
  receipt_id,
  receipt_sequence,
  receipt_payload,
  stage,
  provider_accepted,
  physical_completed,
  job_succeeded,
  audit_event_id,
  received_at
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4::uuid,
  $5::uuid,
  $6::numeric,
  $7::jsonb,
  $8,
  $9,
  $10,
  $11,
  $12,
  $13::timestamptz
)
`;

const insertDeliverySql = `
/* integration-control:insert-delivery */
INSERT INTO aethercloud.integration_control_receipt_deliveries (
  tenant_id,
  project_id,
  gateway_id,
  stream_id,
  stream_epoch,
  position,
  batch_id,
  business_digest,
  request_id,
  job_id,
  receipt_id,
  receipt_sequence,
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
  $10::uuid,
  $11::uuid,
  $12::numeric,
  $13::timestamptz
)
`;

const updateIntentReceiptSql = `
/* integration-control:update-intent-receipt */
UPDATE aethercloud.integration_control_intents
SET
  latest_receipt_payload = $5::jsonb,
  latest_receipt_id = $6::uuid,
  revision = $7::bigint,
  updated_at = clock_timestamp()
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND job_id = $4::uuid
  AND revision = $8::bigint
`;

const updateStreamCursorSql = `
/* integration-control:update-stream-cursor */
UPDATE aethercloud.integration_control_receipt_streams
SET
  contiguous_position = $6::numeric,
  updated_at = clock_timestamp()
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND stream_id = $4
  AND stream_epoch = $5::numeric
  AND contiguous_position = $7::numeric
`;

const insertAcknowledgementSql = `
/* integration-control:insert-ack */
INSERT INTO aethercloud.integration_control_ack_outbox (
  event_id,
  tenant_id,
  project_id,
  gateway_id,
  session_id,
  session_epoch,
  credential_generation,
  stream_id,
  stream_epoch,
  acknowledged_position,
  batch_id,
  business_digest,
  source_receipt_id,
  acknowledgement_receipt_id,
  acknowledged_at
) VALUES (
  $1,
  $2::uuid,
  $3::uuid,
  $4::uuid,
  $5::uuid,
  $6::numeric,
  $7::numeric,
  $8,
  $9::numeric,
  $10::numeric,
  $11,
  $12,
  $13::uuid,
  $14,
  $15::timestamptz
)
ON CONFLICT (
  tenant_id,
  project_id,
  gateway_id,
  session_id,
  session_epoch,
  stream_id,
  stream_epoch,
  acknowledged_position
) DO NOTHING
`;

const listUnresolvedIntentsSql = `
/* integration-control:list-unresolved-intents */
SELECT
  tenant_id::text AS tenant_id,
  project_id::text AS project_id,
  gateway_id::text AS gateway_id,
  job_id::text AS job_id,
  intent_digest,
  intent_payload,
  expires_at_ms::text AS expires_at_ms,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  latest_receipt_payload,
  revision::text AS revision
FROM aethercloud.integration_control_intents
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND latest_receipt_payload IS NULL
ORDER BY created_at, job_id
`;

const listDispatchableOffersSql = `
/* integration-control:list-dispatchable-offers */
SELECT ${offerColumns}
FROM aethercloud.integration_control_offer_outbox AS offer
WHERE offer.tenant_id = $1::uuid
  AND offer.project_id = $2::uuid
  AND offer.gateway_id = $3::uuid
  AND offer.published_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM aethercloud.integration_control_intents AS intent
    WHERE intent.tenant_id = offer.tenant_id
      AND intent.project_id = offer.project_id
      AND intent.gateway_id = offer.gateway_id
      AND intent.job_id = offer.job_id
      AND intent.latest_receipt_payload IS NULL
  )
ORDER BY sequence
`;

const updateOfferPublishedSql = `
/* integration-control:update-offer-published */
UPDATE aethercloud.integration_control_offer_outbox
SET published_at = $4::timestamptz
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND event_id = $3
  AND published_at IS NULL
`;

function scopeValues(
  scope: IntegrationControlScope,
): readonly [string, string] {
  return [scope.tenantId, scope.projectId];
}

function intentValues(
  scope: IntegrationControlScope,
  gatewayId: GatewayId,
  jobId: GovernedJobId,
): readonly [string, string, string, string] {
  return [...scopeValues(scope), gatewayId, jobId];
}

function stableId(prefix: string, values: readonly string[]): string {
  const digest = createHash("sha256")
    .update(values.join("\u0000"), "utf8")
    .digest("hex");
  return `${prefix}:${digest}`;
}

function bareDigest(input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(input), "utf8")
    .digest("hex");
}

function subjectKind(subjectId: string): AuditWrite["subjectKind"] {
  return subjectId.startsWith("system:") ? "system" : "user";
}

function offerIdentity(
  scope: IntegrationControlScope,
  offer: IntegrationControlActionOffer,
): readonly string[] {
  return [
    scope.tenantId,
    scope.projectId,
    offer.gateway_id,
    offer.job_id,
    offer.session_id,
    offer.session_epoch,
  ];
}

function offerEventId(
  scope: IntegrationControlScope,
  offer: IntegrationControlActionOffer,
): string {
  return stableId(
    "outbox:integration-control:offer",
    offerIdentity(scope, offer),
  );
}

function requestFingerprint(
  gatewayId: GatewayId,
  offer: IntegrationControlActionOffer,
): string {
  return integrationControlFingerprint({
    gatewayId,
    jobId: offer.job_id,
    intentDigest: offer.intent_digest,
    intent: offer.intent,
  });
}

function sameIntent(
  stored: IntegrationStoredIntent | IntentIdentity,
  offer: IntegrationControlActionOffer,
): boolean {
  const digest = "intentDigest" in stored ? stored.intentDigest : stored.digest;
  return (
    digest === offer.intent_digest && sameJson(stored.intent, offer.intent)
  );
}

function sameOffer(
  stored: IntegrationOfferOutboxRecord,
  offer: IntegrationControlActionOffer,
): boolean {
  return sameJson(stored.offer, offer);
}

function makeStoredIntent(
  input: IntegrationIntentAndOfferPersistenceInput,
): IntegrationStoredIntent {
  return Object.freeze({
    ...input.scope,
    gatewayId: input.gatewayId,
    jobId: input.offer.job_id,
    intentDigest: input.offer.intent_digest,
    intent: input.offer.intent,
    expiresAtMs: input.offer.expires_at_ms,
    createdAt: input.createdAt,
    latestReceipt: undefined,
    revision: 1,
  });
}

function makeOfferRecord(
  input:
    | IntegrationIntentAndOfferPersistenceInput
    | IntegrationReofferPersistenceInput,
  eventId: string,
): IntegrationOfferOutboxRecord {
  return Object.freeze({
    eventId,
    ...input.scope,
    gatewayId: input.gatewayId,
    jobId: input.offer.job_id,
    sessionId: input.offer.session_id,
    sessionEpoch: input.offer.session_epoch,
    intentDigest: input.offer.intent_digest,
    offer: input.offer,
    status: "pending",
    createdAt: input.createdAt,
  });
}

async function setTenantScope(
  client: PostgresIntegrationControlClient,
  tenantId: TenantId,
): Promise<void> {
  await client.query("SELECT set_config('aethercloud.tenant_id', $1, true)", [
    tenantId,
  ]);
}

async function lockAggregate(
  client: PostgresIntegrationControlClient,
  scope: IntegrationControlScope,
  gatewayId: GatewayId,
  identity: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${scope.tenantId}:${scope.projectId}:${gatewayId}:${identity}`,
  ]);
}

async function oneOrUndefined(
  client: PostgresIntegrationControlClient,
  sql: string,
  values: readonly unknown[],
): Promise<Record<string, unknown> | undefined> {
  const result = await client.query(sql, values);
  if (result.rows.length > 1) {
    throw new Error("PostgreSQL returned a non-unique control ledger row");
  }
  return result.rows[0];
}

async function selectStoredIntent(
  client: PostgresIntegrationControlClient,
  scope: IntegrationControlScope,
  gatewayId: GatewayId,
  jobId: GovernedJobId,
  forUpdate: boolean,
): Promise<IntegrationStoredIntent | undefined> {
  const row = await oneOrUndefined(
    client,
    forUpdate ? selectIntentForUpdateSql : selectIntentSql,
    intentValues(scope, gatewayId, jobId),
  );
  return row === undefined ? undefined : decodeStoredIntentRow(row);
}

async function selectIntentIdentity(
  client: PostgresIntegrationControlClient,
  scope: IntegrationControlScope,
  gatewayId: GatewayId,
  jobId: GovernedJobId,
): Promise<IntentIdentity | undefined> {
  const row = await oneOrUndefined(
    client,
    selectIntentIdentityForUpdateSql,
    intentValues(scope, gatewayId, jobId),
  );
  return row === undefined
    ? undefined
    : {
        digest: String(row.intent_digest),
        intent: decodeIntentPayload(row.intent_payload),
      };
}

async function selectStoredOffer(
  client: PostgresIntegrationControlClient,
  scope: IntegrationControlScope,
  gatewayId: GatewayId,
  offer: IntegrationControlActionOffer,
): Promise<IntegrationOfferOutboxRecord | undefined> {
  const row = await oneOrUndefined(client, selectOfferForUpdateSql, [
    ...intentValues(scope, gatewayId, offer.job_id),
    offer.session_id,
    offer.session_epoch,
  ]);
  return row === undefined ? undefined : decodeOfferRow(row);
}

async function insertAuditEvents(
  client: PostgresIntegrationControlClient,
  writes: readonly AuditWrite[],
): Promise<void> {
  if (writes.length === 0) return;
  const values: unknown[] = [];
  const rows = writes.map((write, index) => {
    const offset = index * 14;
    values.push(
      write.eventId,
      write.scope.tenantId,
      write.scope.projectId,
      write.occurredAt,
      write.subjectKind,
      write.subjectId,
      write.action,
      "integration-control-job",
      write.jobId,
      write.outcome,
      "high",
      "explicit",
      write.correlationId,
      write.detailsDigest,
    );
    return `(
      $${String(offset + 1)},
      $${String(offset + 2)}::uuid,
      $${String(offset + 3)}::uuid,
      $${String(offset + 4)}::timestamptz,
      $${String(offset + 5)},
      $${String(offset + 6)},
      $${String(offset + 7)},
      $${String(offset + 8)},
      $${String(offset + 9)},
      $${String(offset + 10)},
      $${String(offset + 11)},
      $${String(offset + 12)},
      $${String(offset + 13)},
      NULL,
      $${String(offset + 14)}
    )`;
  });
  await client.query(
    `INSERT INTO aethercloud.audit_events (
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
      trace_id,
      details_digest
    ) VALUES ${rows.join(",")}`,
    values,
  );
}

function auditWrite(
  input:
    | IntegrationIntentAndOfferPersistenceInput
    | IntegrationReofferPersistenceInput,
  action: "intent-created" | "offer-staged",
  eventId: string,
): AuditWrite {
  return {
    eventId,
    scope: input.scope,
    occurredAt: input.createdAt,
    subjectKind: subjectKind(input.subjectId),
    subjectId: input.subjectId,
    action: `integration-control.${action}`,
    jobId: input.offer.job_id,
    outcome: action === "intent-created" ? "accepted" : "succeeded",
    correlationId: input.requestId,
    detailsDigest: bareDigest(input.offer),
  };
}

function acknowledgement(
  input: IntegrationReceiptPersistenceInput,
): IntegrationControlDurableAcknowledgement {
  return Object.freeze({
    ...input.scope,
    gatewayId: input.gatewayId,
    sessionId: input.sessionId,
    sessionEpoch: input.sessionEpoch,
    credentialGeneration: input.credentialGeneration,
    streamId: input.delivery.streamId,
    streamEpoch: input.delivery.streamEpoch,
    acknowledgedPosition: input.delivery.position,
    batchId: input.delivery.batchId,
    digest: input.delivery.digest,
    receiptId: `ack:integration-control:${input.receipt.receiptId}:${input.delivery.position}`,
    acknowledgedAt: input.receivedAt,
  });
}

async function insertAck(
  client: PostgresIntegrationControlClient,
  input: IntegrationReceiptPersistenceInput,
  durableAcknowledgement: IntegrationControlDurableAcknowledgement,
): Promise<void> {
  const eventId = stableId("outbox:integration-control:ack", [
    input.scope.tenantId,
    input.scope.projectId,
    input.gatewayId,
    input.sessionId,
    input.sessionEpoch,
    input.delivery.streamId,
    input.delivery.streamEpoch,
    input.delivery.position,
  ]);
  await client.query(insertAcknowledgementSql, [
    eventId,
    ...scopeValues(input.scope),
    input.gatewayId,
    input.sessionId,
    input.sessionEpoch,
    input.credentialGeneration,
    input.delivery.streamId,
    input.delivery.streamEpoch,
    input.delivery.position,
    input.delivery.batchId,
    input.delivery.digest,
    input.receipt.receiptId,
    durableAcknowledgement.receiptId,
    input.receivedAt,
  ]);
}

export class PostgresIntegrationControlRepository implements IntegrationControlRepository {
  readonly #pool: PostgresIntegrationControlPool;
  readonly #faultInjector: PostgresIntegrationControlFaultInjector | undefined;

  constructor(
    pool: PostgresIntegrationControlPool,
    options: RepositoryOptions = {},
  ) {
    this.#pool = pool;
    this.#faultInjector = options.faultInjector;
  }

  persistIntentAndOffer(
    input: IntegrationIntentAndOfferPersistenceInput,
  ): Promise<IntegrationIntentAndOfferPersistenceResult> {
    return this.transaction<IntegrationIntentAndOfferPersistenceResult>(
      input.scope.tenantId,
      { outcome: "storage-unavailable" },
      async (client) => {
        if (input.gatewayId !== input.offer.gateway_id) {
          return { outcome: "intent-conflict" };
        }
        await lockAggregate(
          client,
          input.scope,
          input.gatewayId,
          `job:${input.offer.job_id}`,
        );
        const fingerprint = requestFingerprint(input.gatewayId, input.offer);
        const priorRequest = await oneOrUndefined(client, selectRequestSql, [
          ...scopeValues(input.scope),
          input.gatewayId,
          input.requestId,
        ]);
        if (priorRequest !== undefined) {
          if (priorRequest.request_fingerprint !== fingerprint) {
            return { outcome: "idempotency-conflict" };
          }
          const intent = await selectStoredIntent(
            client,
            input.scope,
            input.gatewayId,
            input.offer.job_id,
            true,
          );
          const eventId = String(priorRequest.offer_event_id);
          const offerRow = await oneOrUndefined(client, selectOfferByEventSql, [
            ...scopeValues(input.scope),
            input.gatewayId,
            eventId,
          ]);
          if (intent === undefined || offerRow === undefined) {
            throw new Error("Replayed request is missing committed evidence");
          }
          const offer = decodeOfferRow(offerRow);
          if (
            !sameIntent(intent, input.offer) ||
            !sameOffer(offer, input.offer)
          ) {
            throw new Error("Replayed request evidence is inconsistent");
          }
          return { outcome: "replayed", intent, offer };
        }

        const existingIntent = await selectStoredIntent(
          client,
          input.scope,
          input.gatewayId,
          input.offer.job_id,
          true,
        );
        if (
          existingIntent !== undefined &&
          !sameIntent(existingIntent, input.offer)
        ) {
          return { outcome: "intent-conflict" };
        }
        const existingOffer = await selectStoredOffer(
          client,
          input.scope,
          input.gatewayId,
          input.offer,
        );
        if (
          existingOffer !== undefined &&
          !sameOffer(existingOffer, input.offer)
        ) {
          return { outcome: "intent-conflict" };
        }

        const intent = existingIntent ?? makeStoredIntent(input);
        const eventId =
          existingOffer?.eventId ?? offerEventId(input.scope, input.offer);
        const offer = existingOffer ?? makeOfferRecord(input, eventId);
        if (existingIntent === undefined) {
          await client.query(insertIntentSql, [
            ...intentValues(input.scope, input.gatewayId, input.offer.job_id),
            input.offer.intent_digest,
            JSON.stringify(input.offer.intent),
            input.offer.expires_at_ms,
            input.createdAt,
          ]);
          await this.afterStep("intent-written");
        }
        await client.query(insertRequestSql, [
          ...scopeValues(input.scope),
          input.gatewayId,
          input.requestId,
          "create",
          fingerprint,
          input.offer.job_id,
          eventId,
          input.createdAt,
        ]);
        await this.afterStep("request-written");

        const audits: AuditWrite[] = [];
        if (existingIntent === undefined) {
          audits.push(
            auditWrite(
              input,
              "intent-created",
              stableId("audit:integration-control:intent", [
                ...offerIdentity(input.scope, input.offer),
                input.requestId,
              ]),
            ),
          );
        }
        if (existingOffer === undefined) {
          audits.push(
            auditWrite(
              input,
              "offer-staged",
              stableId("audit:integration-control:offer", [
                ...offerIdentity(input.scope, input.offer),
                input.requestId,
              ]),
            ),
          );
        }
        await insertAuditEvents(client, audits);
        if (audits.length > 0) await this.afterStep("audit-written");

        if (existingOffer === undefined) {
          await client.query(insertOfferSql, [
            eventId,
            ...scopeValues(input.scope),
            input.gatewayId,
            input.offer.job_id,
            input.offer.session_id,
            input.offer.session_epoch,
            input.offer.intent_digest,
            JSON.stringify(input.offer),
            input.createdAt,
          ]);
          await this.afterStep("offer-written");
        }
        return {
          outcome:
            existingIntent === undefined || existingOffer === undefined
              ? "persisted"
              : "replayed",
          intent,
          offer,
        };
      },
    );
  }

  persistReoffer(
    input: IntegrationReofferPersistenceInput,
  ): Promise<IntegrationReofferPersistenceResult> {
    return this.transaction<IntegrationReofferPersistenceResult>(
      input.scope.tenantId,
      { outcome: "storage-unavailable" },
      async (client) => {
        if (input.gatewayId !== input.offer.gateway_id) {
          return { outcome: "intent-conflict" };
        }
        await lockAggregate(
          client,
          input.scope,
          input.gatewayId,
          `job:${input.offer.job_id}`,
        );
        const stored = await selectIntentIdentity(
          client,
          input.scope,
          input.gatewayId,
          input.offer.job_id,
        );
        if (stored === undefined) return { outcome: "not-found" };
        if (!sameIntent(stored, input.offer)) {
          return { outcome: "intent-conflict" };
        }

        const fingerprint = requestFingerprint(input.gatewayId, input.offer);
        const priorRequest = await oneOrUndefined(client, selectRequestSql, [
          ...scopeValues(input.scope),
          input.gatewayId,
          input.requestId,
        ]);
        if (priorRequest !== undefined) {
          if (priorRequest.request_fingerprint !== fingerprint) {
            return { outcome: "intent-conflict" };
          }
          const row = await oneOrUndefined(client, selectOfferByEventSql, [
            ...scopeValues(input.scope),
            input.gatewayId,
            String(priorRequest.offer_event_id),
          ]);
          if (row === undefined) {
            throw new Error("Reoffer replay is missing its outbox record");
          }
          const replayed = decodeOfferRow(row);
          return sameOffer(replayed, input.offer)
            ? { outcome: "replayed", offer: replayed }
            : { outcome: "intent-conflict" };
        }

        const existing = await selectStoredOffer(
          client,
          input.scope,
          input.gatewayId,
          input.offer,
        );
        if (existing !== undefined && !sameOffer(existing, input.offer)) {
          return { outcome: "intent-conflict" };
        }
        const eventId =
          existing?.eventId ?? offerEventId(input.scope, input.offer);
        const offer = existing ?? makeOfferRecord(input, eventId);
        await client.query(insertRequestSql, [
          ...scopeValues(input.scope),
          input.gatewayId,
          input.requestId,
          "reoffer",
          fingerprint,
          input.offer.job_id,
          eventId,
          input.createdAt,
        ]);
        await this.afterStep("request-written");
        if (existing === undefined) {
          await insertAuditEvents(client, [
            auditWrite(
              input,
              "offer-staged",
              stableId("audit:integration-control:offer", [
                ...offerIdentity(input.scope, input.offer),
                input.requestId,
              ]),
            ),
          ]);
          await this.afterStep("audit-written");
          await client.query(insertOfferSql, [
            eventId,
            ...scopeValues(input.scope),
            input.gatewayId,
            input.offer.job_id,
            input.offer.session_id,
            input.offer.session_epoch,
            input.offer.intent_digest,
            JSON.stringify(input.offer),
            input.createdAt,
          ]);
          await this.afterStep("offer-written");
        }
        return {
          outcome: existing === undefined ? "persisted" : "replayed",
          offer,
        };
      },
    );
  }

  persistReceipt(
    input: IntegrationReceiptPersistenceInput,
  ): Promise<IntegrationReceiptPersistenceResult> {
    return this.transaction<IntegrationReceiptPersistenceResult>(
      input.scope.tenantId,
      { outcome: "storage-unavailable" },
      async (client) => {
        await lockAggregate(
          client,
          input.scope,
          input.gatewayId,
          "integration-control-receipt-stream",
        );
        const intent = await selectStoredIntent(
          client,
          input.scope,
          input.gatewayId,
          input.receipt.jobId,
          true,
        );
        if (intent === undefined) return { outcome: "not-found" };
        if (
          intent.intentDigest !== input.receipt.intentDigest ||
          intent.intent.target.integration_id !==
            input.receipt.target.integrationId ||
          intent.intent.target.snapshot_generation !==
            input.receipt.target.snapshotGeneration ||
          intent.intent.target.entity_id !== input.receipt.target.entityId ||
          intent.intent.target.point_key !== input.receipt.target.pointKey
        ) {
          return { outcome: "intent-conflict" };
        }

        const scopeAndGateway = [
          ...scopeValues(input.scope),
          input.gatewayId,
        ] as const;
        const bindingRow = await oneOrUndefined(
          client,
          selectStreamBindingForUpdateSql,
          scopeAndGateway,
        );
        if (
          bindingRow !== undefined &&
          bindingRow.stream_id !== input.delivery.streamId
        ) {
          return { outcome: "stream-binding-conflict" };
        }
        const streamRow = await oneOrUndefined(
          client,
          selectStreamForUpdateSql,
          [
            ...scopeAndGateway,
            input.delivery.streamId,
            input.delivery.streamEpoch,
          ],
        );
        const cursor =
          streamRow === undefined
            ? 0n
            : BigInt(String(streamRow.contiguous_position));
        const deliveryRow = await oneOrUndefined(client, selectDeliverySql, [
          ...scopeAndGateway,
          input.delivery.streamId,
          input.delivery.streamEpoch,
          input.delivery.position,
        ]);
        const durableAcknowledgement = acknowledgement(input);
        if (deliveryRow !== undefined) {
          const stored = decodeStoredDeliveryRow(deliveryRow, {
            tenantId: input.scope.tenantId,
            projectId: input.scope.projectId,
            gatewayId: input.gatewayId,
          });
          if (
            stored.batchId !== input.delivery.batchId ||
            stored.digest !== input.delivery.digest ||
            !sameJson(stored.evidence.receipt, input.receipt)
          ) {
            return { outcome: "delivery-conflict" };
          }
          if (BigInt(stored.position) > cursor) {
            throw new Error("Committed delivery exceeds its durable cursor");
          }
          await insertAck(client, input, durableAcknowledgement);
          await this.afterStep("ack-written");
          return {
            outcome: "replayed",
            evidence: stored.evidence,
            durableAcknowledgement,
          };
        }

        const receiptById = await oneOrUndefined(client, selectReceiptByIdSql, [
          ...scopeAndGateway,
          input.receipt.jobId,
          input.receipt.receiptId,
        ]);
        const receiptBySequence = await oneOrUndefined(
          client,
          selectReceiptBySequenceSql,
          [
            ...scopeAndGateway,
            input.receipt.jobId,
            input.receipt.receiptSequence,
          ],
        );
        if (receiptById !== undefined || receiptBySequence !== undefined) {
          if (receiptById !== undefined) decodeReceiptEvidenceRow(receiptById);
          if (receiptBySequence !== undefined) {
            decodeReceiptEvidenceRow(receiptBySequence);
          }
          return { outcome: "receipt-conflict" };
        }

        const expectedPosition = cursor + 1n;
        const receivedPosition = BigInt(input.delivery.position);
        if (receivedPosition !== expectedPosition) {
          return {
            outcome:
              receivedPosition > expectedPosition
                ? "delivery-gap"
                : "delivery-conflict",
          };
        }
        if (bindingRow === undefined) {
          await client.query(insertStreamBindingSql, [
            ...scopeAndGateway,
            input.delivery.streamId,
            input.receivedAt,
          ]);
          await this.afterStep("stream-binding-written");
        }
        if (streamRow === undefined) {
          await client.query(insertStreamSql, [
            ...scopeAndGateway,
            input.delivery.streamId,
            input.delivery.streamEpoch,
            input.receivedAt,
          ]);
          await this.afterStep("stream-written");
        }

        const auditEventId = stableId("audit:integration-control:receipt", [
          input.scope.tenantId,
          input.scope.projectId,
          input.gatewayId,
          input.receipt.jobId,
          input.receipt.receiptId,
          input.receipt.receiptSequence,
        ]);
        const providerAccepted = input.receipt.stage === "provider-accepted";
        const evidence = Object.freeze({
          ...input.scope,
          gatewayId: input.gatewayId,
          jobId: input.receipt.jobId,
          receipt: input.receipt,
          providerAccepted,
          physicalCompleted: false as const,
          jobSucceeded: false as const,
          auditEventId,
          receivedAt: input.receivedAt,
        });
        await client.query(insertReceiptSql, [
          ...scopeAndGateway,
          input.receipt.jobId,
          input.receipt.receiptId,
          input.receipt.receiptSequence,
          JSON.stringify(input.receipt),
          input.receipt.stage,
          providerAccepted,
          false,
          false,
          auditEventId,
          input.receivedAt,
        ]);
        await this.afterStep("receipt-written");
        await client.query(insertDeliverySql, [
          ...scopeAndGateway,
          input.delivery.streamId,
          input.delivery.streamEpoch,
          input.delivery.position,
          input.delivery.batchId,
          input.delivery.digest,
          input.requestId,
          input.receipt.jobId,
          input.receipt.receiptId,
          input.receipt.receiptSequence,
          input.receivedAt,
        ]);
        await this.afterStep("delivery-written");

        const revision = intent.revision + 1;
        if (!Number.isSafeInteger(revision)) {
          throw new Error("Integration Control intent revision overflow");
        }
        const updatedIntent = await client.query(updateIntentReceiptSql, [
          ...intentValues(input.scope, input.gatewayId, input.receipt.jobId),
          JSON.stringify(input.receipt),
          input.receipt.receiptId,
          revision,
          intent.revision,
        ]);
        if (updatedIntent.rowCount !== 1) {
          throw new Error(
            "Integration Control intent lost its locked revision",
          );
        }
        await this.afterStep("intent-updated");

        const updatedCursor = await client.query(updateStreamCursorSql, [
          ...scopeAndGateway,
          input.delivery.streamId,
          input.delivery.streamEpoch,
          input.delivery.position,
          cursor.toString(),
        ]);
        if (updatedCursor.rowCount !== 1) {
          throw new Error("Integration Control stream lost its locked cursor");
        }
        await this.afterStep("cursor-written");

        await insertAuditEvents(client, [
          {
            eventId: auditEventId,
            scope: input.scope,
            occurredAt: input.receivedAt,
            subjectKind: "gateway",
            subjectId: input.gatewayId,
            action: "integration-control.receipt-persisted",
            jobId: input.receipt.jobId,
            outcome: "accepted",
            correlationId: input.requestId,
            detailsDigest: bareDigest(input.receipt),
          },
        ]);
        await this.afterStep("audit-written");
        await insertAck(client, input, durableAcknowledgement);
        await this.afterStep("ack-written");
        return {
          outcome: "persisted",
          evidence,
          durableAcknowledgement,
        };
      },
    );
  }

  findIntent(
    scope: IntegrationControlScope,
    gatewayId: GatewayId,
    jobId: GovernedJobId,
  ): Promise<IntegrationStoredIntent | undefined> {
    return this.transaction(scope.tenantId, undefined, (client) =>
      selectStoredIntent(client, scope, gatewayId, jobId, false),
    );
  }

  listUnresolvedIntents(
    scope: IntegrationControlScope,
    gatewayId: GatewayId,
  ): Promise<readonly IntegrationStoredIntent[]> {
    return this.transaction(scope.tenantId, [], async (client) => {
      const rows = await client.query(listUnresolvedIntentsSql, [
        ...scopeValues(scope),
        gatewayId,
      ]);
      return Object.freeze(rows.rows.map(decodeStoredIntentRow));
    });
  }

  listDispatchableOffers(
    scope: IntegrationControlScope,
    gatewayId: GatewayId,
  ): Promise<readonly IntegrationOfferOutboxRecord[]> {
    return this.transaction(scope.tenantId, [], async (client) => {
      const rows = await client.query(listDispatchableOffersSql, [
        ...scopeValues(scope),
        gatewayId,
      ]);
      return Object.freeze(rows.rows.map(decodeOfferRow));
    });
  }

  markOfferPublished(
    scope: IntegrationControlScope,
    eventId: string,
    publishedAt: UtcInstant,
  ): Promise<IntegrationOfferPublishedResult> {
    return this.transaction<IntegrationOfferPublishedResult>(
      scope.tenantId,
      { outcome: "storage-unavailable" },
      async (client) => {
        const row = await oneOrUndefined(
          client,
          selectOfferPublishForUpdateSql,
          [...scopeValues(scope), eventId],
        );
        if (row === undefined) return { outcome: "not-found" };
        const offer = decodeOfferRow(row);
        if (offer.status === "published") return { outcome: "replayed" };
        const updated = await client.query(updateOfferPublishedSql, [
          ...scopeValues(scope),
          eventId,
          publishedAt,
        ]);
        if (updated.rowCount !== 1) {
          throw new Error("Integration Control offer publication raced");
        }
        await this.afterStep("offer-published");
        await insertAuditEvents(client, [
          {
            eventId: stableId("audit:integration-control:published", [
              scope.tenantId,
              scope.projectId,
              eventId,
            ]),
            scope,
            occurredAt: publishedAt,
            subjectKind: "system",
            subjectId: "system:integration-control-publisher",
            action: "integration-control.offer-published",
            jobId: offer.jobId,
            outcome: "succeeded",
            correlationId: eventId,
            detailsDigest: bareDigest(offer.offer),
          },
        ]);
        await this.afterStep("audit-written");
        return { outcome: "published" };
      },
    );
  }

  private afterStep(
    step: PostgresIntegrationControlPersistenceStep,
  ): Promise<void> {
    return Promise.resolve(this.#faultInjector?.afterStep?.(step));
  }

  private async transaction<Result>(
    tenantId: TenantId,
    unavailable: Result,
    operation: (client: PostgresIntegrationControlClient) => Promise<Result>,
  ): Promise<Result> {
    let client: PostgresIntegrationControlClient | undefined;
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
          // The typed storage outcome remains authoritative.
        }
      }
      return unavailable;
    } finally {
      client?.release();
    }
  }
}
