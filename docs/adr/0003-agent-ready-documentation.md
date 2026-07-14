---
title: ADR-0003: Agent-ready documentation
description: Treat LLM-readable documentation as a tested product interface
updated: 2026-07-14
status: normative
---

# ADR-0003: Agent-ready documentation

## Status

Accepted on 2026-07-14.

## Context

Coding agents need product semantics and safety constraints that cannot be
reliably inferred from TypeScript types or route implementations. Conventional
navigation and generated API reference alone do not explain authority,
implemented-versus-planned status, or how to verify a cross-module change.

Neon demonstrates a useful layered model: a compact `llms.txt` index,
Markdown-addressable documentation, task-oriented Agent Skills, and MCP
capabilities built on real product APIs. AetherCloud needs the same development
quality while retaining its own edge-first safety model.

## Decision

Treat agent documentation as a versioned, tested interface:

- `llms.txt` is the compact primary index.
- Markdown pages provide progressively deeper product and engineering context.
- `ai/docs-manifest.json` provides machine-readable titles, descriptions, paths,
  and audiences.
- `skills/aether-cloud/SKILL.md` routes tasks and carries non-negotiable rules.
- `AGENTS.md` is the repository-wide contributor contract.
- Tests validate required assets, frontmatter parity, local links, and incomplete
  placeholders.
- Manifest schema version 2 requires each indexed page to declare one machine-
  readable status: `implemented`, `planned`, `mixed`, `normative`, or
  `deprecated`.

Documentation states whether behavior is implemented or planned. Later MCP
resources will serve these documents through a read-only application surface;
MCP command tools wait for the corresponding authorized use cases.

## Consequences

- Behavior and documentation changes ship together.
- Agents receive concise routing before loading deep context.
- Documentation drift becomes a failing test instead of a review-only concern.
- Public docs hosting can render the same source files rather than creating a
  second knowledge base.
- The manifest schema must be versioned before incompatible fields are added.
