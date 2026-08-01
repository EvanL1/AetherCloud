import type { MqttInboundEvent } from "@aether-cloud/cloudlink-mqtt-adapter";
import {
  parseGatewayId,
  parseIntegrationId,
  parseProjectId,
  parseTenantId,
} from "@aether-cloud/domain";
import { InMemoryIntegrationProjectionRepository } from "@aether-cloud/integration-projection-memory-adapter";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import type {
  CloudLinkMqttDuplexTransport,
  CloudLinkMqttTransportConnector,
} from "../src/index.js";
import {
  composeCloudLinkRuntime,
  rejectedTelemetryCommand,
  type CloudLinkRuntimeFactories,
} from "../src/runtime.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const gatewayId = "33333333-3333-4333-8333-333333333333";
const credentialId = "development-binding-17";
const topicPrefix = "aethercloud";
const sessionTopic = `${topicPrefix}/v1/gateways/${gatewayId}/up/session`;
const manifestTopic = `${topicPrefix}/v1/gateways/${gatewayId}/up/manifest`;
const telemetryTopic = `${topicPrefix}/v1/gateways/${gatewayId}/up/telemetry`;
const topologyTopic = `${topicPrefix}/v1/gateways/${gatewayId}/up/integration/topology`;

/**
 * Generated per run so that no credential-shaped literal is committed and so
 * that the decoder is exercised against a value it cannot have been tuned to.
 */
const proof = randomBytes(48).toString("base64url");

type JsonRecord = Record<string, unknown>;

function credentialEntries(
  ...overrides: readonly JsonRecord[]
): readonly JsonRecord[] {
  return overrides.length === 0
    ? [{ gatewayId, credentialId, generation: "3", proof }]
    : overrides.map((override) => ({
        gatewayId,
        credentialId,
        generation: "3",
        proof,
        ...override,
      }));
}

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AETHER_CLOUD_CLOUDLINK_MQTT_URL: "mqtt://127.0.0.1:1883",
    AETHER_CLOUD_CLOUDLINK_TOPIC_PREFIX: topicPrefix,
    AETHER_CLOUD_TENANT_ID: tenantId,
    AETHER_CLOUD_PROJECT_ID: projectId,
    AETHER_CLOUD_CLOUDLINK_TRUSTED_GATEWAY_CREDENTIALS:
      JSON.stringify(credentialEntries()),
    ...overrides,
  };
}

class FakeTransport implements CloudLinkMqttDuplexTransport {
  subscriptions: readonly string[] = [];
  handler: ((event: MqttInboundEvent) => void) | undefined;
  readonly publications: Array<{ topic: string; payload: Uint8Array }> = [];
  closed = false;
  /** Set to hold `close()` open so a test can observe the draining window. */
  closeGate: Promise<void> | undefined;

  subscribe(
    topics: readonly string[],
    handler: (event: MqttInboundEvent) => void,
  ): Promise<void> {
    this.subscriptions = [...topics];
    this.handler = handler;
    return Promise.resolve();
  }

  publish(topic: string, payload: Uint8Array): Promise<void> {
    this.publications.push({ topic, payload });
    return Promise.resolve();
  }

  async close(): Promise<void> {
    await this.closeGate;
    this.closed = true;
  }

  deliver(topic: string, payload: Uint8Array): void {
    this.handler?.({
      topic,
      payload,
      qos: 1,
      retain: false,
      duplicate: false,
    });
  }

  decoded(index: number): JsonRecord {
    const publication = this.publications[index];
    if (publication === undefined) {
      throw new Error(`no MQTT publication at index ${String(index)}`);
    }
    return record(
      JSON.parse(new TextDecoder().decode(publication.payload)),
      "publication",
    );
  }
}

class FakeConnector implements CloudLinkMqttTransportConnector {
  readonly transport = new FakeTransport();
  input: unknown;
  connections = 0;

  connect(input: unknown): Promise<CloudLinkMqttDuplexTransport> {
    this.input = input;
    this.connections += 1;
    return Promise.resolve(this.transport);
  }
}

function record(input: unknown, field: string): JsonRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError(`${field} must be an object`);
  }
  return input as JsonRecord;
}

function stringField(input: JsonRecord, field: string): string {
  const value = input[field];
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  return value;
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
      `../../../contracts/aether-contracts/v0.1.0-alpha.4-candidate/fixtures/cloudlink-integration/v1alpha1/${name}`,
      import.meta.url,
    ),
  );
}

function decodeFixture(payload: Uint8Array): JsonRecord {
  return record(JSON.parse(new TextDecoder().decode(payload)), "fixture");
}

function encode(value: JsonRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
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

function businessDigest(messageKind: string, payload: unknown): string {
  return `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        protocol_version: "1.0",
        message_kind: messageKind,
        payload,
      }),
    )
    .digest("hex")}`;
}

function trustedConnectorHello(): Uint8Array {
  const hello = decodeFixture(sharedFixture("session-hello.valid.json"));
  record(hello.credential_binding, "credential binding").origin_model =
    "trusted-connector-broker-attestation";
  delete hello.gateway_key_id;
  delete hello.gateway_signature;
  return encode(hello);
}

/** The commissioned manifest that declares the read-only Integration protocol. */
function integrationManifest(
  sessionId: string,
  sessionEpoch: string,
): Uint8Array {
  const envelope = decodeFixture(
    sharedFixture("runtime-manifest-report.valid.json"),
  );
  envelope.session_id = sessionId;
  envelope.session_epoch = sessionEpoch;
  const delivery = record(envelope.delivery, "manifest delivery");
  delivery.position = "1";
  delivery.batch_id = "manifest-1";
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
  delivery.digest = businessDigest("runtime-manifest-report", payload);
  return encode(envelope);
}

function topologyDelivery(sessionId: string, sessionEpoch: string): Uint8Array {
  const envelope = decodeFixture(
    integrationFixture("integration-topology.valid.json"),
  );
  envelope.session_id = sessionId;
  envelope.session_epoch = sessionEpoch;
  return encode(envelope);
}

function telemetryDelivery(
  sessionId: string,
  sessionEpoch: string,
): Uint8Array {
  const envelope = decodeFixture(sharedFixture("telemetry-batch.valid.json"));
  envelope.session_id = sessionId;
  envelope.session_epoch = sessionEpoch;
  record(envelope.delivery, "telemetry delivery").position = "1";
  return encode(envelope);
}

function startedRuntime(overrides: NodeJS.ProcessEnv = {}): Promise<{
  runtime: ReturnType<typeof composeCloudLinkRuntime>;
  transport: FakeTransport;
  projections: InMemoryIntegrationProjectionRepository;
}> {
  const connector = new FakeConnector();
  const projections = new InMemoryIntegrationProjectionRepository();
  const factories: CloudLinkRuntimeFactories = {
    connector,
    projectionStore: { repository: projections },
  };
  const runtime = composeCloudLinkRuntime(environment(overrides), factories);
  return runtime.start().then(() => ({
    runtime,
    transport: connector.transport,
    projections,
  }));
}

async function openSession(transport: FakeTransport): Promise<{
  sessionId: string;
  sessionEpoch: string;
}> {
  transport.deliver(sessionTopic, trustedConnectorHello());
  await vi.waitFor(() => {
    expect(transport.publications).toHaveLength(1);
  });
  const accepted = transport.decoded(0);
  expect(accepted.message_kind).toBe("session-accepted");
  return {
    sessionId: stringField(accepted, "session_id"),
    sessionEpoch: stringField(accepted, "session_epoch"),
  };
}

describe("composeCloudLinkRuntime", () => {
  it("never wires the governed control path", async () => {
    const source = await readFile(
      new URL("../src/runtime.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("integrationControlFactory");
    expect(source).not.toContain("integration-control");
    expect(source).not.toContain("INTEGRATION_CONTROL_PROTOCOL");
  });

  it("never wires the gateway-signed path that has no production key source", async () => {
    const source = await readFile(
      new URL("../src/runtime.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("acceptGatewaySignedSession");
    expect(source).not.toContain("authenticateGatewaySignedUplink");
    expect(source).not.toContain("requestSessionChallenge");
  });

  it("enables only the read-only Integration extension", () => {
    const runtime = composeCloudLinkRuntime(environment());

    expect(runtime.enabledExtensions).toEqual([
      "aether.cloudlink.integration.v1alpha1",
    ]);
  });

  it("defaults to the memory projection store", () => {
    const runtime = composeCloudLinkRuntime(environment());

    expect(runtime.projectionStoreMode).toBe("memory");
  });

  it("does not touch the Broker until start is called", () => {
    const connector = new FakeConnector();
    const runtime = composeCloudLinkRuntime(environment(), { connector });

    expect(runtime.running).toBe(false);
    expect(connector.input).toBeUndefined();
    expect(connector.transport.subscriptions).toEqual([]);
  });

  it("connects on start and closes the transport on close", async () => {
    const connector = new FakeConnector();
    const runtime = composeCloudLinkRuntime(environment(), { connector });

    await runtime.start();
    expect(runtime.running).toBe(true);
    expect(connector.input).toMatchObject({ url: "mqtt://127.0.0.1:1883" });
    expect(connector.transport.subscriptions).toContain(
      `${topicPrefix}/v1/gateways/+/up/integration/topology`,
    );
    expect(connector.transport.subscriptions).not.toContain(
      `${topicPrefix}/v1/gateways/+/up/integration-control/receipts`,
    );

    await runtime.close();
    expect(connector.transport.closed).toBe(true);
    expect(runtime.running).toBe(false);
  });

  it("refuses to start twice so a second Broker connection cannot leak", async () => {
    const connector = new FakeConnector();
    const runtime = composeCloudLinkRuntime(environment(), { connector });

    await runtime.start();
    await expect(runtime.start()).rejects.toThrow(
      "CloudLink ingress is already running",
    );
    expect(connector.connections).toBe(1);
    await runtime.close();
  });

  it("refuses to start again after close because the pool cannot reopen", async () => {
    const connector = new FakeConnector();
    const runtime = composeCloudLinkRuntime(environment(), { connector });

    await runtime.start();
    await runtime.close();
    await expect(runtime.start()).rejects.toThrow(
      "CloudLink ingress is closed",
    );
    expect(connector.connections).toBe(1);
    expect(runtime.running).toBe(false);
  });

  it("keeps reporting running until the ingress has finished draining", async () => {
    const connector = new FakeConnector();
    let releaseClose = (): void => undefined;
    connector.transport.closeGate = new Promise<void>((resolve) => {
      releaseClose = (): void => {
        resolve();
      };
    });
    const runtime = composeCloudLinkRuntime(environment(), { connector });

    await runtime.start();
    const closing = runtime.close();
    await Promise.resolve();
    expect(runtime.running).toBe(true);
    expect(connector.transport.closed).toBe(false);

    releaseClose();
    await closing;
    expect(runtime.running).toBe(false);
    expect(connector.transport.closed).toBe(true);
  });

  it("forwards optional Broker credentials without embedding them in the URL", async () => {
    const connector = new FakeConnector();
    const runtime = composeCloudLinkRuntime(
      environment({
        AETHER_CLOUD_CLOUDLINK_MQTT_USERNAME: "cloudlink-ingress",
        AETHER_CLOUD_CLOUDLINK_MQTT_PASSWORD: "broker-password",
      }),
      { connector },
    );

    await runtime.start();
    expect(connector.input).toMatchObject({
      url: "mqtt://127.0.0.1:1883",
      username: "cloudlink-ingress",
      password: "broker-password",
    });
    await runtime.close();
  });

  it("closes the projection pool it opened", async () => {
    let ended = 0;
    const runtime = composeCloudLinkRuntime(environment(), {
      connector: new FakeConnector(),
      projectionStore: {
        repository: new InMemoryIntegrationProjectionRepository(),
        pool: {
          connect: () => Promise.reject(new Error("unused")),
          end: () => {
            ended += 1;
            return Promise.resolve();
          },
        },
      },
    });

    expect(runtime.projectionStoreMode).toBe("postgres");
    await runtime.close();
    await runtime.close();
    expect(ended).toBe(1);
  });

  describe("required operator configuration", () => {
    const requiredVariables = [
      "AETHER_CLOUD_CLOUDLINK_MQTT_URL",
      "AETHER_CLOUD_CLOUDLINK_TOPIC_PREFIX",
      "AETHER_CLOUD_TENANT_ID",
      "AETHER_CLOUD_PROJECT_ID",
      "AETHER_CLOUD_CLOUDLINK_TRUSTED_GATEWAY_CREDENTIALS",
    ] as const;

    for (const variable of requiredVariables) {
      it(`rejects a missing ${variable}`, () => {
        const configuration: NodeJS.ProcessEnv = Object.fromEntries(
          Object.entries(environment()).filter(([key]) => key !== variable),
        );

        expect(() => composeCloudLinkRuntime(configuration)).toThrow(
          `${variable} is required`,
        );
      });

      it(`rejects an empty ${variable}`, () => {
        expect(() =>
          composeCloudLinkRuntime(environment({ [variable]: "" })),
        ).toThrow(`${variable} is required`);
      });
    }

    it("rejects a tenant identity that is not a canonical UUID", () => {
      expect(() =>
        composeCloudLinkRuntime(
          environment({ AETHER_CLOUD_TENANT_ID: "tenant-a0" }),
        ),
      ).toThrow("AETHER_CLOUD_TENANT_ID must be a canonical lowercase UUID");
    });

    it("rejects a project identity that is not a canonical UUID", () => {
      expect(() =>
        composeCloudLinkRuntime(
          environment({ AETHER_CLOUD_PROJECT_ID: "project-a0" }),
        ),
      ).toThrow("AETHER_CLOUD_PROJECT_ID must be a canonical lowercase UUID");
    });
  });

  describe("trusted connector credential configuration", () => {
    const variable = "AETHER_CLOUD_CLOUDLINK_TRUSTED_GATEWAY_CREDENTIALS";

    function rejects(value: string, message: string): void {
      expect(() =>
        composeCloudLinkRuntime(environment({ [variable]: value })),
      ).toThrow(message);
    }

    it("rejects a value that is not JSON", () => {
      rejects("{not json", `${variable} must be a JSON array`);
    });

    it("rejects a JSON value that is not an array", () => {
      rejects(
        JSON.stringify(credentialEntries()[0]),
        `${variable} must be a JSON array`,
      );
    });

    it("rejects an empty array so the ingress never starts unauthenticated", () => {
      rejects("[]", `${variable} must declare 1-64 Gateway credentials`);
    });

    it("rejects more credentials than the A0 deployment bound", () => {
      const entries = Array.from({ length: 65 }, (_unused, index) => ({
        credentialId: `binding-${String(index)}`,
      }));
      rejects(
        JSON.stringify(credentialEntries(...entries)),
        `${variable} must declare 1-64 Gateway credentials`,
      );
    });

    it("rejects an unknown field instead of silently ignoring it", () => {
      rejects(
        JSON.stringify(credentialEntries({ status: "active" })),
        `${variable} entries must declare exactly gatewayId, credentialId, generation, and proof`,
      );
    });

    it("rejects a missing field", () => {
      rejects(
        JSON.stringify([{ gatewayId, credentialId, generation: "3" }]),
        `${variable} entries must declare exactly gatewayId, credentialId, generation, and proof`,
      );
    });

    it("rejects a Gateway identity that is not a canonical UUID", () => {
      rejects(
        JSON.stringify(credentialEntries({ gatewayId: "gateway-a0" })),
        `${variable} gatewayId must be a canonical lowercase UUID`,
      );
    });

    it("rejects a credential generation that is not a canonical uint64", () => {
      rejects(
        JSON.stringify(credentialEntries({ generation: "03" })),
        `${variable} generation must be a canonical uint64 string`,
      );
    });

    it("rejects an empty credentialId", () => {
      rejects(
        JSON.stringify(credentialEntries({ credentialId: "" })),
        `${variable} credentialId must be 1-256 characters`,
      );
    });

    it("rejects a duplicate credentialId", () => {
      rejects(
        JSON.stringify(credentialEntries({}, { gatewayId })),
        `${variable} credentialId values must be unique`,
      );
    });

    it("rejects a proof larger than the CloudLink bound", () => {
      rejects(
        JSON.stringify(credentialEntries({ proof: "B".repeat(4097) })),
        `${variable} proof must be 1-4096 bytes`,
      );
    });

    it("never echoes the proof in a rejection message", () => {
      const secret = randomBytes(24).toString("base64url");
      let thrown: unknown;
      try {
        composeCloudLinkRuntime(
          environment({
            [variable]: JSON.stringify(
              credentialEntries({ proof: secret, generation: "03" }),
            ),
          }),
        );
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const rendered = `${String(thrown)}\n${(thrown as Error).stack ?? ""}`;
      expect(rendered).toContain(variable);
      expect(rendered).not.toContain(secret);
    });
  });

  describe("read-only Integration projection over the trusted connector", () => {
    it("projects a Home Assistant topology reported on a trusted-connector session", async () => {
      const { runtime, transport, projections } = await startedRuntime();

      const session = await openSession(transport);
      transport.deliver(
        manifestTopic,
        integrationManifest(session.sessionId, session.sessionEpoch),
      );
      await vi.waitFor(() => {
        expect(transport.publications).toHaveLength(2);
      });
      expect(transport.decoded(1)).toMatchObject({
        message_kind: "durable-ack",
        stream_id: "manifest",
      });

      transport.deliver(
        topologyTopic,
        topologyDelivery(session.sessionId, session.sessionEpoch),
      );
      await vi.waitFor(() => {
        expect(transport.publications).toHaveLength(3);
      });
      expect(transport.decoded(2)).toMatchObject({
        message_kind: "durable-ack",
        stream_id: "integration-topology-home",
        batch_id: "topology-1",
      });

      const projection = await projections.findCurrent({
        tenantId: parseTenantId(tenantId),
        projectId: parseProjectId(projectId),
        gatewayId: parseGatewayId(gatewayId),
        integrationId: parseIntegrationId("home-assistant.home"),
      });
      expect(projection).toMatchObject({
        revision: 1,
        topology: {
          integrationKind: "home-assistant",
          snapshotGeneration: "1",
        },
      });

      await runtime.close();
    });

    it("refuses a session whose credential is not operator-configured", async () => {
      const { runtime, transport } = await startedRuntime({
        AETHER_CLOUD_CLOUDLINK_TRUSTED_GATEWAY_CREDENTIALS: JSON.stringify(
          credentialEntries({ credentialId: "some-other-binding" }),
        ),
      });

      transport.deliver(sessionTopic, trustedConnectorHello());
      await runtime.close();

      expect(transport.publications).toEqual([]);
    });

    it("refuses a session whose configured credential generation differs", async () => {
      const { runtime, transport } = await startedRuntime({
        AETHER_CLOUD_CLOUDLINK_TRUSTED_GATEWAY_CREDENTIALS: JSON.stringify(
          credentialEntries({ generation: "4" }),
        ),
      });

      transport.deliver(sessionTopic, trustedConnectorHello());
      await runtime.close();

      expect(transport.publications).toEqual([]);
    });

    // The MQTT bridge maps an explicit failure and a malformed success to the
    // same `rejected` outcome, so the failure payload has to be pinned here.
    // Asserting only that no acknowledgement was published would still pass if
    // the command were flipped to return `{ ok: true, value: {} }`.
    it("returns an explicit telemetry failure rather than an empty success", async () => {
      await expect(rejectedTelemetryCommand.execute()).resolves.toEqual({
        ok: false,
        failure: {
          code: "invalid-input",
          message:
            "telemetry ingestion is not part of the read-only A0 composition",
        },
      });
    });

    it("never acknowledges telemetry delivered on a live session", async () => {
      const { runtime, transport } = await startedRuntime();
      const session = await openSession(transport);

      transport.deliver(
        telemetryTopic,
        telemetryDelivery(session.sessionId, session.sessionEpoch),
      );
      await runtime.close();

      expect(transport.publications).toHaveLength(1);
      expect(transport.decoded(0).message_kind).toBe("session-accepted");
    });
  });
});
