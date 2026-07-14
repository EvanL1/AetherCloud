import {
  InvalidDomainValueError,
  parseAuditSequence,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";
import type { AuditEvent, UtcInstant } from "@aether-cloud/domain";

import { SEARCH_AUDIT_EVENTS_QUERY } from "./capability-definition.js";
import type {
  AuditEventRepository,
  AuditEventSearch,
  AuditScope,
} from "./audit-repository.js";

export interface AuditApplicationFailure {
  readonly code: "invalid-input" | "permission-denied";
  readonly message: string;
}

export type AuditQueryResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: AuditApplicationFailure }>;

export interface AuditEventView {
  readonly eventId: string;
  readonly sequence: string;
  readonly occurredAt: string;
  readonly subject: Readonly<{ kind: string; subjectId: string }>;
  readonly action: string;
  readonly resource: Readonly<{ kind: string; resourceId: string }>;
  readonly outcome: string;
  readonly risk: string;
  readonly confirmation: string;
  readonly correlationId: string;
  readonly traceId?: string;
  readonly detailsDigest?: string;
}

export interface AuditSearchView {
  readonly items: readonly AuditEventView[];
  readonly nextCursor: string | null;
}

interface AuditQueryContext extends AuditScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
}

class AuditInputError extends Error {}

function failure(
  code: AuditApplicationFailure["code"],
  message: string,
): Readonly<{ ok: false; failure: AuditApplicationFailure }> {
  return { ok: false, failure: { code, message } };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function requireRecord(input: unknown, name: string): Record<string, unknown> {
  if (!isRecord(input)) throw new AuditInputError(`${name} must be an object`);
  return input;
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
    throw new AuditInputError(`${name} fields are invalid`);
  }
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  requireAllowedKeys(record, expected, [], name);
  if (Object.keys(record).length !== expected.length) {
    throw new AuditInputError(`${name} fields are invalid`);
  }
}

function requireIdentifier(input: unknown, name: string): string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)
  ) {
    throw new AuditInputError(`${name} must be a bounded identifier`);
  }
  return input;
}

function requireOpaqueIdentifier(input: unknown, name: string): string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input)
  ) {
    throw new AuditInputError(
      `${name} must be an opaque 8-128 character identifier`,
    );
  }
  return input;
}

function decodePermissions(input: unknown): ReadonlySet<string> {
  if (
    !Array.isArray(input) ||
    input.some((permission) => typeof permission !== "string")
  ) {
    throw new AuditInputError("permissions must be an array of strings");
  }
  return new Set(input);
}

function decodeContext(input: unknown): AuditQueryContext {
  const record = requireRecord(input, "Audit query context");
  requireExactKeys(
    record,
    ["permissions", "projectId", "subjectId", "tenantId"],
    "Audit query context",
  );
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
    subjectId: requireIdentifier(record.subjectId, "subjectId"),
    permissions: decodePermissions(record.permissions),
  };
}

function optionalIdentifier(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  return record[field] === undefined
    ? undefined
    : requireIdentifier(record[field], field);
}

function optionalOpaqueIdentifier(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  return record[field] === undefined
    ? undefined
    : requireOpaqueIdentifier(record[field], field);
}

function optionalTime(
  record: Record<string, unknown>,
  field: string,
): UtcInstant | undefined {
  return record[field] === undefined
    ? undefined
    : parseUtcInstant(record[field]);
}

function decodeSearch(input: unknown): AuditEventSearch {
  const record = requireRecord(input, "Audit search");
  requireAllowedKeys(
    record,
    ["limit"],
    [
      "action",
      "cursor",
      "from",
      "resourceId",
      "resourceKind",
      "subjectId",
      "to",
    ],
    "Audit search",
  );
  if (
    typeof record.limit !== "number" ||
    !Number.isInteger(record.limit) ||
    record.limit < 1 ||
    record.limit > 100
  ) {
    throw new AuditInputError("limit must be an integer from 1 through 100");
  }
  const from = optionalTime(record, "from");
  const to = optionalTime(record, "to");
  if (from !== undefined && to !== undefined && from > to) {
    throw new AuditInputError("from must not follow to");
  }
  const action = optionalIdentifier(record, "action");
  const subjectId = optionalIdentifier(record, "subjectId");
  const resourceKind = optionalIdentifier(record, "resourceKind");
  const resourceId = optionalOpaqueIdentifier(record, "resourceId");
  return {
    limit: record.limit,
    ...(record.cursor === undefined
      ? {}
      : { cursor: parseAuditSequence(record.cursor) }),
    ...(action === undefined ? {} : { action }),
    ...(subjectId === undefined ? {} : { subjectId }),
    ...(resourceKind === undefined ? {} : { resourceKind }),
    ...(resourceId === undefined ? {} : { resourceId }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

function decodeSafely<Value>(
  decoder: () => Value,
):
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: AuditApplicationFailure }> {
  try {
    return { ok: true, value: decoder() };
  } catch (error: unknown) {
    if (
      error instanceof AuditInputError ||
      error instanceof InvalidDomainValueError
    ) {
      return failure("invalid-input", error.message);
    }
    throw error;
  }
}

function toView(event: AuditEvent): AuditEventView {
  return Object.freeze({
    eventId: event.eventId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    subject: Object.freeze({ ...event.subject }),
    action: event.action,
    resource: Object.freeze({ ...event.resource }),
    outcome: event.outcome,
    risk: event.risk,
    confirmation: event.confirmation,
    correlationId: event.correlationId,
    ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
    ...(event.detailsDigest === undefined
      ? {}
      : { detailsDigest: event.detailsDigest }),
  });
}

export class SearchAuditEvents {
  static readonly capability = SEARCH_AUDIT_EVENTS_QUERY;
  readonly #repository: AuditEventRepository;

  constructor(dependencies: { readonly repository: AuditEventRepository }) {
    this.#repository = dependencies.repository;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<AuditQueryResult<AuditSearchView>> {
    const decodedContext = decodeSafely(() => decodeContext(rawContext));
    if (!decodedContext.ok) return decodedContext;
    if (
      !decodedContext.value.permissions.has(
        SearchAuditEvents.capability.permission,
      )
    ) {
      return failure(
        "permission-denied",
        `permission ${SearchAuditEvents.capability.permission} is required`,
      );
    }
    const decodedSearch = decodeSafely(() => decodeSearch(rawInput));
    if (!decodedSearch.ok) return decodedSearch;
    const found = await this.#repository.search(
      decodedContext.value,
      decodedSearch.value,
    );
    return {
      ok: true,
      value: Object.freeze({
        items: Object.freeze(found.events.map(toView)),
        nextCursor: found.nextCursor ?? null,
      }),
    };
  }
}
