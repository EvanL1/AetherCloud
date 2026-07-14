import { describe, expect, it } from "vitest";

import { GetArtifactRevision, PublishArtifactRevision } from "../src/index.js";
import type {
  ArtifactContentStore,
  ArtifactRegistryRepository,
  ArtifactSignatureVerifier,
} from "../src/index.js";
import { parseUtcInstant } from "@aether-cloud/domain";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const artifactId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";
const contentDigest = "a".repeat(64);
const signatureDigest = "b".repeat(64);

function context(overrides: Record<string, unknown> = {}) {
  return {
    tenantId,
    projectId,
    subjectId: "operator-1",
    permissions: ["artifact.revision.publish"],
    confirmation: "confirmed",
    idempotencyKey: "publish-request-0001",
    issuedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2026-07-14T00:05:00.000Z",
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    artifactId,
    revisionId,
    revisionNumber: "1",
    kind: "pack",
    contentDigest,
    contentLength: "4096",
    releaseChannel: "stable",
    compatibility: {
      runtimeContract: "aetheriot.runtime-manifest.v1",
      requiredCapabilities: ["telemetry.upload.v1"],
    },
    dependencies: [],
    signature: {
      algorithm: "ed25519",
      keyId: "release-key-2026",
      signatureDigest,
    },
    ...overrides,
  };
}

function dependencies(
  overrides: {
    repository?: Partial<ArtifactRegistryRepository>;
    contentStore?: Partial<ArtifactContentStore>;
    signatureVerifier?: Partial<ArtifactSignatureVerifier>;
  } = {},
) {
  const repository: ArtifactRegistryRepository = {
    publish: () => Promise.resolve({ outcome: "published" }),
    findRevision: () => Promise.resolve(undefined),
    findChannel: () => Promise.resolve(undefined),
    ...overrides.repository,
  };
  const contentStore: ArtifactContentStore = {
    verifyContent: () => Promise.resolve({ outcome: "verified" }),
    ...overrides.contentStore,
  };
  const signatureVerifier: ArtifactSignatureVerifier = {
    verifySignature: () => Promise.resolve({ outcome: "verified" }),
    ...overrides.signatureVerifier,
  };
  return { repository, contentStore, signatureVerifier };
}

describe("Artifact registry application", () => {
  it("publishes only after content and signature verification", async () => {
    const calls: string[] = [];
    const deps = dependencies({
      repository: {
        publish: (request) => {
          calls.push(`publish:${request.revision.state}`);
          return Promise.resolve({
            outcome: "published",
            revision: request.revision,
          });
        },
      },
      contentStore: {
        verifyContent: () => {
          calls.push("content");
          return Promise.resolve({ outcome: "verified" });
        },
      },
      signatureVerifier: {
        verifySignature: () => {
          calls.push("signature");
          return Promise.resolve({ outcome: "verified" });
        },
      },
    });
    const useCase = new PublishArtifactRevision({
      ...deps,
      clock: { now: () => parseUtcInstant("2026-07-14T00:01:00.000Z") },
    });

    const result = await useCase.execute(context(), input());

    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      value: { state: "published", releaseChannel: "stable" },
    });
    expect(calls).toEqual(["content", "signature", "publish:published"]);
  });

  it("fails closed for permission, confirmation, expiry, content, and signature", async () => {
    const now = {
      now: () => parseUtcInstant("2026-07-14T00:06:00.000Z"),
    };
    expect(
      await new PublishArtifactRevision({
        ...dependencies(),
        clock: now,
      }).execute(context({ permissions: [] }), input()),
    ).toMatchObject({ ok: false, failure: { code: "permission-denied" } });
    expect(
      await new PublishArtifactRevision({
        ...dependencies(),
        clock: now,
      }).execute(context({ confirmation: "not-confirmed" }), input()),
    ).toMatchObject({ ok: false, failure: { code: "confirmation-required" } });
    expect(
      await new PublishArtifactRevision({
        ...dependencies(),
        clock: now,
      }).execute(context(), input()),
    ).toMatchObject({ ok: false, failure: { code: "command-expired" } });
    expect(
      await new PublishArtifactRevision({
        ...dependencies({
          contentStore: {
            verifyContent: () =>
              Promise.resolve({ outcome: "digest-mismatch" }),
          },
        }),
        clock: { now: () => parseUtcInstant("2026-07-14T00:01:00.000Z") },
      }).execute(context(), input()),
    ).toMatchObject({
      ok: false,
      failure: { code: "artifact-digest-mismatch" },
    });
    expect(
      await new PublishArtifactRevision({
        ...dependencies({
          signatureVerifier: {
            verifySignature: () => Promise.resolve({ outcome: "invalid" }),
          },
        }),
        clock: { now: () => parseUtcInstant("2026-07-14T00:01:00.000Z") },
      }).execute(context(), input()),
    ).toMatchObject({
      ok: false,
      failure: { code: "artifact-signature-invalid" },
    });
  });

  it("decodes external input exactly and maps replay/conflict outcomes", async () => {
    const execute = (repository: Partial<ArtifactRegistryRepository>) =>
      new PublishArtifactRevision({
        ...dependencies({ repository }),
        clock: { now: () => parseUtcInstant("2026-07-14T00:01:00.000Z") },
      }).execute(context(), input());

    expect(
      await new PublishArtifactRevision({
        ...dependencies(),
        clock: { now: () => parseUtcInstant("2026-07-14T00:01:00.000Z") },
      }).execute(context(), { ...input(), unexpected: true }),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    expect(
      await execute({
        publish: (request) =>
          Promise.resolve({ outcome: "replayed", revision: request.revision }),
      }),
    ).toMatchObject({ ok: true, replayed: true });
    expect(
      await execute({
        publish: () => Promise.resolve({ outcome: "revision-conflict" }),
      }),
    ).toMatchObject({
      ok: false,
      failure: { code: "artifact-revision-conflict" },
    });
  });

  it("queries only within an authorized Tenant and Project", async () => {
    const published = await new PublishArtifactRevision({
      ...dependencies({
        repository: {
          publish: (request) =>
            Promise.resolve({
              outcome: "published",
              revision: request.revision,
            }),
        },
      }),
      clock: { now: () => parseUtcInstant("2026-07-14T00:01:00.000Z") },
    }).execute(context(), input());
    if (!published.ok) throw new Error("fixture publication failed");
    const repository = dependencies({
      repository: {
        findRevision: () => Promise.resolve(published.value.revision),
      },
    }).repository;
    const query = new GetArtifactRevision({ repository });

    expect(
      await query.execute(
        {
          tenantId,
          projectId,
          subjectId: "reader-1",
          permissions: ["artifact.revision.read"],
        },
        { artifactId, revisionId },
      ),
    ).toMatchObject({ ok: true, value: { state: "published" } });
    expect(
      await query.execute(
        {
          tenantId,
          projectId,
          subjectId: "reader-1",
          permissions: [],
        },
        { artifactId, revisionId },
      ),
    ).toMatchObject({ ok: false, failure: { code: "permission-denied" } });
  });
});
