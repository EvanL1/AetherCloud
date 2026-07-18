---
title: Governed Home Assistant power control
description: Understand the experimental conversation-to-edge power action, its safety checks, evidence model, and current delivery limits
updated: 2026-07-17
status: mixed
---

# Governed Home Assistant power control

[Simplified Chinese](https://docs.aetheriot.workers.dev/aethercloud/concepts/home-assistant-governed-control/)

A future AetherCloud Agent can turn a request such as “switch off the bedroom
light” into one narrow, typed action. It does not send a Home Assistant service
name, arbitrary parameters, provider URL, or access token across the network.

The current source implements the cloud-side foundation for that action. It is
experimental and disabled by default. An optional transport-neutral MCP tool
exists for trusted composition roots, but there is no public Agent, MCP server,
or user API.

## Supported action

The only accepted action is `device.power.set.v1`. It sets the Boolean
`is_on` point to `true` or `false` for a current `light`, `switch`, or `fan`
entity.

Every request must bind all of the following:

- the exact Tenant, Project, Gateway, and integration;
- the current topology generation and stable entity identity;
- the fixed `is_on` point;
- an active CloudLink session and its credential generation;
- a persisted Runtime Manifest that declares
  `aether.cloudlink.integration-control.v1alpha1`;
- the `integration.device.control` permission;
- explicit confirmation, policy evidence, idempotency, expiry, and audit.

An old topology generation, a legacy `state` point, an unsupported entity
type, an expired request, or an undeclared runtime protocol fails closed.

## Control flow

```text
Person describes an outcome
  -> Agent proposes one typed power change
  -> AetherCloud checks permission, confirmation, expiry, topology, and session
  -> AetherCloud signs and records an immutable action offer
  -> AetherEdge makes the final local policy and safety decision
  -> the edge-side Home Assistant adapter attempts the provider action
  -> AetherEdge returns a signed, ordered receipt
  -> AetherCloud records evidence before acknowledging delivery
```

The cloud cannot bypass AetherEdge. AetherEdge remains authoritative for live
state, deterministic rules, safety interlocks, and physical device control.
Cloud unavailability must not stop already commissioned edge behavior.

## What a receipt proves

A receipt can say that the edge accepted or rejected the request, or that the
Home Assistant provider accepted or rejected the call. It can also preserve an
unknown result.

Provider acceptance is not proof that a lamp changed physically. Therefore
the cloud view always keeps physical completion unknown and does not call the
job successful merely because Home Assistant accepted a command. A later
read-only observation may show a state change, but it remains
freshness-labelled edge-reported evidence rather than proof of causation.

The same job identity and intent digest survive an eligible reconnect reoffer.
Once any receipt exists, the cloud does not automatically reoffer the physical
effect. Ambiguity remains visible instead of becoming permission to repeat an
action.

## Secret boundary

Home Assistant addresses, access tokens, refresh tokens, provider service
names, and arbitrary service data remain at the edge. They are forbidden in
the action intent, CloudLink payload, cloud persistence, audit details, logs,
prompts, and Agent context.

Cloud and Gateway signatures bind the immutable intent, current session, and
ordered delivery evidence. The included Node.js Ed25519 adapter accepts an
opaque key reference and a non-exported key object; production provisioning,
rotation, and revocation are still required.

## Implemented in this repository

- closed domain values for the fixed power target and receipt stages;
- strict contract decoding, canonical digests, signatures, and MQTT topic
  construction;
- application use cases for creating, reoffering, publishing, and receiving
  governed actions;
- validation against the current topology, active session, credential
  generation, and persisted Runtime Manifest;
- atomic in-memory intent, audit, outbox, receipt, replay, and acknowledgement
  behavior;
- a transactional PostgreSQL control ledger for immutable intents, offer
  outbox records, ordered receipt evidence, exact cursors, audit records, and
  durable acknowledgement outbox records; forced Tenant row-level security and
  real-database concurrency, rollback, restart, and constraint tests are
  implemented;
- Node.js Ed25519 signing and receipt verification adapters;
- an explicit, default-off `apps/cloudlink` MQTT composition that requires both
  the read-only Integration extension and the complete control dependency set,
  publishes offers on the same QoS 1 non-retained transport, restores Runtime
  Manifest declarations on reconnect, and publishes a durable ACK only after
  atomic receipt, audit, and cursor persistence;
- an optional `integration.device.power.set` MCP adapter that exists only when
  both the application command and a trusted governance resolver are injected;
- optional Integration projection catalog and by-ID MCP resources. They invoke
  separate application queries, keep discovery bounded and stably paginated,
  and label every result as an edge-reported copy rather than live truth;
- contract fixtures and behavior tests for rejected fields, replay, ordering,
  stale targets, expiry, and unknown physical outcome.

These remain source-level foundations. MQTT publication acknowledgement is
transport evidence only: it is never provider acceptance, physical completion,
or job success. The MCP adapters are not reachable without an explicit
composition root and do not let callers supply policy or confirmation
references.

## Required before user availability

- prove the default-off control composition against supported real Brokers and
  production reconnect/crash boundaries;
- wire the transactional PostgreSQL ledger into a production composition and
  prove crash-recoverable offer and acknowledgement delivery workers;
- provision, rotate, revoke, and observe production signing keys without
  exposing key material;
- complete cross-repository conformance with the released AetherContracts
  version and the AetherEdge control implementation;
- compose production identity and trusted policy/confirmation resolution around
  the existing optional MCP interface, or add another public interface that
  invokes the same typed command without a privileged shortcut;
- add household authorization, clear confirmation language, status
  explanations, and recovery guidance.

Until those gates are complete, this feature must remain disabled by default
and must not be presented as an available household control product.

Read the [Home Assistant integration](home-assistant-integration.md) for the
separate topology and observation path.
