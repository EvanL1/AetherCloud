-- Apply after 0001_gateway_identity.sql. That migration owns the shared
-- audit_events and outbox_events tables used by this bounded context.

CREATE TABLE aethercloud.integration_projections (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  integration_id text NOT NULL CHECK (
    integration_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  integration_kind text NOT NULL CHECK (
    integration_kind ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  snapshot_generation numeric(20, 0) NOT NULL CHECK (
    snapshot_generation BETWEEN 0 AND 18446744073709551615
  ),
  topology_digest text NOT NULL CHECK (topology_digest ~ '^[0-9a-f]{64}$'),
  topology_payload jsonb NOT NULL CHECK (
    jsonb_typeof(topology_payload) = 'object'
  ),
  latest_observations jsonb NOT NULL CHECK (
    jsonb_typeof(latest_observations) = 'array'
  ),
  received_at timestamptz NOT NULL,
  revision bigint NOT NULL CHECK (
    revision BETWEEN 1 AND 9007199254740991
  ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    tenant_id,
    project_id,
    gateway_id,
    integration_id
  )
);

CREATE TABLE aethercloud.integration_projection_topologies (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  integration_id text NOT NULL CHECK (
    integration_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  integration_kind text NOT NULL CHECK (
    integration_kind ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  snapshot_generation numeric(20, 0) NOT NULL CHECK (
    snapshot_generation BETWEEN 0 AND 18446744073709551615
  ),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  topology_payload jsonb NOT NULL CHECK (
    jsonb_typeof(topology_payload) = 'object'
  ),
  revision bigint NOT NULL CHECK (
    revision BETWEEN 1 AND 9007199254740991
  ),
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (
    tenant_id,
    project_id,
    gateway_id,
    integration_id,
    snapshot_generation
  )
);

CREATE TABLE aethercloud.integration_projection_batches (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  integration_id text NOT NULL CHECK (
    integration_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  snapshot_generation numeric(20, 0) NOT NULL CHECK (
    snapshot_generation BETWEEN 0 AND 18446744073709551615
  ),
  batch_id text NOT NULL CHECK (
    batch_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (
    tenant_id,
    project_id,
    gateway_id,
    integration_id,
    snapshot_generation,
    batch_id
  )
);

CREATE TABLE aethercloud.integration_projection_ingress_requests (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  request_id text NOT NULL CHECK (
    char_length(request_id) BETWEEN 8 AND 128
  ),
  operation text NOT NULL CHECK (
    operation IN ('observations', 'topology')
  ),
  integration_id text NOT NULL CHECK (
    integration_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  snapshot_generation numeric(20, 0) NOT NULL CHECK (
    snapshot_generation BETWEEN 0 AND 18446744073709551615
  ),
  batch_id text CHECK (
    batch_id IS NULL OR
    batch_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  credential_generation numeric(20, 0) NOT NULL CHECK (
    credential_generation BETWEEN 0 AND 18446744073709551615
  ),
  revision bigint NOT NULL CHECK (
    revision BETWEEN 1 AND 9007199254740991
  ),
  audit_event_id text NOT NULL CHECK (
    char_length(audit_event_id) BETWEEN 8 AND 128
  ),
  outbox_event_id text NOT NULL CHECK (
    char_length(outbox_event_id) BETWEEN 8 AND 128
  ),
  committed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, project_id, gateway_id, request_id),
  CHECK (
    (operation = 'topology' AND batch_id IS NULL) OR
    (operation = 'observations' AND batch_id IS NOT NULL)
  )
);

CREATE TABLE aethercloud.integration_projection_cloudlink_streams (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  stream_id text NOT NULL CHECK (
    stream_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  stream_epoch numeric(20, 0) NOT NULL CHECK (
    stream_epoch BETWEEN 1 AND 18446744073709551615
  ),
  message_kind text NOT NULL CHECK (
    message_kind IN (
      'integration-observation-batch',
      'integration-topology-snapshot'
    )
  ),
  integration_id text NOT NULL CHECK (
    integration_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  contiguous_position numeric(20, 0) CHECK (
    contiguous_position BETWEEN 1 AND 18446744073709551615
  ),
  bound_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch
  ),
  CONSTRAINT integration_projection_cloudlink_stream_binding_uq UNIQUE (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    integration_id,
    message_kind
  )
);

CREATE TABLE aethercloud.integration_projection_cloudlink_deliveries (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  stream_id text NOT NULL CHECK (
    stream_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  stream_epoch numeric(20, 0) NOT NULL,
  position numeric(20, 0) NOT NULL CHECK (
    position BETWEEN 1 AND 18446744073709551615
  ),
  integration_id text NOT NULL,
  message_kind text NOT NULL,
  batch_id text NOT NULL CHECK (
    char_length(batch_id) BETWEEN 1 AND 128
  ),
  business_digest text NOT NULL CHECK (
    business_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  request_id text NOT NULL CHECK (
    char_length(request_id) BETWEEN 8 AND 128
  ),
  projection_audit_event_id text NOT NULL CHECK (
    char_length(projection_audit_event_id) BETWEEN 8 AND 128
  ),
  projection_outbox_event_id text NOT NULL CHECK (
    char_length(projection_outbox_event_id) BETWEEN 8 AND 128
  ),
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    position
  ),
  CONSTRAINT integration_projection_cloudlink_delivery_ack_binding_uq UNIQUE (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    position,
    integration_id,
    message_kind,
    batch_id,
    business_digest
  ),
  FOREIGN KEY (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    integration_id,
    message_kind
  ) REFERENCES aethercloud.integration_projection_cloudlink_streams (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    integration_id,
    message_kind
  ),
  CHECK (
    message_kind IN (
      'integration-observation-batch',
      'integration-topology-snapshot'
    )
  )
);

CREATE TABLE aethercloud.integration_projection_cloudlink_delivery_attempts (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  stream_id text NOT NULL CHECK (
    stream_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  stream_epoch numeric(20, 0) NOT NULL CHECK (
    stream_epoch BETWEEN 1 AND 18446744073709551615
  ),
  position numeric(20, 0) NOT NULL CHECK (
    position BETWEEN 1 AND 18446744073709551615
  ),
  session_id uuid NOT NULL,
  session_epoch numeric(20, 0) NOT NULL CHECK (
    session_epoch BETWEEN 1 AND 18446744073709551615
  ),
  credential_generation numeric(20, 0) NOT NULL CHECK (
    credential_generation BETWEEN 1 AND 18446744073709551615
  ),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    position,
    session_id,
    session_epoch,
    credential_generation
  ),
  FOREIGN KEY (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    position
  ) REFERENCES aethercloud.integration_projection_cloudlink_deliveries (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    position
  )
);

CREATE TABLE aethercloud.integration_projection_cloudlink_ack_outbox (
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  outbox_event_id text NOT NULL CHECK (
    char_length(outbox_event_id) BETWEEN 8 AND 128
  ),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  integration_id text NOT NULL CHECK (
    integration_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  message_kind text NOT NULL CHECK (
    message_kind IN (
      'integration-observation-batch',
      'integration-topology-snapshot'
    )
  ),
  session_id uuid NOT NULL,
  session_epoch numeric(20, 0) NOT NULL CHECK (
    session_epoch BETWEEN 1 AND 18446744073709551615
  ),
  credential_generation numeric(20, 0) NOT NULL CHECK (
    credential_generation BETWEEN 1 AND 18446744073709551615
  ),
  stream_id text NOT NULL CHECK (
    stream_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  stream_epoch numeric(20, 0) NOT NULL CHECK (
    stream_epoch BETWEEN 1 AND 18446744073709551615
  ),
  acknowledged_position numeric(20, 0) NOT NULL CHECK (
    acknowledged_position BETWEEN 1 AND 18446744073709551615
  ),
  batch_id text NOT NULL CHECK (
    char_length(batch_id) BETWEEN 1 AND 128
  ),
  business_digest text NOT NULL CHECK (
    business_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  receipt_id text NOT NULL CHECK (
    char_length(receipt_id) BETWEEN 8 AND 128
  ),
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
    stream_id,
    stream_epoch,
    acknowledged_position,
    integration_id,
    message_kind,
    batch_id,
    business_digest
  ) REFERENCES aethercloud.integration_projection_cloudlink_deliveries (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    position,
    integration_id,
    message_kind,
    batch_id,
    business_digest
  )
);

CREATE INDEX integration_projection_topologies_history_idx
  ON aethercloud.integration_projection_topologies (
    tenant_id,
    project_id,
    gateway_id,
    integration_id,
    snapshot_generation DESC
  );

CREATE INDEX integration_projection_batches_history_idx
  ON aethercloud.integration_projection_batches (
    tenant_id,
    project_id,
    gateway_id,
    integration_id,
    snapshot_generation,
    accepted_at DESC
  );

CREATE INDEX integration_projection_cloudlink_ack_pending_idx
  ON aethercloud.integration_projection_cloudlink_ack_outbox (
    tenant_id,
    project_id,
    available_at,
    sequence
  )
  WHERE published_at IS NULL;

ALTER TABLE aethercloud.integration_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_projections FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_projection_topologies ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_projection_topologies FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_projection_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_projection_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_projection_ingress_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_projection_ingress_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_projection_cloudlink_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_projection_cloudlink_streams FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_projection_cloudlink_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_projection_cloudlink_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_projection_cloudlink_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_projection_cloudlink_delivery_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_projection_cloudlink_ack_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_projection_cloudlink_ack_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY integration_projections_tenant_policy
  ON aethercloud.integration_projections
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY integration_projection_topologies_tenant_policy
  ON aethercloud.integration_projection_topologies
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY integration_projection_batches_tenant_policy
  ON aethercloud.integration_projection_batches
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY integration_projection_ingress_requests_tenant_policy
  ON aethercloud.integration_projection_ingress_requests
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY integration_projection_cloudlink_streams_tenant_policy
  ON aethercloud.integration_projection_cloudlink_streams
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY integration_projection_cloudlink_deliveries_tenant_policy
  ON aethercloud.integration_projection_cloudlink_deliveries
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY integration_projection_cloudlink_delivery_attempts_tenant_policy
  ON aethercloud.integration_projection_cloudlink_delivery_attempts
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY integration_projection_cloudlink_ack_outbox_tenant_policy
  ON aethercloud.integration_projection_cloudlink_ack_outbox
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );
