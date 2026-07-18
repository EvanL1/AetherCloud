---
title: Emergency capability revocation
description: Remove cloud command exposure during a safety incident without claiming a cloud-side physical emergency stop
updated: 2026-07-18
status: planned
---

# Emergency capability revocation

Use this runbook when cloud or agent control must be contained immediately.
Emergency capability revocation is not the same as proving that a physical
effect stopped.

## Implemented today

- Device control is deny by default.
- The experimental fixed Home Assistant power action is absent unless read-only
  discovery, control enablement, its application use case, and trusted
  governance are explicitly composed.
- The action is high risk, requires explicit confirmation, and remains subject
  to AetherEdge local authorization and safety policy.
- Cloud cancellation is intent only; it never fabricates a stopped outcome.

## Not implemented

AetherCloud has no production identity service, permission-revocation command,
Gateway emergency isolation command, agent kill switch, credential revocation
workflow, public emergency interface, or cloud-side physical emergency stop.
`integration.webhook.subscription.disable` applies only to webhook delivery and
must not be represented as device-control revocation.

## Safe response

1. Use the independent human emergency path appropriate to the site and device.
   Do not wait for an agent when people, equipment, or property may be at risk.
2. Remove the affected command tool from the production composition or revoke
   its identity and permission at the currently authoritative identity system.
3. Isolate the affected broker or Gateway credential through its authoritative
   external control when available.
4. Preserve AetherEdge local acquisition, deterministic rules, interlocks, and
   safe behavior unless the site's human procedure explicitly requires local
   isolation.
5. Mark outstanding command outcomes unknown until edge or physical evidence
   resolves them. Do not claim that revoking cloud access reversed an effect.
6. Preserve confirmation, command, Receipt, session, and audit evidence.

## Escalate

Emergency revocation always requires a direct human-accessible control and a
named incident owner. Human confirmation is mandatory before re-enabling any
affected command capability. Credential disclosure, unexplained physical
effects, or inability to reach the edge requires security and site-safety
escalation.

Read [governed Home Assistant power control](../concepts/home-assistant-governed-control.md),
[edge and cloud authority](../concepts/edge-cloud-boundary.md), and
[AI invariants](../../ai/invariants.md).
