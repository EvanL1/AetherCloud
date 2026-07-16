-- Apply after 0001_gateway_identity.sql, which owns the shared Audit and
-- integration Outbox tables used by this bounded context.

CREATE TABLE aethercloud.telemetry_gateway_usage (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  record_count bigint NOT NULL CHECK (record_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, gateway_id)
);

CREATE TABLE aethercloud.telemetry_streams (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  stream_id text NOT NULL CHECK (stream_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  stream_epoch numeric(20, 0) NOT NULL CHECK (
    stream_epoch BETWEEN 0 AND 18446744073709551615
  ),
  contiguous_position numeric(20, 0) CHECK (
    contiguous_position BETWEEN 0 AND 18446744073709551615
  ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch
  )
);

CREATE TABLE aethercloud.telemetry_batches (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  stream_id text NOT NULL,
  stream_epoch numeric(20, 0) NOT NULL CHECK (
    stream_epoch BETWEEN 0 AND 18446744073709551615
  ),
  first_position numeric(20, 0) NOT NULL CHECK (
    first_position BETWEEN 0 AND 18446744073709551615
  ),
  last_position numeric(20, 0) NOT NULL CHECK (
    last_position BETWEEN first_position AND 18446744073709551615
  ),
  batch_identity text NOT NULL CHECK (char_length(batch_identity) BETWEEN 1 AND 384),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  credential_generation numeric(20, 0) NOT NULL CHECK (
    credential_generation BETWEEN 0 AND 18446744073709551615
  ),
  record_count smallint NOT NULL CHECK (record_count BETWEEN 1 AND 256),
  received_at timestamptz NOT NULL,
  persisted_at timestamptz NOT NULL,
  retention_class text NOT NULL CHECK (
    retention_class IN ('archive-365d', 'hot-7d', 'standard-30d')
  ),
  topology_publication_epoch numeric(20, 0) NOT NULL CHECK (
    topology_publication_epoch BETWEEN 0 AND 18446744073709551615
  ),
  topology_snapshot_digest text NOT NULL CHECK (
    topology_snapshot_digest ~ '^(fx64:[0-9a-f]{16}|sha256:[0-9a-f]{64})$'
  ),
  receipt_id text NOT NULL CHECK (char_length(receipt_id) BETWEEN 8 AND 128),
  audit_event_id text NOT NULL CHECK (char_length(audit_event_id) BETWEEN 8 AND 128),
  outbox_event_id text NOT NULL CHECK (char_length(outbox_event_id) BETWEEN 8 AND 128),
  contiguous_position numeric(20, 0) CHECK (
    contiguous_position BETWEEN 0 AND 18446744073709551615
  ),
  gap_expected_position numeric(20, 0) CHECK (
    gap_expected_position BETWEEN 0 AND 18446744073709551615
  ),
  gap_received_position numeric(20, 0) CHECK (
    gap_received_position BETWEEN 0 AND 18446744073709551615
  ),
  PRIMARY KEY (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    first_position
  ),
  CONSTRAINT telemetry_batches_identity_uq UNIQUE (
    tenant_id,
    project_id,
    gateway_id,
    batch_identity
  ),
  CONSTRAINT telemetry_batches_receipt_uq UNIQUE (
    tenant_id,
    project_id,
    receipt_id
  ),
  CONSTRAINT telemetry_batches_stream_fk FOREIGN KEY (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch
  ) REFERENCES aethercloud.telemetry_streams (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch
  ),
  CHECK (
    (gap_expected_position IS NULL AND gap_received_position IS NULL) OR
    (
      gap_expected_position IS NOT NULL AND
      gap_received_position = first_position AND
      gap_received_position > gap_expected_position
    )
  )
);

CREATE TABLE aethercloud.telemetry_ingress_requests (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 8 AND 128),
  stream_id text NOT NULL,
  stream_epoch numeric(20, 0) NOT NULL,
  first_position numeric(20, 0) NOT NULL,
  batch_identity text NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, project_id, gateway_id, request_id),
  FOREIGN KEY (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    first_position
  ) REFERENCES aethercloud.telemetry_batches (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    first_position
  )
);

CREATE TABLE aethercloud.telemetry_records (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  stream_id text NOT NULL,
  stream_epoch numeric(20, 0) NOT NULL,
  position numeric(20, 0) NOT NULL CHECK (
    position BETWEEN 0 AND 18446744073709551615
  ),
  batch_first_position numeric(20, 0) NOT NULL,
  batch_identity text NOT NULL,
  source_timestamp_ms numeric(20, 0) NOT NULL CHECK (
    source_timestamp_ms BETWEEN 0 AND 18446744073709551615
  ),
  record_kind text NOT NULL CHECK (
    record_kind IN ('device-event', 'point-sample')
  ),
  record_payload jsonb NOT NULL CHECK (jsonb_typeof(record_payload) = 'object'),
  received_at timestamptz NOT NULL,
  persisted_at timestamptz NOT NULL,
  PRIMARY KEY (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    position
  ),
  FOREIGN KEY (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    batch_first_position
  ) REFERENCES aethercloud.telemetry_batches (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    first_position
  )
);

CREATE INDEX telemetry_records_history_idx
  ON aethercloud.telemetry_records (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    position
  );

CREATE TABLE aethercloud.cloudlink_durable_ack_outbox (
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  outbox_event_id text NOT NULL CHECK (
    char_length(outbox_event_id) BETWEEN 8 AND 128
  ),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  session_id uuid NOT NULL,
  session_epoch numeric(20, 0) NOT NULL CHECK (
    session_epoch BETWEEN 0 AND 18446744073709551615
  ),
  credential_generation numeric(20, 0) NOT NULL CHECK (
    credential_generation BETWEEN 0 AND 18446744073709551615
  ),
  stream_id text NOT NULL CHECK (stream_id ~ '^[a-z][a-z0-9.-]{0,63}$'),
  stream_epoch numeric(20, 0) NOT NULL CHECK (
    stream_epoch BETWEEN 1 AND 18446744073709551615
  ),
  acknowledged_position numeric(20, 0) NOT NULL CHECK (
    acknowledged_position BETWEEN 0 AND 18446744073709551615
  ),
  telemetry_stream_id text NOT NULL,
  telemetry_stream_epoch numeric(20, 0) NOT NULL,
  telemetry_first_position numeric(20, 0) NOT NULL,
  batch_id text NOT NULL CHECK (char_length(batch_id) BETWEEN 1 AND 128),
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  receipt_id text NOT NULL CHECK (char_length(receipt_id) BETWEEN 8 AND 128),
  acknowledged_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  published_at timestamptz,
  leased_by text CHECK (
    leased_by IS NULL OR char_length(leased_by) BETWEEN 8 AND 128
  ),
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9-]{0,63}$'
  ),
  CHECK (
    (leased_by IS NULL AND lease_expires_at IS NULL) OR
    (leased_by IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  PRIMARY KEY (tenant_id, sequence),
  UNIQUE (tenant_id, project_id, outbox_event_id),
  FOREIGN KEY (
    tenant_id,
    project_id,
    gateway_id,
    telemetry_stream_id,
    telemetry_stream_epoch,
    telemetry_first_position
  ) REFERENCES aethercloud.telemetry_batches (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    first_position
  )
);

CREATE INDEX cloudlink_durable_ack_pending_idx
  ON aethercloud.cloudlink_durable_ack_outbox (
    tenant_id,
    project_id,
    available_at,
    sequence
  )
  WHERE published_at IS NULL;

ALTER TABLE aethercloud.telemetry_gateway_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.telemetry_gateway_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.telemetry_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.telemetry_streams FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.telemetry_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.telemetry_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.telemetry_ingress_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.telemetry_ingress_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.telemetry_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.telemetry_records FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.cloudlink_durable_ack_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.cloudlink_durable_ack_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY telemetry_gateway_usage_tenant_policy
  ON aethercloud.telemetry_gateway_usage
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY telemetry_streams_tenant_policy
  ON aethercloud.telemetry_streams
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY telemetry_batches_tenant_policy
  ON aethercloud.telemetry_batches
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY telemetry_ingress_requests_tenant_policy
  ON aethercloud.telemetry_ingress_requests
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY telemetry_records_tenant_policy
  ON aethercloud.telemetry_records
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY cloudlink_durable_ack_outbox_tenant_policy
  ON aethercloud.cloudlink_durable_ack_outbox
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );
