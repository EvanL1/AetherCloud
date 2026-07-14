---
title: "ADR-0011: Governed capability Jobs and Receipts"
description: Admit only declared edge capabilities and preserve confirmation, uncertainty, cancellation, ordering, and edge outcomes as separate evidence
updated: 2026-07-14
status: normative
---

# ADR-0011: Governed capability Jobs and Receipts

## Status

Accepted on 2026-07-14. Domain transitions, application commands/queries,
active-Gateway Receipt binding, lossless ordering, and an atomic memory
audit/outbox adapter are implemented. Production persistence, Runtime Manifest
catalog wiring, CloudLink delivery, workers, HTTP/MCP exposure, large evidence,
and the AetherIot counterpart remain planned.

## Context

Diagnostics and eventual controlled work need more governance than a remote
method call. Wide-area timeout also cannot reveal whether work ran. Treating a
timeout as failure or blindly retrying a physical effect can duplicate an
action, while letting callers supply their own risk metadata defeats policy.

## Decision

1. Every edge operation is a Job for a versioned capability declaration. An
   undeclared capability is denied and there is no arbitrary RPC escape hatch.
2. The declaration is authoritative for permission, risk, confirmation,
   replay-safety, and physical-effect metadata. Creation requires the platform
   permission and the capability-specific permission.
3. Cloud authorization, confirmation, queueing, offering, uncertainty, and
   cancellation are cloud evidence. Edge accept/reject/expire/execute/result
   are authenticated Receipt evidence.
4. Cancellation is intent, not proof of cancellation. A late terminal Receipt
   remains authoritative.
5. Timeout is `unknown`. Unsafe or physical-effect work is never automatically
   reissued merely because delivery or execution timed out.
6. Receipt sequence is a lossless `uint64`. Out-of-order facts are retained but
   projection advances only over a contiguous sequence.
7. Exact Receipt replay is idempotent. Reuse of a Receipt identity or sequence
   with different content conflicts. Terminal execution results require an
   evidence digest.
8. Gateway credential verification supplies Tenant, Project, and Gateway
   scope. A Receipt cannot name a different target into existence.
9. Production persistence commits Job/Receipt, idempotency, audit, and outbox
   evidence atomically before acknowledgement or delivery progression.

## Alternatives considered

**Generic edge RPC** is flexible but cannot prove capability provenance,
governance, replay safety, or local rejection semantics.

**Caller-provided risk and confirmation** is easy to serialize but allows an
untrusted caller to downgrade policy.

**Timeout means failed** simplifies dashboards but can duplicate work that
already produced a physical effect.

**Discard out-of-order Receipts** makes the projection smaller but loses edge
facts during reconnect and prevents deterministic convergence.

## Security impact

Capabilities are deny by default. Every cloud command declares permission,
risk, confirmation, idempotency, expiry, and audit. Physical effect remains an
explicit declaration and never transfers final control from AetherIot.
Arguments and preconditions are represented by content digests in the current
foundation; raw secrets, device registers, SHM addresses, and evidence bytes do
not belong in audit or agent context.

## Compatibility and migration

No mutually implemented CloudLink Job schema exists. The current contracts use
stable identifiers, canonical decimal sequences, content digests, and explicit
state semantics so a reviewed versioned wire schema can be added without
claiming a mock is interoperable.

## Consequences

- operators can distinguish permission, confirmation, delivery, edge progress,
  uncertainty, cancellation intent, and final result;
- late and reordered Receipts converge without overwriting history;
- durable production completion requires an inbox, ledger, audit, and outbox;
- convenience retries must respect replay safety and preserve Job identity;
- AetherIot integration is required before any capability executes remotely.
