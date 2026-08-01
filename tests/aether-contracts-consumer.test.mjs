import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { verifyConsumerLock } from "../contracts/aether-contracts/v0.1.0-alpha.4/scripts/verify-consumer-lock.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const lockPath = resolve(repositoryRoot, "aether-contracts.lock.json");

test("AetherCloud consumes the digest-pinned AetherContracts release offline", async () => {
  const result = await verifyConsumerLock({
    consumerRoot: repositoryRoot,
    lockPath,
  });

  assert.deepEqual(result, {
    imported: 101,
    pending: 0,
    releaseCommit: "8c858ba978aa183a3c534c34f62596f4902461ae",
    releaseVersion: "0.1.0-alpha.4",
    scope: "cloudlink-integration-alpha4",
    status: "complete-consumer",
  });
});
