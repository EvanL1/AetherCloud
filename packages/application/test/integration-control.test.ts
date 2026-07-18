import { describe, expect, it } from "vitest";

import {
  AuthenticateGatewaySignedCloudLinkUplink,
  CREATE_INTEGRATION_POWER_CONTROL_COMMAND,
  CreateIntegrationPowerControl,
  INGEST_INTEGRATION_CONTROL_RECEIPT_COMMAND,
  IngestIntegrationControlReceipt,
  PublishIntegrationControlOffers,
  ReofferIntegrationPowerControls,
  type GatewayCredentialVerificationResult,
  type GatewayCredentialVerifier,
  type IntegrationControlActionOffer,
  type IntegrationControlApplicationClock,
  type IntegrationControlIntentDigestor,
  type IntegrationControlOfferPublisher,
  type IntegrationControlOfferSigner,
  type IntegrationControlReceiptAuthenticator,
  type IntegrationControlReceiptAuthenticationInput,
  type IntegrationControlRepository,
  type IntegrationControlRuntimeProtocolReader,
  type IntegrationControlSessionReader,
  type IntegrationControlScope,
  type IntegrationControlProjectionReader,
  type IntegrationIntentAndOfferPersistenceInput,
  type IntegrationIntentAndOfferPersistenceResult,
  type IntegrationOfferOutboxRecord,
  type IntegrationOfferPublishedResult,
  type IntegrationReceiptPersistenceInput,
  type IntegrationReceiptPersistenceResult,
  type IntegrationReofferPersistenceInput,
  type IntegrationReofferPersistenceResult,
  type IntegrationStoredIntent,
  type IntegrationProjectionRecord,
} from "../src/index.js";
import {
  INTEGRATION_CONTROL_PROTOCOL,
  defineIntegrationTopologySnapshot,
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseGovernedJobId,
  parseIntegrationControlDigest,
  parseIntegrationControlReceiptId,
  parseIntegrationControlReceiptSequence,
  parseIntegrationEntityId,
  parseIntegrationId,
  parseIntegrationPointKey,
  parseIntegrationSnapshotGeneration,
  parseProjectId,
  parseProtocolVersion,
  parseTenantId,
  parseUtcInstant,
  type AetherRuntimeManifestV1,
  type CloudLinkSession,
  type GatewayCredentialBinding,
  type IntegrationControlReceipt,
  type RuntimeManifestObservation,
} from "@aether-cloud/domain";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const jobId = parseGovernedJobId("55555555-5555-4555-8555-555555555555");
const sessionId = parseCloudLinkSessionId(
  "44444444-4444-4444-8444-444444444444",
);

const scope = { tenantId, projectId } as const;
const fixedNow = parseUtcInstant("2026-07-17T08:00:00.000Z");

class FixedClock implements IntegrationControlApplicationClock {
  now() {
    return fixedNow;
  }
}

function binding(): GatewayCredentialBinding {
  return {
    tenantId,
    projectId,
    gatewayId,
    generation: parseGatewayCredentialGeneration("3"),
    status: "active",
  };
}

function currentSession(
  overrides: Partial<CloudLinkSession> = {},
): CloudLinkSession {
  return {
    tenantId,
    projectId,
    gatewayId,
    sessionId,
    credentialGeneration: parseGatewayCredentialGeneration("3"),
    epoch: parseCloudLinkSessionEpoch("7"),
    state: "active",
    protocolVersion: parseProtocolVersion("1.0"),
    openedAt: parseUtcInstant("2026-07-17T07:59:00.000Z"),
    activatedAt: parseUtcInstant("2026-07-17T07:59:01.000Z"),
    revision: 1,
    ...overrides,
  };
}

const topology = defineIntegrationTopologySnapshot({
  schema: "aether.integration.topology-snapshot.v1alpha1",
  integrationId: "home-assistant.home",
  integrationKind: "home-assistant",
  snapshotGeneration: "9",
  observedAtMs: "1784275199000",
  areas: [],
  devices: [],
  entities: [
    {
      entityId: "entity-registry-light-bedroom",
      sourceAddress: "light.bedroom",
      name: "Bedroom light",
      entityKind: "light",
      points: [
        {
          pointKey: "is_on",
          title: "Power",
          kind: "status",
          valueType: "boolean",
        },
      ],
    },
    {
      entityId: "entity-registry-climate-living",
      sourceAddress: "climate.living",
      name: "Living climate",
      entityKind: "climate",
      points: [
        {
          pointKey: "is_on",
          title: "Power",
          kind: "status",
          valueType: "boolean",
        },
      ],
    },
    {
      entityId: "entity-registry-switch-legacy",
      sourceAddress: "switch.legacy",
      name: "Legacy switch",
      entityKind: "switch",
      points: [
        {
          pointKey: "state",
          title: "Legacy state",
          kind: "status",
          valueType: "boolean",
        },
      ],
    },
  ],
});

function projection(): IntegrationProjectionRecord {
  return {
    tenantId,
    projectId,
    gatewayId,
    integrationId: parseIntegrationId("home-assistant.home"),
    topology,
    topologyDigest: "a".repeat(64),
    latestObservations: [],
    receivedAt: fixedNow,
    revision: 1,
  };
}

const manifest: AetherRuntimeManifestV1 = {
  schemaVersion: 1,
  composition: "aether-edge-home",
  aetherVersion: "0.5.0",
  targetTriple: "x86_64-unknown-linux-gnu",
  targetOs: "linux",
  services: ["aether-io"],
  cargoFeatures: [],
  capabilities: [],
  protocols: [
    "aether.cloudlink.integration.v1alpha1",
    INTEGRATION_CONTROL_PROTOCOL,
  ],
  checksum: { algorithm: "sha256", digest: "b".repeat(64) },
};

function manifestObservation(
  protocols: readonly string[] = manifest.protocols,
): RuntimeManifestObservation {
  return {
    tenantId,
    projectId,
    gatewayId,
    generation: "4" as RuntimeManifestObservation["generation"],
    observedAt: fixedNow,
    receivedAt: fixedNow,
    manifest: { ...manifest, protocols },
  };
}

class StubSessionRepository {
  current: CloudLinkSession | undefined = currentSession();

  findCurrent() {
    return Promise.resolve(this.current);
  }
}

class StubManifestRepository {
  current: RuntimeManifestObservation | undefined = manifestObservation();

  findCurrent() {
    return Promise.resolve(this.current);
  }
}

class StubProjectionRepository {
  current: IntegrationProjectionRecord | undefined = projection();

  findCurrent() {
    return Promise.resolve(this.current);
  }
}

class StubDigestor implements IntegrationControlIntentDigestor {
  calls = 0;

  digest() {
    this.calls += 1;
    return Promise.resolve(
      "sha256:40108827ca617c95f9d9c48c357fdd94b2b5f019d8ccf8a23842642e934c7327",
    );
  }
}

class StubSigner implements IntegrationControlOfferSigner {
  calls = 0;

  sign() {
    this.calls += 1;
    return Promise.resolve({
      keyId: "development-cloud-key-1",
      algorithm: "Ed25519" as const,
      signature: "D".repeat(86),
    });
  }
}

class StubRepository implements IntegrationControlRepository {
  intentInput: IntegrationIntentAndOfferPersistenceInput | undefined;
  reofferInput: IntegrationReofferPersistenceInput | undefined;
  receiptInput: IntegrationReceiptPersistenceInput | undefined;
  publishedAt: ReturnType<typeof parseUtcInstant> | undefined;
  intents: readonly IntegrationStoredIntent[] = [];
  outbox: readonly IntegrationOfferOutboxRecord[] = [];

  persistIntentAndOffer(
    input: IntegrationIntentAndOfferPersistenceInput,
  ): Promise<IntegrationIntentAndOfferPersistenceResult> {
    this.intentInput = input;
    return Promise.resolve({
      outcome: "persisted",
      intent: {
        ...input.scope,
        gatewayId: input.gatewayId,
        jobId: input.offer.job_id,
        intentDigest: input.offer.intent_digest,
        intent: input.offer.intent,
        expiresAtMs: input.offer.expires_at_ms,
        createdAt: input.createdAt,
        latestReceipt: undefined,
        revision: 1,
      },
      offer: {
        eventId: "outbox:integration-control:1",
        ...input.scope,
        gatewayId: input.gatewayId,
        jobId: input.offer.job_id,
        sessionId: input.offer.session_id,
        sessionEpoch: input.offer.session_epoch,
        intentDigest: input.offer.intent_digest,
        offer: input.offer,
        status: "pending",
        createdAt: input.createdAt,
      },
    });
  }

  persistReoffer(
    input: IntegrationReofferPersistenceInput,
  ): Promise<IntegrationReofferPersistenceResult> {
    this.reofferInput = input;
    return Promise.resolve({
      outcome: "persisted",
      offer: {
        eventId: "outbox:integration-control:2",
        ...input.scope,
        gatewayId: input.gatewayId,
        jobId: input.offer.job_id,
        sessionId: input.offer.session_id,
        sessionEpoch: input.offer.session_epoch,
        intentDigest: input.offer.intent_digest,
        offer: input.offer,
        status: "pending",
        createdAt: input.createdAt,
      },
    });
  }

  persistReceipt(
    input: IntegrationReceiptPersistenceInput,
  ): Promise<IntegrationReceiptPersistenceResult> {
    this.receiptInput = input;
    return Promise.resolve({
      outcome: "persisted",
      evidence: {
        ...input.scope,
        gatewayId: input.gatewayId,
        jobId: input.receipt.jobId,
        receipt: input.receipt,
        providerAccepted: input.receipt.stage === "provider-accepted",
        physicalCompleted: false,
        jobSucceeded: false,
        auditEventId: "audit:integration-control:receipt:1",
        receivedAt: input.receivedAt,
      },
      durableAcknowledgement: {
        ...input.scope,
        gatewayId: input.gatewayId,
        sessionId: input.sessionId,
        sessionEpoch: input.sessionEpoch,
        credentialGeneration: input.credentialGeneration,
        streamId: input.delivery.streamId,
        streamEpoch: input.delivery.streamEpoch,
        acknowledgedPosition: input.delivery.position,
        batchId: input.delivery.batchId,
        digest: input.delivery.digest,
        receiptId: "ack:integration-control:1",
        acknowledgedAt: input.receivedAt,
      },
    });
  }

  findIntent() {
    return Promise.resolve(this.intents[0]);
  }

  listUnresolvedIntents() {
    return Promise.resolve(this.intents);
  }

  listDispatchableOffers() {
    return Promise.resolve(this.outbox);
  }

  markOfferPublished(
    _scope: IntegrationControlScope,
    _eventId: string,
    publishedAt: ReturnType<typeof parseUtcInstant>,
  ): Promise<IntegrationOfferPublishedResult> {
    this.publishedAt = publishedAt;
    return Promise.resolve({ outcome: "published" });
  }
}

class StubCredentialVerifier implements GatewayCredentialVerifier {
  calls = 0;
  result: GatewayCredentialVerificationResult = {
    ok: true,
    value: binding(),
  };

  verify() {
    this.calls += 1;
    return Promise.resolve(this.result);
  }
}

class StubReceiptAuthenticator implements IntegrationControlReceiptAuthenticator {
  valid = true;
  calls = 0;
  readonly inputs: IntegrationControlReceiptAuthenticationInput[] = [];

  verify(input: IntegrationControlReceiptAuthenticationInput) {
    this.calls += 1;
    this.inputs.push(input);
    return Promise.resolve(this.valid);
  }
}

function commandContext() {
  return {
    tenantId,
    projectId,
    subjectId: "user-homeowner",
    permissions: ["integration.device.control"],
    confirmation: {
      confirmationId: "66666666-6666-4666-8666-666666666666",
      subjectId: "user-homeowner",
      confirmedAtMs: "1784275199500",
    },
    authorization: {
      policyDecisionId: "policy-decision-1",
      subjectId: "user-homeowner",
      permission: "integration.device.control",
      authorizedAtMs: "1784275199000",
    },
    idempotencyKey: "integration-control-create-001",
    issuedAt: "2026-07-17T07:59:59.000Z",
    expiresAt: "2026-07-17T08:02:00.000Z",
  };
}

function controlInput() {
  return {
    gatewayId,
    jobId,
    integrationId: "home-assistant.home",
    snapshotGeneration: "9",
    entityId: "entity-registry-light-bedroom",
    value: true,
    jobExpiresAtMs: "1784275320000",
  };
}

function makeCreate(
  overrides: {
    repository?: StubRepository;
    sessions?: StubSessionRepository;
    manifests?: StubManifestRepository;
    projections?: StubProjectionRepository;
    enabled?: boolean;
  } = {},
) {
  return new CreateIntegrationPowerControl({
    repository: overrides.repository ?? new StubRepository(),
    sessions: (overrides.sessions ??
      new StubSessionRepository()) satisfies IntegrationControlSessionReader,
    manifests: (overrides.manifests ??
      new StubManifestRepository()) satisfies IntegrationControlRuntimeProtocolReader,
    projections: (overrides.projections ??
      new StubProjectionRepository()) satisfies IntegrationControlProjectionReader,
    digestor: new StubDigestor(),
    signer: new StubSigner(),
    clock: new FixedClock(),
    ...(overrides.enabled === undefined ? {} : { enabled: overrides.enabled }),
  });
}

describe("Integration Control application", () => {
  it("declares the fixed high-risk permission and remains disabled by default", async () => {
    expect(CREATE_INTEGRATION_POWER_CONTROL_COMMAND).toEqual({
      kind: "command",
      name: "integration.device.power.set",
      permission: "integration.device.control",
      risk: "high",
      confirmation: "explicit",
      idempotency: "required",
      expiry: "required",
      audit: "required",
      authorization: "tenant-permission",
    });
    expect(INGEST_INTEGRATION_CONTROL_RECEIPT_COMMAND).toMatchObject({
      permission: "integration.control.receipt.ingest",
      authorization: "gateway-credential",
      audit: "required",
    });

    await expect(
      makeCreate().execute(commandContext(), controlInput()),
    ).resolves.toEqual({
      ok: false,
      failure: {
        code: "integration-control-disabled",
        message: "Integration Control is disabled",
      },
    });
  });

  it("creates only a confirmed fixed power intent bound to current topology and session", async () => {
    const repository = new StubRepository();
    const result = await makeCreate({ repository, enabled: true }).execute(
      commandContext(),
      controlInput(),
    );

    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        disposition: "persisted",
        offer: {
          gateway_id: gatewayId,
          session_id: sessionId,
          session_epoch: "7",
          credential_generation: "3",
          job_id: jobId,
          intent: {
            capability_id: "device.power.set.v1",
            target: {
              integration_id: "home-assistant.home",
              snapshot_generation: "9",
              entity_id: "entity-registry-light-bedroom",
              point_key: "is_on",
            },
            arguments: { value: true },
            governance: {
              execution: "governed-job",
              default_authorization: "deny",
              permission: "integration.device.control",
              risk: "high",
              confirmation: "required",
              idempotency: "required",
              expiry: "required",
              audit: "required",
              edge_final_decision: true,
            },
          },
        },
        physicalCompleted: false,
        jobSucceeded: false,
      },
    });
    expect(repository.intentInput?.offer.cloud_authentication).toEqual({
      key_id: "development-cloud-key-1",
      algorithm: "Ed25519",
      signature: "D".repeat(86),
    });
  });

  it.each([
    [
      "missing permission",
      {
        context: { ...commandContext(), permissions: [] },
        input: controlInput(),
        code: "permission-denied",
      },
    ],
    [
      "unknown provider operation",
      {
        context: commandContext(),
        input: { ...controlInput(), service: "turn_on" },
        code: "invalid-input",
      },
    ],
    [
      "unconfirmed request",
      {
        context: { ...commandContext(), confirmation: null },
        input: controlInput(),
        code: "confirmation-required",
      },
    ],
  ])("rejects %s before persistence", async (_name, scenario) => {
    const repository = new StubRepository();
    const result = await makeCreate({ repository, enabled: true }).execute(
      scenario.context,
      scenario.input,
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { code: scenario.code },
    });
    expect(repository.intentInput).toBeUndefined();
  });

  it("rejects unsupported Home Assistant entities and stale generations", async () => {
    await expect(
      makeCreate({ enabled: true }).execute(commandContext(), {
        ...controlInput(),
        entityId: "entity-registry-climate-living",
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "integration-target-not-writable" },
    });
    await expect(
      makeCreate({ enabled: true }).execute(commandContext(), {
        ...controlInput(),
        entityId: "entity-registry-switch-legacy",
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "integration-target-not-writable" },
    });
    await expect(
      makeCreate({ enabled: true }).execute(commandContext(), {
        ...controlInput(),
        snapshotGeneration: "8",
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "integration-topology-generation-stale" },
    });
  });

  it("does not stage an offer without the persisted runtime protocol or active current session", async () => {
    const manifests = new StubManifestRepository();
    manifests.current = manifestObservation([
      "aether.cloudlink.integration.v1alpha1",
    ]);
    await expect(
      makeCreate({ manifests, enabled: true }).execute(
        commandContext(),
        controlInput(),
      ),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "integration-control-protocol-not-declared" },
    });

    const sessions = new StubSessionRepository();
    sessions.current = currentSession({ state: "suspect" });
    await expect(
      makeCreate({ sessions, enabled: true }).execute(
        commandContext(),
        controlInput(),
      ),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "cloudlink-session-not-active" },
    });
  });
});

function receipt(): IntegrationControlReceipt {
  return {
    jobId,
    receiptId: parseIntegrationControlReceiptId(
      "77777777-7777-4777-8777-777777777777",
    ),
    receiptSequence: parseIntegrationControlReceiptSequence("1"),
    capabilityId: "device.power.set.v1",
    target: {
      integrationId: parseIntegrationId("home-assistant.home"),
      snapshotGeneration: topology.snapshotGeneration,
      entityId: parseIntegrationEntityId("entity-registry-light-bedroom"),
      pointKey: parseIntegrationPointKey("is_on"),
    },
    intentDigest: parseIntegrationControlDigest(
      "sha256:40108827ca617c95f9d9c48c357fdd94b2b5f019d8ccf8a23842642e934c7327",
    ),
    stage: "provider-accepted",
    decision: "accepted",
    physicalOutcome: "unknown",
    observedAtMs: "1784275200450",
    evidenceDigest: parseIntegrationControlDigest(
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ),
    audit: {
      auditRecordId: "audit-provider-accepted-1",
      status: "complete",
    },
  };
}

function receiptInput() {
  return {
    credential: {
      credentialId: "gateway-credential-003",
      proof: "opaque-test-proof-material",
    },
    sessionId,
    sessionEpoch: "7",
    credentialGeneration: "3",
    sentAtMs: "1784275200500",
    delivery: {
      streamId: "integration-control-receipts",
      streamEpoch: "1",
      position: "1",
      batchId: "job-55555555-receipt-1",
      digest:
        "sha256:f42bb6dfcd28ca27a7c1079569ffcd0f6144f741461cd362c3c679f471af80a7",
    },
    messageAuthentication: {
      keyId: "development-gateway-key-1",
      algorithm: "Ed25519",
      signature: "E".repeat(86),
    },
    receipt: receipt(),
  };
}

async function authenticateGatewaySignedReceipt(input: {
  readonly expiresAtMs?: string;
}) {
  const raw = receiptInput();
  const result = await new AuthenticateGatewaySignedCloudLinkUplink({
    sessions: {
      findCurrent: () =>
        Promise.resolve(
          currentSession({
            gatewayKeyId: "gateway-session-key-17",
            heartbeatIntervalMs: "30000",
          }),
        ),
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
      nowMilliseconds: () => "1784275200550",
    },
    enabled: true,
  }).execute({
    tenantId,
    projectId,
    gatewayId,
    sessionId,
    sessionEpoch: "7",
    credentialGeneration: "3",
    messageKind: "integration-action-receipt",
    sentAtMs: raw.sentAtMs,
    ...(input.expiresAtMs === undefined
      ? {}
      : { expiresAtMs: input.expiresAtMs }),
    delivery: raw.delivery,
    messageAuthentication: {
      keyId: "gateway-session-key-17",
      algorithm: "Ed25519",
      signature: "A".repeat(86),
    },
  });
  if (!result.ok) throw new Error("test receipt did not authenticate");
  return result.value;
}

function storedIntentForReceipt(): IntegrationStoredIntent {
  return {
    ...scope,
    gatewayId,
    jobId,
    intentDigest: receipt().intentDigest,
    intent: {
      schema: "aether.integration-control.action-intent.v1alpha1",
      capability_id: "device.power.set.v1",
      target: {
        integration_id: parseIntegrationId("home-assistant.home"),
        snapshot_generation: parseIntegrationSnapshotGeneration("9"),
        entity_id: parseIntegrationEntityId("entity-registry-light-bedroom"),
        point_key: "is_on",
      },
      arguments: { value: true },
      governance: {
        execution: "governed-job",
        default_authorization: "deny",
        permission: "integration.device.control",
        risk: "high",
        confirmation: "required",
        idempotency: "required",
        expiry: "required",
        audit: "required",
        edge_final_decision: true,
      },
      authorization: {
        policy_decision_id: "policy-decision-1",
        subject_id: "user-homeowner",
        permission: "integration.device.control",
        authorized_at_ms: "1784275199000",
      },
      confirmation: {
        confirmation_id: "66666666-6666-4666-8666-666666666666",
        subject_id: "user-homeowner",
        confirmed_at_ms: "1784275199500",
      },
    },
    expiresAtMs: "1784275320000",
    createdAt: fixedNow,
    latestReceipt: undefined,
    revision: 1,
  };
}

describe("Integration Control receipt evidence", () => {
  it("authenticates and atomically persists provider acceptance without claiming success", async () => {
    const repository = new StubRepository();
    repository.intents = [storedIntentForReceipt()];
    const authenticator = new StubReceiptAuthenticator();
    const useCase = new IngestIntegrationControlReceipt({
      repository,
      sessions: new StubSessionRepository(),
      credentialVerifier: new StubCredentialVerifier(),
      authenticator,
      clock: new FixedClock(),
    });

    const result = await useCase.execute(
      {
        idempotencyKey: "integration-receipt-ingest-001",
        issuedAt: "2026-07-17T07:59:59.000Z",
        expiresAt: "2026-07-17T08:02:00.000Z",
      },
      {
        ...receiptInput(),
        expiresAtMs: "1784275200600",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        stage: "provider-accepted",
        providerAccepted: true,
        physicalCompleted: false,
        jobSucceeded: false,
        durableAcknowledgement: {
          acknowledgedPosition: "1",
          digest:
            "sha256:f42bb6dfcd28ca27a7c1079569ffcd0f6144f741461cd362c3c679f471af80a7",
        },
      },
    });
    expect(authenticator.calls).toBe(1);
    expect(authenticator.inputs[0]).toMatchObject({
      expiresAtMs: "1784275200600",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });
    expect(repository.receiptInput?.receipt.physicalOutcome).toBe("unknown");
    expect(repository.receiptInput).not.toHaveProperty("expiresAtMs");
    expect(repository.receiptInput).not.toHaveProperty("traceparent");
  });

  it("uses the opaque Gateway-signed uplink capability as the single receipt authentication model", async () => {
    const expiresAtMs = "1784275200600";
    const fact = await authenticateGatewaySignedReceipt({ expiresAtMs });
    const repository = new StubRepository();
    repository.intents = [storedIntentForReceipt()];
    const credentialVerifier = new StubCredentialVerifier();
    const authenticator = new StubReceiptAuthenticator();
    const useCase = new IngestIntegrationControlReceipt({
      repository,
      sessions: new StubSessionRepository(),
      credentialVerifier,
      authenticator,
      clock: new FixedClock(),
    });
    const {
      credential: _credential,
      messageAuthentication: _messageAuthentication,
      ...signedReceipt
    } = receiptInput();
    void _credential;
    void _messageAuthentication;
    const context = {
      idempotencyKey: "integration-receipt-ingest-signed-001",
      issuedAt: "2026-07-17T07:59:59.000Z",
      expiresAt: "2026-07-17T08:02:00.000Z",
    };

    await expect(
      useCase.execute(context, {
        ...signedReceipt,
        expiresAtMs,
        gatewaySignedAuthentication: fact,
      }),
    ).resolves.toMatchObject({
      ok: true,
      replayed: false,
      value: {
        stage: "provider-accepted",
        providerAccepted: true,
      },
    });
    expect(credentialVerifier.calls).toBe(0);
    expect(authenticator.calls).toBe(0);
    expect(repository.receiptInput).toMatchObject({
      gatewayId,
      sessionId,
      sessionEpoch: "7",
      credentialGeneration: "3",
      delivery: signedReceipt.delivery,
    });

    await expect(
      useCase.execute(context, {
        ...signedReceipt,
        expiresAtMs,
        gatewaySignedAuthentication: { ...fact },
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
    await expect(
      useCase.execute(context, {
        ...signedReceipt,
        expiresAtMs,
        delivery: { ...signedReceipt.delivery, position: "2" },
        gatewaySignedAuthentication: fact,
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
    await expect(
      useCase.execute(context, {
        ...signedReceipt,
        credential: receiptInput().credential,
        expiresAtMs,
        gatewaySignedAuthentication: fact,
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
    expect(credentialVerifier.calls).toBe(0);
    expect(authenticator.calls).toBe(0);
  });

  it.each([
    ["an expiry before sent time", { expiresAtMs: "1784275200499" }],
    [
      "an invalid W3C trace context",
      {
        traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      },
    ],
  ])(
    "rejects receipt input with %s before authentication",
    async (_name, patch) => {
      const repository = new StubRepository();
      const authenticator = new StubReceiptAuthenticator();
      const useCase = new IngestIntegrationControlReceipt({
        repository,
        sessions: new StubSessionRepository(),
        credentialVerifier: new StubCredentialVerifier(),
        authenticator,
        clock: new FixedClock(),
      });

      await expect(
        useCase.execute(
          {
            idempotencyKey: "integration-receipt-ingest-invalid-envelope",
            issuedAt: "2026-07-17T07:59:59.000Z",
            expiresAt: "2026-07-17T08:02:00.000Z",
          },
          { ...receiptInput(), ...patch },
        ),
      ).resolves.toMatchObject({
        ok: false,
        failure: { code: "invalid-input" },
      });
      expect(authenticator.calls).toBe(0);
      expect(repository.receiptInput).toBeUndefined();
    },
  );

  it("fails closed on invalid authentication or a receipt/intent conflict", async () => {
    const repository = new StubRepository();
    const authenticator = new StubReceiptAuthenticator();
    authenticator.valid = false;
    const useCase = new IngestIntegrationControlReceipt({
      repository,
      sessions: new StubSessionRepository(),
      credentialVerifier: new StubCredentialVerifier(),
      authenticator,
      clock: new FixedClock(),
    });
    await expect(
      useCase.execute(
        {
          idempotencyKey: "integration-receipt-ingest-002",
          issuedAt: "2026-07-17T07:59:59.000Z",
          expiresAt: "2026-07-17T08:02:00.000Z",
        },
        receiptInput(),
      ),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "integration-receipt-authentication-invalid" },
    });
    expect(repository.receiptInput).toBeUndefined();
  });
});

class RecordingPublisher implements IntegrationControlOfferPublisher {
  published: IntegrationControlActionOffer[] = [];

  publish(offer: IntegrationControlActionOffer) {
    this.published.push(offer);
    return Promise.resolve();
  }
}

describe("Integration Control outbox", () => {
  it("reoffers one unresolved intent with the same job and digest on the new current session", async () => {
    const repository = new StubRepository();
    const create = await makeCreate({ repository, enabled: true }).execute(
      commandContext(),
      controlInput(),
    );
    expect(create.ok).toBe(true);
    const stored = (create as { value: { intent: IntegrationStoredIntent } })
      .value.intent;
    repository.intents = [stored];
    const sessions = new StubSessionRepository();
    sessions.current = currentSession({
      sessionId: parseCloudLinkSessionId(
        "88888888-8888-4888-8888-888888888888",
      ),
      epoch: parseCloudLinkSessionEpoch("8"),
    });
    const reoffer = new ReofferIntegrationPowerControls({
      repository,
      sessions,
      manifests: new StubManifestRepository(),
      signer: new StubSigner(),
      clock: new FixedClock(),
      enabled: true,
    });

    const result = await reoffer.execute(scope, { gatewayId });

    expect(result).toMatchObject({
      ok: true,
      value: {
        staged: 1,
        offers: [
          {
            job_id: jobId,
            intent_digest: stored.intentDigest,
            session_id: "88888888-8888-4888-8888-888888888888",
            session_epoch: "8",
          },
        ],
      },
    });
  });

  it("does not stage a duplicate when the current session already has a pending offer", async () => {
    const repository = new StubRepository();
    const create = await makeCreate({ repository, enabled: true }).execute(
      commandContext(),
      controlInput(),
    );
    expect(create.ok).toBe(true);
    const value = create as {
      value: {
        intent: IntegrationStoredIntent;
        offer: IntegrationControlActionOffer;
      };
    };
    repository.intents = [value.value.intent];
    repository.outbox = [
      {
        eventId: "outbox:integration-control:pending-current",
        ...scope,
        gatewayId,
        jobId,
        sessionId,
        sessionEpoch: "7",
        intentDigest: value.value.intent.intentDigest,
        offer: value.value.offer,
        status: "pending",
        createdAt: fixedNow,
      },
    ];
    const signer = new StubSigner();
    const reoffer = new ReofferIntegrationPowerControls({
      repository,
      sessions: new StubSessionRepository(),
      manifests: new StubManifestRepository(),
      signer,
      clock: new FixedClock(),
      enabled: true,
    });

    await expect(reoffer.execute(scope, { gatewayId })).resolves.toMatchObject({
      ok: true,
      value: { staged: 0, deferred: 0, offers: [] },
    });
    expect(signer.calls).toBe(0);
    expect(repository.reofferInput).toBeUndefined();
  });

  it("publishes only an offer bound to the active current session and declared protocol", async () => {
    const repository = new StubRepository();
    const create = await makeCreate({ repository, enabled: true }).execute(
      commandContext(),
      controlInput(),
    );
    expect(create.ok).toBe(true);
    const offer = (
      create as { value: { offer: IntegrationControlActionOffer } }
    ).value.offer;
    repository.outbox = [
      {
        eventId: "outbox:integration-control:1",
        ...scope,
        gatewayId,
        jobId,
        sessionId,
        sessionEpoch: "7",
        intentDigest: offer.intent_digest,
        offer,
        status: "pending",
        createdAt: fixedNow,
      },
    ];
    const publisher = new RecordingPublisher();
    const publish = new PublishIntegrationControlOffers({
      repository,
      sessions: new StubSessionRepository(),
      manifests: new StubManifestRepository(),
      publisher,
      clock: new FixedClock(),
      enabled: true,
    });
    await expect(publish.execute(scope, { gatewayId })).resolves.toMatchObject({
      ok: true,
      value: { published: 1, deferred: 0 },
    });
    expect(publisher.published).toHaveLength(1);
    expect(repository.publishedAt).toBe(fixedNow);

    const staleSessions = new StubSessionRepository();
    staleSessions.current = currentSession({
      sessionId: parseCloudLinkSessionId(
        "88888888-8888-4888-8888-888888888888",
      ),
      epoch: parseCloudLinkSessionEpoch("8"),
    });
    const stalePublisher = new RecordingPublisher();
    const stalePublish = new PublishIntegrationControlOffers({
      repository,
      sessions: staleSessions,
      manifests: new StubManifestRepository(),
      publisher: stalePublisher,
      clock: new FixedClock(),
      enabled: true,
    });
    await expect(
      stalePublish.execute(scope, { gatewayId }),
    ).resolves.toMatchObject({
      ok: true,
      value: { published: 0, deferred: 1 },
    });
    expect(stalePublisher.published).toHaveLength(0);
  });

  it("does not publish an offer after its governed expiry", async () => {
    const repository = new StubRepository();
    const create = await makeCreate({ repository, enabled: true }).execute(
      commandContext(),
      controlInput(),
    );
    expect(create.ok).toBe(true);
    const offer = (
      create as { value: { offer: IntegrationControlActionOffer } }
    ).value.offer;
    repository.outbox = [
      {
        eventId: "outbox:integration-control:expired",
        ...scope,
        gatewayId,
        jobId,
        sessionId,
        sessionEpoch: "7",
        intentDigest: offer.intent_digest,
        offer: {
          ...offer,
          expires_at_ms: "1784275199999",
        },
        status: "pending",
        createdAt: fixedNow,
      },
    ];
    const publisher = new RecordingPublisher();
    const publish = new PublishIntegrationControlOffers({
      repository,
      sessions: new StubSessionRepository(),
      manifests: new StubManifestRepository(),
      publisher,
      clock: new FixedClock(),
      enabled: true,
    });

    await expect(publish.execute(scope, { gatewayId })).resolves.toMatchObject({
      ok: true,
      value: { published: 0, deferred: 1 },
    });
    expect(publisher.published).toHaveLength(0);
    expect(repository.publishedAt).toBeUndefined();
  });
});
