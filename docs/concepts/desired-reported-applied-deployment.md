---
title: Desired, Reported, and Applied deployment
description: Roll out immutable artifact intent without treating dispatch, connection, or timeout as edge application evidence
updated: 2026-07-14
status: mixed
---

# Desired, Reported, and Applied deployment

The cloud-side domain/application foundation and atomic memory adapter are
implemented for one Gateway target. They provide published-Artifact lookup,
lossless desired generations, distinct reported and applied facts,
pause/resume/cancel-request/rollback intent, authenticated edge observations,
unknown outcome, replay/conflict handling, Tenant-scoped query, audit evidence,
and outbox evidence.

This is not an end-to-end rollout. PostgreSQL, a production audit/outbox,
CloudLink outbound delivery and observation envelopes, target snapshots,
canary/batch scheduling, public HTTP, and the AetherIot counterpart remain
planned.

## Authority and facts

- AetherCloud owns desired revision and rollout intent.
- AetherIot owns its reported observation and final compatibility/policy
  decision.
- Applied exists only when edge evidence says applied or failed. A dispatch,
  download, validation, connected session, or HTTP success cannot create it.
- A network timeout creates a separate `unknown` reconciliation state. It does
  not fabricate an Applied fact. A later authenticated edge observation may
  resolve the projection.
- Artifact publication makes a revision eligible for Desired; it does not
  deploy or apply it.

The implemented view returns `reported: null` and `applied: null` until those
facts exist, rather than overloading a single status field.

## State and ordering

The single-target rollout state foundation is:

```text
running <-> paused -> cancel-requested
   |                     |
   +-- edge applied ----> completed
   +-- reject/fail -----> completed-with-failures
```

Rollback creates a newer Desired generation pointing at another immutable,
published Artifact Revision. It appends desired history; it does not edit the
prior generation or imply the edge restored anything.

Every edge observation has a stable identity and lossless Desired generation.
Exact replay is safe. Reuse of an observation identity with different content
conflicts. A fact for an older generation is retained in observation history
without rolling the current projection backward. A fact newer than the cloud's
known Desired generation fails closed.

Cancellation is a request to stop work that has not crossed the relevant edge
boundary. It cannot erase applied evidence or reverse a physical effect.

## Implemented application surface

- `deployment.rollout.start`: high risk, explicit confirmation, published
  Artifact precondition, expiry, idempotency, permission, and audit required.
- `deployment.rollout.pause`, `deployment.rollout.resume`, and
  `deployment.rollout.cancel-request`: governed rollout intent changes.
- `deployment.rollout.rollback`: high-risk new Desired generation with a
  published Artifact precondition.
- `deployment.rollout.mark-unknown`: records uncertain delivery/execution
  outcome without inferring failure or success.
- `deployment.observation.report`: active Gateway-credential scope and target
  binding, exact decoding, idempotency, and edge evidence projection.
- `deployment.rollout.get`: Tenant/Project-scoped query.

The memory repository atomically stores aggregate, idempotency, audit, and
outbox evidence and proves optimistic version conflicts. It is a conformance
adapter, not production durability.

## Planned expansion

Target snapshots, cohorts, canary/batch limits, pause gates, per-target partial
success, health policy, rollout scheduling, and large evidence storage build on
this single-target aggregate. Production CloudLink sends only versioned Desired
offers or immutable references through application-owned outbox records; it may
not write an edge cache, SHM, point, or device register.

Read [ADR-0010](../adr/0010-desired-reported-applied-deployment.md) for the
decision and [Artifact registry](artifact-registry.md) for publication
authority.
