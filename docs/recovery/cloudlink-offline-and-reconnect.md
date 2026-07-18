---
title: CloudLink offline and reconnect recovery
description: Preserve edge authority and reconcile sessions, cursors, and acknowledgements after CloudLink interruption
updated: 2026-07-18
status: partial
---

# CloudLink offline and reconnect recovery

Use this runbook after broker, network, cloud process, or Gateway connectivity
is interrupted. Disconnection makes cloud observations stale; it does not prove
that the Gateway or physical devices stopped.

## Implemented today

- Transport-neutral session open, heartbeat, session generation fencing, resume
  cursor, and current-session query semantics exist.
- Experimental MQTT transport and broker fault evidence exercise reconnect
  behavior.
- The PostgreSQL telemetry slice acknowledges accepted telemetry only after its
  durable transaction and can reproduce the same acknowledgement.
- A newer authenticated session generation fences an older generation.

## Not implemented

Production credential lifecycle, complete per-uplink authentication, durable
multi-instance session ownership, production CloudLink composition, flow
control, durable command delivery, and full joint conformance remain planned.
The current foundations are not a deployable automatic reconnect service.

## Safe response

1. Leave commissioned AetherEdge acquisition, deterministic rules, interlocks,
   and physical control running locally.
2. Mark cloud projections stale using their last observation time. Never present
   them as live state.
3. Reconnect only with an active credential, supported protocol version, valid
   challenge, and a newer session generation.
4. Resume from the cloud's last durable acknowledgement cursor. The edge may
   replay unacknowledged idempotent facts; the cloud must de-duplicate them.
5. Do not replay a physical command merely because its connection closed.
6. Reject digest conflicts, sequence gaps that cannot converge, and traffic from
   fenced session generations.

## Escalate

Escalate credential rejection, signature or identity mismatch, persistent cursor
gaps, data-loss evidence, conflicting replay, or repeated old-generation
connections. Ordinary loss and bounded reconnect need no human confirmation,
but an agent must stop automatic recovery when identity or durable ordering is
uncertain.

Read [CloudLink reliability and lifecycle](../concepts/cloudlink-and-core-state-machines.md),
the [CloudLink transport reference](../reference/cloudlink-mqtt-v1.md), and the
[edge-cloud authority boundary](../concepts/edge-cloud-boundary.md).
