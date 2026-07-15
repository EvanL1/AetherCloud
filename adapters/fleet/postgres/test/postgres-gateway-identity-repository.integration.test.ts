import { readFile } from "node:fs/promises";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ClaimGatewayEnrollment,
  GetGatewayEnrollment,
  IssueGatewayEnrollment,
  RegisterGateway,
  type EnrollmentTokenService,
} from "@aether-cloud/application";
import {
  parseEnrollmentClaimId,
  parseEnrollmentTokenDigest,
  parseUtcInstant,
} from "@aether-cloud/domain";

import {
  NodePostgresPool,
  PostgresGatewayIdentityRepository,
  gatewayEnrollmentMigrationUrl,
} from "../src/index.js";

const databaseUrl = process.env.AETHER_CLOUD_POSTGRES_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;
const testRole = "aethercloud_app_test";
const testPassword = "local-integration-password";

class FixedTokenService implements EnrollmentTokenService {
  readonly #digest = parseEnrollmentTokenDigest("a".repeat(64));

  issue() {
    return Promise.resolve({
      ok: true as const,
      value: {
        claimId: parseEnrollmentClaimId("44444444-4444-4444-8444-444444444444"),
        token: "integration-enrollment-token",
        tokenDigest: this.#digest,
      },
    });
  }

  matches(token: string, expectedDigest: string) {
    return Promise.resolve(
      token === "integration-enrollment-token" &&
        expectedDigest === this.#digest,
    );
  }
}

integration("Gateway enrollment PostgreSQL integration", () => {
  if (databaseUrl === undefined) return;
  const parsedUrl = new URL(databaseUrl);
  if (parsedUrl.pathname !== "/aethercloud_test") {
    throw new Error(
      "PostgreSQL integration tests require the dedicated aethercloud_test database",
    );
  }
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  const applicationUrl = new URL(databaseUrl);
  applicationUrl.username = testRole;
  applicationUrl.password = testPassword;
  const database = NodePostgresPool.fromConfig({
    connectionString: applicationUrl.toString(),
    max: 2,
    statement_timeout: 5_000,
  });

  beforeAll(async () => {
    await admin.query("DROP SCHEMA IF EXISTS aethercloud CASCADE");
    await admin.query(`DROP ROLE IF EXISTS ${testRole}`);
    const migration = await readFile(gatewayEnrollmentMigrationUrl, "utf8");
    await admin.query(migration);
    await admin.query(
      `CREATE ROLE ${testRole} LOGIN PASSWORD '${testPassword}' NOSUPERUSER NOBYPASSRLS`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA aethercloud TO ${testRole}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA aethercloud TO ${testRole}`,
    );
    await admin.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA aethercloud TO ${testRole}`,
    );
  });

  afterAll(async () => {
    await database.end();
    await admin.query("DROP SCHEMA IF EXISTS aethercloud CASCADE");
    await admin.query(`DROP ROLE IF EXISTS ${testRole}`);
    await admin.end();
  });

  it("runs register, issue, claim, Tenant query, Audit, and Outbox in PostgreSQL", async () => {
    const repository = new PostgresGatewayIdentityRepository(database);
    const clock = {
      now: () => parseUtcInstant("2026-07-15T08:05:00.000Z"),
    };
    const tokens = new FixedTokenService();
    const register = new RegisterGateway({ repository, clock });
    const issue = new IssueGatewayEnrollment({ repository, tokens, clock });
    const claim = new ClaimGatewayEnrollment({ repository, tokens, clock });
    const query = new GetGatewayEnrollment({ repository });
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const gatewayId = "33333333-3333-4333-8333-333333333333";

    await expect(
      register.execute(
        {
          tenantId,
          projectId,
          subjectKind: "service-account",
          subjectId: "service:provisioner",
          permissions: ["fleet.gateway.create"],
          idempotencyKey: "register-request-001",
          issuedAt: "2026-07-15T08:00:00.000Z",
          expiresAt: "2026-07-15T08:10:00.000Z",
        },
        { gatewayId, displayName: "North plant gateway" },
      ),
    ).resolves.toMatchObject({ ok: true, value: { state: "registered" } });
    await expect(
      issue.execute(
        {
          tenantId,
          projectId,
          subjectKind: "user",
          subjectId: "operator:alice",
          permissions: ["fleet.gateway.enrollment.issue"],
          idempotencyKey: "issue-request-001",
          issuedAt: "2026-07-15T08:00:00.000Z",
          expiresAt: "2026-07-15T08:10:00.000Z",
          confirmation: {
            method: "explicit",
            confirmedAt: "2026-07-15T08:00:01.000Z",
          },
        },
        { gatewayId, claimExpiresAt: "2026-07-15T08:15:00.000Z" },
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { gateway: { state: "awaiting-claim" } },
    });
    await expect(
      claim.execute(
        {
          tenantId,
          projectId,
          idempotencyKey: "claim-request-001",
          issuedAt: "2026-07-15T08:04:00.000Z",
          expiresAt: "2026-07-15T08:10:00.000Z",
        },
        {
          gatewayId,
          enrollmentToken: "integration-enrollment-token",
          credentialRequestFingerprint: "b".repeat(64),
        },
      ),
    ).resolves.toMatchObject({ ok: true, value: { state: "claimed" } });

    await expect(
      query.execute(
        {
          tenantId,
          projectId,
          subjectId: "operator:alice",
          permissions: ["fleet.gateway.enrollment.read"],
        },
        { gatewayId },
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { state: "claimed", revision: 3 },
    });
    const evidence = await admin.query<{
      audit_count: string;
      outbox_count: string;
      token_leaks: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM aethercloud.audit_events) AS audit_count,
        (SELECT count(*)::text FROM aethercloud.outbox_events) AS outbox_count,
        (
          SELECT count(*)::text
          FROM aethercloud.outbox_events
          WHERE payload::text LIKE '%integration-enrollment-token%'
        ) AS token_leaks
    `);
    expect(evidence.rows[0]).toEqual({
      audit_count: "3",
      outbox_count: "3",
      token_leaks: "0",
    });
  });
});
