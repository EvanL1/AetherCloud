---
title: IoT Cloud vertical-slice roadmap
description: Deliver AetherCloud product value through independently testable cloud-edge slices
updated: 2026-07-16
status: planned
---

# IoT Cloud vertical-slice roadmap

Each phase must be runnable and valuable without pretending that later phases
exist. The default verification path remains independent of PostgreSQL, cloud
accounts, and real AetherEdge devices through ports, memory adapters, and
contract fixtures.

## Phase 0: Audit and architecture contract

**Observable value.** Developers and agents can distinguish executable layers
from reviewed contracts, find every authority boundary, and select the next
slice without treating multi-cloud infrastructure work as the IoT product.

**Model.** Bounded contexts, authority matrix, capability map, implementation
status, state machines, storage ownership, and composition-root dependency
rules.

**API and protocol.** Machine-readable capability, permission, error, event,
and HTTP-operation catalog. No new runtime endpoint or CloudLink wire message.

**Persistence.** PostgreSQL, object, analytics, inbox/outbox, audit, and
OpenTelemetry responsibilities are assigned without installing a service.

**Security.** Edge authority, Tenant isolation, deny-by-default commands,
sensitive-data exclusion, and implemented/planned truth are documentation
contracts.

**Tests.** Manifest/frontmatter parity, links, required assets, catalog schema,
command metadata, and telemetry/observability separation.

**Done when.** The evidence-backed audit, capability map, state machines, ADRs,
roadmap, and Agent indexes agree and documentation contract tests pass.

**Not included.** Runtime code, provider expansion, OpenTofu Apply, production
infrastructure, or a fabricated edge protocol.

## Phase 1: Gateway identity and enrollment foundation

**Observable value.** An authorized operator can register a Gateway in one
Tenant and Project, issue one short-lived claim, let a runtime claim it, and
query the resulting state through application use cases.

**Model.** `TenantId`, `ProjectId`, `GatewayId`, `EnrollmentClaimId`,
`EnrollmentRequestId`, `GatewayIdentity`, and the
`registered -> awaiting-claim -> claimed` state machine.

**API and protocol.** Implemented transport-neutral register, issue, claim, and
get capabilities. No public HTTP route or CloudLink message yet.

**Persistence.** Implemented optimistic repository port, memory repository,
memory token service, and PostgreSQL Gateway repository/migration. The SQL
adapter provides Tenant RLS and atomic aggregate/Audit/Outbox writes. Production
database composition, roles, migration execution, backup/restore, and KMS token
service remain planned.

**Security.** Tenant-scoped permission checks, explicit confirmation for issue,
server expiry, idempotency conflicts, token digest at rest, raw token returned
once, generic claim rejection, and audit-required metadata.

**Tests.** ID decoding, state transitions, expiry boundary, identical replay,
conflicting claim, deny-by-default permission, confirmation, cross-tenant
query, optimistic replacement, token verification, and full memory flow.

**Done when.** Narrow tests, `pnpm check`, coverage thresholds, and production
dependency audit pass; agent documentation states the exact implemented surface.

**Not included.** CA/KMS, active credential, revocation, recovery, attestation,
production database deployment, HTTP enrollment, CloudLink, or device control.

## Phase 2: CloudLink heartbeat and session

**Current status.** The transport-neutral domain/application/memory foundation
implements credential verification through a port, protocol selection, lossless
epochs/cursors, fencing, resume, heartbeat, and session query. An experimental
JSON/MQTT codec, broker adapter, application bridge, ingress lifecycle, Schemas,
fixtures, and real-broker harness are also implemented. Production credential
lifecycle, shared AetherEdge conformance, timeout scheduler, PostgreSQL
session/epoch state, durable data-loss facts, multi-instance ownership, and
backpressure remain planned, so Phase 2 is not complete. The accepted-telemetry
PostgreSQL inbox/cursor/receipt/ACK transaction and delivery use case are
implemented, but they do not complete session durability. The production
release sequence is: shared-Broker origin authentication, one joint wire profile, identical
fixtures, a dual Edge/Cloud Broker harness, fault injection, crash-durable ACK
persistence, then explicit legacy cutover. The target profile is not yet the
implemented codec.

**Observable value.** An operator sees authenticated connection freshness, and
a Gateway reconnects without replaying already durable envelopes.

**Model.** `CredentialBinding`, `SessionEpoch`, `ProtocolVersion`,
`StreamCursor`, `HeartbeatObservation`, `IngressInbox`, and flow-control credit.

**API and protocol.** The provisional experimental core binding implements
session hello/accepted, heartbeat/ACK, Runtime Manifest, Point telemetry,
durable ACK, replay request, and data-loss wire shapes. Alpha.3 ACKs are
unsigned. Production challenge/per-uplink authentication remains blocked; a
future Cloud-signed ACK requires a new protocol version. Durable data-loss
persistence, multi-sample Cloud indexing, and credit messages require later
application work. Read-only session queries already use application use cases.

**Persistence.** The accepted-telemetry PostgreSQL inbox, cursor, receipt, Audit,
integration Outbox, and exact ACK outbox are implemented. PostgreSQL session,
epoch, data-loss, and multi-instance ownership remain planned; socket state
remains local to an independent CloudLink composition root.

**Operational observability.** A neutral failure-isolated ingress observer is
implemented. Wire it to the existing no-op/OpenTelemetry runtime with optional
W3C Trace Context, active-session and handshake metrics, and bounded export. No
Collector is needed by default.

**Security.** Credential verifier port, revocation check, new-session fencing,
protocol allow-list, bounded message/window limits, canonical uint64 strings,
authenticated per-Gateway Broker ACLs, and optional verified out-of-band
principal metadata from reviewed connector/Broker adapters. The current hello
proof is structural only. Generic shared-Broker mode requires a jointly frozen
establishment signature and a session-bound Gateway signature on every uplink;
trusted per-publish Broker attestation is the reviewed alternative. Topic or
payload identity never supplies authorization. Exact signing projections, key
rotation, and revocation remain gates.

**Tests.** Both repositories first close every pending AetherContracts import
and execute the complete identical valid/invalid fixture set. One real
Broker then runs the Edge harness and Cloud ingress while injecting disconnect,
ACK loss, Edge/Cloud process restart, duplicate delivery, conflicting digest,
and data loss. Unit coverage additionally includes gap, reorder window, old
epoch, simultaneous connections, backpressure, heartbeat timeout, missing
trace context, forbidden baggage authorization, redaction, and exporter loss.

**Done when.** The independent CloudLink root and AetherEdge harness resume from
the PostgreSQL durable cursor, a pre-commit crash emits no ACK, a post-commit
crash republishes one stable identical ACK, and every ordered interoperability gate
passes. The external-service-free default suite remains available separately.

**Not included.** Artifact delivery, arbitrary RPC, physical commands, direct
SHM writes, or device-register writes. Legacy remains the default until the
phase is complete.

## Phase 3: Runtime manifest and capability catalog

**Current status.** The bounded AetherEdge Runtime Manifest v1 report/query slice
is implemented in domain, application, Node checksum, and memory repository
layers. It validates exact external fields, verifies the AetherEdge canonical
JSON SHA-256 vector, derives scope from an active credential, preserves
lossless generations and late history, rejects conflicting reuse, and exposes
the current capability catalog. PostgreSQL, durable audit/outbox, CloudLink
wire transport, public fleet API, freshness policy, and Instance/Point catalog
remain planned, so Phase 3 is not complete.

**Observable value.** Operators and deployment planners can query runtime
versions, reported Instances/Points metadata, and supported edge capabilities
with observation time and freshness.

**Model.** Implemented `RuntimeManifestObservation`, `ManifestGeneration`, and
capability/protocol catalog values; planned `RuntimeVersion`, `InstanceDescriptor`,
`PointDescriptor`, `CapabilityDescriptor`, `ManifestGeneration`, and freshness.

**API and protocol.** Implemented transport-neutral report command and current
manifest query. A versioned manifest observation envelope, public fleet/version
queries, and dynamic groups with typed predicates remain planned.

**Persistence.** Implemented atomic memory latest/history and request replay
adapter for conformance. PostgreSQL latest/historical metadata is planned;
object storage is considered only if bounded relational storage is insufficient.

**Security.** Authenticated Gateway binding, schema/version validation, count
and size quotas, and no cloud mutation of commissioned edge channels.

**Tests.** Duplicate and old generation, reorder, unknown capability,
unsupported version, excessive size, stale projection, and tenant isolation.

**Done when.** Fleet queries return capability provenance, `observedAt`, and
freshness; deployment compatibility can consume the application contract.

**Not included.** Artifact publication, rollout, Job execution, or a universal
Entity/Relation/Attribute store.

## Phase 4: IoT telemetry ingestion

**Current status.** The protocol-neutral domain/application slice, canonical
digest, memory inbox/history/outbox/audit adapter, durable receipt, duplicate
and conflicting replay handling, gap/coalescing behavior, quota, scoped history
query, OpenTelemetry ingestion decorator, edge-native Point identity, topology
binding, and experimental CloudLink MQTT mapping are implemented. PostgreSQL,
accepted-fact/history/cursor storage, Audit/integration Outbox, exact ACK outbox,
and a bounded delivery use case are also implemented and PostgreSQL 18 verified.
Public HTTP, production database/worker composition, durable data-loss,
multi-sample mapping, downsampling, and export remain planned, so the production
phase is partial.

**Observable value.** Tenants query replay-safe Point and device-event history
without confusing it with authoritative edge live state.

**Model.** `TelemetryStream`, `TelemetryBatch`, `PointSample`, `DeviceEvent`,
`StreamEpoch`, lossless `StreamPosition`, `IngestionReceipt`, `RetentionClass`,
and gap marker.

**API and protocol.** Protocol-neutral ingest and history queries plus an
experimental versioned MQTT envelope are implemented. The envelope remains a
pre-release candidate. Durable ACK follows application acceptance; the bridge
can use the exact PostgreSQL-persisted projection, while authentication and
production composition remain gated.

**Persistence.** PostgreSQL inbox, cursor, metadata, quota, initial bounded
history, Audit, integration Outbox, and exact ACK outbox are implemented;
raw/cold batches may move to object storage when justified through a replaceable
history-store port.

**Security.** Credential-derived Tenant/Gateway scope, decompression and batch
limits, canonical int64 encoding, quota, retention, payload decoding, and
explicit freshness. OpenTelemetry labels exclude resource identities.

**Tests.** Valid/invalid batch, revoked Gateway, replay, same-ID conflict, gap,
reorder, atomic batch failure, int64 boundaries, crash before/after commit,
disconnect, retention overflow, exporter failure isolation, and history query.

**Done when.** Ack follows durable acceptance; replay produces no duplicate
fact or event; history exposes source/ingest time, position, quality, and known
gaps; no code presents it as live authority.

**Not included.** Cloud live-state authority, cloud deterministic rules,
high-cardinality Point metrics, or a claim that the experimental schema is a
released cross-repository contract.

## Phase 5: Alarm projection

**Current status.** Edge alarm-fact domain projection, authenticated ingestion,
Tenant query, cloud-only acknowledgement, canonical digest, replay/conflict/gap/
late behavior, and a memory projection/audit/outbox adapter are implemented.
PostgreSQL, CloudLink wire, public HTTP/search, assignment, comments, and
freshness reconciliation remain planned, so the production phase is partial.

**Observable value.** Tenants search replay-safe edge alarm facts and manage
cloud-only acknowledgement, assignment, and comments without changing edge
safety state.

**Model.** `AlarmOccurrence`, `AlarmFact`, `AlarmProjection`, edge generation
and sequence, workflow acknowledgement, assignment, comment, and freshness.

**API and protocol.** Authenticated alarm-fact ingestion, alarm search/timeline,
and cloud workflow commands through shared application use cases.

**Persistence.** PostgreSQL inbox, append-only facts, projection, workflow,
audit, and outbox.

**Security.** Gateway binding, bounded payload, Tenant isolation, cloud workflow
permissions, and no cloud operation that clears a local alarm or interlock.

**Tests.** Duplicate/conflicting fact, clear-before-raise, missing predecessor,
late update, disconnect stale state, re-raise generation, cross-Tenant query,
workflow audit, and projection retry.

**Done when.** Every projection exposes completeness and freshness, edge fact
state remains separate from cloud workflow, and replay is idempotent.

**Not included.** Cloud-authoritative deterministic alarms, physical interlock
mutation, or alarm clearing through CloudLink.

## Phase 6: Artifact registry

**Current status.** The explicit Artifact/Revision domain lifecycle,
lossless revision/content-length values, immutable publication, compatibility
and dependency metadata, digest/content verification port, signature verifier
port, release-channel conflict protection, publish/query use cases, and atomic
memory metadata/content/audit/outbox adapter are implemented. PostgreSQL,
production object storage, KMS-backed signature verification, upload HTTP,
deprecate/withdraw commands, and edge download remain planned, so the
production phase is partial.

**Observable value.** Teams publish immutable, verifiable Pack, configuration,
model, rule, and application revisions with provenance and compatibility.

**Model.** `Artifact`, `ArtifactRevision`, `ContentDigest`, `Signature`,
`CompatibilitySpec`, `ReleaseChannel`, and `Publication`.

**API and protocol.** Upload/finalize, validate, publish, deprecate, withdraw,
channel update, and read/query APIs. Edge download protocol remains reference by
digest rather than inline mutable content.

**Persistence.** PostgreSQL metadata; object storage blob, signature, SBOM, and
provenance; transactional outbox for publication events.

**Security.** Digest verification, immutable writes, signer/provenance policy,
malware/content validation hooks, upload limits, and permissioned publication.

**Tests.** Tampered upload, duplicate digest, validation failure, signature
failure, publish race, conflicting idempotency, channel race, and withdrawal.

**Done when.** A published revision is immutable, independently verifiable, and
stable enough for desired-state references.

**Not included.** Rollout scheduling or edge activation.

The implemented layer contract and remaining production boundary are detailed
in [Artifact registry and immutable publication](../concepts/artifact-registry.md).

## Phase 7: Desired, reported, and applied deployment

**Current status.** A single-Gateway domain/application/memory foundation is
implemented. It verifies a published Artifact, creates lossless Desired
generations, keeps Reported and Applied separate, authenticates edge
observations, represents timeout as unknown without an Applied fact, preserves
late observations, supports pause/resume/cancel-request and rollback as a new
generation, and atomically records memory audit/outbox evidence. PostgreSQL,
durable audit/outbox, target snapshots, canary/batch scheduling, CloudLink wire,
HTTP, and AetherEdge delivery remain planned, so the production phase is partial.

**Observable value.** Operators perform canary/batched rollout, pause/resume,
cancel remaining targets, roll back through a new generation, and see truthful
divergence and partial success.

**Model.** `Deployment`, `Rollout`, `TargetSnapshot`, `DesiredGeneration`,
`ReportedRevision`, `AppliedEvidence`, rollout policy, and target result.

**API and protocol.** Start/pause/resume/cancel-request/rollback commands,
divergence queries, immutable revision offer, and edge accept/reject/fetch/
validate/apply observations.

**Persistence.** PostgreSQL aggregate, target state, inbox/outbox, and audit;
object storage for large evidence.

**Security.** Artifact compatibility, target snapshot, permission/risk/
confirmation, expiry, precondition, and anti-TOCTOU policy checks.

**Tests.** Old report, duplicate desired generation, partial success, disconnect
unknown, cancel race, paused delivery, late applied evidence, rollback, and
target replacement during rollout.

**Done when.** Desired, reported, and applied are separately queryable and no
intermediate delivery state is presented as applied.

**Not included.** General-purpose edge capability commands.

See [Desired, Reported, and Applied deployment](../concepts/desired-reported-applied-deployment.md)
for the implemented boundary.

## Phase 8: Governed capability Jobs

**Current status.** The capability-gated domain/application/memory foundation
is implemented. It derives governance from declarations, requires platform and
capability permissions, supports confirmation/queue/offer/unknown/cancel,
orders lossless edge Receipts across gaps, binds ingestion to an active Gateway
credential, and atomically records memory audit/outbox evidence. PostgreSQL,
Runtime Manifest declaration provenance, CloudLink delivery, workers, public
HTTP, evidence storage, and the AetherEdge counterpart remain planned, so the
production phase is partial.

**Observable value.** Tenants first run low-risk diagnostics and later approved
commands through one auditable Job lifecycle with edge rejection preserved.

**Model.** `CapabilityDeclaration`, `CapabilityJob`, `Risk`, `Confirmation`,
`Precondition`, `ExecutionAttempt`, `Receipt`, and evidence reference.

**API and protocol.** Create, confirm, offer, cancel-request, status, and Receipt
ingestion. Capability schemas come from the runtime catalog; no arbitrary RPC.

**Persistence.** PostgreSQL Job ledger, immutable Receipt inbox, audit, and
outbox; object storage for large evidence.

**Security.** Permission, risk, confirmation, idempotency, expiry, precondition,
audit, edge-side acceptance, and explicit non-idempotent unknown semantics.

**Tests.** Missing governance metadata, permission/confirmation failure,
precondition drift, duplicate, conflicting duplicate, edge rejection, timeout,
late Receipt, retry, cancel race, partial result, and network partition.

**Done when.** Creation through final Receipt has a correlated immutable audit
chain and no transport bypass exists.

**Not included.** Physical control enabled by default; such capabilities remain
deny by default and require additional policy evidence.

See [Governed capability Jobs](../concepts/governed-capability-jobs.md) for the
implemented boundary.

## Phase 9: Audit, query, integration, operations, and observability

**Current status.** Tenant/Project-scoped audit values and cursor query, an
authenticated JSON route, a finite `Last-Event-ID` resumable SSE snapshot,
webhook subscription and bounded delivery/retry/dead-letter/redrive state
machines, asynchronous Data Export request/outcome/query, and memory adapters
are implemented. PostgreSQL durability, production identity, live notification,
destination registry/secrets/signing/SSRF defence, workers, object storage,
download, quota, fleet health, and WebSocket remain planned, so Phase 9 is
partial.

**Observable value.** Operators search the complete action history, monitor
connection/data/deployment/Job health, and safely subscribe, export, or deliver
webhooks.

**Model.** `AuditEvent`, `FleetHealthProjection`, `Subscription`,
`WebhookEndpoint`, `DeliveryAttempt`, `DeadLetter`, `ExportJob`, `Quota`, and
`RetentionBudget`.

**API and protocol.** Tenant-filtered audit/fleet queries, SSE/WebSocket event
resume, webhook/subscription/export commands, and dead-letter redrive.

**Persistence.** PostgreSQL audit/outbox/delivery and summary state; object
storage exports; optional OpenTelemetry traces/metrics backend; broker only
after measured need.

**Security.** Append-only audit, redaction, webhook SSRF prevention and signing,
secret rotation, Tenant-filtered streams, quotas, and rate limits.

**Tests.** Cross-tenant search, duplicate delivery, exponential retry, dead
letter, redrive, stream disconnect/resume, webhook rotation, quota, retention,
projection freshness, trace propagation, redaction, metric cardinality, bounded
export, and exporter failure isolation.

**Done when.** Every earlier command and ingestion path is correlated in audit,
and health views expose source time and freshness.

**Not included.** Kafka, Redis, Kubernetes, or service extraction without
measured operational evidence.

## Phase 10: MCP resources and tools

**Current status.** A transport-neutral MCP interface lists capability and Audit
resources, reads Tenant audit evidence through `SearchAuditEvents`, advertises
complete governance metadata, and exposes `data.export.request` and
`edge.job.create` through their existing application commands. Planned tools
fail closed. An MCP SDK transport, stdio/Streamable HTTP composition root,
production identity/audit, rate limit, and remaining resources/tools are
planned, so Phase 10 is partial and no MCP client can connect to a wire server
yet.

**Observable value.** Coding and operations agents read real product contracts,
capability metadata, and Tenant projections, then invoke only existing governed
use cases.

**Model.** `DocumentationResource`, `CapabilityDefinition`, tool input/output
schema, actor provenance, and audit correlation.

**API and protocol.** Read-only documentation and query resources first. A
command tool maps one-to-one to an implemented application command and displays
permission, risk, confirmation, idempotency, and expiry before invocation.

**Persistence.** Reuse normal application ports and audit; no agent-only data
path.

**Security.** Tenant authorization, least privilege, explicit confirmation,
prompt/output redaction, provenance, rate limit, and deny-by-default discovery.

**Tests.** HTTP/CLI/MCP use-case parity, planned capability rejection, metadata
completeness, cross-tenant denial, confirmation, secret redaction, and audit.

**Done when.** An agent can determine implemented/planned status and governance
requirements before a call, and every tool result traces to the same use case.

**Not included.** A chatbot that writes storage, an agent-only CloudLink path,
or direct physical control.
