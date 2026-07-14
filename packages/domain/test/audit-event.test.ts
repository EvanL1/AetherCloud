import { describe, expect, it } from "vitest";

import {
  defineAuditEvent,
  parseAuditEventId,
  parseAuditSequence,
  parseContentDigest,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "../src/index.js";

describe("Audit Event", () => {
  const valid = defineAuditEvent({
    eventId: parseAuditEventId("audit-event-00000002"),
    sequence: parseAuditSequence("2"),
    tenantId: parseTenantId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    projectId: parseProjectId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    occurredAt: parseUtcInstant("2026-07-15T00:00:00.000Z"),
    subject: { kind: "system", subjectId: "audit-writer-1" },
    action: "audit.event.record",
    resource: { kind: "audit-event", resourceId: "audit-event-00000002" },
    outcome: "succeeded",
    risk: "low",
    confirmation: "not-required",
    correlationId: "request-00000002",
    traceId: "a".repeat(32),
  });

  it("preserves immutable governed evidence with a lossless sequence", () => {
    const event = defineAuditEvent({
      eventId: parseAuditEventId("audit-event-00000001"),
      sequence: parseAuditSequence("18446744073709551615"),
      tenantId: parseTenantId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      projectId: parseProjectId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      occurredAt: parseUtcInstant("2026-07-15T00:00:00.000Z"),
      subject: { kind: "user", subjectId: "operator-1" },
      action: "edge.job.confirm",
      resource: {
        kind: "governed-job",
        resourceId: "11111111-1111-4111-8111-111111111111",
      },
      outcome: "accepted",
      risk: "high",
      confirmation: "explicit",
      correlationId: "request-00000001",
      detailsDigest: parseContentDigest("a".repeat(64)),
    });

    expect(event.sequence).toBe("18446744073709551615");
    expect(event).toMatchObject({
      action: "edge.job.confirm",
      subject: { kind: "user", subjectId: "operator-1" },
      outcome: "accepted",
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.subject)).toBe(true);
  });

  it("rejects unsafe numeric and out-of-range audit sequences", () => {
    expect(() => parseAuditSequence(1)).toThrow(/decimal string/u);
    expect(() => parseAuditSequence("01")).toThrow(/decimal string/u);
    expect(() => parseAuditSequence("18446744073709551616")).toThrow(/uint64/u);
    expect(() => parseAuditEventId("short")).toThrow();
  });

  it("rejects invalid authority, governance, correlation, and optional evidence", () => {
    expect(() =>
      defineAuditEvent({ ...valid, sequence: parseAuditSequence("0") }),
    ).toThrow(/positive/u);
    expect(() =>
      defineAuditEvent({
        ...valid,
        subject: { kind: "robot" as "user", subjectId: "subject-1" },
      }),
    ).toThrow(/subject kind/u);
    expect(() =>
      defineAuditEvent({ ...valid, outcome: "maybe" as "succeeded" }),
    ).toThrow(/outcome/u);
    expect(() =>
      defineAuditEvent({ ...valid, risk: "extreme" as "high" }),
    ).toThrow(/risk/u);
    expect(() =>
      defineAuditEvent({
        ...valid,
        confirmation: "implicit" as "explicit",
      }),
    ).toThrow(/confirmation/u);
    for (const candidate of [
      { ...valid, traceId: "A".repeat(32) },
      { ...valid, subject: { ...valid.subject, subjectId: "bad subject" } },
      { ...valid, action: "bad action" },
      { ...valid, resource: { ...valid.resource, kind: "bad kind" } },
      { ...valid, resource: { ...valid.resource, resourceId: "short" } },
      { ...valid, correlationId: "short" },
    ]) {
      expect(() => defineAuditEvent(candidate)).toThrow();
    }
    expect(() =>
      defineAuditEvent({
        ...valid,
        detailsDigest: "bad" as ReturnType<typeof parseContentDigest>,
      }),
    ).toThrow();
    expect(valid.detailsDigest).toBeUndefined();
  });
});
