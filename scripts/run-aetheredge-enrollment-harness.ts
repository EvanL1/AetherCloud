import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { composeApiRuntime } from "../apps/api/src/runtime.js";

type JsonRecord = Record<string, unknown>;

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const gatewayId = "33333333-3333-4333-8333-333333333333";
const bearerToken = "local-enrollment-harness-token";
const edgeBinary = resolve(
  process.env.AETHEREDGE_BIN ??
    "../AetherEdge-cloud-enrollment/target/debug/aether",
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("cannot allocate Enrollment harness port"));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolvePromise(address.port);
        else reject(error);
      });
    });
  });
}

async function jsonRequest(
  url: string,
  options: RequestInit,
): Promise<JsonRecord> {
  const response = await fetch(url, options);
  const value: unknown = await response.json();
  if (!response.ok || typeof value !== "object" || value === null) {
    throw new Error(`Enrollment harness HTTP ${String(response.status)}`);
  }
  return value as JsonRecord;
}

async function runEdge(
  cloudOrigin: string,
  token: string,
  configDirectory: string,
  dataDirectory: string,
): Promise<JsonRecord> {
  const child = spawn(
    edgeBinary,
    [
      "--json",
      "--config-path",
      configDirectory,
      "--db-path",
      dataDirectory,
      "cloud",
      "enroll",
      "--cloud-url",
      cloudOrigin,
      "--tenant-id",
      tenantId,
      "--project-id",
      projectId,
      "--gateway-id",
      gatewayId,
      "--token-stdin",
      "--allow-insecure-localhost",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.end(`${token}\n`);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
  });
  const code = await new Promise<number>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => {
      resolvePromise(value ?? 1);
    });
  });
  assert(
    code === 0,
    `real AetherEdge enrollment failed: ${Buffer.concat(stderr).toString("utf8")}`,
  );
  const output: unknown = JSON.parse(Buffer.concat(stdout).toString("utf8"));
  assert(typeof output === "object" && output !== null, "invalid Edge output");
  return output as JsonRecord;
}

const parent = resolve(homedir(), ".config/aethercloud");
mkdirSync(parent, { recursive: true, mode: 0o700 });
chmodSync(parent, 0o700);
const workspace = mkdtempSync(resolve(parent, "edge-enrollment-harness-"));
chmodSync(workspace, 0o700);
const configDirectory = resolve(workspace, "config");
const dataDirectory = resolve(workspace, "data");
mkdirSync(configDirectory, { mode: 0o700 });
const port = await freePort();
const cloudOrigin = `http://127.0.0.1:${String(port)}`;
const runtime = composeApiRuntime({
  AETHER_CLOUD_AUTH_MODE: "configured",
  AETHER_CLOUD_API_BEARER_TOKEN: bearerToken,
  AETHER_CLOUD_API_TENANT_ID: tenantId,
  AETHER_CLOUD_API_PROJECT_ID: projectId,
  AETHER_CLOUD_API_SUBJECT_ID: "enrollment-harness",
  AETHER_CLOUD_API_PERMISSIONS:
    "fleet.gateway.create,fleet.gateway.read,fleet.gateway.enrollment.issue,fleet.gateway.enrollment.read",
  AETHER_CLOUD_AUDIT_STORE: "memory",
});

try {
  await runtime.app.listen({ host: "127.0.0.1", port });
  const authorization = `Bearer ${bearerToken}`;
  await jsonRequest(`${cloudOrigin}/api/v1/fleet/gateways`, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      "idempotency-key": "register-edge-harness-001",
    },
    body: JSON.stringify({ gatewayId, displayName: "AetherEdge harness" }),
  });
  const issuance = await jsonRequest(
    `${cloudOrigin}/api/v1/fleet/gateways/${gatewayId}/enrollment-claims`,
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        "idempotency-key": "issue-edge-harness-001",
        "x-aethercloud-confirmation": "issue-enrollment-claim",
      },
      body: "{}",
    },
  );
  const enrollmentToken = issuance.enrollmentToken;
  assert(typeof enrollmentToken === "string", "Enrollment Token is absent");
  const edge = await runEdge(
    cloudOrigin,
    enrollmentToken,
    configDirectory,
    dataDirectory,
  );
  const cloud = await jsonRequest(
    `${cloudOrigin}/api/v1/fleet/gateways/${gatewayId}/enrollment`,
    { headers: { authorization } },
  );
  const edgeData =
    typeof edge.data === "object" && edge.data !== null
      ? (edge.data as JsonRecord)
      : {};
  assert(edgeData.enrollment_state === "claimed", "Edge is not claimed");
  assert(cloud.state === "claimed", "Cloud is not claimed");
  assert(edgeData.claimed_revision === cloud.revision, "revision drift");
  process.stdout.write(
    `${JSON.stringify(
      {
        schema: "aether.cloud.edge-enrollment-harness-evidence.v1",
        result: "passed",
        edge_process: "real-compiled-aether-cli",
        cloud_process: "aethercloud-fastify-memory-composition",
        gateway_id: gatewayId,
        edge_state: edgeData.enrollment_state,
        cloud_state: cloud.state,
        revision: cloud.revision,
        credential_active: false,
        cloudlink_online: false,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await runtime.close();
  rmSync(workspace, { recursive: true, force: true });
}
