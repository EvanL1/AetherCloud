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

for (const entry of [
  {
    name: "CloudLink",
    configUrl: cloudLinkConfigUrl,
    source: "apps/cloudlink/src/server.ts",
  },
  { name: "API", configUrl, source: "apps/api/src/server.ts" },
]) {
  test(`the ${entry.name} shutdown deadline stays inside the Railway draining window`, async () => {
    const config = JSON.parse(await readFile(entry.configUrl, "utf8"));
    const server = await readFile(
      new URL(`../${entry.source}`, import.meta.url),
      "utf8",
    );
    const declared = server.match(/const shutdownDeadlineMs = ([0-9_]+);/)?.[1];

    assert.ok(declared, `${entry.source} must declare a deadline`);
    // A deadline at or past the draining window would be replaced by SIGKILL,
    // and a stuck close would look like an ordinary platform stop instead of
    // the non-zero exit the entry point writes.
    assert.ok(
      Number(declared.replaceAll("_", "")) <
        config.deploy.drainingSeconds * 1000,
      "the shutdown deadline must expire before Railway stops draining",
    );
  });

  test(`the ${entry.name} entry point survives a repeated stop signal`, async () => {
    const server = await readFile(
      new URL(`../${entry.source}`, import.meta.url),
      "utf8",
    );

    // `process.once` removes the listener on the first delivery, which restores
    // the default disposition; the second signal a process group plus `pnpm
    // run` produces then kills the process mid-shutdown, and the deadline never
    // reports anything. Measured: a group SIGTERM exited 143 without draining.
    assert.doesNotMatch(
      server,
      /process\.once\(\s*signal/,
      `${entry.source} must register signal handlers with process.on`,
    );
    assert.match(server, /process\.on\(signal/);
  });
}
