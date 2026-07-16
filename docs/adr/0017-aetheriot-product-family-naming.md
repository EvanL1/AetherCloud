---
title: "ADR-0017: Adopt AetherIoT product-family naming"
description: Name the edge product AetherEdge while preserving AetherCloud authority, stable software identifiers, and immutable contract evidence
updated: 2026-07-16
status: normative
---

# ADR-0017: Adopt AetherIoT product-family naming

## Status

Accepted on 2026-07-16. The canonical rename decision and migration checklist
live with AetherEdge in ADR-0019 and its public migration guide. This ADR records
AetherCloud's adoption and authority constraints.

## Context

The former AetherIot name identified both the complete project and the edge
runtime repository, while AetherCloud and AetherContracts already had distinct
product identities. The edge installer, SDK, and public diagrams already used
AetherEdge, so the overlap made product relationships and documentation
navigation ambiguous.

## Decision

1. AetherIoT is the umbrella platform identity.
2. AetherEdge is the edge runtime, Kernel, CLI, and SDK product formerly named
   AetherIot.
3. AetherCloud and AetherContracts keep their existing names and repository
   identities.
4. AetherEMS is an industry solution built on the platform, not a control-plane
   module or a dependency of the industry-neutral products.
5. AetherCloud documentation, current tests, harness output, and new external
   links use AetherEdge.
6. Existing `AETHERIOT_*` compatibility environment variables, `aether-*`
   packages, the `aether` CLI, installer names, and protocol identifiers remain
   unchanged until a separate versioned compatibility decision says otherwise.
7. Published releases, evidence, provenance, and digest-pinned alpha.3 imports
   are not rewritten. Historical AetherIot strings in those artifacts remain
   truthful.

## Consequences

Cloud documentation now describes its edge peer unambiguously, and the shared
documentation site can route users by product. GitHub links, local harness
defaults, repository descriptions, badges, and release examples require a
coordinated update when the edge repository is renamed.

The product rename does not pass any CloudLink authentication, durability,
conformance, or legacy-cutover gate and introduces no physical-control path.

## Rollback

If the GitHub rename breaks CI or downstream consumers, restore the former
repository name and repository-facing URLs. Keep the product-family model,
stable software identifiers, and immutable evidence. Never rewrite published
contract bytes as part of rollback.
