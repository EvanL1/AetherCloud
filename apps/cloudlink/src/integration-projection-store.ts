import {
  assertPostgresConnectionString,
  NodePostgresPool,
} from "@aether-cloud/fleet-postgres-adapter";
import { InMemoryIntegrationProjectionRepository } from "@aether-cloud/integration-projection-memory-adapter";
import {
  PostgresIntegrationProjectionRepository,
  type PostgresIntegrationProjectionPool,
} from "@aether-cloud/integration-projection-postgres-adapter";

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

export interface ClosableProjectionPool extends PostgresIntegrationProjectionPool {
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
  return assertPostgresConnectionString(environment.AETHER_CLOUD_POSTGRES_URL, {
    variable: "AETHER_CLOUD_POSTGRES_URL",
    roleName: "aethercloud_cloudlink_ingress",
    requiredWhen: "the projection store is postgres",
  });
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
    NodePostgresPool.fromConfig(configuration);
  return {
    repository: new PostgresIntegrationProjectionRepository(pool),
    pool,
  };
}
