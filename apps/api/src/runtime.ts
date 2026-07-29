import { SearchAuditEvents } from "@aether-cloud/application";
import { InMemoryAuditEventStore } from "@aether-cloud/audit-memory-adapter";
import {
  PostgresAuditEventRepository,
  type PostgresAuditPool,
} from "@aether-cloud/audit-postgres-adapter";
import { NodePostgresPool } from "@aether-cloud/fleet-postgres-adapter";
import { URL } from "node:url";

import { buildApp } from "./app.js";
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
        parsed.hostname !== "aetheriot.dev" &&
        !parsed.hostname.endsWith(".aetheriot.dev")) ||
      unique.has(origin)
    ) {
      throw new Error("AETHER_CLOUD_ALLOWED_WEB_ORIGINS is invalid");
    }
    unique.add(origin);
  }
  return Object.freeze([...unique]);
}

function postgresConnectionString(environment: NodeJS.ProcessEnv): string {
  const input = environment.AETHER_CLOUD_POSTGRES_URL;
  if (input === undefined || input.length === 0) {
    throw new Error(
      "AETHER_CLOUD_POSTGRES_URL is required when AETHER_CLOUD_AUDIT_STORE=postgres",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("AETHER_CLOUD_POSTGRES_URL must be a PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("AETHER_CLOUD_POSTGRES_URL must be a PostgreSQL URL");
  }
  const username = decodeURIComponent(parsed.username);
  if (
    username !== "aethercloud_app" &&
    !username.startsWith("aethercloud_app.")
  ) {
    throw new Error(
      "AETHER_CLOUD_POSTGRES_URL must use the dedicated non-owner application role",
    );
  }
  if (parsed.password.length === 0) {
    throw new Error("AETHER_CLOUD_POSTGRES_URL must include a password");
  }
  if (parsed.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("AETHER_CLOUD_POSTGRES_URL must use verify-full TLS");
  }
  return input;
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
    connectionString: postgresConnectionString(environment),
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

export function composeApiRuntime(
  environment: NodeJS.ProcessEnv,
  factories: ApiRuntimeFactories = {},
): ApiRuntime {
  const audit = auditRepository(environment, factories);
  const origins = allowedOrigins(environment);
  const app = buildApp({
    version: "0.1.0",
    ...(origins === undefined ? {} : { allowedOrigins: origins }),
    audit: {
      query: new SearchAuditEvents({ repository: audit.repository }),
      authenticator: authenticator(environment),
    },
  });
  let closePromise: Promise<void> | undefined;
  return {
    app,
    close(): Promise<void> {
      closePromise ??= (async () => {
        await app.close();
        await audit.pool?.end();
      })();
      return closePromise;
    },
  };
}
