---
title: "ADR-0006: CloudLink sessions and durable delivery"
description: Fence authenticated sessions and acknowledge cloud-edge data only after durable acceptance
updated: 2026-07-14
status: normative
---

# ADR-0006: CloudLink sessions and durable delivery

## Status

Accepted on 2026-07-14 as a planned protocol decision. No CloudLink executable,
Protobuf contract, or production session store is implemented yet.

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

- PostgreSQL inbox/outbox and cursor transactions precede a production
  CloudLink release.
- Protocol conformance tests must cover duplicate, gap, reorder, reconnect,
  fencing, backpressure, and acknowledgement-after-crash behavior.
- Telemetry, deployment, and Job state machines stay in their bounded contexts;
  CloudLink owns transport delivery, not their business meaning.
- A broker may be introduced only after measured throughput or isolation needs,
  and must preserve the same application contracts and durable cursors.
