import type {
  WebhookSubscriptionInsertRequest,
  WebhookSubscriptionInsertResult,
  WebhookSubscriptionReplaceRequest,
  WebhookSubscriptionReplaceResult,
  WebhookSubscriptionRepository,
  WebhookSubscriptionScope,
} from "@aether-cloud/application";
import type {
  WebhookSubscription,
  WebhookSubscriptionId,
} from "@aether-cloud/domain";

export interface InMemoryWebhookSubscriptionAuditEvent {
  readonly eventId: string;
  readonly subscriptionId: WebhookSubscriptionId;
  readonly subjectId: string;
  readonly action: "created" | "disabled";
}

export interface InMemoryWebhookSubscriptionOutboxEvent {
  readonly eventId: string;
  readonly subscriptionId: WebhookSubscriptionId;
  readonly eventName:
    | "integration.webhook-subscription-created.v1"
    | "integration.webhook-subscription-disabled.v1";
}

interface StoredRequest {
  readonly fingerprint: string;
  readonly subscription: WebhookSubscription;
}

function scopeKey(scope: WebhookSubscriptionScope): string {
  return `${scope.tenantId}:${scope.projectId}`;
}

function subscriptionKey(
  scope: WebhookSubscriptionScope,
  subscriptionId: WebhookSubscriptionId,
): string {
  return `${scopeKey(scope)}:${subscriptionId}`;
}

function requestKey(
  scope: WebhookSubscriptionScope,
  requestId: string,
): string {
  return `${scopeKey(scope)}:${requestId}`;
}

function fingerprint(subscription: WebhookSubscription): string {
  return JSON.stringify(subscription);
}

export class InMemoryWebhookSubscriptionRepository implements WebhookSubscriptionRepository {
  readonly #subscriptions = new Map<string, WebhookSubscription>();
  readonly #requests = new Map<string, StoredRequest>();
  readonly #audit: InMemoryWebhookSubscriptionAuditEvent[] = [];
  readonly #outbox: InMemoryWebhookSubscriptionOutboxEvent[] = [];
  #failNext = false;

  insert(
    request: WebhookSubscriptionInsertRequest,
  ): Promise<WebhookSubscriptionInsertResult> {
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const replay = this.#replay(request, request.subscription);
    if (replay !== undefined) return Promise.resolve(replay);
    const identity = subscriptionKey(
      request,
      request.subscription.subscriptionId,
    );
    if (this.#subscriptions.has(identity)) {
      return Promise.resolve({ outcome: "already-exists" });
    }
    this.#subscriptions.set(identity, request.subscription);
    this.#remember(request, request.subscription);
    this.#recordEvidence(request, "created");
    return Promise.resolve({
      outcome: "inserted",
      subscription: request.subscription,
    });
  }

  replace(
    request: WebhookSubscriptionReplaceRequest,
  ): Promise<WebhookSubscriptionReplaceResult> {
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const replay = this.#replay(request, request.subscription);
    if (replay !== undefined) return Promise.resolve(replay);
    const identity = subscriptionKey(
      request,
      request.subscription.subscriptionId,
    );
    const current = this.#subscriptions.get(identity);
    if (current === undefined) return Promise.resolve({ outcome: "not-found" });
    if (current.revision !== request.expectedRevision) {
      return Promise.resolve({ outcome: "version-conflict" });
    }
    this.#subscriptions.set(identity, request.subscription);
    this.#remember(request, request.subscription);
    this.#recordEvidence(request, "disabled");
    return Promise.resolve({
      outcome: "replaced",
      subscription: request.subscription,
    });
  }

  find(
    scope: WebhookSubscriptionScope,
    subscriptionId: WebhookSubscriptionId,
  ): Promise<WebhookSubscription | undefined> {
    return Promise.resolve(
      this.#subscriptions.get(subscriptionKey(scope, subscriptionId)),
    );
  }

  failNextPersistence(): void {
    this.#failNext = true;
  }

  subscriptionCount(): number {
    return this.#subscriptions.size;
  }

  auditEvents(): readonly InMemoryWebhookSubscriptionAuditEvent[] {
    return Object.freeze([...this.#audit]);
  }

  pendingOutboxEvents(): readonly InMemoryWebhookSubscriptionOutboxEvent[] {
    return Object.freeze([...this.#outbox]);
  }

  #replay(
    request:
      | WebhookSubscriptionInsertRequest
      | WebhookSubscriptionReplaceRequest,
    subscription: WebhookSubscription,
  ):
    | Readonly<{ outcome: "idempotency-conflict" }>
    | Readonly<{
        outcome: "replayed";
        subscription: WebhookSubscription;
      }>
    | undefined {
    const prior = this.#requests.get(requestKey(request, request.requestId));
    if (prior === undefined) return undefined;
    return prior.fingerprint === fingerprint(subscription)
      ? { outcome: "replayed", subscription: prior.subscription }
      : { outcome: "idempotency-conflict" };
  }

  #remember(
    request:
      | WebhookSubscriptionInsertRequest
      | WebhookSubscriptionReplaceRequest,
    subscription: WebhookSubscription,
  ): void {
    this.#requests.set(requestKey(request, request.requestId), {
      fingerprint: fingerprint(subscription),
      subscription,
    });
  }

  #recordEvidence(
    request:
      | WebhookSubscriptionInsertRequest
      | WebhookSubscriptionReplaceRequest,
    action: InMemoryWebhookSubscriptionAuditEvent["action"],
  ): void {
    const suffix = `${scopeKey(request)}:${request.subscription.subscriptionId}:${request.requestId}`;
    this.#audit.push(
      Object.freeze({
        eventId: `audit:webhook-subscription:${suffix}`,
        subscriptionId: request.subscription.subscriptionId,
        subjectId: request.subjectId,
        action,
      }),
    );
    this.#outbox.push(
      Object.freeze({
        eventId: `outbox:webhook-subscription:${suffix}`,
        subscriptionId: request.subscription.subscriptionId,
        eventName:
          action === "created"
            ? "integration.webhook-subscription-created.v1"
            : "integration.webhook-subscription-disabled.v1",
      }),
    );
  }
}
