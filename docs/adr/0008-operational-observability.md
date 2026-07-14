---
title: "ADR-0008: OpenTelemetry operational observability"
description: Keep vendor-neutral traces and metrics outside domain authority, business telemetry, and audit
updated: 2026-07-14
status: normative
---

# ADR-0008: OpenTelemetry operational observability

## Status

Accepted on 2026-07-14. The adapter boundary now includes OpenTelemetry SDK
dependencies, a no-op default, in-memory and OTLP HTTP exporters, a bounded
processor, W3C extraction, and telemetry-ingestion instrumentation. Collector
deployment and broader composition-root wiring remain planned.

## Context

AetherCloud needs correlated traces and low-cardinality metrics across HTTP,
CloudLink, ingestion, PostgreSQL, workers, and integration delivery. A
vendor-specific SDK in application code would compromise portability and
dependency direction. Reusing the same operational pipeline for Point history
or durable audit would also erase different reliability and authority needs.

## Decision

1. OpenTelemetry is the vendor-neutral operational instrumentation boundary.
   It is not an observability backend, IoT business data model, command receipt,
   or audit ledger.
2. Domain and application packages do not import OpenTelemetry SDK or signal
   types. Instrumentation lives in adapters, composition roots, or neutral
   use-case decorators.
3. API, CloudLink, and worker composition roots independently own SDK startup,
   resource configuration, bounded flush, and shutdown.
4. The default observer is no-op. OTLP export and an OpenTelemetry Collector
   are optional deployment components and never default-test dependencies.
5. Exporter failure, queue overflow, or Collector loss cannot fail a business
   transaction, CloudLink heartbeat, durable telemetry acknowledgement, or
   edge operation. Queues and retry are bounded and dropped signals are
   observable.
6. W3C Trace Context may be propagated as optional transport metadata. Trace
   context and baggage never affect identity, digest, order, Tenant scope,
   permission, risk, or confirmation.
7. Metrics use bounded attributes. Tenant, Project, Gateway, Point, Job, user,
   secret, full URL, payload, and free-form error values are forbidden metric
   labels.
8. Stable standard semantic conventions are preferred. Product attributes use
   a versioned `aethercloud.*` catalog; experimental conventions are not stable
   product contracts.
9. Structured logs correlate with trace/span identity and remain independently
   usable. Sensitive values are redacted before logs or spans.
10. Audit records remain unsampled product facts committed with business state.
    Trace sampling or export success cannot satisfy an audit policy.

## Alternatives considered

**Direct vendor agents and APIs** can provide useful automatic instrumentation
but make the application depend on one backend. They may be deployment adapters
behind the OpenTelemetry boundary.

**OpenTelemetry APIs in domain objects** simplify manual spans but contaminate
business signatures and tests with an operational concern.

**Use logs as audit** avoids a ledger but cannot provide atomic, Tenant-scoped,
unsampled command evidence.

**Point identities as metric labels** make individual series convenient while
creating high-cardinality, privacy, and cost failures. Point history remains in
the IoT telemetry context.

## Security impact

Resource attributes and span enrichment use an allow-list. Baggage is bounded
and untrusted. Tokens, authorization headers, private keys, certificate
material, raw IoT payloads, and arbitrary exception bodies are excluded.

## Compatibility and migration

OpenTelemetry package and semantic-convention versions are pinned by the
lockfile. Application contracts remain unchanged when exporter or backend
choices change. Custom attribute changes follow the documented catalog
stability rules.

## Consequences

- Operators can correlate independent composition roots without creating a new
  source of business truth.
- No-op and in-memory implementations keep tests deterministic.
- Production deployments must choose retention, sampling, Collector, and
  backend policies outside the domain.
- Some diagnostic signals may be dropped by design; durable audit and IoT data
  may not.
