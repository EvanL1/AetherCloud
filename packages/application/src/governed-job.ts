import {
  GovernedJobTransitionError,
  InvalidDomainValueError,
  confirmGovernedJob,
  createGovernedJob,
  expireGovernedJob,
  markGovernedJobUnknown,
  offerGovernedJob,
  parseContentDigest,
  parseEdgeCapabilityId,
  parseGatewayId,
  parseGovernedJobId,
  parseJobReceiptId,
  parseJobReceiptSequence,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  queueGovernedJob,
  recordGovernedJobReceipt,
  requestGovernedJobCancellation,
} from "@aether-cloud/domain";
import type {
  GovernedJob,
  GovernedJobReceipt,
  JobConfirmation,
  JobReplaySafety,
  JobRisk,
  UtcInstant,
} from "@aether-cloud/domain";

import {
  CANCEL_GOVERNED_JOB_COMMAND,
  CONFIRM_GOVERNED_JOB_COMMAND,
  CREATE_GOVERNED_JOB_COMMAND,
  EXPIRE_GOVERNED_JOB_COMMAND,
  GET_GOVERNED_JOB_QUERY,
  INGEST_GOVERNED_JOB_RECEIPT_COMMAND,
  MARK_GOVERNED_JOB_UNKNOWN_COMMAND,
  OFFER_GOVERNED_JOB_COMMAND,
  QUEUE_GOVERNED_JOB_COMMAND,
} from "./capability-definition.js";
import type {
  GatewayCredentialAssertion,
  GatewayCredentialVerifier,
} from "./cloudlink-session-repository.js";
import type {
  EdgeCapabilityCatalog,
  EdgeCapabilityDeclaration,
  GovernedJobRepository,
  GovernedJobScope,
} from "./governed-job-repository.js";

type GovernedJobFailureCode =
  | "command-expired"
  | "confirmation-required"
  | "gateway-credential-inactive"
  | "invalid-gateway-credential"
  | "invalid-input"
  | "job-already-exists"
  | "job-capability-denied"
  | "job-idempotency-conflict"
  | "job-not-found"
  | "job-receipt-conflict"
  | "job-receipt-invalid"
  | "job-storage-unavailable"
  | "job-transition-invalid"
  | "job-version-conflict"
  | "permission-denied";

export interface GovernedJobApplicationFailure {
  readonly code: GovernedJobFailureCode;
  readonly message: string;
}

export type GovernedJobApplicationResult<Value> =
  | Readonly<{ ok: true; replayed: boolean; value: Value }>
  | Readonly<{ ok: false; failure: GovernedJobApplicationFailure }>;

export type GovernedJobQueryResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: GovernedJobApplicationFailure }>;

export interface GovernedJobReceiptView {
  readonly receiptId: string;
  readonly sequence: string;
  readonly kind: string;
  readonly observedAt: string;
  readonly payloadDigest: string;
  readonly evidenceDigest?: string;
}

export interface GovernedJobView {
  readonly jobId: string;
  readonly gatewayId: string;
  readonly capabilityId: string;
  readonly capabilityPermission: string;
  readonly risk: JobRisk;
  readonly confirmation: JobConfirmation;
  readonly replaySafety: JobReplaySafety;
  readonly physicalEffect: boolean;
  readonly state: GovernedJob["state"];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly confirmedBy: string | null;
  readonly confirmedAt: string | null;
  readonly lastContiguousSequence: string;
  readonly receipts: readonly GovernedJobReceiptView[];
  readonly revision: number;
}

export interface GovernedJobApplicationClock {
  now(): string;
}

interface TenantCommandContext extends GovernedJobScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
  readonly confirmation: "confirmed" | "not-confirmed";
  readonly requestId: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

interface TenantQueryContext extends GovernedJobScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
}

interface GatewayCommandContext {
  readonly credential: GatewayCredentialAssertion;
  readonly requestId: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

class GovernedJobInputError extends Error {}

function failure(
  code: GovernedJobFailureCode,
  message: string,
): Readonly<{ ok: false; failure: GovernedJobApplicationFailure }> {
  return { ok: false, failure: { code, message } };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function requireRecord(input: unknown, name: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new GovernedJobInputError(`${name} must be an object`);
  }
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
    throw new GovernedJobInputError(
      `${name} must contain exactly: ${canonical.join(", ")}`,
    );
  }
}

function requireAllowedKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new GovernedJobInputError(`${name} fields are invalid`);
  }
}

function requireString(input: unknown, name: string, maximum = 128): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > maximum
  ) {
    throw new GovernedJobInputError(
      `${name} must be a non-empty bounded string`,
    );
  }
  return input;
}

function requireRequestId(input: unknown): string {
  const requestId = requireString(input, "idempotencyKey");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(requestId)) {
    throw new GovernedJobInputError("idempotencyKey is invalid");
  }
  return requestId;
}

function decodePermissions(input: unknown): ReadonlySet<string> {
  if (
    !Array.isArray(input) ||
    input.some((permission) => typeof permission !== "string")
  ) {
    throw new GovernedJobInputError("permissions must be an array of strings");
  }
  return new Set(input);
}

function decodeScope(record: Record<string, unknown>): GovernedJobScope {
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
  };
}

function decodeTenantCommandContext(input: unknown): TenantCommandContext {
  const record = requireRecord(input, "Job command context");
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
    "Job command context",
  );
  if (
    record.confirmation !== "confirmed" &&
    record.confirmation !== "not-confirmed"
  ) {
    throw new GovernedJobInputError("confirmation is invalid");
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
  const record = requireRecord(input, "Job query context");
  requireExactKeys(
    record,
    ["permissions", "projectId", "subjectId", "tenantId"],
    "Job query context",
  );
  return {
    ...decodeScope(record),
    subjectId: requireString(record.subjectId, "subjectId"),
    permissions: decodePermissions(record.permissions),
  };
}

function decodeGatewayCommandContext(input: unknown): GatewayCommandContext {
  const record = requireRecord(input, "Job Receipt context");
  requireExactKeys(
    record,
    ["credentialId", "expiresAt", "idempotencyKey", "issuedAt", "proof"],
    "Job Receipt context",
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

function decodeCreateInput(input: unknown) {
  const record = requireRecord(input, "create Job input");
  requireExactKeys(
    record,
    [
      "argumentsDigest",
      "capabilityId",
      "gatewayId",
      "jobExpiresAt",
      "jobId",
      "preconditionDigest",
    ],
    "create Job input",
  );
  return {
    jobId: parseGovernedJobId(record.jobId),
    gatewayId: parseGatewayId(record.gatewayId),
    capabilityId: parseEdgeCapabilityId(record.capabilityId),
    argumentsDigest: parseContentDigest(record.argumentsDigest),
    preconditionDigest: parseContentDigest(record.preconditionDigest),
    jobExpiresAt: parseUtcInstant(record.jobExpiresAt),
  };
}

function decodeJobIdentity(input: unknown) {
  const record = requireRecord(input, "Job identity");
  requireExactKeys(record, ["jobId"], "Job identity");
  return parseGovernedJobId(record.jobId);
}

type GovernedJobControlAction =
  | "cancel"
  | "expire"
  | "mark-unknown"
  | "offer"
  | "queue";

function decodeControlInput(input: unknown): Readonly<{
  jobId: ReturnType<typeof parseGovernedJobId>;
  action: GovernedJobControlAction;
}> {
  const record = requireRecord(input, "Job control input");
  requireExactKeys(record, ["action", "jobId"], "Job control input");
  if (
    record.action !== "cancel" &&
    record.action !== "expire" &&
    record.action !== "mark-unknown" &&
    record.action !== "offer" &&
    record.action !== "queue"
  ) {
    throw new GovernedJobInputError("Job control action is unsupported");
  }
  return {
    jobId: parseGovernedJobId(record.jobId),
    action: record.action,
  };
}

function decodeReceiptInput(input: unknown): Readonly<{
  jobId: ReturnType<typeof parseGovernedJobId>;
  receipt: GovernedJobReceipt;
}> {
  const record = requireRecord(input, "Job Receipt input");
  requireAllowedKeys(
    record,
    ["jobId", "kind", "observedAt", "payloadDigest", "receiptId", "sequence"],
    ["evidenceDigest"],
    "Job Receipt input",
  );
  const kind = record.kind;
  if (
    kind !== "accepted" &&
    kind !== "canceled" &&
    kind !== "expired" &&
    kind !== "failed" &&
    kind !== "partial" &&
    kind !== "rejected" &&
    kind !== "running" &&
    kind !== "succeeded"
  ) {
    throw new GovernedJobInputError("Job Receipt kind is unsupported");
  }
  return {
    jobId: parseGovernedJobId(record.jobId),
    receipt: {
      receiptId: parseJobReceiptId(record.receiptId),
      sequence: parseJobReceiptSequence(record.sequence),
      kind,
      observedAt: parseUtcInstant(record.observedAt),
      payloadDigest: parseContentDigest(record.payloadDigest),
      ...(record.evidenceDigest === undefined
        ? {}
        : { evidenceDigest: parseContentDigest(record.evidenceDigest) }),
    },
  };
}

function decodeCapabilityDescriptor(
  descriptor: EdgeCapabilityDeclaration,
  requestedCapabilityId: string,
): Readonly<{
  capabilityId: ReturnType<typeof parseEdgeCapabilityId>;
  permission: string;
  risk: JobRisk;
  confirmation: JobConfirmation;
  replaySafety: JobReplaySafety;
  physicalEffect: boolean;
}> {
  const capabilityId = parseEdgeCapabilityId(descriptor.capabilityId);
  if (capabilityId !== requestedCapabilityId) {
    throw new GovernedJobInputError(
      "Capability catalog returned a mismatched capability",
    );
  }
  const permission = requireString(
    descriptor.permission,
    "capability permission",
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(permission)) {
    throw new GovernedJobInputError("capability permission is invalid");
  }
  if (typeof descriptor.physicalEffect !== "boolean") {
    throw new GovernedJobInputError("Capability physicalEffect is invalid");
  }
  if (
    descriptor.physicalEffect &&
    (descriptor.confirmation !== "explicit" ||
      (descriptor.risk !== "high" && descriptor.risk !== "critical"))
  ) {
    throw new GovernedJobInputError(
      "A physical-effect capability must be high or critical risk and require explicit confirmation",
    );
  }
  return {
    capabilityId,
    permission,
    risk: descriptor.risk,
    confirmation: descriptor.confirmation,
    replaySafety: descriptor.replaySafety,
    physicalEffect: descriptor.physicalEffect,
  };
}

function decodeSafely<Value>(
  decoder: () => Value,
):
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: GovernedJobApplicationFailure }> {
  try {
    return { ok: true, value: decoder() };
  } catch (error: unknown) {
    if (
      error instanceof GovernedJobInputError ||
      error instanceof InvalidDomainValueError
    ) {
      return failure("invalid-input", error.message);
    }
    throw error;
  }
}

function authorize(
  permissions: ReadonlySet<string>,
  permission: string,
): GovernedJobApplicationFailure | undefined {
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
): GovernedJobApplicationFailure | undefined {
  if (context.expiresAt <= context.issuedAt || context.issuedAt > now) {
    return { code: "invalid-input", message: "command time window is invalid" };
  }
  return now >= context.expiresAt
    ? { code: "command-expired", message: "command has expired" }
    : undefined;
}

function toReceiptView(receipt: GovernedJobReceipt): GovernedJobReceiptView {
  return Object.freeze({
    receiptId: receipt.receiptId,
    sequence: receipt.sequence,
    kind: receipt.kind,
    observedAt: receipt.observedAt,
    payloadDigest: receipt.payloadDigest,
    ...(receipt.evidenceDigest === undefined
      ? {}
      : { evidenceDigest: receipt.evidenceDigest }),
  });
}

function toView(job: GovernedJob): GovernedJobView {
  return Object.freeze({
    jobId: job.jobId,
    gatewayId: job.gatewayId,
    capabilityId: job.capabilityId,
    capabilityPermission: job.capabilityPermission,
    risk: job.risk,
    confirmation: job.confirmation,
    replaySafety: job.replaySafety,
    physicalEffect: job.physicalEffect,
    state: job.state,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    confirmedBy: job.confirmedBy ?? null,
    confirmedAt: job.confirmedAt ?? null,
    lastContiguousSequence: job.lastContiguousSequence,
    receipts: Object.freeze(job.receipts.map(toReceiptView)),
    revision: job.revision,
  });
}

function mapInsertFailure(
  outcome: "already-exists" | "idempotency-conflict" | "storage-unavailable",
) {
  const codes = {
    "already-exists": "job-already-exists",
    "idempotency-conflict": "job-idempotency-conflict",
    "storage-unavailable": "job-storage-unavailable",
  } as const;
  return failure(codes[outcome], "Job creation was rejected");
}

function mapReplaceFailure(
  outcome:
    | "idempotency-conflict"
    | "not-found"
    | "storage-unavailable"
    | "version-conflict",
) {
  const codes = {
    "idempotency-conflict": "job-idempotency-conflict",
    "not-found": "job-not-found",
    "storage-unavailable": "job-storage-unavailable",
    "version-conflict": "job-version-conflict",
  } as const;
  return failure(codes[outcome], "Job update was rejected");
}

function transitionSafely(
  transition: () => GovernedJob,
):
  | Readonly<{ ok: true; value: GovernedJob }>
  | Readonly<{ ok: false; failure: GovernedJobApplicationFailure }> {
  try {
    return { ok: true, value: transition() };
  } catch (error: unknown) {
    if (error instanceof GovernedJobTransitionError) {
      return failure("job-transition-invalid", error.message);
    }
    if (error instanceof InvalidDomainValueError) {
      return failure("invalid-input", error.message);
    }
    throw error;
  }
}

export class CreateGovernedJob {
  static readonly capability = CREATE_GOVERNED_JOB_COMMAND;
  readonly #repository: GovernedJobRepository;
  readonly #capabilities: EdgeCapabilityCatalog;
  readonly #clock: GovernedJobApplicationClock;

  constructor(dependencies: {
    readonly repository: GovernedJobRepository;
    readonly capabilities: EdgeCapabilityCatalog;
    readonly clock: GovernedJobApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#capabilities = dependencies.capabilities;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<GovernedJobApplicationResult<GovernedJobView>> {
    const decodedContext = decodeSafely(() =>
      decodeTenantCommandContext(rawContext),
    );
    if (!decodedContext.ok) return decodedContext;
    const context = decodedContext.value;
    const platformAuthorization = authorize(
      context.permissions,
      CreateGovernedJob.capability.permission,
    );
    if (platformAuthorization !== undefined) {
      return { ok: false, failure: platformAuthorization };
    }
    const decodedNow = decodeSafely(() => parseUtcInstant(this.#clock.now()));
    if (!decodedNow.ok) return decodedNow;
    const timeFailure = validateTime(context, decodedNow.value);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    const decodedInput = decodeSafely(() => decodeCreateInput(rawInput));
    if (!decodedInput.ok) return decodedInput;
    const input = decodedInput.value;
    if (
      input.jobExpiresAt <= decodedNow.value ||
      input.jobExpiresAt > context.expiresAt
    ) {
      return failure(
        "invalid-input",
        "Job expiry must be in the future and within the creation command window",
      );
    }
    const declared = await this.#capabilities.find(
      context,
      input.gatewayId,
      input.capabilityId,
    );
    if (declared === undefined) {
      return failure(
        "job-capability-denied",
        "Capability is not declared for the target Gateway",
      );
    }
    const decodedCapability = decodeSafely(() =>
      decodeCapabilityDescriptor(declared, input.capabilityId),
    );
    if (!decodedCapability.ok) {
      return failure(
        "job-capability-denied",
        decodedCapability.failure.message,
      );
    }
    const descriptor = decodedCapability.value;
    const capabilityAuthorization = authorize(
      context.permissions,
      descriptor.permission,
    );
    if (capabilityAuthorization !== undefined) {
      return { ok: false, failure: capabilityAuthorization };
    }
    const job = createGovernedJob({
      jobId: input.jobId,
      gatewayId: input.gatewayId,
      capabilityId: descriptor.capabilityId,
      capabilityPermission: descriptor.permission,
      risk: descriptor.risk,
      confirmation: descriptor.confirmation,
      replaySafety: descriptor.replaySafety,
      physicalEffect: descriptor.physicalEffect,
      argumentsDigest: input.argumentsDigest,
      preconditionDigest: input.preconditionDigest,
      createdAt: decodedNow.value,
      expiresAt: input.jobExpiresAt,
    });
    const persisted = await this.#repository.insert({
      tenantId: context.tenantId,
      projectId: context.projectId,
      requestId: context.requestId,
      subjectId: context.subjectId,
      job,
    });
    if (persisted.outcome === "inserted" || persisted.outcome === "replayed") {
      return {
        ok: true,
        replayed: persisted.outcome === "replayed",
        value: toView(persisted.job),
      };
    }
    return mapInsertFailure(persisted.outcome);
  }
}

export class ConfirmGovernedJob {
  static readonly capability = CONFIRM_GOVERNED_JOB_COMMAND;
  readonly #repository: GovernedJobRepository;
  readonly #clock: GovernedJobApplicationClock;

  constructor(dependencies: {
    readonly repository: GovernedJobRepository;
    readonly clock: GovernedJobApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<GovernedJobApplicationResult<GovernedJobView>> {
    const decodedContext = decodeSafely(() =>
      decodeTenantCommandContext(rawContext),
    );
    if (!decodedContext.ok) return decodedContext;
    const context = decodedContext.value;
    const authorization = authorize(
      context.permissions,
      ConfirmGovernedJob.capability.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    if (context.confirmation !== "confirmed") {
      return failure("confirmation-required", "Job confirmation is explicit");
    }
    const decodedNow = decodeSafely(() => parseUtcInstant(this.#clock.now()));
    if (!decodedNow.ok) return decodedNow;
    const timeFailure = validateTime(context, decodedNow.value);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    const decodedJobId = decodeSafely(() => decodeJobIdentity(rawInput));
    if (!decodedJobId.ok) return decodedJobId;
    const current = await this.#repository.find(context, decodedJobId.value);
    if (current === undefined)
      return failure("job-not-found", "Job was not found");
    const transitioned = transitionSafely(() =>
      confirmGovernedJob(current, context.subjectId, decodedNow.value),
    );
    if (!transitioned.ok) return transitioned;
    return this.#persist(
      context,
      current,
      transitioned.value,
      "edge.job-controlled.v1",
    );
  }

  async #persist(
    context: TenantCommandContext,
    current: GovernedJob,
    next: GovernedJob,
    eventName: Parameters<GovernedJobRepository["replace"]>[0]["eventName"],
  ): Promise<GovernedJobApplicationResult<GovernedJobView>> {
    const persisted = await this.#repository.replace({
      tenantId: context.tenantId,
      projectId: context.projectId,
      requestId: context.requestId,
      subjectId: context.subjectId,
      expectedRevision: current.revision,
      job: next,
      eventName,
    });
    if (persisted.outcome === "replaced" || persisted.outcome === "replayed") {
      return {
        ok: true,
        replayed: persisted.outcome === "replayed",
        value: toView(persisted.job),
      };
    }
    return mapReplaceFailure(persisted.outcome);
  }
}

const controlDefinitions = {
  cancel: CANCEL_GOVERNED_JOB_COMMAND,
  expire: EXPIRE_GOVERNED_JOB_COMMAND,
  "mark-unknown": MARK_GOVERNED_JOB_UNKNOWN_COMMAND,
  offer: OFFER_GOVERNED_JOB_COMMAND,
  queue: QUEUE_GOVERNED_JOB_COMMAND,
} as const;

export class ControlGovernedJob {
  readonly #repository: GovernedJobRepository;
  readonly #clock: GovernedJobApplicationClock;

  constructor(dependencies: {
    readonly repository: GovernedJobRepository;
    readonly clock: GovernedJobApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<GovernedJobApplicationResult<GovernedJobView>> {
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
    const decodedNow = decodeSafely(() => parseUtcInstant(this.#clock.now()));
    if (!decodedNow.ok) return decodedNow;
    const timeFailure = validateTime(context, decodedNow.value);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    const current = await this.#repository.find(context, input.jobId);
    if (current === undefined)
      return failure("job-not-found", "Job was not found");
    const transitioned = transitionSafely(() => {
      if (input.action === "queue") {
        return queueGovernedJob(current, decodedNow.value);
      }
      if (input.action === "offer") {
        return offerGovernedJob(current, decodedNow.value);
      }
      if (input.action === "mark-unknown") {
        return markGovernedJobUnknown(current, decodedNow.value);
      }
      if (input.action === "cancel") {
        return requestGovernedJobCancellation(current, decodedNow.value);
      }
      return expireGovernedJob(current, decodedNow.value);
    });
    if (!transitioned.ok) return transitioned;
    const persisted = await this.#repository.replace({
      tenantId: context.tenantId,
      projectId: context.projectId,
      requestId: context.requestId,
      subjectId: context.subjectId,
      expectedRevision: current.revision,
      job: transitioned.value,
      eventName: "edge.job-controlled.v1",
    });
    if (persisted.outcome === "replaced" || persisted.outcome === "replayed") {
      return {
        ok: true,
        replayed: persisted.outcome === "replayed",
        value: toView(persisted.job),
      };
    }
    return mapReplaceFailure(persisted.outcome);
  }
}

export class IngestGovernedJobReceipt {
  static readonly capability = INGEST_GOVERNED_JOB_RECEIPT_COMMAND;
  readonly #repository: GovernedJobRepository;
  readonly #credentialVerifier: GatewayCredentialVerifier;
  readonly #clock: GovernedJobApplicationClock;

  constructor(dependencies: {
    readonly repository: GovernedJobRepository;
    readonly credentialVerifier: GatewayCredentialVerifier;
    readonly clock: GovernedJobApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#credentialVerifier = dependencies.credentialVerifier;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<GovernedJobApplicationResult<GovernedJobView>> {
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
    const decodedInput = decodeSafely(() => decodeReceiptInput(rawInput));
    if (!decodedInput.ok) return decodedInput;
    const current = await this.#repository.find(
      verified.value,
      decodedInput.value.jobId,
    );
    if (
      current === undefined ||
      current.gatewayId !== verified.value.gatewayId
    ) {
      return failure("job-not-found", "Job was not found");
    }
    const recorded = recordGovernedJobReceipt(
      current,
      decodedInput.value.receipt,
    );
    if (!recorded.ok) {
      return failure(recorded.failure.code, recorded.failure.message);
    }
    if (recorded.replayed) {
      return { ok: true, replayed: true, value: toView(recorded.job) };
    }
    const persisted = await this.#repository.replace({
      tenantId: verified.value.tenantId,
      projectId: verified.value.projectId,
      requestId: context.requestId,
      subjectId: `gateway:${verified.value.gatewayId}`,
      expectedRevision: current.revision,
      job: recorded.job,
      eventName: "edge.job-receipt-ingested.v1",
    });
    if (persisted.outcome === "replaced" || persisted.outcome === "replayed") {
      return {
        ok: true,
        replayed: persisted.outcome === "replayed",
        value: toView(persisted.job),
      };
    }
    return mapReplaceFailure(persisted.outcome);
  }
}

export class GetGovernedJob {
  static readonly capability = GET_GOVERNED_JOB_QUERY;
  readonly #repository: GovernedJobRepository;

  constructor(dependencies: { readonly repository: GovernedJobRepository }) {
    this.#repository = dependencies.repository;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<GovernedJobQueryResult<GovernedJobView>> {
    const decodedContext = decodeSafely(() =>
      decodeTenantQueryContext(rawContext),
    );
    if (!decodedContext.ok) return decodedContext;
    const authorization = authorize(
      decodedContext.value.permissions,
      GetGovernedJob.capability.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    const decodedJobId = decodeSafely(() => decodeJobIdentity(rawInput));
    if (!decodedJobId.ok) return decodedJobId;
    const job = await this.#repository.find(
      decodedContext.value,
      decodedJobId.value,
    );
    return job === undefined
      ? failure("job-not-found", "Job was not found")
      : { ok: true, value: toView(job) };
  }
}
