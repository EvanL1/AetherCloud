# PostgreSQL integration-control adapter

This adapter is the durable control ledger for AetherCloud Integration
Control. It stores immutable governed intents, session-bound offer outbox
records, ordered receipt evidence, exact stream cursors, governance audit
events, and durable acknowledgement outbox records.

Apply `migrations/0004_integration_control.sql` after migrations `0001`,
`0002`, and `0003`. Runtime access must use a PostgreSQL role without
`BYPASSRLS`; every transaction sets `aethercloud.tenant_id` before reading or
writing tenant data.

The default test suite uses a fake PostgreSQL client. Real PostgreSQL
concurrency and restart tests are opt-in:

```bash
AETHER_CLOUD_POSTGRES_URL=postgres://.../aethercloud_test \
  pnpm test:postgres-integration
```

The integration test refuses to run against any database whose path is not
exactly `/aethercloud_test`.
