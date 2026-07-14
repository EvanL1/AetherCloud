import { describe, expect, it } from "vitest";

import {
  ControlEdgeDeployment,
  GetEdgeDeployment,
  StartEdgeDeployment,
} from "@aether-cloud/application";
import { InMemoryArtifactRegistry } from "@aether-cloud/artifact-memory-adapter";

import { InMemoryEdgeDeploymentRepository } from "../src/index.js";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const deploymentId = "11111111-1111-4111-8111-111111111111";
const gatewayId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";
const revisionId = "44444444-4444-4444-8444-444444444444";

function context(request = "deployment-request-0001") {
  return {
    tenantId,
    projectId,
    subjectId: "operator-1",
    permissions: ["deployment.rollout.start"],
    confirmation: "confirmed",
    idempotencyKey: request,
    issuedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2026-07-14T00:10:00.000Z",
  };
}

async function fixture() {
  const artifacts = new InMemoryArtifactRegistry();
  artifacts.putContent({ digest: "a".repeat(64), byteLength: "10" });
  artifacts.trustSignature({
    contentDigest: "a".repeat(64),
    signatureDigest: "b".repeat(64),
  });
  const publish = new (
    await import("@aether-cloud/application")
  ).PublishArtifactRevision({
    repository: artifacts,
    contentStore: artifacts,
    signatureVerifier: artifacts,
    clock: { now: () => "2026-07-14T00:00:30.000Z" },
  });
  await publish.execute(
    {
      ...context("artifact-request-0001"),
      permissions: ["artifact.revision.publish"],
    },
    {
      artifactId,
      revisionId,
      revisionNumber: "1",
      kind: "pack",
      contentDigest: "a".repeat(64),
      contentLength: "10",
      releaseChannel: "stable",
      compatibility: {
        runtimeContract: "aetheriot.runtime-manifest.v1",
        requiredCapabilities: [],
      },
      dependencies: [],
      signature: {
        algorithm: "ed25519",
        keyId: "key-1",
        signatureDigest: "b".repeat(64),
      },
    },
  );
  return { artifacts, repository: new InMemoryEdgeDeploymentRepository() };
}

describe("InMemoryEdgeDeploymentRepository", () => {
  it("atomically starts and exactly replays desired intent", async () => {
    const { artifacts, repository } = await fixture();
    const start = new StartEdgeDeployment({
      repository,
      artifacts,
      clock: { now: () => "2026-07-14T00:01:00.000Z" },
    });
    const input = {
      deploymentId,
      gatewayId,
      artifactId,
      revisionId,
      desiredGeneration: "1",
    };

    expect(await start.execute(context(), input)).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(await start.execute(context(), input)).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(repository.deploymentCount()).toBe(1);
    expect(repository.auditEvents()).toHaveLength(1);
    expect(repository.pendingOutboxEvents()).toHaveLength(1);
  });

  it("persists pause as a new revision and hides cross-Tenant queries", async () => {
    const { artifacts, repository } = await fixture();
    const start = new StartEdgeDeployment({
      repository,
      artifacts,
      clock: { now: () => "2026-07-14T00:01:00.000Z" },
    });
    await start.execute(context(), {
      deploymentId,
      gatewayId,
      artifactId,
      revisionId,
      desiredGeneration: "1",
    });
    const control = new ControlEdgeDeployment({
      repository,
      artifacts,
      clock: { now: () => "2026-07-14T00:02:00.000Z" },
    });
    expect(
      await control.execute(
        {
          ...context("pause-request-0001"),
          permissions: ["deployment.rollout.pause"],
          confirmation: "not-confirmed",
        },
        { deploymentId, action: "pause" },
      ),
    ).toMatchObject({ ok: true, value: { rolloutState: "paused" } });
    const query = new GetEdgeDeployment({ repository });
    expect(
      await query.execute(
        {
          tenantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          projectId,
          subjectId: "reader-1",
          permissions: ["deployment.rollout.read"],
        },
        { deploymentId },
      ),
    ).toMatchObject({ ok: false, failure: { code: "deployment-not-found" } });
  });

  it("leaves no deployment, audit, or outbox evidence on atomic failure", async () => {
    const { artifacts, repository } = await fixture();
    repository.failNextPersistence();
    const start = new StartEdgeDeployment({
      repository,
      artifacts,
      clock: { now: () => "2026-07-14T00:01:00.000Z" },
    });
    expect(
      await start.execute(context(), {
        deploymentId,
        gatewayId,
        artifactId,
        revisionId,
        desiredGeneration: "1",
      }),
    ).toMatchObject({
      ok: false,
      failure: { code: "deployment-storage-unavailable" },
    });
    expect(repository.deploymentCount()).toBe(0);
    expect(repository.auditEvents()).toHaveLength(0);
    expect(repository.pendingOutboxEvents()).toHaveLength(0);
  });
});
