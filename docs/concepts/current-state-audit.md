---
title: Current implementation audit
description: Distinguish executable AetherCloud layers, Broker evidence, and durable PostgreSQL CloudLink, telemetry, and Integration slices from missing production surfaces
updated: 2026-07-29
status: mixed
---

# Current implementation audit

This audit is evidence-based as of 2026-07-29. `Implemented` below always names
the executable layer. It does not imply a public API, durable production
adapter, or complete AetherEdge integration unless those layers are named.

## Repository baseline

The repository is on `main`. The pre-change HEAD for the current deployment
slice is `6d30ddd`; the earlier bootstrap baseline is `d698a97`. Existing tracked and untracked
workspace changes remain user-owned project state and are not permission to
reset, replace, or delete them.

The workspace uses Node.js 24, pnpm 11, TypeScript 5.9, ESM, strict type
checking, ESLint, Prettier, Vitest, an 80 percent coverage gate, and a Node test
suite for agent-documentation contracts. Evidence is in `package.json`,
`tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, and
`tests/ai-docs.test.mjs`.

The baseline `pnpm check` completed successfully with 114 Vitest tests and 8
documentation contract tests before this capability expansion began.

## Executable product layers

| Capability                                 | Executable evidence                                                                                                                                                                | Honest status                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Edge/cloud/provider authority values       | `packages/domain/src/authority.ts` and its tests                                                                                                                                   | Implemented domain value, not an authorization service                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Provider catalog and region discovery      | `packages/domain`, `packages/application/src/discover-provider-regions.ts`, provider conformance, and memory adapter                                                               | Domain/application/test-adapter implemented; real provider and HTTP planned                                                                                                                                                                                                                                                                                                                                                                                                          |
| Deployment Stack and governed Plan         | Domain/application Plan modules, infrastructure conformance, memory adapter, and `adapters/infrastructure/opentofu`                                                                | Real local OpenTofu Plan worker implemented; production remote State, durable encrypted artifacts, audit, and HTTP planned                                                                                                                                                                                                                                                                                                                                                           |
| Gateway registration and enrollment claim  | Gateway domain/application modules plus `adapters/fleet/memory` and `adapters/fleet/postgres`                                                                                      | Domain/application, memory conformance, PostgreSQL SQL/migration/driver adapter, atomic Gateway/Audit/Outbox registration, forced-RLS Fleet list/detail projection, Railway HTTP API, and console are implemented; enrollment-token HTTP, identity credentials, CA/KMS, and production CloudLink remain planned                                                                                                                                                                      |
| CloudLink session and heartbeat foundation | CloudLink domain/application modules plus `adapters/cloudlink/memory`, `adapters/cloudlink/postgres`, and `adapters/cloudlink/node-crypto`                                         | Credential-authenticated use cases, epoch fencing, cursor resume, v1alpha1 challenge issue/exact retry/atomic consume, fixed per-Gateway rate limits, Ed25519 challenge and hello transcripts, memory adapter, and transactional PostgreSQL session/challenge adapter with forced RLS are implemented; production database composition, atomic credential/key lifecycle, durable audit, and joint conformance remain planned                                                         |
| Experimental CloudLink MQTT ingress        | `adapters/cloudlink/mqtt`, `apps/cloudlink`, `contracts/cloudlink/v1`, and opt-in dual Broker test                                                                                 | Strict alpha.3 plus reviewed v1alpha1 challenge-request decoding, MQTT.js ingress, challenge/session publication, explicit trusted-connector resolution, real Mosquitto/AWS evidence, and alpha fault matrix are implemented. Gateway-signed business uplinks deliberately fail closed because per-uplink authentication is absent; production shared-Broker authentication, multi-sample mapping, durable data-loss persistence, session durability, and composition remain planned |
| Runtime Manifest and capability foundation | Runtime domain/application modules and `adapters/runtime/memory`                                                                                                                   | AetherEdge v1 checksum, monotonic history, report/query, memory adapter, and experimental MQTT mapping implemented; PostgreSQL/HTTP planned                                                                                                                                                                                                                                                                                                                                          |
| IoT telemetry ingestion and history        | Telemetry domain/application modules plus `adapters/telemetry/memory` and `adapters/telemetry/postgres`                                                                            | Atomic replay/gap/cursor/history semantics, PostgreSQL receipt/facts/Audit/integration-Outbox/exact-ACK transaction, leased delivery use case, forced RLS, and PostgreSQL 18 crash-boundary tests implemented; public HTTP, production composition, data-loss persistence, and analytics remain planned                                                                                                                                                                              |
| Home Assistant integration projection      | AetherContracts alpha.4 candidate schemas, AetherEdge connector/durable CloudLink publisher, AetherCloud application bridge, and memory/PostgreSQL Integration projection adapters | Provider-neutral multi-point topology, typed observations, Edge full resynchronization, independent durable streams, strict session replay, Runtime Manifest restoration, atomic PostgreSQL fact/inbox/receipt/history/audit/outbox/ACK persistence, and bounded catalog/by-ID application and optional MCP interfaces are implemented; published alpha.4 consumption, PostgreSQL session/manifest production composition, public API, and public Agent remain gated                 |
| Governed Home Assistant power control      | Integration Control domain/application, strict candidate codec, memory/PostgreSQL ledgers, Node.js Ed25519 adapter, `apps/cloudlink`, and optional `apps/mcp` adapters             | Default-off fixed power action, explicit read-only/control enablement, current-session MQTT offer/reoffer and signed receipt ingress, transactional PostgreSQL intent/offer/receipt/audit/cursor/ACK persistence with forced RLS, trusted-governance MCP tool, and bounded projection discovery/detail resources are implemented; production ledger composition, key lifecycle/Broker evidence, released cross-repository conformance, MCP wire root, and public Agent remain gated  |
| Alarm fact and workflow projection         | Alarm domain/application modules and `adapters/alarm/memory`                                                                                                                       | Edge-fact ordering and cloud acknowledgement implemented with memory projection; production persistence and wire planned                                                                                                                                                                                                                                                                                                                                                             |
| Operational OpenTelemetry foundation       | `adapters/observability/opentelemetry`                                                                                                                                             | No-op, in-memory, OTLP HTTP, bounded queue, W3C extraction, and ingestion decorator implemented; broad root wiring planned                                                                                                                                                                                                                                                                                                                                                           |
| Artifact Registry foundation               | Artifact domain/application modules and `adapters/artifacts/memory`                                                                                                                | Immutable lifecycle, digest/content/signature checks, channel conflict, query, and atomic memory audit/outbox implemented; production stores/HTTP planned                                                                                                                                                                                                                                                                                                                            |
| Desired/Reported/Applied deployment        | Edge deployment domain/application modules and `adapters/deployment/memory`                                                                                                        | Published-Artifact Desired intent, report/applied separation, pause/resume/cancel/rollback/unknown, query, and atomic memory audit/outbox implemented; scheduler/wire/PostgreSQL/HTTP planned                                                                                                                                                                                                                                                                                        |
| Governed capability Jobs and Receipts      | Governed Job domain/application modules and `adapters/jobs/memory`                                                                                                                 | Capability-gated creation, confirmation, queue/offer, unknown/cancel intent, ordered authenticated Receipts, query, and atomic memory audit/outbox implemented; delivery/wire/PostgreSQL/HTTP/MCP planned                                                                                                                                                                                                                                                                            |
| Audit search                               | Audit domain/application modules plus `adapters/audit/memory` and `adapters/audit/postgres`                                                                                        | Tenant/Project-scoped values, bounded cursor query, memory/PostgreSQL adapters, typed storage failure, forced-RLS transaction, and deployed Railway-to-Supabase read composition and Supabase ES256 JWT verification implemented; membership administration and live notification planned                                                                                                                                                                                            |
| Webhook subscriptions and delivery         | Integration domain/application modules and `adapters/integration/memory`                                                                                                           | Stable destination references, allowlists, bounded retry/dead-letter/redrive, and atomic memory evidence implemented; production sender, secrets, workers, and PostgreSQL planned                                                                                                                                                                                                                                                                                                    |
| Data export                                | Data Export domain/application modules and `adapters/integration/memory`                                                                                                           | Governed asynchronous request/outcome/query and immutable object-result metadata implemented; production object storage, worker, download, and PostgreSQL planned                                                                                                                                                                                                                                                                                                                    |
| MCP application interface                  | `apps/mcp/src/mcp-interface.ts` and behavior tests                                                                                                                                 | Capability/Audit resources, Data Export/Job tools, and optional trusted-governance Integration Control plus bounded projection catalog/by-ID adapters delegate to application use cases; MCP SDK transport/root, production identity, rate limiting, and public service composition remain planned                                                                                                                                                                                   |
| API process                                | `apps/api`, Railway configuration, and API behavior tests                                                                                                                          | Public health/platform plus authenticated Fleet list/detail/registration, Audit JSON, and finite SSE routes are implemented; production verifies Supabase ES256 JWTs through JWKS, trusts only administrator-controlled scope claims, permits only the exact AetherCloud console origin through credential-free CORS, and queries PostgreSQL through constrained verified-TLS connections; membership lifecycle remains planned                                                      |
| Agent documentation contract               | `llms.txt`, manifest, Skill, invariants, ADRs, and Node tests                                                                                                                      | Implemented repository interface                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

The infrastructure engine port is deliberately Plan-only. No executable Apply,
Destroy, Import, or State-repair operation exists.

The PostgreSQL Gateway, CloudLink session, telemetry, Integration projection,
and Integration Control adapters are real SQL/driver boundaries with scripted
transaction/migration tests and opt-in PostgreSQL 18 integration tests using a
constrained application role. The Integration Control test covers concurrent
deduplication, whole-transaction rollback, restart recovery, Tenant isolation,
and database constraints. A Supabase PostgreSQL 17 baseline and Railway API now provide deployed Audit
reads through a constrained role and verified TLS. This is not evidence of
complete production migration orchestration, write-route composition, worker
deployment, public Agent service, or backup/restore.

## Reviewed contracts without executable product surfaces

The following are designed or named in documentation but have no corresponding
domain/application implementation at this audit point:

- Tenant membership provisioning, role/ABAC administration, Service Accounts,
  API credentials, immediate session revocation checks, and IAM Audit writes;
  Supabase user JWT verification and fail-closed scope extraction are executable
- Site, Instance, Point metadata, groups, topology, and dynamic queries
- production Gateway credentials, revocation, recovery, CA/KMS, durable
  credential binding, database composition, and migration execution; the
  Gateway aggregate SQL adapter covers only registration and claim state
- production CloudLink process and PostgreSQL adapter composition,
  inbox/outbox ownership, backpressure, and actual edge integration; the
  transport-neutral session foundation, transactional PostgreSQL
  session/challenge/cursor adapter, experimental MQTT codec/bridge/ingress, and
  public alpha.3 fixture decoding plus the experimental v1alpha1
  challenge/hello handshake are executable. Credential and public-key status
  are not atomically locked with challenge consumption, and Gateway-signed
  business uplinks fail closed until per-uplink authentication exists.
  Production credential/key lifecycle, Broker ACL evidence, the full
  crash-durable gate, multi-sample batch indexing, data-loss persistence, and
  production process-crash wiring remain planned gates; the telemetry ACK
  transaction/worker and opt-in dual
  harness/fault suite are executable evidence
- PostgreSQL Runtime Manifest history, public fleet query, durable audit/outbox,
  and Instance/Point catalog; the bounded v1 report/query and experimental MQTT
  envelope are executable
- production Integration projection and Integration Control composition,
  offer/acknowledgement workers, public HTTP, MCP wire service, supported
  Broker qualification, and signing-key lifecycle; their PostgreSQL ledgers,
  bounded catalog/detail queries, and optional transport-neutral MCP adapters
  are executable
- production PostgreSQL telemetry composition and migrations, multi-instance
  ACK worker operation, multi-sample wire/application mapping, durable data-loss
  facts, downsampling, cold export, and public API; the PostgreSQL telemetry
  repository/ACK transaction and shared alpha.3 fixture execution are implemented
- PostgreSQL alarm facts/projection/workflow, CloudLink alarm wire adapter,
  assignment/comment/search, and public API
- PostgreSQL artifact metadata, production object storage/signature verifier,
  durable audit/outbox, upload API, deprecation/withdrawal commands, and HTTP;
  publication/query and memory-conformance foundations are executable
- PostgreSQL deployment ledger, target snapshots, canary/batch scheduler,
  CloudLink wire, public HTTP, durable audit/outbox, and AetherEdge counterpart;
  the single-target domain/application/memory foundation is executable
- PostgreSQL governed Job ledger/inbox, Runtime Manifest catalog provenance,
  CloudLink delivery, public HTTP and remaining MCP exposure, scheduling/expiry workers, large evidence
  storage, and the AetherEdge counterpart; the capability-gated
  domain/application/memory foundation is executable
- production Audit write-route composition, outbox/delivery/export adapters,
  destination registry and secrets, hardened webhook sender/signing/SSRF
  defence, retry and export workers, live SSE/WebSocket fan-out, object storage
  and authorized export download, quota, and MCP wire/composition root; current
  PostgreSQL-backed Audit JSON/finite SSE, transport-neutral MCP resources/tools,
  and integration memory foundations are executable
- Collector deployment and OpenTelemetry instrumentation beyond the implemented
  telemetry-ingestion decorator

The machine-readable [application contract catalog](../reference/application-contracts.md)
uses `partial` for executable inner layers that do not yet form a production
product surface.

## AetherEdge boundary evidence

AetherEdge has a stable runtime-manifest JSON Schema at
`contracts/runtime/runtime-manifest.v1.schema.json`, an acquisition-owned
`PointSample`/`PointQuality` model, and a local `DurableOutbox` with at-least-once
forwarding. Its SHM remains authoritative for live T/S values and its local
alarm stream remains authoritative for alarm facts.

AetherEdge also has a compatibility MQTT uplink and instance export endpoint.
Those payloads do not define AetherCloud CloudLink session epochs, per-stream
durable cursors, digest-conflict behavior, or cloud persistence acknowledgement.
The new AetherCloud JSON/MQTT implementation is an experimental consumer of the
public alpha.3 release. Therefore the existing legacy MQTT payloads remain
reference evidence and are not silently treated as CloudLink v1.

Both products pin and execute the complete public alpha.3 fixture manifest, and
the opt-in real Mosquitto harness records dual Edge/Cloud alpha fault evidence.
Authentication remains an experimental proposal and ACKs remain unsigned. A
crash-durable PostgreSQL ACK store/outbox exists for accepted telemetry, but the
full session/credential/loss-marker production path and composition do not.

## Material gaps and design corrections

The existing capability map correctly separated IoT platform work from
multi-cloud infrastructure, but it did not yet provide a dedicated IoT
telemetry contract, an operational-observability boundary, or a machine-readable
catalog for capability governance and implementation layers. ADR-0007 and
ADR-0008 add those decisions without changing the edge-first authority of
ADR-0001. ADR-0012 adds the durable audit/outbound transaction boundary after
the audit HTTP/SSE and integration state-machine foundations became executable.
ADR-0015 prevents CloudLink transport progress from bypassing shared-Broker
origin authentication, common bytes, fault injection, or crash durability.

Production exposure of any mutating use case still requires one transaction for
aggregate state, required audit, and outbox delivery. Memory adapters are
conformance tools and never satisfy that production durability gate.

## Verification evidence

The completed foundation was verified through 2026-07-29:

- Railway serves `https://api.aetheriot.dev`, with valid custom-domain TLS,
  successful liveness, and PostgreSQL Audit queries authenticated by a real
  Supabase Auth ES256 access token resolved through the hosted JWKS
- Railway has an explicit GitHub `main` deployment trigger for the API service;
  the repository-owned `railway.json` remains its deployment configuration
- one initial Supabase owner identity is provisioned with administrator-controlled
  Tenant, Project, role, and permission metadata; the independent
  `cloud.aetheriot.dev` console supports login, recovery, password change,
  effective-scope display, API status, and real Audit queries, while general
  membership administration remains manual
- Supabase PostgreSQL 17 has the ordered baseline migrations, forced RLS,
  non-owner/non-`BYPASSRLS` application role, pinned CA, and database SSL
  enforcement; ephemeral migration credentials are absent from the API service
- `pnpm check`: 815 Vitest behavior tests and 29 Node contract tests passed;
  TypeScript, ESLint, and Prettier checks passed
- `pnpm test:coverage`: 86.31% statements, 80.02% branches, 97.10% functions,
  and 87.59% lines
- `pnpm test:mqtt-integration`: the opt-in MQTT.js transport test exchanged an
  isolated QoS 1, non-retained message through Eclipse Mosquitto 2
- `pnpm test:postgres-integration`: the Gateway registration/claim, CloudLink
  session/challenge concurrency and RLS, telemetry commit/replay/crash-boundary,
  Integration projection, and five Integration Control
  concurrency/rollback/restart/RLS/constraint cases passed against PostgreSQL
  18 with a non-superuser, non-`BYPASSRLS` application role
- `pnpm test:cloudlink-alpha-harness`: the local Mosquitto/AetherEdge/AetherCloud
  dual-process ACK-loss, restart, replay, conflict, gap, expiry, partial-result,
  and data-loss matrix passed; its composition intentionally still reports no
  production crash-durable store
- `pnpm audit --prod`: no known production dependency vulnerabilities

These results cover executable inner layers and memory conformance adapters;
the PostgreSQL result covers Gateway Identity, CloudLink session/challenge,
accepted-telemetry ACK, Integration projection, and Integration Control ledger
slices. They are not evidence that other planned PostgreSQL adapters,
production composition, object-store integration, full CloudLink
authentication/durability, deployed workers, public MCP/Agent services, or a
complete Tenant membership and identity-administration lifecycle exist.
