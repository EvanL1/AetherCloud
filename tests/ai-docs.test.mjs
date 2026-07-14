import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

const requiredDocuments = [
  "README.md",
  "AGENTS.md",
  "llms.txt",
  "ai/docs-manifest.json",
  "ai/application-contracts.json",
  "ai/invariants.md",
  "skills/aether-cloud/SKILL.md",
  "docs/get-started/overview.md",
  "docs/concepts/architecture.md",
  "docs/concepts/audit-and-integrations.md",
  "docs/concepts/artifact-registry.md",
  "docs/concepts/cloudlink-and-core-state-machines.md",
  "docs/concepts/current-state-audit.md",
  "docs/concepts/edge-cloud-boundary.md",
  "docs/concepts/desired-reported-applied-deployment.md",
  "docs/concepts/gateway-identity-and-enrollment.md",
  "docs/concepts/governed-capability-jobs.md",
  "docs/concepts/iot-cloud-capability-map.md",
  "docs/concepts/iot-telemetry.md",
  "docs/concepts/mcp-application-interface.md",
  "docs/concepts/multi-cloud-fusion.md",
  "docs/concepts/operational-observability.md",
  "docs/concepts/resource-model.md",
  "docs/guides/build-with-an-agent.md",
  "docs/guides/iot-cloud-roadmap.md",
  "docs/guides/add-provider-adapter.md",
  "docs/guides/plan-infrastructure.md",
  "docs/reference/http-api.md",
  "docs/reference/application-contracts.md",
  "docs/reference/repository-layout.md",
  "docs/reference/terminology.md",
  "docs/adr/0001-edge-first-cloud-control-plane.md",
  "docs/adr/0002-typescript-modular-monolith.md",
  "docs/adr/0003-agent-ready-documentation.md",
  "docs/adr/0004-multi-cloud-fusion.md",
  "docs/adr/0005-gateway-identity-and-enrollment.md",
  "docs/adr/0006-cloudlink-durable-delivery.md",
  "docs/adr/0007-durable-iot-telemetry.md",
  "docs/adr/0008-operational-observability.md",
  "docs/adr/0009-immutable-artifact-publication.md",
  "docs/adr/0010-desired-reported-applied-deployment.md",
  "docs/adr/0011-governed-capability-jobs.md",
  "docs/adr/0012-durable-audit-and-outbound-integrations.md",
];

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function parseFrontmatter(path) {
  const source = read(path);
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${path} must start with YAML frontmatter`);

  return Object.fromEntries(
    match[1]
      .split("\n")
      .map((line) => line.match(/^([a-z_]+):\s+(.+)$/))
      .filter(Boolean)
      .map((entry) => [entry[1], entry[2].replace(/^['"]|['"]$/g, "")]),
  );
}

test("the repository exposes the minimum agent documentation surface", () => {
  for (const path of requiredDocuments) {
    assert.ok(existsSync(join(root, path)), `missing ${path}`);
  }
});

test("llms.txt only links to existing local Markdown documents", () => {
  const links = [...read("llms.txt").matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !target.startsWith("http"));

  assert.ok(
    links.length >= 10,
    "llms.txt should be a useful index, not a stub",
  );

  for (const target of links) {
    assert.ok(
      existsSync(join(root, target)),
      `llms.txt has a broken link: ${target}`,
    );
  }
});

test("the machine-readable manifest matches document frontmatter", () => {
  const manifest = JSON.parse(read("ai/docs-manifest.json"));
  const seen = new Set();

  assert.equal(manifest.schema_version, 2);
  assert.ok(manifest.documents.length >= 10);

  for (const document of manifest.documents) {
    assert.ok(
      !seen.has(document.path),
      `duplicate manifest path: ${document.path}`,
    );
    seen.add(document.path);
    assert.ok(
      existsSync(join(root, document.path)),
      `missing ${document.path}`,
    );

    const frontmatter = parseFrontmatter(document.path);
    assert.equal(
      document.title,
      frontmatter.title,
      `${document.path} title drifted`,
    );
    assert.equal(
      document.description,
      frontmatter.description,
      `${document.path} description drifted`,
    );
    assert.ok(
      ["deprecated", "implemented", "mixed", "normative", "planned"].includes(
        document.status,
      ),
      `${document.path} has an invalid implementation status`,
    );
    assert.equal(
      document.status,
      frontmatter.status,
      `${document.path} implementation status drifted`,
    );
  }
});

test("agent-facing documents are complete and route agents to deeper context", () => {
  const manifest = JSON.parse(read("ai/docs-manifest.json"));

  for (const document of manifest.documents) {
    const source = read(document.path);
    assert.doesNotMatch(
      source,
      /\b(?:TODO|TBD|PLACEHOLDER)\b/i,
      `${document.path} is incomplete`,
    );
  }

  const skill = read("skills/aether-cloud/SKILL.md");
  assert.match(skill, /^name:\s*aether-cloud$/m);
  assert.match(skill, /## Documentation routing/);
  assert.match(skill, /edge remains authoritative/i);
  assert.match(skill, /deny by default/i);
  assert.match(skill, /provider adapter/i);
  assert.match(skill, /OpenTofu/i);
});

test("machine-readable application contracts distinguish governance and implementation", () => {
  const catalog = JSON.parse(read("ai/application-contracts.json"));

  assert.equal(catalog.schema_version, 1);
  assert.ok(catalog.capabilities.length >= 8);
  assert.ok(catalog.errors.length >= 8);
  assert.ok(catalog.events.length >= 4);
  assert.ok(catalog.http_operations.length >= 2);
  assert.ok(catalog.mcp_exposures.length >= 4);

  const names = new Set();
  for (const capability of catalog.capabilities) {
    assert.ok(
      !names.has(capability.name),
      `duplicate capability ${capability.name}`,
    );
    names.add(capability.name);
    assert.ok(
      ["implemented", "partial", "planned", "deprecated"].includes(
        capability.status,
      ),
      `${capability.name} has invalid status`,
    );
    assert.equal(typeof capability.permission, "string");
    assert.ok(capability.permission.length > 0);
    if (capability.kind === "command") {
      assert.ok(
        ["low", "medium", "high", "critical"].includes(capability.risk),
      );
      assert.ok(["not-required", "explicit"].includes(capability.confirmation));
      assert.equal(capability.idempotency, "required");
      assert.equal(capability.expiry, "required");
      assert.equal(capability.audit, "required");
    }
  }

  for (const exposure of catalog.mcp_exposures) {
    assert.ok(["implemented", "planned"].includes(exposure.interface_status));
    assert.ok(["implemented", "planned"].includes(exposure.transport_status));
    if (exposure.kind === "tool") {
      const capability = catalog.capabilities.find(
        (candidate) => candidate.name === exposure.capability,
      );
      assert.ok(capability, `missing MCP capability ${exposure.capability}`);
      assert.equal(capability.kind, "command");
    }
  }
});

test("telemetry documentation separates business data, live authority, audit, and OpenTelemetry", () => {
  const telemetry = read("docs/concepts/iot-telemetry.md");
  const observability = read("docs/concepts/operational-observability.md");

  assert.match(telemetry, /durable acknowledgement/i);
  assert.match(telemetry, /conflicting duplicate/i);
  assert.match(telemetry, /not.*live.*authority/is);
  assert.match(observability, /OpenTelemetry/);
  assert.match(observability, /not.*IoT.*telemetry/is);
  assert.match(observability, /not.*audit/is);
  assert.match(observability, /high.cardinality/i);
});

test("integration documentation preserves audit, delivery, SSRF, and export boundaries", () => {
  const source = read("docs/concepts/audit-and-integrations.md");

  assert.match(source, /append-only/i);
  assert.match(source, /same application query/i);
  assert.match(source, /idempotency key/i);
  assert.match(source, /dead-letter/i);
  assert.match(source, /SSRF/i);
  assert.match(source, /object reference/i);
  assert.match(source, /OpenTelemetry.*neither.*audit/is);
  assert.match(source, /implemented/i);
  assert.match(source, /planned/i);
});

test("MCP documentation exposes governance without inventing a wire server", () => {
  const source = read("docs/concepts/mcp-application-interface.md");

  assert.match(source, /same `SearchAuditEvents`/);
  assert.match(
    source,
    /permission.*risk.*confirmation.*idempotency.*expiry.*audit/is,
  );
  assert.match(source, /mcp-tool-not-implemented/);
  assert.match(source, /does not own business state/i);
  assert.match(source, /no\s+MCP SDK transport/i);
  assert.match(source, /implemented/i);
  assert.match(source, /planned/i);
});

test("multi-cloud documentation preserves provider differences and state isolation", () => {
  const source = read("docs/concepts/multi-cloud-fusion.md");

  assert.match(source, /capability-driven/i);
  assert.match(source, /provider-specific/i);
  assert.match(source, /OpenTofu/i);
  assert.match(source, /one state/i);
  assert.match(source, /short-lived credentials/i);
});

test("provider adapter documentation routes agents through the implemented contract", () => {
  const source = read("docs/guides/add-provider-adapter.md");

  assert.match(source, /ProviderAdapter/);
  assert.match(source, /CloudConnection/);
  assert.match(source, /providerAdapterConformance/);
  assert.match(source, /implemented/i);
  assert.match(source, /planned/i);
  assert.match(source, /secret reference/i);
});

test("infrastructure planning documentation preserves the Plan-only safety boundary", () => {
  const source = read("docs/guides/plan-infrastructure.md");

  assert.match(source, /PlanDeploymentStack/);
  assert.match(source, /InfrastructureEngine/);
  assert.match(source, /infrastructureEngineConformance/);
  assert.match(source, /no Apply operation/i);
  assert.match(source, /encrypted/i);
  assert.match(source, /raw.*JSON.*sensitive/i);
  assert.match(source, /OpenTofuInfrastructureEngine/);
  assert.match(source, /NodeOpenTofuProcessRunner/);
  assert.match(source, /tofu version -json/);
  assert.match(source, /test:opentofu-integration/);
  assert.match(source, /0700/);
  assert.match(source, /0600/);
  assert.match(source, /remote State.*planned/is);
  assert.match(source, /production.*artifact store.*planned/is);
  assert.match(source, /implemented/i);
  assert.match(source, /planned/i);
});

test("relative Markdown links inside indexed documents resolve", () => {
  const manifest = JSON.parse(read("ai/docs-manifest.json"));

  for (const document of manifest.documents) {
    const source = read(document.path);
    const targets = [...source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
      .map((match) => match[1].split("#", 1)[0])
      .filter(
        (target) =>
          target && !target.startsWith("http") && !target.startsWith("mailto:"),
      );

    for (const target of targets) {
      const resolved = join(root, dirname(document.path), target);
      assert.ok(
        existsSync(resolved),
        `${document.path} links to missing ${relative(root, resolved)}`,
      );
    }
  }
});
