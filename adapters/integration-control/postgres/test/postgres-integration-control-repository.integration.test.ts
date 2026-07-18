import { readFile } from "node:fs/promises";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  NodePostgresPool,
  gatewayEnrollmentMigrationUrl,
} from "@aether-cloud/fleet-postgres-adapter";
import { parseTenantId } from "@aether-cloud/domain";

import {
  integrationControlPostgresMigrationUrl,
  PostgresIntegrationControlRepository,
} from "../src/index.js";
import {
  createInput,
  gatewayId,
  jobId,
  offer,
  otherTenantId,
  projectId,
  receiptInput,
  scope,
  tenantId,
} from "./fixtures.js";

const databaseUrl = process.env.AETHER_CLOUD_POSTGRES_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;
const testRole = "aethercloud_integration_control_app_test";
const testPassword = "local-integration-control-password";

integration("integration control PostgreSQL durability", () => {
  if (databaseUrl === undefined) return;
  const parsedUrl = new URL(databaseUrl);
  if (parsedUrl.pathname !== "/aethercloud_test") {
    throw new Error(
      "PostgreSQL integration tests require the dedicated aethercloud_test database",
    );
  }
  const admin = new Pool({ connectionString: databaseUrl, max: 3 });
  const applicationUrl = new URL(databaseUrl);
  applicationUrl.username = testRole;
  applicationUrl.password = testPassword;
  const database = NodePostgresPool.fromConfig({
    connectionString: applicationUrl.toString(),
    max: 3,
    statement_timeout: 5_000,
  });

  beforeAll(async () => {
    await admin.query("DROP SCHEMA IF EXISTS aethercloud CASCADE");
    await admin.query(`DROP ROLE IF EXISTS ${testRole}`);
    await admin.query(await readFile(gatewayEnrollmentMigrationUrl, "utf8"));
    await admin.query(
      await readFile(integrationControlPostgresMigrationUrl, "utf8"),
    );
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

  beforeEach(async () => {
    await admin.query(`
      TRUNCATE TABLE
        aethercloud.integration_control_ack_outbox,
        aethercloud.integration_control_receipt_deliveries,
        aethercloud.integration_control_receipts,
        aethercloud.integration_control_receipt_streams,
        aethercloud.integration_control_receipt_stream_bindings,
        aethercloud.integration_control_requests,
        aethercloud.integration_control_offer_outbox,
        aethercloud.integration_control_intents,
        aethercloud.audit_events,
        aethercloud.outbox_events
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    await database.end();
    await admin.query("DROP SCHEMA IF EXISTS aethercloud CASCADE");
    await admin.query(`DROP ROLE IF EXISTS ${testRole}`);
    await admin.end();
  });

  it("serializes concurrent exact intent and offer writes into one durable result", async () => {
    const repository = new PostgresIntegrationControlRepository(database);
    const results = await Promise.all([
      repository.persistIntentAndOffer(createInput()),
      repository.persistIntentAndOffer(createInput()),
    ]);

    expect(results.map(({ outcome }) => outcome).sort()).toEqual([
      "persisted",
      "replayed",
    ]);
    const counts = await admin.query<{
      intent_count: string;
      offer_count: string;
      request_count: string;
    }>(`
      SELECT
        (SELECT count(*) FROM aethercloud.integration_control_intents)::text
          AS intent_count,
        (SELECT count(*) FROM aethercloud.integration_control_offer_outbox)::text
          AS offer_count,
        (SELECT count(*) FROM aethercloud.integration_control_requests)::text
          AS request_count
    `);
    expect(counts.rows[0]).toEqual({
      intent_count: "1",
      offer_count: "1",
      request_count: "1",
    });
  });

  it("rolls back receipt evidence, cursor, audit, and ACK together", async () => {
    const setup = new PostgresIntegrationControlRepository(database);
    await expect(
      setup.persistIntentAndOffer(createInput()),
    ).resolves.toMatchObject({ outcome: "persisted" });
    const failing = new PostgresIntegrationControlRepository(database, {
      faultInjector: {
        afterStep(step) {
          if (step === "ack-written") {
            throw new Error("simulated crash before commit");
          }
        },
      },
    });

    await expect(failing.persistReceipt(receiptInput())).resolves.toEqual({
      outcome: "storage-unavailable",
    });
    const rolledBack = await admin.query<{
      receipt_count: string;
      delivery_count: string;
      stream_count: string;
      ack_count: string;
      receipt_audit_count: string;
      revision: string;
    }>(
      `
      SELECT
        (SELECT count(*) FROM aethercloud.integration_control_receipts)::text
          AS receipt_count,
        (SELECT count(*) FROM aethercloud.integration_control_receipt_deliveries)::text
          AS delivery_count,
        (SELECT count(*) FROM aethercloud.integration_control_receipt_streams)::text
          AS stream_count,
        (SELECT count(*) FROM aethercloud.integration_control_ack_outbox)::text
          AS ack_count,
        (
          SELECT count(*)
          FROM aethercloud.audit_events
          WHERE action = 'integration-control.receipt-persisted'
        )::text AS receipt_audit_count,
        (
          SELECT revision::text
          FROM aethercloud.integration_control_intents
          WHERE tenant_id = $1::uuid
            AND project_id = $2::uuid
            AND gateway_id = $3::uuid
            AND job_id = $4::uuid
        ) AS revision
    `,
      [tenantId, projectId, gatewayId, jobId],
    );
    expect(rolledBack.rows[0]).toEqual({
      receipt_count: "0",
      delivery_count: "0",
      stream_count: "0",
      ack_count: "0",
      receipt_audit_count: "0",
      revision: "1",
    });

    await expect(setup.persistReceipt(receiptInput())).resolves.toMatchObject({
      outcome: "persisted",
      evidence: { physicalCompleted: false, jobSucceeded: false },
    });
  });

  it("deduplicates concurrent complete receipt delivery and ACK evidence", async () => {
    const repository = new PostgresIntegrationControlRepository(database);
    await repository.persistIntentAndOffer(createInput());
    const results = await Promise.all([
      repository.persistReceipt(receiptInput()),
      repository.persistReceipt(receiptInput()),
    ]);

    expect(results.map(({ outcome }) => outcome).sort()).toEqual([
      "persisted",
      "replayed",
    ]);
    const counts = await admin.query<{
      receipt_count: string;
      delivery_count: string;
      ack_count: string;
      cursor: string;
    }>(`
      SELECT
        (SELECT count(*) FROM aethercloud.integration_control_receipts)::text
          AS receipt_count,
        (SELECT count(*) FROM aethercloud.integration_control_receipt_deliveries)::text
          AS delivery_count,
        (SELECT count(*) FROM aethercloud.integration_control_ack_outbox)::text
          AS ack_count,
        (
          SELECT contiguous_position::text
          FROM aethercloud.integration_control_receipt_streams
        ) AS cursor
    `);
    expect(counts.rows[0]).toEqual({
      receipt_count: "1",
      delivery_count: "1",
      ack_count: "1",
      cursor: "1",
    });
  });

  it("survives repository restart and enforces tenant isolation", async () => {
    const first = new PostgresIntegrationControlRepository(database);
    const created = await first.persistIntentAndOffer(createInput());
    expect(created.outcome).toBe("persisted");
    if (created.outcome !== "persisted") {
      throw new Error("Expected a persisted integration offer");
    }

    const restarted = new PostgresIntegrationControlRepository(database);
    await expect(
      restarted.findIntent(scope, gatewayId, jobId),
    ).resolves.toMatchObject({ jobId, revision: 1 });
    await expect(
      restarted.listUnresolvedIntents(scope, gatewayId),
    ).resolves.toHaveLength(1);
    await expect(
      restarted.listDispatchableOffers(scope, gatewayId),
    ).resolves.toHaveLength(1);
    await expect(
      restarted.markOfferPublished(
        scope,
        created.offer.eventId,
        createInput().createdAt,
      ),
    ).resolves.toEqual({ outcome: "published" });
    await expect(
      restarted.markOfferPublished(
        scope,
        created.offer.eventId,
        createInput().createdAt,
      ),
    ).resolves.toEqual({ outcome: "replayed" });

    const otherScope = { tenantId: otherTenantId, projectId };
    await expect(
      restarted.findIntent(otherScope, gatewayId, jobId),
    ).resolves.toBeUndefined();
    await expect(
      restarted.markOfferPublished(
        otherScope,
        created.offer.eventId,
        createInput().createdAt,
      ),
    ).resolves.toEqual({ outcome: "not-found" });
    await expect(
      restarted.persistIntentAndOffer({
        ...createInput(offer(), "integration-control-other-tenant"),
        scope: otherScope,
      }),
    ).resolves.toMatchObject({ outcome: "persisted" });

    const appClient = await database.connect();
    try {
      await appClient.query("BEGIN");
      await appClient.query(
        "SELECT set_config('aethercloud.tenant_id', $1, true)",
        [parseTenantId(otherTenantId)],
      );
      const hidden = await appClient.query(
        `SELECT count(*)::text AS count
         FROM aethercloud.integration_control_intents
         WHERE tenant_id = $1::uuid`,
        [tenantId],
      );
      expect(hidden.rows[0]).toEqual({ count: "0" });
      await appClient.query("COMMIT");
    } finally {
      appClient.release();
    }
  });

  it("rejects unsupported stages, physical claims, and arbitrary control payloads in SQL", async () => {
    const repository = new PostgresIntegrationControlRepository(database);
    await expect(
      repository.persistIntentAndOffer(createInput()),
    ).resolves.toMatchObject({ outcome: "persisted" });
    await expect(
      repository.persistReceipt(receiptInput()),
    ).resolves.toMatchObject({ outcome: "persisted" });

    for (const statement of [
      `UPDATE aethercloud.integration_control_receipts
       SET stage = 'physically-completed'`,
      `UPDATE aethercloud.integration_control_receipts
       SET physical_completed = true`,
      `UPDATE aethercloud.integration_control_receipts
       SET receipt_payload = receipt_payload ||
         '{"arbitrary_service_call":{"domain":"shell_command","service":"run"}}'::jsonb`,
      `UPDATE aethercloud.integration_control_intents
       SET intent_payload = intent_payload ||
         '{"arbitrary_service_call":{"domain":"shell_command","service":"run"}}'::jsonb`,
      `UPDATE aethercloud.integration_control_offer_outbox
       SET offer_payload = offer_payload ||
         '{"arbitrary_service_call":{"domain":"shell_command","service":"run"}}'::jsonb`,
    ]) {
      await expect(admin.query(statement)).rejects.toMatchObject({
        code: "23514",
      });
    }
  });
});
