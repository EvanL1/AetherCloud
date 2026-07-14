---
title: "ADR-0012: Durable audit and outbound integrations"
description: Separate committed business outcomes from resumable audit queries, webhook attempts, dead letters, and immutable data exports
updated: 2026-07-15
status: normative
---

# ADR-0012: Durable audit and outbound integrations

## Status

Accepted on 2026-07-15. Audit domain/query, a memory adapter, authenticated
JSON and finite SSE audit routes, webhook subscription/delivery state machines,
data-export state machines, application use cases, and memory conformance
adapters are implemented. Production durability, destination secrets/sending,
live notification, object storage, workers, and public integration APIs remain
planned.

## Context

Business commands need immutable evidence and external consumers need
notifications and bounded exports. Calling a webhook inside the business
transaction couples availability and latency to an untrusted endpoint. Treating
a network error as proof of non-delivery can duplicate downstream effects.
Allowing callers to submit arbitrary URLs creates an SSRF and secret-exposure
boundary. Returning large export bodies from an API process also defeats
retention, quota, and resumability controls.

## Decision

1. The owning business transaction commits aggregate, required audit, and
   outbox evidence atomically. Outbound delivery occurs after commit and never
   changes the business outcome.
2. Audit is append-only Tenant/Project-scoped evidence. Query cursors and SSE
   event identities use canonical lossless audit sequences.
3. A webhook subscription names a stable destination reference and an explicit
   event allowlist. Domain/application input never accepts an arbitrary URL or
   signing secret.
4. Each event/destination delivery has a stable delivery identity used as the
   receiver-facing idempotency key. Attempt intent is persisted before network
   I/O; results, retryability, schedule, and bounded evidence are persisted
   afterward.
5. Retries are bounded. Exhaustion is visible as dead-letter state. Redrive is
   a high-risk, explicitly confirmed command and retains prior attempt evidence.
6. A production sender resolves Tenant-scoped destination secrets at the
   adapter boundary and must enforce HTTPS, DNS/redirect SSRF defence, signing,
   time/size limits, and credential isolation.
7. Data exports are governed asynchronous resources. Ready state contains an
   immutable object reference, digest, and lossless byte length, never inline
   unbounded data. Download authorization is a separate capability.
8. HTTP, SSE, workers, and MCP invoke application use cases. None reads or
   writes audit, outbox, delivery, or export storage directly.
9. OpenTelemetry correlation is optional operational evidence. It is not audit,
   delivery acknowledgement, or export authority.

## Alternatives considered

**Synchronous webhook calls in command transactions** provide immediate
feedback but let external latency and failure control internal commits.

**Arbitrary endpoint URLs on each delivery** are convenient but bypass
destination governance, secret rotation, and SSRF controls.

**Unbounded automatic retry** hides failures, creates cost and load without a
clear operator decision, and can duplicate receiver effects.

**Inline export responses** avoid object storage but cannot safely bound large
history requests, retention, resumability, or download authorization.

## Consequences

- consumers observe committed facts eventually and must accept at-least-once
  delivery using the stable idempotency key;
- worker reconciliation is required for an attempt left in flight by a crash;
- dead letters and exports are explicit Tenant resources with retention and
  quota requirements;
- production readiness requires a PostgreSQL transaction boundary and
  hardened destination/object-store adapters;
- a finite SSE audit snapshot is useful now without pretending that a durable
  live fan-out process already exists.
