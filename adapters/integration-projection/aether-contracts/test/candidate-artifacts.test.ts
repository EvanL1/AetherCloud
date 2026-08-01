import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface ConsumerLock {
  readonly status: string;
  readonly release: Readonly<{
    version: string;
    tag: string;
    bundle: Readonly<{ root: string }>;
  }>;
  readonly manifest: Readonly<{ local_path: string; sha256: string }>;
}

const repositoryRoot = new URL("../../../../", import.meta.url);

function isConsumerLock(input: unknown): input is ConsumerLock {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  const release = record.release as Record<string, unknown> | undefined;
  const bundle = release?.bundle as Record<string, unknown> | undefined;
  const manifest = record.manifest as Record<string, unknown> | undefined;
  return (
    record.status === "complete-consumer" &&
    typeof release?.version === "string" &&
    typeof release.tag === "string" &&
    typeof bundle?.root === "string" &&
    typeof manifest?.local_path === "string" &&
    typeof manifest.sha256 === "string"
  );
}

async function readConsumerLock(): Promise<ConsumerLock> {
  const raw = await readFile(
    new URL("aether-contracts.lock.json", repositoryRoot),
  );
  const decoded = JSON.parse(raw.toString("utf8")) as unknown;
  if (!isConsumerLock(decoded)) {
    throw new TypeError("aether-contracts.lock.json is not a consumer lock");
  }
  return decoded;
}

describe("AetherContracts alpha.4 published consumption", () => {
  it("pins the published alpha.4 release rather than an unpublished candidate", async () => {
    const lock = await readConsumerLock();

    expect(lock.release.version).toBe("0.1.0-alpha.4");
    expect(lock.release.tag).toBe("v0.1.0-alpha.4");
    expect(lock.release.bundle.root).toBe("AetherContracts-0.1.0-alpha.4");
  });

  it("verifies the imported manifest against the locked digest", async () => {
    const lock = await readConsumerLock();
    const manifest = await readFile(
      new URL(lock.manifest.local_path, repositoryRoot),
    );

    expect(createHash("sha256").update(manifest).digest("hex")).toBe(
      lock.manifest.sha256,
    );
  });

  it("no longer carries an unpublished candidate lock", async () => {
    // The candidate copy declared `publication_status: candidate-unpublished`
    // and this suite asserted that status, so importing the real release had to
    // be a deliberate act rather than a silent drift. Keep the tripwire pointed
    // at the file's absence so a candidate copy cannot reappear unnoticed.
    await expect(
      readFile(
        new URL(
          "contracts/aether-contracts/v0.1.0-alpha.4/candidate-lock.json",
          repositoryRoot,
        ),
      ),
    ).rejects.toThrow();
  });

  it("keeps no candidate directory anywhere in the contracts tree", async () => {
    await expect(
      readFile(
        new URL(
          "contracts/aether-contracts/v0.1.0-alpha.4-candidate/contract-manifest.json",
          repositoryRoot,
        ),
      ),
    ).rejects.toThrow();
  });
});
