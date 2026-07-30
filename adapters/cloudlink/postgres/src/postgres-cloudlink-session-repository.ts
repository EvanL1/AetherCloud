import type {
  AcceptCloudLinkSessionChallengeRepositoryInput,
  AcceptCloudLinkSessionChallengeRepositoryResult,
  CloudLinkSessionChallengeRecord,
  CloudLinkSessionChallengeRepository,
  CloudLinkSessionHealthRepository,
  CloudLinkSessionReplaceResult,
  CompleteCloudLinkSessionHealthInput,
  CompleteCloudLinkSessionHealthResult,
  CloudLinkSessionRepository,
  CloudLinkSessionScope,
  IssueCloudLinkSessionChallengeRepositoryInput,
  IssueCloudLinkSessionChallengeRepositoryResult,
  LeaseDueCloudLinkSessionHealthResult,
  OpenCloudLinkSessionRepositoryInput,
  OpenCloudLinkSessionRepositoryResult,
  RecordCloudLinkDurableCursorRepositoryInput,
  RecordCloudLinkDurableCursorRepositoryResult,
} from "@aether-cloud/application";
import {
  activateCloudLinkSession,
  createCloudLinkSession,
  negotiateCloudLinkSession,
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
} from "@aether-cloud/domain";
import type {
  CloudLinkSession,
  CloudLinkSessionChallengeId,
  CloudLinkSessionId,
  CloudLinkStreamCursor,
  GatewayCredentialBinding,
  GatewayId,
  ProtocolVersion,
  TenantId,
  UtcInstant,
} from "@aether-cloud/domain";

import {
  decodeChallengeRow,
  decodeSessionRow,
  sameBinding,
  sameChallengeRequest,
  sessionWriteValues,
  type CloudLinkPostgresRow,
} from "./postgres-cloudlink-session-codec.js";
import {
  CloudLinkPostgresStorageError,
  type PostgresCloudLinkSessionClient,
  type PostgresCloudLinkSessionPool,
} from "./postgres-cloudlink-session-contracts.js";

const maximumUint64 = 18_446_744_073_709_551_615n;
const uint64Pattern = /^(?:0|[1-9][0-9]{0,19})$/;
const authenticationFingerprintPattern = /^sha256:[0-9a-f]{64}$/;

const sessionColumns = `
  tenant_id::text AS tenant_id,
  project_id::text AS project_id,
  gateway_id::text AS gateway_id,
  session_id::text AS session_id,
  credential_generation::text AS credential_generation,
  epoch::text AS epoch,
  state,
  to_char(
    opened_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) AS opened_at,
  revision::text AS revision,
  protocol_version,
  resume_cursors,
  CASE WHEN activated_at IS NULL THEN NULL ELSE to_char(
    activated_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) END AS activated_at,
  gateway_key_id,
  heartbeat_interval_ms::text AS heartbeat_interval_ms,
  CASE WHEN last_heartbeat_at IS NULL THEN NULL ELSE to_char(
    last_heartbeat_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) END AS last_heartbeat_at,
  last_heartbeat_request_id,
  CASE WHEN suspect_at IS NULL THEN NULL ELSE to_char(
    suspect_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) END AS suspect_at,
  CASE WHEN closed_at IS NULL THEN NULL ELSE to_char(
    closed_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) END AS closed_at,
  close_reason
`;

const challengeColumns = `
  tenant_id::text AS tenant_id,
  project_id::text AS project_id,
  gateway_id::text AS gateway_id,
  credential_generation::text AS credential_generation,
  credential_status,
  request_state,
  challenge_id::text AS challenge_id,
  cloud_nonce,
  issued_at_ms::text AS issued_at_ms,
  expires_at_ms::text AS expires_at_ms,
  cloud_authentication,
  authentication_fingerprint,
  consumed_session_id::text AS consumed_session_id,
  consumed_at_ms::text AS consumed_at_ms,
  superseded_at_ms::text AS superseded_at_ms
`;

const ensureHeadSql = `
/* cloudlink-session:ensure-head */
INSERT INTO aethercloud.cloudlink_session_heads (
  tenant_id,
  project_id,
  gateway_id
) VALUES ($1::uuid, $2::uuid, $3::uuid)
ON CONFLICT (tenant_id, project_id, gateway_id) DO NOTHING
`;

const lockHeadSql = `
/* cloudlink-session:lock-head */
SELECT
  last_epoch::text AS last_epoch,
  current_session_id::text AS current_session_id,
  challenge_window_started_at_ms::text AS challenge_window_started_at_ms,
  challenge_request_count
FROM aethercloud.cloudlink_session_heads
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
FOR UPDATE
`;

const findOpenRequestSql = `
/* cloudlink-session:find-open-request */
SELECT
  credential_generation::text AS credential_generation,
  protocol_version,
  session_id::text AS session_id
FROM aethercloud.cloudlink_session_open_requests
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND request_id = $4
`;

const selectSessionSql = `
/* cloudlink-session:select-session */
SELECT ${sessionColumns}
FROM aethercloud.cloudlink_sessions
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND session_id = $4::uuid
  AND credential_generation = $5::numeric
`;

const selectCurrentSql = `
/* cloudlink-session:select-current */
SELECT ${sessionColumns}
FROM aethercloud.cloudlink_sessions
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND session_id = (
    SELECT current_session_id
    FROM aethercloud.cloudlink_session_heads
    WHERE tenant_id = $1::uuid
      AND project_id = $2::uuid
      AND gateway_id = $3::uuid
  )
`;

const selectCursorsSql = `
/* cloudlink-session:select-cursors */
SELECT
  stream_id,
  stream_epoch::text AS stream_epoch,
  position::text AS position
FROM aethercloud.cloudlink_durable_cursors
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
ORDER BY stream_id, stream_epoch
`;

const fenceCurrentSql = `
/* cloudlink-session:fence-current */
UPDATE aethercloud.cloudlink_sessions
SET
  state = 'closed',
  revision = revision + 1,
  closed_at = $5::timestamptz,
  close_reason = 'fenced',
  updated_at = clock_timestamp()
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND session_id = $4::uuid
  AND state <> 'closed'
  AND opened_at <= $5::timestamptz
`;

const insertSessionSql = `
/* cloudlink-session:insert-session */
INSERT INTO aethercloud.cloudlink_sessions (
  tenant_id,
  project_id,
  gateway_id,
  session_id,
  credential_generation,
  epoch,
  state,
  opened_at,
  revision,
  protocol_version,
  resume_cursors,
  activated_at,
  gateway_key_id,
  heartbeat_interval_ms,
  last_heartbeat_at,
  last_heartbeat_request_id,
  suspect_at,
  closed_at,
  close_reason
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4::uuid,
  $5::numeric,
  $6::numeric,
  $7,
  $8::timestamptz,
  $9::bigint,
  $10,
  $11::jsonb,
  $12::timestamptz,
  $13,
  $14::numeric,
  $15::timestamptz,
  $16,
  $17::timestamptz,
  $18::timestamptz,
  $19
)
`;

const insertOpenRequestSql = `
/* cloudlink-session:insert-open-request */
INSERT INTO aethercloud.cloudlink_session_open_requests (
  tenant_id,
  project_id,
  gateway_id,
  request_id,
  credential_generation,
  protocol_version,
  session_id,
  created_at
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5::numeric,
  $6,
  $7::uuid,
  $8::timestamptz
)
`;

const updateHeadSessionSql = `
/* cloudlink-session:update-head-session */
UPDATE aethercloud.cloudlink_session_heads
SET
  last_epoch = $4::numeric,
  current_session_id = $5::uuid,
  updated_at = clock_timestamp()
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
`;

const replaceSessionSql = `
/* cloudlink-session:replace-session */
UPDATE aethercloud.cloudlink_sessions
SET
  credential_generation = $5::numeric,
  epoch = $6::numeric,
  state = $7,
  opened_at = $8::timestamptz,
  revision = $9::bigint,
  protocol_version = $10,
  resume_cursors = $11::jsonb,
  activated_at = $12::timestamptz,
  gateway_key_id = $13,
  heartbeat_interval_ms = $14::numeric,
  last_heartbeat_at = $15::timestamptz,
  last_heartbeat_request_id = $16,
  suspect_at = $17::timestamptz,
  closed_at = $18::timestamptz,
  close_reason = $19,
  health_lease_id = NULL,
  health_lease_expires_at = NULL,
  updated_at = clock_timestamp()
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND session_id = $4::uuid
  AND revision = $20::bigint
`;

const leaseDueHealthSql = `
/* cloudlink-session-health:lease-due */
WITH due AS (
  SELECT tenant_id, project_id, gateway_id, session_id
  FROM aethercloud.cloudlink_sessions
  WHERE state IN ('active', 'suspect')
    AND heartbeat_interval_ms IS NOT NULL
    AND (
      health_lease_expires_at IS NULL OR
      health_lease_expires_at <= $2::timestamptz
    )
    AND (
      (
        state = 'active' AND
        EXTRACT(EPOCH FROM $2::timestamptz) * 1000 >
          EXTRACT(EPOCH FROM COALESCE(last_heartbeat_at, activated_at)) * 1000 +
          heartbeat_interval_ms * 3
      ) OR (
        state = 'suspect' AND
        EXTRACT(EPOCH FROM $2::timestamptz) * 1000 >
          EXTRACT(EPOCH FROM suspect_at) * 1000 +
          heartbeat_interval_ms * 3
      )
    )
  ORDER BY
    COALESCE(last_heartbeat_at, suspect_at, activated_at),
    tenant_id,
    project_id,
    gateway_id,
    session_id
  FOR UPDATE SKIP LOCKED
  LIMIT $4
), leased AS (
  UPDATE aethercloud.cloudlink_sessions AS session
  SET
    health_lease_id = $1::uuid,
    health_lease_expires_at = $3::timestamptz,
    updated_at = clock_timestamp()
  FROM due
  WHERE session.tenant_id = due.tenant_id
    AND session.project_id = due.project_id
    AND session.gateway_id = due.gateway_id
    AND session.session_id = due.session_id
  RETURNING session.*
)
SELECT ${sessionColumns}
FROM leased
`;

const completeHealthSql = `
/* cloudlink-session-health:complete */
UPDATE aethercloud.cloudlink_sessions
SET
  credential_generation = $5::numeric,
  epoch = $6::numeric,
  state = $7,
  opened_at = $8::timestamptz,
  revision = $9::bigint,
  protocol_version = $10,
  resume_cursors = $11::jsonb,
  activated_at = $12::timestamptz,
  gateway_key_id = $13,
  heartbeat_interval_ms = $14::numeric,
  last_heartbeat_at = $15::timestamptz,
  last_heartbeat_request_id = $16,
  suspect_at = $17::timestamptz,
  closed_at = $18::timestamptz,
  close_reason = $19,
  health_lease_id = NULL,
  health_lease_expires_at = NULL,
  updated_at = clock_timestamp()
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND session_id = $4::uuid
  AND revision = $20::bigint
  AND health_lease_id = $21::uuid
  AND health_lease_expires_at > $22::timestamptz
`;

const insertHealthAuditSql = `
/* cloudlink-session-health:insert-audit */
INSERT INTO aethercloud.audit_events (
  event_id,
  tenant_id,
  project_id,
  occurred_at,
  subject_kind,
  subject_id,
  action,
  resource_kind,
  resource_id,
  outcome,
  risk,
  confirmation,
  correlation_id
) VALUES (
  $1,
  $2::uuid,
  $3::uuid,
  $4::timestamptz,
  'system',
  'cloudlink-health-worker',
  'cloudlink.session.health.reconcile',
  'cloudlink-session',
  $5,
  'succeeded',
  'low',
  'not-required',
  $6
)
`;

const insertHealthOutboxSql = `
/* cloudlink-session-health:insert-outbox */
INSERT INTO aethercloud.outbox_events (
  event_id,
  tenant_id,
  project_id,
  occurred_at,
  event_name,
  aggregate_kind,
  aggregate_id,
  payload
) VALUES (
  $1,
  $2::uuid,
  $3::uuid,
  $4::timestamptz,
  $5,
  'cloudlink-session',
  $6,
  $7::jsonb
)
`;

const sessionExistsSql = `
/* cloudlink-session:session-exists */
SELECT true AS exists
FROM aethercloud.cloudlink_sessions
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND session_id = $4::uuid
`;

const clearClosedHeadSql = `
/* cloudlink-session:clear-closed-head */
UPDATE aethercloud.cloudlink_session_heads
SET current_session_id = NULL, updated_at = clock_timestamp()
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND current_session_id = $4::uuid
`;

const lockSessionSql = `
/* cloudlink-session:lock-session */
SELECT ${sessionColumns}
FROM aethercloud.cloudlink_sessions
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND session_id = $4::uuid
  AND credential_generation = $5::numeric
FOR UPDATE
`;

const lockCursorSql = `
/* cloudlink-session:lock-cursor */
SELECT position::text AS position
FROM aethercloud.cloudlink_durable_cursors
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND stream_id = $4
  AND stream_epoch = $5::numeric
FOR UPDATE
`;

const upsertCursorSql = `
/* cloudlink-session:upsert-cursor */
INSERT INTO aethercloud.cloudlink_durable_cursors (
  tenant_id,
  project_id,
  gateway_id,
  stream_id,
  stream_epoch,
  position
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, $6::numeric)
ON CONFLICT (
  tenant_id,
  project_id,
  gateway_id,
  stream_id,
  stream_epoch
) DO UPDATE SET
  position = EXCLUDED.position,
  updated_at = clock_timestamp()
`;

const updateRateLimitSql = `
/* cloudlink-session:update-rate-limit */
UPDATE aethercloud.cloudlink_session_heads
SET
  challenge_window_started_at_ms = $4::numeric,
  challenge_request_count = $5::integer,
  updated_at = clock_timestamp()
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
`;

const lockPendingChallengeSql = `
/* cloudlink-session:lock-pending-challenge */
SELECT ${challengeColumns}
FROM aethercloud.cloudlink_session_challenges
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND consumed_at_ms IS NULL
  AND superseded_at_ms IS NULL
FOR UPDATE
`;

const insertChallengeSql = `
/* cloudlink-session:insert-challenge */
INSERT INTO aethercloud.cloudlink_session_challenges (
  tenant_id,
  project_id,
  gateway_id,
  credential_generation,
  credential_status,
  request_state,
  challenge_id,
  cloud_nonce,
  issued_at_ms,
  expires_at_ms,
  cloud_authentication
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4::numeric,
  $5::text,
  jsonb_build_object(
    'gatewayId', ($3::uuid)::text,
    'credentialId', $6::text,
    'credentialGeneration', $4::text,
    'offeredProtocolVersions', $7::jsonb,
    'clientNonce', $8::text,
    'resumeCursors', $9::jsonb
  ),
  $10::uuid,
  $11::text,
  $12::numeric,
  $13::numeric,
  jsonb_build_object(
    'keyId', $14::text,
    'algorithm', 'Ed25519',
    'signature', $15::text
  )
)
ON CONFLICT (tenant_id, project_id, gateway_id, challenge_id) DO NOTHING
`;

const supersedeChallengeSql = `
/* cloudlink-session:supersede-challenge */
UPDATE aethercloud.cloudlink_session_challenges
SET superseded_at_ms = $5::numeric
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND challenge_id = $4::uuid
  AND consumed_at_ms IS NULL
  AND superseded_at_ms IS NULL
`;

const selectChallengeSql = `
/* cloudlink-session:select-challenge */
SELECT ${challengeColumns}
FROM aethercloud.cloudlink_session_challenges
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND credential_generation = $4::numeric
  AND credential_status = $5
  AND challenge_id = $6::uuid
  AND superseded_at_ms IS NULL
`;

const lockChallengeSql = `
/* cloudlink-session:lock-challenge */
SELECT ${challengeColumns}
FROM aethercloud.cloudlink_session_challenges
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND challenge_id = $4::uuid
  AND superseded_at_ms IS NULL
FOR UPDATE
`;

const consumeChallengeSql = `
/* cloudlink-session:consume-challenge */
UPDATE aethercloud.cloudlink_session_challenges
SET
  authentication_fingerprint = $5,
  consumed_session_id = $6::uuid,
  consumed_at_ms = $7::numeric
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND challenge_id = $4::uuid
  AND authentication_fingerprint IS NULL
  AND consumed_session_id IS NULL
  AND consumed_at_ms IS NULL
  AND superseded_at_ms IS NULL
`;

interface HeadRow extends CloudLinkPostgresRow {
  readonly last_epoch: unknown;
  readonly current_session_id: unknown;
  readonly challenge_window_started_at_ms: unknown;
  readonly challenge_request_count: unknown;
}

interface OpenRequestRow extends CloudLinkPostgresRow {
  readonly credential_generation: unknown;
  readonly protocol_version: unknown;
  readonly session_id: unknown;
}

function parseUint64(input: unknown, field: string): bigint {
  if (
    typeof input !== "string" ||
    !uint64Pattern.test(input) ||
    BigInt(input) > maximumUint64
  ) {
    throw new Error(`PostgreSQL CloudLink row has invalid ${field}`);
  }
  return BigInt(input);
}

function parseHead(row: HeadRow): {
  readonly lastEpoch: bigint;
  readonly currentSessionId?: CloudLinkSessionId;
  readonly challengeWindowStartedAtMs?: bigint;
  readonly challengeRequestCount: number;
} {
  const currentSessionId =
    row.current_session_id === null || row.current_session_id === undefined
      ? undefined
      : parseCloudLinkSessionId(row.current_session_id);
  const challengeWindowStartedAtMs =
    row.challenge_window_started_at_ms === null ||
    row.challenge_window_started_at_ms === undefined
      ? undefined
      : parseUint64(
          row.challenge_window_started_at_ms,
          "challenge_window_started_at_ms",
        );
  if (
    typeof row.challenge_request_count !== "number" ||
    !Number.isSafeInteger(row.challenge_request_count) ||
    row.challenge_request_count < 0
  ) {
    throw new Error(
      "PostgreSQL CloudLink row has invalid challenge_request_count",
    );
  }
  return {
    lastEpoch: parseUint64(row.last_epoch, "last_epoch"),
    ...(currentSessionId === undefined ? {} : { currentSessionId }),
    ...(challengeWindowStartedAtMs === undefined
      ? {}
      : { challengeWindowStartedAtMs }),
    challengeRequestCount: row.challenge_request_count,
  };
}

function sameOpenRequest(
  row: OpenRequestRow,
  input: OpenCloudLinkSessionRepositoryInput,
): boolean {
  return (
    row.credential_generation === input.binding.generation &&
    row.protocol_version === input.protocolVersion &&
    typeof row.session_id === "string"
  );
}

function nextEpoch(
  lastEpoch: bigint,
): ReturnType<typeof parseCloudLinkSessionEpoch> {
  if (lastEpoch >= maximumUint64) {
    throw new Error("PostgreSQL CloudLink Gateway epoch is exhausted");
  }
  return parseCloudLinkSessionEpoch((lastEpoch + 1n).toString());
}

function requireActiveBinding(binding: GatewayCredentialBinding): void {
  if (binding.status !== "active") {
    throw new Error("CloudLink challenge requires an active binding");
  }
}

function requireChallengeCandidate(
  candidate: CloudLinkSessionChallengeRecord,
): void {
  requireActiveBinding(candidate.binding);
  if (
    candidate.request.gatewayId !== candidate.binding.gatewayId ||
    candidate.request.credentialGeneration !== candidate.binding.generation ||
    parseUint64(candidate.issuedAtMs, "issued_at_ms") >=
      parseUint64(candidate.expiresAtMs, "expires_at_ms")
  ) {
    throw new Error("CloudLink challenge candidate is inconsistent");
  }
}

function requireFingerprint(fingerprint: string): void {
  if (!authenticationFingerprintPattern.test(fingerprint)) {
    throw new Error("CloudLink authentication fingerprint is invalid");
  }
}

function requireTransition<Value>(
  transition:
    | Readonly<{ ok: true; value: Value }>
    | Readonly<{ ok: false; failure: Readonly<{ message: string }> }>,
): Value {
  if (!transition.ok) {
    throw new Error("CloudLink session transition failed");
  }
  return transition.value;
}

function buildActiveSession(
  binding: GatewayCredentialBinding,
  sessionId: CloudLinkSessionId,
  epoch: ReturnType<typeof parseCloudLinkSessionEpoch>,
  protocolVersion: ProtocolVersion,
  openedAt: UtcInstant,
  resumeCursors: readonly CloudLinkStreamCursor[],
  gatewayAuthentication?: Readonly<{
    gatewayKeyId: string;
    heartbeatIntervalMs: string;
  }>,
): CloudLinkSession {
  const negotiating = createCloudLinkSession({
    tenantId: binding.tenantId,
    projectId: binding.projectId,
    gatewayId: binding.gatewayId,
    sessionId,
    credentialGeneration: binding.generation,
    epoch,
    openedAt,
    ...(gatewayAuthentication === undefined ? {} : gatewayAuthentication),
  });
  const negotiated = requireTransition(
    negotiateCloudLinkSession(negotiating, protocolVersion),
  );
  return requireTransition(
    activateCloudLinkSession(negotiated, {
      activatedAt: openedAt,
      resumeCursors,
    }),
  );
}

function decodeCursors(
  rows: readonly CloudLinkPostgresRow[],
): readonly CloudLinkStreamCursor[] {
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        streamId: parseStreamId(row.stream_id),
        streamEpoch: parseStreamEpoch(row.stream_epoch),
        position: parseStreamPosition(row.position),
      }),
    ),
  );
}

export class PostgresCloudLinkSessionRepository
  implements
    CloudLinkSessionRepository,
    CloudLinkSessionChallengeRepository,
    CloudLinkSessionHealthRepository
{
  readonly #pool: PostgresCloudLinkSessionPool;

  constructor(pool: PostgresCloudLinkSessionPool) {
    this.#pool = pool;
  }

  open(
    input: OpenCloudLinkSessionRepositoryInput,
  ): Promise<OpenCloudLinkSessionRepositoryResult> {
    return this.transaction(input.binding.tenantId, async (client) => {
      const head = await this.lockGatewayHead(client, input.binding);
      const prior = await client.query<OpenRequestRow>(findOpenRequestSql, [
        input.binding.tenantId,
        input.binding.projectId,
        input.binding.gatewayId,
        input.requestId,
      ]);
      const priorRequest = prior.rows[0];
      if (priorRequest !== undefined) {
        if (!sameOpenRequest(priorRequest, input)) {
          return { outcome: "idempotency-conflict" };
        }
        const priorSession = await this.selectSession(
          client,
          input.binding,
          parseCloudLinkSessionId(priorRequest.session_id),
        );
        return priorSession === undefined
          ? { outcome: "idempotency-conflict" }
          : { outcome: "replayed", session: priorSession };
      }
      const epoch = nextEpoch(head.lastEpoch);
      const cursors = await this.selectCursors(client, input.binding);
      const session = buildActiveSession(
        input.binding,
        input.sessionId,
        epoch,
        input.protocolVersion,
        input.openedAt,
        cursors,
      );
      const fencedSessionId = await this.fenceCurrent(
        client,
        input.binding,
        head.currentSessionId,
        input.openedAt,
      );
      await client.query(insertSessionSql, sessionWriteValues(session));
      await client.query(insertOpenRequestSql, [
        input.binding.tenantId,
        input.binding.projectId,
        input.binding.gatewayId,
        input.requestId,
        input.binding.generation,
        input.protocolVersion,
        input.sessionId,
        input.openedAt,
      ]);
      await this.updateHead(client, input.binding, epoch, input.sessionId);
      return {
        outcome: "opened",
        session,
        ...(fencedSessionId === undefined ? {} : { fencedSessionId }),
      };
    });
  }

  findById(
    binding: GatewayCredentialBinding,
    sessionId: CloudLinkSessionId,
  ): Promise<CloudLinkSession | undefined> {
    return this.transaction(binding.tenantId, (client) =>
      this.selectSession(client, binding, sessionId),
    );
  }

  findCurrent(
    scope: CloudLinkSessionScope,
    gatewayId: GatewayId,
  ): Promise<CloudLinkSession | undefined> {
    return this.transaction(scope.tenantId, async (client) => {
      const selected = await client.query<CloudLinkPostgresRow>(
        selectCurrentSql,
        [scope.tenantId, scope.projectId, gatewayId],
      );
      const row = selected.rows[0];
      return row === undefined ? undefined : decodeSessionRow(row);
    });
  }

  replace(
    session: CloudLinkSession,
    expectedRevision: number,
  ): Promise<CloudLinkSessionReplaceResult> {
    return this.transaction(session.tenantId, async (client) => {
      const replaced = await client.query(replaceSessionSql, [
        ...sessionWriteValues(session),
        expectedRevision,
      ]);
      if (replaced.rowCount !== 1) {
        const existing = await client.query<CloudLinkPostgresRow>(
          sessionExistsSql,
          [
            session.tenantId,
            session.projectId,
            session.gatewayId,
            session.sessionId,
          ],
        );
        return existing.rows.length === 0 ? "not-found" : "version-conflict";
      }
      if (session.state === "closed") {
        await client.query(clearClosedHeadSql, [
          session.tenantId,
          session.projectId,
          session.gatewayId,
          session.sessionId,
        ]);
      }
      return "replaced";
    });
  }

  async leaseDue(input: {
    readonly leaseId: string;
    readonly evaluatedAt: UtcInstant;
    readonly leaseExpiresAt: UtcInstant;
    readonly limit: number;
  }): Promise<LeaseDueCloudLinkSessionHealthResult> {
    try {
      return await this.platformTransaction(async (client) => {
        const leased = await client.query<CloudLinkPostgresRow>(
          leaseDueHealthSql,
          [input.leaseId, input.evaluatedAt, input.leaseExpiresAt, input.limit],
        );
        return {
          outcome: "leased" as const,
          leases: Object.freeze(
            leased.rows.map((row) =>
              Object.freeze({
                leaseId: input.leaseId,
                session: decodeSessionRow(row),
              }),
            ),
          ),
        };
      });
    } catch {
      return { outcome: "storage-unavailable" };
    }
  }

  async complete(
    input: CompleteCloudLinkSessionHealthInput,
  ): Promise<CompleteCloudLinkSessionHealthResult> {
    try {
      return await this.transaction(input.session.tenantId, async (client) => {
        const completed = await client.query(completeHealthSql, [
          ...sessionWriteValues(input.session),
          input.expectedRevision,
          input.leaseId,
          input.evidence.occurredAt,
        ]);
        if (completed.rowCount !== 1) return "lease-lost";
        await client.query(insertHealthAuditSql, [
          input.evidence.eventId,
          input.session.tenantId,
          input.session.projectId,
          input.evidence.occurredAt,
          input.session.sessionId,
          input.leaseId,
        ]);
        await client.query(insertHealthOutboxSql, [
          input.evidence.outboxId,
          input.session.tenantId,
          input.session.projectId,
          input.evidence.occurredAt,
          input.evidence.eventName,
          input.session.sessionId,
          JSON.stringify({
            tenantId: input.session.tenantId,
            projectId: input.session.projectId,
            gatewayId: input.session.gatewayId,
            sessionId: input.session.sessionId,
            sessionEpoch: input.session.epoch,
            state: input.session.state,
            revision: input.session.revision,
            ...(input.session.suspectAt === undefined
              ? {}
              : { suspectAt: input.session.suspectAt }),
            ...(input.session.closedAt === undefined
              ? {}
              : { closedAt: input.session.closedAt }),
            ...(input.session.closeReason === undefined
              ? {}
              : { closeReason: input.session.closeReason }),
          }),
        ]);
        if (input.session.state === "closed") {
          await client.query(clearClosedHeadSql, [
            input.session.tenantId,
            input.session.projectId,
            input.session.gatewayId,
            input.session.sessionId,
          ]);
        }
        return "completed";
      });
    } catch {
      return "storage-unavailable";
    }
  }

  recordDurableCursor(
    input: RecordCloudLinkDurableCursorRepositoryInput,
  ): Promise<RecordCloudLinkDurableCursorRepositoryResult> {
    return this.transaction(input.binding.tenantId, async (client) => {
      await this.lockGatewayHead(client, input.binding);
      const selected = await client.query<CloudLinkPostgresRow>(
        lockSessionSql,
        [
          input.binding.tenantId,
          input.binding.projectId,
          input.binding.gatewayId,
          input.sessionId,
          input.binding.generation,
        ],
      );
      const row = selected.rows[0];
      if (row === undefined) return "not-found";
      const session = decodeSessionRow(row);
      if (session.state !== "active" || session.epoch !== input.sessionEpoch) {
        return "stale-session";
      }
      const cursor = await client.query<CloudLinkPostgresRow>(lockCursorSql, [
        input.binding.tenantId,
        input.binding.projectId,
        input.binding.gatewayId,
        input.cursor.streamId,
        input.cursor.streamEpoch,
      ]);
      const currentRow = cursor.rows[0];
      const requestedPosition = BigInt(input.cursor.position);
      if (currentRow !== undefined) {
        const currentPosition = parseUint64(
          currentRow.position,
          "cursor_position",
        );
        if (requestedPosition <= currentPosition) return "replayed";
        if (requestedPosition !== currentPosition + 1n) return "position-gap";
      } else if (requestedPosition !== 1n) {
        return "position-gap";
      }
      await client.query(upsertCursorSql, [
        input.binding.tenantId,
        input.binding.projectId,
        input.binding.gatewayId,
        input.cursor.streamId,
        input.cursor.streamEpoch,
        input.cursor.position,
      ]);
      return "recorded";
    });
  }

  issue(
    input: IssueCloudLinkSessionChallengeRepositoryInput,
  ): Promise<IssueCloudLinkSessionChallengeRepositoryResult> {
    return this.transaction(
      input.candidate.binding.tenantId,
      async (client) => {
        requireChallengeCandidate(input.candidate);
        if (
          !Number.isSafeInteger(input.rateLimitWindowMs) ||
          input.rateLimitWindowMs < 1 ||
          !Number.isSafeInteger(input.rateLimitMaximumRequests) ||
          input.rateLimitMaximumRequests < 1
        ) {
          throw new Error("CloudLink challenge rate limit is invalid");
        }
        const evaluationTime = parseUint64(
          input.evaluationTimeMs,
          "evaluation_time_ms",
        );
        const head = await this.lockGatewayHead(
          client,
          input.candidate.binding,
        );
        const windowLength = BigInt(input.rateLimitWindowMs);
        const resetWindow =
          head.challengeWindowStartedAtMs === undefined ||
          evaluationTime >= head.challengeWindowStartedAtMs + windowLength;
        if (
          !resetWindow &&
          head.challengeRequestCount >= input.rateLimitMaximumRequests
        ) {
          return { outcome: "rate-limited" };
        }
        const windowStart = resetWindow
          ? evaluationTime
          : head.challengeWindowStartedAtMs;
        await client.query(updateRateLimitSql, [
          input.candidate.binding.tenantId,
          input.candidate.binding.projectId,
          input.candidate.binding.gatewayId,
          windowStart.toString(),
          resetWindow ? 1 : head.challengeRequestCount + 1,
        ]);
        const pending = await client.query<CloudLinkPostgresRow>(
          lockPendingChallengeSql,
          [
            input.candidate.binding.tenantId,
            input.candidate.binding.projectId,
            input.candidate.binding.gatewayId,
          ],
        );
        const pendingRow = pending.rows[0];
        if (pendingRow !== undefined) {
          const current = decodeChallengeRow(pendingRow);
          if (evaluationTime < BigInt(current.record.expiresAtMs)) {
            return sameBinding(
              current.record.binding,
              input.candidate.binding,
            ) &&
              sameChallengeRequest(
                current.record.request,
                input.candidate.request,
              )
              ? { outcome: "replayed", challenge: current.record }
              : { outcome: "request-conflict" };
          }
          const superseded = await client.query(supersedeChallengeSql, [
            input.candidate.binding.tenantId,
            input.candidate.binding.projectId,
            input.candidate.binding.gatewayId,
            current.record.challengeId,
            input.evaluationTimeMs,
          ]);
          if (superseded.rowCount !== 1) {
            throw new Error("CloudLink challenge supersession failed");
          }
        }
        const inserted = await client.query(insertChallengeSql, [
          input.candidate.binding.tenantId,
          input.candidate.binding.projectId,
          input.candidate.binding.gatewayId,
          input.candidate.binding.generation,
          input.candidate.binding.status,
          input.candidate.request.credentialId,
          JSON.stringify(input.candidate.request.offeredProtocolVersions),
          input.candidate.request.clientNonce,
          JSON.stringify(input.candidate.request.resumeCursors),
          input.candidate.challengeId,
          input.candidate.cloudNonce,
          input.candidate.issuedAtMs,
          input.candidate.expiresAtMs,
          input.candidate.cloudAuthentication.keyId,
          input.candidate.cloudAuthentication.signature,
        ]);
        return inserted.rowCount === 1
          ? { outcome: "issued", challenge: input.candidate }
          : { outcome: "request-conflict" };
      },
    );
  }

  find(
    binding: GatewayCredentialBinding,
    challengeId: CloudLinkSessionChallengeId,
  ): Promise<CloudLinkSessionChallengeRecord | undefined> {
    return this.transaction(binding.tenantId, async (client) => {
      const selected = await client.query<CloudLinkPostgresRow>(
        selectChallengeSql,
        [
          binding.tenantId,
          binding.projectId,
          binding.gatewayId,
          binding.generation,
          binding.status,
          challengeId,
        ],
      );
      const row = selected.rows[0];
      return row === undefined ? undefined : decodeChallengeRow(row).record;
    });
  }

  acceptAndOpen(
    input: AcceptCloudLinkSessionChallengeRepositoryInput,
  ): Promise<AcceptCloudLinkSessionChallengeRepositoryResult> {
    return this.transaction(input.binding.tenantId, async (client) => {
      requireActiveBinding(input.binding);
      requireFingerprint(input.authenticationFingerprint);
      const evaluationTime = parseUint64(
        input.evaluationTimeMs,
        "evaluation_time_ms",
      );
      const head = await this.lockGatewayHead(client, input.binding);
      const selected = await client.query<CloudLinkPostgresRow>(
        lockChallengeSql,
        [
          input.binding.tenantId,
          input.binding.projectId,
          input.binding.gatewayId,
          input.challengeId,
        ],
      );
      const row = selected.rows[0];
      if (row === undefined) return { outcome: "not-found" };
      const stored = decodeChallengeRow(row);
      if (!sameBinding(stored.record.binding, input.binding)) {
        return { outcome: "binding-conflict" };
      }
      if (stored.authenticationFingerprint !== undefined) {
        if (
          stored.authenticationFingerprint !==
            input.authenticationFingerprint ||
          stored.consumedSessionId === undefined
        ) {
          return { outcome: "consumed-conflict" };
        }
        const session = await this.selectSession(
          client,
          input.binding,
          stored.consumedSessionId,
        );
        return session === undefined
          ? { outcome: "consumed-conflict" }
          : { outcome: "replayed", session };
      }
      if (evaluationTime >= BigInt(stored.record.expiresAtMs)) {
        return { outcome: "expired" };
      }
      if (
        !stored.record.request.offeredProtocolVersions.includes(
          input.protocolVersion,
        )
      ) {
        return { outcome: "binding-conflict" };
      }
      const epoch = nextEpoch(head.lastEpoch);
      const cursors = await this.selectCursors(client, input.binding);
      const session = buildActiveSession(
        input.binding,
        input.sessionId,
        epoch,
        input.protocolVersion,
        input.openedAt,
        cursors,
        {
          gatewayKeyId: input.gatewayKeyId,
          heartbeatIntervalMs: input.heartbeatIntervalMs,
        },
      );
      const fencedSessionId = await this.fenceCurrent(
        client,
        input.binding,
        head.currentSessionId,
        input.openedAt,
      );
      await client.query(insertSessionSql, sessionWriteValues(session));
      const consumed = await client.query(consumeChallengeSql, [
        input.binding.tenantId,
        input.binding.projectId,
        input.binding.gatewayId,
        input.challengeId,
        input.authenticationFingerprint,
        input.sessionId,
        input.evaluationTimeMs,
      ]);
      if (consumed.rowCount !== 1) {
        throw new Error("CloudLink challenge consumption failed");
      }
      await this.updateHead(client, input.binding, epoch, input.sessionId);
      return {
        outcome: "opened",
        session,
        ...(fencedSessionId === undefined ? {} : { fencedSessionId }),
      };
    });
  }

  private async lockGatewayHead(
    client: PostgresCloudLinkSessionClient,
    binding: GatewayCredentialBinding,
  ): Promise<ReturnType<typeof parseHead>> {
    const values = [
      binding.tenantId,
      binding.projectId,
      binding.gatewayId,
    ] as const;
    await client.query(ensureHeadSql, values);
    const selected = await client.query<HeadRow>(lockHeadSql, values);
    const row = selected.rows[0];
    if (row === undefined) {
      throw new Error("PostgreSQL CloudLink Gateway head is unavailable");
    }
    return parseHead(row);
  }

  private async selectSession(
    client: PostgresCloudLinkSessionClient,
    binding: GatewayCredentialBinding,
    sessionId: CloudLinkSessionId,
  ): Promise<CloudLinkSession | undefined> {
    const selected = await client.query<CloudLinkPostgresRow>(
      selectSessionSql,
      [
        binding.tenantId,
        binding.projectId,
        binding.gatewayId,
        sessionId,
        binding.generation,
      ],
    );
    const row = selected.rows[0];
    return row === undefined ? undefined : decodeSessionRow(row);
  }

  private async selectCursors(
    client: PostgresCloudLinkSessionClient,
    binding: GatewayCredentialBinding,
  ): Promise<readonly CloudLinkStreamCursor[]> {
    const selected = await client.query<CloudLinkPostgresRow>(
      selectCursorsSql,
      [binding.tenantId, binding.projectId, binding.gatewayId],
    );
    return decodeCursors(selected.rows);
  }

  private async fenceCurrent(
    client: PostgresCloudLinkSessionClient,
    binding: GatewayCredentialBinding,
    currentSessionId: CloudLinkSessionId | undefined,
    closedAt: UtcInstant,
  ): Promise<CloudLinkSessionId | undefined> {
    if (currentSessionId === undefined) return undefined;
    const fenced = await client.query(fenceCurrentSql, [
      binding.tenantId,
      binding.projectId,
      binding.gatewayId,
      currentSessionId,
      closedAt,
    ]);
    if (fenced.rowCount !== 1) {
      throw new Error("PostgreSQL CloudLink current session cannot be fenced");
    }
    return currentSessionId;
  }

  private async updateHead(
    client: PostgresCloudLinkSessionClient,
    binding: GatewayCredentialBinding,
    epoch: ReturnType<typeof parseCloudLinkSessionEpoch>,
    sessionId: CloudLinkSessionId,
  ): Promise<void> {
    const updated = await client.query(updateHeadSessionSql, [
      binding.tenantId,
      binding.projectId,
      binding.gatewayId,
      epoch,
      sessionId,
    ]);
    if (updated.rowCount !== 1) {
      throw new Error("PostgreSQL CloudLink Gateway head update failed");
    }
  }

  private async platformTransaction<Result>(
    operation: (client: PostgresCloudLinkSessionClient) => Promise<Result>,
  ): Promise<Result> {
    let client: PostgresCloudLinkSessionClient | undefined;
    let began = false;
    try {
      client = await this.#pool.connect();
      await client.query("BEGIN");
      began = true;
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch {
      if (client !== undefined && began) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The fixed public storage error stays authoritative.
        }
      }
      throw new CloudLinkPostgresStorageError();
    } finally {
      client?.release();
    }
  }

  private async transaction<Result>(
    tenantId: TenantId,
    operation: (client: PostgresCloudLinkSessionClient) => Promise<Result>,
  ): Promise<Result> {
    let client: PostgresCloudLinkSessionClient | undefined;
    let began = false;
    try {
      client = await this.#pool.connect();
      await client.query("BEGIN");
      began = true;
      await client.query(
        "SELECT set_config('aethercloud.tenant_id', $1, true)",
        [tenantId],
      );
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch {
      if (client !== undefined && began) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The fixed public storage error stays authoritative.
        }
      }
      throw new CloudLinkPostgresStorageError();
    } finally {
      client?.release();
    }
  }
}
