import { getPlatformProfile } from "@aether-cloud/application";
import type {
  ClaimGatewayEnrollment,
  GetFleetGateway,
  GetGatewayEnrollment,
  IssueGatewayEnrollment,
  ListFleetGateways,
  RegisterGateway,
  SearchAuditEvents,
} from "@aether-cloud/application";
import cors from "@fastify/cors";
import Fastify from "fastify";

import { registerAuditRoutes } from "./audit-routes.js";
import type { EnrollmentClaimRateLimiter } from "./enrollment-claim-rate-limiter.js";
import { registerFleetRoutes } from "./fleet-routes.js";
import { registerIntegrationRoutes } from "./integration-routes.js";
import type { IntegrationHttpDependencies } from "./integration-routes.js";
import { registerMcpHttp } from "./mcp-http.js";
import type { McpHttpDependencies } from "./mcp-http.js";
import type { FastifyInstance } from "fastify";

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

export interface FleetHttpDependencies {
  readonly authenticator: HttpAuthenticator;
  readonly list: Pick<ListFleetGateways, "execute">;
  readonly get: Pick<GetFleetGateway, "execute">;
  readonly register: Pick<RegisterGateway, "execute">;
  readonly issueEnrollment?: Pick<IssueGatewayEnrollment, "execute">;
  readonly claimEnrollment?: Pick<ClaimGatewayEnrollment, "execute">;
  readonly getEnrollment?: Pick<GetGatewayEnrollment, "execute">;
  readonly claimRateLimiter?: EnrollmentClaimRateLimiter;
}

export interface BuildAppOptions {
  readonly version: string;
  readonly allowedOrigins?: readonly string[];
  readonly audit?: AuditHttpDependencies;
  readonly fleet?: FleetHttpDependencies;
  readonly integrations?: IntegrationHttpDependencies;
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

export function buildApp(options: BuildAppOptions): FastifyInstance {
  // `:integrationId` is the only non-UUID path parameter in this API, and the
  // domain allows 128 characters. Fastify's default cap of 100 rejects longer
  // ones in the router, before any route schema or error convention applies:
  // the reply is a 414 whose `error` is a string rather than the documented
  // `{code, message, correlationId}` object, and it carries no correlation
  // header. That would let the catalog list a projection the detail route can
  // never return.
  const app = Fastify({ logger: false, maxParamLength: 128 });

  if (
    options.allowedOrigins !== undefined &&
    options.allowedOrigins.length > 0
  ) {
    void app.register(cors, {
      allowedHeaders: [
        "authorization",
        "content-type",
        "idempotency-key",
        "last-event-id",
        "x-aethercloud-confirmation",
      ],
      credentials: false,
      exposedHeaders: ["x-correlation-id"],
      maxAge: 600,
      methods: ["GET", "HEAD", "OPTIONS", "POST"],
      origin: [...options.allowedOrigins],
      strictPreflight: true,
    });
  }

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

  const fleet = options.fleet;
  if (fleet !== undefined) {
    registerFleetRoutes(app, fleet);
  }

  const integrations = options.integrations;
  if (integrations !== undefined) {
    registerIntegrationRoutes(app, integrations);
  }

  const audit = options.audit;
  if (audit !== undefined) {
    registerAuditRoutes(app, audit);
  }

  return app;
}

export type { IntegrationHttpDependencies } from "./integration-routes.js";
export type { McpHttpDependencies, McpHttpInterface } from "./mcp-http.js";
