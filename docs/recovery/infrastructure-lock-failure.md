---
title: Infrastructure lock failure recovery
description: Fail closed on missing or uncertain State-lock evidence and require a fresh Plan after operator recovery
updated: 2026-07-18
status: partial
---

# Infrastructure lock failure recovery

Use this runbook after State-lock acquisition times out, lock release cannot be
proved, or a Plan result lacks evidence for the exact Deployment Stack State
key.

## Implemented today

- The Plan-only infrastructure engine requires an acquired lease for the exact
  State key and successful release evidence.
- Lock timeout and lock-release failure are typed failures.
- A successful OpenTofu process exit is rejected when application-level lock
  evidence is absent or mismatched.
- The worker passes argv without a shell, bounds output, restricts temporary
  files, and removes its workspace on every outcome.

## Not implemented

Production remote State, a distributed lock adapter, durable lock ownership,
operator lock inspection, force-unlock, State repair, and a public Plan route
remain planned. The current port has no Apply, Destroy, Import, or State-repair
operation.

## Safe response

1. Record the Tenant, Project, provider connection, Deployment Stack, exact State
   key, Plan identity, lock holder evidence, and lease deadline.
2. Treat missing acquisition or release evidence as a failed Plan even when the
   infrastructure process exited successfully.
3. Never switch State keys, bypass locking, edit raw State, or expose saved Plan
   binaries or raw Plan JSON to an agent.
4. A bounded retry is permissible only for an acquisition timeout when the lock
   backend proves the existing lease remains valid and the request retains the
   same idempotency identity.
5. On release uncertainty, isolate the Deployment Stack from further Plan and
   future mutation until an operator verifies the authoritative backend.
6. After recovery, create a fresh Plan from a verified State snapshot. Do not
   reuse an artifact produced under uncertain locking.

## Escalate

Persistent acquisition timeout or any release failure requires an infrastructure
operator. Automatic force-unlock is forbidden. The operator must identify the
holder, backend, lease, and active worker before changing lock state; absent
that evidence, the Stack remains isolated.

Read [Plan infrastructure safely](../guides/plan-infrastructure.md),
[multi-cloud fusion](../concepts/multi-cloud-fusion.md), and
[AI invariants](../../ai/invariants.md).
