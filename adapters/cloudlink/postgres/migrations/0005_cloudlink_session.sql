CREATE OR REPLACE FUNCTION aethercloud.cloudlink_resume_cursors_valid(
  cursors jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    jsonb_typeof(cursors) = 'array'
    AND jsonb_array_length(cursors) <= 32
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(cursors) AS item(cursor)
      WHERE
        jsonb_typeof(cursor) <> 'object'
        OR NOT cursor ?& ARRAY['streamId', 'streamEpoch', 'position']
        OR (
          cursor - ARRAY['streamId', 'streamEpoch', 'position']::text[]
        ) <> '{}'::jsonb
        OR NOT COALESCE(
          cursor->>'streamId' ~
            '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
          false
        )
        OR NOT CASE
          WHEN cursor->>'streamEpoch' ~ '^(0|[1-9][0-9]{0,19})$'
            THEN (cursor->>'streamEpoch')::numeric BETWEEN 1
              AND 18446744073709551615
          ELSE false
        END
        OR NOT CASE
          WHEN cursor->>'position' ~ '^(0|[1-9][0-9]{0,19})$'
            THEN (cursor->>'position')::numeric BETWEEN 0
              AND 18446744073709551615
          ELSE false
        END
    )
    AND (
      SELECT count(*) = count(
        DISTINCT jsonb_build_array(
          cursor->>'streamId',
          cursor->>'streamEpoch'
        )
      )
      FROM jsonb_array_elements(cursors) AS item(cursor)
    )
$$;

CREATE OR REPLACE FUNCTION aethercloud.cloudlink_protocol_versions_valid(
  versions jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    jsonb_typeof(versions) = 'array'
    AND jsonb_array_length(versions) BETWEEN 1 AND 8
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(versions) AS item(version)
      WHERE
        jsonb_typeof(version) <> 'string'
        OR NOT COALESCE(
          trim(BOTH '"' FROM version::text) ~
            '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$',
          false
        )
        OR char_length(trim(BOTH '"' FROM version::text)) > 64
    )
    AND (
      SELECT count(*) = count(DISTINCT version)
      FROM jsonb_array_elements(versions) AS item(version)
    )
$$;

CREATE TABLE aethercloud.cloudlink_session_heads (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  last_epoch numeric(20, 0) NOT NULL DEFAULT 0 CHECK (
    last_epoch BETWEEN 0 AND 18446744073709551615
  ),
  current_session_id uuid,
  challenge_window_started_at_ms numeric(20, 0) CHECK (
    challenge_window_started_at_ms IS NULL OR
    challenge_window_started_at_ms BETWEEN 0 AND 18446744073709551615
  ),
  challenge_request_count integer NOT NULL DEFAULT 0 CHECK (
    challenge_request_count >= 0
  ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, gateway_id),
  FOREIGN KEY (tenant_id, project_id, gateway_id)
    REFERENCES aethercloud.gateway_identities (
      tenant_id,
      project_id,
      gateway_id
    ),
  CHECK (
    challenge_window_started_at_ms IS NOT NULL OR
    challenge_request_count = 0
  )
);

CREATE TABLE aethercloud.cloudlink_sessions (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  session_id uuid NOT NULL,
  credential_generation numeric(20, 0) NOT NULL CHECK (
    credential_generation BETWEEN 1 AND 18446744073709551615
  ),
  epoch numeric(20, 0) NOT NULL CHECK (
    epoch BETWEEN 1 AND 18446744073709551615
  ),
  state text NOT NULL CHECK (
    state IN (
      'active',
      'closed',
      'draining',
      'negotiating',
      'resuming',
      'suspect'
    )
  ),
  opened_at timestamptz NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  protocol_version text CHECK (
    protocol_version IS NULL OR (
      char_length(protocol_version) BETWEEN 3 AND 64 AND
      protocol_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    )
  ),
  resume_cursors jsonb CHECK (
    resume_cursors IS NULL OR
    aethercloud.cloudlink_resume_cursors_valid(resume_cursors)
  ),
  activated_at timestamptz,
  gateway_key_id text CHECK (
    gateway_key_id IS NULL OR (
      char_length(gateway_key_id) BETWEEN 1 AND 128 AND
      gateway_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    )
  ),
  heartbeat_interval_ms numeric(20, 0) CHECK (
    heartbeat_interval_ms BETWEEN 1 AND 18446744073709551615
  ),
  last_heartbeat_at timestamptz,
  last_heartbeat_request_id text CHECK (
    last_heartbeat_request_id IS NULL OR (
      char_length(last_heartbeat_request_id) BETWEEN 8 AND 128 AND
      last_heartbeat_request_id ~
        '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
    )
  ),
  suspect_at timestamptz,
  closed_at timestamptz,
  close_reason text CHECK (
    close_reason IS NULL OR
    close_reason IN ('drained', 'fenced', 'heartbeat-timeout')
  ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, gateway_id, session_id),
  UNIQUE (tenant_id, project_id, gateway_id, epoch),
  FOREIGN KEY (tenant_id, project_id, gateway_id)
    REFERENCES aethercloud.cloudlink_session_heads (
      tenant_id,
      project_id,
      gateway_id
    ),
  CHECK (
    (protocol_version IS NOT NULL) OR
    (resume_cursors IS NULL AND activated_at IS NULL)
  ),
  CHECK (
    (gateway_key_id IS NULL) = (heartbeat_interval_ms IS NULL)
  ),
  CHECK (
    state <> 'active' OR (
      protocol_version IS NOT NULL AND
      resume_cursors IS NOT NULL AND
      activated_at IS NOT NULL
    )
  ),
  CHECK (
    (state = 'closed') = (closed_at IS NOT NULL)
  ),
  CHECK (
    (state = 'closed') = (close_reason IS NOT NULL)
  ),
  CHECK (
    closed_at IS NULL OR closed_at >= opened_at
  )
);

CREATE UNIQUE INDEX cloudlink_sessions_one_current_uq
  ON aethercloud.cloudlink_sessions (tenant_id, project_id, gateway_id)
  WHERE state <> 'closed';

ALTER TABLE aethercloud.cloudlink_session_heads
  ADD CONSTRAINT cloudlink_session_heads_current_session_fk
  FOREIGN KEY (
    tenant_id,
    project_id,
    gateway_id,
    current_session_id
  )
  REFERENCES aethercloud.cloudlink_sessions (
    tenant_id,
    project_id,
    gateway_id,
    session_id
  )
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE aethercloud.cloudlink_session_open_requests (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  request_id text NOT NULL CHECK (
    char_length(request_id) BETWEEN 8 AND 128 AND
    request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  credential_generation numeric(20, 0) NOT NULL CHECK (
    credential_generation BETWEEN 1 AND 18446744073709551615
  ),
  protocol_version text NOT NULL CHECK (
    char_length(protocol_version) BETWEEN 3 AND 64 AND
    protocol_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  session_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, project_id, gateway_id, request_id),
  FOREIGN KEY (
    tenant_id,
    project_id,
    gateway_id,
    session_id
  )
  REFERENCES aethercloud.cloudlink_sessions (
    tenant_id,
    project_id,
    gateway_id,
    session_id
  )
);

CREATE TABLE aethercloud.cloudlink_durable_cursors (
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
    position BETWEEN 0 AND 18446744073709551615
  ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    tenant_id,
    project_id,
    gateway_id,
    stream_id,
    stream_epoch
  ),
  FOREIGN KEY (tenant_id, project_id, gateway_id)
    REFERENCES aethercloud.cloudlink_session_heads (
      tenant_id,
      project_id,
      gateway_id
    )
);

CREATE TABLE aethercloud.cloudlink_session_challenges (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  credential_generation numeric(20, 0) NOT NULL CHECK (
    credential_generation BETWEEN 1 AND 18446744073709551615
  ),
  credential_status text NOT NULL CHECK (
    credential_status IN ('active', 'revoked', 'suspended')
  ),
  request_state jsonb NOT NULL,
  challenge_id uuid NOT NULL,
  cloud_nonce text NOT NULL CHECK (
    char_length(cloud_nonce) = 43 AND
    cloud_nonce ~ '^[A-Za-z0-9_-]{43}$'
  ),
  issued_at_ms numeric(20, 0) NOT NULL CHECK (
    issued_at_ms BETWEEN 0 AND 18446744073709551615
  ),
  expires_at_ms numeric(20, 0) NOT NULL CHECK (
    expires_at_ms BETWEEN 0 AND 18446744073709551615
  ),
  cloud_authentication jsonb NOT NULL,
  authentication_fingerprint text CHECK (
    authentication_fingerprint IS NULL OR
    authentication_fingerprint ~ '^sha256:[0-9a-f]{64}$'
  ),
  consumed_session_id uuid,
  consumed_at_ms numeric(20, 0) CHECK (
    consumed_at_ms IS NULL OR
    consumed_at_ms BETWEEN 0 AND 18446744073709551615
  ),
  superseded_at_ms numeric(20, 0) CHECK (
    superseded_at_ms IS NULL OR
    superseded_at_ms BETWEEN 0 AND 18446744073709551615
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, gateway_id, challenge_id),
  FOREIGN KEY (tenant_id, project_id, gateway_id)
    REFERENCES aethercloud.cloudlink_session_heads (
      tenant_id,
      project_id,
      gateway_id
    ),
  FOREIGN KEY (
    tenant_id,
    project_id,
    gateway_id,
    consumed_session_id
  )
  REFERENCES aethercloud.cloudlink_sessions (
    tenant_id,
    project_id,
    gateway_id,
    session_id
  )
  DEFERRABLE INITIALLY DEFERRED,
  CHECK (expires_at_ms > issued_at_ms),
  CHECK ((
    jsonb_typeof(request_state) = 'object' AND
    request_state ?& ARRAY[
      'gatewayId',
      'credentialId',
      'credentialGeneration',
      'offeredProtocolVersions',
      'clientNonce',
      'resumeCursors'
    ] AND
    (
      request_state - ARRAY[
        'gatewayId',
        'credentialId',
        'credentialGeneration',
        'offeredProtocolVersions',
        'clientNonce',
        'resumeCursors'
      ]::text[]
    ) = '{}'::jsonb AND
    request_state->>'gatewayId' = gateway_id::text AND
    request_state->>'credentialGeneration' = credential_generation::text AND
    char_length(request_state->>'credentialId') BETWEEN 1 AND 256 AND
    request_state->>'credentialId' ~
      '^[A-Za-z0-9][A-Za-z0-9._:-]*$' AND
    char_length(request_state->>'clientNonce') = 43 AND
    request_state->>'clientNonce' ~ '^[A-Za-z0-9_-]{43}$' AND
    aethercloud.cloudlink_protocol_versions_valid(
      request_state->'offeredProtocolVersions'
    ) AND
    aethercloud.cloudlink_resume_cursors_valid(
      request_state->'resumeCursors'
    )
  ) IS TRUE),
  CHECK ((
    jsonb_typeof(cloud_authentication) = 'object' AND
    cloud_authentication ?& ARRAY['keyId', 'algorithm', 'signature'] AND
    (
      cloud_authentication - ARRAY[
        'keyId',
        'algorithm',
        'signature'
      ]::text[]
    ) = '{}'::jsonb AND
    char_length(cloud_authentication->>'keyId') BETWEEN 1 AND 128 AND
    cloud_authentication->>'keyId' ~
      '^[A-Za-z0-9][A-Za-z0-9._:-]*$' AND
    cloud_authentication->>'algorithm' = 'Ed25519' AND
    char_length(cloud_authentication->>'signature') = 86 AND
    cloud_authentication->>'signature' ~ '^[A-Za-z0-9_-]{86}$'
  ) IS TRUE),
  CHECK (
    (
      authentication_fingerprint IS NULL AND
      consumed_session_id IS NULL AND
      consumed_at_ms IS NULL
    ) OR (
      authentication_fingerprint IS NOT NULL AND
      consumed_session_id IS NOT NULL AND
      consumed_at_ms IS NOT NULL AND
      consumed_at_ms < expires_at_ms
    )
  ),
  CHECK (
    consumed_at_ms IS NULL OR superseded_at_ms IS NULL
  )
);

CREATE UNIQUE INDEX cloudlink_session_challenges_one_pending_uq
  ON aethercloud.cloudlink_session_challenges (
    tenant_id,
    project_id,
    gateway_id
  )
  WHERE consumed_at_ms IS NULL
    AND superseded_at_ms IS NULL;

CREATE INDEX cloudlink_session_challenges_expiry_idx
  ON aethercloud.cloudlink_session_challenges (
    tenant_id,
    project_id,
    expires_at_ms
  )
  WHERE consumed_at_ms IS NULL
    AND superseded_at_ms IS NULL;

ALTER TABLE aethercloud.cloudlink_session_heads
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.cloudlink_session_heads
  FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.cloudlink_sessions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.cloudlink_sessions
  FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.cloudlink_session_open_requests
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.cloudlink_session_open_requests
  FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.cloudlink_durable_cursors
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.cloudlink_durable_cursors
  FORCE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.cloudlink_session_challenges
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE aethercloud.cloudlink_session_challenges
  FORCE ROW LEVEL SECURITY;

CREATE POLICY cloudlink_session_heads_tenant_policy
  ON aethercloud.cloudlink_session_heads
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

CREATE POLICY cloudlink_sessions_tenant_policy
  ON aethercloud.cloudlink_sessions
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

CREATE POLICY cloudlink_session_open_requests_tenant_policy
  ON aethercloud.cloudlink_session_open_requests
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

CREATE POLICY cloudlink_durable_cursors_tenant_policy
  ON aethercloud.cloudlink_durable_cursors
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

CREATE POLICY cloudlink_session_challenges_tenant_policy
  ON aethercloud.cloudlink_session_challenges
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
