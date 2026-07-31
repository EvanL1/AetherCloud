import { describe, expect, it } from "vitest";

import { composeIntegrationProjectionStore } from "../src/integration-projection-store.js";

describe("composeIntegrationProjectionStore", () => {
  it("defaults to the memory repository so the default test path needs no database", () => {
    const store = composeIntegrationProjectionStore({});

    expect(store.repository).toBeDefined();
    expect(store.pool).toBeUndefined();
  });

  it("accepts an explicit memory selection", () => {
    const store = composeIntegrationProjectionStore({
      AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "memory",
    });

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

  it("requires a verify-full TLS PostgreSQL URL when postgres is selected", () => {
    expect(() =>
      composeIntegrationProjectionStore({
        AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "postgresql://user:secret@db.example:5432/aether",
      }),
    ).toThrow("AETHER_CLOUD_POSTGRES_URL must use verify-full TLS");
  });

  it("builds a PostgreSQL repository through the injected pool factory", () => {
    let seenMax: number | undefined;
    const store = composeIntegrationProjectionStore(
      {
        AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "postgresql://user:secret@db.example:5432/aether?sslmode=verify-full",
      },
      {
        postgresPoolFactory(configuration) {
          seenMax = configuration.max;
          return {
            query: () => Promise.reject(new Error("unused")),
            connect: () => Promise.reject(new Error("unused")),
            end: () => Promise.resolve(),
          };
        },
      },
    );

    expect(seenMax).toBe(5);
    expect(store.pool).toBeDefined();
  });
});
