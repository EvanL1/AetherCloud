import { describe, expect, it } from "vitest";

import {
  ClaimGatewayEnrollment,
  IssueGatewayEnrollment,
  RegisterGateway,
  type ApplicationClock,
} from "@aether-cloud/application";
import {
  parseGatewayId,
  parseEnrollmentRequestId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  registerGatewayIdentity,
} from "@aether-cloud/domain";

import {
  InMemoryEnrollmentTokenService,
  InMemoryGatewayIdentityRepository,
} from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const otherTenantId = parseTenantId("99999999-9999-4999-8999-999999999999");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");

class FixedClock implements ApplicationClock {
  now() {
    return parseUtcInstant("2026-07-14T08:05:00.000Z");
  }
}

describe("fleet in-memory adapters", () => {
  it("scopes gateway identities by tenant and rejects stale replacements", async () => {
    const repository = new InMemoryGatewayIdentityRepository();
    const gateway = registerGatewayIdentity({
      tenantId,
      projectId,
      gatewayId,
      displayName: "North plant gateway",
      requestId: parseEnrollmentRequestId("register-request-001"),
      registeredAt: parseUtcInstant("2026-07-14T08:00:00.000Z"),
    });

    expect(await repository.insert(gateway)).toBe("inserted");
    expect(await repository.insert(gateway)).toBe("already-exists");
    expect(await repository.find({ tenantId, projectId }, gatewayId)).toBe(
      gateway,
    );
    expect(
      await repository.find({ tenantId: otherTenantId, projectId }, gatewayId),
    ).toBeUndefined();
    expect(await repository.replace(gateway, 0)).toBe("version-conflict");
  });

  it("issues replay-stable token material and detects conflicting reuse", async () => {
    const tokens = new InMemoryEnrollmentTokenService({
      tokenFactory: () => "deterministic-enrollment-token",
      claimIdFactory: () => "44444444-4444-4444-8444-444444444444",
    });
    const request = {
      tenantId,
      projectId,
      gatewayId,
      requestId: parseEnrollmentRequestId("issue-request-001"),
      issuedAt: parseUtcInstant("2026-07-14T08:05:00.000Z"),
      expiresAt: parseUtcInstant("2026-07-14T08:15:00.000Z"),
    };

    const first = await tokens.issue(request);
    const replay = await tokens.issue(request);
    const conflict = await tokens.issue({
      ...request,
      expiresAt: parseUtcInstant("2026-07-14T08:20:00.000Z"),
    });

    expect(first).toEqual(replay);
    expect(conflict).toMatchObject({
      ok: false,
      failure: { code: "idempotency-conflict" },
    });
    if (first.ok) {
      expect(
        await tokens.matches(first.value.token, first.value.tokenDigest),
      ).toBe(true);
      expect(
        await tokens.matches("incorrect-token", first.value.tokenDigest),
      ).toBe(false);
    }
  });

  it("supports the register, issue, and claim application flow", async () => {
    const repository = new InMemoryGatewayIdentityRepository();
    const tokens = new InMemoryEnrollmentTokenService({
      tokenFactory: () => "deterministic-enrollment-token",
      claimIdFactory: () => "44444444-4444-4444-8444-444444444444",
    });
    const clock = new FixedClock();
    const register = new RegisterGateway({ repository, clock });
    const issue = new IssueGatewayEnrollment({ repository, tokens, clock });
    const claim = new ClaimGatewayEnrollment({ repository, tokens, clock });

    await register.execute(
      {
        tenantId,
        projectId,
        subjectId: "operator:alice",
        permissions: ["fleet.gateway.create"],
        idempotencyKey: "register-request-001",
        issuedAt: "2026-07-14T08:00:00.000Z",
        expiresAt: "2026-07-14T08:10:00.000Z",
      },
      { gatewayId, displayName: "North plant gateway" },
    );
    const issued = await issue.execute(
      {
        tenantId,
        projectId,
        subjectId: "operator:alice",
        permissions: ["fleet.gateway.enrollment.issue"],
        idempotencyKey: "issue-request-001",
        issuedAt: "2026-07-14T08:00:00.000Z",
        expiresAt: "2026-07-14T08:10:00.000Z",
        confirmation: {
          method: "explicit",
          confirmedAt: "2026-07-14T08:00:01.000Z",
        },
      },
      { gatewayId, claimExpiresAt: "2026-07-14T08:15:00.000Z" },
    );
    expect(issued.ok).toBe(true);

    const claimed = await claim.execute(
      {
        tenantId,
        projectId,
        idempotencyKey: "claim-request-001",
        issuedAt: "2026-07-14T08:04:00.000Z",
        expiresAt: "2026-07-14T08:10:00.000Z",
      },
      {
        gatewayId,
        enrollmentToken: "deterministic-enrollment-token",
        credentialRequestFingerprint: "b".repeat(64),
      },
    );

    expect(claimed).toMatchObject({
      ok: true,
      replayed: false,
      value: { state: "claimed", revision: 3 },
    });
  });
});
