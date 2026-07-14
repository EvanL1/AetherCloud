import { describe, expect, it } from "vitest";

import { EnqueueWebhookDelivery } from "@aether-cloud/application";
import {
  beginWebhookDelivery,
  createWebhookDelivery,
  parseContentDigest,
  parseIntegrationEventId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  parseWebhookDeliveryId,
  parseWebhookDestinationId,
} from "@aether-cloud/domain";

import { InMemoryWebhookDeliveryRepository } from "../src/index.js";

const context = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  subjectId: "outbox-worker-1",
  permissions: ["integration.webhook.enqueue"],
  confirmation: "not-confirmed",
  idempotencyKey: "webhook-request-0001",
  issuedAt: "2026-07-15T01:00:00.000Z",
  expiresAt: "2026-07-15T01:10:00.000Z",
};

const input = {
  deliveryId: "webhook-delivery-0001",
  eventId: "integration-event-0001",
  eventType: "edge.job-created.v1",
  destinationId: "webhook-destination-0001",
  payloadDigest: "a".repeat(64),
  maxAttempts: 3,
};

describe("InMemoryWebhookDeliveryRepository", () => {
  it("atomically enqueues exact replay and rejects conflicting consumer identity", async () => {
    const repository = new InMemoryWebhookDeliveryRepository();
    const enqueue = new EnqueueWebhookDelivery({
      repository,
      clock: { now: () => "2026-07-15T01:00:01.000Z" },
    });

    expect(await enqueue.execute(context, input)).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(await enqueue.execute(context, input)).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(
      await enqueue.execute(context, {
        ...input,
        destinationId: "webhook-destination-0002",
      }),
    ).toMatchObject({
      ok: false,
      failure: { code: "webhook-idempotency-conflict" },
    });
    expect(repository.deliveryCount()).toBe(1);
    expect(repository.auditEvents()).toHaveLength(1);
    expect(repository.pendingOutboxEvents()).toHaveLength(1);
  });

  it("keeps cross-Tenant lookup closed and persistence failure atomic", async () => {
    const repository = new InMemoryWebhookDeliveryRepository();
    repository.failNextPersistence();
    const enqueue = new EnqueueWebhookDelivery({
      repository,
      clock: { now: () => "2026-07-15T01:00:01.000Z" },
    });

    expect(await enqueue.execute(context, input)).toMatchObject({
      ok: false,
      failure: { code: "webhook-storage-unavailable" },
    });
    expect(repository.deliveryCount()).toBe(0);
    expect(repository.auditEvents()).toHaveLength(0);
    expect(repository.pendingOutboxEvents()).toHaveLength(0);
  });

  it("conforms for conflicting insert and optimistic state replacement", async () => {
    const repository = new InMemoryWebhookDeliveryRepository();
    const scope = {
      tenantId: parseTenantId(context.tenantId),
      projectId: parseProjectId(context.projectId),
    };
    const delivery = createWebhookDelivery({
      deliveryId: parseWebhookDeliveryId(input.deliveryId),
      eventId: parseIntegrationEventId(input.eventId),
      eventType: input.eventType,
      destinationId: parseWebhookDestinationId(input.destinationId),
      payloadDigest: parseContentDigest(input.payloadDigest),
      createdAt: parseUtcInstant("2026-07-15T01:00:00.000Z"),
      maxAttempts: 3,
    });
    const insert = {
      ...scope,
      requestId: "delivery-insert-0001",
      subjectId: "worker-1",
      delivery,
    };
    expect(await repository.insert(insert)).toMatchObject({
      outcome: "inserted",
    });
    expect(await repository.insert(insert)).toMatchObject({
      outcome: "replayed",
    });
    expect(
      await repository.insert({ ...insert, requestId: "delivery-insert-0002" }),
    ).toEqual({ outcome: "already-exists" });
    expect(
      await repository.insert({
        ...insert,
        delivery: { ...delivery, maxAttempts: 4 },
      }),
    ).toEqual({ outcome: "idempotency-conflict" });
    expect(
      await repository.find(
        {
          tenantId: parseTenantId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
          projectId: scope.projectId,
        },
        delivery.deliveryId,
      ),
    ).toBeUndefined();

    const begun = beginWebhookDelivery(
      delivery,
      parseUtcInstant("2026-07-15T01:00:01.000Z"),
    );
    const replace = {
      ...scope,
      requestId: "delivery-replace-0001",
      subjectId: "worker-1",
      expectedRevision: 1,
      delivery: begun,
      eventName: "integration.webhook-delivery-state-changed.v1" as const,
    };
    expect(
      await repository.replace({ ...replace, expectedRevision: 99 }),
    ).toEqual({ outcome: "version-conflict" });
    repository.failNextPersistence();
    expect(await repository.replace(replace)).toEqual({
      outcome: "storage-unavailable",
    });
    expect(await repository.replace(replace)).toMatchObject({
      outcome: "replaced",
    });
    expect(await repository.replace(replace)).toMatchObject({
      outcome: "replayed",
    });
    expect(
      await new InMemoryWebhookDeliveryRepository().replace(replace),
    ).toEqual({ outcome: "not-found" });
    expect(repository.auditEvents()).toHaveLength(2);
    expect(repository.pendingOutboxEvents()).toHaveLength(2);
  });
});
