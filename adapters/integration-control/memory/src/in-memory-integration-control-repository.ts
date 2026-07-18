import type {
  IntegrationControlActionIntent,
  IntegrationControlActionOffer,
  IntegrationControlDurableAcknowledgement,
  IntegrationOfferOutboxRecord,
  IntegrationControlRepository,
  IntegrationControlScope,
  IntegrationIntentAndOfferPersistenceInput,
  IntegrationIntentAndOfferPersistenceResult,
  IntegrationOfferPublishedResult,
  IntegrationReceiptPersistenceInput,
  IntegrationReceiptPersistenceResult,
  IntegrationReofferPersistenceInput,
  IntegrationReofferPersistenceResult,
  IntegrationStoredIntent,
} from "@aether-cloud/application";
import type {
  GatewayId,
  GovernedJobId,
  IntegrationControlReceipt,
  UtcInstant,
} from "@aether-cloud/domain";

export interface InMemoryIntegrationControlAuditEvent {
  readonly eventId: string;
  readonly tenantId: IntegrationControlScope["tenantId"];
  readonly projectId: IntegrationControlScope["projectId"];
  readonly gatewayId: GatewayId;
  readonly jobId: GovernedJobId;
  readonly subjectId: string;
  readonly action:
    | "intent-created"
    | "offer-published"
    | "offer-staged"
    | "receipt-persisted";
  readonly recordedAt: UtcInstant;
}

export interface InMemoryIntegrationControlAcknowledgementOutboxEvent {
  readonly eventId: string;
  readonly acknowledgement: IntegrationControlDurableAcknowledgement;
}

interface StoredRequest {
  readonly fingerprint: string;
}

interface StoredDelivery {
  readonly batchId: string;
  readonly digest: string;
  readonly messageKind: "integration-action-receipt";
  readonly sentAtMs: string;
  readonly expiresAtMs: string | null;
  readonly sessionId: IntegrationReceiptPersistenceInput["sessionId"];
  readonly sessionEpoch: IntegrationReceiptPersistenceInput["sessionEpoch"];
  readonly credentialGeneration: IntegrationReceiptPersistenceInput["credentialGeneration"];
  readonly receiptFingerprint: string;
  readonly evidence: Extract<
    IntegrationReceiptPersistenceResult,
    { outcome: "persisted" | "replayed" }
  >["evidence"];
}

function sameDeliveryBusiness(
  stored: StoredDelivery,
  input: IntegrationReceiptPersistenceInput,
): boolean {
  return (
    stored.batchId === input.delivery.batchId &&
    stored.digest === input.delivery.digest &&
    stored.sentAtMs === input.delivery.sentAtMs &&
    stored.expiresAtMs === input.delivery.expiresAtMs &&
    stored.receiptFingerprint === fingerprint(input.receipt)
  );
}

function acceptsDeliverySessionRebind(
  stored: StoredDelivery,
  input: IntegrationReceiptPersistenceInput,
): boolean {
  const storedEpoch = BigInt(stored.sessionEpoch);
  const incomingEpoch = BigInt(input.sessionEpoch);
  if (incomingEpoch < storedEpoch) return false;
  if (incomingEpoch === storedEpoch) {
    return (
      input.sessionId === stored.sessionId &&
      input.credentialGeneration === stored.credentialGeneration
    );
  }
  return (
    input.sessionId !== stored.sessionId &&
    BigInt(input.credentialGeneration) >= BigInt(stored.credentialGeneration)
  );
}

function scopeKey(scope: IntegrationControlScope): string {
  return `${scope.tenantId}:${scope.projectId}`;
}

function gatewayKey(
  scope: IntegrationControlScope,
  gatewayId: GatewayId,
): string {
  return `${scopeKey(scope)}:${gatewayId}`;
}

function intentKey(
  scope: IntegrationControlScope,
  gatewayId: GatewayId,
  jobId: GovernedJobId,
): string {
  return `${gatewayKey(scope, gatewayId)}:${jobId}`;
}

function requestKey(scope: IntegrationControlScope, requestId: string): string {
  return `${scopeKey(scope)}:${requestId}`;
}

function offerKey(
  scope: IntegrationControlScope,
  offer: IntegrationControlActionOffer,
): string {
  return `${intentKey(scope, offer.gateway_id, offer.job_id)}:${offer.session_id}:${offer.session_epoch}`;
}

function streamKey(input: IntegrationReceiptPersistenceInput): string {
  return `${gatewayKey(input.scope, input.gatewayId)}:${input.delivery.streamId}:${input.delivery.streamEpoch}`;
}

function streamIdentityKey(input: IntegrationReceiptPersistenceInput): string {
  return `${gatewayKey(input.scope, input.gatewayId)}:stream-id`;
}

function deliveryKey(input: IntegrationReceiptPersistenceInput): string {
  return `${streamKey(input)}:${input.delivery.position}`;
}

function receiptIdentityKey(
  scope: IntegrationControlScope,
  gatewayId: GatewayId,
  jobId: GovernedJobId,
  identity: string,
): string {
  return `${intentKey(scope, gatewayId, jobId)}:receipt:${identity}`;
}

function fingerprint(input: unknown): string {
  return JSON.stringify(input);
}

function freezeIntent(
  input: IntegrationControlActionIntent,
): IntegrationControlActionIntent {
  return Object.freeze({
    ...input,
    target: Object.freeze({ ...input.target }),
    arguments: Object.freeze({ ...input.arguments }),
    governance: Object.freeze({ ...input.governance }),
    authorization: Object.freeze({ ...input.authorization }),
    confirmation: Object.freeze({ ...input.confirmation }),
  });
}

function freezeOffer(
  input: IntegrationControlActionOffer,
): IntegrationControlActionOffer {
  return Object.freeze({
    ...input,
    intent: freezeIntent(input.intent),
    cloud_authentication: Object.freeze({ ...input.cloud_authentication }),
  });
}

function sameIntent(
  stored: IntegrationStoredIntent,
  offer: IntegrationControlActionOffer,
): boolean {
  return (
    stored.intentDigest === offer.intent_digest &&
    fingerprint(stored.intent) === fingerprint(offer.intent)
  );
}

function sameOffer(
  stored: IntegrationOfferOutboxRecord,
  candidate: IntegrationControlActionOffer,
): boolean {
  return fingerprint(stored.offer) === fingerprint(candidate);
}

function sameReceipt(
  left: IntegrationControlReceipt,
  right: IntegrationControlReceipt,
): boolean {
  return fingerprint(left) === fingerprint(right);
}

export class InMemoryIntegrationControlRepository implements IntegrationControlRepository {
  readonly #intents = new Map<string, IntegrationStoredIntent>();
  readonly #requests = new Map<string, StoredRequest>();
  readonly #offers = new Map<string, IntegrationOfferOutboxRecord>();
  readonly #deliveries = new Map<string, StoredDelivery>();
  readonly #streamIds = new Map<string, string>();
  readonly #streamCursors = new Map<string, bigint>();
  readonly #receiptIdentities = new Map<string, IntegrationControlReceipt>();
  readonly #audit: InMemoryIntegrationControlAuditEvent[] = [];
  readonly #acknowledgements: InMemoryIntegrationControlAcknowledgementOutboxEvent[] =
    [];
  #sequence = 0;
  #failNext = false;

  persistIntentAndOffer(
    input: IntegrationIntentAndOfferPersistenceInput,
  ): Promise<IntegrationIntentAndOfferPersistenceResult> {
    if (this.#consumeFailure()) {
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const requestFingerprint = fingerprint({
      gatewayId: input.gatewayId,
      jobId: input.offer.job_id,
      intentDigest: input.offer.intent_digest,
      intent: input.offer.intent,
    });
    const priorRequest = this.#requests.get(
      requestKey(input.scope, input.requestId),
    );
    if (
      priorRequest !== undefined &&
      priorRequest.fingerprint !== requestFingerprint
    ) {
      return Promise.resolve({ outcome: "idempotency-conflict" });
    }
    const key = intentKey(input.scope, input.gatewayId, input.offer.job_id);
    let stored = this.#intents.get(key);
    let intentCreated = false;
    if (stored === undefined) {
      stored = Object.freeze({
        ...input.scope,
        gatewayId: input.gatewayId,
        jobId: input.offer.job_id,
        intentDigest: input.offer.intent_digest,
        intent: freezeIntent(input.offer.intent),
        expiresAtMs: input.offer.expires_at_ms,
        createdAt: input.createdAt,
        latestReceipt: undefined,
        revision: 1,
      });
      this.#intents.set(key, stored);
      intentCreated = true;
    } else if (!sameIntent(stored, input.offer)) {
      return Promise.resolve({ outcome: "intent-conflict" });
    }
    const staged = this.#stageOffer(
      input.scope,
      input.gatewayId,
      input.subjectId,
      input.offer,
      input.createdAt,
    );
    if (staged.outcome === "intent-conflict") {
      if (intentCreated) this.#intents.delete(key);
      return Promise.resolve(staged);
    }
    this.#requests.set(requestKey(input.scope, input.requestId), {
      fingerprint: requestFingerprint,
    });
    if (intentCreated) {
      this.#recordAudit(
        input.scope,
        input.gatewayId,
        input.offer.job_id,
        input.subjectId,
        "intent-created",
        input.createdAt,
      );
    }
    if (staged.outcome === "persisted") {
      this.#recordAudit(
        input.scope,
        input.gatewayId,
        input.offer.job_id,
        input.subjectId,
        "offer-staged",
        input.createdAt,
      );
    }
    return Promise.resolve({
      outcome:
        intentCreated || staged.outcome === "persisted"
          ? "persisted"
          : "replayed",
      intent: stored,
      offer: staged.offer,
    });
  }

  persistReoffer(
    input: IntegrationReofferPersistenceInput,
  ): Promise<IntegrationReofferPersistenceResult> {
    if (this.#consumeFailure()) {
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const stored = this.#intents.get(
      intentKey(input.scope, input.gatewayId, input.offer.job_id),
    );
    if (stored === undefined) return Promise.resolve({ outcome: "not-found" });
    if (!sameIntent(stored, input.offer)) {
      return Promise.resolve({ outcome: "intent-conflict" });
    }
    const staged = this.#stageOffer(
      input.scope,
      input.gatewayId,
      input.subjectId,
      input.offer,
      input.createdAt,
    );
    if (staged.outcome === "persisted") {
      this.#recordAudit(
        input.scope,
        input.gatewayId,
        input.offer.job_id,
        input.subjectId,
        "offer-staged",
        input.createdAt,
      );
    }
    return Promise.resolve(staged);
  }

  persistReceipt(
    input: IntegrationReceiptPersistenceInput,
  ): Promise<IntegrationReceiptPersistenceResult> {
    if (this.#consumeFailure()) {
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const key = intentKey(input.scope, input.gatewayId, input.receipt.jobId);
    const stored = this.#intents.get(key);
    if (stored === undefined) return Promise.resolve({ outcome: "not-found" });
    const receiptCapabilityId: unknown = input.receipt.capabilityId;
    if (
      stored.intentDigest !== input.receipt.intentDigest ||
      stored.intent.capability_id !== receiptCapabilityId ||
      stored.intent.target.integration_id !==
        input.receipt.target.integrationId ||
      stored.intent.target.snapshot_generation !==
        input.receipt.target.snapshotGeneration ||
      stored.intent.target.entity_id !== input.receipt.target.entityId ||
      stored.intent.target.point_key !== input.receipt.target.pointKey
    ) {
      return Promise.resolve({ outcome: "intent-conflict" });
    }
    const expectedStreamId = this.#streamIds.get(streamIdentityKey(input));
    if (
      expectedStreamId !== undefined &&
      expectedStreamId !== input.delivery.streamId
    ) {
      return Promise.resolve({ outcome: "stream-binding-conflict" });
    }
    const existingDelivery = this.#deliveries.get(deliveryKey(input));
    if (existingDelivery !== undefined) {
      if (
        !sameDeliveryBusiness(existingDelivery, input) ||
        !acceptsDeliverySessionRebind(existingDelivery, input)
      ) {
        return Promise.resolve({ outcome: "delivery-conflict" });
      }
      if (input.sessionEpoch !== existingDelivery.sessionEpoch) {
        this.#deliveries.set(deliveryKey(input), {
          ...existingDelivery,
          sessionId: input.sessionId,
          sessionEpoch: input.sessionEpoch,
          credentialGeneration: input.credentialGeneration,
        });
      }
      const acknowledgement = this.#acknowledgement(input);
      this.#recordAcknowledgement(acknowledgement);
      return Promise.resolve({
        outcome: "replayed",
        evidence: existingDelivery.evidence,
        durableAcknowledgement: acknowledgement,
      });
    }
    const receiptById = this.#receiptIdentities.get(
      receiptIdentityKey(
        input.scope,
        input.gatewayId,
        input.receipt.jobId,
        `id:${input.receipt.receiptId}`,
      ),
    );
    const receiptBySequence = this.#receiptIdentities.get(
      receiptIdentityKey(
        input.scope,
        input.gatewayId,
        input.receipt.jobId,
        `sequence:${input.receipt.receiptSequence}`,
      ),
    );
    if (
      (receiptById !== undefined && !sameReceipt(receiptById, input.receipt)) ||
      (receiptBySequence !== undefined &&
        !sameReceipt(receiptBySequence, input.receipt))
    ) {
      return Promise.resolve({ outcome: "receipt-conflict" });
    }
    const cursorKey = streamKey(input);
    const cursor = this.#streamCursors.get(cursorKey) ?? 0n;
    if (BigInt(input.delivery.position) !== cursor + 1n) {
      return Promise.resolve({
        outcome:
          BigInt(input.delivery.position) > cursor + 1n
            ? "delivery-gap"
            : "delivery-conflict",
      });
    }

    const evidence = Object.freeze({
      ...input.scope,
      gatewayId: input.gatewayId,
      jobId: input.receipt.jobId,
      receipt: input.receipt,
      providerAccepted: input.receipt.stage === "provider-accepted",
      physicalCompleted: false as const,
      jobSucceeded: false as const,
      auditEventId: this.#nextId("audit:integration-control:receipt"),
      receivedAt: input.receivedAt,
    });
    const nextIntent: IntegrationStoredIntent = Object.freeze({
      ...stored,
      latestReceipt: input.receipt,
      revision: stored.revision + 1,
    });
    const acknowledgement = this.#acknowledgement(input);

    this.#intents.set(key, nextIntent);
    this.#streamIds.set(streamIdentityKey(input), input.delivery.streamId);
    this.#streamCursors.set(cursorKey, BigInt(input.delivery.position));
    this.#deliveries.set(deliveryKey(input), {
      batchId: input.delivery.batchId,
      digest: input.delivery.digest,
      messageKind: input.delivery.messageKind,
      sentAtMs: input.delivery.sentAtMs,
      expiresAtMs: input.delivery.expiresAtMs,
      sessionId: input.sessionId,
      sessionEpoch: input.sessionEpoch,
      credentialGeneration: input.credentialGeneration,
      receiptFingerprint: fingerprint(input.receipt),
      evidence,
    });
    this.#receiptIdentities.set(
      receiptIdentityKey(
        input.scope,
        input.gatewayId,
        input.receipt.jobId,
        `id:${input.receipt.receiptId}`,
      ),
      input.receipt,
    );
    this.#receiptIdentities.set(
      receiptIdentityKey(
        input.scope,
        input.gatewayId,
        input.receipt.jobId,
        `sequence:${input.receipt.receiptSequence}`,
      ),
      input.receipt,
    );
    this.#recordAudit(
      input.scope,
      input.gatewayId,
      input.receipt.jobId,
      `gateway:${input.gatewayId}`,
      "receipt-persisted",
      input.receivedAt,
      evidence.auditEventId,
    );
    this.#recordAcknowledgement(acknowledgement);
    return Promise.resolve({
      outcome: "persisted",
      evidence,
      durableAcknowledgement: acknowledgement,
    });
  }

  findIntent(
    scope: IntegrationControlScope,
    gatewayId: GatewayId,
    jobId: GovernedJobId,
  ): Promise<IntegrationStoredIntent | undefined> {
    return Promise.resolve(
      this.#intents.get(intentKey(scope, gatewayId, jobId)),
    );
  }

  listUnresolvedIntents(
    scope: IntegrationControlScope,
    gatewayId: GatewayId,
  ): Promise<readonly IntegrationStoredIntent[]> {
    const prefix = `${gatewayKey(scope, gatewayId)}:`;
    return Promise.resolve(
      Object.freeze(
        [...this.#intents.entries()]
          .filter(
            ([key, value]) =>
              key.startsWith(prefix) && value.latestReceipt === undefined,
          )
          .map(([, value]) => value),
      ),
    );
  }

  listDispatchableOffers(
    scope: IntegrationControlScope,
    gatewayId: GatewayId,
  ): Promise<readonly IntegrationOfferOutboxRecord[]> {
    const prefix = `${gatewayKey(scope, gatewayId)}:`;
    return Promise.resolve(
      Object.freeze(
        [...this.#offers.entries()]
          .filter(([key, value]) => {
            const intent = this.#intents.get(
              intentKey(scope, gatewayId, value.jobId),
            );
            return (
              key.startsWith(prefix) &&
              value.status === "pending" &&
              intent?.latestReceipt === undefined
            );
          })
          .map(([, value]) => value),
      ),
    );
  }

  markOfferPublished(
    scope: IntegrationControlScope,
    eventId: string,
    publishedAt: UtcInstant,
  ): Promise<IntegrationOfferPublishedResult> {
    if (this.#consumeFailure()) {
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const entry = [...this.#offers.entries()].find(
      ([, value]) =>
        value.tenantId === scope.tenantId &&
        value.projectId === scope.projectId &&
        value.eventId === eventId,
    );
    if (entry === undefined) return Promise.resolve({ outcome: "not-found" });
    const [key, current] = entry;
    if (current.status === "published") {
      return Promise.resolve({ outcome: "replayed" });
    }
    this.#offers.set(
      key,
      Object.freeze({
        ...current,
        status: "published",
        publishedAt,
      }),
    );
    this.#recordAudit(
      scope,
      current.gatewayId,
      current.jobId,
      "system:integration-control-publisher",
      "offer-published",
      publishedAt,
    );
    return Promise.resolve({ outcome: "published" });
  }

  failNextPersistence(): void {
    this.#failNext = true;
  }

  auditEvents(): readonly InMemoryIntegrationControlAuditEvent[] {
    return Object.freeze([...this.#audit]);
  }

  outboxEvents(): readonly IntegrationOfferOutboxRecord[] {
    return Object.freeze([...this.#offers.values()]);
  }

  acknowledgementOutbox(): readonly InMemoryIntegrationControlAcknowledgementOutboxEvent[] {
    return Object.freeze([...this.#acknowledgements]);
  }

  #stageOffer(
    scope: IntegrationControlScope,
    gatewayId: GatewayId,
    _subjectId: string,
    candidate: IntegrationControlActionOffer,
    createdAt: UtcInstant,
  ):
    | Readonly<{
        outcome: "persisted" | "replayed";
        offer: IntegrationOfferOutboxRecord;
      }>
    | Readonly<{ outcome: "intent-conflict" }> {
    const key = offerKey(scope, candidate);
    const existing = this.#offers.get(key);
    if (existing !== undefined) {
      return sameOffer(existing, candidate)
        ? { outcome: "replayed", offer: existing }
        : { outcome: "intent-conflict" };
    }
    const frozenOffer = freezeOffer(candidate);
    const event: IntegrationOfferOutboxRecord = Object.freeze({
      eventId: this.#nextId("outbox:integration-control:offer"),
      ...scope,
      gatewayId,
      jobId: candidate.job_id,
      sessionId: candidate.session_id,
      sessionEpoch: candidate.session_epoch,
      intentDigest: candidate.intent_digest,
      offer: frozenOffer,
      status: "pending",
      createdAt,
    });
    this.#offers.set(key, event);
    return { outcome: "persisted", offer: event };
  }

  #acknowledgement(
    input: IntegrationReceiptPersistenceInput,
  ): IntegrationControlDurableAcknowledgement {
    return Object.freeze({
      ...input.scope,
      gatewayId: input.gatewayId,
      sessionId: input.sessionId,
      sessionEpoch: input.sessionEpoch,
      credentialGeneration: input.credentialGeneration,
      streamId: input.delivery.streamId,
      streamEpoch: input.delivery.streamEpoch,
      acknowledgedPosition: input.delivery.position,
      batchId: input.delivery.batchId,
      digest: input.delivery.digest,
      receiptId: `ack:integration-control:${input.receipt.receiptId}:${input.delivery.position}`,
      acknowledgedAt: input.receivedAt,
    });
  }

  #recordAcknowledgement(
    acknowledgement: IntegrationControlDurableAcknowledgement,
  ): void {
    this.#acknowledgements.push(
      Object.freeze({
        eventId: this.#nextId("outbox:integration-control:ack"),
        acknowledgement,
      }),
    );
  }

  #recordAudit(
    scope: IntegrationControlScope,
    gatewayId: GatewayId,
    jobId: GovernedJobId,
    subjectId: string,
    action: InMemoryIntegrationControlAuditEvent["action"],
    recordedAt: UtcInstant,
    eventId = this.#nextId("audit:integration-control"),
  ): void {
    this.#audit.push(
      Object.freeze({
        eventId,
        ...scope,
        gatewayId,
        jobId,
        subjectId,
        action,
        recordedAt,
      }),
    );
  }

  #nextId(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}:${String(this.#sequence).padStart(8, "0")}`;
  }

  #consumeFailure(): boolean {
    if (!this.#failNext) return false;
    this.#failNext = false;
    return true;
  }
}
