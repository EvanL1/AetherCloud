---
title: Database backup and restore recovery
description: Plan a controlled PostgreSQL cell restore without inventing production backup automation or cross-cell authority
updated: 2026-07-18
status: planned
---

# Database backup and restore recovery

Use this runbook to reason about restoring one AetherCloud PostgreSQL control
plane cell. It deliberately provides safety requirements rather than database
commands because AetherCloud has no production backup or restore capability.

## Implemented today

- Gateway, CloudLink session, telemetry, Integration projection, and Integration
  Control have PostgreSQL adapter or migration foundations.
- Relevant integration tests exercise transactions, Tenant row-level security,
  rollback, uncertain commit recovery, and selected restart behavior.
- One independently placed cell is the transactional authority for the data it
  owns.

These facts prove adapter behavior, not that a backup exists or is restorable.

## Not implemented

Production database composition, migration orchestration, backup scheduling,
encrypted backup retention, restore verification, recovery-point and
recovery-time objectives, failover, and governed Tenant migration remain
planned. `infrastructure.stack.plan` cannot apply or restore a database.

## Safe response

1. Identify the exact Tenant, cell, provider connection, database version,
   schema version, backup identity, encryption authority, and restore point.
2. Fence the previous writer before any restored copy can become authoritative.
3. Restore first into an isolated target using the approved provider or database
   procedure outside AetherCloud.
4. Verify migrations, constraints, forced row-level security, Audit/Outbox
   continuity, replay identities, cursors, and pending deliveries.
5. Reconcile edge sessions and projections before admitting new writes.
6. Promote only one write authority. A cross-cloud copy never becomes authority
   merely because it is reachable or newer.

## Escalate

Every restore, failover, point-in-time rollback, or operation that may discard
committed evidence requires a database and security operator. Do not make a
restored database writable when the old writer has not been conclusively
fenced, the backup identity is unverified, or Tenant isolation has not passed.

Read [PostgreSQL persistence and multi-cloud cells](../concepts/persistence-and-multi-cloud-cells.md),
the [current implementation audit](../concepts/current-state-audit.md), and the
[operational observability model](../concepts/operational-observability.md).
