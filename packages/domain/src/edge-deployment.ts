import {
  InvalidDomainValueError,
  parseGatewayId,
  parseUtcInstant,
} from "./resource-identities.js";
import type { GatewayId, UtcInstant } from "./resource-identities.js";
import {
  parseArtifactRevisionId,
  parseContentDigest,
} from "./artifact-registry.js";
import type { ArtifactRevisionId, ContentDigest } from "./artifact-registry.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uint64Pattern = /^(?:0|[1-9][0-9]*)$/;
const opaqueObservationPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const maximumUint64 = 18_446_744_073_709_551_615n;

declare const edgeDeploymentIdBrand: unique symbol;
declare const desiredGenerationBrand: unique symbol;
declare const deploymentObservationIdBrand: unique symbol;

export type EdgeDeploymentId = string & {
  readonly [edgeDeploymentIdBrand]: true;
};
export type DesiredGeneration = string & {
  readonly [desiredGenerationBrand]: true;
};
export type DeploymentObservationId = string & {
  readonly [deploymentObservationIdBrand]: true;
};

export type EdgeDeploymentRolloutState =
  | "cancel-requested"
  | "completed"
  | "completed-with-failures"
  | "paused"
  | "running";

export type EdgeDeploymentReconciliation =
  | "drifted"
  | "failed"
  | "in-sync"
  | "pending"
  | "unknown";

export type EdgeDeploymentObservationKind =
  | "accepted"
  | "applied"
  | "expired"
  | "failed"
  | "fetching"
  | "rejected"
  | "validated";

export interface EdgeDeploymentDesiredFact {
  readonly revisionId: ArtifactRevisionId;
  readonly generation: DesiredGeneration;
  readonly requestedAt: UtcInstant;
}

export interface EdgeDeploymentReportedFact {
  readonly observationId: DeploymentObservationId;
  readonly generation: DesiredGeneration;
  readonly kind: EdgeDeploymentObservationKind;
  readonly observedAt: UtcInstant;
  readonly revisionId?: ArtifactRevisionId;
  readonly evidenceDigest?: ContentDigest;
}

export interface EdgeDeploymentAppliedFact {
  readonly observationId?: DeploymentObservationId;
  readonly generation: DesiredGeneration;
  readonly outcome: "applied" | "failed";
  readonly observedAt: UtcInstant;
  readonly revisionId?: ArtifactRevisionId;
  readonly evidenceDigest?: ContentDigest;
}

export type DesiredDeploymentRevision = EdgeDeploymentDesiredFact;
export type ReportedDeploymentFact = EdgeDeploymentReportedFact;
export type AppliedDeploymentEvidence = EdgeDeploymentAppliedFact;

export interface EdgeDeployment {
  readonly deploymentId: EdgeDeploymentId;
  readonly gatewayId: GatewayId;
  readonly desired: EdgeDeploymentDesiredFact;
  readonly desiredHistory: readonly EdgeDeploymentDesiredFact[];
  readonly observationHistory: readonly EdgeDeploymentReportedFact[];
  readonly reported?: EdgeDeploymentReportedFact;
  readonly applied?: EdgeDeploymentAppliedFact;
  readonly rolloutState: EdgeDeploymentRolloutState;
  readonly reconciliation: EdgeDeploymentReconciliation;
  readonly outcomeUnknownAt?: UtcInstant;
  readonly revision: number;
}

export interface EdgeDeploymentObservationInput {
  readonly observationId: string;
  readonly generation: DesiredGeneration;
  readonly kind: EdgeDeploymentObservationKind;
  readonly observedAt: UtcInstant;
  readonly reportedRevisionId?: ArtifactRevisionId;
  readonly evidenceDigest?: string;
}

export type EdgeDeploymentObservation = EdgeDeploymentObservationInput;

export interface EdgeDeploymentObservationFailure {
  readonly code:
    | "deployment-observation-conflict"
    | "deployment-observation-invalid"
    | "deployment-observation-newer-than-desired";
  readonly message: string;
}

export type EdgeDeploymentObservationResult =
  | Readonly<{
      ok: true;
      replayed: boolean;
      disposition: "accepted-current" | "accepted-late" | "replayed";
      deployment: EdgeDeployment;
    }>
  | Readonly<{ ok: false; failure: EdgeDeploymentObservationFailure }>;

export class EdgeDeploymentTransitionError extends Error {
  readonly code = "invalid-edge-deployment-transition";

  constructor(message: string) {
    super(message);
    this.name = "EdgeDeploymentTransitionError";
  }
}

export function parseEdgeDeploymentId(input: unknown): EdgeDeploymentId {
  if (typeof input !== "string" || !uuidPattern.test(input)) {
    throw new InvalidDomainValueError(
      "deploymentId",
      "deploymentId must be a canonical lowercase UUID",
    );
  }
  return input as EdgeDeploymentId;
}

export function parseDesiredGeneration(input: unknown): DesiredGeneration {
  if (
    typeof input !== "string" ||
    !uint64Pattern.test(input) ||
    input === "0" ||
    BigInt(input) > maximumUint64
  ) {
    throw new InvalidDomainValueError(
      "desiredGeneration",
      "desiredGeneration must be a canonical positive uint64 decimal string",
    );
  }
  return input as DesiredGeneration;
}

export function parseDeploymentObservationId(
  input: unknown,
): DeploymentObservationId {
  if (typeof input !== "string" || !opaqueObservationPattern.test(input)) {
    throw new InvalidDomainValueError(
      "observationId",
      "observationId must be an opaque 8-128 character identifier",
    );
  }
  return input as DeploymentObservationId;
}

function compareGeneration(
  left: DesiredGeneration,
  right: DesiredGeneration,
): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function freezeDesired(
  input: EdgeDeploymentDesiredFact,
): EdgeDeploymentDesiredFact {
  return Object.freeze({ ...input });
}

function freezeReported(
  input: EdgeDeploymentReportedFact,
): EdgeDeploymentReportedFact {
  return Object.freeze({ ...input });
}

function freezeApplied(
  input: EdgeDeploymentAppliedFact,
): EdgeDeploymentAppliedFact {
  return Object.freeze({ ...input });
}

function freezeDeployment(input: EdgeDeployment): EdgeDeployment {
  return Object.freeze({
    ...input,
    desired: freezeDesired(input.desired),
    desiredHistory: Object.freeze(input.desiredHistory.map(freezeDesired)),
    observationHistory: Object.freeze(
      input.observationHistory.map(freezeReported),
    ),
    ...(input.reported === undefined
      ? {}
      : { reported: freezeReported(input.reported) }),
    ...(input.applied === undefined
      ? {}
      : { applied: freezeApplied(input.applied) }),
  });
}

function reconciliationFor(
  desired: EdgeDeploymentDesiredFact,
  applied: EdgeDeploymentAppliedFact | undefined,
): EdgeDeploymentReconciliation {
  if (applied === undefined) return "pending";
  if (applied.outcome === "failed") return "failed";
  return applied.generation === desired.generation &&
    applied.revisionId === desired.revisionId
    ? "in-sync"
    : "drifted";
}

export function createEdgeDeployment(input: {
  readonly deploymentId: EdgeDeploymentId;
  readonly gatewayId: GatewayId;
  readonly desiredRevisionId: ArtifactRevisionId;
  readonly desiredGeneration: DesiredGeneration;
  readonly createdAt: UtcInstant;
}): EdgeDeployment {
  const desired = freezeDesired({
    revisionId: parseArtifactRevisionId(input.desiredRevisionId),
    generation: parseDesiredGeneration(input.desiredGeneration),
    requestedAt: parseUtcInstant(input.createdAt),
  });
  return freezeDeployment({
    deploymentId: parseEdgeDeploymentId(input.deploymentId),
    gatewayId: parseGatewayId(input.gatewayId),
    desired,
    desiredHistory: [desired],
    observationHistory: [],
    rolloutState: "running",
    reconciliation: "pending",
    revision: 1,
  });
}

function transitionRollout(
  deployment: EdgeDeployment,
  next: EdgeDeploymentRolloutState,
  changedAt: UtcInstant,
): EdgeDeployment {
  parseUtcInstant(changedAt);
  return freezeDeployment({
    ...deployment,
    rolloutState: next,
    revision: deployment.revision + 1,
  });
}

export function pauseEdgeDeployment(
  deployment: EdgeDeployment,
  pausedAt: UtcInstant,
): EdgeDeployment {
  if (deployment.rolloutState === "paused") return deployment;
  if (deployment.rolloutState !== "running") {
    throw new EdgeDeploymentTransitionError(
      `pause requires running state, received ${deployment.rolloutState}`,
    );
  }
  return transitionRollout(deployment, "paused", pausedAt);
}

export function resumeEdgeDeployment(
  deployment: EdgeDeployment,
  resumedAt: UtcInstant,
): EdgeDeployment {
  if (deployment.rolloutState === "running") return deployment;
  if (deployment.rolloutState !== "paused") {
    throw new EdgeDeploymentTransitionError(
      `resume requires paused state, received ${deployment.rolloutState}`,
    );
  }
  return transitionRollout(deployment, "running", resumedAt);
}

export function requestEdgeDeploymentCancellation(
  deployment: EdgeDeployment,
  requestedAt: UtcInstant,
): EdgeDeployment {
  if (deployment.rolloutState === "cancel-requested") return deployment;
  if (
    deployment.rolloutState !== "running" &&
    deployment.rolloutState !== "paused"
  ) {
    throw new EdgeDeploymentTransitionError(
      `cancellation cannot be requested from ${deployment.rolloutState}`,
    );
  }
  return transitionRollout(deployment, "cancel-requested", requestedAt);
}

export function rollbackEdgeDeployment(
  deployment: EdgeDeployment,
  desiredRevisionId: ArtifactRevisionId,
  desiredGeneration: DesiredGeneration,
  requestedAt: UtcInstant,
): EdgeDeployment {
  if (
    compareGeneration(desiredGeneration, deployment.desired.generation) <= 0
  ) {
    throw new EdgeDeploymentTransitionError(
      "a rollback intent requires a newer desired generation",
    );
  }
  const desired = freezeDesired({
    revisionId: parseArtifactRevisionId(desiredRevisionId),
    generation: parseDesiredGeneration(desiredGeneration),
    requestedAt: parseUtcInstant(requestedAt),
  });
  return freezeDeployment({
    ...deployment,
    desired,
    desiredHistory: [...deployment.desiredHistory, desired],
    rolloutState: "running",
    reconciliation: reconciliationFor(desired, deployment.applied),
    revision: deployment.revision + 1,
  });
}

export function markEdgeDeploymentOutcomeUnknown(
  deployment: EdgeDeployment,
  observedAt: UtcInstant,
): EdgeDeployment {
  return freezeDeployment({
    ...deployment,
    outcomeUnknownAt: parseUtcInstant(observedAt),
    reconciliation: "unknown",
    revision: deployment.revision + 1,
  });
}

function sameObservation(
  left: EdgeDeploymentReportedFact,
  right: EdgeDeploymentReportedFact,
): boolean {
  return (
    left.observationId === right.observationId &&
    left.generation === right.generation &&
    left.kind === right.kind &&
    left.observedAt === right.observedAt &&
    left.revisionId === right.revisionId &&
    left.evidenceDigest === right.evidenceDigest
  );
}

function observationFailure(
  code: EdgeDeploymentObservationFailure["code"],
  message: string,
): Readonly<{ ok: false; failure: EdgeDeploymentObservationFailure }> {
  return { ok: false, failure: { code, message } };
}

export function recordEdgeDeploymentObservation(
  deployment: EdgeDeployment,
  input: EdgeDeploymentObservationInput,
): EdgeDeploymentObservationResult {
  const observationId = parseDeploymentObservationId(input.observationId);
  const observedAt = parseUtcInstant(input.observedAt);
  const revisionId =
    input.reportedRevisionId === undefined
      ? undefined
      : parseArtifactRevisionId(input.reportedRevisionId);
  const evidenceDigest =
    input.evidenceDigest === undefined
      ? undefined
      : parseContentDigest(input.evidenceDigest);
  if (
    (input.kind === "fetching" ||
      input.kind === "validated" ||
      input.kind === "applied") &&
    revisionId === undefined
  ) {
    return observationFailure(
      "deployment-observation-invalid",
      `${input.kind} observation requires reportedRevisionId`,
    );
  }
  if (input.kind === "applied" && evidenceDigest === undefined) {
    return observationFailure(
      "deployment-observation-invalid",
      "applied observation requires evidenceDigest",
    );
  }
  const observed = freezeReported({
    observationId,
    generation: parseDesiredGeneration(input.generation),
    kind: input.kind,
    observedAt,
    ...(revisionId === undefined ? {} : { revisionId }),
    ...(evidenceDigest === undefined ? {} : { evidenceDigest }),
  });
  const existing = deployment.observationHistory.find(
    (candidate) => candidate.observationId === observationId,
  );
  if (existing !== undefined) {
    return sameObservation(existing, observed)
      ? {
          ok: true,
          replayed: true,
          disposition: "replayed",
          deployment,
        }
      : observationFailure(
          "deployment-observation-conflict",
          "observation identity was reused with different evidence",
        );
  }
  const generationOrder = compareGeneration(
    observed.generation,
    deployment.desired.generation,
  );
  if (generationOrder > 0) {
    return observationFailure(
      "deployment-observation-newer-than-desired",
      "edge observation generation is newer than cloud desired intent",
    );
  }
  if (generationOrder < 0) {
    return {
      ok: true,
      replayed: false,
      disposition: "accepted-late",
      deployment: freezeDeployment({
        ...deployment,
        observationHistory: [...deployment.observationHistory, observed],
        revision: deployment.revision + 1,
      }),
    };
  }

  let applied = deployment.applied;
  let rolloutState = deployment.rolloutState;
  if (observed.kind === "applied") {
    applied = freezeApplied({
      observationId: observed.observationId,
      generation: observed.generation,
      outcome: "applied",
      observedAt: observed.observedAt,
      ...(observed.revisionId === undefined
        ? {}
        : { revisionId: observed.revisionId }),
      ...(observed.evidenceDigest === undefined
        ? {}
        : { evidenceDigest: observed.evidenceDigest }),
    });
    rolloutState = "completed";
  } else if (observed.kind === "failed") {
    applied = freezeApplied({
      observationId: observed.observationId,
      generation: observed.generation,
      outcome: "failed",
      observedAt: observed.observedAt,
      ...(observed.revisionId === undefined
        ? {}
        : { revisionId: observed.revisionId }),
      ...(observed.evidenceDigest === undefined
        ? {}
        : { evidenceDigest: observed.evidenceDigest }),
    });
    rolloutState = "completed-with-failures";
  } else if (observed.kind === "rejected" || observed.kind === "expired") {
    rolloutState = "completed-with-failures";
  }

  return {
    ok: true,
    replayed: false,
    disposition: "accepted-current",
    deployment: freezeDeployment({
      ...deployment,
      observationHistory: [...deployment.observationHistory, observed],
      reported: observed,
      ...(applied === undefined ? {} : { applied }),
      rolloutState,
      reconciliation: reconciliationFor(deployment.desired, applied),
      revision: deployment.revision + 1,
    }),
  };
}
