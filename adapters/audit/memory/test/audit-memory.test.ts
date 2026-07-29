import { describe, expect, it } from "vitest";

import { SearchAuditEvents } from "@aether-cloud/application";
import {
  defineAuditEvent,
  parseAuditEventId,
  parseAuditSequence,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";

import { InMemoryAuditEventStore } from "../src/index.js";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function event(
  sequence: string,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return defineAuditEvent({
    eventId: parseAuditEventId(`audit-event-${sequence.padStart(8, "0")}`),
    sequence: parseAuditSequence(sequence),
    tenantId: parseTenantId(tenantId),
    projectId: parseProjectId(projectId),
    occurredAt: parseUtcInstant(`2026-07-15T00:00:0${sequence}.000Z`),
    subject: { kind: "user", subjectId: "operator-1" },
    action: "edge.job.create",
    resource: {
      kind: "governed-job",
      resourceId: `job-${sequence.padStart(8, "0")}`,
    },
    outcome: "accepted",
    risk: "medium",
    confirmation: "not-required",
    correlationId: `request-${sequence.padStart(8, "0")}`,
    ...overrides,
  });
}

describe("InMemoryAuditEventStore", () => {
  it("keeps exact replay idempotent and conflicting immutable evidence closed", () => {
    const store = new InMemoryAuditEventStore();
    expect(store.record(event("1"))).toEqual({ outcome: "inserted" });
    expect(store.record(event("1"))).toEqual({ outcome: "replayed" });
    expect(
      store.record(event("1", { action: "edge.job.cancel-request" })),
    ).toEqual({ outcome: "conflict" });
    expect(store.eventCount()).toBe(1);
  });

  it("filters inside Tenant scope and paginates by lossless cursor", async () => {
    const store = new InMemoryAuditEventStore();
    store.record(event("1"));
    store.record(event("2"));
    store.record(event("3", { action: "edge.job.cancel-request" }));
    const search = new SearchAuditEvents({ repository: store });
    const context = {
      tenantId,
      projectId,
      subjectId: "auditor-1",
      permissions: ["audit.event.read"],
    };

    expect(await search.execute(context, { limit: 2 })).toMatchObject({
      ok: true,
      value: {
        items: [{ sequence: "3" }, { sequence: "2" }],
        nextCursor: "2",
      },
    });
    expect(
      await search.execute(context, { cursor: "2", limit: 2 }),
    ).toMatchObject({
      ok: true,
      value: { items: [{ sequence: "1" }], nextCursor: null },
    });
    expect(
      await search.execute(
        { ...context, tenantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
        { limit: 10 },
      ),
    ).toMatchObject({ ok: true, value: { items: [] } });
  });

  it("applies every filter without leaking mismatched evidence", async () => {
    const store = new InMemoryAuditEventStore();
    store.record(
      event("1", {
        subject: { kind: "service-account", subjectId: "integration-1" },
        resource: { kind: "telemetry-batch", resourceId: "batch-00000001" },
        action: "telemetry.batch.ingest",
      }),
    );
    store.record(event("2"));
    const scope = {
      tenantId: parseTenantId(tenantId),
      projectId: parseProjectId(projectId),
    };

    expect(
      await store.search(scope, {
        limit: 10,
        cursor: parseAuditSequence("2"),
        action: "telemetry.batch.ingest",
        subjectId: "integration-1",
        resourceKind: "telemetry-batch",
        resourceId: "batch-00000001",
        from: parseUtcInstant("2026-07-15T00:00:00.000Z"),
        to: parseUtcInstant("2026-07-15T00:00:01.000Z"),
      }),
    ).toMatchObject({ events: [{ sequence: "1" }] });

    for (const query of [
      { limit: 10, action: "other.action" },
      { limit: 10, subjectId: "other-subject" },
      { limit: 10, resourceKind: "other-kind" },
      { limit: 10, resourceId: "other-resource-0001" },
      { limit: 10, from: parseUtcInstant("2026-07-15T00:00:03.000Z") },
      { limit: 10, to: parseUtcInstant("2026-07-14T23:59:59.000Z") },
    ]) {
      expect(await store.search(scope, query)).toEqual({
        outcome: "found",
        events: [],
      });
    }
  });
});
