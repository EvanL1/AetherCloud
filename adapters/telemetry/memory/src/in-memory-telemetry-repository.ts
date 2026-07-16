import { createHash } from "node:crypto";

import type {
  CloudLinkDurableAcknowledgement,
  TelemetryHistoryQuery,
  TelemetryPersistenceInput,
  TelemetryPersistenceResult,
  TelemetryRepository,
} from "@aether-cloud/application";
import { parseTelemetryStreamPosition } from "@aether-cloud/domain";
import type {
  PersistedTelemetryRecord,
  TelemetryIngestionReceipt,
} from "@aether-cloud/domain";

export interface InMemoryTelemetryRepositoryOptions {
  readonly maximumRecordsPerGateway?: number;
}

export interface InMemoryTelemetryAuditEvent {
  readonly eventId: string;
  readonly batchIdentity: string;
  readonly payloadDigest: string;
}

export interface InMemoryTelemetryOutboxEvent {
  readonly eventId: string;
  readonly eventName: "telemetry.batch-accepted.v1";
  readonly batchIdentity: string;
}

interface StoredBatch {
  readonly payloadDigest: string;
  readonly receipt: TelemetryIngestionReceipt;
}

interface StoredRequest {
  readonly batchKey: string;
  readonly payloadDigest: string;
  readonly receipt: TelemetryIngestionReceipt;
}

function acknowledgementKey(input: TelemetryPersistenceInput): string {
  const intent = input.durableAcknowledgement;
  if (intent === undefined) return "";
  return [
    input.binding.tenantId,
    input.binding.projectId,
    input.binding.gatewayId,
    intent.sessionId,
    intent.sessionEpoch,
    intent.streamId,
    intent.streamEpoch,
    intent.acknowledgedPosition,
    intent.batchId,
    intent.digest,
  ].join("\u0000");
}

function stableAcknowledgementId(key: string): string {
  return `outbox:cloudlink-ack:${createHash("sha256").update(key, "utf8").digest("hex")}`;
}

function acknowledgementReceiptId(batchId: string): string {
  const candidate = `receipt:cloudlink:${batchId}`;
  return candidate.length <= 128
    ? candidate
    : `receipt:cloudlink:${createHash("sha256").update(batchId, "utf8").digest("hex")}`;
}

function gatewayKey(input: {
  readonly tenantId: string;
  readonly projectId: string;
  readonly gatewayId: string;
}): string {
  return `${input.tenantId}:${input.projectId}:${input.gatewayId}`;
}

function streamKey(input: {
  readonly tenantId: string;
  readonly projectId: string;
  readonly gatewayId: string;
  readonly streamId: string;
  readonly streamEpoch: string;
}): string {
  return `${gatewayKey(input)}:${input.streamId}:${input.streamEpoch}`;
}

function batchKey(input: TelemetryPersistenceInput): string {
  return `${streamKey({
    ...input.binding,
    streamId: input.batch.streamId,
    streamEpoch: input.batch.streamEpoch,
  })}:${input.batch.firstPosition}`;
}

function requestKey(input: TelemetryPersistenceInput): string {
  return `${gatewayKey(input.binding)}:${input.requestId}`;
}

function positionKey(stream: string, position: string): string {
  return `${stream}:${position}`;
}

export class InMemoryTelemetryRepository implements TelemetryRepository {
  readonly #maximumRecordsPerGateway: number;
  readonly #batches = new Map<string, StoredBatch>();
  readonly #requests = new Map<string, StoredRequest>();
  readonly #history = new Map<string, PersistedTelemetryRecord>();
  readonly #gatewayRecordCounts = new Map<string, number>();
  readonly #contiguousPositions = new Map<string, bigint>();
  readonly #auditEvents: InMemoryTelemetryAuditEvent[] = [];
  readonly #outboxEvents: InMemoryTelemetryOutboxEvent[] = [];
  readonly #durableAcknowledgements = new Map<
    string,
    CloudLinkDurableAcknowledgement
  >();
  #failNext = false;

  constructor(options: InMemoryTelemetryRepositoryOptions = {}) {
    this.#maximumRecordsPerGateway =
      options.maximumRecordsPerGateway ?? 100_000;
  }

  persist(
    input: TelemetryPersistenceInput,
  ): Promise<TelemetryPersistenceResult> {
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.resolve({ outcome: "storage-unavailable" });
    }

    const identity = batchKey(input);
    const requestIdentity = requestKey(input);
    const priorRequest = this.#requests.get(requestIdentity);
    if (priorRequest !== undefined) {
      if (
        priorRequest.batchKey !== identity ||
        priorRequest.payloadDigest !== input.payloadDigest
      ) {
        return Promise.resolve({ outcome: "conflicting-replay" });
      }
      const durableAcknowledgement = this.#acknowledgement(input);
      return Promise.resolve({
        outcome: "duplicate",
        receipt: priorRequest.receipt,
        ...(durableAcknowledgement === undefined
          ? {}
          : { durableAcknowledgement }),
      });
    }
    const priorBatch = this.#batches.get(identity);
    if (priorBatch !== undefined) {
      if (priorBatch.payloadDigest !== input.payloadDigest) {
        return Promise.resolve({ outcome: "conflicting-replay" });
      }
      this.#requests.set(requestIdentity, {
        batchKey: identity,
        payloadDigest: input.payloadDigest,
        receipt: priorBatch.receipt,
      });
      const durableAcknowledgement = this.#acknowledgement(input);
      return Promise.resolve({
        outcome: "duplicate",
        receipt: priorBatch.receipt,
        ...(durableAcknowledgement === undefined
          ? {}
          : { durableAcknowledgement }),
      });
    }

    const stream = streamKey({
      ...input.binding,
      streamId: input.batch.streamId,
      streamEpoch: input.batch.streamEpoch,
    });
    if (
      input.batch.records.some((record) =>
        this.#history.has(positionKey(stream, record.position)),
      )
    ) {
      return Promise.resolve({ outcome: "position-conflict" });
    }
    const gateway = gatewayKey(input.binding);
    const currentCount = this.#gatewayRecordCounts.get(gateway) ?? 0;
    if (
      currentCount + input.batch.recordCount >
      this.#maximumRecordsPerGateway
    ) {
      return Promise.resolve({ outcome: "quota-exceeded" });
    }

    const before = this.#contiguousPositions.get(stream) ?? -1n;
    const expected = before + 1n;
    const received = BigInt(input.batch.firstPosition);
    const hasGap = received > expected;
    const persistedRecords = input.batch.records.map<PersistedTelemetryRecord>(
      (record) => ({
        tenantId: input.binding.tenantId,
        projectId: input.binding.projectId,
        gatewayId: input.binding.gatewayId,
        streamId: input.batch.streamId,
        streamEpoch: input.batch.streamEpoch,
        topology: input.batch.topology,
        batchIdentity: input.batch.batchIdentity,
        receivedAt: input.receivedAt,
        persistedAt: input.receivedAt,
        retentionClass: input.batch.retentionClass,
        record,
      }),
    );

    for (const persisted of persistedRecords) {
      this.#history.set(
        positionKey(stream, persisted.record.position),
        Object.freeze(persisted),
      );
    }
    let contiguous = before;
    while (
      contiguous < 18_446_744_073_709_551_615n &&
      this.#history.has(positionKey(stream, (contiguous + 1n).toString()))
    ) {
      contiguous += 1n;
    }
    if (contiguous >= 0n) {
      this.#contiguousPositions.set(stream, contiguous);
    }

    const auditEventId = `audit:telemetry:${identity}`;
    const outboxEventId = `outbox:telemetry:${identity}`;
    const receipt: TelemetryIngestionReceipt = Object.freeze({
      receiptId: `receipt:telemetry:${identity}`,
      tenantId: input.binding.tenantId,
      projectId: input.binding.projectId,
      gatewayId: input.binding.gatewayId,
      credentialGeneration: input.binding.generation,
      batchIdentity: input.batch.batchIdentity,
      payloadDigest: input.payloadDigest,
      streamId: input.batch.streamId,
      streamEpoch: input.batch.streamEpoch,
      firstPosition: input.batch.firstPosition,
      lastPosition: input.batch.lastPosition,
      recordCount: input.batch.recordCount,
      persistedAt: input.receivedAt,
      ...(contiguous < 0n
        ? {}
        : {
            contiguousPosition: parseTelemetryStreamPosition(
              contiguous.toString(),
            ),
          }),
      ...(hasGap
        ? {
            gap: Object.freeze({
              expectedPosition: parseTelemetryStreamPosition(
                expected.toString(),
              ),
              receivedPosition: input.batch.firstPosition,
            }),
          }
        : {}),
      auditEventId,
      outboxEventId,
    });

    this.#batches.set(identity, {
      payloadDigest: input.payloadDigest,
      receipt,
    });
    this.#requests.set(requestIdentity, {
      batchKey: identity,
      payloadDigest: input.payloadDigest,
      receipt,
    });
    this.#gatewayRecordCounts.set(
      gateway,
      currentCount + input.batch.recordCount,
    );
    this.#auditEvents.push(
      Object.freeze({
        eventId: auditEventId,
        batchIdentity: input.batch.batchIdentity,
        payloadDigest: input.payloadDigest,
      }),
    );
    this.#outboxEvents.push(
      Object.freeze({
        eventId: outboxEventId,
        eventName: "telemetry.batch-accepted.v1",
        batchIdentity: input.batch.batchIdentity,
      }),
    );
    const durableAcknowledgement = this.#acknowledgement(input);
    return Promise.resolve({
      outcome: "persisted",
      receipt,
      ...(durableAcknowledgement === undefined
        ? {}
        : { durableAcknowledgement }),
    });
  }

  #acknowledgement(
    input: TelemetryPersistenceInput,
  ): CloudLinkDurableAcknowledgement | undefined {
    const intent = input.durableAcknowledgement;
    if (intent === undefined) return undefined;
    const key = acknowledgementKey(input);
    const prior = this.#durableAcknowledgements.get(key);
    if (prior !== undefined) return prior;
    const acknowledgement = Object.freeze({
      outboxEventId: stableAcknowledgementId(key),
      tenantId: input.binding.tenantId,
      projectId: input.binding.projectId,
      gatewayId: input.binding.gatewayId,
      sessionId: intent.sessionId,
      sessionEpoch: intent.sessionEpoch,
      credentialGeneration: intent.credentialGeneration,
      streamId: intent.streamId,
      streamEpoch: intent.streamEpoch,
      acknowledgedPosition: intent.acknowledgedPosition,
      batchId: intent.batchId,
      digest: intent.digest,
      receiptId: acknowledgementReceiptId(intent.batchId),
      acknowledgedAt: intent.acknowledgedAt,
    });
    this.#durableAcknowledgements.set(key, acknowledgement);
    return acknowledgement;
  }

  queryHistory(
    query: TelemetryHistoryQuery,
  ): Promise<readonly PersistedTelemetryRecord[]> {
    const stream = streamKey(query);
    const from = BigInt(query.fromPosition);
    const records = [...this.#history.entries()]
      .filter(
        ([key, value]) =>
          key.startsWith(`${stream}:`) && BigInt(value.record.position) >= from,
      )
      .map(([, value]) => value)
      .sort((left, right) =>
        BigInt(left.record.position) < BigInt(right.record.position) ? -1 : 1,
      )
      .slice(0, query.limit);
    return Promise.resolve(Object.freeze(records));
  }

  failNextPersistence(): void {
    this.#failNext = true;
  }

  historyRecordCount(): number {
    return this.#history.size;
  }

  pendingOutboxEvents(): readonly InMemoryTelemetryOutboxEvent[] {
    return Object.freeze([...this.#outboxEvents]);
  }

  auditEvents(): readonly InMemoryTelemetryAuditEvent[] {
    return Object.freeze([...this.#auditEvents]);
  }
}
