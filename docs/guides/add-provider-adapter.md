---
title: Add a Provider Adapter
description: Implement provider discovery behind the application port and prove it with the shared conformance suite
updated: 2026-07-14
status: implemented
---

# Add a Provider Adapter

This guide describes the implemented read-only provider discovery contract. It
does not describe a generic cloud SDK wrapper. A Provider Adapter translates one
explicit CloudConnection into provider observations while preserving
provider-native identifiers and namespaced capabilities.

## Implemented contract

The current foundation includes:

- `CloudProviderDescriptor`, `CloudConnection`, and `ProviderRegion` domain
  values
- the application-owned `ProviderAdapter` port and dynamic
  `ProviderAdapterRegistry`
- the tenant/project-scoped `DiscoverProviderRegions` query with the
  `cloud-connections:read` permission
- typed authentication, configuration, permission, rate-limit, and
  availability failures
- application-boundary checks for provider identity, connection identity,
  observation time, duplicate regions, and undeclared capabilities
- `providerAdapterConformance`, a reusable adapter test suite
- `MemoryProviderAdapter`, a deterministic test adapter

No provider SDK, credential resolver, persistence adapter, public discovery
endpoint, or infrastructure mutation is implemented yet.

## Adapter workflow

1. Define one descriptor with a stable lower-case provider identity, provider
   kind, portable capabilities, and namespaced provider capabilities.
2. Implement the application-owned `ProviderAdapter` interface outside
   `packages/domain` and `packages/application`.
3. Accept only a CloudConnection resolved for the authorized tenant and project
   scope. Its
   `credentialSource` is a workload identity or secret reference, never the
   credential value.
4. Resolve short-lived access inside the adapter boundary. Do not place tokens
   in a snapshot, error, log, fixture, prompt, or generated module.
5. Map expected provider failures to the typed result. Do not leak an SDK error
   as an application contract or report rate limiting as an empty region list.
6. Return canonical UTC observation time, the exact Provider and Connection
   identities, unique regions, and capabilities declared by the descriptor.
7. Run the shared conformance suite and provider-specific fixtures.
8. Register the adapter only in a composition root.

Minimal shape:

```ts
export class ExampleProviderAdapter implements ProviderAdapter {
  readonly descriptor = exampleProviderDescriptor;

  async discoverRegions(
    request: ProviderRegionDiscoveryRequest,
  ): Promise<ProviderRegionDiscoveryResult> {
    // Resolve short-lived access from request.connection.credentialSource.
    // Decode the provider response and return typed domain observations.
  }
}
```

## Required conformance

Every adapter test imports `providerAdapterConformance` from
`@aether-cloud/provider-conformance`. Supply a fresh adapter and a
CloudConnection belonging to that provider. The shared suite checks the
provider and connection scope, canonical observation time, unique region
identities, declared capabilities, and rejection of a mismatched connection.

Provider-specific tests remain necessary for response decoding, pagination,
authentication, throttling, quota behavior, and malformed upstream data. The
default test path uses fixtures and must not call a real cloud account.

## Separate lifecycle support

Infrastructure planning is now implemented behind a separate plan-only
`InfrastructureEngine` port. Real local OpenTofu Plan process execution is
implemented; Terraform process execution and infrastructure mutation remain
planned. A future provider adapter may select
versioned provider modules and normalize provider observations, but do not add
`plan`, `apply`, `destroy`, import, or State repair to the read-only discovery
method.

Read [multi-cloud fusion](../concepts/multi-cloud-fusion.md) for State and
authority rules and [repository layout](../reference/repository-layout.md) for
dependency placement.
