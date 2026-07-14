import { describe, expect, it } from "vitest";

import {
  CreateWebhookSubscription,
  DisableWebhookSubscription,
  GetWebhookSubscription,
} from "../src/index.js";
import type { WebhookSubscriptionRepository } from "../src/index.js";
import {
  createWebhookSubscription,
  parseUtcInstant,
  parseWebhookDestinationId,
  parseWebhookSubscriptionId,
} from "@aether-cloud/domain";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const subscriptionId = "webhook-subscription-0001";
const createInput = {
  subscriptionId,
  destinationId: "webhook-destination-0001",
  eventTypes: ["edge.job-created.v1"],
  maxAttempts: 5,
};

function commandContext(overrides: Record<string, unknown> = {}) {
  return {
    tenantId,
    projectId,
    subjectId: "integration-admin-1",
    permissions: ["integration.webhook.subscription.create"],
    confirmation: "confirmed",
    idempotencyKey: "subscription-request-0001",
    issuedAt: "2026-07-15T03:00:00.000Z",
    expiresAt: "2026-07-15T03:10:00.000Z",
    ...overrides,
  };
}

function repository(
  overrides: Partial<WebhookSubscriptionRepository> = {},
): WebhookSubscriptionRepository {
  return {
    insert: (request) =>
      Promise.resolve({
        outcome: "inserted",
        subscription: request.subscription,
      }),
    replace: (request) =>
      Promise.resolve({
        outcome: "replaced",
        subscription: request.subscription,
      }),
    find: () => Promise.resolve(undefined),
    ...overrides,
  };
}

describe("Webhook subscription application", () => {
  it("requires explicit confirmation and stores only a destination reference", async () => {
    const create = new CreateWebhookSubscription({
      repository: repository(),
      clock: { now: () => "2026-07-15T03:00:01.000Z" },
    });
    expect(
      await create.execute(
        commandContext({ confirmation: "not-confirmed" }),
        createInput,
      ),
    ).toMatchObject({
      ok: false,
      failure: { code: "confirmation-required" },
    });
    expect(await create.execute(commandContext(), createInput)).toMatchObject({
      ok: true,
      value: { destinationId: "webhook-destination-0001", state: "active" },
    });
  });

  it("disables by command and reads through the same scoped repository", async () => {
    let current = createWebhookSubscription({
      subscriptionId: parseWebhookSubscriptionId(subscriptionId),
      destinationId: parseWebhookDestinationId("webhook-destination-0001"),
      eventTypes: ["edge.job-created.v1"],
      maxAttempts: 5,
      createdAt: parseUtcInstant("2026-07-15T03:00:00.000Z"),
    });
    const store = repository({
      find: () => Promise.resolve(current),
      replace: (request) => {
        current = request.subscription;
        return Promise.resolve({ outcome: "replaced", subscription: current });
      },
    });
    const disable = new DisableWebhookSubscription({
      repository: store,
      clock: { now: () => "2026-07-15T03:05:00.000Z" },
    });

    expect(
      await disable.execute(
        commandContext({
          permissions: ["integration.webhook.subscription.disable"],
          idempotencyKey: "subscription-disable-0001",
        }),
        { subscriptionId },
      ),
    ).toMatchObject({ ok: true, value: { state: "disabled" } });
    expect(
      await new GetWebhookSubscription({ repository: store }).execute(
        {
          tenantId,
          projectId,
          subjectId: "integration-reader-1",
          permissions: ["integration.webhook.subscription.read"],
        },
        { subscriptionId },
      ),
    ).toMatchObject({ ok: true, value: { state: "disabled" } });
  });

  it("validates context, authorization, clock, time window, and create input", async () => {
    const create = new CreateWebhookSubscription({
      repository: repository(),
      clock: { now: () => "2026-07-15T03:00:01.000Z" },
    });
    for (const invalidContext of [
      null,
      { ...commandContext(), extra: true },
      { ...commandContext(), confirmation: "implicit" },
      { ...commandContext(), subjectId: "bad subject" },
      { ...commandContext(), permissions: "permission" },
      { ...commandContext(), permissions: [7] },
      { ...commandContext(), idempotencyKey: "short" },
    ]) {
      expect(await create.execute(invalidContext, createInput)).toMatchObject({
        ok: false,
        failure: { code: "invalid-input" },
      });
    }
    expect(
      await create.execute(commandContext({ permissions: [] }), createInput),
    ).toMatchObject({ ok: false, failure: { code: "permission-denied" } });
    expect(
      await create.execute(
        commandContext({ issuedAt: "2026-07-15T03:00:02.000Z" }),
        createInput,
      ),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    expect(
      await create.execute(
        commandContext({ expiresAt: "2026-07-15T03:00:01.000Z" }),
        createInput,
      ),
    ).toMatchObject({ ok: false, failure: { code: "command-expired" } });
    for (const invalidInput of [
      null,
      { ...createInput, url: "https://forbidden.test" },
      { ...createInput, eventTypes: "edge.job-created.v1" },
      { ...createInput, eventTypes: [7] },
      { ...createInput, maxAttempts: "5" },
      { ...createInput, destinationId: "short" },
      { ...createInput, subscriptionId: "short" },
      { ...createInput, maxAttempts: 0 },
    ]) {
      expect(
        await create.execute(commandContext(), invalidInput),
      ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    }
    expect(
      await new CreateWebhookSubscription({
        repository: repository(),
        clock: { now: () => "not-a-time" },
      }).execute(commandContext(), createInput),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
  });

  it("maps create replay and every insertion failure", async () => {
    for (const [outcome, code] of [
      ["already-exists", "webhook-subscription-conflict"],
      ["idempotency-conflict", "webhook-subscription-idempotency-conflict"],
      ["storage-unavailable", "webhook-subscription-storage-unavailable"],
    ] as const) {
      const create = new CreateWebhookSubscription({
        repository: repository({ insert: () => Promise.resolve({ outcome }) }),
        clock: { now: () => "2026-07-15T03:00:01.000Z" },
      });
      expect(await create.execute(commandContext(), createInput)).toMatchObject(
        { ok: false, failure: { code } },
      );
    }
    expect(
      await new CreateWebhookSubscription({
        repository: repository({
          insert: (request) =>
            Promise.resolve({
              outcome: "replayed",
              subscription: request.subscription,
            }),
        }),
        clock: { now: () => "2026-07-15T03:00:01.000Z" },
      }).execute(commandContext(), createInput),
    ).toMatchObject({ ok: true, replayed: true });
  });

  it("maps disable permission, not-found, transition, replay, and persistence failures", async () => {
    const active = createWebhookSubscription({
      subscriptionId: parseWebhookSubscriptionId(subscriptionId),
      destinationId: parseWebhookDestinationId("webhook-destination-0001"),
      eventTypes: ["edge.job-created.v1"],
      maxAttempts: 5,
      createdAt: parseUtcInstant("2026-07-15T03:01:00.000Z"),
    });
    const disableContext = commandContext({
      permissions: ["integration.webhook.subscription.disable"],
    });
    expect(
      await new DisableWebhookSubscription({
        repository: repository(),
        clock: { now: () => "2026-07-15T03:05:00.000Z" },
      }).execute(disableContext, { subscriptionId }),
    ).toMatchObject({
      ok: false,
      failure: { code: "webhook-subscription-not-found" },
    });
    expect(
      await new DisableWebhookSubscription({
        repository: repository({ find: () => Promise.resolve(active) }),
        clock: { now: () => "2026-07-15T03:00:00.000Z" },
      }).execute(disableContext, { subscriptionId }),
    ).toMatchObject({
      ok: false,
      failure: { code: "webhook-subscription-transition-invalid" },
    });
    for (const [outcome, code] of [
      ["idempotency-conflict", "webhook-subscription-idempotency-conflict"],
      ["not-found", "webhook-subscription-not-found"],
      ["storage-unavailable", "webhook-subscription-storage-unavailable"],
      ["version-conflict", "webhook-subscription-version-conflict"],
    ] as const) {
      const disable = new DisableWebhookSubscription({
        repository: repository({
          find: () => Promise.resolve(active),
          replace: () => Promise.resolve({ outcome }),
        }),
        clock: { now: () => "2026-07-15T03:05:00.000Z" },
      });
      expect(
        await disable.execute(disableContext, { subscriptionId }),
      ).toMatchObject({ ok: false, failure: { code } });
    }
    expect(
      await new DisableWebhookSubscription({
        repository: repository({
          find: () => Promise.resolve(active),
          replace: (request) =>
            Promise.resolve({
              outcome: "replayed",
              subscription: request.subscription,
            }),
        }),
        clock: { now: () => "2026-07-15T03:05:00.000Z" },
      }).execute(disableContext, { subscriptionId }),
    ).toMatchObject({ ok: true, replayed: true });
  });

  it("enforces query decoding, permission, and not-found", async () => {
    const query = new GetWebhookSubscription({ repository: repository() });
    const queryContext = {
      tenantId,
      projectId,
      subjectId: "reader-1",
      permissions: ["integration.webhook.subscription.read"],
    };
    expect(
      await query.execute(
        { ...queryContext, permissions: [] },
        { subscriptionId },
      ),
    ).toMatchObject({ ok: false, failure: { code: "permission-denied" } });
    expect(
      await query.execute(queryContext, { subscriptionId, extra: true }),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    expect(await query.execute(queryContext, { subscriptionId })).toMatchObject(
      {
        ok: false,
        failure: { code: "webhook-subscription-not-found" },
      },
    );
    expect(await query.execute(null, { subscriptionId })).toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
  });
});
