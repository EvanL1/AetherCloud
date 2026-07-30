import { describe, expect, it } from "vitest";

import {
  GetFleetGateway,
  ListFleetGateways,
  type ApplicationClock,
  type FleetGatewayQueryRepository,
  type FleetGatewaySnapshot,
} from "../src/index.js";
import {
  parseGatewayId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");

class FixedClock implements ApplicationClock {
  now() {
    return parseUtcInstant("2026-07-29T12:00:00.000Z");
  }
}

function snapshot(
  overrides: Partial<FleetGatewaySnapshot> = {},
): FleetGatewaySnapshot {
  return {
    tenantId,
    projectId,
    gatewayId,
    displayName: "Warehouse gateway",
    enrollmentState: "claimed",
    revision: 3,
    registeredAt: parseUtcInstant("2026-07-29T10:00:00.000Z"),
    session: {
      sessionId: "44444444-4444-4444-8444-444444444444",
      state: "active",
      protocolVersion: "1.0",
      openedAt: parseUtcInstant("2026-07-29T11:57:50.000Z"),
      activatedAt: parseUtcInstant("2026-07-29T11:58:00.000Z"),
      lastHeartbeatAt: parseUtcInstant("2026-07-29T11:59:50.000Z"),
      heartbeatIntervalMs: "30000",
    },
    telemetry: {
      recordCount: "42",
      lastReceivedAt: parseUtcInstant("2026-07-29T11:59:45.000Z"),
      latest: {
        streamId: "points",
        streamEpoch: "1",
        position: "42",
        sourceTimestampMs: "1785326385000",
        kind: "point-sample",
        payload: { pointId: "temperature", value: "21.4" },
      },
    },
    ...overrides,
  };
}

class Repository implements FleetGatewayQueryRepository {
  result:
    | Readonly<{
        outcome: "found";
        gateway: FleetGatewaySnapshot;
      }>
    | Readonly<{ outcome: "not-found" | "storage-unavailable" }> = {
    outcome: "found",
    gateway: snapshot(),
  };

  list() {
    return Promise.resolve({
      outcome: "found" as const,
      gateways: [snapshot()],
      nextCursor: null,
    });
  }

  get() {
    return Promise.resolve(this.result);
  }
}

const context = {
  tenantId,
  projectId,
  subjectId: "operator:alice",
  permissions: ["fleet.gateway.read"],
};

describe("Fleet gateway queries", () => {
  it("lists Tenant-scoped gateways with real connection and telemetry summaries", async () => {
    const query = new ListFleetGateways({
      repository: new Repository(),
      clock: new FixedClock(),
    });

    const result = await query.execute(context, { limit: 25 });
    expect(result).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            gatewayId,
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
              recordCount: "42",
              latest: { position: "42" },
            },
          },
        ],
        nextCursor: null,
      },
    });
  });

  it("classifies stale active sessions without trusting a browser status", async () => {
    const repository = new Repository();
    repository.result = {
      outcome: "found",
      gateway: snapshot({
        session: {
          sessionId: "44444444-4444-4444-8444-444444444444",
          state: "active",
          openedAt: parseUtcInstant("2026-07-29T11:49:50.000Z"),
          activatedAt: parseUtcInstant("2026-07-29T11:50:00.000Z"),
          lastHeartbeatAt: parseUtcInstant("2026-07-29T11:51:00.000Z"),
          heartbeatIntervalMs: "30000",
        },
      }),
    };
    const query = new GetFleetGateway({
      repository,
      clock: new FixedClock(),
    });

    const result = await query.execute(context, { gatewayId });
    expect(result).toMatchObject({
      ok: true,
      value: {
        connection: {
          status: "stale",
          reason: "heartbeat-overdue",
          staleAfter: "2026-07-29T11:52:30.000Z",
        },
      },
    });
  });

  it("preserves the latest closed session as offline diagnostic evidence", async () => {
    const repository = new Repository();
    repository.result = {
      outcome: "found",
      gateway: snapshot({
        session: {
          sessionId: "44444444-4444-4444-8444-444444444444",
          state: "closed",
          protocolVersion: "1.0",
          openedAt: parseUtcInstant("2026-07-29T11:40:00.000Z"),
          activatedAt: parseUtcInstant("2026-07-29T11:41:00.000Z"),
          lastHeartbeatAt: parseUtcInstant("2026-07-29T11:50:00.000Z"),
          heartbeatIntervalMs: "30000",
          closedAt: parseUtcInstant("2026-07-29T11:51:30.000Z"),
          closeReason: "heartbeat-timeout",
        },
        telemetry: { recordCount: "0" },
      }),
    };
    const query = new GetFleetGateway({
      repository,
      clock: new FixedClock(),
    });

    await expect(query.execute(context, { gatewayId })).resolves.toMatchObject({
      ok: true,
      value: {
        connection: {
          status: "offline",
          reason: "session-closed",
          lastSeenAt: "2026-07-29T11:50:00.000Z",
          closedAt: "2026-07-29T11:51:30.000Z",
          closeReason: "heartbeat-timeout",
        },
        telemetry: { status: "no-data", recordCount: "0" },
      },
    });
  });

  it("fails closed without Fleet permission", async () => {
    const query = new ListFleetGateways({
      repository: new Repository(),
      clock: new FixedClock(),
    });

    await expect(
      query.execute({ ...context, permissions: [] }, { limit: 25 }),
    ).resolves.toEqual({
      ok: false,
      failure: {
        code: "permission-denied",
        message: "permission fleet.gateway.read is required",
      },
    });
  });

  it("returns typed not-found and storage failures", async () => {
    const repository = new Repository();
    const query = new GetFleetGateway({
      repository,
      clock: new FixedClock(),
    });
    repository.result = { outcome: "not-found" };
    await expect(query.execute(context, { gatewayId })).resolves.toEqual({
      ok: false,
      failure: { code: "gateway-not-found", message: "gateway was not found" },
    });
    repository.result = { outcome: "storage-unavailable" };
    await expect(query.execute(context, { gatewayId })).resolves.toEqual({
      ok: false,
      failure: {
        code: "gateway-storage-unavailable",
        message: "Fleet storage is unavailable",
      },
    });
  });
});
