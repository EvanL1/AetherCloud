---
title: "ADR-0016: Pinned AetherContracts consumption"
description: Consume one digest-pinned public contract release while keeping product codecs local and conformance claims evidence-based
updated: 2026-07-16
status: normative
---

# ADR-0016: Pinned AetherContracts consumption

## Status

Accepted on 2026-07-15. AetherContracts `v0.1.0-alpha.3` is the public
release consumed by both AetherCloud and AetherEdge through the same
`aether-contracts.lock.json`. The current claim is `distribution-only`; both
locks are `complete-consumer` with no pending imports.

## Context

Keeping a second shared protocol copy in each product repository created three
different kinds of authority: Cloud, Edge, and the public contract repository.
A Git submodule or a dependency on `main` would preserve that ambiguity and
would also make clean-clone tests depend on network availability. Merely
downloading a release would not prove that a product codec uses its bytes.

Alpha.3 closes the Runtime Manifest SemVer, conflicting replay, and duplicate
cursor gaps in both product suites. Complete adoption remains distinct from
production transport and durability conformance.

## Decision

1. The tagged AetherContracts specification, Schema, fixture, profile, and TCK
   surface is the shared interoperability authority. Product domain and codec
   implementations remain in their product repositories.
2. AetherCloud and AetherEdge commit byte-identical consumer locks. The lock pins
   the annotated tag object, peeled commit, exact release URL, bundle size and
   SHA-256, manifest SHA-256, and the imported and pending artifact sets.
3. Default verification is offline. A versioned copy of the exact release
   manifest and reference verifier closure is committed in each consumer. Every
   imported destination is hashed against both the lock and release manifest.
4. Optional CI downloads only the locked release, validates size and digest
   before extraction, and has no `latest`, branch, sibling-checkout, or repair
   fallback. The reusable Action is pinned to the full release commit.
5. Alpha.3 imports 53 exact alpha.3 artifacts: the required specification,
   profiles, gates, failure taxonomy, TCK manifest, Schemas, fixtures, and
   verifier closure, with `pending_imports: []`.
6. `contracts/cloudlink/v1` remains the current product integration surface.
   Its local manifest, authentication Schema, wire profile, gates, and scenarios
   are migration history or product proposals and cannot override the public
   authority.
7. A distribution check proves byte identity only. It does not pass codec/TCK,
   shared-Broker authentication, real-Broker dual-harness, fault-injection, or
   crash-durable ACK gates.

## Consequences

- Contract upgrades are explicit reviewed lock changes. Cloudflare may cache
  locked bytes, but it is not authority. Git submodules are not the default.
- Local product extensions need their own namespace and cannot redefine a
  public core field or failure meaning.
- Future releases require failing behavior tests and a reviewed closure update.
- Production authentication key lifecycle remains unresolved, legacy remains default, and this decision
  adds no physical-control capability.
