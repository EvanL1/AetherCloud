import { describe, expect, it } from "vitest";

import {
  parseAuditSequence,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";

import {
  PostgresAuditEventRepository,
  type PostgresAuditClient,
  type PostgresAuditPool,
  type PostgresAuditQueryResult,
} from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");

function row(sequence: string) {
  return {
    event_id: `audit-event-${sequence.padStart(8, "0")}`,
    sequence,
    tenant_id: tenantId,
    project_id: projectId,
    occurred_at: new Date("2026-07-28T14:00:00.000Z"),
    subject_kind: "service-account",
    subject_id: "service:cloudlink",
    action: "telemetry.batch.ingest",
    resource_kind: "telemetry-batch",
    resource_id: `batch-${sequence.padStart(8, "0")}`,
    outcome: "accepted",
    risk: "low",
    confirmation: "not-required",
    correlation_id: `request-${sequence.padStart(8, "0")}`,
    trace_id: "a".repeat(32),
    details_digest: "b".repeat(64),
  };
}

class ScriptedClient implements PostgresAuditClient {
  readonly statements: { text: string; values: readonly unknown[] }[] = [];
  readonly #rows: readonly Record<string, unknown>[];
  readonly #failAt: number | undefined;
  released = false;

  constructor(rows: readonly Record<string, unknown>[], failAt?: number) {
    this.#rows = rows;
    this.#failAt = failAt;
  }

  query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresAuditQueryResult<Row>> {
    this.statements.push({ text, values });
    if (this.#failAt === this.statements.length) {
      return Promise.reject(new Error("database unavailable"));
    }
    return Promise.resolve({
      rows: (text.includes("FROM aethercloud.audit_events")
        ? this.#rows
        : []) as readonly Row[],
      rowCount: text.includes("FROM aethercloud.audit_events")
        ? this.#rows.length
        : null,
    });
  }

  release(): void {
    this.released = true;
  }
}

function poolFor(client: ScriptedClient): PostgresAuditPool {
  return { connect: () => Promise.resolve(client) };
}

describe("PostgresAuditEventRepository", () => {
  it("sets Tenant scope, applies every bounded filter, and paginates", async () => {
    const client = new ScriptedClient([row("9"), row("8"), row("7")]);
    const repository = new PostgresAuditEventRepository(poolFor(client));

    const result = await repository.search(
      { tenantId, projectId },
      {
        limit: 2,
        cursor: parseAuditSequence("10"),
        action: "telemetry.batch.ingest",
        subjectId: "service:cloudlink",
        resourceKind: "telemetry-batch",
        resourceId: "batch-00000009",
        from: parseUtcInstant("2026-07-28T13:00:00.000Z"),
        to: parseUtcInstant("2026-07-28T15:00:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      outcome: "found",
      events: [
        {
          sequence: "9",
          traceId: "a".repeat(32),
          detailsDigest: "b".repeat(64),
        },
        { sequence: "8" },
      ],
      nextCursor: "8",
    });
    expect(client.statements.map(({ text }) => text)).toEqual([
      "BEGIN",
      expect.stringContaining("set_config"),
      expect.stringContaining("FROM aethercloud.audit_events"),
      "COMMIT",
    ]);
    expect(client.statements[1]?.values).toEqual([tenantId]);
    expect(client.statements[2]?.values).toEqual([
      tenantId,
      projectId,
      "10",
      "telemetry.batch.ingest",
      "service:cloudlink",
      "telemetry-batch",
      "batch-00000009",
      "2026-07-28T13:00:00.000Z",
      "2026-07-28T15:00:00.000Z",
      3,
    ]);
    expect(client.released).toBe(true);
  });

  it("returns a typed unavailable outcome and rolls back", async () => {
    const client = new ScriptedClient([], 3);
    const repository = new PostgresAuditEventRepository(poolFor(client));

    await expect(
      repository.search({ tenantId, projectId }, { limit: 10 }),
    ).resolves.toEqual({ outcome: "storage-unavailable" });
    expect(client.statements.map(({ text }) => text)).toEqual([
      "BEGIN",
      expect.stringContaining("set_config"),
      expect.stringContaining("FROM aethercloud.audit_events"),
      "ROLLBACK",
    ]);
    expect(client.released).toBe(true);
  });

  it("rejects malformed database rows as unavailable", async () => {
    const client = new ScriptedClient([{ ...row("9"), sequence: 9 }]);
    const repository = new PostgresAuditEventRepository(poolFor(client));

    await expect(
      repository.search({ tenantId, projectId }, { limit: 10 }),
    ).resolves.toEqual({ outcome: "storage-unavailable" });
    expect(client.statements.at(-1)?.text).toBe("ROLLBACK");
  });
});
