import { createHash } from "node:crypto";

import type {
  IntegrationCloudLinkDelivery,
  IntegrationCloudLinkDurableAcknowledgement,
  IntegrationCloudLinkMessageKind,
  IntegrationCloudLinkSessionFenceVerifier,
  IntegrationObservationPersistenceInput,
  IntegrationObservationPersistenceReceipt,
  IntegrationObservationPersistenceResult,
  IntegrationProjectionCatalog,
  IntegrationProjectionCatalogQuery,
  IntegrationProjectionCatalogRecord,
  IntegrationProjectionRecord,
  IntegrationProjectionRepository,
  IntegrationProjectionScope,
  IntegrationTopologyPersistenceInput,
  IntegrationTopologyHistoryRecord,
  IntegrationTopologyPersistenceReceipt,
  IntegrationTopologyPersistenceResult,
} from "@aether-cloud/application";
import type { IntegrationObservation } from "@aether-cloud/domain";

type PersistenceReceipt =
  | IntegrationObservationPersistenceReceipt
  | IntegrationTopologyPersistenceReceipt;

export type InMemoryIntegrationProjectionAuditEvent = Readonly<
  PersistenceReceipt & {
    readonly eventId: string;
    readonly eventName:
      | "integration.observations-reported.v1"
      | "integration.topology-reported.v1";
  }
>;

export type InMemoryIntegrationProjectionOutboxEvent = Readonly<
  PersistenceReceipt & {
    readonly eventId: string;
    readonly eventName:
      | "integration.projection-observations-changed.v1"
      | "integration.projection-topology-changed.v1";
  }
>;

interface StoredRequest {
  readonly kind: "observations" | "topology";
  readonly identity: string;
  readonly digest: string;
  readonly receipt: PersistenceReceipt;
}

interface StoredObservationPayload {
  readonly digest: string;
  readonly receipt: IntegrationObservationPersistenceReceipt;
}

interface StoredCloudLinkDelivery {
  readonly integrationId: IntegrationProjectionScope["integrationId"];
  readonly messageKind: IntegrationCloudLinkMessageKind;
  readonly sentAtMs?: string;
  readonly expiresAtMs?: string | null;
  readonly streamId: IntegrationCloudLinkDelivery["streamId"];
  readonly streamEpoch: IntegrationCloudLinkDelivery["streamEpoch"];
  readonly position: IntegrationCloudLinkDelivery["position"];
  readonly batchId: string;
  readonly digest: string;
  readonly record: IntegrationProjectionRecord;
  readonly receipt: PersistenceReceipt;
}

interface CloudLinkStreamState {
  readonly integrationId: IntegrationProjectionScope["integrationId"];
  readonly messageKind: IntegrationCloudLinkMessageKind;
  readonly lastContiguousPosition: bigint;
}

type CloudLinkDeliveryPreparation =
  | Readonly<{ outcome: "not-cloudlink" }>
  | Readonly<{ outcome: "new"; delivery: IntegrationCloudLinkDelivery }>
  | Readonly<{
      outcome: "replay";
      delivery: IntegrationCloudLinkDelivery;
      stored: StoredCloudLinkDelivery;
    }>
  | Readonly<{
      outcome: "delivery-conflict" | "delivery-gap" | "stream-binding-conflict";
    }>;

function scopeKey(scope: IntegrationProjectionScope): string {
  return [
    scope.tenantId,
    scope.projectId,
    scope.gatewayId,
    scope.integrationId,
  ].join("\u0000");
}

function gatewayRequestKey(
  input:
    | IntegrationObservationPersistenceInput
    | IntegrationTopologyPersistenceInput,
): string {
  return [
    input.binding.tenantId,
    input.binding.projectId,
    input.binding.gatewayId,
    input.requestId,
  ].join("\u0000");
}

function topologyScope(input: IntegrationTopologyPersistenceInput) {
  return {
    tenantId: input.binding.tenantId,
    projectId: input.binding.projectId,
    gatewayId: input.binding.gatewayId,
    integrationId: input.topology.integrationId,
  };
}

function observationScope(input: IntegrationObservationPersistenceInput) {
  return {
    tenantId: input.binding.tenantId,
    projectId: input.binding.projectId,
    gatewayId: input.binding.gatewayId,
    integrationId: input.batch.integrationId,
  };
}

function topologyIdentity(input: IntegrationTopologyPersistenceInput): string {
  return `${scopeKey(topologyScope(input))}\u0000${input.topology.snapshotGeneration}`;
}

function batchIdentity(input: IntegrationObservationPersistenceInput): string {
  return [
    scopeKey(observationScope(input)),
    input.batch.snapshotGeneration,
    input.batch.batchId,
  ].join("\u0000");
}

function observationIdentity(observation: IntegrationObservation): string {
  return `${observation.entityId}\u0000${observation.pointKey}`;
}

function freezeRecord(
  record: IntegrationProjectionRecord,
): IntegrationProjectionRecord {
  return Object.freeze({
    ...record,
    latestObservations: Object.freeze([...record.latestObservations]),
  });
}

function eventIdentity(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function cloudLinkStreamKey(
  scope: IntegrationProjectionScope,
  delivery: IntegrationCloudLinkDelivery,
): string {
  return [
    scope.tenantId,
    scope.projectId,
    scope.gatewayId,
    delivery.streamId,
    delivery.streamEpoch,
  ].join("\u0000");
}

function cloudLinkDeliveryKey(
  scope: IntegrationProjectionScope,
  delivery: IntegrationCloudLinkDelivery,
): string {
  return `${cloudLinkStreamKey(scope, delivery)}\u0000${delivery.position}`;
}

function sameCloudLinkDelivery(
  stored: StoredCloudLinkDelivery,
  scope: IntegrationProjectionScope,
  delivery: IntegrationCloudLinkDelivery,
): boolean {
  return (
    stored.integrationId === scope.integrationId &&
    stored.messageKind === delivery.messageKind &&
    stored.sentAtMs === delivery.sentAtMs &&
    stored.expiresAtMs === delivery.expiresAtMs &&
    stored.streamId === delivery.streamId &&
    stored.streamEpoch === delivery.streamEpoch &&
    stored.position === delivery.position &&
    stored.batchId === delivery.batchId &&
    stored.digest === delivery.digest
  );
}

function cloudLinkAcknowledgement(
  scope: IntegrationProjectionScope,
  delivery: IntegrationCloudLinkDelivery,
  acknowledgedAt: IntegrationProjectionRecord["receivedAt"],
): IntegrationCloudLinkDurableAcknowledgement {
  const identity = eventIdentity(
    [
      cloudLinkDeliveryKey(scope, delivery),
      delivery.batchId,
      delivery.digest,
      delivery.sessionId,
      delivery.sessionEpoch,
      delivery.credentialGeneration,
    ].join("\u0000"),
  );
  return Object.freeze({
    ...scope,
    outboxEventId: `outbox:integration-cloudlink-ack:${identity}`,
    receiptId: `receipt:integration-cloudlink-ack:${identity}`,
    sessionId: delivery.sessionId,
    sessionEpoch: delivery.sessionEpoch,
    credentialGeneration: delivery.credentialGeneration,
    streamId: delivery.streamId,
    streamEpoch: delivery.streamEpoch,
    acknowledgedPosition: delivery.position,
    batchId: delivery.batchId,
    digest: delivery.digest,
    messageKind: delivery.messageKind,
    acknowledgedAt,
  });
}

function topologyReceipt(
  input: IntegrationTopologyPersistenceInput,
  revision: number,
): IntegrationTopologyPersistenceReceipt {
  const scope = topologyScope(input);
  const evidenceIdentity = eventIdentity(
    `${topologyIdentity(input)}\u0000${input.payloadDigest}`,
  );
  return Object.freeze({
    kind: "topology",
    ...scope,
    credentialGeneration: input.binding.generation,
    requestId: input.requestId,
    payloadDigest: input.payloadDigest,
    snapshotGeneration: input.topology.snapshotGeneration,
    revision,
    auditEventId: `audit:integration-topology:${evidenceIdentity}`,
    outboxEventId: `outbox:integration-topology:${evidenceIdentity}`,
    committedAt: input.receivedAt,
  });
}

function observationReceipt(
  input: IntegrationObservationPersistenceInput,
  revision: number,
): IntegrationObservationPersistenceReceipt {
  const scope = observationScope(input);
  const evidenceIdentity = eventIdentity(
    `${batchIdentity(input)}\u0000${input.payloadDigest}`,
  );
  return Object.freeze({
    kind: "observations",
    ...scope,
    credentialGeneration: input.binding.generation,
    requestId: input.requestId,
    payloadDigest: input.payloadDigest,
    snapshotGeneration: input.batch.snapshotGeneration,
    batchId: input.batch.batchId,
    revision,
    auditEventId: `audit:integration-observations:${evidenceIdentity}`,
    outboxEventId: `outbox:integration-observations:${evidenceIdentity}`,
    committedAt: input.receivedAt,
  });
}

export class InMemoryIntegrationProjectionRepository
  implements IntegrationProjectionRepository, IntegrationProjectionCatalog
{
  readonly #current = new Map<string, IntegrationProjectionRecord>();
  readonly #topologyHistory = new Map<
    string,
    IntegrationTopologyHistoryRecord
  >();
  readonly #requests = new Map<string, StoredRequest>();
  readonly #batches = new Map<string, StoredObservationPayload>();
  readonly #auditEvents: InMemoryIntegrationProjectionAuditEvent[] = [];
  readonly #outboxEvents: InMemoryIntegrationProjectionOutboxEvent[] = [];
  readonly #cloudLinkStreams = new Map<string, CloudLinkStreamState>();
  readonly #cloudLinkDeliveries = new Map<string, StoredCloudLinkDelivery>();
  readonly #sessionFenceVerifier:
    | IntegrationCloudLinkSessionFenceVerifier
    | undefined;
  #failNext = false;

  constructor(
    options: {
      readonly sessionFenceVerifier?: IntegrationCloudLinkSessionFenceVerifier;
    } = {},
  ) {
    this.#sessionFenceVerifier = options.sessionFenceVerifier;
  }

  #acceptsSessionFence(
    input:
      | IntegrationObservationPersistenceInput
      | IntegrationTopologyPersistenceInput,
  ): boolean {
    const fence = input.cloudLinkSessionFence;
    if (fence === undefined) return true;
    const delivery = input.cloudLinkDelivery;
    return (
      delivery !== undefined &&
      fence.tenantId === input.binding.tenantId &&
      fence.projectId === input.binding.projectId &&
      fence.gatewayId === input.binding.gatewayId &&
      fence.credentialGeneration === input.binding.generation &&
      fence.sessionId === delivery.sessionId &&
      fence.sessionEpoch === delivery.sessionEpoch &&
      fence.credentialGeneration === delivery.credentialGeneration &&
      this.#sessionFenceVerifier?.isCurrentSessionFence(fence) === true
    );
  }

  #prepareCloudLinkDelivery(
    scope: IntegrationProjectionScope,
    input:
      | IntegrationObservationPersistenceInput
      | IntegrationTopologyPersistenceInput,
    messageKind: IntegrationCloudLinkMessageKind,
    expectedBatchId: string,
  ): CloudLinkDeliveryPreparation {
    const delivery = input.cloudLinkDelivery;
    if (delivery === undefined) return { outcome: "not-cloudlink" };
    if (
      delivery.messageKind !== messageKind ||
      delivery.batchId !== expectedBatchId ||
      delivery.credentialGeneration !== input.binding.generation
    ) {
      return { outcome: "delivery-conflict" };
    }
    const streamKey = cloudLinkStreamKey(scope, delivery);
    const stream = this.#cloudLinkStreams.get(streamKey);
    if (
      stream !== undefined &&
      (stream.integrationId !== scope.integrationId ||
        stream.messageKind !== messageKind)
    ) {
      return { outcome: "stream-binding-conflict" };
    }
    const key = cloudLinkDeliveryKey(scope, delivery);
    const stored = this.#cloudLinkDeliveries.get(key);
    if (stored !== undefined) {
      return sameCloudLinkDelivery(stored, scope, delivery)
        ? { outcome: "replay", delivery, stored }
        : { outcome: "delivery-conflict" };
    }
    const lastContiguousPosition = stream?.lastContiguousPosition ?? 0n;
    const position = BigInt(delivery.position);
    if (position <= lastContiguousPosition) {
      return { outcome: "delivery-conflict" };
    }
    if (position !== lastContiguousPosition + 1n) {
      return { outcome: "delivery-gap" };
    }
    return { outcome: "new", delivery };
  }

  #commitCloudLinkDelivery(
    scope: IntegrationProjectionScope,
    preparation: CloudLinkDeliveryPreparation,
    record: IntegrationProjectionRecord,
    receipt: PersistenceReceipt,
  ): IntegrationCloudLinkDurableAcknowledgement | undefined {
    if (preparation.outcome !== "new") return undefined;
    const delivery = preparation.delivery;
    this.#cloudLinkStreams.set(cloudLinkStreamKey(scope, delivery), {
      integrationId: scope.integrationId,
      messageKind: delivery.messageKind,
      lastContiguousPosition: BigInt(delivery.position),
    });
    this.#cloudLinkDeliveries.set(cloudLinkDeliveryKey(scope, delivery), {
      integrationId: scope.integrationId,
      messageKind: delivery.messageKind,
      ...(delivery.sentAtMs === undefined
        ? {}
        : { sentAtMs: delivery.sentAtMs }),
      ...(delivery.expiresAtMs === undefined
        ? {}
        : { expiresAtMs: delivery.expiresAtMs }),
      streamId: delivery.streamId,
      streamEpoch: delivery.streamEpoch,
      position: delivery.position,
      batchId: delivery.batchId,
      digest: delivery.digest,
      record,
      receipt,
    });
    return cloudLinkAcknowledgement(scope, delivery, record.receivedAt);
  }

  persistTopology(
    input: IntegrationTopologyPersistenceInput,
  ): Promise<IntegrationTopologyPersistenceResult> {
    if (!this.#acceptsSessionFence(input)) {
      return Promise.resolve({ outcome: "session-fenced" });
    }
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const scope = topologyScope(input);
    const cloudLink = this.#prepareCloudLinkDelivery(
      scope,
      input,
      "integration-topology-snapshot",
      `topology-${input.topology.snapshotGeneration}`,
    );
    if (
      cloudLink.outcome === "delivery-conflict" ||
      cloudLink.outcome === "delivery-gap" ||
      cloudLink.outcome === "stream-binding-conflict"
    ) {
      return Promise.resolve({ outcome: cloudLink.outcome });
    }
    if (cloudLink.outcome === "replay") {
      if (cloudLink.stored.receipt.kind !== "topology") {
        return Promise.resolve({ outcome: "delivery-conflict" });
      }
      return Promise.resolve({
        outcome: "replayed",
        record: cloudLink.stored.record,
        receipt: cloudLink.stored.receipt,
        durableAcknowledgement: cloudLinkAcknowledgement(
          scope,
          cloudLink.delivery,
          input.receivedAt,
        ),
      });
    }
    const requestKey = gatewayRequestKey(input);
    const identity = topologyIdentity(input);
    const key = scopeKey(scope);
    const current = this.#current.get(key);
    if (
      current !== undefined &&
      BigInt(input.topology.snapshotGeneration) <
        BigInt(current.topology.snapshotGeneration)
    ) {
      return Promise.resolve({ outcome: "stale-generation" });
    }
    if (
      current !== undefined &&
      current.topology.integrationKind !== input.topology.integrationKind
    ) {
      return Promise.resolve({ outcome: "generation-conflict" });
    }
    const priorRequest = this.#requests.get(requestKey);
    if (priorRequest !== undefined) {
      if (
        priorRequest.kind !== "topology" ||
        priorRequest.identity !== identity ||
        priorRequest.digest !== input.payloadDigest ||
        priorRequest.receipt.kind !== "topology" ||
        current === undefined ||
        current.topology.snapshotGeneration !==
          input.topology.snapshotGeneration ||
        current.topologyDigest !== input.payloadDigest
      ) {
        return Promise.resolve({ outcome: "idempotency-conflict" });
      }
      const durableAcknowledgement = this.#commitCloudLinkDelivery(
        scope,
        cloudLink,
        current,
        priorRequest.receipt,
      );
      return Promise.resolve({
        outcome: "replayed",
        record: current,
        receipt: priorRequest.receipt,
        ...(durableAcknowledgement === undefined
          ? {}
          : { durableAcknowledgement }),
      });
    }
    if (
      current !== undefined &&
      input.topology.snapshotGeneration === current.topology.snapshotGeneration
    ) {
      return Promise.resolve({ outcome: "generation-conflict" });
    }
    if (current?.revision === Number.MAX_SAFE_INTEGER) {
      return Promise.resolve({ outcome: "storage-unavailable" });
    }

    const record = freezeRecord({
      ...scope,
      topology: input.topology,
      topologyDigest: input.payloadDigest,
      latestObservations: [],
      receivedAt: input.receivedAt,
      revision: (current?.revision ?? 0) + 1,
    });
    const receipt = topologyReceipt(input, record.revision);
    this.#current.set(key, record);
    this.#topologyHistory.set(
      identity,
      Object.freeze({
        ...scope,
        topology: input.topology,
        topologyDigest: input.payloadDigest,
        receivedAt: input.receivedAt,
        revision: record.revision,
      }),
    );
    this.#requests.set(requestKey, {
      kind: "topology",
      identity,
      digest: input.payloadDigest,
      receipt,
    });
    this.#auditEvents.push(
      Object.freeze({
        ...receipt,
        eventId: receipt.auditEventId,
        eventName: "integration.topology-reported.v1",
      }),
    );
    this.#outboxEvents.push(
      Object.freeze({
        ...receipt,
        eventId: receipt.outboxEventId,
        eventName: "integration.projection-topology-changed.v1",
      }),
    );
    const durableAcknowledgement = this.#commitCloudLinkDelivery(
      scope,
      cloudLink,
      record,
      receipt,
    );
    return Promise.resolve({
      outcome: "persisted",
      record,
      receipt,
      ...(durableAcknowledgement === undefined
        ? {}
        : { durableAcknowledgement }),
    });
  }

  persistObservations(
    input: IntegrationObservationPersistenceInput,
  ): Promise<IntegrationObservationPersistenceResult> {
    if (!this.#acceptsSessionFence(input)) {
      return Promise.resolve({ outcome: "session-fenced" });
    }
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const scope = observationScope(input);
    const key = scopeKey(scope);
    const cloudLink = this.#prepareCloudLinkDelivery(
      scope,
      input,
      "integration-observation-batch",
      input.batch.batchId,
    );
    if (
      cloudLink.outcome === "delivery-conflict" ||
      cloudLink.outcome === "delivery-gap" ||
      cloudLink.outcome === "stream-binding-conflict"
    ) {
      return Promise.resolve({ outcome: cloudLink.outcome });
    }
    if (cloudLink.outcome === "replay") {
      const replayCurrent = this.#current.get(key);
      if (
        cloudLink.stored.receipt.kind !== "observations" ||
        replayCurrent === undefined
      ) {
        return Promise.resolve({ outcome: "delivery-conflict" });
      }
      return Promise.resolve({
        outcome: "replayed",
        record: replayCurrent,
        receipt: cloudLink.stored.receipt,
        durableAcknowledgement: cloudLinkAcknowledgement(
          scope,
          cloudLink.delivery,
          input.receivedAt,
        ),
      });
    }
    const current = this.#current.get(key);
    if (current === undefined) {
      return Promise.resolve({ outcome: "topology-required" });
    }
    if (
      current.topology.snapshotGeneration !== input.batch.snapshotGeneration
    ) {
      return Promise.resolve({ outcome: "generation-conflict" });
    }
    const requestKey = gatewayRequestKey(input);
    const identity = batchIdentity(input);
    const priorRequest = this.#requests.get(requestKey);
    if (priorRequest !== undefined) {
      if (
        priorRequest.kind !== "observations" ||
        priorRequest.identity !== identity ||
        priorRequest.digest !== input.payloadDigest ||
        priorRequest.receipt.kind !== "observations"
      ) {
        return Promise.resolve({ outcome: "idempotency-conflict" });
      }
      const durableAcknowledgement = this.#commitCloudLinkDelivery(
        scope,
        cloudLink,
        current,
        priorRequest.receipt,
      );
      return Promise.resolve({
        outcome: "replayed",
        record: current,
        receipt: priorRequest.receipt,
        ...(durableAcknowledgement === undefined
          ? {}
          : { durableAcknowledgement }),
      });
    }
    const priorBatch = this.#batches.get(identity);
    if (priorBatch !== undefined) {
      return Promise.resolve({ outcome: "batch-conflict" });
    }
    if (current.revision === Number.MAX_SAFE_INTEGER) {
      return Promise.resolve({ outcome: "storage-unavailable" });
    }

    const latest = new Map(
      current.latestObservations.map((observation) => [
        observationIdentity(observation),
        observation,
      ]),
    );
    for (const observation of input.batch.observations) {
      const observationKey = observationIdentity(observation);
      const prior = latest.get(observationKey);
      if (
        prior === undefined ||
        BigInt(observation.observedAtMs) >= BigInt(prior.observedAtMs)
      ) {
        latest.set(observationKey, observation);
      }
    }
    const latestObservations = [...latest.values()].sort((left, right) =>
      observationIdentity(left).localeCompare(observationIdentity(right)),
    );
    const record = freezeRecord({
      ...scope,
      topology: current.topology,
      topologyDigest: current.topologyDigest,
      latestObservations,
      receivedAt: input.receivedAt,
      revision: current.revision + 1,
    });
    const receipt = observationReceipt(input, record.revision);
    this.#current.set(key, record);
    this.#batches.set(identity, {
      digest: input.payloadDigest,
      receipt,
    });
    this.#requests.set(requestKey, {
      kind: "observations",
      identity,
      digest: input.payloadDigest,
      receipt,
    });
    this.#auditEvents.push(
      Object.freeze({
        ...receipt,
        eventId: receipt.auditEventId,
        eventName: "integration.observations-reported.v1",
      }),
    );
    this.#outboxEvents.push(
      Object.freeze({
        ...receipt,
        eventId: receipt.outboxEventId,
        eventName: "integration.projection-observations-changed.v1",
      }),
    );
    const durableAcknowledgement = this.#commitCloudLinkDelivery(
      scope,
      cloudLink,
      record,
      receipt,
    );
    return Promise.resolve({
      outcome: "persisted",
      record,
      receipt,
      ...(durableAcknowledgement === undefined
        ? {}
        : { durableAcknowledgement }),
    });
  }

  findCurrent(
    scope: IntegrationProjectionScope,
  ): Promise<IntegrationProjectionRecord | undefined> {
    return Promise.resolve(this.#current.get(scopeKey(scope)));
  }

  findTopology(
    scope: IntegrationProjectionScope,
    snapshotGeneration: IntegrationTopologyHistoryRecord["topology"]["snapshotGeneration"],
  ): Promise<IntegrationTopologyHistoryRecord | undefined> {
    return Promise.resolve(
      this.#topologyHistory.get(
        `${scopeKey(scope)}\u0000${snapshotGeneration}`,
      ),
    );
  }

  list(
    query: IntegrationProjectionCatalogQuery,
  ): Promise<readonly IntegrationProjectionCatalogRecord[]> {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 101
    ) {
      return Promise.reject(
        new TypeError("Integration projection catalog limit is invalid"),
      );
    }
    const after =
      query.after === undefined
        ? undefined
        : `${query.after.gatewayId}\u0000${query.after.integrationId}`;
    const records = [...this.#current.values()]
      .filter(
        (record) =>
          record.tenantId === query.tenantId &&
          record.projectId === query.projectId &&
          (query.gatewayId === undefined ||
            record.gatewayId === query.gatewayId) &&
          (after === undefined ||
            `${record.gatewayId}\u0000${record.integrationId}` > after),
      )
      .sort((left, right) => {
        const leftIdentity = `${left.gatewayId}\u0000${left.integrationId}`;
        const rightIdentity = `${right.gatewayId}\u0000${right.integrationId}`;
        return leftIdentity < rightIdentity
          ? -1
          : leftIdentity > rightIdentity
            ? 1
            : 0;
      })
      .slice(0, query.limit)
      .map((record) =>
        Object.freeze({
          tenantId: record.tenantId,
          projectId: record.projectId,
          gatewayId: record.gatewayId,
          integrationId: record.integrationId,
          integrationKind: record.topology.integrationKind,
          snapshotGeneration: record.topology.snapshotGeneration,
          entityCount: record.topology.entities.length,
          latestObservationCount: record.latestObservations.length,
          receivedAt: record.receivedAt,
          revision: record.revision,
        }),
      );
    return Promise.resolve(Object.freeze(records));
  }

  failNextPersistence(): void {
    this.#failNext = true;
  }

  auditEvents(): readonly InMemoryIntegrationProjectionAuditEvent[] {
    return [...this.#auditEvents];
  }

  pendingOutboxEvents(): readonly InMemoryIntegrationProjectionOutboxEvent[] {
    return [...this.#outboxEvents];
  }
}
