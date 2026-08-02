import {
  ClaimGatewayEnrollment,
  GetFleetGateway,
  GetGatewayEnrollment,
  GetIntegrationProjection,
  IssueGatewayEnrollment,
  ListFleetGateways,
  ListIntegrationProjections,
  ReconcileCloudLinkSessionHealth,
  RegisterGateway,
  SearchAuditEvents,
} from "@aether-cloud/application";
import { InMemoryAuditEventStore } from "@aether-cloud/audit-memory-adapter";
import { PostgresCloudLinkSessionRepository } from "@aether-cloud/cloudlink-postgres-adapter";
import { InMemoryGatewayIdentityRepository } from "@aether-cloud/fleet-memory-adapter";
import {
  InMemoryIntegrationProjectionRepository,
  NodeIntegrationPayloadDigestor,
} from "@aether-cloud/integration-projection-memory-adapter";
import { PostgresIntegrationProjectionRepository } from "@aether-cloud/integration-projection-postgres-adapter";
import {
  PostgresAuditEventRepository,
  type PostgresAuditPool,
} from "@aether-cloud/audit-postgres-adapter";
import {
  assertPostgresConnectionString,
  NodePostgresPool,
  PostgresGatewayIdentityRepository,
} from "@aether-cloud/fleet-postgres-adapter";
import { parseUtcInstant } from "@aether-cloud/domain";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import type {
  IntegrationProjectionCatalog,
  IntegrationProjectionRepository,
} from "@aether-cloud/application";

import { buildApp } from "./app.js";
import {
  startCloudLinkHealthScheduler,
  type RunningCloudLinkHealthScheduler,
} from "./cloudlink-health-scheduler.js";
import { FixedWindowEnrollmentClaimRateLimiter } from "./enrollment-claim-rate-limiter.js";
import { NodeEnrollmentTokenService } from "./node-enrollment-token-service.js";
import {
  ConfiguredBearerAuthenticator,
  type ConfiguredBearerSubject,
} from "./configured-bearer-authenticator.js";
import { SupabaseJwtAuthenticator } from "./supabase-jwt-authenticator.js";
import type { FastifyInstance } from "fastify";
import type { HttpAuthenticator } from "./app.js";

interface ClosablePostgresPool extends PostgresAuditPool {
  end(): Promise<void>;
}

interface PostgresPoolConfiguration {
  readonly connectionString: string;
  readonly max: number;
  readonly connectionTimeoutMillis: number;
  readonly idleTimeoutMillis: number;
  readonly statement_timeout: number;
}

export interface ApiRuntime {
  readonly app: FastifyInstance;
  close(): Promise<void>;
}

export interface ApiRuntimeFactories {
  readonly postgresPoolFactory?: (
    configuration: PostgresPoolConfiguration,
  ) => ClosablePostgresPool;
  readonly cloudLinkHealthPostgresPoolFactory?: (
    configuration: PostgresPoolConfiguration,
  ) => ClosablePostgresPool;
  readonly integrationProjectionPostgresPoolFactory?: (
    configuration: PostgresPoolConfiguration,
  ) => ClosablePostgresPool;
}

function configuredSubject(
  environment: NodeJS.ProcessEnv,
): ConfiguredBearerSubject | undefined {
  const token = environment.AETHER_CLOUD_API_BEARER_TOKEN;
  const tenantId = environment.AETHER_CLOUD_API_TENANT_ID;
  const projectId = environment.AETHER_CLOUD_API_PROJECT_ID;
  const subjectId = environment.AETHER_CLOUD_API_SUBJECT_ID;
  if (
    token === undefined ||
    tenantId === undefined ||
    projectId === undefined ||
    subjectId === undefined
  ) {
    return undefined;
  }
  return {
    token,
    tenantId,
    projectId,
    subjectId,
    permissions: (environment.AETHER_CLOUD_API_PERMISSIONS ?? "")
      .split(",")
      .map((permission) => permission.trim())
      .filter((permission) => permission.length > 0),
  };
}

function authenticator(environment: NodeJS.ProcessEnv): HttpAuthenticator {
  const mode = environment.AETHER_CLOUD_AUTH_MODE ?? "configured";
  if (mode === "configured") {
    if (environment.RAILWAY_ENVIRONMENT_NAME === "production") {
      throw new Error("Production requires Supabase JWT authentication");
    }
    return new ConfiguredBearerAuthenticator(configuredSubject(environment));
  }
  if (mode !== "supabase-jwt") {
    throw new Error(
      "AETHER_CLOUD_AUTH_MODE must be configured or supabase-jwt",
    );
  }
  const issuer = environment.AETHER_CLOUD_SUPABASE_AUTH_ISSUER;
  if (issuer === undefined || issuer.length === 0) {
    throw new Error(
      "AETHER_CLOUD_SUPABASE_AUTH_ISSUER is required for Supabase JWT authentication",
    );
  }
  return new SupabaseJwtAuthenticator({ issuer });
}

/**
 * Web domains this product serves browsers from.
 *
 * Both are legal while `aetheriot.ai` replaces `aetheriot.dev`. Remove
 * `aetheriot.dev` once no browser reaches the API from it; removing it while a
 * deployed origin still names it throws at composition and takes the API
 * process down at boot.
 */
const PRODUCT_WEB_DOMAINS = ["aetheriot.ai", "aetheriot.dev"] as const;

function isProductWebHost(hostname: string): boolean {
  // The leading dot matters: a bare suffix test would also admit
  // `notaetheriot.ai` and `aetheriot.ai.example.com`.
  return PRODUCT_WEB_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

function allowedOrigins(
  environment: NodeJS.ProcessEnv,
): readonly string[] | undefined {
  const input = environment.AETHER_CLOUD_ALLOWED_WEB_ORIGINS;
  if (input === undefined || input.length === 0) {
    if (environment.RAILWAY_ENVIRONMENT_NAME === "production") {
      throw new Error(
        "AETHER_CLOUD_ALLOWED_WEB_ORIGINS is required in production",
      );
    }
    return undefined;
  }
  const origins = input.split(",").map((origin) => origin.trim());
  if (origins.length > 8 || origins.some((origin) => origin.length === 0)) {
    throw new Error("AETHER_CLOUD_ALLOWED_WEB_ORIGINS is invalid");
  }
  const unique = new Set<string>();
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("AETHER_CLOUD_ALLOWED_WEB_ORIGINS is invalid");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== origin ||
      (environment.RAILWAY_ENVIRONMENT_NAME === "production" &&
        !isProductWebHost(parsed.hostname)) ||
      unique.has(origin)
    ) {
      throw new Error("AETHER_CLOUD_ALLOWED_WEB_ORIGINS is invalid");
    }
    unique.add(origin);
  }
  return Object.freeze([...unique]);
}

function postgresConnectionString(
  environment: NodeJS.ProcessEnv,
  requiredWhen: string,
): string {
  return assertPostgresConnectionString(environment.AETHER_CLOUD_POSTGRES_URL, {
    variable: "AETHER_CLOUD_POSTGRES_URL",
    roleName: "aethercloud_app",
    requiredWhen,
  });
}

function cloudLinkHealthConnectionString(
  environment: NodeJS.ProcessEnv,
): string {
  return assertPostgresConnectionString(
    environment.AETHER_CLOUD_CLOUDLINK_HEALTH_POSTGRES_URL,
    {
      variable: "AETHER_CLOUD_CLOUDLINK_HEALTH_POSTGRES_URL",
      roleName: "aethercloud_cloudlink_health_worker",
      requiredWhen: "the CloudLink health worker is enabled",
    },
  );
}

function positiveInteger(
  input: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (input === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(input)) throw new Error(`${name} is invalid`);
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function auditRepository(
  environment: NodeJS.ProcessEnv,
  factories: ApiRuntimeFactories,
): Readonly<{
  repository: ConstructorParameters<typeof SearchAuditEvents>[0]["repository"];
  pool?: ClosablePostgresPool;
}> {
  const mode = environment.AETHER_CLOUD_AUDIT_STORE ?? "memory";
  if (mode === "memory") {
    return { repository: new InMemoryAuditEventStore() };
  }
  if (mode !== "postgres") {
    throw new Error("AETHER_CLOUD_AUDIT_STORE must be memory or postgres");
  }
  const configuration: PostgresPoolConfiguration = {
    connectionString: postgresConnectionString(
      environment,
      "AETHER_CLOUD_AUDIT_STORE=postgres",
    ),
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5_000,
  };
  const pool =
    factories.postgresPoolFactory?.(configuration) ??
    NodePostgresPool.fromConfig(configuration);
  return {
    repository: new PostgresAuditEventRepository(pool),
    pool,
  };
}

/**
 * The read-only projection surface reads as `aethercloud_app` through
 * `AETHER_CLOUD_POSTGRES_URL`. CloudLink ingress writes the same tables as
 * `aethercloud_cloudlink_ingress` through its own variable, so the two
 * processes never share a role or a connection string.
 */
function integrationProjectionStore(
  environment: NodeJS.ProcessEnv,
  factories: ApiRuntimeFactories,
): Readonly<{
  repository: IntegrationProjectionRepository & IntegrationProjectionCatalog;
  pool?: ClosablePostgresPool;
}> {
  const mode =
    environment.AETHER_CLOUD_INTEGRATION_PROJECTION_STORE ?? "memory";
  if (mode === "memory") {
    return { repository: new InMemoryIntegrationProjectionRepository() };
  }
  if (mode !== "postgres") {
    throw new Error(
      "AETHER_CLOUD_INTEGRATION_PROJECTION_STORE must be memory or postgres",
    );
  }
  const configuration: PostgresPoolConfiguration = {
    connectionString: postgresConnectionString(
      environment,
      "AETHER_CLOUD_INTEGRATION_PROJECTION_STORE=postgres",
    ),
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5_000,
  };
  const pool =
    factories.integrationProjectionPostgresPoolFactory?.(configuration) ??
    NodePostgresPool.fromConfig(configuration);
  return {
    repository: new PostgresIntegrationProjectionRepository(pool),
    pool,
  };
}

function cloudLinkHealthWorker(
  environment: NodeJS.ProcessEnv,
  factories: ApiRuntimeFactories,
  clock: Readonly<{ now(): ReturnType<typeof parseUtcInstant> }>,
): Readonly<{
  scheduler?: RunningCloudLinkHealthScheduler;
  pool?: ClosablePostgresPool;
}> {
  const mode = environment.AETHER_CLOUD_CLOUDLINK_HEALTH_WORKER ?? "disabled";
  if (mode === "disabled") return {};
  if (mode !== "enabled") {
    throw new Error(
      "AETHER_CLOUD_CLOUDLINK_HEALTH_WORKER must be disabled or enabled",
    );
  }
  const configuration: PostgresPoolConfiguration = {
    connectionString: cloudLinkHealthConnectionString(environment),
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
  };
  const pool =
    factories.cloudLinkHealthPostgresPoolFactory?.(configuration) ??
    NodePostgresPool.fromConfig(configuration);
  const repository = new PostgresCloudLinkSessionRepository(pool);
  const reconcile = new ReconcileCloudLinkSessionHealth({
    repository,
    clock,
    ids: { next: randomUUID },
  });
  const scheduler = startCloudLinkHealthScheduler({
    reconcile,
    observer: {
      sweepFailed() {
        process.stderr.write("CloudLink health sweep failed\n");
      },
    },
    intervalMs: positiveInteger(
      environment.AETHER_CLOUD_CLOUDLINK_HEALTH_INTERVAL_MS,
      30_000,
      1_000,
      300_000,
      "AETHER_CLOUD_CLOUDLINK_HEALTH_INTERVAL_MS",
    ),
    batchSize: positiveInteger(
      environment.AETHER_CLOUD_CLOUDLINK_HEALTH_BATCH_SIZE,
      100,
      1,
      500,
      "AETHER_CLOUD_CLOUDLINK_HEALTH_BATCH_SIZE",
    ),
  });
  return { scheduler, pool };
}

export function composeApiRuntime(
  environment: NodeJS.ProcessEnv,
  factories: ApiRuntimeFactories = {},
): ApiRuntime {
  const audit = auditRepository(environment, factories);
  const fleetRepository =
    audit.pool === undefined
      ? new InMemoryGatewayIdentityRepository()
      : new PostgresGatewayIdentityRepository(audit.pool);
  const clock = {
    now: () => parseUtcInstant(new Date().toISOString()),
  };
  const enrollmentTokens = new NodeEnrollmentTokenService();
  const projections = integrationProjectionStore(environment, factories);
  const cloudLinkHealth = cloudLinkHealthWorker(environment, factories, clock);
  const identity = authenticator(environment);
  const origins = allowedOrigins(environment);
  const app = buildApp({
    version: "0.1.0",
    ...(origins === undefined ? {} : { allowedOrigins: origins }),
    audit: {
      query: new SearchAuditEvents({ repository: audit.repository }),
      authenticator: identity,
    },
    fleet: {
      list: new ListFleetGateways({ repository: fleetRepository, clock }),
      get: new GetFleetGateway({ repository: fleetRepository, clock }),
      register: new RegisterGateway({ repository: fleetRepository, clock }),
      issueEnrollment: new IssueGatewayEnrollment({
        repository: fleetRepository,
        tokens: enrollmentTokens,
        clock,
      }),
      claimEnrollment: new ClaimGatewayEnrollment({
        repository: fleetRepository,
        tokens: enrollmentTokens,
        clock,
      }),
      getEnrollment: new GetGatewayEnrollment({
        repository: fleetRepository,
      }),
      claimRateLimiter: new FixedWindowEnrollmentClaimRateLimiter(),
      authenticator: identity,
    },
    integrations: {
      list: new ListIntegrationProjections({
        catalog: projections.repository,
        clock,
      }),
      get: new GetIntegrationProjection({
        repository: projections.repository,
        digestor: new NodeIntegrationPayloadDigestor(),
        clock,
      }),
      authenticator: identity,
    },
  });
  let closePromise: Promise<void> | undefined;
  return {
    app,
    close(): Promise<void> {
      closePromise ??= (async () => {
        await app.close();
        await cloudLinkHealth.scheduler?.close();
        await Promise.all([
          audit.pool?.end(),
          cloudLinkHealth.pool?.end(),
          projections.pool?.end(),
        ]);
      })();
      return closePromise;
    },
  };
}
