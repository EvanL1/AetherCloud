# AetherCloud

AetherCloud is an AI-native, multi-cloud IoT fusion and control plane. It
unifies provider capabilities, placement, infrastructure plans, fleets,
telemetry, and audited work without hiding provider-native differences. An
AetherIot edge runtime remains authoritative for live state, deterministic
automation, and physical control.

This repository is intentionally agent-readable. Start with [`llms.txt`](llms.txt)
for a compact documentation index or install the repository-owned
[`aether-cloud` Agent Skill](skills/aether-cloud/SKILL.md) for task-specific
routing and safety constraints.

## Current milestone

The first milestone establishes the TypeScript workspace, dynamic provider and
Cloud Connection models, an authorized tenant/project-scoped read-only provider
discovery use case, a provider-scoped Deployment Stack and remote State
binding, an adapter conformance kit, an independently runnable API composition
root, stable architecture decisions, documentation contracts for coding
agents, and the first Gateway identity and enrollment domain/application
foundation. Transport-neutral CloudLink session/heartbeat and Runtime Manifest
report/query foundations now add credential-derived scope, epoch fencing,
lossless resume positions, canonical checksum verification, monotonic manifest
history, and memory adapters. Atomic IoT telemetry ingestion/history and alarm
projection/workflow foundations now add lossless stream positions, durable
receipt semantics, replay/conflict/gap handling, cloud-only acknowledgement,
and memory inbox/outbox/audit conformance adapters. An OpenTelemetry adapter
adds no-op defaults, in-memory and OTLP HTTP exporters, bounded queues, W3C
Trace Context, and low-cardinality ingestion instrumentation. It also includes
a partial Artifact Registry foundation with immutable publication, content and
signature verification ports, compatibility metadata, release-channel
protection, and an atomic memory adapter. Single-Gateway
Desired/Reported/Applied deployment and governed capability Job foundations
add immutable intent, edge-authoritative observations, ordered Receipts,
explicit uncertainty, and atomic memory audit/outbox evidence. Tenant-scoped
audit query values, an authenticated JSON/SSE audit interface, webhook
subscription and bounded delivery/dead-letter workflows, and asynchronous data
export foundations now provide the first integration slice. The webhook sender,
destination secrets, durable persistence, live event fan-out, object storage,
and export workers remain planned. A transport-neutral MCP interface now lists
capability and Audit resources plus governed Data Export and Job tools, all
delegating to existing application use cases; an MCP wire server remains
planned. It also includes a governed, idempotent
infrastructure Plan command, a dynamic plan-only OpenTofu/Terraform engine
port, policy receipts, a deterministic conformance adapter, and a real local
OpenTofu saved-Plan worker with bounded argv-only process execution and
temporary-workspace cleanup. Real provider adapters, credential resolution,
production remote State and encrypted object storage, a CloudLink wire/process,
durable persistence, Apply, production Gateway credentials, production
telemetry/alarm/artifact/deployment/Job persistence, remaining public interfaces,
scheduling, production integration delivery, and MCP transport are separate contract-first vertical
slices.

## Development

Prerequisites:

- Node.js 24
- pnpm 11

```bash
pnpm install
pnpm check
pnpm dev:api
```

The API listens on `127.0.0.1:3000` by default. `GET /health` is the initial
readiness endpoint.

## Documentation

- [Product overview](docs/get-started/overview.md)
- [Architecture](docs/concepts/architecture.md)
- [Audit, subscriptions, webhook delivery, and data export](docs/concepts/audit-and-integrations.md)
- [Current implementation audit](docs/concepts/current-state-audit.md)
- [IoT Cloud capability map](docs/concepts/iot-cloud-capability-map.md)
- [IoT business telemetry](docs/concepts/iot-telemetry.md)
- [Artifact registry and immutable publication](docs/concepts/artifact-registry.md)
- [Desired, Reported, and Applied deployment](docs/concepts/desired-reported-applied-deployment.md)
- [Governed capability Jobs](docs/concepts/governed-capability-jobs.md)
- [MCP application interface](docs/concepts/mcp-application-interface.md)
- [Operational observability](docs/concepts/operational-observability.md)
- [Gateway identity and enrollment](docs/concepts/gateway-identity-and-enrollment.md)
- [CloudLink and core state machines](docs/concepts/cloudlink-and-core-state-machines.md)
- [IoT Cloud vertical-slice roadmap](docs/guides/iot-cloud-roadmap.md)
- [Multi-cloud fusion](docs/concepts/multi-cloud-fusion.md)
- [Edge, cloud, and provider authority](docs/concepts/edge-cloud-boundary.md)
- [Build with an AI agent](docs/guides/build-with-an-agent.md)
- [Add a Provider Adapter](docs/guides/add-provider-adapter.md)
- [Plan infrastructure safely](docs/guides/plan-infrastructure.md)
- [Repository layout](docs/reference/repository-layout.md)
- [Application contract catalog](docs/reference/application-contracts.md)
- [Artifact registry and immutable publication](docs/concepts/artifact-registry.md)

## Status

AetherCloud is at the repository-foundation stage. Read-only provider discovery
is implemented as a domain/application contract and test adapter, but it is not
yet exposed through HTTP or backed by a real provider. Deployment Stack State
isolation and governed Plan orchestration are implemented as contracts with
memory adapters. The real local OpenTofu process adapter is implemented and
opt-in integration-tested without a cloud account. Production remote State,
distributed locking, durable encrypted Plan storage, a public Plan API, and
every Apply path remain planned. Gateway registration,
claim issuance, claim consumption, and enrollment status query are implemented
as domain/application contracts with memory adapters; they are not HTTP routes,
production certificate enrollment, or durable persistence. CloudLink
session/heartbeat, Runtime Manifest, telemetry ingestion/history, alarm
projection/workflow, Artifact Registry publication/query, single-target
deployment, and governed capability Jobs are implemented as
domain/application contracts with memory adapters. Audit search is additionally
exposed through authenticated JSON and finite resumable SSE routes; webhook
subscription/delivery and data export are inner-layer foundations only. The MCP
resource/tool application interface is implemented without a wire server. No
CloudLink wire, long-running composition root, PostgreSQL adapter, public fleet
endpoint, or durable production audit/outbox exists. Most public Tenant APIs,
production telemetry storage, production artifact stores/signers, scheduling,
Job delivery, and the MCP transport runtime also remain planned. OpenTelemetry
instrumentation is partial and does not replace business telemetry or audit.
IoT telemetry is product data and remains separate from sampled operational
traces and metrics.
