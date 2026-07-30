---
title: Gateway identity and enrollment
description: Build tenant-scoped Gateway identity from registration and short-lived bootstrap claims
updated: 2026-07-30
status: mixed
---

# Gateway identity and enrollment

A Gateway is AetherCloud's tenant-scoped identity for one AetherEdge runtime. It
is not a device session, a live-state owner, or a certificate record. Enrollment
progressively binds a registered cloud resource to proof held by the runtime.

## Implemented foundation

The current TypeScript foundation implements:

- runtime-validated, branded `TenantId`, `ProjectId`, and `GatewayId` values
- immutable Gateway enrollment transitions
  `registered -> awaiting-claim -> claimed`
- separate `RegisterGateway`, `IssueGatewayEnrollment`, and
  `ClaimGatewayEnrollment` application commands
- a tenant-scoped `GetGatewayEnrollment` query
- command definitions containing permission, risk, confirmation, idempotency,
  expiry, audit, and authorization policy
- typed application failures and runtime decoding of untrusted inputs
- optimistic `GatewayIdentityRepository` insert and replace operations
- mutation evidence carrying authenticated actor, command governance, and
  integration event identity
- typed storage-unavailable outcomes for read and write paths
- an in-memory repository and token service for conformance and local tests
- a PostgreSQL repository, explicit migration, Tenant RLS, Node `pg` pool
  boundary, optimistic revision checks, and atomic Gateway/Audit/Outbox writes
- an opt-in PostgreSQL 18 integration test with a constrained application role

Registration, Claim issue/status, and strict AetherEdge Claim consume HTTP
routes are now composed over the deployed forced-RLS PostgreSQL adapter. A real
compiled AetherEdge CLI local harness reaches `claimed` against the Fastify
memory composition. Active credential issuance, production CloudLink, CA/KMS,
and complete migration orchestration remain unavailable.

## Command boundary

| Capability                       | Authorization                                      | Risk   | Confirmation | Idempotency and expiry |
| -------------------------------- | -------------------------------------------------- | ------ | ------------ | ---------------------- |
| `fleet.gateway.register`         | `fleet.gateway.create` in Tenant context           | low    | not required | required               |
| `fleet.gateway.enrollment.issue` | `fleet.gateway.enrollment.issue` in Tenant context | high   | explicit     | required               |
| `fleet.gateway.enrollment.claim` | bound enrollment token                             | medium | not required | required               |

All three commands require audit by policy. Registration and Claim issue use
the authenticated Tenant context; Claim consume uses only its short-lived
Token and strict bound scope. PostgreSQL persists each aggregate, Audit, and
Outbox transition atomically.

The issue command returns the raw enrollment token once. An identical retry
returns only public Gateway and claim state. A retry with the same idempotency
key and different input fails. The Gateway aggregate stores the token digest,
never the raw token.

The claim command compares token material through an application-owned token
service. It binds a credential-request fingerprint but does not issue or
activate a certificate. A valid duplicate claim with the same request and
fingerprint is a replay; a different claimant cannot rebind the Gateway.

## Query boundary

`fleet.gateway.enrollment.get` requires
`fleet.gateway.enrollment.read`. The query uses Tenant and Project scope from
the authenticated context and returns `gateway-not-found` outside that scope.
It never returns a token, token digest, or command idempotency key.

## Implemented failures

- `invalid-input`
- `permission-denied`
- `confirmation-required`
- `command-expired`
- `idempotency-conflict`
- `gateway-already-exists`
- `gateway-not-found`
- `gateway-storage-unavailable`
- `invalid-enrollment-token`
- `enrollment-claim-expired`
- `invalid-gateway-enrollment-transition`
- `concurrent-modification`

The Fastify composition maps these failures into bounded HTTP error envelopes.
Credential activation and recovery transport mappings remain planned.

## Planned lifecycle

The production lifecycle extends the foundation without changing its authority:

```text
registered -> awaiting-claim -> claimed -> credential-pending -> active
                    |                              |             |
                 expired                        failed       suspended
                                                                  |
                                                               revoked
                                                                  |
                                                        recovery-pending
                                                                  |
                                                   active (new generation)
```

Claims are short-lived and replaceable; active credentials are separately
versioned. Revocation permanently fences a credential generation. Recovery
requires explicit authorization and creates a new generation rather than
reactivating revoked material.

The [IoT Cloud roadmap](../guides/iot-cloud-roadmap.md) identifies which
credential, persistence, and public API capabilities are available now and
which remain planned.
