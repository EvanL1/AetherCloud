import { describe, expect, it } from "vitest";

import {
  buildAuditSearchUrl,
  decodeAuditSearchResponse,
} from "../src/api-client.js";

const event = {
  eventId: "event-1",
  sequence: "42",
  occurredAt: "2026-07-29T10:00:00.000Z",
  subject: { kind: "user", subjectId: "user-1" },
  action: "audit.event.read",
  resource: { kind: "audit", resourceId: "event-1" },
  outcome: "succeeded",
  risk: "low",
  confirmation: "not-required",
  correlationId: "correlation-1",
};

describe("AetherCloud web API client", () => {
  it("decodes the bounded Audit response without converting int64 sequences", () => {
    expect(
      decodeAuditSearchResponse({ items: [event], nextCursor: "cursor-2" }),
    ).toEqual({ items: [event], nextCursor: "cursor-2" });
  });

  it("rejects malformed external Audit responses", () => {
    expect(() =>
      decodeAuditSearchResponse({
        items: [{ ...event, sequence: 42 }],
        nextCursor: null,
      }),
    ).toThrow("invalid Audit response");
  });

  it("builds only supported Audit filters", () => {
    expect(
      buildAuditSearchUrl("https://api.aetheriot.dev", {
        action: "gateway.enrolled",
        limit: 25,
        resourceId: "gateway-1",
      }).toString(),
    ).toBe(
      "https://api.aetheriot.dev/api/v1/audit/events?limit=25&action=gateway.enrolled&resourceId=gateway-1",
    );
  });
});
