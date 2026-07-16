---
title: "ADR-0014: Experimental CloudLink MQTT transport binding"
description: Bind the provisional CloudLink candidate to operator-selected MQTT without weakening identity or durable acknowledgement boundaries
updated: 2026-07-15
status: normative
---

# ADR-0014: Experimental CloudLink MQTT transport binding

## Status

Accepted on 2026-07-15 for the experimental CloudLink MQTT binding. AetherCloud
and AetherIot execute byte-identical provisional core fixtures, but production
message-origin key lifecycle and the signed-ACK profile are not production
ready. Alpha.3 freezes an experimental transcript and unsigned application ACK,
not production credentials or signatures. This is not evidence that dual-process interoperability or
crash-durable persistence gates have passed.

## Context

CloudLink is an application protocol, not a synonym for one transport. MQTT is
useful because many customers already operate a broker, but requiring an
AetherCloud-owned broker would add cost and migration friction. Conversely, a
Gateway ID copied into a topic or payload is only a routing claim. The broker
connection, topic ACL, CloudLink establishment proof, and active session fence
must work together; none may be silently treated as the others.

The AetherIot compatibility MQTT adapter also has installed users and
established topics. Replacing it in place would conflate migration with a new
delivery contract. MQTT PUBACK proves broker delivery, not durable acceptance
by the AetherCloud application.

## Decision

1. CloudLink remains transport-neutral. MQTT v3.1.1 is the first executable
   binding; MQTT 5 may be selected but correctness cannot depend on MQTT 5-only
   expiry, response-topic, correlation, or session properties.
2. The Broker URL, authentication, TLS trust, and topic prefix are operator
   configuration. A reachable customer-selected broker is first-class. An
   AetherCloud-managed broker is optional, not required.
3. A private broker that AetherCloud cannot reach requires a future
   customer-controlled site connector or bridge. That component must preserve
   identities, application acknowledgements, bounded buffering, and audit; it
   cannot translate CloudLink into direct device control.
4. Uplinks and downlinks use versioned per-Gateway topics, QoS 1, and
   `retain=false`. Retained or non-QoS-1 uplinks are discarded before
   application routing. MQTT PUBACK never advances a CloudLink durable cursor.
5. Topic and payload Gateway IDs must match, but neither authorizes a caller.
   The current `session-hello` proof is a codec sentinel, not production
   message-origin authentication. Generic shared-Broker mode requires a
   Cloud-signed challenge, a Gateway establishment signature, and
   session-bound Gateway signatures on later uplinks. A reviewed trusted
   connector or Broker-specific adapter may instead supply verified publisher
   attestation out of band for every publish. Payload-supplied attestation is
   never trusted. Alpha.3 fixes the experimental transcript; production key
   lifecycle and signed-ACK bytes remain planned.
6. Only `session.hello`, heartbeat, Runtime Manifest report, acquisition-owned
   Point telemetry, and explicit data-loss evidence enter this binding.
   Durable ACK and replay request are Cloud downlinks. There is no arbitrary
   RPC, retained command, direct SHM/register write, or physical-control topic.
7. MQTT input is decoded strictly and bounded to 256 KiB. Unknown fields,
   unsupported versions, unsafe integer encodings, topic/body mismatch,
   contextually stale session epochs, writable Point kinds, and malformed
   manifests fail closed.
8. The MQTT interface invokes existing application commands. Only a successful
   application result with a durable telemetry receipt may produce a business
   ACK. The current memory adapters prove behavior but are not production
   durability.
9. The CloudLink composition root is independently startable from HTTP and
   workers. An injected low-cardinality observer permits OpenTelemetry wiring;
   observer/export failure cannot alter message or acknowledgement semantics.
10. The AetherIot legacy MQTT adapter is retained. Its `legacy`, experimental
    `cloudlink-v1`, and measured `dual` modes remain distinct. Legacy removal
    requires a later ADR, a supported migration window, zero supported
    dependencies, rollback evidence, and joint protocol conformance.

## Topic set

```text
{prefix}/v1/gateways/{gatewayId}/up/session
{prefix}/v1/gateways/{gatewayId}/up/heartbeat
{prefix}/v1/gateways/{gatewayId}/up/manifest
{prefix}/v1/gateways/{gatewayId}/up/telemetry
{prefix}/v1/gateways/{gatewayId}/up/data-loss

{prefix}/v1/gateways/{gatewayId}/down/session
{prefix}/v1/gateways/{gatewayId}/down/ack
{prefix}/v1/gateways/{gatewayId}/down/replay
```

Alarms, deployments, governed Jobs, and physical capabilities require
separately reviewed message contracts. They are not implied by wildcard
subscriptions.

## Consequences

- Customers can use a reachable existing broker when it can enforce a dedicated
  Gateway namespace and authenticated ACLs.
- A broker that cannot provide publisher isolation requires a trusted connector
  or an explicitly reviewed attestation adapter; a session ID alone is not
  authentication.
- Private brokers require an additional connector deployment and operational
  ownership.
- A broker or Cloud outage cannot stop commissioned AetherIot acquisition,
  rules, alarms, history, safety interlocks, or local control.
- PostgreSQL production adapters and the dual Edge/Cloud harness remain release
  gates even though both codecs consume identical provisional core fixtures.
- The ordered authentication, wire, fixture, dual-harness, fault-injection,
  crash-durability, and legacy-cutover gates are normative in
  [ADR-0015](0015-cloudlink-interoperability-release-gates.md).
