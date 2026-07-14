import { describe, expect, it } from "vitest";

import { CreateWebhookSubscription } from "@aether-cloud/application";
import {
  createWebhookSubscription,
  disableWebhookSubscription,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  parseWebhookDestinationId,
  parseWebhookSubscriptionId,
} from "@aether-cloud/domain";

import { InMemoryWebhookSubscriptionRepository } from "../src/index.js";

describe("InMemoryWebhookSubscriptionRepository", () => {
  it("keeps create replay atomic and Tenant-scoped", async () => {
    const repository = new InMemoryWebhookSubscriptionRepository();
    const create = new CreateWebhookSubscription({
      repository,
      clock: { now: () => "2026-07-15T03:00:01.000Z" },
    });
    const context = {
      tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      subjectId: "integration-admin-1",
      permissions: ["integration.webhook.subscription.create"],
      confirmation: "confirmed",
      idempotencyKey: "subscription-request-0001",
      issuedAt: "2026-07-15T03:00:00.000Z",
      expiresAt: "2026-07-15T03:10:00.000Z",
    };
    const input = {
      subscriptionId: "webhook-subscription-0001",
      destinationId: "webhook-destination-0001",
      eventTypes: ["edge.job-created.v1"],
      maxAttempts: 5,
    };

    expect(await create.execute(context, input)).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(await create.execute(context, input)).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(repository.subscriptionCount()).toBe(1);
    expect(repository.auditEvents()).toHaveLength(1);
    expect(repository.pendingOutboxEvents()).toHaveLength(1);
  });

  it("conforms for conflicting insert, optimistic disable, and persistence failure", async () => {
    const repository = new InMemoryWebhookSubscriptionRepository();
    const scope = {
      tenantId: parseTenantId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      projectId: parseProjectId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    };
    const subscription = createWebhookSubscription({
      subscriptionId: parseWebhookSubscriptionId("webhook-subscription-0001"),
      destinationId: parseWebhookDestinationId("webhook-destination-0001"),
      eventTypes: ["edge.job-created.v1"],
      maxAttempts: 3,
      createdAt: parseUtcInstant("2026-07-15T03:00:00.000Z"),
    });
    const insert = {
      ...scope,
      requestId: "subscription-insert-0001",
      subjectId: "operator-1",
      subscription,
    };
    expect(await repository.insert(insert)).toMatchObject({
      outcome: "inserted",
    });
    expect(await repository.insert(insert)).toMatchObject({
      outcome: "replayed",
    });
    expect(
      await repository.insert({
        ...insert,
        requestId: "subscription-insert-0002",
      }),
    ).toEqual({ outcome: "already-exists" });
    expect(
      await repository.insert({
        ...insert,
        subscription: { ...subscription, maxAttempts: 4 },
      }),
    ).toEqual({ outcome: "idempotency-conflict" });
    expect(
      await repository.find(
        {
          tenantId: parseTenantId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
          projectId: scope.projectId,
        },
        subscription.subscriptionId,
      ),
    ).toBeUndefined();

    const disabled = disableWebhookSubscription(
      subscription,
      parseUtcInstant("2026-07-15T03:05:00.000Z"),
    );
    const replace = {
      ...scope,
      requestId: "subscription-replace-0001",
      subjectId: "operator-1",
      expectedRevision: 1,
      subscription: disabled,
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
      await new InMemoryWebhookSubscriptionRepository().replace(replace),
    ).toEqual({ outcome: "not-found" });
    expect(repository.auditEvents()).toHaveLength(2);
    expect(repository.pendingOutboxEvents()).toMatchObject([
      { eventName: "integration.webhook-subscription-created.v1" },
      { eventName: "integration.webhook-subscription-disabled.v1" },
    ]);
  });
});
