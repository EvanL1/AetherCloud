---
title: ADR-0004: Capability-driven multi-cloud fusion
description: Use OpenTofu by default, preserve provider modules, and isolate infrastructure state by deployment stack
updated: 2026-07-14
status: normative
---

# ADR-0004: Capability-driven multi-cloud fusion

## Status

Accepted on 2026-07-14. This decision extends ADR-0001 and ADR-0002.

## Context

AetherCloud must manage IoT deployments and cloud-side workloads across more
than one public or private infrastructure provider. A lowest-common-denominator
resource API would discard useful provider capabilities. Direct cloud SDK
orchestration would require AetherCloud to recreate dependency planning, State,
locking, drift detection, import, and safe destroy behavior.

HPC-NOW provides a useful precedent: common cluster configuration and lifecycle
commands are implemented over provider-specific Terraform templates, while
provider state is normalized into one operational view. Its fixed provider
codes, credential inference, local encrypted files, provider conditionals, and
raw tfstate parsing are not suitable boundaries for a multi-tenant cloud
control plane.

## Decision

1. Multi-cloud fusion is a primary AetherCloud product capability.
2. Providers register dynamically through a capability-driven Provider Adapter.
3. The common domain models intent, policy, placement, jobs, and normalized
   observations. Provider-specific modules and namespaced extensions preserve
   native capabilities.
4. OpenTofu is the default infrastructure engine. Terraform is a compatible
   engine behind the same `InfrastructureEngine` port.
5. Infrastructure lifecycle uses saved plans and versioned JSON output. Raw
   State or human CLI text is never parsed as an application contract.
6. One deployment stack has one remote, encrypted, versioned, independently
   locked State. A State cannot span provider connections.
7. Cloud providers are explicit identities. Credentials use secret references
   and short-lived access where available; credential shape is not a provider
   discriminator.
8. Infrastructure apply, destroy, import, and state-repair operations are
   governed commands with permission, risk, policy, confirmation, lock, and
   audit requirements.
9. Infrastructure workers are horizontally scalable and stateless. Durable
   artifacts, State, logs, locks, and receipts are external.
10. Direct cloud SDKs are allowed for discovery, price, quota, identity, and
    provider operations that do not recreate the infrastructure state machine.

## Alternatives considered

**Pulumi** provides strong TypeScript authoring but introduces a second engine
and State model, while much provider coverage derives from the Terraform
ecosystem. It may be offered as a future adapter but is not the foundation.

**Crossplane** provides continuous reconciliation through Kubernetes resources.
It remains a possible provider adapter for Kubernetes-native deployments, but
making it foundational would make Kubernetes mandatory for AetherCloud.

**Direct provider SDKs** remain complementary. Using them as the only lifecycle
engine would require a new plan, State, locking, drift, and rollback system.

**Terragrunt and PR automation frameworks** improve repository-driven Terraform
workflows but are not an embeddable multi-tenant product domain or execution
contract.

## Consequences

- Adding a provider does not change core vendor branches.
- Provider conformance tests and version compatibility become release gates.
- State backend design, locking, plan retention, and disaster recovery are
  product responsibilities.
- Cross-cloud actions are explicit sagas with partial-success semantics.
- The TypeScript product remains independent of one IaC engine or provider.
- A Provider Adapter is larger than a thin API client because it owns modules,
  discovery, normalization, and conformance evidence.
