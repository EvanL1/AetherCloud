---
title: CloudLink ingress deployment
description: Deploy the read-only CloudLink MQTT ingress process, configure its environment, and understand that its authentication is your Broker ACL
updated: 2026-08-01
status: mixed
---

# CloudLink ingress deployment

`apps/cloudlink` is a long-lived MQTT subscriber. It connects to an
operator-selected Broker, subscribes to CloudLink v1 uplink topics, and stores
Home Assistant topology and observation projections reported by AetherEdge
Gateways. It enables exactly one CloudLink extension,
`aether.cloudlink.integration.v1alpha1`, and nothing in this composition can
send a device command.

It listens on no HTTP port. It reads no `PORT` or `HOST` variable, serves no
health endpoint, and its Railway service therefore carries no healthcheck.

This process is experimental. Read
[Home Assistant integration](../concepts/home-assistant-integration.md) and
[CloudLink reliability and lifecycle](../concepts/cloudlink-and-core-state-machines.md)
before you decide whether to run it at all.

## Read this before you deploy: your Broker ACL is the authentication

The ingress verifies no Gateway signature, on the opening session or on any
later uplink. It resolves an operator-configured credential from the Gateway ID,
credential ID, and credential generation carried in the message itself. Those
three values are non-secret identifiers. The configured proof never crosses the
wire and AetherCloud never stores it.

- **Authentication depends entirely on Broker-side per-Gateway ACLs. Without
  them there is effectively no authentication.** Any publisher that can write
  `{prefix}/v1/gateways/{gatewayId}/up/...` and knows those three identifiers
  obtains a session, and can then report a Runtime Manifest and overwrite that
  Gateway's projected home topology and observations.
- **`AETHER_CLOUD_CLOUDLINK_MQTT_USERNAME` and
  `AETHER_CLOUD_CLOUDLINK_MQTT_PASSWORD` are the ingress's own Broker login.**
  They authenticate AetherCloud's subscriber connection to the Broker. They are
  not per-Gateway publisher ACLs and say nothing about which publishers may
  write a Gateway's uplink topics. Nothing in this repository configures,
  enforces, or verifies those ACLs, and the ingress starts successfully whether
  or not you created them.
- **No publisher attestation is consumed.**
  [ADR-0014](../adr/0014-cloudlink-mqtt-transport-binding.md) decision 5 expects
  a reviewed trusted connector to supply verified publisher attestation out of
  band for every publish. This composition consumes none of it. It assumes the
  Broker ACL is correct and has no way to detect that it is not.

Restricting each Gateway's Broker credentials to that Gateway's own topic
namespace is a required deployment step, not an optional hardening measure. This
mode suits a single household where you own the Broker and can confirm publisher
identity out of band. It is not Gateway authentication, must not be described as
such, and does not support multi-tenant or multi-Gateway scale.

## Single instance

The MQTT client id is stable, which is what makes the transport's `clean: false`
persistent Broker session resume across a restart instead of being orphaned. The
cost is that **two ingress instances sharing a client id evict each other from
the Broker**, disconnecting in a loop. A0 therefore supports exactly one ingress
instance per client id. Do not scale the Railway service beyond one replica.
Multi-instance socket ownership is a planned capability, not a supported
deployment.

## Required environment

Every variable below is read by `composeCloudLinkRuntime` in
`apps/cloudlink/src/runtime.ts` and rejected at composition time, before any
Broker connection exists. An empty string is treated as absent.

| Variable                                             | Rule                                                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `AETHER_CLOUD_CLOUDLINK_MQTT_URL`                    | Broker URL, `mqtt://` or `mqtts://`, at most 2048 characters. Credentials must not be embedded in it.                               |
| `AETHER_CLOUD_CLOUDLINK_TOPIC_PREFIX`                | Topic prefix. Validated by building the real uplink filters, so an unusable prefix fails at startup rather than inside `subscribe`. |
| `AETHER_CLOUD_TENANT_ID`                             | Canonical lowercase UUID.                                                                                                           |
| `AETHER_CLOUD_PROJECT_ID`                            | Canonical lowercase UUID.                                                                                                           |
| `AETHER_CLOUD_CLOUDLINK_TRUSTED_GATEWAY_CREDENTIALS` | JSON array of 1 to 64 Gateway credential entries. See below. **Contains secrets.**                                                  |

### `AETHER_CLOUD_CLOUDLINK_TRUSTED_GATEWAY_CREDENTIALS`

A JSON array. Each entry must be an object with exactly these four string
fields and no others:

| Field          | Rule                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `gatewayId`    | Canonical lowercase UUID.                                                                        |
| `credentialId` | 1 to 256 characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]*$`. Must be unique across all entries. |
| `generation`   | Canonical decimal uint64 string, no leading zero, at most `18446744073709551615`.                |
| `proof`        | 1 to 4096 UTF-8 bytes. **This is a long-lived secret.**                                          |

The shape below is the structure only. Replace every value; do not deploy any
value printed in this document.

```json
[
  {
    "gatewayId": "<the Gateway's canonical lowercase UUID>",
    "credentialId": "<the credential id you bound to that Gateway>",
    "generation": "<that binding's generation, as a decimal string>",
    "proof": "<the secret you and the Gateway agreed out of band>"
  }
]
```

`gatewayId`, `credentialId`, and `generation` are non-secret identifiers and the
ingress writes them to stderr when a Gateway presents a binding it cannot
resolve, so that you can find the mismatched entry. `proof` is a secret: it is
never written to a log line, an error message, an audit payload, a response, or
cloud storage, and it must never be pasted into an issue, a prompt, or agent
context. Store the whole variable as a secret in your platform's secret store
and rotate it by changing the Gateway binding and its `generation` together.

## Optional environment

| Variable                                                  | Default                          | Rule                                                                                          |
| --------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| `AETHER_CLOUD_CLOUDLINK_MQTT_CLIENT_ID`                   | `aether-cloud-cloudlink-ingress` | 1 to 128 characters. Read the single-instance constraint above before changing it.            |
| `AETHER_CLOUD_CLOUDLINK_MQTT_USERNAME`                    | none                             | At most 256 characters. The ingress's own Broker login, not a per-Gateway ACL.                |
| `AETHER_CLOUD_CLOUDLINK_MQTT_PASSWORD`                    | none                             | At most 4096 characters. **Secret.**                                                          |
| `AETHER_CLOUD_INTEGRATION_PROJECTION_STORE`               | `memory`                         | Exactly `memory` or `postgres`. Any other value, including an empty string, fails at startup. |
| `AETHER_CLOUD_CLOUDLINK_INGRESS_POSTGRES_URL`             | none                             | Required when the store is `postgres`. See the PostgreSQL section. **Secret.**                |
| `AETHER_CLOUD_CLOUDLINK_MQTT_TLS_CA_PATH`                 | none                             | Absolute path to the Broker CA certificate. See the TLS section.                              |
| `AETHER_CLOUD_CLOUDLINK_MQTT_TLS_CLIENT_CERTIFICATE_PATH` | none                             | Absolute path to the ingress client certificate.                                              |
| `AETHER_CLOUD_CLOUDLINK_MQTT_TLS_CLIENT_PRIVATE_KEY_PATH` | none                             | Absolute path to the ingress client private key.                                              |

## Broker TLS trust

[ADR-0014](../adr/0014-cloudlink-mqtt-transport-binding.md) decision 2 makes TLS
trust operator configuration, alongside the Broker URL and topic prefix. A0
exposes it, with one constraint inherited from the transport.

**The three TLS variables are one bundle.** Set all three or none. A CA alone
cannot be configured: the transport accepts the trust material only as a mutual
TLS bundle, so pointing at a private CA also means issuing the ingress a client
certificate and key. Setting one or two of the three fails at startup.

When all three are set:

- the URL must use `mqtts://`;
- each path must be absolute, and each file must be a regular non-symlink file
  of 1 byte to 1 MiB;
- the private key must deny group and other access, so `chmod 0600` it;
- certificate verification is required against the configured CA.

When none are set, the connection uses Node's default system trust chain.
Verification still applies over `mqtts://` — there is no configuration in this
composition that disables certificate verification, and none should be added.
A `mqtt://` URL is unencrypted and authenticates nothing; use it only against a
Broker reachable exclusively over a trusted private network.

## Projection store and the PostgreSQL role

`AETHER_CLOUD_INTEGRATION_PROJECTION_STORE` defaults to `memory`, which keeps
every projection in process memory and loses it on restart. CloudLink session
state follows the same choice, so a deployment can never combine durable
projections with sessions that vanish on restart.

`postgres` mode requires `AETHER_CLOUD_CLOUDLINK_INGRESS_POSTGRES_URL`, which
must use the `postgres:` or `postgresql:` protocol, authenticate as the
dedicated `aethercloud_cloudlink_ingress` role (or a Supabase pooler username
prefixed `aethercloud_cloudlink_ingress.`), include a password, and set
`sslmode=verify-full`. The role is deliberately narrower than the API's
`aethercloud_app`, because the ingress is a write path consuming untrusted
external input.

**Provision the role before you deploy.**
`supabase/migrations/20260728000900_cloudlink_ingress_role.sql` creates
`aethercloud_cloudlink_ingress` as `NOLOGIN` with no password and grants it only
the CloudLink session and Integration projection tables it needs. Giving it a
login is an out-of-band operator step:

```sql
ALTER ROLE aethercloud_cloudlink_ingress LOGIN PASSWORD '<a generated password>';
```

This matches how `aethercloud_cloudlink_health_worker` is handled. Only
`aethercloud_app` has an in-repository activation path, in
`apps/api/src/postgres-role-activation.ts`; the other two roles rely on this
operational step. Put the resulting connection string in
`AETHER_CLOUD_CLOUDLINK_INGRESS_POSTGRES_URL`, and note that it is a distinct
variable from `AETHER_CLOUD_POSTGRES_URL`, which continues to mean
`aethercloud_app` alone. Sharing one variable between the two services would
silently break one of them.

All three role migrations end with a guard that raises if the role already has
`LOGIN` or any other unsafe attribute. Re-running one of them against a
correctly provisioned database therefore raises
`... has unsafe role attributes`. That is expected, not a defect: Supabase
records applied migrations by version prefix and will not re-run one it has
already applied.

A0 has no PostgreSQL Runtime Manifest adapter. Manifest declarations live only
in this process even in `postgres` mode, so after a restart Integration uplinks
fail closed until each Gateway reports its manifest again. That is the correct
failure direction and must not be relaxed.

## Railway service

`railway.json` is a single-service file and already serves
`@aether-cloud/api`. The ingress needs its own Railway service whose
config-as-code path points at `railway.cloudlink.json`. Leave `railway.json`
untouched.

`railway.cloudlink.json` deliberately carries no `healthcheckPath`: the process
opens no HTTP port, so a healthcheck would fail every deployment rather than
observe anything. `drainingSeconds` is 30, which must stay above the process's
own shutdown deadline.

Set the environment variables on that service. Do not rely on project-level
shared variables for the two PostgreSQL URLs.

## Startup, logging, and shutdown

On a successful start the process writes one line to stderr naming the store it
selected, so you can confirm you did not deploy `memory` by accident:

```text
cloudlink ingress started with postgres projection store
```

A failed start writes `cloudlink failed to start: ...` and exits non-zero. An
unreachable Broker is a failed start, not a silent degraded mode.

Message-level output is deliberately low cardinality and never contains a
payload, a failure message, or a secret:

- `cloudlink uplink discarded: <code>` for a rejected uplink, carrying the
  failure code only;
- `cloudlink uplink deferred` when an uplink was processed but its
  acknowledgement could not be published, which means the Gateway will
  retransmit rather than that the ingress is under backpressure;
- `cloudlink uplink rejected` and `cloudlink internal failure` for the
  remaining outcomes;
- `cloudlink no trusted connector credential is configured: ...` naming the
  non-secret `gatewayId`, `credentialId`, and `generation` a Gateway presented
  so you can find the mismatched entry.

That last diagnostic is unbounded and message-driven, so a Gateway stuck on a
stale `generation` produces one line per message it publishes, at Broker message
rate. Fix the binding rather than filtering the log.

`SIGINT` and `SIGTERM` begin a shutdown that drains in-flight uplinks, closes
the Broker connection, and ends the PostgreSQL pool. That close has no inherent
upper bound - the Broker connect is bounded but the subscribe is not - so the
entry point races it against a 15 second deadline. A clean close exits zero and
usually within a second. If the deadline wins, the process writes
`cloudlink close exceeded 15000ms; exiting without a clean Broker close` and
exits non-zero, so a stuck shutdown is visible rather than looking like an
ordinary stop. A non-zero exit here means the Broker may still consider the
session attached; the next instance reclaims the client id when it connects.

The deadline is deliberately below `drainingSeconds`, so the process reports the
overrun itself instead of being replaced by an unexplained `SIGKILL`. Repeated
signals are safe: the handler stays registered and the close runs once, which
matters because `pnpm run` forwards `SIGTERM` to the script and then raises its
own on the way out.

## Verify locally

```bash
AETHER_CLOUD_CLOUDLINK_MQTT_URL=mqtt://127.0.0.1:1883 \
AETHER_CLOUD_CLOUDLINK_TOPIC_PREFIX=aethercloud \
AETHER_CLOUD_TENANT_ID=11111111-1111-4111-8111-111111111111 \
AETHER_CLOUD_PROJECT_ID=22222222-2222-4222-8222-222222222222 \
AETHER_CLOUD_CLOUDLINK_TRUSTED_GATEWAY_CREDENTIALS="$CREDENTIALS_JSON" \
pnpm --filter @aether-cloud/cloudlink start
```

With a Broker listening it prints
`cloudlink ingress started with memory projection store`. With none it prints
`cloudlink failed to start:` and exits non-zero, which is the correct behavior:
it never pretends to be connected.

`pnpm test:mqtt-integration` exercises the transport against a real local
Broker. `pnpm check` must never require one.
