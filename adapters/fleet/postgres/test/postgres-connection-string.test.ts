import { describe, expect, it } from "vitest";

import { assertPostgresConnectionString } from "../src/index.js";

const options = {
  variable: "AETHER_CLOUD_POSTGRES_URL",
  roleName: "aethercloud_app",
  requiredWhen: "postgres mode is selected",
} as const;

describe("assertPostgresConnectionString", () => {
  it("returns the input unchanged when every rule is satisfied", () => {
    const input =
      "postgresql://aethercloud_app:secret@database.example:5432/postgres?sslmode=verify-full";

    expect(assertPostgresConnectionString(input, options)).toBe(input);
  });

  it("accepts a Supabase pooler role.project username", () => {
    const input =
      "postgresql://aethercloud_app.pooler-project:secret@database.example:5432/postgres?sslmode=verify-full";

    expect(assertPostgresConnectionString(input, options)).toBe(input);
  });

  it("rejects a missing value", () => {
    expect(() => assertPostgresConnectionString(undefined, options)).toThrow(
      "AETHER_CLOUD_POSTGRES_URL is required when postgres mode is selected",
    );
  });

  it("rejects an empty value", () => {
    expect(() => assertPostgresConnectionString("", options)).toThrow(
      "AETHER_CLOUD_POSTGRES_URL is required when postgres mode is selected",
    );
  });

  it("rejects an unparseable URL with a message distinct from an invalid protocol", () => {
    expect(() => assertPostgresConnectionString("not a url", options)).toThrow(
      "AETHER_CLOUD_POSTGRES_URL must be a parseable PostgreSQL connection URL",
    );
  });

  it("rejects a non-PostgreSQL protocol with a message distinct from an unparseable URL", () => {
    expect(() =>
      assertPostgresConnectionString(
        "mysql://aethercloud_app:secret@database.example:5432/postgres?sslmode=verify-full",
        options,
      ),
    ).toThrow(
      "AETHER_CLOUD_POSTGRES_URL must use the postgres: or postgresql: protocol",
    );
  });

  it("rejects a username that is not the dedicated role", () => {
    expect(() =>
      assertPostgresConnectionString(
        "postgresql://postgres:secret@database.example:5432/postgres?sslmode=verify-full",
        options,
      ),
    ).toThrow(
      "AETHER_CLOUD_POSTGRES_URL must authenticate as the aethercloud_app role",
    );
  });

  it("rejects a username that only shares the role name as a prefix without the pooler separator", () => {
    expect(() =>
      assertPostgresConnectionString(
        "postgresql://aethercloud_app_owner:secret@database.example:5432/postgres?sslmode=verify-full",
        options,
      ),
    ).toThrow(
      "AETHER_CLOUD_POSTGRES_URL must authenticate as the aethercloud_app role",
    );
  });

  it("rejects an empty password", () => {
    expect(() =>
      assertPostgresConnectionString(
        "postgresql://aethercloud_app@database.example:5432/postgres?sslmode=verify-full",
        options,
      ),
    ).toThrow("AETHER_CLOUD_POSTGRES_URL must include a password");
  });

  it("rejects a non-verify-full sslmode", () => {
    expect(() =>
      assertPostgresConnectionString(
        "postgresql://aethercloud_app:secret@database.example:5432/postgres?sslmode=require",
        options,
      ),
    ).toThrow("AETHER_CLOUD_POSTGRES_URL must use verify-full TLS");
  });

  it("never includes the connection string, host, username, or password in a thrown message", () => {
    const input =
      "postgresql://aethercloud_app:super-secret-password@database.example:5432/postgres?sslmode=require";

    try {
      assertPostgresConnectionString(input, options);
      throw new Error("expected assertPostgresConnectionString to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("super-secret-password");
      expect(message).not.toContain("database.example");
      expect(message).not.toContain(input);
    }
  });
});
