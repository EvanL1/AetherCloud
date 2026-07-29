import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
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
