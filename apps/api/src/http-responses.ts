import type { FastifyReply } from "fastify";

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function sendError(
  reply: FastifyReply,
  statusCode: 400 | 401 | 403 | 404 | 409 | 429 | 503,
  code: string,
  message: string,
  correlationId: string,
) {
  return reply.status(statusCode).send({
    error: { code, message, correlationId },
  });
}

export const errorResponseSchema = {
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
