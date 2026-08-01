import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { cloudLinkBusinessDigest } from "@aether-cloud/cloudlink-mqtt-adapter";
import { describe, expect, it } from "vitest";

import {
  CloudLinkMqttApplicationBridge,
  type CloudLinkApplicationCommand,
  type CloudLinkBridgeDependencies,
  type CloudLinkCredentialQuery,
  type CloudLinkMqttResponsePublisher,
} from "../src/index.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const gatewayId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const topicPrefix = "aethercloud";
const credential = {
  credentialId: "development-binding-17",
  proof:
    "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
};

function sharedFixture(name: string): Uint8Array {
  return readFileSync(
    new URL(
      `../../../contracts/cloudlink/v1/fixtures/${name}`,
      import.meta.url,
    ),
  );
}

function fixtureObject(name: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(sharedFixture(name))) as Record<
    string,
    unknown
  >;
}

function integrationFixture(name: string): Uint8Array {
  return readFileSync(
    new URL(
      `../../../contracts/aether-contracts/v0.1.0-alpha.4/fixtures/cloudlink-integration/v1alpha1/${name}`,
      import.meta.url,
    ),
  );
}

function inbound(
  route:
    | "data-loss"
    | "heartbeat"
    | "integration/observations"
    | "integration/topology"
    | "manifest"
    | "session"
    | "telemetry",
  body: Uint8Array = sharedFixture(`${route}.valid.json`),
) {
  return {
    topic: `${topicPrefix}/v1/gateways/${gatewayId}/up/${route}`,
    payload: body,
  };
}

class RecordingPublisher implements CloudLinkMqttResponsePublisher {
  readonly messages: Array<{ readonly topic: string; readonly body: unknown }> =
    [];

  publish(topic: string, payload: Uint8Array): Promise<void> {
    this.messages.push({
      topic,
      body: JSON.parse(new TextDecoder().decode(payload)) as unknown,
    });
    return Promise.resolve();
  }
}

class StubCommand implements CloudLinkApplicationCommand {
  readonly calls: Array<{
    readonly context: unknown;
    readonly input: unknown;
  }> = [];
  result: unknown;

  constructor(result: unknown) {
    this.result = result;
  }

  execute(context: unknown, input: unknown): Promise<unknown> {
    this.calls.push({ context, input });
    if (typeof this.result === "function") {
      return Promise.resolve(
        (this.result as (context: unknown, input: unknown) => unknown)(
          context,
          input,
        ),
      );
    }
    return Promise.resolve(this.result);
  }
}

class StubCredentialQuery implements CloudLinkCredentialQuery {
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

function record(input: unknown, field: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError(`${field} must be a test object`);
  }
  return input as Record<string, unknown>;
}

function integrationReceipt(
  kind: "observations" | "topology",
  context: unknown,
  input: unknown,
): Record<string, unknown> {
  const commandContext = record(context, "command context");
  const commandInput = record(input, "command input");
  return {
    kind,
    tenantId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    gatewayId,
    integrationId: commandInput.integrationId,
    credentialGeneration: "3",
    requestId: commandContext.idempotencyKey,
    payloadDigest: "1".repeat(64),
    snapshotGeneration: commandInput.snapshotGeneration,
    ...(kind === "observations" ? { batchId: commandInput.batchId } : {}),
    revision: kind === "topology" ? 1 : 2,
    auditEventId: `audit:integration-${kind}:test`,
    outboxEventId: `outbox:integration-${kind}:test`,
    committedAt: "2024-07-14T23:33:20.400Z",
  };
}

function integrationDurableAcknowledgement(
  input: unknown,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const commandInput = record(input, "command input");
  const delivery = record(commandInput.cloudLinkDelivery, "CloudLink delivery");
  return {
    outboxEventId: "outbox:integration-ack:test",
    receiptId: "receipt:integration-ack:test",
    tenantId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    gatewayId,
    integrationId: commandInput.integrationId,
    sessionId: delivery.sessionId,
    sessionEpoch: delivery.sessionEpoch,
    credentialGeneration: delivery.credentialGeneration,
    streamId: delivery.streamId,
    streamEpoch: delivery.streamEpoch,
    acknowledgedPosition: delivery.position,
    batchId: delivery.batchId,
    digest: delivery.digest,
    messageKind: delivery.messageKind,
    acknowledgedAt: "2024-07-14T23:33:20.400Z",
    ...overrides,
  };
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = record(value, "canonical value");
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function extensionManifest(): Uint8Array {
  const envelope = fixtureObject("runtime-manifest-report.valid.json");
  const manifestPayload = record(envelope.payload, "manifest payload");
  const manifest = record(manifestPayload.manifest, "manifest");
  const protocols = manifest.protocols;
  if (!Array.isArray(protocols)) {
    throw new TypeError("manifest protocols must be an array");
  }
  protocols.push("aether.cloudlink.integration.v1alpha1");
  protocols.sort();
  const unsigned = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== "checksum"),
  );
  record(manifest.checksum, "manifest checksum").digest = createHash("sha256")
    .update(canonicalJson(unsigned))
    .digest("hex");
  record(envelope.delivery, "delivery").digest = cloudLinkBusinessDigest(
    "runtime-manifest-report",
    manifestPayload as never,
  );
  return new TextEncoder().encode(JSON.stringify(envelope));
}

function trustedConnectorSessionHello(): Uint8Array {
  const envelope = fixtureObject("session-hello.valid.json");
  const binding = record(envelope.credential_binding, "credential binding");
  binding.origin_model = "trusted-connector-broker-attestation";
  delete envelope.gateway_key_id;
  delete envelope.gateway_signature;
  return new TextEncoder().encode(JSON.stringify(envelope));
}

function testContext(
  options?: Readonly<{
    integrationEnabled?: boolean;
    omitTrustedConnectorCredential?: boolean;
    omitRestoreRuntimeProtocols?: boolean;
    resolveTrustedConnectorCredential?: CloudLinkCredentialQuery;
    restoreRuntimeProtocolsResult?: unknown;
  }>,
) {
  const publisher = new RecordingPublisher();
  const openSession = new StubCommand({
    ok: true,
    replayed: false,
    value: {
      gatewayId,
      tenantId,
      projectId,
      sessionId,
      credentialGeneration: "3",
      epoch: "7",
      state: "active",
      protocolVersion: "1.0",
      resumeCursors: [
        { streamId: "manifest", streamEpoch: "1", position: "7" },
      ],
    },
  });
  const heartbeat = new StubCommand({ ok: true, value: { state: "active" } });
  const reportManifest = new StubCommand({
    ok: true,
    value: { disposition: "accepted-latest" },
  });
  const recordDurableCursor = new StubCommand({
    ok: true,
    replayed: false,
    value: { streamId: "manifest", streamEpoch: "1", position: "1" },
  });
  const ingestTelemetry = new StubCommand({
    ok: true,
    value: {
      disposition: "persisted",
      durablyAcknowledged: true,
      receipt: { receiptId: "receipt:telemetry:telemetry:4:19" },
    },
  });
  const reportIntegrationTopology = new StubCommand(
    (context: unknown, input: unknown) => ({
      ok: true,
      replayed: false,
      value: {
        disposition: "persisted",
        receipt: integrationReceipt("topology", context, input),
        durableAcknowledgement: integrationDurableAcknowledgement(input),
      },
    }),
  );
  const reportIntegrationObservations = new StubCommand(
    (context: unknown, input: unknown) => ({
      ok: true,
      replayed: false,
      value: {
        disposition: "persisted",
        receipt: integrationReceipt("observations", context, input),
        durableAcknowledgement: integrationDurableAcknowledgement(input),
      },
    }),
  );
  const restoreRuntimeProtocols = new StubCredentialQuery(
    options?.restoreRuntimeProtocolsResult ?? {
      ok: true,
      value: {
        status: "absent",
        tenantId,
        projectId,
        gatewayId,
        credentialGeneration: "3",
      },
    },
  );
  const defaultTrustedConnectorCredential = new StubCredentialQuery({
    ok: true,
    value: credential,
  });
  const dependencies: CloudLinkBridgeDependencies = {
    topicPrefix,
    publisher,
    openSession,
    heartbeat,
    reportManifest,
    recordDurableCursor,
    ingestTelemetry,
    reportIntegrationTopology,
    reportIntegrationObservations,
    ...(options?.omitTrustedConnectorCredential === true
      ? {}
      : {
          resolveTrustedConnectorCredential:
            options?.resolveTrustedConnectorCredential ??
            defaultTrustedConnectorCredential,
        }),
    ...(options?.integrationEnabled === true
      ? {
          enabledExtensions: ["aether.cloudlink.integration.v1alpha1" as const],
          ...(options.omitRestoreRuntimeProtocols === true
            ? {}
            : { restoreRuntimeProtocols }),
        }
      : {}),
    clock: { now: () => "2024-07-14T23:33:20.400Z" },
  };
  return {
    bridge: new CloudLinkMqttApplicationBridge(dependencies),
    heartbeat,
    ingestTelemetry,
    openSession,
    publisher,
    recordDurableCursor,
    reportIntegrationObservations,
    reportIntegrationTopology,
    reportManifest,
    restoreRuntimeProtocols,
  };
}

async function open(context: ReturnType<typeof testContext>) {
  return context.bridge.handle(
    inbound("session", trustedConnectorSessionHello()),
  );
}

describe("CloudLink MQTT product application bridge", () => {
  it("rejects trusted-connector sessions when no external attestation resolver is configured", async () => {
    const context = testContext({ omitTrustedConnectorCredential: true });

    await expect(
      context.bridge.handle(inbound("session", trustedConnectorSessionHello())),
    ).resolves.toMatchObject({
      outcome: "discarded",
      failure: { code: "authentication-evidence-missing" },
    });
    expect(context.openSession.calls).toEqual([]);
    expect(context.publisher.messages).toEqual([]);
  });

  it("accepts trusted-connector sessions only with explicit matching external attestation", async () => {
    const resolver = new StubCredentialQuery({
      ok: true,
      value: credential,
    });
    const context = testContext({
      resolveTrustedConnectorCredential: resolver,
    });

    await expect(
      context.bridge.handle(inbound("session", trustedConnectorSessionHello())),
    ).resolves.toEqual({ outcome: "acknowledged" });
    expect(resolver.calls).toEqual([
      {
        gatewayId,
        credentialId: credential.credentialId,
        credentialGeneration: "3",
      },
    ]);
    expect(context.openSession.calls[0]?.input).toMatchObject({ credential });
  });

  it("rejects trusted-connector attestation bound to another credential without leaking proof", async () => {
    const resolver = new StubCredentialQuery({
      ok: true,
      value: {
        credentialId: "another-development-binding",
        proof: credential.proof,
      },
    });
    const context = testContext({
      resolveTrustedConnectorCredential: resolver,
    });

    const result = await context.bridge.handle(
      inbound("session", trustedConnectorSessionHello()),
    );
    expect(result).toMatchObject({
      outcome: "discarded",
      failure: { code: "authentication-evidence-missing" },
    });
    expect(JSON.stringify(result)).not.toContain(credential.proof);
    expect(context.openSession.calls).toEqual([]);
    expect(context.publisher.messages).toEqual([]);
  });

  it("opens the shared hello and emits the shared session vocabulary", async () => {
    const context = testContext();
    await expect(open(context)).resolves.toEqual({ outcome: "acknowledged" });
    const opaqueRequestId = record(
      context.openSession.calls[0]?.context,
      "session command context",
    ).idempotencyKey;
    expect(opaqueRequestId).toMatch(/^cloudlink:session:[0-9a-f]{64}$/);

    expect(context.openSession.calls).toEqual([
      {
        context: {
          idempotencyKey: opaqueRequestId,
          issuedAt: "2024-07-14T23:33:20.400Z",
          expiresAt: "2024-07-14T23:38:20.400Z",
        },
        input: {
          credential,
          protocolVersions: ["1.0"],
          clientPositions: [
            { streamId: "telemetry", streamEpoch: "4", position: "18" },
          ],
        },
      },
    ]);
    expect(context.publisher.messages).toMatchObject([
      {
        topic: `${topicPrefix}/v1/gateways/${gatewayId}/down/session`,
        body: {
          schema: "aether.cloudlink.session-accepted.v1",
          message_kind: "session-accepted",
          gateway_id: gatewayId,
          session_id: sessionId,
          session_epoch: "7",
          credential_generation: "3",
          resume: [
            {
              stream_id: "manifest",
              stream_epoch: "1",
              acknowledged_position: "7",
            },
          ],
        },
      },
    ]);
  });

  it("keeps equal Gateway UUIDs isolated by accepted Tenant and Project scope", async () => {
    const context = testContext();
    await expect(open(context)).resolves.toEqual({ outcome: "acknowledged" });
    context.openSession.result = {
      ok: true,
      replayed: false,
      value: {
        gatewayId,
        tenantId: "77777777-7777-4777-8777-777777777777",
        projectId: "88888888-8888-4888-8888-888888888888",
        sessionId: "99999999-9999-4999-8999-999999999999",
        credentialGeneration: "3",
        epoch: "1",
        state: "active",
        protocolVersion: "1.0",
        resumeCursors: [],
      },
    };
    const secondHello = JSON.parse(
      new TextDecoder().decode(trustedConnectorSessionHello()),
    ) as Record<string, unknown>;
    secondHello.client_nonce = "Z".repeat(43);

    await expect(
      context.bridge.handle(
        inbound(
          "session",
          new TextEncoder().encode(JSON.stringify(secondHello)),
        ),
      ),
    ).resolves.toEqual({ outcome: "acknowledged" });
    context.publisher.messages.length = 0;

    await expect(
      context.bridge.handle(
        inbound("heartbeat", sharedFixture("heartbeat.valid.json")),
      ),
    ).resolves.toEqual({ outcome: "acknowledged" });
    expect(context.heartbeat.calls).toHaveLength(1);
  });

  it("uses an opaque stable digest instead of a client nonce as the application idempotency key", async () => {
    const hello = JSON.parse(
      new TextDecoder().decode(trustedConnectorSessionHello()),
    ) as Record<string, unknown>;
    hello.client_nonce = `_${"A".repeat(42)}`;
    const context = testContext();

    await expect(
      context.bridge.handle(
        inbound("session", new TextEncoder().encode(JSON.stringify(hello))),
      ),
    ).resolves.toEqual({ outcome: "acknowledged" });
    const commandContext = record(
      context.openSession.calls[0]?.context,
      "session command context",
    );
    expect(commandContext.idempotencyKey).toMatch(
      /^cloudlink:session:[0-9a-f]{64}$/,
    );
    expect(commandContext.idempotencyKey).not.toContain(`_${"A".repeat(42)}`);
  });

  it("maps shared heartbeat, manifest, and point facts then emits exact durable ACK identity", async () => {
    const context = testContext();
    await open(context);
    context.publisher.messages.length = 0;

    await expect(
      context.bridge.handle(
        inbound("heartbeat", sharedFixture("heartbeat.valid.json")),
      ),
    ).resolves.toEqual({ outcome: "acknowledged" });
    await expect(
      context.bridge.handle(
        inbound(
          "manifest",
          sharedFixture("runtime-manifest-report.valid.json"),
        ),
      ),
    ).resolves.toEqual({ outcome: "acknowledged" });
    await expect(
      context.bridge.handle(
        inbound("telemetry", sharedFixture("telemetry-batch.valid.json")),
      ),
    ).resolves.toEqual({ outcome: "acknowledged" });

    expect(context.heartbeat.calls[0]?.input).toEqual({
      credential,
      sessionId,
      sessionEpoch: "7",
    });
    expect(context.reportManifest.calls[0]?.input).toMatchObject({
      credential,
      generation: "1",
      observedAt: "2024-07-14T23:33:20.123Z",
    });
    expect(context.recordDurableCursor.calls).toEqual([
      {
        context: {
          idempotencyKey: "cursor:manifest:2:1",
          issuedAt: "2024-07-14T23:33:20.400Z",
          expiresAt: "2024-07-14T23:38:20.400Z",
        },
        input: {
          credential,
          sessionId,
          sessionEpoch: "7",
          streamId: "manifest",
          streamEpoch: "2",
          position: "1",
        },
      },
    ]);
    expect(context.ingestTelemetry.calls[0]?.input).toMatchObject({
      credential,
      streamId: "telemetry",
      streamEpoch: "4",
      durableAcknowledgement: {
        sessionId,
        sessionEpoch: "7",
        credentialGeneration: "3",
        streamId: "telemetry",
        streamEpoch: "4",
        acknowledgedPosition: "19",
        acceptedTelemetryPosition: "18",
        batchId: "batch-1",
        digest:
          "sha256:397dafb32f984e975221bb3aa13481808692d24850a201be8818dd1517f38c35",
      },
      topology: {
        publicationEpoch: "11",
        snapshotDigest: "fx64:0123456789abcdef",
      },
      records: [
        {
          position: "18",
          sourceTimestampMs: "1721000000123",
          instanceId: "42",
          pointKind: "telemetry",
          pointId: "8",
          quality: "uncertain",
          value: { type: "float64", value: 12.5 },
        },
      ],
    });
    expect(
      context.publisher.messages.map((message) => message.body),
    ).toMatchObject([
      { message_kind: "heartbeat-ack", session_epoch: "7" },
      {
        message_kind: "durable-ack",
        stream_id: "manifest",
        acknowledged_position: "1",
        batch_id: "manifest-75643d71",
      },
      {
        message_kind: "durable-ack",
        stream_id: "telemetry",
        stream_epoch: "4",
        acknowledged_position: "19",
        batch_id: "batch-1",
        digest:
          "sha256:397dafb32f984e975221bb3aa13481808692d24850a201be8818dd1517f38c35",
      },
    ]);
  });

  it("fences a structurally valid stale session without invoking commands", async () => {
    const context = testContext();
    await open(context);
    context.publisher.messages.length = 0;
    const heartbeat = fixtureObject("heartbeat.valid.json");
    heartbeat.session_epoch = "6";

    await expect(
      context.bridge.handle(
        inbound(
          "heartbeat",
          new TextEncoder().encode(JSON.stringify(heartbeat)),
        ),
      ),
    ).resolves.toEqual({ outcome: "rejected" });
    expect(context.heartbeat.calls).toHaveLength(0);
    expect(context.publisher.messages).toEqual([]);
  });

  it("fails honestly until Cloud batch-level indexing supports multiple samples", async () => {
    const context = testContext();
    await open(context);
    const envelope = fixtureObject("telemetry-batch.valid.json");
    const businessPayload = envelope.payload as {
      samples: Array<Record<string, unknown>>;
      topology: Record<string, unknown>;
    };
    businessPayload.samples.push({ ...businessPayload.samples[0] });
    const delivery = envelope.delivery as Record<string, unknown>;
    delivery.digest = cloudLinkBusinessDigest(
      "telemetry-batch",
      businessPayload as never,
    );

    await expect(
      context.bridge.handle(
        inbound(
          "telemetry",
          new TextEncoder().encode(JSON.stringify(envelope)),
        ),
      ),
    ).resolves.toMatchObject({
      outcome: "discarded",
      failure: { code: "cloud-telemetry-position-model-pending" },
    });
    expect(context.ingestTelemetry.calls).toHaveLength(0);
  });

  it("does not leak rejected session proof material", async () => {
    const context = testContext();
    context.openSession.result = {
      ok: false,
      failure: {
        code: "invalid-gateway-credential",
        message: "Gateway credential was rejected",
      },
    };

    const result = await open(context);
    expect(result).toMatchObject({
      outcome: "discarded",
      failure: { code: "invalid-gateway-credential" },
    });
    expect(JSON.stringify(result)).not.toContain(credential.proof);
    expect(context.publisher.messages).toEqual([]);
  });

  it("never emits a durable ACK for a non-durable application result", async () => {
    const context = testContext();
    await open(context);
    context.publisher.messages.length = 0;
    context.ingestTelemetry.result = {
      ok: true,
      value: { disposition: "buffered", durablyAcknowledged: false },
    };

    await expect(
      context.bridge.handle(
        inbound("telemetry", sharedFixture("telemetry-batch.valid.json")),
      ),
    ).resolves.toEqual({ outcome: "rejected" });
    expect(context.publisher.messages).toEqual([]);
  });

  it("publishes the exact acknowledgement projection returned by durable persistence", async () => {
    const context = testContext();
    await open(context);
    context.publisher.messages.length = 0;
    context.ingestTelemetry.result = {
      ok: true,
      value: {
        disposition: "persisted",
        durablyAcknowledged: true,
        receipt: { receiptId: "receipt:telemetry:stored" },
        durableAcknowledgement: {
          outboxEventId: "outbox:cloudlink-ack:stored",
          tenantId: "11111111-1111-4111-8111-111111111111",
          projectId: "22222222-2222-4222-8222-222222222222",
          gatewayId,
          sessionId,
          sessionEpoch: "7",
          credentialGeneration: "3",
          streamId: "telemetry",
          streamEpoch: "4",
          acknowledgedPosition: "19",
          batchId: "batch-1",
          digest:
            "sha256:397dafb32f984e975221bb3aa13481808692d24850a201be8818dd1517f38c35",
          receiptId: "receipt:cloudlink:stored",
          acknowledgedAt: "2024-07-14T23:33:20.123Z",
        },
      },
    };

    await expect(
      context.bridge.handle(
        inbound("telemetry", sharedFixture("telemetry-batch.valid.json")),
      ),
    ).resolves.toEqual({ outcome: "acknowledged" });
    expect(context.publisher.messages).toMatchObject([
      {
        body: {
          message_kind: "durable-ack",
          receipt_id: "receipt:cloudlink:stored",
          acknowledged_at_ms: "1721000000123",
        },
      },
    ]);
  });

  it("withholds the manifest ACK when application cursor recording fails", async () => {
    const context = testContext();
    await open(context);
    context.publisher.messages.length = 0;
    context.recordDurableCursor.result = {
      ok: false,
      failure: { code: "stale-cloudlink-session-epoch", message: "stale" },
    };

    await expect(
      context.bridge.handle(
        inbound(
          "manifest",
          sharedFixture("runtime-manifest-report.valid.json"),
        ),
      ),
    ).resolves.toEqual({ outcome: "rejected" });
    expect(context.publisher.messages).toEqual([]);
  });

  it("rejects expiry equality before invoking application persistence", async () => {
    const context = testContext();
    await open(context);
    context.publisher.messages.length = 0;
    const envelope = fixtureObject("telemetry-batch.valid.json");
    envelope.expires_at_ms = "1721000000400";

    await expect(
      context.bridge.handle(
        inbound(
          "telemetry",
          new TextEncoder().encode(JSON.stringify(envelope)),
        ),
      ),
    ).resolves.toMatchObject({
      outcome: "discarded",
      failure: { code: "message-expired" },
    });
    expect(context.ingestTelemetry.calls).toHaveLength(0);
    expect(context.publisher.messages).toEqual([]);
  });

  it("does not emit a cumulative ACK across an unresolved position gap", async () => {
    const context = testContext();
    await open(context);
    context.publisher.messages.length = 0;
    context.ingestTelemetry.result = {
      ok: true,
      value: {
        disposition: "persisted",
        durablyAcknowledged: true,
        receipt: {
          receiptId: "receipt:gap",
          gap: { expectedPosition: "1", receivedPosition: "19" },
        },
      },
    };

    await expect(
      context.bridge.handle(
        inbound("telemetry", sharedFixture("telemetry-batch.valid.json")),
      ),
    ).resolves.toEqual({ outcome: "rejected" });
    expect(context.publisher.messages).toEqual([]);
  });

  it("keeps the Integration extension deny-by-default", async () => {
    const context = testContext();
    await open(context);

    await expect(
      context.bridge.handle(
        inbound(
          "integration/topology",
          integrationFixture("integration-topology.valid.json"),
        ),
      ),
    ).resolves.toMatchObject({
      outcome: "discarded",
      failure: { code: "unsupported-message" },
    });
    expect(context.reportIntegrationTopology.calls).toEqual([]);
  });

  it("requires credential-authenticated Runtime Manifest restoration when Integration is enabled", () => {
    expect(() =>
      testContext({
        integrationEnabled: true,
        omitRestoreRuntimeProtocols: true,
      }),
    ).toThrow(/Runtime Manifest protocol restoration/);
  });

  it("requires the accepted runtime manifest to declare the enabled Integration extension", async () => {
    const context = testContext({ integrationEnabled: true });
    await open(context);

    await expect(
      context.bridge.handle(
        inbound(
          "integration/topology",
          integrationFixture("integration-topology.valid.json"),
        ),
      ),
    ).resolves.toMatchObject({
      outcome: "discarded",
      failure: { code: "integration-extension-not-declared" },
    });
    expect(context.reportIntegrationTopology.calls).toEqual([]);
    expect(context.restoreRuntimeProtocols.calls).toEqual([{ credential }]);
  });

  it("restores a persisted Integration declaration before accepting a new session", async () => {
    const context = testContext({
      integrationEnabled: true,
      restoreRuntimeProtocolsResult: {
        ok: true,
        value: {
          status: "present",
          tenantId,
          projectId,
          gatewayId,
          credentialGeneration: "3",
          manifestGeneration: "7",
          protocols: ["aether.cloudlink.integration.v1alpha1"],
        },
      },
    });

    await expect(open(context)).resolves.toEqual({ outcome: "acknowledged" });
    await expect(
      context.bridge.handle(
        inbound(
          "integration/topology",
          integrationFixture("integration-topology.valid.json"),
        ),
      ),
    ).resolves.toEqual({ outcome: "acknowledged" });

    expect(context.restoreRuntimeProtocols.calls).toEqual([{ credential }]);
    expect(context.reportIntegrationTopology.calls).toHaveLength(1);
  });

  it("does not activate a session when protocol restoration authentication fails", async () => {
    const context = testContext({
      integrationEnabled: true,
      restoreRuntimeProtocolsResult: {
        ok: false,
        failure: {
          code: "invalid-gateway-credential",
          message: "Gateway credential was rejected",
        },
      },
    });

    await expect(open(context)).resolves.toMatchObject({
      outcome: "discarded",
      failure: { code: "invalid-gateway-credential" },
    });
    expect(context.publisher.messages).toEqual([]);
    await expect(
      context.bridge.handle(
        inbound(
          "integration/topology",
          integrationFixture("integration-topology.valid.json"),
        ),
      ),
    ).resolves.toEqual({ outcome: "rejected" });
  });

  it("removes the fenced local session when restoration fails during reconnect", async () => {
    const context = testContext({
      integrationEnabled: true,
      restoreRuntimeProtocolsResult: {
        ok: true,
        value: {
          status: "present",
          tenantId,
          projectId,
          gatewayId,
          credentialGeneration: "3",
          manifestGeneration: "7",
          protocols: ["aether.cloudlink.integration.v1alpha1"],
        },
      },
    });
    await expect(open(context)).resolves.toEqual({ outcome: "acknowledged" });
    context.restoreRuntimeProtocols.result = {
      ok: false,
      failure: {
        code: "invalid-gateway-credential",
        message: "Gateway credential was rejected",
      },
    };

    await expect(open(context)).resolves.toMatchObject({
      outcome: "discarded",
      failure: { code: "invalid-gateway-credential" },
    });
    await expect(
      context.bridge.handle(
        inbound(
          "integration/topology",
          integrationFixture("integration-topology.valid.json"),
        ),
      ),
    ).resolves.toEqual({ outcome: "rejected" });
  });

  it("rejects forged Runtime Manifest restoration identity and protocol values", async () => {
    const forgedIdentity = testContext({
      integrationEnabled: true,
      restoreRuntimeProtocolsResult: {
        ok: true,
        value: {
          status: "present",
          tenantId,
          projectId,
          gatewayId: "99999999-9999-4999-8999-999999999999",
          credentialGeneration: "3",
          manifestGeneration: "7",
          protocols: ["aether.cloudlink.integration.v1alpha1"],
        },
      },
    });
    const malformedProtocols = testContext({
      integrationEnabled: true,
      restoreRuntimeProtocolsResult: {
        ok: true,
        value: {
          status: "present",
          tenantId,
          projectId,
          gatewayId,
          credentialGeneration: "3",
          manifestGeneration: "7",
          protocols: ["aether.cloudlink.integration.v1alpha1", 42],
        },
      },
    });

    await expect(open(forgedIdentity)).resolves.toMatchObject({
      outcome: "discarded",
      failure: { code: "invalid-runtime-protocol-restoration" },
    });
    await expect(open(malformedProtocols)).resolves.toMatchObject({
      outcome: "discarded",
      failure: { code: "invalid-runtime-protocol-restoration" },
    });
    expect(forgedIdentity.publisher.messages).toEqual([]);
    expect(malformedProtocols.publisher.messages).toEqual([]);
  });

  it("maps pinned topology and observations into durable application reports and exact ACKs", async () => {
    const context = testContext({ integrationEnabled: true });
    await open(context);
    await expect(
      context.bridge.handle(inbound("manifest", extensionManifest())),
    ).resolves.toEqual({ outcome: "acknowledged" });
    context.publisher.messages.length = 0;
    context.recordDurableCursor.calls.length = 0;

    await expect(
      context.bridge.handle(
        inbound(
          "integration/topology",
          integrationFixture("integration-topology.valid.json"),
        ),
      ),
    ).resolves.toEqual({ outcome: "acknowledged" });
    await expect(
      context.bridge.handle(
        inbound(
          "integration/observations",
          integrationFixture("integration-observations.valid.json"),
        ),
      ),
    ).resolves.toEqual({ outcome: "acknowledged" });

    expect(context.reportIntegrationTopology.calls).toHaveLength(1);
    const topologyContext = record(
      context.reportIntegrationTopology.calls[0]?.context,
      "topology command context",
    );
    expect(topologyContext.idempotencyKey).toBeTypeOf("string");
    expect(topologyContext.idempotencyKey).toMatch(/^cloudlink:[0-9a-f]{64}$/);
    expect(context.reportIntegrationTopology.calls[0]?.input).toMatchObject({
      credential,
      integrationId: "home-assistant.home",
      integrationKind: "home-assistant",
      snapshotGeneration: "1",
      cloudLinkDelivery: {
        sessionId,
        sessionEpoch: "7",
        credentialGeneration: "3",
        streamId: "integration-topology-home",
        streamEpoch: "1",
        position: "1",
        batchId: "topology-1",
        digest:
          "sha256:32193a4724adc86e721802aca209e68438b7baf433b2f6c01565c0a82767f146",
        messageKind: "integration-topology-snapshot",
      },
    });
    expect(
      context.reportIntegrationTopology.calls[0]?.input,
    ).not.toHaveProperty("gatewayId");
    expect(context.reportIntegrationObservations.calls).toHaveLength(1);
    expect(context.reportIntegrationObservations.calls[0]?.input).toMatchObject(
      {
        credential,
        integrationId: "home-assistant.home",
        snapshotGeneration: "1",
        batchId: "batch-0001",
        cloudLinkDelivery: {
          streamId: "integration-observations-home",
          streamEpoch: "1",
          position: "1",
          batchId: "batch-0001",
          digest:
            "sha256:051b0291d257084052a86c90b163b191b72f10d6093789c132180a69226494b6",
          messageKind: "integration-observation-batch",
        },
      },
    );
    const observationInput = record(
      context.reportIntegrationObservations.calls[0]?.input,
      "observation command input",
    );
    if (!Array.isArray(observationInput.observations)) {
      throw new TypeError("observation command must contain observations");
    }
    expect(observationInput.observations[0]).toMatchObject({
      entityId: "entity-registry-climate-living",
      pointKey: "current_temperature",
      value: { type: "float64", value: 23.5 },
    });

    expect(context.recordDurableCursor.calls).toHaveLength(0);
    expect(
      context.publisher.messages.map((message) => message.body),
    ).toMatchObject([
      {
        message_kind: "durable-ack",
        stream_id: "integration-topology-home",
        acknowledged_position: "1",
        batch_id: "topology-1",
      },
      {
        message_kind: "durable-ack",
        stream_id: "integration-observations-home",
        acknowledged_position: "1",
        batch_id: "batch-0001",
      },
    ]);
    for (const publication of context.publisher.messages) {
      expect(record(publication.body, "published ACK").receipt_id).toBe(
        "receipt:integration-ack:test",
      );
    }
  });

  it("withholds Integration cursor and ACK when the projection receipt is not closed", async () => {
    const context = testContext({ integrationEnabled: true });
    await open(context);
    await context.bridge.handle(inbound("manifest", extensionManifest()));
    context.publisher.messages.length = 0;
    context.recordDurableCursor.calls.length = 0;
    context.reportIntegrationTopology.result = {
      ok: true,
      replayed: false,
      value: { disposition: "persisted" },
    };

    await expect(
      context.bridge.handle(
        inbound(
          "integration/topology",
          integrationFixture("integration-topology.valid.json"),
        ),
      ),
    ).resolves.toEqual({ outcome: "rejected" });
    expect(context.recordDurableCursor.calls).toEqual([]);
    expect(context.publisher.messages).toEqual([]);
  });

  it("does not use the separate cursor command after atomic Integration persistence", async () => {
    const context = testContext({ integrationEnabled: true });
    await open(context);
    await context.bridge.handle(inbound("manifest", extensionManifest()));
    context.publisher.messages.length = 0;
    context.recordDurableCursor.calls.length = 0;
    context.recordDurableCursor.result = {
      ok: false,
      failure: { code: "cursor-storage-unavailable", message: "unavailable" },
    };

    await expect(
      context.bridge.handle(
        inbound(
          "integration/topology",
          integrationFixture("integration-topology.valid.json"),
        ),
      ),
    ).resolves.toEqual({ outcome: "acknowledged" });
    expect(context.recordDurableCursor.calls).toEqual([]);
    expect(context.publisher.messages).toHaveLength(1);
  });

  it("accepts an exact replay from an older credential only with a current-session durable ACK", async () => {
    const context = testContext({ integrationEnabled: true });
    await open(context);
    await context.bridge.handle(inbound("manifest", extensionManifest()));
    context.publisher.messages.length = 0;
    context.reportIntegrationTopology.result = (
      commandContext: unknown,
      input: unknown,
    ) => ({
      ok: true,
      replayed: true,
      value: {
        disposition: "replayed",
        receipt: {
          ...integrationReceipt("topology", commandContext, input),
          credentialGeneration: "2",
        },
        durableAcknowledgement: integrationDurableAcknowledgement(input),
      },
    });

    await expect(
      context.bridge.handle(
        inbound(
          "integration/topology",
          integrationFixture("integration-topology.valid.json"),
        ),
      ),
    ).resolves.toEqual({ outcome: "acknowledged" });
    expect(context.publisher.messages).toHaveLength(1);
  });

  it("rejects an older business receipt for a new persist or without an exact current ACK", async () => {
    const cases = [
      {
        disposition: "persisted",
        receiptCredentialGeneration: "2",
        includeAcknowledgement: true,
      },
      {
        disposition: "replayed",
        receiptCredentialGeneration: "2",
        includeAcknowledgement: false,
      },
      {
        disposition: "replayed",
        receiptCredentialGeneration: "4",
        includeAcknowledgement: true,
      },
      {
        disposition: "replayed",
        receiptCredentialGeneration: "0",
        includeAcknowledgement: true,
      },
    ] as const;

    for (const candidate of cases) {
      const context = testContext({ integrationEnabled: true });
      await open(context);
      await context.bridge.handle(inbound("manifest", extensionManifest()));
      context.publisher.messages.length = 0;
      context.reportIntegrationTopology.result = (
        commandContext: unknown,
        input: unknown,
      ) => ({
        ok: true,
        replayed: candidate.disposition === "replayed",
        value: {
          disposition: candidate.disposition,
          receipt: {
            ...integrationReceipt("topology", commandContext, input),
            credentialGeneration: candidate.receiptCredentialGeneration,
          },
          ...(candidate.includeAcknowledgement
            ? {
                durableAcknowledgement:
                  integrationDurableAcknowledgement(input),
              }
            : {}),
        },
      });

      await expect(
        context.bridge.handle(
          inbound(
            "integration/topology",
            integrationFixture("integration-topology.valid.json"),
          ),
        ),
      ).resolves.toEqual({ outcome: "rejected" });
      expect(context.publisher.messages).toEqual([]);
    }
  });

  it("defers an out-of-order Integration delivery when persistence has not advanced a contiguous ACK", async () => {
    const context = testContext({ integrationEnabled: true });
    await open(context);
    await context.bridge.handle(inbound("manifest", extensionManifest()));
    context.publisher.messages.length = 0;
    context.reportIntegrationTopology.result = (
      commandContext: unknown,
      input: unknown,
    ) => ({
      ok: true,
      replayed: false,
      value: {
        disposition: "persisted",
        receipt: integrationReceipt("topology", commandContext, input),
      },
    });

    await expect(
      context.bridge.handle(
        inbound(
          "integration/topology",
          integrationFixture("integration-topology.valid.json"),
        ),
      ),
    ).resolves.toEqual({ outcome: "deferred" });
    expect(context.publisher.messages).toEqual([]);
  });

  it("rejects an ACK that skips beyond the exact delivery even when the repository claims a later cursor", async () => {
    const context = testContext({ integrationEnabled: true });
    await open(context);
    await context.bridge.handle(inbound("manifest", extensionManifest()));
    context.publisher.messages.length = 0;
    context.reportIntegrationTopology.result = (
      commandContext: unknown,
      input: unknown,
    ) => ({
      ok: true,
      replayed: false,
      value: {
        disposition: "persisted",
        receipt: integrationReceipt("topology", commandContext, input),
        durableAcknowledgement: integrationDurableAcknowledgement(input, {
          acknowledgedPosition: "2",
          batchId: "topology-2",
          digest: `sha256:${"c".repeat(64)}`,
        }),
      },
    });

    await expect(
      context.bridge.handle(
        inbound(
          "integration/topology",
          integrationFixture("integration-topology.valid.json"),
        ),
      ),
    ).resolves.toEqual({ outcome: "rejected" });
    expect(context.publisher.messages).toEqual([]);
  });

  it("rejects a repository ACK that is not bound to the current session", async () => {
    const context = testContext({ integrationEnabled: true });
    await open(context);
    await context.bridge.handle(inbound("manifest", extensionManifest()));
    context.publisher.messages.length = 0;
    context.reportIntegrationTopology.result = (
      commandContext: unknown,
      input: unknown,
    ) => ({
      ok: true,
      replayed: false,
      value: {
        disposition: "persisted",
        receipt: integrationReceipt("topology", commandContext, input),
        durableAcknowledgement: integrationDurableAcknowledgement(input, {
          sessionEpoch: "8",
        }),
      },
    });

    await expect(
      context.bridge.handle(
        inbound(
          "integration/topology",
          integrationFixture("integration-topology.valid.json"),
        ),
      ),
    ).resolves.toEqual({ outcome: "rejected" });
    expect(context.publisher.messages).toEqual([]);
  });

  it("rejects reuse of one Integration stream epoch for another Integration", async () => {
    const context = testContext({ integrationEnabled: true });
    await open(context);
    await context.bridge.handle(inbound("manifest", extensionManifest()));
    await context.bridge.handle(
      inbound(
        "integration/topology",
        integrationFixture("integration-topology.valid.json"),
      ),
    );
    const conflicting = JSON.parse(
      new TextDecoder().decode(
        integrationFixture("integration-topology.valid.json"),
      ),
    ) as Record<string, unknown>;
    const payload = record(conflicting.payload, "integration payload");
    payload.integration_id = "home-assistant.other";
    const delivery = record(conflicting.delivery, "integration delivery");
    delivery.position = "2";
    delivery.digest = cloudLinkBusinessDigest(
      "integration-topology-snapshot",
      payload,
    );

    await expect(
      context.bridge.handle(
        inbound(
          "integration/topology",
          new TextEncoder().encode(JSON.stringify(conflicting)),
        ),
      ),
    ).resolves.toMatchObject({
      outcome: "discarded",
      failure: { code: "integration-stream-binding-conflict" },
    });
    expect(context.reportIntegrationTopology.calls).toHaveLength(1);
  });
});
