---
title: PostgreSQL persistence and multi-cloud cells
description: Place Gateway and telemetry transactional authority in one portable PostgreSQL cell while evolving analytics and provider profiles independently
updated: 2026-07-16
status: mixed
---

# PostgreSQL persistence and multi-cloud cells

PostgreSQL is AetherCloud's default control-plane transaction engine. This does
not make AetherCloud a PostgreSQL management product and does not erase its
multi-cloud Provider Adapter model.

## Responsibility split

| Store                         | Owns                                                                                              | Does not own                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| PostgreSQL                    | Tenant/Fleet metadata, identity, session cursor, Inbox, Outbox, Audit, Deployment and Job ledgers | edge live state, provider resources, infrastructure State, large immutable blobs |
| Object storage                | artifacts, provenance, raw/cold batches, evidence, exports                                        | mutable aggregate or authorization state                                         |
| Time-series/analytics adapter | historical telemetry scans, downsampling, aggregates after measured need                          | live Point authority or command transactions                                     |
| Deployment Stack backend      | one provider-scoped locked infrastructure State                                                   | IoT product data or cross-provider global state                                  |
| OpenTelemetry backend         | sampled operational traces and metrics                                                            | Audit, IoT telemetry, Receipt, or authorization evidence                         |

PostgreSQL can initially implement a bounded telemetry-history port. Moving
history to TimescaleDB or ClickHouse does not change CloudLink acknowledgement:
the owning ingestion application contract must still establish durable replay
identity and accepted business facts before acknowledging the edge.

## Multi-cloud deployment model

Multi-cloud has three different meanings:

1. **Portable cell:** the same API, CloudLink, worker, PostgreSQL, and object
   storage composition can run in any supported environment.
2. **Multi-cloud management:** one cell manages provider-scoped resources and
   Gateways across many clouds. Its database need not span those clouds.
3. **Multi-cloud active-active control plane:** multiple cells write the same
   Tenant transaction state. This is not implemented and requires a separate
   consensus, fencing, conflict, latency, and recovery decision.

Multi-cloud management does not require synchronous cross-cloud database writes.

The default topology is an explicit Tenant home cell:

```text
Global tenant directory
  ├── Tenant A -> Cell 1 -> PostgreSQL writer + object storage
  ├── Tenant B -> Cell 2 -> PostgreSQL writer + object storage
  └── Tenant C -> Cell 3 -> PostgreSQL writer + object storage

Each cell
  API + CloudLink + workers
          |
          +-- one authoritative PostgreSQL writer topology
```

Cross-cloud replicas and backups may improve recovery, but they are not write
authority until a governed failover fences the old cell. CloudLink durable
acknowledgement never waits for an unrelated cross-cloud infrastructure saga.

## Provider database profiles

Core provider descriptors can advertise `managed-postgresql`. A future profile
discovery contract will retain, rather than flatten, at least:

- provider-native engine/profile identity;
- PostgreSQL-compatible versions and optional extensions;
- regional availability, sovereignty, and private connectivity;
- HA, replica, backup, restore, encryption, and maintenance capabilities;
- stated RPO/RTO and observed cost evidence;
- provider-specific namespaced extensions.

The core repository never branches on AWS, Azure, GCP, or any other fixed
vendor identifier. A provider without managed PostgreSQL may expose a governed
self-hosted profile later.

## Implemented Gateway persistence slice

The current executable slice includes:

- `PostgresGatewayIdentityRepository` with parameterized SQL;
- a real `pg` driver pool adapter behind a narrow local contract;
- explicit registration, pending-claim, and claimed columns and checks;
- composite Tenant/Project/Gateway identity and optimistic revision checks;
- Tenant transaction context plus forced Row-Level Security policies;
- atomic aggregate, append-only Audit, and Outbox writes;
- stable evidence identities and secret-free Outbox payloads;
- typed `gateway-storage-unavailable` application failures;
- scripted SQL/migration behavior tests with no external service;
- an opt-in PostgreSQL 18 integration test using a dedicated database and a
  non-superuser/non-`BYPASSRLS` application role.

The SQL adapter and migration are implemented. No composition root currently
opens a production database, runs migrations, exposes Gateway HTTP routes, or
delivers the Outbox. Production roles, credentials, pool sizing, timeouts,
backup/restore testing, managed-provider profiles, and continuously provisioned
integration infrastructure remain planned.

## Implemented telemetry and CloudLink ACK slice

`PostgresTelemetryRepository` implements the first crash-durable telemetry
acceptance slice. One Tenant-scoped transaction writes the ingress idempotency
identity, batch receipt, stream and contiguous cursor state, accepted records,
required Audit event, integration Outbox event, and the exact CloudLink durable
ACK outbox row. Duplicate replay returns and requeues the same stored ACK rather
than inserting a second fact.

The adapter uses parameterized SQL, lossless `numeric(20,0)` protocol
positions, composite Tenant keys and foreign keys, forced Row-Level Security,
bounded reorder and quota checks, and a lease-based ACK delivery repository.
The application-owned delivery use case validates claimed adapter output,
publishes sequentially, records completion only after publish succeeds, and
releases failures with a sanitized code.

The opt-in PostgreSQL 18 tests use a non-superuser/non-`BYPASSRLS` application
role and inject failures on both sides of commit. A pre-commit failure leaves no
telemetry fact and no ACK. A post-commit uncertain result leaves one committed
fact, and a worker later publishes the identical ACK; replay does not create a
second fact. This evidence covers accepted telemetry only. Production database
and worker composition, CloudLink session/epoch persistence, data-loss facts,
multi-sample mapping, and a full production crash-durable release gate remain
planned.

Read [Gateway identity and enrollment](gateway-identity-and-enrollment.md) for
the tenant-scoped identity and persistence boundary visible to gateway users.
