---
title: ADR-0002: TypeScript modular monolith
description: Start with one workspace and independently scalable composition roots
updated: 2026-07-14
status: normative
---

# ADR-0002: TypeScript modular monolith

## Status

Accepted on 2026-07-14.

## Context

The cloud control plane is dominated by APIs, identity, orchestration, schema
handling, long-lived sessions, documentation tooling, and web integration.
TypeScript has a strong ecosystem for these workloads and lets contracts flow
into SDK and UI development. Early microservices would add distributed failure
and deployment costs before module throughput is known.

## Decision

Use Node.js 24, TypeScript 5.9, ESM, and a pnpm workspace. TypeScript upgrades
must wait until the lint and build toolchain declares support for the target
release; beta compilers are not a repository baseline. Begin with a modular
monolith containing strict domain, application, adapter, and interface
boundaries. Fastify is the initial HTTP adapter.

Use independent composition roots for the HTTP API, CloudLink connections, and
background workers so their process counts can change without dividing the
domain prematurely. PostgreSQL is the first transactional cloud adapter. Start
background delivery with a transactional outbox rather than requiring a broker.

Use runtime decoding at every external boundary and keep strict compiler
options enabled. Preserve protocol 64-bit values without unsafe conversion to
JavaScript `number`.

## Consequences

- Most cloud development uses one language and one dependency graph.
- Tests can exercise use cases without networked infrastructure.
- Package-boundary checks are required to stop framework and persistence types
  from leaking inward.
- A measured ingestion hot path may later be extracted or implemented in Rust
  behind the same versioned contract.
- Service extraction requires operational evidence and failure-mode tests.
