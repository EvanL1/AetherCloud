---
title: Home Assistant integration
description: Understand the experimental Edge-owned Home Assistant data path, durable Cloud projection, the Broker-ACL-only cloud ingress, safety boundary, and remaining release gates
updated: 2026-08-01
status: mixed
---

# Home Assistant integration

[Simplified Chinese](https://docs.aetheriot.ai/zh/aethercloud/concepts/home-assistant-integration/)

Home Assistant is integrated at AetherEdge, close to the home network and
devices. AetherCloud does not connect to a person's Home Assistant instance,
store its token, or become authoritative for current device state.

The intended data path is:

```text
Home Assistant
  -> AetherEdge connector
  -> vendor-neutral integration topology and observations
  -> governed CloudLink delivery
  -> AetherCloud projection
  -> Agent discovery and explanation
```

This read-only path is executable in explicit source builds. AetherEdge can
produce strict alpha.4-candidate topology and observation messages through
independent crash-recoverable CloudLink streams. AetherCloud validates the
current session and Runtime Manifest declaration, then atomically stores the
business projection, replay receipt, audit evidence, outbox evidence, and
contiguous application acknowledgement.

This is still an experimental integration, not a released household product.
The contract is an unpublished candidate, several Cloud composition adapters
remain memory-backed, the optional Agent-facing query adapters have no public
wire service, and production enrollment and credential lifecycles are not
complete. The cloud ingress also performs no Gateway authentication of its own;
it depends entirely on your Broker's per-Gateway ACLs, as
[Cloud ingress authentication depends on your Broker ACL](#cloud-ingress-authentication-depends-on-your-broker-acl)
explains.

## Authority and secret boundary

| Concern                                                               | Authority                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------- |
| Home Assistant registries and observed entity state                   | Home Assistant evidence, consumed locally by AetherEdge |
| Normalization, reconnect, resynchronization, and local acceptance     | AetherEdge                                              |
| Live point state, deterministic rules, safety, and physical execution | AetherEdge                                              |
| Shared topology and observation shape                                 | AetherContracts                                         |
| Searchable historical projection and Agent context                    | AetherCloud                                             |

The Home Assistant URL, access token, refresh token, and OAuth client material
remain in edge-local configuration or a secret provider. They are forbidden in
topology, observations, CloudLink payloads, cloud persistence, audit details,
logs, prompts, and Agent context.

## Cloud ingress authentication depends on your Broker ACL

The cloud side of this path runs a deliberately restricted CloudLink mode.
[CloudLink reliability and lifecycle](https://docs.aetheriot.ai/aethercloud/concepts/cloudlink-and-core-state-machines.md)
carries the full description, but a reader who stops at this page must still
leave knowing the constraint below.

The cloud ingress verifies no Gateway signature, on the opening session or on
any later uplink, because no production message-origin key source exists yet.
It instead resolves an operator-configured credential from the Gateway ID,
credential ID, and credential generation carried in the message. Those three
values are non-secret identifiers. The configured secret never crosses the wire
and AetherCloud never stores it.

- **Authentication depends entirely on Broker-side per-Gateway ACLs. Without
  them there is effectively no authentication.** Any publisher that can write a
  Gateway's uplink topics and knows those three identifiers obtains a session,
  and can then report a Runtime Manifest and overwrite that Gateway's projected
  home topology and observations.
- **The ingress Broker login is not a per-Gateway ACL.** The optional Broker
  username and password authenticate AetherCloud's own subscriber connection to
  the Broker. They say nothing about which publishers may write a Gateway's
  uplink topics. Nothing in this repository configures, enforces, or verifies
  those ACLs, and the ingress starts whether or not you created them.
- **No publisher attestation is consumed.** A reviewed trusted connector
  could supply verified publisher attestation out of band for every publish.
  This composition consumes none of it. It assumes the Broker ACL is correct
  and has no way to detect that it is not.

Restricting each Gateway's Broker credentials to that Gateway's own topic
namespace is therefore a required deployment step, not an optional hardening
measure. This mode suits a single household where you own the Broker and can
confirm publisher identity out of band. It is not Gateway authentication, must
not be described as such, and does not support multi-tenant or multi-Gateway
scale.

## Contract candidate

AetherContracts `0.1.0-alpha.4` in the current sibling working tree defines a
closed, provider-neutral `aether.integration` contract:

- a complete topology snapshot with a lossless generation;
- areas, devices, entities, and multiple typed points per entity;
- observation batches fenced by topology generation;
- exact `int64`, `uint64`, decimal, finite floating-point, string, boolean, and
  base64url byte values;
- explicit `good`, `uncertain`, `bad`, and `unavailable` quality;
- contextual rejection for duplicate identities, dangling references, type
  mismatch, and invalid quality/value combinations.

Home Assistant registry entry identity becomes the stable entity identity.
The mutable Home Assistant `entity_id` is retained as `source_address`, so a
rename does not create a new Aether entity. The primary power state for
`light`, `switch`, and `fan` is the Boolean `is_on` point. Selected bounded
attributes become separate declared points; arbitrary attributes are not
copied into the contract.

The contract deliberately excludes credentials, arbitrary service calls, and
a CloudLink transport wrapper. Device control requires a later, separate,
deny-by-default capability and receipt contract.

AetherCloud's existing complete-consumer lock still pins the published
`0.1.0-alpha.3` release. It must not claim alpha.4 conformance until alpha.4 is
published, imported with exact digests, and executed through the consumer
tests. The cloud domain below is aligned with the candidate fields but is not a
substitute for that release gate.

## Implemented read-only path

The three repositories now contain:

- an authenticated Home Assistant WebSocket adapter at AetherEdge;
- complete snapshots, ordered state changes, restart-stable topology
  generations, explicit gap detection, and full resynchronization;
- strict alpha.4-candidate Integration and CloudLink codecs;
- two independent edge file journals for topology and observations;
- MQTT reconnect and exact replay that remove a journal record only after a
  strict current-session application acknowledgement;
- Runtime Manifest declaration and authenticated restoration on a new
  CloudLink session;
- provider-neutral cloud topology and observation domain values;
- closed internal command decoding plus deep validation of repository results;
- Gateway-credential-scoped topology and observation report commands;
- Tenant/Project-scoped by-ID and bounded catalog projection queries;
- generation fencing, typed value validation, replay identity, and conflict
  results;
- memory and PostgreSQL projection adapters;
- PostgreSQL transactions that bind the Integration fact, inbox identity,
  immutable receipt, topology history, audit record, outbox record, CloudLink
  delivery, and contiguous acknowledgement;
- exact cross-session and credential-generation replay without repeating
  business effects;
- bounded future-clock-skew rejection for provider timestamps;
- a view that always reports `edge-reported-copy` and
  `liveStateAuthoritative: false`.

The catalog is ordered by Gateway and Integration identity and returns only
bounded summary fields. It helps an Agent discover which copied projections
exist before requesting one exact detail view. It is not a live device
inventory, and `receivedAt` is freshness evidence rather than proof of current
physical state. The optional MCP resource adapters remain hidden unless their
application queries are explicitly injected.

The memory adapters remain development aids. The PostgreSQL Integration
adapter has real-database restart and concurrency tests, but the current
CloudLink session, Runtime Manifest, and deployment composition still include
memory-backed pieces. Therefore the repository does not yet claim a complete
production Cloud process.

## Resynchronization

AetherEdge subscribes before taking its initial snapshot so state changes
during discovery are not silently lost. Registry changes, deletion, connection
loss, invalid protocol data, or an observation gap require a new complete
snapshot. AetherCloud also fences every observation batch by the exact topology
generation. Neither side guesses missing state, carries values across an
unknown topology, or treats `unknown` and `unavailable` as fabricated strings.

## Current user-visible boundary

- a published, digest-pinned alpha.4 complete-consumer import;
- prebuilt AetherEdge packages, installer configuration, and a published
  Home Assistant compatibility baseline;
- installer-managed enrollment, Broker ACL templates, credential rotation,
  and production secret-manager adapters; until they exist, the per-Gateway
  Broker ACLs that this integration's authentication rests on must be written
  and audited by hand, and AetherCloud never checks them;
- a fully PostgreSQL-backed CloudLink session and Runtime Manifest production
  composition; the Runtime Manifest is memory-only today, so a cloud restart
  drops accepted declarations and projection uplinks fail closed until each
  Gateway reports its manifest again;
- production API and Agent discovery exposure;
- bounded historical observation queries and a complete freshness model;
- floors, labels, configuration-entry provenance, and service capability
  publication in the public contract;
- a production-enabled governed control path; the separate
  `aether.cloudlink.integration-control.v1alpha1` power action is experimental,
  default off, and cannot claim physical completion;
- production OAuth onboarding and token rotation.

These remaining gaps are product gates. Passing the repository tests must not
be described as a supported production deployment.
