---
title: Unknown command outcome recovery
description: Resolve timed-out or ambiguous commands from authoritative evidence without blindly repeating physical effects
updated: 2026-07-18
status: partial
---

# Unknown command outcome recovery

Use this runbook when a governed Job, deployment command, or integration control
request was accepted or offered but no authoritative outcome arrived before its
deadline.

## Implemented today

- Governed Job and deployment state machines preserve `unknown` as a distinct
  outcome instead of rewriting timeout as success or failure.
- A late authenticated Receipt or edge observation remains evidence and may
  resolve uncertainty.
- Cancellation is recorded as intent and does not erase a late successful
  physical outcome.
- Memory foundations preserve command identity, idempotency, ordered Receipts,
  conflict detection, Audit, and Outbox semantics.

## Not implemented

Production PostgreSQL Job and deployment ledgers, CloudLink delivery,
schedulers, expiry workers, public command routes, complete MCP transport, and
the corresponding AetherEdge delivery path remain planned. A static document
cannot inspect the physical world or resolve an unknown outcome.

## Safe response

1. Preserve the original command identity, idempotency key, intent digest,
   capability declaration version, issue time, and expiry.
2. Query the existing Job or deployment projection and accept only authenticated
   edge evidence for the same identity.
3. Keep the result `unknown` while authoritative evidence is absent.
4. Never create a new command identity as an automatic retry for an unsafe or
   physical effect.
5. A cancellation request may stop work not yet accepted by the edge, but it is
   not evidence that already accepted work stopped.
6. If a later Receipt arrives, record it without deleting the earlier timeout
   and cancellation evidence.

## Escalate

Every unknown high-risk or non-replay-safe physical effect requires a human to
inspect edge evidence and, when necessary, the physical environment. The human
decides whether to retain the unknown state, request cancellation, or create a
new independently confirmed intent. An agent must never infer completion from
delivery, timeout, or disappearance of a connection.

Read [governed capability Jobs](../concepts/governed-capability-jobs.md),
[desired, reported, and applied deployment](../concepts/desired-reported-applied-deployment.md),
and [AI invariants](../../ai/invariants.md).
