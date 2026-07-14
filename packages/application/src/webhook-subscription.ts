import {
  InvalidDomainValueError,
  WebhookSubscriptionTransitionError,
  createWebhookSubscription,
  disableWebhookSubscription,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  parseWebhookDestinationId,
  parseWebhookSubscriptionId,
} from "@aether-cloud/domain";
import type { UtcInstant, WebhookSubscription } from "@aether-cloud/domain";

import {
  CREATE_WEBHOOK_SUBSCRIPTION_COMMAND,
  DISABLE_WEBHOOK_SUBSCRIPTION_COMMAND,
  GET_WEBHOOK_SUBSCRIPTION_QUERY,
} from "./capability-definition.js";
import type {
  WebhookSubscriptionRepository,
  WebhookSubscriptionScope,
} from "./webhook-subscription-repository.js";

type SubscriptionFailureCode =
  | "command-expired"
  | "confirmation-required"
  | "invalid-input"
  | "permission-denied"
  | "webhook-subscription-conflict"
  | "webhook-subscription-idempotency-conflict"
  | "webhook-subscription-not-found"
  | "webhook-subscription-storage-unavailable"
  | "webhook-subscription-transition-invalid"
  | "webhook-subscription-version-conflict";

export interface WebhookSubscriptionApplicationFailure {
  readonly code: SubscriptionFailureCode;
  readonly message: string;
}

export type WebhookSubscriptionApplicationResult<Value> =
  | Readonly<{ ok: true; replayed: boolean; value: Value }>
  | Readonly<{ ok: false; failure: WebhookSubscriptionApplicationFailure }>;

export type WebhookSubscriptionQueryResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: WebhookSubscriptionApplicationFailure }>;

export interface WebhookSubscriptionView {
  readonly subscriptionId: string;
  readonly destinationId: string;
  readonly eventTypes: readonly string[];
  readonly maxAttempts: number;
  readonly state: WebhookSubscription["state"];
  readonly createdAt: string;
  readonly disabledAt: string | null;
  readonly revision: number;
}

export interface WebhookSubscriptionApplicationClock {
  now(): string;
}

interface CommandContext extends WebhookSubscriptionScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
  readonly confirmation: "confirmed" | "not-confirmed";
  readonly requestId: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

interface QueryContext extends WebhookSubscriptionScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
}

class SubscriptionInputError extends Error {}

function failure(
  code: SubscriptionFailureCode,
  message: string,
): Readonly<{
  ok: false;
  failure: WebhookSubscriptionApplicationFailure;
}> {
  return { ok: false, failure: { code, message } };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function requireRecord(input: unknown, name: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new SubscriptionInputError(`${name} must be an object`);
  }
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
    throw new SubscriptionInputError(
      `${name} must contain exactly: ${canonical.join(", ")}`,
    );
  }
}

function requireIdentifier(input: unknown, name: string): string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)
  ) {
    throw new SubscriptionInputError(`${name} must be a bounded identifier`);
  }
  return input;
}

function requireRequestId(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input)
  ) {
    throw new SubscriptionInputError("idempotencyKey is invalid");
  }
  return input;
}

function decodePermissions(input: unknown): ReadonlySet<string> {
  if (
    !Array.isArray(input) ||
    input.some((permission) => typeof permission !== "string")
  ) {
    throw new SubscriptionInputError("permissions must be an array of strings");
  }
  return new Set(input);
}

function decodeScope(
  record: Record<string, unknown>,
): WebhookSubscriptionScope {
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
  };
}

function decodeCommandContext(input: unknown): CommandContext {
  const record = requireRecord(input, "Webhook subscription command context");
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
    "Webhook subscription command context",
  );
  if (
    record.confirmation !== "confirmed" &&
    record.confirmation !== "not-confirmed"
  ) {
    throw new SubscriptionInputError("confirmation is invalid");
  }
  return {
    ...decodeScope(record),
    subjectId: requireIdentifier(record.subjectId, "subjectId"),
    permissions: decodePermissions(record.permissions),
    confirmation: record.confirmation,
    requestId: requireRequestId(record.idempotencyKey),
    issuedAt: parseUtcInstant(record.issuedAt),
    expiresAt: parseUtcInstant(record.expiresAt),
  };
}

function decodeQueryContext(input: unknown): QueryContext {
  const record = requireRecord(input, "Webhook subscription query context");
  requireExactKeys(
    record,
    ["permissions", "projectId", "subjectId", "tenantId"],
    "Webhook subscription query context",
  );
  return {
    ...decodeScope(record),
    subjectId: requireIdentifier(record.subjectId, "subjectId"),
    permissions: decodePermissions(record.permissions),
  };
}

function decodeCreateInput(input: unknown) {
  const record = requireRecord(input, "create Webhook subscription input");
  requireExactKeys(
    record,
    ["destinationId", "eventTypes", "maxAttempts", "subscriptionId"],
    "create Webhook subscription input",
  );
  if (
    !Array.isArray(record.eventTypes) ||
    record.eventTypes.some((value) => typeof value !== "string")
  ) {
    throw new SubscriptionInputError("eventTypes must be an array of strings");
  }
  if (typeof record.maxAttempts !== "number") {
    throw new SubscriptionInputError("maxAttempts must be a number");
  }
  return {
    subscriptionId: parseWebhookSubscriptionId(record.subscriptionId),
    destinationId: parseWebhookDestinationId(record.destinationId),
    eventTypes: record.eventTypes,
    maxAttempts: record.maxAttempts,
  };
}

function decodeSubscriptionId(input: unknown) {
  const record = requireRecord(input, "Webhook subscription identity");
  requireExactKeys(record, ["subscriptionId"], "Webhook subscription identity");
  return parseWebhookSubscriptionId(record.subscriptionId);
}

function decodeSafely<Value>(decoder: () => Value):
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{
      ok: false;
      failure: WebhookSubscriptionApplicationFailure;
    }> {
  try {
    return { ok: true, value: decoder() };
  } catch (error: unknown) {
    if (
      error instanceof SubscriptionInputError ||
      error instanceof InvalidDomainValueError
    ) {
      return failure("invalid-input", error.message);
    }
    throw error;
  }
}

function transitionSafely(transition: () => WebhookSubscription):
  | Readonly<{ ok: true; value: WebhookSubscription }>
  | Readonly<{
      ok: false;
      failure: WebhookSubscriptionApplicationFailure;
    }> {
  try {
    return { ok: true, value: transition() };
  } catch (error: unknown) {
    if (error instanceof WebhookSubscriptionTransitionError) {
      return failure("webhook-subscription-transition-invalid", error.message);
    }
    throw error;
  }
}

function authorize(
  permissions: ReadonlySet<string>,
  permission: string,
): WebhookSubscriptionApplicationFailure | undefined {
  return permissions.has(permission)
    ? undefined
    : {
        code: "permission-denied",
        message: `permission ${permission} is required`,
      };
}

function validateTime(
  context: CommandContext,
  now: UtcInstant,
): WebhookSubscriptionApplicationFailure | undefined {
  if (context.expiresAt <= context.issuedAt || context.issuedAt > now) {
    return { code: "invalid-input", message: "command time window is invalid" };
  }
  return now >= context.expiresAt
    ? { code: "command-expired", message: "command has expired" }
    : undefined;
}

function toView(subscription: WebhookSubscription): WebhookSubscriptionView {
  return Object.freeze({
    subscriptionId: subscription.subscriptionId,
    destinationId: subscription.destinationId,
    eventTypes: Object.freeze([...subscription.eventTypes]),
    maxAttempts: subscription.maxAttempts,
    state: subscription.state,
    createdAt: subscription.createdAt,
    disabledAt: subscription.disabledAt ?? null,
    revision: subscription.revision,
  });
}

function mapInsertFailure(
  outcome: "already-exists" | "idempotency-conflict" | "storage-unavailable",
) {
  const codes = {
    "already-exists": "webhook-subscription-conflict",
    "idempotency-conflict": "webhook-subscription-idempotency-conflict",
    "storage-unavailable": "webhook-subscription-storage-unavailable",
  } as const;
  return failure(codes[outcome], "Webhook subscription creation was rejected");
}

function mapReplaceFailure(
  outcome:
    | "idempotency-conflict"
    | "not-found"
    | "storage-unavailable"
    | "version-conflict",
) {
  const codes = {
    "idempotency-conflict": "webhook-subscription-idempotency-conflict",
    "not-found": "webhook-subscription-not-found",
    "storage-unavailable": "webhook-subscription-storage-unavailable",
    "version-conflict": "webhook-subscription-version-conflict",
  } as const;
  return failure(codes[outcome], "Webhook subscription update was rejected");
}

export class CreateWebhookSubscription {
  static readonly capability = CREATE_WEBHOOK_SUBSCRIPTION_COMMAND;
  readonly #repository: WebhookSubscriptionRepository;
  readonly #clock: WebhookSubscriptionApplicationClock;

  constructor(dependencies: {
    readonly repository: WebhookSubscriptionRepository;
    readonly clock: WebhookSubscriptionApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<WebhookSubscriptionApplicationResult<WebhookSubscriptionView>> {
    const context = decodeSafely(() => decodeCommandContext(rawContext));
    if (!context.ok) return context;
    const authorization = authorize(
      context.value.permissions,
      CreateWebhookSubscription.capability.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    if (context.value.confirmation !== "confirmed") {
      return failure(
        "confirmation-required",
        "Webhook subscription creation requires explicit confirmation",
      );
    }
    const now = decodeSafely(() => parseUtcInstant(this.#clock.now()));
    if (!now.ok) return now;
    const timeFailure = validateTime(context.value, now.value);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    const input = decodeSafely(() => decodeCreateInput(rawInput));
    if (!input.ok) return input;
    const subscription = decodeSafely(() =>
      createWebhookSubscription({
        ...input.value,
        createdAt: now.value,
      }),
    );
    if (!subscription.ok) return subscription;
    const persisted = await this.#repository.insert({
      tenantId: context.value.tenantId,
      projectId: context.value.projectId,
      requestId: context.value.requestId,
      subjectId: context.value.subjectId,
      subscription: subscription.value,
    });
    if (persisted.outcome === "inserted" || persisted.outcome === "replayed") {
      return {
        ok: true,
        replayed: persisted.outcome === "replayed",
        value: toView(persisted.subscription),
      };
    }
    return mapInsertFailure(persisted.outcome);
  }
}

export class DisableWebhookSubscription {
  static readonly capability = DISABLE_WEBHOOK_SUBSCRIPTION_COMMAND;
  readonly #repository: WebhookSubscriptionRepository;
  readonly #clock: WebhookSubscriptionApplicationClock;

  constructor(dependencies: {
    readonly repository: WebhookSubscriptionRepository;
    readonly clock: WebhookSubscriptionApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<WebhookSubscriptionApplicationResult<WebhookSubscriptionView>> {
    const context = decodeSafely(() => decodeCommandContext(rawContext));
    if (!context.ok) return context;
    const authorization = authorize(
      context.value.permissions,
      DisableWebhookSubscription.capability.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    const now = decodeSafely(() => parseUtcInstant(this.#clock.now()));
    if (!now.ok) return now;
    const timeFailure = validateTime(context.value, now.value);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    const identity = decodeSafely(() => decodeSubscriptionId(rawInput));
    if (!identity.ok) return identity;
    const current = await this.#repository.find(context.value, identity.value);
    if (current === undefined) {
      return failure(
        "webhook-subscription-not-found",
        "Webhook subscription was not found",
      );
    }
    const disabled = transitionSafely(() =>
      disableWebhookSubscription(current, now.value),
    );
    if (!disabled.ok) return disabled;
    const persisted = await this.#repository.replace({
      tenantId: context.value.tenantId,
      projectId: context.value.projectId,
      requestId: context.value.requestId,
      subjectId: context.value.subjectId,
      expectedRevision: current.revision,
      subscription: disabled.value,
    });
    if (persisted.outcome === "replaced" || persisted.outcome === "replayed") {
      return {
        ok: true,
        replayed: persisted.outcome === "replayed",
        value: toView(persisted.subscription),
      };
    }
    return mapReplaceFailure(persisted.outcome);
  }
}

export class GetWebhookSubscription {
  static readonly capability = GET_WEBHOOK_SUBSCRIPTION_QUERY;
  readonly #repository: WebhookSubscriptionRepository;

  constructor(dependencies: {
    readonly repository: WebhookSubscriptionRepository;
  }) {
    this.#repository = dependencies.repository;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<WebhookSubscriptionQueryResult<WebhookSubscriptionView>> {
    const context = decodeSafely(() => decodeQueryContext(rawContext));
    if (!context.ok) return context;
    const authorization = authorize(
      context.value.permissions,
      GetWebhookSubscription.capability.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    const identity = decodeSafely(() => decodeSubscriptionId(rawInput));
    if (!identity.ok) return identity;
    const subscription = await this.#repository.find(
      context.value,
      identity.value,
    );
    return subscription === undefined
      ? failure(
          "webhook-subscription-not-found",
          "Webhook subscription was not found",
        )
      : { ok: true, value: toView(subscription) };
  }
}
