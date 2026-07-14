import { describe, expect, it } from "vitest";

import {
  ArtifactTransitionError,
  defineArtifactRevisionDraft,
  deprecateArtifactRevision,
  parseArtifactContentLength,
  parseArtifactId,
  parseArtifactRevisionId,
  parseArtifactRevisionNumber,
  parseContentDigest,
  parseUtcInstant,
  publishArtifactRevision,
  validateArtifactRevision,
  withdrawArtifactRevision,
} from "../src/index.js";

const artifactId = parseArtifactId("11111111-1111-4111-8111-111111111111");
const revisionId = parseArtifactRevisionId(
  "22222222-2222-4222-8222-222222222222",
);
const digest = parseContentDigest("a".repeat(64));

function draft() {
  return defineArtifactRevisionDraft({
    artifactId,
    revisionId,
    revisionNumber: parseArtifactRevisionNumber("1"),
    kind: "pack",
    contentDigest: digest,
    contentLength: parseArtifactContentLength("4096"),
    createdAt: parseUtcInstant("2026-07-14T00:00:00.000Z"),
    compatibility: {
      runtimeContract: "aetheriot.runtime-manifest.v1",
      requiredCapabilities: ["telemetry.upload.v1"],
    },
    dependencies: [],
    signature: {
      algorithm: "ed25519",
      keyId: "release-key-2026",
      signatureDigest: parseContentDigest("b".repeat(64)),
    },
  });
}

describe("Artifact revision publication", () => {
  it("moves a draft through validation and publication without mutating prior facts", () => {
    const initial = draft();
    const validated = validateArtifactRevision(
      initial,
      parseUtcInstant("2026-07-14T00:01:00.000Z"),
    );
    const published = publishArtifactRevision(
      validated,
      parseUtcInstant("2026-07-14T00:02:00.000Z"),
    );

    expect(initial.state).toBe("draft");
    expect(validated).toMatchObject({ state: "validated", revision: 2 });
    expect(published).toMatchObject({ state: "published", revision: 3 });
    expect(Object.isFrozen(published)).toBe(true);
  });

  it("rejects publication that skipped validation", () => {
    expect(() =>
      publishArtifactRevision(
        draft(),
        parseUtcInstant("2026-07-14T00:02:00.000Z"),
      ),
    ).toThrow(ArtifactTransitionError);
  });

  it("supports deprecation and withdrawal without rewriting publication identity", () => {
    const published = publishArtifactRevision(
      validateArtifactRevision(
        draft(),
        parseUtcInstant("2026-07-14T00:01:00.000Z"),
      ),
      parseUtcInstant("2026-07-14T00:02:00.000Z"),
    );
    const deprecated = deprecateArtifactRevision(
      published,
      parseUtcInstant("2026-07-14T00:03:00.000Z"),
    );
    const withdrawn = withdrawArtifactRevision(
      deprecated,
      parseUtcInstant("2026-07-14T00:04:00.000Z"),
    );

    expect(deprecated.state).toBe("deprecated");
    expect(withdrawn).toMatchObject({
      artifactId,
      revisionId,
      state: "withdrawn",
      publishedAt: "2026-07-14T00:02:00.000Z",
    });
  });

  it("rejects unsafe protocol integers and unbounded compatibility metadata", () => {
    expect(() => parseArtifactRevisionNumber("01")).toThrow(/revisionNumber/);
    expect(() =>
      defineArtifactRevisionDraft({
        artifactId,
        revisionId,
        revisionNumber: parseArtifactRevisionNumber("1"),
        kind: "pack",
        contentDigest: digest,
        contentLength: parseArtifactContentLength("4096"),
        createdAt: parseUtcInstant("2026-07-14T00:00:00.000Z"),
        compatibility: {
          runtimeContract: "aetheriot.runtime-manifest.v1",
          requiredCapabilities: Array.from(
            { length: 65 },
            (_, index) => `capability.${index.toString(10)}`,
          ),
        },
        dependencies: [],
        signature: {
          algorithm: "ed25519",
          keyId: "release-key-2026",
          signatureDigest: parseContentDigest("b".repeat(64)),
        },
      }),
    ).toThrow(/requiredCapabilities/);
  });
});
