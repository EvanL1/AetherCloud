---
title: Resource model
description: Use cloud connection, deployment stack, fleet, and edge resource vocabulary consistently
updated: 2026-07-14
status: mixed
---

# Resource model

AetherCloud uses explicit IoT nouns instead of a universal entity table. The
model can gain typed relationships later, but the foundational ownership and
identity hierarchy remains visible.

```text
Tenant
└── Project
    ├── CloudConnection
    │   └── DeploymentStack
    │       └── CloudResourceProjection
    └── Site
        └── Gateway
            └── Instance
                └── Point
```

## Core resources

**Tenant** is the security, billing, retention, and data-isolation boundary.
Every owned aggregate and event includes a tenant identity.

**Project** groups sites and artifacts for an application or operational team.
It is not a substitute for tenant authorization.

**CloudConnection** references one explicitly selected provider identity and a
short-lived credential source. It records configuration and discovery status,
never raw long-lived credentials.

**DeploymentStack** is the smallest independently planned, applied, locked, and
recovered infrastructure unit. It belongs to exactly one cloud connection and
uses exactly one remote State binding. Its Tenant, Project, Provider,
Connection, and State key are derived rather than repeated as caller-provided
values. Region placement retains its observation time for future freshness
policy. The domain definition is implemented; persistence and lifecycle
execution are planned.

**CloudResourceProjection** is AetherCloud's normalized, time-stamped view of a
provider resource. The infrastructure provider remains authoritative for the
resource's actual existence and lifecycle state.

**Site** is a physical or logical operating location that remains meaningful
while gateways are replaced.

**Gateway** is one enrolled AetherIot runtime identity. A reinstall or hardware
replacement must follow an explicit identity-recovery workflow.

The implemented Gateway foundation distinguishes registration, a short-lived
enrollment claim, and claim consumption. Active credential binding, CloudLink
session, runtime health, revocation, and recovery remain separate planned facts.

**Instance** is an edge thing-model instance reported by a gateway. Its cloud
identity includes its gateway context; edge-local numeric identifiers are not
globally unique.

**Point** is a typed measurement, status, command, or adjustment point within an
instance. The cloud stores metadata and historical projections, not the
authoritative live value.

## Identity rules

- Public resource identities are opaque strings, normally UUIDs.
- Edge-local sequence values and identifiers preserve their original integer
  width in wire contracts.
- Display names are mutable and never used as durable foreign keys.
- Provider identities are explicit, stable, lower-case identifiers; they are
  never inferred from credential shape.
- Portable capabilities use core names. Provider-specific capabilities use a
  namespaced identifier so the common model stays open-ended.
- Moving a gateway between tenants is an explicit security-sensitive workflow,
  not an ordinary update.
- Domain Packs add typed metadata and knowledge; they do not replace the core
  ownership hierarchy.

## State vocabulary

Use `desired` for a cloud-authored target, `reported` for an edge observation,
and `applied` only when the edge reports successful activation. Use `connected`
for a recent authenticated session, not as proof that devices behind the
gateway are healthy.

See the [terminology reference](../reference/terminology.md) before adding new
state names. See [Gateway identity and enrollment](gateway-identity-and-enrollment.md)
for the implemented foundation and explicit exclusions.
