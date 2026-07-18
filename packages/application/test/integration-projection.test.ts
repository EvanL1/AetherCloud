import { describe, expect, it } from "vitest";

import {
  AuthenticateGatewaySignedCloudLinkUplink,
  GET_INTEGRATION_PROJECTION_QUERY,
  GetIntegrationProjection,
  REPORT_INTEGRATION_OBSERVATIONS_COMMAND,
  REPORT_INTEGRATION_TOPOLOGY_COMMAND,
  ReportIntegrationObservations,
  ReportIntegrationTopology,
  type ApplicationClock,
  type CloudLinkBusinessPayloadDigestor,
  type GatewayCredentialVerificationResult,
  type GatewayCredentialVerifier,
  type IntegrationPayloadDigestor,
  type IntegrationProjectionRecord,
  type IntegrationProjectionRepository,
  type IntegrationProjectionScope,
  type IntegrationTopologyPersistenceInput,
  type IntegrationTopologyPersistenceResult,
  type IntegrationObservationPersistenceInput,
  type IntegrationObservationPersistenceReceipt,
  type IntegrationObservationPersistenceResult,
  type IntegrationCloudLinkDelivery,
  type IntegrationCloudLinkDurableAcknowledgement,
  type IntegrationTopologyPersistenceReceipt,
  type IntegrationTopologyHistoryRecord,
} from "../src/index.js";
import {
  defineIntegrationTopologySnapshot,
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseProtocolVersion,
  parseTenantId,
  parseUtcInstant,
  type GatewayCredentialBinding,
  type CloudLinkSession,
} from "@aether-cloud/domain";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");

function binding(
  status: GatewayCredentialBinding["status"] = "active",
  generation = "3",
): GatewayCredentialBinding {
  return {
    tenantId,
    projectId,
    gatewayId,
    generation: parseGatewayCredentialGeneration(generation),
    status,
  };
}

class FixedClock implements ApplicationClock {
  now() {
    return parseUtcInstant("2026-07-17T06:00:00.000Z");
  }
}

class StubVerifier implements GatewayCredentialVerifier {
  readonly #result: GatewayCredentialVerificationResult;
  calls = 0;

  constructor(
    result: GatewayCredentialVerificationResult = {
      ok: true,
      value: binding(),
    },
  ) {
    this.#result = result;
  }

  verify(): Promise<GatewayCredentialVerificationResult> {
    this.calls += 1;
    return Promise.resolve(this.#result);
  }
}

class StubDigestor implements IntegrationPayloadDigestor {
  calls = 0;

  digest(): Promise<string> {
    this.calls += 1;
    return Promise.resolve("a".repeat(64));
  }
}

class StubBusinessPayloadDigestor implements CloudLinkBusinessPayloadDigestor {
  calls: unknown[] = [];
  result: string;

  constructor(result: string) {
    this.result = result;
  }

  digest(input: unknown): Promise<string> {
    this.calls.push(input);
    return Promise.resolve(this.result);
  }
}

class StubRepository implements IntegrationProjectionRepository {
  topologyInput: IntegrationTopologyPersistenceInput | undefined;
  observationInput: IntegrationObservationPersistenceInput | undefined;
  record: IntegrationProjectionRecord | undefined;
  topologyResult: IntegrationTopologyPersistenceResult | undefined;
  observationResult: IntegrationObservationPersistenceResult | undefined;
  historicalTopology: IntegrationTopologyHistoryRecord | undefined;

  persistTopology(
    input: IntegrationTopologyPersistenceInput,
  ): Promise<IntegrationTopologyPersistenceResult> {
    this.topologyInput = input;
    const record: IntegrationProjectionRecord = {
      tenantId: input.binding.tenantId,
      projectId: input.binding.projectId,
      gatewayId: input.binding.gatewayId,
      integrationId: input.topology.integrationId,
      topology: input.topology,
      topologyDigest: input.payloadDigest,
      latestObservations: [],
      receivedAt: input.receivedAt,
      revision: 1,
    };
    this.record = record;
    const receipt: IntegrationTopologyPersistenceReceipt = {
      kind: "topology",
      tenantId: input.binding.tenantId,
      projectId: input.binding.projectId,
      gatewayId: input.binding.gatewayId,
      integrationId: input.topology.integrationId,
      credentialGeneration: input.binding.generation,
      requestId: input.requestId,
      payloadDigest: input.payloadDigest,
      snapshotGeneration: input.topology.snapshotGeneration,
      revision: record.revision,
      auditEventId: "audit:integration-topology:test0001",
      outboxEventId: "outbox:integration-topology:test0001",
      committedAt: input.receivedAt,
    };
    return Promise.resolve(
      this.topologyResult ?? {
        outcome: "persisted",
        record,
        receipt,
      },
    );
  }

  persistObservations(
    input: IntegrationObservationPersistenceInput,
  ): Promise<IntegrationObservationPersistenceResult> {
    this.observationInput = input;
    if (this.record === undefined) {
      return Promise.resolve({ outcome: "topology-required" });
    }
    const record: IntegrationProjectionRecord = {
      ...this.record,
      latestObservations: input.batch.observations,
      receivedAt: input.receivedAt,
      revision: this.record.revision + 1,
    };
    this.record = record;
    const receipt: IntegrationObservationPersistenceReceipt = {
      kind: "observations",
      tenantId: input.binding.tenantId,
      projectId: input.binding.projectId,
      gatewayId: input.binding.gatewayId,
      integrationId: input.batch.integrationId,
      credentialGeneration: input.binding.generation,
      requestId: input.requestId,
      payloadDigest: input.payloadDigest,
      snapshotGeneration: input.batch.snapshotGeneration,
      batchId: input.batch.batchId,
      revision: record.revision,
      auditEventId: "audit:integration-observations:test0001",
      outboxEventId: "outbox:integration-observations:test0001",
      committedAt: input.receivedAt,
    };
    return Promise.resolve(
      this.observationResult ?? {
        outcome: "persisted",
        record,
        receipt,
      },
    );
  }

  findCurrent(
    scope: IntegrationProjectionScope,
  ): Promise<IntegrationProjectionRecord | undefined> {
    if (
      this.record?.tenantId !== scope.tenantId ||
      this.record.projectId !== scope.projectId ||
      this.record.gatewayId !== scope.gatewayId ||
      this.record.integrationId !== scope.integrationId
    ) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(this.record);
  }

  findTopology(
    scope: IntegrationProjectionScope,
    snapshotGeneration: IntegrationTopologyHistoryRecord["topology"]["snapshotGeneration"],
  ): Promise<IntegrationTopologyHistoryRecord | undefined> {
    if (
      this.historicalTopology?.tenantId === scope.tenantId &&
      this.historicalTopology.projectId === scope.projectId &&
      this.historicalTopology.gatewayId === scope.gatewayId &&
      this.historicalTopology.integrationId === scope.integrationId &&
      this.historicalTopology.topology.snapshotGeneration === snapshotGeneration
    ) {
      return Promise.resolve(this.historicalTopology);
    }
    if (
      this.record === undefined ||
      this.record.tenantId !== scope.tenantId ||
      this.record.projectId !== scope.projectId ||
      this.record.gatewayId !== scope.gatewayId ||
      this.record.integrationId !== scope.integrationId ||
      this.record.topology.snapshotGeneration !== snapshotGeneration
    ) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      tenantId: this.record.tenantId,
      projectId: this.record.projectId,
      gatewayId: this.record.gatewayId,
      integrationId: this.record.integrationId,
      topology: this.record.topology,
      topologyDigest: this.record.topologyDigest,
      receivedAt: this.record.receivedAt,
      revision: this.record.revision,
    });
  }
}

const commandContext = {
  idempotencyKey: "integration-report-0001",
  issuedAt: "2026-07-17T05:55:00.000Z",
  expiresAt: "2026-07-17T06:05:00.000Z",
};
const credential = {
  credentialId: "gateway-credential-003",
  proof: "opaque-test-proof",
};
const cloudLinkTopologyDelivery = {
  sessionId: "44444444-4444-4444-8444-444444444444",
  sessionEpoch: "7",
  credentialGeneration: "3",
  streamId: "integration-topology-ha-home",
  streamEpoch: "9",
  position: "12",
  batchId: "topology-12",
  digest: `sha256:${"b".repeat(64)}`,
  messageKind: "integration-topology-snapshot",
} as const;
const cloudLinkObservationDelivery = {
  sessionId: "44444444-4444-4444-8444-444444444444",
  sessionEpoch: "7",
  credentialGeneration: "3",
  streamId: "integration-observations-ha-home",
  streamEpoch: "9",
  position: "1",
  batchId: "ha-event-old",
  digest: `sha256:${"c".repeat(64)}`,
  messageKind: "integration-observation-batch",
} as const;

async function authenticateGatewaySignedDelivery(input: {
  readonly sessionId: string;
  readonly sessionEpoch: string;
  readonly credentialGeneration: string;
  readonly sentAtMs: string;
  readonly expiresAtMs?: string | null;
  readonly streamId: string;
  readonly streamEpoch: string;
  readonly position: string;
  readonly batchId: string;
  readonly digest: string;
  readonly messageKind:
    | "integration-observation-batch"
    | "integration-topology-snapshot";
}) {
  const session: CloudLinkSession = {
    tenantId,
    projectId,
    gatewayId,
    sessionId: parseCloudLinkSessionId(input.sessionId),
    credentialGeneration: parseGatewayCredentialGeneration(
      input.credentialGeneration,
    ),
    epoch: parseCloudLinkSessionEpoch(input.sessionEpoch),
    state: "active",
    protocolVersion: parseProtocolVersion("1.0"),
    openedAt: parseUtcInstant("2026-07-17T05:59:00.000Z"),
    activatedAt: parseUtcInstant("2026-07-17T05:59:01.000Z"),
    resumeCursors: [],
    revision: 1,
    gatewayKeyId: "gateway-session-key-17",
    heartbeatIntervalMs: "30000",
  };
  const result = await new AuthenticateGatewaySignedCloudLinkUplink({
    sessions: {
      findCurrent: () => Promise.resolve(session),
    },
    repository: {
      acceptHeartbeat: () => Promise.resolve({ outcome: "accepted" }),
    },
    verifier: {
      verify: () =>
        Promise.resolve({
          gatewayKeyActive: true,
          signatureVerified: true,
          signingObjectDigest: `sha256:${"d".repeat(64)}`,
        }),
    },
    clock: {
      nowMilliseconds: () => input.sentAtMs,
    },
    enabled: true,
  }).execute({
    tenantId,
    projectId,
    gatewayId,
    sessionId: input.sessionId,
    sessionEpoch: input.sessionEpoch,
    credentialGeneration: input.credentialGeneration,
    messageKind: input.messageKind,
    sentAtMs: input.sentAtMs,
    ...(typeof input.expiresAtMs !== "string"
      ? {}
      : { expiresAtMs: input.expiresAtMs }),
    delivery: {
      streamId: input.streamId,
      streamEpoch: input.streamEpoch,
      position: input.position,
      batchId: input.batchId,
      digest: input.digest,
    },
    messageAuthentication: {
      keyId: "gateway-session-key-17",
      algorithm: "Ed25519",
      signature: "A".repeat(86),
    },
  });
  if (!result.ok) {
    throw new Error(
      `test delivery did not authenticate: ${result.failure.code}`,
    );
  }
  return result.value;
}
const topologyInput = {
  credential,
  schema: "aether.integration.topology-snapshot.v1alpha1",
  integrationId: "home-assistant:home",
  integrationKind: "home-assistant",
  snapshotGeneration: "12",
  observedAtMs: "1784268000000",
  areas: [{ areaId: "area:kitchen", name: "Kitchen" }],
  devices: [
    {
      deviceId: "device:thermostat",
      name: "Kitchen thermostat",
      areaId: "area:kitchen",
      manufacturer: "Example",
      model: "Thermostat 1",
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
} as const;

const wireTopologyPayload = {
  schema: topologyInput.schema,
  integration_id: topologyInput.integrationId,
  integration_kind: topologyInput.integrationKind,
  snapshot_generation: topologyInput.snapshotGeneration,
  observed_at_ms: topologyInput.observedAtMs,
  areas: topologyInput.areas.map((area) => ({
    area_id: area.areaId,
    name: area.name,
  })),
  devices: topologyInput.devices.map((device) => ({
    device_id: device.deviceId,
    name: device.name,
    area_id: device.areaId,
    manufacturer: device.manufacturer,
    model: device.model,
  })),
  entities: topologyInput.entities.map((entity) => ({
    entity_id: entity.entityId,
    source_address: entity.sourceAddress,
    name: entity.name,
    entity_kind: entity.entityKind,
    device_id: entity.deviceId,
    area_id: entity.areaId,
    points: entity.points.map((point) => ({
      point_key: point.pointKey,
      title: point.title,
      kind: point.kind,
      value_type: point.valueType,
      ...("unit" in point ? { unit: point.unit } : {}),
    })),
  })),
} as const;

function topologyRecord(): IntegrationProjectionRecord {
  const topology = defineIntegrationTopologySnapshot(topologyInput);
  return {
    tenantId,
    projectId,
    gatewayId,
    integrationId: topology.integrationId,
    topology,
    topologyDigest: "a".repeat(64),
    latestObservations: [],
    receivedAt: parseUtcInstant("2026-07-17T06:00:00.000Z"),
    revision: 1,
  };
}

function topologyReceiptFor(
  record: IntegrationProjectionRecord,
): IntegrationTopologyPersistenceReceipt {
  return {
    kind: "topology",
    tenantId: record.tenantId,
    projectId: record.projectId,
    gatewayId: record.gatewayId,
    integrationId: record.integrationId,
    credentialGeneration: binding().generation,
    requestId: commandContext.idempotencyKey,
    payloadDigest: record.topologyDigest,
    snapshotGeneration: record.topology.snapshotGeneration,
    revision: record.revision,
    auditEventId: "audit:integration-topology:test0001",
    outboxEventId: "outbox:integration-topology:test0001",
    committedAt: record.receivedAt,
  };
}

function observationReceiptFor(
  record: IntegrationProjectionRecord,
  batchId = "ha-event-0001",
): IntegrationObservationPersistenceReceipt {
  return {
    kind: "observations",
    tenantId: record.tenantId,
    projectId: record.projectId,
    gatewayId: record.gatewayId,
    integrationId: record.integrationId,
    credentialGeneration: binding().generation,
    requestId: commandContext.idempotencyKey,
    payloadDigest: "a".repeat(64),
    snapshotGeneration: record.topology.snapshotGeneration,
    batchId: batchId as IntegrationObservationPersistenceReceipt["batchId"],
    revision: record.revision,
    auditEventId: "audit:integration-observations:test0001",
    outboxEventId: "outbox:integration-observations:test0001",
    committedAt: record.receivedAt,
  };
}

function durableAcknowledgementFor(
  delivery: IntegrationCloudLinkDelivery,
  acknowledgedPosition = delivery.position,
): IntegrationCloudLinkDurableAcknowledgement {
  return {
    outboxEventId: "outbox:cloudlink-ack:test0001",
    receiptId: "receipt:cloudlink-ack:test0001",
    tenantId,
    projectId,
    gatewayId,
    integrationId: topologyRecord().integrationId,
    sessionId: delivery.sessionId,
    sessionEpoch: delivery.sessionEpoch,
    credentialGeneration: delivery.credentialGeneration,
    streamId: delivery.streamId,
    streamEpoch: delivery.streamEpoch,
    acknowledgedPosition,
    batchId: delivery.batchId,
    digest: delivery.digest,
    messageKind: delivery.messageKind,
    acknowledgedAt: parseUtcInstant("2026-07-17T06:00:00.000Z"),
  };
}

describe("integration projection application", () => {
  it("reports an authenticated edge topology without granting cloud authority", async () => {
    const repository = new StubRepository();
    const verifier = new StubVerifier();
    const digestor = new StubDigestor();
    const useCase = new ReportIntegrationTopology({
      repository,
      verifier,
      digestor,
      clock: new FixedClock(),
    });

    const result = await useCase.execute(commandContext, topologyInput);

    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        disposition: "persisted",
        receipt: {
          auditEventId: "audit:integration-topology:test0001",
          outboxEventId: "outbox:integration-topology:test0001",
        },
        projection: {
          authority: "edge-reported-copy",
          liveStateAuthoritative: false,
          gatewayId,
          revision: 1,
        },
      },
    });
    expect(repository.topologyInput?.topology.entities[0]?.points).toHaveLength(
      2,
    );
    expect(verifier.calls).toBe(1);
    expect(digestor.calls).toBe(2);
  });

  it("consumes the opaque Gateway-signed capability for topology and observations without a second credential model", async () => {
    const signedTopologyDelivery = {
      ...cloudLinkTopologyDelivery,
      sentAtMs: "1784268000000",
      expiresAtMs: null,
    } as const;
    const topologyFact = await authenticateGatewaySignedDelivery(
      signedTopologyDelivery,
    );
    const topologyRepository = new StubRepository();
    const topologyVerifier = new StubVerifier();
    const topologyUseCase = new ReportIntegrationTopology({
      repository: topologyRepository,
      verifier: topologyVerifier,
      digestor: new StubDigestor(),
      businessPayloadDigestor: new StubBusinessPayloadDigestor(
        signedTopologyDelivery.digest,
      ),
      clock: new FixedClock(),
    });
    await expect(
      topologyUseCase.execute(commandContext, {
        gatewaySignedAuthentication: topologyFact,
        cloudLinkDelivery: signedTopologyDelivery,
        cloudLinkPayload: wireTopologyPayload,
      }),
    ).resolves.toMatchObject({ ok: true, replayed: false });
    expect(topologyVerifier.calls).toBe(0);
    expect(topologyRepository.topologyInput?.cloudLinkSessionFence).toEqual({
      tenantId,
      projectId,
      gatewayId,
      sessionId: signedTopologyDelivery.sessionId,
      sessionEpoch: signedTopologyDelivery.sessionEpoch,
      sessionRevision: 1,
      credentialGeneration: signedTopologyDelivery.credentialGeneration,
      gatewayKeyId: "gateway-session-key-17",
    });

    const signedObservationDelivery = {
      ...cloudLinkObservationDelivery,
      batchId: "ha-event-0001",
      sentAtMs: "1784268000100",
      expiresAtMs: null,
    } as const;
    const observationFact = await authenticateGatewaySignedDelivery(
      signedObservationDelivery,
    );
    const observationRepository = new StubRepository();
    observationRepository.record = topologyRecord();
    const observationVerifier = new StubVerifier();
    const observationUseCase = new ReportIntegrationObservations({
      repository: observationRepository,
      verifier: observationVerifier,
      digestor: new StubDigestor(),
      businessPayloadDigestor: new StubBusinessPayloadDigestor(
        signedObservationDelivery.digest,
      ),
      clock: new FixedClock(),
    });
    const observationPayload = {
      schema: "aether.integration.observation-batch.v1alpha1",
      integrationId: "home-assistant:home",
      snapshotGeneration: "12",
      batchId: "ha-event-0001",
      observedAtMs: "1784268000100",
      observations: [
        {
          entityId: "entity-registry:climate-kitchen",
          pointKey: "current_temperature",
          observedAtMs: "1784268000100",
          quality: "good",
          value: { type: "float64", value: 21.5 },
        },
      ],
    } as const;
    const wireObservationPayload = {
      schema: observationPayload.schema,
      integration_id: observationPayload.integrationId,
      snapshot_generation: observationPayload.snapshotGeneration,
      batch_id: observationPayload.batchId,
      observed_at_ms: observationPayload.observedAtMs,
      observations: observationPayload.observations.map((observation) => ({
        entity_id: observation.entityId,
        point_key: observation.pointKey,
        observed_at_ms: observation.observedAtMs,
        quality: observation.quality,
        value: observation.value,
      })),
    } as const;
    await expect(
      observationUseCase.execute(commandContext, {
        gatewaySignedAuthentication: observationFact,
        cloudLinkDelivery: signedObservationDelivery,
        cloudLinkPayload: wireObservationPayload,
      }),
    ).resolves.toMatchObject({ ok: true, replayed: false });
    expect(observationVerifier.calls).toBe(0);
    expect(
      observationRepository.observationInput?.cloudLinkSessionFence,
    ).toMatchObject({
      sessionId: signedObservationDelivery.sessionId,
      sessionEpoch: signedObservationDelivery.sessionEpoch,
      sessionRevision: 1,
      credentialGeneration: signedObservationDelivery.credentialGeneration,
    });

    await expect(
      observationUseCase.execute(commandContext, {
        gatewaySignedAuthentication: { ...observationFact },
        cloudLinkDelivery: signedObservationDelivery,
        cloudLinkPayload: wireObservationPayload,
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
    await expect(
      observationUseCase.execute(commandContext, {
        gatewaySignedAuthentication: observationFact,
        cloudLinkDelivery: {
          ...signedObservationDelivery,
          position: "2",
        },
        cloudLinkPayload: wireObservationPayload,
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
    expect(observationRepository.observationInput?.cloudLinkDelivery).toEqual(
      signedObservationDelivery,
    );
  });

  it("does not persist or acknowledge a Gateway-signed payload with a mismatched digest or consumption-time expiry", async () => {
    const baseDelivery = {
      ...cloudLinkTopologyDelivery,
      sentAtMs: "1784267999000",
      expiresAtMs: null,
    } as const;
    const digestFact = await authenticateGatewaySignedDelivery(baseDelivery);
    const digestRepository = new StubRepository();
    const digestUseCase = new ReportIntegrationTopology({
      repository: digestRepository,
      verifier: new StubVerifier(),
      digestor: new StubDigestor(),
      businessPayloadDigestor: new StubBusinessPayloadDigestor(
        `sha256:${"c".repeat(64)}`,
      ),
      clock: new FixedClock(),
    });

    const digestResult = await digestUseCase.execute(commandContext, {
      gatewaySignedAuthentication: digestFact,
      cloudLinkDelivery: baseDelivery,
      cloudLinkPayload: wireTopologyPayload,
    });
    expect(digestResult).toMatchObject({
      ok: false,
      failure: { code: "gateway-signed-authentication-invalid" },
    });
    expect(digestRepository.topologyInput).toBeUndefined();
    expect(digestResult).not.toHaveProperty("durableAcknowledgement");

    const expiringDelivery = {
      ...baseDelivery,
      expiresAtMs: "1784268000000",
    } as const;
    const expiringFact =
      await authenticateGatewaySignedDelivery(expiringDelivery);
    const expiryRepository = new StubRepository();
    const expiryUseCase = new ReportIntegrationTopology({
      repository: expiryRepository,
      verifier: new StubVerifier(),
      digestor: new StubDigestor(),
      businessPayloadDigestor: new StubBusinessPayloadDigestor(
        expiringDelivery.digest,
      ),
      clock: new FixedClock(),
    });

    const expiryResult = await expiryUseCase.execute(commandContext, {
      gatewaySignedAuthentication: expiringFact,
      cloudLinkDelivery: expiringDelivery,
      cloudLinkPayload: wireTopologyPayload,
    });
    expect(expiryResult).toMatchObject({
      ok: false,
      failure: { code: "gateway-signed-authentication-invalid" },
    });
    expect(expiryRepository.topologyInput).toBeUndefined();
    expect(expiryResult).not.toHaveProperty("durableAcknowledgement");
  });

  it("fails closed when the atomic persistence boundary reports that the signed session was fenced", async () => {
    const signedDelivery = {
      ...cloudLinkTopologyDelivery,
      sentAtMs: "1784268000000",
      expiresAtMs: null,
    } as const;
    const fact = await authenticateGatewaySignedDelivery(signedDelivery);
    const repository = new StubRepository();
    repository.topologyResult = { outcome: "session-fenced" };
    const useCase = new ReportIntegrationTopology({
      repository,
      verifier: new StubVerifier(),
      digestor: new StubDigestor(),
      businessPayloadDigestor: new StubBusinessPayloadDigestor(
        signedDelivery.digest,
      ),
      clock: new FixedClock(),
    });
    await expect(
      useCase.execute(commandContext, {
        gatewaySignedAuthentication: fact,
        cloudLinkDelivery: signedDelivery,
        cloudLinkPayload: wireTopologyPayload,
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "integration-session-fenced" },
    });
  });

  it("passes CloudLink delivery evidence into the same persistence call and returns only a validated durable ACK", async () => {
    const repository = new StubRepository();
    const useCase = new ReportIntegrationTopology({
      repository,
      verifier: new StubVerifier(),
      digestor: new StubDigestor(),
      clock: new FixedClock(),
    });
    const originalPersist = repository.persistTopology.bind(repository);
    repository.persistTopology = async (input) => {
      const persisted = await originalPersist(input);
      if (
        persisted.outcome !== "persisted" &&
        persisted.outcome !== "replayed"
      ) {
        return persisted;
      }
      return {
        ...persisted,
        durableAcknowledgement: durableAcknowledgementFor(
          input.cloudLinkDelivery as IntegrationCloudLinkDelivery,
        ),
      };
    };

    const result = await useCase.execute(commandContext, {
      ...topologyInput,
      cloudLinkDelivery: cloudLinkTopologyDelivery,
    });

    expect(repository.topologyInput?.cloudLinkDelivery).toEqual(
      cloudLinkTopologyDelivery,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        durableAcknowledgement: {
          acknowledgedPosition: "12",
          digest: cloudLinkTopologyDelivery.digest,
          sessionId: cloudLinkTopologyDelivery.sessionId,
        },
      },
    });

    repository.topologyResult = {
      outcome: "delivery-conflict",
    };
    expect(
      await useCase.execute(commandContext, {
        ...topologyInput,
        cloudLinkDelivery: cloudLinkTopologyDelivery,
      }),
    ).toMatchObject({
      ok: false,
      failure: { code: "integration-delivery-conflict" },
    });
  });

  it("allows an atomically persisted out-of-order delivery to remain unacknowledged and rejects forged ACK evidence", async () => {
    const repository = new StubRepository();
    const useCase = new ReportIntegrationTopology({
      repository,
      verifier: new StubVerifier(),
      digestor: new StubDigestor(),
      clock: new FixedClock(),
    });

    await expect(
      useCase.execute(commandContext, {
        ...topologyInput,
        cloudLinkDelivery: cloudLinkTopologyDelivery,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { disposition: "persisted" },
    });

    const record = topologyRecord();
    repository.topologyResult = {
      outcome: "persisted",
      record,
      receipt: topologyReceiptFor(record),
      durableAcknowledgement: {
        ...durableAcknowledgementFor(
          cloudLinkTopologyDelivery as IntegrationCloudLinkDelivery,
        ),
        sessionEpoch: parseCloudLinkSessionEpoch("8"),
      },
    };
    await expect(
      useCase.execute(commandContext, {
        ...topologyInput,
        cloudLinkDelivery: cloudLinkTopologyDelivery,
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "invalid-integration-repository-result" },
    });

    repository.topologyResult = {
      outcome: "persisted",
      record,
      receipt: topologyReceiptFor(record),
      durableAcknowledgement: durableAcknowledgementFor(
        cloudLinkTopologyDelivery as IntegrationCloudLinkDelivery,
      ),
    };
    await expect(
      useCase.execute(commandContext, topologyInput),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "invalid-integration-repository-result" },
    });
  });

  it("fails closed on unknown fields, expired commands, and inactive credentials", async () => {
    const repository = new StubRepository();
    const malformed = new ReportIntegrationTopology({
      repository,
      verifier: new StubVerifier(),
      digestor: new StubDigestor(),
      clock: new FixedClock(),
    });
    expect(
      await malformed.execute(commandContext, {
        ...topologyInput,
        vendorSpecificEscapeHatch: true,
      }),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    expect(repository.topologyInput).toBeUndefined();

    expect(
      await malformed.execute(
        {
          ...commandContext,
          expiresAt: "2026-07-17T05:59:59.999Z",
        },
        topologyInput,
      ),
    ).toMatchObject({ ok: false, failure: { code: "command-expired" } });
    expect(
      await malformed.execute(
        {
          ...commandContext,
          issuedAt: "2026-07-17T06:00:00.001Z",
        },
        topologyInput,
      ),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    expect(
      await malformed.execute(
        {
          ...commandContext,
          issuedAt: "2026-07-17T06:05:00.000Z",
          expiresAt: "2026-07-17T06:05:00.000Z",
        },
        topologyInput,
      ),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });

    const inactive = new ReportIntegrationTopology({
      repository,
      verifier: new StubVerifier({ ok: true, value: binding("revoked") }),
      digestor: new StubDigestor(),
      clock: new FixedClock(),
    });
    expect(await inactive.execute(commandContext, topologyInput)).toMatchObject(
      {
        ok: false,
        failure: { code: "gateway-credential-inactive" },
      },
    );

    const rejected = new ReportIntegrationTopology({
      repository,
      verifier: new StubVerifier({
        ok: false,
        failure: {
          code: "invalid-gateway-credential",
          message: "secret verifier diagnostics",
        },
      }),
      digestor: new StubDigestor(),
      clock: new FixedClock(),
    });
    expect(await rejected.execute(commandContext, topologyInput)).toMatchObject(
      {
        ok: false,
        failure: {
          code: "invalid-gateway-credential",
          message: "gateway credential was rejected",
        },
      },
    );
  });

  it("rejects provider timestamps that are too far in the future", async () => {
    const topologyRepository = new StubRepository();
    const topologyUseCase = new ReportIntegrationTopology({
      repository: topologyRepository,
      verifier: new StubVerifier(),
      digestor: new StubDigestor(),
      clock: new FixedClock(),
    });
    expect(
      await topologyUseCase.execute(commandContext, {
        ...topologyInput,
        observedAtMs: "18446744073709551615",
      }),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    expect(topologyRepository.topologyInput).toBeUndefined();

    const observationRepository = new StubRepository();
    observationRepository.record = topologyRecord();
    const observationUseCase = new ReportIntegrationObservations({
      repository: observationRepository,
      verifier: new StubVerifier(),
      digestor: new StubDigestor(),
      clock: new FixedClock(),
    });
    expect(
      await observationUseCase.execute(commandContext, {
        credential,
        schema: "aether.integration.observation-batch.v1alpha1",
        integrationId: "home-assistant:home",
        snapshotGeneration: "12",
        batchId: "ha-event-future",
        observedAtMs: "18446744073709551615",
        observations: [
          {
            entityId: "entity-registry:climate-kitchen",
            pointKey: "current_temperature",
            observedAtMs: "18446744073709551615",
            quality: "good",
            value: { type: "float64", value: 21.5 },
          },
        ],
      }),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    expect(observationRepository.observationInput).toBeUndefined();
  });

  it("validates observation context against the current topology before persistence", async () => {
    const repository = new StubRepository();
    repository.record = topologyRecord();
    const useCase = new ReportIntegrationObservations({
      repository,
      verifier: new StubVerifier(),
      digestor: new StubDigestor(),
      clock: new FixedClock(),
    });
    const input = {
      credential,
      schema: "aether.integration.observation-batch.v1alpha1",
      integrationId: "home-assistant:home",
      snapshotGeneration: "12",
      batchId: "ha-event-0001",
      observedAtMs: "1784268000100",
      observations: [
        {
          entityId: "entity-registry:climate-kitchen",
          pointKey: "current_temperature",
          observedAtMs: "1784268000100",
          quality: "good",
          value: { type: "float64", value: 21.5 },
        },
      ],
    };

    expect(await useCase.execute(commandContext, input)).toMatchObject({
      ok: true,
      value: {
        disposition: "persisted",
        projection: {
          authority: "edge-reported-copy",
          liveStateAuthoritative: false,
          latestObservations: [
            {
              pointKey: "current_temperature",
              value: { type: "float64", value: 21.5 },
            },
          ],
        },
      },
    });

    expect(
      await useCase.execute(commandContext, {
        ...input,
        observations: [
          {
            ...input.observations[0],
            value: { type: "string", value: "21.5" },
          },
        ],
      }),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    expect(
      await useCase.execute(commandContext, {
        ...input,
        integrationId: "invalid integration id",
      }),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
  });

  it("validates an exact CloudLink replay against immutable history after topology and credential generations advance", async () => {
    const repository = new StubRepository();
    const historicalTopology = topologyRecord();
    const currentTopology = defineIntegrationTopologySnapshot({
      ...topologyInput,
      snapshotGeneration: "13",
      observedAtMs: "1784268000200",
    });
    const current: IntegrationProjectionRecord = {
      ...historicalTopology,
      topology: currentTopology,
      topologyDigest: "a".repeat(64),
      receivedAt: parseUtcInstant("2026-07-17T06:00:00.000Z"),
      revision: 3,
    };
    repository.record = current;
    repository.historicalTopology = {
      tenantId,
      projectId,
      gatewayId,
      integrationId: historicalTopology.integrationId,
      topology: historicalTopology.topology,
      topologyDigest: historicalTopology.topologyDigest,
      receivedAt: historicalTopology.receivedAt,
      revision: 1,
    };
    const historicalReceipt: IntegrationObservationPersistenceReceipt = {
      ...observationReceiptFor(current, "ha-event-old"),
      snapshotGeneration: historicalTopology.topology.snapshotGeneration,
      revision: 2,
    };
    const rotatedBinding = binding("active", "4");
    const rotatedDelivery = {
      ...cloudLinkObservationDelivery,
      sessionId: "55555555-5555-4555-8555-555555555555",
      sessionEpoch: "8",
      credentialGeneration: "4",
    } as const;
    repository.observationResult = {
      outcome: "replayed",
      record: current,
      receipt: historicalReceipt,
      durableAcknowledgement: durableAcknowledgementFor(
        rotatedDelivery as unknown as IntegrationCloudLinkDelivery,
      ),
    };
    const useCase = new ReportIntegrationObservations({
      repository,
      verifier: new StubVerifier({ ok: true, value: rotatedBinding }),
      digestor: new StubDigestor(),
      clock: new FixedClock(),
    });

    await expect(
      useCase.execute(commandContext, {
        credential,
        schema: "aether.integration.observation-batch.v1alpha1",
        integrationId: "home-assistant:home",
        snapshotGeneration: "12",
        batchId: "ha-event-old",
        observedAtMs: "1784268000100",
        observations: [
          {
            entityId: "entity-registry:climate-kitchen",
            pointKey: "current_temperature",
            observedAtMs: "1784268000100",
            quality: "good",
            value: { type: "float64", value: 21.5 },
          },
        ],
        cloudLinkDelivery: rotatedDelivery,
      }),
    ).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: {
        projection: {
          topology: { snapshotGeneration: "13" },
        },
        receipt: {
          credentialGeneration: "3",
          snapshotGeneration: "12",
        },
        durableAcknowledgement: {
          acknowledgedPosition: "1",
          credentialGeneration: "4",
          sessionId: rotatedDelivery.sessionId,
        },
      },
    });
  });

  it("queries only authorized tenant projections and labels them as non-live copies", async () => {
    const repository = new StubRepository();
    repository.record = topologyRecord();
    const useCase = new GetIntegrationProjection({
      repository,
      digestor: new StubDigestor(),
      clock: new FixedClock(),
    });
    const context = {
      tenantId,
      projectId,
      subjectId: "operator:alice",
      permissions: [GET_INTEGRATION_PROJECTION_QUERY.permission],
    };
    const input = {
      gatewayId,
      integrationId: "home-assistant:home",
    };

    expect(await useCase.execute(context, input)).toMatchObject({
      ok: true,
      value: {
        authority: "edge-reported-copy",
        liveStateAuthoritative: false,
      },
    });
    expect(
      await useCase.execute({ ...context, permissions: [] }, input),
    ).toMatchObject({ ok: false, failure: { code: "permission-denied" } });
    expect(
      await useCase.execute(
        {
          ...context,
          tenantId: "99999999-9999-4999-8999-999999999999",
        },
        input,
      ),
    ).toMatchObject({
      ok: false,
      failure: { code: "integration-projection-not-found" },
    });
  });

  it("fails closed on unknown outcomes, missing evidence, and malformed records", async () => {
    const repository = new StubRepository();
    const record = topologyRecord();
    const useCase = new ReportIntegrationTopology({
      repository,
      verifier: new StubVerifier(),
      digestor: new StubDigestor(),
      clock: new FixedClock(),
    });

    repository.topologyResult = {
      outcome: "future-success",
      record,
      receipt: topologyReceiptFor(record),
    } as unknown as IntegrationTopologyPersistenceResult;
    expect(await useCase.execute(commandContext, topologyInput)).toMatchObject({
      ok: false,
      failure: { code: "invalid-integration-repository-result" },
    });

    repository.topologyResult = {
      outcome: "persisted",
      record,
    } as unknown as IntegrationTopologyPersistenceResult;
    expect(await useCase.execute(commandContext, topologyInput)).toMatchObject({
      ok: false,
      failure: { code: "invalid-integration-repository-result" },
    });

    const malformedRecord = {
      ...record,
      revision: 0,
    } as IntegrationProjectionRecord;
    repository.topologyResult = {
      outcome: "persisted",
      record: malformedRecord,
      receipt: { ...topologyReceiptFor(record), revision: 0 },
    };
    expect(await useCase.execute(commandContext, topologyInput)).toMatchObject({
      ok: false,
      failure: { code: "invalid-integration-repository-result" },
    });
  });

  it("deep-validates observation projections and query records from adapters", async () => {
    const repository = new StubRepository();
    const current = topologyRecord();
    repository.record = current;
    const malformedObservationRecord = {
      ...current,
      revision: 2,
      latestObservations: [
        {
          entityId: current.topology.entities[0]?.entityId,
          pointKey: current.topology.entities[0]?.points[1]?.pointKey,
          observedAtMs: "1784268000100",
          quality: "good",
          value: { type: "string", value: "not-a-float" },
        },
      ],
    } as unknown as IntegrationProjectionRecord;
    repository.observationResult = {
      outcome: "persisted",
      record: malformedObservationRecord,
      receipt: observationReceiptFor(malformedObservationRecord),
    };
    const report = new ReportIntegrationObservations({
      repository,
      verifier: new StubVerifier(),
      digestor: new StubDigestor(),
      clock: new FixedClock(),
    });
    const observationInput = {
      credential,
      schema: "aether.integration.observation-batch.v1alpha1",
      integrationId: "home-assistant:home",
      snapshotGeneration: "12",
      batchId: "ha-event-0001",
      observedAtMs: "1784268000100",
      observations: [
        {
          entityId: "entity-registry:climate-kitchen",
          pointKey: "current_temperature",
          observedAtMs: "1784268000100",
          quality: "good",
          value: { type: "float64", value: 21.5 },
        },
      ],
    };

    expect(
      await report.execute(commandContext, observationInput),
    ).toMatchObject({
      ok: false,
      failure: { code: "invalid-integration-repository-result" },
    });

    repository.record = {
      ...current,
      topology: null,
    } as unknown as IntegrationProjectionRecord;
    const query = new GetIntegrationProjection({
      repository,
      digestor: new StubDigestor(),
      clock: new FixedClock(),
    });
    await expect(
      query.execute(
        {
          tenantId,
          projectId,
          subjectId: "operator:alice",
          permissions: [GET_INTEGRATION_PROJECTION_QUERY.permission],
        },
        { gatewayId, integrationId: "home-assistant:home" },
      ),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "invalid-integration-repository-result" },
    });
  });

  it("publishes explicit governed capability metadata", () => {
    expect(ReportIntegrationTopology.definition).toBe(
      REPORT_INTEGRATION_TOPOLOGY_COMMAND,
    );
    expect(ReportIntegrationObservations.definition).toBe(
      REPORT_INTEGRATION_OBSERVATIONS_COMMAND,
    );
    expect(GetIntegrationProjection.definition).toBe(
      GET_INTEGRATION_PROJECTION_QUERY,
    );
    expect(REPORT_INTEGRATION_TOPOLOGY_COMMAND.authorization).toBe(
      "gateway-credential",
    );
  });
});
