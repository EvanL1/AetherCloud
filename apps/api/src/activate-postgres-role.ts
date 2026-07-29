import { NodePostgresPool } from "@aether-cloud/fleet-postgres-adapter";

import { activatePostgresApplicationRole } from "./postgres-role-activation.js";

const connectionString = process.env.AETHER_CLOUD_POSTGRES_ADMIN_URL;
const password = process.env.AETHER_CLOUD_POSTGRES_APP_PASSWORD;
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("AETHER_CLOUD_POSTGRES_ADMIN_URL is required");
}
if (password === undefined || password.length === 0) {
  throw new Error("AETHER_CLOUD_POSTGRES_APP_PASSWORD is required");
}

const pool = NodePostgresPool.fromConfig({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
  statement_timeout: 10_000,
});

try {
  await activatePostgresApplicationRole(pool, password);
} finally {
  await pool.end();
}
