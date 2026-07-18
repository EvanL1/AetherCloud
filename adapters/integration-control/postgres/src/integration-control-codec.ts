import { createHash } from "node:crypto";

import type {
  IntegrationControlActionIntent,
  IntegrationControlActionOffer,
  IntegrationControlReceiptEvidence,
  IntegrationOfferOutboxRecord,
  IntegrationStoredIntent,
} from "@aether-cloud/application";
import {
  defineIntegrationControlReceipt,
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseGovernedJobId,
  parseIntegrationControlDigest,
  parseIntegrationEntityId,
  parseIntegrationId,
  parseIntegrationSnapshotGeneration,
  parseProjectId,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
  parseTenantId,
  parseUtcInstant,
  type IntegrationControlReceipt,
  type StreamEpoch,
  type StreamId,
  type StreamPosition,
} from "@aether-cloud/domain";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;
const uint64Pattern = /^(?:0|[1-9][0-9]*)$/;
const maximumUint64 = 18_446_744_073_709_551_615n;

export interface StoredReceiptDelivery {
  readonly streamId: StreamId;
  readonly streamEpoch: StreamEpoch;
  readonly position: StreamPosition;
  readonly batchId: string;
  readonly digest: ReturnType<typeof parseIntegrationControlDigest>;
  readonly evidence: IntegrationControlReceiptEvidence;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function record(input: unknown, field: string): Record<string, unknown> {
  if (!isRecord(input)) throw new Error(`${field} must be an object`);
  return input;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${field} contains unknown or missing fields`);
  }
}

function string(input: unknown, field: string, maximumLength = 128): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maximumLength
  ) {
    throw new Error(`${field} must be bounded non-empty text`);
  }
  return input;
}

function literal<Value extends string | boolean>(
  input: unknown,
  expected: Value,
  field: string,
): Value {
  if (input !== expected) throw new Error(`${field} is unsupported`);
  return expected;
}

function identifier(input: unknown, field: string): string {
  const value = string(input, field);
  if (!identifierPattern.test(value)) {
    throw new Error(`${field} must be a bounded identifier`);
  }
  return value;
}

function uuid(input: unknown, field: string): string {
  if (typeof input !== "string" || !uuidPattern.test(input)) {
    throw new Error(`${field} must be a canonical lowercase UUID`);
  }
  return input;
}

function uint64(input: unknown, field: string, positive = false): string {
  if (
    typeof input !== "string" ||
    !uint64Pattern.test(input) ||
    BigInt(input) > maximumUint64 ||
    (positive && input === "0")
  ) {
    throw new Error(`${field} must be a canonical uint64`);
  }
  return input;
}

function boolean(input: unknown, field: string): boolean {
  if (typeof input !== "boolean") throw new Error(`${field} must be Boolean`);
  return input;
}

function rowValue(row: Record<string, unknown>, key: string): unknown {
  if (!(key in row)) throw new Error(`PostgreSQL row is missing ${key}`);
  return row[key];
}

function optionalRowValue(row: Record<string, unknown>, key: string): unknown {
  const value = rowValue(row, key);
  return value === null ? undefined : value;
}

function safePositiveInteger(input: unknown, field: string): number {
  const value = uint64(input, field, true);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${field} exceeds the JavaScript safe integer range`);
  }
  return parsed;
}

export function canonicalJson(input: unknown): string {
  if (input === undefined) {
    throw new Error("Cannot encode undefined as canonical JSON");
  }
  if (input === null || typeof input !== "object") {
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    return `[${input.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const value = input as Record<string, unknown>;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function integrationControlFingerprint(input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(input), "utf8")
    .digest("hex");
}

export function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function decodeIntentPayload(
  input: unknown,
): IntegrationControlActionIntent {
  const value = record(input, "intent");
  exactKeys(
    value,
    [
      "schema",
      "capability_id",
      "target",
      "arguments",
      "governance",
      "authorization",
      "confirmation",
    ],
    [],
    "intent",
  );
  const target = record(value.target, "intent.target");
  exactKeys(
    target,
    ["integration_id", "snapshot_generation", "entity_id", "point_key"],
    [],
    "intent.target",
  );
  const argumentsValue = record(value.arguments, "intent.arguments");
  exactKeys(argumentsValue, ["value"], [], "intent.arguments");
  const governance = record(value.governance, "intent.governance");
  exactKeys(
    governance,
    [
      "execution",
      "default_authorization",
      "permission",
      "risk",
      "confirmation",
      "idempotency",
      "expiry",
      "audit",
      "edge_final_decision",
    ],
    [],
    "intent.governance",
  );
  const authorization = record(value.authorization, "intent.authorization");
  exactKeys(
    authorization,
    ["policy_decision_id", "subject_id", "permission", "authorized_at_ms"],
    [],
    "intent.authorization",
  );
  const confirmation = record(value.confirmation, "intent.confirmation");
  exactKeys(
    confirmation,
    ["confirmation_id", "subject_id", "confirmed_at_ms"],
    [],
    "intent.confirmation",
  );

  return Object.freeze({
    schema: literal(
      value.schema,
      "aether.integration-control.action-intent.v1alpha1",
      "intent.schema",
    ),
    capability_id: literal(
      value.capability_id,
      "device.power.set.v1",
      "intent.capability_id",
    ),
    target: Object.freeze({
      integration_id: parseIntegrationId(target.integration_id),
      snapshot_generation: parseIntegrationSnapshotGeneration(
        target.snapshot_generation,
      ),
      entity_id: parseIntegrationEntityId(target.entity_id),
      point_key: literal(target.point_key, "is_on", "intent.target.point_key"),
    }),
    arguments: Object.freeze({
      value: boolean(argumentsValue.value, "intent.arguments.value"),
    }),
    governance: Object.freeze({
      execution: literal(
        governance.execution,
        "governed-job",
        "intent.governance.execution",
      ),
      default_authorization: literal(
        governance.default_authorization,
        "deny",
        "intent.governance.default_authorization",
      ),
      permission: literal(
        governance.permission,
        "integration.device.control",
        "intent.governance.permission",
      ),
      risk: literal(governance.risk, "high", "intent.governance.risk"),
      confirmation: literal(
        governance.confirmation,
        "required",
        "intent.governance.confirmation",
      ),
      idempotency: literal(
        governance.idempotency,
        "required",
        "intent.governance.idempotency",
      ),
      expiry: literal(
        governance.expiry,
        "required",
        "intent.governance.expiry",
      ),
      audit: literal(governance.audit, "required", "intent.governance.audit"),
      edge_final_decision: literal(
        governance.edge_final_decision,
        true,
        "intent.governance.edge_final_decision",
      ),
    }),
    authorization: Object.freeze({
      policy_decision_id: identifier(
        authorization.policy_decision_id,
        "intent.authorization.policy_decision_id",
      ),
      subject_id: identifier(
        authorization.subject_id,
        "intent.authorization.subject_id",
      ),
      permission: literal(
        authorization.permission,
        "integration.device.control",
        "intent.authorization.permission",
      ),
      authorized_at_ms: uint64(
        authorization.authorized_at_ms,
        "intent.authorization.authorized_at_ms",
      ),
    }),
    confirmation: Object.freeze({
      confirmation_id: uuid(
        confirmation.confirmation_id,
        "intent.confirmation.confirmation_id",
      ),
      subject_id: identifier(
        confirmation.subject_id,
        "intent.confirmation.subject_id",
      ),
      confirmed_at_ms: uint64(
        confirmation.confirmed_at_ms,
        "intent.confirmation.confirmed_at_ms",
      ),
    }),
  });
}

export function decodeOfferPayload(
  input: unknown,
): IntegrationControlActionOffer {
  const value = record(input, "offer");
  exactKeys(
    value,
    [
      "schema",
      "protocol",
      "protocol_version",
      "extension",
      "message_kind",
      "gateway_id",
      "session_id",
      "session_epoch",
      "credential_generation",
      "job_id",
      "issued_at_ms",
      "expires_at_ms",
      "intent_digest",
      "intent",
      "cloud_authentication",
    ],
    [],
    "offer",
  );
  const authentication = record(
    value.cloud_authentication,
    "offer.cloud_authentication",
  );
  exactKeys(
    authentication,
    ["key_id", "algorithm", "signature"],
    [],
    "offer.cloud_authentication",
  );
  const signature = string(
    authentication.signature,
    "offer.cloud_authentication.signature",
    86,
  );
  if (!signaturePattern.test(signature)) {
    throw new Error("offer.cloud_authentication.signature is invalid");
  }

  return Object.freeze({
    schema: literal(
      value.schema,
      "aether.cloudlink.integration-action-offer.v1alpha1",
      "offer.schema",
    ),
    protocol: literal(value.protocol, "aether.cloudlink", "offer.protocol"),
    protocol_version: literal(
      value.protocol_version,
      "1.0",
      "offer.protocol_version",
    ),
    extension: literal(
      value.extension,
      "aether.cloudlink.integration-control.v1alpha1",
      "offer.extension",
    ),
    message_kind: literal(
      value.message_kind,
      "integration-action-offer",
      "offer.message_kind",
    ),
    gateway_id: parseGatewayId(value.gateway_id),
    session_id: parseCloudLinkSessionId(value.session_id),
    session_epoch: parseCloudLinkSessionEpoch(value.session_epoch),
    credential_generation: parseGatewayCredentialGeneration(
      value.credential_generation,
    ),
    job_id: parseGovernedJobId(value.job_id),
    issued_at_ms: uint64(value.issued_at_ms, "offer.issued_at_ms"),
    expires_at_ms: uint64(value.expires_at_ms, "offer.expires_at_ms", true),
    intent_digest: parseIntegrationControlDigest(value.intent_digest),
    intent: decodeIntentPayload(value.intent),
    cloud_authentication: Object.freeze({
      key_id: identifier(
        authentication.key_id,
        "offer.cloud_authentication.key_id",
      ),
      algorithm: literal(
        authentication.algorithm,
        "Ed25519",
        "offer.cloud_authentication.algorithm",
      ),
      signature,
    }),
  });
}

export function decodeReceiptPayload(
  input: unknown,
): IntegrationControlReceipt {
  const value = record(input, "receipt");
  exactKeys(
    value,
    [
      "jobId",
      "receiptId",
      "receiptSequence",
      "capabilityId",
      "target",
      "intentDigest",
      "stage",
      "decision",
      "physicalOutcome",
      "observedAtMs",
      "audit",
    ],
    ["evidenceDigest", "failureCode"],
    "receipt",
  );
  const target = record(value.target, "receipt.target");
  exactKeys(
    target,
    ["integrationId", "snapshotGeneration", "entityId", "pointKey"],
    [],
    "receipt.target",
  );
  const audit = record(value.audit, "receipt.audit");
  exactKeys(audit, ["auditRecordId", "status"], [], "receipt.audit");

  return defineIntegrationControlReceipt({
    jobId: value.jobId,
    receiptId: value.receiptId,
    receiptSequence: value.receiptSequence,
    capabilityId: value.capabilityId,
    target: {
      integrationId: target.integrationId,
      snapshotGeneration: target.snapshotGeneration,
      entityId: target.entityId,
      pointKey: target.pointKey,
    },
    intentDigest: value.intentDigest,
    stage: value.stage,
    decision: value.decision,
    physicalOutcome: value.physicalOutcome,
    observedAtMs: value.observedAtMs,
    ...("evidenceDigest" in value
      ? { evidenceDigest: value.evidenceDigest }
      : {}),
    ...("failureCode" in value ? { failureCode: value.failureCode } : {}),
    audit: {
      auditRecordId: audit.auditRecordId,
      status: audit.status,
    },
  });
}

export function decodeStoredIntentRow(
  row: Record<string, unknown>,
): IntegrationStoredIntent {
  const intent = decodeIntentPayload(rowValue(row, "intent_payload"));
  const latestReceiptPayload = optionalRowValue(row, "latest_receipt_payload");
  const jobId = parseGovernedJobId(rowValue(row, "job_id"));
  const intentDigest = parseIntegrationControlDigest(
    rowValue(row, "intent_digest"),
  );
  const latestReceipt =
    latestReceiptPayload === undefined
      ? undefined
      : decodeReceiptPayload(latestReceiptPayload);
  if (
    latestReceipt !== undefined &&
    (latestReceipt.jobId !== jobId ||
      latestReceipt.intentDigest !== intentDigest ||
      latestReceipt.target.integrationId !== intent.target.integration_id ||
      latestReceipt.target.snapshotGeneration !==
        intent.target.snapshot_generation ||
      latestReceipt.target.entityId !== intent.target.entity_id)
  ) {
    throw new Error("PostgreSQL latest receipt is bound to another intent");
  }
  return Object.freeze({
    tenantId: parseTenantId(rowValue(row, "tenant_id")),
    projectId: parseProjectId(rowValue(row, "project_id")),
    gatewayId: parseGatewayId(rowValue(row, "gateway_id")),
    jobId,
    intentDigest,
    intent,
    expiresAtMs: uint64(rowValue(row, "expires_at_ms"), "expires_at_ms", true),
    createdAt: parseUtcInstant(rowValue(row, "created_at")),
    latestReceipt,
    revision: safePositiveInteger(rowValue(row, "revision"), "revision"),
  });
}

export function decodeOfferRow(
  row: Record<string, unknown>,
): IntegrationOfferOutboxRecord {
  const publishedAt = optionalRowValue(row, "published_at");
  const gatewayId = parseGatewayId(rowValue(row, "gateway_id"));
  const jobId = parseGovernedJobId(rowValue(row, "job_id"));
  const sessionId = parseCloudLinkSessionId(rowValue(row, "session_id"));
  const sessionEpoch = parseCloudLinkSessionEpoch(
    rowValue(row, "session_epoch"),
  );
  const intentDigest = parseIntegrationControlDigest(
    rowValue(row, "intent_digest"),
  );
  const offer = decodeOfferPayload(rowValue(row, "offer_payload"));
  if (
    offer.gateway_id !== gatewayId ||
    offer.job_id !== jobId ||
    offer.session_id !== sessionId ||
    offer.session_epoch !== sessionEpoch ||
    offer.intent_digest !== intentDigest
  ) {
    throw new Error("PostgreSQL offer payload does not match its row identity");
  }
  return Object.freeze({
    eventId: string(rowValue(row, "event_id"), "event_id"),
    tenantId: parseTenantId(rowValue(row, "tenant_id")),
    projectId: parseProjectId(rowValue(row, "project_id")),
    gatewayId,
    jobId,
    sessionId,
    sessionEpoch,
    intentDigest,
    offer,
    status: publishedAt === undefined ? "pending" : "published",
    createdAt: parseUtcInstant(rowValue(row, "created_at")),
    ...(publishedAt === undefined
      ? {}
      : { publishedAt: parseUtcInstant(publishedAt) }),
  });
}

export function decodeReceiptEvidenceRow(
  row: Record<string, unknown>,
): IntegrationControlReceiptEvidence {
  const providerAccepted = boolean(
    rowValue(row, "provider_accepted"),
    "provider_accepted",
  );
  if (
    rowValue(row, "physical_completed") !== false ||
    rowValue(row, "job_succeeded") !== false
  ) {
    throw new Error("PostgreSQL receipt row claims a physical outcome");
  }
  const receipt = decodeReceiptPayload(rowValue(row, "receipt_payload"));
  const jobId = parseGovernedJobId(rowValue(row, "job_id"));
  if (receipt.jobId !== jobId) {
    throw new Error("PostgreSQL receipt payload does not match its Job");
  }
  if (providerAccepted !== (receipt.stage === "provider-accepted")) {
    throw new Error("PostgreSQL receipt provider acceptance is inconsistent");
  }
  return Object.freeze({
    tenantId: parseTenantId(rowValue(row, "tenant_id")),
    projectId: parseProjectId(rowValue(row, "project_id")),
    gatewayId: parseGatewayId(rowValue(row, "gateway_id")),
    jobId,
    receipt,
    providerAccepted,
    physicalCompleted: false,
    jobSucceeded: false,
    auditEventId: string(rowValue(row, "audit_event_id"), "audit_event_id"),
    receivedAt: parseUtcInstant(rowValue(row, "received_at")),
  });
}

export function decodeStoredDeliveryRow(
  row: Record<string, unknown>,
  scope: {
    readonly tenantId: unknown;
    readonly projectId: unknown;
    readonly gatewayId: unknown;
  },
): StoredReceiptDelivery {
  const evidence = decodeReceiptEvidenceRow({
    ...row,
    tenant_id: scope.tenantId,
    project_id: scope.projectId,
    gateway_id: scope.gatewayId,
  });
  return Object.freeze({
    streamId: parseStreamId(rowValue(row, "stream_id")),
    streamEpoch: parseStreamEpoch(rowValue(row, "stream_epoch")),
    position: parseStreamPosition(rowValue(row, "position")),
    batchId: string(rowValue(row, "batch_id"), "batch_id"),
    digest: parseIntegrationControlDigest(rowValue(row, "business_digest")),
    evidence,
  });
}
