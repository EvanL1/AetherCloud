---
title: "ADR-0015: CloudLink interoperability release gates"
description: Gate a pinned public core on shared-Broker identity, complete fixtures, dual-harness fault injection, and crash-durable acknowledgements before legacy cutover
updated: 2026-07-16
status: normative
---

# ADR-0015: CloudLink interoperability release gates

## Status

Accepted on 2026-07-15 as the interoperability release policy. The public
AetherContracts `v0.1.0-alpha.3` release is the sole authority, and both
products pin the same complete adoption closure with no pending imports. The
candidate must not become the default until production gates pass. Release
distribution is not by itself a successful real-Broker run or durability
evidence. The separate opt-in dual harness now supplies alpha run and fault
evidence. A PostgreSQL telemetry acceptance transaction, exact ACK outbox, and
leased delivery use case now demonstrate the telemetry portion of the
crash-durable contract. They do not pass the full production authentication or
durability gates.

## Context

The repository-local candidates previously disagreed on envelope vocabulary,
identity, time, digest coverage, cursor semantics, telemetry facts, and durable
ACK shape. The joint candidate resolves the core application wire contract
without pretending that production key lifecycle or Broker deployment is done.

A topic or payload does not prove publisher identity. Direct shared-Broker alpha.3
therefore requires authenticated per-Gateway Broker ACLs, a bounded
establishment proof verified by the Cloud application, and monotonic session
fencing. If the Broker cannot isolate publishers, a trusted connector or
reviewed Broker-specific principal-attestation adapter is required. Session ID
alone is never authorization.

## Decision

CloudLink v1 cannot replace legacy MQTT until these ordered gates pass:

1. **Shared-Broker message-origin authentication.** The current challenge and
   Gateway signature objects freeze the alpha.3 proposal, not a production key
   lifecycle. Generic Broker mode requires the frozen replay-bounded establishment signature and
   a session-bound Gateway signature on every later uplink. The reviewed
   alternative is trusted out-of-band Broker principal attestation for every
   delivered publish. Per-Gateway ACLs remain defense in depth. Production
   key provisioning, rotation, revocation, verifier ownership, and future
   Cloud-signed ACK projection remain unresolved. Alpha.3 ACKs are unsigned.
2. **Trusted connector/attestation alternative.** Where a Broker cannot expose
   an isolated Gateway namespace, a customer-controlled connector or reviewed
   adapter may supply verified out-of-band publisher-principal metadata. Bytes
   copied from an MQTT payload are always untrusted.
3. **One wire profile.** The public AetherContracts core is closed snake_case UTF-8 JSON,
   canonical uint64 Unix-millisecond strings, lowercase UUID Gateway/session
   identities, explicit stream epoch and atomic-batch position, and SHA-256 over
   RFC 8785 canonical `{protocol_version,message_kind,payload}`. Batch and
   receipt IDs are bounded opaque values. The exact durable ACK binds session,
   stream, epoch, position, batch, digest, and Cloud receipt. MQTT PUBACK is not
   that ACK.
4. **Identical fixtures.** Both repositories execute the same public valid,
   structurally invalid, and context-invalid fixtures with the agreed
   classification. The alpha.3 consumer lock and both codec suites cover the
   complete public fixture manifest.
5. **Real-Broker dual harness.** One opt-in test runs the AetherEdge harness and
   AetherCloud ingress through one real Broker and proves session/resume,
   Runtime Manifest, telemetry, and application ACK behavior.
6. **Fault injection.** The joint harness injects disconnect, ACK loss, Edge and
   Cloud restart, duplicate delivery, conflicting digest, gap, and explicit
   data loss. No conflict or gap receives a false successful ACK.
7. **Crash-durable Cloud ACK.** Production persistence atomically commits
   credential/session scope, inbox identity, cursor, business fact or loss
   marker, receipt, audit, and ACK outbox. A pre-commit crash emits no ACK; a
   post-commit crash republishes the identical ACK without another fact. Any
   future ACK signature is a separately versioned enhancement, not a hidden
   alpha.3 field.
8. **Legacy cutover.** Legacy remains default until all preceding evidence
   passes in both repositories. Cutover is explicit and reversible. This work
   adds no physical control, direct SHM write, or device-register write.

Machine-readable AetherCloud readiness lives in
`contracts/cloudlink/v1/interoperability-gates.json`. A
local status is non-authoritative implementation evidence, not a public gate
definition or production passage.

## Consequences

- The former Cloud-only `1.0-cloud.1` vocabulary and repository-local shared
  authority are superseded by the public AetherContracts release. Local files
  remain product integration copies or proposals.
- Production credential lifecycle and full crash-durable Cloud persistence
  remain incomplete. The dual Edge/Cloud harness, fault matrix, and PostgreSQL
  telemetry slice are implemented evidence but do not pass the complete gate.
- PostgreSQL now proves atomic telemetry fact/receipt/ACK-outbox behavior and
  identical post-commit recovery. Session/credential and loss-marker
  persistence plus production root/worker wiring are still required. MQTT
  PUBACK and memory receipts remain test/transport evidence.
- Optional Thing Model binding is never fabricated. The Cloud batch-to-record
  position mapping remains a Cloud application concern.
- Physical control remains outside this interoperability milestone.
