DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'aethercloud_app'
  ) THEN
    CREATE ROLE aethercloud_app
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
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'aethercloud_app'
      AND (
        rolcanlogin OR
        rolsuper OR
        rolcreatedb OR
        rolcreaterole OR
        rolinherit OR
        rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION 'aethercloud_app has unsafe role attributes';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE postgres TO aethercloud_app;
GRANT USAGE ON SCHEMA aethercloud TO aethercloud_app;

GRANT SELECT, INSERT, UPDATE
  ON ALL TABLES IN SCHEMA aethercloud
  TO aethercloud_app;

GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA aethercloud
  TO aethercloud_app;

GRANT EXECUTE
  ON ALL FUNCTIONS IN SCHEMA aethercloud
  TO aethercloud_app;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  IN SCHEMA aethercloud
  GRANT SELECT, INSERT, UPDATE ON TABLES TO aethercloud_app;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  IN SCHEMA aethercloud
  GRANT USAGE, SELECT ON SEQUENCES TO aethercloud_app;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  IN SCHEMA aethercloud
  GRANT EXECUTE ON FUNCTIONS TO aethercloud_app;
