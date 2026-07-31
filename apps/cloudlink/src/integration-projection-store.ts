import { NodePostgresPool } from "@aether-cloud/fleet-postgres-adapter";
import { InMemoryIntegrationProjectionRepository } from "@aether-cloud/integration-projection-memory-adapter";
import {
  PostgresIntegrationProjectionRepository,
  type PostgresIntegrationProjectionPool,
} from "@aether-cloud/integration-projection-postgres-adapter";
import { URL } from "node:url";

import type {
  IntegrationProjectionCatalog,
  IntegrationProjectionRepository,
} from "@aether-cloud/application";

export interface IntegrationProjectionPoolConfiguration {
  readonly connectionString: string;
  readonly max: number;
  readonly connectionTimeoutMillis: number;
  readonly idleTimeoutMillis: number;
  readonly statement_timeout: number;
}

interface ClosableProjectionPool extends PostgresIntegrationProjectionPool {
  end(): Promise<void>;
}

export interface IntegrationProjectionStoreFactories {
  readonly postgresPoolFactory?: (
    configuration: IntegrationProjectionPoolConfiguration,
  ) => ClosableProjectionPool;
}

export interface IntegrationProjectionStore {
  readonly repository: IntegrationProjectionRepository &
    IntegrationProjectionCatalog;
  readonly pool?: ClosableProjectionPool;
}

function connectionString(environment: NodeJS.ProcessEnv): string {
  const input = environment.AETHER_CLOUD_POSTGRES_URL;
  if (input === undefined || input.length === 0) {
    throw new Error(
      "AETHER_CLOUD_POSTGRES_URL is required when the projection store is postgres",
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
  if (parsed.password.length === 0) {
    throw new Error("AETHER_CLOUD_POSTGRES_URL must include a password");
  }
  if (parsed.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("AETHER_CLOUD_POSTGRES_URL must use verify-full TLS");
  }
  return input;
}

export function composeIntegrationProjectionStore(
  environment: NodeJS.ProcessEnv,
  factories: IntegrationProjectionStoreFactories = {},
): IntegrationProjectionStore {
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
  const configuration: IntegrationProjectionPoolConfiguration = {
    connectionString: connectionString(environment),
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5_000,
  };
  const pool =
    factories.postgresPoolFactory?.(configuration) ??
    (NodePostgresPool.fromConfig(configuration) as ClosableProjectionPool);
  return {
    repository: new PostgresIntegrationProjectionRepository(pool),
    pool,
  };
}
