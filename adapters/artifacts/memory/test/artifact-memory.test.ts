import { describe, expect, it } from "vitest";

import {
  GetArtifactRevision,
  PublishArtifactRevision,
} from "@aether-cloud/application";
import { parseUtcInstant } from "@aether-cloud/domain";

import { InMemoryArtifactRegistry } from "../src/index.js";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const artifactId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";
const contentDigest = "a".repeat(64);
const signatureDigest = "b".repeat(64);

function context(idempotencyKey = "publish-request-0001") {
  return {
    tenantId,
    projectId,
    subjectId: "operator-1",
    permissions: ["artifact.revision.publish"],
    confirmation: "confirmed",
    idempotencyKey,
    issuedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2026-07-14T00:05:00.000Z",
  };
}

function input(channel = "stable") {
  return {
    artifactId,
    revisionId,
    revisionNumber: "1",
    kind: "pack",
    contentDigest,
    contentLength: "4096",
    releaseChannel: channel,
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
  };
}

describe("InMemoryArtifactRegistry", () => {
  it("publishes content-addressed immutable revisions and replays exactly once", async () => {
    const adapter = new InMemoryArtifactRegistry();
    adapter.putContent({ digest: contentDigest, byteLength: "4096" });
    adapter.trustSignature({ contentDigest, signatureDigest });
    const useCase = new PublishArtifactRevision({
      repository: adapter,
      contentStore: adapter,
      signatureVerifier: adapter,
      clock: { now: () => parseUtcInstant("2026-07-14T00:01:00.000Z") },
    });

    expect(await useCase.execute(context(), input())).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(await useCase.execute(context(), input())).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(adapter.revisionCount()).toBe(1);
    expect(adapter.auditEvents()).toHaveLength(1);
    expect(adapter.pendingOutboxEvents()).toHaveLength(1);
  });

  it("rejects revision and release-channel races without replacing publication", async () => {
    const adapter = new InMemoryArtifactRegistry();
    adapter.putContent({ digest: contentDigest, byteLength: "4096" });
    adapter.trustSignature({ contentDigest, signatureDigest });
    const useCase = new PublishArtifactRevision({
      repository: adapter,
      contentStore: adapter,
      signatureVerifier: adapter,
      clock: { now: () => parseUtcInstant("2026-07-14T00:01:00.000Z") },
    });
    await useCase.execute(context(), input());

    expect(
      await useCase.execute(context("publish-request-0002"), {
        ...input(),
        contentDigest: "c".repeat(64),
      }),
    ).toMatchObject({ ok: false });
    expect(
      await useCase.execute(context("publish-request-0003"), {
        ...input(),
        revisionId: "33333333-3333-4333-8333-333333333333",
      }),
    ).toMatchObject({
      ok: false,
      failure: { code: "artifact-channel-conflict" },
    });
    expect(adapter.revisionCount()).toBe(1);
  });

  it("keeps cross-Tenant queries hidden and persists nothing on storage failure", async () => {
    const adapter = new InMemoryArtifactRegistry();
    adapter.putContent({ digest: contentDigest, byteLength: "4096" });
    adapter.trustSignature({ contentDigest, signatureDigest });
    adapter.failNextPersistence();
    const useCase = new PublishArtifactRevision({
      repository: adapter,
      contentStore: adapter,
      signatureVerifier: adapter,
      clock: { now: () => parseUtcInstant("2026-07-14T00:01:00.000Z") },
    });

    expect(await useCase.execute(context(), input())).toMatchObject({
      ok: false,
      failure: { code: "artifact-storage-unavailable" },
    });
    expect(adapter.revisionCount()).toBe(0);
    expect(adapter.auditEvents()).toHaveLength(0);

    const query = new GetArtifactRevision({ repository: adapter });
    expect(
      await query.execute(
        {
          tenantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          projectId,
          subjectId: "reader-1",
          permissions: ["artifact.revision.read"],
        },
        { artifactId, revisionId },
      ),
    ).toMatchObject({ ok: false, failure: { code: "artifact-not-found" } });
  });
});
