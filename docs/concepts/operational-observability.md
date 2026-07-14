---
title: Operational observability
description: Instrument AetherCloud with OpenTelemetry without turning operational signals into IoT data or audit
updated: 2026-07-14
status: mixed
---

# Operational observability

OpenTelemetry is the vendor-neutral instrumentation and export boundary for
AetherCloud processes. A no-op default, validated environment opt-in, OTLP HTTP
trace/metric exporters, in-memory exporters, W3C Trace Context extraction,
bounded span processor, low-cardinality telemetry-ingestion decorator, and
failure-isolation tests are implemented. Collector deployment and broad HTTP,
CloudLink, database, worker, and webhook instrumentation remain planned.

Operational observability answers whether AetherCloud components are healthy
and where time or failures occur. It is not IoT business telemetry, a durable
command receipt, an authorization source, or an audit ledger.

## Dependency boundary

Domain and application packages do not import OpenTelemetry APIs or SDK types.
Standard framework/database instrumentation belongs in adapters and composition
roots. Application-specific operation names may be observed through a neutral
application-owned observer port or a use-case decorator.

The API, CloudLink, and worker roots independently configure and close their
SDK lifecycle. The default is a no-op implementation. OTLP export and a
Collector are optional deployment choices; tests and correct product behavior
never require either one.

Exporter queues and flushes are bounded. An unavailable exporter can drop
operational signals after bounded retry, but it cannot block HTTP commands,
CloudLink heartbeat, telemetry persistence acknowledgement, inbox/outbox work,
or commissioned edge behavior.

## Initial traces

The telemetry-ingestion use-case span is implemented. Planned spans also cover:

- HTTP request and application use case
- CloudLink authentication, negotiation, session, resume, and reconnect
- telemetry decode, validation, de-duplication, persistence, and acknowledgement
- inbox/outbox lease and delivery
- PostgreSQL transaction
- webhook delivery
- background worker execution

W3C Trace Context may cross CloudLink as optional metadata. Trace context and
baggage never participate in message identity, payload digest, ordering,
authorization, permission, risk, or Tenant resolution. Remote baggage uses a
small allow-list and strict byte limits.

## Initial metrics

The initial low-cardinality catalog includes:

- active CloudLink sessions
- handshake failures and reconnect count
- heartbeat age and round-trip latency
- telemetry batches and samples by bounded result class
- duplicate, conflicting replay, and sequence-gap count
- persistence and acknowledgement latency
- inbox/outbox backlog, retry, and dead-letter count
- application command/query duration and failure class
- worker duration and bounded queue depth
- dropped OpenTelemetry signal count

Metric attributes use bounded classifications such as service, operation,
protocol version, result class, and deployment environment. TenantId,
ProjectId, GatewayId, PointId, JobId, user identity, token, certificate, full
URL, payload, and free-form error text are forbidden metric labels because they
leak sensitive context or create high-cardinality series.

Standard stable HTTP, database, RPC, and messaging semantic conventions are
preferred. Product-specific names use a documented `aethercloud.*` namespace
and an explicit stability/version catalog. Experimental semantic conventions
do not become stable AetherCloud contracts by accident.

## Logs, traces, and audit

Structured application logs remain the first logging surface and carry
trace/span correlation when tracing is enabled. Raw IoT payloads, tokens,
authorization headers, private keys, certificate material, and arbitrary
exception bodies are redacted before logging or span enrichment.

Audit records are unsampled, Tenant-scoped product facts committed with the
business transaction. Traces are sampled, best-effort diagnostic signals. A
trace may reference an audit event identity and an audit event may retain a
trace identity, but neither substitutes for the other. A successful span or
export says nothing about business transaction success.

## Sampling and tests

Head sampling is sufficient for the first adapter. Collector-side tail
sampling may be introduced later without changing application behavior. Error
and security-denial traces may receive a higher sampling probability, while
the corresponding audit record remains mandatory and unsampled.

Conformance tests use a no-op observer and in-memory exporters. They cover
context propagation, missing context, exporter failure isolation, bounded
queues, redaction, forbidden high-cardinality labels, and independence between
audit persistence and trace sampling.

Read [ADR-0008](../adr/0008-operational-observability.md) for the decision and
[IoT business telemetry](iot-telemetry.md) for the product data path.
