import { describe, expect, it } from "vitest";

import {
  createWebhookSubscription,
  disableWebhookSubscription,
  parseUtcInstant,
  parseWebhookDestinationId,
  parseWebhookSubscriptionId,
} from "../src/index.js";

describe("Webhook subscription", () => {
  it("binds a bounded event allowlist to a destination reference", () => {
    const subscription = createWebhookSubscription({
      subscriptionId: parseWebhookSubscriptionId("webhook-subscription-0001"),
      destinationId: parseWebhookDestinationId("webhook-destination-0001"),
      eventTypes: ["edge.job-created.v1", "alarm.projection-updated.v1"],
      maxAttempts: 5,
      createdAt: parseUtcInstant("2026-07-15T03:00:00.000Z"),
    });

    expect(subscription).toMatchObject({ state: "active", maxAttempts: 5 });
    expect(Object.isFrozen(subscription.eventTypes)).toBe(true);
    expect(() =>
      createWebhookSubscription({
        subscriptionId: parseWebhookSubscriptionId("webhook-subscription-0002"),
        destinationId: parseWebhookDestinationId("webhook-destination-0001"),
        eventTypes: ["edge.job-created.v1", "edge.job-created.v1"],
        maxAttempts: 5,
        createdAt: parseUtcInstant("2026-07-15T03:00:00.000Z"),
      }),
    ).toThrow(/unique/u);
  });

  it("disables future matching without rewriting prior deliveries", () => {
    const created = createWebhookSubscription({
      subscriptionId: parseWebhookSubscriptionId("webhook-subscription-0001"),
      destinationId: parseWebhookDestinationId("webhook-destination-0001"),
      eventTypes: ["edge.job-created.v1"],
      maxAttempts: 5,
      createdAt: parseUtcInstant("2026-07-15T03:00:00.000Z"),
    });
    const disabled = disableWebhookSubscription(
      created,
      parseUtcInstant("2026-07-15T03:10:00.000Z"),
    );

    expect(disabled).toMatchObject({ state: "disabled", revision: 2 });
    expect(
      disableWebhookSubscription(
        disabled,
        parseUtcInstant("2026-07-15T03:10:00.000Z"),
      ),
    ).toBe(disabled);
  });

  it("bounds identities, event allowlists, retry policy, and transition time", () => {
    expect(() => parseWebhookSubscriptionId("short")).toThrow();
    for (const eventTypes of [
      [],
      Array.from({ length: 33 }, (_, index) => `event-${String(index)}`),
      ["bad event type"],
    ]) {
      expect(() =>
        createWebhookSubscription({
          subscriptionId: parseWebhookSubscriptionId(
            "webhook-subscription-0001",
          ),
          destinationId: parseWebhookDestinationId("webhook-destination-0001"),
          eventTypes,
          maxAttempts: 5,
          createdAt: parseUtcInstant("2026-07-15T03:00:00.000Z"),
        }),
      ).toThrow();
    }
    for (const maxAttempts of [0, 21, 1.5]) {
      expect(() =>
        createWebhookSubscription({
          subscriptionId: parseWebhookSubscriptionId(
            "webhook-subscription-0001",
          ),
          destinationId: parseWebhookDestinationId("webhook-destination-0001"),
          eventTypes: ["edge.job-created.v1"],
          maxAttempts,
          createdAt: parseUtcInstant("2026-07-15T03:00:00.000Z"),
        }),
      ).toThrow(/maxAttempts/u);
    }
    const created = createWebhookSubscription({
      subscriptionId: parseWebhookSubscriptionId("webhook-subscription-0001"),
      destinationId: parseWebhookDestinationId("webhook-destination-0001"),
      eventTypes: ["edge.job-created.v1"],
      maxAttempts: 1,
      createdAt: parseUtcInstant("2026-07-15T03:00:00.000Z"),
    });
    expect(() =>
      disableWebhookSubscription(
        created,
        parseUtcInstant("2026-07-15T02:59:59.999Z"),
      ),
    ).toThrow(/precedes/u);
  });
});
