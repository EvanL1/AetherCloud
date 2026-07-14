---
title: ADR-0001: Edge-first cloud control plane
description: Keep the cloud optional for deterministic edge operation
updated: 2026-07-14
status: normative
---

# ADR-0001: Edge-first cloud control plane

## Status

Accepted on 2026-07-14.

## Context

AetherIot is a deterministic edge kernel whose live state and safety behavior
must survive external-service and network failure. A cloud product is needed
for fleet identity, historical projections, artifact distribution, desired
state, audited work, and application development. Treating the cloud as a
remote runtime authority would contradict the edge product and make site safety
depend on wide-area connectivity.

## Decision

AetherCloud is a separate, optional control-plane repository. AetherIot remains
authoritative for live state, device communication, deterministic automation,
and final acceptance of physical work. AetherCloud owns tenant and fleet
identity, published artifacts, desired revisions, jobs, and cloud audit state.

Cross-boundary changes use versioned desired/applied state or expiring capability
jobs. The edge validates cloud intent under its local compatibility,
commissioning, authorization, and safety policy. Telemetry in the cloud is a
time-stamped projection, never a replacement for edge live state.

## Consequences

- A site continues operating when AetherCloud is unavailable.
- Product features must define offline, retry, duplicate, expiry, and resume
  behavior.
- Cloud UI and AI responses can be stale and must expose observation time.
- A cloud request can remain pending or be rejected by an edge.
- End-to-end tests need explicit network-partition and replay scenarios.
