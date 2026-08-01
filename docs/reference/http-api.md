---
title: HTTP API reference
description: Call the implemented HTTP endpoints and distinguish them from planned versioned APIs
updated: 2026-08-01
status: implemented
---

# HTTP API reference

The API exposes two public metadata routes, five authenticated Fleet routes,
one token-authorized AetherEdge Claim route, two authenticated Audit query
routes, and two authenticated read-only Integration projection routes.
Telemetry is currently
visible only as the latest per-Gateway Fleet projection; standalone history,
provider discovery, deployment, webhook/export, and MCP routes remain
unexposed. No route creates, changes, or cancels an Integration device command;
the governed control path has no HTTP surface. The implemented `DiscoverProviderRegions` application query is
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
latest persisted telemetry record when one exists. Connection output includes a
machine-readable reason, latest Session evidence, protocol version, observation
time, heartbeat interval, and the derived `staleAfter` boundary when available.
The latest closed Session remains visible with its close time and reason instead
of being rewritten as `never-connected`. Telemetry status is only `no-data` or
`receiving`; neither value claims that the source or physical process is healthy.
The projection never reads live point state from an edge connection.

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

## `GET /api/v1/integrations`

Lists the Integration projections held for the Tenant and Project resolved from
the authenticated subject. The request cannot supply Tenant scope. It requires
`integration.projection.read`.

The only accepted query fields are `cursor`, `gatewayId`, and `limit`; any other
field returns `400 invalid-input` instead of being ignored. `limit` is an integer
from 1 to 100 and defaults to 50. `gatewayId` restricts the page to one Gateway.
`cursor` is the opaque `nextCursor` token from the previous page; it encodes the
Gateway filter it was issued under, so replaying it with a different `gatewayId`
is rejected rather than silently repaged.

Response status is `200 OK`:

```json
{
  "authority": "edge-reported-copy",
  "liveStateAuthoritative": false,
  "items": [
    {
      "gatewayId": "33333333-3333-4333-8333-333333333333",
      "integrationId": "example-integration-id",
      "integrationKind": "home-assistant",
      "snapshotGeneration": "7",
      "entityCount": 24,
      "latestObservationCount": 24,
      "receivedAt": "2026-07-31T09:15:04.000Z",
      "revision": 3
    }
  ],
  "nextCursor": "example-opaque-page-token"
}
```

`nextCursor` appears only when a further page exists. Unlike the Audit routes it
is omitted rather than returned as `null`. `snapshotGeneration` is a protocol
`int64` and stays a canonical decimal string.

Typed failures are `400 invalid-input`, `401 unauthenticated`,
`403 permission-denied`, and `503 integration-storage-unavailable` or
`503 invalid-integration-repository-result`.

## `GET /api/v1/integrations/:gatewayId/:integrationId`

Returns one Integration projection under the same permission and Tenant
boundary. It accepts no query fields. An unknown or out-of-scope identity
returns the same typed `404 integration-projection-not-found` result, so the
route does not disclose whether a projection exists in another Tenant.

The success body carries the same two authority constants, the resolved
`tenantId`, `projectId`, `gatewayId`, and `integrationId`, the reported
`topology`, its `topologyDigest`, `latestObservations`, `receivedAt`, and
`revision`. `topology` contains the snapshot `schema`, `integrationKind`,
`snapshotGeneration`, `observedAtMs`, and the reported `areas`, `devices`, and
`entities`; each entity carries its `points` with kind, value type, and optional
unit. Each observation carries `entityId`, `pointKey`, `observedAtMs`,
`quality`, an optional typed `value`, and an optional bounded `diagnostic`.
`snapshotGeneration` and `observedAtMs` are protocol `int64` values and remain
canonical decimal strings.

`topologyDigest` is lowercase hexadecimal SHA-256 of the stored topology. The
query recomputes it on every read and returns
`503 invalid-integration-repository-result` when the stored digest and the
recomputed digest disagree, rather than serving a topology it cannot vouch for.

No response field carries a Home Assistant address, access token, or any other
provider credential. The application layer does not return them and the
response schema has no place to put them.

Typed failures are `400 invalid-input`, `401 unauthenticated`,
`403 permission-denied`, `404 integration-projection-not-found`, and
`503 integration-storage-unavailable` or
`503 invalid-integration-repository-result`.

## What an Integration projection is evidence of

Both routes pin `authority` to `"edge-reported-copy"` and
`liveStateAuthoritative` to `false` as schema constants. They are not
descriptive prose that a later release may quietly drop, so a client may branch
on them.

They mean what they say. The payload is what an edge runtime reported to
AetherCloud, not live device state read at request time. AetherCloud never opens
an edge connection to answer these routes. `receivedAt` is freshness evidence
about the report, not proof that the physical device is currently in the
reported state, and a recent `receivedAt` does not make the data live. Render it
as a relative age rather than as a bare timestamp; a bare timestamp reads as
current state. The edge runtime remains authoritative for live point state and
physical control.

## Reading the Integration projection requires the shared PostgreSQL store

`AETHER_CLOUD_INTEGRATION_PROJECTION_STORE` selects `memory` or `postgres` and
defaults to `memory` in both the API and the CloudLink ingress.

In `memory` mode the API's projection repository is a separate in-process
instance from the CloudLink ingress's. The two are different processes, so the
API cannot observe anything the ingress received and both routes answer as
though no projection exists: the catalog is empty and every detail request
returns `404 integration-projection-not-found`. That is configuration, not a
defect, and it is the first thing to check when the catalog looks broken.

The two processes share data only when both set
`AETHER_CLOUD_INTEGRATION_PROJECTION_STORE=postgres` against the same database.
They still never share a role or a connection string: the API reads as
`aethercloud_app` through `AETHER_CLOUD_POSTGRES_URL`, and the ingress writes as
the narrower `aethercloud_cloudlink_ingress` through
`AETHER_CLOUD_CLOUDLINK_INGRESS_POSTGRES_URL`. See
[CloudLink ingress deployment](cloudlink-ingress-deployment.md) for the ingress
side, including the fact that its only authentication is your Broker ACL.

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

Fleet, Audit, and Integration projection routes return typed `400 invalid-input`,
`401 unauthenticated`, `403 permission-denied`, `404 gateway-not-found` or
`404 integration-projection-not-found`, `409` idempotency/conflict,
`429 rate-limited`, or `503` storage failures as applicable and also emit `x-correlation-id`.
PostgreSQL transport and row-decoding failures are sanitized into typed `503`
outcomes.

## Authentication

`/health` and `/api/v1/platform` are intentionally public and contain no Tenant
or infrastructure instances. Fleet, Audit, and Integration projection routes
require `Authorization: Bearer <token>`; the AetherEdge Claim route uses the
short-lived Enrollment Token instead of a user JWT. Railway production sets `AETHER_CLOUD_AUTH_MODE=supabase-jwt` and
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
