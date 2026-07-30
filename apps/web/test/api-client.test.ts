import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AetherCloudApiClient,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

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
              reason: "heartbeat-current",
              sessionId: "44444444-4444-4444-8444-444444444444",
              sessionState: "active",
              protocolVersion: "1.0",
              lastSeenAt: "2026-07-29T11:59:50.000Z",
              staleAfter: "2026-07-29T12:01:20.000Z",
            },
            telemetry: {
              status: "receiving",
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
      connection: {
        status: "online",
        reason: "heartbeat-current",
        protocolVersion: "1.0",
      },
      telemetry: {
        status: "receiving",
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

  it("issues a governed one-time Enrollment Claim", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          schema: "aether.cloud.gateway-enrollment-issued.v1",
          gatewayId: "33333333-3333-4333-8333-333333333333",
          state: "awaiting-claim",
          revision: 2,
          expiresAt: "2026-07-29T10:10:00.000Z",
          enrollmentToken: "opaque-token-with-sufficient-entropy",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await new AetherCloudApiClient(
      "https://api.aetheriot.dev",
    ).issueGatewayEnrollment(
      "access-token",
      "33333333-3333-4333-8333-333333333333",
      "issue-request-001",
    );

    expect(result.state).toBe("awaiting-claim");
    const calls = fetch.mock.calls as unknown as readonly (readonly [
      URL,
      RequestInit,
    ])[];
    expect(calls[0]?.[0].toString()).toBe(
      "https://api.aetheriot.dev/api/v1/fleet/gateways/33333333-3333-4333-8333-333333333333/enrollment-claims",
    );
    expect(calls[0]?.[1].method).toBe("POST");
    expect(calls[0]?.[1].headers).toMatchObject({
      "x-aethercloud-confirmation": "issue-enrollment-claim",
    });
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
