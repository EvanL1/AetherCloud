import { readFile } from "node:fs/promises";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  IntegrationObservationPersistenceInput,
  IntegrationTopologyPersistenceInput,
} from "@aether-cloud/application";
import {
  NodePostgresPool,
  gatewayEnrollmentMigrationUrl,
} from "@aether-cloud/fleet-postgres-adapter";
import {
  defineIntegrationObservationBatch,
  defineIntegrationTopologySnapshot,
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
  parseTenantId,
  parseUtcInstant,
  type GatewayCredentialBinding,
  type IntegrationTopologySnapshot,
} from "@aether-cloud/domain";

import {
  integrationProjectionPostgresMigrationUrl,
  PostgresIntegrationProjectionRepository,
  type IntegrationCloudLinkDelivery,
} from "../src/index.js";

const databaseUrl = process.env.AETHER_CLOUD_POSTGRES_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;
const testRole = "aethercloud_integration_projection_app_test";
const testPassword = "local-integration-projection-password";
const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const binding: GatewayCredentialBinding = {
  tenantId,
  projectId,
  gatewayId,
  generation: parseGatewayCredentialGeneration("3"),
  status: "active",
};
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "e".repeat(64);
const wireDigestA = "c".repeat(64);
const wireDigestB = "d".repeat(64);

function topology(generation = "12"): IntegrationTopologySnapshot {
  return defineIntegrationTopologySnapshot({
    schema: "aether.integration.topology-snapshot.v1alpha1",
    integrationId: "home-assistant:home",
    integrationKind: "home-assistant",
    snapshotGeneration: generation,
    observedAtMs: "1784268000000",
    areas: [{ areaId: "area:kitchen", name: "Kitchen" }],
    devices: [
      {
        deviceId: "device:thermostat",
        name: "Kitchen thermostat",
        areaId: "area:kitchen",
      },
    ],
    entities: [
      {
        entityId: "entity-registry:climate-kitchen",
        sourceAddress: "climate.kitchen",
        name: "Kitchen climate",
        entityKind: "climate",
        deviceId: "device:thermostat",
        areaId: "area:kitchen",
        points: [
          {
            pointKey: "current_temperature",
            title: "Current temperature",
            kind: "telemetry",
            valueType: "float64",
            unit: "°C",
          },
        ],
      },
    ],
  });
}

function topologyInput(
  generation = "12",
  payloadDigest = digestA,
): IntegrationTopologyPersistenceInput {
  return {
    requestId: `topology-request-${generation.padStart(3, "0")}`,
    binding,
    topology: topology(generation),
    payloadDigest,
    receivedAt: parseUtcInstant("2026-07-17T06:00:00.000Z"),
  };
}

function observationInput(
  currentTopology: IntegrationTopologySnapshot,
  batchId = "ha-event-001",
  requestId = "observation-request-001",
  observedAtMs = "1784268000100",
  temperature = 21.5,
  payloadDigest = digestB,
): IntegrationObservationPersistenceInput {
  return {
    requestId,
    binding,
    batch: defineIntegrationObservationBatch(
      {
        schema: "aether.integration.observation-batch.v1alpha1",
        integrationId: currentTopology.integrationId,
        snapshotGeneration: currentTopology.snapshotGeneration,
        batchId,
        observedAtMs,
        observations: [
          {
            entityId: "entity-registry:climate-kitchen",
            pointKey: "current_temperature",
            observedAtMs,
            quality: "good",
            value: { type: "float64", value: temperature },
          },
        ],
      },
      currentTopology,
    ),
    payloadDigest,
    receivedAt: parseUtcInstant("2026-07-17T06:01:00.000Z"),
  };
}

function delivery(
  messageKind: IntegrationCloudLinkDelivery["messageKind"],
  position: string,
  digest: string,
  streamEpoch = "9",
): IntegrationCloudLinkDelivery {
  return {
    sessionId: parseCloudLinkSessionId("44444444-4444-4444-8444-444444444444"),
    sessionEpoch: parseCloudLinkSessionEpoch("4"),
    credentialGeneration: binding.generation,
    streamId: parseStreamId(
      messageKind === "integration-topology-snapshot"
        ? "integration-topology"
        : "integration-observations",
    ),
    streamEpoch: parseStreamEpoch(streamEpoch),
    position: parseStreamPosition(position),
    batchId:
      messageKind === "integration-topology-snapshot"
        ? "topology-12"
        : "ha-event-001",
    digest: `sha256:${digest}`,
    messageKind,
  };
}

integration("integration projection PostgreSQL crash durability", () => {
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
    await admin.query(
      await readFile(integrationProjectionPostgresMigrationUrl, "utf8"),
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
        aethercloud.integration_projection_cloudlink_ack_outbox,
        aethercloud.integration_projection_cloudlink_delivery_attempts,
        aethercloud.integration_projection_cloudlink_deliveries,
        aethercloud.integration_projection_cloudlink_streams,
        aethercloud.integration_projection_ingress_requests,
        aethercloud.integration_projection_batches,
        aethercloud.integration_projection_topologies,
        aethercloud.integration_projections,
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

  it("commits topology, observations, evidence, and exact durable ACKs once", async () => {
    const repository = new PostgresIntegrationProjectionRepository(database);
    const topologyReport = topologyInput();
    const topologyDelivery = delivery(
      "integration-topology-snapshot",
      "1",
      wireDigestA,
    );
    const acceptedTopology = await repository.persistTopology({
      ...topologyReport,
      cloudLinkDelivery: topologyDelivery,
    });
    expect(acceptedTopology).toMatchObject({
      outcome: "persisted",
      record: { revision: 1 },
      durableAcknowledgement: {
        acknowledgedPosition: "1",
        digest: `sha256:${wireDigestA}`,
      },
    });

    const observations = observationInput(topologyReport.topology);
    const observationDelivery = delivery(
      "integration-observation-batch",
      "1",
      wireDigestB,
    );
    const acceptedObservations = await repository.persistObservations({
      ...observations,
      cloudLinkDelivery: observationDelivery,
    });
    expect(acceptedObservations).toMatchObject({
      outcome: "persisted",
      record: { revision: 2 },
      durableAcknowledgement: {
        acknowledgedPosition: "1",
        digest: `sha256:${wireDigestB}`,
      },
    });

    const replay = await repository.persistTopology({
      ...topologyReport,
      cloudLinkDelivery: topologyDelivery,
    });
    expect(replay).toMatchObject({
      outcome: "replayed",
      record: {
        revision: 1,
        topology: { snapshotGeneration: "12" },
      },
      receipt: { revision: 1 },
      durableAcknowledgement: { acknowledgedPosition: "1" },
    });

    const counts = await admin.query<{
      acknowledgements: string;
      attempts: string;
      audit_events: string;
      batches: string;
      deliveries: string;
      inbox: string;
      outbox_events: string;
      projections: string;
      streams: string;
      topologies: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM aethercloud.integration_projections) AS projections,
        (SELECT count(*)::text FROM aethercloud.integration_projection_topologies) AS topologies,
        (SELECT count(*)::text FROM aethercloud.integration_projection_batches) AS batches,
        (SELECT count(*)::text FROM aethercloud.integration_projection_ingress_requests) AS inbox,
        (SELECT count(*)::text FROM aethercloud.integration_projection_cloudlink_streams) AS streams,
        (SELECT count(*)::text FROM aethercloud.integration_projection_cloudlink_deliveries) AS deliveries,
        (SELECT count(*)::text FROM aethercloud.integration_projection_cloudlink_delivery_attempts) AS attempts,
        (SELECT count(*)::text FROM aethercloud.integration_projection_cloudlink_ack_outbox) AS acknowledgements,
        (SELECT count(*)::text FROM aethercloud.audit_events) AS audit_events,
        (SELECT count(*)::text FROM aethercloud.outbox_events) AS outbox_events
    `);
    expect(counts.rows[0]).toEqual({
      acknowledgements: "2",
      attempts: "2",
      audit_events: "2",
      batches: "1",
      deliveries: "2",
      inbox: "2",
      outbox_events: "2",
      projections: "1",
      streams: "2",
      topologies: "1",
    });
  });

  it.each(["Stream_A:B", `S${"_".repeat(127)}`])(
    "persists the public CloudLink stream identifier boundary: %s",
    async (streamId) => {
      const repository = new PostgresIntegrationProjectionRepository(database);
      const input = topologyInput();
      const outer: IntegrationCloudLinkDelivery = {
        ...delivery("integration-topology-snapshot", "1", wireDigestA),
        streamId: parseStreamId(streamId),
      };

      await expect(
        repository.persistTopology({
          ...input,
          cloudLinkDelivery: outer,
        }),
      ).resolves.toMatchObject({
        outcome: "persisted",
        durableAcknowledgement: { streamId },
      });
    },
  );

  it("rolls back every projection and delivery fact before commit", async () => {
    const repository = new PostgresIntegrationProjectionRepository(database, {
      faultInjector: {
        afterStep(step) {
          if (step === "durable-ack-written") {
            throw new Error("simulated process failure before commit");
          }
        },
      },
    });
    await expect(
      repository.persistTopology({
        ...topologyInput(),
        cloudLinkDelivery: delivery(
          "integration-topology-snapshot",
          "1",
          wireDigestA,
        ),
      }),
    ).resolves.toEqual({ outcome: "storage-unavailable" });

    const facts = await admin.query<{ facts: string }>(`
      SELECT (
        (SELECT count(*) FROM aethercloud.integration_projections) +
        (SELECT count(*) FROM aethercloud.integration_projection_topologies) +
        (SELECT count(*) FROM aethercloud.integration_projection_ingress_requests) +
        (SELECT count(*) FROM aethercloud.integration_projection_cloudlink_streams) +
        (SELECT count(*) FROM aethercloud.integration_projection_cloudlink_deliveries) +
        (SELECT count(*) FROM aethercloud.integration_projection_cloudlink_delivery_attempts) +
        (SELECT count(*) FROM aethercloud.integration_projection_cloudlink_ack_outbox) +
        (SELECT count(*) FROM aethercloud.audit_events) +
        (SELECT count(*) FROM aethercloud.outbox_events)
      )::text AS facts
    `);
    expect(facts.rows[0]).toEqual({ facts: "0" });
  });

  it("rejects a stream gap before business writes and advances only after the missing position commits", async () => {
    const repository = new PostgresIntegrationProjectionRepository(database);
    const topologyReport = topologyInput();
    await expect(
      repository.persistTopology(topologyReport),
    ).resolves.toMatchObject({ outcome: "persisted", record: { revision: 1 } });

    const highInput = observationInput(
      topologyReport.topology,
      "ha-event-002",
      "observation-request-002",
      "1784268000200",
      22,
      digestC,
    );
    const highDelivery: IntegrationCloudLinkDelivery = {
      ...delivery("integration-observation-batch", "2", wireDigestB),
      batchId: highInput.batch.batchId,
    };
    await expect(
      repository.persistObservations({
        ...highInput,
        cloudLinkDelivery: highDelivery,
      }),
    ).resolves.toEqual({ outcome: "delivery-gap" });

    const afterGap = await admin.query<{
      audit_events: string;
      batches: string;
      deliveries: string;
      inbox: string;
      outbox_events: string;
      revision: string;
      streams: string;
    }>(`
      SELECT
        (SELECT revision::text FROM aethercloud.integration_projections) AS revision,
        (SELECT count(*)::text FROM aethercloud.integration_projection_batches) AS batches,
        (SELECT count(*)::text FROM aethercloud.integration_projection_ingress_requests) AS inbox,
        (SELECT count(*)::text FROM aethercloud.integration_projection_cloudlink_streams) AS streams,
        (SELECT count(*)::text FROM aethercloud.integration_projection_cloudlink_deliveries) AS deliveries,
        (SELECT count(*)::text FROM aethercloud.audit_events) AS audit_events,
        (SELECT count(*)::text FROM aethercloud.outbox_events) AS outbox_events
    `);
    expect(afterGap.rows[0]).toEqual({
      audit_events: "1",
      batches: "0",
      deliveries: "0",
      inbox: "1",
      outbox_events: "1",
      revision: "1",
      streams: "0",
    });

    const lowInput = observationInput(topologyReport.topology);
    const lowDelivery = delivery(
      "integration-observation-batch",
      "1",
      wireDigestA,
    );
    const failing = new PostgresIntegrationProjectionRepository(database, {
      faultInjector: {
        afterStep(step) {
          if (step === "delivery-written") {
            throw new Error("simulated missing-position commit failure");
          }
        },
      },
    });
    await expect(
      failing.persistObservations({
        ...lowInput,
        cloudLinkDelivery: lowDelivery,
      }),
    ).resolves.toEqual({ outcome: "storage-unavailable" });
    await expect(
      repository.persistObservations({
        ...highInput,
        cloudLinkDelivery: highDelivery,
      }),
    ).resolves.toEqual({ outcome: "delivery-gap" });

    const restarted = new PostgresIntegrationProjectionRepository(database);
    await expect(
      restarted.persistObservations({
        ...lowInput,
        cloudLinkDelivery: lowDelivery,
      }),
    ).resolves.toMatchObject({
      outcome: "persisted",
      durableAcknowledgement: { acknowledgedPosition: "1" },
    });
    const restartedAgain = new PostgresIntegrationProjectionRepository(
      database,
    );
    await expect(
      restartedAgain.persistObservations({
        ...highInput,
        cloudLinkDelivery: highDelivery,
      }),
    ).resolves.toMatchObject({
      outcome: "persisted",
      durableAcknowledgement: { acknowledgedPosition: "2" },
    });

    const final = await admin.query<{
      acknowledgements: string;
      attempts: string;
      batches: string;
      contiguous_position: string;
      deliveries: string;
      revision: string;
    }>(`
      SELECT
        (SELECT revision::text FROM aethercloud.integration_projections) AS revision,
        (SELECT count(*)::text FROM aethercloud.integration_projection_batches) AS batches,
        (SELECT count(*)::text FROM aethercloud.integration_projection_cloudlink_deliveries) AS deliveries,
        (SELECT count(*)::text FROM aethercloud.integration_projection_cloudlink_delivery_attempts) AS attempts,
        (SELECT count(*)::text FROM aethercloud.integration_projection_cloudlink_ack_outbox) AS acknowledgements,
        (
          SELECT contiguous_position::text
          FROM aethercloud.integration_projection_cloudlink_streams
        ) AS contiguous_position
    `);
    expect(final.rows[0]).toEqual({
      acknowledgements: "2",
      attempts: "2",
      batches: "2",
      contiguous_position: "2",
      deliveries: "2",
      revision: "3",
    });
  });

  it("serializes concurrent positions so the durable cursor never skips a delivery", async () => {
    const repository = new PostgresIntegrationProjectionRepository(database);
    const topologyReport = topologyInput();
    await repository.persistTopology(topologyReport);
    const lowInput = observationInput(topologyReport.topology);
    const highInput = observationInput(
      topologyReport.topology,
      "ha-event-002",
      "observation-request-002",
      "1784268000200",
      22,
      digestC,
    );
    const lowDelivery = delivery(
      "integration-observation-batch",
      "1",
      wireDigestA,
    );
    const highDelivery: IntegrationCloudLinkDelivery = {
      ...delivery("integration-observation-batch", "2", wireDigestB),
      batchId: highInput.batch.batchId,
    };

    const [low, high] = await Promise.all([
      repository.persistObservations({
        ...lowInput,
        cloudLinkDelivery: lowDelivery,
      }),
      repository.persistObservations({
        ...highInput,
        cloudLinkDelivery: highDelivery,
      }),
    ]);
    expect(low).toMatchObject({
      outcome: "persisted",
      durableAcknowledgement: { acknowledgedPosition: "1" },
    });
    expect(["delivery-gap", "persisted"]).toContain(high.outcome);
    if (high.outcome === "delivery-gap") {
      await expect(
        repository.persistObservations({
          ...highInput,
          cloudLinkDelivery: highDelivery,
        }),
      ).resolves.toMatchObject({
        outcome: "persisted",
        durableAcknowledgement: { acknowledgedPosition: "2" },
      });
    } else {
      expect(high).toMatchObject({
        durableAcknowledgement: { acknowledgedPosition: "2" },
      });
    }

    const final = await admin.query<{
      acknowledgements: string;
      batches: string;
      contiguous_position: string;
      deliveries: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM aethercloud.integration_projection_batches) AS batches,
        (SELECT count(*)::text FROM aethercloud.integration_projection_cloudlink_deliveries) AS deliveries,
        (SELECT count(*)::text FROM aethercloud.integration_projection_cloudlink_ack_outbox) AS acknowledgements,
        (
          SELECT contiguous_position::text
          FROM aethercloud.integration_projection_cloudlink_streams
        ) AS contiguous_position
    `);
    expect(final.rows[0]).toEqual({
      acknowledgements: "2",
      batches: "2",
      contiguous_position: "2",
      deliveries: "2",
    });
  });

  it("recovers the exact ACK after post-commit uncertainty and rejects conflicting positions", async () => {
    const input = topologyInput();
    const outer = delivery("integration-topology-snapshot", "1", wireDigestA);
    const uncertain = new PostgresIntegrationProjectionRepository(database, {
      faultInjector: {
        afterCommit() {
          throw new Error("simulated process loss after commit");
        },
      },
    });
    await expect(
      uncertain.persistTopology({ ...input, cloudLinkDelivery: outer }),
    ).resolves.toEqual({ outcome: "storage-unavailable" });

    const repository = new PostgresIntegrationProjectionRepository(database);
    const recovered = await repository.persistTopology({
      ...input,
      cloudLinkDelivery: outer,
    });
    expect(recovered).toMatchObject({
      outcome: "replayed",
      durableAcknowledgement: {
        acknowledgedPosition: "1",
        digest: `sha256:${wireDigestA}`,
      },
    });
    if (
      recovered.outcome !== "replayed" ||
      recovered.durableAcknowledgement === undefined
    ) {
      throw new Error("committed CloudLink delivery was not recovered");
    }
    await expect(
      repository.persistTopology(topologyInput("13", digestB)),
    ).resolves.toMatchObject({
      outcome: "persisted",
      record: {
        revision: 2,
        topology: { snapshotGeneration: "13" },
      },
    });

    const rotatedBinding: GatewayCredentialBinding = {
      ...binding,
      generation: parseGatewayCredentialGeneration("4"),
    };
    const reconnectedDelivery: IntegrationCloudLinkDelivery = {
      ...outer,
      sessionId: parseCloudLinkSessionId(
        "55555555-5555-4555-8555-555555555555",
      ),
      sessionEpoch: parseCloudLinkSessionEpoch("5"),
      credentialGeneration: rotatedBinding.generation,
    };
    const reconnected = await repository.persistTopology({
      ...input,
      binding: rotatedBinding,
      cloudLinkDelivery: reconnectedDelivery,
    });
    expect(reconnected).toMatchObject({
      outcome: "replayed",
      record: {
        revision: 1,
        topology: { snapshotGeneration: "12" },
      },
      receipt: { credentialGeneration: "3" },
      durableAcknowledgement: {
        sessionId: reconnectedDelivery.sessionId,
        sessionEpoch: "5",
        credentialGeneration: "4",
        acknowledgedPosition: "1",
        receiptId: recovered.durableAcknowledgement.receiptId,
      },
    });
    if (
      reconnected.outcome !== "replayed" ||
      reconnected.durableAcknowledgement === undefined
    ) {
      throw new Error("reconnected CloudLink delivery was not replayed");
    }
    expect(reconnected.durableAcknowledgement.outboxEventId).not.toBe(
      recovered.durableAcknowledgement.outboxEventId,
    );

    await expect(
      repository.persistTopology({
        ...topologyInput("12", digestB),
        cloudLinkDelivery: {
          ...outer,
          digest: `sha256:${wireDigestB}`,
        },
      }),
    ).resolves.toEqual({ outcome: "delivery-conflict" });
    const facts = await admin.query<{
      acknowledgements: string;
      business_digest: string;
      deliveries: string;
      payload_digest: string;
    }>(`
      SELECT
        (
          SELECT count(*)::text
          FROM aethercloud.integration_projection_cloudlink_ack_outbox
        ) AS acknowledgements,
        (
          SELECT count(*)::text
          FROM aethercloud.integration_projection_cloudlink_deliveries
        ) AS deliveries,
        (
          SELECT business_digest
          FROM aethercloud.integration_projection_cloudlink_deliveries
        ) AS business_digest,
        (
          SELECT payload_digest
          FROM aethercloud.integration_projection_ingress_requests
          WHERE request_id = 'topology-request-012'
        ) AS payload_digest
    `);
    expect(facts.rows[0]).toEqual({
      acknowledgements: "2",
      business_digest: `sha256:${wireDigestA}`,
      deliveries: "1",
      payload_digest: digestA,
    });
  });
});
