---
title: "ADR-0005: Gateway identity and enrollment"
description: Separate gateway registration, bootstrap claims, credential binding, revocation, and recovery
updated: 2026-07-16
status: normative
---

# ADR-0005: Gateway identity and enrollment

## Status

Accepted on 2026-07-14. The registration and claim foundation is implemented;
credential issuance, revocation, and recovery remain planned.

## Context

A Gateway represents one AetherEdge runtime identity in a Tenant and Project.
Enrollment must establish that identity without turning a short-lived bootstrap
secret into a long-lived credential. Network retries also make a command that
both registers a Gateway and returns a secret unsafe: either the secret must be
stored for replay or an idempotent retry discloses it again.

Gateway reinstall and hardware replacement add another constraint. Recovery
must not reactivate a revoked credential or silently move a Gateway between
Tenants.

## Decision

1. Gateway registration, enrollment-claim issuance, and claim consumption are
   separate application commands.
2. Tenant identity is resolved from authenticated command context. It is never
   accepted from a command payload as authorization evidence.
3. An enrollment claim is bound to one Tenant, Project, Gateway, issuance
   request, expiry, and token digest. The raw token is returned only by the
   first successful issue command and is never stored in the Gateway aggregate.
4. Replaying the same issue request returns public claim metadata without the
   raw token. Reusing an idempotency key with different input is a typed
   conflict.
5. A claim token is a bootstrap credential, not a user or service-account API
   credential. Claim failures do not expose cross-tenant Gateway existence.
6. The initial state machine is `registered -> awaiting-claim -> claimed`.
   Claim expiry is checked against a server-owned clock, and `now >= expiresAt`
   is expired.
7. Credential binding is a later transition after `claimed`. A successful
   claim does not claim that a production certificate was issued.
8. Revocation permanently fences one credential generation. Recovery creates a
   new claim and credential generation; it never reactivates the old one.
9. Every command declares permission, risk, confirmation, idempotency, expiry,
   and audit policy before a transport may expose it.

## Consequences

- Lost first-issue responses require an explicitly authorized new claim rather
  than secret recovery.
- PostgreSQL persistence must atomically enforce Gateway identity, claim, and
  idempotency constraints before enrollment is exposed over HTTP.
- A real token service must use a secret manager or KMS-backed construction and
  constant-time verification. The implemented memory adapter is for conformance
  and local development only.
- A real CA, certificate status, revocation delivery, hardware attestation, and
  recovery approval are not implied by the implemented foundation.
- CloudLink authentication will consume an active credential binding, not an
  enrollment token.
