import {
  InvalidDomainValueError,
  WebhookDeliveryTransitionError,
  beginWebhookDelivery,
  createWebhookDelivery,
  failWebhookDelivery,
  parseContentDigest,
  parseIntegrationEventId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  parseWebhookDeliveryId,
  parseWebhookDestinationId,
  redriveWebhookDelivery,
  succeedWebhookDelivery,
} from "@aether-cloud/domain";
import type {
  UtcInstant,
  WebhookDelivery,
  WebhookAttemptEvidence,
} from "@aether-cloud/domain";

import {
  ENQUEUE_WEBHOOK_DELIVERY_COMMAND,
  PROCESS_WEBHOOK_DELIVERY_COMMAND,
  REDRIVE_WEBHOOK_DELIVERY_COMMAND,
} from "./capability-definition.js";
import type {
  WebhookDeliveryRepository,
  WebhookDeliveryScope,
  WebhookSender,
} from "./webhook-delivery-repository.js";

type WebhookFailureCode =
  | "command-expired"
  | "confirmation-required"
  | "invalid-input"
  | "permission-denied"
  | "webhook-delivery-conflict"
  | "webhook-delivery-not-found"
  | "webhook-idempotency-conflict"
  | "webhook-not-due"
  | "webhook-sender-invalid-response"
  | "webhook-storage-unavailable"
  | "webhook-transition-invalid"
  | "webhook-version-conflict";

export interface WebhookApplicationFailure {
  readonly code: WebhookFailureCode;
  readonly message: string;
}

export type WebhookApplicationResult<Value> =
  | Readonly<{ ok: true; replayed: boolean; value: Value }>
  | Readonly<{ ok: false; failure: WebhookApplicationFailure }>;

export interface WebhookAttemptView {
  readonly attempt: number;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly outcome: string;
  readonly statusCode?: number;
  readonly failureCode?: string;
  readonly retryable?: boolean;
}

export interface WebhookDeliveryView {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly destinationId: string;
  readonly payloadDigest: string;
  readonly state: WebhookDelivery["state"];
  readonly maxAttempts: number;
  readonly attempts: number;
  readonly redriveCount: number;
  readonly nextAttemptAt: string | null;
  readonly attemptEvidence: readonly WebhookAttemptView[];
  readonly revision: number;
}

export interface WebhookApplicationClock {
  now(): string;
}

interface CommandContext extends WebhookDeliveryScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
  readonly confirmation: "confirmed" | "not-confirmed";
  readonly requestId: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

class WebhookInputError extends Error {}

function failure(
  code: WebhookFailureCode,
  message: string,
): Readonly<{ ok: false; failure: WebhookApplicationFailure }> {
  return { ok: false, failure: { code, message } };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function requireRecord(input: unknown, name: string): Record<string, unknown> {
  if (!isRecord(input))
    throw new WebhookInputError(`${name} must be an object`);
  return input;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(record).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new WebhookInputError(
      `${name} must contain exactly: ${canonical.join(", ")}`,
    );
  }
}

function requireIdentifier(input: unknown, name: string): string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)
  ) {
    throw new WebhookInputError(`${name} must be a bounded identifier`);
  }
  return input;
}

function requireRequestId(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input)
  ) {
    throw new WebhookInputError("idempotencyKey is invalid");
  }
  return input;
}

function decodePermissions(input: unknown): ReadonlySet<string> {
  if (
    !Array.isArray(input) ||
    input.some((permission) => typeof permission !== "string")
  ) {
    throw new WebhookInputError("permissions must be an array of strings");
  }
  return new Set(input);
}

function decodeContext(input: unknown): CommandContext {
  const record = requireRecord(input, "Webhook command context");
  requireExactKeys(
    record,
    [
      "confirmation",
      "expiresAt",
      "idempotencyKey",
      "issuedAt",
      "permissions",
      "projectId",
      "subjectId",
      "tenantId",
    ],
    "Webhook command context",
  );
  if (
    record.confirmation !== "confirmed" &&
    record.confirmation !== "not-confirmed"
  ) {
    throw new WebhookInputError("confirmation is invalid");
  }
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
    subjectId: requireIdentifier(record.subjectId, "subjectId"),
    permissions: decodePermissions(record.permissions),
    confirmation: record.confirmation,
    requestId: requireRequestId(record.idempotencyKey),
    issuedAt: parseUtcInstant(record.issuedAt),
    expiresAt: parseUtcInstant(record.expiresAt),
  };
}

function decodeEnqueueInput(input: unknown) {
  const record = requireRecord(input, "enqueue Webhook input");
  requireExactKeys(
    record,
    [
      "deliveryId",
      "destinationId",
      "eventId",
      "eventType",
      "maxAttempts",
      "payloadDigest",
    ],
    "enqueue Webhook input",
  );
  if (typeof record.maxAttempts !== "number") {
    throw new WebhookInputError("maxAttempts must be a number");
  }
  return {
    deliveryId: parseWebhookDeliveryId(record.deliveryId),
    eventId: parseIntegrationEventId(record.eventId),
    eventType: requireIdentifier(record.eventType, "eventType"),
    destinationId: parseWebhookDestinationId(record.destinationId),
    payloadDigest: parseContentDigest(record.payloadDigest),
    maxAttempts: record.maxAttempts,
  };
}

function decodeDeliveryId(input: unknown) {
  const record = requireRecord(input, "Webhook delivery identity");
  requireExactKeys(record, ["deliveryId"], "Webhook delivery identity");
  return parseWebhookDeliveryId(record.deliveryId);
}

function decodeSafely<Value>(
  decoder: () => Value,
):
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: WebhookApplicationFailure }> {
  try {
    return { ok: true, value: decoder() };
  } catch (error: unknown) {
    if (
      error instanceof WebhookInputError ||
      error instanceof InvalidDomainValueError
    ) {
      return failure("invalid-input", error.message);
    }
    throw error;
  }
}

function transitionSafely(
  transition: () => WebhookDelivery,
):
  | Readonly<{ ok: true; value: WebhookDelivery }>
  | Readonly<{ ok: false; failure: WebhookApplicationFailure }> {
  try {
    return { ok: true, value: transition() };
  } catch (error: unknown) {
    if (error instanceof WebhookDeliveryTransitionError) {
      return failure(
        error.message.includes("not due")
          ? "webhook-not-due"
          : "webhook-transition-invalid",
        error.message,
      );
    }
    if (error instanceof InvalidDomainValueError) {
      return failure("invalid-input", error.message);
    }
    throw error;
  }
}

function authorize(
  context: CommandContext,
  permission: string,
): WebhookApplicationFailure | undefined {
  return context.permissions.has(permission)
    ? undefined
    : {
        code: "permission-denied",
        message: `permission ${permission} is required`,
      };
}

function validateTime(
  context: CommandContext,
  now: UtcInstant,
): WebhookApplicationFailure | undefined {
  if (context.expiresAt <= context.issuedAt || context.issuedAt > now) {
    return { code: "invalid-input", message: "command time window is invalid" };
  }
  return now >= context.expiresAt
    ? { code: "command-expired", message: "command has expired" }
    : undefined;
}

function toAttemptView(evidence: WebhookAttemptEvidence): WebhookAttemptView {
  return Object.freeze({
    attempt: evidence.attempt,
    startedAt: evidence.startedAt,
    outcome: evidence.outcome,
    ...(evidence.completedAt === undefined
      ? {}
      : { completedAt: evidence.completedAt }),
    ...(evidence.statusCode === undefined
      ? {}
      : { statusCode: evidence.statusCode }),
    ...(evidence.failureCode === undefined
      ? {}
      : { failureCode: evidence.failureCode }),
    ...(evidence.retryable === undefined
      ? {}
      : { retryable: evidence.retryable }),
  });
}

function toView(delivery: WebhookDelivery): WebhookDeliveryView {
  return Object.freeze({
    deliveryId: delivery.deliveryId,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    destinationId: delivery.destinationId,
    payloadDigest: delivery.payloadDigest,
    state: delivery.state,
    maxAttempts: delivery.maxAttempts,
    attempts: delivery.attempts,
    redriveCount: delivery.redriveCount,
    nextAttemptAt: delivery.nextAttemptAt ?? null,
    attemptEvidence: Object.freeze(delivery.attemptEvidence.map(toAttemptView)),
    revision: delivery.revision,
  });
}

function mapInsertFailure(
  outcome: "already-exists" | "idempotency-conflict" | "storage-unavailable",
) {
  const codes = {
    "already-exists": "webhook-delivery-conflict",
    "idempotency-conflict": "webhook-idempotency-conflict",
    "storage-unavailable": "webhook-storage-unavailable",
  } as const;
  return failure(codes[outcome], "Webhook delivery enqueue was rejected");
}

function mapReplaceFailure(
  outcome:
    | "idempotency-conflict"
    | "not-found"
    | "storage-unavailable"
    | "version-conflict",
) {
  const codes = {
    "idempotency-conflict": "webhook-idempotency-conflict",
    "not-found": "webhook-delivery-not-found",
    "storage-unavailable": "webhook-storage-unavailable",
    "version-conflict": "webhook-version-conflict",
  } as const;
  return failure(codes[outcome], "Webhook delivery update was rejected");
}

function decodeCommand(
  rawContext: unknown,
  rawNow: string,
):
  | Readonly<{ ok: true; context: CommandContext; now: UtcInstant }>
  | Readonly<{ ok: false; failure: WebhookApplicationFailure }> {
  const decodedContext = decodeSafely(() => decodeContext(rawContext));
  if (!decodedContext.ok) return decodedContext;
  const decodedNow = decodeSafely(() => parseUtcInstant(rawNow));
  if (!decodedNow.ok) return decodedNow;
  const timeFailure = validateTime(decodedContext.value, decodedNow.value);
  return timeFailure === undefined
    ? { ok: true, context: decodedContext.value, now: decodedNow.value }
    : { ok: false, failure: timeFailure };
}

export class EnqueueWebhookDelivery {
  static readonly capability = ENQUEUE_WEBHOOK_DELIVERY_COMMAND;
  readonly #repository: WebhookDeliveryRepository;
  readonly #clock: WebhookApplicationClock;

  constructor(dependencies: {
    readonly repository: WebhookDeliveryRepository;
    readonly clock: WebhookApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<WebhookApplicationResult<WebhookDeliveryView>> {
    const decoded = decodeCommand(rawContext, this.#clock.now());
    if (!decoded.ok) return decoded;
    const authorization = authorize(
      decoded.context,
      EnqueueWebhookDelivery.capability.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    const decodedInput = decodeSafely(() => decodeEnqueueInput(rawInput));
    if (!decodedInput.ok) return decodedInput;
    const delivery = decodeSafely(() =>
      createWebhookDelivery({
        ...decodedInput.value,
        createdAt: decoded.now,
      }),
    );
    if (!delivery.ok) return delivery;
    const persisted = await this.#repository.insert({
      tenantId: decoded.context.tenantId,
      projectId: decoded.context.projectId,
      requestId: decoded.context.requestId,
      subjectId: decoded.context.subjectId,
      delivery: delivery.value,
    });
    if (persisted.outcome === "inserted" || persisted.outcome === "replayed") {
      return {
        ok: true,
        replayed: persisted.outcome === "replayed",
        value: toView(persisted.delivery),
      };
    }
    return mapInsertFailure(persisted.outcome);
  }
}

function nextAttempt(now: UtcInstant, seconds: number): UtcInstant {
  return parseUtcInstant(
    new Date(Date.parse(now) + seconds * 1000).toISOString(),
  );
}

export class ProcessWebhookDelivery {
  static readonly capability = PROCESS_WEBHOOK_DELIVERY_COMMAND;
  readonly #repository: WebhookDeliveryRepository;
  readonly #sender: WebhookSender;
  readonly #clock: WebhookApplicationClock;

  constructor(dependencies: {
    readonly repository: WebhookDeliveryRepository;
    readonly sender: WebhookSender;
    readonly clock: WebhookApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#sender = dependencies.sender;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<WebhookApplicationResult<WebhookDeliveryView>> {
    const decoded = decodeCommand(rawContext, this.#clock.now());
    if (!decoded.ok) return decoded;
    const authorization = authorize(
      decoded.context,
      ProcessWebhookDelivery.capability.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    const deliveryId = decodeSafely(() => decodeDeliveryId(rawInput));
    if (!deliveryId.ok) return deliveryId;
    const current = await this.#repository.find(
      decoded.context,
      deliveryId.value,
    );
    if (current === undefined) {
      return failure(
        "webhook-delivery-not-found",
        "Webhook delivery was not found",
      );
    }
    if (current.state === "delivered" || current.state === "dead-lettered") {
      return { ok: true, replayed: true, value: toView(current) };
    }
    const begun = transitionSafely(() =>
      beginWebhookDelivery(current, decoded.now),
    );
    if (!begun.ok) return begun;
    const persistedBegin = await this.#repository.replace({
      tenantId: decoded.context.tenantId,
      projectId: decoded.context.projectId,
      requestId: `${decoded.context.requestId}:begin`,
      subjectId: decoded.context.subjectId,
      expectedRevision: current.revision,
      delivery: begun.value,
      eventName: "integration.webhook-delivery-state-changed.v1",
    });
    if (
      persistedBegin.outcome !== "replaced" &&
      persistedBegin.outcome !== "replayed"
    ) {
      return mapReplaceFailure(persistedBegin.outcome);
    }
    const active = persistedBegin.delivery;
    const sent = await this.#sender.send({
      deliveryId: active.deliveryId,
      eventId: active.eventId,
      eventType: active.eventType,
      destinationId: active.destinationId,
      payloadDigest: active.payloadDigest,
      idempotencyKey: active.deliveryId,
    });
    let completed: WebhookDelivery;
    if (sent.ok) {
      const result = transitionSafely(() =>
        succeedWebhookDelivery(active, sent.statusCode, decoded.now),
      );
      if (!result.ok) {
        return failure(
          "webhook-sender-invalid-response",
          result.failure.message,
        );
      }
      completed = result.value;
    } else {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sent.failureCode) ||
        (sent.retryAfterSeconds !== undefined &&
          (!Number.isInteger(sent.retryAfterSeconds) ||
            sent.retryAfterSeconds < 1 ||
            sent.retryAfterSeconds > 3600))
      ) {
        return failure(
          "webhook-sender-invalid-response",
          "Webhook sender returned invalid failure metadata",
        );
      }
      const retryAfterSeconds = sent.retryAfterSeconds ?? 30;
      const result = transitionSafely(() =>
        failWebhookDelivery(active, {
          completedAt: decoded.now,
          failureCode: sent.failureCode,
          retryable: sent.retryable,
          ...(sent.retryable
            ? { nextAttemptAt: nextAttempt(decoded.now, retryAfterSeconds) }
            : {}),
        }),
      );
      if (!result.ok) return result;
      completed = result.value;
    }
    const persistedCompletion = await this.#repository.replace({
      tenantId: decoded.context.tenantId,
      projectId: decoded.context.projectId,
      requestId: `${decoded.context.requestId}:complete`,
      subjectId: decoded.context.subjectId,
      expectedRevision: active.revision,
      delivery: completed,
      eventName: "integration.webhook-delivery-state-changed.v1",
    });
    if (
      persistedCompletion.outcome === "replaced" ||
      persistedCompletion.outcome === "replayed"
    ) {
      return {
        ok: true,
        replayed: persistedCompletion.outcome === "replayed",
        value: toView(persistedCompletion.delivery),
      };
    }
    return mapReplaceFailure(persistedCompletion.outcome);
  }
}

export class RedriveWebhookDelivery {
  static readonly capability = REDRIVE_WEBHOOK_DELIVERY_COMMAND;
  readonly #repository: WebhookDeliveryRepository;
  readonly #clock: WebhookApplicationClock;

  constructor(dependencies: {
    readonly repository: WebhookDeliveryRepository;
    readonly clock: WebhookApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<WebhookApplicationResult<WebhookDeliveryView>> {
    const decoded = decodeCommand(rawContext, this.#clock.now());
    if (!decoded.ok) return decoded;
    const authorization = authorize(
      decoded.context,
      RedriveWebhookDelivery.capability.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    if (decoded.context.confirmation !== "confirmed") {
      return failure(
        "confirmation-required",
        "Webhook redrive requires explicit confirmation",
      );
    }
    const deliveryId = decodeSafely(() => decodeDeliveryId(rawInput));
    if (!deliveryId.ok) return deliveryId;
    const current = await this.#repository.find(
      decoded.context,
      deliveryId.value,
    );
    if (current === undefined) {
      return failure(
        "webhook-delivery-not-found",
        "Webhook delivery was not found",
      );
    }
    const redriven = transitionSafely(() =>
      redriveWebhookDelivery(current, decoded.now),
    );
    if (!redriven.ok) return redriven;
    const persisted = await this.#repository.replace({
      tenantId: decoded.context.tenantId,
      projectId: decoded.context.projectId,
      requestId: decoded.context.requestId,
      subjectId: decoded.context.subjectId,
      expectedRevision: current.revision,
      delivery: redriven.value,
      eventName: "integration.webhook-delivery-state-changed.v1",
    });
    if (persisted.outcome === "replaced" || persisted.outcome === "replayed") {
      return {
        ok: true,
        replayed: persisted.outcome === "replayed",
        value: toView(persisted.delivery),
      };
    }
    return mapReplaceFailure(persisted.outcome);
  }
}
