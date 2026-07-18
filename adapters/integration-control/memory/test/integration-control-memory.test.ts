import { describe, expect, it } from "vitest";

import type {
  IntegrationControlActionOffer,
  IntegrationControlScope,
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

import { InMemoryIntegrationControlRepository } from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const jobId = parseGovernedJobId("55555555-5555-4555-8555-555555555555");
const sessionId = parseCloudLinkSessionId(
  "44444444-4444-4444-8444-444444444444",
);
const intentDigest = parseIntegrationControlDigest(
  "sha256:40108827ca617c95f9d9c48c357fdd94b2b5f019d8ccf8a23842642e934c7327",
);
const now = parseUtcInstant("2026-07-17T08:00:00.000Z");
const scope: IntegrationControlScope = { tenantId, projectId };

function offer(
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

function createInput(
  value: IntegrationControlActionOffer = offer(),
  requestId = "integration-control-create-001",
) {
  return {
    scope,
    gatewayId,
    requestId,
    subjectId: "user-homeowner",
    offer: value,
    createdAt: now,
  };
}

function receiptInput(
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

describe("InMemoryIntegrationControlRepository", () => {
  it("atomically stores one immutable intent, audit event, and exact offer outbox", async () => {
    const repository = new InMemoryIntegrationControlRepository();

    const first = await repository.persistIntentAndOffer(createInput());
    const replay = await repository.persistIntentAndOffer(createInput());

    expect(first).toMatchObject({
      outcome: "persisted",
      intent: {
        jobId,
        intentDigest,
        latestReceipt: undefined,
        revision: 1,
      },
      offer: {
        sessionId,
        sessionEpoch: "7",
        status: "pending",
      },
    });
    expect(replay).toMatchObject({
      outcome: "replayed",
      offer: {
        eventId: (first as { offer: { eventId: string } }).offer.eventId,
      },
    });
    expect(repository.auditEvents()).toHaveLength(2);
    expect(repository.auditEvents().map((event) => event.action)).toEqual([
      "intent-created",
      "offer-staged",
    ]);
    expect(repository.outboxEvents()).toHaveLength(1);
    expect(Object.isFrozen(repository.outboxEvents()[0]?.offer)).toBe(true);
  });

  it("rejects same Job with another digest and does not mutate evidence", async () => {
    const repository = new InMemoryIntegrationControlRepository();
    await repository.persistIntentAndOffer(createInput());
    const conflict = offer({
      intent_digest: parseIntegrationControlDigest(
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ),
    });

    await expect(
      repository.persistIntentAndOffer(
        createInput(conflict, "integration-control-create-002"),
      ),
    ).resolves.toEqual({ outcome: "intent-conflict" });
    expect(repository.auditEvents()).toHaveLength(2);
    expect(repository.outboxEvents()).toHaveLength(1);
  });

  it("stages the same Job and digest for a new session without changing the intent", async () => {
    const repository = new InMemoryIntegrationControlRepository();
    const first = await repository.persistIntentAndOffer(createInput());
    if (first.outcome !== "persisted") throw new Error("intent must persist");
    const nextOffer = offer({
      session_id: parseCloudLinkSessionId(
        "88888888-8888-4888-8888-888888888888",
      ),
      session_epoch: parseCloudLinkSessionEpoch("8"),
      issued_at_ms: "1784275200100",
      cloud_authentication: {
        key_id: "development-cloud-key-1",
        algorithm: "Ed25519",
        signature: "E".repeat(86),
      },
    });

    const staged = await repository.persistReoffer({
      scope,
      gatewayId,
      requestId: "reoffer:job:session-8",
      subjectId: "system:cloudlink-reconnect",
      offer: nextOffer,
      createdAt: now,
    });
    const replay = await repository.persistReoffer({
      scope,
      gatewayId,
      requestId: "reoffer:job:session-8",
      subjectId: "system:cloudlink-reconnect",
      offer: nextOffer,
      createdAt: now,
    });

    expect(staged).toMatchObject({
      outcome: "persisted",
      offer: {
        jobId,
        intentDigest,
        sessionId: "88888888-8888-4888-8888-888888888888",
        sessionEpoch: "8",
      },
    });
    expect(replay).toMatchObject({
      outcome: "replayed",
      offer: {
        eventId: (staged as { offer: { eventId: string } }).offer.eventId,
      },
    });
    await expect(
      repository.findIntent(scope, gatewayId, jobId),
    ).resolves.toEqual(first.intent);
    expect(repository.outboxEvents()).toHaveLength(2);
  });

  it("does not return an already published offer as dispatchable", async () => {
    const repository = new InMemoryIntegrationControlRepository();
    const persisted = await repository.persistIntentAndOffer(createInput());
    expect(persisted.outcome).toBe("persisted");
    if (persisted.outcome !== "persisted") return;

    await expect(
      repository.markOfferPublished(
        scope,
        persisted.offer.eventId,
        parseUtcInstant("2026-07-17T08:00:01.000Z"),
      ),
    ).resolves.toEqual({ outcome: "published" });
    await expect(
      repository.listDispatchableOffers(scope, gatewayId),
    ).resolves.toEqual([]);
  });

  it("atomically records authenticated receipt evidence, audit, and a contiguous ACK", async () => {
    const repository = new InMemoryIntegrationControlRepository();
    await repository.persistIntentAndOffer(createInput());

    const result = await repository.persistReceipt(receiptInput());

    expect(result).toMatchObject({
      outcome: "persisted",
      evidence: {
        providerAccepted: false,
        physicalCompleted: false,
        jobSucceeded: false,
        receipt: { stage: "edge-accepted", physicalOutcome: "unknown" },
      },
      durableAcknowledgement: {
        acknowledgedPosition: "1",
        sessionId,
        sessionEpoch: "7",
      },
    });
    expect(repository.auditEvents().at(-1)).toMatchObject({
      action: "receipt-persisted",
      jobId,
    });
    expect(repository.acknowledgementOutbox()).toHaveLength(1);
    await expect(
      repository.findIntent(scope, gatewayId, jobId),
    ).resolves.toMatchObject({
      latestReceipt: { stage: "edge-accepted" },
      revision: 2,
    });
  });

  it("returns a current-session ACK for exact receipt replay without duplicating business evidence", async () => {
    const repository = new InMemoryIntegrationControlRepository();
    await repository.persistIntentAndOffer(createInput());
    const input = receiptInput();
    const first = await repository.persistReceipt(input);
    const replay = await repository.persistReceipt({
      ...input,
      requestId: "integration-control-receipt-replay",
      sessionId: parseCloudLinkSessionId(
        "88888888-8888-4888-8888-888888888888",
      ),
      sessionEpoch: parseCloudLinkSessionEpoch("8"),
    });

    expect(first).toMatchObject({ outcome: "persisted" });
    expect(replay).toMatchObject({
      outcome: "replayed",
      durableAcknowledgement: {
        sessionId: "88888888-8888-4888-8888-888888888888",
        sessionEpoch: "8",
        acknowledgedPosition: "1",
      },
    });
    expect(
      repository
        .auditEvents()
        .filter((event) => event.action === "receipt-persisted"),
    ).toHaveLength(1);
    expect(repository.acknowledgementOutbox()).toHaveLength(2);
    await expect(repository.persistReceipt(input)).resolves.toEqual({
      outcome: "delivery-conflict",
    });
    await expect(
      repository.persistReceipt({
        ...input,
        sessionId: parseCloudLinkSessionId(
          "99999999-9999-4999-8999-999999999999",
        ),
        sessionEpoch: parseCloudLinkSessionEpoch("8"),
      }),
    ).resolves.toEqual({ outcome: "delivery-conflict" });
    await expect(
      repository.persistReceipt({
        ...input,
        requestId: "integration-control-receipt-mutated",
        sessionId: parseCloudLinkSessionId(
          "88888888-8888-4888-8888-888888888888",
        ),
        sessionEpoch: parseCloudLinkSessionEpoch("8"),
        delivery: {
          ...input.delivery,
          sentAtMs: "1784275200501",
        },
      }),
    ).resolves.toEqual({ outcome: "delivery-conflict" });
    expect(repository.acknowledgementOutbox()).toHaveLength(2);
  });

  it("refuses a position gap and leaves intent, audit, and ACK state unchanged", async () => {
    const repository = new InMemoryIntegrationControlRepository();
    await repository.persistIntentAndOffer(createInput());
    const beforeAudit = repository.auditEvents().length;

    await expect(repository.persistReceipt(receiptInput("2"))).resolves.toEqual(
      {
        outcome: "delivery-gap",
      },
    );
    expect(repository.auditEvents()).toHaveLength(beforeAudit);
    expect(repository.acknowledgementOutbox()).toHaveLength(0);
    await expect(
      repository.findIntent(scope, gatewayId, jobId),
    ).resolves.toMatchObject({ latestReceipt: undefined, revision: 1 });
  });

  it("never reoffers an intent after any edge receipt made execution outcome ambiguous", async () => {
    const repository = new InMemoryIntegrationControlRepository();
    await repository.persistIntentAndOffer(createInput());
    await repository.persistReceipt(receiptInput());

    await expect(
      repository.listUnresolvedIntents(scope, gatewayId),
    ).resolves.toEqual([]);
  });
});
