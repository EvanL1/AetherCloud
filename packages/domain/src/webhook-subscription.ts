import type { UtcInstant } from "./resource-identities.js";
import {
  InvalidDomainValueError,
  parseUtcInstant,
} from "./resource-identities.js";
import type { WebhookDestinationId } from "./webhook-delivery.js";
import { parseWebhookDestinationId } from "./webhook-delivery.js";

const opaqueIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const boundedIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

declare const webhookSubscriptionIdBrand: unique symbol;

export type WebhookSubscriptionId = string & {
  readonly [webhookSubscriptionIdBrand]: true;
};
export type WebhookSubscriptionState = "active" | "disabled";

export interface WebhookSubscription {
  readonly subscriptionId: WebhookSubscriptionId;
  readonly destinationId: WebhookDestinationId;
  readonly eventTypes: readonly string[];
  readonly maxAttempts: number;
  readonly state: WebhookSubscriptionState;
  readonly createdAt: UtcInstant;
  readonly disabledAt?: UtcInstant;
  readonly revision: number;
}

export class WebhookSubscriptionTransitionError extends Error {
  readonly code = "invalid-webhook-subscription-transition";

  constructor(message: string) {
    super(message);
    this.name = "WebhookSubscriptionTransitionError";
  }
}

export function parseWebhookSubscriptionId(
  input: unknown,
): WebhookSubscriptionId {
  if (typeof input !== "string" || !opaqueIdentifier.test(input)) {
    throw new InvalidDomainValueError(
      "webhookSubscriptionId",
      "webhookSubscriptionId must be an opaque 8-128 character identifier",
    );
  }
  return input as WebhookSubscriptionId;
}

function parseEventTypes(input: readonly string[]): readonly string[] {
  if (input.length < 1 || input.length > 32) {
    throw new InvalidDomainValueError(
      "eventTypes",
      "eventTypes must contain from 1 through 32 values",
    );
  }
  if (
    input.some(
      (eventType) =>
        typeof eventType !== "string" || !boundedIdentifier.test(eventType),
    )
  ) {
    throw new InvalidDomainValueError(
      "eventTypes",
      "eventTypes must contain bounded identifiers",
    );
  }
  if (new Set(input).size !== input.length) {
    throw new InvalidDomainValueError(
      "eventTypes",
      "eventTypes must be unique",
    );
  }
  return Object.freeze([...input].sort());
}

export function createWebhookSubscription(input: {
  readonly subscriptionId: WebhookSubscriptionId;
  readonly destinationId: WebhookDestinationId;
  readonly eventTypes: readonly string[];
  readonly maxAttempts: number;
  readonly createdAt: UtcInstant;
}): WebhookSubscription {
  if (
    !Number.isInteger(input.maxAttempts) ||
    input.maxAttempts < 1 ||
    input.maxAttempts > 20
  ) {
    throw new InvalidDomainValueError(
      "maxAttempts",
      "maxAttempts must be an integer from 1 through 20",
    );
  }
  return Object.freeze({
    subscriptionId: parseWebhookSubscriptionId(input.subscriptionId),
    destinationId: parseWebhookDestinationId(input.destinationId),
    eventTypes: parseEventTypes(input.eventTypes),
    maxAttempts: input.maxAttempts,
    state: "active",
    createdAt: parseUtcInstant(input.createdAt),
    revision: 1,
  });
}

export function disableWebhookSubscription(
  subscription: WebhookSubscription,
  disabledAt: UtcInstant,
): WebhookSubscription {
  if (subscription.state === "disabled") return subscription;
  const at = parseUtcInstant(disabledAt);
  if (at < subscription.createdAt) {
    throw new WebhookSubscriptionTransitionError(
      "disable precedes subscription creation",
    );
  }
  return Object.freeze({
    ...subscription,
    state: "disabled",
    disabledAt: at,
    revision: subscription.revision + 1,
  });
}
