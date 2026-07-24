---
title: AetherIoT product family
description: Place AetherCloud beside AetherEdge and AetherContracts without blurring edge, cloud, provider, or protocol authority
updated: 2026-07-16
status: normative
---

# AetherIoT product family

AetherIoT is the umbrella project and public platform identity. It is not an
additional runtime, control plane, or protocol.

```text
AetherIoT
├── AetherEdge       edge runtime, Kernel, CLI, and SDK
├── AetherCloud      cloud fusion and governed control plane
└── AetherContracts  public specifications, Schemas, fixtures, and TCK

AetherEMS            industry solution built on the platform
```

The edge repository formerly named `EvanL1/AetherIot` moves to
`EvanL1/AetherEdge`. Existing `aether-*` crates and binaries, the `aether` CLI,
`aether-edge-sdk`, configuration identifiers, installer names, and CloudLink
contract identifiers remain stable.

## Authority does not move with the name

- AetherEdge remains authoritative for live point state, acquisition,
  deterministic rules, safety interlocks, local policy, and final physical
  execution.
- AetherCloud remains authoritative for desired placement and governed cloud
  jobs.
- A provider remains authoritative for the actual existence and native state
  of its resources.
- AetherContracts remains the sole shared interoperability authority.

Published tags, evidence, provenance records, and digest-pinned
AetherContracts releases are immutable. The alpha.3 release and imported
consumer closure may retain the historical AetherIot name. Repository renaming
does not change their conformance status.

The common documentation entry point is
[docs.aetheriot.dev](https://docs.aetheriot.dev/en/). Its primary
sections are Overview, AetherEdge, AetherCloud, AetherContracts, Tutorials,
Compatibility, and Roadmap. Product repositories remain authoritative for
implementation details.

The public [AetherIot to AetherEdge migration guide](https://docs.aetheriot.dev/en/migration/aetheriot-to-aetheredge/)
explains repository URL changes and the identifiers that remain stable.
