---
title: Governed capability Jobs
description: Request versioned edge capabilities without arbitrary RPC, unsafe retry, or cloud claims about physical outcomes
updated: 2026-07-14
status: mixed
---

# Governed capability Jobs

The transport-neutral domain/application foundation and atomic memory adapter
are implemented. An authorized Tenant actor can create work only for a declared
Gateway capability, inspect its governance metadata, confirm it when required,
queue and offer it, request cancellation, mark an ambiguous outcome unknown,
ingest authenticated edge Receipts, and query the resulting Job.

This is not an end-to-end remote execution product. PostgreSQL, production
audit/outbox, Runtime Manifest catalog wiring, CloudLink envelopes and mailbox,
large evidence storage, public HTTP, scheduling workers, and the AetherIot
counterpart remain planned.

## Authority and admission

- AetherCloud owns Job intent, Tenant authorization, confirmation evidence,
  expiry, and delivery policy.
- AetherIot owns capability acceptance, local precondition and safety checks,
  execution, and result facts.
- A declared capability is evidence of availability, not authorization. Job
  creation requires both `edge.job.create` and the declaration's permission.
- The capability declaration, rather than caller input, supplies risk,
  confirmation, replay safety, permission, and physical-effect metadata.
- An unknown or malformed capability fails closed. There is no generic method
  name or arbitrary RPC fallback.
- A physical-effect capability remains deny by default and the edge always
  retains its final decision.

The current memory catalog is a conformance fixture. Production eligibility
must consume a freshness-labelled Runtime Manifest projection and preserve the
exact declaration version used for admission.

## Lifecycle and uncertainty

```text
awaiting-confirmation -> authorized -> queued -> offered
                                      edge: accepted -> running -> terminal
                                                   \-> unknown
offered/running/unknown -> cancel-requested -> edge terminal Receipt
```

`succeeded`, `failed`, `partial`, `rejected`, `expired`, and `canceled` are
terminal edge Receipt outcomes. Cloud-side expiry before edge acceptance does
not fabricate a Receipt. Cancellation records intent; a later `succeeded`
Receipt remains authoritative if the effect already occurred.

After a network timeout the Job becomes `unknown`. In particular, an unsafe or
physical-effect Job is not automatically retried under a new identity. A late
authenticated Receipt may resolve uncertainty without erasing the earlier
timeout or cancellation evidence.

## Receipt ordering and idempotency

Receipt identity and sequence are independent replay guards. Sequence is a
lossless canonical `uint64` decimal string. Exact replay returns the existing
fact. Reusing an identity or sequence with different content fails closed.

An out-of-order Receipt is retained as `pending-predecessor`; it does not move
the projection. Filling the gap applies all newly contiguous Receipts in order.
Execution terminal Receipts require an evidence digest. Large evidence bytes
will live in object storage; the Job ledger stores only governed references and
digests.

## Implemented application surface

- `edge.job.create`: validates exact external input, the command time window,
  Tenant scope, platform permission, and capability permission.
- `edge.job.confirm`: high risk and explicitly confirmed.
- `edge.job.queue` and `edge.job.offer`: dispatch controls with independent
  command metadata.
- `edge.job.mark-unknown` and `edge.job.cancel-request`: record cloud knowledge
  and intent without claiming an edge result.
- `edge.job.receipt.ingest`: derives Tenant, Project, and Gateway from an active
  credential and enforces target binding.
- `edge.job.get`: Tenant/Project-scoped query exposing governance before state.

The memory adapter atomically stores Job state, idempotency, required audit
evidence, and an outbox record. It proves behavior without an external service;
it does not satisfy production durability.

## Planned production completion

Production work adds a PostgreSQL ledger and Receipt inbox, a transactionally
coupled outbox/audit chain, Runtime Manifest declaration provenance,
application-owned CloudLink delivery, evidence objects, scheduling and expiry
workers, public interfaces, and a reviewed AetherIot contract. Acknowledgement
to the edge occurs only after durable Receipt acceptance.

Read [ADR-0011](../adr/0011-governed-capability-jobs.md) for the decision and
[CloudLink and core state machines](cloudlink-and-core-state-machines.md) for
transport-independent failure semantics.
