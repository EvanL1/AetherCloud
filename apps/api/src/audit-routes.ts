import type { AuditApplicationFailure } from "@aether-cloud/application";

import type { FastifyInstance } from "fastify";

import type { AuditHttpDependencies } from "./app.js";
import { errorResponseSchema, isRecord, sendError } from "./http-responses.js";

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

function auditFailureStatus(
  code: AuditApplicationFailure["code"],
): 400 | 403 | 503 {
  if (code === "permission-denied") return 403;
  if (code === "storage-unavailable") return 503;
  return 400;
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

export function registerAuditRoutes(
  app: FastifyInstance,
  audit: AuditHttpDependencies,
): void {
  app.get(
    "/api/v1/audit/events",
    {
      schema: {
        response: {
          200: auditSearchResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          503: errorResponseSchema,
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
        return sendError(
          reply,
          auditFailureStatus(result.failure.code),
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
          throw new HttpQueryInputError("cursor and last-event-id must agree");
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
      return sendError(
        reply,
        auditFailureStatus(result.failure.code),
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
