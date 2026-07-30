import { createPublicKey } from "node:crypto";
import { appendFileSync } from "node:fs";

import {
  IngestTelemetryBatch,
  OpenCloudLinkSession,
  RecordCloudLinkDurableCursor,
  RecordCloudLinkHeartbeat,
  ReportGatewayRuntimeManifest,
  type ApplicationClock,
} from "../packages/application/src/index.js";
import { InMemoryCloudLinkSessionRepository } from "../adapters/cloudlink/memory/src/index.js";
import { NodeCloudLinkBusinessPayloadDigestor } from "../adapters/cloudlink/node-crypto/src/index.js";
import {
  connectNodeMqttTransport,
  type MqttInboundEvent,
} from "../adapters/cloudlink/mqtt/src/index.js";
import {
  InMemoryRuntimeManifestRepository,
  NodeRuntimeManifestIntegrityVerifier,
} from "../adapters/runtime/memory/src/index.js";
import {
  InMemoryTelemetryRepository,
  NodeTelemetryBatchDigestor,
} from "../adapters/telemetry/memory/src/index.js";
import {
  parseCloudLinkSessionId,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "../packages/domain/src/index.js";
import {
  startCloudLinkMqttIngress,
  type CloudLinkApplicationCommand,
  type CloudLinkApplicationUnaryCommand,
  type CloudLinkMqttDuplexTransport,
  type CloudLinkMqttTransportConnector,
} from "../apps/cloudlink/src/index.js";
import {
  createCloudLinkDualSessionComposition,
  type GatewaySignedSessionCommands,
} from "./cloudlink-dual-session-composition.js";

type JsonRecord = Record<string, unknown>;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const evidencePath = requiredEnvironment("AETHER_DUAL_EVIDENCE_LOG");
const topicPrefix = requiredEnvironment("AETHER_DUAL_TOPIC_PREFIX");
const gatewayId = parseGatewayId(requiredEnvironment("AETHER_DUAL_GATEWAY_ID"));
const gatewayKeyId = requiredEnvironment("AETHER_DUAL_GATEWAY_KEY_ID");
if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(gatewayKeyId)) {
  throw new Error("AETHER_DUAL_GATEWAY_KEY_ID is invalid");
}
const encodedGatewayPublicKey = requiredEnvironment(
  "AETHER_DUAL_GATEWAY_PUBLIC_KEY",
);
if (!/^[A-Za-z0-9_-]{43}$/.test(encodedGatewayPublicKey)) {
  throw new Error("AETHER_DUAL_GATEWAY_PUBLIC_KEY is invalid");
}
const gatewayPublicKeyBytes = Buffer.from(encodedGatewayPublicKey, "base64url");
if (
  gatewayPublicKeyBytes.length !== 32 ||
  gatewayPublicKeyBytes.toString("base64url") !== encodedGatewayPublicKey
) {
  throw new Error("AETHER_DUAL_GATEWAY_PUBLIC_KEY is not canonical Ed25519");
}
const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
const gatewayPublicKey = createPublicKey({
  key: Buffer.concat([ed25519SpkiPrefix, gatewayPublicKeyBytes]),
  format: "der",
  type: "spki",
});
const configuredBrokerUrl = process.env.AETHER_DUAL_BROKER_URL;
const configuredBrokerPort = process.env.AETHER_DUAL_BROKER_PORT;
const brokerPort =
  configuredBrokerPort === undefined ? undefined : Number(configuredBrokerPort);
const generation = Number(requiredEnvironment("AETHER_DUAL_CLOUD_GENERATION"));
if (
  configuredBrokerUrl === undefined &&
  (brokerPort === undefined ||
    !Number.isSafeInteger(brokerPort) ||
    brokerPort < 1 ||
    brokerPort > 65_535)
) {
  throw new Error(
    "AETHER_DUAL_BROKER_PORT must be a TCP port when no Broker URL is configured",
  );
}
if (!Number.isSafeInteger(generation) || generation < 1 || generation > 99) {
  throw new Error("AETHER_DUAL_CLOUD_GENERATION must be 1-99");
}

const tlsPaths = [
  process.env.AETHER_DUAL_BROKER_CA_PATH,
  process.env.AETHER_DUAL_BROKER_CLIENT_CERTIFICATE_PATH,
  process.env.AETHER_DUAL_BROKER_CLIENT_PRIVATE_KEY_PATH,
] as const;
if (
  tlsPaths.some((value) => value !== undefined) &&
  tlsPaths.some((value) => value === undefined || value.length === 0)
) {
  throw new Error(
    "CloudLink dual Broker mTLS files must be configured together",
  );
}
const tls = tlsPaths.every(
  (value): value is string => value !== undefined && value.length > 0,
)
  ? {
      caPath: tlsPaths[0],
      clientCertificatePath: tlsPaths[1],
      clientPrivateKeyPath: tlsPaths[2],
    }
  : undefined;
const brokerUrl =
  configuredBrokerUrl ?? `mqtt://127.0.0.1:${String(brokerPort)}`;
const cloudClientId =
  process.env.AETHER_DUAL_CLOUD_CLIENT_ID ??
  `aethercloud-dual-${String(generation)}-${String(process.pid)}`;

function evidence(event: string, fields: JsonRecord = {}): void {
  appendFileSync(
    evidencePath,
    `${JSON.stringify({
      source: "aethercloud",
      cloud_generation: generation,
      event,
      at: new Date().toISOString(),
      ...fields,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultEvidence(result: unknown): JsonRecord {
  if (!isRecord(result)) return { outcome: "invalid-result" };
  if (result.ok === true) {
    const value = isRecord(result.value) ? result.value : {};
    const receipt = isRecord(value.receipt) ? value.receipt : undefined;
    return {
      outcome: "ok",
      replayed: result.replayed === true,
      ...(value.durablyAcknowledged === undefined
        ? {}
        : { durably_acknowledged: value.durablyAcknowledged }),
      ...(receipt === undefined
        ? {}
        : {
            receipt_id:
              typeof receipt.receiptId === "string"
                ? receipt.receiptId
                : "present",
            gap: isRecord(receipt.gap),
          }),
    };
  }
  const failure = isRecord(result.failure) ? result.failure : {};
  return {
    outcome: "rejected",
    failure_code:
      typeof failure.code === "string" ? failure.code : "unknown-failure",
  };
}

class HarnessClock implements ApplicationClock {
  now() {
    return parseUtcInstant("2024-07-14T23:33:20.400Z");
  }

  nowMilliseconds(): string {
    return "1721000000400";
  }
}

class SessionIds {
  #next = 1;

  next() {
    const suffix = generation * 100 + this.#next++;
    return parseCloudLinkSessionId(
      `44444444-4444-4444-8444-${String(suffix).padStart(12, "0")}`,
    );
  }
}

class ObservedCommand implements CloudLinkApplicationCommand {
  readonly #name: string;
  readonly #inner: CloudLinkApplicationCommand;

  constructor(name: string, inner: CloudLinkApplicationCommand) {
    this.#name = name;
    this.#inner = inner;
  }

  async execute(context: unknown, input: unknown): Promise<unknown> {
    const result = await this.#inner.execute(context, input);
    evidence("application-command", {
      command: this.#name,
      ...resultEvidence(result),
    });
    return result;
  }
}

class ObservedUnaryCommand implements CloudLinkApplicationUnaryCommand {
  readonly #name: string;
  readonly #inner: CloudLinkApplicationUnaryCommand;

  constructor(name: string, inner: CloudLinkApplicationUnaryCommand) {
    this.#name = name;
    this.#inner = inner;
  }

  async execute(input: unknown): Promise<unknown> {
    const result = await this.#inner.execute(input);
    evidence("application-command", {
      command: this.#name,
      ...resultEvidence(result),
    });
    return result;
  }
}

class FaultableTelemetryCommand implements CloudLinkApplicationCommand {
  readonly #inner: CloudLinkApplicationCommand;

  constructor(inner: CloudLinkApplicationCommand) {
    this.#inner = inner;
  }

  async execute(context: unknown, input: unknown): Promise<unknown> {
    const request = isRecord(context) ? context : {};
    if (request.idempotencyKey === "cloudlink:partial-success") {
      const result = {
        ok: true,
        value: { disposition: "buffered", durablyAcknowledged: false },
      };
      evidence("application-command", {
        command: "ingest-telemetry",
        scenario: "partial-success",
        ...resultEvidence(result),
      });
      return result;
    }
    const result = await this.#inner.execute(context, input);
    evidence("application-command", {
      command: "ingest-telemetry",
      ...resultEvidence(result),
    });
    return result;
  }
}

class DataLossCommand implements CloudLinkApplicationCommand {
  readonly #facts = new Map<string, string>();

  execute(_context: unknown, input: unknown): Promise<unknown> {
    const value = isRecord(input) ? input : {};
    const identity = [
      value.stream_id,
      value.stream_epoch,
      value.first_lost_position,
      value.last_lost_position,
      value.earliest_retained_position,
    ].join(":");
    const stable = JSON.stringify(value);
    const prior = this.#facts.get(identity);
    if (prior !== undefined && prior !== stable) {
      const result = {
        ok: false,
        failure: {
          code: "data-loss-conflict",
          message: "data-loss identity was reused with different evidence",
        },
      };
      evidence("application-command", {
        command: "record-data-loss",
        ...resultEvidence(result),
      });
      return Promise.resolve(result);
    }
    this.#facts.set(identity, stable);
    const result = { ok: true, value: { recorded: true } };
    evidence("application-command", {
      command: "record-data-loss",
      fact_count: this.#facts.size,
      ...resultEvidence(result),
    });
    return Promise.resolve(result);
  }
}

class FaultInjectingTransport implements CloudLinkMqttDuplexTransport {
  readonly #inner: CloudLinkMqttDuplexTransport;
  #droppedTelemetryAck = false;

  constructor(inner: CloudLinkMqttDuplexTransport) {
    this.#inner = inner;
  }

  subscribe(
    topics: readonly string[],
    handler: (event: MqttInboundEvent) => void,
  ): Promise<void> {
    return this.#inner.subscribe(topics, handler);
  }

  publish(topic: string, payload: Uint8Array): Promise<void> {
    const raw = JSON.parse(new TextDecoder().decode(payload)) as JsonRecord;
    if (
      raw.message_kind === "durable-ack" &&
      (raw.batch_id === "telemetry-ack-loss" ||
        raw.batch_id === "telemetry-dual") &&
      generation === 1 &&
      !this.#droppedTelemetryAck
    ) {
      this.#droppedTelemetryAck = true;
      evidence("fault-injected", {
        scenario: "ack-loss",
        action: "dropped-application-ack",
        batch_id: raw.batch_id,
      });
      return Promise.resolve();
    }
    evidence("downlink-published", {
      message_kind: raw.message_kind,
      batch_id: raw.batch_id,
      acknowledged_position: raw.acknowledged_position,
      ...(raw.message_kind === "session-accepted" && Array.isArray(raw.resume)
        ? { resume: raw.resume }
        : {}),
      topic,
    });
    return this.#inner.publish(topic, payload);
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}

const connector: CloudLinkMqttTransportConnector = {
  async connect(input: unknown): Promise<CloudLinkMqttDuplexTransport> {
    return new FaultInjectingTransport(await connectNodeMqttTransport(input));
  },
};

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const clock = new HarnessClock();
const sessions = new InMemoryCloudLinkSessionRepository();
const sessionIds = new SessionIds();
const { credentialVerifier, sessionCommands } =
  createCloudLinkDualSessionComposition({
    sessions,
    clock,
    sessionIds,
    tenantId,
    projectId,
    gatewayId,
    gatewayKeyId,
    gatewayPublicKey,
  });
const telemetry = new InMemoryTelemetryRepository();
const runtimeManifests = new InMemoryRuntimeManifestRepository();
const businessPayloadDigestor = new NodeCloudLinkBusinessPayloadDigestor();
const observedSessionCommands = {
  requestSessionChallenge: new ObservedUnaryCommand(
    "request-gateway-signed-session-challenge",
    sessionCommands.requestSessionChallenge,
  ),
  acceptGatewaySignedSession: new ObservedUnaryCommand(
    "accept-gateway-signed-session",
    sessionCommands.acceptGatewaySignedSession,
  ),
  authenticateGatewaySignedUplink: new ObservedUnaryCommand(
    "authenticate-gateway-signed-uplink",
    sessionCommands.authenticateGatewaySignedUplink,
  ),
  gatewaySignedScope: sessionCommands.gatewaySignedScope,
} satisfies GatewaySignedSessionCommands;

const ingress = await startCloudLinkMqttIngress({
  connection: {
    url: brokerUrl,
    clientId: cloudClientId,
    connectTimeoutMs: 5_000,
    protocolVersion: 4,
    ...(tls === undefined ? {} : { tls }),
  },
  connector,
  topicPrefix,
  ...observedSessionCommands,
  openSession: new ObservedCommand(
    "open-session",
    new OpenCloudLinkSession({
      repository: sessions,
      credentialVerifier,
      clock,
      sessionIds,
      supportedProtocolVersions: ["1.0"],
    }),
  ),
  heartbeat: new ObservedCommand(
    "record-heartbeat",
    new RecordCloudLinkHeartbeat({
      repository: sessions,
      credentialVerifier,
      clock,
    }),
  ),
  reportManifest: new ObservedCommand(
    "report-runtime-manifest",
    new ReportGatewayRuntimeManifest({
      repository: runtimeManifests,
      credentialVerifier,
      integrityVerifier: new NodeRuntimeManifestIntegrityVerifier(),
      businessPayloadDigestor,
      clock,
    }),
  ),
  recordDurableCursor: new ObservedCommand(
    "record-durable-cursor",
    new RecordCloudLinkDurableCursor({
      repository: sessions,
      credentialVerifier,
      businessPayloadDigestor,
      clock,
    }),
  ),
  ingestTelemetry: new FaultableTelemetryCommand(
    new IngestTelemetryBatch({
      credentialVerifier,
      digestor: new NodeTelemetryBatchDigestor(),
      repository: telemetry,
      businessPayloadDigestor,
      clock,
    }),
  ),
  recordDataLoss: new DataLossCommand(),
  clock,
  observer: {
    messageHandled(result) {
      evidence("ingress-result", {
        outcome: result.outcome,
        ...(result.outcome === "discarded"
          ? {
              failure_code: result.failure.code,
              contract_code:
                "contract_code" in result.failure
                  ? result.failure.contract_code
                  : undefined,
            }
          : {}),
        telemetry_fact_count: telemetry.historyRecordCount(),
      });
    },
    internalFailure() {
      evidence("ingress-internal-failure");
    },
  },
});

evidence("worker-ready", {
  broker_kind: process.env.AETHER_DUAL_BROKER_KIND ?? "local-mqtt",
  topic_prefix: topicPrefix,
  authentication_gate: "gateway-signed-challenge",
  persistence: "process-local-memory",
});

let closing = false;
async function close(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  evidence("worker-stopping", {
    signal,
    telemetry_fact_count: telemetry.historyRecordCount(),
  });
  await ingress.close();
  process.exitCode = 0;
}

process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

await new Promise<void>((resolve) => {
  process.once("beforeExit", () => {
    resolve();
  });
});
