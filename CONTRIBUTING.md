# Contributing to AetherCloud

These are contributor workflows, not a product installation path. The rules
that govern what may change live in [AGENTS.md](AGENTS.md); read it first.

## Requirements

- Node.js 24
- pnpm 11

## Local development

```bash
pnpm install
pnpm check
pnpm dev:api
```

The development API listens on `127.0.0.1:3000` by default, and `GET /health`
is the initial readiness endpoint.

## Verification

`pnpm check` is the default path. It must keep passing without PostgreSQL, an
edge device, a Broker, or a cloud account; anything that needs one of those is
opt-in and must stay out of the default path.

Write behavior tests before implementation, and run the narrowest affected test
before the full check.

## Documentation changes

Update a document's frontmatter, its `ai/docs-manifest.json` entry, and its
`llms.txt` description together. Documentation must distinguish implemented
behavior from planned contracts.
