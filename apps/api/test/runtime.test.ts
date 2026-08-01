import { afterEach, describe, expect, it } from "vitest";

import type {
  PostgresAuditClient,
  PostgresAuditQueryResult,
} from "@aether-cloud/audit-postgres-adapter";

import { composeApiRuntime } from "../src/runtime.js";

const authenticatedEnvironment = {
  AETHER_CLOUD_API_BEARER_TOKEN: "opaque-test-token",
  AETHER_CLOUD_API_TENANT_ID: "11111111-1111-4111-8111-111111111111",
  AETHER_CLOUD_API_PROJECT_ID: "22222222-2222-4222-8222-222222222222",
  AETHER_CLOUD_API_SUBJECT_ID: "user:admin",
  AETHER_CLOUD_API_PERMISSIONS: "audit.event.read",
} satisfies NodeJS.ProcessEnv;

describe("API runtime composition", () => {
  const runtimes: { close(): Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it("uses the PostgreSQL Audit adapter and closes its pool", async () => {
    const statements: string[] = [];
    let ended = false;
    const client: PostgresAuditClient = {
      query: <Row extends Record<string, unknown>>(
        text: string,
      ): Promise<PostgresAuditQueryResult<Row>> => {
        statements.push(text);
        return Promise.resolve({ rows: [] as readonly Row[], rowCount: 0 });
      },
      release: () => undefined,
    };
    const runtime = composeApiRuntime(
      {
        ...authenticatedEnvironment,
        AETHER_CLOUD_AUDIT_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "postgresql://aethercloud_app.pooler-project:secret@database.example:5432/postgres?sslmode=verify-full",
      },
      {
        postgresPoolFactory: () => ({
          connect: () => Promise.resolve(client),
          end: () => {
            ended = true;
            return Promise.resolve();
          },
        }),
      },
    );
    runtimes.push(runtime);

    const response = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/audit/events?limit=10",
      headers: { authorization: "Bearer opaque-test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], nextCursor: null });
    expect(statements).toEqual([
      "BEGIN",
      expect.stringContaining("set_config"),
      expect.stringContaining("FROM aethercloud.audit_events"),
      "COMMIT",
    ]);
    await runtime.close();
    expect(ended).toBe(true);
  });

  it("fails closed when PostgreSQL mode has no safe application URL", () => {
    expect(() =>
      composeApiRuntime({
        ...authenticatedEnvironment,
        AETHER_CLOUD_AUDIT_STORE: "postgres",
      }),
    ).toThrow(
      "AETHER_CLOUD_POSTGRES_URL is required when AETHER_CLOUD_AUDIT_STORE=postgres",
    );

    // The whole point of threading requiredWhen is that the message names the
    // gate the operator actually set. Two call sites share one validator, so
    // passing the wrong literal at either is the hazard the parameter creates.
    expect(() =>
      composeApiRuntime({
        ...authenticatedEnvironment,
        AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "postgres",
      }),
    ).toThrow(
      "AETHER_CLOUD_POSTGRES_URL is required when AETHER_CLOUD_INTEGRATION_PROJECTION_STORE=postgres",
    );

    expect(() =>
      composeApiRuntime({
        ...authenticatedEnvironment,
        AETHER_CLOUD_AUDIT_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL: "not a url",
      }),
    ).toThrow(
      "AETHER_CLOUD_POSTGRES_URL must be a parseable PostgreSQL connection URL",
    );

    expect(() =>
      composeApiRuntime({
        ...authenticatedEnvironment,
        AETHER_CLOUD_AUDIT_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "mysql://aethercloud_app:secret@database.example:5432/postgres?sslmode=verify-full",
      }),
    ).toThrow(
      "AETHER_CLOUD_POSTGRES_URL must use the postgres: or postgresql: protocol",
    );

    expect(() =>
      composeApiRuntime({
        ...authenticatedEnvironment,
        AETHER_CLOUD_AUDIT_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "postgresql://postgres:secret@database.example:5432/postgres?sslmode=verify-full",
      }),
    ).toThrow(
      "AETHER_CLOUD_POSTGRES_URL must authenticate as the aethercloud_app role",
    );

    expect(() =>
      composeApiRuntime({
        ...authenticatedEnvironment,
        AETHER_CLOUD_AUDIT_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "postgresql://aethercloud_app_owner:secret@database.example:5432/postgres?sslmode=verify-full",
      }),
    ).toThrow(
      "AETHER_CLOUD_POSTGRES_URL must authenticate as the aethercloud_app role",
    );

    expect(() =>
      composeApiRuntime({
        ...authenticatedEnvironment,
        AETHER_CLOUD_AUDIT_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "postgresql://aethercloud_app@database.example:5432/postgres?sslmode=verify-full",
      }),
    ).toThrow("AETHER_CLOUD_POSTGRES_URL must include a password");

    expect(() =>
      composeApiRuntime({
        ...authenticatedEnvironment,
        AETHER_CLOUD_AUDIT_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "postgresql://aethercloud_app:secret@database.example:5432/postgres?sslmode=require",
      }),
    ).toThrow("AETHER_CLOUD_POSTGRES_URL must use verify-full TLS");
  });

  it("runs CloudLink health through an isolated worker role and closes its pool", async () => {
    const statements: string[] = [];
    let ended = false;
    let configuredUrl = "";
    const client: PostgresAuditClient = {
      query: <Row extends Record<string, unknown>>(
        text: string,
      ): Promise<PostgresAuditQueryResult<Row>> => {
        statements.push(text);
        return Promise.resolve({ rows: [] as readonly Row[], rowCount: 0 });
      },
      release: () => undefined,
    };
    const runtime = composeApiRuntime(
      {
        ...authenticatedEnvironment,
        AETHER_CLOUD_AUDIT_STORE: "memory",
        AETHER_CLOUD_CLOUDLINK_HEALTH_WORKER: "enabled",
        AETHER_CLOUD_CLOUDLINK_HEALTH_POSTGRES_URL:
          "postgresql://aethercloud_cloudlink_health_worker.pooler-project:secret@database.example:5432/postgres?sslmode=verify-full",
      },
      {
        cloudLinkHealthPostgresPoolFactory: (configuration) => {
          configuredUrl = configuration.connectionString;
          return {
            connect: () => Promise.resolve(client),
            end: () => {
              ended = true;
              return Promise.resolve();
            },
          };
        },
      },
    );
    runtimes.push(runtime);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(configuredUrl).toContain(
      "aethercloud_cloudlink_health_worker.pooler-project",
    );
    expect(statements).toEqual([
      "BEGIN",
      expect.stringContaining("cloudlink-session-health:lease-due"),
      "COMMIT",
    ]);
    await runtime.close();
    expect(ended).toBe(true);
  });

  it("rejects unsafe CloudLink health worker database identities", () => {
    expect(() =>
      composeApiRuntime({
        ...authenticatedEnvironment,
        AETHER_CLOUD_AUDIT_STORE: "memory",
        AETHER_CLOUD_CLOUDLINK_HEALTH_WORKER: "enabled",
        AETHER_CLOUD_CLOUDLINK_HEALTH_POSTGRES_URL:
          "postgresql://aethercloud_app:secret@database.example:5432/postgres?sslmode=verify-full",
      }),
    ).toThrow(
      "AETHER_CLOUD_CLOUDLINK_HEALTH_POSTGRES_URL must authenticate as the aethercloud_cloudlink_health_worker role",
    );
  });

  it("reads Integration projections as the application role and closes its pool", async () => {
    const statements: string[] = [];
    let ended = false;
    let configuredUrl = "";
    const client: PostgresAuditClient = {
      query: <Row extends Record<string, unknown>>(
        text: string,
      ): Promise<PostgresAuditQueryResult<Row>> => {
        statements.push(text);
        return Promise.resolve({ rows: [] as readonly Row[], rowCount: 0 });
      },
      release: () => undefined,
    };
    const runtime = composeApiRuntime(
      {
        ...authenticatedEnvironment,
        AETHER_CLOUD_API_PERMISSIONS: "integration.projection.read",
        AETHER_CLOUD_AUDIT_STORE: "memory",
        AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "postgresql://aethercloud_app.pooler-project:secret@database.example:5432/postgres?sslmode=verify-full",
      },
      {
        integrationProjectionPostgresPoolFactory: (configuration) => {
          configuredUrl = configuration.connectionString;
          return {
            connect: () => Promise.resolve(client),
            end: () => {
              ended = true;
              return Promise.resolve();
            },
          };
        },
      },
    );
    runtimes.push(runtime);

    const response = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/integrations",
      headers: { authorization: "Bearer opaque-test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      authority: "edge-reported-copy",
      liveStateAuthoritative: false,
      items: [],
    });
    expect(configuredUrl).toContain("aethercloud_app.pooler-project");
    expect(statements).toEqual([
      "BEGIN",
      "SELECT set_config('aethercloud.tenant_id', $1, true)",
      expect.stringContaining("aethercloud.integration_projections"),
      "COMMIT",
    ]);
    await runtime.close();
    expect(ended).toBe(true);
  });

  it("rejects a projection store that is neither memory nor postgres", () => {
    expect(() =>
      composeApiRuntime({
        ...authenticatedEnvironment,
        AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "sqlite",
      }),
    ).toThrow(
      "AETHER_CLOUD_INTEGRATION_PROJECTION_STORE must be memory or postgres",
    );
  });

  it("selects Supabase JWT authentication explicitly", async () => {
    const runtime = composeApiRuntime({
      ...authenticatedEnvironment,
      AETHER_CLOUD_AUDIT_STORE: "memory",
      AETHER_CLOUD_AUTH_MODE: "supabase-jwt",
      AETHER_CLOUD_SUPABASE_AUTH_ISSUER:
        "https://exampleproject.supabase.co/auth/v1",
    });
    runtimes.push(runtime);

    const response = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/audit/events?limit=10",
      headers: { authorization: "Bearer not-a-jwt" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("requires explicit website origins for production browser access", () => {
    expect(() =>
      composeApiRuntime({
        ...authenticatedEnvironment,
        AETHER_CLOUD_AUDIT_STORE: "memory",
        AETHER_CLOUD_AUTH_MODE: "supabase-jwt",
        AETHER_CLOUD_SUPABASE_AUTH_ISSUER:
          "https://exampleproject.supabase.co/auth/v1",
        RAILWAY_ENVIRONMENT_NAME: "production",
      }),
    ).toThrow(/AETHER_CLOUD_ALLOWED_WEB_ORIGINS/);
  });

  it("fails closed instead of using configured bearer auth in production", () => {
    expect(() =>
      composeApiRuntime({
        ...authenticatedEnvironment,
        AETHER_CLOUD_AUDIT_STORE: "memory",
        AETHER_CLOUD_AUTH_MODE: "configured",
        AETHER_CLOUD_ALLOWED_WEB_ORIGINS: "https://cloud.aetheriot.dev",
        RAILWAY_ENVIRONMENT_NAME: "production",
      }),
    ).toThrow(/Supabase JWT authentication/);
  });

  it("keeps explicit memory mode self-contained", async () => {
    const runtime = composeApiRuntime({
      ...authenticatedEnvironment,
      AETHER_CLOUD_AUDIT_STORE: "memory",
    });
    runtimes.push(runtime);

    const response = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/audit/events?limit=10",
      headers: { authorization: "Bearer opaque-test-token" },
    });

    expect(response.statusCode).toBe(200);
  });
});
