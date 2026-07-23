import { getPlatformProfile } from "@aether-cloud/application";
import type { SearchAuditEvents } from "@aether-cloud/application";
import Fastify from "fastify";

import { registerMcpHttp } from "./mcp-http.js";
import type { McpHttpDependencies } from "./mcp-http.js";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface HttpAuthenticatedSubject {
  readonly tenantId: string;
  readonly projectId: string;
  readonly subjectId: string;
  readonly permissions: readonly string[];
}

export type HttpAuthenticationResult =
  | Readonly<{ ok: true; value: HttpAuthenticatedSubject }>
  | Readonly<{
      ok: false;
      failure: Readonly<{ code: "unauthenticated" }>;
    }>;

export interface HttpAuthenticator {
  authenticate(
    input: Readonly<{
      authorization: string | undefined;
    }>,
  ): Promise<HttpAuthenticationResult>;
}

export interface AuditHttpDependencies {
  readonly query: SearchAuditEvents;
  readonly authenticator: HttpAuthenticator;
}

export interface BuildAppOptions {
  readonly version: string;
  readonly audit?: AuditHttpDependencies;
  readonly mcp?: McpHttpDependencies;
}

const healthResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "service", "version"],
  properties: {
    status: { const: "ok", type: "string" },
    service: { const: "aether-cloud-api", type: "string" },
    version: { type: "string", minLength: 1 },
  },
} as const;

const platformResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "role", "authority", "multiCloud"],
  properties: {
    name: { const: "AetherCloud", type: "string" },
    role: {
      const: "ai-native-multi-cloud-iot-control-plane",
      type: "string",
    },
    authority: {
      type: "object",
      additionalProperties: false,
      required: [
        "livePointState",
        "physicalControl",
        "tenantIdentity",
        "desiredRevision",
        "placementPolicy",
        "actualInfrastructure",
      ],
      properties: {
        livePointState: { const: "edge", type: "string" },
        physicalControl: { const: "edge", type: "string" },
        tenantIdentity: { const: "aether-cloud", type: "string" },
        desiredRevision: { const: "aether-cloud", type: "string" },
        placementPolicy: { const: "aether-cloud", type: "string" },
        actualInfrastructure: { const: "provider", type: "string" },
      },
    },
    multiCloud: {
      type: "object",
      additionalProperties: false,
      required: ["providerModel", "executionEngines", "stateIsolation"],
      properties: {
        providerModel: {
          const: "capability-driven-adapters",
          type: "string",
        },
        executionEngines: {
          type: "array",
          prefixItems: [
            { const: "opentofu", type: "string" },
            { const: "terraform", type: "string" },
          ],
          minItems: 2,
          maxItems: 2,
        },
        stateIsolation: { const: "deployment-stack", type: "string" },
      },
    },
  },
} as const;

const errorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "correlationId"],
      properties: {
        code: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1 },
        correlationId: { type: "string", minLength: 1 },
      },
    },
  },
} as const;

const auditEventResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "eventId",
    "sequence",
    "occurredAt",
    "subject",
    "action",
    "resource",
    "outcome",
    "risk",
    "confirmation",
    "correlationId",
  ],
  properties: {
    eventId: { type: "string" },
    sequence: { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" },
    occurredAt: { type: "string", format: "date-time" },
    subject: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "subjectId"],
      properties: {
        kind: { type: "string" },
        subjectId: { type: "string" },
      },
    },
    action: { type: "string" },
    resource: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "resourceId"],
      properties: {
        kind: { type: "string" },
        resourceId: { type: "string" },
      },
    },
    outcome: { type: "string" },
    risk: { type: "string" },
    confirmation: { type: "string" },
    correlationId: { type: "string" },
    traceId: { type: "string" },
    detailsDigest: { type: "string" },
  },
} as const;

const auditSearchResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", items: auditEventResponseSchema },
    nextCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
} as const;

class HttpQueryInputError extends Error {}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function decodeAuditQuery(input: unknown): Record<string, unknown> {
  if (!isRecord(input))
    throw new HttpQueryInputError("query must be an object");
  const allowed = new Set([
    "action",
    "cursor",
    "from",
    "limit",
    "resourceId",
    "resourceKind",
    "subjectId",
    "to",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new HttpQueryInputError("query contains an unsupported field");
  }
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") {
      throw new HttpQueryInputError(`${key} must occur once as a string`);
    }
  }
  const rawLimit = input.limit ?? "50";
  if (typeof rawLimit !== "string" || !/^[0-9]{1,3}$/.test(rawLimit)) {
    throw new HttpQueryInputError("limit must be a decimal integer");
  }
  const limit = Number.parseInt(rawLimit, 10);
  const decoded: Record<string, unknown> = { limit };
  for (const key of allowed) {
    if (key !== "limit" && input[key] !== undefined) decoded[key] = input[key];
  }
  return decoded;
}

function sendError(
  reply: FastifyReply,
  statusCode: 400 | 401 | 403,
  code: string,
  message: string,
  correlationId: string,
) {
  return reply.status(statusCode).send({
    error: { code, message, correlationId },
  });
}

function encodeAuditSse(
  items: readonly Readonly<{ sequence: string }>[],
): string {
  const frames = items.map((item) =>
    [
      `id: ${item.sequence}`,
      "event: audit.event",
      `data: ${JSON.stringify(item)}`,
      "",
    ].join("\n"),
  );
  return `${frames.join("\n")}\n: snapshot-complete\n\n`;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get(
    "/health",
    {
      schema: {
        response: { 200: healthResponseSchema },
      },
    },
    () => ({
      status: "ok",
      service: "aether-cloud-api",
      version: options.version,
    }),
  );

  app.get(
    "/api/v1/platform",
    {
      schema: {
        response: { 200: platformResponseSchema },
      },
    },
    () => getPlatformProfile(),
  );

  const mcp = options.mcp;
  if (mcp !== undefined) {
    registerMcpHttp(app, mcp, options.version);
  }

  const audit = options.audit;
  if (audit !== undefined) {
    app.get(
      "/api/v1/audit/events",
      {
        schema: {
          response: {
            200: auditSearchResponseSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const correlationId = request.id;
        reply.header("x-correlation-id", correlationId);
        const authentication = await audit.authenticator.authenticate({
          authorization: request.headers.authorization,
        });
        if (!authentication.ok) {
          return sendError(
            reply,
            401,
            "unauthenticated",
            "authentication is required",
            correlationId,
          );
        }
        let query: Record<string, unknown>;
        try {
          query = decodeAuditQuery(request.query);
        } catch (error: unknown) {
          if (error instanceof HttpQueryInputError) {
            return sendError(
              reply,
              400,
              "invalid-input",
              error.message,
              correlationId,
            );
          }
          throw error;
        }
        const result = await audit.query.execute(authentication.value, query);
        if (!result.ok) {
          const status =
            result.failure.code === "permission-denied" ? 403 : 400;
          return sendError(
            reply,
            status,
            result.failure.code,
            result.failure.message,
            correlationId,
          );
        }
        return reply.status(200).send(result.value);
      },
    );

    app.get("/api/v1/audit/events/stream", async (request, reply) => {
      const correlationId = request.id;
      reply.header("x-correlation-id", correlationId);
      const authentication = await audit.authenticator.authenticate({
        authorization: request.headers.authorization,
      });
      if (!authentication.ok) {
        return sendError(
          reply,
          401,
          "unauthenticated",
          "authentication is required",
          correlationId,
        );
      }
      let query: Record<string, unknown>;
      try {
        query = decodeAuditQuery(request.query);
        const lastEventId = request.headers["last-event-id"];
        if (Array.isArray(lastEventId)) {
          throw new HttpQueryInputError("last-event-id must occur once");
        }
        if (lastEventId !== undefined) {
          if (query.cursor !== undefined && query.cursor !== lastEventId) {
            throw new HttpQueryInputError(
              "cursor and last-event-id must agree",
            );
          }
          query.cursor = lastEventId;
        }
      } catch (error: unknown) {
        if (error instanceof HttpQueryInputError) {
          return sendError(
            reply,
            400,
            "invalid-input",
            error.message,
            correlationId,
          );
        }
        throw error;
      }
      const result = await audit.query.execute(authentication.value, query);
      if (!result.ok) {
        const status = result.failure.code === "permission-denied" ? 403 : 400;
        return sendError(
          reply,
          status,
          result.failure.code,
          result.failure.message,
          correlationId,
        );
      }
      reply.header("cache-control", "no-cache, no-transform");
      reply.header("x-content-type-options", "nosniff");
      return reply
        .type("text/event-stream; charset=utf-8")
        .status(200)
        .send(encodeAuditSse(result.value.items));
    });
  }

  return app;
}

export type { McpHttpDependencies, McpHttpInterface } from "./mcp-http.js";
