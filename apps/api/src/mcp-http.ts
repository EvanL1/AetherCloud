import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type {
  McpInterfaceResult,
  McpReadResourceResult,
  McpResourceDescriptor,
  McpToolCallResult,
  McpToolDescriptor,
} from "@aether-cloud/mcp-interface";

import type { HttpAuthenticator } from "./app.js";

/**
 * The transport-facing surface of `AetherCloudMcpInterface`. The route depends
 * on this structural type so tests and future compositions can substitute the
 * application interface without importing the concrete class.
 */
export interface McpHttpInterface {
  listTools(): readonly McpToolDescriptor[];
  listResources(): readonly McpResourceDescriptor[];
  callTool(
    rawSubject: unknown,
    rawCall: unknown,
  ): Promise<McpInterfaceResult<McpToolCallResult>>;
  readResource(
    rawSubject: unknown,
    rawRequest: unknown,
  ): Promise<McpInterfaceResult<McpReadResourceResult>>;
}

export interface McpHttpDependencies {
  readonly interface: McpHttpInterface;
  readonly authenticator: HttpAuthenticator;
}

/**
 * Stateless MCP Streamable HTTP: every request is one JSON-RPC message over
 * POST, authenticated at the HTTP layer, answered as `application/json`. The
 * server opens no SSE stream, issues no session id, and keeps no state
 * between requests, which is the spec's stateless server profile.
 */
const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];
const LATEST_PROTOCOL_VERSION = "2025-06-18";

const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;

type JsonRpcId = string | number;

interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: Readonly<{ code: number; message: string }>;
}

function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeId(value: unknown): JsonRpcId | undefined {
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}

function negotiateProtocolVersion(params: unknown): string {
  if (isRecord(params) && typeof params.protocolVersion === "string") {
    if (SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion)) {
      return params.protocolVersion;
    }
  }
  return LATEST_PROTOCOL_VERSION;
}

function listedTools(mcp: McpHttpInterface): unknown {
  return {
    tools: mcp.listTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

function listedResources(mcp: McpHttpInterface): unknown {
  return {
    resources: mcp.listResources().filter((resource) => "uri" in resource),
  };
}

function listedResourceTemplates(mcp: McpHttpInterface): unknown {
  return {
    resourceTemplates: mcp
      .listResources()
      .filter((resource) => "uriTemplate" in resource),
  };
}

async function calledTool(
  mcp: McpHttpInterface,
  subject: unknown,
  id: JsonRpcId,
  params: unknown,
): Promise<JsonRpcSuccess | JsonRpcFailure> {
  if (!isRecord(params) || typeof params.name !== "string") {
    return rpcError(id, JSONRPC_INVALID_PARAMS, "tools/call requires a name");
  }
  const outcome = await mcp.callTool(subject, {
    name: params.name,
    arguments: params.arguments ?? {},
  });
  if (!outcome.ok) {
    return success(id, {
      isError: true,
      content: [
        {
          type: "text",
          text: `${outcome.failure.code}: ${outcome.failure.message}`,
        },
      ],
    });
  }
  return success(id, {
    isError: false,
    content: outcome.value.content,
    structuredContent: outcome.value.structuredContent,
    _meta: { "aethercloud/replayed": outcome.value.replayed },
  });
}

async function readResource(
  mcp: McpHttpInterface,
  subject: unknown,
  id: JsonRpcId,
  params: unknown,
): Promise<JsonRpcSuccess | JsonRpcFailure> {
  if (!isRecord(params) || typeof params.uri !== "string") {
    return rpcError(
      id,
      JSONRPC_INVALID_PARAMS,
      "resources/read requires a uri",
    );
  }
  const outcome = await mcp.readResource(subject, { uri: params.uri });
  if (!outcome.ok) {
    return rpcError(
      id,
      JSONRPC_INVALID_PARAMS,
      `${outcome.failure.code}: ${outcome.failure.message}`,
    );
  }
  return success(id, { contents: outcome.value.contents });
}

function methodNotAllowed(_request: FastifyRequest, reply: FastifyReply) {
  return reply.status(405).header("allow", "POST").send();
}

export function registerMcpHttp(
  app: FastifyInstance,
  dependencies: McpHttpDependencies,
  version: string,
): void {
  app.get("/api/v1/mcp", methodNotAllowed);
  app.delete("/api/v1/mcp", methodNotAllowed);
  app.post("/api/v1/mcp", async (request, reply) => {
    const authentication = await dependencies.authenticator.authenticate({
      authorization: request.headers.authorization,
    });
    if (!authentication.ok) {
      return reply.status(401).send({
        error: {
          code: "unauthenticated",
          message: "authentication is required",
          correlationId: request.id,
        },
      });
    }

    const message = request.body;
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      return reply
        .status(200)
        .send(
          rpcError(
            null,
            JSONRPC_INVALID_REQUEST,
            "expected a single JSON-RPC 2.0 message; batching is not supported",
          ),
        );
    }

    const id = decodeId(message.id);
    if (id === undefined) {
      // Notifications carry no id and expect no body.
      return reply.status(202).send();
    }

    const subject = authentication.value;
    switch (message.method) {
      case "initialize":
        return reply.send(
          success(id, {
            protocolVersion: negotiateProtocolVersion(message.params),
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "aether-cloud-api", version },
          }),
        );
      case "ping":
        return reply.send(success(id, {}));
      case "tools/list":
        return reply.send(success(id, listedTools(dependencies.interface)));
      case "tools/call":
        return reply.send(
          await calledTool(dependencies.interface, subject, id, message.params),
        );
      case "resources/list":
        return reply.send(success(id, listedResources(dependencies.interface)));
      case "resources/templates/list":
        return reply.send(
          success(id, listedResourceTemplates(dependencies.interface)),
        );
      case "resources/read":
        return reply.send(
          await readResource(
            dependencies.interface,
            subject,
            id,
            message.params,
          ),
        );
      default:
        return reply.send(
          rpcError(
            id,
            JSONRPC_METHOD_NOT_FOUND,
            `unsupported method: ${String(message.method)}`,
          ),
        );
    }
  });
}
