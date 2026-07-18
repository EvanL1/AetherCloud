import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type {
  IntegrationObservationPersistenceInput,
  IntegrationProjectionScope,
  IntegrationTopologyPersistenceInput,
} from "@aether-cloud/application";
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
  type PostgresIntegrationProjectionClient,
  type PostgresIntegrationProjectionFaultInjector,
  type PostgresIntegrationProjectionPersistenceStep,
  type PostgresIntegrationProjectionPool,
  type PostgresIntegrationProjectionQueryResult,
} from "../src/index.js";

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
const wireDigestA = "c".repeat(64);
const wireDigestB = "d".repeat(64);

function delivery(
  messageKind: IntegrationCloudLinkDelivery["messageKind"],
  position = "1",
  digest = wireDigestA,
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
    streamEpoch: parseStreamEpoch("9"),
    position: parseStreamPosition(position),
    batchId:
      messageKind === "integration-topology-snapshot"
        ? "topology-12"
        : "ha-event-001",
    digest: `sha256:${digest}`,
    messageKind,
  };
}

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

function result(
  rows: readonly Record<string, unknown>[] = [],
  rowCount = rows.length,
): PostgresIntegrationProjectionQueryResult<Record<string, unknown>> {
  return { rows, rowCount };
}

class ScenarioClient implements PostgresIntegrationProjectionClient {
  readonly calls: QueryCall[] = [];
  released = false;
  handler:
    | ((
        text: string,
        values: readonly unknown[],
      ) =>
        | Error
        | PostgresIntegrationProjectionQueryResult<Record<string, unknown>>
        | undefined)
    | undefined;

  query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresIntegrationProjectionQueryResult<Row>> {
    this.calls.push({ text, values });
    const response =
      this.handler?.(text, values) ??
      (hasTag(text, "upsert-delivery-attempt")
        ? result([{ position: values[5] }], 1)
        : hasTag(text, "update-stream-cursor")
          ? result([{ contiguous_position: values[5] }], 1)
          : /^\s*(?:INSERT|UPDATE)\b/u.test(text)
            ? result([], 1)
            : result());
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(
          response as PostgresIntegrationProjectionQueryResult<Row>,
        );
  }

  release(): void {
    this.released = true;
  }
}

class ScenarioPool implements PostgresIntegrationProjectionPool {
  readonly client: ScenarioClient;

  constructor(client: ScenarioClient) {
    this.client = client;
  }

  connect(): Promise<PostgresIntegrationProjectionClient> {
    return Promise.resolve(this.client);
  }
}

function topology(
  generation: string,
  integrationKind = "home-assistant",
): IntegrationTopologySnapshot {
  return defineIntegrationTopologySnapshot({
    schema: "aether.integration.topology-snapshot.v1alpha1",
    integrationId: "home-assistant:home",
    integrationKind,
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

function richTopology(): IntegrationTopologySnapshot {
  return defineIntegrationTopologySnapshot({
    schema: "aether.integration.topology-snapshot.v1alpha1",
    integrationId: "home-assistant:rich",
    integrationKind: "home-assistant",
    snapshotGeneration: "1",
    observedAtMs: "1784268000000",
    areas: [{ areaId: "area:kitchen", name: "Kitchen" }],
    devices: [
      {
        deviceId: "device:multi",
        name: "Multi sensor",
        areaId: "area:kitchen",
        manufacturer: "Example",
        model: "Multi 1",
        softwareVersion: "1.2.3",
        hardwareVersion: "A",
      },
    ],
    entities: [
      {
        entityId: "entity-registry:multi",
        sourceAddress: "sensor.multi",
        name: "Multi sensor",
        entityKind: "sensor",
        deviceId: "device:multi",
        areaId: "area:kitchen",
        points: [
          {
            pointKey: "boolean",
            title: "Boolean",
            kind: "status",
            valueType: "boolean",
          },
          {
            pointKey: "bytes",
            title: "Bytes",
            kind: "status",
            valueType: "bytes",
          },
          {
            pointKey: "decimal",
            title: "Decimal",
            kind: "telemetry",
            valueType: "decimal",
          },
          {
            pointKey: "float64",
            title: "Float",
            kind: "telemetry",
            valueType: "float64",
          },
          {
            pointKey: "int64",
            title: "Signed",
            kind: "telemetry",
            valueType: "int64",
          },
          {
            pointKey: "string",
            title: "String",
            kind: "status",
            valueType: "string",
          },
          {
            pointKey: "uint64",
            title: "Unsigned",
            kind: "telemetry",
            valueType: "uint64",
          },
        ],
      },
      {
        entityId: "entity-registry:standalone",
        sourceAddress: "binary_sensor.standalone",
        name: "Standalone",
        entityKind: "binary-sensor",
        points: [
          {
            pointKey: "state",
            title: "State",
            kind: "status",
            valueType: "boolean",
          },
        ],
      },
    ],
  });
}

function topologyInput(
  generation: string,
  requestId = `topology-request-${generation.padStart(3, "0")}`,
  integrationKind = "home-assistant",
  payloadDigest = digestA,
): IntegrationTopologyPersistenceInput {
  return {
    requestId,
    binding,
    topology: topology(generation, integrationKind),
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

function projectionRow(
  currentTopology: IntegrationTopologySnapshot,
  revision = 1,
  latestObservations: readonly unknown[] = [],
): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    project_id: projectId,
    gateway_id: gatewayId,
    integration_id: currentTopology.integrationId,
    integration_kind: currentTopology.integrationKind,
    snapshot_generation: currentTopology.snapshotGeneration,
    topology_digest: digestA,
    topology_payload: currentTopology,
    latest_observations: latestObservations,
    received_at: "2026-07-17T06:00:00.000Z",
    revision: String(revision),
  };
}

function inboxRow(
  input:
    | IntegrationObservationPersistenceInput
    | IntegrationTopologyPersistenceInput,
  revision: number,
): Record<string, unknown> {
  const observations = "batch" in input;
  return {
    operation: observations ? "observations" : "topology",
    integration_id: observations
      ? input.batch.integrationId
      : input.topology.integrationId,
    snapshot_generation: observations
      ? input.batch.snapshotGeneration
      : input.topology.snapshotGeneration,
    batch_id: observations ? input.batch.batchId : null,
    payload_digest: input.payloadDigest,
    credential_generation: input.binding.generation,
    revision: String(revision),
    audit_event_id: observations
      ? `audit:integration-observations:${"1".repeat(64)}`
      : `audit:integration-topology:${"1".repeat(64)}`,
    outbox_event_id: observations
      ? `outbox:integration-observations:${"1".repeat(64)}`
      : `outbox:integration-topology:${"1".repeat(64)}`,
    committed_at: input.receivedAt,
  };
}

function streamBindingRow(
  value: IntegrationCloudLinkDelivery,
  integrationId = topology("12").integrationId,
  contiguousPosition: string | null = value.position,
): Record<string, unknown> {
  return {
    integration_id: integrationId,
    message_kind: value.messageKind,
    contiguous_position: contiguousPosition,
  };
}

function deliveryRow(
  value: IntegrationCloudLinkDelivery,
  input:
    | IntegrationObservationPersistenceInput
    | IntegrationTopologyPersistenceInput,
): Record<string, unknown> {
  const observations = "batch" in input;
  return {
    integration_id: observations
      ? input.batch.integrationId
      : input.topology.integrationId,
    message_kind: value.messageKind,
    stream_id: value.streamId,
    stream_epoch: value.streamEpoch,
    position: value.position,
    batch_id: value.batchId,
    business_digest: value.digest,
    request_id: input.requestId,
    projection_audit_event_id: observations
      ? `audit:integration-observations:${"1".repeat(64)}`
      : `audit:integration-topology:${"1".repeat(64)}`,
    projection_outbox_event_id: observations
      ? `outbox:integration-observations:${"1".repeat(64)}`
      : `outbox:integration-topology:${"1".repeat(64)}`,
    accepted_at: input.receivedAt,
  };
}

function acknowledgementRow(
  value: IntegrationCloudLinkDelivery,
  input:
    | IntegrationObservationPersistenceInput
    | IntegrationTopologyPersistenceInput,
  receiptId?: string,
  outboxEventId?: string,
): Record<string, unknown> {
  const integrationId =
    "batch" in input ? input.batch.integrationId : input.topology.integrationId;
  const businessIdentity = [
    tenantId,
    projectId,
    gatewayId,
    integrationId,
    value.streamId,
    value.streamEpoch,
    value.position,
    value.batchId,
    value.digest,
    value.messageKind,
  ];
  const stableId = (prefix: string, fields: readonly string[]): string =>
    `${prefix}:${createHash("sha256")
      .update(fields.join("\u0000"), "utf8")
      .digest("hex")}`;
  return {
    outbox_event_id:
      outboxEventId ??
      stableId("outbox:cloudlink-integration-ack", [
        ...businessIdentity,
        value.sessionId,
        value.sessionEpoch,
        value.credentialGeneration,
      ]),
    receipt_id:
      receiptId ?? stableId("receipt:cloudlink-integration", businessIdentity),
    tenant_id: tenantId,
    project_id: projectId,
    gateway_id: gatewayId,
    integration_id: integrationId,
    message_kind: value.messageKind,
    session_id: value.sessionId,
    session_epoch: value.sessionEpoch,
    credential_generation: value.credentialGeneration,
    stream_id: value.streamId,
    stream_epoch: value.streamEpoch,
    acknowledged_position: value.position,
    batch_id: value.batchId,
    business_digest: value.digest,
    acknowledged_at: input.receivedAt,
  };
}

function scope(currentTopology = topology("12")): IntegrationProjectionScope {
  return {
    tenantId,
    projectId,
    gatewayId,
    integrationId: currentTopology.integrationId,
  };
}

function hasTag(text: string, tag: string): boolean {
  return text.includes(`integration-projection:${tag}`);
}

describe("PostgresIntegrationProjectionRepository", () => {
  it("atomically persists topology, Gateway inbox, identity, Audit, and Outbox evidence", async () => {
    const client = new ScenarioClient();
    const repository = new PostgresIntegrationProjectionRepository(
      new ScenarioPool(client),
    );
    const input = topologyInput("12");

    const persisted = await repository.persistTopology(input);
    expect(persisted).toMatchObject({
      outcome: "persisted",
      record: {
        topology: { snapshotGeneration: "12" },
        latestObservations: [],
        revision: 1,
      },
      receipt: {
        kind: "topology",
        requestId: input.requestId,
      },
    });
    if (persisted.outcome !== "persisted") {
      throw new Error("topology fixture was not persisted");
    }
    expect(persisted.receipt.auditEventId).toMatch(
      /^audit:integration-topology:/,
    );
    expect(persisted.receipt.outboxEventId).toMatch(
      /^outbox:integration-topology:/,
    );

    expect(client.calls.map((call) => call.text)).toEqual([
      "BEGIN",
      expect.stringContaining("set_config"),
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining(
        "integration-projection:select-current-for-update",
      ),
      expect.stringContaining("integration-projection:select-inbox"),
      expect.stringContaining("integration-projection:insert-current"),
      expect.stringContaining(
        "integration-projection:insert-topology-identity",
      ),
      expect.stringContaining("integration-projection:insert-inbox"),
      expect.stringContaining("INSERT INTO aethercloud.audit_events"),
      expect.stringContaining("INSERT INTO aethercloud.outbox_events"),
      "COMMIT",
    ]);
    expect(client.calls[1]?.values).toEqual([tenantId]);
    expect(
      client.calls.some((call) =>
        call.text.includes("integration_projection_topologies"),
      ),
    ).toBe(true);
    expect(client.released).toBe(true);
  });

  it("checks the current generation fence before looking up an old topology replay", async () => {
    const client = new ScenarioClient();
    const current = topology("13");
    client.handler = (text) =>
      hasTag(text, "select-current-for-update")
        ? result([projectionRow(current)])
        : result();
    const repository = new PostgresIntegrationProjectionRepository(
      new ScenarioPool(client),
    );

    await expect(
      repository.persistTopology(topologyInput("12")),
    ).resolves.toEqual({ outcome: "stale-generation" });
    expect(client.calls.some((call) => hasTag(call.text, "select-inbox"))).toBe(
      false,
    );
    expect(client.calls.at(-1)?.text).toBe("COMMIT");
  });

  it("atomically replaces a newer complete topology and clears prior observations", async () => {
    const client = new ScenarioClient();
    client.handler = (text) => {
      if (hasTag(text, "select-current-for-update")) {
        return result([projectionRow(topology("12"))]);
      }
      if (hasTag(text, "update-current")) return result([], 1);
      return undefined;
    };
    const repository = new PostgresIntegrationProjectionRepository(
      new ScenarioPool(client),
    );

    await expect(
      repository.persistTopology(topologyInput("13")),
    ).resolves.toMatchObject({
      outcome: "persisted",
      record: {
        topology: { snapshotGeneration: "13" },
        latestObservations: [],
        revision: 2,
      },
    });
    expect(
      client.calls.some((call) => hasTag(call.text, "update-current")),
    ).toBe(true);
  });

  it("does not allow one integration identity to change provider kind", async () => {
    const client = new ScenarioClient();
    client.handler = (text) =>
      hasTag(text, "select-current-for-update")
        ? result([projectionRow(topology("12"))])
        : result();
    const repository = new PostgresIntegrationProjectionRepository(
      new ScenarioPool(client),
    );

    await expect(
      repository.persistTopology(
        topologyInput("13", "topology-request-013", "different-provider"),
      ),
    ).resolves.toEqual({ outcome: "generation-conflict" });
    expect(client.calls.some((call) => hasTag(call.text, "select-inbox"))).toBe(
      false,
    );
  });

  it("replays an exact current topology with the original evidence and no new writes", async () => {
    const client = new ScenarioClient();
    const input = topologyInput("12");
    client.handler = (text) => {
      if (hasTag(text, "select-current-for-update")) {
        return result([projectionRow(input.topology)]);
      }
      if (hasTag(text, "select-inbox")) {
        return result([inboxRow(input, 1)]);
      }
      if (hasTag(text, "select-topology-history")) {
        return result([projectionRow(input.topology)]);
      }
      return undefined;
    };
    const repository = new PostgresIntegrationProjectionRepository(
      new ScenarioPool(client),
    );

    await expect(repository.persistTopology(input)).resolves.toMatchObject({
      outcome: "replayed",
      record: { revision: 1 },
      receipt: {
        auditEventId: `audit:integration-topology:${"1".repeat(64)}`,
      },
    });
    expect(
      client.calls.some((call) => hasTag(call.text, "insert-current")),
    ).toBe(false);
    expect(
      client.calls.some((call) =>
        call.text.includes("INSERT INTO aethercloud.audit_events"),
      ),
    ).toBe(false);
  });

  it("fences old observations before request replay and rejects reused batch identity", async () => {
    const current = topology("13");
    const oldInput = observationInput(topology("12"));
    const oldClient = new ScenarioClient();
    oldClient.handler = (text) =>
      hasTag(text, "select-current-for-update")
        ? result([projectionRow(current)])
        : result();
    const oldRepository = new PostgresIntegrationProjectionRepository(
      new ScenarioPool(oldClient),
    );

    await expect(oldRepository.persistObservations(oldInput)).resolves.toEqual({
      outcome: "generation-conflict",
    });
    expect(
      oldClient.calls.some((call) => hasTag(call.text, "select-inbox")),
    ).toBe(false);

    const batchClient = new ScenarioClient();
    batchClient.handler = (text) => {
      if (hasTag(text, "select-current-for-update")) {
        return result([projectionRow(topology("12"))]);
      }
      if (hasTag(text, "select-batch-identity")) {
        return result([{ payload_digest: digestA }]);
      }
      return undefined;
    };
    await expect(
      new PostgresIntegrationProjectionRepository(
        new ScenarioPool(batchClient),
      ).persistObservations(observationInput(topology("12"))),
    ).resolves.toEqual({ outcome: "batch-conflict" });
  });

  it("merges observations deterministically and returns current projection on replay", async () => {
    const currentTopology = topology("12");
    const currentObservation = observationInput(
      currentTopology,
      "ha-event-prior",
      "observation-request-prior",
      "1784268000200",
      22,
    ).batch.observations[0];
    if (currentObservation === undefined) throw new Error("missing fixture");
    const input = observationInput(
      currentTopology,
      "ha-event-older",
      "observation-request-older",
      "1784268000100",
      20,
    );
    const client = new ScenarioClient();
    client.handler = (text) => {
      if (hasTag(text, "select-current-for-update")) {
        return result([
          projectionRow(currentTopology, 2, [currentObservation]),
        ]);
      }
      if (hasTag(text, "update-current")) return result([], 1);
      return undefined;
    };
    const repository = new PostgresIntegrationProjectionRepository(
      new ScenarioPool(client),
    );

    await expect(repository.persistObservations(input)).resolves.toMatchObject({
      outcome: "persisted",
      record: {
        revision: 3,
        latestObservations: [
          {
            observedAtMs: "1784268000200",
            value: { type: "float64", value: 22 },
          },
        ],
      },
    });

    const replayClient = new ScenarioClient();
    replayClient.handler = (text) => {
      if (hasTag(text, "select-current-for-update")) {
        return result([
          projectionRow(currentTopology, 4, [currentObservation]),
        ]);
      }
      if (hasTag(text, "select-inbox")) {
        return result([inboxRow(input, 3)]);
      }
      return undefined;
    };
    await expect(
      new PostgresIntegrationProjectionRepository(
        new ScenarioPool(replayClient),
      ).persistObservations(input),
    ).resolves.toMatchObject({
      outcome: "replayed",
      record: { revision: 4 },
      receipt: { revision: 3, batchId: "ha-event-older" },
    });
  });

  it("rejects Gateway request reuse and safe-integer revision overflow", async () => {
    const input = observationInput(topology("12"));
    const conflictClient = new ScenarioClient();
    conflictClient.handler = (text) => {
      if (hasTag(text, "select-current-for-update")) {
        return result([projectionRow(topology("12"))]);
      }
      if (hasTag(text, "select-inbox")) {
        return result([
          {
            ...inboxRow(input, 2),
            payload_digest: digestA,
          },
        ]);
      }
      return undefined;
    };
    await expect(
      new PostgresIntegrationProjectionRepository(
        new ScenarioPool(conflictClient),
      ).persistObservations(input),
    ).resolves.toEqual({ outcome: "idempotency-conflict" });

    const overflowClient = new ScenarioClient();
    overflowClient.handler = (text) =>
      hasTag(text, "select-current-for-update")
        ? result([projectionRow(topology("12"), Number.MAX_SAFE_INTEGER)])
        : result();
    await expect(
      new PostgresIntegrationProjectionRepository(
        new ScenarioPool(overflowClient),
      ).persistObservations(input),
    ).resolves.toEqual({ outcome: "storage-unavailable" });
    expect(
      overflowClient.calls.some((call) => hasTag(call.text, "update-current")),
    ).toBe(false);
  });

  it("validates persisted JSONB through domain constructors and rolls back corrupt reads", async () => {
    const client = new ScenarioClient();
    client.handler = (text) =>
      hasTag(text, "select-current")
        ? result([
            {
              ...projectionRow(topology("12")),
              topology_payload: {
                ...topology("12"),
                entities: [
                  {
                    ...topology("12").entities[0],
                    points: [
                      {
                        pointKey: "current_temperature",
                        title: "Current temperature",
                        kind: "telemetry",
                        valueType: "not-a-value-type",
                      },
                    ],
                  },
                ],
              },
            },
          ])
        : result();
    const repository = new PostgresIntegrationProjectionRepository(
      new ScenarioPool(client),
    );

    await expect(repository.findCurrent(scope())).resolves.toBeUndefined();
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(client.calls.some((call) => call.text === "COMMIT")).toBe(false);
    expect(client.released).toBe(true);
  });

  it("rehydrates every typed value and optional topology branch from JSONB", async () => {
    const currentTopology = richTopology();
    const latestObservations = [
      {
        entityId: "entity-registry:multi",
        pointKey: "boolean",
        observedAtMs: "1784268000100",
        quality: "good",
        value: { type: "boolean", value: true },
      },
      {
        entityId: "entity-registry:multi",
        pointKey: "bytes",
        observedAtMs: "1784268000100",
        quality: "good",
        value: { type: "bytes", encoding: "base64url", value: "" },
      },
      {
        entityId: "entity-registry:multi",
        pointKey: "decimal",
        observedAtMs: "1784268000100",
        quality: "good",
        value: { type: "decimal", value: "1.25" },
      },
      {
        entityId: "entity-registry:multi",
        pointKey: "float64",
        observedAtMs: "1784268000100",
        quality: "good",
        value: { type: "float64", value: 1.5 },
      },
      {
        entityId: "entity-registry:multi",
        pointKey: "int64",
        observedAtMs: "1784268000100",
        quality: "good",
        value: { type: "int64", value: "-1" },
      },
      {
        entityId: "entity-registry:multi",
        pointKey: "string",
        observedAtMs: "1784268000100",
        quality: "good",
        value: { type: "string", value: "" },
      },
      {
        entityId: "entity-registry:multi",
        pointKey: "uint64",
        observedAtMs: "1784268000100",
        quality: "uncertain",
        value: { type: "uint64", value: "1" },
        diagnostic: "estimated",
      },
      {
        entityId: "entity-registry:standalone",
        pointKey: "state",
        observedAtMs: "1784268000100",
        quality: "unavailable",
        diagnostic: "offline",
      },
    ];
    const client = new ScenarioClient();
    client.handler = (text) =>
      hasTag(text, "select-current")
        ? result([projectionRow(currentTopology, 2, latestObservations)])
        : result();
    const repository = new PostgresIntegrationProjectionRepository(
      new ScenarioPool(client),
    );

    const record = await repository.findCurrent({
      tenantId,
      projectId,
      gatewayId,
      integrationId: currentTopology.integrationId,
    });

    expect(record).toMatchObject({
      revision: 2,
      topology: {
        devices: [
          {
            manufacturer: "Example",
            softwareVersion: "1.2.3",
          },
        ],
      },
      latestObservations: [
        { pointKey: "boolean", value: { type: "boolean", value: true } },
        { pointKey: "bytes", value: { type: "bytes", value: "" } },
        { pointKey: "decimal", value: { type: "decimal", value: "1.25" } },
        { pointKey: "float64", value: { type: "float64", value: 1.5 } },
        { pointKey: "int64", value: { type: "int64", value: "-1" } },
        { pointKey: "string", value: { type: "string", value: "" } },
        { pointKey: "uint64", value: { type: "uint64", value: "1" } },
        {
          pointKey: "state",
          quality: "unavailable",
          diagnostic: "offline",
        },
      ],
    });
  });

  it("returns an immutable historical topology without current observation state", async () => {
    const historical = topology("12");
    const client = new ScenarioClient();
    client.handler = (text) =>
      hasTag(text, "select-topology-history")
        ? result([projectionRow(historical, 4)])
        : undefined;
    const repository = new PostgresIntegrationProjectionRepository(
      new ScenarioPool(client),
    );

    const record = await repository.findTopology(
      scope(historical),
      historical.snapshotGeneration,
    );

    expect(record).toEqual({
      tenantId,
      projectId,
      gatewayId,
      integrationId: historical.integrationId,
      topology: historical,
      topologyDigest: digestA,
      receivedAt: "2026-07-17T06:00:00.000Z",
      revision: 4,
    });
    expect(record).not.toHaveProperty("latestObservations");
    expect(client.calls[1]?.values).toEqual([tenantId]);
  });

  it.each<PostgresIntegrationProjectionPersistenceStep>([
    "projection-written",
    "identity-written",
    "inbox-written",
    "audit-written",
    "outbox-written",
  ])("rolls back every write after an injected %s failure", async (step) => {
    const client = new ScenarioClient();
    const faultInjector: PostgresIntegrationProjectionFaultInjector = {
      afterStep(completed) {
        if (completed === step) throw new Error(`failure after ${step}`);
      },
    };
    const repository = new PostgresIntegrationProjectionRepository(
      new ScenarioPool(client),
      { faultInjector },
    );

    await expect(
      repository.persistTopology(topologyInput("12")),
    ).resolves.toEqual({ outcome: "storage-unavailable" });
    expect(client.calls.some((call) => call.text === "ROLLBACK")).toBe(true);
    expect(client.calls.some((call) => call.text === "COMMIT")).toBe(false);
    expect(client.released).toBe(true);
  });

  it("atomically binds a CloudLink topology delivery and creates a recoverable durable ACK", async () => {
    const client = new ScenarioClient();
    const input = topologyInput("12");
    const outer = delivery("integration-topology-snapshot");
    client.handler = (text) =>
      hasTag(text, "upsert-durable-ack")
        ? result([acknowledgementRow(outer, input)], 1)
        : undefined;
    const repository = new PostgresIntegrationProjectionRepository(
      new ScenarioPool(client),
    );

    const persisted = await repository.persistTopology({
      ...input,
      cloudLinkDelivery: outer,
    });

    expect(persisted).toMatchObject({
      outcome: "persisted",
      receipt: { requestId: input.requestId },
      durableAcknowledgement: {
        tenantId,
        projectId,
        gatewayId,
        integrationId: input.topology.integrationId,
        sessionId: outer.sessionId,
        streamId: outer.streamId,
        acknowledgedPosition: outer.position,
        digest: outer.digest,
        messageKind: outer.messageKind,
      },
    });
    if (
      persisted.outcome !== "persisted" ||
      persisted.durableAcknowledgement === undefined
    ) {
      throw new Error("CloudLink topology fixture was not persisted");
    }
    expect(persisted.durableAcknowledgement.receiptId).toContain(
      "receipt:cloudlink-integration:",
    );
    expect(persisted.durableAcknowledgement.outboxEventId).toContain(
      "outbox:cloudlink-integration-ack:",
    );
    expect(
      client.calls.some((call) => hasTag(call.text, "insert-stream-binding")),
    ).toBe(true);
    expect(
      client.calls.some((call) => hasTag(call.text, "insert-delivery")),
    ).toBe(true);
    expect(
      client.calls.some((call) => hasTag(call.text, "upsert-durable-ack")),
    ).toBe(true);
    expect(client.calls.at(-1)?.text).toBe("COMMIT");
  });

  it("locks and validates the active session head in the signed business transaction", async () => {
    const input = topologyInput("12");
    const outer = delivery("integration-topology-snapshot");
    const cloudLinkSessionFence = {
      tenantId,
      projectId,
      gatewayId,
      sessionId: outer.sessionId,
      sessionEpoch: outer.sessionEpoch,
      sessionRevision: 3,
      credentialGeneration: outer.credentialGeneration,
      gatewayKeyId: "gateway-session-key-17",
    } as const;
    const acceptedClient = new ScenarioClient();
    acceptedClient.handler = (text) =>
      hasTag(text, "lock-current-cloudlink-session-fence")
        ? result([
            {
              session_id: outer.sessionId,
              session_epoch: outer.sessionEpoch,
              session_revision: "3",
              credential_generation: outer.credentialGeneration,
              gateway_key_id: cloudLinkSessionFence.gatewayKeyId,
            },
          ])
        : hasTag(text, "upsert-durable-ack")
          ? result([acknowledgementRow(outer, input)], 1)
          : undefined;

    await expect(
      new PostgresIntegrationProjectionRepository(
        new ScenarioPool(acceptedClient),
      ).persistTopology({
        ...input,
        cloudLinkDelivery: outer,
        cloudLinkSessionFence,
      }),
    ).resolves.toMatchObject({ outcome: "persisted" });
    expect(
      acceptedClient.calls.find((call) =>
        hasTag(call.text, "lock-current-cloudlink-session-fence"),
      )?.values,
    ).toEqual([
      tenantId,
      projectId,
      gatewayId,
      outer.sessionId,
      outer.sessionEpoch,
      3,
      outer.credentialGeneration,
      cloudLinkSessionFence.gatewayKeyId,
    ]);

    const fencedClient = new ScenarioClient();
    await expect(
      new PostgresIntegrationProjectionRepository(
        new ScenarioPool(fencedClient),
      ).persistTopology({
        ...input,
        cloudLinkDelivery: outer,
        cloudLinkSessionFence,
      }),
    ).resolves.toEqual({ outcome: "session-fenced" });
    expect(
      fencedClient.calls.some((call) => hasTag(call.text, "insert-current")),
    ).toBe(false);
  });

  it("recovers an exact CloudLink delivery ACK without replaying an obsolete topology", async () => {
    const client = new ScenarioClient();
    const input = topologyInput("12");
    const outer = delivery("integration-topology-snapshot");
    client.handler = (text) => {
      if (hasTag(text, "select-stream-binding")) {
        return result([streamBindingRow(outer)]);
      }
      if (hasTag(text, "select-delivery")) {
        return result([deliveryRow(outer, input)]);
      }
      if (hasTag(text, "select-current-for-update")) {
        return result([projectionRow(topology("13"), 2)]);
      }
      if (hasTag(text, "select-inbox")) {
        return result([inboxRow(input, 1)]);
      }
      if (hasTag(text, "select-topology-history")) {
        return result([projectionRow(input.topology)]);
      }
      if (hasTag(text, "upsert-durable-ack")) {
        return result([acknowledgementRow(outer, input)], 1);
      }
      return undefined;
    };
    const repository = new PostgresIntegrationProjectionRepository(
      new ScenarioPool(client),
    );

    await expect(
      repository.persistTopology({ ...input, cloudLinkDelivery: outer }),
    ).resolves.toMatchObject({
      outcome: "replayed",
      record: {
        topology: { snapshotGeneration: "12" },
        revision: 1,
      },
      receipt: { snapshotGeneration: "12" },
      durableAcknowledgement: {
        acknowledgedPosition: "1",
        receiptId: acknowledgementRow(outer, input).receipt_id,
      },
    });
    expect(
      client.calls.some((call) => hasTag(call.text, "insert-delivery")),
    ).toBe(false);
    expect(
      client.calls.some((call) => hasTag(call.text, "insert-current")),
    ).toBe(false);
  });

  it("replays one durable position after reconnect and emits an ACK for the new authenticated session", async () => {
    const acceptedInput = topologyInput("12");
    const acceptedDelivery = delivery("integration-topology-snapshot");
    const rotatedBinding = {
      ...binding,
      generation: parseGatewayCredentialGeneration("4"),
    };
    const replayInput: IntegrationTopologyPersistenceInput = {
      ...acceptedInput,
      binding: rotatedBinding,
    };
    const reconnectedDelivery: IntegrationCloudLinkDelivery = {
      ...acceptedDelivery,
      sessionId: parseCloudLinkSessionId(
        "55555555-5555-4555-8555-555555555555",
      ),
      sessionEpoch: parseCloudLinkSessionEpoch("5"),
      credentialGeneration: rotatedBinding.generation,
    };
    const client = new ScenarioClient();
    client.handler = (text) => {
      if (hasTag(text, "select-stream-binding")) {
        return result([streamBindingRow(acceptedDelivery)]);
      }
      if (hasTag(text, "select-delivery")) {
        return result([deliveryRow(acceptedDelivery, acceptedInput)]);
      }
      if (hasTag(text, "select-current-for-update")) {
        return result([projectionRow(topology("13"), 2)]);
      }
      if (hasTag(text, "select-inbox")) {
        return result([inboxRow(acceptedInput, 1)]);
      }
      if (hasTag(text, "select-topology-history")) {
        return result([projectionRow(acceptedInput.topology)]);
      }
      if (hasTag(text, "upsert-durable-ack")) {
        return result(
          [acknowledgementRow(reconnectedDelivery, replayInput)],
          1,
        );
      }
      return undefined;
    };
    const repository = new PostgresIntegrationProjectionRepository(
      new ScenarioPool(client),
    );

    await expect(
      repository.persistTopology({
        ...replayInput,
        cloudLinkDelivery: reconnectedDelivery,
      }),
    ).resolves.toMatchObject({
      outcome: "replayed",
      record: {
        topology: { snapshotGeneration: "12" },
        revision: 1,
      },
      receipt: {
        credentialGeneration: "3",
        revision: 1,
      },
      durableAcknowledgement: {
        sessionId: reconnectedDelivery.sessionId,
        sessionEpoch: "5",
        credentialGeneration: "4",
        acknowledgedPosition: acceptedDelivery.position,
        digest: acceptedDelivery.digest,
      },
    });
    expect(
      client.calls.some((call) => hasTag(call.text, "insert-delivery")),
    ).toBe(false);
    expect(
      client.calls.some((call) => hasTag(call.text, "upsert-durable-ack")),
    ).toBe(true);
  });

  it("persists and replays a CloudLink observation delivery with its original receipt", async () => {
    const currentTopology = topology("12");
    const input = observationInput(currentTopology);
    const outer = delivery("integration-observation-batch", "1", wireDigestB);
    const client = new ScenarioClient();
    client.handler = (text) => {
      if (hasTag(text, "select-current-for-update")) {
        return result([projectionRow(currentTopology)]);
      }
      if (hasTag(text, "update-current")) return result([], 1);
      if (hasTag(text, "upsert-durable-ack")) {
        return result([acknowledgementRow(outer, input)], 1);
      }
      return undefined;
    };
    const repository = new PostgresIntegrationProjectionRepository(
      new ScenarioPool(client),
    );

    await expect(
      repository.persistObservations({ ...input, cloudLinkDelivery: outer }),
    ).resolves.toMatchObject({
      outcome: "persisted",
      record: { revision: 2 },
      receipt: { kind: "observations", batchId: "ha-event-001" },
      durableAcknowledgement: {
        acknowledgedPosition: "1",
        digest: `sha256:${wireDigestB}`,
      },
    });

    const observation = input.batch.observations[0];
    if (observation === undefined) throw new Error("missing observation");
    const replayClient = new ScenarioClient();
    replayClient.handler = (text) => {
      if (hasTag(text, "select-stream-binding")) {
        return result([streamBindingRow(outer)]);
      }
      if (hasTag(text, "select-delivery")) {
        return result([deliveryRow(outer, input)]);
      }
      if (hasTag(text, "select-current-for-update")) {
        return result([projectionRow(currentTopology, 2, [observation])]);
      }
      if (hasTag(text, "select-inbox")) {
        return result([inboxRow(input, 2)]);
      }
      if (hasTag(text, "upsert-durable-ack")) {
        return result([acknowledgementRow(outer, input)], 1);
      }
      return undefined;
    };
    await expect(
      new PostgresIntegrationProjectionRepository(
        new ScenarioPool(replayClient),
      ).persistObservations({ ...input, cloudLinkDelivery: outer }),
    ).resolves.toMatchObject({
      outcome: "replayed",
      record: { revision: 2 },
      receipt: { kind: "observations", revision: 2 },
      durableAcknowledgement: { acknowledgedPosition: "1" },
    });
  });

  it("rejects an out-of-order delivery before business writes, then accepts positions one and two contiguously", async () => {
    const currentTopology = topology("12");
    const highInput = observationInput(
      currentTopology,
      "ha-event-002",
      "observation-request-002",
      "1784268000200",
      22,
    );
    const highDelivery: IntegrationCloudLinkDelivery = {
      ...delivery("integration-observation-batch", "2", wireDigestB),
      batchId: highInput.batch.batchId,
    };
    const highClient = new ScenarioClient();
    const high = await new PostgresIntegrationProjectionRepository(
      new ScenarioPool(highClient),
    ).persistObservations({
      ...highInput,
      cloudLinkDelivery: highDelivery,
    });

    expect(high).toEqual({ outcome: "delivery-gap" });
    expect(
      highClient.calls.some(
        (call) =>
          hasTag(call.text, "select-current-for-update") ||
          hasTag(call.text, "insert-delivery") ||
          call.text.includes("aethercloud.audit_events") ||
          call.text.includes("aethercloud.outbox_events"),
      ),
    ).toBe(false);

    const lowInput = observationInput(currentTopology);
    const lowDelivery = delivery(
      "integration-observation-batch",
      "1",
      wireDigestA,
    );
    const lowClient = new ScenarioClient();
    lowClient.handler = (text) => {
      if (hasTag(text, "select-current-for-update")) {
        return result([projectionRow(currentTopology)]);
      }
      if (hasTag(text, "update-current")) return result([], 1);
      if (hasTag(text, "upsert-durable-ack")) {
        return result([acknowledgementRow(lowDelivery, lowInput)], 1);
      }
      return undefined;
    };

    await expect(
      new PostgresIntegrationProjectionRepository(
        new ScenarioPool(lowClient),
      ).persistObservations({
        ...lowInput,
        cloudLinkDelivery: lowDelivery,
      }),
    ).resolves.toMatchObject({
      outcome: "persisted",
      receipt: { batchId: "ha-event-001" },
      durableAcknowledgement: {
        acknowledgedPosition: "1",
        batchId: "ha-event-001",
        digest: lowDelivery.digest,
      },
    });
    expect(
      lowClient.calls.find((call) => hasTag(call.text, "update-stream-cursor"))
        ?.values[5],
    ).toBe("1");

    const lowObservation = lowInput.batch.observations[0];
    if (lowObservation === undefined) {
      throw new Error("missing low observation fixture");
    }
    const retryClient = new ScenarioClient();
    retryClient.handler = (text) => {
      if (hasTag(text, "select-stream-binding")) {
        return result([streamBindingRow(highDelivery, undefined, "1")]);
      }
      if (hasTag(text, "select-current-for-update")) {
        return result([projectionRow(currentTopology, 2, [lowObservation])]);
      }
      if (hasTag(text, "update-current")) return result([], 1);
      if (hasTag(text, "upsert-durable-ack")) {
        return result([acknowledgementRow(highDelivery, highInput)], 1);
      }
      return undefined;
    };
    await expect(
      new PostgresIntegrationProjectionRepository(
        new ScenarioPool(retryClient),
      ).persistObservations({
        ...highInput,
        cloudLinkDelivery: highDelivery,
      }),
    ).resolves.toMatchObject({
      outcome: "persisted",
      receipt: { batchId: "ha-event-002" },
      durableAcknowledgement: {
        acknowledgedPosition: "2",
        batchId: "ha-event-002",
        digest: highDelivery.digest,
      },
    });
  });

  it("fails closed on CloudLink position or stream binding conflicts", async () => {
    const input = topologyInput("12");
    const outer = delivery("integration-topology-snapshot");
    const positionClient = new ScenarioClient();
    positionClient.handler = (text) => {
      if (hasTag(text, "select-stream-binding")) {
        return result([streamBindingRow(outer)]);
      }
      if (hasTag(text, "select-delivery")) {
        return result([
          {
            ...deliveryRow(outer, input),
            business_digest: `sha256:${wireDigestB}`,
          },
        ]);
      }
      return undefined;
    };
    await expect(
      new PostgresIntegrationProjectionRepository(
        new ScenarioPool(positionClient),
      ).persistTopology({ ...input, cloudLinkDelivery: outer }),
    ).resolves.toEqual({ outcome: "delivery-conflict" });
    expect(
      positionClient.calls.some((call) =>
        hasTag(call.text, "select-current-for-update"),
      ),
    ).toBe(false);

    const streamClient = new ScenarioClient();
    streamClient.handler = (text) =>
      hasTag(text, "select-stream-binding")
        ? result([
            {
              ...streamBindingRow(outer),
              integration_id: "home-assistant:different",
            },
          ])
        : result();
    await expect(
      new PostgresIntegrationProjectionRepository(
        new ScenarioPool(streamClient),
      ).persistTopology({ ...input, cloudLinkDelivery: outer }),
    ).resolves.toEqual({ outcome: "stream-binding-conflict" });
  });

  it("rejects non-positive wire cursors and message-specific batch identities", async () => {
    const input = topologyInput("12");
    const valid = delivery("integration-topology-snapshot");
    const invalidDeliveries: readonly IntegrationCloudLinkDelivery[] = [
      { ...valid, position: parseStreamPosition("0") },
      { ...valid, sessionEpoch: parseCloudLinkSessionEpoch("0") },
      {
        ...valid,
        credentialGeneration: parseGatewayCredentialGeneration("0"),
      },
      { ...valid, batchId: "not-the-topology-generation" },
    ];
    for (const invalid of invalidDeliveries) {
      await expect(
        new PostgresIntegrationProjectionRepository(
          new ScenarioPool(new ScenarioClient()),
        ).persistTopology({ ...input, cloudLinkDelivery: invalid }),
      ).resolves.toEqual({ outcome: "delivery-conflict" });
    }

    const observation = observationInput(input.topology);
    await expect(
      new PostgresIntegrationProjectionRepository(
        new ScenarioPool(new ScenarioClient()),
      ).persistObservations({
        ...observation,
        cloudLinkDelivery: {
          ...delivery("integration-observation-batch", "8", wireDigestB),
          batchId: "different-observation-batch",
        },
      }),
    ).resolves.toEqual({ outcome: "delivery-conflict" });
  });

  it.each(["Stream_A:B", `S${"_".repeat(127)}`])(
    "accepts the public 128-character CloudLink stream identifier contract: %s",
    async (streamId) => {
      const input = topologyInput("12");
      const outer: IntegrationCloudLinkDelivery = {
        ...delivery("integration-topology-snapshot"),
        streamId: parseStreamId(streamId),
      };
      const client = new ScenarioClient();
      client.handler = (text) =>
        hasTag(text, "upsert-durable-ack")
          ? result([acknowledgementRow(outer, input)], 1)
          : undefined;

      await expect(
        new PostgresIntegrationProjectionRepository(
          new ScenarioPool(client),
        ).persistTopology({ ...input, cloudLinkDelivery: outer }),
      ).resolves.toMatchObject({
        outcome: "persisted",
        durableAcknowledgement: { streamId },
      });
    },
  );

  it.each<PostgresIntegrationProjectionPersistenceStep>([
    "stream-binding-written",
    "delivery-written",
    "delivery-attempt-written",
    "cursor-written",
    "durable-ack-written",
  ])("rolls back a CloudLink transaction after %s", async (step) => {
    const client = new ScenarioClient();
    const input = topologyInput("12");
    const outer = delivery("integration-topology-snapshot");
    client.handler = (text) =>
      hasTag(text, "upsert-durable-ack")
        ? result([acknowledgementRow(outer, input)], 1)
        : undefined;
    const repository = new PostgresIntegrationProjectionRepository(
      new ScenarioPool(client),
      {
        faultInjector: {
          afterStep(completed) {
            if (completed === step) throw new Error(`failure after ${step}`);
          },
        },
      },
    );

    await expect(
      repository.persistTopology({ ...input, cloudLinkDelivery: outer }),
    ).resolves.toEqual({ outcome: "storage-unavailable" });
    expect(client.calls.some((call) => call.text === "ROLLBACK")).toBe(true);
    expect(client.calls.some((call) => call.text === "COMMIT")).toBe(false);
  });

  it("defines bounded identities, forced Tenant RLS, and reuses shared evidence tables", async () => {
    const migration = await readFile(
      integrationProjectionPostgresMigrationUrl,
      "utf8",
    );

    expect(migration).toContain(
      "CREATE TABLE aethercloud.integration_projections",
    );
    expect(migration).toContain(
      "CREATE TABLE aethercloud.integration_projection_ingress_requests",
    );
    expect(migration).toContain(
      "CREATE TABLE aethercloud.integration_projection_topologies",
    );
    expect(migration).toContain(
      "CREATE TABLE aethercloud.integration_projection_batches",
    );
    expect(migration).toContain(
      "CREATE TABLE aethercloud.integration_projection_cloudlink_streams",
    );
    expect(migration).toContain(
      "CREATE TABLE aethercloud.integration_projection_cloudlink_deliveries",
    );
    expect(migration).toContain(
      "CREATE TABLE aethercloud.integration_projection_cloudlink_delivery_attempts",
    );
    expect(migration).toContain(
      "CREATE TABLE aethercloud.integration_projection_cloudlink_ack_outbox",
    );
    expect(migration).toContain(
      "integration_projection_cloudlink_stream_binding_uq",
    );
    expect(migration).toContain("business_digest ~ '^sha256:[0-9a-f]{64}$'");
    expect(migration).toContain(
      "integration_projection_cloudlink_ack_pending_idx",
    );
    expect(migration).toContain("numeric(20, 0)");
    expect(migration).toContain("9007199254740991");
    expect(migration).toContain("contiguous_position numeric(20, 0)");
    expect(migration).toContain(
      "stream_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'",
    );
    expect(migration.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(8);
    expect(migration).toContain(
      "current_setting('aethercloud.tenant_id', true)",
    );
    expect(migration).not.toMatch(
      /CREATE TABLE aethercloud\.(?:audit_events|outbox_events)/,
    );
  });
});
