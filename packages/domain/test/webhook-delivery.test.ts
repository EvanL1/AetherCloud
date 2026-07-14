import { describe, expect, it } from "vitest";

import {
  beginWebhookDelivery,
  createWebhookDelivery,
  failWebhookDelivery,
  parseContentDigest,
  parseIntegrationEventId,
  parseUtcInstant,
  parseWebhookDeliveryId,
  parseWebhookDestinationId,
  redriveWebhookDelivery,
  succeedWebhookDelivery,
} from "../src/index.js";
import type { WebhookDelivery } from "../src/index.js";

function delivery() {
  return createWebhookDelivery({
    deliveryId: parseWebhookDeliveryId("webhook-delivery-0001"),
    eventId: parseIntegrationEventId("integration-event-0001"),
    eventType: "edge.job-created.v1",
    destinationId: parseWebhookDestinationId("webhook-destination-0001"),
    payloadDigest: parseContentDigest("a".repeat(64)),
    createdAt: parseUtcInstant("2026-07-15T01:00:00.000Z"),
    maxAttempts: 3,
  });
}

describe("Webhook delivery", () => {
  it("preserves attempt evidence across retry and delivery", () => {
    const first = beginWebhookDelivery(
      delivery(),
      parseUtcInstant("2026-07-15T01:00:01.000Z"),
    );
    const retrying = failWebhookDelivery(first, {
      completedAt: parseUtcInstant("2026-07-15T01:00:02.000Z"),
      failureCode: "destination-unavailable",
      retryable: true,
      nextAttemptAt: parseUtcInstant("2026-07-15T01:01:00.000Z"),
    });
    const second = beginWebhookDelivery(
      retrying,
      parseUtcInstant("2026-07-15T01:01:00.000Z"),
    );
    const delivered = succeedWebhookDelivery(
      second,
      204,
      parseUtcInstant("2026-07-15T01:01:01.000Z"),
    );

    expect(retrying).toMatchObject({
      state: "retrying",
      attempts: 1,
      nextAttemptAt: "2026-07-15T01:01:00.000Z",
    });
    expect(delivered).toMatchObject({
      state: "delivered",
      attempts: 2,
      attemptEvidence: [
        { attempt: 1, outcome: "failed" },
        { attempt: 2, outcome: "delivered", statusCode: 204 },
      ],
    });
  });

  it("dead-letters permanent failure and redrives only through new governed intent", () => {
    const begun = beginWebhookDelivery(
      delivery(),
      parseUtcInstant("2026-07-15T01:00:01.000Z"),
    );
    const dead = failWebhookDelivery(begun, {
      completedAt: parseUtcInstant("2026-07-15T01:00:02.000Z"),
      failureCode: "destination-rejected",
      retryable: false,
    });
    const redriven = redriveWebhookDelivery(
      dead,
      parseUtcInstant("2026-07-15T02:00:00.000Z"),
    );

    expect(dead.state).toBe("dead-lettered");
    expect(redriven).toMatchObject({
      state: "pending",
      attempts: 0,
      redriveCount: 1,
    });
    expect(redriven.attemptEvidence).toHaveLength(1);
  });

  it("does not run a retry before its bounded backoff expires", () => {
    const begun = beginWebhookDelivery(
      delivery(),
      parseUtcInstant("2026-07-15T01:00:01.000Z"),
    );
    const retrying = failWebhookDelivery(begun, {
      completedAt: parseUtcInstant("2026-07-15T01:00:02.000Z"),
      failureCode: "destination-unavailable",
      retryable: true,
      nextAttemptAt: parseUtcInstant("2026-07-15T01:01:00.000Z"),
    });

    expect(() =>
      beginWebhookDelivery(
        retrying,
        parseUtcInstant("2026-07-15T01:00:59.000Z"),
      ),
    ).toThrow(/not due/u);
  });

  it("validates identifiers, event type, and attempt budget", () => {
    for (const parser of [
      parseWebhookDeliveryId,
      parseIntegrationEventId,
      parseWebhookDestinationId,
    ]) {
      expect(() => parser("short")).toThrow();
      expect(() => parser("contains space value")).toThrow();
      expect(() => parser(7)).toThrow();
    }
    for (const maxAttempts of [0, 21, 1.5]) {
      expect(() =>
        createWebhookDelivery({
          ...delivery(),
          eventType: "edge.job-created.v1",
          maxAttempts,
        }),
      ).toThrow(/maxAttempts/u);
    }
    expect(() =>
      createWebhookDelivery({ ...delivery(), eventType: "bad event type" }),
    ).toThrow(/eventType/u);
  });

  it("rejects invalid begin and completion transitions", () => {
    const begun = beginWebhookDelivery(
      delivery(),
      parseUtcInstant("2026-07-15T01:00:01.000Z"),
    );
    expect(
      beginWebhookDelivery(begun, parseUtcInstant("2026-07-15T01:00:01.000Z")),
    ).toBe(begun);
    const delivered = succeedWebhookDelivery(
      begun,
      204,
      parseUtcInstant("2026-07-15T01:00:02.000Z"),
    );
    expect(() =>
      beginWebhookDelivery(
        delivered,
        parseUtcInstant("2026-07-15T01:00:03.000Z"),
      ),
    ).toThrow(/cannot begin/u);
    const exhausted: WebhookDelivery = {
      ...delivery(),
      state: "retrying",
      attempts: 3,
      nextAttemptAt: parseUtcInstant("2026-07-15T01:00:00.000Z"),
    };
    expect(() =>
      beginWebhookDelivery(
        exhausted,
        parseUtcInstant("2026-07-15T01:00:01.000Z"),
      ),
    ).toThrow(/exhausted/u);
    expect(() =>
      succeedWebhookDelivery(
        delivery(),
        204,
        parseUtcInstant("2026-07-15T01:00:01.000Z"),
      ),
    ).toThrow(/invalid/u);
    for (const statusCode of [199, 300, 204.5]) {
      expect(() =>
        succeedWebhookDelivery(
          begun,
          statusCode,
          parseUtcInstant("2026-07-15T01:00:02.000Z"),
        ),
      ).toThrow(/status/u);
    }
    expect(() =>
      succeedWebhookDelivery(
        begun,
        204,
        parseUtcInstant("2026-07-15T01:00:00.000Z"),
      ),
    ).toThrow(/precedes/u);
  });

  it("rejects invalid failure and redrive evidence", () => {
    expect(() =>
      failWebhookDelivery(delivery(), {
        completedAt: parseUtcInstant("2026-07-15T01:00:02.000Z"),
        failureCode: "destination-unavailable",
        retryable: false,
      }),
    ).toThrow(/invalid/u);
    const begun = beginWebhookDelivery(
      delivery(),
      parseUtcInstant("2026-07-15T01:00:01.000Z"),
    );
    expect(() =>
      failWebhookDelivery(begun, {
        completedAt: parseUtcInstant("2026-07-15T01:00:00.000Z"),
        failureCode: "destination-unavailable",
        retryable: false,
      }),
    ).toThrow(/precedes/u);
    expect(() =>
      failWebhookDelivery(begun, {
        completedAt: parseUtcInstant("2026-07-15T01:00:02.000Z"),
        failureCode: "bad failure code",
        retryable: false,
      }),
    ).toThrow(/failureCode/u);
    expect(() =>
      failWebhookDelivery(begun, {
        completedAt: parseUtcInstant("2026-07-15T01:00:02.000Z"),
        failureCode: "destination-unavailable",
        retryable: true,
      }),
    ).toThrow(/nextAttemptAt/u);
    expect(() =>
      failWebhookDelivery(begun, {
        completedAt: parseUtcInstant("2026-07-15T01:00:02.000Z"),
        failureCode: "destination-unavailable",
        retryable: true,
        nextAttemptAt: parseUtcInstant("2026-07-15T01:00:02.000Z"),
      }),
    ).toThrow(/follow/u);
    expect(() =>
      redriveWebhookDelivery(
        delivery(),
        parseUtcInstant("2026-07-15T02:00:00.000Z"),
      ),
    ).toThrow(/invalid/u);
  });
});
