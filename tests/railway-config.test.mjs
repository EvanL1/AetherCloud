import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const configUrl = new URL("../railway.json", import.meta.url);
const cloudLinkConfigUrl = new URL(
  "../railway.cloudlink.json",
  import.meta.url,
);

test("Railway runs the API with bounded production lifecycle settings", async () => {
  const config = JSON.parse(await readFile(configUrl, "utf8"));

  assert.equal(config.$schema, "https://railway.com/railway.schema.json");
  assert.equal(config.build?.builder, "RAILPACK");
  assert.deepEqual(config.deploy, {
    drainingSeconds: 30,
    healthcheckPath: "/health",
    healthcheckTimeout: 30,
    restartPolicyMaxRetries: 10,
    restartPolicyType: "ON_FAILURE",
    runtime: "V2",
    sleepApplication: false,
    startCommand: "pnpm --filter @aether-cloud/api start",
  });

  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, /(?:token|password|secret|database_url)/i);
});

test("Railway runs the CloudLink ingress as a portless long-lived subscriber", async () => {
  const config = JSON.parse(await readFile(cloudLinkConfigUrl, "utf8"));

  assert.equal(config.$schema, "https://railway.com/railway.schema.json");
  assert.equal(config.build?.builder, "RAILPACK");
  assert.deepEqual(config.deploy, {
    drainingSeconds: 30,
    restartPolicyMaxRetries: 10,
    restartPolicyType: "ON_FAILURE",
    runtime: "V2",
    sleepApplication: false,
    startCommand: "pnpm --filter @aether-cloud/cloudlink start",
  });

  // The ingress is an MQTT subscriber and listens on no HTTP port, so any
  // healthcheck would fail every deployment rather than observe anything.
  assert.equal("healthcheckPath" in config.deploy, false);
  assert.equal("healthcheckTimeout" in config.deploy, false);

  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, /(?:token|password|secret|database_url)/i);
});

test("the CloudLink shutdown deadline stays inside the Railway draining window", async () => {
  const config = JSON.parse(await readFile(cloudLinkConfigUrl, "utf8"));
  const server = await readFile(
    new URL("../apps/cloudlink/src/server.ts", import.meta.url),
    "utf8",
  );
  const declared = server.match(/const shutdownDeadlineMs = ([0-9_]+);/)?.[1];

  assert.ok(declared, "apps/cloudlink/src/server.ts must declare a deadline");
  // A deadline at or past the draining window would be replaced by SIGKILL, and
  // a stuck close would look like an ordinary platform stop instead of the
  // non-zero exit the entry point writes.
  assert.ok(
    Number(declared.replaceAll("_", "")) < config.deploy.drainingSeconds * 1000,
    "the shutdown deadline must expire before Railway stops draining",
  );
});
