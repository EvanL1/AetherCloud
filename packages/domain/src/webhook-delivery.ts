import type { ContentDigest } from "./artifact-registry.js";
import { parseContentDigest } from "./artifact-registry.js";
import type { UtcInstant } from "./resource-identities.js";
import {
  InvalidDomainValueError,
  parseUtcInstant,
} from "./resource-identities.js";

const opaqueIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const boundedIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

declare const integrationEventIdBrand: unique symbol;
declare const webhookDeliveryIdBrand: unique symbol;
declare const webhookDestinationIdBrand: unique symbol;

export type IntegrationEventId = string & {
  readonly [integrationEventIdBrand]: true;
};
export type WebhookDeliveryId = string & {
  readonly [webhookDeliveryIdBrand]: true;
};
export type WebhookDestinationId = string & {
  readonly [webhookDestinationIdBrand]: true;
};
export type WebhookDeliveryState =
  | "dead-lettered"
  | "delivered"
  | "delivering"
  | "pending"
  | "retrying";

export interface WebhookAttemptEvidence {
  readonly attempt: number;
  readonly startedAt: UtcInstant;
  readonly completedAt?: UtcInstant;
  readonly outcome: "delivered" | "failed" | "in-flight";
  readonly statusCode?: number;
  readonly failureCode?: string;
  readonly retryable?: boolean;
}

export interface WebhookDelivery {
  readonly deliveryId: WebhookDeliveryId;
  readonly eventId: IntegrationEventId;
  readonly eventType: string;
  readonly destinationId: WebhookDestinationId;
  readonly payloadDigest: ContentDigest;
  readonly createdAt: UtcInstant;
  readonly state: WebhookDeliveryState;
  readonly maxAttempts: number;
  readonly attempts: number;
  readonly redriveCount: number;
  readonly nextAttemptAt?: UtcInstant;
  readonly deliveredAt?: UtcInstant;
  readonly deadLetteredAt?: UtcInstant;
  readonly attemptEvidence: readonly WebhookAttemptEvidence[];
  readonly revision: number;
}

export class WebhookDeliveryTransitionError extends Error {
  readonly code = "invalid-webhook-delivery-transition";

  constructor(message: string) {
    super(message);
    this.name = "WebhookDeliveryTransitionError";
  }
}

function parseOpaqueIdentifier(input: unknown, field: string): string {
  if (typeof input !== "string" || !opaqueIdentifier.test(input)) {
    throw new InvalidDomainValueError(
      field,
      `${field} must be an opaque 8-128 character identifier`,
    );
  }
  return input;
}

function parseIdentifier(input: unknown, field: string): string {
  if (typeof input !== "string" || !boundedIdentifier.test(input)) {
    throw new InvalidDomainValueError(
      field,
      `${field} must be a bounded identifier`,
    );
  }
  return input;
}

export function parseIntegrationEventId(input: unknown): IntegrationEventId {
  return parseOpaqueIdentifier(
    input,
    "integrationEventId",
  ) as IntegrationEventId;
}

export function parseWebhookDeliveryId(input: unknown): WebhookDeliveryId {
  return parseOpaqueIdentifier(input, "webhookDeliveryId") as WebhookDeliveryId;
}

export function parseWebhookDestinationId(
  input: unknown,
): WebhookDestinationId {
  return parseOpaqueIdentifier(
    input,
    "webhookDestinationId",
  ) as WebhookDestinationId;
}

function freezeAttempt(
  evidence: WebhookAttemptEvidence,
): WebhookAttemptEvidence {
  return Object.freeze({ ...evidence });
}

function freezeDelivery(delivery: WebhookDelivery): WebhookDelivery {
  return Object.freeze({
    ...delivery,
    attemptEvidence: Object.freeze(delivery.attemptEvidence.map(freezeAttempt)),
  });
}

export function createWebhookDelivery(input: {
  readonly deliveryId: WebhookDeliveryId;
  readonly eventId: IntegrationEventId;
  readonly eventType: string;
  readonly destinationId: WebhookDestinationId;
  readonly payloadDigest: ContentDigest;
  readonly createdAt: UtcInstant;
  readonly maxAttempts: number;
}): WebhookDelivery {
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
  return freezeDelivery({
    deliveryId: parseWebhookDeliveryId(input.deliveryId),
    eventId: parseIntegrationEventId(input.eventId),
    eventType: parseIdentifier(input.eventType, "eventType"),
    destinationId: parseWebhookDestinationId(input.destinationId),
    payloadDigest: parseContentDigest(input.payloadDigest),
    createdAt: parseUtcInstant(input.createdAt),
    state: "pending",
    maxAttempts: input.maxAttempts,
    attempts: 0,
    redriveCount: 0,
    attemptEvidence: [],
    revision: 1,
  });
}

export function beginWebhookDelivery(
  delivery: WebhookDelivery,
  startedAt: UtcInstant,
): WebhookDelivery {
  if (delivery.state === "delivering") return delivery;
  if (delivery.state !== "pending" && delivery.state !== "retrying") {
    throw new WebhookDeliveryTransitionError(
      `delivery cannot begin from ${delivery.state}`,
    );
  }
  const at = parseUtcInstant(startedAt);
  if (delivery.nextAttemptAt !== undefined && at < delivery.nextAttemptAt) {
    throw new WebhookDeliveryTransitionError("delivery retry is not due");
  }
  if (delivery.attempts >= delivery.maxAttempts) {
    throw new WebhookDeliveryTransitionError(
      "delivery attempt budget is exhausted",
    );
  }
  const attempt = delivery.attempts + 1;
  return freezeDelivery({
    ...delivery,
    state: "delivering",
    attempts: attempt,
    attemptEvidence: [
      ...delivery.attemptEvidence,
      Object.freeze({ attempt, startedAt: at, outcome: "in-flight" }),
    ],
    revision: delivery.revision + 1,
  });
}

function replaceCurrentAttempt(
  delivery: WebhookDelivery,
  evidence: WebhookAttemptEvidence,
): readonly WebhookAttemptEvidence[] {
  const prior = delivery.attemptEvidence.at(-1);
  if (
    prior === undefined ||
    prior.attempt !== delivery.attempts ||
    prior.outcome !== "in-flight"
  ) {
    throw new WebhookDeliveryTransitionError(
      "delivery has no in-flight attempt evidence",
    );
  }
  return Object.freeze([
    ...delivery.attemptEvidence.slice(0, -1),
    freezeAttempt(evidence),
  ]);
}

export function succeedWebhookDelivery(
  delivery: WebhookDelivery,
  statusCode: number,
  completedAt: UtcInstant,
): WebhookDelivery {
  if (delivery.state !== "delivering") {
    throw new WebhookDeliveryTransitionError(
      `success is invalid from ${delivery.state}`,
    );
  }
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode > 299) {
    throw new InvalidDomainValueError(
      "statusCode",
      "a successful Webhook status must be from 200 through 299",
    );
  }
  const at = parseUtcInstant(completedAt);
  const current = delivery.attemptEvidence.at(-1);
  if (current !== undefined && at < current.startedAt) {
    throw new WebhookDeliveryTransitionError(
      "delivery completion precedes its attempt",
    );
  }
  return freezeDelivery({
    ...delivery,
    state: "delivered",
    deliveredAt: at,
    attemptEvidence: replaceCurrentAttempt(delivery, {
      attempt: delivery.attempts,
      startedAt: current?.startedAt ?? at,
      completedAt: at,
      outcome: "delivered",
      statusCode,
    }),
    revision: delivery.revision + 1,
  });
}

export function failWebhookDelivery(
  delivery: WebhookDelivery,
  input: {
    readonly completedAt: UtcInstant;
    readonly failureCode: string;
    readonly retryable: boolean;
    readonly nextAttemptAt?: UtcInstant;
  },
): WebhookDelivery {
  if (delivery.state !== "delivering") {
    throw new WebhookDeliveryTransitionError(
      `failure is invalid from ${delivery.state}`,
    );
  }
  const completedAt = parseUtcInstant(input.completedAt);
  const current = delivery.attemptEvidence.at(-1);
  if (current !== undefined && completedAt < current.startedAt) {
    throw new WebhookDeliveryTransitionError(
      "delivery completion precedes its attempt",
    );
  }
  const failureCode = parseIdentifier(input.failureCode, "failureCode");
  const willRetry = input.retryable && delivery.attempts < delivery.maxAttempts;
  const attemptEvidence = replaceCurrentAttempt(delivery, {
    attempt: delivery.attempts,
    startedAt: current?.startedAt ?? completedAt,
    completedAt,
    outcome: "failed",
    failureCode,
    retryable: input.retryable,
  });
  if (willRetry) {
    if (input.nextAttemptAt === undefined) {
      throw new InvalidDomainValueError(
        "nextAttemptAt",
        "a retryable failure requires nextAttemptAt",
      );
    }
    const nextAttemptAt = parseUtcInstant(input.nextAttemptAt);
    if (nextAttemptAt <= completedAt) {
      throw new InvalidDomainValueError(
        "nextAttemptAt",
        "nextAttemptAt must follow failure completion",
      );
    }
    return freezeDelivery({
      ...delivery,
      state: "retrying",
      nextAttemptAt,
      attemptEvidence,
      revision: delivery.revision + 1,
    });
  }
  const { nextAttemptAt: priorSchedule, ...withoutSchedule } = delivery;
  void priorSchedule;
  return freezeDelivery({
    ...withoutSchedule,
    state: "dead-lettered",
    deadLetteredAt: completedAt,
    attemptEvidence,
    revision: delivery.revision + 1,
  });
}

export function redriveWebhookDelivery(
  delivery: WebhookDelivery,
  requestedAt: UtcInstant,
): WebhookDelivery {
  if (delivery.state !== "dead-lettered") {
    throw new WebhookDeliveryTransitionError(
      `redrive is invalid from ${delivery.state}`,
    );
  }
  return freezeDelivery({
    ...delivery,
    state: "pending",
    attempts: 0,
    redriveCount: delivery.redriveCount + 1,
    nextAttemptAt: parseUtcInstant(requestedAt),
    revision: delivery.revision + 1,
  });
}
