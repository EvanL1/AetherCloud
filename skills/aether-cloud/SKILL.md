---
name: aether-cloud
description: Build multi-cloud IoT applications and integrations against AetherCloud using capability-driven providers, edge-first authority, versioned contracts, and agent-readable documentation
---

# AetherCloud

Use this skill when a coding agent changes AetherCloud or generates software
that integrates with it. Operator and runtime agents start from `llms.txt` and
`ai/docs-manifest.json`; this repository skill does not grant runtime authority.
Read only the pages relevant to the task, but always apply the safety and
authority rules below.

## Non-negotiable rules

- The edge remains authoritative for live point state, deterministic automation,
  safety, and physical control.
- Device control is deny by default.
- Cloud sends desired state or governed jobs; it does not directly write device
  points.
- AetherCloud owns desired placement; each provider owns actual infrastructure
  state.
- A Provider Adapter declares capabilities and preserves provider-specific
  extensions. Do not add a fixed vendor switch to core packages.
- OpenTofu is the default infrastructure engine; Terraform is a compatible
  engine, not a separate domain path.
- One deployment stack has one independently locked State.
- Plans are parsed as versioned JSON, evaluated, and stored as encrypted
  artifacts. The current port exposes no Apply operation. Raw Plan JSON and
  long-lived credentials never enter prompts, logs, or generated modules.
- AI and transports call application use cases and never write adapters directly.
- Static documentation never grants Tenant permission or makes a capability
  executable. Resolve `capability_refs` through `ai/application-contracts.json`
  and the authenticated live interface.
- Do not claim a planned endpoint, event, or CloudLink message is implemented.
- Treat desired, reported, and applied as separate facts.
- Treat Gateway registration, enrollment claim, credential, CloudLink session,
  and runtime health as separate facts.

## Documentation routing

| Task                                      | Read first                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Route any agent task                      | `ai/docs-manifest.json`, selecting the matching `agent_profiles`, `intents`, status, sensitivity, and priority  |
| Resolve permission, risk, or confirmation | `ai/application-contracts.json`; never infer governance from prose                                              |
| Understand the product                    | `docs/get-started/overview.md`                                                                                  |
| Add or change a Provider Adapter          | `docs/concepts/multi-cloud-fusion.md`, `ai/invariants.md`                                                       |
| Change persistence or database placement  | `docs/concepts/persistence-and-multi-cloud-cells.md`, `docs/adr/0013-postgresql-control-plane-persistence.md`   |
| Implement Provider discovery              | `docs/guides/add-provider-adapter.md`                                                                           |
| Add an IoT Cloud capability               | `docs/concepts/iot-cloud-capability-map.md`, `docs/guides/iot-cloud-roadmap.md`                                 |
| Change IoT telemetry                      | `docs/concepts/iot-telemetry.md`, `docs/adr/0007-durable-iot-telemetry.md`                                      |
| Change Artifact Registry                  | `docs/concepts/artifact-registry.md`, `docs/adr/0009-immutable-artifact-publication.md`                         |
| Change edge deployment                    | `docs/concepts/desired-reported-applied-deployment.md`, `docs/adr/0010-desired-reported-applied-deployment.md`  |
| Change governed edge Jobs                 | `docs/concepts/governed-capability-jobs.md`, `docs/adr/0011-governed-capability-jobs.md`                        |
| Change audit, webhook, or export          | `docs/concepts/audit-and-integrations.md`, `docs/adr/0012-durable-audit-and-outbound-integrations.md`           |
| Add or change an MCP resource/tool        | `docs/concepts/mcp-application-interface.md`, `docs/reference/application-contracts.md`                         |
| Change artifact publication               | `docs/concepts/artifact-registry.md`, `docs/adr/0009-immutable-artifact-publication.md`                         |
| Add operational instrumentation           | `docs/concepts/operational-observability.md`, `docs/adr/0008-operational-observability.md`                      |
| Change Gateway enrollment                 | `docs/concepts/gateway-identity-and-enrollment.md`, `docs/adr/0005-gateway-identity-and-enrollment.md`          |
| Define or change CloudLink                | `docs/concepts/cloudlink-and-core-state-machines.md`, `docs/reference/cloudlink-mqtt-v1.md`, ADR-0006/0014/0015 |
| Change Runtime Manifest ingestion         | `docs/concepts/cloudlink-and-core-state-machines.md`, `docs/guides/iot-cloud-roadmap.md`                        |
| Add infrastructure Plan                   | `docs/guides/plan-infrastructure.md`, `docs/adr/0004-multi-cloud-fusion.md`                                     |
| Propose infrastructure Apply              | `docs/guides/plan-infrastructure.md`, `ai/invariants.md`, then add or amend an ADR                              |
| Recover a credential or Gateway identity  | `docs/recovery/credential-revocation-and-reenrollment.md`                                                       |
| Recover CloudLink or an unknown outcome   | `docs/recovery/cloudlink-offline-and-reconnect.md`, `docs/recovery/unknown-command-outcome.md`                  |
| Contain unsafe agent or integration work  | `docs/recovery/emergency-revoke.md`, `docs/recovery/integration-safe-degradation.md`                            |
| Recover database or State-lock failure    | `docs/recovery/database-backup-and-restore.md`, `docs/recovery/infrastructure-lock-failure.md`                  |
| Add a domain concept                      | `docs/concepts/resource-model.md`, `ai/invariants.md`                                                           |
| Decide edge/cloud/provider ownership      | `docs/concepts/edge-cloud-boundary.md`                                                                          |
| Add an application module                 | `docs/concepts/architecture.md`, `docs/reference/repository-layout.md`                                          |
| Call or change HTTP                       | `docs/reference/http-api.md`                                                                                    |
| Add a command, query, error, or event     | `docs/reference/application-contracts.md`, `ai/application-contracts.json`                                      |
| Name a resource or state transition       | `docs/reference/terminology.md`                                                                                 |
| Propose a foundational change             | `docs/adr/`, then add or amend an ADR                                                                           |

## Workflow

1. Classify the agent profile and intent, then select the narrowest matching
   entry from `ai/docs-manifest.json`.
2. If the entry has `capability_refs`, resolve each reference in
   `ai/application-contracts.json`; absent, planned, or uncomposed capabilities
   are unavailable.
3. Read the routed pages and the nearest package instructions. Respect the
   entry's context sensitivity, preconditions, recovery route, and human
   escalation.
4. Write an observable behavior test before implementation.
5. Keep runtime decoding at every untrusted boundary.
6. For infrastructure work, separate provider-neutral intent from
   provider-specific module and normalization code.
7. Run `providerAdapterConformance` for every Provider Adapter and
   `infrastructureEngineConformance` for every Infrastructure Engine. Keep real
   cloud accounts out of the default test path.
8. Update contracts and agent documentation in the same change when behavior
   changes.
9. Regenerate `llms.txt` with
   `node scripts/generate-ai-doc-index.mjs --write`, run the narrow test, then
   `pnpm check`.

## Safety review for commands

Before adding a command, identify its permission, risk, confirmation policy,
idempotency behavior, expiry, audit record, and edge-side rejection behavior.
If any field is undefined, the command is not ready to expose. Every high-risk
command also needs a valid manifest `recovery_route` and explicit
`human_escalation`.

Infrastructure commands additionally require a State identity and lock, saved
plan digest, engine and provider versions, policy result, approval evidence,
bounded execution log, and normalized post-apply observation.
