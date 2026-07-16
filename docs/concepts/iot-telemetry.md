---
title: IoT business telemetry
description: Document replay-safe PostgreSQL telemetry acceptance and exact CloudLink ACK delivery without replacing edge live-state authority
updated: 2026-07-16
status: mixed
---

# IoT business telemetry

The protocol-neutral domain, application ingest/history use cases, canonical
batch digest, in-memory conformance adapter, experimental CloudLink MQTT
point-batch mapping, and PostgreSQL telemetry adapter are implemented. The
PostgreSQL slice atomically stores replay identity, stream/cursor state,
accepted business facts, Audit, the integration Outbox, and an exact durable
ACK outbox. It proves pre-commit rollback and post-commit identical-ACK recovery
against PostgreSQL 18. Public HTTP history, production database composition,
joint production authentication, multi-sample mapping, and durable data-loss
persistence remain planned; the memory adapter is not a production durability
claim.

IoT business telemetry is Tenant-owned product data. It is not OpenTelemetry
operational data. An AetherEdge runtime remains authoritative for the current
live point value; AetherCloud stores replay-safe, time-stamped historical facts
and freshness-labelled projections.

## Domain boundary

The first slice uses explicit resources rather than a generic entity table:

- `TelemetryStream` identifies one ordered logical uplink stream for a Gateway.
- `StreamEpoch` fences sequence reuse after a deliberate stream reset.
- `StreamPosition` is an unsigned 64-bit value encoded as a canonical decimal
  string at JSON boundaries and represented losslessly in TypeScript.
- `TelemetryBatch` is the atomic ingestion unit and owns a bounded ordered list
  of records.
- `PointSample` carries an Instance/acquisition-Point identity, source time,
  typed value, and source quality. Only `telemetry` and `status` Point kinds are
  accepted; command/action kinds cannot become a control backdoor.
- `TelemetryTopologyBinding` preserves the edge publication epoch and an
  algorithm-qualified topology snapshot digest for each batch.
- A Thing Model reference is optional and must come from commissioned evidence;
  AetherCloud does not invent one for an edge-native Point.
- `DeviceEvent` carries a versioned event type, source time, and bounded typed
  payload.
- `IngestionReceipt` records the batch identity, digest, durable cursor,
  acceptance status, and cloud persistence time.
- `RetentionClass` selects an authorized retention policy; callers do not
  provide arbitrary storage duration.

AetherEdge currently exposes numeric acquired samples and four quality states.
The cloud value model may be broader for future thing models, but the first
wire contract must not claim edge value variants that the edge cannot emit.

## Trusted identity and scope

CloudLink resolves Tenant, Project, Gateway, and credential generation from an
authenticated active Gateway credential before calling the ingestion use case.
An envelope may repeat those identifiers for correlation, but payload fields
are never authorization evidence. Suspended or revoked credential generations
fail closed.

The application command is `telemetry.batch.ingest`. It requires a Gateway
credential scope, expiry, idempotency, audit, bounded size, and an application-
owned repository/inbox transaction. HTTP, a test fixture, or a future alternate
transport must invoke the same command rather than writing history directly.

## Batch identity, digest, and atomicity

The implemented stable identity is:

```text
TenantId + ProjectId + GatewayId + StreamId + StreamEpoch + first position
```

The canonical payload digest covers versioned business content, not transport
headers, trace context, retry count, socket identity, or compression bytes.

The MVP accepts a complete batch atomically. Validation, limits, authorization,
record uniqueness, digest calculation, sequence evaluation, inbox identity,
business facts, required audit, and outbox events succeed in one transaction or
none become accepted. A future partial-record mode requires a new contract
version and per-record receipts.

## Duplicate, conflict, gap, and reorder behavior

- The same identity and digest is a duplicate. It returns the prior durable
  acknowledgement without creating history or integration events again.
- The same identity with different content is a conflicting duplicate. It is
  quarantined, audited, and never acknowledged as accepted.
- The next contiguous batch advances the durable cursor after transaction
  commit.
- A forward gap is durably observable and requests replay. It does not advance
  the contiguous acknowledgement cursor.
- A bounded reorder window may retain later batches as pending. Unbounded
  buffering is forbidden.
- A batch older than the durable cursor is either a verified duplicate or a
  conflict; age alone never proves equality.
- Retention overflow at the edge becomes an explicit loss/gap marker. Neither
  side fabricates missing samples.

## Durable acknowledgement

`received`, `decoded`, `validated`, `accepted`, `durably persisted`, and
`acknowledged` are distinct observations. CloudLink may send a successful
durable acknowledgement only after the transaction containing de-duplication
identity and accepted business facts commits.

If the connection fails before the Gateway receives that acknowledgement, the
Gateway safely replays the batch. A crash after commit returns the same receipt
on replay. A storage timeout with an unknown commit result must be resolved by
the idempotency identity before any new acceptance is attempted.

The implemented PostgreSQL path stores the exact alpha.3 ACK projection in the
same transaction. A bounded delivery worker leases pending rows with
`FOR UPDATE SKIP LOCKED`, publishes sequentially, marks delivery only after a
successful publish, and releases failures for bounded retry. Replay requeues
the same event ID, receipt ID, persisted time, stream position, batch ID, and
digest; it never invents a second business fact. The application validates all
claimed rows at the adapter boundary before publishing them.

## Time and freshness

Every record keeps at least:

- edge/source event time
- cloud received time
- cloud persisted time
- stream epoch and position
- source quality

History queries expose source and ingest time. A latest-value projection also
exposes its durable position, freshness, and known gap state. It is never
labelled as the current physical value. Late data is retained in event-time
history but cannot silently roll a latest projection backward.

## Storage responsibilities

`PostgresTelemetryRepository` now owns the first bounded implementation of
stream metadata, durable inbox identities, contiguous cursors, gap state,
retention policy, bounded history, Audit, integration Outbox, and CloudLink ACK
outbox. Tenant-scoped keys and forced Row-Level Security are defense in depth;
the normal application role remains non-superuser and non-`BYPASSRLS`.

Object storage owns content-addressed raw/cold batches and exports when their
size justifies it. A future time-series or analytics adapter owns large history,
aggregation, and downsampling. Neither store becomes live-state authority.

The history port is owned by the telemetry application context so a measured
ingestion hot path can move without changing the domain contract.

## Resource and security limits

The decoder rejects unsupported contract versions, unsafe integer encodings,
non-finite numeric samples, unknown record variants, duplicate positions inside
a batch, excessive records, oversized values, decompression expansion, and
unbounded metadata. Quota rejection and backpressure are visible results rather
than silent loss.

TenantId, ProjectId, GatewayId, PointId, raw payloads, and arbitrary event type
strings are forbidden as OpenTelemetry metric labels. Enrollment tokens,
credentials, private material, and authorization headers never enter telemetry
payloads, errors, logs, traces, or audit details.

## Application surface and status

- Command `telemetry.batch.ingest`: domain/application, memory, and PostgreSQL
  adapters implemented.
- Query `telemetry.history.query`: application, memory, and bounded PostgreSQL
  adapters implemented.
- Event `telemetry.batch-accepted.v1`: memory and PostgreSQL transactional
  Outbox behavior implemented.
- Exact CloudLink durable ACK outbox and bounded delivery use case: implemented
  for accepted telemetry; production worker composition is planned.
- Stream cursor, gap, lag, and retention-state query: planned.
- CloudLink MQTT adapter: experimental codec/bridge/ingress and the shared
  alpha.3 AetherEdge fixture manifest implemented; the bridge consumes the
  persisted ACK projection, while production database/worker composition and
  session persistence remain planned.
- HTTP history adapter: planned.

Read [ADR-0007](../adr/0007-durable-iot-telemetry.md) for the durable-ingestion
decision and [operational observability](operational-observability.md) for the
separate OpenTelemetry signal path.
