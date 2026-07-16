import { readFileSync } from "node:fs";

import { cloudLinkBusinessDigest } from "@aether-cloud/cloudlink-mqtt-adapter";
import { describe, expect, it } from "vitest";

import {
  CloudLinkMqttApplicationBridge,
  type CloudLinkApplicationCommand,
  type CloudLinkBridgeDependencies,
  type CloudLinkMqttResponsePublisher,
} from "../src/index.js";

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

function inbound(
  route: "data-loss" | "heartbeat" | "manifest" | "session" | "telemetry",
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
    return Promise.resolve(this.result);
  }
}

function testContext() {
  const publisher = new RecordingPublisher();
  const openSession = new StubCommand({
    ok: true,
    replayed: false,
    value: {
      gatewayId,
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
  const dependencies: CloudLinkBridgeDependencies = {
    topicPrefix,
    publisher,
    openSession,
    heartbeat,
    reportManifest,
    recordDurableCursor,
    ingestTelemetry,
    clock: { now: () => "2024-07-14T23:33:20.400Z" },
  };
  return {
    bridge: new CloudLinkMqttApplicationBridge(dependencies),
    heartbeat,
    ingestTelemetry,
    openSession,
    publisher,
    recordDurableCursor,
    reportManifest,
  };
}

async function open(context: ReturnType<typeof testContext>) {
  return context.bridge.handle(
    inbound("session", sharedFixture("session-hello.valid.json")),
  );
}

describe("CloudLink MQTT product application bridge", () => {
  it("opens the shared hello and emits the shared session vocabulary", async () => {
    const context = testContext();
    await expect(open(context)).resolves.toEqual({ outcome: "acknowledged" });

    expect(context.openSession.calls).toEqual([
      {
        context: {
          idempotencyKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
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
});
