---
title: "ADR-0009: Immutable artifact publication"
description: Separate content-addressed revisions, governed release channels, deployment intent, and edge application evidence
updated: 2026-07-14
status: normative
---

# ADR-0009: Immutable artifact publication

## Status

Accepted on 2026-07-14. The publication state machine, publish/get application
use cases, content/signature/repository ports, and atomic memory conformance
adapter are implemented. Production object storage, PostgreSQL, signer/KMS,
public interfaces, and the AetherIot delivery counterpart remain planned.

## Context

AetherCloud must distribute Packs, configurations, models, rules, and
applications without allowing mutable bytes or metadata to change beneath a
desired-state reference. A release name is useful to operators, but treating a
channel as content identity would make rollback and audit ambiguous. Likewise,
cloud publication cannot prove that an edge downloaded, accepted, or applied a
revision.

## Decision

1. An artifact revision is identified independently from its artifact and has
   an immutable content digest, length, compatibility declaration,
   dependencies, signature metadata, and revision number.
2. Protocol-sized revision numbers and content lengths use canonical uint64
   decimal strings at JSON boundaries.
3. Publication follows `draft -> validated -> published`; a published revision
   may become `deprecated` or `withdrawn`, but is never rewritten or deleted to
   correct content.
4. Content verification and signature verification are application-owned
   ports. Publication fails closed before metadata persistence when either
   verification fails or is unavailable.
5. A release channel is a separately governed reference. The publication
   command cannot silently overwrite an occupied channel; a future explicit
   channel-move command needs its own permission, confirmation, idempotency,
   audit, and concurrency policy.
6. The production publication transaction owns revision metadata, channel
   reference, idempotency evidence, audit, and outbox evidence atomically.
   Immutable bytes live in object storage by digest.
7. Publication is high risk and requires Tenant/Project authorization,
   explicit confirmation, expiry, an idempotency key, and durable audit.
8. `published` means cloud publication only. Desired, reported, applied, and
   edge compatibility evidence remain separate facts.

## Alternatives considered

**Mutable artifact versions** simplify corrections but invalidate approvals,
signatures, rollback targets, and forensic evidence.

**Store large content in PostgreSQL** offers one transaction but couples the
metadata ledger to large immutable blobs and their retention/serving profile.

**Automatically move a channel on every publication** is convenient but makes
concurrent releases overwrite operator intent. A separate compare-and-set
operation is safer.

**Treat signature metadata as proof without verification** preserves metadata
but does not establish trust. The application verifies before publication.

## Security impact

External metadata is exactly decoded and bounded. Digest, content length,
signature algorithm and signer key identity are explicit. Raw artifact bytes,
private keys, credentials, and arbitrary validation output do not enter audit,
errors, traces, or prompts. Cross-Tenant lookup is hidden. Production adapters
must preserve atomic audit/outbox and content immutability.

## Compatibility and migration

There is no mutually implemented AetherCloud/AetherIot artifact wire contract
yet. Future delivery references the exact revision and digest and is versioned
against runtime compatibility evidence. The memory adapter is not production
durability and does not imply end-to-end delivery.

## Consequences

- desired-state references remain stable and independently verifiable;
- corrections and rollbacks use new or prior immutable revisions;
- channel movement requires a distinct governed command;
- publication adds verification and transactional persistence latency;
- deployment and edge application remain honest, separately observed facts.
