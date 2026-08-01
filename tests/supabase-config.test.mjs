import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFile, readdir, readlink } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const root = new URL("../", import.meta.url);
const migrationBindings = [
  [
    "supabase/migrations/20260728000100_gateway_identity.sql",
    "adapters/fleet/postgres/migrations/0001_gateway_identity.sql",
  ],
  [
    "supabase/migrations/20260728000200_cloudlink_telemetry.sql",
    "adapters/telemetry/postgres/migrations/0002_cloudlink_telemetry.sql",
  ],
  [
    "supabase/migrations/20260728000300_integration_projection.sql",
    "adapters/integration-projection/postgres/migrations/0003_integration_projection.sql",
  ],
  [
    "supabase/migrations/20260728000400_integration_control.sql",
    "adapters/integration-control/postgres/migrations/0004_integration_control.sql",
  ],
  [
    "supabase/migrations/20260728000500_cloudlink_session.sql",
    "adapters/cloudlink/postgres/migrations/0005_cloudlink_session.sql",
  ],
  [
    "supabase/migrations/20260728000700_cloudlink_session_health.sql",
    "adapters/cloudlink/postgres/migrations/0006_cloudlink_session_health.sql",
  ],
];

test("the deployed Supabase CA is pinned and valid for certificate signing", async () => {
  const pem = await readFile(
    new URL("deploy/certs/supabase-prod-ca-2021.crt", root),
    "utf8",
  );
  const certificate = new X509Certificate(pem);

  assert.equal(certificate.ca, true);
  assert.equal(
    certificate.subject,
    "C=US\nST=Delware\nL=New Castle\nO=Supabase Inc\nCN=Supabase Root 2021 CA",
  );
  assert.equal(
    certificate.fingerprint256,
    "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA",
  );
  assert.ok(
    Date.parse(certificate.validTo) > Date.parse("2030-01-01T00:00:00Z"),
  );
});

test("Supabase keeps the private AetherCloud schema off the Data API", async () => {
  const config = await readFile(new URL("supabase/config.toml", root), "utf8");

  assert.match(config, /project_id = "AetherCloud"/);
  assert.match(config, /major_version = 17/);
  assert.match(config, /schemas = \["public", "graphql_public"\]/);
  assert.doesNotMatch(config, /schemas = \[[^\n]*"aethercloud"/);
  assert.match(
    config,
    /\[db\.seed\]\n# Production data is never seeded by the deployment configuration\.\nenabled = false\nsql_paths = \[\]/,
  );
});

test("Supabase declares hardened production Auth and database TLS settings", async () => {
  const config = await readFile(new URL("supabase/config.toml", root), "utf8");

  assert.match(config, /\[db\.ssl_enforcement\]\nenabled = true/);
  assert.match(config, /site_url = "https:\/\/cloud\.aetheriot\.dev"/);
  assert.match(
    config,
    /additional_redirect_urls = \["https:\/\/cloud\.aetheriot\.dev"\]/,
  );
  assert.match(config, /minimum_password_length = 8/);
  assert.match(config, /\[auth\.email\][\s\S]*enable_confirmations = true/);
  assert.match(config, /\[auth\.email\][\s\S]*secure_password_change = true/);
  assert.match(config, /enable_anonymous_sign_ins = false/);
});

test("Supabase provisions a non-login least-privilege application role", async () => {
  const migration = await readFile(
    new URL("supabase/migrations/20260728000600_application_role.sql", root),
    "utf8",
  );

  assert.match(migration, /CREATE ROLE aethercloud_app/);
  assert.match(migration, /NOLOGIN/);
  assert.match(migration, /NOBYPASSRLS/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE/);
  assert.doesNotMatch(migration, /\bPASSWORD\b/);
  assert.doesNotMatch(migration, /\bBYPASSRLS\b(?!\s*=\s*false)/);
  assert.doesNotMatch(migration, /GRANT[^;]*DELETE/);
});

test("Supabase provisions an isolated CloudLink health worker role", async () => {
  const migration = await readFile(
    new URL(
      "supabase/migrations/20260728000800_cloudlink_health_worker_role.sql",
      root,
    ),
    "utf8",
  );

  assert.match(migration, /CREATE ROLE aethercloud_cloudlink_health_worker/);
  assert.match(migration, /NOLOGIN/);
  assert.match(migration, /NOBYPASSRLS/);
  assert.match(
    migration,
    /GRANT SELECT, UPDATE ON aethercloud\.cloudlink_sessions/,
  );
  assert.doesNotMatch(migration, /GRANT[^;]*DELETE/);
  assert.doesNotMatch(migration, /\bPASSWORD\b/);
});

test("Supabase provisions an isolated CloudLink ingress role", async () => {
  const migration = await readFile(
    new URL(
      "supabase/migrations/20260728000900_cloudlink_ingress_role.sql",
      root,
    ),
    "utf8",
  );

  assert.match(migration, /CREATE ROLE aethercloud_cloudlink_ingress/);
  assert.match(migration, /NOLOGIN/);
  assert.match(migration, /NOBYPASSRLS/);
  assert.match(
    migration,
    /GRANT SELECT, INSERT, UPDATE ON aethercloud\.cloudlink_sessions/,
  );
  assert.match(
    migration,
    /GRANT SELECT, INSERT, UPDATE ON aethercloud\.integration_projections/,
  );
  assert.doesNotMatch(migration, /aethercloud\.gateway_identities/);
  assert.doesNotMatch(migration, /GRANT[^;]*DELETE/);
  assert.doesNotMatch(migration, /\bPASSWORD\b/);
});

test("every GRANT in a migration that contains one grants SELECT wherever it grants UPDATE", async () => {
  // PostgreSQL requires SELECT privilege on any existing-row column read by
  // an INSERT ... ON CONFLICT DO UPDATE's SET/WHERE clause, an UPDATE's
  // WHERE clause, or a RETURNING list, on top of the SELECT ... FOR UPDATE
  // locking clauses repositories use. A table granted UPDATE without SELECT
  // silently breaks at runtime instead of at review or `pnpm check` time.
  //
  // Scope, chosen deliberately: this scans every migration file that
  // contains the word GRANT anywhere, not only files named "*_role.sql".
  // That is broader than matching on filename and cannot be evaded by
  // naming a future grant-bearing migration something else (the forward-fix
  // migration in this same change, "*_select_fix.sql", is exactly that
  // case, and is picked up automatically).
  //
  // Coverage limit, not fixed by this guard: it is a table-level privilege
  // check only. An INSERT-only grant (audit_events, outbox_events today) is
  // correct as long as its statement stays INSERT-only; if that statement
  // later gains a RETURNING clause or an ON CONFLICT DO UPDATE, this guard
  // would still show green until the corresponding GRANT is also widened.
  // It catches "UPDATE without SELECT", not "every privilege a statement
  // will ever need".
  const migrationsDir = new URL("supabase/migrations/", root);
  const entries = await readdir(migrationsDir);
  assert.ok(entries.length > 0, "found no files under supabase/migrations/");

  // Recognizes exactly the GRANT shapes this repository's migrations use:
  // an explicit table list (aethercloud.foo[, aethercloud.bar]...), a
  // whole-schema form (ALL TABLES/SEQUENCES/FUNCTIONS IN SCHEMA aethercloud
  // or bare TABLES/SEQUENCES/FUNCTIONS from an ALTER DEFAULT PRIVILEGES
  // clause), or a SCHEMA/DATABASE grant. Uppercase privilege keywords, no
  // ALL/ALL PRIVILEGES, no column lists, no trailing whitespace before the
  // semicolon. Anything else (lowercase, GRANT ALL, GRANT UPDATE (col), an
  // unrecognized target, ...) is deliberately NOT matched here, so it falls
  // through to the "cannot parse" failure below instead of being silently
  // ignored.
  const knownGrantPattern =
    /^GRANT\s+((?:SELECT|INSERT|UPDATE|DELETE|CONNECT|USAGE|EXECUTE)(?:\s*,\s*(?:SELECT|INSERT|UPDATE|DELETE|CONNECT|USAGE|EXECUTE))*)\s+ON\s+(aethercloud\.[a-z_]+(?:\s*,\s*aethercloud\.[a-z_]+)*|ALL TABLES IN SCHEMA aethercloud|ALL SEQUENCES IN SCHEMA aethercloud|ALL FUNCTIONS IN SCHEMA aethercloud|TABLES|SEQUENCES|FUNCTIONS|SCHEMA aethercloud|DATABASE postgres)\s+TO\s+\w+;$/;
  // Finds every GRANT statement text (case-insensitively, so a lowercase or
  // mixed-case statement is still found and then fails the strict parser
  // above instead of being invisible to this scan) from the GRANT keyword
  // to its terminating semicolon.
  const anyGrantStatementPattern = /\bGRANT\b[\s\S]*?;/gi;
  // SQL line comments are stripped before scanning so an explanatory
  // comment that happens to mention "grant" (as this very test's migration
  // files do) is never mistaken for the start of a statement.
  const stripLineComments = (sql) => sql.replace(/--[^\n]*/g, "");

  let checked = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".sql")) continue;
    const migration = stripLineComments(
      await readFile(new URL(entry, migrationsDir), "utf8"),
    );
    if (!/\bGRANT\b/i.test(migration)) continue;

    for (const [statement] of migration.matchAll(anyGrantStatementPattern)) {
      const match = statement.match(knownGrantPattern);
      assert.ok(
        match,
        `${entry}: GRANT statement does not match the supported style and ` +
          `cannot be checked for the SELECT/UPDATE invariant: "${statement}". ` +
          "Normalize the statement to this repository's GRANT style, or " +
          "extend knownGrantPattern in this test.",
      );
      checked += 1;
      const [, privilegeList, target] = match;
      const privileges = privilegeList.split(",").map((value) => value.trim());
      if (!privileges.includes("UPDATE")) continue;
      assert.ok(
        privileges.includes("SELECT"),
        `${entry}: "${target}" is granted UPDATE without SELECT`,
      );
    }
  }
  assert.ok(
    checked > 0,
    "found no GRANT statement to check across any migration",
  );
});

test("Supabase migration history follows the adapter-owned SQL in order", async () => {
  for (const [bindingPath, sourcePath] of migrationBindings) {
    const bindingUrl = new URL(bindingPath, root);
    const sourceUrl = new URL(sourcePath, root);
    const linkedPath = await readlink(bindingUrl);
    assert.equal(
      fileURLToPath(new URL(linkedPath, bindingUrl)),
      fileURLToPath(sourceUrl),
    );
    assert.equal(
      await readFile(bindingUrl, "utf8"),
      await readFile(sourceUrl, "utf8"),
    );
  }
});
