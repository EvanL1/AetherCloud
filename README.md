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
history, and memory adapters. An experimental CloudLink MQTT slice adds strict
versioned JSON codecs, topic/session binding, a MQTT.js transport, an
application bridge, an independently startable ingress lifecycle, candidate
Schemas/fixtures, and an opt-in real-broker transport harness. The ordered
CloudLink interoperability gates now record provisional core fixture
convergence while requiring shared-Broker message-origin authentication first,
then one public alpha.3 wire profile with unsigned application ACKs. A dual
Edge/Cloud real-Broker harness and alpha fault injection now provide opt-in
evidence. A separate opt-in AWS IoT Core mTLS harness provisions and cleans
ephemeral least-privilege principals while exercising the same Cloud ingress
and Edge spool. A separate PostgreSQL telemetry slice now supplies atomic
receipt/fact/Audit/integration-Outbox/exact-ACK evidence across pre-commit and
post-commit failures, but the full crash-durable gate remains blocked before
legacy cutover. The
public AetherContracts `v0.1.0-alpha.3` release is consumed through the same
complete, digest-pinned lock in Cloud and Edge with no pending imports. This
proves offline distribution integrity and product fixture execution; it does
not prove production authentication, signed ACK, full CloudLink crash
durability, or cutover readiness. Atomic IoT telemetry ingestion/history and alarm
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
production remote State and encrypted object storage, production CloudLink
identity/durability/process configuration,
remaining durable persistence, Apply, production Gateway credentials, production
telemetry/alarm/artifact/deployment/Job persistence, remaining public interfaces,
scheduling, production integration delivery, and MCP transport are separate contract-first vertical
slices.

The first PostgreSQL persistence slice now adds a parameterized Gateway
Identity repository, explicit migration, Tenant-scoped Row-Level Security,
optimistic revisions, a real `pg` pool boundary, and atomic aggregate, Audit,
and Outbox writes. The telemetry PostgreSQL slice adds lossless cursor/history,
idempotent receipts, forced RLS, Audit/integration Outbox, an exact durable ACK
outbox, and a bounded leased delivery use case. Its PostgreSQL 18 tests prove no
ACK before commit and identical ACK recovery after an uncertain commit.
`managed-postgresql` is a portable Provider capability; production database and
worker composition plus provider-specific database profiles remain planned.

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
- [PostgreSQL persistence and multi-cloud cells](docs/concepts/persistence-and-multi-cloud-cells.md)
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
- [Pre-release CloudLink MQTT v1](docs/reference/cloudlink-mqtt-v1.md)
- [CloudLink interoperability release gates](docs/adr/0015-cloudlink-interoperability-release-gates.md)
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
as domain/application contracts with memory and PostgreSQL adapters. The
PostgreSQL slice atomically writes Gateway, Audit, and Outbox records, but it is
not wired to an HTTP route or production database deployment and does not issue
certificates. CloudLink
session/heartbeat, Runtime Manifest, telemetry ingestion/history, alarm
projection/workflow, Artifact Registry publication/query, single-target
deployment, and governed capability Jobs are implemented as
domain/application contracts with memory adapters. Telemetry also has a bounded
PostgreSQL repository and exact ACK-delivery slice, without a production
composition root. Audit search is additionally
exposed through authenticated JSON and finite resumable SSE routes; webhook
subscription/delivery and data export are inner-layer foundations only. The MCP
resource/tool application interface is implemented without a wire server. The
experimental CloudLink MQTT codec/ingress and complete digest-pinned alpha.3
contract adoption exist. Production key lifecycle, a signed-ACK profile,
production CloudLink process configuration, complete session/loss durability,
and full production crash-restart proof do not exist. The consumer dual Edge/Cloud harness is
development evidence only. The candidate is experimental; legacy remains the default and no
physical control is part of this milestone. No long-running worker root, public fleet endpoint, or general
production persistence exists. Most public Tenant APIs,
production telemetry composition and analytics, production artifact stores/signers, scheduling,
Job delivery, and the MCP transport runtime also remain planned. OpenTelemetry
instrumentation is partial and does not replace business telemetry or audit.
IoT telemetry is product data and remains separate from sampled operational
traces and metrics.
