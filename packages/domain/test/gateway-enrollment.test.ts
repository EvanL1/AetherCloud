import { describe, expect, it } from "vitest";

import {
  InvalidDomainValueError,
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
} from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const claimId = parseEnrollmentClaimId("44444444-4444-4444-8444-444444444444");
const tokenDigest = parseEnrollmentTokenDigest("a".repeat(64));
const requestFingerprint = parseCredentialRequestFingerprint("b".repeat(64));

function registeredGateway() {
  return registerGatewayIdentity({
    tenantId,
    projectId,
    gatewayId,
    displayName: "North plant gateway",
    requestId: parseEnrollmentRequestId("register-request-001"),
    registeredAt: parseUtcInstant("2026-07-14T07:55:00.000Z"),
  });
}

function pendingGateway() {
  const result = issueGatewayEnrollmentClaim(registeredGateway(), {
    requestId: parseEnrollmentRequestId("issue-request-001"),
    claimId,
    tokenDigest,
    issuedAt: parseUtcInstant("2026-07-14T08:00:00.000Z"),
    expiresAt: parseUtcInstant("2026-07-14T08:15:00.000Z"),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("test setup failed to issue a claim");
  return result.value;
}

describe("gateway enrollment domain", () => {
  it("rejects an invalid Gateway display name", () => {
    expect(() =>
      registerGatewayIdentity({
        tenantId,
        projectId,
        gatewayId,
        displayName: "   ",
        requestId: parseEnrollmentRequestId("register-request-invalid"),
        registeredAt: parseUtcInstant("2026-07-14T07:55:00.000Z"),
      }),
    ).toThrow(InvalidDomainValueError);
  });

  it("registers an immutable tenant-scoped gateway before issuing a claim", () => {
    const gateway = registeredGateway();

    expect(gateway).toMatchObject({
      tenantId,
      projectId,
      gatewayId,
      displayName: "North plant gateway",
      revision: 1,
      enrollment: {
        state: "registered",
        requestId: "register-request-001",
        registeredAt: "2026-07-14T07:55:00.000Z",
      },
    });
    expect(Object.isFrozen(gateway)).toBe(true);
    expect(Object.isFrozen(gateway.enrollment)).toBe(true);
  });

  it("issues an expiring claim while retaining only its token digest", () => {
    const result = issueGatewayEnrollmentClaim(registeredGateway(), {
      requestId: parseEnrollmentRequestId("issue-request-001"),
      claimId,
      tokenDigest,
      issuedAt: parseUtcInstant("2026-07-14T08:00:00.000Z"),
      expiresAt: parseUtcInstant("2026-07-14T08:15:00.000Z"),
    });

    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        revision: 2,
        enrollment: {
          state: "awaiting-claim",
          requestId: "issue-request-001",
          claim: {
            claimId,
            tokenDigest,
            issuedAt: "2026-07-14T08:00:00.000Z",
            expiresAt: "2026-07-14T08:15:00.000Z",
          },
        },
      },
    });
  });

  it("rejects a claim issue that does not expire after issuance", () => {
    const result = issueGatewayEnrollmentClaim(registeredGateway(), {
      requestId: parseEnrollmentRequestId("issue-request-expired"),
      claimId,
      tokenDigest,
      issuedAt: parseUtcInstant("2026-07-14T08:00:00.000Z"),
      expiresAt: parseUtcInstant("2026-07-14T08:00:00.000Z"),
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "enrollment-claim-expired" },
    });
  });

  it("replays the same claim issue and rejects a competing active claim", () => {
    const gateway = pendingGateway();
    const replay = issueGatewayEnrollmentClaim(gateway, {
      requestId: parseEnrollmentRequestId("issue-request-001"),
      claimId,
      tokenDigest,
      issuedAt: parseUtcInstant("2026-07-14T08:00:00.000Z"),
      expiresAt: parseUtcInstant("2026-07-14T08:15:00.000Z"),
    });
    const competing = issueGatewayEnrollmentClaim(gateway, {
      requestId: parseEnrollmentRequestId("issue-request-002"),
      claimId: parseEnrollmentClaimId("55555555-5555-4555-8555-555555555555"),
      tokenDigest,
      issuedAt: parseUtcInstant("2026-07-14T08:01:00.000Z"),
      expiresAt: parseUtcInstant("2026-07-14T08:16:00.000Z"),
    });

    expect(replay).toEqual({ ok: true, replayed: true, value: gateway });
    expect(competing).toMatchObject({
      ok: false,
      failure: { code: "invalid-gateway-enrollment-transition" },
    });
  });

  it("claims a pending gateway without ever handling the raw token", () => {
    const result = claimGatewayEnrollment(pendingGateway(), {
      requestId: parseEnrollmentRequestId("claim-request-001"),
      credentialRequestFingerprint: requestFingerprint,
      claimedAt: parseUtcInstant("2026-07-14T08:05:00.000Z"),
    });

    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        revision: 3,
        enrollment: {
          state: "claimed",
          claimId,
          tokenDigest,
          requestId: "claim-request-001",
          credentialRequestFingerprint: requestFingerprint,
          claimedAt: "2026-07-14T08:05:00.000Z",
        },
      },
    });
  });

  it("treats an identical claim request as an idempotent replay", () => {
    const first = claimGatewayEnrollment(pendingGateway(), {
      requestId: parseEnrollmentRequestId("claim-request-001"),
      credentialRequestFingerprint: requestFingerprint,
      claimedAt: parseUtcInstant("2026-07-14T08:05:00.000Z"),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replay = claimGatewayEnrollment(first.value, {
      requestId: parseEnrollmentRequestId("claim-request-001"),
      credentialRequestFingerprint: requestFingerprint,
      claimedAt: parseUtcInstant("2026-07-14T08:06:00.000Z"),
    });

    expect(replay).toEqual({ ok: true, replayed: true, value: first.value });
  });

  it("rejects a claim at expiry without changing gateway state", () => {
    const gateway = pendingGateway();
    const result = claimGatewayEnrollment(gateway, {
      requestId: parseEnrollmentRequestId("claim-request-expired"),
      credentialRequestFingerprint: requestFingerprint,
      claimedAt: parseUtcInstant("2026-07-14T08:15:00.000Z"),
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        code: "enrollment-claim-expired",
        message: "gateway enrollment claim has expired",
      },
    });
    expect(gateway.enrollment.state).toBe("awaiting-claim");
  });

  it("rejects a second non-identical claim", () => {
    const first = claimGatewayEnrollment(pendingGateway(), {
      requestId: parseEnrollmentRequestId("claim-request-001"),
      credentialRequestFingerprint: requestFingerprint,
      claimedAt: parseUtcInstant("2026-07-14T08:05:00.000Z"),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const result = claimGatewayEnrollment(first.value, {
      requestId: parseEnrollmentRequestId("claim-request-002"),
      credentialRequestFingerprint: parseCredentialRequestFingerprint(
        "c".repeat(64),
      ),
      claimedAt: parseUtcInstant("2026-07-14T08:06:00.000Z"),
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "invalid-gateway-enrollment-transition" },
    });
  });

  it("requires an active claim and a recovery workflow after claim", () => {
    const withoutClaim = claimGatewayEnrollment(registeredGateway(), {
      requestId: parseEnrollmentRequestId("claim-request-001"),
      credentialRequestFingerprint: requestFingerprint,
      claimedAt: parseUtcInstant("2026-07-14T08:05:00.000Z"),
    });
    const claimed = claimGatewayEnrollment(pendingGateway(), {
      requestId: parseEnrollmentRequestId("claim-request-001"),
      credentialRequestFingerprint: requestFingerprint,
      claimedAt: parseUtcInstant("2026-07-14T08:05:00.000Z"),
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const issueAfterClaim = issueGatewayEnrollmentClaim(claimed.value, {
      requestId: parseEnrollmentRequestId("issue-request-recovery"),
      claimId,
      tokenDigest,
      issuedAt: parseUtcInstant("2026-07-14T08:06:00.000Z"),
      expiresAt: parseUtcInstant("2026-07-14T08:16:00.000Z"),
    });

    expect(withoutClaim).toMatchObject({
      ok: false,
      failure: { code: "invalid-gateway-enrollment-transition" },
    });
    expect(issueAfterClaim).toMatchObject({
      ok: false,
      failure: { code: "invalid-gateway-enrollment-transition" },
    });
  });
});
