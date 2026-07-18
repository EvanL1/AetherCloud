import { spawn, type ChildProcess } from "node:child_process";
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  createHash,
  type KeyObject,
} from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  AcceptGatewaySignedCloudLinkSession,
  AuthenticateGatewaySignedCloudLinkUplink,
  CreateIntegrationPowerControl,
  OpenCloudLinkSession,
  RecordCloudLinkDurableCursor,
  RecordCloudLinkHeartbeat,
  RequestCloudLinkSessionChallenge,
  ReportGatewayRuntimeManifest,
  ReportIntegrationObservations,
  ReportIntegrationTopology,
  RestoreGatewayRuntimeProtocols,
  type ApplicationClock,
} from "../packages/application/src/index.js";
import {
  InMemoryCloudLinkSessionRepository,
  InMemoryGatewayCredentialVerifier,
} from "../adapters/cloudlink/memory/src/index.js";
import {
  connectNodeMqttTransport,
  type NodeMqttTransport,
} from "../adapters/cloudlink/mqtt/src/index.js";
import {
  NodeCloudLinkBusinessPayloadDigestor,
  NodeCloudLinkSessionChallengeMaterialGenerator,
  NodeEd25519CloudLinkGatewayHelloAuthenticator,
  NodeEd25519CloudLinkSessionChallengeSigner,
  NodeEd25519CloudLinkUplinkVerifier,
} from "../adapters/cloudlink/node-crypto/src/index.js";
import { InMemoryIntegrationControlRepository } from "../adapters/integration-control/memory/src/index.js";
import {
  NodeEd25519IntegrationControlOfferSigner,
  NodeEd25519IntegrationControlReceiptAuthenticator,
  NodeIntegrationControlIntentDigestor,
} from "../adapters/integration-control/node-crypto/src/index.js";
import {
  InMemoryIntegrationProjectionRepository,
  NodeIntegrationPayloadDigestor,
} from "../adapters/integration-projection/memory/src/index.js";
import {
  InMemoryRuntimeManifestRepository,
  NodeRuntimeManifestIntegrityVerifier,
} from "../adapters/runtime/memory/src/index.js";
import {
  INTEGRATION_CONTROL_PROTOCOL,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseGovernedJobId,
  parseIntegrationId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "../packages/domain/src/index.js";
import {
  createCloudLinkIntegrationControlFactory,
  startCloudLinkMqttIngress,
  type CloudLinkApplicationCommand,
  type RunningCloudLinkMqttIngress,
} from "../apps/cloudlink/src/index.js";
import {
  createGatewaySessionChallengeRequest,
  createGatewaySignedSessionHello,
  decodeCloudSessionDownlink,
  evaluateCloudSessionChallenge,
} from "./home-assistant-e2e-gateway-session.js";

type JsonRecord = Record<string, unknown>;

const runSetting = "AETHER_CLOUD_RUN_HOME_ASSISTANT_E2E";
const integrationProtocol = "aether.cloudlink.integration.v1alpha1";
const integrationId = parseIntegrationId("home-assistant.home");
const entityId = "entity-registry-light-bedroom";
const credential = Object.freeze({
  credentialId: "development-binding-17",
  proof:
    "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
});
const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(input: unknown): input is JsonRecord {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function selectedEnvironment(keys: readonly string[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function applicationFailureCode(result: unknown): string {
  if (!isRecord(result) || !isRecord(result.failure)) return "invalid-result";
  return typeof result.failure.code === "string"
    ? result.failure.code
    : "unknown-failure";
}

function assertApplicationSuccess(result: unknown, operation: string): void {
  if (!isRecord(result) || result.ok !== true) {
    throw new Error(`${operation} failed: ${applicationFailureCode(result)}`);
  }
}

class SystemClock implements ApplicationClock {
  now() {
    return parseUtcInstant(new Date().toISOString());
  }

  nowMilliseconds(): string {
    return String(Date.now());
  }
}

class RandomSessionIds {
  next() {
    return parseCloudLinkSessionId(randomUUID());
  }
}

class UnusedCommand implements CloudLinkApplicationCommand {
  execute(): Promise<unknown> {
    return Promise.resolve({
      ok: false,
      failure: {
        code: "unused-command",
        message: "the Home Assistant harness does not use this command",
      },
    });
  }
}

class ObservedCommand implements CloudLinkApplicationCommand {
  readonly #name: string;
  readonly #inner: CloudLinkApplicationCommand;
  readonly #diagnostics: string[];

  constructor(
    name: string,
    inner: CloudLinkApplicationCommand,
    diagnostics: string[],
  ) {
    this.#name = name;
    this.#inner = inner;
    this.#diagnostics = diagnostics;
  }

  async execute(context: unknown, input: unknown): Promise<unknown> {
    const result = await this.#inner.execute(context, input);
    this.#diagnostics.push(
      isRecord(result) && result.ok === true
        ? `${this.#name}:ok`
        : `${this.#name}:${applicationFailureCode(result)}`,
    );
    return result;
  }
}

class ObservedUnaryCommand {
  readonly #name: string;
  readonly #inner: Readonly<{ execute(input: unknown): Promise<unknown> }>;
  readonly #diagnostics: string[];

  constructor(
    name: string,
    inner: Readonly<{ execute(input: unknown): Promise<unknown> }>,
    diagnostics: string[],
  ) {
    this.#name = name;
    this.#inner = inner;
    this.#diagnostics = diagnostics;
  }

  async execute(input: unknown): Promise<unknown> {
    const result = await this.#inner.execute(input);
    this.#diagnostics.push(
      isRecord(result) && result.ok === true
        ? `${this.#name}:${result.replayed === true ? "replayed" : "ok"}`
        : `${this.#name}:${applicationFailureCode(result)}`,
    );
    return result;
  }
}

function commandContext(idempotencyKey: string): JsonRecord {
  const now = Date.now();
  return {
    idempotencyKey,
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
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
  assert(isRecord(value), "canonical JSON value must be JSON-compatible");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function commissionedRuntimeManifest(): JsonRecord {
  const fixturePath = resolve(
    import.meta.dirname,
    "../contracts/cloudlink/v1/fixtures/runtime-manifest-report.valid.json",
  );
  const envelope = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
  assert(isRecord(envelope), "Runtime Manifest fixture must be an object");
  assert(
    isRecord(envelope.payload),
    "Runtime Manifest payload must be an object",
  );
  const manifest = envelope.payload.manifest;
  assert(isRecord(manifest), "Runtime Manifest must be an object");
  assert(
    Array.isArray(manifest.protocols) &&
      manifest.protocols.every((protocol) => typeof protocol === "string"),
    "Runtime Manifest protocols must be strings",
  );
  manifest.protocols = [
    ...new Set([
      ...manifest.protocols,
      integrationProtocol,
      INTEGRATION_CONTROL_PROTOCOL,
    ]),
  ].sort();
  const unsigned = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== "checksum"),
  );
  manifest.checksum = {
    algorithm: "sha256",
    digest: createHash("sha256")
      .update(canonicalJson(unsigned), "utf8")
      .digest("hex"),
  };
  return manifest;
}

interface SessionDownlinkEvent {
  readonly topic: string;
  readonly payload: Uint8Array;
}

async function waitForSessionDownlink(
  events: readonly SessionDownlinkEvent[],
  startIndex: number,
  topicPrefix: string,
  gatewayId: string,
  expectedKind: "session-accepted" | "session-challenge",
): Promise<
  Readonly<{
    index: number;
    message: ReturnType<typeof decodeCloudSessionDownlink>;
    payload: Uint8Array;
  }>
> {
  return waitUntil(`CloudLink ${expectedKind}`, 10_000, () => {
    for (let index = startIndex; index < events.length; index += 1) {
      const event = events[index];
      if (event === undefined) continue;
      const message = decodeCloudSessionDownlink({
        topicPrefix,
        gatewayId,
        topic: event.topic,
        payload: event.payload,
      });
      if (message.message_kind === expectedKind) {
        return Promise.resolve({ index, message, payload: event.payload });
      }
    }
    return Promise.resolve(undefined);
  });
}

async function verifyGatewaySignedSessionPath(input: {
  readonly transport: NodeMqttTransport;
  readonly topicPrefix: string;
  readonly gatewayId: string;
  readonly sessionDownlinks: readonly SessionDownlinkEvent[];
  readonly cloudPublicKey: KeyObject;
  readonly wrongCloudPublicKey: KeyObject;
  readonly gatewayPrivateKey: KeyObject;
}): Promise<
  Readonly<{
    sessionId: string;
    sessionEpoch: string;
  }>
> {
  const request = createGatewaySessionChallengeRequest({
    topicPrefix: input.topicPrefix,
    gatewayId: input.gatewayId,
    credentialId: credential.credentialId,
    credentialGeneration: "3",
    clientNonce: randomBytes(32).toString("base64url"),
  });
  const firstOffset = input.sessionDownlinks.length;
  await input.transport.publish(request.topic, request.payload);
  const firstChallenge = await waitForSessionDownlink(
    input.sessionDownlinks,
    firstOffset,
    input.topicPrefix,
    input.gatewayId,
    "session-challenge",
  );
  assert(
    firstChallenge.message.message_kind === "session-challenge",
    "CloudLink returned the wrong session response",
  );
  assert(
    evaluateCloudSessionChallenge(
      firstChallenge.message,
      input.wrongCloudPublicKey,
      BigInt(Date.now()),
    ) === "invalid-signature",
    "an unrelated Cloud public key unexpectedly verified the challenge",
  );
  assert(
    evaluateCloudSessionChallenge(
      firstChallenge.message,
      input.cloudPublicKey,
      BigInt(Date.now()),
    ) === "valid",
    "the configured Cloud public key did not verify the live challenge",
  );

  const replayOffset = firstChallenge.index + 1;
  await input.transport.publish(request.topic, request.payload);
  const replayedChallenge = await waitForSessionDownlink(
    input.sessionDownlinks,
    replayOffset,
    input.topicPrefix,
    input.gatewayId,
    "session-challenge",
  );
  assert(
    Buffer.from(replayedChallenge.payload).equals(
      Buffer.from(firstChallenge.payload),
    ),
    "an exact challenge request retry did not return byte-identical state",
  );

  const hello = createGatewaySignedSessionHello({
    topicPrefix: input.topicPrefix,
    request: request.message,
    challenge: firstChallenge.message,
    gatewayKeyId: "gateway-session-key-17",
    privateKey: input.gatewayPrivateKey,
  });
  const acceptedOffset = replayedChallenge.index + 1;
  await input.transport.publish(hello.topic, hello.payload);
  const firstAccepted = await waitForSessionDownlink(
    input.sessionDownlinks,
    acceptedOffset,
    input.topicPrefix,
    input.gatewayId,
    "session-accepted",
  );
  assert(
    firstAccepted.message.message_kind === "session-accepted",
    "CloudLink did not accept the Gateway-signed hello",
  );

  const acceptedReplayOffset = firstAccepted.index + 1;
  await input.transport.publish(hello.topic, hello.payload);
  const replayedAccepted = await waitForSessionDownlink(
    input.sessionDownlinks,
    acceptedReplayOffset,
    input.topicPrefix,
    input.gatewayId,
    "session-accepted",
  );
  assert(
    replayedAccepted.message.message_kind === "session-accepted" &&
      replayedAccepted.message.session_id ===
        firstAccepted.message.session_id &&
      replayedAccepted.message.session_epoch ===
        firstAccepted.message.session_epoch,
    "an exact Gateway hello retry did not recover the original session",
  );
  return {
    sessionId: firstAccepted.message.session_id,
    sessionEpoch: firstAccepted.message.session_epoch,
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("cannot allocate a loopback Broker port"));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolvePromise(address.port);
        else reject(error);
      });
    });
  });
}

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolvePromise) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolvePromise(true);
      });
      socket.once("error", () => {
        resolvePromise(false);
      });
    });
    if (ready) return;
    await sleep(50);
  }
  throw new Error(`temporary Broker did not listen on port ${String(port)}`);
}

function childExit(child: ChildProcess): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  if (child.signalCode !== null) return Promise.resolve(128);
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      resolvePromise(code ?? 128);
    });
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (
    child === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    childExit(child).then(() => true),
    sleep(5_000).then(() => false),
  ]);
  if (!stopped) {
    child.kill("SIGKILL");
    await childExit(child);
  }
}

async function waitUntil<Value>(
  description: string,
  timeoutMs: number,
  query: () => Promise<Value | undefined>,
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await query();
    if (value !== undefined) return value;
    await sleep(50);
  }
  throw new Error(`${description} was not observed before the deadline`);
}

function appendEvidence(path: string, event: JsonRecord): void {
  appendFileSync(path, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function jwkMember(key: KeyObject, member: "d" | "x"): string {
  const value = key.export({ format: "jwk" })[member];
  assert(
    typeof value === "string" && value.length > 0,
    `generated Ed25519 key is missing ${member}`,
  );
  return value;
}

function readEvidence(path: string): readonly JsonRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const value = JSON.parse(line) as unknown;
      assert(isRecord(value), "evidence line must be a JSON object");
      return value;
    });
}

assert(
  process.env[runSetting] === "1",
  `set ${runSetting}=1 or run pnpm test:home-assistant-e2e`,
);
assert(
  process.platform !== "win32",
  "the real Home Assistant harness currently requires Unix file permissions",
);

const cloudRoot = resolve(import.meta.dirname, "..");
const edgeRoot = resolve(
  process.env.AETHEREDGE_ROOT ?? resolve(cloudRoot, "../AetherEdge"),
);
assert(
  existsSync(resolve(edgeRoot, "Cargo.toml")),
  `AetherEdge was not found at ${edgeRoot}`,
);
const mosquitto =
  process.env.MOSQUITTO_BIN ??
  (existsSync("/opt/homebrew/sbin/mosquitto")
    ? "/opt/homebrew/sbin/mosquitto"
    : "mosquitto");
const temporaryRoot = mkdtempSync(
  resolve(tmpdir(), "aether-home-assistant-e2e-"),
);
chmodSync(temporaryRoot, 0o700);
const evidencePath = resolve(temporaryRoot, "evidence.jsonl");
const brokerConfig = resolve(temporaryRoot, "mosquitto.conf");
writeFileSync(evidencePath, "", { mode: 0o600 });

const port = await freePort();
writeFileSync(
  brokerConfig,
  `listener ${String(port)} 127.0.0.1\nallow_anonymous true\npersistence false\n`,
  { encoding: "utf8", mode: 0o600 },
);
const runId = randomUUID().replaceAll("-", "");
const gatewayId = parseGatewayId(randomUUID());
const jobId = randomUUID();
const topicPrefix = `aether-ha-e2e/${runId}`;
const clock = new SystemClock();
const cloudSessionKeys = generateKeyPairSync("ed25519");
const wrongCloudSessionKeys = generateKeyPairSync("ed25519");
const gatewaySessionKeys = generateKeyPairSync("ed25519");
const cloudControlKeys = generateKeyPairSync("ed25519");
const sessions = new InMemoryCloudLinkSessionRepository();
const cloudLinkBusinessPayloadDigestor =
  new NodeCloudLinkBusinessPayloadDigestor();
const manifests = new InMemoryRuntimeManifestRepository();
const projections = new InMemoryIntegrationProjectionRepository({
  sessionFenceVerifier: sessions,
});
const controls = new InMemoryIntegrationControlRepository();
const diagnostics: string[] = [];
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
const reportManifest = new ReportGatewayRuntimeManifest({
  repository: manifests,
  credentialVerifier: verifier,
  integrityVerifier: new NodeRuntimeManifestIntegrityVerifier(),
  businessPayloadDigestor: cloudLinkBusinessPayloadDigestor,
  clock,
});
const offerSigner = new NodeEd25519IntegrationControlOfferSigner({
  keyReference: "cloud-control-key-1",
  privateKey: cloudControlKeys.privateKey,
});
const failures: string[] = [];
let broker: ChildProcess | undefined;
let edge: ChildProcess | undefined;
let ingress: RunningCloudLinkMqttIngress | undefined;
let harnessTransport: NodeMqttTransport | undefined;
let cleaning = false;
let passedSummary: JsonRecord | undefined;

async function cleanup(): Promise<void> {
  if (cleaning) return;
  cleaning = true;
  if (ingress !== undefined) {
    await ingress.close().catch(() => undefined);
  }
  if (harnessTransport !== undefined) {
    await harnessTransport.close().catch(() => undefined);
  }
  await stopChild(edge);
  await stopChild(broker);
}

const terminate = (): void => {
  void cleanup().finally(() => {
    rmSync(temporaryRoot, { force: true, recursive: true });
    process.exit(130);
  });
};
process.once("SIGINT", terminate);
process.once("SIGTERM", terminate);

try {
  broker = spawn(mosquitto, ["-c", brokerConfig], {
    cwd: temporaryRoot,
    env: selectedEnvironment([
      "PATH",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "LC_ALL",
    ]),
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitForPort(port);

  const seedResult = await reportManifest.execute(
    commandContext(`ha-e2e-manifest-${runId}`),
    {
      credential,
      generation: "1",
      observedAt: new Date(Date.now() - 100).toISOString(),
      manifest: commissionedRuntimeManifest(),
    },
  );
  assertApplicationSuccess(seedResult, "commissioned Runtime Manifest seed");

  ingress = await startCloudLinkMqttIngress({
    connection: {
      url: `mqtt://127.0.0.1:${String(port)}`,
      clientId: `aether-cloud-ha-e2e-${runId}`,
      protocolVersion: 4,
      connectTimeoutMs: 5_000,
    },
    topicPrefix,
    requestSessionChallenge: new ObservedUnaryCommand(
      "request-gateway-signed-session-challenge",
      new RequestCloudLinkSessionChallenge({
        repository: sessions,
        credentials: verifier,
        signer: new NodeEd25519CloudLinkSessionChallengeSigner({
          keyReference: "cloud-session-key-1",
          privateKey: cloudSessionKeys.privateKey,
        }),
        materials: new NodeCloudLinkSessionChallengeMaterialGenerator(),
        clock,
        supportedProtocolVersions: ["1.0"],
        enabled: true,
      }),
      diagnostics,
    ),
    acceptGatewaySignedSession: new ObservedUnaryCommand(
      "accept-gateway-signed-session",
      new AcceptGatewaySignedCloudLinkSession({
        repository: sessions,
        credentials: verifier,
        authenticator: new NodeEd25519CloudLinkGatewayHelloAuthenticator({
          resolvePublicKey(input) {
            return Promise.resolve(
              input.gatewayId === gatewayId &&
                input.credentialId === credential.credentialId &&
                input.credentialGeneration === "3" &&
                input.gatewayKeyId === "gateway-session-key-17"
                ? gatewaySessionKeys.publicKey
                : undefined,
            );
          },
        }),
        clock,
        sessionIds: new RandomSessionIds(),
        supportedProtocolVersions: ["1.0"],
        enabled: true,
      }),
      diagnostics,
    ),
    authenticateGatewaySignedUplink: new ObservedUnaryCommand(
      "authenticate-gateway-signed-uplink",
      new AuthenticateGatewaySignedCloudLinkUplink({
        sessions,
        repository: sessions,
        verifier: new NodeEd25519CloudLinkUplinkVerifier({
          resolvePublicKey(input) {
            return Promise.resolve(
              input.tenantId === tenantId &&
                input.projectId === projectId &&
                input.gatewayId === gatewayId &&
                input.credentialGeneration === "3" &&
                input.gatewayKeyId === "gateway-session-key-17"
                ? {
                    status: "active" as const,
                    publicKey: gatewaySessionKeys.publicKey,
                  }
                : undefined,
            );
          },
        }),
        clock,
        enabled: true,
      }),
      diagnostics,
    ),
    gatewaySignedScope: { tenantId, projectId },
    openSession: new ObservedCommand(
      "open-session",
      new OpenCloudLinkSession({
        repository: sessions,
        credentialVerifier: verifier,
        clock,
        sessionIds: new RandomSessionIds(),
        supportedProtocolVersions: ["1.0"],
      }),
      diagnostics,
    ),
    heartbeat: new ObservedCommand(
      "heartbeat",
      new RecordCloudLinkHeartbeat({
        repository: sessions,
        credentialVerifier: verifier,
        clock,
      }),
      diagnostics,
    ),
    reportManifest,
    restoreRuntimeProtocols: new RestoreGatewayRuntimeProtocols({
      repository: manifests,
      credentialVerifier: verifier,
    }),
    ingestTelemetry: new UnusedCommand(),
    reportIntegrationTopology: new ObservedCommand(
      "report-integration-topology",
      new ReportIntegrationTopology({
        repository: projections,
        verifier,
        digestor: new NodeIntegrationPayloadDigestor(),
        businessPayloadDigestor: cloudLinkBusinessPayloadDigestor,
        clock,
      }),
      diagnostics,
    ),
    reportIntegrationObservations: new ObservedCommand(
      "report-integration-observations",
      new ReportIntegrationObservations({
        repository: projections,
        verifier,
        digestor: new NodeIntegrationPayloadDigestor(),
        businessPayloadDigestor: cloudLinkBusinessPayloadDigestor,
        clock,
      }),
      diagnostics,
    ),
    recordDurableCursor: new ObservedCommand(
      "record-durable-cursor",
      new RecordCloudLinkDurableCursor({
        repository: sessions,
        credentialVerifier: verifier,
        businessPayloadDigestor: cloudLinkBusinessPayloadDigestor,
        clock,
      }),
      diagnostics,
    ),
    integrationControlFactory: createCloudLinkIntegrationControlFactory({
      repository: controls,
      sessions,
      manifests,
      credentialVerifier: verifier,
      authenticator: new NodeEd25519IntegrationControlReceiptAuthenticator({
        resolvePublicKey() {
          // Gateway-signed receipts are authenticated once by the CloudLink
          // per-uplink verifier and never enter this legacy verifier.
          return Promise.resolve(undefined);
        },
      }),
      signer: offerSigner,
      clock,
    }),
    enabledExtensions: [integrationProtocol, INTEGRATION_CONTROL_PROTOCOL],
    clock,
    observer: {
      messageHandled(result) {
        if (result.outcome === "discarded") {
          failures.push(`${result.failure.code}:${result.failure.message}`);
        } else if (result.outcome === "rejected") {
          failures.push("application-rejected");
        }
      },
      internalFailure() {
        failures.push("internal-failure");
      },
    },
  });
  harnessTransport = await connectNodeMqttTransport({
    url: `mqtt://127.0.0.1:${String(port)}`,
    clientId: `aether-cloud-ha-harness-${runId}`,
    protocolVersion: 4,
    connectTimeoutMs: 5_000,
  });
  const sessionDownlinks: SessionDownlinkEvent[] = [];
  const sessionDownlinkTopic = `${topicPrefix}/v1/gateways/${gatewayId}/down/session`;
  const receiptTopic = `${topicPrefix}/v1/gateways/${gatewayId}/up/integration-control/receipts`;
  await harnessTransport.subscribe(
    [sessionDownlinkTopic, receiptTopic],
    (event) => {
      if (event.topic === sessionDownlinkTopic) {
        sessionDownlinks.push({
          topic: event.topic,
          payload: Uint8Array.from(event.payload),
        });
        return;
      }
      if (event.topic === receiptTopic) {
        try {
          const envelope = JSON.parse(
            new TextDecoder().decode(event.payload),
          ) as unknown;
          const payload =
            isRecord(envelope) && isRecord(envelope.payload)
              ? envelope.payload
              : {};
          diagnostics.push(
            `edge-receipt-shape:${String(payload.stage)}:${Object.keys(payload)
              .sort()
              .join("+")}`,
          );
        } catch {
          diagnostics.push("edge-receipt-shape:invalid-json");
        }
      }
    },
  );
  const signedSession = await verifyGatewaySignedSessionPath({
    transport: harnessTransport,
    topicPrefix,
    gatewayId,
    sessionDownlinks,
    cloudPublicKey: cloudSessionKeys.publicKey,
    wrongCloudPublicKey: wrongCloudSessionKeys.publicKey,
    gatewayPrivateKey: gatewaySessionKeys.privateKey,
  });
  appendEvidence(evidencePath, {
    source: "aethercloud",
    event: "gateway-signed-session-verified",
    gateway_id: gatewayId,
    session_id: signedSession.sessionId,
    session_epoch: signedSession.sessionEpoch,
    exact_challenge_retry_verified: true,
    exact_hello_retry_verified: true,
    wrong_cloud_key_rejected: true,
  });
  appendEvidence(evidencePath, {
    source: "aethercloud",
    event: "worker-ready",
    gateway_id: gatewayId,
    commissioned_runtime_manifest: true,
  });

  const edgeSessionDownlinkOffset = sessionDownlinks.length;
  edge = spawn(
    "cargo",
    [
      "test",
      "-p",
      "aether-io",
      "--lib",
      "--no-default-features",
      "--features",
      "home-assistant-integration-control",
      "real_broker_projects_home_assistant_and_completes_governed_control",
      "--",
      "--ignored",
      "--nocapture",
      "--test-threads=1",
    ],
    {
      cwd: edgeRoot,
      env: {
        ...selectedEnvironment([
          "PATH",
          "HOME",
          "CARGO_HOME",
          "RUSTUP_HOME",
          "RUSTUP_TOOLCHAIN",
          "CARGO_TARGET_DIR",
          "TMPDIR",
          "TMP",
          "TEMP",
          "LANG",
          "LC_ALL",
          "TERM",
          "NO_COLOR",
          "CARGO_TERM_COLOR",
          "SDKROOT",
          "MACOSX_DEPLOYMENT_TARGET",
          "CC",
          "CXX",
          "AR",
        ]),
        AETHER_HA_E2E_RUN: "1",
        AETHER_HA_E2E_BROKER_PORT: String(port),
        AETHER_HA_E2E_TOPIC_PREFIX: topicPrefix,
        AETHER_HA_E2E_GATEWAY_ID: gatewayId,
        AETHER_HA_E2E_EVIDENCE_LOG: evidencePath,
        AETHER_HA_E2E_CLOUD_PUBLIC_X: jwkMember(
          cloudControlKeys.publicKey,
          "x",
        ),
        AETHER_HA_E2E_CLOUD_SESSION_PUBLIC_X: jwkMember(
          cloudSessionKeys.publicKey,
          "x",
        ),
        AETHER_HA_E2E_GATEWAY_SESSION_PRIVATE_D: jwkMember(
          gatewaySessionKeys.privateKey,
          "d",
        ),
      },
      stdio: "inherit",
    },
  );
  const edgeExitPromise = childExit(edge);
  const edgeAcceptedSession = await Promise.race([
    waitForSessionDownlink(
      sessionDownlinks,
      edgeSessionDownlinkOffset,
      topicPrefix,
      gatewayId,
      "session-accepted",
    ),
    edgeExitPromise.then((code) => {
      throw new Error(
        `AetherEdge exited with ${String(code)} before its Gateway-signed session was accepted (${diagnostics.join(",")}; ${failures.join(",")})`,
      );
    }),
  ]);
  assert(
    edgeAcceptedSession.message.message_kind === "session-accepted",
    "AetherEdge did not establish a Gateway-signed CloudLink session",
  );
  appendEvidence(evidencePath, {
    source: "aethercloud",
    event: "edge-gateway-signed-session-active",
    gateway_id: gatewayId,
    session_id: edgeAcceptedSession.message.session_id,
    session_epoch: edgeAcceptedSession.message.session_epoch,
  });
  const projection = await Promise.race([
    waitUntil("durable Home Assistant projection", 45_000, async () => {
      const current = await projections.findCurrent({
        tenantId,
        projectId,
        gatewayId,
        integrationId,
      });
      return current !== undefined && current.latestObservations.length > 0
        ? current
        : undefined;
    }),
    edgeExitPromise.then((code) => {
      throw new Error(
        `AetherEdge exited with ${String(code)} before Cloud projection (${diagnostics.join(",")}; ${failures.join(",")})`,
      );
    }),
  ]);
  appendEvidence(evidencePath, {
    source: "aethercloud",
    event: "projection-ready",
    gateway_id: gatewayId,
    integration_id: integrationId,
    snapshot_generation: projection.topology.snapshotGeneration,
    observation_count: projection.latestObservations.length,
  });

  const now = Date.now();
  const createResult = await new CreateIntegrationPowerControl({
    repository: controls,
    sessions,
    manifests,
    projections,
    digestor: new NodeIntegrationControlIntentDigestor(),
    signer: offerSigner,
    clock,
    enabled: true,
  }).execute(
    {
      tenantId,
      projectId,
      subjectId: "user-homeowner",
      permissions: ["integration.device.control"],
      confirmation: {
        confirmationId: randomUUID(),
        subjectId: "user-homeowner",
        confirmedAtMs: String(now - 100),
      },
      authorization: {
        policyDecisionId: `ha-e2e-policy-${runId}`,
        subjectId: "user-homeowner",
        permission: "integration.device.control",
        authorizedAtMs: String(now - 100),
      },
      idempotencyKey: `ha-e2e-control-${runId}`,
      issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 120_000).toISOString(),
    },
    {
      gatewayId,
      jobId,
      integrationId,
      snapshotGeneration: projection.topology.snapshotGeneration,
      entityId,
      value: true,
      jobExpiresAtMs: String(now + 60_000),
    },
  );
  assertApplicationSuccess(createResult, "governed power control creation");
  const pumpResult = await ingress.pumpIntegrationControl(
    { tenantId, projectId },
    { gatewayId },
  );
  assert(
    pumpResult.outcome === "acknowledged",
    "Integration Control offer was not published",
  );
  appendEvidence(evidencePath, {
    source: "aethercloud",
    event: "control-offer-published",
    gateway_id: gatewayId,
    job_id: jobId,
  });

  const storedIntent = await Promise.race([
    waitUntil("authenticated Integration Control receipt", 30_000, async () => {
      if (failures.length > 0) {
        throw new Error("CloudLink ingress discarded the control receipt");
      }
      const current = await controls.findIntent(
        { tenantId, projectId },
        gatewayId,
        parseGovernedJobId(jobId),
      );
      return current?.latestReceipt === undefined ? undefined : current;
    }),
    edgeExitPromise.then((code) => {
      throw new Error(
        `AetherEdge exited with ${String(code)} before its receipt was persisted`,
      );
    }),
  ]).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown failure";
    throw new Error(
      `${message} (${diagnostics.join(",")}; ${failures.join(",")})`,
    );
  });
  assert(
    storedIntent.latestReceipt?.decision === "accepted" &&
      storedIntent.latestReceipt.stage === "provider-accepted",
    "Cloud did not atomically persist provider acceptance",
  );
  assert(
    controls.acknowledgementOutbox().length === 1,
    "Cloud durable acknowledgement was not staged",
  );
  appendEvidence(evidencePath, {
    source: "aethercloud",
    event: "control-complete",
    gateway_id: gatewayId,
    job_id: jobId,
    receipt_stage: storedIntent.latestReceipt.stage,
    receipt_decision: storedIntent.latestReceipt.decision,
    durable_acknowledgement_staged: true,
  });

  const edgeCode = await Promise.race([
    edgeExitPromise,
    sleep(30_000).then(() => -1),
  ]);
  if (edgeCode === -1) {
    throw new Error("AetherEdge did not finish after Cloud durable ACK");
  }
  assert(edgeCode === 0, `AetherEdge test exited with ${String(edgeCode)}`);

  const events = readEvidence(evidencePath);
  for (const required of [
    "gateway-signed-session-verified",
    "edge-gateway-signed-session-active",
    "worker-ready",
    "projection-ready",
    "control-offer-published",
    "control-complete",
    "edge-complete",
  ]) {
    assert(
      events.some((event) => event.event === required),
      `temporary evidence is missing ${required}`,
    );
  }
  assert(
    failures.length === 0,
    `CloudLink ingress rejected messages: ${failures.join(",")}`,
  );
  passedSummary = {
    outcome: "passed",
    broker: "temporary-loopback-mosquitto",
    cloud_ingress: "real-mqtt-application-bridge",
    gateway_signed_session:
      "real-request-cloud-signature-gateway-signature-atomic-acceptance",
    gateway_signed_replay: "exact-challenge-request-and-hello-retries-verified",
    wrong_cloud_key: "rejected",
    gateway_signed_business_uplinks:
      "per-uplink-ed25519-on-the-active-gateway-session",
    business_flow_session: "same-active-gateway-signed-session",
    edge_runtime: "aether-io-home-assistant-composition",
    home_assistant: "loopback-websocket-mock",
    projection: "topology-and-observations-durably-acknowledged",
    control:
      "signed-offer-provider-accepted-receipt-durable-ack-ledger-drained",
    production_end_to_end: false,
  };
} finally {
  process.removeListener("SIGINT", terminate);
  process.removeListener("SIGTERM", terminate);
  await cleanup();
  rmSync(temporaryRoot, { force: true, recursive: true });
}

console.log(
  JSON.stringify(
    {
      ...passedSummary,
      temporary_resources_cleaned: !existsSync(temporaryRoot),
    },
    null,
    2,
  ),
);
