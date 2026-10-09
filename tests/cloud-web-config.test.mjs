import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the AetherCloud console is an independently deployed cloud subdomain", async () => {
  const wrangler = await read("apps/web/wrangler.toml");
  const website = await read("apps/web/index.html");
  const headers = await read("apps/web/public/_headers");

  assert.match(wrangler, /name = "aethercloud-console"/);
  // Both hostnames serve permanently and both must stay declared. A custom
  // domain missing from this file is invisible to `wrangler deploy`, which is
  // how cloud.aetheriot.ai came to serve without being declared at all.
  assert.match(wrangler, /pattern = "cloud\.aetheriot\.ai"/);
  assert.match(wrangler, /pattern = "cloud\.aetheriot\.dev"/);
  assert.match(wrangler, /custom_domain = true/);
  assert.match(wrangler, /not_found_handling = "single-page-application"/);
  assert.match(website, /<title>AetherCloud Console<\/title>/);
  assert.match(headers, /Content-Security-Policy:/);
  // connect-src has to name every API host the console may call. It is a
  // second allowlist beside the API's CORS origins, enforced by the browser
  // rather than the server, and omitting a host here blocks every request to
  // it no matter what the server allows.
  assert.match(
    headers,
    /connect-src 'self' https:\/\/api\.aetheriot\.ai https:\/\/api\.aetheriot\.dev https:\/\/dvzmvjbiwytvbdedetxs\.supabase\.co/,
  );
  assert.match(
    headers,
    /img-src 'self' https:\/\/aetheriot\.ai https:\/\/aetheriot\.dev data:/,
  );
  assert.match(headers, /frame-ancestors 'none'/);
});

test("the console browser configuration contains no privileged secret", async () => {
  const config = await read("apps/web/src/config.ts");

  assert.match(config, /https:\/\/dvzmvjbiwytvbdedetxs\.supabase\.co/);
  assert.match(config, /sb_publishable_/);
  assert.match(config, /https:\/\/api\.aetheriot\.ai/);
  assert.doesNotMatch(config, /sb_secret_|service_role|database|password/i);
});
