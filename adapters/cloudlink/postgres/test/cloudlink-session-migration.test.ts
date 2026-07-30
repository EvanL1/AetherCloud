import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  cloudLinkSessionHealthPostgresMigrationUrl,
  cloudLinkSessionPostgresMigrationUrl,
} from "../src/index.js";

describe("CloudLink session PostgreSQL migration", () => {
  it("defines one Gateway lock head plus scoped session, request, cursor, and challenge tables", async () => {
    const sql = await readFile(cloudLinkSessionPostgresMigrationUrl, "utf8");

    for (const table of [
      "cloudlink_session_heads",
      "cloudlink_sessions",
      "cloudlink_session_open_requests",
      "cloudlink_durable_cursors",
      "cloudlink_session_challenges",
    ]) {
      expect(sql).toContain(`CREATE TABLE aethercloud.${table}`);
      expect(sql).toMatch(
        new RegExp(
          `ALTER TABLE aethercloud\\.${table}\\s+ENABLE ROW LEVEL SECURITY`,
        ),
      );
      expect(sql).toMatch(
        new RegExp(
          `ALTER TABLE aethercloud\\.${table}\\s+FORCE ROW LEVEL SECURITY`,
        ),
      );
      expect(sql).toMatch(
        new RegExp(
          `CREATE POLICY ${table}_tenant_policy[\\s\\S]+?current_setting\\('aethercloud\\.tenant_id', true\\)`,
        ),
      );
    }
    expect(sql).toMatch(/PRIMARY KEY \(tenant_id, project_id, gateway_id\)/);
  });

  it("adds complete durable health leases without weakening Session RLS", async () => {
    const sql = await readFile(
      cloudLinkSessionHealthPostgresMigrationUrl,
      "utf8",
    );

    expect(sql).toContain("ADD COLUMN health_lease_id uuid");
    expect(sql).toContain("ADD COLUMN health_lease_expires_at timestamptz");
    expect(sql).toMatch(
      /\(health_lease_id IS NULL\) = \(health_lease_expires_at IS NULL\)/,
    );
    expect(sql).toContain("cloudlink_sessions_health_due_idx");
    expect(sql).not.toContain("DISABLE ROW LEVEL SECURITY");
  });

  it("bounds uint64, identifiers, closed JSON, authentication fingerprints, and one pending challenge", async () => {
    const sql = await readFile(cloudLinkSessionPostgresMigrationUrl, "utf8");

    expect(sql).toContain("18446744073709551615");
    expect(sql).toContain(
      "char_length(request_state->>'credentialId') BETWEEN 1 AND 256",
    );
    expect(sql).toContain("char_length(request_state->>'clientNonce') = 43");
    expect(sql).toContain(
      "char_length(cloud_authentication->>'signature') = 86",
    );
    expect(sql.match(/credential_generation BETWEEN 1 AND/g)).toHaveLength(3);
    expect(sql).toContain("cloudlink_resume_cursors_valid");
    expect(sql).toContain("request_state - ARRAY[");
    expect(sql).toContain("cloud_authentication - ARRAY[");
    expect(sql.match(/\) IS TRUE\),/g)?.length).toBeGreaterThanOrEqual(2);
    expect(sql).toContain(
      "authentication_fingerprint ~ '^sha256:[0-9a-f]{64}$'",
    );
    expect(sql).toContain("gateway_key_id text CHECK");
    expect(sql).toContain(
      "heartbeat_interval_ms BETWEEN 1 AND 18446744073709551615",
    );
    expect(sql).toMatch(
      /\(gateway_key_id IS NULL\) = \(heartbeat_interval_ms IS NULL\)/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX cloudlink_session_challenges_one_pending_uq[\s\S]+?WHERE consumed_at_ms IS NULL[\s\S]+?superseded_at_ms IS NULL/,
    );
  });
});
