import type {
  PostgresAuditClient,
  PostgresAuditPool,
} from "@aether-cloud/audit-postgres-adapter";

const roleVerificationSql = `
SELECT
  rolcanlogin,
  rolbypassrls,
  rolsuper,
  rolcreatedb,
  rolcreaterole
FROM pg_catalog.pg_roles
WHERE rolname = 'aethercloud_app'
`;

type Row = Record<string, unknown>;

function verifiedApplicationRole(row: Row | undefined): boolean {
  return (
    row !== undefined &&
    row.rolcanlogin === true &&
    row.rolbypassrls === false &&
    row.rolsuper === false &&
    row.rolcreatedb === false &&
    row.rolcreaterole === false
  );
}

async function rollback(client: PostgresAuditClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original activation failure remains authoritative.
  }
}

export async function activatePostgresApplicationRole(
  pool: PostgresAuditPool,
  password: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(password)) {
    throw new Error(
      "PostgreSQL application password must be a generated 64-character lowercase hexadecimal value",
    );
  }
  let client: PostgresAuditClient | undefined;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(
      `ALTER ROLE aethercloud_app LOGIN PASSWORD '${password}'`,
    );
    const verified = await client.query<Row>(roleVerificationSql);
    if (!verifiedApplicationRole(verified.rows[0])) {
      throw new Error("PostgreSQL application role verification failed");
    }
    await client.query("COMMIT");
  } catch (error: unknown) {
    if (client !== undefined && transactionStarted) await rollback(client);
    if (
      error instanceof Error &&
      error.message.includes("verification failed")
    ) {
      throw error;
    }
    throw new Error("PostgreSQL application role activation failed", {
      cause: error,
    });
  } finally {
    client?.release();
  }
}
