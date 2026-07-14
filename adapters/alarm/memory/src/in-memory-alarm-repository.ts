import type {
  AlarmAcknowledgementInput,
  AlarmAcknowledgementResult,
  AlarmIngestionInput,
  AlarmIngestionResult,
  AlarmProjectionRecord,
  AlarmRepository,
  AlarmScope,
} from "@aether-cloud/application";
import {
  acknowledgeAlarmProjection,
  projectAlarmFact,
  resolveAlarmProjectionGap,
} from "@aether-cloud/domain";
import type {
  AlarmFact,
  AlarmOccurrenceId,
  AlarmProjection,
} from "@aether-cloud/domain";

export interface InMemoryAlarmAuditEvent {
  readonly eventId: string;
  readonly kind: "alarm-fact" | "alarm-workflow";
  readonly occurrenceId: AlarmOccurrenceId;
}

export interface InMemoryAlarmOutboxEvent {
  readonly eventId: string;
  readonly eventName:
    | "alarm.projection-changed.v1"
    | "alarm.workflow-acknowledged.v1";
  readonly occurrenceId: AlarmOccurrenceId;
}

interface StoredFact {
  readonly digest: string;
  readonly fact: AlarmFact;
}

interface StoredIngestionRequest {
  readonly factKey: string;
  readonly digest: string;
}

interface StoredAcknowledgementRequest {
  readonly occurrenceId: AlarmOccurrenceId;
  readonly subjectId: string;
  readonly record: AlarmProjectionRecord;
}

function scopeKey(scope: AlarmScope): string {
  return `${scope.tenantId}:${scope.projectId}`;
}

function occurrenceKey(
  scope: AlarmScope,
  occurrenceId: AlarmOccurrenceId,
): string {
  return `${scopeKey(scope)}:${occurrenceId}`;
}

function factKey(input: AlarmIngestionInput): string {
  return `${occurrenceKey(input.binding, input.fact.occurrenceId)}:${input.fact.factId}`;
}

function sequenceKey(input: AlarmIngestionInput): string {
  return `${occurrenceKey(input.binding, input.fact.occurrenceId)}:${input.fact.generation}:${input.fact.sequence}`;
}

function ingestionRequestKey(input: AlarmIngestionInput): string {
  return `${scopeKey(input.binding)}:${input.requestId}`;
}

function acknowledgementRequestKey(input: AlarmAcknowledgementInput): string {
  return `${scopeKey(input)}:${input.requestId}`;
}

export class InMemoryAlarmRepository implements AlarmRepository {
  readonly #facts = new Map<string, StoredFact>();
  readonly #sequenceFacts = new Map<string, string>();
  readonly #ingestionRequests = new Map<string, StoredIngestionRequest>();
  readonly #acknowledgementRequests = new Map<
    string,
    StoredAcknowledgementRequest
  >();
  readonly #current = new Map<string, AlarmProjectionRecord>();
  readonly #auditEvents: InMemoryAlarmAuditEvent[] = [];
  readonly #outboxEvents: InMemoryAlarmOutboxEvent[] = [];
  #failNext = false;

  ingest(input: AlarmIngestionInput): Promise<AlarmIngestionResult> {
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const identity = factKey(input);
    const requestIdentity = ingestionRequestKey(input);
    const priorRequest = this.#ingestionRequests.get(requestIdentity);
    if (priorRequest !== undefined) {
      if (
        priorRequest.factKey !== identity ||
        priorRequest.digest !== input.payloadDigest
      ) {
        return Promise.resolve({ outcome: "fact-conflict" });
      }
      const record = this.#current.get(
        occurrenceKey(input.binding, input.fact.occurrenceId),
      );
      if (record === undefined) {
        return Promise.resolve({ outcome: "storage-unavailable" });
      }
      return Promise.resolve({
        outcome: "replayed",
        disposition: "replayed",
        record,
      });
    }
    const priorFact = this.#facts.get(identity);
    if (priorFact !== undefined) {
      if (priorFact.digest !== input.payloadDigest) {
        return Promise.resolve({ outcome: "fact-conflict" });
      }
      const record = this.#current.get(
        occurrenceKey(input.binding, input.fact.occurrenceId),
      );
      if (record === undefined) {
        return Promise.resolve({ outcome: "storage-unavailable" });
      }
      this.#ingestionRequests.set(requestIdentity, {
        factKey: identity,
        digest: input.payloadDigest,
      });
      return Promise.resolve({
        outcome: "replayed",
        disposition: "replayed",
        record,
      });
    }
    const sequenceIdentity = sequenceKey(input);
    const priorSequenceFact = this.#sequenceFacts.get(sequenceIdentity);
    if (
      priorSequenceFact !== undefined &&
      priorSequenceFact !== input.fact.factId
    ) {
      return Promise.resolve({ outcome: "sequence-conflict" });
    }

    const currentKey = occurrenceKey(input.binding, input.fact.occurrenceId);
    const currentRecord = this.#current.get(currentKey);
    if (
      currentRecord !== undefined &&
      currentRecord.gatewayId !== input.binding.gatewayId
    ) {
      return Promise.resolve({ outcome: "fact-conflict" });
    }
    const projected = projectAlarmFact(currentRecord?.projection, input.fact);
    if (!projected.ok) {
      return Promise.resolve({ outcome: "sequence-conflict" });
    }

    this.#facts.set(identity, {
      digest: input.payloadDigest,
      fact: input.fact,
    });
    this.#sequenceFacts.set(sequenceIdentity, input.fact.factId);
    this.#ingestionRequests.set(requestIdentity, {
      factKey: identity,
      digest: input.payloadDigest,
    });

    let projection = projected.projection ?? currentRecord?.projection;
    if (projection === undefined) {
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    if (
      projection.gap !== undefined &&
      this.#isGenerationContiguous(input, projection)
    ) {
      projection = resolveAlarmProjectionGap(projection);
    }
    const record: AlarmProjectionRecord = Object.freeze({
      tenantId: input.binding.tenantId,
      projectId: input.binding.projectId,
      gatewayId: input.binding.gatewayId,
      receivedAt:
        projected.updatesProjection || currentRecord === undefined
          ? input.receivedAt
          : currentRecord.receivedAt,
      projection,
      ...(currentRecord?.acknowledgement === undefined
        ? {}
        : { acknowledgement: currentRecord.acknowledgement }),
    });
    this.#current.set(currentKey, record);

    const auditEventId = `audit:alarm:${identity}`;
    const outboxEventId = `outbox:alarm:${identity}`;
    this.#auditEvents.push(
      Object.freeze({
        eventId: auditEventId,
        kind: "alarm-fact",
        occurrenceId: input.fact.occurrenceId,
      }),
    );
    this.#outboxEvents.push(
      Object.freeze({
        eventId: outboxEventId,
        eventName: "alarm.projection-changed.v1",
        occurrenceId: input.fact.occurrenceId,
      }),
    );
    return Promise.resolve({
      outcome: "persisted",
      disposition: projected.disposition,
      record,
    });
  }

  findCurrent(
    scope: AlarmScope,
    occurrenceId: AlarmOccurrenceId,
  ): Promise<AlarmProjectionRecord | undefined> {
    return Promise.resolve(
      this.#current.get(occurrenceKey(scope, occurrenceId)),
    );
  }

  acknowledge(
    input: AlarmAcknowledgementInput,
  ): Promise<AlarmAcknowledgementResult> {
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const requestIdentity = acknowledgementRequestKey(input);
    const priorRequest = this.#acknowledgementRequests.get(requestIdentity);
    if (priorRequest !== undefined) {
      return Promise.resolve(
        priorRequest.occurrenceId === input.occurrenceId &&
          priorRequest.subjectId === input.subjectId
          ? { outcome: "replayed", record: priorRequest.record }
          : { outcome: "idempotency-conflict" },
      );
    }
    const key = occurrenceKey(input, input.occurrenceId);
    const current = this.#current.get(key);
    if (current === undefined) return Promise.resolve({ outcome: "not-found" });
    if (
      current.acknowledgement !== undefined &&
      current.acknowledgement.subjectId !== input.subjectId
    ) {
      return Promise.resolve({ outcome: "concurrent-modification" });
    }
    const record: AlarmProjectionRecord = Object.freeze({
      ...current,
      projection: acknowledgeAlarmProjection(current.projection),
      acknowledgement: Object.freeze({
        subjectId: input.subjectId,
        acknowledgedAt: input.acknowledgedAt,
      }),
    });
    this.#current.set(key, record);
    this.#acknowledgementRequests.set(requestIdentity, {
      occurrenceId: input.occurrenceId,
      subjectId: input.subjectId,
      record,
    });
    const suffix = `${key}:${input.requestId}`;
    this.#auditEvents.push(
      Object.freeze({
        eventId: `audit:alarm-ack:${suffix}`,
        kind: "alarm-workflow",
        occurrenceId: input.occurrenceId,
      }),
    );
    this.#outboxEvents.push(
      Object.freeze({
        eventId: `outbox:alarm-ack:${suffix}`,
        eventName: "alarm.workflow-acknowledged.v1",
        occurrenceId: input.occurrenceId,
      }),
    );
    return Promise.resolve({ outcome: "acknowledged", record });
  }

  failNextPersistence(): void {
    this.#failNext = true;
  }

  factCount(): number {
    return this.#facts.size;
  }

  auditEvents(): readonly InMemoryAlarmAuditEvent[] {
    return Object.freeze([...this.#auditEvents]);
  }

  pendingOutboxEvents(): readonly InMemoryAlarmOutboxEvent[] {
    return Object.freeze([...this.#outboxEvents]);
  }

  #isGenerationContiguous(
    input: AlarmIngestionInput,
    projection: AlarmProjection,
  ): boolean {
    const prefix = `${occurrenceKey(input.binding, input.fact.occurrenceId)}:${projection.generation}:`;
    for (
      let sequence = 0n;
      sequence <= BigInt(projection.lastSequence);
      sequence += 1n
    ) {
      if (!this.#sequenceFacts.has(`${prefix}${sequence.toString(10)}`)) {
        return false;
      }
    }
    return true;
  }
}
