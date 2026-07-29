import { describe, expect, it } from "vitest";

import type {
  PostgresAuditClient,
  PostgresAuditQueryResult,
} from "@aether-cloud/audit-postgres-adapter";

import { activatePostgresApplicationRole } from "../src/postgres-role-activation.js";

class RoleClient implements PostgresAuditClient {
  readonly statements: string[] = [];
  readonly #validRole: boolean;
  released = false;

  constructor(validRole = true) {
    this.#validRole = validRole;
  }

  query<Row extends Record<string, unknown>>(
    text: string,
  ): Promise<PostgresAuditQueryResult<Row>> {
    this.statements.push(text);
    const rows = text.includes("FROM pg_catalog.pg_roles")
      ? [
          {
            rolcanlogin: this.#validRole,
            rolbypassrls: false,
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
          },
        ]
      : [];
    return Promise.resolve({
      rows: rows as unknown as readonly Row[],
      rowCount: rows.length,
    });
  }

  release(): void {
    this.released = true;
  }
}

describe("activatePostgresApplicationRole", () => {
  it("activates and verifies only the constrained application role", async () => {
    const client = new RoleClient();

    await activatePostgresApplicationRole(
      { connect: () => Promise.resolve(client) },
      "a".repeat(64),
    );

    expect(client.statements).toEqual([
      "BEGIN",
      `ALTER ROLE aethercloud_app LOGIN PASSWORD '${"a".repeat(64)}'`,
      expect.stringContaining("FROM pg_catalog.pg_roles"),
      "COMMIT",
    ]);
    expect(client.released).toBe(true);
  });

  it("rejects non-generated secrets before opening a connection", async () => {
    let connected = false;

    await expect(
      activatePostgresApplicationRole(
        {
          connect: () => {
            connected = true;
            return Promise.reject(new Error("must not connect"));
          },
        },
        "unsafe-password",
      ),
    ).rejects.toThrow(/64-character lowercase hexadecimal/);
    expect(connected).toBe(false);
  });

  it("rolls back if role attributes are unsafe", async () => {
    const client = new RoleClient(false);

    await expect(
      activatePostgresApplicationRole(
        { connect: () => Promise.resolve(client) },
        "b".repeat(64),
      ),
    ).rejects.toThrow(/verification failed/);
    expect(client.statements.at(-1)).toBe("ROLLBACK");
    expect(client.released).toBe(true);
  });
});
