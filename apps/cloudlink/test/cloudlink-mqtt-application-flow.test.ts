import { createHash } from "node:crypto";

import {
  IngestTelemetryBatch,
  OpenCloudLinkSession,
  RecordCloudLinkDurableCursor,
  ReportGatewayRuntimeManifest,
  ReportIntegrationObservations,
  ReportIntegrationTopology,
  RestoreGatewayRuntimeProtocols,
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
  parseIntegrationId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";
import {
  InMemoryIntegrationProjectionRepository,
  NodeIntegrationPayloadDigestor,
} from "@aether-cloud/integration-projection-memory-adapter";
import {
  InMemoryRuntimeManifestRepository,
  NodeRuntimeManifestIntegrityVerifier,
} from "@aether-cloud/runtime-memory-adapter";
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

class IntegrationClock implements ApplicationClock {
  now() {
    return parseUtcInstant("2026-07-17T06:00:00.000Z");
  }
}

class FixedSessionIds {
  next() {
    return sessionId;
  }
}

class SequenceSessionIds {
  readonly #sessionIds: ReturnType<typeof parseCloudLinkSessionId>[];

  constructor(sessionIds: readonly string[]) {
    this.#sessionIds = sessionIds.map(parseCloudLinkSessionId);
  }

  next() {
    const next = this.#sessionIds.shift();
    if (next === undefined) throw new Error("test session IDs exhausted");
    return next;
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

function integrationFixture(name: string): Uint8Array {
  return readFileSync(
    new URL(
      `../../../contracts/aether-contracts/v0.1.0-alpha.4/fixtures/cloudlink-integration/v1alpha1/${name}`,
      import.meta.url,
    ),
  );
}

function record(input: unknown, field: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError(`${field} must be a test object`);
  }
  return input as Record<string, unknown>;
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

function cloudLinkBusinessDigest(
  messageKind: string,
  businessPayload: unknown,
): string {
  return `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        protocol_version: "1.0",
        message_kind: messageKind,
        payload: businessPayload,
      }),
    )
    .digest("hex")}`;
}

function extensionManifest(sessionEpoch: string, position = "1"): Uint8Array {
  const envelope = JSON.parse(
    new TextDecoder().decode(
      sharedFixture("runtime-manifest-report.valid.json"),
    ),
  ) as Record<string, unknown>;
  envelope.session_epoch = sessionEpoch;
  const delivery = record(envelope.delivery, "manifest delivery");
  delivery.position = position;
  delivery.batch_id = `manifest-${position}`;
  const payload = record(envelope.payload, "manifest payload");
  const manifest = record(payload.manifest, "runtime manifest");
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
  delivery.digest = cloudLinkBusinessDigest("runtime-manifest-report", payload);
  return new TextEncoder().encode(JSON.stringify(envelope));
}

function integrationDelivery(
  name: string,
  deliverySessionId: string,
  sessionEpoch: string,
): Uint8Array {
  const envelope = JSON.parse(
    new TextDecoder().decode(integrationFixture(name)),
  ) as Record<string, unknown>;
  envelope.session_id = deliverySessionId;
  envelope.session_epoch = sessionEpoch;
  return new TextEncoder().encode(JSON.stringify(envelope));
}

function sessionHello(clientNonce: string): Uint8Array {
  const hello = JSON.parse(
    new TextDecoder().decode(sharedFixture("session-hello.valid.json")),
  ) as Record<string, unknown>;
  hello.client_nonce = clientNonce;
  const credentialBinding = record(
    hello.credential_binding,
    "credential binding",
  );
  credentialBinding.origin_model = "trusted-connector-broker-attestation";
  delete hello.gateway_key_id;
  delete hello.gateway_signature;
  return new TextEncoder().encode(JSON.stringify(hello));
}

const trustedConnectorCredential = {
  execute: () =>
    Promise.resolve({
      ok: true,
      value: credential,
    }),
};

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
      resolveTrustedConnectorCredential: trustedConnectorCredential,
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
        payload: sessionHello("A".repeat(43)),
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

  it("withholds a manifest acknowledgement across a cursor gap and advances after the gap is filled", async () => {
    const clock = new IntegrationClock();
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
    const runtimeManifests = new InMemoryRuntimeManifestRepository();
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
      resolveTrustedConnectorCredential: trustedConnectorCredential,
      heartbeat: unused,
      reportManifest: new ReportGatewayRuntimeManifest({
        repository: runtimeManifests,
        credentialVerifier: verifier,
        integrityVerifier: new NodeRuntimeManifestIntegrityVerifier(),
        clock,
      }),
      ingestTelemetry: unused,
      recordDurableCursor: new RecordCloudLinkDurableCursor({
        repository: sessions,
        credentialVerifier: verifier,
        clock,
      }),
      clock,
    });

    await expect(
      bridge.handle({
        topic: `aethercloud/v1/gateways/${gatewayId}/up/session`,
        payload: sessionHello("A".repeat(43)),
      }),
    ).resolves.toEqual({ outcome: "acknowledged" });
    await expect(
      bridge.handle({
        topic: `aethercloud/v1/gateways/${gatewayId}/up/manifest`,
        payload: extensionManifest("1", "2"),
      }),
    ).resolves.toEqual({ outcome: "rejected" });
    expect(publisher.messages).toHaveLength(1);

    await expect(
      bridge.handle({
        topic: `aethercloud/v1/gateways/${gatewayId}/up/manifest`,
        payload: extensionManifest("1", "1"),
      }),
    ).resolves.toEqual({ outcome: "acknowledged" });
    await expect(
      bridge.handle({
        topic: `aethercloud/v1/gateways/${gatewayId}/up/manifest`,
        payload: extensionManifest("1", "2"),
      }),
    ).resolves.toEqual({ outcome: "acknowledged" });
    expect(publisher.messages.slice(-2)).toMatchObject([
      {
        message_kind: "durable-ack",
        stream_id: "manifest",
        acknowledged_position: "1",
        batch_id: "manifest-1",
      },
      {
        message_kind: "durable-ack",
        stream_id: "manifest",
        acknowledged_position: "2",
        batch_id: "manifest-2",
      },
    ]);
  });

  it("restores the accepted manifest across sessions before projecting Home Assistant data", async () => {
    const clock = new IntegrationClock();
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
    const runtimeManifests = new InMemoryRuntimeManifestRepository();
    const projections = new InMemoryIntegrationProjectionRepository({
      sessionFenceVerifier: sessions,
    });
    const publisher = new RecordingPublisher();
    const unused = new UnusedCommand();
    const projectionDependencies = {
      repository: projections,
      verifier,
      digestor: new NodeIntegrationPayloadDigestor(),
      clock,
    };
    const bridge = new CloudLinkMqttApplicationBridge({
      topicPrefix: "aethercloud",
      publisher,
      openSession: new OpenCloudLinkSession({
        repository: sessions,
        credentialVerifier: verifier,
        clock,
        sessionIds: new SequenceSessionIds([
          sessionId,
          "55555555-5555-4555-8555-555555555555",
        ]),
        supportedProtocolVersions: ["1.0"],
      }),
      resolveTrustedConnectorCredential: trustedConnectorCredential,
      heartbeat: unused,
      reportManifest: new ReportGatewayRuntimeManifest({
        repository: runtimeManifests,
        credentialVerifier: verifier,
        integrityVerifier: new NodeRuntimeManifestIntegrityVerifier(),
        clock,
      }),
      restoreRuntimeProtocols: new RestoreGatewayRuntimeProtocols({
        repository: runtimeManifests,
        credentialVerifier: verifier,
      }),
      ingestTelemetry: unused,
      reportIntegrationTopology: new ReportIntegrationTopology(
        projectionDependencies,
      ),
      reportIntegrationObservations: new ReportIntegrationObservations(
        projectionDependencies,
      ),
      recordDurableCursor: new RecordCloudLinkDurableCursor({
        repository: sessions,
        credentialVerifier: verifier,
        clock,
      }),
      enabledExtensions: ["aether.cloudlink.integration.v1alpha1"],
      clock,
    });

    await expect(
      bridge.handle({
        topic: `aethercloud/v1/gateways/${gatewayId}/up/session`,
        payload: sessionHello("A".repeat(43)),
      }),
    ).resolves.toEqual({ outcome: "acknowledged" });
    await expect(
      bridge.handle({
        topic: `aethercloud/v1/gateways/${gatewayId}/up/manifest`,
        payload: extensionManifest("1"),
      }),
    ).resolves.toEqual({ outcome: "acknowledged" });
    const reconnectedSessionId = "55555555-5555-4555-8555-555555555555";
    await expect(
      bridge.handle({
        topic: `aethercloud/v1/gateways/${gatewayId}/up/session`,
        payload: sessionHello("CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"),
      }),
    ).resolves.toEqual({ outcome: "acknowledged" });
    await expect(
      bridge.handle({
        topic: `aethercloud/v1/gateways/${gatewayId}/up/integration/topology`,
        payload: integrationDelivery(
          "integration-topology.valid.json",
          reconnectedSessionId,
          "2",
        ),
      }),
    ).resolves.toEqual({ outcome: "acknowledged" });
    await expect(
      bridge.handle({
        topic: `aethercloud/v1/gateways/${gatewayId}/up/integration/observations`,
        payload: integrationDelivery(
          "integration-observations.valid.json",
          reconnectedSessionId,
          "2",
        ),
      }),
    ).resolves.toEqual({ outcome: "acknowledged" });

    const projection = await projections.findCurrent({
      tenantId,
      projectId,
      gatewayId,
      integrationId: parseIntegrationId("home-assistant.home"),
    });
    expect(projection).toMatchObject({
      revision: 2,
      topology: {
        integrationKind: "home-assistant",
        snapshotGeneration: "1",
      },
    });
    expect(projection?.latestObservations).toHaveLength(7);
    expect(projections.auditEvents()).toHaveLength(2);
    expect(projections.pendingOutboxEvents()).toHaveLength(2);
    expect(publisher.messages.slice(-2)).toMatchObject([
      {
        message_kind: "durable-ack",
        stream_id: "integration-topology-home",
        batch_id: "topology-1",
      },
      {
        message_kind: "durable-ack",
        stream_id: "integration-observations-home",
        batch_id: "batch-0001",
      },
    ]);
  });
});
