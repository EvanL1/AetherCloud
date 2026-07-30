import { describe, expect, it } from "vitest";

import {
  markCloudLinkSessionSuspect,
  parseCloudLinkSessionEpoch,
  parseGatewayCredentialGeneration,
  parseProtocolVersion,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
  parseUtcInstant,
} from "@aether-cloud/domain";

import {
  CloudLinkPostgresStorageError,
  PostgresCloudLinkSessionRepository,
  type PostgresCloudLinkSessionClient,
  type PostgresCloudLinkSessionPool,
  type PostgresCloudLinkSessionQueryResult,
} from "../src/index.js";
import {
  binding,
  challengeId,
  challengeRecord,
  challengeRow,
  firstSessionId,
  gatewayId,
  openInput,
  openedAt,
  projectId,
  secondSessionId,
  sessionRow,
  tenantId,
} from "./fixtures.js";

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

function result(
  rows: readonly Record<string, unknown>[] = [],
  rowCount = rows.length,
): PostgresCloudLinkSessionQueryResult<Record<string, unknown>> {
  return { rows, rowCount };
}

class ScenarioClient implements PostgresCloudLinkSessionClient {
  readonly calls: QueryCall[] = [];
  released = false;
  handler:
    | ((
        text: string,
        values: readonly unknown[],
      ) =>
        | PostgresCloudLinkSessionQueryResult<Record<string, unknown>>
        | Error
        | undefined)
    | undefined;

  query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresCloudLinkSessionQueryResult<Row>> {
    this.calls.push({ text, values });
    const handled = this.handler?.(text, values);
    if (handled instanceof Error) return Promise.reject(handled);
    return Promise.resolve(
      (handled ??
        result(
          [],
          text.trimStart().startsWith("SELECT") ? 0 : 1,
        )) as PostgresCloudLinkSessionQueryResult<Row>,
    );
  }

  release(): void {
    this.released = true;
  }
}

class ScenarioPool implements PostgresCloudLinkSessionPool {
  readonly client: ScenarioClient;

  constructor(client: ScenarioClient) {
    this.client = client;
  }

  connect(): Promise<PostgresCloudLinkSessionClient> {
    return Promise.resolve(this.client);
  }
}

function repository(client: ScenarioClient) {
  return new PostgresCloudLinkSessionRepository(new ScenarioPool(client));
}

const protocolVersion = parseProtocolVersion("1.0");

function headRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    last_epoch: "0",
    current_session_id: null,
    challenge_window_started_at_ms: null,
    challenge_request_count: 0,
    ...overrides,
  };
}

function route(
  client: ScenarioClient,
  responses: Readonly<
    Record<string, PostgresCloudLinkSessionQueryResult<Record<string, unknown>>>
  >,
): void {
  client.handler = (text) => {
    const match = Object.entries(responses).find(([marker]) =>
      text.includes(marker),
    );
    return match?.[1];
  };
}

describe("PostgresCloudLinkSessionRepository sessions", () => {
  it("opens one active session under a Tenant-scoped Gateway head lock with durable resume cursors", async () => {
    const client = new ScenarioClient();
    route(client, {
      "cloudlink-session:lock-head": result([headRow()]),
      "cloudlink-session:find-open-request": result(),
      "cloudlink-session:select-cursors": result([
        {
          stream_id: "telemetry",
          stream_epoch: "4",
          position: "18",
        },
      ]),
    });

    await expect(repository(client).open(openInput())).resolves.toMatchObject({
      outcome: "opened",
      session: {
        sessionId: firstSessionId,
        epoch: "1",
        state: "active",
        revision: 3,
        protocolVersion: "1.0",
        resumeCursors: [
          { streamId: "telemetry", streamEpoch: "4", position: "18" },
        ],
      },
    });

    const statements = client.calls.map((call) => call.text);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toContain("set_config");
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining("cloudlink-session:ensure-head"),
        expect.stringContaining("cloudlink-session:lock-head"),
        expect.stringContaining("cloudlink-session:insert-session"),
        expect.stringContaining("cloudlink-session:insert-open-request"),
        expect.stringContaining("cloudlink-session:update-head-session"),
      ]),
    );
    expect(statements.at(-1)).toBe("COMMIT");
    expect(client.calls[1]?.values).toEqual([tenantId]);
    expect(client.released).toBe(true);
    for (const statement of statements) {
      expect(statement).not.toContain(tenantId);
      expect(statement).not.toContain(gatewayId);
    }
  });

  it("replays an identical open request and rejects a conflicting idempotency reuse", async () => {
    const replayClient = new ScenarioClient();
    route(replayClient, {
      "cloudlink-session:lock-head": result([
        headRow({ last_epoch: "1", current_session_id: firstSessionId }),
      ]),
      "cloudlink-session:find-open-request": result([
        {
          credential_generation: "3",
          protocol_version: "1.0",
          session_id: firstSessionId,
        },
      ]),
      "cloudlink-session:select-session": result([sessionRow()]),
    });
    await expect(
      repository(replayClient).open(
        openInput("cloudlink-open-request-001", secondSessionId),
      ),
    ).resolves.toMatchObject({
      outcome: "replayed",
      session: { sessionId: firstSessionId },
    });
    expect(
      replayClient.calls.some((call) =>
        call.text.includes("cloudlink-session:insert-session"),
      ),
    ).toBe(false);

    const conflictClient = new ScenarioClient();
    route(conflictClient, {
      "cloudlink-session:lock-head": result([headRow()]),
      "cloudlink-session:find-open-request": result([
        {
          credential_generation: "4",
          protocol_version: "1.0",
          session_id: firstSessionId,
        },
      ]),
    });
    await expect(repository(conflictClient).open(openInput())).resolves.toEqual(
      {
        outcome: "idempotency-conflict",
      },
    );
  });

  it("fences the current session and increments the Gateway epoch in the same transaction", async () => {
    const client = new ScenarioClient();
    route(client, {
      "cloudlink-session:lock-head": result([
        headRow({ last_epoch: "4", current_session_id: firstSessionId }),
      ]),
      "cloudlink-session:find-open-request": result(),
      "cloudlink-session:select-cursors": result(),
    });

    await expect(
      repository(client).open(
        openInput("cloudlink-open-request-002", secondSessionId),
      ),
    ).resolves.toMatchObject({
      outcome: "opened",
      fencedSessionId: firstSessionId,
      session: { sessionId: secondSessionId, epoch: "5" },
    });
    const fence = client.calls.findIndex((call) =>
      call.text.includes("cloudlink-session:fence-current"),
    );
    const insert = client.calls.findIndex((call) =>
      call.text.includes("cloudlink-session:insert-session"),
    );
    expect(fence).toBeGreaterThan(0);
    expect(insert).toBeGreaterThan(fence);
    expect(client.calls.at(-1)?.text).toBe("COMMIT");
  });

  it("rolls back with a sanitized storage failure instead of wrapping an exhausted Gateway epoch", async () => {
    const client = new ScenarioClient();
    route(client, {
      "cloudlink-session:lock-head": result([
        headRow({ last_epoch: "18446744073709551615" }),
      ]),
      "cloudlink-session:find-open-request": result(),
    });

    await expect(repository(client).open(openInput())).rejects.toEqual(
      new CloudLinkPostgresStorageError(),
    );
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(
      client.calls.some((call) =>
        call.text.includes("cloudlink-session:insert-session"),
      ),
    ).toBe(false);
  });

  it("finds scoped sessions, replaces by revision, and distinguishes missing from concurrent modification", async () => {
    const findClient = new ScenarioClient();
    route(findClient, {
      "cloudlink-session:select-session": result([sessionRow()]),
      "cloudlink-session:select-current": result([
        sessionRow({
          gateway_key_id: "gateway-session-key-17",
          heartbeat_interval_ms: "30000",
        }),
      ]),
    });
    const store = repository(findClient);
    await expect(
      store.findById(binding, firstSessionId),
    ).resolves.toMatchObject({
      sessionId: firstSessionId,
      credentialGeneration: "3",
    });
    await expect(
      store.findCurrent({ tenantId, projectId }, gatewayId),
    ).resolves.toMatchObject({
      sessionId: firstSessionId,
      gatewayKeyId: "gateway-session-key-17",
      heartbeatIntervalMs: "30000",
    });

    const replaced = new ScenarioClient();
    route(replaced, {
      "cloudlink-session:replace-session": result([], 1),
    });
    await expect(
      repository(replaced).replace(
        {
          ...sessionRowToDomain(),
          lastHeartbeatAt: openedAt,
          lastHeartbeatRequestId: "heartbeat-request-001",
          revision: 4,
        },
        3,
      ),
    ).resolves.toBe("replaced");

    const conflict = new ScenarioClient();
    route(conflict, {
      "cloudlink-session:replace-session": result([], 0),
      "cloudlink-session:session-exists": result([{ exists: true }]),
    });
    await expect(
      repository(conflict).replace(sessionRowToDomain(), 2),
    ).resolves.toBe("version-conflict");

    const missing = new ScenarioClient();
    route(missing, {
      "cloudlink-session:replace-session": result([], 0),
      "cloudlink-session:session-exists": result(),
    });
    await expect(
      repository(missing).replace(sessionRowToDomain(), 2),
    ).resolves.toBe("not-found");
  });

  it("leases due health work across Tenants and atomically persists evidence", async () => {
    const client = new ScenarioClient();
    route(client, {
      "cloudlink-session-health:lease-due": result([
        sessionRow({
          gateway_key_id: "gateway-key-1",
          heartbeat_interval_ms: "30000",
          last_heartbeat_at: "2026-07-15T08:00:30.000Z",
        }),
      ]),
    });
    const store = repository(client);
    const leaseId = "77777777-7777-4777-8777-777777777777";
    const evaluatedAt = parseUtcInstant("2026-07-15T08:02:00.000Z");

    const leased = await store.leaseDue({
      leaseId,
      evaluatedAt,
      leaseExpiresAt: parseUtcInstant("2026-07-15T08:02:30.000Z"),
      limit: 50,
    });
    expect(leased).toMatchObject({
      outcome: "leased",
      leases: [{ leaseId, session: { state: "active", revision: 3 } }],
    });
    expect(client.calls.map((call) => call.text)).toEqual([
      "BEGIN",
      expect.stringContaining("cloudlink-session-health:lease-due"),
      "COMMIT",
    ]);

    const active =
      leased.outcome === "leased" ? leased.leases[0]?.session : undefined;
    if (active === undefined) throw new Error("expected health lease");
    const suspect = markCloudLinkSessionSuspect(active, evaluatedAt);
    if (!suspect.ok) throw new Error(suspect.failure.message);
    client.calls.length = 0;
    await expect(
      store.complete({
        leaseId,
        session: suspect.value,
        expectedRevision: active.revision,
        evidence: {
          eventId: "88888888-8888-4888-8888-888888888888",
          outboxId: "99999999-9999-4999-8999-999999999999",
          occurredAt: evaluatedAt,
          eventName: "cloudlink.session.suspected.v1",
        },
      }),
    ).resolves.toBe("completed");
    expect(client.calls.map((call) => call.text)).toEqual([
      "BEGIN",
      expect.stringContaining("set_config"),
      expect.stringContaining("cloudlink-session-health:complete"),
      expect.stringContaining("cloudlink-session-health:insert-audit"),
      expect.stringContaining("cloudlink-session-health:insert-outbox"),
      "COMMIT",
    ]);
  });

  it.each([
    ["not-found", result(), result(), "not-found"],
    [
      "stale-session",
      result([sessionRow({ epoch: "2" })]),
      result(),
      "stale-session",
    ],
    ["position-gap", result([sessionRow()]), result(), "position-gap"],
    [
      "recorded",
      result([sessionRow()]),
      result([{ position: "1" }]),
      "recorded",
    ],
    [
      "replayed",
      result([sessionRow()]),
      result([{ position: "2" }]),
      "replayed",
    ],
  ] as const)(
    "returns %s for durable cursor persistence",
    async (_name, session, cursor, expected) => {
      const client = new ScenarioClient();
      route(client, {
        "cloudlink-session:lock-head": result([headRow()]),
        "cloudlink-session:lock-session": session,
        "cloudlink-session:lock-cursor": cursor,
      });
      await expect(
        repository(client).recordDurableCursor({
          binding,
          sessionId: firstSessionId,
          sessionEpoch: parseCloudLinkSessionEpoch("1"),
          cursor: {
            streamId: parseStreamId("telemetry"),
            streamEpoch: parseStreamEpoch("4"),
            position: parseStreamPosition("2"),
          },
        }),
      ).resolves.toBe(expected);
    },
  );
});

describe("PostgresCloudLinkSessionRepository challenges", () => {
  it("issues once, then returns the exact unexpired persisted challenge for an identical request", async () => {
    const issuedClient = new ScenarioClient();
    route(issuedClient, {
      "cloudlink-session:lock-head": result([headRow()]),
      "cloudlink-session:lock-pending-challenge": result(),
    });
    const candidate = challengeRecord();
    await expect(
      repository(issuedClient).issue({
        candidate,
        evaluationTimeMs: "1784275200000",
        rateLimitWindowMs: 60_000,
        rateLimitMaximumRequests: 4,
      }),
    ).resolves.toEqual({ outcome: "issued", challenge: candidate });
    expect(
      issuedClient.calls.find((call) =>
        call.text.includes("cloudlink-session:insert-challenge"),
      )?.values,
    ).toEqual(
      expect.arrayContaining([
        candidate.request.credentialId,
        candidate.cloudNonce,
        candidate.cloudAuthentication.signature,
      ]),
    );

    const replayClient = new ScenarioClient();
    route(replayClient, {
      "cloudlink-session:lock-head": result([
        headRow({
          challenge_window_started_at_ms: "1784275200000",
          challenge_request_count: 1,
        }),
      ]),
      "cloudlink-session:lock-pending-challenge": result([challengeRow()]),
    });
    const regeneratedCandidate = challengeRecord({
      cloudNonce: "Z".repeat(43),
    });
    await expect(
      repository(replayClient).issue({
        candidate: regeneratedCandidate,
        evaluationTimeMs: "1784275200001",
        rateLimitWindowMs: 60_000,
        rateLimitMaximumRequests: 4,
      }),
    ).resolves.toEqual({
      outcome: "replayed",
      challenge: candidate,
    });
    expect(
      replayClient.calls.some((call) =>
        call.text.includes("cloudlink-session:insert-challenge"),
      ),
    ).toBe(false);
  });

  it("rate-limits before challenge lookup and rejects changed request state while one challenge is unexpired", async () => {
    const limited = new ScenarioClient();
    route(limited, {
      "cloudlink-session:lock-head": result([
        headRow({
          challenge_window_started_at_ms: "1784275200000",
          challenge_request_count: 4,
        }),
      ]),
    });
    await expect(
      repository(limited).issue({
        candidate: challengeRecord(),
        evaluationTimeMs: "1784275200001",
        rateLimitWindowMs: 60_000,
        rateLimitMaximumRequests: 4,
      }),
    ).resolves.toEqual({ outcome: "rate-limited" });
    expect(
      limited.calls.some((call) =>
        call.text.includes("cloudlink-session:lock-pending-challenge"),
      ),
    ).toBe(false);

    const conflict = new ScenarioClient();
    route(conflict, {
      "cloudlink-session:lock-head": result([headRow()]),
      "cloudlink-session:lock-pending-challenge": result([challengeRow()]),
    });
    await expect(
      repository(conflict).issue({
        candidate: challengeRecord({
          request: {
            ...challengeRecord().request,
            clientNonce: "Z".repeat(43),
          },
        }),
        evaluationTimeMs: "1784275200001",
        rateLimitWindowMs: 60_000,
        rateLimitMaximumRequests: 4,
      }),
    ).resolves.toEqual({ outcome: "request-conflict" });
  });

  it("finds only an exact scoped binding and never returns persistence-only consumption state", async () => {
    const client = new ScenarioClient();
    route(client, {
      "cloudlink-session:select-challenge": result([challengeRow()]),
    });
    await expect(
      repository(client).find(binding, challengeId),
    ).resolves.toEqual(challengeRecord());
    expect(client.calls[2]?.values).toEqual([
      tenantId,
      projectId,
      gatewayId,
      "3",
      "active",
      challengeId,
    ]);
  });

  it("accepts and opens under Gateway and challenge locks, fences the old session, and commits one consumption", async () => {
    const client = new ScenarioClient();
    route(client, {
      "cloudlink-session:lock-head": result([
        headRow({ last_epoch: "4", current_session_id: firstSessionId }),
      ]),
      "cloudlink-session:lock-challenge": result([challengeRow()]),
      "cloudlink-session:select-cursors": result(),
      "cloudlink-session:consume-challenge": result([], 1),
    });
    await expect(
      repository(client).acceptAndOpen({
        binding,
        challengeId,
        authenticationFingerprint: `sha256:${"a".repeat(64)}`,
        evaluationTimeMs: "1784275259999",
        sessionId: secondSessionId,
        protocolVersion,
        openedAt,
        gatewayKeyId: "gateway-session-key-17",
        heartbeatIntervalMs: "30000",
      }),
    ).resolves.toMatchObject({
      outcome: "opened",
      fencedSessionId: firstSessionId,
      session: {
        sessionId: secondSessionId,
        epoch: "5",
        state: "active",
        gatewayKeyId: "gateway-session-key-17",
        heartbeatIntervalMs: "30000",
      },
    });
    const statements = client.calls.map((call) => call.text);
    expect(
      statements.findIndex((statement) => statement.includes("lock-head")),
    ).toBeLessThan(
      statements.findIndex((statement) => statement.includes("lock-challenge")),
    );
    expect(
      statements.findIndex((statement) =>
        statement.includes("consume-challenge"),
      ),
    ).toBeLessThan(statements.findIndex((statement) => statement === "COMMIT"));
  });

  it("rejects challenge acceptance with a sanitized failure when the Gateway epoch is exhausted", async () => {
    const client = new ScenarioClient();
    route(client, {
      "cloudlink-session:lock-head": result([
        headRow({ last_epoch: "18446744073709551615" }),
      ]),
      "cloudlink-session:lock-challenge": result([challengeRow()]),
    });

    await expect(
      repository(client).acceptAndOpen({
        binding,
        challengeId,
        authenticationFingerprint: `sha256:${"a".repeat(64)}`,
        evaluationTimeMs: "1784275200001",
        sessionId: secondSessionId,
        protocolVersion,
        openedAt,
        gatewayKeyId: "gateway-session-key-17",
        heartbeatIntervalMs: "30000",
      }),
    ).rejects.toEqual(new CloudLinkPostgresStorageError());
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(
      client.calls.some((call) =>
        call.text.includes("cloudlink-session:consume-challenge"),
      ),
    ).toBe(false);
  });

  it("replays the same authentication fingerprint after consumption and conflicts on a different fingerprint", async () => {
    const replayClient = new ScenarioClient();
    route(replayClient, {
      "cloudlink-session:lock-head": result([headRow()]),
      "cloudlink-session:lock-challenge": result([
        challengeRow({
          authentication_fingerprint: `sha256:${"a".repeat(64)}`,
          consumed_session_id: firstSessionId,
          consumed_at_ms: "1784275200001",
        }),
      ]),
      "cloudlink-session:select-session": result([
        sessionRow({
          gateway_key_id: "gateway-session-key-17",
          heartbeat_interval_ms: "30000",
        }),
      ]),
    });
    const input = {
      binding,
      challengeId,
      authenticationFingerprint: `sha256:${"a".repeat(64)}`,
      evaluationTimeMs: "1784275260000",
      sessionId: secondSessionId,
      protocolVersion,
      openedAt,
      gatewayKeyId: "gateway-session-key-17",
      heartbeatIntervalMs: "30000",
    };
    await expect(
      repository(replayClient).acceptAndOpen(input),
    ).resolves.toMatchObject({
      outcome: "replayed",
      session: { sessionId: firstSessionId },
    });

    const conflictClient = new ScenarioClient();
    route(conflictClient, {
      "cloudlink-session:lock-head": result([headRow()]),
      "cloudlink-session:lock-challenge": result([
        challengeRow({
          authentication_fingerprint: `sha256:${"b".repeat(64)}`,
          consumed_session_id: firstSessionId,
          consumed_at_ms: "1784275200001",
        }),
      ]),
    });
    await expect(
      repository(conflictClient).acceptAndOpen(input),
    ).resolves.toEqual({ outcome: "consumed-conflict" });
  });

  it.each([
    ["not-found", result(), { ...binding }, "1784275200001", "not-found"],
    [
      "expired at equality",
      result([challengeRow()]),
      { ...binding },
      "1784275260000",
      "expired",
    ],
    [
      "binding conflict",
      result([challengeRow()]),
      {
        ...binding,
        generation: parseGatewayCredentialGeneration("4"),
      },
      "1784275200001",
      "binding-conflict",
    ],
  ] as const)(
    "returns %s without opening a session",
    async (_name, challenge, candidateBinding, evaluationTimeMs, outcome) => {
      const client = new ScenarioClient();
      route(client, {
        "cloudlink-session:lock-head": result([headRow()]),
        "cloudlink-session:lock-challenge": challenge,
      });
      await expect(
        repository(client).acceptAndOpen({
          binding: candidateBinding,
          challengeId,
          authenticationFingerprint: `sha256:${"a".repeat(64)}`,
          evaluationTimeMs,
          sessionId: secondSessionId,
          protocolVersion,
          openedAt,
          gatewayKeyId: "gateway-session-key-17",
          heartbeatIntervalMs: "30000",
        }),
      ).resolves.toEqual({ outcome });
      expect(
        client.calls.some((call) =>
          call.text.includes("cloudlink-session:insert-session"),
        ),
      ).toBe(false);
    },
  );

  it("rolls back with a sanitized error that excludes challenge secrets and credential identity", async () => {
    const client = new ScenarioClient();
    route(client, {
      "cloudlink-session:lock-head": result([headRow()]),
      "cloudlink-session:lock-pending-challenge": result(),
    });
    client.handler = (text) => {
      if (text.includes("cloudlink-session:lock-head")) {
        return result([headRow()]);
      }
      if (text.includes("cloudlink-session:lock-pending-challenge")) {
        return result();
      }
      if (text.includes("cloudlink-session:insert-challenge")) {
        const challenge = challengeRecord();
        return new Error(
          `${challenge.request.credentialId}:${challenge.cloudNonce}:${challenge.cloudAuthentication.signature}`,
        );
      }
      return undefined;
    };

    const rejected = repository(client).issue({
      candidate: challengeRecord(),
      evaluationTimeMs: "1784275200000",
      rateLimitWindowMs: 60_000,
      rateLimitMaximumRequests: 4,
    });
    await expect(rejected).rejects.toBeInstanceOf(
      CloudLinkPostgresStorageError,
    );
    await expect(rejected).rejects.not.toThrow(
      /development-binding-17|CCCCCCCC|DDDDDDDD/,
    );
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(client.released).toBe(true);
  });
});

function sessionRowToDomain() {
  return {
    tenantId,
    projectId,
    gatewayId,
    sessionId: firstSessionId,
    credentialGeneration: parseGatewayCredentialGeneration("3"),
    epoch: parseCloudLinkSessionEpoch("1"),
    state: "active" as const,
    openedAt,
    revision: 3,
    protocolVersion,
    resumeCursors: challengeRecord().request.resumeCursors,
    activatedAt: openedAt,
  };
}
