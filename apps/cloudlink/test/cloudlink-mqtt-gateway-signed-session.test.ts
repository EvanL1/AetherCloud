import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CloudLinkMqttApplicationBridge,
  type CloudLinkApplicationCommand,
  type CloudLinkApplicationUnaryCommand,
  type CloudLinkBridgeDependencies,
  type CloudLinkMqttResponsePublisher,
} from "../src/index.js";

const topicPrefix = "aethercloud";
const gatewayId = "33333333-3333-4333-8333-333333333333";
const challengeId = "55555555-5555-4555-8555-555555555555";
const sessionId = "44444444-4444-4444-8444-444444444444";
const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const clientNonce = "A".repeat(43);
const gatewaySignature = "B".repeat(86);
const messageSignature = Buffer.alloc(64, 0xa5).toString("base64url");

function telemetrySigningProjection() {
  return {
    schema: "aether.cloudlink.uplink-signing.v1alpha1",
    gateway_id: gatewayId,
    credential_generation: "3",
    session_id: sessionId,
    session_epoch: "7",
    message_kind: "telemetry-batch",
    sent_at_ms: "1721000000200",
    expires_at_ms: "1721003600000",
    stream_id: "telemetry",
    stream_epoch: "4",
    position: "19",
    batch_id: "batch-1",
    business_digest:
      "sha256:397dafb32f984e975221bb3aa13481808692d24850a201be8818dd1517f38c35",
  };
}

function deliverySigningProjection(message: Record<string, unknown>) {
  const delivery = message.delivery as Record<string, unknown>;
  return {
    schema: "aether.cloudlink.uplink-signing.v1alpha1",
    gateway_id: message.gateway_id,
    credential_generation: message.credential_generation,
    session_id: message.session_id,
    session_epoch: message.session_epoch,
    message_kind: message.message_kind,
    sent_at_ms: message.sent_at_ms,
    expires_at_ms: message.expires_at_ms ?? null,
    stream_id: delivery.stream_id,
    stream_epoch: delivery.stream_epoch,
    position: delivery.position,
    batch_id: delivery.batch_id,
    business_digest: delivery.digest,
  };
}

function sessionEvent(body: unknown) {
  return {
    topic: `${topicPrefix}/v1/gateways/${gatewayId}/up/session`,
    payload: new TextEncoder().encode(JSON.stringify(body)),
  };
}

function challengeRequest() {
  return {
    schema: "aether.cloudlink.session-challenge-request.v1",
    protocol: "aether.cloudlink",
    message_kind: "session-challenge-request",
    gateway_id: gatewayId,
    credential_binding: {
      credential_id: "development-binding-17",
      generation: "3",
    },
    offered_protocol_versions: ["1.0"],
    client_nonce: clientNonce,
    resume: [
      {
        stream_id: "telemetry",
        stream_epoch: "4",
        acknowledged_position: "18",
      },
    ],
  };
}

function gatewayHello() {
  return {
    schema: "aether.cloudlink.session-hello.v1",
    protocol: "aether.cloudlink",
    message_kind: "session-hello",
    gateway_id: gatewayId,
    credential_binding: {
      credential_id: "development-binding-17",
      generation: "3",
      origin_model: "gateway-signed",
    },
    challenge_id: challengeId,
    gateway_key_id: "gateway-session-key-17",
    gateway_signature: {
      key_id: "gateway-session-key-17",
      algorithm: "Ed25519",
      signature: gatewaySignature,
    },
    offered_protocol_versions: ["1.0"],
    client_nonce: clientNonce,
    resume: [
      {
        stream_id: "telemetry",
        stream_epoch: "4",
        acknowledged_position: "18",
      },
    ],
  };
}

class RecordingUnaryCommand implements CloudLinkApplicationUnaryCommand {
  readonly calls: unknown[] = [];
  result: unknown;

  constructor(result: unknown) {
    this.result = result;
  }

  execute(input: unknown): Promise<unknown> {
    this.calls.push(input);
    return Promise.resolve(this.result);
  }
}

class RecordingCommand implements CloudLinkApplicationCommand {
  readonly calls: Array<{
    readonly context: unknown;
    readonly input: unknown;
  }> = [];
  readonly result: unknown;

  constructor(result: unknown) {
    this.result = result;
  }

  execute(context: unknown, input: unknown): Promise<unknown> {
    this.calls.push({ context, input });
    return Promise.resolve(this.result);
  }
}

class ByteRecordingPublisher implements CloudLinkMqttResponsePublisher {
  readonly messages: Array<{
    readonly topic: string;
    readonly payload: Uint8Array;
  }> = [];
  #failuresRemaining = 0;

  failNext(): void {
    this.#failuresRemaining += 1;
  }

  publish(topic: string, payload: Uint8Array): Promise<void> {
    if (this.#failuresRemaining > 0) {
      this.#failuresRemaining -= 1;
      return Promise.reject(new Error("test publication failure"));
    }
    this.messages.push({ topic, payload: Uint8Array.from(payload) });
    return Promise.resolve();
  }
}

function setup() {
  const publisher = new ByteRecordingPublisher();
  const requestSessionChallenge = new RecordingUnaryCommand({
    ok: true,
    replayed: false,
    value: {
      gatewayId,
      challengeId,
      cloudNonce: "C".repeat(43),
      issuedAtMs: "1784275200000",
      expiresAtMs: "1784275260000",
      cloudAuthentication: {
        keyId: "cloud-session-key-1",
        algorithm: "Ed25519",
        signature: "D".repeat(86),
      },
    },
  });
  const acceptGatewaySignedSession = new RecordingUnaryCommand({
    ok: true,
    replayed: false,
    value: {
      tenantId,
      projectId,
      gatewayId,
      sessionId,
      credentialGeneration: "3",
      epoch: "7",
      state: "active",
      protocolVersion: "1.0",
      gatewayKeyId: "gateway-session-key-17",
      heartbeatIntervalMs: "30000",
      resumeCursors: [
        {
          streamId: "telemetry",
          streamEpoch: "4",
          position: "18",
        },
      ],
    },
  });
  const authenticateGatewaySignedUplink = new RecordingUnaryCommand({
    ok: true,
    replayed: false,
    value: {
      tenantId,
      projectId,
      gatewayId,
      sessionId,
      sessionEpoch: "7",
      credentialGeneration: "3",
      gatewayKeyId: "gateway-session-key-17",
      messageKind: "telemetry-batch",
      signingObjectDigest: `sha256:${"a".repeat(64)}`,
      signingProjection: telemetrySigningProjection(),
      refreshServerLiveness: false,
    },
  });
  const openSession = new RecordingCommand({ ok: false });
  const heartbeat = new RecordingCommand({ ok: true });
  const reportManifest = new RecordingCommand({ ok: true });
  const ingestTelemetry = new RecordingCommand({
    ok: true,
    value: {
      disposition: "persisted",
      durablyAcknowledged: true,
      receipt: { receiptId: "telemetry-receipt-18" },
    },
  });
  const dependencies: CloudLinkBridgeDependencies = {
    topicPrefix,
    publisher,
    requestSessionChallenge,
    acceptGatewaySignedSession,
    authenticateGatewaySignedUplink,
    gatewaySignedScope: { tenantId, projectId },
    openSession,
    heartbeat,
    reportManifest,
    ingestTelemetry,
    clock: { now: () => "2026-07-17T08:00:00.000Z" },
  };
  return {
    bridge: new CloudLinkMqttApplicationBridge(dependencies),
    dependencies,
    publisher,
    requestSessionChallenge,
    acceptGatewaySignedSession,
    authenticateGatewaySignedUplink,
    heartbeat,
    openSession,
    ingestTelemetry,
  };
}

describe("CloudLink MQTT Gateway-signed session bridge", () => {
  it("publishes the persisted challenge and returns byte-identical output for an exact retry", async () => {
    const context = setup();

    const first = await context.bridge.handle(sessionEvent(challengeRequest()));
    const second = await context.bridge.handle(
      sessionEvent(challengeRequest()),
    );

    expect(first).toEqual({ outcome: "acknowledged" });
    expect(second).toEqual({ outcome: "acknowledged" });
    expect(context.requestSessionChallenge.calls).toEqual([
      {
        gatewayId,
        credentialId: "development-binding-17",
        credentialGeneration: "3",
        protocolVersions: ["1.0"],
        clientNonce,
        clientPositions: [
          { streamId: "telemetry", streamEpoch: "4", position: "18" },
        ],
      },
      {
        gatewayId,
        credentialId: "development-binding-17",
        credentialGeneration: "3",
        protocolVersions: ["1.0"],
        clientNonce,
        clientPositions: [
          { streamId: "telemetry", streamEpoch: "4", position: "18" },
        ],
      },
    ]);
    expect(context.publisher.messages).toHaveLength(2);
    expect(context.publisher.messages[1]?.payload).toEqual(
      context.publisher.messages[0]?.payload,
    );
    expect(
      JSON.parse(
        new TextDecoder().decode(context.publisher.messages[0]?.payload),
      ),
    ).toMatchObject({
      message_kind: "session-challenge",
      gateway_id: gatewayId,
      challenge_id: challengeId,
      cloud_signature: {
        key_id: "cloud-session-key-1",
        algorithm: "Ed25519",
      },
    });
  });

  it("defers a persisted challenge when publication fails and republishes it on exact retry", async () => {
    const context = setup();
    context.publisher.failNext();

    const first = await context.bridge.handle(sessionEvent(challengeRequest()));
    const second = await context.bridge.handle(
      sessionEvent(challengeRequest()),
    );

    expect(first).toEqual({ outcome: "deferred" });
    expect(second).toEqual({ outcome: "acknowledged" });
    expect(context.requestSessionChallenge.calls).toHaveLength(2);
    expect(context.publisher.messages).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain(clientNonce);
    expect(JSON.stringify(first)).not.toContain("development-binding-17");
    expect(JSON.stringify(first)).not.toContain("D".repeat(86));
  });

  it("routes Gateway hello to atomic acceptance without reusing its signature as credential proof", async () => {
    const context = setup();
    await context.bridge.handle(sessionEvent(challengeRequest()));
    context.publisher.messages.length = 0;

    const result = await context.bridge.handle(sessionEvent(gatewayHello()));

    expect(result).toEqual({ outcome: "acknowledged" });
    expect(context.acceptGatewaySignedSession.calls).toEqual([
      {
        originModel: "gateway-signed",
        gatewayId,
        credentialId: "development-binding-17",
        credentialGeneration: "3",
        gatewayKeyId: "gateway-session-key-17",
        gatewayAuthentication: {
          keyId: "gateway-session-key-17",
          algorithm: "Ed25519",
          signature: gatewaySignature,
        },
        challengeId,
        protocolVersions: ["1.0"],
        clientNonce,
        clientPositions: [
          { streamId: "telemetry", streamEpoch: "4", position: "18" },
        ],
      },
    ]);
    expect(context.openSession.calls).toEqual([]);
    expect(context.publisher.messages).toHaveLength(1);
    expect(
      JSON.parse(
        new TextDecoder().decode(context.publisher.messages[0]?.payload),
      ),
    ).toMatchObject({
      message_kind: "session-accepted",
      gateway_id: gatewayId,
      session_id: sessionId,
      session_epoch: "7",
      heartbeat_interval_ms: "30000",
    });
  });

  it("defers an accepted session when publication fails and republishes acceptance on exact hello retry", async () => {
    const context = setup();
    await context.bridge.handle(sessionEvent(challengeRequest()));
    context.publisher.messages.length = 0;
    context.publisher.failNext();

    const first = await context.bridge.handle(sessionEvent(gatewayHello()));
    const second = await context.bridge.handle(sessionEvent(gatewayHello()));

    expect(first).toEqual({ outcome: "deferred" });
    expect(second).toEqual({ outcome: "acknowledged" });
    expect(context.acceptGatewaySignedSession.calls).toHaveLength(2);
    expect(context.publisher.messages).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain(clientNonce);
    expect(JSON.stringify(first)).not.toContain(gatewaySignature);
    expect(JSON.stringify(first)).not.toContain("development-binding-17");
  });

  it("authenticates a signed delivery in the application before invoking business idempotency", async () => {
    const context = setup();
    await context.bridge.handle(sessionEvent(challengeRequest()));
    await context.bridge.handle(sessionEvent(gatewayHello()));
    const telemetry = JSON.parse(
      readFileSync(
        new URL(
          "../../../contracts/cloudlink/v1/fixtures/telemetry-batch.valid.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    telemetry.message_authentication = {
      key_id: "gateway-session-key-17",
      algorithm: "Ed25519",
      signature: messageSignature,
    };

    const result = await context.bridge.handle({
      topic: `${topicPrefix}/v1/gateways/${gatewayId}/up/telemetry`,
      payload: new TextEncoder().encode(JSON.stringify(telemetry)),
    });

    expect(result).toEqual({ outcome: "acknowledged" });
    expect(context.authenticateGatewaySignedUplink.calls).toEqual([
      {
        tenantId,
        projectId,
        gatewayId,
        sessionId,
        sessionEpoch: "7",
        credentialGeneration: "3",
        messageKind: "telemetry-batch",
        sentAtMs: "1721000000200",
        expiresAtMs: "1721003600000",
        delivery: {
          streamId: "telemetry",
          streamEpoch: "4",
          position: "19",
          batchId: "batch-1",
          digest:
            "sha256:397dafb32f984e975221bb3aa13481808692d24850a201be8818dd1517f38c35",
        },
        messageAuthentication: {
          keyId: "gateway-session-key-17",
          algorithm: "Ed25519",
          signature: messageSignature,
        },
      },
    ]);
    expect(context.ingestTelemetry.calls).toHaveLength(1);
    expect(context.ingestTelemetry.calls[0]?.input).toMatchObject({
      gatewaySignedAuthentication: {
        tenantId,
        projectId,
        gatewayId,
        messageKind: "telemetry-batch",
      },
    });
  });

  it("recovers a signed session from persistent application authentication after bridge reconstruction", async () => {
    const context = setup();
    const reconstructed = new CloudLinkMqttApplicationBridge(
      context.dependencies,
    );
    const telemetry = JSON.parse(
      readFileSync(
        new URL(
          "../../../contracts/cloudlink/v1/fixtures/telemetry-batch.valid.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    telemetry.message_authentication = {
      key_id: "gateway-session-key-17",
      algorithm: "Ed25519",
      signature: messageSignature,
    };

    await expect(
      reconstructed.handle({
        topic: `${topicPrefix}/v1/gateways/${gatewayId}/up/telemetry`,
        payload: new TextEncoder().encode(JSON.stringify(telemetry)),
      }),
    ).resolves.toEqual({ outcome: "acknowledged" });
    expect(context.ingestTelemetry.calls).toHaveLength(1);
  });

  it("restores scoped Runtime Manifest protocols before direct signed Integration delivery and control receipt after reconstruction", async () => {
    const context = setup();
    const restoreRuntimeProtocols = new RecordingUnaryCommand({
      ok: true,
      value: {
        status: "present",
        tenantId,
        projectId,
        gatewayId,
        credentialGeneration: "3",
        manifestGeneration: "4",
        protocols: [
          "aether.cloudlink.integration-control.v1alpha1",
          "aether.cloudlink.integration.v1alpha1",
        ],
      },
    });
    const reportIntegrationTopology = new RecordingCommand({ ok: false });
    const ingestIntegrationControlReceipt = new RecordingCommand({
      ok: false,
    });
    const publishIntegrationControlOffers = new RecordingCommand({
      ok: true,
    });
    const reofferIntegrationControls = new RecordingCommand({ ok: true });
    const signedDependencies: CloudLinkBridgeDependencies = {
      ...context.dependencies,
      restoreRuntimeProtocols,
      reportIntegrationTopology,
      ingestIntegrationControlReceipt,
      publishIntegrationControlOffers,
      reofferIntegrationControls,
      enabledExtensions: [
        "aether.cloudlink.integration.v1alpha1",
        "aether.cloudlink.integration-control.v1alpha1",
      ],
    };

    const topology = JSON.parse(
      readFileSync(
        new URL(
          "../../../contracts/aether-contracts/v0.1.0-alpha.4/fixtures/cloudlink-integration/v1alpha1/integration-topology.valid.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    topology.message_authentication = {
      key_id: "gateway-session-key-17",
      algorithm: "Ed25519",
      signature: messageSignature,
    };
    context.authenticateGatewaySignedUplink.result = {
      ok: true,
      replayed: false,
      value: {
        tenantId,
        projectId,
        gatewayId,
        sessionId,
        sessionEpoch: "7",
        credentialGeneration: "3",
        gatewayKeyId: "gateway-session-key-17",
        messageKind: "integration-topology-snapshot",
        signingObjectDigest: `sha256:${"c".repeat(64)}`,
        signingProjection: deliverySigningProjection(topology),
        refreshServerLiveness: false,
      },
    };
    const topologyBridge = new CloudLinkMqttApplicationBridge(
      signedDependencies,
    );
    await expect(
      topologyBridge.handle({
        topic: `${topicPrefix}/v1/gateways/${gatewayId}/up/integration/topology`,
        payload: new TextEncoder().encode(JSON.stringify(topology)),
      }),
    ).resolves.toEqual({ outcome: "rejected" });
    expect(reportIntegrationTopology.calls).toHaveLength(1);
    expect(restoreRuntimeProtocols.calls[0]).toEqual({
      gatewaySignedBinding: {
        tenantId,
        projectId,
        gatewayId,
        credentialGeneration: "3",
      },
    });

    const receipt = JSON.parse(
      readFileSync(
        new URL(
          "../../../contracts/aether-contracts/v0.1.0-alpha.4/fixtures/integration-control/v1alpha1/action-receipt-provider-accepted.valid.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    receipt.message_authentication = {
      key_id: "gateway-session-key-17",
      algorithm: "Ed25519",
      signature: messageSignature,
    };
    context.authenticateGatewaySignedUplink.result = {
      ok: true,
      replayed: false,
      value: {
        tenantId,
        projectId,
        gatewayId,
        sessionId,
        sessionEpoch: "7",
        credentialGeneration: "3",
        gatewayKeyId: "gateway-session-key-17",
        messageKind: "integration-action-receipt",
        signingObjectDigest: `sha256:${"d".repeat(64)}`,
        signingProjection: deliverySigningProjection(receipt),
        refreshServerLiveness: false,
      },
    };
    const receiptBridge = new CloudLinkMqttApplicationBridge(
      signedDependencies,
    );
    await expect(
      receiptBridge.handle({
        topic: `${topicPrefix}/v1/gateways/${gatewayId}/up/integration-control/receipts`,
        payload: new TextEncoder().encode(JSON.stringify(receipt)),
      }),
    ).resolves.toEqual({ outcome: "rejected" });
    expect(ingestIntegrationControlReceipt.calls).toHaveLength(1);
    expect(restoreRuntimeProtocols.calls).toHaveLength(2);
  });

  it("acknowledges an exact signed heartbeat replay without refreshing application liveness or echoing its signature", async () => {
    const context = setup();
    const heartbeat = JSON.parse(
      readFileSync(
        new URL(
          "../../../contracts/cloudlink/v1/fixtures/heartbeat.valid.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    heartbeat.message_authentication = {
      key_id: "gateway-session-key-17",
      algorithm: "Ed25519",
      signature: messageSignature,
    };
    context.authenticateGatewaySignedUplink.result = {
      ok: true,
      replayed: true,
      value: {
        tenantId,
        projectId,
        gatewayId,
        sessionId,
        sessionEpoch: "7",
        credentialGeneration: "3",
        gatewayKeyId: "gateway-session-key-17",
        messageKind: "heartbeat",
        signingObjectDigest: `sha256:${"b".repeat(64)}`,
        signingProjection: {
          schema: "aether.cloudlink.uplink-signing.v1alpha1",
          gateway_id: gatewayId,
          credential_generation: "3",
          session_id: sessionId,
          session_epoch: "7",
          message_kind: "heartbeat",
          sent_at_ms: "1721000000123",
          expires_at_ms: null,
          stream_id: null,
          stream_epoch: null,
          position: null,
          batch_id: null,
          business_digest: null,
        },
        refreshServerLiveness: false,
      },
    };

    await expect(
      context.bridge.handle({
        topic: `${topicPrefix}/v1/gateways/${gatewayId}/up/heartbeat`,
        payload: new TextEncoder().encode(JSON.stringify(heartbeat)),
      }),
    ).resolves.toEqual({ outcome: "acknowledged" });
    expect(context.heartbeat.calls).toEqual([]);
    const published = JSON.parse(
      new TextDecoder().decode(context.publisher.messages.at(-1)?.payload),
    ) as Record<string, unknown>;
    expect(published.message_kind).toBe("heartbeat-ack");
    expect(published).not.toHaveProperty("message_authentication");
    expect(JSON.stringify(published)).not.toContain(messageSignature);
  });

  it("fails authentication exceptions and conflicts closed before business handling without leaking resolver details", async () => {
    const context = setup();
    context.authenticateGatewaySignedUplink.result = {
      ok: false,
      failure: {
        code: "AUTHENTICATION_INVALID",
        message: `resolver leaked ${messageSignature}`,
      },
    };
    const telemetry = JSON.parse(
      readFileSync(
        new URL(
          "../../../contracts/cloudlink/v1/fixtures/telemetry-batch.valid.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    telemetry.message_authentication = {
      key_id: "gateway-session-key-17",
      algorithm: "Ed25519",
      signature: messageSignature,
    };

    const result = await context.bridge.handle({
      topic: `${topicPrefix}/v1/gateways/${gatewayId}/up/telemetry`,
      payload: new TextEncoder().encode(JSON.stringify(telemetry)),
    });
    expect(result).toEqual({
      outcome: "discarded",
      failure: {
        code: "AUTHENTICATION_INVALID",
        message: "Gateway uplink authentication is invalid",
      },
    });
    expect(context.ingestTelemetry.calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(messageSignature);
  });

  it("requires complete explicit Gateway-signed composition", () => {
    const context = setup();
    const {
      authenticateGatewaySignedUplink: _authenticateGatewaySignedUplink,
      ...partialComposition
    } = context.dependencies;
    void _authenticateGatewaySignedUplink;
    expect(
      () => new CloudLinkMqttApplicationBridge(partialComposition),
    ).toThrow(/complete Gateway-signed session composition/);
  });
});
