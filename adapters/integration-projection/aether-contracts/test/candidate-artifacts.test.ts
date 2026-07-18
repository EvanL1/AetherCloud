import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface CandidateLockArtifact {
  readonly path: string;
  readonly sha256: string;
}

interface CandidateLock {
  readonly source_version: string;
  readonly source_contract_manifest_sha256: string;
  readonly publication_status: string;
  readonly scope: readonly string[];
  readonly artifacts: readonly CandidateLockArtifact[];
}

const candidateRoot = new URL(
  "../../../../contracts/aether-contracts/v0.1.0-alpha.4-candidate/",
  import.meta.url,
);

function isCandidateLock(input: unknown): input is CandidateLock {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  return (
    record.source_version === "0.1.0-alpha.4" &&
    record.source_contract_manifest_sha256 ===
      "574b064f1a913cde4e4ea4ccc3d399ff0ffbfdf6a8585b78891fe795fb063dfa" &&
    record.publication_status === "candidate-unpublished" &&
    Array.isArray(record.scope) &&
    Array.isArray(record.artifacts)
  );
}

describe("AetherContracts alpha.4 candidate pin", () => {
  it("labels the imported contract as an unpublished candidate", async () => {
    const raw = await readFile(new URL("candidate-lock.json", candidateRoot));
    const decoded = JSON.parse(raw.toString("utf8")) as unknown;

    expect(isCandidateLock(decoded)).toBe(true);
    if (!isCandidateLock(decoded)) {
      throw new TypeError("candidate lock is invalid");
    }
    expect(decoded.scope).toEqual([
      "aether.integration.v1alpha1",
      "aether.cloudlink.integration.v1alpha1",
      "aether.integration-control.v1alpha1",
      "aether.cloudlink.integration-control.v1alpha1",
    ]);
  });

  it("matches every pinned schema, profile, manifest, and fixture digest", async () => {
    const decoded = JSON.parse(
      await readFile(new URL("candidate-lock.json", candidateRoot), "utf8"),
    ) as unknown;
    if (!isCandidateLock(decoded)) {
      throw new TypeError("candidate lock is invalid");
    }

    expect(decoded.artifacts).toHaveLength(46);
    for (const artifact of decoded.artifacts) {
      const bytes = await readFile(new URL(artifact.path, candidateRoot));
      expect(
        createHash("sha256").update(bytes).digest("hex"),
        artifact.path,
      ).toBe(artifact.sha256);
    }
  });
});
