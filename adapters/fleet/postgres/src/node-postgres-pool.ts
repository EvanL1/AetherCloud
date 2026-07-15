import { Pool, type PoolConfig } from "pg";

import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryResult,
} from "./postgres-contracts.js";

export type NodePostgresDriverClient = PostgresClient;

export interface NodePostgresDriverPool {
  connect(): Promise<NodePostgresDriverClient>;
  end(): Promise<void>;
}

function createDriverPool(config: PoolConfig): NodePostgresDriverPool {
  const pool = new Pool(config);
  return {
    async connect(): Promise<NodePostgresDriverClient> {
      const client = await pool.connect();
      return {
        async query<Row extends Record<string, unknown>>(
          text: string,
          values: readonly unknown[] = [],
        ): Promise<PostgresQueryResult<Row>> {
          const response = await client.query<Row>(text, [...values]);
          return {
            rows: response.rows,
            rowCount: response.rowCount,
          };
        },
        release(): void {
          client.release();
        },
      };
    },
    end(): Promise<void> {
      return pool.end();
    },
  };
}

export class NodePostgresPool implements PostgresPool {
  readonly #driver: NodePostgresDriverPool;

  constructor(driver: NodePostgresDriverPool) {
    this.#driver = driver;
  }

  static fromConfig(config: PoolConfig): NodePostgresPool {
    return new NodePostgresPool(createDriverPool(config));
  }

  connect(): Promise<PostgresClient> {
    return this.#driver.connect();
  }

  end(): Promise<void> {
    return this.#driver.end();
  }
}
