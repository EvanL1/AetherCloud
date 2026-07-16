---
title: "ADR-0007: Durable IoT telemetry ingestion"
description: Accept replayed edge telemetry atomically and acknowledge only after durable business acceptance
updated: 2026-07-16
status: normative
---

# ADR-0007: Durable IoT telemetry ingestion

## Status

Accepted on 2026-07-14. The protocol-neutral domain/application contract,
in-memory conformance adapter, experimental CloudLink MQTT point-batch mapping,
and PostgreSQL telemetry repository/migration are implemented. The PostgreSQL
transaction persists accepted facts, replay identity, cursor, Audit,
integration Outbox, and the exact durable ACK outbox; PostgreSQL 18 fault tests
cover rollback before commit and identical ACK recovery after an uncertain
commit. Public query transport, production database/worker composition,
multi-sample mapping, data-loss persistence, production authentication, and any
future signed-ACK profile remain incomplete.

## Context

AetherEdge acquires live point values, buffers bounded uplink work locally, and
continues operating while disconnected. Wide-area delivery is therefore
at-least-once: a Gateway can replay a batch after either side loses a response.
A cloud receiver must distinguish a safe replay from different content using
the same identity, preserve stream gaps, and avoid acknowledging volatile data.

Cloud history is useful for analysis and integration but cannot replace the
edge SHM authority for current point state. Operational OpenTelemetry signals
also use the word telemetry but have different identity, retention, authority,
and safety semantics.

## Decision

1. IoT telemetry is an explicit bounded context with `TelemetryStream`,
   `TelemetryBatch`, `PointSample`, `DeviceEvent`, and `IngestionReceipt`; it is
   not stored in a generic Entity/Attribute model.
2. Tenant and Project scope comes from an authenticated active Gateway
   credential. Payload scope is correlation data, not authorization evidence.
3. Each logical stream has an explicit epoch and lossless unsigned 64-bit
   position. JSON encodes protocol 64-bit values as canonical decimal strings.
4. The MVP accepts or rejects a complete batch atomically. A future partial
   mode requires a new version and per-record receipts.
5. A stable batch identity plus canonical business-content digest determines
   replay. The same identity and digest returns the prior receipt; the same
   identity with different content is a quarantined security conflict.
6. A forward gap is observable and does not advance the contiguous cursor.
   Reordering may use a bounded durable window; unbounded buffering is
   forbidden.
7. A successful CloudLink acknowledgement follows one transaction containing
   de-duplication identity, accepted business facts, required audit, and outbox
   events. Receiving, decoding, or buffering in process is insufficient.
8. History and latest-value projections retain source time, ingest time,
   position, freshness, and known gaps. They never become live-state authority.
9. PostgreSQL is the initial transactional inbox/cursor and bounded-history
   adapter. Object and analytical stores may take large history behind
   application-owned ports after measured need.
10. IoT business telemetry never uses OpenTelemetry metrics as its primary
    model or persistence path.

## Alternatives considered

**Acknowledge on socket receipt** reduces latency but loses data on process
failure and violates store-and-forward replay safety.

**At-most-once delivery** avoids duplicates by accepting silent loss, which is
not an acceptable industrial history contract.

**Per-record partial success in v1** can salvage valid records but makes cursor,
replay, audit, and receipt behavior substantially harder to prove. Atomic
batches are the safer first contract.

**OpenTelemetry metrics for every Point** reuse an operations pipeline but lose
business sequence, quality, event-time, retention, and Tenant semantics while
creating uncontrolled cardinality.

## Security impact

Gateway authentication precedes decoding into a Tenant context. Batch,
decompression, record, value, metadata, and reorder windows are bounded.
Conflicting duplicates are audited without recording the raw payload. Secrets
and credentials are excluded from every telemetry record and diagnostic signal.

## Compatibility and migration

AetherEdge has a runtime manifest, point model, local durable outbox, and a
compatibility MQTT uplink, but no mutually accepted CloudLink telemetry wire
schema. The experimental MQTT contract must be executed unchanged against both
repositories before release; the legacy MQTT payload is not silently adopted as
CloudLink v1. Edge-native Points preserve acquisition kind and topology
publication evidence without fabricating a Thing Model revision.

## Consequences

- An edge may safely replay after an ambiguous acknowledgement.
- Durable acceptance adds storage latency to acknowledgement.
- Cursor and digest indexes become production correctness requirements.
- Missing history is explicit through gaps rather than concealed by a latest
  value.
- The memory adapter proves semantics but does not satisfy production
  durability. The PostgreSQL telemetry slice proves its bounded transaction and
  recovery contract, not the still-open full CloudLink production gate.
