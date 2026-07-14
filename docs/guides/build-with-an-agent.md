---
title: Build with an AI agent
description: Use repository contracts and verification commands without inventing unsupported APIs
updated: 2026-07-14
status: implemented
---

# Build with an AI agent

AetherCloud documents architecture, product semantics, and implemented surfaces
as versioned repository assets so a coding agent can make a narrow change
without reconstructing intent from framework code.

## Give an agent context

Point the agent at the repository root and ask it to read, in order:

1. `AGENTS.md` for mandatory boundaries and verification
2. `skills/aether-cloud/SKILL.md` for task routing
3. the page selected from `llms.txt`
4. the nearest package README or contract for implementation details

Provider work also reads
[Add a Provider Adapter](add-provider-adapter.md) before changing the
application port or creating SDK code.

Example prompt:

```text
Read AGENTS.md and the aether-cloud skill. Add a read-only provider capability
query using the existing application boundary. Keep provider SDK types outside
the application package, update the HTTP reference, and run pnpm check.
```

## Require evidence

An agent should identify:

- the source of truth it is changing
- the application use case and permission boundary
- whether a contract is implemented or planned
- whether intent is provider-neutral or requires a namespaced provider feature
- the provider, deployment stack, State, and credential boundaries for
  infrastructure work
- the narrow behavior test that fails before implementation
- the verification commands that passed afterward

Reject generated code that writes an adapter from a route handler, treats cloud
telemetry as live authority, omits tenant context, or invents a CloudLink
message that is not present in the versioned contract package.

Also reject fixed vendor switches in core packages, provider inference from
credential contents, cross-provider State, parsing human IaC output, or an
infrastructure apply that lacks saved-plan and approval evidence.

## Documentation contract

Every indexed page has frontmatter containing `title`, `description`, `updated`,
and `status`. The same title, description, and status appear in
`ai/docs-manifest.json`. Status is one of `implemented`, `planned`, `mixed`,
`normative`, or `deprecated`. The repository test checks the manifest, local
links, required entry points, and unfinished placeholders.

When behavior changes, update code, tests, the narrow reference page, and the
manifest description if its routing meaning changed. Architectural authority or
dependency changes also require an ADR.

## Current verification

```bash
pnpm check
```

This runs documentation contracts, unit and integration tests, type checking,
linting, and formatting checks without external services.

## Agent capabilities

The repository-foundation milestone provides documentation for coding agents.
Remote MCP resources and operational tools are planned later, after identity,
tenant authorization, and the underlying query use cases exist. Repository
documentation must not instruct an agent to call those tools before they ship.
