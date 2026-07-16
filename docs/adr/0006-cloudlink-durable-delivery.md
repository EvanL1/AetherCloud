---
title: "ADR-0006: CloudLink sessions and durable delivery"
description: Fence authenticated sessions and acknowledge cloud-edge data only after durable acceptance
updated: 2026-07-16
status: normative
---

# ADR-0006: CloudLink sessions and durable delivery

## Status

Accepted on 2026-07-14. The session domain/application/memory foundation and an
experimental JSON/MQTT codec, bridge, ingress lifecycle, contract fixtures, and
real-broker harness are implemented. A PostgreSQL telemetry transaction now
persists an exact ACK outbox projection, and an application-owned leased worker
delivers it after commit. PostgreSQL session/epoch storage, production identity,
durable data-loss facts, backpressure, and deployed database/worker composition
remain planned. ADR-0014 owns the experimental MQTT binding.

## Context

AetherCloud needs long-lived connections to many independently operating edge
runtimes. Connections fail, overlap during reconnect, deliver duplicates, and
can resume after either process has lost volatile state. Treating the stream as
an RPC control bus would bypass application policy and make safe retry
impossible.

## Decision

1. CloudLink runs in an independent composition root and calls the same
   application use cases as HTTP, CLI, and MCP interfaces.
2. A successful connection negotiates an explicit protocol version and obtains
   a monotonic session epoch. A newer epoch fences every older connection for
   that Gateway.
3. Each logical stream has its own sequence and durable acknowledgement cursor.
   Protocol 64-bit values remain lossless and are never silently converted to a
   JavaScript `number`.
4. Duplicate messages with the same identity and digest receive the prior
   acknowledgement. Gaps and conflicting duplicates do not advance the cursor.
5. AetherCloud acknowledges ingress only after the inbox identity and business
   fact are durably accepted. Reconnect resumes from the cloud's durable cursor,
   not from an unverified client position.
6. Flow control uses explicit bounded credit or windows. Buffer overflow,
   retention loss, and replay gaps are observable facts.
7. Outbound desired state and governed Jobs enter an application-owned mailbox.
   HTTP handlers and application use cases never write directly to a live
   socket.
8. CloudLink does not expose arbitrary RPC, direct SHM or register writes,
   ungoverned physical control, unpublished artifact activation, or a way to
   clear an edge-authoritative alarm.
9. Heartbeat freshness is a connection projection. It is not proof that
   downstream devices are healthy.

## Consequences

- The implemented PostgreSQL telemetry inbox/cursor/receipt/ACK transaction is
  necessary but not sufficient for a production CloudLink release; session,
  credential, loss-marker, and production composition durability remain gated.
- Protocol conformance tests must cover duplicate, gap, reorder, reconnect,
  fencing, backpressure, and acknowledgement-after-crash behavior.
- Telemetry, deployment, and Job state machines stay in their bounded contexts;
  CloudLink owns transport delivery, not their business meaning.
- A transport or broker binding must preserve the same application contracts
  and durable cursors. MQTT transport delivery never substitutes for the
  application acknowledgement; see [ADR-0014](0014-cloudlink-mqtt-transport-binding.md).
