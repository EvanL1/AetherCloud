# AetherCloud

[中文说明](README-CN.md)

**Documentation website:** [docs.aetheriot.dev/aethercloud](https://docs.aetheriot.dev/aethercloud/)

**The evolving agent and control plane for AetherIoT.**

AetherCloud is where human intent becomes governed desired state, capability
jobs, integration work, and explainable change across AetherEdge runtimes and
cloud providers. It is not a hosted copy of the edge runtime, and it is not a
generic multi-cloud dashboard with an AI chat box added on top.

The product direction is conversation-first: a person describes an outcome,
the Agent discovers the capabilities that actually exist, proposes a typed
change, explains its effects, requests confirmation when risk requires it, and
then commissions deterministic behavior to the edge.

The complete end-user conversational experience is **in development**. This
repository currently provides tested domain and application foundations for
that direction; it does not yet ship a production end-user Agent.

> **Want something you can run today?** Start with the
> [AetherEdge safe commissioning journey](https://docs.aetheriot.dev/overview/user-journeys/) —
> install a safe-empty runtime, prove the read-only data path, and only then
> commission deterministic behavior for this control plane to coordinate.

AetherCloud is one product in the
[AetherIoT platform](docs/get-started/aetheriot-product-family.md), alongside
[AetherEdge](https://github.com/EvanL1/AetherEdge) and
[AetherContracts](https://github.com/EvanL1/AetherContracts).

## Product role

| Concern                                                           | Authority               |
| ----------------------------------------------------------------- | ----------------------- |
| Human intent, semantic context, proposals, explanations           | AetherCloud Agent plane |
| Desired placement and governed infrastructure jobs                | AetherCloud             |
| Public message shapes and capability vocabulary                   | AetherContracts         |
| Live point state, deterministic rules, safety, physical execution | AetherEdge              |
| Provider-native resource existence and state                      | Infrastructure provider |

Cloud failure must not stop commissioned edge behavior. The Agent may propose
change, but it cannot bypass application use cases, policy, confirmation, audit,
or the edge's final local decision.

## AI-native control loop

```text
Describe outcome
      ↓
Discover typed capabilities and current context
      ↓
Generate a versioned proposal
      ↓
Validate policy, risk, permissions, and compatibility
      ↓
Explain or simulate the expected change
      ↓
Confirm when required
      ↓
Commission desired behavior
      ↓
Observe, explain, and revise
```

“No configuration interface” does not mean “no visibility.” The Agent can
generate a temporary summary, diff, timeline, or simulation when the person
needs to inspect a decision. Those views are evidence for a conversation, not
another permanent configuration maze.

## What exists today

| Area                                                                                                 | Status                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant/project boundaries, Provider Adapter registry, discovery, deployment stacks                   | Implemented foundations                                                                                                                                                                                                                                 |
| Plan-only OpenTofu/Terraform engine with exact-state locking evidence                                | Implemented and opt-in integration tested                                                                                                                                                                                                               |
| Gateway identity, enrollment, CloudLink sessions, manifests, telemetry, alarms                       | Partial domain/application and persistence foundations                                                                                                                                                                                                  |
| Home Assistant topology and observation projection                                                   | Experimental Edge connector, durable CloudLink transport, memory/PostgreSQL projection, and bounded catalog/by-ID query interfaces implemented; release composition and public service planned                                                          |
| Governed Home Assistant power control                                                                | Experimental and default off; strict CloudLink MQTT composition, application use cases, memory/PostgreSQL ledgers, signing adapters, and optional MCP adapters exist; production composition, keys/Broker proof, and public Agent access remain planned |
| Artifacts, desired/reported/applied deployment, governed capability jobs                             | Partial foundations                                                                                                                                                                                                                                     |
| Audit query, resumable event delivery, webhooks, exports, MCP application interface                  | PostgreSQL-backed Audit JSON/SSE query composition and stateless MCP Streamable HTTP are implemented; production IAM, live delivery, several adapters, and workers remain planned                                                                       |
| Production credential lifecycle, durable remote state and encrypted plan storage                     | Planned                                                                                                                                                                                                                                                 |
| Infrastructure Apply and Destroy                                                                     | Planned as separate governed commands                                                                                                                                                                                                                   |
| Physical-space semantics, conversational Agent, proposal compiler, simulation, continuous adaptation | Planned product work                                                                                                                                                                                                                                    |

“Implemented foundation” means the behavior has tested domain/application
contracts and, where stated, adapters. It does not imply a public production
service. See the
[current implementation audit](docs/concepts/current-state-audit.md) for exact
evidence and missing composition work.

The [Home Assistant integration](docs/concepts/home-assistant-integration.md)
documents the executable source-build data path and its remaining release,
composition, query, and control gates.
The separate
[governed Home Assistant power control](docs/concepts/home-assistant-governed-control.md)
page explains the fixed semantic action, confirmation and receipt model, and
why the current source foundation is not yet an end-user control product.

## Safety rules

- Capabilities are deny by default.
- Queries and commands are distinct types.
- Commands declare risk, permission, idempotency, confirmation, and audit
  policy.
- Agent output is untrusted input until the application boundary validates it.
- Saved infrastructure Plans and raw Plan JSON never enter prompts, logs,
  audit payloads, or public responses.
- Infrastructure Apply and Destroy do not exist in the current port.
- Cross-tenant access requires an explicit platform-level use case and audit.

## Contributing

Development setup and verification live in
[CONTRIBUTING.md](CONTRIBUTING.md). Repository rules for agents and
contributors live in [AGENTS.md](AGENTS.md).
