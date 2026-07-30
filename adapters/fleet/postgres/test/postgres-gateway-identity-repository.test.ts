import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type {
  GatewayIdentityMutationEvidence,
  GatewayIdentityReplaceRequest,
} from "@aether-cloud/application";
import {
  claimGatewayEnrollment,
  issueGatewayEnrollmentClaim,
  parseCredentialRequestFingerprint,
  parseEnrollmentClaimId,
  parseEnrollmentRequestId,
  parseEnrollmentTokenDigest,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  registerGatewayIdentity,
} from "@aether-cloud/domain";

import {
  PostgresGatewayIdentityRepository,
  gatewayEnrollmentMigrationUrl,
  type PostgresClient,
  type PostgresPool,
  type PostgresQueryResult,
} from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const scope = { tenantId, projectId };

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

class ScriptedClient implements PostgresClient {
  readonly calls: QueryCall[] = [];
  released = false;

  readonly #responses: Array<
    PostgresQueryResult<Record<string, unknown>> | Error
  >;

  constructor(
    responses: Array<PostgresQueryResult<Record<string, unknown>> | Error>,
  ) {
    this.#responses = responses;
  }

  query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ text, values });
    const response = this.#responses.shift();
    if (response === undefined) {
      throw new Error(`unexpected query: ${text}`);
    }
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response as PostgresQueryResult<Row>);
  }

  release(): void {
    this.released = true;
  }
}

class ScriptedPool implements PostgresPool {
  readonly client: ScriptedClient;

  constructor(client: ScriptedClient) {
    this.client = client;
  }

  connect(): Promise<PostgresClient> {
    return Promise.resolve(this.client);
  }
}

function result(
  rows: readonly Record<string, unknown>[] = [],
  rowCount = rows.length,
): PostgresQueryResult<Record<string, unknown>> {
  return { rows, rowCount };
}

function registeredGateway() {
  return registerGatewayIdentity({
    tenantId,
    projectId,
    gatewayId,
    displayName: "North plant gateway",
    requestId: parseEnrollmentRequestId("register-request-001"),
    registeredAt: parseUtcInstant("2026-07-15T08:00:00.000Z"),
  });
}

function registrationEvidence(): GatewayIdentityMutationEvidence {
  return {
    requestId: parseEnrollmentRequestId("register-request-001"),
    actor: { kind: "user", subjectId: "operator:alice" },
    occurredAt: parseUtcInstant("2026-07-15T08:00:00.000Z"),
    action: "fleet.gateway.register",
    risk: "low",
    confirmation: "not-required",
    eventName: "fleet.gateway.registered.v1",
  };
}

function registeredRow(): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    project_id: projectId,
    gateway_id: gatewayId,
    display_name: "North plant gateway",
    revision: "1",
    enrollment_state: "registered",
    registration_request_id: "register-request-001",
    registered_at: "2026-07-15T08:00:00.000Z",
    claim_id: null,
    token_digest: null,
    claim_issue_request_id: null,
    claim_issued_at: null,
    claim_expires_at: null,
    claim_request_id: null,
    credential_request_fingerprint: null,
    claimed_at: null,
  };
}

function fleetProjectionRow(): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    project_id: projectId,
    gateway_id: gatewayId,
    display_name: "North plant gateway",
    revision: "3",
    enrollment_state: "claimed",
    registered_at: "2026-07-15T08:00:00.000Z",
    session_id: "44444444-4444-4444-8444-444444444444",
    session_state: "active",
    session_protocol_version: "1.0",
    session_opened_at: "2026-07-15T08:00:30.000Z",
    session_activated_at: "2026-07-15T08:01:00.000Z",
    last_heartbeat_at: "2026-07-15T08:02:00.000Z",
    heartbeat_interval_ms: "30000",
    session_suspect_at: null,
    session_closed_at: null,
    session_close_reason: null,
    telemetry_record_count: "7",
    telemetry_last_received_at: "2026-07-15T08:02:01.000Z",
    telemetry_stream_id: "points",
    telemetry_stream_epoch: "1",
    telemetry_position: "7",
    telemetry_source_timestamp_ms: "1752566521000",
    telemetry_record_kind: "point-sample",
    telemetry_record_payload: { pointId: "temperature", value: "21.4" },
  };
}

function awaitingClaimGateway() {
  const pending = issueGatewayEnrollmentClaim(registeredGateway(), {
    requestId: parseEnrollmentRequestId("issue-request-001"),
    claimId: parseEnrollmentClaimId("44444444-4444-4444-8444-444444444444"),
    tokenDigest: parseEnrollmentTokenDigest("a".repeat(64)),
    issuedAt: parseUtcInstant("2026-07-15T08:01:00.000Z"),
    expiresAt: parseUtcInstant("2026-07-15T08:11:00.000Z"),
  });
  if (!pending.ok) throw new Error(pending.failure.message);
  return pending.value;
}

function claimedGateway() {
  const claimed = claimGatewayEnrollment(awaitingClaimGateway(), {
    requestId: parseEnrollmentRequestId("claim-request-001"),
    credentialRequestFingerprint: parseCredentialRequestFingerprint(
      "b".repeat(64),
    ),
    claimedAt: parseUtcInstant("2026-07-15T08:02:00.000Z"),
  });
  if (!claimed.ok) throw new Error(claimed.failure.message);
  return claimed.value;
}

function awaitingClaimRow(): Record<string, unknown> {
  return {
    ...registeredRow(),
    revision: "2",
    enrollment_state: "awaiting-claim",
    claim_id: "44444444-4444-4444-8444-444444444444",
    token_digest: "a".repeat(64),
    claim_issue_request_id: "issue-request-001",
    claim_issued_at: "2026-07-15T08:01:00.000Z",
    claim_expires_at: "2026-07-15T08:11:00.000Z",
  };
}

function claimedRow(): Record<string, unknown> {
  return {
    ...awaitingClaimRow(),
    revision: "3",
    enrollment_state: "claimed",
    claim_request_id: "claim-request-001",
    credential_request_fingerprint: "b".repeat(64),
    claimed_at: "2026-07-15T08:02:00.000Z",
  };
}

function replacementEvidence(
  state: "awaiting-claim" | "claimed",
): GatewayIdentityMutationEvidence {
  return state === "awaiting-claim"
    ? {
        requestId: parseEnrollmentRequestId("issue-request-001"),
        actor: { kind: "service-account", subjectId: "service:provisioner" },
        occurredAt: parseUtcInstant("2026-07-15T08:01:00.000Z"),
        action: "fleet.gateway.enrollment.issue",
        risk: "high",
        confirmation: "explicit",
        eventName: "fleet.gateway.enrollment-issued.v1",
      }
    : {
        requestId: parseEnrollmentRequestId("claim-request-001"),
        actor: { kind: "gateway", subjectId: gatewayId },
        occurredAt: parseUtcInstant("2026-07-15T08:02:00.000Z"),
        action: "fleet.gateway.enrollment.claim",
        risk: "high",
        confirmation: "not-required",
        eventName: "fleet.gateway.enrollment-claimed.v1",
      };
}

describe("PostgresGatewayIdentityRepository", () => {
  it("reads a Gateway through a Tenant-scoped transaction and rehydrates domain state", async () => {
    const client = new ScriptedClient([
      result(),
      result(),
      result([registeredRow()]),
      result(),
    ]);
    const repository = new PostgresGatewayIdentityRepository(
      new ScriptedPool(client),
    );

    const found = await repository.find(scope, gatewayId);

    expect(found).toMatchObject({
      outcome: "found",
      gateway: {
        tenantId,
        projectId,
        gatewayId,
        revision: 1,
        enrollment: { state: "registered" },
      },
    });
    expect(client.calls.map((call) => call.text)).toEqual([
      "BEGIN",
      expect.stringContaining("set_config"),
      expect.stringContaining("FROM aethercloud.gateway_identities"),
      "COMMIT",
    ]);
    expect(client.calls[1]?.values).toEqual([tenantId]);
    expect(client.calls[2]?.values).toEqual([tenantId, projectId, gatewayId]);
    expect(client.released).toBe(true);
  });

  it("lists Fleet projections through RLS with session and latest telemetry", async () => {
    const client = new ScriptedClient([
      result(),
      result(),
      result([fleetProjectionRow()]),
      result(),
    ]);
    const repository = new PostgresGatewayIdentityRepository(
      new ScriptedPool(client),
    );

    const listed = await repository.list({ tenantId, projectId, limit: 25 });
    expect(listed).toMatchObject({
      outcome: "found",
      gateways: [
        {
          gatewayId,
          session: {
            sessionId: "44444444-4444-4444-8444-444444444444",
            state: "active",
            protocolVersion: "1.0",
            openedAt: "2026-07-15T08:00:30.000Z",
            heartbeatIntervalMs: "30000",
          },
          telemetry: {
            recordCount: "7",
            latest: { position: "7" },
          },
        },
      ],
      nextCursor: null,
    });
    expect(client.calls[2]?.text).toContain("cloudlink_sessions");
    expect(client.calls[2]?.text).not.toContain("state <> 'closed'");
    expect(client.calls[2]?.text).toContain("telemetry_records");
    expect(client.calls[2]?.values).toEqual([tenantId, projectId, null, 26]);
  });

  it("gets one Fleet projection and returns typed not-found", async () => {
    const foundClient = new ScriptedClient([
      result(),
      result(),
      result([fleetProjectionRow()]),
      result(),
    ]);
    const foundRepository = new PostgresGatewayIdentityRepository(
      new ScriptedPool(foundClient),
    );
    await expect(foundRepository.get(scope, gatewayId)).resolves.toMatchObject({
      outcome: "found",
      gateway: { gatewayId, displayName: "North plant gateway" },
    });

    const missingClient = new ScriptedClient([
      result(),
      result(),
      result(),
      result(),
    ]);
    const missingRepository = new PostgresGatewayIdentityRepository(
      new ScriptedPool(missingClient),
    );
    await expect(missingRepository.get(scope, gatewayId)).resolves.toEqual({
      outcome: "not-found",
    });
  });

  it("returns not-found when the Tenant-scoped Gateway query has no row", async () => {
    const client = new ScriptedClient([result(), result(), result(), result()]);
    const repository = new PostgresGatewayIdentityRepository(
      new ScriptedPool(client),
    );

    await expect(repository.find(scope, gatewayId)).resolves.toEqual({
      outcome: "not-found",
    });
    expect(client.calls.at(-1)?.text).toBe("COMMIT");
    expect(client.released).toBe(true);
  });

  it.each([
    ["awaiting-claim", awaitingClaimRow(), 2],
    ["claimed", claimedRow(), 3],
  ] as const)(
    "rehydrates the %s Gateway enrollment state through domain transitions",
    async (state, row, revision) => {
      const client = new ScriptedClient([
        result(),
        result(),
        result([row]),
        result(),
      ]);
      const repository = new PostgresGatewayIdentityRepository(
        new ScriptedPool(client),
      );

      const found = await repository.find(scope, gatewayId);

      expect(found).toMatchObject({
        outcome: "found",
        gateway: { revision, enrollment: { state } },
      });
      expect(client.calls.at(-1)?.text).toBe("COMMIT");
    },
  );

  it.each([
    ["non-string revision", { ...registeredRow(), revision: 1 }],
    ["non-positive revision", { ...registeredRow(), revision: "0" }],
    ["unsafe revision", { ...registeredRow(), revision: "9007199254740992" }],
    ["empty display name", { ...registeredRow(), display_name: "" }],
    ["contradictory revision", { ...registeredRow(), revision: "2" }],
    [
      "invalid pending transition",
      {
        ...awaitingClaimRow(),
        claim_expires_at: "2026-07-15T08:01:00.000Z",
      },
    ],
    ["unsupported state", { ...awaitingClaimRow(), enrollment_state: "lost" }],
  ] as const)(
    "treats a %s database row as typed storage unavailability",
    async (_description, row) => {
      const client = new ScriptedClient([
        result(),
        result(),
        result([row]),
        result(),
      ]);
      const repository = new PostgresGatewayIdentityRepository(
        new ScriptedPool(client),
      );

      await expect(repository.find(scope, gatewayId)).resolves.toEqual({
        outcome: "storage-unavailable",
      });
      expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
      expect(client.released).toBe(true);
    },
  );

  it("atomically inserts the Gateway, required Audit event, and Outbox event", async () => {
    const client = new ScriptedClient([
      result(),
      result(),
      result([], 1),
      result([], 1),
      result([], 1),
      result(),
    ]);
    const repository = new PostgresGatewayIdentityRepository(
      new ScriptedPool(client),
    );

    const outcome = await repository.insert({
      ...scope,
      gateway: registeredGateway(),
      evidence: registrationEvidence(),
    });

    expect(outcome).toBe("inserted");
    const statements = client.calls.map((call) => call.text);
    expect(statements).toEqual([
      "BEGIN",
      expect.stringContaining("set_config"),
      expect.stringContaining("INSERT INTO aethercloud.gateway_identities"),
      expect.stringContaining("INSERT INTO aethercloud.audit_events"),
      expect.stringContaining("INSERT INTO aethercloud.outbox_events"),
      "COMMIT",
    ]);
    expect(client.calls[3]?.values).not.toContain(
      "deterministic-enrollment-token",
    );
    expect(client.calls[4]?.values).not.toContain(
      "deterministic-enrollment-token",
    );
  });

  it("does not emit evidence when a Gateway identity already exists", async () => {
    const client = new ScriptedClient([
      result(),
      result(),
      result([], 0),
      result(),
    ]);
    const repository = new PostgresGatewayIdentityRepository(
      new ScriptedPool(client),
    );

    const outcome = await repository.insert({
      ...scope,
      gateway: registeredGateway(),
      evidence: registrationEvidence(),
    });

    expect(outcome).toBe("already-exists");
    expect(
      client.calls.some((call) => call.text.includes("audit_events")),
    ).toBe(false);
    expect(
      client.calls.some((call) => call.text.includes("outbox_events")),
    ).toBe(false);
  });

  it("distinguishes a missing Gateway from an optimistic revision conflict", async () => {
    const request: GatewayIdentityReplaceRequest = {
      ...scope,
      gateway: awaitingClaimGateway(),
      expectedRevision: 1,
      evidence: replacementEvidence("awaiting-claim"),
    };
    const conflictingClient = new ScriptedClient([
      result(),
      result(),
      result([], 0),
      result([{ revision: "8" }]),
      result(),
    ]);
    const missingClient = new ScriptedClient([
      result(),
      result(),
      result([], 0),
      result(),
      result(),
    ]);

    await expect(
      new PostgresGatewayIdentityRepository(
        new ScriptedPool(conflictingClient),
      ).replace(request),
    ).resolves.toBe("version-conflict");
    await expect(
      new PostgresGatewayIdentityRepository(
        new ScriptedPool(missingClient),
      ).replace(request),
    ).resolves.toBe("not-found");
  });

  it.each([
    ["awaiting-claim", awaitingClaimGateway(), 1],
    ["claimed", claimedGateway(), 2],
  ] as const)(
    "atomically replaces the %s Gateway state with evidence",
    async (state, gateway, expectedRevision) => {
      const client = new ScriptedClient([
        result(),
        result(),
        result([{ revision: String(gateway.revision) }], 1),
        result([], 1),
        result([], 1),
        result(),
      ]);
      const repository = new PostgresGatewayIdentityRepository(
        new ScriptedPool(client),
      );

      const outcome = await repository.replace({
        ...scope,
        gateway,
        expectedRevision,
        evidence: replacementEvidence(state),
      });

      expect(outcome).toBe("replaced");
      expect(client.calls.map((call) => call.text)).toEqual([
        "BEGIN",
        expect.stringContaining("set_config"),
        expect.stringContaining("UPDATE aethercloud.gateway_identities"),
        expect.stringContaining("INSERT INTO aethercloud.audit_events"),
        expect.stringContaining("INSERT INTO aethercloud.outbox_events"),
        "COMMIT",
      ]);
      expect(client.calls[2]?.values[6]).toBe(state);
    },
  );

  it("rejects a replacement that attempts to return to registered state", async () => {
    const client = new ScriptedClient([result(), result(), result()]);
    const repository = new PostgresGatewayIdentityRepository(
      new ScriptedPool(client),
    );

    await expect(
      repository.replace({
        ...scope,
        gateway: registeredGateway(),
        expectedRevision: 1,
        evidence: registrationEvidence(),
      }),
    ).resolves.toBe("storage-unavailable");
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("rejects insertion of a Gateway outside the registered state", async () => {
    const client = new ScriptedClient([result(), result(), result()]);
    const repository = new PostgresGatewayIdentityRepository(
      new ScriptedPool(client),
    );

    await expect(
      repository.insert({
        ...scope,
        gateway: awaitingClaimGateway(),
        evidence: replacementEvidence("awaiting-claim"),
      }),
    ).resolves.toBe("storage-unavailable");
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("rolls back and returns a typed storage outcome on database failure", async () => {
    const client = new ScriptedClient([
      result(),
      result(),
      new Error("connection lost"),
      result(),
    ]);
    const repository = new PostgresGatewayIdentityRepository(
      new ScriptedPool(client),
    );

    await expect(
      repository.insert({
        ...scope,
        gateway: registeredGateway(),
        evidence: registrationEvidence(),
      }),
    ).resolves.toBe("storage-unavailable");
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(client.released).toBe(true);
  });

  it("returns typed unavailability when acquiring a database connection fails", async () => {
    const pool: PostgresPool = {
      connect: () => Promise.reject(new Error("pool unavailable")),
    };
    const repository = new PostgresGatewayIdentityRepository(pool);

    await expect(repository.find(scope, gatewayId)).resolves.toEqual({
      outcome: "storage-unavailable",
    });
  });

  it("preserves typed unavailability when rollback also fails", async () => {
    const client = new ScriptedClient([
      result(),
      result(),
      new Error("write failed"),
      new Error("connection already closed"),
    ]);
    const repository = new PostgresGatewayIdentityRepository(
      new ScriptedPool(client),
    );

    await expect(
      repository.insert({
        ...scope,
        gateway: registeredGateway(),
        evidence: registrationEvidence(),
      }),
    ).resolves.toBe("storage-unavailable");
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(client.released).toBe(true);
  });
});

describe("Gateway enrollment PostgreSQL migration", () => {
  it("enforces explicit Tenant scope, lifecycle shape, audit, and outbox", async () => {
    const migration = await readFile(gatewayEnrollmentMigrationUrl, "utf8");

    expect(migration).toContain("CREATE SCHEMA IF NOT EXISTS aethercloud");
    expect(migration).toContain("CREATE TABLE aethercloud.gateway_identities");
    expect(migration).toContain("CREATE TABLE aethercloud.audit_events");
    expect(migration).toContain("CREATE TABLE aethercloud.outbox_events");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("current_setting('aethercloud.tenant_id'");
    expect(migration).toContain("CHECK (enrollment_state IN");
    expect(migration).toContain(
      "CREATE UNIQUE INDEX gateway_identities_claim_identity_uq",
    );
    expect(migration).toContain("WHERE claim_id IS NOT NULL");
    expect(migration).not.toMatch(/\b(?:aws|azure|gcp)\b/i);
  });
});
