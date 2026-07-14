import type {
  ProjectId,
  TenantId,
  WebhookDelivery,
  WebhookDeliveryId,
} from "@aether-cloud/domain";

export interface WebhookDeliveryScope {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

export interface WebhookDeliveryInsertRequest extends WebhookDeliveryScope {
  readonly requestId: string;
  readonly subjectId: string;
  readonly delivery: WebhookDelivery;
}

export type WebhookDeliveryInsertResult =
  | Readonly<{ outcome: "already-exists" }>
  | Readonly<{ outcome: "idempotency-conflict" }>
  | Readonly<{ outcome: "inserted"; delivery: WebhookDelivery }>
  | Readonly<{ outcome: "replayed"; delivery: WebhookDelivery }>
  | Readonly<{ outcome: "storage-unavailable" }>;

export type WebhookDeliveryEventName =
  | "integration.webhook-delivery-enqueued.v1"
  | "integration.webhook-delivery-state-changed.v1";

export interface WebhookDeliveryReplaceRequest extends WebhookDeliveryScope {
  readonly requestId: string;
  readonly subjectId: string;
  readonly expectedRevision: number;
  readonly delivery: WebhookDelivery;
  readonly eventName: WebhookDeliveryEventName;
}

export type WebhookDeliveryReplaceResult =
  | Readonly<{ outcome: "idempotency-conflict" }>
  | Readonly<{ outcome: "not-found" }>
  | Readonly<{ outcome: "replaced"; delivery: WebhookDelivery }>
  | Readonly<{ outcome: "replayed"; delivery: WebhookDelivery }>
  | Readonly<{ outcome: "storage-unavailable" }>
  | Readonly<{ outcome: "version-conflict" }>;

export interface WebhookDeliveryRepository {
  insert(
    request: WebhookDeliveryInsertRequest,
  ): Promise<WebhookDeliveryInsertResult>;
  replace(
    request: WebhookDeliveryReplaceRequest,
  ): Promise<WebhookDeliveryReplaceResult>;
  find(
    scope: WebhookDeliveryScope,
    deliveryId: WebhookDeliveryId,
  ): Promise<WebhookDelivery | undefined>;
}

export interface WebhookSendRequest {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly destinationId: string;
  readonly payloadDigest: string;
  readonly idempotencyKey: string;
}

export type WebhookSendResult =
  | Readonly<{ ok: true; statusCode: number }>
  | Readonly<{
      ok: false;
      failureCode: string;
      retryable: boolean;
      retryAfterSeconds?: number;
    }>;

export interface WebhookSender {
  send(request: WebhookSendRequest): Promise<WebhookSendResult>;
}
