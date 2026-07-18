import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const manifestPath = join(root, "ai/docs-manifest.json");
const catalogPath = join(root, "ai/application-contracts.json");
const outputPath = join(root, "llms.txt");
const githubBlobBase = "https://github.com/EvanL1/AetherCloud/blob/main";
const githubRawBase =
  "https://raw.githubusercontent.com/EvanL1/AetherCloud/main";
const publicDocsBase = "https://docs.aetheriot.workers.dev";
const manifestSchemaUrl = `${githubRawBase}/ai/docs-manifest.schema.json`;

const roles = new Set([
  "agent-task",
  "operations",
  "safety",
  "recovery",
  "reference",
  "decision",
  "status",
]);
const profiles = new Set(["coding-agent", "operator-agent", "runtime-agent"]);
const implementationStatuses = new Set([
  "implemented",
  "partial",
  "planned",
  "deprecated",
]);
const productionReadinessValues = new Set([
  "production-ready",
  "experimental",
  "not-production-ready",
  "not-applicable",
]);
const contextSensitivityValues = new Set([
  "public",
  "internal",
  "redacted-only",
  "sensitive-never-load",
]);
const priorities = new Set(["core", "optional"]);
const requiredFields = [
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
const riskOrder = new Map([
  ["low", 1],
  ["medium", 2],
  ["high", 3],
  ["critical", 4],
]);
const sectionByRole = new Map([
  ["agent-task", "Agent Task Manual"],
  ["operations", "Deployment and Operations"],
  ["safety", "Safety and Governance"],
  ["recovery", "Recovery"],
  ["reference", "Platform Reference"],
  ["status", "Compatibility and Status"],
  ["decision", "Decisions"],
]);
const coreSections = [
  "Agent Task Manual",
  "Deployment and Operations",
  "Safety and Governance",
  "Recovery",
  "Platform Reference",
  "Compatibility and Status",
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertStringList(value, field, path) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error(`${path} has an invalid ${field}`);
  }
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

function canonicalUrlForDocument(document) {
  if (isPublishedEnglishUserDocument(document)) {
    const slug = document.path.slice("docs/".length, -".md".length);
    return `${publicDocsBase}/en/aethercloud/${slug}.md`;
  }
  return `${githubBlobBase}/${document.path}`;
}

export function validateManifest(manifest, catalog) {
  if (manifest.schema_version !== 3) {
    throw new Error("ai/docs-manifest.json must use schema_version 3");
  }
  if (manifest.$schema !== manifestSchemaUrl) {
    throw new Error(
      "ai/docs-manifest.json must reference its absolute raw GitHub schema",
    );
  }
  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) {
    throw new Error("ai/docs-manifest.json has no documents");
  }

  const capabilityByName = new Map(
    catalog.capabilities.map((capability) => [capability.name, capability]),
  );
  const documentById = new Map();
  const documentByPath = new Map();

  for (const document of manifest.documents) {
    for (const field of requiredFields) {
      if (!Object.hasOwn(document, field)) {
        throw new Error(`${document.path ?? document.id} is missing ${field}`);
      }
    }
    if (documentById.has(document.id)) {
      throw new Error(`duplicate document id ${document.id}`);
    }
    if (documentByPath.has(document.path)) {
      throw new Error(`duplicate document path ${document.path}`);
    }
    if (!existsSync(join(root, document.path))) {
      throw new Error(`missing document ${document.path}`);
    }
    if (document.canonical_url !== canonicalUrlForDocument(document)) {
      throw new Error(`${document.path} has an invalid canonical_url`);
    }
    if (!roles.has(document.document_role)) {
      throw new Error(`${document.path} has an invalid document_role`);
    }
    if (!implementationStatuses.has(document.implementation_status)) {
      throw new Error(`${document.path} has an invalid implementation_status`);
    }
    if (!productionReadinessValues.has(document.production_readiness)) {
      throw new Error(`${document.path} has an invalid production_readiness`);
    }
    if (!contextSensitivityValues.has(document.context_sensitivity)) {
      throw new Error(`${document.path} has an invalid context_sensitivity`);
    }
    if (!priorities.has(document.priority)) {
      throw new Error(`${document.path} has an invalid priority`);
    }
    assertStringList(document.agent_profiles, "agent_profiles", document.path);
    assertStringList(document.intents, "intents", document.path);
    if (document.agent_profiles.some((profile) => !profiles.has(profile))) {
      throw new Error(`${document.path} has an unknown agent profile`);
    }
    documentById.set(document.id, document);
    documentByPath.set(document.path, document);
  }

  for (const document of manifest.documents) {
    if (document.translation_of !== null) {
      const canonical = documentById.get(document.translation_of);
      if (canonical === undefined || canonical.locale !== "en") {
        throw new Error(`${document.path} has an invalid translation_of`);
      }
    }

    for (const reference of document.capability_refs ?? []) {
      if (!capabilityByName.has(reference)) {
        throw new Error(
          `${document.path} references unknown capability ${reference}`,
        );
      }
      const capability = capabilityByName.get(reference);
      if (
        capability.kind === "command" &&
        ["high", "critical"].includes(capability.risk) &&
        (document.recovery_route === undefined ||
          document.human_escalation === undefined)
      ) {
        throw new Error(
          `${document.path} must route high-risk capability ${reference} to recovery and human escalation`,
        );
      }
    }

    if (document.recovery_route !== undefined) {
      const recovery = documentByPath.get(document.recovery_route);
      if (recovery === undefined || recovery.document_role !== "recovery") {
        throw new Error(`${document.path} has an invalid recovery_route`);
      }
    }
  }

  return { capabilityByName, documentById };
}

function englishMetadata(document, documentById) {
  if (document.translation_of === null) {
    return {
      title: document.title,
      description: document.description,
    };
  }

  const canonical = documentById.get(document.translation_of);
  return {
    title: `Simplified Chinese translation of ${canonical.title}`,
    description: `Localized copy of ${canonical.title} for Simplified Chinese agent contexts`,
  };
}

function safetySummary(document, capabilityByName) {
  const capabilities = (document.capability_refs ?? []).map((reference) =>
    capabilityByName.get(reference),
  );
  if (capabilities.length === 0) {
    return "";
  }

  const highestRisk = capabilities
    .filter((capability) => capability.kind === "command")
    .map((capability) => capability.risk)
    .sort((left, right) => riskOrder.get(right) - riskOrder.get(left))[0];
  const permissions = [
    ...new Set(capabilities.map((capability) => capability.permission)),
  ].sort();
  const confirmations = [
    ...new Set(
      capabilities
        .filter((capability) => capability.kind === "command")
        .map((capability) => capability.confirmation),
    ),
  ].sort();
  const parts = [`capabilities: ${document.capability_refs.join(", ")}`];

  if (highestRisk !== undefined) {
    parts.push(`maximum risk: ${highestRisk}`);
  }
  parts.push(`permissions: ${permissions.join(", ")}`);
  if (confirmations.length > 0) {
    parts.push(`confirmation: ${confirmations.join(", ")}`);
  }

  return ` Safety gate: ${parts.join("; ")}.`;
}

function documentLine(document, documentById, capabilityByName) {
  const metadata = englishMetadata(document, documentById);
  return `- [${metadata.title}](${document.canonical_url}): ${metadata.description}. Status: ${document.implementation_status}; readiness: ${document.production_readiness}; context: ${document.context_sensitivity}.${safetySummary(document, capabilityByName)}`;
}

function sortedDocuments(documents, documentById) {
  return [...documents].sort((left, right) => {
    const leftTitle = englishMetadata(left, documentById).title;
    const rightTitle = englishMetadata(right, documentById).title;
    return leftTitle.localeCompare(rightTitle, "en");
  });
}

export function generateIndex(manifest, catalog) {
  const { capabilityByName, documentById } = validateManifest(
    manifest,
    catalog,
  );
  const lines = [
    "# AetherCloud",
    "",
    "> Agent-readable routing for the AI-native, multi-cloud IoT fusion and control plane.",
    "> AetherEdge remains authoritative for live state, deterministic safety, and physical control.",
    "",
    "This index serves three distinct agent profiles:",
    "",
    `- Coding agents change repository code and contracts under [AGENTS.md](${githubBlobBase}/AGENTS.md) and the [AetherCloud Agent Skill](${githubBlobBase}/skills/aether-cloud/SKILL.md).`,
    "- Operator agents inspect deployment, reliability, security, and recovery evidence; they do not gain provider or Tenant authority from this file.",
    "- Runtime agents translate user intent into governed application requests; they may use only capabilities exposed by the authenticated live interface.",
    "",
    "## Mandatory Safety Gate",
    "",
    `- Static documentation never grants runtime permission. Resolve every capability against the [machine-readable capability catalog](${githubRawBase}/ai/application-contracts.json), authenticated Tenant policy, and the live capability catalog before invocation.`,
    "- Capabilities are deny by default. An absent, planned, disabled, or uncomposed capability is unavailable.",
    "- High-risk commands require explicit human confirmation, a recovery route, idempotency, expiry, and durable audit. Documentation cannot satisfy those controls.",
    "- Never infer physical completion from cloud acceptance, delivery, timeout, or connection state. The edge and authenticated Receipts remain authoritative.",
    "- Saved Plan binaries, raw Plan JSON, credentials, tokens, secrets, and device-register values must never enter prompts or agent context.",
    "- Infrastructure Apply, Destroy, Import, State repair, production credential recovery, and cloud-side emergency stop are not implemented.",
    "",
    "Machine-readable routing sources:",
    "",
    `- [Documentation manifest](${githubRawBase}/ai/docs-manifest.json)`,
    `- [Documentation manifest schema](${manifestSchemaUrl})`,
    `- [Capability and authorization catalog](${githubRawBase}/ai/application-contracts.json)`,
    "",
  ];

  const emitted = new Set();
  for (const section of coreSections) {
    lines.push(`## ${section}`, "");
    const documents = sortedDocuments(
      manifest.documents.filter(
        (document) =>
          document.priority === "core" &&
          document.document_role !== "decision" &&
          sectionByRole.get(document.document_role) === section,
      ),
      documentById,
    );
    if (documents.length === 0) {
      throw new Error(`core section ${section} has no documents`);
    }
    for (const document of documents) {
      lines.push(documentLine(document, documentById, capabilityByName));
      emitted.add(document.id);
    }
    lines.push("");
  }

  lines.push("## Optional", "");
  const optionalDocuments = manifest.documents.filter(
    (document) =>
      document.priority === "optional" || document.document_role === "decision",
  );
  const optionalSections = [...coreSections, "Decisions"];
  for (const section of optionalSections) {
    const documents = sortedDocuments(
      optionalDocuments.filter(
        (document) => sectionByRole.get(document.document_role) === section,
      ),
      documentById,
    );
    if (documents.length === 0) {
      continue;
    }
    lines.push(`### ${section}`, "");
    for (const document of documents) {
      lines.push(documentLine(document, documentById, capabilityByName));
      emitted.add(document.id);
    }
    lines.push("");
  }

  if (emitted.size !== manifest.documents.length) {
    const missing = manifest.documents
      .filter((document) => !emitted.has(document.id))
      .map((document) => document.id);
    throw new Error(`documents were not emitted: ${missing.join(", ")}`);
  }

  const output = `${lines.join("\n").trimEnd()}\n`;
  if (/[\u3400-\u9fff]/u.test(output)) {
    throw new Error("llms.txt generation produced non-English text");
  }
  return output;
}

const manifest = readJson(manifestPath);
const catalog = readJson(catalogPath);
const output = generateIndex(manifest, catalog);
const command = process.argv[2] ?? "--write";

if (command === "--stdout") {
  process.stdout.write(output);
} else if (command === "--check") {
  if (!existsSync(outputPath) || readFileSync(outputPath, "utf8") !== output) {
    process.stderr.write(
      "llms.txt is stale; run node scripts/generate-ai-doc-index.mjs\n",
    );
    process.exitCode = 1;
  }
} else if (command === "--write") {
  writeFileSync(outputPath, output);
} else {
  process.stderr.write(`unknown option: ${command}\n`);
  process.exitCode = 2;
}
