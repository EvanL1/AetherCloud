import { describe, expect, it } from "vitest";

import type {
  IntegrationCloudLinkDelivery,
  IntegrationCloudLinkSessionFence,
  IntegrationCloudLinkSessionFenceVerifier,
  IntegrationObservationPersistenceInput,
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
} from "@aether-cloud/domain";

import {
  InMemoryIntegrationProjectionRepository,
  NodeIntegrationPayloadDigestor,
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

class MutableSessionFenceVerifier implements IntegrationCloudLinkSessionFenceVerifier {
  currentSessionId = parseCloudLinkSessionId(
    "44444444-4444-4444-8444-444444444444",
  );
  currentRevision = 1;

  isCurrentSessionFence(fence: IntegrationCloudLinkSessionFence): boolean {
    return (
      fence.tenantId === tenantId &&
      fence.projectId === projectId &&
      fence.gatewayId === gatewayId &&
      fence.sessionId === this.currentSessionId &&
      fence.sessionEpoch === "7" &&
      fence.sessionRevision === this.currentRevision &&
      fence.credentialGeneration === binding.generation &&
      fence.gatewayKeyId === "gateway-session-key-17"
    );
  }
}

function cloudLinkDelivery(
  position: string,
  batchId: string,
  digestCharacter: string,
  session = "44444444-4444-4444-8444-444444444444",
): IntegrationCloudLinkDelivery {
  return {
    sessionId: parseCloudLinkSessionId(session),
    sessionEpoch: parseCloudLinkSessionEpoch("7"),
    credentialGeneration: binding.generation,
    streamId: parseStreamId("Integration_Topology:Home"),
    streamEpoch: parseStreamEpoch("9"),
    position: parseStreamPosition(position),
    batchId,
    digest: `sha256:${digestCharacter.repeat(64)}`,
    messageKind: "integration-topology-snapshot",
  };
}

function observationCloudLinkDelivery(
  position: string,
  batchId: string,
  digestCharacter: string,
): IntegrationCloudLinkDelivery {
  return {
    sessionId: parseCloudLinkSessionId("44444444-4444-4444-8444-444444444444"),
    sessionEpoch: parseCloudLinkSessionEpoch("7"),
    credentialGeneration: binding.generation,
    streamId: parseStreamId("Integration_Observations:Home"),
    streamEpoch: parseStreamEpoch("9"),
    position: parseStreamPosition(position),
    batchId,
    digest: `sha256:${digestCharacter.repeat(64)}`,
    messageKind: "integration-observation-batch",
  };
}

function sessionFence(
  delivery: IntegrationCloudLinkDelivery,
): IntegrationCloudLinkSessionFence {
  return {
    tenantId,
    projectId,
    gatewayId,
    sessionId: delivery.sessionId,
    sessionEpoch: delivery.sessionEpoch,
    sessionRevision: 1,
    credentialGeneration: delivery.credentialGeneration,
    gatewayKeyId: "gateway-session-key-17",
  };
}

function topology(generation: string, name = "Kitchen climate") {
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
        name,
        entityKind: "climate",
        deviceId: "device:thermostat",
        areaId: "area:kitchen",
        points: [
          {
            pointKey: "state",
            title: "Mode",
            kind: "status",
            valueType: "string",
          },
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

function observations(
  currentTopology: ReturnType<typeof topology>,
  batchId: string,
  observedAtMs: string,
  temperature: number,
) {
  return defineIntegrationObservationBatch(
    {
      schema: "aether.integration.observation-batch.v1alpha1",
      integrationId: "home-assistant:home",
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
  );
}

async function topologyInput(
  value: ReturnType<typeof topology>,
  requestId: string,
): Promise<IntegrationTopologyPersistenceInput> {
  const digestor = new NodeIntegrationPayloadDigestor();
  return {
    requestId,
    binding,
    topology: value,
    payloadDigest: await digestor.digest(value),
    receivedAt: parseUtcInstant("2026-07-17T06:00:00.000Z"),
  };
}

async function observationInput(
  value: ReturnType<typeof observations>,
  requestId: string,
): Promise<IntegrationObservationPersistenceInput> {
  const digestor = new NodeIntegrationPayloadDigestor();
  return {
    requestId,
    binding,
    batch: value,
    payloadDigest: await digestor.digest(value),
    receivedAt: parseUtcInstant("2026-07-17T06:01:00.000Z"),
  };
}

describe("integration projection memory adapter", () => {
  it("atomically fences an old signed session head before mutating business state", async () => {
    const sessionFenceVerifier = new MutableSessionFenceVerifier();
    const repository = new InMemoryIntegrationProjectionRepository({
      sessionFenceVerifier,
    });
    const firstDelivery = cloudLinkDelivery("1", "topology-1", "a");
    const first = await topologyInput(
      topology("1"),
      "signed-topology-session-1",
    );
    await expect(
      repository.persistTopology({
        ...first,
        cloudLinkDelivery: firstDelivery,
        cloudLinkSessionFence: sessionFence(firstDelivery),
      }),
    ).resolves.toMatchObject({ outcome: "persisted" });

    sessionFenceVerifier.currentSessionId = parseCloudLinkSessionId(
      "55555555-5555-4555-8555-555555555555",
    );
    const staleDelivery = cloudLinkDelivery("2", "topology-2", "b");
    await expect(
      repository.persistTopology({
        ...(await topologyInput(
          topology("2"),
          "signed-topology-session-1-after-fence",
        )),
        cloudLinkDelivery: staleDelivery,
        cloudLinkSessionFence: sessionFence(staleDelivery),
      }),
    ).resolves.toEqual({ outcome: "session-fenced" });

    await expect(
      repository.findCurrent({
        tenantId,
        projectId,
        gatewayId,
        integrationId: first.topology.integrationId,
      }),
    ).resolves.toMatchObject({
      topology: { snapshotGeneration: "1" },
      revision: 1,
    });
    expect(repository.auditEvents()).toHaveLength(1);
    expect(repository.pendingOutboxEvents()).toHaveLength(1);
  });

  it("rejects a CloudLink position gap before mutating the projection and advances only exact contiguous deliveries", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    const generation1 = await topologyInput(
      topology("1"),
      "cloudlink-topology-position-1",
    );
    const generation2 = await topologyInput(
      topology("2"),
      "cloudlink-topology-position-2",
    );

    await expect(
      repository.persistTopology({
        ...generation2,
        cloudLinkDelivery: cloudLinkDelivery("2", "topology-2", "c"),
      }),
    ).resolves.toEqual({ outcome: "delivery-gap" });
    expect(repository.auditEvents()).toEqual([]);
    expect(repository.pendingOutboxEvents()).toEqual([]);
    await expect(
      repository.findCurrent({
        tenantId,
        projectId,
        gatewayId,
        integrationId: generation2.topology.integrationId,
      }),
    ).resolves.toBeUndefined();

    const first = await repository.persistTopology({
      ...generation1,
      cloudLinkDelivery: cloudLinkDelivery("1", "topology-1", "b"),
    });
    expect(first).toMatchObject({
      outcome: "persisted",
      durableAcknowledgement: {
        acknowledgedPosition: "1",
        batchId: "topology-1",
        digest: `sha256:${"b".repeat(64)}`,
      },
    });

    const second = await repository.persistTopology({
      ...generation2,
      cloudLinkDelivery: cloudLinkDelivery("2", "topology-2", "c"),
    });
    expect(second).toMatchObject({
      outcome: "persisted",
      record: { topology: { snapshotGeneration: "2" } },
      durableAcknowledgement: { acknowledgedPosition: "2" },
    });
  });

  it("replays an exact CloudLink delivery into a new session without reapplying business effects", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    const input = await topologyInput(
      topology("1"),
      "cloudlink-topology-position-1",
    );
    const first = await repository.persistTopology({
      ...input,
      cloudLinkDelivery: cloudLinkDelivery("1", "topology-1", "b"),
    });
    const replay = await repository.persistTopology({
      ...input,
      cloudLinkDelivery: cloudLinkDelivery(
        "1",
        "topology-1",
        "b",
        "55555555-5555-4555-8555-555555555555",
      ),
    });

    expect(replay).toMatchObject({
      outcome: "replayed",
      durableAcknowledgement: {
        sessionId: "55555555-5555-4555-8555-555555555555",
        acknowledgedPosition: "1",
      },
    });
    if (first.outcome === "persisted" && replay.outcome === "replayed") {
      expect(replay.receipt).toEqual(first.receipt);
    }
    expect(repository.auditEvents()).toHaveLength(1);
    expect(repository.pendingOutboxEvents()).toHaveLength(1);

    await expect(
      repository.persistTopology({
        ...input,
        cloudLinkDelivery: cloudLinkDelivery("1", "topology-1", "d"),
      }),
    ).resolves.toEqual({ outcome: "delivery-conflict" });
  });

  it("atomically attaches a new CloudLink delivery to a topology that was already persisted", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    const firstInput = await topologyInput(
      topology("1"),
      "business-first-topology-1",
    );
    await repository.persistTopology(firstInput);

    const replay = await repository.persistTopology({
      ...firstInput,
      cloudLinkDelivery: cloudLinkDelivery("1", "topology-1", "a"),
    });

    expect(replay).toMatchObject({
      outcome: "replayed",
      durableAcknowledgement: {
        acknowledgedPosition: "1",
        batchId: "topology-1",
        digest: `sha256:${"a".repeat(64)}`,
      },
    });
    expect(repository.auditEvents()).toHaveLength(1);
    expect(repository.pendingOutboxEvents()).toHaveLength(1);

    await expect(
      repository.persistTopology({
        ...(await topologyInput(topology("2"), "cloudlink-topology-2")),
        cloudLinkDelivery: cloudLinkDelivery("2", "topology-2", "b"),
      }),
    ).resolves.toMatchObject({
      outcome: "persisted",
      durableAcknowledgement: { acknowledgedPosition: "2" },
    });
  });

  it("atomically attaches a new CloudLink delivery to observations that were already persisted", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    const currentTopology = topology("1");
    await repository.persistTopology(
      await topologyInput(currentTopology, "business-first-topology"),
    );
    const firstInput = await observationInput(
      observations(currentTopology, "ha-event-1", "1784268000100", 21),
      "business-first-observation-1",
    );
    await repository.persistObservations(firstInput);

    const replay = await repository.persistObservations({
      ...firstInput,
      cloudLinkDelivery: observationCloudLinkDelivery("1", "ha-event-1", "c"),
    });

    expect(replay).toMatchObject({
      outcome: "replayed",
      durableAcknowledgement: {
        acknowledgedPosition: "1",
        batchId: "ha-event-1",
        digest: `sha256:${"c".repeat(64)}`,
      },
    });
    expect(repository.auditEvents()).toHaveLength(2);
    expect(repository.pendingOutboxEvents()).toHaveLength(2);

    const secondInput = await observationInput(
      observations(currentTopology, "ha-event-2", "1784268000200", 22),
      "cloudlink-observation-2",
    );
    await expect(
      repository.persistObservations({
        ...secondInput,
        cloudLinkDelivery: observationCloudLinkDelivery("2", "ha-event-2", "d"),
      }),
    ).resolves.toMatchObject({
      outcome: "persisted",
      durableAcknowledgement: { acknowledgedPosition: "2" },
    });
  });

  it("persists one topology atomically and replays identical requests once", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    const input = await topologyInput(topology("12"), "topology-request-001");

    const first = await repository.persistTopology(input);
    const replay = await repository.persistTopology(input);

    expect(first).toMatchObject({
      outcome: "persisted",
      record: {
        topology: { snapshotGeneration: "12" },
        latestObservations: [],
        revision: 1,
      },
    });
    expect(replay).toMatchObject(
      first.outcome === "persisted"
        ? {
            outcome: "replayed",
            record: first.record,
            receipt: first.receipt,
          }
        : {},
    );
    expect(repository.auditEvents()).toHaveLength(1);
    expect(repository.pendingOutboxEvents()).toHaveLength(1);
    expect(repository.auditEvents()[0]?.eventId).not.toContain("\u0000");
    if (first.outcome === "persisted") {
      expect(repository.auditEvents()[0]).toMatchObject({
        ...first.receipt,
        eventId: first.receipt.auditEventId,
        eventName: "integration.topology-reported.v1",
      });
      expect(repository.pendingOutboxEvents()[0]).toMatchObject({
        ...first.receipt,
        eventId: first.receipt.outboxEventId,
        eventName: "integration.projection-topology-changed.v1",
      });
    }
  });

  it("rejects idempotency reuse, same-generation conflict, and stale topology", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    const original = await topologyInput(
      topology("12"),
      "topology-request-001",
    );
    await repository.persistTopology(original);

    expect(
      await repository.persistTopology({
        ...(await topologyInput(topology("13"), "topology-request-001")),
      }),
    ).toEqual({ outcome: "idempotency-conflict" });
    expect(
      await repository.persistTopology(
        await topologyInput(
          topology("12", "Changed at same generation"),
          "topology-request-002",
        ),
      ),
    ).toEqual({ outcome: "generation-conflict" });
    expect(
      await repository.persistTopology(
        await topologyInput(topology("11"), "topology-request-003"),
      ),
    ).toEqual({ outcome: "stale-generation" });
  });

  it("never replays an obsolete topology after a newer generation is current", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    const generation12 = await topologyInput(
      topology("12"),
      "topology-request-012",
    );
    await repository.persistTopology(generation12);
    await repository.persistTopology(
      await topologyInput(topology("13"), "topology-request-013"),
    );

    expect(await repository.persistTopology(generation12)).toEqual({
      outcome: "stale-generation",
    });
    expect(
      await repository.persistTopology(
        await topologyInput(topology("12"), "topology-request-014"),
      ),
    ).toEqual({ outcome: "stale-generation" });
    expect(
      await repository.findCurrent({
        tenantId,
        projectId,
        gatewayId,
        integrationId: topology("13").integrationId,
      }),
    ).toMatchObject({
      topology: { snapshotGeneration: "13" },
    });
  });

  it("does not let one integration identity change provider kind", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    await repository.persistTopology(
      await topologyInput(topology("12"), "topology-request-012"),
    );
    const changedKind = defineIntegrationTopologySnapshot({
      ...topology("13"),
      integrationKind: "different-provider",
    });

    expect(
      await repository.persistTopology(
        await topologyInput(changedKind, "topology-request-013"),
      ),
    ).toEqual({ outcome: "generation-conflict" });
  });

  it("updates latest observations and ignores older values without losing the accepted batch", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    const currentTopology = topology("12");
    await repository.persistTopology(
      await topologyInput(currentTopology, "topology-request-001"),
    );
    const newer = await repository.persistObservations(
      await observationInput(
        observations(currentTopology, "ha-event-002", "1784268000200", 22),
        "observation-request-002",
      ),
    );
    const older = await repository.persistObservations(
      await observationInput(
        observations(currentTopology, "ha-event-001", "1784268000100", 20),
        "observation-request-001",
      ),
    );

    expect(newer).toMatchObject({
      outcome: "persisted",
      record: {
        latestObservations: [{ value: { type: "float64", value: 22 } }],
        revision: 2,
      },
    });
    expect(older).toMatchObject({
      outcome: "persisted",
      record: {
        latestObservations: [{ value: { type: "float64", value: 22 } }],
        revision: 3,
      },
    });
    expect(repository.auditEvents()).toHaveLength(3);
  });

  it("accepts repeated point observations and projects the newest timestamp deterministically", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    const currentTopology = topology("12");
    await repository.persistTopology(
      await topologyInput(currentTopology, "topology-request-012"),
    );
    const repeated = defineIntegrationObservationBatch(
      {
        schema: "aether.integration.observation-batch.v1alpha1",
        integrationId: currentTopology.integrationId,
        snapshotGeneration: currentTopology.snapshotGeneration,
        batchId: "ha-event-repeated",
        observedAtMs: "1784268000200",
        observations: [
          {
            entityId: "entity-registry:climate-kitchen",
            pointKey: "current_temperature",
            observedAtMs: "1784268000200",
            quality: "good",
            value: { type: "float64", value: 22 },
          },
          {
            entityId: "entity-registry:climate-kitchen",
            pointKey: "current_temperature",
            observedAtMs: "1784268000100",
            quality: "good",
            value: { type: "float64", value: 21 },
          },
        ],
      },
      currentTopology,
    );

    expect(
      await repository.persistObservations(
        await observationInput(repeated, "observation-request-repeated"),
      ),
    ).toMatchObject({
      outcome: "persisted",
      record: {
        latestObservations: [
          {
            observedAtMs: "1784268000200",
            value: { type: "float64", value: 22 },
          },
        ],
      },
    });
  });

  it("fences observations by topology generation and batch identity", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    const generation12 = topology("12");
    await repository.persistTopology(
      await topologyInput(generation12, "topology-request-001"),
    );
    const batch = observations(
      generation12,
      "ha-event-001",
      "1784268000100",
      21.5,
    );
    const input = await observationInput(batch, "observation-request-001");
    const first = await repository.persistObservations(input);

    expect(await repository.persistObservations(input)).toMatchObject(
      first.outcome === "persisted"
        ? {
            outcome: "replayed",
            record: first.record,
            receipt: first.receipt,
          }
        : {},
    );
    expect(
      await repository.persistObservations({
        ...(await observationInput(
          observations(generation12, "ha-event-001", "1784268000100", 99),
          "observation-request-002",
        )),
      }),
    ).toEqual({ outcome: "batch-conflict" });

    const generation13 = topology("13");
    await repository.persistTopology(
      await topologyInput(generation13, "topology-request-013"),
    );
    expect(
      await repository.persistObservations(
        await observationInput(batch, "observation-request-003"),
      ),
    ).toEqual({ outcome: "generation-conflict" });
    expect(
      await repository.persistObservations(
        await observationInput(
          observations(generation13, "ha-event-001", "1784268000300", 23),
          "observation-request-013",
        ),
      ),
    ).toMatchObject({
      outcome: "persisted",
      record: {
        topology: { snapshotGeneration: "13" },
        latestObservations: [{ value: { type: "float64", value: 23 } }],
      },
    });
  });

  it("replays an older accepted batch with its receipt and the current projection", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    const currentTopology = topology("12");
    await repository.persistTopology(
      await topologyInput(currentTopology, "topology-request-012"),
    );
    const batchA = await observationInput(
      observations(currentTopology, "ha-event-001", "1784268000100", 21),
      "observation-request-001",
    );
    const acceptedA = await repository.persistObservations(batchA);
    await repository.persistObservations(
      await observationInput(
        observations(currentTopology, "ha-event-002", "1784268000200", 22),
        "observation-request-002",
      ),
    );

    const replay = await repository.persistObservations(batchA);

    expect(acceptedA).toMatchObject({
      outcome: "persisted",
      receipt: {
        requestId: "observation-request-001",
        batchId: "ha-event-001",
      },
    });
    expect(replay).toMatchObject({
      outcome: "replayed",
      record: {
        latestObservations: [{ value: { type: "float64", value: 22 } }],
        revision: 3,
      },
      receipt: {
        requestId: "observation-request-001",
        batchId: "ha-event-001",
      },
    });
    if (acceptedA.outcome === "persisted" && replay.outcome === "replayed") {
      expect(replay.receipt).toEqual(acceptedA.receipt);
    }
    expect(repository.auditEvents()).toHaveLength(3);
    expect(repository.pendingOutboxEvents()).toHaveLength(3);
  });

  it("clears observations on a newer complete topology and isolates tenant scope", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    const generation12 = topology("12");
    await repository.persistTopology(
      await topologyInput(generation12, "topology-request-012"),
    );
    await repository.persistObservations(
      await observationInput(
        observations(generation12, "ha-event-001", "1784268000100", 21.5),
        "observation-request-001",
      ),
    );
    const replacement = await repository.persistTopology(
      await topologyInput(topology("13"), "topology-request-013"),
    );

    expect(replacement).toMatchObject({
      outcome: "persisted",
      record: {
        topology: { snapshotGeneration: "13" },
        latestObservations: [],
        revision: 3,
      },
    });
    expect(
      await repository.findCurrent({
        tenantId: parseTenantId("99999999-9999-4999-8999-999999999999"),
        projectId,
        gatewayId,
        integrationId:
          replacement.outcome === "persisted"
            ? replacement.record.integrationId
            : generation12.integrationId,
      }),
    ).toBeUndefined();
  });

  it("returns an immutable topology history record", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    const currentTopology = topology("12");
    await repository.persistTopology(
      await topologyInput(currentTopology, "topology-history-012"),
    );

    const historical = await repository.findTopology(
      {
        tenantId,
        projectId,
        gatewayId,
        integrationId: currentTopology.integrationId,
      },
      currentTopology.snapshotGeneration,
    );

    expect(historical).toMatchObject({
      topology: { snapshotGeneration: "12" },
      revision: 1,
    });
    expect(Object.isFrozen(historical)).toBe(true);
  });

  it("fails atomically when storage is unavailable", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    repository.failNextPersistence();

    expect(
      await repository.persistTopology(
        await topologyInput(topology("12"), "topology-request-001"),
      ),
    ).toEqual({ outcome: "storage-unavailable" });
    expect(repository.auditEvents()).toEqual([]);
    expect(repository.pendingOutboxEvents()).toEqual([]);
  });

  it("does not partially change projection, inbox, audit, or outbox on failure", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    const currentTopology = topology("12");
    await repository.persistTopology(
      await topologyInput(currentTopology, "topology-request-012"),
    );
    const before = await repository.findCurrent({
      tenantId,
      projectId,
      gatewayId,
      integrationId: currentTopology.integrationId,
    });
    repository.failNextPersistence();

    expect(
      await repository.persistObservations(
        await observationInput(
          observations(currentTopology, "ha-event-failed", "1784268000100", 99),
          "observation-request-failed",
        ),
      ),
    ).toEqual({ outcome: "storage-unavailable" });
    expect(
      await repository.findCurrent({
        tenantId,
        projectId,
        gatewayId,
        integrationId: currentTopology.integrationId,
      }),
    ).toBe(before);
    expect(repository.auditEvents()).toHaveLength(1);
    expect(repository.pendingOutboxEvents()).toHaveLength(1);
  });

  it("digests canonical content deterministically", async () => {
    const digestor = new NodeIntegrationPayloadDigestor();

    expect(await digestor.digest(topology("12"))).toBe(
      await digestor.digest(topology("12")),
    );
    expect(await digestor.digest(topology("12"))).not.toBe(
      await digestor.digest(topology("13")),
    );
  });
});
