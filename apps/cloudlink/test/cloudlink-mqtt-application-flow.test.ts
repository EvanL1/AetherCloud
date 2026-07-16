import {
  IngestTelemetryBatch,
  OpenCloudLinkSession,
  type ApplicationClock,
} from "@aether-cloud/application";
import {
  InMemoryCloudLinkSessionRepository,
  InMemoryGatewayCredentialVerifier,
} from "@aether-cloud/cloudlink-memory-adapter";
import {
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";
import {
  InMemoryTelemetryRepository,
  NodeTelemetryBatchDigestor,
} from "@aether-cloud/telemetry-memory-adapter";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CloudLinkMqttApplicationBridge,
  type CloudLinkApplicationCommand,
  type CloudLinkMqttResponsePublisher,
} from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const sessionId = parseCloudLinkSessionId(
  "44444444-4444-4444-8444-444444444444",
);
const credential = {
  credentialId: "development-binding-17",
  proof:
    "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
};

class FixedClock implements ApplicationClock {
  now() {
    return parseUtcInstant("2024-07-14T23:33:20.400Z");
  }
}

class FixedSessionIds {
  next() {
    return sessionId;
  }
}

class UnusedCommand implements CloudLinkApplicationCommand {
  execute(): Promise<unknown> {
    return Promise.resolve({
      ok: false,
      failure: { code: "unused-command", message: "not used" },
    });
  }
}

class RecordingPublisher implements CloudLinkMqttResponsePublisher {
  readonly messages: unknown[] = [];

  publish(_topic: string, payload: Uint8Array): Promise<void> {
    this.messages.push(
      JSON.parse(new TextDecoder().decode(payload)) as unknown,
    );
    return Promise.resolve();
  }
}

function sharedFixture(name: string): Uint8Array {
  return readFileSync(
    new URL(
      `../../../contracts/cloudlink/v1/fixtures/${name}`,
      import.meta.url,
    ),
  );
}

describe("CloudLink MQTT application flow", () => {
  it("opens a real memory session and acknowledges telemetry after application persistence", async () => {
    const clock = new FixedClock();
    const verifier = new InMemoryGatewayCredentialVerifier([
      {
        assertion: credential,
        binding: {
          tenantId,
          projectId,
          gatewayId,
          generation: parseGatewayCredentialGeneration("3"),
          status: "active",
        },
      },
    ]);
    const sessions = new InMemoryCloudLinkSessionRepository();
    const telemetry = new InMemoryTelemetryRepository();
    const publisher = new RecordingPublisher();
    const unused = new UnusedCommand();
    const bridge = new CloudLinkMqttApplicationBridge({
      topicPrefix: "aethercloud",
      publisher,
      openSession: new OpenCloudLinkSession({
        repository: sessions,
        credentialVerifier: verifier,
        clock,
        sessionIds: new FixedSessionIds(),
        supportedProtocolVersions: ["1.0"],
      }),
      heartbeat: unused,
      reportManifest: unused,
      ingestTelemetry: new IngestTelemetryBatch({
        credentialVerifier: verifier,
        digestor: new NodeTelemetryBatchDigestor(),
        repository: telemetry,
        clock,
      }),
      clock,
    });

    await expect(
      bridge.handle({
        topic: `aethercloud/v1/gateways/${gatewayId}/up/session`,
        payload: sharedFixture("session-hello.valid.json"),
      }),
    ).resolves.toEqual({ outcome: "acknowledged" });
    await expect(
      bridge.handle({
        topic: `aethercloud/v1/gateways/${gatewayId}/up/telemetry`,
        payload: (() => {
          const envelope = JSON.parse(
            new TextDecoder().decode(
              sharedFixture("telemetry-batch.valid.json"),
            ),
          ) as Record<string, unknown>;
          envelope.session_epoch = "1";
          (envelope.delivery as Record<string, unknown>).position = "1";
          return new TextEncoder().encode(JSON.stringify(envelope));
        })(),
      }),
    ).resolves.toEqual({ outcome: "acknowledged" });

    expect(telemetry.historyRecordCount()).toBe(1);
    expect(publisher.messages).toMatchObject([
      {
        message_kind: "session-accepted",
        session_id: sessionId,
        session_epoch: "1",
      },
      {
        message_kind: "durable-ack",
        stream_id: "telemetry",
        stream_epoch: "4",
        acknowledged_position: "1",
        batch_id: "batch-1",
      },
    ]);
  });
});
