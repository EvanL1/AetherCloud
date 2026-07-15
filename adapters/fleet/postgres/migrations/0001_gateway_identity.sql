CREATE SCHEMA IF NOT EXISTS aethercloud;

REVOKE ALL ON SCHEMA aethercloud FROM PUBLIC;

CREATE TABLE aethercloud.gateway_identities (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  display_name text NOT NULL CHECK (
    char_length(btrim(display_name)) BETWEEN 1 AND 128
  ),
  revision bigint NOT NULL CHECK (revision > 0),
  enrollment_state text NOT NULL,
  registration_request_id text NOT NULL CHECK (
    char_length(registration_request_id) BETWEEN 8 AND 128
  ),
  registered_at timestamptz NOT NULL,
  claim_id uuid,
  token_digest text CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  claim_issue_request_id text CHECK (
    claim_issue_request_id IS NULL OR
    char_length(claim_issue_request_id) BETWEEN 8 AND 128
  ),
  claim_issued_at timestamptz,
  claim_expires_at timestamptz,
  claim_request_id text CHECK (
    claim_request_id IS NULL OR
    char_length(claim_request_id) BETWEEN 8 AND 128
  ),
  credential_request_fingerprint text CHECK (
    credential_request_fingerprint IS NULL OR
    credential_request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  claimed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, gateway_id),
  CHECK (enrollment_state IN ('registered', 'awaiting-claim', 'claimed')),
  CHECK (
    (
      enrollment_state = 'registered' AND
      revision = 1 AND
      claim_id IS NULL AND
      token_digest IS NULL AND
      claim_issue_request_id IS NULL AND
      claim_issued_at IS NULL AND
      claim_expires_at IS NULL AND
      claim_request_id IS NULL AND
      credential_request_fingerprint IS NULL AND
      claimed_at IS NULL
    ) OR (
      enrollment_state = 'awaiting-claim' AND
      revision = 2 AND
      claim_id IS NOT NULL AND
      token_digest IS NOT NULL AND
      claim_issue_request_id IS NOT NULL AND
      claim_issued_at IS NOT NULL AND
      claim_expires_at > claim_issued_at AND
      claim_request_id IS NULL AND
      credential_request_fingerprint IS NULL AND
      claimed_at IS NULL
    ) OR (
      enrollment_state = 'claimed' AND
      revision = 3 AND
      claim_id IS NOT NULL AND
      token_digest IS NOT NULL AND
      claim_issue_request_id IS NOT NULL AND
      claim_issued_at IS NOT NULL AND
      claim_expires_at > claim_issued_at AND
      claim_request_id IS NOT NULL AND
      credential_request_fingerprint IS NOT NULL AND
      claimed_at >= claim_issued_at AND
      claimed_at < claim_expires_at
    )
  )
);

CREATE UNIQUE INDEX gateway_identities_claim_identity_uq
  ON aethercloud.gateway_identities (tenant_id, project_id, claim_id)
  WHERE claim_id IS NOT NULL;

CREATE TABLE aethercloud.audit_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL UNIQUE CHECK (char_length(event_id) BETWEEN 8 AND 128),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  subject_kind text NOT NULL CHECK (
    subject_kind IN ('gateway', 'service-account', 'system', 'user')
  ),
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 128),
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 128),
  resource_kind text NOT NULL CHECK (
    char_length(resource_kind) BETWEEN 1 AND 128
  ),
  resource_id text NOT NULL CHECK (char_length(resource_id) BETWEEN 8 AND 128),
  outcome text NOT NULL CHECK (
    outcome IN ('accepted', 'denied', 'failed', 'succeeded', 'unknown')
  ),
  risk text NOT NULL CHECK (risk IN ('critical', 'high', 'low', 'medium')),
  confirmation text NOT NULL CHECK (
    confirmation IN ('explicit', 'not-required')
  ),
  correlation_id text NOT NULL CHECK (
    char_length(correlation_id) BETWEEN 8 AND 128
  ),
  trace_id text CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  details_digest text CHECK (details_digest ~ '^[0-9a-f]{64}$')
);

CREATE INDEX audit_events_scope_sequence_idx
  ON aethercloud.audit_events (tenant_id, project_id, sequence DESC);

CREATE TABLE aethercloud.outbox_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL UNIQUE CHECK (char_length(event_id) BETWEEN 8 AND 128),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  event_name text NOT NULL CHECK (char_length(event_name) BETWEEN 1 AND 128),
  aggregate_kind text NOT NULL CHECK (
    char_length(aggregate_kind) BETWEEN 1 AND 128
  ),
  aggregate_id text NOT NULL CHECK (
    char_length(aggregate_id) BETWEEN 8 AND 128
  ),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text
);

CREATE INDEX outbox_events_pending_idx
  ON aethercloud.outbox_events (available_at, sequence)
  WHERE published_at IS NULL;

ALTER TABLE aethercloud.gateway_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.gateway_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.outbox_events FORCE ROW LEVEL SECURITY;

CREATE POLICY gateway_identities_tenant_policy
  ON aethercloud.gateway_identities
  USING (
    tenant_id = NULLIF(
      current_setting('aethercloud.tenant_id', true),
      ''
    )::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(
      current_setting('aethercloud.tenant_id', true),
      ''
    )::uuid
  );

CREATE POLICY audit_events_tenant_policy
  ON aethercloud.audit_events
  USING (
    tenant_id = NULLIF(
      current_setting('aethercloud.tenant_id', true),
      ''
    )::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(
      current_setting('aethercloud.tenant_id', true),
      ''
    )::uuid
  );

CREATE POLICY outbox_events_tenant_policy
  ON aethercloud.outbox_events
  USING (
    tenant_id = NULLIF(
      current_setting('aethercloud.tenant_id', true),
      ''
    )::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(
      current_setting('aethercloud.tenant_id', true),
      ''
    )::uuid
  );
