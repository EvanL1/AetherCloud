---
title: Audit, subscriptions, webhook delivery, and data export
description: Expose Tenant-scoped evidence and durable integration workflows without bypassing application use cases or leaking destination secrets
updated: 2026-07-29
status: mixed
---

# Audit, subscriptions, webhook delivery, and data export

This context turns application evidence into queryable audit history and
governed outbound work. It does not make OpenTelemetry a business ledger and it
does not let an HTTP, SSE, webhook, export, or future MCP interface write a
bounded-context store directly.

## Authority and transaction boundary

An owning command transaction must commit its aggregate change, required audit
event, and outbox record together. Integration workers consume committed outbox
facts later. A failed webhook or disconnected SSE client can delay an external
projection, but cannot roll back or change the original business outcome.

Audit is append-only evidence scoped by `TenantId` and `ProjectId`. Operational
traces may correlate through a trace identifier, but sampled OpenTelemetry data
is neither authorization evidence nor a replacement for audit.

## Implemented layers

The following executable foundations exist:

- an immutable `AuditEvent` domain value with canonical lossless sequence,
  subject, resource, outcome, governance, correlation, and optional evidence
  digests;
- the authorized `SearchAuditEvents` application query with Tenant/Project
  scoped memory and PostgreSQL repositories;
- a PostgreSQL Audit query transaction that sets Tenant context, relies on
  forced RLS, validates every returned row, paginates losslessly, and returns a
  typed unavailable outcome;
- authenticated `GET /api/v1/audit/events` and a finite resumable
  `GET /api/v1/audit/events/stream` SSE snapshot, both calling the same query;
- `WebhookSubscription` create, disable, and get use cases using stable
  destination references and bounded event allowlists;
- a `WebhookDelivery` lifecycle with persisted in-flight intent, a stable
  delivery idempotency key, bounded retries, attempt evidence, visible dead
  letter state, and explicit-confirmation redrive;
- a `DataExport` lifecycle for bounded audit, alarm, or telemetry history
  exports, with high-risk explicit-confirmation request, worker outcome
  reporting, immutable object reference, digest, and lossless byte length;
- memory conformance adapters that atomically retain aggregate, idempotency,
  audit, and outbox evidence for application tests.

The SSE endpoint is deliberately a finite snapshot. `Last-Event-ID` resumes
from the audit sequence through the same application query, but no durable
live-notification process exists yet.

## State machines

```text
Webhook subscription: active -> disabled

Webhook delivery:
pending -> delivering -> delivered
                     \-> retrying -> delivering
                     \-> dead-lettered -> pending (explicit redrive)

Data export:
queued -> running -> ready
                  \-> failed
queued/ready/failed -> expired
```

An attempt is written as `delivering` before the external sender is called. A
crash can therefore leave an in-flight attempt requiring worker reconciliation;
it must not be silently treated as never attempted. The delivery identity is
the receiver-facing idempotency key across retries. A conflicting enqueue or
redrive fails closed.

An export response never contains raw export bytes. `ready` exposes only a
bounded object reference, content digest, and decimal `uint64` byte length. A
separate authorized download capability and production object-store adapter
remain required before clients can retrieve content.

## Destination and SSRF boundary

Application and domain records contain `WebhookDestinationId`, never an
arbitrary request-supplied URL or plaintext signing secret. A production sender
must resolve the reference from a Tenant-scoped secret-backed destination
registry, require HTTPS, reject private/link-local/reserved address targets
after DNS resolution and redirect, bound response bytes and time, sign the
canonical delivery, and prevent credential forwarding. That sender and
registry are planned; the current memory sender is test-only.

## Missing production surface

Production Audit write-route composition, transactional outbox consumption, a
destination registry, secret rotation, production HTTP sender, signing,
DNS/redirect SSRF defence, retry leasing, a live SSE notifier, WebSocket,
object storage, export workers, retention/quota enforcement, and public
webhook/export APIs are still planned. The API can select the PostgreSQL Audit
query repository with a non-owner forced-RLS role and verified TLS, but its
configured bearer identity is not production IAM.

Use the [HTTP API reference](../reference/http-api.md) and the
[application contract catalog](../reference/application-contracts.md) to find
the supported integration operations, required permissions, and current
implementation status.
