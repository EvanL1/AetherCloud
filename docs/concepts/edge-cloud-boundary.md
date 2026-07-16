---
title: Edge, AetherCloud, and provider authority
description: Assign live, desired, and actual state across edge runtimes, AetherCloud, and infrastructure providers
updated: 2026-07-16
status: normative
---

# Edge, AetherCloud, and provider authority

Wide-area connectivity and provider APIs are unreliable coordination paths, not
control buses. For every cross-boundary feature, identify the authority, the
projection, and the behavior during disconnection before choosing a transport.

| Concern                    | Authority               | Remote representation                        |
| -------------------------- | ----------------------- | -------------------------------------------- |
| Current point value        | AetherEdge SHM          | Time-stamped telemetry projection            |
| Device acquisition         | AetherEdge runtime      | Connection and health observation            |
| Local safety and rules     | AetherEdge runtime      | Versioned configuration and audit projection |
| Commissioned channel state | AetherEdge local store  | Desired/applied revision status              |
| Tenant and user access     | AetherCloud             | Bounded grants delivered to an edge          |
| Fleet membership           | AetherCloud             | Enrolled gateway identity                    |
| Published artifact         | AetherCloud             | Verified local artifact cache                |
| Job intent                 | AetherCloud             | Locally validated accepted/rejected job      |
| Physical command result    | AetherEdge runtime      | Receipt and audit record                     |
| Desired cloud placement    | AetherCloud             | Provider-scoped deployment plan              |
| Actual cloud resource      | Infrastructure provider | Normalized inventory projection              |
| Infrastructure state       | Stack remote backend    | Metadata and version reference               |
| Provider capabilities      | Infrastructure provider | Versioned adapter capability projection      |

## Desired and applied are separate facts

A deployment request changes cloud desired state. It does not prove that an edge
downloaded, validated, activated, or retained the artifact. The edge reports an
applied revision with evidence, and the cloud records both values without
silently reconciling them.

## Jobs, not remote procedure calls

Work that crosses the boundary carries at least:

- a globally unique job identity
- tenant, gateway, and capability identity
- typed arguments and contract version
- issue and expiry time
- idempotency key and retry policy
- required permission, risk, and confirmation evidence
- desired revision or other precondition

The edge returns a state transition such as accepted, rejected, expired,
running, succeeded, or failed. A network timeout means the result is unknown;
it is not permission to repeat a non-idempotent physical action.

Infrastructure work follows the same job semantics. Planning is a query-like,
read-only operation; apply and destroy are commands with explicit permissions,
saved-plan evidence, idempotency controls, confirmation policy, and audit.

## Disconnection behavior

An edge durably buffers bounded uplink data, continues local behavior, and
reconnects with an explicit resume position. The cloud tolerates duplicate
delivery and acknowledges only data it has durably accepted. Retention overflow
must be observable rather than hidden.

## AI boundary

An AI agent may explain observed divergence or propose a deployment plan. It
cannot redefine which side is authoritative. Any future command exposed to an
agent uses the same governed job flow as a human or API client.
