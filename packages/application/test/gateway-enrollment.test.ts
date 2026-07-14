import { describe, expect, it } from "vitest";

import {
  CLAIM_GATEWAY_ENROLLMENT_COMMAND,
  ClaimGatewayEnrollment,
  GET_GATEWAY_ENROLLMENT_QUERY,
  GetGatewayEnrollment,
  ISSUE_GATEWAY_ENROLLMENT_COMMAND,
  IssueGatewayEnrollment,
  REGISTER_GATEWAY_COMMAND,
  RegisterGateway,
  type ApplicationClock,
  type EnrollmentTokenService,
  type GatewayIdentityRepository,
} from "../src/index.js";
import {
  parseEnrollmentClaimId,
  parseEnrollmentTokenDigest,
  parseUtcInstant,
  type GatewayIdentity,
  type ProjectId,
  type TenantId,
} from "@aether-cloud/domain";

const tenantId = "11111111-1111-4111-8111-111111111111";
const otherTenantId = "99999999-9999-4999-8999-999999999999";
const projectId = "22222222-2222-4222-8222-222222222222";
const gatewayId = "33333333-3333-4333-8333-333333333333";
const enrollmentToken = "enrollment-secret-with-sufficient-entropy";

class FixedClock implements ApplicationClock {
  #current = parseUtcInstant("2026-07-14T08:05:00.000Z");

  now() {
    return this.#current;
  }

  set(instant: string) {
    this.#current = parseUtcInstant(instant);
  }
}

class MemoryRepository implements GatewayIdentityRepository {
  readonly #gateways = new Map<string, GatewayIdentity>();

  find(
    scope: Readonly<{ tenantId: TenantId; projectId: ProjectId }>,
    requestedGatewayId: GatewayIdentity["gatewayId"],
  ) {
    return Promise.resolve(
      this.#gateways.get(
        `${scope.tenantId}:${scope.projectId}:${requestedGatewayId}`,
      ),
    );
  }

  insert(gateway: GatewayIdentity) {
    const key = `${gateway.tenantId}:${gateway.projectId}:${gateway.gatewayId}`;
    if (this.#gateways.has(key)) {
      return Promise.resolve("already-exists" as const);
    }
    this.#gateways.set(key, gateway);
    return Promise.resolve("inserted" as const);
  }

  replace(gateway: GatewayIdentity, expectedRevision: number) {
    const key = `${gateway.tenantId}:${gateway.projectId}:${gateway.gatewayId}`;
    const current = this.#gateways.get(key);
    if (current === undefined) return Promise.resolve("not-found" as const);
    if (current.revision !== expectedRevision) {
      return Promise.resolve("version-conflict" as const);
    }
    this.#gateways.set(key, gateway);
    return Promise.resolve("replaced" as const);
  }
}

class FixedTokenService implements EnrollmentTokenService {
  readonly #digest = parseEnrollmentTokenDigest("a".repeat(64));

  issue() {
    return Promise.resolve({
      ok: true as const,
      value: {
        claimId: parseEnrollmentClaimId("44444444-4444-4444-8444-444444444444"),
        token: enrollmentToken,
        tokenDigest: this.#digest,
      },
    });
  }

  matches(token: string, expectedDigest: string) {
    return Promise.resolve(
      token === enrollmentToken && expectedDigest === this.#digest,
    );
  }
}

function commandContext(
  permission: string,
  idempotencyKey: string,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    tenantId,
    projectId,
    subjectId: "operator:alice",
    permissions: [permission],
    idempotencyKey,
    issuedAt: "2026-07-14T08:00:00.000Z",
    expiresAt: "2026-07-14T08:10:00.000Z",
    confirmation: {
      confirmedAt: "2026-07-14T08:00:01.000Z",
      method: "explicit",
    },
    ...overrides,
  };
}

const registerInput = {
  gatewayId,
  displayName: "North plant gateway",
};

const issueInput = {
  gatewayId,
  claimExpiresAt: "2026-07-14T08:15:00.000Z",
};

function createUseCases() {
  const repository = new MemoryRepository();
  const tokens = new FixedTokenService();
  const clock = new FixedClock();
  return {
    register: new RegisterGateway({ repository, clock }),
    issue: new IssueGatewayEnrollment({ repository, tokens, clock }),
    claim: new ClaimGatewayEnrollment({ repository, tokens, clock }),
    get: new GetGatewayEnrollment({ repository }),
    repository,
    clock,
  };
}

async function registerGateway(register: RegisterGateway) {
  return register.execute(
    commandContext("fleet.gateway.create", "register-request-001"),
    registerInput,
  );
}

describe("gateway enrollment application boundary", () => {
  it("declares governed command and query metadata", () => {
    expect(REGISTER_GATEWAY_COMMAND).toMatchObject({
      kind: "command",
      permission: "fleet.gateway.create",
      risk: "low",
      confirmation: "not-required",
      idempotency: "required",
      expiry: "required",
      audit: "required",
    });
    expect(ISSUE_GATEWAY_ENROLLMENT_COMMAND).toEqual({
      kind: "command",
      name: "fleet.gateway.enrollment.issue",
      permission: "fleet.gateway.enrollment.issue",
      risk: "high",
      confirmation: "explicit",
      idempotency: "required",
      expiry: "required",
      audit: "required",
      authorization: "tenant-permission",
    });
    expect(CLAIM_GATEWAY_ENROLLMENT_COMMAND).toMatchObject({
      kind: "command",
      permission: "fleet.gateway.enrollment.claim",
      risk: "medium",
      confirmation: "not-required",
      idempotency: "required",
      expiry: "required",
      audit: "required",
      authorization: "enrollment-token",
    });
    expect(GET_GATEWAY_ENROLLMENT_QUERY).toEqual({
      kind: "query",
      name: "fleet.gateway.enrollment.get",
      permission: "fleet.gateway.enrollment.read",
    });
  });

  it("fails closed without the issue permission", async () => {
    const { register, issue } = createUseCases();
    await registerGateway(register);

    const result = await issue.execute(
      commandContext("fleet.gateway.enrollment.issue", "issue-request-001", {
        permissions: [],
      }),
      issueInput,
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "permission-denied" },
    });
  });

  it("returns typed invalid-input failures before repository access", async () => {
    const { register, issue } = createUseCases();

    const invalidContext = await register.execute(null, registerInput);
    const invalidPermissions = await register.execute(
      commandContext("fleet.gateway.create", "register-request-001", {
        permissions: "fleet.gateway.create",
      }),
      registerInput,
    );
    const invalidConfirmation = await issue.execute(
      commandContext("fleet.gateway.enrollment.issue", "issue-request-001", {
        confirmation: { method: "implicit" },
      }),
      issueInput,
    );

    expect(invalidContext).toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
    expect(invalidPermissions).toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
    expect(invalidConfirmation).toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
  });

  it("requires explicit confirmation before issuing a claim token", async () => {
    const { register, issue } = createUseCases();
    await registerGateway(register);
    const context = commandContext(
      "fleet.gateway.enrollment.issue",
      "issue-request-001",
    );
    Reflect.deleteProperty(context, "confirmation");

    const result = await issue.execute(context, issueInput);

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "confirmation-required" },
    });
  });

  it("registers a gateway and idempotently issues a token only once", async () => {
    const { register, issue } = createUseCases();

    const registration = await registerGateway(register);
    const first = await issue.execute(
      commandContext("fleet.gateway.enrollment.issue", "issue-request-001"),
      issueInput,
    );
    const replay = await issue.execute(
      commandContext("fleet.gateway.enrollment.issue", "issue-request-001"),
      issueInput,
    );

    expect(registration).toMatchObject({
      ok: true,
      replayed: false,
      value: { state: "registered", revision: 1 },
    });
    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        enrollmentToken,
        gateway: {
          tenantId,
          projectId,
          gatewayId,
          state: "awaiting-claim",
          revision: 2,
        },
      },
    });
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      value: { gateway: { state: "awaiting-claim" } },
    });
    if (replay.ok) {
      expect("enrollmentToken" in replay.value).toBe(false);
    }
  });

  it("distinguishes registration replay, idempotency conflict, and identity conflict", async () => {
    const { register } = createUseCases();
    await registerGateway(register);

    const replay = await registerGateway(register);
    const changedPayload = await register.execute(
      commandContext("fleet.gateway.create", "register-request-001"),
      { ...registerInput, displayName: "Changed name" },
    );
    const differentRequest = await register.execute(
      commandContext("fleet.gateway.create", "register-request-002"),
      registerInput,
    );

    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(changedPayload).toMatchObject({
      ok: false,
      failure: { code: "idempotency-conflict" },
    });
    expect(differentRequest).toMatchObject({
      ok: false,
      failure: { code: "gateway-already-exists" },
    });
  });

  it("rejects claim issuance for a missing Gateway or competing request", async () => {
    const { register, issue } = createUseCases();
    const missing = await issue.execute(
      commandContext("fleet.gateway.enrollment.issue", "issue-request-missing"),
      issueInput,
    );
    await registerGateway(register);
    await issue.execute(
      commandContext("fleet.gateway.enrollment.issue", "issue-request-001"),
      issueInput,
    );
    const conflictingKey = await issue.execute(
      commandContext("fleet.gateway.enrollment.issue", "issue-request-002"),
      issueInput,
    );
    const conflictingPayload = await issue.execute(
      commandContext("fleet.gateway.enrollment.issue", "issue-request-001"),
      { ...issueInput, claimExpiresAt: "2026-07-14T08:20:00.000Z" },
    );

    expect(missing).toMatchObject({
      ok: false,
      failure: { code: "gateway-not-found" },
    });
    expect(conflictingKey).toMatchObject({
      ok: false,
      failure: { code: "invalid-gateway-enrollment-transition" },
    });
    expect(conflictingPayload).toMatchObject({
      ok: false,
      failure: { code: "idempotency-conflict" },
    });
  });

  it("rejects an expired command before issuing a token", async () => {
    const { register, issue } = createUseCases();
    await registerGateway(register);

    const result = await issue.execute(
      commandContext("fleet.gateway.enrollment.issue", "issue-request-001", {
        expiresAt: "2026-07-14T08:04:59.999Z",
      }),
      issueInput,
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "command-expired" },
    });
  });

  it("rejects commands and confirmations dated in the future", async () => {
    const { register, issue } = createUseCases();
    const futureCommand = await register.execute(
      commandContext("fleet.gateway.create", "register-request-future", {
        issuedAt: "2026-07-14T08:06:00.000Z",
      }),
      registerInput,
    );
    await registerGateway(register);
    const futureConfirmation = await issue.execute(
      commandContext("fleet.gateway.enrollment.issue", "issue-request-future", {
        confirmation: {
          method: "explicit",
          confirmedAt: "2026-07-14T08:06:00.000Z",
        },
      }),
      issueInput,
    );

    expect(futureCommand).toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
    expect(futureConfirmation).toMatchObject({
      ok: false,
      failure: { code: "confirmation-required" },
    });
  });

  it("claims the gateway with a valid token without persisting the raw token", async () => {
    const { register, issue, claim, repository } = createUseCases();
    await registerGateway(register);
    await issue.execute(
      commandContext("fleet.gateway.enrollment.issue", "issue-request-001"),
      issueInput,
    );

    const result = await claim.execute(
      {
        tenantId,
        projectId,
        idempotencyKey: "claim-request-001",
        issuedAt: "2026-07-14T08:04:00.000Z",
        expiresAt: "2026-07-14T08:10:00.000Z",
      },
      {
        gatewayId,
        enrollmentToken,
        credentialRequestFingerprint: "b".repeat(64),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      value: { state: "claimed", revision: 3 },
    });
    const stored = await repository.find(
      {
        tenantId: tenantId as TenantId,
        projectId: projectId as ProjectId,
      },
      gatewayId as GatewayIdentity["gatewayId"],
    );
    expect(JSON.stringify(stored)).not.toContain(enrollmentToken);
  });

  it("idempotently replays a claimed Gateway after verifying the token", async () => {
    const { register, issue, claim } = createUseCases();
    await registerGateway(register);
    await issue.execute(
      commandContext("fleet.gateway.enrollment.issue", "issue-request-001"),
      issueInput,
    );
    const context = {
      tenantId,
      projectId,
      idempotencyKey: "claim-request-001",
      issuedAt: "2026-07-14T08:04:00.000Z",
      expiresAt: "2026-07-14T08:10:00.000Z",
    };
    const input = {
      gatewayId,
      enrollmentToken,
      credentialRequestFingerprint: "b".repeat(64),
    };

    const first = await claim.execute(context, input);
    const replay = await claim.execute(context, input);

    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(replay).toMatchObject({ ok: true, replayed: true });
  });

  it("rejects an invalid or expired enrollment claim", async () => {
    const first = createUseCases();
    await registerGateway(first.register);
    await first.issue.execute(
      commandContext("fleet.gateway.enrollment.issue", "issue-request-001"),
      issueInput,
    );

    const invalidToken = await first.claim.execute(
      {
        tenantId,
        projectId,
        idempotencyKey: "claim-request-invalid",
        issuedAt: "2026-07-14T08:04:00.000Z",
        expiresAt: "2026-07-14T08:10:00.000Z",
      },
      {
        gatewayId,
        enrollmentToken: "incorrect-enrollment-token",
        credentialRequestFingerprint: "b".repeat(64),
      },
    );
    expect(invalidToken).toMatchObject({
      ok: false,
      failure: { code: "invalid-enrollment-token" },
    });

    const second = createUseCases();
    await registerGateway(second.register);
    await second.issue.execute(
      commandContext("fleet.gateway.enrollment.issue", "issue-request-002"),
      { ...issueInput, claimExpiresAt: "2026-07-14T08:06:00.000Z" },
    );
    second.clock.set("2026-07-14T08:06:00.000Z");
    const expired = await second.claim.execute(
      {
        tenantId,
        projectId,
        idempotencyKey: "claim-request-expired",
        issuedAt: "2026-07-14T08:04:00.000Z",
        expiresAt: "2026-07-14T08:10:00.000Z",
      },
      {
        gatewayId,
        enrollmentToken,
        credentialRequestFingerprint: "b".repeat(64),
      },
    );
    expect(expired).toMatchObject({
      ok: false,
      failure: { code: "enrollment-claim-expired" },
    });
  });

  it("does not disclose a gateway through another tenant query", async () => {
    const { register, get } = createUseCases();
    await registerGateway(register);

    const result = await get.execute(
      {
        tenantId: otherTenantId,
        projectId,
        subjectId: "operator:mallory",
        permissions: ["fleet.gateway.enrollment.read"],
      },
      { gatewayId },
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "gateway-not-found" },
    });
  });

  it("authorizes a scoped status query and denies missing permission", async () => {
    const { register, get } = createUseCases();
    await registerGateway(register);
    const input = { gatewayId };
    const allowed = await get.execute(
      {
        tenantId,
        projectId,
        subjectId: "operator:alice",
        permissions: ["fleet.gateway.enrollment.read"],
      },
      input,
    );
    const denied = await get.execute(
      {
        tenantId,
        projectId,
        subjectId: "operator:bob",
        permissions: [],
      },
      input,
    );

    expect(allowed).toMatchObject({
      ok: true,
      value: { state: "registered" },
    });
    if (allowed.ok) expect("replayed" in allowed).toBe(false);
    expect(denied).toMatchObject({
      ok: false,
      failure: { code: "permission-denied" },
    });
  });
});
