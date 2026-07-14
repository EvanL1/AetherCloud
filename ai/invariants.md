---
title: AetherCloud invariants
description: Non-negotiable authority, tenancy, safety, and documentation rules for every change
updated: 2026-07-15
status: normative
---

# AetherCloud invariants

These rules are more stable than the current directory layout.

1. An AetherIot edge runtime is authoritative for live point state and physical
   control.
2. Cloud unavailability cannot stop acquisition, local history, deterministic
   rules, alarms, or safety behavior at a commissioned edge.
3. AetherCloud stores desired, reported, and applied state as three separate
   facts. Delivery, download, or validation never implies applied state.
4. Cloud work reaches an edge as an expiring, idempotently identified job, never
   as an ungoverned remote procedure call.
5. The edge may reject cloud intent under local compatibility, authorization,
   commissioning, or safety policy.
6. Every tenant-owned aggregate and event carries a tenant identity. Tenant
   context is resolved before a use case touches an adapter.
7. Queries and commands are distinct. Commands declare risk, permission,
   confirmation, idempotency, and audit policy.
8. Device control is deny by default and always audited.
9. AI, HTTP, CLI, and MCP interfaces invoke the same application use cases.
10. An AI agent cannot write PostgreSQL, a queue, object storage, or an edge
    session directly.
11. AI-generated explanations and plans carry provenance and never become
    authoritative device state.
12. Domain packages do not import Fastify, PostgreSQL clients, protocol SDKs, or
    concrete identity providers.
13. External-service tests do not belong to the default verification path.
14. Documentation describes implemented behavior as implemented and future
    behavior as planned; examples must not fabricate available commands.
15. Every indexed document has valid frontmatter and a matching entry in the
    machine-readable documentation manifest.
16. AetherCloud owns desired placement; a provider owns actual infrastructure
    state. A normalized projection never silently becomes either authority.
17. Provider identity is explicit. Credential syntax, length, or contents are
    never used to infer the provider.
18. Providers register through capability-driven Provider Adapters; adding one
    never requires a new core vendor branch.
19. Provider-specific capability remains available through namespaced
    extensions and is not hidden to manufacture false portability.
20. One deployment stack has one independently locked State. No State spans
    multiple provider connections or becomes tenant-global.
21. OpenTofu is the default infrastructure engine and Terraform is compatible;
    neither engine is the AetherCloud domain model.
22. Infrastructure plans are inspected through versioned JSON and saved before
    approval. The implemented engine port exposes no Apply operation; a future
    Apply command must consume an exact approved Plan after independent policy,
    permission, confirmation, and audit checks.
23. Infrastructure workers are stateless. Durable State, plans, locks, logs,
    and receipts live in external stores with explicit retention.
24. Cloud credentials are short-lived where supported and otherwise referenced
    through a secret provider; they are not persisted in generated modules.
25. Provider observations match the requested Provider and CloudConnection,
    use canonical observation time, and contain only unique resources and
    declared capabilities before entering the normalized resource graph.
26. Expected provider authentication, configuration, permission, throttling,
    and availability failures remain typed results; failure is never
    normalized into an empty successful observation.
27. Gateway registration, bootstrap claim, active credential, CloudLink
    session, and runtime health are distinct facts. Success in one does not
    imply another.
28. Enrollment claims are Tenant/Project/Gateway bound and expiring. Raw claim
    tokens never enter Gateway persistence, logs, audit, documentation, or
    query results.
29. CloudLink acknowledges ingress only after durable de-duplication and
    business acceptance. Reconnect resumes from the cloud's durable cursor.
30. A newer authenticated CloudLink session fences every older session for the
    same Gateway credential generation.
31. Telemetry and alarm history in cloud storage always remains a time-stamped,
    freshness-labelled projection of edge-authoritative facts.
32. Aggregate change, required audit, and outbox delivery are one transaction
    before a command is exposed through a production interface.
33. Saved Plan binaries and raw Plan JSON are sensitive. Only encrypted
    artifact references, digests, validated summaries, and policy evidence may
    enter application receipts, logs, audit, prompts, or agent context.
34. IoT business telemetry is a replay-safe Tenant product-data context. It is
    never modelled primarily as OpenTelemetry metrics, and its cloud history is
    never presented as edge live-state authority.
35. A telemetry acknowledgement follows durable de-duplication and atomic
    business acceptance. A conflicting duplicate never advances a cursor.
36. OpenTelemetry SDKs stay outside domain and application packages. Exporter
    or Collector failure cannot change business results or edge behavior.
37. OpenTelemetry signals are sampled operational evidence, not durable audit,
    command Receipts, authorization evidence, or IoT history.
38. High-cardinality Tenant, Gateway, Point, Job, user, payload, credential, or
    free-form error values never become metric labels.
39. Infrastructure subprocesses use argv without a shell, an explicit
    environment, bounded output and time, restricted temporary files, and
    unconditional cleanup. Raw stdout and stderr never become logs or errors.
40. A successful infrastructure process is not lock evidence. A Plan receipt
    requires an acquired lease for its exact State key and proven release.
41. A Runtime Manifest is scoped only by an authenticated Gateway credential.
    Its generation is lossless and immutable: late generations remain history,
    while reuse of one generation with a different checksum fails closed.
42. Runtime Manifest checksum verification matches AetherIot's canonical JSON
    SHA-256 contract. A reported capability catalog is an observed edge fact,
    not cloud permission to execute that capability.
43. A published artifact revision is immutable and content-addressed. A release
    channel, desired deployment, edge report, and applied evidence are separate
    facts; none may rewrite or imply another.
44. Deployment timeout remains `unknown` until authoritative evidence resolves
    it. Pause, cancel, and rollback are cloud intent and never erase or
    fabricate an edge Applied fact.
45. A governed Job derives permission, risk, confirmation, replay safety, and
    physical-effect metadata from a declared edge capability. Callers cannot
    downgrade these fields, and undeclared capabilities fail closed.
46. Job timeout is `unknown`, not failure or permission to repeat an unsafe
    effect. Cancellation is cloud intent; a late edge Receipt remains a fact.
47. Receipt identity and lossless sequence are independent replay guards.
    Out-of-order Receipts remain pending until predecessors arrive, while a
    conflicting identity or sequence never advances the Job projection.
48. Audit is append-only Tenant/Project-scoped business evidence. OpenTelemetry
    correlation may point to it but never replaces authorization, confirmation,
    Receipt, or audit evidence.
49. External delivery starts only from a committed outbox fact. One stable
    delivery identity survives bounded webhook retries; exhaustion is a visible
    dead letter and redrive requires explicit confirmation.
50. Webhook commands name a governed destination reference, never an arbitrary
    URL or plaintext secret. URL resolution, signing, SSRF defence, and secret
    access remain adapter responsibilities.
51. A ready Data Export exposes an immutable object reference, digest, and
    lossless byte length. Inline unbounded history and object-store access
    outside an authorized application use case are forbidden.
52. MCP exposure is explicit and deny by default. Resource and tool adapters
    inject authenticated scope, advertise the underlying permission and command
    governance, invoke the same application use case, and reject planned tools
    without simulation.
