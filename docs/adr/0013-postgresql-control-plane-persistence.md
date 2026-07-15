---
title: "ADR-0013: PostgreSQL control-plane persistence and multi-cloud cells"
description: Use PostgreSQL as the portable transactional authority while provider profiles place independent control-plane cells
updated: 2026-07-15
status: normative
---

# ADR-0013: PostgreSQL control-plane persistence and multi-cloud cells

## Status

Accepted on 2026-07-15. The first Gateway Identity PostgreSQL adapter,
migration, Node PostgreSQL pool boundary, transactional Audit/Outbox write, and
`managed-postgresql` provider capability are implemented. Production migration
execution, database credentials, backup/restore, provider-specific database
profiles, and PostgreSQL adapters for the remaining contexts are planned.

## Context

AetherCloud needs atomic enrollment, CloudLink cursor, Inbox, Outbox, Audit,
Deployment, and Job behavior. Those workloads require uniqueness, optimistic
concurrency, relational constraints, and transactions more than a universal
database abstraction. At the same time, AetherCloud can be deployed into many
clouds and must not make one provider's database product part of its domain.

IoT telemetry has a different growth curve. It initially benefits from the same
durable transaction boundary, but long-retention scans and high-volume
aggregation may eventually require a time-series or analytical adapter. Large
artifacts, raw batches, evidence, and exports are object data rather than
transactional rows.

Cross-cloud active-active writes add consensus latency and failure modes to the
durable acknowledgement path. Multi-cloud infrastructure management does not,
by itself, require one globally writable database.

## Decision

1. PostgreSQL is the first and default transactional persistence engine for an
   AetherCloud control-plane cell.
2. Domain and application modules depend on bounded-context repository ports,
   never a generic database port or PostgreSQL client.
3. A successful production command commits aggregate state, required Audit,
   and Outbox evidence in one PostgreSQL transaction.
4. Every Tenant-owned table and unique key includes `TenantId`. Application
   scope is mandatory and PostgreSQL Row-Level Security is defense in depth.
5. The portable migration baseline uses core PostgreSQL features. Optional
   extensions are declared provider-profile capabilities and cannot become
   hidden assumptions in repository contracts.
6. Provider Adapters may advertise the portable `managed-postgresql`
   capability. Provider-specific database profiles retain native engine
   variants, versions, HA, backup, encryption, private connectivity, extension,
   replica, region, sovereignty, RPO/RTO, and cost evidence.
7. One control-plane cell has one authoritative PostgreSQL writer topology. A
   Tenant has an explicit home cell. Cross-cloud backup, replica, disaster
   recovery, and Tenant migration are governed workflows, not implicit
   synchronous transactions.
8. Initial bounded telemetry history may use a PostgreSQL repository adapter.
   A time-series or analytical adapter is added only after measured ingestion,
   retention, scan latency, or cost evidence. ClickHouse and TimescaleDB are
   candidates, not current dependencies.
9. Object storage owns immutable artifacts, raw/cold batches, large evidence,
   and exports. Infrastructure State remains in each Deployment Stack's remote
   backend.
10. Kafka, Redis, and a globally distributed SQL database require separate
    measured need and an ADR. They are not implied by multi-cloud support.

## First executable slice

`adapters/fleet/postgres` implements the Gateway Identity repository against
parameterized PostgreSQL SQL. Each operation starts a transaction, sets
Tenant-scoped RLS context, performs an optimistic aggregate mutation, and writes
Audit and Outbox evidence before commit. A failure rolls back and maps to the
typed `gateway-storage-unavailable` application outcome.

The migration stores explicit enrollment columns and state-shape constraints;
it does not serialize the aggregate into an opaque JSON document. Raw
enrollment tokens are absent from aggregate, Audit, and Outbox records.

Default tests use a scripted PostgreSQL boundary and inspect the migration, so
they require no external database. An opt-in integration test also applies the
migration to PostgreSQL 18, uses a non-superuser/non-`BYPASSRLS` application
role, and runs the full registration/issue/claim flow. This proves application
and adapter behavior but does not claim that production credentials, migration
orchestration, backups, or a managed database deployment exist.

## Consequences

- AetherCloud remains portable across managed and self-hosted PostgreSQL while
  preserving provider-specific deployment features.
- Multi-cloud placement and database technology are separate decisions.
- RLS does not replace application authorization; a superuser or `BYPASSRLS`
  role must never be used by a normal composition root.
- A cell outage does not move write authority automatically. Failover requires
  explicit fencing and recovery evidence.
- Analytical telemetry can evolve independently without moving identity, Job,
  Audit, or Deployment authority out of PostgreSQL.
- The initial Gateway schema represents the implemented registration/claim
  lifecycle only. Credential activation, suspension, revocation, and recovery
  require additive migrations with their corresponding domain slices.
