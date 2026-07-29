---
title: Repository layout
description: Place code in the correct application, domain, adapter, or composition-root package
updated: 2026-07-29
status: mixed
---

# Repository layout

The workspace separates stable product logic from delivery mechanisms. Some
directories are established by the repository foundation and others are added
when their first vertical slice is implemented.

```text
apps/
  api/                  HTTP composition root with Supabase JWKS authentication
  mcp/                  implemented transport-neutral MCP application interface; wire root planned
  cloudlink/            experimental MQTT ingress composition; production wiring planned
  worker/               planned background-work composition root
  web/                  planned operator client
packages/
  domain/               values, identifiers, invariants
  application/          transport-neutral use cases
  provider-conformance/ reusable Provider Adapter contract tests
  infrastructure-conformance/ reusable Infrastructure Engine contract tests
adapters/
  fleet/memory/          implemented Gateway repository/token test adapters
  fleet/postgres/        implemented Gateway SQL/migration/driver adapter; production composition planned
  cloudlink/memory/      implemented session, challenge, and heartbeat test adapter
  cloudlink/postgres/    implemented session/challenge SQL adapter; production composition planned
  cloudlink/mqtt/        experimental strict codec and MQTT.js transport adapter
  cloudlink/node-crypto/ experimental Ed25519 challenge and hello authentication adapter
  runtime/memory/        implemented Runtime Manifest history test adapter
  telemetry/memory/      implemented atomic telemetry conformance adapter
  alarm/memory/          implemented alarm projection conformance adapter
  artifacts/memory/      implemented Artifact Registry conformance adapter
  deployment/memory/     implemented edge deployment conformance adapter
  jobs/memory/           implemented governed Job ledger conformance adapter
  audit/memory/          implemented append-only Audit query test adapter
  audit/postgres/        implemented forced-RLS Audit query adapter
  integration/memory/    implemented webhook subscription/delivery and export test adapters
  observability/opentelemetry/ optional implemented operational-signal adapter
  providers/memory/      deterministic implemented test adapter
  providers/<provider>/  planned SDK discovery and normalization adapters
  infrastructure/memory/ implemented deterministic Plan engine and repository
  infrastructure/opentofu/ implemented real local Plan-only CLI adapter
  infrastructure/terraform/ planned Terraform CLI adapter
  persistence/          planned shared migration runner and object-store adapters
infra/modules/           planned versioned provider-specific IaC modules
deploy/certs/             pinned public CA certificates used by compositions
supabase/                 CLI config and ordered bindings to adapter-owned SQL migrations
contracts/cloudlink/     experimental JSON Schemas and golden fixtures
ai/                      invariants and machine-readable documentation catalog
skills/aether-cloud/     coding-agent workflow and routing
docs/                    concepts, guides, reference, and decisions
tests/                   repository-wide contract tests
```

## Placement rules

Put a type in `domain` when it expresses business meaning without I/O. Put an
interface in a port-owning application module when it describes a capability
needed by a use case. Put orchestration in `application`. Put Fastify routes,
process signals, environment access, and dependency construction in an app.

An adapter may depend on a port and third-party SDK. A port cannot depend on its
adapter. Do not create a generic utilities package; place a helper with the
concept that owns its semantics.

Provider-neutral intent belongs in domain and application packages.
Provider-specific modules, SDK clients, authentication, and normalization stay
under adapters and `infra/modules`. A worker composition root selects a
Provider Adapter and an `InfrastructureEngine`; neither is selected inside a
domain use case.

## Package exports

Packages expose deliberate public entry points. Import another package through
its declared export rather than reaching into its internal directory. Avoid
barrel exports that accidentally make persistence records or framework types
part of the application contract.

## Adding a bounded context

Start with one observable use case and its domain language. Add the test and
application contract before choosing persistence. If the context needs an
adapter, provide an in-memory conformance implementation so default tests stay
self-contained.

Update [architecture](../concepts/architecture.md) only when the context changes
system responsibilities or dependencies; routine file additions belong in this
reference page or a package README.
