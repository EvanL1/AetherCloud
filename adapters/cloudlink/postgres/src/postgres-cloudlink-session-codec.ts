import type { CloudLinkSessionChallengeRecord } from "@aether-cloud/application";
import {
  parseCloudLinkSessionChallengeId,
  parseCloudLinkSessionEpoch,
  parseCloudLinkGatewayKeyId,
  parseCloudLinkHeartbeatIntervalMs,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseProtocolVersion,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";
import type {
  CloudLinkSession,
  CloudLinkSessionState,
  CloudLinkStreamCursor,
  GatewayCredentialBinding,
  GatewayCredentialStatus,
} from "@aether-cloud/domain";

export type CloudLinkPostgresRow = Record<string, unknown>;

export interface StoredCloudLinkChallenge {
  readonly record: CloudLinkSessionChallengeRecord;
  readonly authenticationFingerprint?: string;
  readonly consumedSessionId?: CloudLinkSession["sessionId"];
}

const uint64Pattern = /^(?:0|[1-9][0-9]{0,19})$/;
const maximumUint64 = 18_446_744_073_709_551_615n;
const fingerprintPattern = /^sha256:[0-9a-f]{64}$/;
const credentialIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const noncePattern = /^[A-Za-z0-9_-]{43}$/;
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;

function invalidRow(field: string): Error {
  return new Error(`PostgreSQL CloudLink row has invalid ${field}`);
}

function optionalString(
  row: CloudLinkPostgresRow,
  field: string,
): string | undefined {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw invalidRow(field);
  }
  return value;
}

function requireUint64(input: unknown, field: string): string {
  if (
    typeof input !== "string" ||
    !uint64Pattern.test(input) ||
    BigInt(input) > maximumUint64
  ) {
    throw invalidRow(field);
  }
  return input;
}

function requirePositiveSafeInteger(input: unknown, field: string): number {
  const value = requireUint64(input, field);
  const parsed = Number(value);
  if (parsed < 1 || !Number.isSafeInteger(parsed)) {
    throw invalidRow(field);
  }
  return parsed;
}

function requireObject(input: unknown, field: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRow(field);
  }
  return input as Record<string, unknown>;
}

function requireExactKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw invalidRow(field);
  }
}

function requirePattern(
  input: unknown,
  pattern: RegExp,
  field: string,
): string {
  if (typeof input !== "string" || !pattern.test(input)) {
    throw invalidRow(field);
  }
  return input;
}

function parseSessionState(input: unknown): CloudLinkSessionState {
  if (
    input !== "active" &&
    input !== "closed" &&
    input !== "draining" &&
    input !== "negotiating" &&
    input !== "resuming" &&
    input !== "suspect"
  ) {
    throw invalidRow("state");
  }
  return input;
}

function parseCredentialStatus(input: unknown): GatewayCredentialStatus {
  if (input !== "active" && input !== "revoked" && input !== "suspended") {
    throw invalidRow("credential_status");
  }
  return input;
}

export function decodeResumeCursors(
  input: unknown,
  field = "resume_cursors",
): readonly CloudLinkStreamCursor[] {
  if (!Array.isArray(input) || input.length > 32) {
    throw invalidRow(field);
  }
  const identities = new Set<string>();
  const cursors = input.map((candidate) => {
    const cursor = requireObject(candidate, field);
    requireExactKeys(cursor, ["streamId", "streamEpoch", "position"], field);
    const parsed = Object.freeze({
      streamId: parseStreamId(cursor.streamId),
      streamEpoch: parseStreamEpoch(cursor.streamEpoch),
      position: parseStreamPosition(cursor.position),
    });
    const identity = `${parsed.streamId}:${parsed.streamEpoch}`;
    if (identities.has(identity)) throw invalidRow(field);
    identities.add(identity);
    return parsed;
  });
  return Object.freeze(cursors);
}

export function decodeSessionRow(row: CloudLinkPostgresRow): CloudLinkSession {
  const state = parseSessionState(row.state);
  const protocolVersion =
    row.protocol_version === null || row.protocol_version === undefined
      ? undefined
      : parseProtocolVersion(row.protocol_version);
  const resumeCursors =
    row.resume_cursors === null || row.resume_cursors === undefined
      ? undefined
      : decodeResumeCursors(row.resume_cursors);
  const activatedAt =
    optionalString(row, "activated_at") === undefined
      ? undefined
      : parseUtcInstant(row.activated_at);
  const gatewayKeyId =
    optionalString(row, "gateway_key_id") === undefined
      ? undefined
      : parseCloudLinkGatewayKeyId(row.gateway_key_id);
  const heartbeatIntervalMs =
    row.heartbeat_interval_ms === null ||
    row.heartbeat_interval_ms === undefined
      ? undefined
      : parseCloudLinkHeartbeatIntervalMs(row.heartbeat_interval_ms);
  const lastHeartbeatAt =
    optionalString(row, "last_heartbeat_at") === undefined
      ? undefined
      : parseUtcInstant(row.last_heartbeat_at);
  const lastHeartbeatRequestId = optionalString(
    row,
    "last_heartbeat_request_id",
  );
  const suspectAt =
    optionalString(row, "suspect_at") === undefined
      ? undefined
      : parseUtcInstant(row.suspect_at);
  const closedAt =
    optionalString(row, "closed_at") === undefined
      ? undefined
      : parseUtcInstant(row.closed_at);
  const closeReason = optionalString(row, "close_reason");
  if (
    closeReason !== undefined &&
    closeReason !== "drained" &&
    closeReason !== "fenced" &&
    closeReason !== "heartbeat-timeout"
  ) {
    throw invalidRow("close_reason");
  }
  if (
    (state === "active" &&
      (protocolVersion === undefined ||
        resumeCursors === undefined ||
        activatedAt === undefined)) ||
    (state === "closed") !==
      (closedAt !== undefined && closeReason !== undefined) ||
    (state !== "closed" &&
      (closedAt !== undefined || closeReason !== undefined)) ||
    (gatewayKeyId === undefined) !== (heartbeatIntervalMs === undefined)
  ) {
    throw invalidRow("state");
  }
  return Object.freeze({
    tenantId: parseTenantId(row.tenant_id),
    projectId: parseProjectId(row.project_id),
    gatewayId: parseGatewayId(row.gateway_id),
    sessionId: parseCloudLinkSessionId(row.session_id),
    credentialGeneration: parseGatewayCredentialGeneration(
      row.credential_generation,
    ),
    epoch: parseCloudLinkSessionEpoch(row.epoch),
    state,
    openedAt: parseUtcInstant(row.opened_at),
    revision: requirePositiveSafeInteger(row.revision, "revision"),
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    ...(resumeCursors === undefined ? {} : { resumeCursors }),
    ...(activatedAt === undefined ? {} : { activatedAt }),
    ...(gatewayKeyId === undefined ? {} : { gatewayKeyId }),
    ...(heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs }),
    ...(lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt }),
    ...(lastHeartbeatRequestId === undefined ? {} : { lastHeartbeatRequestId }),
    ...(suspectAt === undefined ? {} : { suspectAt }),
    ...(closedAt === undefined ? {} : { closedAt }),
    ...(closeReason === undefined ? {} : { closeReason }),
  });
}

function decodeChallengeRequest(
  input: unknown,
): CloudLinkSessionChallengeRecord["request"] {
  const request = requireObject(input, "request_state");
  requireExactKeys(
    request,
    [
      "gatewayId",
      "credentialId",
      "credentialGeneration",
      "offeredProtocolVersions",
      "clientNonce",
      "resumeCursors",
    ],
    "request_state",
  );
  if (
    !Array.isArray(request.offeredProtocolVersions) ||
    request.offeredProtocolVersions.length < 1 ||
    request.offeredProtocolVersions.length > 8
  ) {
    throw invalidRow("offered_protocol_versions");
  }
  const offeredProtocolVersions = Object.freeze(
    request.offeredProtocolVersions.map(parseProtocolVersion),
  );
  if (
    new Set(offeredProtocolVersions).size !== offeredProtocolVersions.length
  ) {
    throw invalidRow("offered_protocol_versions");
  }
  return Object.freeze({
    gatewayId: parseGatewayId(request.gatewayId),
    credentialId: requirePattern(
      request.credentialId,
      credentialIdPattern,
      "credential_id",
    ),
    credentialGeneration: parseGatewayCredentialGeneration(
      request.credentialGeneration,
    ),
    offeredProtocolVersions,
    clientNonce: requirePattern(
      request.clientNonce,
      noncePattern,
      "client_nonce",
    ),
    resumeCursors: decodeResumeCursors(request.resumeCursors),
  });
}

function decodeChallengeAuthentication(
  input: unknown,
): CloudLinkSessionChallengeRecord["cloudAuthentication"] {
  const authentication = requireObject(input, "cloud_authentication");
  requireExactKeys(
    authentication,
    ["keyId", "algorithm", "signature"],
    "cloud_authentication",
  );
  if (authentication.algorithm !== "Ed25519") {
    throw invalidRow("cloud_authentication");
  }
  return Object.freeze({
    keyId: requirePattern(authentication.keyId, keyIdPattern, "key_id"),
    algorithm: "Ed25519" as const,
    signature: requirePattern(
      authentication.signature,
      signaturePattern,
      "signature",
    ),
  });
}

export function decodeChallengeRow(
  row: CloudLinkPostgresRow,
): StoredCloudLinkChallenge {
  const binding: GatewayCredentialBinding = Object.freeze({
    tenantId: parseTenantId(row.tenant_id),
    projectId: parseProjectId(row.project_id),
    gatewayId: parseGatewayId(row.gateway_id),
    generation: parseGatewayCredentialGeneration(row.credential_generation),
    status: parseCredentialStatus(row.credential_status),
  });
  const request = decodeChallengeRequest(row.request_state);
  if (
    request.gatewayId !== binding.gatewayId ||
    request.credentialGeneration !== binding.generation
  ) {
    throw invalidRow("request_state");
  }
  const issuedAtMs = requireUint64(row.issued_at_ms, "issued_at_ms");
  const expiresAtMs = requireUint64(row.expires_at_ms, "expires_at_ms");
  if (BigInt(expiresAtMs) <= BigInt(issuedAtMs)) {
    throw invalidRow("expires_at_ms");
  }
  const record: CloudLinkSessionChallengeRecord = Object.freeze({
    binding,
    request,
    challengeId: parseCloudLinkSessionChallengeId(row.challenge_id),
    cloudNonce: requirePattern(row.cloud_nonce, noncePattern, "cloud_nonce"),
    issuedAtMs,
    expiresAtMs,
    cloudAuthentication: decodeChallengeAuthentication(
      row.cloud_authentication,
    ),
  });
  const fingerprint = optionalString(row, "authentication_fingerprint");
  if (fingerprint !== undefined && !fingerprintPattern.test(fingerprint)) {
    throw invalidRow("authentication_fingerprint");
  }
  const consumedSessionId =
    row.consumed_session_id === null || row.consumed_session_id === undefined
      ? undefined
      : parseCloudLinkSessionId(row.consumed_session_id);
  if ((fingerprint === undefined) !== (consumedSessionId === undefined)) {
    throw invalidRow("challenge_consumption");
  }
  return Object.freeze({
    record,
    ...(fingerprint === undefined
      ? {}
      : { authenticationFingerprint: fingerprint }),
    ...(consumedSessionId === undefined ? {} : { consumedSessionId }),
  });
}

export function sameBinding(
  left: GatewayCredentialBinding,
  right: GatewayCredentialBinding,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.gatewayId === right.gatewayId &&
    left.generation === right.generation &&
    left.status === right.status
  );
}

export function sameChallengeRequest(
  left: CloudLinkSessionChallengeRecord["request"],
  right: CloudLinkSessionChallengeRecord["request"],
): boolean {
  return (
    left.gatewayId === right.gatewayId &&
    left.credentialId === right.credentialId &&
    left.credentialGeneration === right.credentialGeneration &&
    left.clientNonce === right.clientNonce &&
    left.offeredProtocolVersions.length ===
      right.offeredProtocolVersions.length &&
    left.offeredProtocolVersions.every(
      (version, index) => version === right.offeredProtocolVersions[index],
    ) &&
    left.resumeCursors.length === right.resumeCursors.length &&
    left.resumeCursors.every((cursor, index) => {
      const other = right.resumeCursors[index];
      return (
        other !== undefined &&
        cursor.streamId === other.streamId &&
        cursor.streamEpoch === other.streamEpoch &&
        cursor.position === other.position
      );
    })
  );
}

export function sessionWriteValues(
  session: CloudLinkSession,
): readonly unknown[] {
  return [
    session.tenantId,
    session.projectId,
    session.gatewayId,
    session.sessionId,
    session.credentialGeneration,
    session.epoch,
    session.state,
    session.openedAt,
    session.revision,
    session.protocolVersion ?? null,
    session.resumeCursors === undefined
      ? null
      : JSON.stringify(session.resumeCursors),
    session.activatedAt ?? null,
    session.gatewayKeyId ?? null,
    session.heartbeatIntervalMs ?? null,
    session.lastHeartbeatAt ?? null,
    session.lastHeartbeatRequestId ?? null,
    session.suspectAt ?? null,
    session.closedAt ?? null,
    session.closeReason ?? null,
  ];
}
