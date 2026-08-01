import { describe, expect, it } from "vitest";

import { InMemoryIntegrationProjectionRepository } from "@aether-cloud/integration-projection-memory-adapter";
import { PostgresIntegrationProjectionRepository } from "@aether-cloud/integration-projection-postgres-adapter";

import { composeIntegrationProjectionStore } from "../src/integration-projection-store.js";

const validPostgresUrl =
  "postgresql://aethercloud_cloudlink_ingress:secret@db.example:5432/aether?sslmode=verify-full";

describe("composeIntegrationProjectionStore", () => {
  it("defaults to the memory repository so the default test path needs no database", () => {
    const store = composeIntegrationProjectionStore({});

    expect(store.repository).toBeInstanceOf(
      InMemoryIntegrationProjectionRepository,
    );
    expect(store.pool).toBeUndefined();
  });

  it("accepts an explicit memory selection", () => {
    const store = composeIntegrationProjectionStore({
      AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "memory",
    });

    expect(store.repository).toBeInstanceOf(
      InMemoryIntegrationProjectionRepository,
    );
    expect(store.pool).toBeUndefined();
  });

  it("rejects an unknown store selection", () => {
    expect(() =>
      composeIntegrationProjectionStore({
        AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "sqlite",
      }),
    ).toThrow(
      "AETHER_CLOUD_INTEGRATION_PROJECTION_STORE must be memory or postgres",
    );
  });

  it("rejects a missing PostgreSQL URL when postgres is selected", () => {
    expect(() =>
      composeIntegrationProjectionStore({
        AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "postgres",
      }),
    ).toThrow(
      "AETHER_CLOUD_POSTGRES_URL is required when the projection store is postgres",
    );
  });

  it("rejects an unparseable PostgreSQL URL", () => {
    expect(() =>
      composeIntegrationProjectionStore({
        AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL: "not a url",
      }),
    ).toThrow(
      "AETHER_CLOUD_POSTGRES_URL must be a parseable PostgreSQL connection URL",
    );
  });

  it("rejects a non-PostgreSQL protocol", () => {
    expect(() =>
      composeIntegrationProjectionStore({
        AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "mysql://aethercloud_cloudlink_ingress:secret@db.example:5432/aether?sslmode=verify-full",
      }),
    ).toThrow(
      "AETHER_CLOUD_POSTGRES_URL must use the postgres: or postgresql: protocol",
    );
  });

  it("rejects a connection that does not authenticate as the isolated ingress role", () => {
    expect(() =>
      composeIntegrationProjectionStore({
        AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "postgresql://aethercloud_app:secret@db.example:5432/aether?sslmode=verify-full",
      }),
    ).toThrow(
      "AETHER_CLOUD_POSTGRES_URL must authenticate as the aethercloud_cloudlink_ingress role",
    );
  });

  it("rejects an empty password", () => {
    expect(() =>
      composeIntegrationProjectionStore({
        AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "postgresql://aethercloud_cloudlink_ingress@db.example:5432/aether?sslmode=verify-full",
      }),
    ).toThrow("AETHER_CLOUD_POSTGRES_URL must include a password");
  });

  it("requires a verify-full TLS PostgreSQL URL when postgres is selected", () => {
    expect(() =>
      composeIntegrationProjectionStore({
        AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "postgresql://aethercloud_cloudlink_ingress:secret@db.example:5432/aether",
      }),
    ).toThrow("AETHER_CLOUD_POSTGRES_URL must use verify-full TLS");
  });

  it("builds a PostgreSQL repository through the injected pool factory", () => {
    let seenMax: number | undefined;
    let seenConnectionString: string | undefined;
    const store = composeIntegrationProjectionStore(
      {
        AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL: validPostgresUrl,
      },
      {
        postgresPoolFactory(configuration) {
          seenMax = configuration.max;
          seenConnectionString = configuration.connectionString;
          return {
            connect: () =>
              Promise.resolve({
                query: () => Promise.reject(new Error("unused")),
                release: () => undefined,
              }),
            end: () => Promise.resolve(),
          };
        },
      },
    );

    expect(seenMax).toBe(5);
    expect(seenConnectionString).toBe(validPostgresUrl);
    expect(store.repository).toBeInstanceOf(
      PostgresIntegrationProjectionRepository,
    );
    expect(store.pool).toBeDefined();
  });
});
