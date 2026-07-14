import { describe, expect, it } from "vitest";

import {
  EnqueueWebhookDelivery,
  ProcessWebhookDelivery,
  RedriveWebhookDelivery,
} from "../src/index.js";
import type { WebhookDeliveryRepository, WebhookSender } from "../src/index.js";
import {
  beginWebhookDelivery,
  createWebhookDelivery,
  failWebhookDelivery,
  parseContentDigest,
  parseIntegrationEventId,
  parseUtcInstant,
  parseWebhookDeliveryId,
  parseWebhookDestinationId,
} from "@aether-cloud/domain";
import type { WebhookDelivery } from "@aether-cloud/domain";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function context(permission: string, overrides: Record<string, unknown> = {}) {
  return {
    tenantId,
    projectId,
    subjectId: "worker-1",
    permissions: [permission],
    confirmation: "not-confirmed",
    idempotencyKey: "webhook-request-0001",
    issuedAt: "2026-07-15T01:00:00.000Z",
    expiresAt: "2026-07-15T01:10:00.000Z",
    ...overrides,
  };
}

const input = {
  deliveryId: "webhook-delivery-0001",
  eventId: "integration-event-0001",
  eventType: "edge.job-created.v1",
  destinationId: "webhook-destination-0001",
  payloadDigest: "a".repeat(64),
  maxAttempts: 3,
};

function pending(): WebhookDelivery {
  return createWebhookDelivery({
    deliveryId: parseWebhookDeliveryId(input.deliveryId),
    eventId: parseIntegrationEventId(input.eventId),
    eventType: input.eventType,
    destinationId: parseWebhookDestinationId(input.destinationId),
    payloadDigest: parseContentDigest(input.payloadDigest),
    createdAt: parseUtcInstant("2026-07-15T01:00:00.000Z"),
    maxAttempts: input.maxAttempts,
  });
}

function repository(
  overrides: Partial<WebhookDeliveryRepository> = {},
): WebhookDeliveryRepository {
  return {
    insert: (request) =>
      Promise.resolve({ outcome: "inserted", delivery: request.delivery }),
    replace: (request) =>
      Promise.resolve({ outcome: "replaced", delivery: request.delivery }),
    find: () => Promise.resolve(undefined),
    ...overrides,
  };
}

describe("Webhook delivery application", () => {
  it("enqueues an outbox event without accepting an arbitrary URL", async () => {
    const enqueue = new EnqueueWebhookDelivery({
      repository: repository(),
      clock: { now: () => "2026-07-15T01:00:01.000Z" },
    });

    expect(
      await enqueue.execute(context("integration.webhook.enqueue"), input),
    ).toMatchObject({ ok: true, value: { state: "pending" } });
    expect(
      await enqueue.execute(context("integration.webhook.enqueue"), {
        ...input,
        url: "http://169.254.169.254/latest/meta-data",
      }),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
  });

  it("delivers through a destination-reference sender and persists terminal evidence", async () => {
    let current: WebhookDelivery | undefined;
    const seedRepository = repository({
      insert: (request) => {
        current = request.delivery;
        return Promise.resolve({
          outcome: "inserted",
          delivery: request.delivery,
        });
      },
    });
    const created = await new EnqueueWebhookDelivery({
      repository: seedRepository,
      clock: { now: () => "2026-07-15T01:00:01.000Z" },
    }).execute(context("integration.webhook.enqueue"), input);
    if (!created.ok) throw new Error("delivery fixture failed");
    const repo = repository({
      find: () => Promise.resolve(current),
      replace: (request) => {
        current = request.delivery;
        return Promise.resolve({ outcome: "replaced", delivery: current });
      },
    });
    let sent: unknown;
    const sender: WebhookSender = {
      send: (request) => {
        sent = request;
        return Promise.resolve({ ok: true, statusCode: 202 });
      },
    };

    const result = await new ProcessWebhookDelivery({
      repository: repo,
      sender,
      clock: { now: () => "2026-07-15T01:00:02.000Z" },
    }).execute(context("integration.webhook.deliver"), {
      deliveryId: input.deliveryId,
    });

    expect(sent).toMatchObject({
      deliveryId: input.deliveryId,
      eventId: input.eventId,
      destinationId: input.destinationId,
      idempotencyKey: input.deliveryId,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { state: "delivered", attempts: 1 },
    });
  });

  it("requires explicit confirmation to redrive dead-lettered evidence", async () => {
    const redrive = new RedriveWebhookDelivery({
      repository: repository(),
      clock: { now: () => "2026-07-15T02:00:00.000Z" },
    });

    expect(
      await redrive.execute(
        context("integration.webhook.redrive", {
          issuedAt: "2026-07-15T01:59:00.000Z",
          expiresAt: "2026-07-15T02:10:00.000Z",
        }),
        { deliveryId: input.deliveryId },
      ),
    ).toMatchObject({
      ok: false,
      failure: { code: "confirmation-required" },
    });
  });

  it("validates context, permission, clock, time, and enqueue input", async () => {
    const enqueue = new EnqueueWebhookDelivery({
      repository: repository(),
      clock: { now: () => "2026-07-15T01:00:01.000Z" },
    });
    for (const invalidContext of [
      null,
      { ...context("integration.webhook.enqueue"), extra: true },
      { ...context("integration.webhook.enqueue"), confirmation: "implicit" },
      { ...context("integration.webhook.enqueue"), subjectId: "bad subject" },
      { ...context("integration.webhook.enqueue"), permissions: "permission" },
      { ...context("integration.webhook.enqueue"), permissions: [7] },
      { ...context("integration.webhook.enqueue"), idempotencyKey: "short" },
    ]) {
      expect(await enqueue.execute(invalidContext, input)).toMatchObject({
        ok: false,
        failure: { code: "invalid-input" },
      });
    }
    expect(
      await enqueue.execute(context("other.permission"), input),
    ).toMatchObject({ ok: false, failure: { code: "permission-denied" } });
    expect(
      await enqueue.execute(
        context("integration.webhook.enqueue", {
          issuedAt: "2026-07-15T01:00:02.000Z",
        }),
        input,
      ),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    expect(
      await enqueue.execute(
        context("integration.webhook.enqueue", {
          expiresAt: "2026-07-15T01:00:01.000Z",
        }),
        input,
      ),
    ).toMatchObject({ ok: false, failure: { code: "command-expired" } });
    for (const invalidInput of [
      null,
      { ...input, extra: true },
      { ...input, maxAttempts: "3" },
      { ...input, maxAttempts: 0 },
      { ...input, deliveryId: "short" },
      { ...input, eventId: "short" },
      { ...input, destinationId: "short" },
      { ...input, eventType: "bad event" },
      { ...input, payloadDigest: "bad" },
    ]) {
      expect(
        await enqueue.execute(
          context("integration.webhook.enqueue"),
          invalidInput,
        ),
      ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    }
    expect(
      await new EnqueueWebhookDelivery({
        repository: repository(),
        clock: { now: () => "not-a-time" },
      }).execute(context("integration.webhook.enqueue"), input),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
  });

  it("maps enqueue replay and every insertion failure", async () => {
    for (const [outcome, code] of [
      ["already-exists", "webhook-delivery-conflict"],
      ["idempotency-conflict", "webhook-idempotency-conflict"],
      ["storage-unavailable", "webhook-storage-unavailable"],
    ] as const) {
      const enqueue = new EnqueueWebhookDelivery({
        repository: repository({ insert: () => Promise.resolve({ outcome }) }),
        clock: { now: () => "2026-07-15T01:00:01.000Z" },
      });
      expect(
        await enqueue.execute(context("integration.webhook.enqueue"), input),
      ).toMatchObject({ ok: false, failure: { code } });
    }
    expect(
      await new EnqueueWebhookDelivery({
        repository: repository({
          insert: (request) =>
            Promise.resolve({
              outcome: "replayed",
              delivery: request.delivery,
            }),
        }),
        clock: { now: () => "2026-07-15T01:00:01.000Z" },
      }).execute(context("integration.webhook.enqueue"), input),
    ).toMatchObject({ ok: true, replayed: true });
  });

  it("handles process lookup, terminal replay, retry, permanent failure, and invalid sender evidence", async () => {
    const processContext = context("integration.webhook.deliver");
    const successSender: WebhookSender = {
      send: () => Promise.resolve({ ok: true, statusCode: 204 }),
    };
    expect(
      await new ProcessWebhookDelivery({
        repository: repository(),
        sender: successSender,
        clock: { now: () => "2026-07-15T01:00:02.000Z" },
      }).execute(processContext, { deliveryId: input.deliveryId }),
    ).toMatchObject({
      ok: false,
      failure: { code: "webhook-delivery-not-found" },
    });
    expect(
      await new ProcessWebhookDelivery({
        repository: repository(),
        sender: successSender,
        clock: { now: () => "2026-07-15T01:00:02.000Z" },
      }).execute(context("other.permission"), { deliveryId: input.deliveryId }),
    ).toMatchObject({ ok: false, failure: { code: "permission-denied" } });

    const begun = beginWebhookDelivery(
      pending(),
      parseUtcInstant("2026-07-15T01:00:01.000Z"),
    );
    const dead = failWebhookDelivery(begun, {
      completedAt: parseUtcInstant("2026-07-15T01:00:02.000Z"),
      failureCode: "destination-rejected",
      retryable: false,
    });
    expect(
      await new ProcessWebhookDelivery({
        repository: repository({ find: () => Promise.resolve(dead) }),
        sender: successSender,
        clock: { now: () => "2026-07-15T01:01:00.000Z" },
      }).execute(processContext, { deliveryId: input.deliveryId }),
    ).toMatchObject({
      ok: true,
      replayed: true,
      value: { state: "dead-lettered" },
    });

    const retrySender: WebhookSender = {
      send: () =>
        Promise.resolve({
          ok: false,
          failureCode: "destination-unavailable",
          retryable: true,
        }),
    };
    let retryCurrent = pending();
    const retryRepo = repository({
      find: () => Promise.resolve(retryCurrent),
      replace: (request) => {
        retryCurrent = request.delivery;
        return Promise.resolve({ outcome: "replaced", delivery: retryCurrent });
      },
    });
    expect(
      await new ProcessWebhookDelivery({
        repository: retryRepo,
        sender: retrySender,
        clock: { now: () => "2026-07-15T01:00:02.000Z" },
      }).execute(processContext, { deliveryId: input.deliveryId }),
    ).toMatchObject({ ok: true, value: { state: "retrying" } });

    const permanentSender: WebhookSender = {
      send: () =>
        Promise.resolve({
          ok: false,
          failureCode: "destination-rejected",
          retryable: false,
        }),
    };
    let permanentCurrent = pending();
    expect(
      await new ProcessWebhookDelivery({
        repository: repository({
          find: () => Promise.resolve(permanentCurrent),
          replace: (request) => {
            permanentCurrent = request.delivery;
            return Promise.resolve({
              outcome: "replaced",
              delivery: permanentCurrent,
            });
          },
        }),
        sender: permanentSender,
        clock: { now: () => "2026-07-15T01:00:02.000Z" },
      }).execute(processContext, { deliveryId: input.deliveryId }),
    ).toMatchObject({ ok: true, value: { state: "dead-lettered" } });

    for (const result of [
      { ok: true as const, statusCode: 500 },
      {
        ok: false as const,
        failureCode: "bad failure code",
        retryable: true,
      },
      {
        ok: false as const,
        failureCode: "destination-unavailable",
        retryable: true,
        retryAfterSeconds: 0,
      },
      {
        ok: false as const,
        failureCode: "destination-unavailable",
        retryable: true,
        retryAfterSeconds: 1.5,
      },
      {
        ok: false as const,
        failureCode: "destination-unavailable",
        retryable: true,
        retryAfterSeconds: 3601,
      },
    ]) {
      let current = pending();
      const invalidSender: WebhookSender = {
        send: () => Promise.resolve(result),
      };
      expect(
        await new ProcessWebhookDelivery({
          repository: repository({
            find: () => Promise.resolve(current),
            replace: (request) => {
              current = request.delivery;
              return Promise.resolve({
                outcome: "replaced",
                delivery: current,
              });
            },
          }),
          sender: invalidSender,
          clock: { now: () => "2026-07-15T01:00:02.000Z" },
        }).execute(processContext, { deliveryId: input.deliveryId }),
      ).toMatchObject({
        ok: false,
        failure: { code: "webhook-sender-invalid-response" },
      });
    }
  });

  it("maps begin/completion persistence failures and not-due state", async () => {
    const processContext = context("integration.webhook.deliver");
    const sender: WebhookSender = {
      send: () => Promise.resolve({ ok: true, statusCode: 204 }),
    };
    const retrying = failWebhookDelivery(
      beginWebhookDelivery(
        pending(),
        parseUtcInstant("2026-07-15T01:00:01.000Z"),
      ),
      {
        completedAt: parseUtcInstant("2026-07-15T01:00:02.000Z"),
        failureCode: "destination-unavailable",
        retryable: true,
        nextAttemptAt: parseUtcInstant("2026-07-15T01:01:00.000Z"),
      },
    );
    expect(
      await new ProcessWebhookDelivery({
        repository: repository({ find: () => Promise.resolve(retrying) }),
        sender,
        clock: { now: () => "2026-07-15T01:00:30.000Z" },
      }).execute(processContext, { deliveryId: input.deliveryId }),
    ).toMatchObject({ ok: false, failure: { code: "webhook-not-due" } });

    for (const [outcome, code] of [
      ["idempotency-conflict", "webhook-idempotency-conflict"],
      ["not-found", "webhook-delivery-not-found"],
      ["storage-unavailable", "webhook-storage-unavailable"],
      ["version-conflict", "webhook-version-conflict"],
    ] as const) {
      const process = new ProcessWebhookDelivery({
        repository: repository({
          find: () => Promise.resolve(pending()),
          replace: () => Promise.resolve({ outcome }),
        }),
        sender,
        clock: { now: () => "2026-07-15T01:00:02.000Z" },
      });
      expect(
        await process.execute(processContext, { deliveryId: input.deliveryId }),
      ).toMatchObject({ ok: false, failure: { code } });
    }

    let calls = 0;
    const completionConflict = new ProcessWebhookDelivery({
      repository: repository({
        find: () => Promise.resolve(pending()),
        replace: (request) => {
          calls += 1;
          return calls === 1
            ? Promise.resolve({
                outcome: "replaced",
                delivery: request.delivery,
              })
            : Promise.resolve({ outcome: "version-conflict" });
        },
      }),
      sender,
      clock: { now: () => "2026-07-15T01:00:02.000Z" },
    });
    expect(
      await completionConflict.execute(processContext, {
        deliveryId: input.deliveryId,
      }),
    ).toMatchObject({
      ok: false,
      failure: { code: "webhook-version-conflict" },
    });
  });

  it("redrives only dead letters and maps update outcomes", async () => {
    const redriveContext = context("integration.webhook.redrive", {
      confirmation: "confirmed",
      issuedAt: "2026-07-15T01:59:00.000Z",
      expiresAt: "2026-07-15T02:10:00.000Z",
    });
    expect(
      await new RedriveWebhookDelivery({
        repository: repository(),
        clock: { now: () => "2026-07-15T02:00:00.000Z" },
      }).execute(redriveContext, { deliveryId: input.deliveryId }),
    ).toMatchObject({
      ok: false,
      failure: { code: "webhook-delivery-not-found" },
    });
    expect(
      await new RedriveWebhookDelivery({
        repository: repository({ find: () => Promise.resolve(pending()) }),
        clock: { now: () => "2026-07-15T02:00:00.000Z" },
      }).execute(redriveContext, { deliveryId: input.deliveryId }),
    ).toMatchObject({
      ok: false,
      failure: { code: "webhook-transition-invalid" },
    });

    const dead = failWebhookDelivery(
      beginWebhookDelivery(
        pending(),
        parseUtcInstant("2026-07-15T01:00:01.000Z"),
      ),
      {
        completedAt: parseUtcInstant("2026-07-15T01:00:02.000Z"),
        failureCode: "destination-rejected",
        retryable: false,
      },
    );
    for (const [outcome, code] of [
      ["idempotency-conflict", "webhook-idempotency-conflict"],
      ["not-found", "webhook-delivery-not-found"],
      ["storage-unavailable", "webhook-storage-unavailable"],
      ["version-conflict", "webhook-version-conflict"],
    ] as const) {
      expect(
        await new RedriveWebhookDelivery({
          repository: repository({
            find: () => Promise.resolve(dead),
            replace: () => Promise.resolve({ outcome }),
          }),
          clock: { now: () => "2026-07-15T02:00:00.000Z" },
        }).execute(redriveContext, { deliveryId: input.deliveryId }),
      ).toMatchObject({ ok: false, failure: { code } });
    }
    expect(
      await new RedriveWebhookDelivery({
        repository: repository({
          find: () => Promise.resolve(dead),
          replace: (request) =>
            Promise.resolve({
              outcome: "replayed",
              delivery: request.delivery,
            }),
        }),
        clock: { now: () => "2026-07-15T02:00:00.000Z" },
      }).execute(redriveContext, { deliveryId: input.deliveryId }),
    ).toMatchObject({ ok: true, replayed: true, value: { state: "pending" } });
  });
});
