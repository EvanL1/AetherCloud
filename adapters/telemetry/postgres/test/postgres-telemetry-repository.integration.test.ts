import { readFile } from "node:fs/promises";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DeliverCloudLinkDurableAcknowledgements,
  IngestTelemetryBatch,
  type CloudLinkDurableAckPublisher,
  type CloudLinkDurableAcknowledgement,
  type GatewayCredentialVerifier,
} from "@aether-cloud/application";
import {
  NodePostgresPool,
  gatewayEnrollmentMigrationUrl,
} from "@aether-cloud/fleet-postgres-adapter";
import {
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";
import { NodeTelemetryBatchDigestor } from "@aether-cloud/telemetry-memory-adapter";

import {
  PostgresTelemetryRepository,
  telemetryPostgresMigrationUrl,
} from "../src/index.js";

const databaseUrl = process.env.AETHER_CLOUD_POSTGRES_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;
const testRole = "aethercloud_telemetry_app_test";
const testPassword = "local-telemetry-integration-password";
const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const binding = {
  tenantId,
  projectId,
  gatewayId,
  generation: parseGatewayCredentialGeneration("3"),
  status: "active" as const,
};

class FixedVerifier implements GatewayCredentialVerifier {
  verify() {
    return Promise.resolve({ ok: true as const, value: binding });
  }
}

class RecordingPublisher implements CloudLinkDurableAckPublisher {
  readonly published: CloudLinkDurableAcknowledgement[] = [];

  publish(acknowledgement: CloudLinkDurableAcknowledgement) {
    this.published.push(acknowledgement);
    return Promise.resolve({ outcome: "published" as const });
  }
}

function commandContext(batchId: string, issuedAt: string) {
  return {
    idempotencyKey: `cloudlink:${batchId}`,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + 5 * 60_000).toISOString(),
  };
}

function telemetryInput(position: string, batchId: string) {
  const wirePosition = (BigInt(position) + 1n).toString();
  return {
    credential: {
      credentialId: "gateway-credential-003",
      proof: "opaque-integration-proof",
    },
    streamId: "telemetry",
    streamEpoch: "4",
    topology: {
      publicationEpoch: "11",
      snapshotDigest: "fx64:0123456789abcdef",
    },
    retentionClass: "standard-30d",
    replay: false,
    durableAcknowledgement: {
      sessionId: "44444444-4444-4444-8444-444444444444",
      sessionEpoch: "7",
      credentialGeneration: "3",
      streamId: "telemetry",
      streamEpoch: "4",
      acknowledgedPosition: wirePosition,
      acceptedTelemetryPosition: position,
      batchId,
      digest: `sha256:${"a".repeat(64)}`,
    },
    records: [
      {
        kind: "point-sample",
        position,
        sourceTimestampMs: (1_784_016_000_000n + BigInt(position)).toString(),
        instanceId: "42",
        pointKind: "telemetry",
        pointId: "7",
        quality: "good",
        value: { type: "float64", value: 21.5 },
      },
    ],
  };
}

function ingestion(repository: PostgresTelemetryRepository, now: string) {
  return new IngestTelemetryBatch({
    credentialVerifier: new FixedVerifier(),
    digestor: new NodeTelemetryBatchDigestor(),
    repository,
    clock: { now: () => parseUtcInstant(now) },
  });
}

function deliveryInput(now: string) {
  return {
    tenantId,
    projectId,
    workerId: "cloudlink-ack-worker-01",
    now: parseUtcInstant(now),
    leaseExpiresAt: parseUtcInstant(
      new Date(Date.parse(now) + 30_000).toISOString(),
    ),
    retryAt: parseUtcInstant(new Date(Date.parse(now) + 5_000).toISOString()),
    limit: 10,
  };
}

function currentDeliveryInput() {
  return deliveryInput(new Date().toISOString());
}

integration("CloudLink telemetry PostgreSQL crash durability", () => {
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
    await admin.query(await readFile(gatewayEnrollmentMigrationUrl, "utf8"));
    await admin.query(await readFile(telemetryPostgresMigrationUrl, "utf8"));
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
        aethercloud.cloudlink_durable_ack_outbox,
        aethercloud.telemetry_records,
        aethercloud.telemetry_ingress_requests,
        aethercloud.telemetry_batches,
        aethercloud.telemetry_streams,
        aethercloud.telemetry_gateway_usage,
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

  it("commits one fact and republishes the identical ACK on application replay", async () => {
    const repository = new PostgresTelemetryRepository(database);
    const first = await ingestion(
      repository,
      "2026-07-16T01:00:00.000Z",
    ).execute(
      commandContext("batch-001", "2026-07-16T00:59:00.000Z"),
      telemetryInput("0", "batch-001"),
    );
    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        durableAcknowledgement: {
          batchId: "batch-001",
          acknowledgedPosition: "1",
        },
      },
    });
    if (!first.ok || first.value.durableAcknowledgement === undefined) {
      throw new Error("integration setup did not persist an ACK");
    }
    const exactAck = first.value.durableAcknowledgement;
    const firstPublisher = new RecordingPublisher();
    await expect(
      new DeliverCloudLinkDurableAcknowledgements({
        repository,
        publisher: firstPublisher,
      }).execute(currentDeliveryInput()),
    ).resolves.toMatchObject({ outcome: "completed", published: 1 });
    expect(firstPublisher.published).toEqual([exactAck]);

    const replay = await ingestion(
      repository,
      "2026-07-16T01:00:10.000Z",
    ).execute(
      commandContext("batch-001", "2026-07-16T01:00:09.000Z"),
      telemetryInput("0", "batch-001"),
    );
    expect(replay).toMatchObject({ ok: true, replayed: true });
    if (!replay.ok) throw new Error("replay was rejected");
    expect(replay.value.durableAcknowledgement).toEqual(exactAck);
    const replayPublisher = new RecordingPublisher();
    await new DeliverCloudLinkDurableAcknowledgements({
      repository,
      publisher: replayPublisher,
    }).execute(currentDeliveryInput());
    expect(replayPublisher.published).toEqual([exactAck]);

    const counts = await admin.query<{
      ack_count: string;
      audit_count: string;
      batch_count: string;
      integration_outbox_count: string;
      record_count: string;
      request_count: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM aethercloud.telemetry_batches) AS batch_count,
        (SELECT count(*)::text FROM aethercloud.telemetry_records) AS record_count,
        (SELECT count(*)::text FROM aethercloud.telemetry_ingress_requests) AS request_count,
        (SELECT count(*)::text FROM aethercloud.audit_events) AS audit_count,
        (SELECT count(*)::text FROM aethercloud.outbox_events) AS integration_outbox_count,
        (SELECT count(*)::text FROM aethercloud.cloudlink_durable_ack_outbox) AS ack_count
    `);
    expect(counts.rows[0]).toEqual({
      ack_count: "1",
      audit_count: "1",
      batch_count: "1",
      integration_outbox_count: "1",
      record_count: "1",
      request_count: "1",
    });
  });

  it("rolls back every fact and emits no claimable ACK when failure occurs before commit", async () => {
    const repository = new PostgresTelemetryRepository(database, {
      faultInjector: {
        beforeCommit() {
          throw new Error("simulated pre-commit process failure");
        },
      },
    });
    await expect(
      ingestion(repository, "2026-07-16T01:00:00.000Z").execute(
        commandContext("batch-001", "2026-07-16T00:59:00.000Z"),
        telemetryInput("0", "batch-001"),
      ),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "telemetry-storage-unavailable" },
    });
    const counts = await admin.query<{ facts: string }>(`
      SELECT (
        (SELECT count(*) FROM aethercloud.telemetry_batches) +
        (SELECT count(*) FROM aethercloud.telemetry_records) +
        (SELECT count(*) FROM aethercloud.audit_events) +
        (SELECT count(*) FROM aethercloud.outbox_events) +
        (SELECT count(*) FROM aethercloud.cloudlink_durable_ack_outbox)
      )::text AS facts
    `);
    expect(counts.rows[0]).toEqual({ facts: "0" });
    await expect(
      new PostgresTelemetryRepository(database).claimPending(
        currentDeliveryInput(),
      ),
    ).resolves.toEqual({ outcome: "claimed", acknowledgements: [] });
  });

  it("recovers a committed exact ACK after the caller observes post-commit uncertainty", async () => {
    const uncertainRepository = new PostgresTelemetryRepository(database, {
      faultInjector: {
        afterCommit() {
          throw new Error("simulated process loss after server commit");
        },
      },
    });
    await expect(
      ingestion(uncertainRepository, "2026-07-16T01:00:00.000Z").execute(
        commandContext("batch-001", "2026-07-16T00:59:00.000Z"),
        telemetryInput("0", "batch-001"),
      ),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "telemetry-storage-unavailable" },
    });

    const repository = new PostgresTelemetryRepository(database);
    const publisher = new RecordingPublisher();
    await expect(
      new DeliverCloudLinkDurableAcknowledgements({
        repository,
        publisher,
      }).execute(currentDeliveryInput()),
    ).resolves.toMatchObject({
      outcome: "completed",
      claimed: 1,
      published: 1,
    });
    expect(publisher.published).toMatchObject([
      {
        batchId: "batch-001",
        acknowledgedPosition: "1",
        acknowledgedAt: "2026-07-16T01:00:00.000Z",
      },
    ]);

    const replay = await ingestion(
      repository,
      "2026-07-16T01:00:10.000Z",
    ).execute(
      commandContext("batch-001", "2026-07-16T01:00:09.000Z"),
      telemetryInput("0", "batch-001"),
    );
    expect(replay).toMatchObject({ ok: true, replayed: true });
    if (!replay.ok) throw new Error("committed replay was not recovered");
    expect(replay.value.durableAcknowledgement).toEqual(publisher.published[0]);
    const facts = await admin.query<{ batches: string; records: string }>(`
      SELECT
        (SELECT count(*)::text FROM aethercloud.telemetry_batches) AS batches,
        (SELECT count(*)::text FROM aethercloud.telemetry_records) AS records
    `);
    expect(facts.rows[0]).toEqual({ batches: "1", records: "1" });
  });
});
