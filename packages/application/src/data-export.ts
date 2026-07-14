import {
  DataExportTransitionError,
  InvalidDomainValueError,
  completeDataExport,
  createDataExport,
  failDataExport,
  parseContentDigest,
  parseDataExportByteLength,
  parseDataExportId,
  parseProjectId,
  parseStorageObjectReference,
  parseTenantId,
  parseUtcInstant,
  startDataExport,
} from "@aether-cloud/domain";
import type {
  DataExport,
  DataExportFormat,
  DataExportKind,
  UtcInstant,
} from "@aether-cloud/domain";

import {
  GET_DATA_EXPORT_QUERY,
  REPORT_DATA_EXPORT_OUTCOME_COMMAND,
  REQUEST_DATA_EXPORT_COMMAND,
} from "./capability-definition.js";
import type {
  DataExportRepository,
  DataExportScope,
} from "./data-export-repository.js";

type DataExportFailureCode =
  | "command-expired"
  | "confirmation-required"
  | "data-export-conflict"
  | "data-export-idempotency-conflict"
  | "data-export-not-found"
  | "data-export-storage-unavailable"
  | "data-export-transition-invalid"
  | "data-export-version-conflict"
  | "invalid-input"
  | "permission-denied";

export interface DataExportApplicationFailure {
  readonly code: DataExportFailureCode;
  readonly message: string;
}

export type DataExportApplicationResult<Value> =
  | Readonly<{ ok: true; replayed: boolean; value: Value }>
  | Readonly<{ ok: false; failure: DataExportApplicationFailure }>;

export type DataExportQueryResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: DataExportApplicationFailure }>;

export interface DataExportView {
  readonly exportId: string;
  readonly kind: DataExportKind;
  readonly format: DataExportFormat;
  readonly filterDigest: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly state: DataExport["state"];
  readonly objectReference: string | null;
  readonly contentDigest: string | null;
  readonly byteLength: string | null;
  readonly failureCode: string | null;
  readonly evidenceDigest: string | null;
  readonly revision: number;
}

export interface DataExportApplicationClock {
  now(): string;
}

interface CommandContext extends DataExportScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
  readonly confirmation: "confirmed" | "not-confirmed";
  readonly requestId: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

interface QueryContext extends DataExportScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
}

class DataExportInputError extends Error {}

function failure(
  code: DataExportFailureCode,
  message: string,
): Readonly<{ ok: false; failure: DataExportApplicationFailure }> {
  return { ok: false, failure: { code, message } };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function requireRecord(input: unknown, name: string): Record<string, unknown> {
  if (!isRecord(input))
    throw new DataExportInputError(`${name} must be an object`);
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
    throw new DataExportInputError(
      `${name} must contain exactly: ${canonical.join(", ")}`,
    );
  }
}

function requireIdentifier(input: unknown, name: string): string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)
  ) {
    throw new DataExportInputError(`${name} must be a bounded identifier`);
  }
  return input;
}

function requireRequestId(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input)
  ) {
    throw new DataExportInputError("idempotencyKey is invalid");
  }
  return input;
}

function decodePermissions(input: unknown): ReadonlySet<string> {
  if (
    !Array.isArray(input) ||
    input.some((permission) => typeof permission !== "string")
  ) {
    throw new DataExportInputError("permissions must be an array of strings");
  }
  return new Set(input);
}

function decodeScope(record: Record<string, unknown>): DataExportScope {
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
  };
}

function decodeCommandContext(input: unknown): CommandContext {
  const record = requireRecord(input, "Data Export command context");
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
    "Data Export command context",
  );
  if (
    record.confirmation !== "confirmed" &&
    record.confirmation !== "not-confirmed"
  ) {
    throw new DataExportInputError("confirmation is invalid");
  }
  return {
    ...decodeScope(record),
    subjectId: requireIdentifier(record.subjectId, "subjectId"),
    permissions: decodePermissions(record.permissions),
    confirmation: record.confirmation,
    requestId: requireRequestId(record.idempotencyKey),
    issuedAt: parseUtcInstant(record.issuedAt),
    expiresAt: parseUtcInstant(record.expiresAt),
  };
}

function decodeQueryContext(input: unknown): QueryContext {
  const record = requireRecord(input, "Data Export query context");
  requireExactKeys(
    record,
    ["permissions", "projectId", "subjectId", "tenantId"],
    "Data Export query context",
  );
  return {
    ...decodeScope(record),
    subjectId: requireIdentifier(record.subjectId, "subjectId"),
    permissions: decodePermissions(record.permissions),
  };
}

function decodeRequestInput(input: unknown): Readonly<{
  exportId: ReturnType<typeof parseDataExportId>;
  kind: DataExportKind;
  format: DataExportFormat;
  filterDigest: ReturnType<typeof parseContentDigest>;
  exportExpiresAt: UtcInstant;
}> {
  const record = requireRecord(input, "Data Export request");
  requireExactKeys(
    record,
    ["exportExpiresAt", "exportId", "filterDigest", "format", "kind"],
    "Data Export request",
  );
  const kind = record.kind;
  if (
    kind !== "alarm-history" &&
    kind !== "audit-events" &&
    kind !== "telemetry-history"
  ) {
    throw new DataExportInputError("Data Export kind is unsupported");
  }
  const format = record.format;
  if (format !== "ndjson" && format !== "parquet") {
    throw new DataExportInputError("Data Export format is unsupported");
  }
  return {
    exportId: parseDataExportId(record.exportId),
    kind,
    format,
    filterDigest: parseContentDigest(record.filterDigest),
    exportExpiresAt: parseUtcInstant(record.exportExpiresAt),
  };
}

function decodeExportId(input: unknown) {
  const record = requireRecord(input, "Data Export identity");
  requireExactKeys(record, ["exportId"], "Data Export identity");
  return parseDataExportId(record.exportId);
}

type OutcomeInput =
  | Readonly<{
      action: "start";
      exportId: ReturnType<typeof parseDataExportId>;
    }>
  | Readonly<{
      action: "ready";
      exportId: ReturnType<typeof parseDataExportId>;
      objectReference: ReturnType<typeof parseStorageObjectReference>;
      contentDigest: ReturnType<typeof parseContentDigest>;
      byteLength: ReturnType<typeof parseDataExportByteLength>;
    }>
  | Readonly<{
      action: "failed";
      exportId: ReturnType<typeof parseDataExportId>;
      failureCode: string;
      evidenceDigest: ReturnType<typeof parseContentDigest>;
    }>;

function decodeOutcome(input: unknown): OutcomeInput {
  const record = requireRecord(input, "Data Export outcome");
  if (record.action === "start") {
    requireExactKeys(record, ["action", "exportId"], "Data Export start");
    return { action: "start", exportId: parseDataExportId(record.exportId) };
  }
  if (record.action === "ready") {
    requireExactKeys(
      record,
      ["action", "byteLength", "contentDigest", "exportId", "objectReference"],
      "Data Export completion",
    );
    return {
      action: "ready",
      exportId: parseDataExportId(record.exportId),
      objectReference: parseStorageObjectReference(record.objectReference),
      contentDigest: parseContentDigest(record.contentDigest),
      byteLength: parseDataExportByteLength(record.byteLength),
    };
  }
  if (record.action === "failed") {
    requireExactKeys(
      record,
      ["action", "evidenceDigest", "exportId", "failureCode"],
      "Data Export failure",
    );
    return {
      action: "failed",
      exportId: parseDataExportId(record.exportId),
      failureCode: requireIdentifier(record.failureCode, "failureCode"),
      evidenceDigest: parseContentDigest(record.evidenceDigest),
    };
  }
  throw new DataExportInputError("Data Export outcome action is unsupported");
}

function decodeSafely<Value>(
  decoder: () => Value,
):
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: DataExportApplicationFailure }> {
  try {
    return { ok: true, value: decoder() };
  } catch (error: unknown) {
    if (
      error instanceof DataExportInputError ||
      error instanceof InvalidDomainValueError
    ) {
      return failure("invalid-input", error.message);
    }
    throw error;
  }
}

function transitionSafely(
  transition: () => DataExport,
):
  | Readonly<{ ok: true; value: DataExport }>
  | Readonly<{ ok: false; failure: DataExportApplicationFailure }> {
  try {
    return { ok: true, value: transition() };
  } catch (error: unknown) {
    if (error instanceof DataExportTransitionError) {
      return failure("data-export-transition-invalid", error.message);
    }
    throw error;
  }
}

function authorize(
  permissions: ReadonlySet<string>,
  permission: string,
): DataExportApplicationFailure | undefined {
  return permissions.has(permission)
    ? undefined
    : {
        code: "permission-denied",
        message: `permission ${permission} is required`,
      };
}

function validateTime(
  context: CommandContext,
  now: UtcInstant,
): DataExportApplicationFailure | undefined {
  if (context.expiresAt <= context.issuedAt || context.issuedAt > now) {
    return { code: "invalid-input", message: "command time window is invalid" };
  }
  return now >= context.expiresAt
    ? { code: "command-expired", message: "command has expired" }
    : undefined;
}

function toView(exportRequest: DataExport): DataExportView {
  return Object.freeze({
    exportId: exportRequest.exportId,
    kind: exportRequest.kind,
    format: exportRequest.format,
    filterDigest: exportRequest.filterDigest,
    requestedAt: exportRequest.requestedAt,
    expiresAt: exportRequest.expiresAt,
    state: exportRequest.state,
    objectReference: exportRequest.objectReference ?? null,
    contentDigest: exportRequest.contentDigest ?? null,
    byteLength: exportRequest.byteLength ?? null,
    failureCode: exportRequest.failureCode ?? null,
    evidenceDigest: exportRequest.evidenceDigest ?? null,
    revision: exportRequest.revision,
  });
}

function mapInsertFailure(
  outcome: "already-exists" | "idempotency-conflict" | "storage-unavailable",
) {
  const codes = {
    "already-exists": "data-export-conflict",
    "idempotency-conflict": "data-export-idempotency-conflict",
    "storage-unavailable": "data-export-storage-unavailable",
  } as const;
  return failure(codes[outcome], "Data Export request was rejected");
}

function mapReplaceFailure(
  outcome:
    | "idempotency-conflict"
    | "not-found"
    | "storage-unavailable"
    | "version-conflict",
) {
  const codes = {
    "idempotency-conflict": "data-export-idempotency-conflict",
    "not-found": "data-export-not-found",
    "storage-unavailable": "data-export-storage-unavailable",
    "version-conflict": "data-export-version-conflict",
  } as const;
  return failure(codes[outcome], "Data Export update was rejected");
}

export class RequestDataExport {
  static readonly capability = REQUEST_DATA_EXPORT_COMMAND;
  readonly #repository: DataExportRepository;
  readonly #clock: DataExportApplicationClock;

  constructor(dependencies: {
    readonly repository: DataExportRepository;
    readonly clock: DataExportApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<DataExportApplicationResult<DataExportView>> {
    const context = decodeSafely(() => decodeCommandContext(rawContext));
    if (!context.ok) return context;
    const authorization = authorize(
      context.value.permissions,
      RequestDataExport.capability.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    if (context.value.confirmation !== "confirmed") {
      return failure(
        "confirmation-required",
        "Data Export requires explicit confirmation",
      );
    }
    const now = decodeSafely(() => parseUtcInstant(this.#clock.now()));
    if (!now.ok) return now;
    const timeFailure = validateTime(context.value, now.value);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    const input = decodeSafely(() => decodeRequestInput(rawInput));
    if (!input.ok) return input;
    const maximumExpiry = Date.parse(now.value) + 31 * 24 * 60 * 60 * 1000;
    if (
      input.value.exportExpiresAt <= now.value ||
      Date.parse(input.value.exportExpiresAt) > maximumExpiry
    ) {
      return failure(
        "invalid-input",
        "Data Export expiry must be in the future and no more than 31 days away",
      );
    }
    const exportRequest = createDataExport({
      exportId: input.value.exportId,
      kind: input.value.kind,
      format: input.value.format,
      filterDigest: input.value.filterDigest,
      requestedAt: now.value,
      expiresAt: input.value.exportExpiresAt,
    });
    const persisted = await this.#repository.insert({
      tenantId: context.value.tenantId,
      projectId: context.value.projectId,
      requestId: context.value.requestId,
      subjectId: context.value.subjectId,
      exportRequest,
    });
    if (persisted.outcome === "inserted" || persisted.outcome === "replayed") {
      return {
        ok: true,
        replayed: persisted.outcome === "replayed",
        value: toView(persisted.exportRequest),
      };
    }
    return mapInsertFailure(persisted.outcome);
  }
}

export class ReportDataExportOutcome {
  static readonly capability = REPORT_DATA_EXPORT_OUTCOME_COMMAND;
  readonly #repository: DataExportRepository;
  readonly #clock: DataExportApplicationClock;

  constructor(dependencies: {
    readonly repository: DataExportRepository;
    readonly clock: DataExportApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<DataExportApplicationResult<DataExportView>> {
    const context = decodeSafely(() => decodeCommandContext(rawContext));
    if (!context.ok) return context;
    const authorization = authorize(
      context.value.permissions,
      ReportDataExportOutcome.capability.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    const now = decodeSafely(() => parseUtcInstant(this.#clock.now()));
    if (!now.ok) return now;
    const timeFailure = validateTime(context.value, now.value);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    const input = decodeSafely(() => decodeOutcome(rawInput));
    if (!input.ok) return input;
    const current = await this.#repository.find(
      context.value,
      input.value.exportId,
    );
    if (current === undefined) {
      return failure("data-export-not-found", "Data Export was not found");
    }
    const transitioned = transitionSafely(() => {
      if (input.value.action === "start") {
        return startDataExport(current, now.value);
      }
      if (input.value.action === "ready") {
        return completeDataExport(current, {
          completedAt: now.value,
          objectReference: input.value.objectReference,
          contentDigest: input.value.contentDigest,
          byteLength: input.value.byteLength,
        });
      }
      return failDataExport(current, {
        failedAt: now.value,
        failureCode: input.value.failureCode,
        evidenceDigest: input.value.evidenceDigest,
      });
    });
    if (!transitioned.ok) return transitioned;
    const persisted = await this.#repository.replace({
      tenantId: context.value.tenantId,
      projectId: context.value.projectId,
      requestId: context.value.requestId,
      subjectId: context.value.subjectId,
      expectedRevision: current.revision,
      exportRequest: transitioned.value,
    });
    if (persisted.outcome === "replaced" || persisted.outcome === "replayed") {
      return {
        ok: true,
        replayed: persisted.outcome === "replayed",
        value: toView(persisted.exportRequest),
      };
    }
    return mapReplaceFailure(persisted.outcome);
  }
}

export class GetDataExport {
  static readonly capability = GET_DATA_EXPORT_QUERY;
  readonly #repository: DataExportRepository;

  constructor(dependencies: { readonly repository: DataExportRepository }) {
    this.#repository = dependencies.repository;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<DataExportQueryResult<DataExportView>> {
    const context = decodeSafely(() => decodeQueryContext(rawContext));
    if (!context.ok) return context;
    const authorization = authorize(
      context.value.permissions,
      GetDataExport.capability.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    const exportId = decodeSafely(() => decodeExportId(rawInput));
    if (!exportId.ok) return exportId;
    const exportRequest = await this.#repository.find(
      context.value,
      exportId.value,
    );
    return exportRequest === undefined
      ? failure("data-export-not-found", "Data Export was not found")
      : { ok: true, value: toView(exportRequest) };
  }
}
