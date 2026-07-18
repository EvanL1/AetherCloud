import { createHash } from "node:crypto";

import type {
  IntegrationControlActionOffer,
  IntegrationControlScope,
  IntegrationIntentAndOfferPersistenceInput,
  IntegrationReceiptPersistenceInput,
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
} from "@aether-cloud/domain";

export const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
export const otherTenantId = parseTenantId(
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
);
export const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
export const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
export const jobId = parseGovernedJobId("55555555-5555-4555-8555-555555555555");
export const sessionId = parseCloudLinkSessionId(
  "44444444-4444-4444-8444-444444444444",
);
export const intentDigest = parseIntegrationControlDigest(
  "sha256:40108827ca617c95f9d9c48c357fdd94b2b5f019d8ccf8a23842642e934c7327",
);
export const now = parseUtcInstant("2026-07-17T08:00:00.000Z");
export const scope: IntegrationControlScope = { tenantId, projectId };

export function offer(
  overrides: Partial<IntegrationControlActionOffer> = {},
): IntegrationControlActionOffer {
  return {
    schema: "aether.cloudlink.integration-action-offer.v1alpha1",
    protocol: "aether.cloudlink",
    protocol_version: "1.0",
    extension: "aether.cloudlink.integration-control.v1alpha1",
    message_kind: "integration-action-offer",
    gateway_id: gatewayId,
    session_id: sessionId,
    session_epoch: parseCloudLinkSessionEpoch("7"),
    credential_generation: parseGatewayCredentialGeneration("3"),
    job_id: jobId,
    issued_at_ms: "1784275200000",
    expires_at_ms: "1784275320000",
    intent_digest: intentDigest,
    intent: {
      schema: "aether.integration-control.action-intent.v1alpha1",
      capability_id: "device.power.set.v1",
      target: {
        integration_id: parseIntegrationId("home-assistant.home"),
        snapshot_generation: parseIntegrationSnapshotGeneration("9"),
        entity_id: parseIntegrationEntityId("entity-registry-light-bedroom"),
        point_key: "is_on",
      },
      arguments: { value: true },
      governance: {
        execution: "governed-job",
        default_authorization: "deny",
        permission: "integration.device.control",
        risk: "high",
        confirmation: "required",
        idempotency: "required",
        expiry: "required",
        audit: "required",
        edge_final_decision: true,
      },
      authorization: {
        policy_decision_id: "policy-decision-1",
        subject_id: "user-homeowner",
        permission: "integration.device.control",
        authorized_at_ms: "1784275199000",
      },
      confirmation: {
        confirmation_id: "66666666-6666-4666-8666-666666666666",
        subject_id: "user-homeowner",
        confirmed_at_ms: "1784275199500",
      },
    },
    cloud_authentication: {
      key_id: "development-cloud-key-1",
      algorithm: "Ed25519",
      signature: "D".repeat(86),
    },
    ...overrides,
  };
}

export function createInput(
  value: IntegrationControlActionOffer = offer(),
  requestId = "integration-control-create-001",
): IntegrationIntentAndOfferPersistenceInput {
  return {
    scope,
    gatewayId,
    requestId,
    subjectId: "user-homeowner",
    offer: value,
    createdAt: now,
  };
}

export function receiptInput(
  position = "1",
  overrides: Partial<IntegrationReceiptPersistenceInput> = {},
): IntegrationReceiptPersistenceInput {
  return {
    scope,
    gatewayId,
    requestId: `integration-control-receipt-${position.padStart(3, "0")}`,
    credentialGeneration: parseGatewayCredentialGeneration("3"),
    sessionId,
    sessionEpoch: parseCloudLinkSessionEpoch("7"),
    delivery: {
      messageKind: "integration-action-receipt",
      sentAtMs: "1784275200500",
      expiresAtMs: null,
      streamId: parseStreamId("integration-control-receipts"),
      streamEpoch: parseStreamEpoch("1"),
      position: parseStreamPosition(position),
      batchId: `job-55555555-receipt-${position}`,
      digest: parseIntegrationControlDigest(
        position === "1"
          ? "sha256:f42bb6dfcd28ca27a7c1079569ffcd0f6144f741461cd362c3c679f471af80a7"
          : `sha256:${position.padStart(64, "0")}`,
      ),
    },
    receipt: defineIntegrationControlReceipt({
      jobId,
      receiptId:
        position === "1"
          ? "77777777-7777-4777-8777-777777777777"
          : "99999999-9999-4999-8999-999999999999",
      receiptSequence: position,
      capabilityId: "device.power.set.v1",
      target: {
        integrationId: "home-assistant.home",
        snapshotGeneration: "9",
        entityId: "entity-registry-light-bedroom",
        pointKey: "is_on",
      },
      intentDigest,
      stage: position === "1" ? "edge-accepted" : "provider-accepted",
      decision: "accepted",
      physicalOutcome: "unknown",
      observedAtMs: position === "1" ? "1784275200100" : "1784275200200",
      ...(position === "1"
        ? {}
        : {
            evidenceDigest:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          }),
      audit: {
        auditRecordId: `audit-receipt-${position}`,
        status: "complete",
      },
    }),
    receivedAt: now,
    ...overrides,
  };
}

function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new Error("Cannot encode undefined as canonical JSON");
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function createRequestFingerprint(
  input: IntegrationIntentAndOfferPersistenceInput,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        gatewayId: input.gatewayId,
        jobId: input.offer.job_id,
        intentDigest: input.offer.intent_digest,
        intent: input.offer.intent,
      }),
      "utf8",
    )
    .digest("hex");
}

export function intentRow(
  value: IntegrationControlActionOffer = offer(),
  latestReceipt: unknown = null,
  revision = "1",
): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    project_id: projectId,
    gateway_id: gatewayId,
    job_id: value.job_id,
    intent_digest: value.intent_digest,
    intent_payload: value.intent,
    expires_at_ms: value.expires_at_ms,
    created_at: now,
    latest_receipt_payload: latestReceipt,
    revision,
  };
}

export function offerRow(
  value: IntegrationControlActionOffer = offer(),
  sequence = "1",
  publishedAt: string | null = null,
): Record<string, unknown> {
  return {
    sequence,
    event_id: `outbox:integration-control:offer:${"a".repeat(64)}`,
    tenant_id: tenantId,
    project_id: projectId,
    gateway_id: gatewayId,
    job_id: value.job_id,
    session_id: value.session_id,
    session_epoch: value.session_epoch,
    intent_digest: value.intent_digest,
    offer_payload: value,
    created_at: now,
    published_at: publishedAt,
  };
}

export function receiptEvidenceRow(
  input: IntegrationReceiptPersistenceInput = receiptInput(),
): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    project_id: projectId,
    gateway_id: gatewayId,
    job_id: input.receipt.jobId,
    receipt_id: input.receipt.receiptId,
    receipt_sequence: input.receipt.receiptSequence,
    receipt_payload: input.receipt,
    provider_accepted: input.receipt.stage === "provider-accepted",
    physical_completed: false,
    job_succeeded: false,
    audit_event_id: `audit:integration-control:receipt:${"b".repeat(64)}`,
    received_at: input.receivedAt,
  };
}

export function deliveryRow(
  input: IntegrationReceiptPersistenceInput = receiptInput(),
): Record<string, unknown> {
  return {
    stream_id: input.delivery.streamId,
    stream_epoch: input.delivery.streamEpoch,
    position: input.delivery.position,
    batch_id: input.delivery.batchId,
    business_digest: input.delivery.digest,
    job_id: input.receipt.jobId,
    receipt_id: input.receipt.receiptId,
    receipt_payload: input.receipt,
    provider_accepted: input.receipt.stage === "provider-accepted",
    physical_completed: false,
    job_succeeded: false,
    audit_event_id: `audit:integration-control:receipt:${"b".repeat(64)}`,
    received_at: input.receivedAt,
  };
}
