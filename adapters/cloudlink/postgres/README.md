# PostgreSQL CloudLink session adapter

This package durably implements the application-owned CloudLink session and
session-challenge repository ports. A Tenant/Project/Gateway head row is the
serialization point for challenge issue, session fencing, epoch allocation,
and durable cursor handoff.

Apply `migrations/0005_cloudlink_session.sql` after the Gateway identity
migration. Runtime access must use a PostgreSQL role without `BYPASSRLS`; every
repository transaction sets `aethercloud.tenant_id` before reading or writing
Tenant data.

The challenge acceptance transaction locks the Gateway head before the
challenge row. It checks the strict expiry boundary, consumes one
authentication fingerprint idempotently, fences the old session, increments
the epoch without wrapping, opens the replacement session, and advances the
head before commit.

The default test suite uses a fake PostgreSQL executor and does not need a
database. Real PostgreSQL locking, restart durability, constraint, and
Row-Level Security evidence is opt-in:

```bash
AETHER_CLOUD_POSTGRES_URL=postgres://.../aethercloud_test \
  pnpm test:postgres-integration
```

The integration test refuses any database path other than
`/aethercloud_test`. This package is not yet installed in a production
composition root and does not run migrations at process startup.
