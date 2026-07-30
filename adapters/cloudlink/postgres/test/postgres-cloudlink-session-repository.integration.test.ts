import { readFile } from "node:fs/promises";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  NodePostgresPool,
  gatewayEnrollmentMigrationUrl,
} from "@aether-cloud/fleet-postgres-adapter";
import {
  markCloudLinkSessionSuspect,
  parseCloudLinkSessionChallengeId,
  parseCloudLinkSessionId,
  parseProtocolVersion,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";

import {
  PostgresCloudLinkSessionRepository,
  cloudLinkSessionHealthPostgresMigrationUrl,
  cloudLinkSessionPostgresMigrationUrl,
} from "../src/index.js";
import {
  binding,
  challengeRecord,
  firstSessionId,
  gatewayId,
  openedAt,
  projectId,
  secondSessionId,
  tenantId,
} from "./fixtures.js";

const databaseUrl = process.env.AETHER_CLOUD_POSTGRES_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;
const testRole = "aethercloud_cloudlink_app_test";
const testWorkerRole = "aethercloud_cloudlink_health_worker_test";
const testPassword = "local-cloudlink-password";
const otherTenantId = parseTenantId("99999999-9999-4999-8999-999999999999");
const protocolVersion = parseProtocolVersion("1.0");

integration("CloudLink session PostgreSQL durability", () => {
  if (databaseUrl === undefined) return;
  const parsedUrl = new URL(databaseUrl);
  if (parsedUrl.pathname !== "/aethercloud_test") {
    throw new Error(
      "PostgreSQL integration tests require the dedicated aethercloud_test database",
    );
  }
  const admin = new Pool({ connectionString: databaseUrl, max: 4 });
  const applicationUrl = new URL(databaseUrl);
  applicationUrl.username = testRole;
  applicationUrl.password = testPassword;
  const database = NodePostgresPool.fromConfig({
    connectionString: applicationUrl.toString(),
    max: 4,
    statement_timeout: 5_000,
  });
  const workerUrl = new URL(databaseUrl);
  workerUrl.username = testWorkerRole;
  workerUrl.password = testPassword;
  const workerDatabase = NodePostgresPool.fromConfig({
    connectionString: workerUrl.toString(),
    max: 2,
    statement_timeout: 5_000,
  });

  beforeAll(async () => {
    await admin.query("DROP SCHEMA IF EXISTS aethercloud CASCADE");
    await admin.query(`DROP ROLE IF EXISTS ${testRole}`);
    await admin.query(`DROP ROLE IF EXISTS ${testWorkerRole}`);
    await admin.query(await readFile(gatewayEnrollmentMigrationUrl, "utf8"));
    await admin.query(
      await readFile(cloudLinkSessionPostgresMigrationUrl, "utf8"),
    );
    await admin.query(
      await readFile(cloudLinkSessionHealthPostgresMigrationUrl, "utf8"),
    );
    await admin.query(
      `CREATE ROLE ${testRole} LOGIN PASSWORD '${testPassword}' NOSUPERUSER NOBYPASSRLS`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA aethercloud TO ${testRole}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA aethercloud TO ${testRole}`,
    );
    await admin.query(
      `CREATE ROLE ${testWorkerRole} LOGIN PASSWORD '${testPassword}' NOSUPERUSER NOBYPASSRLS`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA aethercloud TO ${testWorkerRole}`);
    await admin.query(
      `GRANT SELECT, UPDATE ON aethercloud.cloudlink_sessions, aethercloud.cloudlink_session_heads TO ${testWorkerRole}`,
    );
    await admin.query(
      `GRANT INSERT ON aethercloud.audit_events, aethercloud.outbox_events TO ${testWorkerRole}`,
    );
    await admin.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA aethercloud TO ${testWorkerRole}`,
    );
    await admin.query(`
      CREATE POLICY cloudlink_sessions_health_test_policy
        ON aethercloud.cloudlink_sessions
        FOR ALL TO ${testWorkerRole}
        USING (true)
        WITH CHECK (true)
    `);
    for (const scopedTenantId of [tenantId, otherTenantId]) {
      await admin.query(
        `
        INSERT INTO aethercloud.gateway_identities (
          tenant_id,
          project_id,
          gateway_id,
          display_name,
          revision,
          enrollment_state,
          registration_request_id,
          registered_at
        ) VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'CloudLink integration Gateway',
          1,
          'registered',
          'cloudlink-registration-001',
          $4::timestamptz
        )
        `,
        [scopedTenantId, projectId, gatewayId, openedAt],
      );
    }
  });

  afterAll(async () => {
    await database.end();
    await workerDatabase.end();
    await admin.query("DROP SCHEMA IF EXISTS aethercloud CASCADE");
    await admin.query(`DROP ROLE IF EXISTS ${testRole}`);
    await admin.query(`DROP ROLE IF EXISTS ${testWorkerRole}`);
    await admin.end();
  });

  it("serializes challenge issue and consumption, persists cursors, and enforces Tenant isolation", async () => {
    const repository = new PostgresCloudLinkSessionRepository(database);
    const candidate = challengeRecord();
    await expect(
      repository.open({
        binding,
        requestId: "cloudlink-integration-open-001",
        sessionId: firstSessionId,
        protocolVersion,
        openedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "opened",
      session: { sessionId: firstSessionId, epoch: "1" },
    });
    const regenerated = challengeRecord({
      challengeId: parseCloudLinkSessionChallengeId(
        "77777777-7777-4777-8777-777777777777",
      ),
      cloudNonce: "Z".repeat(43),
      cloudAuthentication: {
        ...candidate.cloudAuthentication,
        signature: "E".repeat(86),
      },
    });
    const issue = (record: typeof candidate) =>
      repository.issue({
        candidate: record,
        evaluationTimeMs: "1784275200000",
        rateLimitWindowMs: 60_000,
        rateLimitMaximumRequests: 8,
      });

    const issued = await Promise.all([issue(candidate), issue(regenerated)]);
    expect(issued.map(({ outcome }) => outcome).sort()).toEqual([
      "issued",
      "replayed",
    ]);
    const [firstIssue, secondIssue] = issued;
    if (!("challenge" in firstIssue) || !("challenge" in secondIssue)) {
      throw new Error("Both exact issue attempts must return one challenge");
    }
    expect(firstIssue.challenge.challengeId).toBe(
      secondIssue.challenge.challengeId,
    );

    const authenticationFingerprint = `sha256:${"a".repeat(64)}`;
    const accept = (sessionId: ReturnType<typeof parseCloudLinkSessionId>) =>
      repository.acceptAndOpen({
        binding,
        challengeId: candidate.challengeId,
        authenticationFingerprint,
        evaluationTimeMs: "1784275200001",
        sessionId,
        protocolVersion,
        openedAt,
        gatewayKeyId: "gateway-session-key-17",
        heartbeatIntervalMs: "30000",
      });
    const accepted = await Promise.all([
      accept(secondSessionId),
      accept(parseCloudLinkSessionId("88888888-8888-4888-8888-888888888888")),
    ]);
    expect(accepted.map(({ outcome }) => outcome).sort()).toEqual([
      "opened",
      "replayed",
    ]);
    const [firstAccept, secondAccept] = accepted;
    if (!("session" in firstAccept) || !("session" in secondAccept)) {
      throw new Error("Both exact accepts must return one session");
    }
    const acceptedSession = firstAccept.session;
    expect(acceptedSession.sessionId).toBe(secondAccept.session.sessionId);
    expect(acceptedSession.epoch).toBe("2");
    expect(acceptedSession.gatewayKeyId).toBe("gateway-session-key-17");
    expect(acceptedSession.heartbeatIntervalMs).toBe("30000");
    await expect(
      repository.findById(binding, firstSessionId),
    ).resolves.toMatchObject({
      state: "closed",
      closeReason: "fenced",
    });

    await expect(
      repository.acceptAndOpen({
        binding,
        challengeId: candidate.challengeId,
        authenticationFingerprint: `sha256:${"b".repeat(64)}`,
        evaluationTimeMs: candidate.expiresAtMs,
        sessionId: parseCloudLinkSessionId(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ),
        protocolVersion,
        openedAt,
        gatewayKeyId: "gateway-session-key-17",
        heartbeatIntervalMs: "30000",
      }),
    ).resolves.toEqual({ outcome: "consumed-conflict" });
    const cursorInput = {
      binding,
      sessionId: acceptedSession.sessionId,
      sessionEpoch: acceptedSession.epoch,
      cursor: {
        streamId: parseStreamId("events"),
        streamEpoch: parseStreamEpoch("1"),
        position: parseStreamPosition("1"),
      },
    };
    await expect(repository.recordDurableCursor(cursorInput)).resolves.toBe(
      "recorded",
    );
    await expect(repository.recordDurableCursor(cursorInput)).resolves.toBe(
      "replayed",
    );
    await expect(
      repository.findCurrent(binding, gatewayId),
    ).resolves.toMatchObject({
      sessionId: acceptedSession.sessionId,
      epoch: acceptedSession.epoch,
    });

    const workerRepository = new PostgresCloudLinkSessionRepository(
      workerDatabase,
    );
    const leaseId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const evaluatedAt = parseUtcInstant("2026-07-17T08:02:00.000Z");
    const leased = await workerRepository.leaseDue({
      leaseId,
      evaluatedAt,
      leaseExpiresAt: parseUtcInstant("2026-07-17T08:02:30.000Z"),
      limit: 10,
    });
    expect(leased).toMatchObject({
      outcome: "leased",
      leases: [{ leaseId, session: { sessionId: acceptedSession.sessionId } }],
    });
    const healthSession =
      leased.outcome === "leased" ? leased.leases[0]?.session : undefined;
    if (healthSession === undefined) throw new Error("health lease missing");
    const suspect = markCloudLinkSessionSuspect(healthSession, evaluatedAt);
    if (!suspect.ok) throw new Error(suspect.failure.message);
    await expect(
      workerRepository.complete({
        leaseId,
        session: suspect.value,
        expectedRevision: healthSession.revision,
        evidence: {
          eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          outboxId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          occurredAt: evaluatedAt,
          eventName: "cloudlink.session.suspected.v1",
        },
      }),
    ).resolves.toBe("completed");
    await expect(
      repository.findCurrent(binding, gatewayId),
    ).resolves.toMatchObject({ state: "suspect", suspectAt: evaluatedAt });

    await expect(
      repository.find(
        { ...binding, tenantId: otherTenantId },
        candidate.challengeId,
      ),
    ).resolves.toBeUndefined();
    const appClient = await database.connect();
    try {
      await appClient.query("BEGIN");
      await appClient.query(
        "SELECT set_config('aethercloud.tenant_id', $1, true)",
        [otherTenantId],
      );
      const hidden = await appClient.query<{ readonly count: string }>(
        `
        SELECT count(*)::text AS count
        FROM aethercloud.cloudlink_sessions
        WHERE tenant_id = $1::uuid
        `,
        [tenantId],
      );
      expect(hidden.rows[0]).toEqual({ count: "0" });
      await appClient.query("COMMIT");
    } finally {
      appClient.release();
    }

    await expect(
      admin.query(
        `
        UPDATE aethercloud.cloudlink_session_challenges
        SET request_state = request_state || '{"unexpected":true}'::jsonb
        `,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
