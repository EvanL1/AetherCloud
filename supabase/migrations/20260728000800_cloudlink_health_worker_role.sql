DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'aethercloud_cloudlink_health_worker'
  ) THEN
    CREATE ROLE aethercloud_cloudlink_health_worker
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
    WHERE rolname = 'aethercloud_cloudlink_health_worker'
      AND (
        rolcanlogin OR
        rolsuper OR
        rolcreatedb OR
        rolcreaterole OR
        rolinherit OR
        rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION 'aethercloud_cloudlink_health_worker has unsafe role attributes';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE postgres
  TO aethercloud_cloudlink_health_worker;
GRANT USAGE ON SCHEMA aethercloud
  TO aethercloud_cloudlink_health_worker;
GRANT SELECT, UPDATE ON aethercloud.cloudlink_sessions
  TO aethercloud_cloudlink_health_worker;
GRANT UPDATE ON aethercloud.cloudlink_session_heads
  TO aethercloud_cloudlink_health_worker;
GRANT INSERT ON aethercloud.audit_events, aethercloud.outbox_events
  TO aethercloud_cloudlink_health_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA aethercloud
  TO aethercloud_cloudlink_health_worker;

CREATE POLICY cloudlink_sessions_health_worker_policy
  ON aethercloud.cloudlink_sessions
  FOR ALL
  TO aethercloud_cloudlink_health_worker
  USING (true)
  WITH CHECK (true);
