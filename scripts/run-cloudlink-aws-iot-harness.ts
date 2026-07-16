import { randomUUID } from "node:crypto";
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
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

interface CertificateResource {
  readonly arn: string;
  readonly id: string;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
}

interface PolicyAttachment {
  readonly policyName: string;
  readonly certificateArn: string;
}

const cloudRoot = resolve(import.meta.dirname, "..");
const iotRoot = resolve(
  process.env.AETHERIOT_ROOT ?? resolve(cloudRoot, "../AetherEdge"),
);
const workerPath = resolve(cloudRoot, "scripts/cloudlink-dual-cloud-worker.ts");
const region = process.env.AETHER_CLOUDLINK_AWS_REGION ?? "us-west-2";
const outputPath = resolve(
  cloudRoot,
  `evidence/cloudlink-aws-iot-${region}.json`,
);

if (process.env.AETHER_CLOUD_RUN_AWS_IOT_INTEGRATION !== "1") {
  throw new Error("run this opt-in test through pnpm test:cloudlink-aws-iot");
}
if (!/^[a-z]{2}-[a-z]+-[1-9][0-9]*$/.test(region)) {
  throw new Error("AETHER_CLOUDLINK_AWS_REGION is invalid");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function runChecked(
  label: string,
  command: string,
  args: readonly string[],
  cwd = cloudRoot,
): string {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${String(result.status)}`);
  }
  return result.stdout.trim();
}

function aws(label: string, args: readonly string[]): string {
  return runChecked(label, "aws", [
    ...args,
    "--region",
    region,
    "--no-cli-pager",
  ]);
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
  if ((await Promise.race([exited, sleep(5_000).then(() => -1)])) === -1) {
    child.kill("SIGKILL");
    await childExit(child);
  }
}

function parseJsonLines(path: string): JsonRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonRecord);
}

async function waitForCloudReady(logPath: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (
      parseJsonLines(logPath).some(
        (entry) =>
          entry.event === "worker-ready" && entry.cloud_generation === 1,
      )
    ) {
      return;
    }
    await sleep(100);
  }
  throw new Error("AetherCloud AWS IoT worker did not become ready");
}

function policyDocument(input: {
  readonly accountId: string;
  readonly clientId: string;
  readonly publishTopics: readonly string[];
  readonly receiveTopics: readonly string[];
  readonly subscribeFilters: readonly string[];
}): string {
  const prefix = `arn:aws:iot:${region}:${input.accountId}`;
  const statements: JsonRecord[] = [
    {
      Effect: "Allow",
      Action: "iot:Connect",
      Resource: `${prefix}:client/${input.clientId}`,
    },
  ];
  if (input.publishTopics.length > 0) {
    statements.push({
      Effect: "Allow",
      Action: "iot:Publish",
      Resource: input.publishTopics.map((topic) => `${prefix}:topic/${topic}`),
    });
  }
  if (input.subscribeFilters.length > 0) {
    statements.push({
      Effect: "Allow",
      Action: "iot:Subscribe",
      Resource: input.subscribeFilters.map(
        (topic) => `${prefix}:topicfilter/${topic}`,
      ),
    });
  }
  if (input.receiveTopics.length > 0) {
    statements.push({
      Effect: "Allow",
      Action: "iot:Receive",
      Resource: input.receiveTopics.map((topic) => `${prefix}:topic/${topic}`),
    });
  }
  const document = JSON.stringify({
    Version: "2012-10-17",
    Statement: statements,
  });
  assert(document.length <= 2048, "AWS IoT test policy exceeds 2048 bytes");
  return document;
}

function createCertificate(
  temporaryRoot: string,
  role: "cloud" | "edge",
  registerForCleanup: (certificate: CertificateResource) => void,
): CertificateResource {
  const certificatePath = resolve(temporaryRoot, `${role}.certificate.pem`);
  const rawPrivateKeyPath = resolve(temporaryRoot, `${role}.private.raw.pem`);
  const privateKeyPath = resolve(temporaryRoot, `${role}.private.pkcs8.pem`);
  const output = aws(`create ${role} certificate`, [
    "iot",
    "create-keys-and-certificate",
    "--set-as-active",
    "--certificate-pem-outfile",
    certificatePath,
    "--private-key-outfile",
    rawPrivateKeyPath,
    "--query",
    "[certificateArn,certificateId]",
    "--output",
    "text",
  ]);
  const [arn, id] = output.split(/\s+/);
  assert(
    arn !== undefined && id !== undefined,
    "AWS certificate identity is absent",
  );
  const resource = { arn, id, certificatePath, privateKeyPath };
  registerForCleanup(resource);
  chmodSync(certificatePath, 0o600);
  chmodSync(rawPrivateKeyPath, 0o600);
  runChecked(`convert ${role} private key`, "openssl", [
    "pkcs8",
    "-topk8",
    "-nocrypt",
    "-in",
    rawPrivateKeyPath,
    "-out",
    privateKeyPath,
  ]);
  chmodSync(privateKeyPath, 0o600);
  rmSync(rawPrivateKeyPath, { force: true });
  runChecked(`validate ${role} certificate`, "openssl", [
    "x509",
    "-in",
    certificatePath,
    "-noout",
  ]);
  runChecked(`validate ${role} private key`, "openssl", [
    "pkey",
    "-in",
    privateKeyPath,
    "-noout",
  ]);
  return resource;
}

function createPolicy(name: string, document: string): void {
  aws(`create ${name} policy`, [
    "iot",
    "create-policy",
    "--policy-name",
    name,
    "--policy-document",
    document,
    "--query",
    "policyName",
    "--output",
    "text",
  ]);
}

function attachPolicy(policyName: string, certificateArn: string): void {
  aws(`attach ${policyName} policy`, [
    "iot",
    "attach-policy",
    "--policy-name",
    policyName,
    "--target",
    certificateArn,
  ]);
}

function cleanupAwsResources(
  attachments: readonly PolicyAttachment[],
  certificates: readonly CertificateResource[],
  policies: readonly string[],
): string[] {
  const failures: string[] = [];
  for (const attachment of [...attachments].reverse()) {
    try {
      aws(`detach ${attachment.policyName} policy`, [
        "iot",
        "detach-policy",
        "--policy-name",
        attachment.policyName,
        "--target",
        attachment.certificateArn,
      ]);
    } catch {
      failures.push(`detach-policy:${attachment.policyName}`);
    }
  }
  for (const certificate of [...certificates].reverse()) {
    try {
      aws("deactivate certificate", [
        "iot",
        "update-certificate",
        "--certificate-id",
        certificate.id,
        "--new-status",
        "INACTIVE",
      ]);
      aws("delete certificate", [
        "iot",
        "delete-certificate",
        "--certificate-id",
        certificate.id,
        "--force-delete",
      ]);
    } catch {
      failures.push("delete-certificate");
    }
  }
  for (const policy of [...policies].reverse()) {
    try {
      aws(`delete ${policy} policy`, [
        "iot",
        "delete-policy",
        "--policy-name",
        policy,
      ]);
    } catch {
      failures.push(`delete-policy:${policy}`);
    }
  }
  return failures;
}

const runId = randomUUID().replaceAll("-", "");
const gatewayId = randomUUID();
const topicPrefix = `aether-aws/${runId}`;
const cloudClientId = `aethercloud-e2e-cloud-${runId.slice(0, 16)}`;
const cloudPolicyName = `aethercloud-e2e-${runId.slice(0, 16)}-cloud`;
const edgePolicyName = `aethercloud-e2e-${runId.slice(0, 16)}-edge`;
const temporaryRoot = mkdtempSync(resolve(tmpdir(), "aether-aws-iot-"));
chmodSync(temporaryRoot, 0o700);
const caPath = resolve(temporaryRoot, "AmazonRootCA1.pem");
const cloudLog = resolve(temporaryRoot, "cloud-evidence.jsonl");
const edgeEvidencePath = resolve(temporaryRoot, "edge-evidence.json");
const certificates: CertificateResource[] = [];
const policies: string[] = [];
const attachments: PolicyAttachment[] = [];
let cloud: ChildProcess | undefined;
let edge: ChildProcess | undefined;
let evidence: JsonRecord | undefined;
let runFailure: unknown;
let cleanupFailures: string[] = [];

try {
  const accountId = aws("read AWS account", [
    "sts",
    "get-caller-identity",
    "--query",
    "Account",
    "--output",
    "text",
  ]);
  assert(/^\d{12}$/.test(accountId), "AWS account identity is invalid");
  const endpoint = aws("read AWS IoT endpoint", [
    "iot",
    "describe-endpoint",
    "--endpoint-type",
    "iot:Data-ATS",
    "--query",
    "endpointAddress",
    "--output",
    "text",
  ]);
  assert(
    /^[a-zA-Z0-9.-]+\.amazonaws\.com$/.test(endpoint),
    "AWS IoT ATS endpoint is invalid",
  );
  runChecked("download Amazon Root CA", "curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--output",
    caPath,
    "https://www.amazontrust.com/repository/AmazonRootCA1.pem",
  ]);
  chmodSync(caPath, 0o600);
  runChecked("validate Amazon Root CA", "openssl", [
    "x509",
    "-in",
    caPath,
    "-noout",
  ]);

  const cloudPolicy = policyDocument({
    accountId,
    clientId: cloudClientId,
    publishTopics: [`${topicPrefix}/v1/gateways/${gatewayId}/down/*`],
    receiveTopics: [`${topicPrefix}/v1/gateways/${gatewayId}/up/*`],
    subscribeFilters: [`${topicPrefix}/v1/gateways/+/up/*`],
  });
  const edgePolicy = policyDocument({
    accountId,
    clientId: gatewayId,
    publishTopics: [`${topicPrefix}/v1/gateways/${gatewayId}/up/*`],
    receiveTopics: [`${topicPrefix}/v1/gateways/${gatewayId}/down/*`],
    subscribeFilters: [`${topicPrefix}/v1/gateways/${gatewayId}/down/*`],
  });
  createPolicy(cloudPolicyName, cloudPolicy);
  policies.push(cloudPolicyName);
  createPolicy(edgePolicyName, edgePolicy);
  policies.push(edgePolicyName);

  const cloudCertificate = createCertificate(
    temporaryRoot,
    "cloud",
    (certificate) => certificates.push(certificate),
  );
  const edgeCertificate = createCertificate(
    temporaryRoot,
    "edge",
    (certificate) => certificates.push(certificate),
  );
  attachPolicy(cloudPolicyName, cloudCertificate.arn);
  attachments.push({
    policyName: cloudPolicyName,
    certificateArn: cloudCertificate.arn,
  });
  attachPolicy(edgePolicyName, edgeCertificate.arn);
  attachments.push({
    policyName: edgePolicyName,
    certificateArn: edgeCertificate.arn,
  });
  await sleep(2_000);

  cloud = spawn("pnpm", ["exec", "tsx", workerPath], {
    cwd: cloudRoot,
    env: {
      ...process.env,
      AETHER_DUAL_BROKER_CA_PATH: caPath,
      AETHER_DUAL_BROKER_CLIENT_CERTIFICATE_PATH:
        cloudCertificate.certificatePath,
      AETHER_DUAL_BROKER_CLIENT_PRIVATE_KEY_PATH:
        cloudCertificate.privateKeyPath,
      AETHER_DUAL_BROKER_KIND: "aws-iot-core",
      AETHER_DUAL_BROKER_URL: `mqtts://${endpoint}:8883`,
      AETHER_DUAL_CLOUD_CLIENT_ID: cloudClientId,
      AETHER_DUAL_CLOUD_GENERATION: "1",
      AETHER_DUAL_EVIDENCE_LOG: cloudLog,
      AETHER_DUAL_GATEWAY_ID: gatewayId,
      AETHER_DUAL_TOPIC_PREFIX: topicPrefix,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitForCloudReady(cloudLog);

  edge = spawn(
    "cargo",
    [
      "test",
      "-p",
      "aether-cloudlink-mqtt",
      "--test",
      "shared_broker",
      "external_cloud_dual_harness",
      "--",
      "--nocapture",
      "--test-threads=1",
    ],
    {
      cwd: iotRoot,
      env: {
        ...process.env,
        AETHER_CLOUDLINK_BROKER_CA: caPath,
        AETHER_CLOUDLINK_BROKER_CLIENT_CERT: edgeCertificate.certificatePath,
        AETHER_CLOUDLINK_BROKER_CLIENT_KEY: edgeCertificate.privateKeyPath,
        AETHER_CLOUDLINK_BROKER_HOST: endpoint,
        AETHER_CLOUDLINK_BROKER_PORT: "8883",
        AETHER_CLOUDLINK_EDGE_EVIDENCE: edgeEvidencePath,
        AETHER_CLOUDLINK_EXPECT_BROKER_RESTART: "0",
        AETHER_CLOUDLINK_EXTERNAL_CLOUD: "1",
        AETHER_CLOUDLINK_GATEWAY_ID: gatewayId,
        AETHER_CLOUDLINK_TOPIC_PREFIX: topicPrefix,
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  const edgeCode = await childExit(edge);
  assert(
    edgeCode === 0,
    `AetherEdge AWS Edge test failed with exit ${String(edgeCode)}`,
  );
  assert(
    existsSync(edgeEvidencePath),
    "AetherEdge AWS Edge evidence is absent",
  );
  const edgeEvidence = JSON.parse(
    readFileSync(edgeEvidencePath, "utf8"),
  ) as JsonRecord;
  const cloudEvents = parseJsonLines(cloudLog);
  const downlinks = cloudEvents.filter(
    (entry) => entry.event === "downlink-published",
  );
  const commands = cloudEvents.filter(
    (entry) => entry.event === "application-command",
  );
  const ingressResults = cloudEvents.filter(
    (entry) => entry.event === "ingress-result",
  );
  assert(edgeEvidence.pending_records === 0, "AWS Edge spool did not drain");
  assert(edgeEvidence.final_cursor === 1, "AWS Edge cursor did not advance");
  assert(
    cloudEvents.some(
      (entry) =>
        entry.event === "fault-injected" && entry.scenario === "ack-loss",
    ),
    "AWS ACK-loss injection did not execute",
  );
  assert(
    commands.some(
      (entry) =>
        entry.failure_code === "telemetry-conflicting-replay" ||
        entry.failure_code === "telemetry-position-conflict",
    ),
    "AWS conflicting replay rejection is absent",
  );
  evidence = {
    schema: "aether.cloudlink.aws-iot-evidence.v1alpha1",
    generated_at: new Date().toISOString(),
    result: "passed",
    command: "pnpm test:cloudlink-aws-iot",
    topology: {
      broker: "AWS IoT Core",
      region,
      protocol: "MQTT 3.1.1 over TLS 1.2+",
      authentication: "two ephemeral X.509 client principals",
      edge: "AetherEdge rumqttc + FileCloudLinkSpool",
      cloud: "AetherCloud MQTT.js ingress + application use cases",
    },
    observations: {
      cloud_ingress_results: ingressResults.length,
      cloud_application_commands: commands.length,
      cloud_downlinks: downlinks.length,
      edge_sessions: edgeEvidence.sessions,
      telemetry_application_acks: edgeEvidence.telemetry_application_acks,
      ack_loss_replays: edgeEvidence.ack_loss_replays,
      duplicate_replays: edgeEvidence.duplicate_replays,
      conflicts_without_ack: edgeEvidence.conflicts_without_ack,
      expired_without_ack: edgeEvidence.expired_without_ack,
      out_of_order_without_ack: edgeEvidence.out_of_order_without_ack,
      partial_batches_without_ack: edgeEvidence.partial_batches_without_ack,
      data_loss_acks: edgeEvidence.data_loss_acks,
      final_edge_cursor: edgeEvidence.final_cursor,
      final_edge_pending_records: edgeEvidence.pending_records,
    },
    safety: {
      legacy_default: true,
      physical_control: "forbidden",
      physical_control_messages: 0,
      mqtt_puback_is_application_ack: false,
      application_ack_signed: false,
      production_crash_durable_store: false,
      authentication_gate: "proposal",
      edge_safety_authority_preserved:
        edgeEvidence.edge_safety_authority_preserved,
    },
  };
} catch (error: unknown) {
  runFailure = error;
} finally {
  await stopChild(edge);
  await stopChild(cloud);
  cleanupFailures = cleanupAwsResources(attachments, certificates, policies);
  rmSync(temporaryRoot, { recursive: true, force: true });
}

if (cleanupFailures.length > 0) {
  throw new Error(
    `AWS IoT cleanup failed for ${cleanupFailures.join(", ")}${
      runFailure === undefined ? "" : "; the E2E run also failed"
    }`,
  );
}
if (runFailure !== undefined) {
  throw runFailure instanceof Error
    ? runFailure
    : new Error("AWS IoT E2E failed with a non-Error value");
}
assert(evidence !== undefined, "AWS IoT evidence was not produced");
const finalEvidence = {
  ...evidence,
  cleanup: {
    ephemeral_certificates_deleted: 2,
    ephemeral_policies_deleted: 2,
    thing_resources_created: 0,
  },
};
mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
writeFileSync(outputPath, `${JSON.stringify(finalEvidence, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
chmodSync(outputPath, 0o600);
process.stdout.write(
  `${basename(outputPath)}: ${JSON.stringify(finalEvidence, null, 2)}\n`,
);
