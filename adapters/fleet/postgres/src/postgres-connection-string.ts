import { URL } from "node:url";

export interface PostgresConnectionStringOptions {
  /** Name of the environment variable being validated, for error messages. */
  readonly variable: string;
  /** Non-owner role the connection's username must equal or prefix (`role.project` Supabase poolers). */
  readonly roleName: string;
  /** Human-readable condition under which the variable is required, e.g. "postgres mode is selected". */
  readonly requiredWhen: string;
}

/**
 * Validates a PostgreSQL connection string against the shared safety rules
 * every AetherCloud composition root enforces before opening a pool:
 * presence, URL syntax, protocol, dedicated non-owner role identity,
 * a password, and verify-full TLS.
 *
 * Never includes the connection string, host, username, or password in a
 * thrown message — only the variable name and the violated rule.
 */
export function assertPostgresConnectionString(
  input: string | undefined,
  options: PostgresConnectionStringOptions,
): string {
  const { variable, roleName, requiredWhen } = options;
  if (input === undefined || input.length === 0) {
    throw new Error(`${variable} is required when ${requiredWhen}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(
      `${variable} must be a parseable PostgreSQL connection URL`,
    );
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      `${variable} must use the postgres: or postgresql: protocol`,
    );
  }
  const username = decodeURIComponent(parsed.username);
  if (username !== roleName && !username.startsWith(`${roleName}.`)) {
    throw new Error(`${variable} must authenticate as the ${roleName} role`);
  }
  if (parsed.password.length === 0) {
    throw new Error(`${variable} must include a password`);
  }
  if (parsed.searchParams.get("sslmode") !== "verify-full") {
    throw new Error(`${variable} must use verify-full TLS`);
  }
  return input;
}
