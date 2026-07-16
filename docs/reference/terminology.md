---
title: Terminology
description: Resolve AetherCloud terms before naming contracts or database records
updated: 2026-07-16
status: normative
---

# Terminology

**Applied revision** — A revision an edge reports as successfully activated.
It is not inferred from a download or cloud request.

**Capability** — A typed query or command exposed through the application
layer, with permission and safety metadata.

**Capability job** — Durable cloud intent for an edge capability, including
expiry, idempotency, preconditions, authorization evidence, and audit context.

**Cloud connection** — Tenant-scoped configuration that selects one explicit
provider identity, account or subscription scope, and secret reference.

**CloudLink** — The versioned, authenticated protocol between AetherCloud and
an AetherEdge runtime. It is not a device protocol.

**Control-plane cell** — One independently operated API, CloudLink, worker,
PostgreSQL, and object-storage placement with one authoritative transactional
writer topology. A Tenant has an explicit home cell.

**Connected** — A gateway has a sufficiently recent authenticated CloudLink
session. This does not imply that downstream devices are online.

**Desired revision** — The cloud-authored target revision for a gateway or
deployment group.

**Deployment stack** — The smallest provider-scoped unit that is planned,
locked, applied, recovered, and destroyed independently, with one remote State.
Its isolation key is derived from its Tenant, Project, Cloud Connection, and
Stack identities.

**Edge** — One commissioned AetherEdge runtime and its local authority. Edge and
gateway are related but not interchangeable in protocol contracts.

**Enrollment claim** — A Tenant/Project/Gateway-bound, expiring bootstrap claim
used to bind a registered Gateway to credential-request evidence. It is not a
long-lived API or CloudLink credential.

**Gateway credential generation** — One independently revocable generation of
long-lived Gateway identity material. Recovery creates a new generation.

**Gateway** — The cloud resource representing an enrolled AetherEdge runtime
identity.

**Instance** — A thing-model instance owned by one gateway.

**Infrastructure engine** — An adapter that plans versioned provider modules.
OpenTofu is the default; Terraform is compatible through the same application
port. The implemented port deliberately exposes no Apply operation.

**Saved Plan** — An engine-generated, immutable proposal for one Deployment
Stack and one State. AetherCloud retains an encrypted artifact reference,
digest, lock evidence, version, change summary, and policy result; approval or
Apply is a separate fact.

**Plan artifact** — The encrypted external object containing an engine's saved
Plan. Its binary and raw JSON can contain sensitive values and never belong in
logs, prompts, audit payloads, or normalized records.

**Placement** — AetherCloud's desired choice of provider connection, region,
and constraints for a workload. It is not proof that resources exist.

**Point** — A typed measurement, status, command, or adjustment member of an
instance.

**Projection** — An AetherCloud representation derived from an authoritative
edge or provider fact, such as telemetry history, applied state, or cloud
inventory.

**Provider Adapter** — A capability-driven plugin that owns provider
authentication, discovery, provider-specific modules, normalized observations,
and conformance evidence.

**Provider database profile** — Provider-specific evidence for a managed or
self-hosted PostgreSQL placement, including version, HA, backup, encryption,
network, extension, replica, region, RPO/RTO, cost, and native extensions. It is
not the application persistence contract.

**Reported state** — A time-stamped edge observation. It may become stale and
does not overwrite desired state.

**Site** — A durable physical or logical location that can contain gateways.

**State** — An infrastructure engine's durable mapping between a deployment
stack and provider resources. It is remote, locked, versioned, encrypted, and
never shared across provider connections.

**Tenant** — The primary security and data-isolation boundary.

Use the [resource model](../concepts/resource-model.md) for ownership and
identity rules.
