-- Durable multi-instance leases for the platform-authorized CloudLink health
-- reconciler. Apply after 0005_cloudlink_session.sql.

ALTER TABLE aethercloud.cloudlink_sessions
  ADD COLUMN health_lease_id uuid,
  ADD COLUMN health_lease_expires_at timestamptz;

ALTER TABLE aethercloud.cloudlink_sessions
  ADD CONSTRAINT cloudlink_sessions_health_lease_complete_ck CHECK (
    (health_lease_id IS NULL) = (health_lease_expires_at IS NULL)
  );

CREATE INDEX cloudlink_sessions_health_due_idx
  ON aethercloud.cloudlink_sessions (
    state,
    health_lease_expires_at,
    updated_at
  )
  WHERE
    state IN ('active', 'suspect') AND
    heartbeat_interval_ms IS NOT NULL;
