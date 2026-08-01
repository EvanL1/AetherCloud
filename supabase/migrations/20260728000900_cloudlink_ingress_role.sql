DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'aethercloud_cloudlink_ingress'
  ) THEN
    CREATE ROLE aethercloud_cloudlink_ingress
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'aethercloud_cloudlink_ingress'
      AND (
        rolcanlogin OR
        rolsuper OR
        rolcreatedb OR
        rolcreaterole OR
        rolinherit OR
        rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION 'aethercloud_cloudlink_ingress has unsafe role attributes';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE postgres
  TO aethercloud_cloudlink_ingress;
GRANT USAGE ON SCHEMA aethercloud
  TO aethercloud_cloudlink_ingress;

-- CloudLink session lifecycle: open/resume sessions, issue and accept
-- challenges, and record durable per-stream cursors. Every statement runs
-- inside PostgresCloudLinkSessionRepository's tenant-scoped transaction,
-- which sets aethercloud.tenant_id, so the existing tenant policies on
-- these tables (created without a TO clause, so they bind every role)
-- already confine this role to its own tenant. No additional policy is
-- required here, unlike the health worker role, which reads across
-- tenants outside that transaction.
GRANT SELECT, INSERT, UPDATE ON aethercloud.cloudlink_sessions
  TO aethercloud_cloudlink_ingress;
GRANT SELECT, INSERT, UPDATE ON aethercloud.cloudlink_session_heads
  TO aethercloud_cloudlink_ingress;
GRANT SELECT, INSERT ON aethercloud.cloudlink_session_open_requests
  TO aethercloud_cloudlink_ingress;
GRANT SELECT, INSERT, UPDATE ON aethercloud.cloudlink_durable_cursors
  TO aethercloud_cloudlink_ingress;
GRANT SELECT, INSERT, UPDATE ON aethercloud.cloudlink_session_challenges
  TO aethercloud_cloudlink_ingress;

-- Integration projection: persist topology snapshots and observation
-- batches reported by edge Gateways, and track the CloudLink delivery
-- ledger that makes that persistence idempotent and durably acknowledged.
GRANT SELECT, INSERT, UPDATE ON aethercloud.integration_projections
  TO aethercloud_cloudlink_ingress;
GRANT SELECT, INSERT ON aethercloud.integration_projection_topologies
  TO aethercloud_cloudlink_ingress;
GRANT SELECT, INSERT ON aethercloud.integration_projection_batches
  TO aethercloud_cloudlink_ingress;
GRANT SELECT, INSERT ON aethercloud.integration_projection_ingress_requests
  TO aethercloud_cloudlink_ingress;
GRANT SELECT, INSERT, UPDATE
  ON aethercloud.integration_projection_cloudlink_streams
  TO aethercloud_cloudlink_ingress;
GRANT SELECT, INSERT
  ON aethercloud.integration_projection_cloudlink_deliveries
  TO aethercloud_cloudlink_ingress;
-- SELECT is required in addition to INSERT/UPDATE: both statements are
-- INSERT ... ON CONFLICT DO UPDATE, and PostgreSQL requires SELECT on any
-- existing-row column read by the DO UPDATE SET/WHERE clause or named in a
-- RETURNING list.
GRANT SELECT, INSERT, UPDATE
  ON aethercloud.integration_projection_cloudlink_delivery_attempts
  TO aethercloud_cloudlink_ingress;
GRANT SELECT, INSERT, UPDATE
  ON aethercloud.integration_projection_cloudlink_ack_outbox
  TO aethercloud_cloudlink_ingress;

-- Shared audit and outbox trails: append-only from this role. A separate
-- worker drains outbox_events; nothing in the ingress path reads either
-- table back.
GRANT INSERT ON aethercloud.audit_events, aethercloud.outbox_events
  TO aethercloud_cloudlink_ingress;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA aethercloud
  TO aethercloud_cloudlink_ingress;
