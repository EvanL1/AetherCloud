import type {
  WebhookDeliveryInsertRequest,
  WebhookDeliveryInsertResult,
  WebhookDeliveryReplaceRequest,
  WebhookDeliveryReplaceResult,
  WebhookDeliveryRepository,
  WebhookDeliveryScope,
} from "@aether-cloud/application";
import type { WebhookDelivery, WebhookDeliveryId } from "@aether-cloud/domain";

export interface InMemoryWebhookAuditEvent {
  readonly eventId: string;
  readonly deliveryId: WebhookDeliveryId;
  readonly subjectId: string;
  readonly action: "enqueued" | "updated";
}

export interface InMemoryWebhookOutboxEvent {
  readonly eventId: string;
  readonly deliveryId: WebhookDeliveryId;
  readonly eventName:
    | "integration.webhook-delivery-enqueued.v1"
    | "integration.webhook-delivery-state-changed.v1";
}

interface StoredRequest {
  readonly fingerprint: string;
  readonly delivery: WebhookDelivery;
}

function scopeKey(scope: WebhookDeliveryScope): string {
  return `${scope.tenantId}:${scope.projectId}`;
}

function deliveryKey(
  scope: WebhookDeliveryScope,
  deliveryId: WebhookDeliveryId,
): string {
  return `${scopeKey(scope)}:${deliveryId}`;
}

function requestKey(scope: WebhookDeliveryScope, requestId: string): string {
  return `${scopeKey(scope)}:${requestId}`;
}

function fingerprint(delivery: WebhookDelivery): string {
  return JSON.stringify(delivery);
}

export class InMemoryWebhookDeliveryRepository implements WebhookDeliveryRepository {
  readonly #deliveries = new Map<string, WebhookDelivery>();
  readonly #requests = new Map<string, StoredRequest>();
  readonly #audit: InMemoryWebhookAuditEvent[] = [];
  readonly #outbox: InMemoryWebhookOutboxEvent[] = [];
  #failNext = false;

  insert(
    request: WebhookDeliveryInsertRequest,
  ): Promise<WebhookDeliveryInsertResult> {
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const replay = this.#replay(request, request.delivery);
    if (replay !== undefined) return Promise.resolve(replay);
    const identity = deliveryKey(request, request.delivery.deliveryId);
    if (this.#deliveries.has(identity)) {
      return Promise.resolve({ outcome: "already-exists" });
    }
    this.#deliveries.set(identity, request.delivery);
    this.#remember(request, request.delivery);
    this.#recordEvidence(
      request,
      "enqueued",
      "integration.webhook-delivery-enqueued.v1",
    );
    return Promise.resolve({ outcome: "inserted", delivery: request.delivery });
  }

  replace(
    request: WebhookDeliveryReplaceRequest,
  ): Promise<WebhookDeliveryReplaceResult> {
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const replay = this.#replay(request, request.delivery);
    if (replay !== undefined) return Promise.resolve(replay);
    const identity = deliveryKey(request, request.delivery.deliveryId);
    const current = this.#deliveries.get(identity);
    if (current === undefined) return Promise.resolve({ outcome: "not-found" });
    if (current.revision !== request.expectedRevision) {
      return Promise.resolve({ outcome: "version-conflict" });
    }
    this.#deliveries.set(identity, request.delivery);
    this.#remember(request, request.delivery);
    this.#recordEvidence(request, "updated", request.eventName);
    return Promise.resolve({ outcome: "replaced", delivery: request.delivery });
  }

  find(
    scope: WebhookDeliveryScope,
    deliveryId: WebhookDeliveryId,
  ): Promise<WebhookDelivery | undefined> {
    return Promise.resolve(
      this.#deliveries.get(deliveryKey(scope, deliveryId)),
    );
  }

  failNextPersistence(): void {
    this.#failNext = true;
  }

  deliveryCount(): number {
    return this.#deliveries.size;
  }

  auditEvents(): readonly InMemoryWebhookAuditEvent[] {
    return Object.freeze([...this.#audit]);
  }

  pendingOutboxEvents(): readonly InMemoryWebhookOutboxEvent[] {
    return Object.freeze([...this.#outbox]);
  }

  #replay(
    request: WebhookDeliveryInsertRequest | WebhookDeliveryReplaceRequest,
    delivery: WebhookDelivery,
  ):
    | Readonly<{ outcome: "idempotency-conflict" }>
    | Readonly<{ outcome: "replayed"; delivery: WebhookDelivery }>
    | undefined {
    const prior = this.#requests.get(requestKey(request, request.requestId));
    if (prior === undefined) return undefined;
    return prior.fingerprint === fingerprint(delivery)
      ? { outcome: "replayed", delivery: prior.delivery }
      : { outcome: "idempotency-conflict" };
  }

  #remember(
    request: WebhookDeliveryInsertRequest | WebhookDeliveryReplaceRequest,
    delivery: WebhookDelivery,
  ): void {
    this.#requests.set(requestKey(request, request.requestId), {
      fingerprint: fingerprint(delivery),
      delivery,
    });
  }

  #recordEvidence(
    request: WebhookDeliveryInsertRequest | WebhookDeliveryReplaceRequest,
    action: InMemoryWebhookAuditEvent["action"],
    eventName: InMemoryWebhookOutboxEvent["eventName"],
  ): void {
    const suffix = `${scopeKey(request)}:${request.delivery.deliveryId}:${request.requestId}`;
    this.#audit.push(
      Object.freeze({
        eventId: `audit:webhook:${suffix}`,
        deliveryId: request.delivery.deliveryId,
        subjectId: request.subjectId,
        action,
      }),
    );
    this.#outbox.push(
      Object.freeze({
        eventId: `outbox:webhook:${suffix}`,
        deliveryId: request.delivery.deliveryId,
        eventName,
      }),
    );
  }
}
