import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const configUrl = new URL("../railway.json", import.meta.url);

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
