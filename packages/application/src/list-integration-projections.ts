import { Buffer } from "node:buffer";

import {
  InvalidDomainValueError,
  parseGatewayId,
  parseIntegrationId,
  parseIntegrationKind,
  parseIntegrationSnapshotGeneration,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";
import type {
  GatewayId,
  IntegrationId,
  IntegrationKind,
  IntegrationSnapshotGeneration,
  UtcInstant,
} from "@aether-cloud/domain";

import { LIST_INTEGRATION_PROJECTIONS_QUERY } from "./capability-definition.js";
import type { ApplicationClock } from "./gateway-identity-repository.js";
import type {
  IntegrationProjectionCatalog,
  IntegrationProjectionCatalogPosition,
  IntegrationProjectionCatalogQuery,
} from "./integration-projection-catalog.js";

const defaultLimit = 50;
const maximumLimit = 100;
const maximumCatalogCount = 65_536;
const cursorPattern = /^[A-Za-z0-9_-]{16,512}$/;

type JsonRecord = Record<string, unknown>;

export interface IntegrationProjectionCatalogItem {
  readonly gatewayId: GatewayId;
  readonly integrationId: IntegrationId;
  readonly integrationKind: IntegrationKind;
  readonly snapshotGeneration: IntegrationSnapshotGeneration;
  readonly entityCount: number;
  readonly latestObservationCount: number;
  readonly receivedAt: UtcInstant;
  readonly revision: number;
}

export interface IntegrationProjectionCatalogView {
  readonly authority: "edge-reported-copy";
  readonly liveStateAuthoritative: false;
  readonly items: readonly IntegrationProjectionCatalogItem[];
  readonly nextCursor?: string;
}

export type IntegrationProjectionCatalogFailureCode =
  | "integration-storage-unavailable"
  | "invalid-input"
  | "invalid-integration-repository-result"
  | "permission-denied";

export interface IntegrationProjectionCatalogFailure {
  readonly code: IntegrationProjectionCatalogFailureCode;
  readonly message: string;
}

export type IntegrationProjectionCatalogResult =
  | Readonly<{ ok: true; value: IntegrationProjectionCatalogView }>
  | Readonly<{
      ok: false;
      failure: IntegrationProjectionCatalogFailure;
    }>;

interface QueryContext {
  readonly tenantId: ReturnType<typeof parseTenantId>;
  readonly projectId: ReturnType<typeof parseProjectId>;
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
}

interface DecodedCursor extends IntegrationProjectionCatalogPosition {
  readonly gatewayFilter: GatewayId | null;
}

class CatalogInputError extends Error {}

function failure(
  code: IntegrationProjectionCatalogFailureCode,
  message: string,
): Readonly<{ ok: false; failure: IntegrationProjectionCatalogFailure }> {
  return { ok: false, failure: { code, message } };
}

function isRecord(input: unknown): input is JsonRecord {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function record(input: unknown, field: string): JsonRecord {
  if (!isRecord(input))
    throw new CatalogInputError(`${field} must be an object`);
  return input;
}

function exactKeys(
  input: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in input)) ||
    Object.keys(input).some((key) => !allowed.has(key))
  ) {
    throw new CatalogInputError(`${field} fields are invalid`);
  }
}

function nonEmptyString(
  input: unknown,
  field: string,
  maximum: number,
): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > maximum
  ) {
    throw new CatalogInputError(`${field} must be bounded non-empty text`);
  }
  return input;
}

function decodeContext(input: unknown): QueryContext {
  const value = record(input, "query context");
  exactKeys(
    value,
    ["permissions", "projectId", "subjectId", "tenantId"],
    [],
    "query context",
  );
  if (
    !Array.isArray(value.permissions) ||
    value.permissions.length > 256 ||
    value.permissions.some(
      (permission) =>
        typeof permission !== "string" ||
        permission.length === 0 ||
        permission.length > 256,
    )
  ) {
    throw new CatalogInputError("permissions must be a bounded string array");
  }
  return {
    tenantId: parseTenantId(value.tenantId),
    projectId: parseProjectId(value.projectId),
    subjectId: nonEmptyString(value.subjectId, "subjectId", 128),
    permissions: new Set(value.permissions as string[]),
  };
}

function canonicalCursor(input: DecodedCursor): string {
  return Buffer.from(
    JSON.stringify({
      gatewayFilter: input.gatewayFilter,
      gatewayId: input.gatewayId,
      integrationId: input.integrationId,
      version: 1,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(input: unknown, gatewayFilter: GatewayId | undefined) {
  if (
    typeof input !== "string" ||
    !cursorPattern.test(input) ||
    input.length > 512
  ) {
    throw new CatalogInputError("cursor must be an opaque bounded token");
  }
  let decoded: unknown;
  try {
    const bytes = Buffer.from(input, "base64url");
    if (bytes.toString("base64url") !== input) {
      throw new CatalogInputError("cursor encoding is not canonical");
    }
    decoded = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error: unknown) {
    if (error instanceof CatalogInputError) throw error;
    throw new CatalogInputError("cursor is invalid");
  }
  const value = record(decoded, "cursor");
  exactKeys(
    value,
    ["gatewayFilter", "gatewayId", "integrationId", "version"],
    [],
    "cursor",
  );
  if (value.version !== 1) throw new CatalogInputError("cursor is unsupported");
  const decodedFilter =
    value.gatewayFilter === null ? null : parseGatewayId(value.gatewayFilter);
  if (decodedFilter !== (gatewayFilter ?? null)) {
    throw new CatalogInputError("cursor does not match the Gateway filter");
  }
  const cursor: DecodedCursor = {
    gatewayFilter: decodedFilter,
    gatewayId: parseGatewayId(value.gatewayId),
    integrationId: parseIntegrationId(value.integrationId),
  };
  if (canonicalCursor(cursor) !== input) {
    throw new CatalogInputError("cursor is not canonical");
  }
  return cursor;
}

function decodeInput(input: unknown): Readonly<{
  gatewayId: GatewayId | undefined;
  after: IntegrationProjectionCatalogPosition | undefined;
  limit: number;
}> {
  const value = record(input, "Integration projection catalog query");
  exactKeys(
    value,
    [],
    ["cursor", "gatewayId", "limit"],
    "Integration projection catalog query",
  );
  const gatewayId =
    value.gatewayId === undefined ? undefined : parseGatewayId(value.gatewayId);
  const limit = value.limit === undefined ? defaultLimit : value.limit;
  if (
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > maximumLimit
  ) {
    throw new CatalogInputError("limit must be an integer from 1-100");
  }
  const cursor =
    value.cursor === undefined
      ? undefined
      : decodeCursor(value.cursor, gatewayId);
  return {
    gatewayId,
    after:
      cursor === undefined
        ? undefined
        : {
            gatewayId: cursor.gatewayId,
            integrationId: cursor.integrationId,
          },
    limit,
  };
}

function catalogIdentity(
  value: Readonly<{ gatewayId: string; integrationId: string }>,
): string {
  return `${value.gatewayId}\u0000${value.integrationId}`;
}

function decodeCount(input: unknown, field: string): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 0 ||
    input > maximumCatalogCount
  ) {
    throw new CatalogInputError(`${field} is invalid`);
  }
  return input;
}

function decodeCatalogRecord(
  input: unknown,
  expected: Readonly<{
    tenantId: QueryContext["tenantId"];
    projectId: QueryContext["projectId"];
    gatewayId: GatewayId | undefined;
    now: UtcInstant;
  }>,
): IntegrationProjectionCatalogItem & Readonly<{ identity: string }> {
  const value = record(input, "Integration projection catalog record");
  exactKeys(
    value,
    [
      "entityCount",
      "gatewayId",
      "integrationId",
      "integrationKind",
      "latestObservationCount",
      "projectId",
      "receivedAt",
      "revision",
      "snapshotGeneration",
      "tenantId",
    ],
    [],
    "Integration projection catalog record",
  );
  const tenantId = parseTenantId(value.tenantId);
  const projectId = parseProjectId(value.projectId);
  const gatewayId = parseGatewayId(value.gatewayId);
  const integrationId = parseIntegrationId(value.integrationId);
  if (
    tenantId !== expected.tenantId ||
    projectId !== expected.projectId ||
    (expected.gatewayId !== undefined && gatewayId !== expected.gatewayId)
  ) {
    throw new CatalogInputError("catalog record is outside the query scope");
  }
  const receivedAt = parseUtcInstant(value.receivedAt);
  if (receivedAt > expected.now) {
    throw new CatalogInputError("catalog record is from the future");
  }
  if (
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  ) {
    throw new CatalogInputError("catalog revision is invalid");
  }
  return Object.freeze({
    gatewayId,
    integrationId,
    integrationKind: parseIntegrationKind(value.integrationKind),
    snapshotGeneration: parseIntegrationSnapshotGeneration(
      value.snapshotGeneration,
    ),
    entityCount: decodeCount(value.entityCount, "entityCount"),
    latestObservationCount: decodeCount(
      value.latestObservationCount,
      "latestObservationCount",
    ),
    receivedAt,
    revision: value.revision,
    identity: catalogIdentity({ gatewayId, integrationId }),
  });
}

function invalidRepositoryResult(): IntegrationProjectionCatalogResult {
  return failure(
    "invalid-integration-repository-result",
    "integration projection catalog returned invalid data",
  );
}

export class ListIntegrationProjections {
  static readonly definition = LIST_INTEGRATION_PROJECTIONS_QUERY;

  readonly #catalog: IntegrationProjectionCatalog;
  readonly #clock: ApplicationClock;

  constructor(dependencies: {
    readonly catalog: IntegrationProjectionCatalog;
    readonly clock: ApplicationClock;
  }) {
    this.#catalog = dependencies.catalog;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<IntegrationProjectionCatalogResult> {
    let context: QueryContext;
    let input: ReturnType<typeof decodeInput>;
    try {
      context = decodeContext(rawContext);
      input = decodeInput(rawInput);
    } catch (error: unknown) {
      if (
        error instanceof CatalogInputError ||
        error instanceof InvalidDomainValueError
      ) {
        return failure("invalid-input", error.message);
      }
      throw error;
    }
    if (
      !context.permissions.has(LIST_INTEGRATION_PROJECTIONS_QUERY.permission)
    ) {
      return failure(
        "permission-denied",
        `permission ${LIST_INTEGRATION_PROJECTIONS_QUERY.permission} is required`,
      );
    }
    const catalogQuery: IntegrationProjectionCatalogQuery = {
      tenantId: context.tenantId,
      projectId: context.projectId,
      ...(input.gatewayId === undefined ? {} : { gatewayId: input.gatewayId }),
      ...(input.after === undefined ? {} : { after: input.after }),
      limit: input.limit + 1,
    };
    let rawRecords: unknown;
    try {
      rawRecords = await this.#catalog.list(catalogQuery);
    } catch {
      return failure(
        "integration-storage-unavailable",
        "integration projection catalog is unavailable",
      );
    }
    if (!Array.isArray(rawRecords) || rawRecords.length > catalogQuery.limit) {
      return invalidRepositoryResult();
    }
    try {
      const now = parseUtcInstant(this.#clock.now());
      const decoded = rawRecords.map((record) =>
        decodeCatalogRecord(record, {
          tenantId: context.tenantId,
          projectId: context.projectId,
          gatewayId: input.gatewayId,
          now,
        }),
      );
      let previousIdentity =
        input.after === undefined ? undefined : catalogIdentity(input.after);
      for (const item of decoded) {
        if (
          previousIdentity !== undefined &&
          item.identity <= previousIdentity
        ) {
          return invalidRepositoryResult();
        }
        previousIdentity = item.identity;
      }
      const hasNext = decoded.length > input.limit;
      const visible = decoded.slice(0, input.limit);
      const items = Object.freeze(
        visible.map((item) =>
          Object.freeze({
            gatewayId: item.gatewayId,
            integrationId: item.integrationId,
            integrationKind: item.integrationKind,
            snapshotGeneration: item.snapshotGeneration,
            entityCount: item.entityCount,
            latestObservationCount: item.latestObservationCount,
            receivedAt: item.receivedAt,
            revision: item.revision,
          }),
        ),
      );
      const last = visible.at(-1);
      return {
        ok: true,
        value: Object.freeze({
          authority: "edge-reported-copy",
          liveStateAuthoritative: false,
          items,
          ...(hasNext && last !== undefined
            ? {
                nextCursor: canonicalCursor({
                  gatewayFilter: input.gatewayId ?? null,
                  gatewayId: last.gatewayId,
                  integrationId: last.integrationId,
                }),
              }
            : {}),
        }),
      };
    } catch {
      return invalidRepositoryResult();
    }
  }
}
