---
title: Current implementation audit
description: Distinguish executable AetherCloud layers, Broker evidence, and the PostgreSQL telemetry ACK slice from missing production surfaces
updated: 2026-07-16
status: mixed
---

# Current implementation audit

This audit is evidence-based as of 2026-07-16. `Implemented` below always names
the executable layer. It does not imply a public API, durable production
adapter, or complete AetherIot integration unless those layers are named.

## Repository baseline

The repository is on `main`. The pre-change HEAD for this audit is `d731ecb`;
the earlier bootstrap baseline is `d698a97`. Existing tracked and untracked
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

| Capability                                 | Executable evidence                                                                                                  | Honest status                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge/cloud/provider authority values       | `packages/domain/src/authority.ts` and its tests                                                                     | Implemented domain value, not an authorization service                                                                                                                                                                                                                                                                                                  |
| Provider catalog and region discovery      | `packages/domain`, `packages/application/src/discover-provider-regions.ts`, provider conformance, and memory adapter | Domain/application/test-adapter implemented; real provider and HTTP planned                                                                                                                                                                                                                                                                             |
| Deployment Stack and governed Plan         | Domain/application Plan modules, infrastructure conformance, memory adapter, and `adapters/infrastructure/opentofu`  | Real local OpenTofu Plan worker implemented; production remote State, durable encrypted artifacts, audit, and HTTP planned                                                                                                                                                                                                                              |
| Gateway registration and enrollment claim  | Gateway domain/application modules plus `adapters/fleet/memory` and `adapters/fleet/postgres`                        | Domain/application, memory conformance, PostgreSQL SQL/migration/driver adapter, and atomic Gateway/Audit/Outbox write implemented; production DB composition, identity binding, CA/KMS, and HTTP planned                                                                                                                                               |
| CloudLink session and heartbeat foundation | CloudLink domain/application modules and `adapters/cloudlink/memory`                                                 | Credential-authenticated use cases, epoch fencing, cursor resume, and memory adapter implemented; PostgreSQL planned                                                                                                                                                                                                                                    |
| Experimental CloudLink MQTT ingress        | `adapters/cloudlink/mqtt`, `apps/cloudlink`, `contracts/cloudlink/v1`, and opt-in dual Broker test                   | Strict alpha.3 codec and failure classes, MQTT.js ingress, application bridge, real Mosquitto/AWS evidence, and alpha fault matrix implemented; bridge accepts an exact persisted telemetry ACK, while production shared-Broker authentication, multi-sample mapping, durable data-loss persistence, session durability, and composition remain planned |
| Runtime Manifest and capability foundation | Runtime domain/application modules and `adapters/runtime/memory`                                                     | AetherIot v1 checksum, monotonic history, report/query, memory adapter, and experimental MQTT mapping implemented; PostgreSQL/HTTP planned                                                                                                                                                                                                              |
| IoT telemetry ingestion and history        | Telemetry domain/application modules plus `adapters/telemetry/memory` and `adapters/telemetry/postgres`              | Atomic replay/gap/cursor/history semantics, PostgreSQL receipt/facts/Audit/integration-Outbox/exact-ACK transaction, leased delivery use case, forced RLS, and PostgreSQL 18 crash-boundary tests implemented; public HTTP, production composition, data-loss persistence, and analytics remain planned                                                 |
| Alarm fact and workflow projection         | Alarm domain/application modules and `adapters/alarm/memory`                                                         | Edge-fact ordering and cloud acknowledgement implemented with memory projection; production persistence and wire planned                                                                                                                                                                                                                                |
| Operational OpenTelemetry foundation       | `adapters/observability/opentelemetry`                                                                               | No-op, in-memory, OTLP HTTP, bounded queue, W3C extraction, and ingestion decorator implemented; broad root wiring planned                                                                                                                                                                                                                              |
| Artifact Registry foundation               | Artifact domain/application modules and `adapters/artifacts/memory`                                                  | Immutable lifecycle, digest/content/signature checks, channel conflict, query, and atomic memory audit/outbox implemented; production stores/HTTP planned                                                                                                                                                                                               |
| Desired/Reported/Applied deployment        | Edge deployment domain/application modules and `adapters/deployment/memory`                                          | Published-Artifact Desired intent, report/applied separation, pause/resume/cancel/rollback/unknown, query, and atomic memory audit/outbox implemented; scheduler/wire/PostgreSQL/HTTP planned                                                                                                                                                           |
| Governed capability Jobs and Receipts      | Governed Job domain/application modules and `adapters/jobs/memory`                                                   | Capability-gated creation, confirmation, queue/offer, unknown/cancel intent, ordered authenticated Receipts, query, and atomic memory audit/outbox implemented; delivery/wire/PostgreSQL/HTTP/MCP planned                                                                                                                                               |
| Audit search                               | Audit domain/application modules and `adapters/audit/memory`                                                         | Tenant/Project-scoped append-only values, bounded cursor query, and memory adapter implemented; PostgreSQL durability planned                                                                                                                                                                                                                           |
| Webhook subscriptions and delivery         | Integration domain/application modules and `adapters/integration/memory`                                             | Stable destination references, allowlists, bounded retry/dead-letter/redrive, and atomic memory evidence implemented; production sender, secrets, workers, and PostgreSQL planned                                                                                                                                                                       |
| Data export                                | Data Export domain/application modules and `adapters/integration/memory`                                             | Governed asynchronous request/outcome/query and immutable object-result metadata implemented; production object storage, worker, download, and PostgreSQL planned                                                                                                                                                                                       |
| MCP application interface                  | `apps/mcp/src/mcp-interface.ts` and behavior tests                                                                   | Capability/Audit resources plus Data Export and Job tools delegate to application use cases with full governance metadata; MCP SDK transport/root, production identity, rate limit, and persistence planned                                                                                                                                             |
| API process                                | `apps/api/src/app.ts` and `apps/api/test/app.test.ts`                                                                | Public health/platform plus authenticated audit JSON and finite resumable SSE snapshot routes implemented; production identity and durable audit adapter planned                                                                                                                                                                                        |
| Agent documentation contract               | `llms.txt`, manifest, Skill, invariants, ADRs, and Node tests                                                        | Implemented repository interface                                                                                                                                                                                                                                                                                                                        |

The infrastructure engine port is deliberately Plan-only. No executable Apply,
Destroy, Import, or State-repair operation exists.

The PostgreSQL Gateway and telemetry adapters are real SQL/driver boundaries
with scripted transaction/migration tests and opt-in PostgreSQL 18 integration
tests using a constrained application role. The telemetry test proves no ACK
before commit and identical ACK recovery after an uncertain commit. This is not
evidence of a running managed database, production migration orchestration,
credentials, worker deployment, or backup/restore.

## Reviewed contracts without executable product surfaces

The following are designed or named in documentation but have no corresponding
domain/application implementation at this audit point:

- Tenant/User/Service Account IAM, RBAC/ABAC, API credentials, and durable audit
- Site, Instance, Point metadata, groups, topology, and dynamic queries
- production Gateway credentials, revocation, recovery, CA/KMS, durable
  credential binding, database composition, and migration execution; the
  Gateway aggregate SQL adapter covers only registration and claim state
- production CloudLink process configuration, PostgreSQL
  session/inbox/outbox/cursor, multi-instance ownership, backpressure, and actual
  edge integration; the transport-neutral session foundation and experimental
  MQTT codec/bridge/ingress and public alpha.3 fixture decoding are
  executable, while production credential lifecycle and Broker ACL evidence,
  full crash-durable gate, multi-sample batch indexing, data-loss persistence,
  and production process-crash wiring remain planned gates; the telemetry ACK
  transaction/worker and opt-in dual harness/fault suite are executable evidence
- PostgreSQL Runtime Manifest history, public fleet query, durable audit/outbox,
  and Instance/Point catalog; the bounded v1 report/query and experimental MQTT
  envelope are executable
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
  CloudLink wire, public HTTP, durable audit/outbox, and AetherIot counterpart;
  the single-target domain/application/memory foundation is executable
- PostgreSQL governed Job ledger/inbox, Runtime Manifest catalog provenance,
  CloudLink delivery, public HTTP and remaining MCP exposure, scheduling/expiry workers, large evidence
  storage, and the AetherIot counterpart; the capability-gated
  domain/application/memory foundation is executable
- PostgreSQL audit/outbox/delivery/export adapters, destination registry and
  secrets, hardened webhook sender/signing/SSRF defence, retry and export
  workers, live SSE/WebSocket fan-out, object storage and authorized export
  download, quota, and MCP wire/composition root; current audit JSON/finite SSE,
  transport-neutral MCP resources/tools, and integration memory foundations are
  executable
- Collector deployment and OpenTelemetry instrumentation beyond the implemented
  telemetry-ingestion decorator

The machine-readable [application contract catalog](../reference/application-contracts.md)
uses `partial` for executable inner layers that do not yet form a production
product surface.

## AetherIot boundary evidence

AetherIot has a stable runtime-manifest JSON Schema at
`contracts/runtime/runtime-manifest.v1.schema.json`, an acquisition-owned
`PointSample`/`PointQuality` model, and a local `DurableOutbox` with at-least-once
forwarding. Its SHM remains authoritative for live T/S values and its local
alarm stream remains authoritative for alarm facts.

AetherIot also has a compatibility MQTT uplink and instance export endpoint.
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

The completed foundation was verified on 2026-07-16 with the repository's
default external-service-free path:

- `pnpm check`: 443 Vitest behavior tests and 18 Node contract
  tests passed; TypeScript, ESLint, and Prettier checks passed
- `pnpm test:coverage`: 87.40% statements, 80.42% branches, 96.86% functions,
  and 88.97% lines
- `pnpm test:mqtt-integration`: the opt-in MQTT.js transport test exchanged an
  isolated QoS 1, non-retained message through Eclipse Mosquitto 2
- `pnpm test:postgres-integration`: the Gateway registration/claim flow and the
  telemetry commit/replay/crash-boundary cases passed against PostgreSQL 18 with
  a non-superuser, non-`BYPASSRLS` application role
- `pnpm test:cloudlink-alpha-harness`: the local Mosquitto/AetherIot/AetherCloud
  dual-process ACK-loss, restart, replay, conflict, gap, expiry, partial-result,
  and data-loss matrix passed; its composition intentionally still reports no
  production crash-durable store
- `pnpm audit --prod`: no known production dependency vulnerabilities

These results cover executable inner layers and memory conformance adapters;
the PostgreSQL result covers the Gateway Identity and accepted-telemetry ACK
slices. They are not evidence that other planned PostgreSQL adapters,
object-store integration, full production CloudLink authentication/durability,
deployed workers, or production identity integration exist.
