---
title: "ADR-0010: Desired, reported, and applied deployment"
description: Preserve cloud intent, edge observations, applied evidence, unknown outcomes, and cancellation as separate facts
updated: 2026-07-14
status: normative
---

# ADR-0010: Desired, reported, and applied deployment

## Status

Accepted on 2026-07-14. Domain transitions, application use cases, published
artifact gating, Gateway-authenticated observation ingestion, Tenant query,
and an atomic memory adapter are implemented. CloudLink wire, PostgreSQL,
workers, batching, public interfaces, and the AetherIot application counterpart
remain planned.

## Context

Wide-area delivery is asynchronous and ambiguous. A cloud can know what it
requested, while only the edge can know what it accepted and applied under
local compatibility and safety policy. Treating dispatch, download, or timeout
as Applied would create false operational and safety claims.

## Decision

1. Desired is a cloud-owned immutable revision reference and monotonic uint64
   generation.
2. Reported and Applied are separate edge-owned facts. Reported progress never
   automatically becomes Applied.
3. Every desired generation remains history. Rollback is a new desired
   generation pointing to a prior immutable revision, not mutation of history.
4. Edge observation identity is replay-safe. Exact replay succeeds; conflicting
   reuse fails closed. Late generations are retained without rolling the
   current projection backward.
5. Network timeout may produce `unknown`. It cannot be normalized to failed or
   succeeded, and later edge evidence may resolve it.
6. Pause, resume, and cancel-request govern remaining cloud intent. Cancellation
   does not claim to undo accepted or applied work.
7. Start and rollback require a published, non-withdrawn artifact revision.
8. Observation scope and Gateway target derive from an active credential.
9. A production transaction atomically persists aggregate/history,
   idempotency, required audit, and outbox evidence.

## Alternatives considered

**One deployment status field** is simpler but loses authority and cannot
represent Desired/Reported divergence or an ambiguous timeout.

**Treat timeout as failed** makes retry dashboards convenient but risks
duplicating an effect that actually occurred.

**Mutate Desired during rollback** loses the original operator intent and makes
late receipts impossible to reconcile.

**Clear Applied on every new Desired generation** hides the true currently
applied evidence. The prior fact must remain visible as drift.

## Security impact

Tenant commands carry permission, risk, confirmation policy, idempotency,
expiry, and audit metadata. Edge facts require active credential verification.
Artifact eligibility is checked through an application-owned contract. Raw
credentials and arbitrary evidence payloads are excluded; large evidence will
use governed object references.

## Compatibility and migration

There is no mutually implemented CloudLink deployment wire contract. The
cloud-side contracts use lossless decimal generations and exact immutable
revision IDs so a future versioned counterpart can be added without pretending
current mocks are end to end.

## Consequences

- operators can distinguish intent, edge progress, applied proof, drift, and
  uncertainty;
- late evidence remains useful after reconnect;
- reconciliation requires durable history and idempotency indexes;
- cloud cancellation has deliberately limited semantics;
- production completion depends on an AetherIot counterpart.
