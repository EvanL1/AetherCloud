import { describe, expect, it } from "vitest";

import {
  activateCloudLinkSession,
  createCloudLinkSession,
  fenceCloudLinkSession,
  markCloudLinkSessionSuspect,
  negotiateCloudLinkSession,
  observeCloudLinkHeartbeat,
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseProtocolVersion,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
  parseTenantId,
  parseUtcInstant,
} from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const sessionId = parseCloudLinkSessionId(
  "44444444-4444-4444-8444-444444444444",
);
const generation = parseGatewayCredentialGeneration("1");
const epoch = parseCloudLinkSessionEpoch("7");

function negotiatingSession() {
  return createCloudLinkSession({
    tenantId,
    projectId,
    gatewayId,
    sessionId,
    credentialGeneration: generation,
    epoch,
    openedAt: parseUtcInstant("2026-07-14T08:00:00.000Z"),
  });
}

function activeSession() {
  const negotiated = negotiateCloudLinkSession(
    negotiatingSession(),
    parseProtocolVersion("1.0"),
  );
  expect(negotiated.ok).toBe(true);
  if (!negotiated.ok) throw new Error("test negotiation failed");
  const activated = activateCloudLinkSession(negotiated.value, {
    activatedAt: parseUtcInstant("2026-07-14T08:00:01.000Z"),
    resumeCursors: [
      {
        streamId: parseStreamId("telemetry"),
        streamEpoch: parseStreamEpoch("9"),
        position: parseStreamPosition("18446744073709551615"),
      },
    ],
  });
  expect(activated.ok).toBe(true);
  if (!activated.ok) throw new Error("test activation failed");
  return activated.value;
}

describe("CloudLink session domain", () => {
  it("preserves protocol uint64 values without JavaScript number conversion", () => {
    expect(parseStreamPosition("18446744073709551615")).toBe(
      "18446744073709551615",
    );
    expect(() => parseStreamPosition(7)).toThrow();
    expect(() => parseStreamPosition("01")).toThrow();
    expect(() => parseStreamPosition("18446744073709551616")).toThrow();
  });

  it("negotiates and activates with cloud-owned durable resume cursors", () => {
    const session = activeSession();

    expect(session).toMatchObject({
      state: "active",
      tenantId,
      projectId,
      gatewayId,
      sessionId,
      credentialGeneration: "1",
      epoch: "7",
      protocolVersion: "1.0",
      revision: 3,
      resumeCursors: [
        {
          streamId: "telemetry",
          streamEpoch: "9",
          position: "18446744073709551615",
        },
      ],
    });
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.resumeCursors)).toBe(true);
  });

  it("rejects duplicate streams and invalid state transitions", () => {
    const negotiated = negotiateCloudLinkSession(
      negotiatingSession(),
      parseProtocolVersion("1.0"),
    );
    expect(negotiated.ok).toBe(true);
    if (!negotiated.ok) return;

    const duplicate = activateCloudLinkSession(negotiated.value, {
      activatedAt: parseUtcInstant("2026-07-14T08:00:01.000Z"),
      resumeCursors: [
        {
          streamId: parseStreamId("telemetry"),
          streamEpoch: parseStreamEpoch("1"),
          position: parseStreamPosition("1"),
        },
        {
          streamId: parseStreamId("telemetry"),
          streamEpoch: parseStreamEpoch("1"),
          position: parseStreamPosition("2"),
        },
      ],
    });
    const renegotiate = negotiateCloudLinkSession(
      activeSession(),
      parseProtocolVersion("1.0"),
    );

    expect(duplicate).toMatchObject({
      ok: false,
      failure: { code: "duplicate-cloudlink-stream" },
    });
    expect(renegotiate).toMatchObject({
      ok: false,
      failure: { code: "invalid-cloudlink-session-transition" },
    });
  });

  it("records heartbeat replay and recovers a suspect session", () => {
    const session = activeSession();
    const first = observeCloudLinkHeartbeat(session, {
      epoch,
      requestId: "heartbeat-request-001",
      observedAt: parseUtcInstant("2026-07-14T08:01:00.000Z"),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replay = observeCloudLinkHeartbeat(first.value, {
      epoch,
      requestId: "heartbeat-request-001",
      observedAt: parseUtcInstant("2026-07-14T08:01:01.000Z"),
    });
    const suspect = markCloudLinkSessionSuspect(
      first.value,
      parseUtcInstant("2026-07-14T08:02:00.000Z"),
    );
    expect(suspect.ok).toBe(true);
    if (!suspect.ok) return;
    const recovered = observeCloudLinkHeartbeat(suspect.value, {
      epoch,
      requestId: "heartbeat-request-002",
      observedAt: parseUtcInstant("2026-07-14T08:02:01.000Z"),
    });

    expect(replay).toEqual({ ok: true, replayed: true, value: first.value });
    expect(recovered).toMatchObject({
      ok: true,
      replayed: false,
      value: { state: "active", lastHeartbeatAt: "2026-07-14T08:02:01.000Z" },
    });
  });

  it("fences old epochs and rejects their late heartbeat", () => {
    const fenced = fenceCloudLinkSession(
      activeSession(),
      parseUtcInstant("2026-07-14T08:03:00.000Z"),
    );
    expect(fenced.ok).toBe(true);
    if (!fenced.ok) return;

    expect(fenced.value).toMatchObject({
      state: "closed",
      closeReason: "fenced",
    });
    expect(
      observeCloudLinkHeartbeat(fenced.value, {
        epoch,
        requestId: "heartbeat-request-late",
        observedAt: parseUtcInstant("2026-07-14T08:03:01.000Z"),
      }),
    ).toMatchObject({
      ok: false,
      failure: { code: "invalid-cloudlink-session-transition" },
    });
  });
});
