import { describe, expect, it } from "vitest";

import { SearchAuditEvents } from "../src/index.js";
import type { AuditEventRepository } from "../src/index.js";
import {
  defineAuditEvent,
  parseAuditEventId,
  parseAuditSequence,
  parseContentDigest,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const event = defineAuditEvent({
  eventId: parseAuditEventId("audit-event-00000001"),
  sequence: parseAuditSequence("7"),
  tenantId: parseTenantId(tenantId),
  projectId: parseProjectId(projectId),
  occurredAt: parseUtcInstant("2026-07-15T00:00:00.000Z"),
  subject: { kind: "service-account", subjectId: "integration-1" },
  action: "telemetry.batch.ingest",
  resource: { kind: "telemetry-batch", resourceId: "batch-00000001" },
  outcome: "succeeded",
  risk: "low",
  confirmation: "not-required",
  correlationId: "request-00000001",
});

function context(permissions = ["audit.event.read"]) {
  return {
    tenantId,
    projectId,
    subjectId: "auditor-1",
    permissions,
  };
}

describe("SearchAuditEvents", () => {
  it("validates a bounded Tenant query and returns an opaque next cursor", async () => {
    let observedScope: unknown;
    let observedQuery: unknown;
    const repository: AuditEventRepository = {
      search: (scope, query) => {
        observedScope = scope;
        observedQuery = query;
        return Promise.resolve({
          events: [event],
          nextCursor: parseAuditSequence("7"),
        });
      },
    };

    const result = await new SearchAuditEvents({ repository }).execute(
      context(),
      { action: "telemetry.batch.ingest", limit: 25 },
    );

    expect(observedScope).toMatchObject({ tenantId, projectId });
    expect(observedQuery).toMatchObject({
      action: "telemetry.batch.ingest",
      limit: 25,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        items: [{ eventId: "audit-event-00000001", sequence: "7" }],
        nextCursor: "7",
      },
    });
  });

  it("denies missing permission and rejects unbounded input", async () => {
    const query = new SearchAuditEvents({
      repository: {
        search: () => Promise.resolve({ events: [], nextCursor: undefined }),
      },
    });

    expect(await query.execute(context([]), { limit: 25 })).toMatchObject({
      ok: false,
      failure: { code: "permission-denied" },
    });
    expect(await query.execute(context(), { limit: 101 })).toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
  });

  it("validates every external context and bounded optional filter", async () => {
    const query = new SearchAuditEvents({
      repository: {
        search: () => Promise.resolve({ events: [], nextCursor: undefined }),
      },
    });
    for (const invalidContext of [
      null,
      { ...context(), extra: true },
      { tenantId, projectId, subjectId: "auditor-1" },
      { ...context(), tenantId: "bad-tenant" },
      { ...context(), subjectId: "bad subject" },
      { ...context(), permissions: "audit.event.read" },
      { ...context(), permissions: [7] },
    ]) {
      expect(await query.execute(invalidContext, { limit: 10 })).toMatchObject({
        ok: false,
        failure: { code: "invalid-input" },
      });
    }
    for (const invalidSearch of [
      null,
      {},
      { limit: 10, tenantId },
      { limit: "10" },
      { limit: 1.5 },
      { limit: 0 },
      { limit: 10, cursor: "01" },
      { limit: 10, action: "bad action" },
      { limit: 10, subjectId: "bad subject" },
      { limit: 10, resourceKind: "bad kind" },
      { limit: 10, resourceId: "short" },
      { limit: 10, from: "not-a-time" },
      {
        limit: 10,
        from: "2026-07-16T00:00:00.000Z",
        to: "2026-07-15T00:00:00.000Z",
      },
    ]) {
      expect(await query.execute(context(), invalidSearch)).toMatchObject({
        ok: false,
        failure: { code: "invalid-input" },
      });
    }
  });

  it("decodes all optional filters and projects optional evidence", async () => {
    let observed: unknown;
    const withEvidence = defineAuditEvent({
      ...event,
      eventId: parseAuditEventId("audit-event-00000002"),
      sequence: parseAuditSequence("8"),
      correlationId: "request-00000002",
      traceId: "a".repeat(32),
      detailsDigest: parseContentDigest("b".repeat(64)),
    });
    const query = new SearchAuditEvents({
      repository: {
        search: (_scope, search) => {
          observed = search;
          return Promise.resolve({
            events: [withEvidence],
            nextCursor: undefined,
          });
        },
      },
    });
    const result = await query.execute(context(), {
      limit: 100,
      cursor: "9",
      action: "telemetry.batch.ingest",
      subjectId: "integration-1",
      resourceKind: "telemetry-batch",
      resourceId: "batch-00000001",
      from: "2026-07-14T00:00:00.000Z",
      to: "2026-07-16T00:00:00.000Z",
    });

    expect(observed).toMatchObject({ cursor: "9", limit: 100 });
    expect(result).toMatchObject({
      ok: true,
      value: {
        nextCursor: null,
        items: [
          {
            traceId: "a".repeat(32),
            detailsDigest: "b".repeat(64),
          },
        ],
      },
    });
  });
});
