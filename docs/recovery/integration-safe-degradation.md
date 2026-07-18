---
title: Integration safe degradation
description: Degrade an unhealthy device integration to bounded read-only or unavailable behavior while preserving stale-data labels
updated: 2026-07-18
status: partial
---

# Integration safe degradation

Use this runbook when an edge-owned integration reports invalid data, topology
gaps, stale observations, receipt uncertainty, or repeated delivery failure.

## Implemented today

- Experimental Home Assistant topology and observation flows keep discovery and
  acquisition at AetherEdge.
- Cloud projection queries are bounded, Tenant scoped, and labelled as
  edge-reported copies rather than live-state authority.
- Topology generation and replay rules reject conflicting or out-of-generation
  observations and support a complete resynchronization.
- Integration control is default off, fixed in scope, explicitly confirmed, and
  does not treat delivery as physical completion.
- Webhook delivery uses bounded retries and dead-letter evidence without rolling
  back the committed business result.

## Not implemented

Published alpha.4 consumption, production CloudLink and credential composition,
supported-broker evidence, production control composition, signing-key
lifecycle, a public agent service, and a governed control re-enable workflow
remain gated or planned.

## Safe response

1. Keep AetherEdge local collection, deterministic automation, and safety
   behavior independent of cloud availability.
2. Mark the cloud projection stale or unavailable. Preserve its observation time
   and never guess missing device state.
3. Remove command exposure for the affected integration while keeping bounded
   read-only discovery only when its identity and Tenant scope remain trusted.
4. Request a complete edge-owned topology and observation resynchronization
   using the existing session and Runtime Manifest boundaries.
5. Restore read access only after generation, digest, ordering, and freshness
   converge. Restore control only through explicit operator enablement and policy
   review.
6. Keep Home Assistant addresses, tokens, credentials, and provider payloads at
   the edge.

## Escalate

Escalate repeated topology conflicts, non-converging sequence gaps, credential
disclosure, unknown control outcomes, or physical safety risk. Dead-letter
redrive and control re-enablement require explicit human review; an agent must
not choose them merely to make a warning disappear.

Read [Home Assistant integration](../concepts/home-assistant-integration.md),
[governed control](../concepts/home-assistant-governed-control.md), and
[audit and integrations](../concepts/audit-and-integrations.md).
