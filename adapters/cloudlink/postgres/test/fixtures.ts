import type {
  CloudLinkSessionChallengeRecord,
  OpenCloudLinkSessionRepositoryInput,
} from "@aether-cloud/application";
import {
  parseCloudLinkSessionChallengeId,
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
  type GatewayCredentialBinding,
} from "@aether-cloud/domain";

export const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
export const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
export const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
export const firstSessionId = parseCloudLinkSessionId(
  "44444444-4444-4444-8444-444444444444",
);
export const challengeId = parseCloudLinkSessionChallengeId(
  "55555555-5555-4555-8555-555555555555",
);
export const secondSessionId = parseCloudLinkSessionId(
  "66666666-6666-4666-8666-666666666666",
);
export const openedAt = parseUtcInstant("2026-07-17T08:00:00.000Z");

export const binding: GatewayCredentialBinding = {
  tenantId,
  projectId,
  gatewayId,
  generation: parseGatewayCredentialGeneration("3"),
  status: "active",
};

export function openInput(
  requestId = "cloudlink-open-request-001",
  sessionId = firstSessionId,
): OpenCloudLinkSessionRepositoryInput {
  return {
    binding,
    requestId,
    sessionId,
    protocolVersion: parseProtocolVersion("1.0"),
    openedAt,
  };
}

export function challengeRecord(
  overrides: Partial<CloudLinkSessionChallengeRecord> = {},
): CloudLinkSessionChallengeRecord {
  return {
    binding,
    request: {
      gatewayId,
      credentialId: "development-binding-17",
      credentialGeneration: parseGatewayCredentialGeneration("3"),
      offeredProtocolVersions: [parseProtocolVersion("1.0")],
      clientNonce: "A".repeat(43),
      resumeCursors: [
        {
          streamId: parseStreamId("telemetry"),
          streamEpoch: parseStreamEpoch("4"),
          position: parseStreamPosition("18"),
        },
      ],
    },
    challengeId,
    cloudNonce: "C".repeat(43),
    issuedAtMs: "1784275200000",
    expiresAtMs: "1784275260000",
    cloudAuthentication: {
      keyId: "cloud-session-key-1",
      algorithm: "Ed25519",
      signature: "D".repeat(86),
    },
    ...overrides,
  };
}

export function sessionRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    project_id: projectId,
    gateway_id: gatewayId,
    session_id: firstSessionId,
    credential_generation: "3",
    epoch: "1",
    state: "active",
    opened_at: openedAt,
    revision: "3",
    protocol_version: "1.0",
    resume_cursors: [
      {
        streamId: "telemetry",
        streamEpoch: "4",
        position: "18",
      },
    ],
    activated_at: openedAt,
    gateway_key_id: null,
    heartbeat_interval_ms: null,
    last_heartbeat_at: null,
    last_heartbeat_request_id: null,
    suspect_at: null,
    closed_at: null,
    close_reason: null,
    ...overrides,
  };
}

export function challengeRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const challenge = challengeRecord();
  return {
    tenant_id: tenantId,
    project_id: projectId,
    gateway_id: gatewayId,
    credential_generation: "3",
    credential_status: "active",
    request_state: challenge.request,
    challenge_id: challenge.challengeId,
    cloud_nonce: challenge.cloudNonce,
    issued_at_ms: challenge.issuedAtMs,
    expires_at_ms: challenge.expiresAtMs,
    cloud_authentication: challenge.cloudAuthentication,
    authentication_fingerprint: null,
    consumed_session_id: null,
    consumed_at_ms: null,
    superseded_at_ms: null,
    ...overrides,
  };
}
