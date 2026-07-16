---
title: Pre-release CloudLink MQTT v1
description: Review alpha.3 Broker evidence and the PostgreSQL telemetry ACK slice without overstating full CloudLink authentication or crash durability
updated: 2026-07-16
status: mixed
---

# Pre-release CloudLink MQTT v1

This is an experimental, pre-release interoperability candidate. The public
AetherContracts `v0.1.0-alpha.3` release is the sole contract authority, and
AetherCloud and AetherIot commit the same digest-pinned consumer lock. The
current claim is complete distribution adoption and public fixture execution,
not production protocol conformance. Shared-Broker production key lifecycle is
still unresolved, and alpha.3 durable ACKs are explicitly unsigned.

## Public release consumption

The offline consumer check pins the annotated tag object, commit, bundle size
and SHA-256, release manifest SHA-256, and each adopted destination byte. It
imports the exact alpha.3 adoption closure, including the normative spec,
profiles, gates, failure taxonomy, TCK manifest, Schemas, fixtures, and verifier
closure. `pending_imports` is empty.

The local `contract-manifest.json`, `wire-profile.json`, authentication Schema,
gate file, and scenarios are integration history or AetherCloud proposals. They
do not override AetherContracts. Distribution integrity alone is not codec or
behavioral conformance. The complete public fixtures and opt-in dual harness now
provide alpha evidence, while authentication and production durable-store gates
remain open. The default check is offline; the opt-in CI check downloads only
the exact digest-pinned release.

## Implemented Cloud surface

- `adapters/cloudlink/mqtt` strictly decodes the pinned public snake_case session,
  heartbeat, Runtime Manifest, telemetry, and data-loss uplinks and encodes
  session, heartbeat/durable ACK, and replay downlinks.
- The codec validates topic/body Gateway binding, UUID identity, canonical
  integers/times, JCS business digests, Runtime Manifest checksum, Point kinds,
  topology evidence, limits, and unknown fields.
- MQTT.js accepts configurable endpoint, Broker credentials, strict CA/client
  certificate/private-key file mTLS, MQTT 3.1.1 or MQTT 5, QoS 1, and
  `retain=false`; correctness uses only the 3.1.1 baseline. TLS files must be
  bounded regular non-symlink files, and a private key must deny group/other
  access.
- `apps/cloudlink` routes through existing application use cases and produces no
  ACK without an application receipt. For telemetry, the bridge can consume the
  exact ACK projection committed by `PostgresTelemetryRepository`; the current
  Broker harness roots still use memory and are conformance evidence, not
  production durability.
- The current Cloud telemetry model safely maps only a one-sample wire batch
  because it indexes records while alpha.3 positions an atomic batch. Larger
  batches fail explicitly until Cloud freezes that internal mapping. Data-loss
  persistence is also planned; the alpha harness records an application fact
  but does not claim production durability.
- Default tests need no Broker, Docker, PostgreSQL, or cloud account. The opt-in
  alpha harness starts real Mosquitto, AetherIot's rumqttc transport and file
  spool, plus AetherCloud's MQTT ingress and application use cases.

## Provisional wire boundary

The normative public core is in the locked AetherContracts release. The local
`contracts/cloudlink/v1/wire-profile.json` records an earlier Cloud proposal
and migration differences; it is not shared authority:

- closed snake_case UTF-8 JSON, 256 KiB maximum;
- MQTT 3.1.1, QoS 1, non-retained messages;
- canonical uint64 strings and Unix epoch milliseconds;
- lowercase UUID Gateway/session identity;
- one stream position per atomic batch, at most 256 Point samples;
- RFC 8785 JCS SHA-256 over
  `{protocol_version,message_kind,payload}` only;
- stable epoch, position, batch ID, and digest across replay;
- durable ACK bound to session, stream, epoch, position, batch, digest, and
  Cloud receipt;
- explicit replay request and data-loss evidence;
- no RPC, physical-control topic, SHM write, Point/Register write, or fabricated
  Thing Model revision.

Telemetry retains Edge-owned `instance_id`, `point_kind`, `point_id`, value,
source timestamp, quality, and topology evidence. `model` is optional and may
appear only when commissioning established it.

## Session and shared-Broker boundary

The alpha.3 hello declares either `gateway-signed` or
`trusted-connector-broker-attestation` origin. Gateway-signed hello carries the
exact challenge ID, Gateway key ID, and structurally validated Ed25519
signature object. This proves the frozen codec shape, not production message
origin or production key lifecycle. One successful hello is insufficient when
a different publisher can later inject into a shared namespace.

Generic customer-selected Broker mode therefore requires a replay-bounded
Cloud challenge and Gateway signature, followed by a session-bound Gateway
signature on every uplink. Cloud challenges use the experimental Cloud
signature transcript; alpha.3 durable ACKs are unsigned. The alternative is
trusted Broker attestation supplied by a trusted adapter outside the payload
for every publish.
Payload-supplied attestation is untrusted, and topic identity is untrusted.
Production key provisioning, rotation, revocation, and verifier ownership keep
the authentication gate a proposal.

| Mode                               | Requirement                                              | Status                                             |
| ---------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| Reachable customer-selected Broker | Dedicated namespace, TLS, challenge/per-message proof    | Transport adapter implemented; origin auth planned |
| AetherCloud-managed Broker         | Same CloudLink application/session boundary              | Broker product/principal integration planned       |
| Private customer Broker            | Site connector preserving identity, spool/ACK, and audit | Planned                                            |
| Legacy AetherIot MQTT              | Separate namespace, never silently decoded as CloudLink  | Retained during migration                          |

MQTT PUBACK is transport evidence only and never authorizes deletion from the
AetherIot spool.

## Evidence and remaining gates

The consumer lock pins the complete public manifest: all 25 public fixture
bytes execute in both products, and pending imports are empty. Local
fixture/gate files are evidence overlays only.

| Gate                                                                  | State                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Shared-Broker message-origin authentication                           | In progress                                                                           |
| Single envelope/time/identity/digest/unsigned-ACK profile             | Implemented alpha.3; production auth remains experimental                             |
| Cross-repository fixtures                                             | Passed for the alpha.3 public manifest                                                |
| Real-Broker dual Edge/Cloud harness                                   | Local Mosquitto and AWS IoT Core alpha evidence; authentication gate remains proposal |
| ACK loss, restart, duplicate, conflict, and data-loss fault injection | Implemented alpha evidence; process crash durability excluded                         |
| PostgreSQL crash-durable ACK/outbox                                   | Telemetry acceptance PostgreSQL slice implemented and verified; full gate blocked     |
| Legacy cutover                                                        | Blocked until every preceding gate passes                                             |

The telemetry acceptance transaction, exact ACK outbox, and bounded delivery
use case are implemented. The full crash-durable CloudLink gate remains blocked:
production composition is planned, and credential/session persistence,
data-loss facts, multi-sample mapping, and alpha.3 production authentication
remain incomplete. Legacy remains default. Cloud outage cannot change Edge
authority or stop acquisition, rules, alarms, safety interlocks, or local
control. There is no physical control in this slice.

## Opt-in dual Edge/Cloud alpha harness

```bash
pnpm test:cloudlink-dual
```

The command selects a unique topic prefix, starts and restarts local Mosquitto,
runs both product transports, and writes machine-readable evidence to
`evidence/cloudlink-alpha3-dual-harness.json` (and a compatibility copy under
`artifacts/cloudlink-alpha/evidence.json`). It covers ACK loss, separate Edge
process recovery, the Cloud-owned `manifest/1/1` resume cursor, a separate
Cloud ingress process restart, exact duplicate replay, digest/batch conflict,
explicit data loss, out-of-order, expiry, and a non-durable partial application
outcome. It records Cloud restart continuity as unknown; it does not prove
production process-crash durability. Read
[ADR-0014](../adr/0014-cloudlink-mqtt-transport-binding.md)
and [ADR-0015](../adr/0015-cloudlink-interoperability-release-gates.md) for the
transport decision and ordered release gates. [ADR-0016](../adr/0016-pinned-aethercontracts-consumption.md)
defines public release authority and pinning.

## Opt-in AWS IoT Core mTLS harness

```bash
pnpm test:cloudlink-aws-iot
```

This external-service test requires an authenticated AWS CLI identity with AWS
IoT permissions. It defaults to `us-west-2` and can be moved explicitly with
`AETHER_CLOUDLINK_AWS_REGION`. The command provisions two separate X.509 client
principals and two least-privilege topic policies, creates no Thing, runs the
AetherCloud MQTT.js ingress and AetherIot rumqttc/FileCloudLinkSpool through
AWS IoT Core MQTT 3.1.1 on port 8883, and writes sanitized evidence to
`evidence/cloudlink-aws-iot-us-west-2.json`.

Certificate and private-key bytes remain in a mode-0700 temporary directory;
individual files use mode 0600 and do not enter stdout, evidence, Git, or
application logs. On every normal success or failure path the harness detaches
the policies, deactivates and deletes both certificates, deletes both policies,
and removes the temporary directory.

The AWS run covers session establishment, heartbeat, Runtime Manifest,
telemetry application ACK, ACK-loss replay, duplicate idempotency, conflicting
binding, expiry, out-of-order delivery, unsupported partial batch, explicit
data loss, and final spool drain. It proves alpha transport interoperability
through a managed Broker. It does not pass the production authentication gate:
the application does not yet consume reviewed out-of-band AWS principal
attestation or verify the planned per-uplink Gateway signatures. Alpha.3 ACKs
remain unsigned and Cloud persistence remains process-local memory.
