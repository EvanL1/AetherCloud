import {
  EdgeDeploymentTransitionError,
  InvalidDomainValueError,
  createEdgeDeployment,
  markEdgeDeploymentOutcomeUnknown,
  parseArtifactId,
  parseArtifactRevisionId,
  parseContentDigest,
  parseDesiredGeneration,
  parseEdgeDeploymentId,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  pauseEdgeDeployment,
  recordEdgeDeploymentObservation,
  requestEdgeDeploymentCancellation,
  resumeEdgeDeployment,
  rollbackEdgeDeployment,
} from "@aether-cloud/domain";
import type {
  EdgeDeployment,
  EdgeDeploymentObservationInput,
  UtcInstant,
} from "@aether-cloud/domain";

import type { ArtifactRegistryRepository } from "./artifact-registry-repository.js";
import {
  CANCEL_EDGE_DEPLOYMENT_COMMAND,
  GET_EDGE_DEPLOYMENT_QUERY,
  MARK_EDGE_DEPLOYMENT_UNKNOWN_COMMAND,
  PAUSE_EDGE_DEPLOYMENT_COMMAND,
  REPORT_EDGE_DEPLOYMENT_COMMAND,
  RESUME_EDGE_DEPLOYMENT_COMMAND,
  ROLLBACK_EDGE_DEPLOYMENT_COMMAND,
  START_EDGE_DEPLOYMENT_COMMAND,
} from "./capability-definition.js";
import type {
  GatewayCredentialAssertion,
  GatewayCredentialVerifier,
} from "./cloudlink-session-repository.js";
import type {
  EdgeDeploymentRepository,
  EdgeDeploymentScope,
} from "./edge-deployment-repository.js";

type EdgeDeploymentFailureCode =
  | "command-expired"
  | "confirmation-required"
  | "deployment-artifact-unavailable"
  | "deployment-conflict"
  | "deployment-idempotency-conflict"
  | "deployment-not-found"
  | "deployment-observation-conflict"
  | "deployment-observation-invalid"
  | "deployment-storage-unavailable"
  | "deployment-version-conflict"
  | "gateway-credential-inactive"
  | "invalid-gateway-credential"
  | "invalid-input"
  | "permission-denied";

export interface EdgeDeploymentApplicationFailure {
  readonly code: EdgeDeploymentFailureCode;
  readonly message: string;
}

export type EdgeDeploymentApplicationResult<Value> =
  | Readonly<{ ok: true; replayed: boolean; value: Value }>
  | Readonly<{ ok: false; failure: EdgeDeploymentApplicationFailure }>;

export type EdgeDeploymentQueryResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: EdgeDeploymentApplicationFailure }>;

export interface EdgeDeploymentView {
  readonly deploymentId: string;
  readonly gatewayId: string;
  readonly desired: Readonly<{ revisionId: string; generation: string }>;
  readonly reported: Readonly<{
    kind: string;
    generation: string;
    revisionId?: string;
    observedAt: string;
  }> | null;
  readonly applied: Readonly<{
    outcome: string;
    generation: string;
    revisionId?: string;
    observedAt: string;
  }> | null;
  readonly rolloutState: EdgeDeployment["rolloutState"];
  readonly reconciliation: EdgeDeployment["reconciliation"];
  readonly revision: number;
}

export interface EdgeDeploymentApplicationClock {
  now(): string;
}

interface TenantCommandContext extends EdgeDeploymentScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
  readonly confirmation: "confirmed" | "not-confirmed";
  readonly requestId: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

interface TenantQueryContext extends EdgeDeploymentScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
}

interface GatewayCommandContext {
  readonly credential: GatewayCredentialAssertion;
  readonly requestId: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

class DeploymentInputError extends Error {}

function failure(
  code: EdgeDeploymentFailureCode,
  message: string,
): Readonly<{ ok: false; failure: EdgeDeploymentApplicationFailure }> {
  return { ok: false, failure: { code, message } };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function requireRecord(input: unknown, name: string): Record<string, unknown> {
  if (!isRecord(input))
    throw new DeploymentInputError(`${name} must be an object`);
  return input;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(record).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new DeploymentInputError(
      `${name} must contain exactly: ${canonical.join(", ")}`,
    );
  }
}

function requireString(input: unknown, name: string, maximum = 128): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > maximum
  ) {
    throw new DeploymentInputError(
      `${name} must be a non-empty bounded string`,
    );
  }
  return input;
}

function requireRequestId(input: unknown): string {
  const value = requireString(input, "idempotencyKey");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new DeploymentInputError("idempotencyKey is invalid");
  }
  return value;
}

function decodePermissions(input: unknown): ReadonlySet<string> {
  if (
    !Array.isArray(input) ||
    input.some((value) => typeof value !== "string")
  ) {
    throw new DeploymentInputError("permissions must be an array of strings");
  }
  return new Set(input);
}

function decodeScope(record: Record<string, unknown>): EdgeDeploymentScope {
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
  };
}

function decodeTenantCommandContext(input: unknown): TenantCommandContext {
  const record = requireRecord(input, "deployment command context");
  requireExactKeys(
    record,
    [
      "confirmation",
      "expiresAt",
      "idempotencyKey",
      "issuedAt",
      "permissions",
      "projectId",
      "subjectId",
      "tenantId",
    ],
    "deployment command context",
  );
  if (
    record.confirmation !== "confirmed" &&
    record.confirmation !== "not-confirmed"
  ) {
    throw new DeploymentInputError("confirmation is invalid");
  }
  return {
    ...decodeScope(record),
    subjectId: requireString(record.subjectId, "subjectId"),
    permissions: decodePermissions(record.permissions),
    confirmation: record.confirmation,
    requestId: requireRequestId(record.idempotencyKey),
    issuedAt: parseUtcInstant(record.issuedAt),
    expiresAt: parseUtcInstant(record.expiresAt),
  };
}

function decodeTenantQueryContext(input: unknown): TenantQueryContext {
  const record = requireRecord(input, "deployment query context");
  requireExactKeys(
    record,
    ["permissions", "projectId", "subjectId", "tenantId"],
    "deployment query context",
  );
  return {
    ...decodeScope(record),
    subjectId: requireString(record.subjectId, "subjectId"),
    permissions: decodePermissions(record.permissions),
  };
}

function decodeGatewayCommandContext(input: unknown): GatewayCommandContext {
  const record = requireRecord(input, "deployment observation context");
  requireExactKeys(
    record,
    ["credentialId", "expiresAt", "idempotencyKey", "issuedAt", "proof"],
    "deployment observation context",
  );
  return {
    credential: {
      credentialId: requireString(record.credentialId, "credentialId"),
      proof: requireString(record.proof, "proof", 4096),
    },
    requestId: requireRequestId(record.idempotencyKey),
    issuedAt: parseUtcInstant(record.issuedAt),
    expiresAt: parseUtcInstant(record.expiresAt),
  };
}

function decodeStartInput(input: unknown): {
  readonly deploymentId: ReturnType<typeof parseEdgeDeploymentId>;
  readonly gatewayId: ReturnType<typeof parseGatewayId>;
  readonly artifactId: ReturnType<typeof parseArtifactId>;
  readonly revisionId: ReturnType<typeof parseArtifactRevisionId>;
  readonly desiredGeneration: ReturnType<typeof parseDesiredGeneration>;
} {
  const record = requireRecord(input, "start deployment input");
  requireExactKeys(
    record,
    [
      "artifactId",
      "deploymentId",
      "desiredGeneration",
      "gatewayId",
      "revisionId",
    ],
    "start deployment input",
  );
  return {
    deploymentId: parseEdgeDeploymentId(record.deploymentId),
    gatewayId: parseGatewayId(record.gatewayId),
    artifactId: parseArtifactId(record.artifactId),
    revisionId: parseArtifactRevisionId(record.revisionId),
    desiredGeneration: parseDesiredGeneration(record.desiredGeneration),
  };
}

type ControlAction =
  | "cancel"
  | "mark-unknown"
  | "pause"
  | "resume"
  | "rollback";

function decodeControlInput(input: unknown): {
  readonly deploymentId: ReturnType<typeof parseEdgeDeploymentId>;
  readonly action: ControlAction;
  readonly artifactId?: ReturnType<typeof parseArtifactId>;
  readonly revisionId?: ReturnType<typeof parseArtifactRevisionId>;
  readonly desiredGeneration?: ReturnType<typeof parseDesiredGeneration>;
} {
  const record = requireRecord(input, "control deployment input");
  if (record.action === "rollback") {
    requireExactKeys(
      record,
      [
        "action",
        "artifactId",
        "deploymentId",
        "desiredGeneration",
        "revisionId",
      ],
      "rollback deployment input",
    );
    return {
      deploymentId: parseEdgeDeploymentId(record.deploymentId),
      action: "rollback",
      artifactId: parseArtifactId(record.artifactId),
      revisionId: parseArtifactRevisionId(record.revisionId),
      desiredGeneration: parseDesiredGeneration(record.desiredGeneration),
    };
  }
  requireExactKeys(
    record,
    ["action", "deploymentId"],
    "control deployment input",
  );
  if (
    record.action !== "cancel" &&
    record.action !== "mark-unknown" &&
    record.action !== "pause" &&
    record.action !== "resume"
  ) {
    throw new DeploymentInputError("deployment control action is unsupported");
  }
  return {
    deploymentId: parseEdgeDeploymentId(record.deploymentId),
    action: record.action,
  };
}

function decodeObservationInput(input: unknown): {
  readonly deploymentId: ReturnType<typeof parseEdgeDeploymentId>;
  readonly observation: EdgeDeploymentObservationInput;
} {
  const record = requireRecord(input, "deployment observation");
  const optionalKeys = ["evidenceDigest", "reportedRevisionId"];
  const requiredKeys = [
    "deploymentId",
    "generation",
    "kind",
    "observationId",
    "observedAt",
  ];
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new DeploymentInputError("deployment observation fields are invalid");
  }
  const kind = record.kind;
  if (
    kind !== "accepted" &&
    kind !== "applied" &&
    kind !== "expired" &&
    kind !== "failed" &&
    kind !== "fetching" &&
    kind !== "rejected" &&
    kind !== "validated"
  ) {
    throw new DeploymentInputError(
      "deployment observation kind is unsupported",
    );
  }
  return {
    deploymentId: parseEdgeDeploymentId(record.deploymentId),
    observation: {
      observationId: requireString(record.observationId, "observationId"),
      generation: parseDesiredGeneration(record.generation),
      kind,
      observedAt: parseUtcInstant(record.observedAt),
      ...(record.reportedRevisionId === undefined
        ? {}
        : {
            reportedRevisionId: parseArtifactRevisionId(
              record.reportedRevisionId,
            ),
          }),
      ...(record.evidenceDigest === undefined
        ? {}
        : { evidenceDigest: parseContentDigest(record.evidenceDigest) }),
    },
  };
}

function decodeDeploymentQuery(
  input: unknown,
): ReturnType<typeof parseEdgeDeploymentId> {
  const record = requireRecord(input, "deployment query");
  requireExactKeys(record, ["deploymentId"], "deployment query");
  return parseEdgeDeploymentId(record.deploymentId);
}

function decodeSafely<Value>(
  decoder: () => Value,
):
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: EdgeDeploymentApplicationFailure }> {
  try {
    return { ok: true, value: decoder() };
  } catch (error: unknown) {
    if (
      error instanceof DeploymentInputError ||
      error instanceof InvalidDomainValueError ||
      error instanceof EdgeDeploymentTransitionError
    ) {
      return {
        ok: false,
        failure: { code: "invalid-input", message: error.message },
      };
    }
    throw error;
  }
}

function authorize(
  permissions: ReadonlySet<string>,
  permission: string,
): EdgeDeploymentApplicationFailure | undefined {
  return permissions.has(permission)
    ? undefined
    : {
        code: "permission-denied",
        message: `permission ${permission} is required`,
      };
}

function validateTime(
  context: Readonly<{ issuedAt: UtcInstant; expiresAt: UtcInstant }>,
  now: UtcInstant,
): EdgeDeploymentApplicationFailure | undefined {
  if (context.expiresAt <= context.issuedAt || context.issuedAt > now) {
    return { code: "invalid-input", message: "command time window is invalid" };
  }
  return now >= context.expiresAt
    ? { code: "command-expired", message: "command has expired" }
    : undefined;
}

function toView(deployment: EdgeDeployment): EdgeDeploymentView {
  return Object.freeze({
    deploymentId: deployment.deploymentId,
    gatewayId: deployment.gatewayId,
    desired: Object.freeze({
      revisionId: deployment.desired.revisionId,
      generation: deployment.desired.generation,
    }),
    reported:
      deployment.reported === undefined
        ? null
        : Object.freeze({
            kind: deployment.reported.kind,
            generation: deployment.reported.generation,
            observedAt: deployment.reported.observedAt,
            ...(deployment.reported.revisionId === undefined
              ? {}
              : { revisionId: deployment.reported.revisionId }),
          }),
    applied:
      deployment.applied === undefined
        ? null
        : Object.freeze({
            outcome: deployment.applied.outcome,
            generation: deployment.applied.generation,
            observedAt: deployment.applied.observedAt,
            ...(deployment.applied.revisionId === undefined
              ? {}
              : { revisionId: deployment.applied.revisionId }),
          }),
    rolloutState: deployment.rolloutState,
    reconciliation: deployment.reconciliation,
    revision: deployment.revision,
  });
}

function mapInsertFailure(
  outcome: "already-exists" | "idempotency-conflict" | "storage-unavailable",
): Readonly<{ ok: false; failure: EdgeDeploymentApplicationFailure }> {
  const codes = {
    "already-exists": "deployment-conflict",
    "idempotency-conflict": "deployment-idempotency-conflict",
    "storage-unavailable": "deployment-storage-unavailable",
  } as const;
  return failure(codes[outcome], "deployment creation was rejected");
}

function mapReplaceFailure(
  outcome:
    | "idempotency-conflict"
    | "not-found"
    | "storage-unavailable"
    | "version-conflict",
): Readonly<{ ok: false; failure: EdgeDeploymentApplicationFailure }> {
  const codes = {
    "idempotency-conflict": "deployment-idempotency-conflict",
    "not-found": "deployment-not-found",
    "storage-unavailable": "deployment-storage-unavailable",
    "version-conflict": "deployment-version-conflict",
  } as const;
  return failure(codes[outcome], "deployment update was rejected");
}

export class StartEdgeDeployment {
  static readonly capability = START_EDGE_DEPLOYMENT_COMMAND;
  readonly #repository: EdgeDeploymentRepository;
  readonly #artifacts: ArtifactRegistryRepository;
  readonly #clock: EdgeDeploymentApplicationClock;

  constructor(dependencies: {
    readonly repository: EdgeDeploymentRepository;
    readonly artifacts: ArtifactRegistryRepository;
    readonly clock: EdgeDeploymentApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#artifacts = dependencies.artifacts;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<EdgeDeploymentApplicationResult<EdgeDeploymentView>> {
    const decodedContext = decodeSafely(() =>
      decodeTenantCommandContext(rawContext),
    );
    if (!decodedContext.ok) return decodedContext;
    const context = decodedContext.value;
    const authorization = authorize(
      context.permissions,
      StartEdgeDeployment.capability.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    if (context.confirmation !== "confirmed") {
      return failure(
        "confirmation-required",
        "deployment start requires confirmation",
      );
    }
    const decodedNow = decodeSafely(() => parseUtcInstant(this.#clock.now()));
    if (!decodedNow.ok) return decodedNow;
    const timeFailure = validateTime(context, decodedNow.value);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    const decodedInput = decodeSafely(() => decodeStartInput(rawInput));
    if (!decodedInput.ok) return decodedInput;
    const input = decodedInput.value;
    const artifact = await this.#artifacts.findRevision(
      context,
      input.artifactId,
      input.revisionId,
    );
    if (artifact === undefined || artifact.state !== "published") {
      return failure(
        "deployment-artifact-unavailable",
        "deployment requires a published artifact revision",
      );
    }
    const deployment = createEdgeDeployment({
      deploymentId: input.deploymentId,
      gatewayId: input.gatewayId,
      desiredRevisionId: input.revisionId,
      desiredGeneration: input.desiredGeneration,
      createdAt: decodedNow.value,
    });
    const persisted = await this.#repository.insert({
      tenantId: context.tenantId,
      projectId: context.projectId,
      requestId: context.requestId,
      subjectId: context.subjectId,
      deployment,
    });
    if (persisted.outcome === "inserted" || persisted.outcome === "replayed") {
      return {
        ok: true,
        replayed: persisted.outcome === "replayed",
        value: toView(persisted.deployment),
      };
    }
    return mapInsertFailure(persisted.outcome);
  }
}

const controlDefinitions = {
  cancel: CANCEL_EDGE_DEPLOYMENT_COMMAND,
  "mark-unknown": MARK_EDGE_DEPLOYMENT_UNKNOWN_COMMAND,
  pause: PAUSE_EDGE_DEPLOYMENT_COMMAND,
  resume: RESUME_EDGE_DEPLOYMENT_COMMAND,
  rollback: ROLLBACK_EDGE_DEPLOYMENT_COMMAND,
} as const;

export class ControlEdgeDeployment {
  readonly #repository: EdgeDeploymentRepository;
  readonly #artifacts: ArtifactRegistryRepository;
  readonly #clock: EdgeDeploymentApplicationClock;

  constructor(dependencies: {
    readonly repository: EdgeDeploymentRepository;
    readonly artifacts: ArtifactRegistryRepository;
    readonly clock: EdgeDeploymentApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#artifacts = dependencies.artifacts;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<EdgeDeploymentApplicationResult<EdgeDeploymentView>> {
    const decodedContext = decodeSafely(() =>
      decodeTenantCommandContext(rawContext),
    );
    if (!decodedContext.ok) return decodedContext;
    const decodedInput = decodeSafely(() => decodeControlInput(rawInput));
    if (!decodedInput.ok) return decodedInput;
    const context = decodedContext.value;
    const input = decodedInput.value;
    const definition = controlDefinitions[input.action];
    const authorization = authorize(context.permissions, definition.permission);
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    if (
      definition.confirmation === "explicit" &&
      context.confirmation !== "confirmed"
    ) {
      return failure(
        "confirmation-required",
        `${input.action} requires confirmation`,
      );
    }
    const decodedNow = decodeSafely(() => parseUtcInstant(this.#clock.now()));
    if (!decodedNow.ok) return decodedNow;
    const timeFailure = validateTime(context, decodedNow.value);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    const current = await this.#repository.find(context, input.deploymentId);
    if (current === undefined)
      return failure("deployment-not-found", "deployment was not found");

    let next: EdgeDeployment;
    let eventName: Parameters<
      EdgeDeploymentRepository["replace"]
    >[0]["eventName"];
    if (input.action === "pause") {
      next = pauseEdgeDeployment(current, decodedNow.value);
      eventName = "deployment.rollout-controlled.v1";
    } else if (input.action === "resume") {
      next = resumeEdgeDeployment(current, decodedNow.value);
      eventName = "deployment.rollout-controlled.v1";
    } else if (input.action === "cancel") {
      next = requestEdgeDeploymentCancellation(current, decodedNow.value);
      eventName = "deployment.rollout-controlled.v1";
    } else if (input.action === "mark-unknown") {
      next = markEdgeDeploymentOutcomeUnknown(current, decodedNow.value);
      eventName = "deployment.rollout-controlled.v1";
    } else {
      if (
        input.artifactId === undefined ||
        input.revisionId === undefined ||
        input.desiredGeneration === undefined
      ) {
        return failure(
          "invalid-input",
          "rollback artifact selection is incomplete",
        );
      }
      const artifact = await this.#artifacts.findRevision(
        context,
        input.artifactId,
        input.revisionId,
      );
      if (artifact === undefined || artifact.state !== "published") {
        return failure(
          "deployment-artifact-unavailable",
          "rollback artifact is unavailable",
        );
      }
      next = rollbackEdgeDeployment(
        current,
        input.revisionId,
        input.desiredGeneration,
        decodedNow.value,
      );
      eventName = "deployment.rollout-controlled.v1";
    }
    const persisted = await this.#repository.replace({
      tenantId: context.tenantId,
      projectId: context.projectId,
      requestId: context.requestId,
      subjectId: context.subjectId,
      expectedRevision: current.revision,
      deployment: next,
      eventName,
    });
    if (persisted.outcome === "replaced" || persisted.outcome === "replayed") {
      return {
        ok: true,
        replayed: persisted.outcome === "replayed",
        value: toView(persisted.deployment),
      };
    }
    return mapReplaceFailure(persisted.outcome);
  }
}

export class ReportEdgeDeploymentObservation {
  static readonly capability = REPORT_EDGE_DEPLOYMENT_COMMAND;
  readonly #repository: EdgeDeploymentRepository;
  readonly #credentialVerifier: GatewayCredentialVerifier;
  readonly #clock: EdgeDeploymentApplicationClock;

  constructor(dependencies: {
    readonly repository: EdgeDeploymentRepository;
    readonly credentialVerifier: GatewayCredentialVerifier;
    readonly clock: EdgeDeploymentApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#credentialVerifier = dependencies.credentialVerifier;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<EdgeDeploymentApplicationResult<EdgeDeploymentView>> {
    const decodedContext = decodeSafely(() =>
      decodeGatewayCommandContext(rawContext),
    );
    if (!decodedContext.ok) return decodedContext;
    const context = decodedContext.value;
    const decodedNow = decodeSafely(() => parseUtcInstant(this.#clock.now()));
    if (!decodedNow.ok) return decodedNow;
    const timeFailure = validateTime(context, decodedNow.value);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    const verified = await this.#credentialVerifier.verify(context.credential);
    if (!verified.ok) {
      return failure("invalid-gateway-credential", verified.failure.message);
    }
    if (verified.value.status !== "active") {
      return failure(
        "gateway-credential-inactive",
        "Gateway credential is inactive",
      );
    }
    const decodedInput = decodeSafely(() => decodeObservationInput(rawInput));
    if (!decodedInput.ok) return decodedInput;
    const current = await this.#repository.find(
      verified.value,
      decodedInput.value.deploymentId,
    );
    if (
      current === undefined ||
      current.gatewayId !== verified.value.gatewayId
    ) {
      return failure("deployment-not-found", "deployment was not found");
    }
    const observed = recordEdgeDeploymentObservation(
      current,
      decodedInput.value.observation,
    );
    if (!observed.ok) {
      const code =
        observed.failure.code === "deployment-observation-conflict"
          ? "deployment-observation-conflict"
          : "deployment-observation-invalid";
      return failure(code, observed.failure.message);
    }
    if (observed.replayed) {
      return { ok: true, replayed: true, value: toView(observed.deployment) };
    }
    const persisted = await this.#repository.replace({
      tenantId: verified.value.tenantId,
      projectId: verified.value.projectId,
      requestId: context.requestId,
      subjectId: `gateway:${verified.value.gatewayId}`,
      expectedRevision: current.revision,
      deployment: observed.deployment,
      eventName: "deployment.observation-recorded.v1",
    });
    if (persisted.outcome === "replaced" || persisted.outcome === "replayed") {
      return {
        ok: true,
        replayed: persisted.outcome === "replayed",
        value: toView(persisted.deployment),
      };
    }
    return mapReplaceFailure(persisted.outcome);
  }
}

export class GetEdgeDeployment {
  static readonly capability = GET_EDGE_DEPLOYMENT_QUERY;
  readonly #repository: EdgeDeploymentRepository;

  constructor(dependencies: { readonly repository: EdgeDeploymentRepository }) {
    this.#repository = dependencies.repository;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<EdgeDeploymentQueryResult<EdgeDeploymentView>> {
    const decodedContext = decodeSafely(() =>
      decodeTenantQueryContext(rawContext),
    );
    if (!decodedContext.ok) return decodedContext;
    const authorization = authorize(
      decodedContext.value.permissions,
      GetEdgeDeployment.capability.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    const deploymentId = decodeSafely(() => decodeDeploymentQuery(rawInput));
    if (!deploymentId.ok) return deploymentId;
    const deployment = await this.#repository.find(
      decodedContext.value,
      deploymentId.value,
    );
    return deployment === undefined
      ? failure("deployment-not-found", "deployment was not found")
      : { ok: true, value: toView(deployment) };
  }
}
