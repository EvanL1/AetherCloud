---
title: CloudLink reliability and lifecycle
description: Understand delivery, retries, acknowledgements, offline recovery, the restricted trusted-connector origin model, and current production limits
updated: 2026-08-01
status: mixed
---

# CloudLink reliability and lifecycle

This page mixes executable inner-layer foundations with planned end-to-end
behavior. An experimental JSON/MQTT v1 codec, application bridge, independently
startable ingress lifecycle, Schemas, fixtures, and real-broker harness now
exist, and the public AetherContracts alpha.3 release is the sole shared
authority. The opt-in real Mosquitto dual harness and fault matrix are
executable alpha evidence. They do not constitute a production process;
production authentication, complete inbox/outbox composition, and current
cross-repository conformance remain gates. Production readiness requires
authentication, one wire profile, shared fixtures, a dual
real-Broker harness, fault injection, crash-durable persistence, and an
explicit legacy cutover in that order. Transactional PostgreSQL Session,
challenge, cursor, and heartbeat-health persistence now exists, but does not by
itself prove end-to-end production authentication.

A deployable read-only Integration composition root now exists, but it runs a
restricted trusted-connector mode whose only authenticator is the Broker ACL.
Read [Trusted connector origin model](#trusted-connector-origin-model-a0-read-only-composition)
before deploying it; it is not Gateway authentication.

## CloudLink responsibility

CloudLink authenticates a Gateway credential, negotiates a protocol version,
fences sessions, transfers versioned envelopes, maintains per-stream sequence
and durable acknowledgement cursors, applies backpressure, and resumes after
disconnect. It invokes application ingestion and delivery use cases.

CloudLink does not own telemetry meaning, deployment policy, Job execution, or
alarm lifecycle. It cannot directly write SHM, a point, or a device register;
invoke arbitrary runtime methods; activate unpublished artifacts; bypass Job
confirmation; or clear an edge-authoritative alarm.

HTTP creates desired state and governed Jobs in transactional storage and an
outbox. CloudLink reads an application-owned outbound mailbox. An HTTP handler
never writes a live edge socket.

## Gateway enrollment

Implemented foundation:

```text
registered -> awaiting-claim -> claimed
                    |
                 expired
```

Planned production extension:

```text
claimed -> credential-pending -> active <-> suspended -> revoked
                                      network loss      |
                                      changes no state  v
                                                recovery-pending
                                                       |
                                              active (new generation)
```

- `now >= claim.expiresAt` rejects a claim.
- An identical claim request and credential-request fingerprint is an
  idempotent replay. A different request cannot rebind a claimed Gateway.
- A claim that succeeds before certificate issuance may resume credential
  binding without consuming a new token.
- Disconnect does not revoke identity. Revocation fences a credential
  generation; recovery never revives it.
- Registration or claim success is not evidence that CloudLink authentication
  is active.

## CloudLink session

The domain/application/memory foundation implements credential verification,
server-preference protocol negotiation, monotonic session epochs, old-session
fencing, lossless per-stream resume cursors, authenticated heartbeat, and a
Tenant-scoped current-session query. The experimental MQTT layer adds strict
wire decoding, topic/session binding, non-retained QoS-1 enforcement, an
application bridge, and lifecycle composition. Multi-instance socket ownership,
credit flow control, the complete durable inbox/outbox path, and production
Gateway-signed MQTT authentication remain planned. The one composition root that
exists today is the restricted read-only mode described below.

The PostgreSQL adapter persists Session/challenge state, durable cursors and
Gateway-signed heartbeat observations. A platform-authorized health reconciler
uses expiring PostgreSQL leases with `FOR UPDATE SKIP LOCKED` so multiple API
instances can safely persist `active -> suspect -> closed` transitions. Every
completed transition atomically updates the Session and writes Audit and Outbox
evidence. Its isolated login role is non-owner, non-superuser and `NOBYPASSRLS`;
it can scan/update Session health rows but cannot read Gateway identity tables
or delete Sessions. Heartbeat recovery racing a worker clears the lease through
revision-checked normal Session replacement, while an expired or lost lease
cannot emit evidence.

The implemented structural signature evidence is not sufficient shared-Broker
production authentication. Alpha.3 first uses a signed Cloud challenge and a
Gateway signature, then binds every generic-Broker uplink to that session with a
Gateway signature. A Broker-specific adapter may instead provide verified
out-of-band publisher attestation for every publish. Payload-supplied
attestation, topic identity, or one successful hello cannot authenticate later
messages. Cloud challenges use the proposal signature transcript; alpha.3
durable application ACKs are explicitly unsigned.

```text
authenticating -> negotiating -> resuming -> active -> draining -> closed
       |              |             |          |
    rejected       rejected      rejected    suspect -> active or closed
```

- Each authenticated connection gets a monotonic session epoch. A newer epoch
  fences the old connection, including late messages from the old socket.
- Resume begins at AetherCloud's last durable acknowledgement for each stream.
- Same identity and digest is a duplicate and receives the same acknowledgement.
  Same identity with a different digest is quarantined as a security conflict.
- A sequence gap requests replay and does not advance the cursor. Out-of-order
  envelopes may be durably buffered within a bounded window.
- Heartbeat timeout moves the connection projection to `suspect` or `closed`;
  it does not prove that the Gateway or downstream devices stopped.
- Explicit credit/window flow control and bounded queues prevent a fast sender
  from exhausting process or Tenant resources.

## Trusted connector origin model (A0 read-only composition)

`apps/cloudlink/src/runtime.ts` is an executable composition root, but it runs a
deliberately restricted mode. It enables only
`aether.cloudlink.integration.v1alpha1`, never wires the governed control path,
and never wires Gateway-signed challenge issue, Gateway-signed hello acceptance,
or per-uplink Gateway signature verification. Those three dependencies stay
absent because this repository has no production message-origin key source:
every `resolvePublicKey` implementation lives in a test or a harness script, the
only `GatewayCredentialVerifier` is the in-memory one, and
`PostgresGatewayIdentityRepository` stores an enrollment claim fingerprint
rather than an active signing credential.

Sessions therefore open through the trusted connector branch. A `session-hello`
whose `credential_binding.origin_model` is not `gateway-signed` is resolved
against operator configuration: the composition looks up the wire-supplied
Gateway ID, credential ID, and credential generation and returns the credential
the operator bound to that Gateway out of band. The credential proof is a
secret held only in cloud process configuration; it never crosses the wire, is
never persisted by AetherCloud, and never enters a log line, an error message,
or an audit payload.

Read the following as written. It is not a caveat on an otherwise authenticated
path; it describes the whole of the authentication in this mode.

- **Authentication depends entirely on Broker-side per-Gateway ACLs.** If those
  ACLs are not configured, there is effectively no authentication. The three
  values that select a credential are non-secret identifiers taken from the
  message itself, so any publisher that can reach
  `{prefix}/v1/gateways/{gatewayId}/up/...` and knows them obtains a session.
- **The ingress Broker login is not a per-Gateway ACL.** The optional ingress
  Broker username and password authenticate _AetherCloud's own subscriber
  connection_ to the Broker. They say nothing about which publishers may write a
  Gateway's uplink topics. Nothing in this repository configures, enforces, or
  verifies per-Gateway publisher ACLs, and the ingress starts successfully
  whether or not the operator created them.
- **No publisher attestation is consumed.** ADR-0014 decision 5 permits a
  reviewed trusted connector or Broker-specific adapter to supply verified
  publisher attestation out of band _for every publish_. This composition
  consumes no attestation of any kind. It assumes the Broker ACL is correct and
  has no way to detect that it is not. That gap is the difference between this
  mode and the alternative ADR-0014 decision 5 describes.
- **Scope.** This mode suits a small deployment where the operator owns the
  Broker and can confirm publisher identity out of band, such as a single-home
  Home Assistant installation. It is not Gateway authentication and must not be
  described as such. It does not support multi-tenant or multi-Gateway scale,
  and no claim of such support is warranted by this composition.

Generic shared-Broker deployments still require the ordered Gateway-signed path:
a Cloud-signed challenge, a Gateway establishment signature, and session-bound
Gateway signatures on later uplinks. That path remains planned, and business
uplinks presented as `gateway-signed` continue to fail closed here.

## Runtime Manifest report

The implemented transport-neutral report command accepts the closed AetherEdge
Runtime Manifest v1 shape only after credential authentication. It verifies the
same canonical-JSON SHA-256 contract as AetherEdge, represents its generation as
a canonical unsigned 64-bit decimal string, and derives Tenant, Project, and
Gateway scope from the verified credential rather than payload identifiers.

```text
no current -> accepted-latest
older generation -> accepted-late (history only)
same generation + same digest -> replayed
same generation + different digest -> rejected conflict
newer generation -> accepted-latest
```

Late observations remain queryable history but cannot move the latest
capability projection backward. A capability report is compatibility evidence,
not authorization to invoke an edge method. The experimental CloudLink MQTT
report envelope is implemented. PostgreSQL projection, public query transport,
durable audit, and outbox remain planned.

`adapters/runtime` provides a memory repository only; no PostgreSQL Runtime
Manifest adapter exists. The A0 CloudLink composition therefore holds accepted
manifests in process memory, with a direct consequence for session restore:

```text
process restart -> manifest repository empty
  -> RestoreGatewayRuntimeProtocols returns status "absent"
  -> declared protocols empty
  -> Integration topology and observation uplinks fail closed
  -> Gateway re-reports its manifest -> uplinks resume
```

Failing closed is the correct direction; an undeclared Integration extension
must not project data. Operators should expect that window after every restart
or redeploy, and it is why the projection store selection also drives the
session repository — durable projections must never be paired with sessions and
manifests that vanish on restart.

## Artifact publication

```text
draft -> validated -> published -> deprecated -> withdrawn
                         \---------------------> withdrawn
```

- Once a content digest identifies a revision, its bytes and compatibility
  metadata are immutable. Corrections create a new revision.
- Publication requires successful validation, provenance, compatibility, and
  signature policy. Partial validation does not publish.
- A channel is a separately audited movable reference; moving it does not edit
  a revision.
- Withdrawal prevents new deployments but keeps blobs, signatures, and applied
  evidence needed for audit and recovery.
- Repeated upload or publish with the same digest and idempotency key returns
  the original result; conflicting content is rejected.

The frozen domain transitions, governed publish/query application use cases,
and atomic memory content/signature/metadata/audit/outbox adapter are
implemented. Upload/finalize, production object storage and signer policy,
PostgreSQL metadata, durable audit/outbox, channel movement, lifecycle HTTP,
and edge artifact delivery remain planned. See the
[artifact registry](artifact-registry.md) for exact layer status.

## Telemetry batch ingestion

```text
received -> decoded -> validated -> persisted -> acknowledged -> projected
    |          |           |           |
 rejected   rejected    quarantined  pending-gap
```

- Batch identity is Tenant, Project, Gateway, logical stream, stream epoch, and
  first position. JSON encodes protocol 64-bit positions as canonical decimal
  strings.
- The MVP batch is atomic. One invalid record rejects the batch before any
  business record becomes accepted.
- Same identity and business-content digest returns the prior durable
  acknowledgement. Same identity with different content is a conflicting
  duplicate and is quarantined.
- A gap may retain a batch in a bounded durable reorder window but cannot
  advance the contiguous cursor. Overflow becomes an explicit loss marker.
- Persistence failure returns no successful acknowledgement. An ambiguous
  commit is resolved by the same identity on replay.
- Projection failure after durable acceptance does not revoke the receipt;
  workers retry projection from the outbox.
- Disconnect changes no batch state and the edge may replay every
  unacknowledged position.
- Batch cancellation is unsupported after ingress. Retention and deletion are
  separate governed lifecycle operations, not cancellation of historical fact.

## Deployment desired, reported, and applied

Rollout state:

```text
planned -> running <-> paused -> completed
              |                 completed-with-failures
              v
          cancelling -> cancelled
```

Target state:

```text
pending -> offered -> accepted -> fetching -> validated -> applied
             |          |           |            |
          expired    rejected     failed       failed or unknown
```

- A desired generation is monotonic cloud intent. Reported and applied are
  separate edge observations with their own generation, time, and evidence.
- A late observation for an older generation is retained but cannot roll the
  latest projection backward.
- `offered`, `accepted`, `fetching`, and `validated` never imply `applied`.
- A network timeout yields `unknown`. A late edge receipt may later resolve it.
- Cancellation stops work that has not crossed the relevant edge acceptance
  boundary. It cannot erase work already performed.
- Rollback creates a new desired generation pointing at an older immutable
  revision; it never edits history.
- Partial success is a first-class rollout result. Compensation is a new,
  auditable rollout.

## Governed capability Job

```text
created -> awaiting-confirmation -> authorized -> queued -> offered
   |              |                    |            |
 expired       rejected              expired     accepted -> running
                                                        |      |      |
                                                   succeeded failed partial
                                                        |
                                                     unknown
```

- Permission, risk policy, confirmation, precondition, idempotency, expiry, and
  audit requirements fail closed.
- The edge may reject work because of commissioning, compatibility,
  authorization, or safety policy.
- Timeout after offer or execution is `unknown`, not failure and not permission
  to create a new non-idempotent physical action.
- Retry uses the same Job identity and is allowed only when the capability
  declares safe replay semantics.
- Cancellation is a request. If work has started or completed, its actual
  Receipt remains authoritative.
- A late Receipt can resolve `unknown`; it cannot rewrite earlier audit events.

## Command Receipt

```text
ingressed -> authenticated -> persisted -> acknowledged -> projected
     |             |             |
  rejected      quarantined    pending-predecessor
```

- Receipts are append-only facts with identity, payload digest, Job causation,
  edge sequence, observation time, and optional evidence digest.
- Duplicate identity and digest is replay-safe. Same identity with different
  content is quarantined and never acknowledged as success.
- A Receipt arriving before an expected predecessor is durably retained and
  marked pending rather than discarded.
- Acknowledgement occurs only after Receipt, inbox de-duplication, and evidence
  reference are atomically durable.
- Large evidence is content-addressed in object storage. Missing or unmatched
  evidence remains visible.
- Projection can move an earlier Job from `unknown` to a terminal result while
  preserving the full timeline.

## Alarm projection

Edge occurrence facts:

```text
unseen -> active -> updated* -> cleared
                  \-> superseded or retracted correction
```

Cloud workflow overlay:

```text
unacknowledged -> acknowledged
freshness: complete | gap | stale
```

- Edge alarm identity, generation, and sequence make ingestion replay-safe.
- An out-of-order clear is retained as pending and marks the projection
  incomplete until replay fills the gap.
- Disconnect marks freshness stale; it does not clear or resolve an alarm.
- Store-and-forward overflow creates a visible gap or data-loss marker.
- Cloud acknowledgement, comment, notification mute, and assignment are cloud
  workflow facts. They never change the edge's active/cleared fact.
- A re-raised condition uses a new occurrence or explicit generation rather
  than silently reopening a cleared record.

## Webhook delivery

```text
pending -> leased -> delivered
   |          |
 disabled   retry-wait -> leased
                  |
             dead-letter -> redrive-requested -> pending
```

- One integration event and endpoint produce a stable delivery identity.
  Releasing or retrying a lease never creates a new business event.
- HTTP timeout is an unknown remote-consumption result, so retry keeps the same
  event and delivery identity.
- Retry uses bounded exponential delay and an attempt ceiling. Exhaustion makes
  dead-letter state visible instead of silently discarding the event.
- Endpoint disablement stops new leases but cannot undo a remote side effect.
  Deletion retains required audit and delivery history.
- Redrive is a governed command with permission, idempotency, expiry, and audit;
  it creates another attempt, not another event.
- Partial fan-out success remains visible per endpoint. No distributed
  transaction is claimed across subscribers.

These rules preserve the edge-first authority boundary: the edge remains
authoritative for live state and physical control, while the cloud records
accepted facts and governed intent without claiming unproven device outcomes.
