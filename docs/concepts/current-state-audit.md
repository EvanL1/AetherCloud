---
title: Current implementation audit
description: Distinguish executable AetherCloud layers from reviewed contracts and missing production surfaces
updated: 2026-07-15
status: mixed
---

# Current implementation audit

This audit is evidence-based as of 2026-07-15. `Implemented` below always names
the executable layer. It does not imply a public API, durable production
adapter, or complete AetherIot integration unless those layers are named.

## Repository baseline

The repository is on `main`, with the bootstrap baseline recorded at commit
`d698a97`. Existing tracked and untracked workspace changes remain user-owned
project state and are not permission to reset, replace, or delete them.

The workspace uses Node.js 24, pnpm 11, TypeScript 5.9, ESM, strict type
checking, ESLint, Prettier, Vitest, an 80 percent coverage gate, and a Node test
suite for agent-documentation contracts. Evidence is in `package.json`,
`tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, and
`tests/ai-docs.test.mjs`.

The baseline `pnpm check` completed successfully with 114 Vitest tests and 8
documentation contract tests before this capability expansion began.

## Executable product layers

| Capability                                 | Executable evidence                                                                                                  | Honest status                                                                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge/cloud/provider authority values       | `packages/domain/src/authority.ts` and its tests                                                                     | Implemented domain value, not an authorization service                                                                                                                                                      |
| Provider catalog and region discovery      | `packages/domain`, `packages/application/src/discover-provider-regions.ts`, provider conformance, and memory adapter | Domain/application/test-adapter implemented; real provider and HTTP planned                                                                                                                                 |
| Deployment Stack and governed Plan         | Domain/application Plan modules, infrastructure conformance, memory adapter, and `adapters/infrastructure/opentofu`  | Real local OpenTofu Plan worker implemented; production remote State, durable encrypted artifacts, audit, and HTTP planned                                                                                  |
| Gateway registration and enrollment claim  | Gateway domain/application modules plus `adapters/fleet/memory` and `adapters/fleet/postgres`                        | Domain/application, memory conformance, PostgreSQL SQL/migration/driver adapter, and atomic Gateway/Audit/Outbox write implemented; production DB composition, identity binding, CA/KMS, and HTTP planned   |
| CloudLink session and heartbeat foundation | CloudLink domain/application modules and `adapters/cloudlink/memory`                                                 | Credential-authenticated use cases, epoch fencing, cursor resume, and memory adapter implemented; wire/root/PostgreSQL planned                                                                              |
| Runtime Manifest and capability foundation | Runtime domain/application modules and `adapters/runtime/memory`                                                     | AetherIot v1 checksum, monotonic history, report/query, and memory adapter implemented; wire/PostgreSQL/HTTP planned                                                                                        |
| IoT telemetry ingestion and history        | Telemetry domain/application modules and `adapters/telemetry/memory`                                                 | Atomic replay/gap/cursor/history semantics implemented with a memory conformance adapter; production durability and wire planned                                                                            |
| Alarm fact and workflow projection         | Alarm domain/application modules and `adapters/alarm/memory`                                                         | Edge-fact ordering and cloud acknowledgement implemented with memory projection; production persistence and wire planned                                                                                    |
| Operational OpenTelemetry foundation       | `adapters/observability/opentelemetry`                                                                               | No-op, in-memory, OTLP HTTP, bounded queue, W3C extraction, and ingestion decorator implemented; broad root wiring planned                                                                                  |
| Artifact Registry foundation               | Artifact domain/application modules and `adapters/artifacts/memory`                                                  | Immutable lifecycle, digest/content/signature checks, channel conflict, query, and atomic memory audit/outbox implemented; production stores/HTTP planned                                                   |
| Desired/Reported/Applied deployment        | Edge deployment domain/application modules and `adapters/deployment/memory`                                          | Published-Artifact Desired intent, report/applied separation, pause/resume/cancel/rollback/unknown, query, and atomic memory audit/outbox implemented; scheduler/wire/PostgreSQL/HTTP planned               |
| Governed capability Jobs and Receipts      | Governed Job domain/application modules and `adapters/jobs/memory`                                                   | Capability-gated creation, confirmation, queue/offer, unknown/cancel intent, ordered authenticated Receipts, query, and atomic memory audit/outbox implemented; delivery/wire/PostgreSQL/HTTP/MCP planned   |
| Audit search                               | Audit domain/application modules and `adapters/audit/memory`                                                         | Tenant/Project-scoped append-only values, bounded cursor query, and memory adapter implemented; PostgreSQL durability planned                                                                               |
| Webhook subscriptions and delivery         | Integration domain/application modules and `adapters/integration/memory`                                             | Stable destination references, allowlists, bounded retry/dead-letter/redrive, and atomic memory evidence implemented; production sender, secrets, workers, and PostgreSQL planned                           |
| Data export                                | Data Export domain/application modules and `adapters/integration/memory`                                             | Governed asynchronous request/outcome/query and immutable object-result metadata implemented; production object storage, worker, download, and PostgreSQL planned                                           |
| MCP application interface                  | `apps/mcp/src/mcp-interface.ts` and behavior tests                                                                   | Capability/Audit resources plus Data Export and Job tools delegate to application use cases with full governance metadata; MCP SDK transport/root, production identity, rate limit, and persistence planned |
| API process                                | `apps/api/src/app.ts` and `apps/api/test/app.test.ts`                                                                | Public health/platform plus authenticated audit JSON and finite resumable SSE snapshot routes implemented; production identity and durable audit adapter planned                                            |
| Agent documentation contract               | `llms.txt`, manifest, Skill, invariants, ADRs, and Node tests                                                        | Implemented repository interface                                                                                                                                                                            |

The infrastructure engine port is deliberately Plan-only. No executable Apply,
Destroy, Import, or State-repair operation exists.

The PostgreSQL Gateway adapter is a real SQL/driver boundary with scripted
transaction/migration tests and an opt-in PostgreSQL 18 integration test using
a constrained application role. It is not evidence of a running managed
database, production migration orchestration, credentials, or backup/restore.

## Reviewed contracts without executable product surfaces

The following are designed or named in documentation but have no corresponding
domain/application implementation at this audit point:

- Tenant/User/Service Account IAM, RBAC/ABAC, API credentials, and durable audit
- Site, Instance, Point metadata, groups, topology, and dynamic queries
- production Gateway credentials, revocation, recovery, CA/KMS, durable
  credential binding, database composition, and migration execution; the
  Gateway aggregate SQL adapter covers only registration and claim state
- CloudLink process, wire schema, PostgreSQL session/inbox/outbox/cursor,
  production backpressure, and actual edge integration; the transport-neutral
  session, heartbeat, fencing, and memory resume foundation is executable
- PostgreSQL Runtime Manifest history, public fleet query, CloudLink manifest
  envelope, durable audit/outbox, and Instance/Point catalog; the bounded v1
  report/query foundation is executable
- PostgreSQL telemetry inbox/history/cursor, production durable acknowledgement,
  CloudLink telemetry wire adapter, downsampling, cold export, and public API
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
No mutually implemented AetherCloud CloudLink wire schema was found. Therefore
the existing MQTT payloads are reference evidence, not a CloudLink v1 contract.

## Material gaps and design corrections

The existing capability map correctly separated IoT platform work from
multi-cloud infrastructure, but it did not yet provide a dedicated IoT
telemetry contract, an operational-observability boundary, or a machine-readable
catalog for capability governance and implementation layers. ADR-0007 and
ADR-0008 add those decisions without changing the edge-first authority of
ADR-0001. ADR-0012 adds the durable audit/outbound transaction boundary after
the audit HTTP/SSE and integration state-machine foundations became executable.

Production exposure of any mutating use case still requires one transaction for
aggregate state, required audit, and outbox delivery. Memory adapters are
conformance tools and never satisfy that production durability gate.

## Verification evidence

The completed foundation was verified on 2026-07-15 with the repository's
default external-service-free path:

- `pnpm check`: 365 Vitest behavior tests and 13 agent-documentation contract
  tests passed; TypeScript, ESLint, and Prettier checks passed
- `pnpm test:coverage`: 87.6% statements, 80.17% branches, 97.27% functions,
  and 89.27% lines
- `pnpm test:postgres-integration`: the Gateway migration and
  register/issue/claim transaction passed against PostgreSQL 18 with a
  non-superuser, non-`BYPASSRLS` application role
- `pnpm audit --prod`: no known production dependency vulnerabilities

These results cover executable inner layers and memory conformance adapters;
the PostgreSQL result covers only the Gateway Identity slice. They are not
evidence that other planned PostgreSQL adapters, object-store integration,
CloudLink wire, workers, or production identity integration exist.
