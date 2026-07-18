---
title: MCP application interface
description: Expose capability metadata, bounded Integration discovery, exact Tenant resources, and governed tools without creating an agent-only data path
updated: 2026-07-17
status: mixed
---

# MCP application interface

[Simplified Chinese](https://docs.aetheriot.workers.dev/aethercloud/concepts/mcp-application-interface/)

The MCP interface is an adapter over AetherCloud application commands and
queries. It does not own business state, relax authorization, manufacture a
planned capability, or connect directly to PostgreSQL, an outbox, CloudLink, or
an edge runtime.

## Implemented interface foundation

`apps/mcp` implements a transport-neutral `AetherCloudMcpInterface` with runtime
decoding and typed results:

- `listResources()` advertises `aethercloud://capabilities` and the
  `aethercloud://audit/events{?cursor,limit}` resource template;
- the capability resource reports application status separately from MCP
  exposure status, including planned MCP exposure;
- the Audit resource injects authenticated Tenant, Project, subject, and
  permissions, then invokes the same `SearchAuditEvents` query used by HTTP;
- `listTools()` exposes only executable MCP adapters and includes permission,
  risk, confirmation, idempotency, expiry, audit, and input-schema metadata;
- `data.export.request` invokes `RequestDataExport`; its high-risk explicit
  confirmation is still enforced by the application command;
- `edge.job.create` invokes `CreateGovernedJob`; the capability declaration and
  edge-side decision remain authoritative for the requested work;
- `integration.device.power.set` is advertised only when both
  `CreateIntegrationPowerControl` and a trusted governance resolver are
  injected. The resolver, not the caller, supplies subject-bound policy and
  confirmation references. A successful call reports only that the request is
  accepted and waiting for edge evidence;
- `aethercloud://integration/projections{?gatewayId,cursor,limit}` is
  advertised only when `ListIntegrationProjections` is injected. It provides a
  bounded, stably paginated directory of Integration summaries through the
  application query;
- `aethercloud://integration/projections/{gatewayId}/{integrationId}` is
  advertised only when `GetIntegrationProjection` is injected. It is an exact
  by-ID application query for the topology and latest observation copy;
- unknown or application-only capabilities fail with
  `mcp-tool-not-implemented` before any use case is invoked.

The directory accepts an optional exact Gateway filter, an opaque cursor, and a
limit from 1 to 100. Its stable order is Gateway then Integration identity.
Each item contains only Gateway identity, Integration identity and kind,
snapshot generation, entity and latest-observation counts, receipt time, and
revision. It does not expose provider payloads, source addresses, credentials,
tokens, or arbitrary topology data.

Both Integration resources say `authority: edge-reported-copy` and
`liveStateAuthoritative: false`. The directory is discovery context for an
Agent, not an inventory scan of the physical network and not proof of current
device state. `receivedAt` is the freshness evidence available for the copied
projection. An Agent can list summaries and then read one exact projection,
but every step still passes through its Tenant/Project-scoped application
query and permission check.

Authenticated scope is supplied by the future MCP composition root, never by a
tool's business `input`. Command envelopes contain confirmation,
idempotency key, issue time, and expiry; the interface forwards them unchanged
to the application decoder. It cannot weaken capability metadata.

## Implemented versus planned

The resource/tool registry, bounded catalog and exact detail delegation,
external decoding, capability-status resource, and behavior tests are
implemented. There is no MCP SDK transport, stdio server, Streamable HTTP
endpoint, OAuth flow, session composition root, rate limiter, or production
identity composition yet. Consequently the package is an executable interface
foundation, not a network server that an MCP client can connect to today.

Adding a wire transport must be a thin composition root around this interface.
It must translate MCP protocol errors and content without changing the
underlying command/query context or reaching around the use case. Command tools
remain deny by default; a tool is absent until both its application behavior
and explicit MCP adapter are executable.

## Security and content boundary

Resources and tools return bounded JSON content. Raw credentials, enrollment
tokens, artifact bytes, webhook secrets, export bytes, SHM addresses, and
device-register values are not MCP content. The Integration directory is a
summary projection and never returns arbitrary provider fields. A data export
returns only its governed resource state and immutable object metadata;
download remains a separate planned authorization boundary.

Read the [application contract catalog](../reference/application-contracts.md),
[audit and integrations](audit-and-integrations.md), and
[governed capability Jobs](governed-capability-jobs.md) before exposing another
resource or tool.
