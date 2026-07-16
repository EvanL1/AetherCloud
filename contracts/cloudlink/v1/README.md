# CloudLink MQTT v1 AetherCloud implementation overlay

This directory is AetherCloud's product integration surface for the public
AetherContracts release. AetherContracts `v0.1.0-alpha.3`, pinned by the root
consumer lock, is the sole wire authority. Imported files here are exact release
bytes; the remaining manifest, profile, gate, scenario, and migration files are
non-authoritative AetherCloud implementation/readiness/evidence overlays. They
cannot redefine fields, replay identity, failure codes, authentication, or ACK
semantics. Complete distribution adoption is not production conformance.

CloudLink is the transport-neutral application protocol. MQTT 3.1.1 with QoS
1 and non-retained messages is its first binding. MQTT PUBACK never proves
application durability. A delivery is removable at the Edge only after a
matching `durable-ack` binds the verified session, stream epoch, batch
position, batch identity, business digest, and durable receipt.

## Implemented alpha.3 rules

- JSON is strict and closed with `additionalProperties: false`.
- Protocol `uint64` and Unix millisecond times are canonical decimal strings.
- Gateway and session identities are canonical lowercase UUIDs.
- One durable stream position identifies one business batch, not one sample.
- The business digest is `sha256:` plus the lowercase SHA-256 of RFC 8785 JCS
  over `{protocol_version,message_kind,payload}` in that field vocabulary.
- Session, transport retry, MQTT properties, trace context, and replay attempt
  metadata are outside the business digest.
- The exact proposal transcript distinguishes Gateway signatures from
  trusted-adapter external origin evidence. Production key provisioning,
  rotation, revocation, and verifier ownership remain planned, so this is not
  a production authentication profile. Proof material
  must never be logged.
- Telemetry carries Edge-owned PointAddress, finite `f64` value, source time,
  quality, and topology evidence. Optional model binding may be supplied only
  when commissioning actually established it.
- V1 contains no RPC, Point/Register write, retained command, or physical
  control message.

`fixture-manifest.json` and the root complete-consumer lock pin the alpha.3
release bytes with `pending_imports: []`. Product tests execute the public TCK
and language behavior, but this does not claim production credential,
PostgreSQL crash durability, signed ACK, or legacy cutover conformance.

`wire-profile.json`, the interoperability files, and historical
`session-authentication.schema.json` are AetherCloud overlays only. The public
profile fixes replay identity as `(gateway_id, stream_id, stream_epoch,
position)`; `batch_id` and `digest` are stable bindings. The alpha.3 application
ACK is unsigned and production crash durability remains unproven.
