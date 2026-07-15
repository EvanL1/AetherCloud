import { createHash } from "node:crypto";

import type {
  GatewayFindResult,
  GatewayIdentityInsertRequest,
  GatewayIdentityRepository,
  GatewayIdentityReplaceRequest,
  GatewayInsertResult,
  GatewayReplaceResult,
  GatewayScope,
} from "@aether-cloud/application";
import type {
  GatewayId,
  GatewayIdentity,
  TenantId,
} from "@aether-cloud/domain";
import {
  claimGatewayEnrollment,
  issueGatewayEnrollmentClaim,
  parseCredentialRequestFingerprint,
  parseEnrollmentClaimId,
  parseEnrollmentRequestId,
  parseEnrollmentTokenDigest,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  registerGatewayIdentity,
} from "@aether-cloud/domain";

import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryResult,
} from "./postgres-contracts.js";

const selectGatewaySql = `
SELECT
  tenant_id::text AS tenant_id,
  project_id::text AS project_id,
  gateway_id::text AS gateway_id,
  display_name,
  revision::text AS revision,
  enrollment_state,
  registration_request_id,
  to_char(registered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS registered_at,
  claim_id::text AS claim_id,
  token_digest,
  claim_issue_request_id,
  CASE WHEN claim_issued_at IS NULL THEN NULL ELSE to_char(claim_issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS claim_issued_at,
  CASE WHEN claim_expires_at IS NULL THEN NULL ELSE to_char(claim_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS claim_expires_at,
  claim_request_id,
  credential_request_fingerprint,
  CASE WHEN claimed_at IS NULL THEN NULL ELSE to_char(claimed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS claimed_at
FROM aethercloud.gateway_identities
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
`;

const insertGatewaySql = `
INSERT INTO aethercloud.gateway_identities (
  tenant_id,
  project_id,
  gateway_id,
  display_name,
  revision,
  enrollment_state,
  registration_request_id,
  registered_at
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5::bigint,
  $6,
  $7,
  $8::timestamptz
)
ON CONFLICT (tenant_id, project_id, gateway_id) DO NOTHING
`;

const replaceGatewaySql = `
UPDATE aethercloud.gateway_identities
SET
  display_name = $4,
  revision = $5::bigint,
  enrollment_state = $7,
  claim_id = $8::uuid,
  token_digest = $9,
  claim_issue_request_id = CASE
    WHEN $7 = 'awaiting-claim' THEN $10
    ELSE claim_issue_request_id
  END,
  claim_issued_at = CASE
    WHEN $7 = 'awaiting-claim' THEN $11::timestamptz
    ELSE claim_issued_at
  END,
  claim_expires_at = CASE
    WHEN $7 = 'awaiting-claim' THEN $12::timestamptz
    ELSE claim_expires_at
  END,
  claim_request_id = $13,
  credential_request_fingerprint = $14,
  claimed_at = $15::timestamptz,
  updated_at = clock_timestamp()
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
  AND revision = $6::bigint
RETURNING revision::text AS revision
`;

const selectRevisionSql = `
SELECT revision::text AS revision
FROM aethercloud.gateway_identities
WHERE tenant_id = $1::uuid
  AND project_id = $2::uuid
  AND gateway_id = $3::uuid
`;

const insertAuditSql = `
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
  $5,
  $6,
  $7,
  'gateway',
  $8,
  'succeeded',
  $9,
  $10,
  $11
)
`;

const insertOutboxSql = `
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
  'gateway',
  $6,
  $7::jsonb
)
`;

type Row = Record<string, unknown>;

function requireString(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`PostgreSQL Gateway row has invalid ${field}`);
  }
  return value;
}

function parseRevision(input: unknown): number {
  if (typeof input !== "string" || !/^[1-9][0-9]*$/.test(input)) {
    throw new Error("PostgreSQL Gateway row has invalid revision");
  }
  const revision = Number(input);
  if (!Number.isSafeInteger(revision)) {
    throw new Error(
      "PostgreSQL Gateway revision exceeds JavaScript safe range",
    );
  }
  return revision;
}

function requireTransition<Value>(
  result:
    | Readonly<{ ok: true; value: Value }>
    | Readonly<{ ok: false; failure: Readonly<{ message: string }> }>,
): Value {
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
}

function decodeGatewayRow(row: Row): GatewayIdentity {
  const revision = parseRevision(row.revision);
  const registered = registerGatewayIdentity({
    tenantId: parseTenantId(row.tenant_id),
    projectId: parseProjectId(row.project_id),
    gatewayId: parseGatewayId(row.gateway_id),
    displayName: requireString(row, "display_name"),
    requestId: parseEnrollmentRequestId(row.registration_request_id),
    registeredAt: parseUtcInstant(row.registered_at),
  });
  const state = requireString(row, "enrollment_state");
  let gateway: GatewayIdentity;
  if (state === "registered") {
    gateway = registered;
  } else {
    const pending = requireTransition(
      issueGatewayEnrollmentClaim(registered, {
        requestId: parseEnrollmentRequestId(row.claim_issue_request_id),
        claimId: parseEnrollmentClaimId(row.claim_id),
        tokenDigest: parseEnrollmentTokenDigest(row.token_digest),
        issuedAt: parseUtcInstant(row.claim_issued_at),
        expiresAt: parseUtcInstant(row.claim_expires_at),
      }),
    );
    if (state === "awaiting-claim") {
      gateway = pending;
    } else if (state === "claimed") {
      gateway = requireTransition(
        claimGatewayEnrollment(pending, {
          requestId: parseEnrollmentRequestId(row.claim_request_id),
          credentialRequestFingerprint: parseCredentialRequestFingerprint(
            row.credential_request_fingerprint,
          ),
          claimedAt: parseUtcInstant(row.claimed_at),
        }),
      );
    } else {
      throw new Error(
        "PostgreSQL Gateway row has unsupported enrollment state",
      );
    }
  }
  if (gateway.revision !== revision) {
    throw new Error("PostgreSQL Gateway row revision contradicts its state");
  }
  return gateway;
}

function stableEventId(
  prefix: "audit" | "outbox",
  request: GatewayIdentityInsertRequest,
): string {
  const digest = createHash("sha256")
    .update(
      [
        request.tenantId,
        request.projectId,
        request.gateway.gatewayId,
        request.evidence.action,
        request.evidence.requestId,
      ].join(":"),
    )
    .digest("hex")
    .slice(0, 32);
  return `${prefix}:gateway:${digest}`;
}

async function setTenantScope(
  client: PostgresClient,
  tenantId: TenantId,
): Promise<void> {
  await client.query("SELECT set_config('aethercloud.tenant_id', $1, true)", [
    tenantId,
  ]);
}

async function insertEvidence(
  client: PostgresClient,
  request: GatewayIdentityInsertRequest,
): Promise<void> {
  const { evidence, gateway } = request;
  await client.query(insertAuditSql, [
    stableEventId("audit", request),
    request.tenantId,
    request.projectId,
    evidence.occurredAt,
    evidence.actor.kind,
    evidence.actor.subjectId,
    evidence.action,
    gateway.gatewayId,
    evidence.risk,
    evidence.confirmation,
    evidence.requestId,
  ]);
  await client.query(insertOutboxSql, [
    stableEventId("outbox", request),
    request.tenantId,
    request.projectId,
    evidence.occurredAt,
    evidence.eventName,
    gateway.gatewayId,
    JSON.stringify({
      tenantId: request.tenantId,
      projectId: request.projectId,
      gatewayId: gateway.gatewayId,
      revision: gateway.revision,
      enrollmentState: gateway.enrollment.state,
    }),
  ]);
}

function replacementValues(
  request: GatewayIdentityReplaceRequest,
): readonly unknown[] {
  const { gateway } = request;
  if (gateway.enrollment.state === "registered") {
    throw new Error("Gateway replacement cannot return to registered state");
  }
  const pending = gateway.enrollment.state === "awaiting-claim";
  return [
    request.tenantId,
    request.projectId,
    gateway.gatewayId,
    gateway.displayName,
    gateway.revision,
    request.expectedRevision,
    gateway.enrollment.state,
    pending ? gateway.enrollment.claim.claimId : gateway.enrollment.claimId,
    pending
      ? gateway.enrollment.claim.tokenDigest
      : gateway.enrollment.tokenDigest,
    pending ? gateway.enrollment.requestId : null,
    pending ? gateway.enrollment.claim.issuedAt : null,
    pending ? gateway.enrollment.claim.expiresAt : null,
    pending ? null : gateway.enrollment.requestId,
    pending ? null : gateway.enrollment.credentialRequestFingerprint,
    pending ? null : gateway.enrollment.claimedAt,
  ];
}

export class PostgresGatewayIdentityRepository implements GatewayIdentityRepository {
  readonly #pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.#pool = pool;
  }

  find(scope: GatewayScope, gatewayId: GatewayId): Promise<GatewayFindResult> {
    return this.transaction<GatewayFindResult>(
      scope.tenantId,
      { outcome: "storage-unavailable" },
      async (client) => {
        const query = await client.query<Row>(selectGatewaySql, [
          scope.tenantId,
          scope.projectId,
          gatewayId,
        ]);
        const row = query.rows[0];
        return row === undefined
          ? { outcome: "not-found" }
          : { outcome: "found", gateway: decodeGatewayRow(row) };
      },
    );
  }

  insert(request: GatewayIdentityInsertRequest): Promise<GatewayInsertResult> {
    return this.transaction(
      request.tenantId,
      "storage-unavailable",
      async (client) => {
        const { gateway } = request;
        if (gateway.enrollment.state !== "registered") {
          throw new Error("Gateway insertion requires registered state");
        }
        const inserted = await client.query(insertGatewaySql, [
          request.tenantId,
          request.projectId,
          gateway.gatewayId,
          gateway.displayName,
          gateway.revision,
          gateway.enrollment.state,
          gateway.enrollment.requestId,
          gateway.enrollment.registeredAt,
        ]);
        if (inserted.rowCount !== 1) return "already-exists";
        await insertEvidence(client, request);
        return "inserted";
      },
    );
  }

  replace(
    request: GatewayIdentityReplaceRequest,
  ): Promise<GatewayReplaceResult> {
    return this.transaction(
      request.tenantId,
      "storage-unavailable",
      async (client) => {
        const updated = await client.query<Row>(
          replaceGatewaySql,
          replacementValues(request),
        );
        if (updated.rowCount !== 1) {
          const current = await client.query<Row>(selectRevisionSql, [
            request.tenantId,
            request.projectId,
            request.gateway.gatewayId,
          ]);
          return current.rows.length === 0 ? "not-found" : "version-conflict";
        }
        await insertEvidence(client, request);
        return "replaced";
      },
    );
  }

  private async transaction<Result>(
    tenantId: TenantId,
    unavailable: Result,
    operation: (client: PostgresClient) => Promise<Result>,
  ): Promise<Result> {
    let client: PostgresClient | undefined;
    let began = false;
    try {
      client = await this.#pool.connect();
      await client.query("BEGIN");
      began = true;
      await setTenantScope(client, tenantId);
      const outcome = await operation(client);
      await client.query("COMMIT");
      return outcome;
    } catch {
      if (client !== undefined && began) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The typed storage outcome remains authoritative even if rollback transport fails.
        }
      }
      return unavailable;
    } finally {
      client?.release();
    }
  }
}

export type { PostgresQueryResult };
