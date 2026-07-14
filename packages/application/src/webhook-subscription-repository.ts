import type {
  ProjectId,
  TenantId,
  WebhookSubscription,
  WebhookSubscriptionId,
} from "@aether-cloud/domain";

export interface WebhookSubscriptionScope {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

export interface WebhookSubscriptionInsertRequest extends WebhookSubscriptionScope {
  readonly requestId: string;
  readonly subjectId: string;
  readonly subscription: WebhookSubscription;
}

export type WebhookSubscriptionInsertResult =
  | Readonly<{ outcome: "already-exists" }>
  | Readonly<{ outcome: "idempotency-conflict" }>
  | Readonly<{ outcome: "inserted"; subscription: WebhookSubscription }>
  | Readonly<{ outcome: "replayed"; subscription: WebhookSubscription }>
  | Readonly<{ outcome: "storage-unavailable" }>;

export interface WebhookSubscriptionReplaceRequest extends WebhookSubscriptionScope {
  readonly requestId: string;
  readonly subjectId: string;
  readonly expectedRevision: number;
  readonly subscription: WebhookSubscription;
}

export type WebhookSubscriptionReplaceResult =
  | Readonly<{ outcome: "idempotency-conflict" }>
  | Readonly<{ outcome: "not-found" }>
  | Readonly<{ outcome: "replaced"; subscription: WebhookSubscription }>
  | Readonly<{ outcome: "replayed"; subscription: WebhookSubscription }>
  | Readonly<{ outcome: "storage-unavailable" }>
  | Readonly<{ outcome: "version-conflict" }>;

export interface WebhookSubscriptionRepository {
  insert(
    request: WebhookSubscriptionInsertRequest,
  ): Promise<WebhookSubscriptionInsertResult>;
  replace(
    request: WebhookSubscriptionReplaceRequest,
  ): Promise<WebhookSubscriptionReplaceResult>;
  find(
    scope: WebhookSubscriptionScope,
    subscriptionId: WebhookSubscriptionId,
  ): Promise<WebhookSubscription | undefined>;
}
