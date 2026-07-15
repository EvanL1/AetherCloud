---
title: Multi-cloud fusion
description: Unify cloud lifecycle and policy without erasing provider capabilities or sharing one global state
updated: 2026-07-14
status: mixed
---

# Multi-cloud fusion

Multi-cloud fusion is AetherCloud's primary cloud capability. It gives tenants
one resource graph, policy model, plan workflow, and audit trail across public
clouds, private clouds, sovereign environments, and on-premises infrastructure.
It does not pretend that those providers expose identical resources.

## The common layer

AetherCloud owns a small, capability-driven vocabulary:

- provider and cloud-connection identity
- regions, zones, and placement constraints
- capabilities such as compute, object storage, private networking, managed
  Kubernetes, managed PostgreSQL, and IoT ingress
- deployment stacks, desired topology, saved plans, policy decisions, jobs, and
  normalized resource observations
- cost, quota, health, provenance, and freshness metadata

A provider advertises its available capabilities. Placement selects only a
provider connection that satisfies the requested capabilities and tenant
policy. Selection is explicit; credential shape is never used to infer a
provider.

## Current implementation

The repository currently implements the Provider descriptor, CloudConnection,
ProviderRegion observation, dynamic ProviderAdapter registry, and the
authorized tenant/project-scoped `DiscoverProviderRegions` application query.
Inputs and adapter output are runtime-validated before they become a normalized
observation. The reusable conformance suite and memory adapter make the
contract executable without a cloud account.

The domain also implements a DeploymentStack definition whose Tenant, Project,
Provider, Connection, and State key are derived from one active
CloudConnection. The State backend is an opaque remote reference; locking and
encryption are mandatory rather than caller-selected options. A placement
observation must match the same Provider and Connection before its region can
be selected, and the Stack records the canonical observation time so later
policy can reject stale placement evidence.

The application now implements the governed, tenant/project-scoped
`PlanDeploymentStack` command, dynamic OpenTofu/Terraform
`InfrastructureEngine` registry, runtime engine-output validation, change
summary, policy receipt, and idempotent Plan repository port. A shared
conformance suite, memory engine, and memory Plan repository make the contract
executable without a cloud account. A real OpenTofu CLI adapter dynamically
probes its version, verifies immutable source artifacts, runs an argv-only
saved Plan in a bounded temporary workspace, parses versioned JSON, stores the
Plan through an encrypted-artifact port, and proves an injected State-lock
lease was released. The port has no Apply operation.

Real provider SDK adapters, credential resolution, connection and
DeploymentStack persistence, inventory APIs, placement policy, production
remote State and distributed locking, encrypted object storage, a sandboxed
worker deployment, a Terraform CLI adapter, and Apply remain planned. Neither
discovery nor Plan has an HTTP route yet. Follow
[Add a Provider Adapter](../guides/add-provider-adapter.md) for discovery and
[Plan infrastructure safely](../guides/plan-infrastructure.md) for engine work
instead of inventing new boundaries.

## The provider-specific layer

Each Provider Adapter owns:

- authentication and short-lived credentials
- region, zone, quota, SKU, and price discovery
- provider-specific infrastructure modules
- provider-native capability extensions
- conversion from engine JSON and provider APIs into normalized observations
- conformance fixtures for provider-specific discovery and normalization

Namespaced extensions preserve capabilities that do not belong in the common
model. Portability means that intent and policy can be compared; it does not
mean hiding every provider feature behind a false universal API.

## Infrastructure execution

OpenTofu is the default engine. Terraform is supported through the same
`InfrastructureEngine` port. The implemented application flow selects an
immutable versioned provider module and topology, asks an engine for a saved
Plan, validates versioned JSON-derived changes and State lock evidence, then
evaluates policy and records an encrypted artifact reference. The real local
OpenTofu CLI worker is implemented; its production remote State, credential,
artifact-store, and worker-deployment adapters and every Apply path are planned.

```text
DesiredTopology
      ↓
PlacementPolicy
      ↓
Provider Adapter + versioned module
      ↓
OpenTofu/Terraform plan -out
      ↓
show -json → validation, summary, policy
      ↓
encrypted saved Plan receipt

future separate workflow:
approved exact Plan → Apply → refresh → NormalizedResourceProjection
```

The infrastructure engine calculates dependencies and proposed drift.
AetherCloud owns workflow, permissions, policy, audit, and the normalized
resource graph. A policy-approved Plan is not approval evidence and cannot be
applied through the current port. Direct provider SDKs complement the engine
for discovery, pricing, quotas, temporary credentials, and operations that are
not infrastructure lifecycle changes.

## State isolation

One State belongs to one deployment stack. A stack belongs to exactly one
tenant, provider connection, account or subscription, and primary region.
Cross-region modules may exist where a provider supports them, but one State
never spans multiple provider connections and is never tenant-global.

State uses a remote backend with locking, encryption, versioning, backup, and
retention. The implemented Plan contract requires exact State-key correlation
and acquired-and-released lock evidence. Durable lineage, serial, provider
versions, backup, and retention remain planned. Workers remain stateless and
never treat a local workspace as durable storage.

## Credentials

Cloud connections contain metadata and a secret reference, not plaintext
credentials. Workers prefer workload identity or short-lived credentials,
receive them only for the job, inject them through the provider's supported
environment or credential mechanism, and destroy the workspace afterward.
Credentials must not appear in generated modules, saved plans, logs, prompts,
or normalized resource records.

## Multi-cloud operations

Fusion occurs above individual State files:

- inventory and search across providers
- policy and placement across cost, region, sovereignty, capability, and quota
- coordinated rollouts using multiple independently auditable jobs
- data-routing intent across edge sites and cloud destinations
- normalized health and drift views with provider-native detail available

A cross-cloud rollout is a saga of provider-scoped jobs, not a distributed
transaction. Partial success remains visible and compensation is explicit.

## Control-plane database portability

`managed-postgresql` is a portable Provider capability, not a fixed vendor
product. Future provider profiles retain native engine variants, supported
versions and extensions, HA, backup, encryption, private connectivity,
replication, region, sovereignty, RPO/RTO, price evidence, and namespaced
extensions. Core persistence code remains one PostgreSQL adapter and never
branches on a provider enum.

Each AetherCloud control-plane cell has one authoritative PostgreSQL writer
topology. Managing resources across many providers does not require synchronous
cross-cloud database writes. Tenant home-cell placement, replica promotion,
disaster recovery, and migration are explicit governed workflows. See
[PostgreSQL persistence and multi-cloud cells](persistence-and-multi-cloud-cells.md)
and [ADR-0013](../adr/0013-postgresql-control-plane-persistence.md).

## Lessons retained from HPC-NOW

HPC-NOW demonstrates that a useful common lifecycle can sit above separate
provider IaC templates and that provider state can be normalized for a unified
multi-cluster view. AetherCloud retains those ideas while replacing hard-coded
vendor branches with a registry, requiring explicit provider identity, parsing
versioned JSON instead of raw State text, and separating secrets from modules.
