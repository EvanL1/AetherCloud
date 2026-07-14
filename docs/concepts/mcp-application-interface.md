---
title: MCP application interface
description: Expose capability metadata, Tenant resources, and governed tools through the same application use cases without creating an agent-only data path
updated: 2026-07-15
status: mixed
---

# MCP application interface

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
- unknown or application-only capabilities fail with
  `mcp-tool-not-implemented` before any use case is invoked.

Authenticated scope is supplied by the future MCP composition root, never by a
tool's business `input`. Command envelopes contain confirmation,
idempotency key, issue time, and expiry; the interface forwards them unchanged
to the application decoder. It cannot weaken capability metadata.

## Implemented versus planned

The resource/tool registry, application delegation, exact external decoding,
capability-status resource, and behavior tests are implemented. There is no
MCP SDK transport, stdio server, Streamable HTTP endpoint, OAuth flow, session
composition root, rate limiter, or production identity/audit persistence yet.
Consequently the package is an executable interface foundation, not a network
server that an MCP client can connect to today.

Adding a wire transport must be a thin composition root around this interface.
It must translate MCP protocol errors and content without changing the
underlying command/query context or reaching around the use case. Command tools
remain deny by default; a tool is absent until both its application behavior
and explicit MCP adapter are executable.

## Security and content boundary

Resources and tools return bounded JSON content. Raw credentials, enrollment
tokens, artifact bytes, webhook secrets, export bytes, SHM addresses, and
device-register values are not MCP content. A data export returns only its
governed resource state and immutable object metadata; download remains a
separate planned authorization boundary.

Read the [application contract catalog](../reference/application-contracts.md),
[audit and integrations](audit-and-integrations.md), and
[governed capability Jobs](governed-capability-jobs.md) before exposing another
resource or tool.
