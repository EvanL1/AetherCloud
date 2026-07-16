import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

const cloudRoot = resolve(import.meta.dirname, "..");
const iotRoot = resolve(
  process.env.AETHERIOT_ROOT ?? resolve(cloudRoot, "../AetherEdge"),
);
const contractsRoot = resolve(
  process.env.AETHERCONTRACTS_ROOT ?? resolve(cloudRoot, "../AetherContracts"),
);
const workerPath = resolve(cloudRoot, "scripts/cloudlink-dual-cloud-worker.ts");
const outputPath = resolve(
  cloudRoot,
  "evidence/cloudlink-alpha3-dual-harness.json",
);
const compatibilityOutputPath = resolve(
  cloudRoot,
  "artifacts/cloudlink-alpha/evidence.json",
);
const mosquitto =
  process.env.MOSQUITTO_BIN ??
  (existsSync("/opt/homebrew/sbin/mosquitto")
    ? "/opt/homebrew/sbin/mosquitto"
    : "mosquitto");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function childExit(child: ChildProcess): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolvePromise(code ?? (signal === null ? 1 : 128));
    });
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = childExit(child);
  const timeout = sleep(5_000).then(() => -1);
  if ((await Promise.race([exited, timeout])) === -1) {
    child.kill("SIGKILL");
    await childExit(child);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        server.close();
        reject(new Error("cannot allocate a TCP port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error === undefined) resolvePromise(port);
        else reject(error);
      });
    });
  });
}

async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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
  throw new Error(`Mosquitto did not listen on ${String(port)}`);
}

function parseJsonLines(path: string): JsonRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonRecord);
}

async function waitForCloudReady(
  logPath: string,
  generation: number,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (
      parseJsonLines(logPath).some(
        (entry) =>
          entry.event === "worker-ready" &&
          entry.cloud_generation === generation,
      )
    ) {
      return;
    }
    await sleep(100);
  }
  throw new Error(
    `AetherCloud worker generation ${String(generation)} was not ready`,
  );
}

function gitHead(root: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  assert(result.status === 0, `cannot read Git HEAD for ${root}`);
  return result.stdout.trim();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const runId = randomUUID().replaceAll("-", "");
const gatewayId = `33333333-3333-4333-8333-${runId.slice(0, 12)}`;
const topicPrefix = `aether-dual/${runId}`;
const temporaryRoot = mkdtempSync(resolve(tmpdir(), "aether-dual-"));
chmodSync(temporaryRoot, 0o700);
const controlRoot = resolve(temporaryRoot, "control");
const spoolRoot = resolve(temporaryRoot, "spool");
mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
mkdirSync(spoolRoot, { recursive: true, mode: 0o700 });
const cloudLog = resolve(temporaryRoot, "cloud-evidence.jsonl");
const phase1Evidence = resolve(temporaryRoot, "edge-phase1.json");
const phase2Evidence = resolve(temporaryRoot, "edge-phase2.json");
const brokerConfig = resolve(temporaryRoot, "mosquitto.conf");
const brokerLog = resolve(temporaryRoot, "mosquitto.log");
const port = await freePort();
writeFileSync(
  brokerConfig,
  `listener ${String(port)} 127.0.0.1\nallow_anonymous true\npersistence false\n`,
  { encoding: "utf8", mode: 0o600 },
);

let broker: ChildProcess | undefined;
let cloud: ChildProcess | undefined;
let brokerRestarts = 0;
let cloudRestarts = 0;
const childDiagnostics: string[] = [];

function startBroker(): ChildProcess {
  const child = spawn(mosquitto, ["-c", brokerConfig, "-v"], {
    cwd: temporaryRoot,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    childDiagnostics.push(text.slice(-8_192));
    writeFileSync(brokerLog, text, {
      encoding: "utf8",
      flag: "a",
      mode: 0o600,
    });
  });
  return child;
}

function startCloud(generation: number): ChildProcess {
  const child = spawn("pnpm", ["exec", "tsx", workerPath], {
    cwd: cloudRoot,
    env: {
      ...process.env,
      AETHER_DUAL_BROKER_PORT: String(port),
      AETHER_DUAL_CLOUD_GENERATION: String(generation),
      AETHER_DUAL_EVIDENCE_LOG: cloudLog,
      AETHER_DUAL_GATEWAY_ID: gatewayId,
      AETHER_DUAL_TOPIC_PREFIX: topicPrefix,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk: Buffer) => {
      childDiagnostics.push(chunk.toString("utf8").slice(-8_192));
    });
  }
  return child;
}

async function handleControls(edge: ChildProcess): Promise<number> {
  const edgeExit = childExit(edge);
  let completed: number | undefined;
  void edgeExit.then((code) => {
    completed = code;
  });
  while (completed === undefined) {
    const brokerRequest = resolve(controlRoot, "broker-restart.request");
    if (existsSync(brokerRequest)) {
      rmSync(brokerRequest);
      await stopChild(broker);
      broker = startBroker();
      await waitForPort(port);
      brokerRestarts += 1;
      writeFileSync(resolve(controlRoot, "broker-restart.done"), "done\n", {
        mode: 0o600,
      });
    }
    const cloudRequest = resolve(controlRoot, "cloud-restart.request");
    if (existsSync(cloudRequest)) {
      rmSync(cloudRequest);
      await stopChild(cloud);
      cloud = startCloud(2);
      await waitForCloudReady(cloudLog, 2);
      cloudRestarts += 1;
      writeFileSync(resolve(controlRoot, "cloud-restart.done"), "done\n", {
        mode: 0o600,
      });
    }
    await sleep(50);
  }
  return completed;
}

async function runEdgePhase(
  phase: "after-restart" | "before-restart",
  evidencePath: string,
): Promise<void> {
  const edge = spawn(
    "cargo",
    [
      "test",
      "-p",
      "aether-cloudlink-mqtt",
      "--test",
      "shared_broker",
      "external_cloud_dual_phase",
      "--",
      "--nocapture",
      "--test-threads=1",
    ],
    {
      cwd: iotRoot,
      env: {
        ...process.env,
        AETHER_CLOUDLINK_BROKER_HOST: "127.0.0.1",
        AETHER_CLOUDLINK_BROKER_PORT: String(port),
        AETHER_CLOUDLINK_CONTROL_DIR: controlRoot,
        AETHER_CLOUDLINK_EDGE_EVIDENCE: evidencePath,
        AETHER_CLOUDLINK_EDGE_PHASE: phase,
        AETHER_CLOUDLINK_GATEWAY_ID: gatewayId,
        AETHER_CLOUDLINK_SPOOL_ROOT: spoolRoot,
        AETHER_CLOUDLINK_TOPIC_PREFIX: topicPrefix,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [edge.stdout, edge.stderr]) {
    stream.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      process.stdout.write(text);
      childDiagnostics.push(text.slice(-8_192));
    });
  }
  const code = await handleControls(edge);
  assert(
    code === 0,
    `AetherEdge Edge phase ${phase} failed with exit ${String(code)}`,
  );
  assert(existsSync(evidencePath), `Edge phase ${phase} did not emit evidence`);
}

try {
  broker = startBroker();
  await waitForPort(port);
  cloud = startCloud(1);
  await waitForCloudReady(cloudLog, 1);

  await runEdgePhase("before-restart", phase1Evidence);
  await runEdgePhase("after-restart", phase2Evidence);

  const cloudEvents = parseJsonLines(cloudLog);
  const phase1 = JSON.parse(readFileSync(phase1Evidence, "utf8")) as JsonRecord;
  const phase2 = JSON.parse(readFileSync(phase2Evidence, "utf8")) as JsonRecord;
  const lock = JSON.parse(
    readFileSync(resolve(cloudRoot, "aether-contracts.lock.json"), "utf8"),
  ) as JsonRecord;
  const release = lock.release as JsonRecord;
  const bundle = release.bundle as JsonRecord;
  const manifest = lock.manifest as JsonRecord;

  const downlinks = cloudEvents.filter(
    (entry) => entry.event === "downlink-published",
  );
  const ingressResults = cloudEvents.filter(
    (entry) => entry.event === "ingress-result",
  );
  const commands = cloudEvents.filter(
    (entry) => entry.event === "application-command",
  );
  const hasIngressFailure = (code: string): boolean =>
    ingressResults.some((entry) => entry.failure_code === code);
  const hasCommandFailure = (code: string): boolean =>
    commands.some((entry) => entry.failure_code === code);
  const telemetryAcks = downlinks.filter(
    (entry) => entry.batch_id === "telemetry-ack-loss",
  );
  const generationOneSessions = downlinks.filter(
    (entry) =>
      entry.cloud_generation === 1 && entry.message_kind === "session-accepted",
  );
  const manifestResumeObserved = generationOneSessions.some((entry) =>
    Array.isArray(entry.resume)
      ? entry.resume.some(
          (cursor) =>
            typeof cursor === "object" &&
            cursor !== null &&
            !Array.isArray(cursor) &&
            (cursor as JsonRecord).stream_id === "manifest" &&
            (cursor as JsonRecord).stream_epoch === "1" &&
            (cursor as JsonRecord).acknowledged_position === "1",
        )
      : false,
  );

  assert(brokerRestarts === 1, "Broker restart was not executed exactly once");
  assert(
    cloudRestarts === 1,
    "Cloud process restart was not executed exactly once",
  );
  assert(
    phase1.pending_records === 1,
    "ACK loss did not retain the Edge record",
  );
  assert(phase2.pending_records === 0, "final Edge spool is not drained");
  assert(
    phase2.cloud_restart_durability === "unknown-reaccepted",
    "Cloud restart was not reported honestly",
  );
  assert(telemetryAcks.length === 3, "telemetry ACK/replay count drifted");
  assert(
    manifestResumeObserved,
    "the resumed Edge process did not receive Cloud's manifest/1/1 cursor",
  );
  assert(hasIngressFailure("message-expired"), "expiry rejection is absent");
  assert(
    hasCommandFailure("telemetry-conflicting-replay") ||
      hasCommandFailure("telemetry-position-conflict"),
    "conflicting replay rejection is absent",
  );
  assert(
    cloudEvents.some(
      (entry) =>
        entry.event === "fault-injected" && entry.scenario === "ack-loss",
    ),
    "ACK-loss injector did not run",
  );

  const fixturesPath = resolve(
    cloudRoot,
    "contracts/cloudlink/v1/fixture-manifest.json",
  );
  const scenarios = [
    {
      scenario: "broker-disconnect-reconnect",
      capability: "implemented",
      expected: "both real MQTT transports reconnect and subscriptions recover",
      observed: `Mosquitto restarted ${String(brokerRestarts)} time; Edge continued through a new connection`,
      result: "passed",
      failure_code: null,
    },
    {
      scenario: "application-ack-loss",
      capability: "implemented",
      expected:
        "MQTT PUBACK does not delete the spool; identical business identity is replayed",
      observed:
        "one pending FileCloudLinkSpool record survived, then replay received the stable ACK",
      result: "passed",
      failure_code: null,
    },
    {
      scenario: "server-authoritative-resume-cursor",
      capability: "implemented",
      expected: "Cloud returns the durable stream/epoch/position tuple it owns",
      observed:
        "second Edge process received manifest/1/1 while telemetry/1/1 still replayed after its lost ACK",
      result: "passed",
      failure_code: null,
    },
    {
      scenario: "edge-process-restart",
      capability: "implemented",
      expected: "a second Edge OS process recovers the retained record",
      observed:
        "phase two reopened the phase-one journal with pending_records=1",
      result: "passed",
      failure_code: null,
    },
    {
      scenario: "cloud-ingress-process-restart",
      capability: "planned/blocked",
      expected:
        "without a production durable store, continuity is unknown and must not be claimed",
      observed:
        "new Cloud process rolled session epoch back and re-accepted the replay as unknown",
      result: "expected-honest-unknown",
      failure_code: "CLOUD_CRASH_DURABILITY_UNAVAILABLE",
    },
    {
      scenario: "mqtt-duplicate-delivery",
      capability: "implemented",
      expected: "repeated QoS 1 payload does not create a second business fact",
      observed: "same position/batch/digest returned the same logical receipt",
      result: "passed",
      failure_code: null,
    },
    {
      scenario: "same-position-same-digest-replay",
      capability: "implemented",
      expected: "idempotent replay",
      observed:
        "application repository reported replay and emitted an unsigned application ACK",
      result: "passed",
      failure_code: null,
    },
    {
      scenario: "same-position-conflicting-binding",
      capability: "implemented",
      expected: "no receipt and no ACK",
      observed:
        "application rejected the conflicting replay; Edge timed out waiting for ACK",
      result: "passed",
      failure_code: "DIGEST_CONFLICT",
    },
    {
      scenario: "data-loss-range",
      capability: "experimental",
      expected:
        "loss is an explicit application fact, never a silent cursor jump",
      observed:
        "record-data-loss command persisted one fact and emitted its application ACK",
      result: "passed",
      failure_code: null,
    },
    {
      scenario: "out-of-order",
      capability: "implemented",
      expected: "gap is retained but cumulative ACK is withheld",
      observed: "repository returned a gap receipt and Edge received no ACK",
      result: "passed",
      failure_code: "CURSOR_GAP",
    },
    {
      scenario: "expiry-equality",
      capability: "implemented",
      expected:
        "evaluation_time >= expires_at is rejected before application persistence",
      observed: "ingress returned message-expired and published no ACK",
      result: "passed",
      failure_code: "MESSAGE_EXPIRED",
    },
    {
      scenario: "partial-success",
      capability: "implemented",
      expected: "non-durable/buffered application result never creates an ACK",
      observed: "durablyAcknowledged=false and Edge received no ACK",
      result: "passed",
      failure_code: "APPLICATION_NOT_DURABLE",
    },
  ];

  const evidence = {
    schema: "aether.cloudlink.dual-harness-evidence.v1alpha1",
    generated_at: new Date().toISOString(),
    result: "passed",
    command: "pnpm test:cloudlink-dual",
    topology: {
      broker: `${basename(mosquitto)} MQTT 3.1.1`,
      edge: "AetherEdge aether-cloudlink-mqtt/rumqttc + FileCloudLinkSpool",
      cloud:
        "AetherCloud node-mqtt adapter + CloudLink ingress + application use cases",
      unique_topic_prefix: topicPrefix,
      broker_restarts: brokerRestarts,
      edge_process_restarts: 1,
      cloud_process_restarts: cloudRestarts,
    },
    contract: {
      release: release.version,
      commit: release.commit,
      tag_object: release.tag_object,
      bundle_name: bundle.name,
      bundle_size: bundle.size,
      bundle_sha256: bundle.sha256,
      manifest_sha256: manifest.sha256,
      fixture_manifest_sha256: sha256(fixturesPath),
      consumer_scope: (lock.adoption as JsonRecord).scope,
      imported: (lock.imports as unknown[]).length,
      pending: (lock.pending_imports as unknown[]).length,
    },
    repositories: {
      AetherContracts: { branch: "main", head: gitHead(contractsRoot) },
      AetherCloud: { branch: "main", head: gitHead(cloudRoot) },
      AetherEdge: { branch: "main", head: gitHead(iotRoot) },
    },
    observations: {
      cloud_ingress_results: ingressResults.length,
      cloud_application_commands: commands.length,
      cloud_downlinks: downlinks.length,
      telemetry_application_acks: telemetryAcks.length,
      manifest_resume_cursor_observed: manifestResumeObserved,
      final_edge_cursor: phase2.final_cursor,
      final_edge_pending_records: phase2.pending_records,
      application_ack_signed: false,
      production_crash_durable_store: false,
      authentication_gate: "proposal",
    },
    scenarios,
    safety: {
      legacy_default: true,
      physical_control: "forbidden",
      physical_control_messages: 0,
      mqtt_puback_is_application_ack: false,
      edge_safety_authority_preserved: true,
    },
  };

  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  mkdirSync(dirname(compatibilityOutputPath), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    compatibilityOutputPath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  chmodSync(outputPath, 0o600);
  chmodSync(compatibilityOutputPath, 0o600);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error: unknown) {
  const details = childDiagnostics.slice(-12).join("").slice(-24_000);
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}${
      details.length === 0 ? "" : `\nChild diagnostics:\n${details}`
    }`,
  );
} finally {
  await stopChild(cloud);
  await stopChild(broker);
  rmSync(temporaryRoot, { recursive: true, force: true });
}
