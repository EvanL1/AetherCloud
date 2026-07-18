CREATE TABLE aethercloud.integration_control_intents (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  job_id uuid NOT NULL,
  intent_digest text NOT NULL CHECK (
    intent_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  intent_payload jsonb NOT NULL,
  expires_at_ms numeric(20, 0) NOT NULL CHECK (
    expires_at_ms > 0 AND
    expires_at_ms <= 18446744073709551615
  ),
  created_at timestamptz NOT NULL,
  latest_receipt_payload jsonb,
  latest_receipt_id uuid,
  revision bigint NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, gateway_id, job_id),
  CHECK (
    jsonb_typeof(intent_payload) = 'object' AND
    intent_payload ?& ARRAY[
      'schema',
      'capability_id',
      'target',
      'arguments',
      'governance',
      'authorization',
      'confirmation'
    ] AND
    (
      intent_payload - ARRAY[
        'schema',
        'capability_id',
        'target',
        'arguments',
        'governance',
        'authorization',
        'confirmation'
      ]::text[]
    ) = '{}'::jsonb AND
    intent_payload->>'schema' =
      'aether.integration-control.action-intent.v1alpha1' AND
    intent_payload->>'capability_id' = 'device.power.set.v1' AND
    jsonb_typeof(intent_payload->'target') = 'object' AND
    (intent_payload->'target') ?& ARRAY[
      'integration_id',
      'snapshot_generation',
      'entity_id',
      'point_key'
    ] AND
    (
      (intent_payload->'target') - ARRAY[
        'integration_id',
        'snapshot_generation',
        'entity_id',
        'point_key'
      ]::text[]
    ) = '{}'::jsonb AND
    intent_payload->'target'->>'point_key' = 'is_on' AND
    jsonb_typeof(intent_payload->'arguments') = 'object' AND
    (intent_payload->'arguments') ? 'value' AND
    ((intent_payload->'arguments') - 'value') = '{}'::jsonb AND
    jsonb_typeof(intent_payload->'arguments'->'value') = 'boolean' AND
    jsonb_typeof(intent_payload->'governance') = 'object' AND
    (intent_payload->'governance') ?& ARRAY[
      'execution',
      'default_authorization',
      'permission',
      'risk',
      'confirmation',
      'idempotency',
      'expiry',
      'audit',
      'edge_final_decision'
    ] AND
    (
      (intent_payload->'governance') - ARRAY[
        'execution',
        'default_authorization',
        'permission',
        'risk',
        'confirmation',
        'idempotency',
        'expiry',
        'audit',
        'edge_final_decision'
      ]::text[]
    ) = '{}'::jsonb AND
    intent_payload->'governance'->>'execution' = 'governed-job' AND
    intent_payload->'governance'->>'default_authorization' = 'deny' AND
    intent_payload->'governance'->>'permission' =
      'integration.device.control' AND
    intent_payload->'governance'->>'risk' = 'high' AND
    intent_payload->'governance'->>'confirmation' = 'required' AND
    intent_payload->'governance'->>'idempotency' = 'required' AND
    intent_payload->'governance'->>'expiry' = 'required' AND
    intent_payload->'governance'->>'audit' = 'required' AND
    intent_payload->'governance'->'edge_final_decision' = 'true'::jsonb AND
    jsonb_typeof(intent_payload->'authorization') = 'object' AND
    (intent_payload->'authorization') ?& ARRAY[
      'policy_decision_id',
      'subject_id',
      'permission',
      'authorized_at_ms'
    ] AND
    (
      (intent_payload->'authorization') - ARRAY[
        'policy_decision_id',
        'subject_id',
        'permission',
        'authorized_at_ms'
      ]::text[]
    ) = '{}'::jsonb AND
    intent_payload->'authorization'->>'permission' =
      'integration.device.control' AND
    jsonb_typeof(intent_payload->'confirmation') = 'object' AND
    (intent_payload->'confirmation') ?& ARRAY[
      'confirmation_id',
      'subject_id',
      'confirmed_at_ms'
    ] AND
    (
      (intent_payload->'confirmation') - ARRAY[
        'confirmation_id',
        'subject_id',
        'confirmed_at_ms'
      ]::text[]
    ) = '{}'::jsonb
  ),
  CHECK (
    (latest_receipt_payload IS NULL AND latest_receipt_id IS NULL AND revision = 1)
    OR
    (latest_receipt_payload IS NOT NULL AND latest_receipt_id IS NOT NULL AND revision > 1)
  )
);

CREATE TABLE aethercloud.integration_control_offer_outbox (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL UNIQUE CHECK (
    char_length(event_id) BETWEEN 8 AND 128
  ),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  job_id uuid NOT NULL,
  session_id uuid NOT NULL,
  session_epoch numeric(20, 0) NOT NULL CHECK (
    session_epoch > 0 AND session_epoch <= 18446744073709551615
  ),
  intent_digest text NOT NULL CHECK (
    intent_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  offer_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  UNIQUE (
    tenant_id,
    project_id,
    gateway_id,
    job_id,
    session_id,
    session_epoch
  ),
  UNIQUE (tenant_id, project_id, gateway_id, event_id),
  FOREIGN KEY (tenant_id, project_id, gateway_id, job_id)
    REFERENCES aethercloud.integration_control_intents (
      tenant_id,
      project_id,
      gateway_id,
      job_id
    ),
  CHECK (
    jsonb_typeof(offer_payload) = 'object' AND
    offer_payload ?& ARRAY[
      'schema',
      'protocol',
      'protocol_version',
      'extension',
      'message_kind',
      'gateway_id',
      'session_id',
      'session_epoch',
      'credential_generation',
      'job_id',
      'issued_at_ms',
      'expires_at_ms',
      'intent_digest',
      'intent',
      'cloud_authentication'
    ] AND
    (
      offer_payload - ARRAY[
        'schema',
        'protocol',
        'protocol_version',
        'extension',
        'message_kind',
        'gateway_id',
        'session_id',
        'session_epoch',
        'credential_generation',
        'job_id',
        'issued_at_ms',
        'expires_at_ms',
        'intent_digest',
        'intent',
        'cloud_authentication'
      ]::text[]
    ) = '{}'::jsonb AND
    offer_payload->>'schema' =
      'aether.cloudlink.integration-action-offer.v1alpha1' AND
    offer_payload->>'protocol' = 'aether.cloudlink' AND
    offer_payload->>'protocol_version' = '1.0' AND
    offer_payload->>'extension' =
      'aether.cloudlink.integration-control.v1alpha1' AND
    offer_payload->>'message_kind' = 'integration-action-offer' AND
    offer_payload->>'gateway_id' = gateway_id::text AND
    offer_payload->>'session_id' = session_id::text AND
    offer_payload->>'session_epoch' = session_epoch::text AND
    offer_payload->>'job_id' = job_id::text AND
    offer_payload->>'intent_digest' = intent_digest AND
    offer_payload->'intent'->>'capability_id' =
      'device.power.set.v1' AND
    jsonb_typeof(offer_payload->'intent') = 'object' AND
    (offer_payload->'intent') ?& ARRAY[
      'schema',
      'capability_id',
      'target',
      'arguments',
      'governance',
      'authorization',
      'confirmation'
    ] AND
    (
      (offer_payload->'intent') - ARRAY[
        'schema',
        'capability_id',
        'target',
        'arguments',
        'governance',
        'authorization',
        'confirmation'
      ]::text[]
    ) = '{}'::jsonb AND
    offer_payload->'intent'->>'schema' =
      'aether.integration-control.action-intent.v1alpha1' AND
    jsonb_typeof(offer_payload->'intent'->'target') = 'object' AND
    (offer_payload->'intent'->'target') ?& ARRAY[
      'integration_id',
      'snapshot_generation',
      'entity_id',
      'point_key'
    ] AND
    (
      (offer_payload->'intent'->'target') - ARRAY[
        'integration_id',
        'snapshot_generation',
        'entity_id',
        'point_key'
      ]::text[]
    ) = '{}'::jsonb AND
    offer_payload->'intent'->'target'->>'point_key' = 'is_on' AND
    jsonb_typeof(offer_payload->'intent'->'arguments') = 'object' AND
    (offer_payload->'intent'->'arguments') ? 'value' AND
    (
      (offer_payload->'intent'->'arguments') - 'value'
    ) = '{}'::jsonb AND
    jsonb_typeof(
      offer_payload->'intent'->'arguments'->'value'
    ) = 'boolean' AND
    jsonb_typeof(offer_payload->'intent'->'governance') = 'object' AND
    (offer_payload->'intent'->'governance') ?& ARRAY[
      'execution',
      'default_authorization',
      'permission',
      'risk',
      'confirmation',
      'idempotency',
      'expiry',
      'audit',
      'edge_final_decision'
    ] AND
    (
      (offer_payload->'intent'->'governance') - ARRAY[
        'execution',
        'default_authorization',
        'permission',
        'risk',
        'confirmation',
        'idempotency',
        'expiry',
        'audit',
        'edge_final_decision'
      ]::text[]
    ) = '{}'::jsonb AND
    offer_payload->'intent'->'governance'->>'execution' = 'governed-job' AND
    offer_payload->'intent'->'governance'->>'default_authorization' =
      'deny' AND
    offer_payload->'intent'->'governance'->>'permission' =
      'integration.device.control' AND
    offer_payload->'intent'->'governance'->>'risk' = 'high' AND
    offer_payload->'intent'->'governance'->>'confirmation' = 'required' AND
    offer_payload->'intent'->'governance'->>'idempotency' = 'required' AND
    offer_payload->'intent'->'governance'->>'expiry' = 'required' AND
    offer_payload->'intent'->'governance'->>'audit' = 'required' AND
    offer_payload->'intent'->'governance'->'edge_final_decision' =
      'true'::jsonb AND
    jsonb_typeof(offer_payload->'intent'->'authorization') = 'object' AND
    (offer_payload->'intent'->'authorization') ?& ARRAY[
      'policy_decision_id',
      'subject_id',
      'permission',
      'authorized_at_ms'
    ] AND
    (
      (offer_payload->'intent'->'authorization') - ARRAY[
        'policy_decision_id',
        'subject_id',
        'permission',
        'authorized_at_ms'
      ]::text[]
    ) = '{}'::jsonb AND
    offer_payload->'intent'->'authorization'->>'permission' =
      'integration.device.control' AND
    jsonb_typeof(offer_payload->'intent'->'confirmation') = 'object' AND
    (offer_payload->'intent'->'confirmation') ?& ARRAY[
      'confirmation_id',
      'subject_id',
      'confirmed_at_ms'
    ] AND
    (
      (offer_payload->'intent'->'confirmation') - ARRAY[
        'confirmation_id',
        'subject_id',
        'confirmed_at_ms'
      ]::text[]
    ) = '{}'::jsonb AND
    jsonb_typeof(offer_payload->'cloud_authentication') = 'object' AND
    (offer_payload->'cloud_authentication') ?& ARRAY[
      'key_id',
      'algorithm',
      'signature'
    ] AND
    (
      (offer_payload->'cloud_authentication') - ARRAY[
        'key_id',
        'algorithm',
        'signature'
      ]::text[]
    ) = '{}'::jsonb AND
    offer_payload->'cloud_authentication'->>'algorithm' = 'Ed25519'
  )
);

CREATE INDEX integration_control_offer_outbox_pending_idx
  ON aethercloud.integration_control_offer_outbox (
    tenant_id,
    project_id,
    gateway_id,
    sequence
  )
  WHERE published_at IS NULL;

CREATE TABLE aethercloud.integration_control_requests (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  request_id text NOT NULL CHECK (
    char_length(request_id) BETWEEN 8 AND 128
  ),
  operation text NOT NULL CHECK (operation IN ('create', 'reoffer')),
  request_fingerprint text NOT NULL CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  job_id uuid NOT NULL,
  offer_event_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, project_id, gateway_id, request_id),
  FOREIGN KEY (tenant_id, project_id, gateway_id, job_id)
    REFERENCES aethercloud.integration_control_intents (
      tenant_id,
      project_id,
      gateway_id,
      job_id
    ),
  FOREIGN KEY (tenant_id, project_id, gateway_id, offer_event_id)
    REFERENCES aethercloud.integration_control_offer_outbox (
      tenant_id,
      project_id,
      gateway_id,
      event_id
    )
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE aethercloud.integration_control_receipt_stream_bindings (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  stream_id text NOT NULL CHECK (
    char_length(stream_id) BETWEEN 1 AND 128
  ),
  bound_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, project_id, gateway_id)
);

CREATE TABLE aethercloud.integration_control_receipt_streams (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  stream_id text NOT NULL CHECK (
    char_length(stream_id) BETWEEN 1 AND 128
  ),
  stream_epoch numeric(20, 0) NOT NULL CHECK (
    stream_epoch > 0 AND stream_epoch <= 18446744073709551615
  ),
  contiguous_position numeric(20, 0) NOT NULL DEFAULT 0 CHECK (
    contiguous_position >= 0 AND
    contiguous_position <= 18446744073709551615
  ),
  opened_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch
  ),
  FOREIGN KEY (tenant_id, project_id, gateway_id)
    REFERENCES aethercloud.integration_control_receipt_stream_bindings (
      tenant_id,
      project_id,
      gateway_id
    )
);

CREATE TABLE aethercloud.integration_control_receipts (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  job_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  receipt_sequence numeric(20, 0) NOT NULL CHECK (
    receipt_sequence > 0 AND
    receipt_sequence <= 18446744073709551615
  ),
  receipt_payload jsonb NOT NULL,
  stage text NOT NULL CHECK (
    stage IN ('edge-accepted', 'edge-rejected', 'provider-accepted', 'provider-rejected', 'unknown')
  ),
  provider_accepted boolean NOT NULL,
  physical_completed boolean NOT NULL DEFAULT false CHECK (
    physical_completed = false
  ),
  job_succeeded boolean NOT NULL DEFAULT false CHECK (
    job_succeeded = false
  ),
  audit_event_id text NOT NULL UNIQUE CHECK (
    char_length(audit_event_id) BETWEEN 8 AND 128
  ),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (
    tenant_id,
    project_id,
    gateway_id,
    job_id,
    receipt_id
  ),
  UNIQUE (
    tenant_id,
    project_id,
    gateway_id,
    job_id,
    receipt_sequence
  ),
  UNIQUE (
    tenant_id,
    project_id,
    gateway_id,
    job_id,
    receipt_id,
    receipt_sequence
  ),
  FOREIGN KEY (tenant_id, project_id, gateway_id, job_id)
    REFERENCES aethercloud.integration_control_intents (
      tenant_id,
      project_id,
      gateway_id,
      job_id
    ),
  CHECK (
    jsonb_typeof(receipt_payload) = 'object' AND
    receipt_payload ?& ARRAY[
      'jobId',
      'receiptId',
      'receiptSequence',
      'capabilityId',
      'target',
      'intentDigest',
      'stage',
      'decision',
      'physicalOutcome',
      'observedAtMs',
      'audit'
    ] AND
    (
      receipt_payload - ARRAY[
        'jobId',
        'receiptId',
        'receiptSequence',
        'capabilityId',
        'target',
        'intentDigest',
        'stage',
        'decision',
        'physicalOutcome',
        'observedAtMs',
        'evidenceDigest',
        'failureCode',
        'audit'
      ]::text[]
    ) = '{}'::jsonb AND
    receipt_payload->>'jobId' = job_id::text AND
    receipt_payload->>'receiptId' = receipt_id::text AND
    receipt_payload->>'receiptSequence' = receipt_sequence::text AND
    receipt_payload->>'capabilityId' = 'device.power.set.v1' AND
    receipt_payload->>'intentDigest' ~ '^sha256:[0-9a-f]{64}$' AND
    receipt_payload->>'stage' = stage AND
    receipt_payload->>'physicalOutcome' = 'unknown' AND
    (
      (
        stage = 'edge-accepted' AND
        receipt_payload->>'decision' = 'accepted' AND
        NOT (receipt_payload ? 'evidenceDigest') AND
        NOT (receipt_payload ? 'failureCode')
      ) OR (
        stage = 'edge-rejected' AND
        receipt_payload->>'decision' = 'rejected' AND
        (
          NOT (receipt_payload ? 'evidenceDigest') OR
          COALESCE(
            receipt_payload->>'evidenceDigest' ~ '^sha256:[0-9a-f]{64}$',
            false
          )
        ) AND
        receipt_payload->>'failureCode' ~ '^[A-Z][A-Z0-9_]*$'
      ) OR (
        stage = 'provider-accepted' AND
        receipt_payload->>'decision' = 'accepted' AND
        receipt_payload ? 'evidenceDigest' AND
        receipt_payload->>'evidenceDigest' ~ '^sha256:[0-9a-f]{64}$' AND
        NOT (receipt_payload ? 'failureCode')
      ) OR (
        stage = 'provider-rejected' AND
        receipt_payload->>'decision' = 'rejected' AND
        receipt_payload ? 'evidenceDigest' AND
        receipt_payload->>'evidenceDigest' ~ '^sha256:[0-9a-f]{64}$' AND
        receipt_payload->>'failureCode' ~ '^[A-Z][A-Z0-9_]*$'
      ) OR (
        stage = 'unknown' AND
        receipt_payload->>'decision' = 'unknown' AND
        (
          NOT (receipt_payload ? 'evidenceDigest') OR
          COALESCE(
            receipt_payload->>'evidenceDigest' ~ '^sha256:[0-9a-f]{64}$',
            false
          )
        ) AND
        receipt_payload->>'failureCode' ~ '^[A-Z][A-Z0-9_]*$'
      )
    ) AND
    jsonb_typeof(receipt_payload->'target') = 'object' AND
    (receipt_payload->'target') ?& ARRAY[
      'integrationId',
      'snapshotGeneration',
      'entityId',
      'pointKey'
    ] AND
    (
      (receipt_payload->'target') - ARRAY[
        'integrationId',
        'snapshotGeneration',
        'entityId',
        'pointKey'
      ]::text[]
    ) = '{}'::jsonb AND
    receipt_payload->'target'->>'pointKey' = 'is_on' AND
    jsonb_typeof(receipt_payload->'audit') = 'object' AND
    (receipt_payload->'audit') ?& ARRAY['auditRecordId', 'status'] AND
    (
      (receipt_payload->'audit') - ARRAY[
        'auditRecordId',
        'status'
      ]::text[]
    ) = '{}'::jsonb AND
    receipt_payload->'audit'->>'status' IN ('complete', 'incomplete') AND
    provider_accepted = (stage = 'provider-accepted') AND
    physical_completed = false AND
    job_succeeded = false
  )
);

ALTER TABLE aethercloud.integration_control_intents
  ADD CONSTRAINT integration_control_intents_latest_receipt_fk
  FOREIGN KEY (
    tenant_id,
    project_id,
    gateway_id,
    job_id,
    latest_receipt_id
  ) REFERENCES aethercloud.integration_control_receipts (
    tenant_id,
    project_id,
    gateway_id,
    job_id,
    receipt_id
  )
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE aethercloud.integration_control_receipt_deliveries (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  stream_id text NOT NULL,
  stream_epoch numeric(20, 0) NOT NULL,
  position numeric(20, 0) NOT NULL CHECK (
    position > 0 AND position <= 18446744073709551615
  ),
  batch_id text NOT NULL CHECK (char_length(batch_id) BETWEEN 1 AND 128),
  business_digest text NOT NULL CHECK (
    business_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  request_id text NOT NULL CHECK (
    char_length(request_id) BETWEEN 8 AND 128
  ),
  job_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  receipt_sequence numeric(20, 0) NOT NULL,
  accepted_at timestamptz NOT NULL,
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
    stream_epoch
  ) REFERENCES aethercloud.integration_control_receipt_streams (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch
  ),
  FOREIGN KEY (
    tenant_id,
    project_id,
    gateway_id,
    job_id,
    receipt_id,
    receipt_sequence
  ) REFERENCES aethercloud.integration_control_receipts (
    tenant_id,
    project_id,
    gateway_id,
    job_id,
    receipt_id,
    receipt_sequence
  )
);

CREATE TABLE aethercloud.integration_control_ack_outbox (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL UNIQUE CHECK (
    char_length(event_id) BETWEEN 8 AND 128
  ),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  session_id uuid NOT NULL,
  session_epoch numeric(20, 0) NOT NULL CHECK (
    session_epoch > 0 AND session_epoch <= 18446744073709551615
  ),
  credential_generation numeric(20, 0) NOT NULL CHECK (
    credential_generation > 0 AND
    credential_generation <= 18446744073709551615
  ),
  stream_id text NOT NULL,
  stream_epoch numeric(20, 0) NOT NULL,
  acknowledged_position numeric(20, 0) NOT NULL,
  batch_id text NOT NULL CHECK (char_length(batch_id) BETWEEN 1 AND 128),
  business_digest text NOT NULL CHECK (
    business_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  source_receipt_id uuid NOT NULL,
  acknowledgement_receipt_id text NOT NULL CHECK (
    char_length(acknowledgement_receipt_id) BETWEEN 8 AND 128
  ),
  acknowledged_at timestamptz NOT NULL,
  published_at timestamptz,
  UNIQUE (
    tenant_id,
    project_id,
    gateway_id,
    session_id,
    session_epoch,
    stream_id,
    stream_epoch,
    acknowledged_position
  ),
  FOREIGN KEY (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    acknowledged_position
  ) REFERENCES aethercloud.integration_control_receipt_deliveries (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch,
    position
  )
);

CREATE INDEX integration_control_ack_outbox_pending_idx
  ON aethercloud.integration_control_ack_outbox (
    tenant_id,
    project_id,
    gateway_id,
    sequence
  )
  WHERE published_at IS NULL;

ALTER TABLE aethercloud.integration_control_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_control_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_control_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_control_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_control_offer_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_control_offer_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_control_receipt_stream_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_control_receipt_stream_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_control_receipt_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_control_receipt_streams FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_control_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_control_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_control_receipt_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_control_receipt_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_control_ack_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.integration_control_ack_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY integration_control_intents_tenant_policy
  ON aethercloud.integration_control_intents
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY integration_control_requests_tenant_policy
  ON aethercloud.integration_control_requests
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY integration_control_offer_outbox_tenant_policy
  ON aethercloud.integration_control_offer_outbox
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY integration_control_receipt_stream_bindings_tenant_policy
  ON aethercloud.integration_control_receipt_stream_bindings
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY integration_control_receipt_streams_tenant_policy
  ON aethercloud.integration_control_receipt_streams
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY integration_control_receipts_tenant_policy
  ON aethercloud.integration_control_receipts
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY integration_control_receipt_deliveries_tenant_policy
  ON aethercloud.integration_control_receipt_deliveries
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );

CREATE POLICY integration_control_ack_outbox_tenant_policy
  ON aethercloud.integration_control_ack_outbox
  USING (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('aethercloud.tenant_id', true), '')::uuid
  );
