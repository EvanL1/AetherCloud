import type {
  FleetQueryFailure,
  GatewayEnrollmentApplicationFailure,
} from "@aether-cloud/application";
import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";

import type { FleetHttpDependencies } from "./app.js";
import { errorResponseSchema, isRecord, sendError } from "./http-responses.js";

const fleetTelemetrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "recordCount"],
  properties: {
    status: { enum: ["no-data", "receiving"], type: "string" },
    recordCount: { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" },
    lastReceivedAt: { type: "string", format: "date-time" },
    latest: {
      type: "object",
      additionalProperties: false,
      required: [
        "streamId",
        "streamEpoch",
        "position",
        "sourceTimestampMs",
        "kind",
        "payload",
      ],
      properties: {
        streamId: { type: "string", minLength: 1 },
        streamEpoch: { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" },
        position: { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" },
        sourceTimestampMs: {
          type: "string",
          pattern: "^(?:0|[1-9][0-9]*)$",
        },
        kind: { enum: ["device-event", "point-sample"], type: "string" },
        payload: { type: "object", additionalProperties: true },
      },
    },
  },
} as const;

const fleetGatewaySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "gatewayId",
    "displayName",
    "enrollmentState",
    "revision",
    "registeredAt",
    "connection",
    "telemetry",
  ],
  properties: {
    gatewayId: { type: "string", format: "uuid" },
    displayName: { type: "string", minLength: 1, maxLength: 128 },
    enrollmentState: {
      enum: ["registered", "awaiting-claim", "claimed"],
      type: "string",
    },
    revision: { type: "integer", minimum: 1 },
    registeredAt: { type: "string", format: "date-time" },
    connection: {
      type: "object",
      additionalProperties: false,
      required: ["status", "reason"],
      properties: {
        status: {
          enum: ["connecting", "never-connected", "offline", "online", "stale"],
          type: "string",
        },
        reason: {
          enum: [
            "heartbeat-current",
            "heartbeat-overdue",
            "heartbeat-pending",
            "no-session",
            "session-closed",
            "session-draining",
            "session-negotiating",
            "session-resuming",
            "session-suspect",
          ],
          type: "string",
        },
        sessionId: { type: "string", format: "uuid" },
        sessionState: { type: "string" },
        protocolVersion: { type: "string" },
        openedAt: { type: "string", format: "date-time" },
        activatedAt: { type: "string", format: "date-time" },
        lastSeenAt: { type: "string", format: "date-time" },
        heartbeatIntervalMs: {
          type: "string",
          pattern: "^(?:0|[1-9][0-9]*)$",
        },
        staleAfter: { type: "string", format: "date-time" },
        suspectAt: { type: "string", format: "date-time" },
        closedAt: { type: "string", format: "date-time" },
        closeReason: {
          enum: ["drained", "fenced", "heartbeat-timeout"],
          type: "string",
        },
      },
    },
    telemetry: fleetTelemetrySchema,
  },
} as const;

const fleetListSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", items: fleetGatewaySchema },
    nextCursor: {
      anyOf: [{ type: "string", format: "uuid" }, { type: "null" }],
    },
  },
} as const;

const registeredGatewaySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "tenantId",
    "projectId",
    "gatewayId",
    "displayName",
    "state",
    "revision",
  ],
  properties: {
    tenantId: { type: "string", format: "uuid" },
    projectId: { type: "string", format: "uuid" },
    gatewayId: { type: "string", format: "uuid" },
    displayName: { type: "string", minLength: 1, maxLength: 128 },
    state: { type: "string" },
    revision: { type: "integer", minimum: 1 },
  },
} as const;

const gatewayEnrollmentSchema = {
  ...registeredGatewaySchema,
  properties: {
    ...registeredGatewaySchema.properties,
    claimId: { type: "string", format: "uuid" },
    claimExpiresAt: { type: "string", format: "date-time" },
    claimedAt: { type: "string", format: "date-time" },
  },
} as const;

const enrollmentIssuedSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "gatewayId",
    "state",
    "revision",
    "expiresAt",
    "enrollmentToken",
  ],
  properties: {
    schema: {
      const: "aether.cloud.gateway-enrollment-issued.v1",
      type: "string",
    },
    gatewayId: { type: "string", format: "uuid" },
    state: { const: "awaiting-claim", type: "string" },
    revision: { type: "integer", minimum: 2 },
    expiresAt: { type: "string", format: "date-time" },
    enrollmentToken: { type: "string", minLength: 16, maxLength: 512 },
  },
} as const;

const enrollmentClaimRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "tenantId",
    "projectId",
    "gatewayId",
    "enrollmentToken",
    "credentialRequest",
  ],
  properties: {
    schema: {
      const: "aether.cloud.gateway-enrollment-claim.v1",
      type: "string",
    },
    tenantId: { type: "string", format: "uuid" },
    projectId: { type: "string", format: "uuid" },
    gatewayId: { type: "string", format: "uuid" },
    enrollmentToken: { type: "string", minLength: 16, maxLength: 512 },
    credentialRequest: {
      type: "object",
      additionalProperties: false,
      required: ["algorithm", "publicKey", "fingerprint"],
      properties: {
        algorithm: { const: "ed25519", type: "string" },
        publicKey: {
          type: "string",
          pattern: "^[A-Za-z0-9_-]{43}$",
        },
        fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
    },
  },
} as const;

const enrollmentClaimedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "gatewayId", "state", "revision"],
  properties: {
    schema: {
      const: "aether.cloud.gateway-enrollment-claimed.v1",
      type: "string",
    },
    gatewayId: { type: "string", format: "uuid" },
    state: { const: "claimed", type: "string" },
    revision: {
      type: "integer",
      minimum: 1,
      maximum: 9_007_199_254_740_991,
    },
  },
} as const;

function verifiedCredentialFingerprint(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const publicKey = input.publicKey;
  const fingerprint = input.fingerprint;
  if (
    input.algorithm !== "ed25519" ||
    typeof publicKey !== "string" ||
    typeof fingerprint !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(publicKey) ||
    !/^[0-9a-f]{64}$/.test(fingerprint)
  ) {
    return undefined;
  }
  const decoded = Buffer.from(publicKey, "base64url");
  if (
    decoded.length !== 32 ||
    decoded.toString("base64url") !== publicKey ||
    createHash("sha256").update(decoded).digest("hex") !== fingerprint
  ) {
    return undefined;
  }
  return fingerprint;
}

function fleetFailureStatus(
  code: FleetQueryFailure["code"],
): 400 | 403 | 404 | 503 {
  if (code === "permission-denied") return 403;
  if (code === "gateway-not-found") return 404;
  if (code === "gateway-storage-unavailable") return 503;
  return 400;
}

function gatewayCommandFailureStatus(
  code: GatewayEnrollmentApplicationFailure["code"],
): 400 | 403 | 404 | 409 | 503 {
  if (code === "permission-denied") return 403;
  if (code === "gateway-not-found") return 404;
  if (code === "gateway-storage-unavailable") return 503;
  if (
    code === "gateway-already-exists" ||
    code === "idempotency-conflict" ||
    code === "invalid-gateway-enrollment-transition" ||
    code === "concurrent-modification"
  ) {
    return 409;
  }
  return 400;
}

export function registerFleetRoutes(
  app: FastifyInstance,
  fleet: FleetHttpDependencies,
): void {
  app.get(
    "/api/v1/fleet/gateways",
    {
      schema: {
        response: {
          200: fleetListSchema,
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
      const authentication = await fleet.authenticator.authenticate({
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
      const allowed = new Set(["cursor", "limit"]);
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
          typeof request.query.cursor !== "string")
      ) {
        return sendError(
          reply,
          400,
          "invalid-input",
          "Fleet query is invalid",
          correlationId,
        );
      }
      const result = await fleet.list.execute(authentication.value, {
        limit: Number.parseInt(rawLimit, 10),
        ...(request.query.cursor === undefined
          ? {}
          : { cursor: request.query.cursor }),
      });
      if (!result.ok) {
        return sendError(
          reply,
          fleetFailureStatus(result.failure.code),
          result.failure.code,
          result.failure.message,
          correlationId,
        );
      }
      return reply.status(200).send(result.value);
    },
  );

  app.get(
    "/api/v1/fleet/gateways/:gatewayId",
    {
      schema: {
        response: {
          200: fleetGatewaySchema,
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
      const authentication = await fleet.authenticator.authenticate({
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
      const result = await fleet.get.execute(
        authentication.value,
        request.params,
      );
      if (!result.ok) {
        return sendError(
          reply,
          fleetFailureStatus(result.failure.code),
          result.failure.code,
          result.failure.message,
          correlationId,
        );
      }
      return reply.status(200).send(result.value);
    },
  );

  app.post(
    "/api/v1/fleet/gateways",
    {
      schema: {
        response: {
          200: registeredGatewaySchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          409: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const correlationId = request.id;
      reply.header("x-correlation-id", correlationId);
      const authentication = await fleet.authenticator.authenticate({
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
      const idempotencyKey = request.headers["idempotency-key"];
      if (
        typeof idempotencyKey !== "string" ||
        idempotencyKey.length < 8 ||
        idempotencyKey.length > 128
      ) {
        return sendError(
          reply,
          400,
          "invalid-input",
          "idempotency-key header is required",
          correlationId,
        );
      }
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + 5 * 60_000);
      const result = await fleet.register.execute(
        {
          ...authentication.value,
          subjectKind: "user",
          idempotencyKey,
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
        request.body,
      );
      if (!result.ok) {
        return sendError(
          reply,
          gatewayCommandFailureStatus(result.failure.code),
          result.failure.code,
          result.failure.message,
          correlationId,
        );
      }
      return reply.status(200).send(result.value);
    },
  );

  const issueEnrollment = fleet.issueEnrollment;
  if (issueEnrollment !== undefined) {
    app.post(
      "/api/v1/fleet/gateways/:gatewayId/enrollment-claims",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            maxProperties: 0,
          },
          response: {
            200: enrollmentIssuedSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
            503: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const correlationId = request.id;
        reply.header("x-correlation-id", correlationId);
        const authentication = await fleet.authenticator.authenticate({
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
        const idempotencyKey = request.headers["idempotency-key"];
        if (
          typeof idempotencyKey !== "string" ||
          idempotencyKey.length < 8 ||
          idempotencyKey.length > 128 ||
          request.headers["x-aethercloud-confirmation"] !==
            "issue-enrollment-claim"
        ) {
          return sendError(
            reply,
            400,
            "confirmation-required",
            "explicit Enrollment Claim confirmation is required",
            correlationId,
          );
        }
        const issuedAt = new Date();
        const commandExpiresAt = new Date(issuedAt.getTime() + 2 * 60_000);
        const claimExpiresAt = new Date(issuedAt.getTime() + 10 * 60_000);
        const result = await issueEnrollment.execute(
          {
            ...authentication.value,
            subjectKind: "user",
            idempotencyKey,
            issuedAt: issuedAt.toISOString(),
            expiresAt: commandExpiresAt.toISOString(),
            confirmation: {
              method: "explicit",
              confirmedAt: issuedAt.toISOString(),
            },
          },
          {
            ...(isRecord(request.params) ? request.params : {}),
            claimExpiresAt: claimExpiresAt.toISOString(),
          },
        );
        if (!result.ok) {
          return sendError(
            reply,
            gatewayCommandFailureStatus(result.failure.code),
            result.failure.code,
            result.failure.message,
            correlationId,
          );
        }
        if (!("enrollmentToken" in result.value)) {
          return sendError(
            reply,
            409,
            "enrollment-token-not-recoverable",
            "the Enrollment Token was already issued and cannot be returned again",
            correlationId,
          );
        }
        return reply.status(200).send({
          schema: "aether.cloud.gateway-enrollment-issued.v1",
          gatewayId: result.value.gateway.gatewayId,
          state: "awaiting-claim",
          revision: result.value.gateway.revision,
          expiresAt: result.value.gateway.claimExpiresAt,
          enrollmentToken: result.value.enrollmentToken,
        });
      },
    );
  }

  const getEnrollment = fleet.getEnrollment;
  if (getEnrollment !== undefined) {
    app.get(
      "/api/v1/fleet/gateways/:gatewayId/enrollment",
      {
        schema: {
          response: {
            200: gatewayEnrollmentSchema,
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
        const authentication = await fleet.authenticator.authenticate({
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
        const result = await getEnrollment.execute(
          authentication.value,
          request.params,
        );
        if (!result.ok) {
          return sendError(
            reply,
            gatewayCommandFailureStatus(result.failure.code),
            result.failure.code,
            result.failure.message,
            correlationId,
          );
        }
        return reply.status(200).send(result.value);
      },
    );
  }

  const claimEnrollment = fleet.claimEnrollment;
  if (claimEnrollment !== undefined) {
    app.post(
      "/api/v1/fleet/enrollment-claims:claim",
      {
        schema: {
          body: enrollmentClaimRequestSchema,
          response: {
            200: enrollmentClaimedSchema,
            400: errorResponseSchema,
            409: errorResponseSchema,
            429: errorResponseSchema,
            503: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const correlationId = request.id;
        reply.header("x-correlation-id", correlationId);
        if (
          fleet.claimRateLimiter !== undefined &&
          !fleet.claimRateLimiter.allow(request.ip, Date.now())
        ) {
          return sendError(
            reply,
            429,
            "rate-limited",
            "too many Enrollment Claim attempts",
            correlationId,
          );
        }
        const idempotencyKey = request.headers["idempotency-key"];
        const body = isRecord(request.body) ? request.body : {};
        const fingerprint = verifiedCredentialFingerprint(
          body.credentialRequest,
        );
        if (
          typeof idempotencyKey !== "string" ||
          idempotencyKey.length < 8 ||
          idempotencyKey.length > 128 ||
          typeof body.tenantId !== "string" ||
          typeof body.projectId !== "string" ||
          typeof body.gatewayId !== "string" ||
          typeof body.enrollmentToken !== "string" ||
          fingerprint === undefined
        ) {
          return sendError(
            reply,
            400,
            "invalid-input",
            "Enrollment Claim request is invalid",
            correlationId,
          );
        }
        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + 2 * 60_000);
        const result = await claimEnrollment.execute(
          {
            tenantId: body.tenantId,
            projectId: body.projectId,
            idempotencyKey,
            issuedAt: issuedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
          },
          {
            gatewayId: body.gatewayId,
            enrollmentToken: body.enrollmentToken,
            credentialRequestFingerprint: fingerprint,
          },
        );
        if (!result.ok) {
          return sendError(
            reply,
            gatewayCommandFailureStatus(result.failure.code),
            result.failure.code,
            result.failure.message,
            correlationId,
          );
        }
        return reply.status(200).send({
          schema: "aether.cloud.gateway-enrollment-claimed.v1",
          gatewayId: result.value.gatewayId,
          state: "claimed",
          revision: result.value.revision,
        });
      },
    );
  }
}
