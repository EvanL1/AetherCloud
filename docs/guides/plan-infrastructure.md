---
title: Plan infrastructure safely
description: Run the implemented governed OpenTofu Plan worker without implying infrastructure mutation or exposing sensitive engine output
updated: 2026-07-14
status: implemented
---

# Plan infrastructure safely

This guide describes AetherCloud's implemented infrastructure Plan boundary.
It produces an immutable, policy-evaluated receipt for one Deployment Stack.
There is no Apply operation in the current `InfrastructureEngine` port, so a
successful or policy-approved Plan cannot mutate provider infrastructure.

## Implemented contract

`PlanDeploymentStack` is the transport-neutral application command. It:

1. runtime-decodes Tenant, Project, Stack, engine, idempotency, expiry, module,
   topology, and content digests;
2. requires the `infrastructure.stack.plan` permission before resolving a
   Stack or invoking an engine;
3. replays the same scoped idempotency request and rejects conflicting reuse;
4. resolves exactly one `opentofu` or `terraform` implementation from the
   dynamic `InfrastructureEngineRegistry`;
5. supplies one generated Plan identity, one Deployment Stack, and immutable
   module and topology selections to `InfrastructureEngine.plan`;
6. fails closed unless the result targets the exact Stack and State, proves
   that the State lock was acquired and released, and references an encrypted
   sensitive Plan artifact by digest;
7. summarizes create, update, delete, replace, and read changes for storage and
   policy without returning provider resource details in the Plan receipt;
8. records the policy decision as `policy-approved` or `policy-rejected` and
   keeps approval at `not-requested`.

The Plan repository key is Tenant + Project + idempotency request. A request in
one tenant cannot retrieve another tenant's receipt.

```text
authorized Plan request
        ↓
tenant/project Stack lookup → one remote State key
        ↓
InfrastructureEngine.plan → encrypted saved-Plan reference + lock evidence
        ↓
runtime contract checks → change summary → policy
        ↓
idempotent Plan receipt (never Apply)
```

## Sensitive Plan data

Treat the saved Plan binary and raw versioned JSON as secret-bearing data.
Both [OpenTofu `show`](https://opentofu.org/docs/v1.10/cli/commands/show/) and
[Terraform `show`](https://developer.hashicorp.com/terraform/cli/commands/show)
warn that sensitive values can appear in plaintext JSON output. Raw Plan JSON is sensitive: never put it in logs, audit payloads, HTTP responses, test snapshots, prompts, or agent context.

The application receives only the validated change list needed for policy,
then persists a summary plus the encrypted artifact reference and SHA-256
digest. The actual CLI worker must write the saved Plan and JSON into an
isolated workspace, encrypt the durable artifact, and destroy its workspace
after upload. It must never commit either file to source control.

## Implemented OpenTofu worker

`OpenTofuInfrastructureEngine` under
`adapters/infrastructure/opentofu` is a real Plan-only CLI adapter. Its async
factory executes `tofu version -json` and derives the descriptor version from
that response instead of hard-coding one. For each Plan it uses
`NodeOpenTofuProcessRunner` to pass an executable and argv directly to
`child_process.spawn` with `shell: false`:

```text
tofu init -input=false -no-color
tofu validate -json
tofu plan -json -input=false -lock=true -lock-timeout=… \
  -detailed-exitcode -no-color -out=<saved-plan>
tofu show -json <saved-plan>
```

Plan exit code 0 means a successful empty diff, 2 means a successful non-empty
diff, and every other exit is a typed failure. The versioned `show` JSON maps
create, update, delete, read, no-op, and both replacement action orders into
the application contract. Unsupported JSON major versions and unknown actions
fail closed.

Module configuration and topology variables enter through an injected artifact
resolver. The worker verifies each selected SHA-256 digest before writing JSON
to `main.tf.json` and `aether.auto.tfvars.json`. An injected lock manager must
return a real lease for the exact Stack State key, and the result is successful
only after that lease reports successful release. OpenTofu also always receives
`-lock=true`.

The Node workspace factory creates a fresh 0700 directory and writes source and
saved Plan files as 0600. It rejects symbolic-link and oversized saved Plans,
bounds captured subprocess output, handles deadlines and cancellation, and
removes the complete workspace on success or failure. The subprocess receives
only the explicitly supplied environment; observer events contain only stage,
outcome, exit status, duration, and correlation identity.

## Adapter conformance and tests

Every infrastructure engine adapter must run
`infrastructureEngineConformance` from
`@aether-cloud/infrastructure-conformance`. The shared suite verifies Plan,
Stack, and State correlation; encrypted sensitive-artifact metadata; lock
evidence; JSON format version; and the absence of `apply`.

`MemoryInfrastructureEngine`, `InMemoryInfrastructurePlanRepository`, and the
fake boundaries around the OpenTofu adapter keep the default test path free of
an OpenTofu binary, network, remote State, secret provider, and cloud account.
The real provider-free local CLI integration is explicitly opt-in:

```bash
pnpm test:opentofu-integration
```

It uses the installed OpenTofu binary, an ephemeral local workspace, an
in-memory lock lease, and an AES-GCM test store. It proves the real command
sequence and cleanup without claiming production State or storage.

## Still planned

Production remote State integration, a distributed lock implementation,
short-lived credential resolution, a production encrypted artifact store,
durable Plan repository, audit sink, cost model, sandboxed worker deployment,
Terraform CLI adapter, and public HTTP endpoint remain planned. The implemented
Node adapter is a real local OpenTofu process, but it is not proof of a real
cloud account or production remote State.

Apply, refresh mutation, import, and destroy remain completely unimplemented
future commands with their own permission, confirmation, approval, audit, and
recovery contracts. Do not add them as modes or flags on
`PlanDeploymentStack`.

Read [multi-cloud fusion](../concepts/multi-cloud-fusion.md) for provider and
State boundaries and [AI invariants](../../ai/invariants.md) before extending
this workflow.
