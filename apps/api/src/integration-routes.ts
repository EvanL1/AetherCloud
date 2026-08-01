import type {
  GetIntegrationProjection,
  IntegrationProjectionCatalogFailure,
  IntegrationProjectionFailure,
  ListIntegrationProjections,
} from "@aether-cloud/application";

import type { FastifyInstance } from "fastify";

import type { HttpAuthenticator } from "./app.js";
import { errorResponseSchema, isRecord, sendError } from "./http-responses.js";

export interface IntegrationHttpDependencies {
  readonly authenticator: HttpAuthenticator;
  readonly list: Pick<ListIntegrationProjections, "execute">;
  readonly get: Pick<GetIntegrationProjection, "execute">;
}

const boundedIdSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
} as const;

const boundedTextSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
} as const;

const unsigned64Schema = {
  type: "string",
  pattern: "^(?:0|[1-9][0-9]*)$",
} as const;

const catalogItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "gatewayId",
    "integrationId",
    "integrationKind",
    "snapshotGeneration",
    "entityCount",
    "latestObservationCount",
    "receivedAt",
    "revision",
  ],
  properties: {
    gatewayId: { type: "string", format: "uuid" },
    integrationId: boundedIdSchema,
    integrationKind: boundedIdSchema,
    snapshotGeneration: unsigned64Schema,
    entityCount: { type: "integer", minimum: 0 },
    latestObservationCount: { type: "integer", minimum: 0 },
    receivedAt: { type: "string", format: "date-time" },
    revision: { type: "integer", minimum: 1 },
  },
} as const;

const catalogSchema = {
  type: "object",
  additionalProperties: false,
  required: ["authority", "liveStateAuthoritative", "items"],
  properties: {
    authority: { const: "edge-reported-copy", type: "string" },
    liveStateAuthoritative: { const: false, type: "boolean" },
    items: { type: "array", items: catalogItemSchema },
    nextCursor: { type: "string", minLength: 1, maxLength: 512 },
  },
} as const;

const topologyAreaSchema = {
  type: "object",
  additionalProperties: false,
  required: ["areaId", "name"],
  properties: {
    areaId: boundedIdSchema,
    name: boundedTextSchema,
  },
} as const;

const topologyDeviceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["deviceId", "name"],
  properties: {
    deviceId: boundedIdSchema,
    name: boundedTextSchema,
    areaId: boundedIdSchema,
    manufacturer: boundedTextSchema,
    model: boundedTextSchema,
    softwareVersion: boundedIdSchema,
    hardwareVersion: boundedIdSchema,
  },
} as const;

const topologyPointSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pointKey", "title", "kind", "valueType"],
  properties: {
    pointKey: boundedIdSchema,
    title: boundedTextSchema,
    kind: { enum: ["event", "status", "telemetry"], type: "string" },
    valueType: {
      enum: [
        "boolean",
        "bytes",
        "decimal",
        "float64",
        "int64",
        "string",
        "uint64",
      ],
      type: "string",
    },
    unit: { type: "string", minLength: 1, maxLength: 32 },
  },
} as const;

const topologyEntitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["entityId", "sourceAddress", "name", "entityKind", "points"],
  properties: {
    entityId: boundedIdSchema,
    sourceAddress: boundedIdSchema,
    name: boundedTextSchema,
    entityKind: boundedIdSchema,
    deviceId: boundedIdSchema,
    areaId: boundedIdSchema,
    points: { type: "array", items: topologyPointSchema },
  },
} as const;

const topologySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "integrationId",
    "integrationKind",
    "snapshotGeneration",
    "observedAtMs",
    "areas",
    "devices",
    "entities",
  ],
  properties: {
    schema: boundedIdSchema,
    integrationId: boundedIdSchema,
    integrationKind: boundedIdSchema,
    snapshotGeneration: unsigned64Schema,
    observedAtMs: unsigned64Schema,
    areas: { type: "array", items: topologyAreaSchema },
    devices: { type: "array", items: topologyDeviceSchema },
    entities: { type: "array", items: topologyEntitySchema },
  },
} as const;

const observationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entityId", "pointKey", "observedAtMs", "quality"],
  properties: {
    entityId: boundedIdSchema,
    pointKey: boundedIdSchema,
    observedAtMs: unsigned64Schema,
    quality: {
      enum: ["bad", "good", "uncertain", "unavailable"],
      type: "string",
    },
    value: {
      type: "object",
      additionalProperties: false,
      required: ["type", "value"],
      properties: {
        type: {
          enum: [
            "boolean",
            "bytes",
            "decimal",
            "float64",
            "int64",
            "string",
            "uint64",
          ],
          type: "string",
        },
        encoding: { const: "base64url", type: "string" },
        // The observed value is a boolean, a number, or bounded text depending
        // on the declared type. The domain guarantees it is a scalar, so the
        // serializer copies it through instead of narrowing it per variant.
        value: {},
      },
    },
    diagnostic: { type: "string", minLength: 1, maxLength: 512 },
  },
} as const;

const projectionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "authority",
    "liveStateAuthoritative",
    "tenantId",
    "projectId",
    "gatewayId",
    "integrationId",
    "topology",
    "topologyDigest",
    "latestObservations",
    "receivedAt",
    "revision",
  ],
  properties: {
    authority: { const: "edge-reported-copy", type: "string" },
    liveStateAuthoritative: { const: false, type: "boolean" },
    tenantId: { type: "string", format: "uuid" },
    projectId: { type: "string", format: "uuid" },
    gatewayId: { type: "string", format: "uuid" },
    integrationId: boundedIdSchema,
    topology: topologySchema,
    topologyDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    latestObservations: { type: "array", items: observationSchema },
    receivedAt: { type: "string", format: "date-time" },
    revision: { type: "integer", minimum: 1 },
  },
} as const;

function catalogFailureStatus(
  code: IntegrationProjectionCatalogFailure["code"],
): 400 | 403 | 503 {
  if (code === "permission-denied") return 403;
  if (
    code === "integration-storage-unavailable" ||
    code === "invalid-integration-repository-result"
  ) {
    return 503;
  }
  return 400;
}

function projectionFailureStatus(
  code: IntegrationProjectionFailure["code"],
): 400 | 403 | 404 | 503 {
  if (code === "permission-denied") return 403;
  if (code === "integration-projection-not-found") return 404;
  if (
    code === "integration-storage-unavailable" ||
    code === "invalid-integration-repository-result"
  ) {
    return 503;
  }
  return 400;
}

export function registerIntegrationRoutes(
  app: FastifyInstance,
  integrations: IntegrationHttpDependencies,
): void {
  app.get(
    "/api/v1/integrations",
    {
      schema: {
        response: {
          200: catalogSchema,
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
      const authentication = await integrations.authenticator.authenticate({
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
      if (!isRecord(request.query)) {
        return sendError(
          reply,
          400,
          "invalid-input",
          "query must be an object",
          correlationId,
        );
      }
      const allowed = new Set(["cursor", "gatewayId", "limit"]);
      if (Object.keys(request.query).some((key) => !allowed.has(key))) {
        return sendError(
          reply,
          400,
          "invalid-input",
          "query contains an unsupported field",
          correlationId,
        );
      }
      const rawLimit = request.query.limit ?? "50";
      if (
        typeof rawLimit !== "string" ||
        !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit) ||
        (request.query.cursor !== undefined &&
          typeof request.query.cursor !== "string") ||
        (request.query.gatewayId !== undefined &&
          typeof request.query.gatewayId !== "string")
      ) {
        return sendError(
          reply,
          400,
          "invalid-input",
          "Integration projection query is invalid",
          correlationId,
        );
      }
      const result = await integrations.list.execute(authentication.value, {
        limit: Number.parseInt(rawLimit, 10),
        ...(request.query.cursor === undefined
          ? {}
          : { cursor: request.query.cursor }),
        ...(request.query.gatewayId === undefined
          ? {}
          : { gatewayId: request.query.gatewayId }),
      });
      if (!result.ok) {
        return sendError(
          reply,
          catalogFailureStatus(result.failure.code),
          result.failure.code,
          result.failure.message,
          correlationId,
        );
      }
      return reply.status(200).send(result.value);
    },
  );

  app.get(
    "/api/v1/integrations/:gatewayId/:integrationId",
    {
      schema: {
        response: {
          200: projectionSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const correlationId = request.id;
      reply.header("x-correlation-id", correlationId);
      const authentication = await integrations.authenticator.authenticate({
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
      const result = await integrations.get.execute(
        authentication.value,
        request.params,
      );
      if (!result.ok) {
        return sendError(
          reply,
          projectionFailureStatus(result.failure.code),
          result.failure.code,
          result.failure.message,
          correlationId,
        );
      }
      return reply.status(200).send(result.value);
    },
  );
}
