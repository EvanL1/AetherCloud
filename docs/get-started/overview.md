---
title: AetherCloud overview
description: Understand the multi-cloud product, its authority boundaries, and the first vertical slices
updated: 2026-07-14
status: mixed
---

# AetherCloud overview

AetherCloud is the optional, AI-native multi-cloud fusion and control plane for
AetherIot. It gives people, applications, and coding agents one place to
understand fleets and cloud resources, choose placements, inspect telemetry,
publish versioned artifacts, and coordinate audited work across edge sites and
infrastructure providers.

It is not the runtime that acquires device data or closes a control loop. An
AetherIot host continues operating when AetherCloud, the wide-area network, or
an AI provider is unavailable.

## What belongs in AetherCloud

- Tenant identity, users, permissions, projects, and fleet inventory
- Cloud connections, provider capability discovery, and normalized inventory
- Placement decisions and provider-scoped deployment stacks
- Audited infrastructure plan and apply jobs
- Gateway enrollment and connection observations
- Versioned Pack, configuration, model, and application artifacts
- Separate desired, reported, and applied revision facts
- Durable telemetry and alarm projections received from an edge
- Expiring, audited capability jobs and their receipts
- APIs and documentation for human-authored and agent-authored applications

## What remains at the edge

- Device protocol sessions and acquisition
- Authoritative live point values
- Commissioned channel configuration
- Deterministic rules, alarms, interlocks, and fallback behavior
- Validation and final acceptance of work that can affect a physical system
- Bounded store-and-forward behavior during disconnection

## What remains authoritative at a provider

- The actual existence and lifecycle state of provider resources
- Provider-native identity, quotas, regions, failure domains, and capabilities
- The remote, locked infrastructure state for one deployment stack

AetherCloud owns desired placement and orchestration state, but does not pretend
that a normalized projection is the provider's actual state. Read the
[multi-cloud fusion model](../concepts/multi-cloud-fusion.md) before adding a
provider or infrastructure workflow.

Read the [authority boundary](../concepts/edge-cloud-boundary.md) before adding a
feature that crosses the network.

## Delivery sequence

The repository begins with a TypeScript modular monolith and agent-readable
contracts. Provider discovery, governed infrastructure Plan, and the Gateway
registration/claim foundation have implemented domain/application slices.
Memory adapters keep them self-contained; their production adapters and public
Tenant routes remain planned. The infrastructure engine is deliberately
Plan-only, with no Apply operation.

The IoT product sequence is Gateway identity, CloudLink session, runtime
manifest, telemetry/alarm ingestion, artifact registry, desired/reported/applied
deployment, governed Jobs, operational integration, and MCP. Each slice must be
useful without requiring the later slices. Device control is not part of the
repository-foundation milestone.

Read the [capability map](../concepts/iot-cloud-capability-map.md) for the full
bounded contexts and the [vertical-slice roadmap](../guides/iot-cloud-roadmap.md)
for phase gates and exclusions.

## Start developing

Read the [repository layout](../reference/repository-layout.md), then follow the
[agent development guide](../guides/build-with-an-agent.md). The current API
surface is documented in the [HTTP reference](../reference/http-api.md).
