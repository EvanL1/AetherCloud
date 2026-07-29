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
    ).toThrow(/AETHER_CLOUD_POSTGRES_URL/);

    expect(() =>
      composeApiRuntime({
        ...authenticatedEnvironment,
        AETHER_CLOUD_AUDIT_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "postgresql://postgres:secret@database.example:5432/postgres?sslmode=verify-full",
      }),
    ).toThrow(/dedicated non-owner application role/);

    expect(() =>
      composeApiRuntime({
        ...authenticatedEnvironment,
        AETHER_CLOUD_AUDIT_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "postgresql://aethercloud_app_owner:secret@database.example:5432/postgres?sslmode=verify-full",
      }),
    ).toThrow(/dedicated non-owner application role/);

    expect(() =>
      composeApiRuntime({
        ...authenticatedEnvironment,
        AETHER_CLOUD_AUDIT_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "postgresql://aethercloud_app:secret@database.example:5432/postgres?sslmode=require",
      }),
    ).toThrow(/verify-full TLS/);
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
