---
title: IoT Cloud capability map
description: Map AetherCloud bounded contexts, authority, use cases, storage, edge interaction, risk, and delivery phase
updated: 2026-07-15
status: mixed
---

# IoT Cloud capability map

AetherCloud is an IoT fleet, data, artifact, and governed-work control plane.
Multi-cloud infrastructure fusion is an adjacent capability, not the organizing
model for these IoT contexts. AetherCloud coordinates unreliable wide-area work
without joining the hard real-time control loop.

## Current implementation audit

### Implemented

- Node.js 24, TypeScript 5.9, ESM, pnpm workspace, strict type checking,
  linting, formatting, tests, and coverage gates
- edge/cloud/provider authority values and tests
- capability-driven cloud Provider descriptors, catalog, Cloud Connection and
  read-only discovery foundations, plus memory conformance infrastructure
- one HTTP composition root with public health/platform routes and authenticated
  audit JSON/finite resumable SSE query routes
- agent documentation index, manifest, Skill, invariants, ADRs, and contract
  tests
- Gateway identity and enrollment domain/application foundation described in
  [Gateway identity and enrollment](gateway-identity-and-enrollment.md)
- transport-neutral CloudLink session/heartbeat domain/application foundation
  with epoch fencing, cursor resume, credential verification port, and memory
  adapter
- AetherIot Runtime Manifest v1 report/query domain/application foundation with
  canonical checksum verification, monotonic history, and memory adapter
- replay-safe IoT telemetry batch ingest/history domain/application foundation
  with lossless positions, conflict/gap/reorder handling, and atomic memory
  inbox/history/audit/outbox evidence
- edge-authoritative alarm fact ingestion and cloud workflow projection
  foundation with generation/sequence ordering, visible gaps, cloud-only
  acknowledgement, and an atomic memory adapter
- optional OpenTelemetry adapter foundation with default no-op operation,
  in-memory and OTLP modes, bounded export, W3C context extraction,
  low-cardinality ingestion signals, and exporter-failure isolation
- immutable Artifact Revision publication/query foundation with digest/content
  verification, signature-verifier abstraction, compatibility metadata,
  release-channel conflict protection, and atomic memory audit/outbox evidence
- single-target Desired/Reported/Applied deployment foundation with published
  Artifact preconditions, lossless generations, pause/resume/cancel/rollback,
  explicit unknown outcome, authenticated edge observations, and memory audit/outbox
- governed capability Job foundation with declaration-derived permission/risk,
  explicit confirmation, queue/offer controls, unknown and cancellation intent,
  ordered authenticated Receipts, and atomic memory audit/outbox evidence
- Tenant/Project-scoped audit search, webhook subscription, bounded
  delivery/retry/dead-letter/redrive, and asynchronous data-export foundations
  with memory adapters; audit search is exposed through HTTP/SSE
- transport-neutral MCP capability/Audit resources and governed Data Export/Job
  tools that invoke the same application use cases

### Designed or planned, not implemented

- Tenant, User, Service Account, RBAC/ABAC, API credentials, and durable audit
- Site, Instance, Point, topology, and dynamic groups beyond the Runtime
  Manifest/capability foundation
- CloudLink executable process, protocol messages, production credentials,
  PostgreSQL session/cursors, durable inbox/outbox, and backpressure
- production telemetry/alarm PostgreSQL persistence, CloudLink wire adapters,
  public history/search APIs, downsampling, export, assignment, and comments
- production artifact stores/upload/API and multi-target deployment scheduling,
  persistence, wire, and public interfaces
- production governed Job ledger/inbox, CloudLink delivery, Runtime Manifest
  declaration provenance, workers, public interfaces, and AetherIot counterpart
- PostgreSQL, object-storage, time-series, durable outbox, integration/export
  workers, production webhook sender/destination secrets/signing, live SSE,
  WebSocket, MCP wire/root and remaining tools, fleet operations, quota, or cost
  adapters
- a production Gateway CA, KMS token service, certificate revocation, recovery,
  or enrollment HTTP endpoint

The planned items below are contracts and delivery direction, not available
endpoints or protocol messages. The evidence behind this summary is maintained
in the [current implementation audit](current-state-audit.md).

## Capability map

| Bounded context                    | User value and core aggregates                                                                                                                                                     | Authority                                                                                                           | Queries / commands                                                                                            | Storage needs                                                                                                      | AetherIot interaction                                                                           | Main safety risk                                                                                                  | Phase                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Identity and Access                | Isolate and delegate access with `Tenant`, `Project`, `User`, `ServiceAccount`, `Role`, `Grant`, `Policy`, and `ApiCredential`                                                     | AetherCloud owns membership and authorization; an external IdP may prove login identity                             | Q: principals, grants, effective permissions. C: invite, grant, revoke, rotate credential                     | PostgreSQL; hashes or secret references only; audit and outbox in the same transaction                             | Deliver bounded authorization evidence; edge still applies local policy                         | forged Tenant context, cross-tenant IDOR, over-broad service accounts, leaked keys                                | minimum actor context begins in phase 1; durable IAM before public Tenant APIs |
| Fleet Identity and Enrollment      | Establish and recover trusted runtime identity with `Site`, `GatewayIdentity`, `EnrollmentClaim`, `CredentialBinding`, and `RecoveryAttempt`                                       | AetherCloud owns fleet membership; Gateway owns its private key; issuer owns certificate validity                   | Q: Gateway and enrollment status. C: register, issue claim, claim, suspend, revoke, recover                   | memory conformance now; PostgreSQL and secret/KMS-backed token service later                                       | one-time bootstrap claim, then credential-bound CloudLink authentication                        | token used as a long-term credential, replay, cross-tenant recovery, revoked credential resurrection              | phase 1                                                                        |
| Fleet Topology and Runtime Catalog | Search sites and understand runtime compatibility with `Site`, `Gateway`, `Instance`, `PointMetadata`, `Group`, `TopologyEdge`, `RuntimeManifest`, and `CapabilityCatalog`         | cloud owns grouping; edge reports actual instances, points, runtime, and supported capabilities                     | Q: topology, dynamic groups, version distribution. C: edit site/group/tag; authenticated manifest ingestion   | PostgreSQL for metadata/latest projection; object storage for large historical manifests if required               | edge sends versioned manifest and capability snapshots                                          | generic relation model erases lifecycles; stale manifest treated as current; cloud rewrites commissioned channels | phase 3                                                                        |
| CloudLink Session and Delivery     | Maintain resumable, observable cloud-edge connectivity with `Session`, `SessionEpoch`, `ProtocolNegotiation`, `StreamCursor`, `Inbox`, and `OutboundMailbox`                       | cloud owns durable cursors and connection projection; edge owns its unacknowledged bounded buffer                   | Q: session, lag, version. C: authenticate, negotiate, resume, heartbeat, durable ingest; never arbitrary RPC  | PostgreSQL session/cursor/inbox/outbox; active socket only in CloudLink memory                                     | version negotiation, per-stream order, acknowledgement, reconnect, and flow control             | split-brain sessions, acknowledge-before-durable, gaps, unsafe int64 conversion, unbounded queues                 | phase 2                                                                        |
| IoT Telemetry Projection           | Query replay-safe Point and event history with `TelemetryStream`, `TelemetryBatch`, `PointSample`, `DeviceEvent`, `IngestionReceipt`, and `RetentionClass`                         | edge owns live values; cloud owns durable historical facts, retention, and freshness-labelled projections           | Q: history, aggregates, cursor/gap. C: atomically ingest batch and set retention                              | PostgreSQL metadata/inbox/cursor and initial history; object storage raw/cold batches; replaceable analytics store | edge replays stream positions; cloud acknowledges only after durable acceptance                 | history represented as live state, silent gaps, conflicting replay, unsafe int64 conversion                       | phase 4                                                                        |
| Alarm Projection                   | Search edge alarm facts and manage cloud workflow with `AlarmOccurrence`, `AlarmProjection`, `Acknowledgement`, `Assignment`, and `Comment`                                        | edge owns alarm facts; cloud owns replay-safe projection and operator workflow overlays                             | Q: alarm search/timeline. C: ingest facts and change cloud-only workflow; cloud cannot clear edge alarm       | PostgreSQL inbox, alarm facts, projections, workflow, audit, and outbox                                            | edge replays alarm generation/sequence; cloud preserves stale/gap state                         | cloud acknowledgement confused with edge clear; late clear loses predecessor; disconnect clears alarm             | phase 5                                                                        |
| Artifact Registry and Release      | Publish verifiable immutable Pack, configuration, model, rule, and application revisions with `Artifact`, `Revision`, `Digest`, `Signature`, `Compatibility`, and `Channel`        | AetherCloud owns publication and channel references; edge owns verified local cache                                 | Q: metadata, compatibility, provenance. C: upload, validate, sign, publish, deprecate, withdraw, move channel | PostgreSQL metadata; object storage blobs, signatures, SBOM, provenance                                            | edge downloads by digest and validates before local acceptance                                  | mutable blob, supply-chain injection, missing compatibility, evidence deletion                                    | phase 6                                                                        |
| Deployment and Desired State       | Roll out, pause, resume, and roll back artifacts with `Deployment`, `Rollout`, `Target`, `DesiredGeneration`, `ReportedRevision`, and `AppliedEvidence`                            | cloud owns desired generation and rollout; edge owns reported and applied facts                                     | Q: desired/reported/applied divergence. C: start, pause, resume, cancel request, rollback                     | PostgreSQL transaction state and outbox; object storage for large evidence                                         | send immutable revision reference; edge accepts/rejects/downloads/validates/applies and reports | download inferred as applied, late report rolls projection back, partial failure hidden                           | phase 7                                                                        |
| Governed Capability Jobs           | Safely request diagnostics and later controlled work with `CapabilityDeclaration`, `Job`, `Confirmation`, `Precondition`, `Attempt`, and `Receipt`                                 | cloud owns intent/policy/confirmation; edge owns accept/reject/expire/execute/result                                | Q: Job and Receipt. C: create, confirm, offer, request cancellation; every command has governance metadata    | PostgreSQL ledger/audit/inbox/outbox; object storage for large evidence                                            | only versioned capability Jobs; never direct point, SHM, or register writes                     | blind retry after unknown physical result, arbitrary RPC catalog, stale preconditions, confirmation bypass        | phase 8                                                                        |
| Audit, Integration, and Delivery   | Trace actions and deliver data with `AuditEvent`, `Subscription`, `WebhookEndpoint`, `ExportJob`, `DeliveryAttempt`, and `DeadLetter`                                              | cloud owns its audit and delivery state; consumers own downstream processing                                        | Q: audit and delivery status. C: create subscription/webhook/export, redrive dead letter                      | PostgreSQL audit/outbox/delivery; object storage exports; broker only after evidence                               | consumes application events after CloudLink ingestion, never sockets directly                   | SSRF, weak webhook signatures, PII leak, duplicate delivery, audit split from business commit                     | audit metadata starts phase 1; durable integration phase 9                     |
| Operations and Cost Guardrails     | Observe fleet health, lag, versions, deployments, drift, quota, retention, and cost with `FleetHealthProjection`, `Backlog`, `VersionDistribution`, `Quota`, and `RetentionBudget` | each source fact keeps its authority; operational views are freshness-labelled projections; cloud owns quota policy | Q: health, lag, version, drift, cost. C: set quota, rate, and retention policy                                | PostgreSQL configuration/summary and analytics                                                                     | combines heartbeat, manifest, ingestion lag, deployment, and Job evidence                       | stale health presented as truth or quota causes silent loss                                                       | incremental; unified phase 9                                                   |
| Operational Observability          | Diagnose API, CloudLink, ingestion, database, worker, and delivery behavior with traces, low-cardinality metrics, and correlated structured logs                                   | each product context owns its facts; OpenTelemetry signals are sampled operational evidence only                    | no business command/query; composition roots configure no-op or OTLP adapters                                 | optional observability backend through OTLP; no transactional or audit role                                        | optional W3C Trace Context only; baggage is never authorization                                 | high-cardinality or secret leakage; exporter failure changes business result; trace mistaken for audit            | adapter foundation begins phase 2 and expands through phase 9                  |
| AI-native Contracts and MCP        | Let agents discover truth and safely call existing capabilities with `DocsManifest`, `CapabilityDefinition`, permission/error/event schemas, and golden paths                      | versioned repository contracts and application capability definitions are authoritative; AI output is not           | Q: docs, capability metadata, projections. C: MCP tools only proxy implemented application commands           | Git Markdown and manifest; runtime calls use normal audit persistence                                              | no alternate CloudLink or control path                                                          | planned feature presented as callable, tool omits risk/confirmation, agent bypasses authorization                 | documentation every phase; MCP phase 10                                        |
| Provider and Infrastructure Fusion | Place cloud workloads through existing Provider Adapter and infrastructure decisions                                                                                               | see ADR-0004                                                                                                        | outside this IoT capability expansion                                                                         | independent deployment-stack State                                                                                 | related only through placement and governed infrastructure Jobs                                 | IoT core gains a fixed vendor enum or global State                                                                | adjacent existing track                                                        |

## Cross-context dependencies

```text
Identity and Access -> authorization decisions
Fleet Identity -> CloudLink credential verification and session fencing
Runtime Catalog -> artifact compatibility and Job eligibility
Artifact Registry -> immutable deployment revision references
CloudLink adapter -> telemetry/deployment/Job application ingestion
All command contexts -> audit + transactional outbox
Outbox -> projections, notifications, webhooks, exports, and SSE/WebSocket
```

Contexts exchange deliberate contracts or events, not internal database rows.
Shared code is limited to stable identities, time, actor, correlation, and
capability-definition values.

## Governance, failure, and implementation supplement

The capability table above carries user value, aggregates, authority, use
cases, storage, edge interaction, risk, and phase. This supplement makes the
permission, command policy, offline result, and current executable layer
explicit. Exact names and layers are machine-readable in
[`ai/application-contracts.json`](../../ai/application-contracts.json).

| Context                   | Representative permission                                                           | Command risk / confirmation                          | Offline, retry, or failure result                                                   | Current status                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and Access       | `identity.grant.manage`                                                             | high / explicit                                      | authorization fails closed; credential rotation is idempotent                       | planned                                                                                                                                              |
| Fleet Identity            | `fleet.gateway.create`, `fleet.gateway.enrollment.issue`                            | low or high / none or explicit                       | expired token, invalid token, idempotency conflict, concurrent modification         | domain/application/memory enrollment foundation implemented; production surface planned                                                              |
| Fleet Runtime Catalog     | `fleet.runtime-manifest.report`, `fleet.runtime-manifest.read`                      | low / none                                           | old generation retained; checksum or generation conflict fails closed               | domain/application/memory manifest foundation implemented; production surface planned                                                                |
| CloudLink                 | `cloudlink.session.open`, `cloudlink.session.heartbeat`                             | low / none                                           | rejected version, fenced epoch, stale heartbeat, reconnect resume                   | domain/application/memory session foundation implemented; wire/root/durability planned                                                               |
| IoT Telemetry             | `telemetry.batch.ingest`, `telemetry.history.query`                                 | low / none                                           | duplicate returns receipt; conflict quarantines; gap requests replay                | partial: domain/application/memory inbox-history-outbox and OTel decorator implemented                                                               |
| Alarm Projection          | `alarm.fact.ingest`, `alarm.workflow.acknowledge`                                   | low / none                                           | duplicate fact is safe; gap/stale remain visible                                    | partial: domain/application/memory projection and workflow implemented                                                                               |
| Artifact Registry         | `artifact.revision.publish`, `artifact.revision.read`                               | high / explicit                                      | conflicting digest, revision/channel race, or signature failure                     | partial: domain/application/memory content-signature-metadata adapter implemented; production stores/API planned                                     |
| Deployment                | `deployment.rollout.start`, control, observation, and read                          | high / explicit for start/rollback                   | disconnect becomes unknown; late evidence reconciles; cancellation is intent        | partial: single-target domain/application/memory audit-outbox foundation implemented; target scheduler/wire/storage/API planned                      |
| Governed Jobs             | capability-specific plus `edge.job.create`                                          | declared per capability / explicit when required     | edge reject/expire, timeout unknown, late Receipt resolution                        | partial: domain/application/memory audit-outbox foundation implemented; production ledger/delivery/wire/API planned                                  |
| Audit and Integration     | `audit.event.read`, `integration.webhook.subscription.create`, `data.export.create` | high / explicit for subscription, export, or redrive | delivery retry, visible dead letter, idempotent redrive, immutable export reference | partial: audit HTTP/SSE plus domain/application/memory subscription, delivery, and export foundations; production durability/sending/workers planned |
| Operations                | `operations.read`, `operations.quota.manage`                                        | medium / explicit for quota reduction                | stale projection and quota rejection are explicit                                   | planned                                                                                                                                              |
| Operational Observability | deployment configuration only                                                       | not a product command                                | bounded signal loss; never changes business outcome                                 | optional adapter and telemetry decorator implemented; broader root instrumentation/deployment planned                                                |
| AI-native/MCP             | same permission as underlying use case                                              | same risk and confirmation as underlying command     | planned capability is rejected, never simulated                                     | partial: capability/Audit resources and Data Export/Job tool interface implemented; wire/root, production identity, and remaining exposure planned   |

Read [Architecture](architecture.md) for process and persistence boundaries,
[CloudLink and core state machines](cloudlink-and-core-state-machines.md) for
failure semantics, and the [delivery roadmap](../guides/iot-cloud-roadmap.md)
for executable slices.
