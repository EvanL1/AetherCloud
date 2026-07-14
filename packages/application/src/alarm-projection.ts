import {
  InvalidDomainValueError,
  defineAlarmFact,
  parseAlarmFactId,
  parseAlarmGeneration,
  parseAlarmOccurrenceId,
  parseAlarmRuleId,
  parseAlarmSequence,
  parseEdgeInstanceId,
  parseEdgePointId,
  parseProjectId,
  parseSourceTimestampMs,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";
import type {
  AlarmFactKind,
  AlarmOccurrenceId,
  AlarmSeverity,
  GatewayCredentialBinding,
  UtcInstant,
} from "@aether-cloud/domain";

import {
  ACKNOWLEDGE_ALARM_COMMAND,
  GET_ALARM_PROJECTION_QUERY,
  INGEST_ALARM_FACT_COMMAND,
} from "./capability-definition.js";
import type {
  AlarmProjectionRecord,
  AlarmRepository,
  AlarmScope,
} from "./alarm-repository.js";
import type {
  GatewayCredentialAssertion,
  GatewayCredentialVerifier,
} from "./cloudlink-session-repository.js";
import type { ApplicationClock } from "./gateway-identity-repository.js";
import type { AlarmFactDigestor } from "./alarm-repository.js";

type AlarmFailureCode =
  | "alarm-fact-conflict"
  | "alarm-not-found"
  | "alarm-sequence-conflict"
  | "alarm-storage-unavailable"
  | "command-expired"
  | "concurrent-modification"
  | "gateway-credential-inactive"
  | "idempotency-conflict"
  | "invalid-gateway-credential"
  | "invalid-input"
  | "invalid-alarm-repository-result"
  | "permission-denied";

export interface AlarmApplicationFailure {
  readonly code: AlarmFailureCode;
  readonly message: string;
}

export type AlarmApplicationResult<Value> =
  | Readonly<{ ok: true; replayed: boolean; value: Value }>
  | Readonly<{ ok: false; failure: AlarmApplicationFailure }>;

export type AlarmQueryResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: AlarmApplicationFailure }>;

export interface AlarmProjectionView {
  readonly tenantId: AlarmProjectionRecord["tenantId"];
  readonly projectId: AlarmProjectionRecord["projectId"];
  readonly gatewayId: AlarmProjectionRecord["gatewayId"];
  readonly receivedAt: UtcInstant;
  readonly occurrenceId: AlarmOccurrenceId;
  readonly ruleId: string;
  readonly generation: string;
  readonly lastSequence: string;
  readonly state: "active" | "cleared";
  readonly severity: AlarmSeverity;
  readonly summary: string;
  readonly sourceTimestampMs: string;
  readonly instanceId: string;
  readonly pointId?: string;
  readonly edgeFactAuthoritative: true;
  readonly cloudWorkflowState: "acknowledged" | "unacknowledged";
  readonly revision: number;
  readonly gap?: Readonly<{
    expectedSequence: string;
    receivedSequence: string;
  }>;
  readonly acknowledgement?: Readonly<{
    subjectId: string;
    acknowledgedAt: UtcInstant;
  }>;
}

export interface AlarmIngestionValue {
  readonly disposition:
    | "accepted-gap"
    | "accepted-late"
    | "accepted-latest"
    | "replayed";
  readonly projection?: AlarmProjectionView;
}

interface CommandContext {
  readonly requestId: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

interface TenantCommandContext extends CommandContext, AlarmScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
}

interface QueryContext extends AlarmScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
}

class AlarmInputError extends Error {}

function failure(
  code: AlarmFailureCode,
  message: string,
): Readonly<{ ok: false; failure: AlarmApplicationFailure }> {
  return { ok: false, failure: { code, message } };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function requireRecord(input: unknown, name: string): Record<string, unknown> {
  if (!isRecord(input)) throw new AlarmInputError(`${name} must be an object`);
  return input;
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new AlarmInputError(`${name} contains unknown or missing fields`);
  }
}

function requireString(input: unknown, name: string, maximum = 512): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > maximum
  ) {
    throw new AlarmInputError(`${name} must be a non-empty bounded string`);
  }
  return input;
}

function parseRequestId(input: unknown): string {
  const value = requireString(input, "idempotencyKey", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new AlarmInputError("idempotencyKey must be an opaque identifier");
  }
  return value;
}

function decodeCommandContext(input: unknown): CommandContext {
  const record = requireRecord(input, "command context");
  requireExactKeys(
    record,
    ["expiresAt", "idempotencyKey", "issuedAt"],
    "command context",
  );
  return {
    requestId: parseRequestId(record.idempotencyKey),
    issuedAt: parseUtcInstant(record.issuedAt),
    expiresAt: parseUtcInstant(record.expiresAt),
  };
}

function decodePermissions(input: unknown): ReadonlySet<string> {
  if (
    !Array.isArray(input) ||
    input.some((value) => typeof value !== "string")
  ) {
    throw new AlarmInputError("permissions must be an array of strings");
  }
  return new Set(input);
}

function decodeTenantCommandContext(input: unknown): TenantCommandContext {
  const record = requireRecord(input, "tenant command context");
  requireExactKeys(
    record,
    [
      "expiresAt",
      "idempotencyKey",
      "issuedAt",
      "permissions",
      "projectId",
      "subjectId",
      "tenantId",
    ],
    "tenant command context",
  );
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
    subjectId: requireString(record.subjectId, "subjectId", 128),
    permissions: decodePermissions(record.permissions),
    requestId: parseRequestId(record.idempotencyKey),
    issuedAt: parseUtcInstant(record.issuedAt),
    expiresAt: parseUtcInstant(record.expiresAt),
  };
}

function decodeQueryContext(input: unknown): QueryContext {
  const record = requireRecord(input, "query context");
  requireExactKeys(
    record,
    ["permissions", "projectId", "subjectId", "tenantId"],
    "query context",
  );
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
    subjectId: requireString(record.subjectId, "subjectId", 128),
    permissions: decodePermissions(record.permissions),
  };
}

function decodeCredential(input: unknown): GatewayCredentialAssertion {
  const record = requireRecord(input, "gateway credential");
  requireExactKeys(record, ["credentialId", "proof"], "gateway credential");
  return {
    credentialId: requireString(record.credentialId, "credentialId", 256),
    proof: requireString(record.proof, "credential proof", 4096),
  };
}

function decodeKind(input: unknown): AlarmFactKind {
  if (input !== "cleared" && input !== "raised" && input !== "updated") {
    throw new AlarmInputError("alarm fact kind is unsupported");
  }
  return input;
}

function decodeSeverity(input: unknown): AlarmSeverity {
  if (
    input !== "critical" &&
    input !== "high" &&
    input !== "info" &&
    input !== "low" &&
    input !== "medium"
  ) {
    throw new AlarmInputError("alarm severity is unsupported");
  }
  return input;
}

function decodeFact(input: unknown) {
  const record = requireRecord(input, "alarm fact");
  const keys = [
    "factId",
    "generation",
    "instanceId",
    "kind",
    "occurrenceId",
    "ruleId",
    "sequence",
    "severity",
    "sourceTimestampMs",
    "summary",
    ...(record.pointId === undefined ? [] : ["pointId"]),
  ];
  requireExactKeys(record, keys, "alarm fact");
  return defineAlarmFact({
    factId: parseAlarmFactId(record.factId),
    occurrenceId: parseAlarmOccurrenceId(record.occurrenceId),
    ruleId: parseAlarmRuleId(record.ruleId),
    generation: parseAlarmGeneration(record.generation),
    sequence: parseAlarmSequence(record.sequence),
    kind: decodeKind(record.kind),
    severity: decodeSeverity(record.severity),
    sourceTimestampMs: parseSourceTimestampMs(record.sourceTimestampMs),
    instanceId: parseEdgeInstanceId(record.instanceId),
    ...(record.pointId === undefined
      ? {}
      : { pointId: parseEdgePointId(record.pointId) }),
    summary: requireString(record.summary, "alarm summary"),
  });
}

function decodeSafely<Value>(
  decoder: () => Value,
):
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: AlarmApplicationFailure }> {
  try {
    return { ok: true, value: decoder() };
  } catch (error: unknown) {
    if (
      error instanceof InvalidDomainValueError ||
      error instanceof AlarmInputError
    ) {
      return {
        ok: false,
        failure: { code: "invalid-input", message: error.message },
      };
    }
    throw error;
  }
}

function validateTime(
  command: CommandContext,
  now: UtcInstant,
): AlarmApplicationFailure | undefined {
  if (command.expiresAt <= command.issuedAt || command.issuedAt > now) {
    return { code: "invalid-input", message: "command time window is invalid" };
  }
  return now >= command.expiresAt
    ? { code: "command-expired", message: "command has expired" }
    : undefined;
}

async function verifyCredential(
  verifier: GatewayCredentialVerifier,
  assertion: GatewayCredentialAssertion,
): Promise<
  | Readonly<{ ok: true; value: GatewayCredentialBinding }>
  | Readonly<{ ok: false; failure: AlarmApplicationFailure }>
> {
  const result = await verifier.verify(assertion);
  if (!result.ok) {
    return failure(
      "invalid-gateway-credential",
      "Gateway credential was rejected",
    );
  }
  return result.value.status === "active"
    ? result
    : failure("gateway-credential-inactive", "Gateway credential is inactive");
}

function toView(record: AlarmProjectionRecord): AlarmProjectionView {
  const projection = record.projection;
  return {
    tenantId: record.tenantId,
    projectId: record.projectId,
    gatewayId: record.gatewayId,
    receivedAt: record.receivedAt,
    occurrenceId: projection.occurrenceId,
    ruleId: projection.ruleId,
    generation: projection.generation,
    lastSequence: projection.lastSequence,
    state: projection.state,
    severity: projection.severity,
    summary: projection.summary,
    sourceTimestampMs: projection.sourceTimestampMs,
    instanceId: projection.instanceId,
    ...(projection.pointId === undefined
      ? {}
      : { pointId: projection.pointId }),
    edgeFactAuthoritative: true,
    cloudWorkflowState: projection.cloudWorkflowState,
    revision: projection.revision,
    ...(projection.gap === undefined ? {} : { gap: projection.gap }),
    ...(record.acknowledgement === undefined
      ? {}
      : { acknowledgement: record.acknowledgement }),
  };
}

export class IngestAlarmFact {
  static readonly definition = INGEST_ALARM_FACT_COMMAND;
  readonly #verifier: GatewayCredentialVerifier;
  readonly #digestor: AlarmFactDigestor;
  readonly #repository: AlarmRepository;
  readonly #clock: ApplicationClock;

  constructor(dependencies: {
    readonly verifier: GatewayCredentialVerifier;
    readonly digestor: AlarmFactDigestor;
    readonly repository: AlarmRepository;
    readonly clock: ApplicationClock;
  }) {
    this.#verifier = dependencies.verifier;
    this.#digestor = dependencies.digestor;
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<AlarmApplicationResult<AlarmIngestionValue>> {
    const decoded = decodeSafely(() => {
      const context = decodeCommandContext(rawContext);
      const input = requireRecord(rawInput, "alarm ingestion input");
      requireExactKeys(input, ["credential", "fact"], "alarm ingestion input");
      return {
        context,
        credential: decodeCredential(input.credential),
        fact: decodeFact(input.fact),
      };
    });
    if (!decoded.ok) return decoded;
    const now = this.#clock.now();
    const timeFailure = validateTime(decoded.value.context, now);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    const verified = await verifyCredential(
      this.#verifier,
      decoded.value.credential,
    );
    if (!verified.ok) return verified;
    const payloadDigest = await this.#digestor.digest(decoded.value.fact);
    if (!/^[0-9a-f]{64}$/.test(payloadDigest)) {
      return failure("invalid-input", "alarm digest must be lowercase SHA-256");
    }
    const result = await this.#repository.ingest({
      requestId: decoded.value.context.requestId,
      binding: verified.value,
      fact: decoded.value.fact,
      payloadDigest,
      receivedAt: now,
    });
    if (result.outcome === "fact-conflict") {
      return failure(
        "alarm-fact-conflict",
        "alarm fact identity conflicts with persisted content",
      );
    }
    if (result.outcome === "sequence-conflict") {
      return failure(
        "alarm-sequence-conflict",
        "alarm sequence conflicts with persisted facts",
      );
    }
    if (result.outcome === "storage-unavailable") {
      return failure(
        "alarm-storage-unavailable",
        "alarm projection persistence is unavailable",
      );
    }
    if (result.outcome === "replayed") {
      return {
        ok: true,
        replayed: true,
        value: { disposition: result.disposition },
      };
    }
    if (
      result.record.tenantId !== verified.value.tenantId ||
      result.record.projectId !== verified.value.projectId ||
      result.record.gatewayId !== verified.value.gatewayId
    ) {
      return failure(
        "invalid-alarm-repository-result",
        "alarm repository returned mismatched scope",
      );
    }
    return {
      ok: true,
      replayed: false,
      value: {
        disposition: result.disposition,
        projection: toView(result.record),
      },
    };
  }
}

export class GetAlarmProjection {
  static readonly definition = GET_ALARM_PROJECTION_QUERY;
  readonly #repository: AlarmRepository;

  constructor(dependencies: { readonly repository: AlarmRepository }) {
    this.#repository = dependencies.repository;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<AlarmQueryResult<AlarmProjectionView>> {
    const decoded = decodeSafely(() => {
      const context = decodeQueryContext(rawContext);
      const input = requireRecord(rawInput, "alarm projection query");
      requireExactKeys(input, ["occurrenceId"], "alarm projection query");
      return {
        context,
        occurrenceId: parseAlarmOccurrenceId(input.occurrenceId),
      };
    });
    if (!decoded.ok) return decoded;
    if (
      !decoded.value.context.permissions.has(
        GET_ALARM_PROJECTION_QUERY.permission,
      )
    ) {
      return failure(
        "permission-denied",
        `permission ${GET_ALARM_PROJECTION_QUERY.permission} is required`,
      );
    }
    const record = await this.#repository.findCurrent(
      decoded.value.context,
      decoded.value.occurrenceId,
    );
    return record === undefined
      ? failure("alarm-not-found", "alarm projection was not found")
      : { ok: true, value: toView(record) };
  }
}

export class AcknowledgeAlarm {
  static readonly definition = ACKNOWLEDGE_ALARM_COMMAND;
  readonly #repository: AlarmRepository;
  readonly #clock: ApplicationClock;

  constructor(dependencies: {
    readonly repository: AlarmRepository;
    readonly clock: ApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<AlarmApplicationResult<AlarmProjectionView>> {
    const decoded = decodeSafely(() => {
      const context = decodeTenantCommandContext(rawContext);
      const input = requireRecord(rawInput, "alarm acknowledgement input");
      requireExactKeys(input, ["occurrenceId"], "alarm acknowledgement input");
      return {
        context,
        occurrenceId: parseAlarmOccurrenceId(input.occurrenceId),
      };
    });
    if (!decoded.ok) return decoded;
    const now = this.#clock.now();
    const timeFailure = validateTime(decoded.value.context, now);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    if (
      !decoded.value.context.permissions.has(
        ACKNOWLEDGE_ALARM_COMMAND.permission,
      )
    ) {
      return failure(
        "permission-denied",
        `permission ${ACKNOWLEDGE_ALARM_COMMAND.permission} is required`,
      );
    }
    const result = await this.#repository.acknowledge({
      tenantId: decoded.value.context.tenantId,
      projectId: decoded.value.context.projectId,
      occurrenceId: decoded.value.occurrenceId,
      requestId: decoded.value.context.requestId,
      subjectId: decoded.value.context.subjectId,
      acknowledgedAt: now,
    });
    if (result.outcome === "not-found")
      return failure("alarm-not-found", "alarm projection was not found");
    if (result.outcome === "idempotency-conflict")
      return failure("idempotency-conflict", "idempotency key was reused");
    if (result.outcome === "concurrent-modification")
      return failure(
        "concurrent-modification",
        "alarm workflow changed concurrently",
      );
    if (result.outcome === "storage-unavailable")
      return failure(
        "alarm-storage-unavailable",
        "alarm workflow persistence is unavailable",
      );
    return {
      ok: true,
      replayed: result.outcome === "replayed",
      value: toView(result.record),
    };
  }
}
