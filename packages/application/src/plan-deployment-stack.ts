import {
  InvalidDeploymentStackError,
  InvalidDomainValueError,
  parseDeploymentStackId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  type CloudConnectionId,
  type CloudProviderId,
  type DeploymentStack,
  type DeploymentStackId,
  type InfrastructurePlanId,
  type ProjectId,
  type TenantId,
  type UtcInstant,
} from "@aether-cloud/domain";

import type { CommandDefinition } from "./capability-definition.js";
import type { ApplicationClock } from "./gateway-identity-repository.js";
import type {
  InfrastructureEngineRegistry,
  ImmutableArtifactSelection,
  InfrastructureEngineDescriptor,
  InfrastructureEngineFailure,
  InfrastructureEngineKind,
  InfrastructureEnginePlanValue,
  InfrastructureModuleSelection,
  InfrastructurePlanArtifact,
  InfrastructureResourceChange,
  InfrastructureStateLockEvidence,
} from "./infrastructure-engine.js";

export const PLAN_DEPLOYMENT_STACK_COMMAND = Object.freeze({
  kind: "command",
  name: "infrastructure.stack.plan",
  permission: "infrastructure.stack.plan",
  risk: "medium",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export interface DeploymentStackScope {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

export interface DeploymentStackReader {
  findByScope(
    scope: DeploymentStackScope,
    stackId: DeploymentStackId,
  ): Promise<DeploymentStack | undefined>;
}

export interface InfrastructurePlanIdGenerator {
  next(): InfrastructurePlanId;
}

export interface InfrastructurePlanPolicyDecision {
  readonly decision: "allow" | "deny";
  readonly policyVersion: string;
  readonly reasons: readonly string[];
}

export interface InfrastructurePlanPolicyInput {
  readonly stack: DeploymentStack;
  readonly engine: InfrastructureEngineDescriptor;
  readonly resourceChanges: readonly InfrastructureResourceChange[];
}

export interface InfrastructurePlanPolicy {
  evaluate(
    input: InfrastructurePlanPolicyInput,
  ): Promise<InfrastructurePlanPolicyDecision>;
}

export interface InfrastructureChangeSummary {
  readonly create: number;
  readonly update: number;
  readonly delete: number;
  readonly replace: number;
  readonly read: number;
}

export interface InfrastructurePlanRecord extends DeploymentStackScope {
  readonly planId: InfrastructurePlanId;
  readonly requestId: string;
  readonly subjectId: string;
  readonly stackId: DeploymentStackId;
  readonly connectionId: CloudConnectionId;
  readonly providerId: CloudProviderId;
  readonly engine: InfrastructureEngineDescriptor;
  readonly module: InfrastructureModuleSelection;
  readonly topology: ImmutableArtifactSelection;
  readonly createdAt: UtcInstant;
  readonly jsonFormatVersion: string;
  readonly artifact: InfrastructurePlanArtifact;
  readonly stateLock: InfrastructureStateLockEvidence;
  readonly changes: InfrastructureChangeSummary;
  readonly policy: InfrastructurePlanPolicyDecision;
  readonly status: "policy-approved" | "policy-rejected";
  readonly approval: "not-requested";
}

export type InfrastructurePlanInsertResult = "already-exists" | "inserted";

export interface InfrastructurePlanRepository {
  findByRequest(
    scope: DeploymentStackScope,
    requestId: string,
  ): Promise<InfrastructurePlanRecord | undefined>;
  insert(
    record: InfrastructurePlanRecord,
  ): Promise<InfrastructurePlanInsertResult>;
}

type LocalPlanFailureCode =
  | "command-expired"
  | "concurrent-modification"
  | "deployment-stack-not-found"
  | "idempotency-conflict"
  | "infrastructure-engine-contract-violation"
  | "infrastructure-engine-not-registered"
  | "invalid-input"
  | "permission-denied";

export type PlanDeploymentStackResult =
  | Readonly<{
      ok: true;
      replayed: boolean;
      value: InfrastructurePlanRecord;
    }>
  | Readonly<{
      ok: false;
      failure:
        | InfrastructureEngineFailure
        | Readonly<{ code: LocalPlanFailureCode; retryable: false }>;
    }>;

interface DecodedPlanContext extends DeploymentStackScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
  readonly requestId: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

interface DecodedPlanInput {
  readonly stackId: DeploymentStackId;
  readonly engine: InfrastructureEngineKind;
  readonly module: InfrastructureModuleSelection;
  readonly topology: ImmutableArtifactSelection;
}

class InfrastructurePlanInputError extends Error {}

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const moduleReferencePattern =
  /^module:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]{2,500}$/;
const topologyReferencePattern =
  /^topology:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]{2,498}$/;
const artifactDigestPattern = /^sha256:[0-9a-f]{64}$/;
const moduleVersionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const planArtifactReferencePattern =
  /^plan-artifact:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]{2,495}$/;
const jsonFormatVersionPattern = /^[0-9]+\.[0-9]+$/;
const changeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._"/\x5B\x5D-]{0,511}$/;

function isExactValue<T extends string>(
  value: unknown,
  expected: T,
): value is T {
  return value === expected;
}

function isPolicyDecision(value: unknown): value is "allow" | "deny" {
  return value === "allow" || value === "deny";
}

function localFailure(code: LocalPlanFailureCode): PlanDeploymentStackResult {
  return { ok: false, failure: { code, retryable: false } };
}

function requireRecord(input: unknown, name: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InfrastructurePlanInputError(`${name} must be an object`);
  }
  return input as Record<string, unknown>;
}

function requireString(input: unknown, name: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new InfrastructurePlanInputError(`${name} must be a string`);
  }
  return input;
}

function decodeContext(input: unknown): DecodedPlanContext {
  const record = requireRecord(input, "plan command context");
  const permissions = record.permissions;
  const requestId = requireString(record.idempotencyKey, "idempotencyKey");
  if (
    !Array.isArray(permissions) ||
    permissions.some((permission) => typeof permission !== "string") ||
    !requestIdPattern.test(requestId)
  ) {
    throw new InfrastructurePlanInputError(
      "permissions and idempotencyKey must be valid",
    );
  }
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
    subjectId: requireString(record.subjectId, "subjectId"),
    permissions: new Set(permissions),
    requestId,
    issuedAt: parseUtcInstant(record.issuedAt),
    expiresAt: parseUtcInstant(record.expiresAt),
  };
}

function decodeArtifact(
  input: unknown,
  kind: "module" | "topology",
): ImmutableArtifactSelection {
  const record = requireRecord(input, `${kind} selection`);
  const reference = requireString(record.reference, `${kind}.reference`);
  const digest = requireString(record.digest, `${kind}.digest`);
  const referencePattern =
    kind === "module" ? moduleReferencePattern : topologyReferencePattern;
  if (
    !referencePattern.test(reference) ||
    !artifactDigestPattern.test(digest)
  ) {
    throw new InfrastructurePlanInputError(`${kind} selection is invalid`);
  }
  return { reference, digest };
}

function decodeInput(input: unknown): DecodedPlanInput {
  const record = requireRecord(input, "plan input");
  if (record.engine !== "opentofu" && record.engine !== "terraform") {
    throw new InfrastructurePlanInputError("engine must be supported");
  }
  const module = requireRecord(record.module, "module selection");
  const artifact = decodeArtifact(module, "module");
  const version = requireString(module.version, "module.version");
  if (!moduleVersionPattern.test(version)) {
    throw new InfrastructurePlanInputError("module version is invalid");
  }
  return {
    stackId: parseDeploymentStackId(record.stackId),
    engine: record.engine,
    module: { ...artifact, version },
    topology: decodeArtifact(record.topology, "topology"),
  };
}

function sameRequest(
  record: InfrastructurePlanRecord,
  input: DecodedPlanInput,
  subjectId: string,
): boolean {
  return (
    record.subjectId === subjectId &&
    record.stackId === input.stackId &&
    record.engine.kind === input.engine &&
    record.module.reference === input.module.reference &&
    record.module.version === input.module.version &&
    record.module.digest === input.module.digest &&
    record.topology.reference === input.topology.reference &&
    record.topology.digest === input.topology.digest
  );
}

function classifyChanges(
  changes: readonly InfrastructureResourceChange[],
): InfrastructureChangeSummary | undefined {
  const addresses = new Set<string>();
  const summary = { create: 0, update: 0, delete: 0, replace: 0, read: 0 };
  for (const change of changes) {
    if (
      addresses.has(change.address) ||
      !changeIdentifierPattern.test(change.address) ||
      !changeIdentifierPattern.test(change.providerResourceType)
    ) {
      return undefined;
    }
    addresses.add(change.address);
    const actions = change.actions.join(",");
    if (actions === "create") summary.create += 1;
    else if (actions === "update") summary.update += 1;
    else if (actions === "delete") summary.delete += 1;
    else if (actions === "read") summary.read += 1;
    else if (actions === "no-op") continue;
    else if (actions === "delete,create" || actions === "create,delete") {
      summary.replace += 1;
    } else return undefined;
  }
  return Object.freeze(summary);
}

function normalizeEngineValue(
  value: InfrastructureEnginePlanValue,
  planId: InfrastructurePlanId,
  stack: DeploymentStack,
):
  | Readonly<{
      artifact: InfrastructurePlanArtifact;
      changes: InfrastructureChangeSummary;
      jsonFormatVersion: string;
      resourceChanges: readonly InfrastructureResourceChange[];
      stateLock: InfrastructureStateLockEvidence;
    }>
  | undefined {
  const changes = classifyChanges(value.resourceChanges);
  if (
    value.planId !== planId ||
    value.stackId !== stack.id ||
    value.stateKey !== stack.state.key ||
    value.stateLock.stateKey !== stack.state.key ||
    !isExactValue(value.stateLock.outcome, "acquired-and-released") ||
    !isExactValue(value.artifact.protection, "encrypted") ||
    !isExactValue(value.artifact.sensitivity, "contains-sensitive-values") ||
    !planArtifactReferencePattern.test(value.artifact.reference) ||
    !artifactDigestPattern.test(value.artifact.digest) ||
    !jsonFormatVersionPattern.test(value.jsonFormatVersion) ||
    changes === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    artifact: Object.freeze({ ...value.artifact }),
    changes,
    jsonFormatVersion: value.jsonFormatVersion,
    resourceChanges: Object.freeze([...value.resourceChanges]),
    stateLock: Object.freeze({ ...value.stateLock }),
  });
}

function normalizePolicy(
  decision: InfrastructurePlanPolicyDecision,
): InfrastructurePlanPolicyDecision | undefined {
  if (
    !isPolicyDecision(decision.decision) ||
    decision.policyVersion.trim().length === 0 ||
    decision.reasons.some(
      (reason) => typeof reason !== "string" || reason.trim().length === 0,
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    decision: decision.decision,
    policyVersion: decision.policyVersion,
    reasons: Object.freeze([...decision.reasons]),
  });
}

export class PlanDeploymentStack {
  readonly #stacks: DeploymentStackReader;
  readonly #plans: InfrastructurePlanRepository;
  readonly #engines: InfrastructureEngineRegistry;
  readonly #policy: InfrastructurePlanPolicy;
  readonly #planIds: InfrastructurePlanIdGenerator;
  readonly #clock: ApplicationClock;

  constructor(dependencies: {
    readonly stacks: DeploymentStackReader;
    readonly plans: InfrastructurePlanRepository;
    readonly engines: InfrastructureEngineRegistry;
    readonly policy: InfrastructurePlanPolicy;
    readonly planIds: InfrastructurePlanIdGenerator;
    readonly clock: ApplicationClock;
  }) {
    this.#stacks = dependencies.stacks;
    this.#plans = dependencies.plans;
    this.#engines = dependencies.engines;
    this.#policy = dependencies.policy;
    this.#planIds = dependencies.planIds;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
    signal?: AbortSignal,
  ): Promise<PlanDeploymentStackResult> {
    let context: DecodedPlanContext;
    let input: DecodedPlanInput;
    try {
      context = decodeContext(rawContext);
      input = decodeInput(rawInput);
    } catch (error: unknown) {
      if (
        error instanceof InvalidDeploymentStackError ||
        error instanceof InvalidDomainValueError ||
        error instanceof InfrastructurePlanInputError
      ) {
        return localFailure("invalid-input");
      }
      throw error;
    }

    if (!context.permissions.has(PLAN_DEPLOYMENT_STACK_COMMAND.permission)) {
      return localFailure("permission-denied");
    }
    const now = this.#clock.now();
    if (context.expiresAt <= context.issuedAt || context.issuedAt > now) {
      return localFailure("invalid-input");
    }
    if (now >= context.expiresAt) {
      return localFailure("command-expired");
    }

    const existing = await this.#plans.findByRequest(
      context,
      context.requestId,
    );
    if (existing !== undefined) {
      return sameRequest(existing, input, context.subjectId)
        ? { ok: true, replayed: true, value: existing }
        : localFailure("idempotency-conflict");
    }

    const stack = await this.#stacks.findByScope(context, input.stackId);
    if (
      stack === undefined ||
      stack.tenantId !== context.tenantId ||
      stack.projectId !== context.projectId ||
      stack.id !== input.stackId
    ) {
      return localFailure("deployment-stack-not-found");
    }

    const engine = this.#engines.find(input.engine);
    if (engine === undefined) {
      return localFailure("infrastructure-engine-not-registered");
    }
    const planId = this.#planIds.next();
    const engineResult = await engine.plan({
      planId,
      stack,
      module: input.module,
      topology: input.topology,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!engineResult.ok) return engineResult;

    const normalized = normalizeEngineValue(engineResult.value, planId, stack);
    if (normalized === undefined) {
      return localFailure("infrastructure-engine-contract-violation");
    }
    const policy = normalizePolicy(
      await this.#policy.evaluate({
        stack,
        engine: engine.descriptor,
        resourceChanges: normalized.resourceChanges,
      }),
    );
    if (policy === undefined) {
      return localFailure("infrastructure-engine-contract-violation");
    }

    const record: InfrastructurePlanRecord = Object.freeze({
      planId,
      requestId: context.requestId,
      subjectId: context.subjectId,
      tenantId: context.tenantId,
      projectId: context.projectId,
      stackId: stack.id,
      connectionId: stack.connectionId,
      providerId: stack.providerId,
      engine: Object.freeze({ ...engine.descriptor }),
      module: Object.freeze({ ...input.module }),
      topology: Object.freeze({ ...input.topology }),
      createdAt: now,
      jsonFormatVersion: normalized.jsonFormatVersion,
      artifact: normalized.artifact,
      stateLock: normalized.stateLock,
      changes: normalized.changes,
      policy,
      status:
        policy.decision === "allow" ? "policy-approved" : "policy-rejected",
      approval: "not-requested",
    });

    const insert = await this.#plans.insert(record);
    if (insert === "inserted") {
      return { ok: true, replayed: false, value: record };
    }
    const raced = await this.#plans.findByRequest(context, context.requestId);
    if (raced !== undefined && sameRequest(raced, input, context.subjectId)) {
      return { ok: true, replayed: true, value: raced };
    }
    return localFailure("concurrent-modification");
  }
}
