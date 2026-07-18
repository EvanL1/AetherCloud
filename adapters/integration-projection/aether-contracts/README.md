# AetherContracts integration adapter

This adapter consumes the unpublished AetherContracts `0.1.0-alpha.4`
Integration v1 alpha 1 candidate. The pinned Schemas, Home Assistant mapping
profile, fixtures, and SHA-256 lock are test inputs, not a claim that alpha.4
has been published or adopted by the repository-wide consumer lock.

The public `payload` is closed `snake_case` contract data. Gateway credentials
belong only to the adapter-owned outer envelope:

```json
{
  "credential": {
    "credential_id": "gateway-credential-003",
    "proof": "opaque-proof"
  },
  "payload": {
    "schema": "aether.integration.topology-snapshot.v1alpha1"
  }
}
```

Decode and map a topology report before invoking the application use case:

```ts
const decoded = decodeIntegrationTopologyEnvelope(rawBytes);
const result = await reportIntegrationTopology.execute(
  commandContext,
  toReportIntegrationTopologyInput(decoded),
);
```

Observation envelope decoding performs strict wire validation but deliberately
does not resolve entity points. Pass its mapped input directly to
`ReportIntegrationObservations`; that authenticated use case loads the current
projection and performs contextual generation, reference, quality, and type
validation:

```ts
const decoded = decodeIntegrationObservationEnvelope(rawBytes);
const result = await reportIntegrationObservations.execute(
  commandContext,
  toReportIntegrationObservationsInput(decoded),
);
```

`decodeIntegrationObservationPayload(rawBytes, topology)` remains available
for fixture conformance and other callers that already possess an accepted
topology.

The strict decoder rejects duplicate keys after escape decoding, malformed
UTF-8 or Unicode surrogate pairs, unsafe and non-finite JSON numbers, malformed
syntax, and input over the adapter's explicit resource budgets. The default
envelope binding is capped at 4 MiB, 16 nesting levels, 16 members per object,
65,536 items per array, 16,384 UTF-16 code units per JSON string, and 128
characters per number token.
