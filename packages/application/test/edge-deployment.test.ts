import { describe, expect, it } from "vitest";

import {
  ControlEdgeDeployment,
  GetEdgeDeployment,
  ReportEdgeDeploymentObservation,
  StartEdgeDeployment,
} from "../src/index.js";
import type {
  ArtifactRegistryRepository,
  EdgeDeploymentRepository,
  GatewayCredentialVerifier,
} from "../src/index.js";
import {
  createEdgeDeployment,
  parseArtifactId,
  parseArtifactRevisionId,
  parseDesiredGeneration,
  parseEdgeDeploymentId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  publishArtifactRevision,
  validateArtifactRevision,
  defineArtifactRevisionDraft,
  parseArtifactContentLength,
  parseArtifactRevisionNumber,
  parseContentDigest,
} from "@aether-cloud/domain";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const deploymentId = "11111111-1111-4111-8111-111111111111";
const gatewayId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";
const revisionId = "44444444-4444-4444-8444-444444444444";

function publishedArtifact() {
  const at = parseUtcInstant("2026-07-14T00:00:00.000Z");
  return publishArtifactRevision(
    validateArtifactRevision(
      defineArtifactRevisionDraft({
        artifactId: parseArtifactId(artifactId),
        revisionId: parseArtifactRevisionId(revisionId),
        revisionNumber: parseArtifactRevisionNumber("1"),
        kind: "pack",
        contentDigest: parseContentDigest("a".repeat(64)),
        contentLength: parseArtifactContentLength("10"),
        compatibility: {
          runtimeContract: "aetheriot.runtime-manifest.v1",
          requiredCapabilities: [],
        },
        dependencies: [],
        signature: {
          algorithm: "ed25519",
          keyId: "key-1",
          signatureDigest: parseContentDigest("b".repeat(64)),
        },
        createdAt: at,
      }),
      at,
    ),
    at,
  );
}

function commandContext(overrides: Record<string, unknown> = {}) {
  return {
    tenantId,
    projectId,
    subjectId: "operator-1",
    permissions: ["deployment.rollout.start"],
    confirmation: "confirmed",
    idempotencyKey: "deployment-request-0001",
    issuedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2026-07-14T00:10:00.000Z",
    ...overrides,
  };
}

function repository(
  overrides: Partial<EdgeDeploymentRepository> = {},
): EdgeDeploymentRepository {
  return {
    insert: (request) =>
      Promise.resolve({ outcome: "inserted", deployment: request.deployment }),
    replace: (request) =>
      Promise.resolve({ outcome: "replaced", deployment: request.deployment }),
    find: () => Promise.resolve(undefined),
    ...overrides,
  };
}

function artifactRepository(): ArtifactRegistryRepository {
  return {
    publish: () => Promise.resolve({ outcome: "storage-unavailable" }),
    findRevision: () => Promise.resolve(publishedArtifact()),
    findChannel: () => Promise.resolve(undefined),
  };
}

describe("Edge deployment application", () => {
  it("starts desired intent only after authorization, confirmation, and published revision lookup", async () => {
    const useCase = new StartEdgeDeployment({
      repository: repository(),
      artifacts: artifactRepository(),
      clock: { now: () => "2026-07-14T00:01:00.000Z" },
    });
    const input = {
      deploymentId,
      gatewayId,
      artifactId,
      revisionId,
      desiredGeneration: "1",
    };

    expect(await useCase.execute(commandContext(), input)).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        desired: { revisionId, generation: "1" },
        reported: null,
        applied: null,
      },
    });
    expect(
      await useCase.execute(commandContext({ permissions: [] }), input),
    ).toMatchObject({ ok: false, failure: { code: "permission-denied" } });
    expect(
      await useCase.execute(
        commandContext({ confirmation: "not-confirmed" }),
        input,
      ),
    ).toMatchObject({ ok: false, failure: { code: "confirmation-required" } });
  });

  it("rejects unpublished or missing artifact revisions", async () => {
    const artifacts = artifactRepository();
    artifacts.findRevision = () => Promise.resolve(undefined);
    const useCase = new StartEdgeDeployment({
      repository: repository(),
      artifacts,
      clock: { now: () => "2026-07-14T00:01:00.000Z" },
    });

    expect(
      await useCase.execute(commandContext(), {
        deploymentId,
        gatewayId,
        artifactId,
        revisionId,
        desiredGeneration: "1",
      }),
    ).toMatchObject({
      ok: false,
      failure: { code: "deployment-artifact-unavailable" },
    });
  });

  it("derives observation scope and target from an active Gateway credential", async () => {
    const current = createEdgeDeployment({
      deploymentId: parseEdgeDeploymentId(deploymentId),
      gatewayId: parseGatewayId(gatewayId),
      desiredRevisionId: parseArtifactRevisionId(revisionId),
      desiredGeneration: parseDesiredGeneration("1"),
      createdAt: parseUtcInstant("2026-07-14T00:00:00.000Z"),
    });
    const verifier: GatewayCredentialVerifier = {
      verify: () =>
        Promise.resolve({
          ok: true,
          value: {
            tenantId: parseTenantId(tenantId),
            projectId: parseProjectId(projectId),
            gatewayId: parseGatewayId(gatewayId),
            generation: parseGatewayCredentialGeneration("1"),
            status: "active",
          },
        }),
    };
    const useCase = new ReportEdgeDeploymentObservation({
      repository: repository({ find: () => Promise.resolve(current) }),
      credentialVerifier: verifier,
      clock: { now: () => "2026-07-14T00:02:00.000Z" },
    });

    expect(
      await useCase.execute(
        {
          credentialId: "gateway-credential-1",
          proof: "opaque-proof",
          idempotencyKey: "observation-request-0001",
          issuedAt: "2026-07-14T00:01:00.000Z",
          expiresAt: "2026-07-14T00:05:00.000Z",
        },
        {
          deploymentId,
          observationId: "observation-applied-0001",
          generation: "1",
          kind: "applied",
          observedAt: "2026-07-14T00:01:30.000Z",
          reportedRevisionId: revisionId,
          evidenceDigest: "c".repeat(64),
        },
      ),
    ).toMatchObject({
      ok: true,
      value: { applied: { outcome: "applied", revisionId } },
    });
  });

  it("controls and queries deployment only through Tenant-scoped use cases", async () => {
    const current = createEdgeDeployment({
      deploymentId: parseEdgeDeploymentId(deploymentId),
      gatewayId: parseGatewayId(gatewayId),
      desiredRevisionId: parseArtifactRevisionId(revisionId),
      desiredGeneration: parseDesiredGeneration("1"),
      createdAt: parseUtcInstant("2026-07-14T00:00:00.000Z"),
    });
    const repo = repository({ find: () => Promise.resolve(current) });
    const control = new ControlEdgeDeployment({
      repository: repo,
      artifacts: artifactRepository(),
      clock: { now: () => "2026-07-14T00:02:00.000Z" },
    });
    const query = new GetEdgeDeployment({ repository: repo });

    expect(
      await control.execute(
        commandContext({
          permissions: ["deployment.rollout.pause"],
          confirmation: "not-confirmed",
        }),
        { deploymentId, action: "pause" },
      ),
    ).toMatchObject({ ok: true, value: { rolloutState: "paused" } });
    expect(
      await query.execute(
        {
          tenantId,
          projectId,
          subjectId: "reader-1",
          permissions: ["deployment.rollout.read"],
        },
        { deploymentId },
      ),
    ).toMatchObject({ ok: true, value: { desired: { revisionId } } });
  });
});
