import type {
  AuditEventRepository,
  AuditEventSearch,
  AuditEventSearchResult,
  AuditScope,
} from "@aether-cloud/application";
import {
  defineAuditEvent,
  parseAuditEventId,
  parseAuditSequence,
  parseContentDigest,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";
import type { AuditEvent } from "@aether-cloud/domain";

import type {
  PostgresAuditClient,
  PostgresAuditPool,
} from "./postgres-audit-contracts.js";

const setTenantSql = "SELECT set_config('aethercloud.tenant_id', $1, true)";

const searchSql = `
SELECT
  event_id,
  sequence::text AS sequence,
  tenant_id::text AS tenant_id,
  project_id::text AS project_id,
  occurred_at,
  subject_kind,
  subject_id,
  action,
  resource_kind,
  resource_id,
  outcome,
  risk,
  confirmation,
  correlation_id,
  trace_id,
  details_digest
FROM aethercloud.audit_events
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND ($3::numeric IS NULL OR sequence < $3::numeric)
  AND ($4::text IS NULL OR action = $4::text)
  AND ($5::text IS NULL OR subject_id = $5::text)
  AND ($6::text IS NULL OR resource_kind = $6::text)
  AND ($7::text IS NULL OR resource_id = $7::text)
  AND ($8::timestamptz IS NULL OR occurred_at >= $8::timestamptz)
  AND ($9::timestamptz IS NULL OR occurred_at <= $9::timestamptz)
ORDER BY sequence DESC
LIMIT $10::integer
`;

type Row = Record<string, unknown>;

function stringField(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`PostgreSQL Audit row ${field} is invalid`);
  }
  return value;
}

function optionalStringField(row: Row, field: string): string | undefined {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`PostgreSQL Audit row ${field} is invalid`);
  }
  return value;
}

function timeField(row: Row, field: string): string {
  const value = row[field];
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString();
  }
  return stringField(row, field);
}

function enumField<const Values extends readonly string[]>(
  row: Row,
  field: string,
  values: Values,
): Values[number] {
  const value = stringField(row, field);
  if (!values.includes(value)) {
    throw new Error(`PostgreSQL Audit row ${field} is invalid`);
  }
  return value as Values[number];
}

function decodeRow(row: Row): AuditEvent {
  const traceId = optionalStringField(row, "trace_id");
  const detailsDigest = optionalStringField(row, "details_digest");
  return defineAuditEvent({
    eventId: parseAuditEventId(stringField(row, "event_id")),
    sequence: parseAuditSequence(stringField(row, "sequence")),
    tenantId: parseTenantId(stringField(row, "tenant_id")),
    projectId: parseProjectId(stringField(row, "project_id")),
    occurredAt: parseUtcInstant(timeField(row, "occurred_at")),
    subject: {
      kind: enumField(row, "subject_kind", [
        "gateway",
        "service-account",
        "system",
        "user",
      ] as const),
      subjectId: stringField(row, "subject_id"),
    },
    action: stringField(row, "action"),
    resource: {
      kind: stringField(row, "resource_kind"),
      resourceId: stringField(row, "resource_id"),
    },
    outcome: enumField(row, "outcome", [
      "accepted",
      "denied",
      "failed",
      "succeeded",
      "unknown",
    ] as const),
    risk: enumField(row, "risk", [
      "critical",
      "high",
      "low",
      "medium",
    ] as const),
    confirmation: enumField(row, "confirmation", [
      "explicit",
      "not-required",
    ] as const),
    correlationId: stringField(row, "correlation_id"),
    ...(traceId === undefined ? {} : { traceId }),
    ...(detailsDigest === undefined
      ? {}
      : { detailsDigest: parseContentDigest(detailsDigest) }),
  });
}

function searchValues(
  scope: AuditScope,
  query: AuditEventSearch,
): readonly unknown[] {
  return [
    scope.tenantId,
    scope.projectId,
    query.cursor ?? null,
    query.action ?? null,
    query.subjectId ?? null,
    query.resourceKind ?? null,
    query.resourceId ?? null,
    query.from ?? null,
    query.to ?? null,
    query.limit + 1,
  ];
}

export class PostgresAuditEventRepository implements AuditEventRepository {
  readonly #pool: PostgresAuditPool;

  constructor(pool: PostgresAuditPool) {
    this.#pool = pool;
  }

  async search(
    scope: AuditScope,
    query: AuditEventSearch,
  ): Promise<AuditEventSearchResult> {
    let client: PostgresAuditClient | undefined;
    let transactionStarted = false;
    try {
      client = await this.#pool.connect();
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(setTenantSql, [scope.tenantId]);
      const result = await client.query<Row>(
        searchSql,
        searchValues(scope, query),
      );
      const decoded = result.rows.map(decodeRow);
      const events = Object.freeze(decoded.slice(0, query.limit));
      const hasMore = decoded.length > events.length;
      const nextCursor = events.at(-1)?.sequence;
      await client.query("COMMIT");
      return {
        outcome: "found",
        events,
        ...(hasMore && nextCursor !== undefined ? { nextCursor } : {}),
      };
    } catch {
      if (client !== undefined && transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The typed storage outcome remains authoritative.
        }
      }
      return { outcome: "storage-unavailable" };
    } finally {
      client?.release();
    }
  }
}
