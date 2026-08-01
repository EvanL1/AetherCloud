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
import { describe, expect, it, vi } from "vitest";

import type {
  CloudLinkMqttDuplexTransport,
  CloudLinkMqttTransportConnector,
} from "../src/index.js";
import {
  composeCloudLinkRuntime,
  unsupportedTelemetryCommand,
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
  /** Set to make `close()` fail the way a real Broker close can. */
  closeError: Error | undefined;

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
    if (this.closeError !== undefined) throw this.closeError;
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
  readonly transports: FakeTransport[] = [];
  input: unknown;
  /** Set to hold `connect()` open so a test can interleave `close()`. */
  connectGate: Promise<void> | undefined;
  /** Applied to every transport this connector goes on to create. */
  transportCloseError: Error | undefined;

  get transport(): FakeTransport {
    const first = this.transports[0];
    if (first === undefined) throw new Error("no transport was connected");
    return first;
  }

  get connections(): number {
    return this.transports.length;
  }

  async connect(input: unknown): Promise<CloudLinkMqttDuplexTransport> {
    this.input = input;
    // Each connect returns its own transport so an orphaned second connection
    // is visible instead of being masked by a shared instance.
    const transport = new FakeTransport();
    transport.closeError = this.transportCloseError;
    this.transports.push(transport);
    await this.connectGate;
    return transport;
  }
}

function deferred(): Readonly<{ promise: Promise<void>; release: () => void }> {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = (): void => {
      resolve();
    };
  });
  return { promise, release };
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
  outcomes: string[];
  diagnostics: string[];
}> {
  const connector = new FakeConnector();
  const projections = new InMemoryIntegrationProjectionRepository();
  const outcomes: string[] = [];
  const diagnostics: string[] = [];
  const factories: CloudLinkRuntimeFactories = {
    connector,
    projectionStore: { repository: projections },
    observer: {
      messageHandled(result) {
        outcomes.push(
          result.outcome === "discarded"
            ? `${result.outcome}:${result.failure.code}`
            : result.outcome,
        );
      },
      internalFailure() {
        outcomes.push("internal-failure");
      },
    },
    diagnostic(message) {
      diagnostics.push(message);
    },
  };
  const runtime = composeCloudLinkRuntime(environment(overrides), factories);
  return runtime.start().then(() => ({
    runtime,
    transport: connector.transport,
    projections,
    outcomes,
    diagnostics,
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
  // These replace earlier assertions over the runtime source text, which
  // forbade even naming the control path in a comment and would have kept
  // passing had the wiring moved to another module.
  it("never subscribes to, nor acts on, the governed control path", async () => {
    const { runtime, transport, outcomes } = await startedRuntime();

    expect(transport.subscriptions).not.toContain(
      `${topicPrefix}/v1/gateways/+/up/integration-control/receipts`,
    );
    transport.deliver(
      `${topicPrefix}/v1/gateways/${gatewayId}/up/integration-control/receipts`,
      encode({ schema: "aether.integration.control-receipt.v1alpha1" }),
    );
    await runtime.close();

    expect(transport.publications).toEqual([]);
    expect(outcomes).toEqual(["discarded:integration-control-disabled"]);
  });

  it("never accepts a gateway-signed session hello", async () => {
    const { runtime, transport, outcomes } = await startedRuntime();

    // The unmodified fixture declares origin_model "gateway-signed".
    transport.deliver(sessionTopic, sharedFixture("session-hello.valid.json"));
    await runtime.close();

    expect(transport.publications).toEqual([]);
    // The bridge emits this precisely because acceptGatewaySignedSession
    // is unwired: "Gateway-signed CloudLink session authentication is
    // unavailable".
    expect(outcomes).toEqual(["discarded:authentication-evidence-missing"]);
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
    expect(connector.connections).toBe(0);
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
    const runtime = composeCloudLinkRuntime(environment(), { connector });

    await runtime.start();
    const closeGate = deferred();
    connector.transport.closeGate = closeGate.promise;
    const closing = runtime.close();
    await Promise.resolve();
    expect(runtime.running).toBe(true);
    expect(connector.transport.closed).toBe(false);

    closeGate.release();
    await closing;
    expect(runtime.running).toBe(false);
    expect(connector.transport.closed).toBe(true);
  });

  // A SIGTERM that arrives while start() is still inside the Broker connect
  // timeout is the ordinary shutdown path, not an edge case.
  it("closes a transport that finishes connecting after close has begun", async () => {
    const connector = new FakeConnector();
    const connectGate = deferred();
    connector.connectGate = connectGate.promise;
    const runtime = composeCloudLinkRuntime(environment(), { connector });

    const settled: string[] = [];
    const starting = runtime.start().catch((error: unknown) => {
      settled.push("start");
      throw error;
    });
    const closing = runtime.close().then(() => {
      settled.push("close");
    });
    connectGate.release();

    await expect(starting).rejects.toThrow("CloudLink ingress is closed");
    await closing;
    expect(connector.connections).toBe(1);
    expect(connector.transports.every((transport) => transport.closed)).toBe(
      true,
    );
    expect(runtime.running).toBe(false);
    // close() must not resolve while a start is still in flight, or a caller
    // exits the process with a Broker connect still outstanding.
    expect(settled).toEqual(["start", "close"]);
  });

  it("opens one Broker connection for concurrent starts", async () => {
    const connector = new FakeConnector();
    const connectGate = deferred();
    connector.connectGate = connectGate.promise;
    const runtime = composeCloudLinkRuntime(environment(), { connector });

    const first = runtime.start();
    const second = runtime.start();
    connectGate.release();
    await Promise.all([first, second]);

    expect(connector.connections).toBe(1);
    expect(runtime.running).toBe(true);

    await runtime.close();
    expect(connector.transports.every((transport) => transport.closed)).toBe(
      true,
    );
  });

  it("still ends the projection pool when the ingress close fails", async () => {
    let ended = 0;
    const connector = new FakeConnector();
    const runtime = composeCloudLinkRuntime(environment(), {
      connector,
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

    await runtime.start();
    connector.transport.closeError = new Error("broker close failed");

    await expect(runtime.close()).rejects.toThrow("broker close failed");
    expect(ended).toBe(1);
    expect(runtime.running).toBe(false);
  });

  // The same underlying failure as the previous case, reached through the
  // close-during-start hand-off. It must not report a different result just
  // because the timing differed.
  it("fails close when the orphaned transport cannot be closed", async () => {
    let ended = 0;
    const connector = new FakeConnector();
    connector.transportCloseError = new Error("broker close failed");
    const connectGate = deferred();
    connector.connectGate = connectGate.promise;
    const runtime = composeCloudLinkRuntime(environment(), {
      connector,
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

    const starting = runtime.start();
    const closing = runtime.close();
    connectGate.release();

    await expect(starting).rejects.toThrow("broker close failed");
    await expect(closing).rejects.toThrow("broker close failed");
    expect(connector.transports.every((transport) => transport.closed)).toBe(
      false,
    );
    expect(ended).toBe(1);
    expect(runtime.running).toBe(false);
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

  // The transport hardcodes `clean: false`, so a per-process random client id
  // would abandon a Broker-side session holding the wildcard subscription and
  // queueing QoS-1 uplinks on every restart.
  it("reuses one stable Broker client id across restarts", async () => {
    const first = new FakeConnector();
    const original = composeCloudLinkRuntime(environment(), {
      connector: first,
    });
    await original.start();
    await original.close();

    const second = new FakeConnector();
    const restarted = composeCloudLinkRuntime(environment(), {
      connector: second,
    });
    await restarted.start();
    await restarted.close();

    expect(first.input).toMatchObject({
      clientId: "aether-cloud-cloudlink-ingress",
    });
    expect(second.input).toEqual(first.input);
  });

  it("lets an operator name the Broker client id", async () => {
    const connector = new FakeConnector();
    const runtime = composeCloudLinkRuntime(
      environment({
        AETHER_CLOUD_CLOUDLINK_MQTT_CLIENT_ID: "aether-cloud-home-1",
      }),
      { connector },
    );

    await runtime.start();
    expect(connector.input).toMatchObject({ clientId: "aether-cloud-home-1" });
    await runtime.close();
  });

  it("writes rejected uplinks to stderr when no observer is injected", async () => {
    const written: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    try {
      const connector = new FakeConnector();
      const runtime = composeCloudLinkRuntime(environment(), { connector });
      await runtime.start();
      connector.transport.deliver(
        sessionTopic,
        new TextEncoder().encode("{not json"),
      );
      await runtime.close();
    } finally {
      stderr.mockRestore();
    }

    expect(written).toContain("cloudlink uplink discarded: invalid-json\n");
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

    it("rejects a topic prefix the MQTT contract would refuse", () => {
      expect(() =>
        composeCloudLinkRuntime(
          environment({ AETHER_CLOUD_CLOUDLINK_TOPIC_PREFIX: "aether cloud" }),
        ),
      ).toThrow("AETHER_CLOUD_CLOUDLINK_TOPIC_PREFIX is invalid");
    });

    it("rejects an over-long Broker client id", () => {
      expect(() =>
        composeCloudLinkRuntime(
          environment({
            AETHER_CLOUD_CLOUDLINK_MQTT_CLIENT_ID: "c".repeat(129),
          }),
        ),
      ).toThrow("AETHER_CLOUD_CLOUDLINK_MQTT_CLIENT_ID must be 1-128");
    });

    it("rejects a project identity that is not a canonical UUID", () => {
      expect(() =>
        composeCloudLinkRuntime(
          environment({ AETHER_CLOUD_PROJECT_ID: "project-a0" }),
        ),
      ).toThrow("AETHER_CLOUD_PROJECT_ID must be a canonical lowercase UUID");
    });
  });

  describe("operator-configured Broker TLS trust", () => {
    const tlsEnvironment = {
      AETHER_CLOUD_CLOUDLINK_MQTT_TLS_CA_PATH: "/etc/aether/broker-ca.pem",
      AETHER_CLOUD_CLOUDLINK_MQTT_TLS_CLIENT_CERTIFICATE_PATH:
        "/etc/aether/ingress.crt",
      AETHER_CLOUD_CLOUDLINK_MQTT_TLS_CLIENT_PRIVATE_KEY_PATH:
        "/etc/aether/ingress.key",
    } as const;

    it("omits tls entirely when no trust material is configured", async () => {
      const connector = new FakeConnector();
      const runtime = composeCloudLinkRuntime(environment(), { connector });

      await runtime.start();
      await runtime.close();

      // An absent key, not an undefined one: the transport rejects unsupported
      // fields, and the default system trust chain applies instead.
      expect(connector.input).toBeTypeOf("object");
      expect(Object.keys(record(connector.input, "connection"))).not.toContain(
        "tls",
      );
    });

    it("passes the complete trust bundle to the transport", async () => {
      const connector = new FakeConnector();
      const runtime = composeCloudLinkRuntime(
        environment({
          AETHER_CLOUD_CLOUDLINK_MQTT_URL: "mqtts://broker.example:8883",
          ...tlsEnvironment,
        }),
        { connector },
      );

      await runtime.start();
      await runtime.close();

      expect(connector.input).toMatchObject({
        url: "mqtts://broker.example:8883",
        tls: {
          caPath: "/etc/aether/broker-ca.pem",
          clientCertificatePath: "/etc/aether/ingress.crt",
          clientPrivateKeyPath: "/etc/aether/ingress.key",
        },
      });
    });

    for (const omitted of Object.keys(tlsEnvironment)) {
      it(`rejects a partial trust bundle missing ${omitted}`, () => {
        const partial: NodeJS.ProcessEnv = Object.fromEntries(
          Object.entries(tlsEnvironment).filter(([key]) => key !== omitted),
        );

        expect(() => composeCloudLinkRuntime(environment(partial))).toThrow(
          "must be set together or not at all",
        );
      });
    }
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

    it("names the mismatched binding without ever emitting the proof", async () => {
      const { runtime, transport, outcomes, diagnostics } =
        await startedRuntime({
          AETHER_CLOUD_CLOUDLINK_TRUSTED_GATEWAY_CREDENTIALS: JSON.stringify(
            credentialEntries({ credentialId: "some-other-binding" }),
          ),
        });

      transport.deliver(sessionTopic, trustedConnectorHello());
      await runtime.close();

      expect(outcomes).toEqual(["discarded:authentication-evidence-missing"]);
      expect(diagnostics).toHaveLength(1);
      const reported = diagnostics.join("\n");
      expect(reported).toContain(gatewayId);
      expect(reported).toContain(credentialId);
      expect(reported).toContain("generation");
      expect(reported).not.toContain(proof);
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
      await expect(unsupportedTelemetryCommand.execute()).resolves.toEqual({
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
