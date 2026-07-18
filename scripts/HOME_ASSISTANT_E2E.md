# Home Assistant real-Broker verification

Run the opt-in harness from the AetherCloud repository:

```bash
pnpm test:home-assistant-e2e
```

It requires a local Mosquitto executable and an AetherEdge checkout next to
AetherCloud. `MOSQUITTO_BIN` and `AETHEREDGE_ROOT` may override those paths.
The default test suite does not run this harness.

The harness starts a temporary loopback Broker, the real AetherCloud MQTT
application bridge, the real AetherEdge `aether-io` Home Assistant composition,
and a loopback Home Assistant WebSocket mock. Verification is deliberately
split into two phases.

### Phase 1: Gateway-signed session path

The harness acts as a protocol client and sends a formally decoded
`session-challenge-request`. The application use cases persist and sign the
Cloud challenge, the client verifies it, signs the Gateway hello with a
different Ed25519 key, and the application atomically opens the session before
publishing `session-accepted`.

This phase verifies:

- unrelated Cloud public-key material cannot verify the challenge;
- an exact challenge-request retry returns the same challenge bytes;
- an exact signed-hello retry recovers the same session identity and epoch;
- the Gateway hello contains a signature, never a reusable credential proof.

The adjacent behavior test also fixes the validity boundary: a challenge is
expired when evaluation time equals `expires_at_ms`.

```bash
pnpm exec vitest run \
  apps/cloudlink/test/home-assistant-e2e-gateway-session.test.ts
```

### Phase 2: Gateway-signed Home Assistant business path

The AetherEdge process establishes its own Gateway-signed session with the same
commissioned Gateway key. Every Home Assistant business uplink is signed with
that session identity, epoch, and credential generation. AetherCloud verifies
the Ed25519 signature, active session, exact delivery descriptor, canonical
business-payload digest, and message expiry before invoking an application use
case. In this phase the harness verifies:

- topology and observations reach the Cloud durable projection and are
  acknowledged;
- topology and observations use the same active Gateway-signed session;
- a signed `device.power.set.v1` offer reaches the Edge;
- the Edge applies local policy and emits only the fixed provider power call;
- the Gateway-signed provider-accepted receipt is atomically persisted with a
  durable acknowledgement;
- the Edge removes its receipt only after that acknowledgement.

## Security and scope boundaries

- Phase 1 uses the real challenge-request, Cloud challenge signer, Gateway
  hello authenticator, application use cases, MQTT codec, and application
  bridge. Its repository, credential claim, key lookup, and generated keys are
  still in-memory test dependencies.
- Phase 2 uses the real challenge request, Cloud challenge signature, Gateway
  hello signature, per-uplink Gateway signatures, active-session checks,
  application use cases, MQTT codec, and application bridge. Key lookup,
  credential commissioning, generated keys, and repositories remain in-memory
  test dependencies.
- The Broker is anonymous, loopback-only, and intentionally has no TLS. This is
  acceptable only for the isolated local harness.
- The current unsigned, challenge-unbound `session-accepted` message, in-memory
  key and credential dependencies, and non-atomic heartbeat authentication and
  liveness update remain production blockers. This harness is therefore not a
  production end-to-end authentication claim.
- A commissioned Runtime Manifest is pre-seeded because the current Edge Home
  Assistant composition does not report that manifest in this flow.
- The Home Assistant endpoint is a protocol-faithful loopback mock, not a real
  household installation.
- Test-only keys and credentials exist only in harness memory and selected
  child environments for one run. Child environments use an explicit allowlist
  and do not inherit unrelated cloud or registry credentials.
- Evidence is a mode-`0600` temporary JSONL file containing bounded status and
  capability facts, never key material, credential proofs, provider payloads,
  or evidence-digest values.
- The Broker, child runtime, MQTT clients, keys, and evidence directory are
  terminated or deleted on success, failure, and handled termination signals.
  The success summary reports cleanup only after the temporary directory has
  actually been removed.
