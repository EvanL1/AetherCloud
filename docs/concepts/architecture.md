---
title: Architecture
description: Understand the modular-monolith processes, dependency direction, and evolution rules
updated: 2026-07-29
status: mixed
---

# Architecture

AetherCloud starts as a modular monolith: one repository, one set of domain and
application modules, and several small composition roots that can run and scale
independently. This keeps transactions and refactors local without coupling
long-lived edge sessions to request/response API workloads.

## Target process model

```text
                         application modules
                        /        |          \
                 HTTP API    CloudLink     workers
                    |           |            |
               REST / MCP   CloudLink/MQTT IaC/jobs/projections

                            web console
                                 |
                              HTTP API
```

- `api` serves REST, OpenAPI, WebSocket notifications, and later MCP Streamable
  HTTP.
- `cloud-link` owns authenticated, long-lived AetherEdge sessions and protocol
  acknowledgement.
- `workers` execute isolated infrastructure plans, refresh provider inventory,
  advance deployments and telemetry projections, retry work, and deliver the
  outbox.
- `web` is an authenticated client of the API and has no privileged data path.

Only the API is a configured long-running process in the repository-foundation milestone.
It exposes authenticated audit JSON and finite resumable SSE snapshots in
addition to public liveness/product metadata. The composition root explicitly
selects a memory or PostgreSQL Audit repository; PostgreSQL mode uses bounded
pool settings, Tenant transaction context, forced RLS, a non-owner application
role, and CA-verified TLS. Its configured bearer identity is still not
production IAM.
`apps/mcp` is an implemented transport-neutral resource/tool interface, not a
runnable MCP composition root. It delegates Audit, Data Export, and governed Job
operations to application use cases; MCP SDK transport and identity composition
remain planned.
The CloudLink package now exposes an independently startable experimental MQTT
ingress lifecycle backed by strict codecs and application use cases, but it has
no production environment composition or durable PostgreSQL adapters. Workers
remain planned. The experimental ingress must not be presented as a production
CloudLink service.

## Dependency direction

```text
domain <- ports <- application <- interfaces/composition roots
             ^
             +---- adapters
```

Domain code owns identifiers, values, invariants, and state transitions. Ports
describe capabilities such as an artifact repository or job ledger. Application
code authorizes and coordinates use cases. Adapters implement ports using
PostgreSQL, object storage, identity providers, and network transports.

Provider adapters also implement application ports. They expose declared
capabilities and provider-native extensions without leaking vendor SDK types
into domain or application modules. OpenTofu is the default infrastructure
engine and Terraform is compatible through the same engine port.

Concrete infrastructure never appears in domain names. Prefer `JobLedger` to a
generic database port and `ArtifactStore` to an object-storage SDK wrapper.

## Initial bounded contexts

- Identity and access
- Provider catalog and cloud connections
- Cloud inventory and normalized resource graph
- Placement and deployment stacks
- Fleet and topology
- Telemetry and alarms
- Artifacts and releases
- Deployments and desired state
- Capability jobs
- Audit
- Integrations and export

Operational observability is a cross-cutting adapter concern rather than a
business bounded context. OpenTelemetry SDK types do not enter the domain or
application packages, and its signals do not replace IoT telemetry or audit.

Shared code is intentionally small. A bounded context exports a contract rather
than exposing its internal records to another context.

## Data and messaging

PostgreSQL is the default transactional AetherCloud product store. Gateway,
CloudLink session, telemetry, integration projection/control, and Audit query
adapters now have migration or repository foundations. The API composition
root can query Audit through PostgreSQL, while public write routes, full
bounded-context production composition, and workers remain planned.
Infrastructure state is different: each provider-scoped deployment stack uses
its own remote, locked backend. Workers are stateless with respect to infrastructure state and
consume saved JSON plans rather than scraping terminal output or raw state
text.

The first background-work implementation should use a transactional outbox and
PostgreSQL-backed workers. A broker is introduced only when measured
throughput, retention, or consumer isolation requires it.

The first experimental CloudLink wire contract uses versioned strict JSON over
MQTT so TypeScript and Rust can execute the same fixtures. A later binary
encoding requires joint AetherCloud/AetherEdge review and cannot change business
identity or acknowledgement semantics. Sequence fields remain canonical decimal
strings without unsafe JavaScript-number conversion.

See [multi-cloud fusion](multi-cloud-fusion.md) for provider, state, credential,
and execution boundaries.

## Service extraction rule

A module becomes a separately owned service only when at least one of these is
measured:

- materially different scaling characteristics
- a security or failure-isolation boundary
- an independent deployment cadence owned by another team
- a persistence or regional-placement requirement that cannot be met in-process

The extraction must preserve the application contract and add failure-mode
tests before changing deployment topology.

## IoT context collaboration

The complete bounded-context map is maintained in the
[IoT Cloud capability map](iot-cloud-capability-map.md). Contexts expose
application contracts or events rather than database records:

```text
Identity and Access -> authorization decisions
Fleet Identity -> CloudLink credential verification
Runtime Catalog -> deployment compatibility and Job eligibility
Artifact Registry -> immutable Deployment revision references
CloudLink -> application ingestion use cases
Application transactions -> audit + outbox
Outbox -> projections, notifications, webhooks, exports, SSE, and WebSocket
```

HTTP, CLI, MCP, and CloudLink interfaces all decode external input and call the
same command/query application API. An edge observation that changes a cloud
projection is an authenticated ingestion command even when the edge-originated
fact is descriptive. Query does not mean "safe to write because the data came
from an edge."

## HTTP and CloudLink boundary

HTTP authenticates people and service accounts, evaluates Tenant authorization,
and creates cloud intent such as desired state or a governed Job. It persists
that intent and an outbox record; it never sends through a live edge socket.

CloudLink authenticates Gateway credentials and owns session fencing, protocol
negotiation, stream sequence, durable acknowledgement, resume, and backpressure.
It reads application-owned mailboxes and invokes the owning bounded context for
telemetry, manifest, deployment, or Receipt ingestion. It does not implement
those business state machines or expose arbitrary RPC.

This is why the API and CloudLink composition roots are independent even while
the product remains a modular monolith. Request/response traffic and long-lived
connections have different scaling, draining, and failure behavior. Workers
are a third independent root for outbox delivery, projections, retries,
retention, and governed background execution.

## Authority and data placement

| Store                            | Responsibility                                                                                                                                                              | Explicitly not authoritative for                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| PostgreSQL                       | Tenant/IAM, Fleet identity, latest manifests, session cursors, artifact metadata, desired/reported/applied metadata, Job ledger, Receipt index, audit, inbox, outbox, quota | edge live point state; provider resources; infrastructure State |
| Object storage                   | immutable artifacts, signatures, provenance, raw/cold telemetry batches, large evidence, exports                                                                            | mutable aggregate state or credentials                          |
| Time-series or analytics storage | historical telemetry/event projection, downsampling, aggregates                                                                                                             | current edge point value or alarm truth                         |
| Deployment-stack remote backend  | one provider-scoped locked infrastructure State                                                                                                                             | IoT Fleet, telemetry, or cross-provider global state            |

PostgreSQL may initially implement a history-store adapter, but the application
port remains independent so measured ingestion or analytical requirements can
select a different adapter later.

Operational traces and metrics leave composition roots through an optional
OpenTelemetry adapter and OTLP exporter. Their backend has no transactional or
authority role. Exporter failure cannot change a command, durable
acknowledgement, or worker result.

Desired, reported, and applied are separately persisted facts. A projection
always carries source observation time and freshness. No database choice
changes the authority defined by the edge/cloud/provider boundary.

## Transactional inbox and outbox

A command transaction atomically writes its aggregate change, required audit
record, and outbox message. Edge ingestion atomically records its de-duplication
identity and accepted business fact before CloudLink acknowledges it. Workers
lease work, retry within a bounded policy, and make dead-letter state visible.

PostgreSQL-backed delivery is the default. Kafka or another broker is introduced
only after measured throughput, retention, or consumer-isolation requirements,
and never changes command idempotency or durable acknowledgement semantics.
Outbound webhook attempt intent is persisted before network I/O, uses one
stable delivery identity across bounded retries, and becomes a visible dead
letter when exhausted. Data exports publish immutable object references rather
than returning unbounded history through the API process. See
[audit and integrations](audit-and-integrations.md).

Multi-cloud portability is expressed through independently deployable cells
and Provider database profiles, not a generic lowest-common-denominator
database API. One cell has one authoritative PostgreSQL writer topology; a
Tenant has an explicit home cell. Cross-cloud backup, disaster recovery, and
Tenant migration require fencing and governed workflows. Read
[PostgreSQL persistence and multi-cloud cells](persistence-and-multi-cloud-cells.md).

## Tenant isolation

Every Tenant-owned aggregate, event, unique constraint, object prefix, inbox,
outbox, cache key, and analytical partition carries `TenantId`. A user or
service-account interface resolves Tenant context from authenticated identity;
a Gateway interface resolves it from the verified claim or active credential.
Body and path identifiers select resources only after that context exists.

Implemented PostgreSQL adapters combine application-enforced scope, composite
Tenant keys, and forced row-level security as defense in depth; contexts not
yet composed for production must preserve the same boundary. Cross-Tenant access is
available only through an explicit platform use case with separate permission
and audit evidence.

Before implementing a CloudLink integration, read the
[CloudLink MQTT reference](../reference/cloudlink-mqtt-v1.md) and
[CloudLink reliability and lifecycle](cloudlink-and-core-state-machines.md).

Read [IoT business telemetry](iot-telemetry.md) before adding history or
ingestion and [operational observability](operational-observability.md) before
adding instrumentation. Use the [IoT Cloud roadmap](../guides/iot-cloud-roadmap.md)
to distinguish capabilities available now from those that remain planned.
