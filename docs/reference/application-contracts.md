---
title: Application contract catalog
description: Discover capability governance, errors, events, HTTP operations, and implementation layers from one machine-readable catalog
updated: 2026-07-15
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
state. The catalog now names the experimental CloudLink MQTT layer separately
from production composition and joint AetherIot conformance. It does not claim a
production live event stream, external webhook sender, export worker/download
interface, MCP wire server, production CloudLink process, migration runner, or
deployed production database exists.
