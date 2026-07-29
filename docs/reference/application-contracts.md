---
title: Application contract catalog
description: Discover capability governance, bounded Integration discovery, errors, events, transports, and implementation layers from one machine-readable catalog
updated: 2026-07-29
status: mixed
---

# Application contract catalog

[`ai/application-contracts.json`](../../ai/application-contracts.json) is the
machine-readable index for application capabilities, permissions, command
governance, typed errors, integration events, HTTP operations, and
implementation status.

`mcp_exposures` separately reports whether a resource/tool adapter is
implemented and whether a connectable protocol transport exists. This prevents
an executable transport-neutral interface from being described as an MCP
server before a composition root is available.

The catalog is an index, not an alternate execution path. TypeScript domain and
application code remains authoritative for executable behavior, and transport
schemas remain authoritative for their encoded inputs and outputs.

## Status meanings

- `implemented` means the named transport and its production-required behavior
  are executable.
- `partial` identifies exact executable layers while listing missing production
  or transport layers.
- `planned` is a reviewed name or contract with no executable product surface.
- `deprecated` remains listed only for migration.

An application use case backed only by a memory adapter is `partial`, even when
its domain and application tests pass. An event is `planned` until a business
transaction writes it to a real outbox. A documented CloudLink message is not
implemented until both wire decoding and the owning application behavior are
executable.

## Command governance

Every command entry declares permission, risk, confirmation, idempotency,
expiry, and audit. Missing metadata means the command cannot be exposed. A
transport may add stricter policy but cannot weaken catalog governance.

Queries declare a permission and never mutate product state. Edge-originated
observations that change a projection are commands even when they describe a
fact rather than request physical work.

## Integration discovery contract

`integration.projection.list` is a separate read-only application port and
query; it is not a method on the projection write repository. It uses the same
`integration.projection.read` permission as the exact
`integration.projection.get` query. The list input is closed and accepts only
an optional Gateway identity, an opaque cursor, and a bounded limit.

The result is stably ordered by Gateway then Integration identity. It contains
only Integration kind, snapshot generation, entity and latest-observation
counts, receive time, and revision in addition to those identities. Provider
payloads, arbitrary topology data, source addresses, and secrets are outside
the catalog contract. Both list and detail results are edge-reported copies,
not real-time physical truth.

Memory and PostgreSQL adapters implement the catalog. The PostgreSQL query uses
Tenant row-level security, explicit Tenant/Project parameters, optional
Gateway filtering, keyset pagination, and one extra fetched row to establish a
next page. Optional MCP catalog and detail resource adapters invoke these
application queries, but no connectable MCP transport exists yet.

## Compatibility

`schema_version` changes before incompatible catalog structure changes.
Capability names, error codes, event names, and operation identifiers remain
stable within a version. Adding a field is backward compatible only when old
readers may safely ignore it.

The catalog currently documents two implemented public HTTP operations and two
authenticated Audit query operations (JSON and finite SSE snapshot);
partial provider, Plan, enrollment, CloudLink session, Runtime Manifest,
telemetry, alarm, Artifact Registry, deployment, governed Job, audit, webhook,
and Data Export application slices; and planned later IoT product capabilities.
Gateway registration and enrollment events are now `partial` because the
PostgreSQL adapter writes them into the same transaction as aggregate and Audit
state. The Integration projection and default-off Integration Control slices
now name their transactional PostgreSQL ledgers, including real-database
concurrency, rollback, restart, and row-isolation evidence. This does not mean
their production composition, signing-key lifecycle, public Agent, real Broker
qualification, or MCP wire server exists. The catalog also names the
experimental CloudLink MQTT layer separately from production composition and
joint AetherEdge conformance. The partial
`cloudlink.session.challenge.request` and
`cloudlink.session.gateway-signed.accept` entries describe the executable
v1alpha1 challenge/hello path and its memory, PostgreSQL, Node.js Ed25519, and
MQTT layers. They do not claim production authentication: atomic
credential/key lifecycle, durable command audit, and per-uplink
Gateway-signed authentication are missing, so later business uplinks fail
closed. The deployed PostgreSQL Audit read composition does not imply a
production live event stream, external webhook sender, export worker/download
interface, production CloudLink process, complete migration orchestration, or
production IAM.
