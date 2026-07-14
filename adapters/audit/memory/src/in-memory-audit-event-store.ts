import type {
  AuditEventRepository,
  AuditEventSearch,
  AuditEventSearchResult,
  AuditScope,
} from "@aether-cloud/application";
import type { AuditEvent } from "@aether-cloud/domain";

export type AuditEventRecordResult = Readonly<{
  outcome: "conflict" | "inserted" | "replayed";
}>;

function scopeKey(scope: AuditScope): string {
  return `${scope.tenantId}:${scope.projectId}`;
}

function fingerprint(event: AuditEvent): string {
  return JSON.stringify(event);
}

function matches(event: AuditEvent, query: AuditEventSearch): boolean {
  if (
    query.cursor !== undefined &&
    BigInt(event.sequence) >= BigInt(query.cursor)
  ) {
    return false;
  }
  if (query.action !== undefined && event.action !== query.action) return false;
  if (
    query.subjectId !== undefined &&
    event.subject.subjectId !== query.subjectId
  ) {
    return false;
  }
  if (
    query.resourceKind !== undefined &&
    event.resource.kind !== query.resourceKind
  ) {
    return false;
  }
  if (
    query.resourceId !== undefined &&
    event.resource.resourceId !== query.resourceId
  ) {
    return false;
  }
  if (query.from !== undefined && event.occurredAt < query.from) return false;
  return query.to === undefined || event.occurredAt <= query.to;
}

export class InMemoryAuditEventStore implements AuditEventRepository {
  readonly #eventsByScope = new Map<string, AuditEvent[]>();

  record(event: AuditEvent): AuditEventRecordResult {
    const key = scopeKey(event);
    const events = this.#eventsByScope.get(key) ?? [];
    const prior = events.find(
      (candidate) =>
        candidate.eventId === event.eventId ||
        candidate.sequence === event.sequence,
    );
    if (prior !== undefined) {
      return {
        outcome:
          fingerprint(prior) === fingerprint(event) ? "replayed" : "conflict",
      };
    }
    events.push(event);
    this.#eventsByScope.set(key, events);
    return { outcome: "inserted" };
  }

  search(
    scope: AuditScope,
    query: AuditEventSearch,
  ): Promise<AuditEventSearchResult> {
    const matching = [...(this.#eventsByScope.get(scopeKey(scope)) ?? [])]
      .filter((event) => matches(event, query))
      .sort((left, right) => {
        const leftSequence = BigInt(left.sequence);
        const rightSequence = BigInt(right.sequence);
        return leftSequence === rightSequence
          ? 0
          : leftSequence > rightSequence
            ? -1
            : 1;
      });
    const events = Object.freeze(matching.slice(0, query.limit));
    const hasMore = matching.length > events.length;
    return Promise.resolve({
      events,
      nextCursor:
        hasMore && events.length > 0
          ? events[events.length - 1]?.sequence
          : undefined,
    });
  }

  eventCount(): number {
    let count = 0;
    for (const events of this.#eventsByScope.values()) count += events.length;
    return count;
  }
}
