# AetherCloud Agent Instructions

This file is the canonical instruction source for coding agents in this
repository. `CLAUDE.md` and `GEMINI.md` are symlinks to it, so every agent
reads and edits the same instructions.

## Product direction

AetherCloud is an AI-native, industry-neutral, multi-cloud IoT fusion and
control plane for AetherEdge edge runtimes and cloud-side workloads. It is a
separate product and repository, not a hosted copy of the edge runtime and not
a clone of another IoT or cloud-management platform.

The edge remains authoritative for live point state, acquisition, deterministic
rules, safety interlocks, and physical device control. Cloud failure must not
stop commissioned edge behavior.

AetherCloud is authoritative for desired placement and governed infrastructure
jobs. Each infrastructure provider is authoritative for the actual existence
and provider-native state of its resources.

## Architecture boundaries

Dependency direction is one-way:

```text
domain <- ports <- application <- interfaces/composition roots
             ^
             +---- adapters
```

- Frameworks, database clients, transports, and vendor SDKs stay outside the
  domain and application packages.
- Interfaces call application use cases. They do not write databases, queues,
  or edge sessions directly.
- Cloud sends desired state and capability jobs. An edge runtime validates and
  accepts, rejects, expires, or applies them under local policy.
- Multi-cloud fusion uses a capability-driven Provider Adapter registry. Core
  packages never branch on a fixed AWS/Azure/GCP-style vendor enum.
- Preserve provider-specific modules and extensions instead of reducing every
  provider to the lowest common denominator.
- OpenTofu is the default infrastructure engine and Terraform is compatible.
  Both implement an application-owned `InfrastructureEngine` port.
- One deployment stack owns one independently locked infrastructure state.
  Never create a tenant-wide or cross-provider global state file.
- Parse saved plans and state through versioned JSON output. Do not scrape
  human CLI output or raw state text.
- Treat saved Plan binaries and raw Plan JSON as sensitive. They never enter
  logs, audit payloads, prompts, agent context, or public responses. Persist an
  encrypted artifact reference, digest, validated summary, and policy evidence.
- Cloud connections use explicit provider identity and secret references.
  Never infer a provider from credential shape or write long-lived credentials
  into generated infrastructure code.
- Treat Provider Adapter output as untrusted external input. Validate Provider
  and Connection identity, observation time, uniqueness, and declared
  capabilities at the application boundary.
- Every Provider Adapter runs the shared conformance suite. Provider SDK tests
  use fixtures in the default verification path and never require a cloud
  account.
- Every Infrastructure Engine runs `infrastructureEngineConformance`. The
  current port is Plan-only and exposes no Apply operation.
- OpenTofu processes receive argv directly with no shell and only an explicit
  environment allowlist. Bound stdout and stderr, use 0700 temporary workspaces
  and 0600 sensitive files, and clean them on every outcome.
- A successful CLI exit is not State-lock evidence by itself. A Plan result
  requires an acquired lease for the exact State key and a proven release.
- PostgreSQL is the first cloud persistence adapter, not a domain abstraction.
- Begin as a modular monolith. A module becomes a service only after measured
  scaling or isolation requirements justify the operational cost.

## AI-native documentation

- `llms.txt` is the compact agent index.
- `ai/docs-manifest.json` is the machine-readable document catalog.
- Manifest entries keep a repository-local `path` for validation and an
  absolute `canonical_url` for retrieval. Published pages use the unified
  documentation site; internal Markdown uses GitHub; machine resources use
  Raw GitHub.
- `skills/aether-cloud/SKILL.md` routes task-specific agent work.
- `ai/invariants.md` lists rules that must survive refactors.
- Architecture decisions live under `docs/adr/`.
- Update a document's frontmatter, manifest entry, and `llms.txt` description
  together.
- Documentation must distinguish implemented behavior from planned contracts.

## Key documentation

These are the shortest paths to the most used pages. `llms.txt` and
`ai/docs-manifest.json` remain the complete catalog. `README.md` is a growth
surface and deliberately does not carry this index.

- [Product overview](docs/get-started/overview.md)
- [AetherIoT product family](docs/get-started/aetheriot-product-family.md)
- [Architecture and dependency rules](docs/concepts/architecture.md)
- [Edge, cloud, and provider authority](docs/concepts/edge-cloud-boundary.md)
- [Gateway identity and enrollment](docs/concepts/gateway-identity-and-enrollment.md)
- [CloudLink and core state machines](docs/concepts/cloudlink-and-core-state-machines.md)
- [IoT telemetry](docs/concepts/iot-telemetry.md)
- [Home Assistant integration](docs/concepts/home-assistant-integration.md)
- [Governed Home Assistant power control](docs/concepts/home-assistant-governed-control.md)
- [Desired, Reported, and Applied deployment](docs/concepts/desired-reported-applied-deployment.md)
- [Governed capability jobs](docs/concepts/governed-capability-jobs.md)
- [MCP application interface](docs/concepts/mcp-application-interface.md)
- [Audit and integrations](docs/concepts/audit-and-integrations.md)
- [Plan infrastructure safely](docs/guides/plan-infrastructure.md)
- [Build with an AI agent](docs/guides/build-with-an-agent.md)
- [Application contract catalog](docs/reference/application-contracts.md)

## Safety

- Exposed capabilities are deny by default.
- Queries and commands are distinct types.
- Commands declare risk, permission, idempotency, confirmation, and audit policy.
- AI agents may propose plans or create governed jobs; they never bypass the
  application layer to write storage or an edge connection.
- Cross-tenant access is forbidden unless an explicit platform-level use case
  authorizes it and records an audit event.
- Infrastructure `apply` and `destroy` are planned separate commands, not Plan
  modes. They require a saved Plan, policy evaluation, risk classification,
  confirmation, locking, and audit before implementation or exposure.

## TypeScript conventions

- Node.js 24, TypeScript 5.9, ESM only. Upgrade only when the complete lint and
  build toolchain declares support for the target TypeScript release.
- Keep `strict`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes` enabled.
- Do not use `any`. Decode all external input at runtime.
- Do not use JavaScript `number` for protocol `int64` values without an explicit
  safe-range conversion.
- Library code returns typed domain failures. Composition roots translate them
  into transport responses and process exit codes.
- Database records and Fastify request types are not domain models.

## Verification

Write behavior tests before implementation. Run the narrowest affected test,
then:

```bash
pnpm check
```

The default verification path must not require PostgreSQL, an edge device, or
any other external service.

The real local OpenTofu integration is opt-in through
`pnpm test:opentofu-integration`; it must not enter the default test path.
