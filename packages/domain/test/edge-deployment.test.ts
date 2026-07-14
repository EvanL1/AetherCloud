import { describe, expect, it } from "vitest";

import {
  createEdgeDeployment,
  markEdgeDeploymentOutcomeUnknown,
  parseArtifactRevisionId,
  parseDesiredGeneration,
  parseEdgeDeploymentId,
  parseGatewayId,
  parseUtcInstant,
  pauseEdgeDeployment,
  recordEdgeDeploymentObservation,
  requestEdgeDeploymentCancellation,
  resumeEdgeDeployment,
  rollbackEdgeDeployment,
} from "../src/index.js";

const deploymentId = parseEdgeDeploymentId(
  "11111111-1111-4111-8111-111111111111",
);
const gatewayId = parseGatewayId("22222222-2222-4222-8222-222222222222");
const revision1 = parseArtifactRevisionId(
  "33333333-3333-4333-8333-333333333333",
);
const revision2 = parseArtifactRevisionId(
  "44444444-4444-4444-8444-444444444444",
);
const at = (value: string) => parseUtcInstant(value);

function deployment() {
  return createEdgeDeployment({
    deploymentId,
    gatewayId,
    desiredRevisionId: revision1,
    desiredGeneration: parseDesiredGeneration("1"),
    createdAt: at("2026-07-14T00:00:00.000Z"),
  });
}

describe("Desired, Reported, and Applied deployment", () => {
  it("keeps accepted/fetching/validated reports separate from applied evidence", () => {
    const accepted = recordEdgeDeploymentObservation(deployment(), {
      observationId: "obs-accepted-0001",
      generation: parseDesiredGeneration("1"),
      kind: "accepted",
      observedAt: at("2026-07-14T00:01:00.000Z"),
    });
    if (!accepted.ok) throw new Error("fixture observation failed");
    const fetching = recordEdgeDeploymentObservation(accepted.deployment, {
      observationId: "obs-fetching-0001",
      generation: parseDesiredGeneration("1"),
      kind: "fetching",
      observedAt: at("2026-07-14T00:02:00.000Z"),
      reportedRevisionId: revision1,
    });
    if (!fetching.ok) throw new Error("fixture observation failed");

    expect(fetching.deployment.reported?.kind).toBe("fetching");
    expect(fetching.deployment.applied).toBeUndefined();
    expect(fetching.deployment.reconciliation).toBe("pending");
  });

  it("represents timeout as unknown and lets late applied evidence resolve it", () => {
    const unknown = markEdgeDeploymentOutcomeUnknown(
      deployment(),
      at("2026-07-14T00:03:00.000Z"),
    );
    const applied = recordEdgeDeploymentObservation(unknown, {
      observationId: "obs-applied-0001",
      generation: parseDesiredGeneration("1"),
      kind: "applied",
      observedAt: at("2026-07-14T00:04:00.000Z"),
      reportedRevisionId: revision1,
      evidenceDigest: "a".repeat(64),
    });
    if (!applied.ok) throw new Error("fixture observation failed");

    expect(unknown.reconciliation).toBe("unknown");
    expect(unknown.applied).toBeUndefined();
    expect(applied.deployment).toMatchObject({
      rolloutState: "completed",
      reconciliation: "in-sync",
      applied: { outcome: "applied", revisionId: revision1 },
    });
  });

  it("retains late observations without rolling the current projection backward", () => {
    const rolledBack = rollbackEdgeDeployment(
      deployment(),
      revision2,
      parseDesiredGeneration("2"),
      at("2026-07-14T00:05:00.000Z"),
    );
    const late = recordEdgeDeploymentObservation(rolledBack, {
      observationId: "obs-late-0000001",
      generation: parseDesiredGeneration("1"),
      kind: "applied",
      observedAt: at("2026-07-14T00:06:00.000Z"),
      reportedRevisionId: revision1,
      evidenceDigest: "b".repeat(64),
    });

    expect(late).toMatchObject({ ok: true, disposition: "accepted-late" });
    if (!late.ok) throw new Error("fixture observation failed");
    expect(late.deployment.desired.revisionId).toBe(revision2);
    expect(late.deployment.applied).toBeUndefined();
    expect(late.deployment.desiredHistory).toHaveLength(2);
  });

  it("models pause, resume, and cancellation as intent rather than physical undo", () => {
    const paused = pauseEdgeDeployment(
      deployment(),
      at("2026-07-14T00:01:00.000Z"),
    );
    const resumed = resumeEdgeDeployment(
      paused,
      at("2026-07-14T00:02:00.000Z"),
    );
    const canceled = requestEdgeDeploymentCancellation(
      resumed,
      at("2026-07-14T00:03:00.000Z"),
    );

    expect(paused.rolloutState).toBe("paused");
    expect(resumed.rolloutState).toBe("running");
    expect(canceled.rolloutState).toBe("cancel-requested");
    expect(canceled.applied).toBeUndefined();
  });
});
