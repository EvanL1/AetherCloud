import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const githubBlobBase = "https://github.com/EvanL1/AetherCloud/blob/main";
const githubRawBase =
  "https://raw.githubusercontent.com/EvanL1/AetherCloud/main";
const publicDocsBase = "https://docs.aetheriot.dev";
const manifestSchemaUrl = `${githubRawBase}/ai/docs-manifest.schema.json`;

const requiredDocuments = [
  "README.md",
  "AGENTS.md",
  "llms.txt",
  "ai/docs-manifest.json",
  "ai/docs-manifest.schema.json",
  "ai/application-contracts.json",
  "ai/invariants.md",
  "scripts/generate-ai-doc-index.mjs",
  "skills/aether-cloud/SKILL.md",
  "docs/get-started/overview.md",
  "docs/get-started/aetheriot-product-family.md",
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
  "docs/concepts/persistence-and-multi-cloud-cells.md",
  "docs/concepts/resource-model.md",
  "docs/guides/build-with-an-agent.md",
  "docs/guides/iot-cloud-roadmap.md",
  "docs/guides/add-provider-adapter.md",
  "docs/guides/plan-infrastructure.md",
  "docs/reference/http-api.md",
  "docs/reference/application-contracts.md",
  "docs/reference/cloudlink-mqtt-v1.md",
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
  "docs/adr/0013-postgresql-control-plane-persistence.md",
  "docs/adr/0014-cloudlink-mqtt-transport-binding.md",
  "docs/adr/0015-cloudlink-interoperability-release-gates.md",
  "docs/adr/0016-pinned-aethercontracts-consumption.md",
  "docs/adr/0017-aetheriot-product-family-naming.md",
  "docs/recovery/credential-revocation-and-reenrollment.md",
  "docs/recovery/cloudlink-offline-and-reconnect.md",
  "docs/recovery/unknown-command-outcome.md",
  "docs/recovery/database-backup-and-restore.md",
  "docs/recovery/emergency-revoke.md",
  "docs/recovery/integration-safe-degradation.md",
  "docs/recovery/infrastructure-lock-failure.md",
];

const documentRoles = [
  "agent-task",
  "operations",
  "safety",
  "recovery",
  "reference",
  "decision",
  "status",
];
const agentProfiles = ["coding-agent", "operator-agent", "runtime-agent"];
const implementationStatuses = [
  "implemented",
  "partial",
  "planned",
  "deprecated",
];
const productionReadinessValues = [
  "production-ready",
  "experimental",
  "not-production-ready",
  "not-applicable",
];
const contextSensitivityValues = [
  "public",
  "internal",
  "redacted-only",
  "sensitive-never-load",
];
const priorities = ["core", "optional"];
const requiredManifestFields = [
  "id",
  "path",
  "canonical_url",
  "title",
  "description",
  "locale",
  "translation_of",
  "document_role",
  "agent_profiles",
  "intents",
  "implementation_status",
  "production_readiness",
  "context_sensitivity",
  "updated",
  "priority",
];

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function isPublishedEnglishUserDocument(document) {
  if (document.locale !== "en") {
    return false;
  }
  if (document.path === "docs/concepts/current-state-audit.md") {
    return false;
  }
  return [
    "docs/get-started/",
    "docs/concepts/",
    "docs/guides/",
    "docs/reference/",
    "docs/recovery/",
  ].some((prefix) => document.path.startsWith(prefix));
}

function expectedCanonicalUrl(document) {
  if (isPublishedEnglishUserDocument(document)) {
    const slug = document.path.slice("docs/".length, -".md".length);
    return `${publicDocsBase}/aethercloud/${slug}.md`;
  }
  return `${githubBlobBase}/${document.path}`;
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

test("llms.txt is a generated English task router covering every catalog document", () => {
  const source = read("llms.txt");
  const links = [...read("llms.txt").matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(
    (match) => match[1],
  );
  const manifest = JSON.parse(read("ai/docs-manifest.json"));
  const agentsUrl = `${githubBlobBase}/AGENTS.md`;
  const skillUrl = `${githubBlobBase}/skills/aether-cloud/SKILL.md`;
  const machineUrls = new Set([
    `${githubRawBase}/ai/application-contracts.json`,
    `${githubRawBase}/ai/docs-manifest.json`,
    manifestSchemaUrl,
  ]);
  const permittedUrls = new Set([
    agentsUrl,
    skillUrl,
    ...machineUrls,
    ...manifest.documents.map((document) => document.canonical_url),
  ]);

  assert.doesNotMatch(source, /[\u3400-\u9fff]/u);
  assert.match(source, /Coding agents/);
  assert.match(source, /Operator agents/);
  assert.match(source, /Runtime agents/);
  assert.equal(
    links.filter((target) => target === agentsUrl).length,
    1,
    "AGENTS.md must be directly reachable from llms.txt",
  );
  assert.equal(
    links.filter((target) => target === skillUrl).length,
    1,
    "the AetherCloud agent skill must be directly reachable from llms.txt",
  );
  assert.match(source, /Static documentation never grants runtime permission/);
  assert.match(source, /live capability catalog/);
  assert.match(source, /deny by default/i);

  for (const target of links) {
    assert.equal(new URL(target).protocol, "https:");
    assert.ok(
      permittedUrls.has(target),
      `llms.txt has an unknown link: ${target}`,
    );
  }

  for (const document of manifest.documents) {
    assert.equal(
      links.filter((target) => target === document.canonical_url).length,
      1,
      `${document.canonical_url} must appear exactly once in llms.txt`,
    );
  }

  const requiredSections = [
    "## Agent Task Manual",
    "## Deployment and Operations",
    "## Safety and Governance",
    "## Recovery",
    "## Platform Reference",
    "## Compatibility and Status",
    "## Optional",
  ];
  let previousSection = -1;
  for (const section of requiredSections) {
    const position = source.indexOf(section);
    assert.ok(
      position > previousSection,
      `${section} is missing or out of order`,
    );
    previousSection = position;
  }

  const optionalPosition = source.indexOf("## Optional");
  for (const document of manifest.documents.filter(
    (entry) => entry.document_role === "decision",
  )) {
    assert.ok(
      source.indexOf(`](${document.canonical_url})`) > optionalPosition,
      `${document.path} must remain optional`,
    );
  }

  const generated = spawnSync(
    process.execPath,
    ["scripts/generate-ai-doc-index.mjs", "--stdout"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(
    source,
    generated.stdout,
    "llms.txt is not deterministically generated",
  );
});

test("the schema-v3 manifest is complete, typed, and matches document metadata", () => {
  const manifest = JSON.parse(read("ai/docs-manifest.json"));
  const schema = JSON.parse(read("ai/docs-manifest.schema.json"));
  const seenPaths = new Set();
  const seenIds = new Set();

  assert.equal(manifest.schema_version, 3);
  assert.equal(manifest.$schema, manifestSchemaUrl);
  assert.equal(schema.$id, manifestSchemaUrl);
  assert.equal(schema.properties.$schema.const, manifestSchemaUrl);
  assert.equal(schema.properties.schema_version.const, 3);
  assert.deepEqual(
    schema.$defs.document.properties.document_role.enum,
    documentRoles,
  );
  assert.deepEqual(
    schema.$defs.document.properties.agent_profiles.items.enum,
    agentProfiles,
  );
  assert.deepEqual(
    schema.$defs.document.properties.implementation_status.enum,
    implementationStatuses,
  );
  assert.deepEqual(
    schema.$defs.document.properties.production_readiness.enum,
    productionReadinessValues,
  );
  assert.deepEqual(
    schema.$defs.document.properties.context_sensitivity.enum,
    contextSensitivityValues,
  );
  assert.deepEqual(schema.$defs.document.properties.priority.enum, priorities);
  assert.ok(manifest.documents.length >= 57);

  for (const document of manifest.documents) {
    for (const field of requiredManifestFields) {
      assert.ok(
        Object.hasOwn(document, field),
        `${document.path ?? document.id ?? "document"} is missing ${field}`,
      );
    }
    assert.ok(
      !seenPaths.has(document.path),
      `duplicate manifest path: ${document.path}`,
    );
    assert.ok(
      !seenIds.has(document.id),
      `duplicate manifest id: ${document.id}`,
    );
    seenPaths.add(document.path);
    seenIds.add(document.id);
    assert.ok(
      existsSync(join(root, document.path)),
      `missing ${document.path}`,
    );
    assert.equal(
      document.canonical_url,
      expectedCanonicalUrl(document),
      `${document.path} has an invalid canonical_url`,
    );
    assert.equal(new URL(document.canonical_url).protocol, "https:");

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
    assert.equal(
      document.updated,
      frontmatter.updated,
      `${document.path} update date drifted`,
    );
    assert.ok(documentRoles.includes(document.document_role));
    assert.ok(implementationStatuses.includes(document.implementation_status));
    assert.ok(
      productionReadinessValues.includes(document.production_readiness),
    );
    assert.ok(contextSensitivityValues.includes(document.context_sensitivity));
    assert.ok(priorities.includes(document.priority));
    assert.ok(["en", "zh-CN"].includes(document.locale));
    assert.ok(document.agent_profiles.length > 0);
    assert.ok(
      document.agent_profiles.every((profile) =>
        agentProfiles.includes(profile),
      ),
    );
    assert.ok(document.intents.length > 0);
    assert.ok(!Object.hasOwn(document, "status"));
    assert.ok(!Object.hasOwn(document, "audience"));
  }

  for (const document of manifest.documents) {
    if (document.translation_of === null) {
      continue;
    }
    const canonical = manifest.documents.find(
      (candidate) => candidate.id === document.translation_of,
    );
    assert.ok(canonical, `${document.path} has an unknown translation_of`);
    assert.equal(canonical.locale, "en");
    assert.notEqual(document.locale, canonical.locale);
  }
});

test("manifest capability routes resolve governance and high-risk recovery", () => {
  const manifest = JSON.parse(read("ai/docs-manifest.json"));
  const catalog = JSON.parse(read("ai/application-contracts.json"));
  const byCapability = new Map(
    catalog.capabilities.map((capability) => [capability.name, capability]),
  );
  const byPath = new Map(
    manifest.documents.map((document) => [document.path, document]),
  );

  for (const document of manifest.documents) {
    for (const reference of document.capability_refs ?? []) {
      assert.ok(
        byCapability.has(reference),
        `${document.path} references unknown capability ${reference}`,
      );
    }
    if (document.recovery_route !== undefined) {
      const recovery = byPath.get(document.recovery_route);
      assert.ok(recovery, `${document.path} has an unknown recovery route`);
      assert.equal(recovery.document_role, "recovery");
    }
  }

  for (const capability of catalog.capabilities.filter(
    (candidate) =>
      candidate.kind === "command" &&
      ["high", "critical"].includes(candidate.risk),
  )) {
    const routes = manifest.documents.filter((document) =>
      (document.capability_refs ?? []).includes(capability.name),
    );
    assert.ok(
      routes.length > 0,
      `${capability.name} has no documentation route`,
    );
    for (const route of routes) {
      assert.ok(
        route.recovery_route,
        `${route.path} lacks recovery for ${capability.name}`,
      );
      assert.ok(
        route.human_escalation,
        `${route.path} lacks human escalation for ${capability.name}`,
      );
    }
  }
});

test("recovery documents distinguish executable behavior from operator advice", () => {
  const manifest = JSON.parse(read("ai/docs-manifest.json"));
  const recoveryDocuments = manifest.documents.filter(
    (document) => document.document_role === "recovery",
  );

  assert.ok(recoveryDocuments.length >= 7);
  for (const document of recoveryDocuments) {
    const source = read(document.path);
    assert.match(source, /## Implemented today/);
    assert.match(source, /## Not implemented/);
    assert.match(source, /## Safe response/);
    assert.match(source, /## Escalate/);
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
  assert.match(skill, /ai\/docs-manifest\.json/);
  assert.match(skill, /ai\/application-contracts\.json/);
  assert.match(skill, /docs\/recovery\//);
  assert.doesNotMatch(skill, /## Implementation status/);
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

test("documentation records the implemented PostgreSQL telemetry ACK slice without passing the full CloudLink gate", () => {
  const telemetry = read("docs/concepts/iot-telemetry.md");
  const persistence = read(
    "docs/concepts/persistence-and-multi-cloud-cells.md",
  );
  const cloudLink = read("docs/reference/cloudlink-mqtt-v1.md");
  const migration = read(
    "adapters/telemetry/postgres/migrations/0002_cloudlink_telemetry.sql",
  );
  const packageJson = JSON.parse(read("package.json"));

  assert.match(telemetry, /PostgreSQL.*telemetry.*implemented/is);
  assert.match(telemetry, /exact.*durable ACK.*outbox/is);
  assert.match(persistence, /PostgresTelemetryRepository/);
  assert.match(persistence, /pre-commit.*no ACK/is);
  assert.match(persistence, /post-commit.*identical ACK/is);
  assert.match(cloudLink, /telemetry acceptance.*PostgreSQL.*implemented/is);
  assert.match(cloudLink, /full.*crash-durable.*gate.*blocked/is);
  assert.match(cloudLink, /production composition.*planned/is);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /cloudlink_durable_ack_outbox/);
  assert.match(
    packageJson.scripts["test:postgres-integration"],
    /vitest\.postgres\.config\.ts/,
  );
});

test("CloudLink MQTT documentation preserves broker, identity, legacy, and durability boundaries", () => {
  const source = read("docs/reference/cloudlink-mqtt-v1.md");
  const decision = read("docs/adr/0014-cloudlink-mqtt-transport-binding.md");

  assert.match(source, /experimental/i);
  assert.match(source, /customer-selected broker/i);
  assert.match(source, /topic identity is untrusted/i);
  assert.match(source, /MQTT PUBACK.*transport evidence/is);
  assert.match(source, /PostgreSQL.*planned/is);
  assert.match(source, /distribution integrity alone.*not codec/is);
  assert.match(source, /pnpm test:cloudlink-dual/);
  assert.match(source, /pnpm test:cloudlink-aws-iot/);
  assert.match(source, /AWS IoT Core/i);
  assert.match(source, /us-west-2/i);
  assert.match(source, /two.*X\.509/is);
  assert.match(source, /delet.*certificat.*polic/is);
  assert.match(source, /does not pass.*authentication.*gate/is);
  assert.match(source, /unknown.*process-crash durability/is);
  assert.match(source, /pending imports/i);
  assert.match(source, /do not override AetherContracts/i);
  assert.match(decision, /legacy.*retained/is);
  assert.match(decision, /physical[- ]control topic/i);
  assert.match(decision, /OpenTelemetry/i);

  const packageJson = JSON.parse(read("package.json"));
  assert.match(
    packageJson.scripts["test:cloudlink-aws-iot"],
    /AETHER_CLOUD_RUN_AWS_IOT_INTEGRATION=1/,
  );
  const awsHarness = read("scripts/run-cloudlink-aws-iot-harness.ts");
  assert.match(awsHarness, /detach-policy/);
  assert.match(awsHarness, /update-certificate/);
  assert.match(awsHarness, /delete-certificate/);
  assert.match(awsHarness, /delete-policy/);
  assert.doesNotMatch(awsHarness, /create-thing/);

  for (const path of [
    "contracts/cloudlink/v1/contract-manifest.json",
    "contracts/cloudlink/v1/envelope.schema.json",
    "contracts/cloudlink/v1/session-hello.schema.json",
    "contracts/cloudlink/v1/durable-ack.schema.json",
    "contracts/cloudlink/v1/fixtures/session-hello.valid.json",
    "contracts/cloudlink/v1/fixtures/telemetry-batch.valid.json",
    "contracts/cloudlink/v1/fixtures/durable-ack.valid.json",
  ]) {
    assert.doesNotThrow(() => JSON.parse(read(path)), `${path} must be JSON`);
  }
});

test("CloudLink readiness evidence references public gates and fails closed", () => {
  const gates = JSON.parse(
    read("contracts/cloudlink/v1/interoperability-gates.json"),
  );
  const authoritativeGates = JSON.parse(
    read(
      "contracts/aether-contracts/v0.1.0-alpha.4/compatibility/cloudlink-v1alpha1-gates.json",
    ),
  );
  const authentication = JSON.parse(
    read("contracts/cloudlink/v1/session-authentication.schema.json"),
  );
  const wireProfile = JSON.parse(
    read("contracts/cloudlink/v1/wire-profile.json"),
  );
  const deliveryEnvelope = JSON.parse(
    read("contracts/cloudlink/v1/envelope.schema.json"),
  );
  const durableAck = JSON.parse(
    read("contracts/cloudlink/v1/durable-ack.schema.json"),
  );
  const fixtureManifest = JSON.parse(
    read("contracts/cloudlink/v1/fixture-manifest.json"),
  );
  assert.equal(gates.schema_version, 1);
  assert.equal(gates.contract, "aether.cloudlink");
  assert.equal(
    gates.authoritative_gate_definition,
    "AetherContracts compatibility/cloudlink-v1alpha1-gates.json",
  );
  assert.equal(gates.default_mode, "legacy");
  assert.equal(gates.physical_control, "forbidden");
  assert.deepEqual(
    Object.keys(gates.gate_evidence).sort(),
    authoritativeGates.gates.map((gate) => gate.id).sort(),
  );
  assert.ok(
    Object.values(gates.gate_evidence).every((gate) =>
      ["blocked", "proposal", "implemented-alpha3", "passed"].includes(
        gate.status,
      ),
    ),
  );
  for (const gate of Object.values(gates.gate_evidence)) {
    assert.equal("depends_on" in gate, false);
    assert.equal("exit_criteria" in gate, false);
  }
  assert.equal(
    gates.gate_evidence["shared-broker-authentication"].status,
    "proposal",
  );
  assert.equal(gates.gate_evidence["signed-durable-ack"].status, "blocked");
  assert.equal(gates.gate_evidence["legacy-cutover"].status, "blocked");

  assert.equal(authentication.$id, "session-authentication.schema.json");
  assert.deepEqual(
    authentication.$defs.authenticationMethod.oneOf.map((candidate) => {
      const definitionName = candidate.$ref.split("/").at(-1);
      return authentication.$defs[definitionName].properties.method.const;
    }),
    ["gateway-signature", "trusted-broker-attestation"],
  );
  assert.equal(
    wireProfile.status,
    "non-authoritative-aethercloud-implementation-overlay",
  );
  assert.equal(
    wireProfile.authoritative_artifacts.core_profile,
    "AetherContracts profiles/cloudlink/v1alpha1/core.json",
  );
  assert.equal(wireProfile.implementation.authentication, "proposal");
  assert.equal(wireProfile.implementation.application_ack, "unsigned-alpha3");
  assert.equal(wireProfile.implementation.legacy_default, true);
  assert.equal(wireProfile.implementation.physical_control, "forbidden");
  assert.equal("envelope" in wireProfile, false);
  assert.equal("identity" in wireProfile, false);
  assert.equal("digest" in wireProfile, false);
  assert.equal("ack" in wireProfile, false);
  assert.equal(deliveryEnvelope.$id, "envelope.schema.json");
  // alpha.4 moved the uplink envelope's required list into $defs.uplinkEnvelope
  // and composes it through allOf. The required set itself is unchanged, so
  // this follows the restructuring rather than relaxing the assertion.
  assert.ok(
    deliveryEnvelope.$defs.uplinkEnvelope.required.includes("delivery"),
  );
  assert.equal(deliveryEnvelope.$defs.digest.pattern, "^sha256:[0-9a-f]{64}$");
  assert.equal(durableAck.$id, "durable-ack.schema.json");
  assert.equal(durableAck.properties.message_kind.const, "durable-ack");
  assert.equal(fixtureManifest.hash_algorithm, "sha256");
  assert.equal(fixtureManifest.fixtures.length, 27);
  for (const fixture of fixtureManifest.fixtures) {
    assert.equal(
      createHash("sha256")
        .update(read(`contracts/cloudlink/v1/fixtures/${fixture.file}`))
        .digest("hex"),
      fixture.sha256,
      `${fixture.file} drifted from the fixture manifest`,
    );
  }

  const reference = read("docs/reference/cloudlink-mqtt-v1.md");
  assert.match(reference, /challenge.*signature/is);
  assert.match(reference, /trusted Broker attestation/i);
  assert.match(reference, /25 public fixture\s+bytes/i);
  assert.match(reference, /pending imports.*empty/i);
  assert.match(reference, /ACK loss/i);
  assert.match(reference, /crash-durable/i);
  assert.match(reference, /legacy.*default/is);
  assert.match(reference, /no physical control/i);
});

test("AetherContracts documentation keeps distribution and behavior conformance distinct", () => {
  const lock = JSON.parse(read("aether-contracts.lock.json"));
  const decision = read("docs/adr/0016-pinned-aethercontracts-consumption.md");

  assert.equal(lock.schema, "aether.contracts.consumer-lock.v1alpha1");
  assert.equal(lock.status, "complete-consumer");
  assert.equal(lock.release.version, "0.1.0-alpha.4");
  assert.equal(lock.pending_imports.length, 0);
  assert.equal(lock.release.commit.length, 40);
  assert.equal(lock.release.bundle.sha256.length, 64);
  assert.equal(lock.policy.conformance_claim, "distribution-only");
  assert.equal(lock.policy.production_release, false);
  assert.equal(lock.policy.legacy_default, true);
  assert.equal(lock.policy.physical_control, false);
  assert.equal(lock.imports.length, 101);
  assert.equal(lock.pending_imports.length, 0);
  assert.match(decision, /53 exact alpha\.3 artifacts/i);
  assert.match(decision, /does not pass codec\/TCK/i);
  assert.match(decision, /legacy remains default/i);
});

test("persistence documentation separates PostgreSQL cells from provider identity and analytics", () => {
  const source = read("docs/concepts/persistence-and-multi-cloud-cells.md");

  assert.match(source, /one authoritative PostgreSQL writer/i);
  assert.match(source, /Tenant home cell/i);
  assert.match(source, /managed-postgresql/);
  assert.match(source, /does not require synchronous.*database writes/is);
  assert.match(source, /TimescaleDB or ClickHouse/);
  assert.match(source, /not.*write\s+authority.*governed failover/is);
  assert.match(source, /implemented/i);
  assert.match(source, /planned/i);
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

test("MCP documentation exposes governance and the shipped wire transport honestly", () => {
  const source = read("docs/concepts/mcp-application-interface.md");

  assert.match(source, /same `SearchAuditEvents`/);
  assert.match(
    source,
    /permission.*risk.*confirmation.*idempotency.*expiry.*audit/is,
  );
  assert.match(source, /mcp-tool-not-implemented/);
  assert.match(source, /does not own business state/i);
  assert.match(source, /POST \/api\/v1\/mcp/);
  assert.match(source, /no SSE stream, no session id/i);
  assert.match(source, /still no stdio server/i);
  assert.match(source, /development credential/i);
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

test("product-family naming distinguishes AetherIoT from AetherEdge without rewriting releases", () => {
  const family = read("docs/get-started/aetheriot-product-family.md");
  const decision = read("docs/adr/0017-aetheriot-product-family-naming.md");
  const importedRelease = read(
    "contracts/aether-contracts/v0.1.0-alpha.4/spec/distribution-v1alpha1.md",
  );

  assert.match(family, /AetherIoT is the umbrella project/);
  assert.match(family, /AetherEdge.*edge runtime/s);
  assert.match(
    family,
    /AetherContracts remains the sole shared interoperability authority/,
  );
  assert.match(decision, /`aether` CLI/);
  assert.match(decision, /Published releases, evidence, provenance/);
  // The alpha.3 spec carried the historical `AetherIot` name and this asserted
  // that importing did not rewrite it. Upstream renamed to AetherEdge in
  // alpha.4, so there is no historical name left to preserve here. The
  // no-rewriting guarantee now rests on the consumer lock's digest
  // verification, which tests/aether-contracts-consumer.test.mjs exercises
  // through AetherContracts' own verifier. Assert the imported text still
  // reflects upstream's naming rather than ours.
  assert.match(importedRelease, /AetherEdge/);
  assert.doesNotMatch(importedRelease, /AetherIot\b/);
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
