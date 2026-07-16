---
title: Artifact registry and immutable publication
description: Publish signed content-addressed revisions without confusing release metadata, deployment intent, or edge acceptance
updated: 2026-07-16
status: mixed
---

# Artifact registry and immutable publication

AetherCloud publishes Pack, configuration, model, rule, and application
revisions as immutable, content-addressed facts. Publication makes a revision
eligible for a later desired-state reference; it does not deploy, download, or
apply anything at an AetherEdge runtime.

## Authority and boundaries

- AetherCloud is authoritative for artifact metadata, validation and
  publication state, signer policy, and release-channel references.
- The content store is authoritative for the immutable bytes identified by a
  SHA-256 digest.
- AetherEdge remains authoritative for local compatibility checks, cache state,
  and whether a revision is accepted and applied.
- A release channel is a governed reference. It is not mutable content and is
  not evidence of deployment.
- Signature verification and publication audit are business requirements;
  sampled OpenTelemetry signals cannot replace either.

## Implemented inner-layer slice

The domain package defines bounded IDs, canonical uint64 decimal revision and
content-length values, SHA-256 digests, compatibility requirements, signature
metadata, and this immutable state machine:

```text
draft -> validated -> published -> deprecated -> withdrawn
                            \---------------------> withdrawn
```

Every transition returns a frozen new revision and preserves identity,
content digest, compatibility, dependencies, signature, and publication
timestamps. Publication cannot skip validation. Withdrawal retains prior
publication evidence rather than deleting history.

The application package implements `artifact.revision.publish` and
`artifact.revision.get`. Publication is a high-risk, explicitly confirmed,
expiring, idempotent, audited Tenant/Project command. It decodes external input
exactly, verifies content and signature through application-owned ports, and
only then asks the repository to atomically persist the published revision,
channel reference, idempotency evidence, audit evidence, and outbox evidence.

The memory adapter is a conformance implementation. It proves:

- exact retry returns the original revision without duplicate audit/outbox
  evidence;
- reuse of an idempotency key with changed publication identity conflicts;
- a revision identity cannot be replaced;
- a release-channel race cannot silently replace its current revision;
- content-length/digest and trusted-signature checks fail closed;
- persistence failure writes no revision, channel, audit, or outbox evidence;
- Tenant/Project-scoped lookup does not reveal another Tenant's revision.

## Storage contract

The production design separates three responsibilities:

| Store          | Responsibility                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL     | artifact/revision metadata, publication state, channel reference, idempotency record, authorization scope, audit and transactional outbox |
| Object storage | immutable content, signature material, provenance, SBOM and large validation evidence by digest                                           |
| Edge cache     | locally verified content and application evidence under AetherEdge policy                                                                 |

The current implementation has no PostgreSQL or object-storage adapter. The
memory adapter's `putContent` and trusted-signature helpers are test fixtures,
not upload, KMS, CA, or production signer APIs.

## Failure and replay semantics

Content missing, digest/length mismatch, invalid signature, verifier/storage
unavailability, revision conflict, release-channel conflict, and idempotency
conflict are typed failures. No failure is converted into a successful
publication. An HTTP timeout around a future production route can be resolved
by replaying the same idempotency key; clients must query rather than invent a
publication result.

Publication events are currently present only in the atomic memory adapter.
`artifact.revision-published.v1` becomes a production integration event only
after a durable transaction writes a real outbox.

## Still planned

- upload/finalize and immutable object-storage adapters;
- PostgreSQL metadata, audit, idempotency, channel, and outbox transactions;
- production signer policy, KMS integration, provenance, SBOM and malware
  validation;
- deprecate, withdraw, and channel-move application commands;
- HTTP, CloudLink, export, and MCP interfaces;
- AetherEdge artifact download and verification counterpart;
- desired/reported/applied deployment and rollout.

Next, read [Desired, reported, and applied deployment](desired-reported-applied-deployment.md)
to understand how a published artifact becomes a governed rollout without
being mistaken for proof that an edge runtime applied it.
