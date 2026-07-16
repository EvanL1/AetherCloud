import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { verifyConsumerLock } from "../contracts/aether-contracts/v0.1.0-alpha.3/scripts/verify-consumer-lock.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const lockPath = resolve(repositoryRoot, "aether-contracts.lock.json");

test("AetherCloud consumes the digest-pinned AetherContracts release offline", async () => {
  const result = await verifyConsumerLock({
    consumerRoot: repositoryRoot,
    lockPath,
  });

  assert.deepEqual(result, {
    imported: 53,
    pending: 0,
    releaseCommit: "c5aad674f0844138e778963118e786e430ffb365",
    releaseVersion: "0.1.0-alpha.3",
    scope: "cloudlink-alpha3",
    status: "complete-consumer",
  });
});
