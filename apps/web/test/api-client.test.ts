import { describe, expect, it } from "vitest";

import {
  buildAuditSearchUrl,
  buildFleetListUrl,
  decodeAuditSearchResponse,
  decodeFleetListResponse,
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

  it("decodes Fleet connection and telemetry summaries without unsafe numbers", () => {
    expect(
      decodeFleetListResponse({
        items: [
          {
            gatewayId: "33333333-3333-4333-8333-333333333333",
            displayName: "Warehouse gateway",
            enrollmentState: "claimed",
            revision: 3,
            registeredAt: "2026-07-29T10:00:00.000Z",
            connection: {
              status: "online",
              sessionState: "active",
              lastSeenAt: "2026-07-29T11:59:50.000Z",
            },
            telemetry: {
              recordCount: "9007199254740993",
              latest: {
                streamId: "points",
                streamEpoch: "1",
                position: "9007199254740993",
                sourceTimestampMs: "1785326385000",
                kind: "point-sample",
                payload: { pointId: "temperature", value: "21.4" },
              },
            },
          },
        ],
        nextCursor: null,
      }).items[0],
    ).toMatchObject({
      displayName: "Warehouse gateway",
      connection: { status: "online" },
      telemetry: {
        recordCount: "9007199254740993",
        latest: { position: "9007199254740993" },
      },
    });
  });

  it("rejects malformed Fleet responses", () => {
    expect(() =>
      decodeFleetListResponse({
        items: [{ gatewayId: "forged" }],
        nextCursor: null,
      }),
    ).toThrow("invalid Fleet response");
  });

  it("builds the bounded Fleet list URL", () => {
    expect(buildFleetListUrl("https://api.aetheriot.dev", 50).toString()).toBe(
      "https://api.aetheriot.dev/api/v1/fleet/gateways?limit=50",
    );
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
