import {
  CREATE_GOVERNED_JOB_COMMAND,
  CREATE_INTEGRATION_POWER_CONTROL_COMMAND,
  GET_INTEGRATION_PROJECTION_QUERY,
  LIST_INTEGRATION_PROJECTIONS_QUERY,
  REQUEST_DATA_EXPORT_COMMAND,
  SEARCH_AUDIT_EVENTS_QUERY,
} from "@aether-cloud/application";
import type { CommandDefinition } from "@aether-cloud/application";

export interface McpAuthenticatedSubject {
  readonly tenantId: string;
  readonly projectId: string;
  readonly subjectId: string;
  readonly permissions: readonly string[];
}

interface ApplicationFailure {
  readonly code: string;
  readonly message: string;
}

type ApplicationResult =
  | Readonly<{ ok: true; value: unknown; replayed?: boolean }>
  | Readonly<{ ok: false; failure: ApplicationFailure }>;

interface ApplicationUseCase {
  execute(context: unknown, input: unknown): Promise<ApplicationResult>;
}

export interface IntegrationControlGovernanceEvidence {
  readonly authorization: Readonly<{
    policyDecisionId: string;
    subjectId: string;
    permission: "integration.device.control";
    authorizedAtMs: string;
  }>;
  readonly confirmation: Readonly<{
    confirmationId: string;
    subjectId: string;
    confirmedAtMs: string;
  }>;
}

export interface IntegrationControlGovernanceResolver {
  resolve(
    input: Readonly<{
      subject: McpAuthenticatedSubject;
      idempotencyKey: string;
      issuedAt: string;
      expiresAt: string;
      action: unknown;
    }>,
  ): Promise<
    | Readonly<{ ok: true; value: IntegrationControlGovernanceEvidence }>
    | Readonly<{ ok: false; failure: ApplicationFailure }>
  >;
}

export interface AetherCloudMcpDependencies {
  readonly searchAuditEvents: ApplicationUseCase;
  readonly createGovernedJob: ApplicationUseCase;
  readonly requestDataExport: ApplicationUseCase;
  readonly createIntegrationPowerControl?: ApplicationUseCase;
  readonly getIntegrationProjection?: ApplicationUseCase;
  readonly listIntegrationProjections?: ApplicationUseCase;
  readonly integrationControlGovernance?: IntegrationControlGovernanceResolver;
}

export type McpInterfaceFailureCode = string;

export interface McpInterfaceFailure {
  readonly code: McpInterfaceFailureCode;
  readonly message: string;
}

export type McpInterfaceResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: McpInterfaceFailure }>;

export type McpResourceDescriptor =
  | Readonly<{
      name: string;
      description: string;
      mimeType: "application/json";
      uri: string;
    }>
  | Readonly<{
      name: string;
      description: string;
      mimeType: "application/json";
      uriTemplate: string;
    }>;

export interface McpResourceContent {
  readonly uri: string;
  readonly mimeType: "application/json";
  readonly text: string;
}

export interface McpReadResourceResult {
  readonly contents: readonly McpResourceContent[];
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly permission: string;
  readonly risk: CommandDefinition["risk"];
  readonly confirmation: CommandDefinition["confirmation"];
  readonly idempotency: "required";
  readonly expiry: "required";
  readonly audit: "required";
  readonly status: "partial";
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface McpToolCallResult {
  readonly content: readonly Readonly<{ type: "text"; text: string }>[];
  readonly structuredContent: unknown;
  readonly replayed: boolean;
}

interface DecodedToolEnvelope {
  readonly confirmation: "confirmed" | "not-confirmed";
  readonly idempotencyKey: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly input: unknown;
}

class McpInputError extends Error {}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uint64Pattern = /^(?:0|[1-9][0-9]*)$/;
const opaqueCursorPattern = /^[A-Za-z0-9_-]{16,512}$/;
const maximumUint64 = 18_446_744_073_709_551_615n;

function failure(
  code: McpInterfaceFailureCode,
  message: string,
): Readonly<{ ok: false; failure: McpInterfaceFailure }> {
  return { ok: false, failure: { code, message } };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isUnknownArray(input: unknown): input is unknown[] {
  return Array.isArray(input);
}

function requireRecord(input: unknown, name: string): Record<string, unknown> {
  if (!isRecord(input)) throw new McpInputError(`${name} must be an object`);
  return input;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const expectedSet = new Set(expected);
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !expectedSet.has(key))
  ) {
    throw new McpInputError(`${name} fields are invalid`);
  }
}

function requireString(
  input: unknown,
  name: string,
  pattern: RegExp = identifierPattern,
): string {
  if (typeof input !== "string" || !pattern.test(input)) {
    throw new McpInputError(`${name} is invalid`);
  }
  return input;
}

function decodeSubject(input: unknown): McpAuthenticatedSubject {
  const record = requireRecord(input, "MCP authenticated subject");
  requireExactKeys(
    record,
    ["permissions", "projectId", "subjectId", "tenantId"],
    "MCP authenticated subject",
  );
  const permissions = record.permissions;
  if (
    !isUnknownArray(permissions) ||
    permissions.some(
      (permission) =>
        typeof permission !== "string" || !identifierPattern.test(permission),
    ) ||
    new Set(permissions).size !== permissions.length
  ) {
    throw new McpInputError("permissions must be unique bounded identifiers");
  }
  return Object.freeze({
    tenantId: requireString(record.tenantId, "tenantId"),
    projectId: requireString(record.projectId, "projectId"),
    subjectId: requireString(record.subjectId, "subjectId"),
    permissions: Object.freeze(
      permissions.map((permission) => String(permission)),
    ),
  });
}

function decodeResourceRequest(input: unknown): string {
  const record = requireRecord(input, "MCP resource request");
  requireExactKeys(record, ["uri"], "MCP resource request");
  if (typeof record.uri !== "string" || record.uri.length > 2048) {
    throw new McpInputError("uri must be a bounded string");
  }
  return record.uri;
}

function decodeToolCall(input: unknown): Readonly<{
  name: string;
  arguments: unknown;
}> {
  const record = requireRecord(input, "MCP tool call");
  requireExactKeys(record, ["arguments", "name"], "MCP tool call");
  return {
    name: requireString(record.name, "tool name"),
    arguments: record.arguments,
  };
}

function decodeToolEnvelope(input: unknown): DecodedToolEnvelope {
  const record = requireRecord(input, "MCP command arguments");
  requireExactKeys(
    record,
    ["confirmation", "expiresAt", "idempotencyKey", "input", "issuedAt"],
    "MCP command arguments",
  );
  if (
    record.confirmation !== "confirmed" &&
    record.confirmation !== "not-confirmed"
  ) {
    throw new McpInputError("confirmation is invalid");
  }
  if (typeof record.issuedAt !== "string" || record.issuedAt.length > 64) {
    throw new McpInputError("issuedAt must be a bounded string");
  }
  if (typeof record.expiresAt !== "string" || record.expiresAt.length > 64) {
    throw new McpInputError("expiresAt must be a bounded string");
  }
  return {
    confirmation: record.confirmation,
    idempotencyKey: requireString(
      record.idempotencyKey,
      "idempotencyKey",
      requestIdPattern,
    ),
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    input: record.input,
  };
}

function requireUint64(input: unknown, name: string): string {
  if (
    typeof input !== "string" ||
    !uint64Pattern.test(input) ||
    BigInt(input) > maximumUint64
  ) {
    throw new McpInputError(`${name} is invalid`);
  }
  return input;
}

function decodeIntegrationPowerAction(input: unknown): Readonly<{
  gatewayId: string;
  jobId: string;
  integrationId: string;
  snapshotGeneration: string;
  entityId: string;
  value: boolean;
  jobExpiresAtMs: string;
}> {
  const record = requireRecord(input, "Integration Control action");
  requireExactKeys(
    record,
    [
      "entityId",
      "gatewayId",
      "integrationId",
      "jobExpiresAtMs",
      "jobId",
      "snapshotGeneration",
      "value",
    ],
    "Integration Control action",
  );
  if (typeof record.value !== "boolean") {
    throw new McpInputError("Integration Control value is invalid");
  }
  return Object.freeze({
    gatewayId: requireString(record.gatewayId, "gatewayId", uuidPattern),
    jobId: requireString(record.jobId, "jobId", uuidPattern),
    integrationId: requireString(record.integrationId, "integrationId"),
    snapshotGeneration: requireUint64(
      record.snapshotGeneration,
      "snapshotGeneration",
    ),
    entityId: requireString(record.entityId, "entityId"),
    value: record.value,
    jobExpiresAtMs: requireUint64(record.jobExpiresAtMs, "jobExpiresAtMs"),
  });
}

function decodeIntegrationControlGovernanceEvidence(
  input: unknown,
  subject: McpAuthenticatedSubject,
): IntegrationControlGovernanceEvidence {
  const evidence = requireRecord(input, "Integration Control governance");
  requireExactKeys(
    evidence,
    ["authorization", "confirmation"],
    "Integration Control governance",
  );
  const authorization = requireRecord(
    evidence.authorization,
    "Integration Control authorization",
  );
  requireExactKeys(
    authorization,
    ["authorizedAtMs", "permission", "policyDecisionId", "subjectId"],
    "Integration Control authorization",
  );
  const confirmation = requireRecord(
    evidence.confirmation,
    "Integration Control confirmation",
  );
  requireExactKeys(
    confirmation,
    ["confirmationId", "confirmedAtMs", "subjectId"],
    "Integration Control confirmation",
  );
  if (
    authorization.permission !== "integration.device.control" ||
    authorization.subjectId !== subject.subjectId ||
    confirmation.subjectId !== subject.subjectId
  ) {
    throw new McpInputError(
      "Integration Control governance is not bound to the authenticated subject",
    );
  }
  return Object.freeze({
    authorization: Object.freeze({
      policyDecisionId: requireString(
        authorization.policyDecisionId,
        "policyDecisionId",
      ),
      subjectId: subject.subjectId,
      permission: "integration.device.control",
      authorizedAtMs: requireUint64(
        authorization.authorizedAtMs,
        "authorizedAtMs",
      ),
    }),
    confirmation: Object.freeze({
      confirmationId: requireString(
        confirmation.confirmationId,
        "confirmationId",
        uuidPattern,
      ),
      subjectId: subject.subjectId,
      confirmedAtMs: requireUint64(confirmation.confirmedAtMs, "confirmedAtMs"),
    }),
  });
}

function decodeAuditResource(uri: URL): Record<string, unknown> {
  const allowed = new Set(["cursor", "limit"]);
  if ([...uri.searchParams.keys()].some((key) => !allowed.has(key))) {
    throw new McpInputError(
      "Audit resource query contains an unsupported field",
    );
  }
  for (const key of allowed) {
    if (uri.searchParams.getAll(key).length > 1) {
      throw new McpInputError(`${key} must occur at most once`);
    }
  }
  const query: Record<string, unknown> = {};
  const cursor = uri.searchParams.get("cursor");
  if (cursor !== null) query.cursor = cursor;
  const rawLimit = uri.searchParams.get("limit");
  if (rawLimit !== null) {
    if (!/^[0-9]{1,3}$/.test(rawLimit)) {
      throw new McpInputError("limit must be a decimal integer");
    }
    query.limit = Number.parseInt(rawLimit, 10);
  }
  return query;
}

function decodeIntegrationProjectionResource(uri: URL): Readonly<{
  gatewayId: string;
  integrationId: string;
}> {
  if (
    uri.search !== "" ||
    uri.hash !== "" ||
    uri.username !== "" ||
    uri.password !== "" ||
    uri.port !== ""
  ) {
    throw new McpInputError(
      "Integration projection resource does not accept additional URI fields",
    );
  }
  const segments = uri.pathname.split("/").filter((segment) => segment !== "");
  if (
    segments.length !== 3 ||
    segments[0] !== "projections" ||
    segments.some((segment) => segment.includes("%"))
  ) {
    throw new McpInputError("Integration projection resource path is invalid");
  }
  return Object.freeze({
    gatewayId: requireString(segments[1], "gatewayId", uuidPattern),
    integrationId: requireString(segments[2], "integrationId"),
  });
}

function decodeIntegrationProjectionCatalogResource(
  uri: URL,
): Record<string, unknown> {
  if (
    uri.pathname !== "/projections" ||
    uri.hash !== "" ||
    uri.username !== "" ||
    uri.password !== "" ||
    uri.port !== ""
  ) {
    throw new McpInputError(
      "Integration projection catalog resource URI is invalid",
    );
  }
  const allowed = new Set(["cursor", "gatewayId", "limit"]);
  if ([...uri.searchParams.keys()].some((key) => !allowed.has(key))) {
    throw new McpInputError(
      "Integration projection catalog query contains an unsupported field",
    );
  }
  for (const key of allowed) {
    if (uri.searchParams.getAll(key).length > 1) {
      throw new McpInputError(`${key} must occur at most once`);
    }
  }
  const input: Record<string, unknown> = {};
  const gatewayId = uri.searchParams.get("gatewayId");
  if (gatewayId !== null) {
    input.gatewayId = requireString(gatewayId, "gatewayId", uuidPattern);
  }
  const cursor = uri.searchParams.get("cursor");
  if (cursor !== null) {
    input.cursor = requireString(cursor, "cursor", opaqueCursorPattern);
  }
  const rawLimit = uri.searchParams.get("limit");
  if (rawLimit !== null) {
    if (!/^[0-9]{1,3}$/.test(rawLimit)) {
      throw new McpInputError("limit must be a decimal integer");
    }
    const limit = Number.parseInt(rawLimit, 10);
    if (limit < 1 || limit > 100) {
      throw new McpInputError("limit must be from 1-100");
    }
    input.limit = limit;
  }
  return input;
}

function toolSchema(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: [
      "confirmation",
      "expiresAt",
      "idempotencyKey",
      "input",
      "issuedAt",
    ],
    properties: Object.freeze({
      confirmation: Object.freeze({
        type: "string",
        enum: Object.freeze(["confirmed", "not-confirmed"]),
      }),
      expiresAt: Object.freeze({ type: "string", format: "date-time" }),
      idempotencyKey: Object.freeze({ type: "string", minLength: 8 }),
      input: Object.freeze({ type: "object" }),
      issuedAt: Object.freeze({ type: "string", format: "date-time" }),
    }),
  });
}

function integrationPowerToolSchema(): Readonly<Record<string, unknown>> {
  const base = toolSchema();
  const properties = requireRecord(
    base.properties,
    "Integration Control tool schema",
  );
  return Object.freeze({
    ...base,
    properties: Object.freeze({
      ...properties,
      input: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: Object.freeze([
          "entityId",
          "gatewayId",
          "integrationId",
          "jobExpiresAtMs",
          "jobId",
          "snapshotGeneration",
          "value",
        ]),
        properties: Object.freeze({
          entityId: Object.freeze({ type: "string" }),
          gatewayId: Object.freeze({ type: "string", format: "uuid" }),
          integrationId: Object.freeze({ type: "string" }),
          jobExpiresAtMs: Object.freeze({
            type: "string",
            pattern: "^(?:0|[1-9][0-9]*)$",
          }),
          jobId: Object.freeze({ type: "string", format: "uuid" }),
          snapshotGeneration: Object.freeze({
            type: "string",
            pattern: "^(?:0|[1-9][0-9]*)$",
          }),
          value: Object.freeze({ type: "boolean" }),
        }),
      }),
    }),
  });
}

function toolDescriptor(
  definition: CommandDefinition,
  description: string,
  inputSchema: Readonly<Record<string, unknown>> = toolSchema(),
): McpToolDescriptor {
  return Object.freeze({
    name: definition.name,
    description,
    permission: definition.permission,
    risk: definition.risk,
    confirmation: definition.confirmation,
    idempotency: definition.idempotency,
    expiry: definition.expiry,
    audit: definition.audit,
    status: "partial",
    inputSchema,
  });
}

const baseTools = Object.freeze([
  toolDescriptor(
    REQUEST_DATA_EXPORT_COMMAND,
    "Request a governed asynchronous export through the application command",
  ),
  toolDescriptor(
    CREATE_GOVERNED_JOB_COMMAND,
    "Create declared edge work; capability policy and edge authority still apply",
  ),
]);

const integrationControlTool = toolDescriptor(
  CREATE_INTEGRATION_POWER_CONTROL_COMMAND,
  "Request one confirmed semantic power action and wait for authoritative edge evidence",
  integrationPowerToolSchema(),
);

const baseResources = Object.freeze<McpResourceDescriptor[]>([
  Object.freeze({
    name: "AetherCloud capability exposure",
    description:
      "Discover application and MCP implementation status before calling",
    mimeType: "application/json",
    uri: "aethercloud://capabilities",
  }),
  Object.freeze({
    name: "Tenant Audit events",
    description:
      "Read a bounded Tenant/Project audit page through SearchAuditEvents",
    mimeType: "application/json",
    uriTemplate: "aethercloud://audit/events{?cursor,limit}",
  }),
]);

const integrationProjectionResource = Object.freeze({
  name: "Integration projection",
  description:
    "Read one normalized edge-reported Integration topology and current observation projection",
  mimeType: "application/json" as const,
  uriTemplate:
    "aethercloud://integration/projections/{gatewayId}/{integrationId}",
});

const integrationProjectionCatalogResource = Object.freeze({
  name: "Integration projection catalog",
  description:
    "Discover bounded summaries of normalized edge-reported Integration projections",
  mimeType: "application/json" as const,
  uriTemplate: "aethercloud://integration/projections{?gatewayId,cursor,limit}",
});

function capabilityExposure(
  tools: readonly McpToolDescriptor[],
  hasIntegrationProjection: boolean,
  hasIntegrationProjectionCatalog: boolean,
) {
  return Object.freeze([
    Object.freeze({
      name: SEARCH_AUDIT_EVENTS_QUERY.name,
      kind: SEARCH_AUDIT_EVENTS_QUERY.kind,
      permission: SEARCH_AUDIT_EVENTS_QUERY.permission,
      applicationStatus: "partial",
      mcpStatus: "implemented-resource",
    }),
    ...(hasIntegrationProjection
      ? [
          Object.freeze({
            name: GET_INTEGRATION_PROJECTION_QUERY.name,
            kind: GET_INTEGRATION_PROJECTION_QUERY.kind,
            permission: GET_INTEGRATION_PROJECTION_QUERY.permission,
            applicationStatus: "partial",
            mcpStatus: "implemented-resource",
          }),
        ]
      : []),
    ...(hasIntegrationProjectionCatalog
      ? [
          Object.freeze({
            name: LIST_INTEGRATION_PROJECTIONS_QUERY.name,
            kind: LIST_INTEGRATION_PROJECTIONS_QUERY.kind,
            permission: LIST_INTEGRATION_PROJECTIONS_QUERY.permission,
            applicationStatus: "partial",
            mcpStatus: "implemented-resource",
          }),
        ]
      : []),
    ...tools.map((tool) =>
      Object.freeze({
        name: tool.name,
        kind: "command",
        permission: tool.permission,
        risk: tool.risk,
        confirmation: tool.confirmation,
        idempotency: tool.idempotency,
        expiry: tool.expiry,
        audit: tool.audit,
        applicationStatus: tool.status,
        mcpStatus: "implemented-tool",
      }),
    ),
    Object.freeze({
      name: "integration.webhook.subscription.create",
      kind: "command",
      permission: "integration.webhook.subscription.create",
      risk: "high",
      confirmation: "explicit",
      idempotency: "required",
      expiry: "required",
      audit: "required",
      applicationStatus: "partial",
      mcpStatus: "planned",
    }),
    ...(tools.includes(integrationControlTool)
      ? []
      : [
          Object.freeze({
            name: CREATE_INTEGRATION_POWER_CONTROL_COMMAND.name,
            kind: "command",
            permission: CREATE_INTEGRATION_POWER_CONTROL_COMMAND.permission,
            risk: CREATE_INTEGRATION_POWER_CONTROL_COMMAND.risk,
            confirmation: CREATE_INTEGRATION_POWER_CONTROL_COMMAND.confirmation,
            idempotency: CREATE_INTEGRATION_POWER_CONTROL_COMMAND.idempotency,
            expiry: CREATE_INTEGRATION_POWER_CONTROL_COMMAND.expiry,
            audit: CREATE_INTEGRATION_POWER_CONTROL_COMMAND.audit,
            applicationStatus: "partial",
            mcpStatus: "not-exposed",
          }),
        ]),
  ]);
}

function parseResourceUri(input: string): URL {
  let uri: URL;
  try {
    uri = new URL(input);
  } catch {
    throw new McpInputError("resource uri is invalid");
  }
  if (uri.protocol !== "aethercloud:") {
    throw new McpInputError("resource uri scheme is unsupported");
  }
  return uri;
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export class AetherCloudMcpInterface {
  readonly #searchAuditEvents: ApplicationUseCase;
  readonly #createGovernedJob: ApplicationUseCase;
  readonly #requestDataExport: ApplicationUseCase;
  readonly #getIntegrationProjection: ApplicationUseCase | undefined;
  readonly #listIntegrationProjections: ApplicationUseCase | undefined;
  readonly #createIntegrationPowerControl: ApplicationUseCase | undefined;
  readonly #integrationControlGovernance:
    | IntegrationControlGovernanceResolver
    | undefined;
  readonly #tools: readonly McpToolDescriptor[];
  readonly #resources: readonly McpResourceDescriptor[];
  readonly #capabilityExposure: readonly unknown[];

  constructor(dependencies: AetherCloudMcpDependencies) {
    if (
      (dependencies.createIntegrationPowerControl === undefined) !==
      (dependencies.integrationControlGovernance === undefined)
    ) {
      throw new TypeError(
        "Integration Control MCP exposure requires both the use case and trusted governance resolver",
      );
    }
    this.#searchAuditEvents = dependencies.searchAuditEvents;
    this.#createGovernedJob = dependencies.createGovernedJob;
    this.#requestDataExport = dependencies.requestDataExport;
    this.#getIntegrationProjection = dependencies.getIntegrationProjection;
    this.#listIntegrationProjections = dependencies.listIntegrationProjections;
    this.#createIntegrationPowerControl =
      dependencies.createIntegrationPowerControl;
    this.#integrationControlGovernance =
      dependencies.integrationControlGovernance;
    this.#tools =
      this.#createIntegrationPowerControl === undefined
        ? baseTools
        : Object.freeze([...baseTools, integrationControlTool]);
    this.#resources = Object.freeze([
      ...baseResources,
      ...(this.#listIntegrationProjections === undefined
        ? []
        : [integrationProjectionCatalogResource]),
      ...(this.#getIntegrationProjection === undefined
        ? []
        : [integrationProjectionResource]),
    ]);
    this.#capabilityExposure = capabilityExposure(
      this.#tools,
      this.#getIntegrationProjection !== undefined,
      this.#listIntegrationProjections !== undefined,
    );
  }

  listResources(): readonly McpResourceDescriptor[] {
    return this.#resources;
  }

  listTools(): readonly McpToolDescriptor[] {
    return this.#tools;
  }

  async readResource(
    rawSubject: unknown,
    rawRequest: unknown,
  ): Promise<McpInterfaceResult<McpReadResourceResult>> {
    try {
      const subject = decodeSubject(rawSubject);
      const requestedUri = decodeResourceRequest(rawRequest);
      const uri = parseResourceUri(requestedUri);
      if (uri.hostname === "capabilities" && uri.pathname === "") {
        if (uri.search !== "") {
          return failure(
            "invalid-input",
            "Capability resource has no query fields",
          );
        }
        return {
          ok: true,
          value: {
            contents: Object.freeze([
              Object.freeze({
                uri: requestedUri,
                mimeType: "application/json",
                text: encodeJson({
                  capabilities: this.#capabilityExposure,
                }),
              }),
            ]),
          },
        };
      }
      if (uri.hostname === "audit" && uri.pathname === "/events") {
        const query = decodeAuditResource(uri);
        const result = await this.#searchAuditEvents.execute(subject, query);
        if (!result.ok) return result;
        return {
          ok: true,
          value: {
            contents: Object.freeze([
              Object.freeze({
                uri: requestedUri,
                mimeType: "application/json",
                text: encodeJson(result.value),
              }),
            ]),
          },
        };
      }
      if (uri.hostname === "integration") {
        if (uri.pathname === "/projections") {
          if (this.#listIntegrationProjections === undefined) {
            return failure(
              "mcp-resource-not-found",
              `${requestedUri} is not an exposed AetherCloud resource`,
            );
          }
          const input = decodeIntegrationProjectionCatalogResource(uri);
          const result = await this.#listIntegrationProjections.execute(
            subject,
            input,
          );
          if (!result.ok) return result;
          return {
            ok: true,
            value: {
              contents: Object.freeze([
                Object.freeze({
                  uri: requestedUri,
                  mimeType: "application/json",
                  text: encodeJson(result.value),
                }),
              ]),
            },
          };
        }
        if (this.#getIntegrationProjection === undefined) {
          return failure(
            "mcp-resource-not-found",
            `${requestedUri} is not an exposed AetherCloud resource`,
          );
        }
        const input = decodeIntegrationProjectionResource(uri);
        const result = await this.#getIntegrationProjection.execute(
          subject,
          input,
        );
        if (!result.ok) return result;
        return {
          ok: true,
          value: {
            contents: Object.freeze([
              Object.freeze({
                uri: requestedUri,
                mimeType: "application/json",
                text: encodeJson(result.value),
              }),
            ]),
          },
        };
      }
      return failure(
        "mcp-resource-not-found",
        `${requestedUri} is not an exposed AetherCloud resource`,
      );
    } catch (error: unknown) {
      if (error instanceof McpInputError) {
        return failure("invalid-input", error.message);
      }
      throw error;
    }
  }

  async callTool(
    rawSubject: unknown,
    rawCall: unknown,
  ): Promise<McpInterfaceResult<McpToolCallResult>> {
    try {
      const subject = decodeSubject(rawSubject);
      const call = decodeToolCall(rawCall);
      if (call.name === CREATE_INTEGRATION_POWER_CONTROL_COMMAND.name) {
        if (
          this.#createIntegrationPowerControl === undefined ||
          this.#integrationControlGovernance === undefined
        ) {
          return failure(
            "mcp-tool-not-implemented",
            `${call.name} is not exposed as an MCP tool`,
          );
        }
        const envelope = decodeToolEnvelope(call.arguments);
        if (envelope.confirmation !== "confirmed") {
          return failure(
            "confirmation-required",
            "Integration Control requires explicit confirmation",
          );
        }
        const action = decodeIntegrationPowerAction(envelope.input);
        const governance = await this.#integrationControlGovernance.resolve({
          subject,
          idempotencyKey: envelope.idempotencyKey,
          issuedAt: envelope.issuedAt,
          expiresAt: envelope.expiresAt,
          action,
        });
        if (!governance.ok) return governance;
        const evidence = decodeIntegrationControlGovernanceEvidence(
          governance.value,
          subject,
        );
        const result = await this.#createIntegrationPowerControl.execute(
          {
            ...subject,
            idempotencyKey: envelope.idempotencyKey,
            issuedAt: envelope.issuedAt,
            expiresAt: envelope.expiresAt,
            authorization: evidence.authorization,
            confirmation: evidence.confirmation,
          },
          action,
        );
        if (!result.ok) return result;
        const value = requireRecord(
          result.value,
          "Integration Control application result",
        );
        const intent = requireRecord(
          value.intent,
          "Integration Control persisted intent",
        );
        const jobId = requireString(intent.jobId, "Integration Control jobId");
        if (
          value.providerAccepted !== false ||
          value.physicalCompleted !== false ||
          value.jobSucceeded !== false
        ) {
          return failure(
            "invalid-application-result",
            "Integration Control application result overclaims execution evidence",
          );
        }
        const structuredContent = Object.freeze({
          status: "accepted-awaiting-edge-evidence" as const,
          jobId,
          providerAccepted: false as const,
          physicalCompleted: false as const,
          jobSucceeded: false as const,
        });
        return {
          ok: true,
          value: {
            content: Object.freeze([
              Object.freeze({
                type: "text",
                text: "已受理，正在等待边缘端证据。",
              }),
            ]),
            structuredContent,
            replayed: result.replayed ?? false,
          },
        };
      }
      const useCase =
        call.name === REQUEST_DATA_EXPORT_COMMAND.name
          ? this.#requestDataExport
          : call.name === CREATE_GOVERNED_JOB_COMMAND.name
            ? this.#createGovernedJob
            : undefined;
      if (useCase === undefined) {
        return failure(
          "mcp-tool-not-implemented",
          `${call.name} is not exposed as an MCP tool`,
        );
      }
      const envelope = decodeToolEnvelope(call.arguments);
      const result = await useCase.execute(
        {
          ...subject,
          confirmation: envelope.confirmation,
          idempotencyKey: envelope.idempotencyKey,
          issuedAt: envelope.issuedAt,
          expiresAt: envelope.expiresAt,
        },
        envelope.input,
      );
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          content: Object.freeze([
            Object.freeze({ type: "text", text: encodeJson(result.value) }),
          ]),
          structuredContent: result.value,
          replayed: result.replayed ?? false,
        },
      };
    } catch (error: unknown) {
      if (error instanceof McpInputError) {
        return failure("invalid-input", error.message);
      }
      throw error;
    }
  }
}
