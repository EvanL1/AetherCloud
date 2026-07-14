import {
  CREATE_GOVERNED_JOB_COMMAND,
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

export interface AetherCloudMcpDependencies {
  readonly searchAuditEvents: ApplicationUseCase;
  readonly createGovernedJob: ApplicationUseCase;
  readonly requestDataExport: ApplicationUseCase;
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

function toolDescriptor(
  definition: CommandDefinition,
  description: string,
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
    inputSchema: toolSchema(),
  });
}

const tools = Object.freeze([
  toolDescriptor(
    REQUEST_DATA_EXPORT_COMMAND,
    "Request a governed asynchronous export through the application command",
  ),
  toolDescriptor(
    CREATE_GOVERNED_JOB_COMMAND,
    "Create declared edge work; capability policy and edge authority still apply",
  ),
]);

const resources = Object.freeze<McpResourceDescriptor[]>([
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

const capabilityExposure = Object.freeze([
  Object.freeze({
    name: SEARCH_AUDIT_EVENTS_QUERY.name,
    kind: SEARCH_AUDIT_EVENTS_QUERY.kind,
    permission: SEARCH_AUDIT_EVENTS_QUERY.permission,
    applicationStatus: "partial",
    mcpStatus: "implemented-resource",
  }),
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
]);

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

  constructor(dependencies: AetherCloudMcpDependencies) {
    this.#searchAuditEvents = dependencies.searchAuditEvents;
    this.#createGovernedJob = dependencies.createGovernedJob;
    this.#requestDataExport = dependencies.requestDataExport;
  }

  listResources(): readonly McpResourceDescriptor[] {
    return resources;
  }

  listTools(): readonly McpToolDescriptor[] {
    return tools;
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
                text: encodeJson({ capabilities: capabilityExposure }),
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
