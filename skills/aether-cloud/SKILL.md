---
name: aether-cloud
description: Build multi-cloud IoT applications and integrations against AetherCloud using capability-driven providers, edge-first authority, versioned contracts, and agent-readable documentation
---

# AetherCloud

Use this skill when changing AetherCloud or generating software that integrates
with it. Read only the pages relevant to the task, but always apply the safety
and authority rules below.

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
- Do not claim a planned endpoint, event, or CloudLink message is implemented.
- Treat desired, reported, and applied as separate facts.
- Treat Gateway registration, enrollment claim, credential, CloudLink session,
  and runtime health as separate facts.

## Documentation routing

| Task                                     | Read first                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Understand the product                   | `docs/get-started/overview.md`                                                                                  |
| Add or change a Provider Adapter         | `docs/concepts/multi-cloud-fusion.md`, `ai/invariants.md`                                                       |
| Change persistence or database placement | `docs/concepts/persistence-and-multi-cloud-cells.md`, `docs/adr/0013-postgresql-control-plane-persistence.md`   |
| Implement Provider discovery             | `docs/guides/add-provider-adapter.md`                                                                           |
| Add an IoT Cloud capability              | `docs/concepts/iot-cloud-capability-map.md`, `docs/guides/iot-cloud-roadmap.md`                                 |
| Change IoT telemetry                     | `docs/concepts/iot-telemetry.md`, `docs/adr/0007-durable-iot-telemetry.md`                                      |
| Change Artifact Registry                 | `docs/concepts/artifact-registry.md`, `docs/adr/0009-immutable-artifact-publication.md`                         |
| Change edge deployment                   | `docs/concepts/desired-reported-applied-deployment.md`, `docs/adr/0010-desired-reported-applied-deployment.md`  |
| Change governed edge Jobs                | `docs/concepts/governed-capability-jobs.md`, `docs/adr/0011-governed-capability-jobs.md`                        |
| Change audit, webhook, or export         | `docs/concepts/audit-and-integrations.md`, `docs/adr/0012-durable-audit-and-outbound-integrations.md`           |
| Add or change an MCP resource/tool       | `docs/concepts/mcp-application-interface.md`, `docs/reference/application-contracts.md`                         |
| Change artifact publication              | `docs/concepts/artifact-registry.md`, `docs/adr/0009-immutable-artifact-publication.md`                         |
| Add operational instrumentation          | `docs/concepts/operational-observability.md`, `docs/adr/0008-operational-observability.md`                      |
| Change Gateway enrollment                | `docs/concepts/gateway-identity-and-enrollment.md`, `docs/adr/0005-gateway-identity-and-enrollment.md`          |
| Define or change CloudLink               | `docs/concepts/cloudlink-and-core-state-machines.md`, `docs/reference/cloudlink-mqtt-v1.md`, ADR-0006/0014/0015 |
| Change Runtime Manifest ingestion        | `docs/concepts/cloudlink-and-core-state-machines.md`, `docs/guides/iot-cloud-roadmap.md`                        |
| Add infrastructure Plan                  | `docs/guides/plan-infrastructure.md`, `docs/adr/0004-multi-cloud-fusion.md`                                     |
| Propose infrastructure Apply             | `docs/guides/plan-infrastructure.md`, `ai/invariants.md`, then add or amend an ADR                              |
| Add a domain concept                     | `docs/concepts/resource-model.md`, `ai/invariants.md`                                                           |
| Decide edge/cloud/provider ownership     | `docs/concepts/edge-cloud-boundary.md`                                                                          |
| Add an application module                | `docs/concepts/architecture.md`, `docs/reference/repository-layout.md`                                          |
| Call or change HTTP                      | `docs/reference/http-api.md`                                                                                    |
| Add a command, query, error, or event    | `docs/reference/application-contracts.md`, `ai/application-contracts.json`                                      |
| Name a resource or state transition      | `docs/reference/terminology.md`                                                                                 |
| Propose a foundational change            | `docs/adr/`, then add or amend an ADR                                                                           |

## Workflow

1. Classify the request as documentation, domain, application, adapter, or
   composition-root work.
2. Read the routed pages and the nearest package instructions.
3. Write an observable behavior test before implementation.
4. Keep runtime decoding at every untrusted boundary.
5. For infrastructure work, separate provider-neutral intent from
   provider-specific module and normalization code.
6. Run `providerAdapterConformance` for every Provider Adapter and
   `infrastructureEngineConformance` for every Infrastructure Engine. Keep real
   cloud accounts out of the default test path.
7. Update contracts and agent documentation in the same change when behavior
   changes.
8. Run the narrow test, then `pnpm check`.

## Implementation status

The governed Plan command, plan-only Infrastructure Engine port, conformance
suite, memory engine, memory Plan repository, and real local OpenTofu CLI
adapter are implemented. The CLI adapter probes its version, uses argv without
a shell, verifies source digests, bounds output, cleans a restricted workspace,
and requires lock-release evidence. Production remote State, distributed locks,
encrypted object storage, credentials, worker deployment, and public Plan
route remain planned. The Gateway registration and claim foundation is
implemented in domain, application, and memory-adapter code. The
transport-neutral CloudLink session/heartbeat and Runtime Manifest report/query
foundations are also implemented at those inner layers. An experimental strict
JSON/MQTT core codec, JCS digest, broker adapter, application bridge, ingress
lifecycle, and all 25 public alpha.3 fixtures are implemented. Multi-sample
wire-to-application indexing and data-loss persistence still fail honestly;
production database composition, joint authentication conformance, production
process configuration, and CA/KMS lifecycle integration remain planned. Strict
operator-provided CA/client-certificate/private-key files and an opt-in
ephemeral AWS IoT Core mTLS harness are implemented alpha evidence. The public
AetherContracts `v0.1.0-alpha.3` release is consumed through the same
digest-pinned lock as AetherEdge. Both complete-consumer locks import the same 53
alpha.3 artifacts with no pending imports, and both codecs execute all 25
fixtures with stable failure classes. Local wire/authentication files cannot
override the public authority. The opt-in real Mosquitto dual harness and fault
matrix are implemented alpha evidence. Production authentication,
and legacy cutover gates remain unpassed. A Gateway PostgreSQL
adapter/migration atomically writes aggregate, Audit, and Outbox evidence behind
Tenant RLS. A telemetry PostgreSQL adapter/migration now atomically stores
replay identity, cursor/history, Audit, integration Outbox, and the exact
durable ACK outbox; a bounded application worker leases and delivers those
ACKs. PostgreSQL 18 fault tests prove no ACK before commit and an identical ACK
after an uncertain commit. This is an accepted-telemetry slice, not passage of
the full crash-durable gate: production composition, session/credential and
data-loss persistence, multi-sample mapping, and authentication remain planned.
Alarm, Artifact Registry, single-target
deployment, and governed Job domain/application/memory slices, plus the
operational OpenTelemetry adapter foundation, are partial rather than
production end-to-end features. Audit query is additionally exposed by
authenticated JSON and finite resumable SSE routes. Webhook subscription,
bounded delivery/dead-letter/redrive, and Data Export are partial
domain/application/memory foundations. Production persistence, released CloudLink interoperability,
target scheduling/Job delivery, hardened external sending, export workers, and
the MCP wire/root remain planned contracts. The transport-neutral MCP interface
implements capability/Audit resources and Data Export/Job tools through the
same application use cases; it is not a connectable MCP server.

## Safety review for commands

Before adding a command, identify its permission, risk, confirmation policy,
idempotency behavior, expiry, audit record, and edge-side rejection behavior.
If any field is undefined, the command is not ready to expose.

Infrastructure commands additionally require a State identity and lock, saved
plan digest, engine and provider versions, policy result, approval evidence,
bounded execution log, and normalized post-apply observation.
