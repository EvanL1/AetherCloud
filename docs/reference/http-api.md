---
title: HTTP API reference
description: Call the implemented HTTP endpoints and distinguish them from planned versioned APIs
updated: 2026-07-30
status: implemented
---

# HTTP API reference

The API exposes two public metadata routes, five authenticated Fleet routes,
one token-authorized AetherEdge Claim route, and two authenticated Audit query
routes. Telemetry is currently
visible only as the latest per-Gateway Fleet projection; standalone history,
provider discovery, deployment, webhook/export, and MCP routes remain
unexposed. The implemented `DiscoverProviderRegions` application query is
intentionally not an HTTP contract until authentication, tenant context, and
runtime decoding are composed around it.

The implemented `PlanDeploymentStack` application command is also not an HTTP
contract. No endpoint accepts a module, topology, Plan artifact, or Apply
request. Its future route additionally needs durable audit, encrypted artifact
storage, and a production State-locking engine adapter.

Gateway registration, Enrollment Claim issue/consume, and Fleet read
projections are composed through the Tenant identity boundary and forced-RLS
PostgreSQL adapter. An Enrollment Token is returned exactly once to an
authorized, explicitly confirming operator and is accepted only by the bounded
AetherEdge Claim route. It is never returned by a read route.

## `GET /health`

Returns process liveness without reading PostgreSQL or another external service.

Response status: `200 OK`

```json
{
  "status": "ok",
  "service": "aether-cloud-api",
  "version": "0.1.0"
}
```

This response proves only that the API process can serve requests. Future
readiness checks for configured adapters will use a separate endpoint so a
database outage does not rewrite liveness semantics.

## `GET /api/v1/platform`

Returns stable product-role and authority metadata for clients and coding
agents. It contains no tenant data and performs no I/O.

Response status: `200 OK`

```json
{
  "name": "AetherCloud",
  "role": "ai-native-multi-cloud-iot-control-plane",
  "authority": {
    "livePointState": "edge",
    "physicalControl": "edge",
    "tenantIdentity": "aether-cloud",
    "desiredRevision": "aether-cloud",
    "placementPolicy": "aether-cloud",
    "actualInfrastructure": "provider"
  },
  "multiCloud": {
    "providerModel": "capability-driven-adapters",
    "executionEngines": ["opentofu", "terraform"],
    "stateIsolation": "deployment-stack"
  }
}
```

This is metadata about stable product boundaries, not evidence that a provider
connection, inventory route, or infrastructure execution endpoint is already
available.

## `GET /api/v1/fleet/gateways`

Lists Gateway identities in the authenticated Tenant and Project. It requires
`fleet.gateway.read`; optional `limit` is 1–100 and `cursor` is the last Gateway
UUID from the previous page. The response includes enrollment state, a
CloudLink-derived connection status, canonical string telemetry counts, and the
latest persisted telemetry record when one exists. It never reads live point
state from an edge connection.

## `GET /api/v1/fleet/gateways/:gatewayId`

Returns one Gateway from the same forced-RLS projection and permission boundary.
An unknown or out-of-scope identity returns the same typed `404
gateway-not-found` result.

## `POST /api/v1/fleet/gateways`

Registers a Gateway identity with `gatewayId` and `displayName`. It requires
`fleet.gateway.create` and an `idempotency-key` header. The application command
atomically persists the identity, Audit evidence, and Outbox event in Supabase
PostgreSQL. Registration does not create an edge credential or bypass the separate
Enrollment Claim workflow.

## `POST /api/v1/fleet/gateways/:gatewayId/enrollment-claims`

Issues one ten-minute Enrollment Token. It requires
`fleet.gateway.enrollment.issue`, `Authorization`, `idempotency-key`, and the
explicit `x-aethercloud-confirmation: issue-enrollment-claim` header. The raw
Token appears only in the first successful response; an exact retry returns
`409 enrollment-token-not-recoverable` rather than fabricating or recovering
secret material. Gateway, Audit, and Outbox state advance atomically.

## `GET /api/v1/fleet/gateways/:gatewayId/enrollment`

Returns non-secret enrollment state under
`fleet.gateway.enrollment.read`. It never returns the Token, Token digest,
public key, or idempotency key.

## `POST /api/v1/fleet/enrollment-claims:claim`

Consumes the provisional AetherEdge contract
`aether.cloud.gateway-enrollment-claim.v1`. This route uses the short-lived
Enrollment Token instead of a user JWT and is process-limited against abuse.
It strictly validates the Ed25519 raw public key and requires its declared
fingerprint to equal lowercase hexadecimal `SHA-256(raw 32-byte public key)`.
The only success response is:

```json
{
  "schema": "aether.cloud.gateway-enrollment-claimed.v1",
  "gatewayId": "33333333-3333-4333-8333-333333333333",
  "state": "claimed",
  "revision": 3
}
```

`claimed` proves only that Cloud atomically consumed the Token and bound the
credential-request fingerprint. It does not mean credential-active,
CloudLink-connected, online, or telemetry-healthy. Active credential issuance,
trust-key delivery, and production CloudLink composition remain gated.

## `GET /api/v1/audit/events`

Searches only the Tenant and Project resolved from the authenticated subject.
The request cannot supply Tenant scope. It requires `audit.event.read`.

Supported optional query fields are `action`, `cursor`, `from`, `limit`,
`resourceId`, `resourceKind`, `subjectId`, and `to`. `limit` defaults to 50 and
is bounded by the application query. The cursor is the canonical decimal audit
sequence; protocol `int64` values remain strings.

Response status is `200 OK` with `{ "items": [...], "nextCursor": string |
null }`. Each item contains immutable audit subject, action, resource, outcome,
risk, confirmation, correlation, and optional trace/evidence-digest fields.

## `GET /api/v1/audit/events/stream`

Returns the same authorized query result encoded as `text/event-stream`. The
`Last-Event-ID` header resumes after an audit sequence and must agree with a
query `cursor` when both are present. Each event id is the audit sequence.

This route is a finite resumable snapshot ending with a `snapshot-complete`
comment. It is not a durable live subscription and does not prove that a
notification worker or broker exists.

## Error shape

Versioned application APIs use a stable envelope containing a code,
human-readable message, and correlation identity:

```json
{
  "error": {
    "code": "permission-denied",
    "message": "permission audit.event.read is required",
    "correlationId": "request-correlation-id"
  }
}
```

Fleet and Audit routes return typed `400 invalid-input`, `401 unauthenticated`,
`403 permission-denied`, `404 gateway-not-found`, `409` idempotency/conflict,
`429 rate-limited`, or `503` storage failures as applicable and also emit `x-correlation-id`.
PostgreSQL transport and row-decoding failures are sanitized into typed `503`
outcomes.

## Authentication

`/health` and `/api/v1/platform` are intentionally public and contain no Tenant
or infrastructure instances. Audit routes require `Authorization: Bearer
<token>`. Railway production sets `AETHER_CLOUD_AUTH_MODE=supabase-jwt` and
accepts only ES256 Supabase Auth access tokens with the configured HTTPS issuer,
`authenticated` audience and role, valid lifetime, and a signature resolved
through that issuer's JWKS. The API carries no Supabase secret or JWT signing
key.

Tenant ID, Project ID, and permissions come only from
`app_metadata.aethercloud_tenant_id`, `aethercloud_project_id`, and
`aethercloud_permissions`. Supabase `user_metadata` is user-writable and is
never authorization evidence. Missing, malformed, duplicated, or out-of-scope
claims fail closed with `401`. Self-sign-up alone grants no AetherCloud access;
an administrator-controlled membership flow must attach those claims.

The independently deployed `cloud.aetheriot.dev` console signs in directly with
Supabase Auth, keeps the resulting short-lived session in the browser, and calls
only the AetherCloud API with that access token. Production CORS permits exactly
the configured console origin, does not allow credentials, and exposes only the
correlation header. Browser clients never receive the database URL or write
AetherCloud business tables directly.

The constant-time configured bearer adapter remains available for local tests,
but the composition root refuses it in the Railway production environment.
`AETHER_CLOUD_AUDIT_STORE` explicitly selects `memory` or `postgres`. PostgreSQL
mode requires `AETHER_CLOUD_POSTGRES_URL` to name the dedicated
`aethercloud_app` role and use `verify-full` TLS; it applies Tenant context
inside each transaction before querying the forced-RLS Audit table. The memory
mode remains suitable only for local composition and contract tests. A body,
path, query, or user-editable metadata Tenant identity is never proof of access.
