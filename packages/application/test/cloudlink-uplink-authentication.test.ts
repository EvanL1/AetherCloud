import { describe, expect, it } from "vitest";

import {
  AuthenticateGatewaySignedCloudLinkUplink,
  isGatewaySignedCloudLinkUplinkAuthenticationFact,
  validateGatewaySignedCloudLinkAuthenticationConsumption,
  type CloudLinkUplinkAuthenticationRepository,
  type CloudLinkUplinkAuthenticationRepositoryResult,
  type CloudLinkUplinkCryptographicVerifier,
  type CloudLinkUplinkCryptographicVerifierInput,
  type CloudLinkUplinkEvaluationClock,
  type CloudLinkUplinkSigningProjection,
} from "../src/index.js";
import {
  parseCloudLinkSessionEpoch,
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
  type CloudLinkSession,
} from "@aether-cloud/domain";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const sessionId = parseCloudLinkSessionId(
  "44444444-4444-4444-8444-444444444444",
);
const sessionEpoch = parseCloudLinkSessionEpoch("7");
const credentialGeneration = parseGatewayCredentialGeneration("3");
const gatewayKeyId = "gateway-session-key-17";
const signature = "A".repeat(86);
const signingObjectDigest = `sha256:${"a".repeat(64)}`;

function activeGatewaySignedSession(
  overrides: Partial<CloudLinkSession> = {},
): CloudLinkSession {
  return Object.freeze({
    tenantId,
    projectId,
    gatewayId,
    sessionId,
    credentialGeneration,
    epoch: sessionEpoch,
    state: "active",
    openedAt: parseUtcInstant("2026-07-17T08:00:00.000Z"),
    activatedAt: parseUtcInstant("2026-07-17T08:00:00.000Z"),
    protocolVersion: parseProtocolVersion("1.0"),
    resumeCursors: [],
    revision: 3,
    gatewayKeyId,
    heartbeatIntervalMs: "30000",
    ...overrides,
  });
}

class MutableClock implements CloudLinkUplinkEvaluationClock {
  milliseconds = "1784275200000";

  nowMilliseconds(): string {
    return this.milliseconds;
  }
}

class RecordingVerifier implements CloudLinkUplinkCryptographicVerifier {
  readonly calls: CloudLinkUplinkCryptographicVerifierInput[] = [];
  result:
    | Awaited<ReturnType<CloudLinkUplinkCryptographicVerifier["verify"]>>
    | undefined = {
    gatewayKeyActive: true,
    signatureVerified: true,
    signingObjectDigest,
  };
  failure: Error | undefined;

  verify(
    input: CloudLinkUplinkCryptographicVerifierInput,
  ): Promise<
    Awaited<ReturnType<CloudLinkUplinkCryptographicVerifier["verify"]>>
  > {
    this.calls.push(input);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve(this.result);
  }
}

class StubAuthenticationRepository implements CloudLinkUplinkAuthenticationRepository {
  readonly heartbeatCalls: Parameters<
    CloudLinkUplinkAuthenticationRepository["acceptHeartbeat"]
  >[0][] = [];
  heartbeatResult: CloudLinkUplinkAuthenticationRepositoryResult = {
    outcome: "accepted",
  };

  acceptHeartbeat(
    input: Parameters<
      CloudLinkUplinkAuthenticationRepository["acceptHeartbeat"]
    >[0],
  ): Promise<CloudLinkUplinkAuthenticationRepositoryResult> {
    this.heartbeatCalls.push(input);
    return Promise.resolve(this.heartbeatResult);
  }
}

class SessionReader {
  session: CloudLinkSession | undefined = activeGatewaySignedSession();
  failure: Error | undefined;

  findCurrent() {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve(this.session);
  }
}

function heartbeatInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId,
    projectId,
    gatewayId,
    sessionId,
    sessionEpoch,
    credentialGeneration,
    messageKind: "heartbeat",
    observedAtMs: "1784275200000",
    messageAuthentication: {
      keyId: gatewayKeyId,
      algorithm: "Ed25519",
      signature,
    },
    ...overrides,
  };
}

function deliveryInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId,
    projectId,
    gatewayId,
    sessionId,
    sessionEpoch,
    credentialGeneration,
    messageKind: "telemetry-batch",
    sentAtMs: "1784275200000",
    expiresAtMs: "1784275260000",
    delivery: {
      streamId: "telemetry",
      streamEpoch: "4",
      position: "18",
      batchId: "telemetry-batch-18",
      digest: `sha256:${"b".repeat(64)}`,
    },
    messageAuthentication: {
      keyId: gatewayKeyId,
      algorithm: "Ed25519",
      signature,
    },
    ...overrides,
  };
}

function setup() {
  const sessions = new SessionReader();
  const repository = new StubAuthenticationRepository();
  const verifier = new RecordingVerifier();
  const clock = new MutableClock();
  const useCase = new AuthenticateGatewaySignedCloudLinkUplink({
    sessions,
    repository,
    verifier,
    clock,
    enabled: true,
  });
  return { clock, repository, sessions, useCase, verifier };
}

describe("Gateway-signed CloudLink per-uplink authentication", () => {
  it("projects the exact frozen 13-field heartbeat and delivery objects", async () => {
    const context = setup();

    await expect(
      context.useCase.execute(heartbeatInput()),
    ).resolves.toMatchObject({
      ok: true,
      replayed: false,
      value: {
        messageKind: "heartbeat",
        refreshServerLiveness: true,
        signingObjectDigest,
      },
    });
    expect(context.verifier.calls[0]?.projection).toEqual({
      schema: "aether.cloudlink.uplink-signing.v1alpha1",
      gateway_id: gatewayId,
      credential_generation: credentialGeneration,
      session_id: sessionId,
      session_epoch: sessionEpoch,
      message_kind: "heartbeat",
      sent_at_ms: "1784275200000",
      expires_at_ms: null,
      stream_id: null,
      stream_epoch: null,
      position: null,
      batch_id: null,
      business_digest: null,
    } satisfies CloudLinkUplinkSigningProjection);

    await expect(
      context.useCase.execute(deliveryInput()),
    ).resolves.toMatchObject({
      ok: true,
      replayed: false,
      value: {
        messageKind: "telemetry-batch",
        refreshServerLiveness: false,
        signingObjectDigest,
      },
    });
    expect(context.verifier.calls[1]?.projection).toEqual({
      schema: "aether.cloudlink.uplink-signing.v1alpha1",
      gateway_id: gatewayId,
      credential_generation: credentialGeneration,
      session_id: sessionId,
      session_epoch: sessionEpoch,
      message_kind: "telemetry-batch",
      sent_at_ms: "1784275200000",
      expires_at_ms: "1784275260000",
      stream_id: parseStreamId("telemetry"),
      stream_epoch: parseStreamEpoch("4"),
      position: parseStreamPosition("18"),
      batch_id: "telemetry-batch-18",
      business_digest: `sha256:${"b".repeat(64)}`,
    } satisfies CloudLinkUplinkSigningProjection);
  });

  it("requires one active current accepted session with exact tenant, project, gateway, key, epoch, and generation", async () => {
    for (const session of [
      undefined,
      activeGatewaySignedSession({ state: "closed" }),
      activeGatewaySignedSession({
        sessionId: parseCloudLinkSessionId(
          "55555555-5555-4555-8555-555555555555",
        ),
      }),
      activeGatewaySignedSession({
        epoch: parseCloudLinkSessionEpoch("8"),
      }),
      activeGatewaySignedSession({
        credentialGeneration: parseGatewayCredentialGeneration("4"),
      }),
      activeGatewaySignedSession({ gatewayKeyId: "another-gateway-key" }),
      Object.freeze(
        Object.fromEntries(
          Object.entries(activeGatewaySignedSession()).filter(
            ([key]) => key !== "heartbeatIntervalMs",
          ),
        ) as unknown as CloudLinkSession,
      ),
    ]) {
      const context = setup();
      context.sessions.session = session;

      await expect(
        context.useCase.execute(heartbeatInput()),
      ).resolves.toMatchObject({
        ok: false,
        failure: { code: "AUTHENTICATION_INVALID" },
      });
      expect(context.verifier.calls).toEqual([]);
      expect(context.repository.heartbeatCalls).toEqual([]);
    }
  });

  it("evaluates heartbeat future, stale equality, and uint64 overflow with only its explicit clock", async () => {
    const observedAt = 1_784_275_200_000n;
    for (const evaluationTime of [
      observedAt - 30_000n,
      observedAt + 90_000n - 1n,
    ]) {
      const context = setup();
      context.clock.milliseconds = evaluationTime.toString();
      await expect(
        context.useCase.execute(heartbeatInput()),
      ).resolves.toMatchObject({ ok: true, replayed: false });
    }

    const future = setup();
    future.clock.milliseconds = (observedAt - 30_001n).toString();
    await expect(
      future.useCase.execute(heartbeatInput()),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "AUTHENTICATION_INVALID" },
    });

    const stale = setup();
    stale.clock.milliseconds = (observedAt + 90_000n).toString();
    await expect(
      stale.useCase.execute(heartbeatInput()),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "MESSAGE_EXPIRED" },
    });

    for (const overflow of [
      {
        now: "18446744073709551615",
        observedAtMs: "1784275200000",
        heartbeatIntervalMs: "1",
      },
      {
        now: "18446744073709551614",
        observedAtMs: "18446744073709551615",
        heartbeatIntervalMs: "1",
      },
      {
        now: "1784275200000",
        observedAtMs: "1784275200000",
        heartbeatIntervalMs: "18446744073709551615",
      },
    ]) {
      const context = setup();
      context.clock.milliseconds = overflow.now;
      context.sessions.session = activeGatewaySignedSession({
        heartbeatIntervalMs: overflow.heartbeatIntervalMs,
      });
      await expect(
        context.useCase.execute(
          heartbeatInput({ observedAtMs: overflow.observedAtMs }),
        ),
      ).resolves.toMatchObject({
        ok: false,
        failure: { code: "AUTHENTICATION_INVALID" },
      });
      expect(context.repository.heartbeatCalls).toEqual([]);
    }
  });

  it("never refreshes liveness for an exact heartbeat replay and never changes replay state for conflicts", async () => {
    const replay = setup();
    replay.repository.heartbeatResult = { outcome: "replayed" };
    await expect(
      replay.useCase.execute(heartbeatInput()),
    ).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: { refreshServerLiveness: false },
    });

    for (const outcome of ["conflict", "lower"] as const) {
      const context = setup();
      context.repository.heartbeatResult = { outcome };
      await expect(
        context.useCase.execute(heartbeatInput()),
      ).resolves.toMatchObject({
        ok: false,
        failure: { code: "AUTHENTICATION_INVALID" },
      });
    }
  });

  it("authenticates delivery before existing business idempotency and rejects expiry equality", async () => {
    const accepted = setup();
    await expect(
      accepted.useCase.execute(deliveryInput()),
    ).resolves.toMatchObject({
      ok: true,
      replayed: false,
      value: {
        refreshServerLiveness: false,
        signingObjectDigest,
      },
    });
    expect(accepted.repository.heartbeatCalls).toEqual([]);

    const expired = setup();
    expired.clock.milliseconds = "1784275260000";
    await expect(
      expired.useCase.execute(deliveryInput()),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "MESSAGE_EXPIRED" },
    });
    expect(expired.repository.heartbeatCalls).toEqual([]);
  });

  it("gives authentication/session failures precedence over freshness and fails resolver exceptions closed without sensitive output", async () => {
    const context = setup();
    context.sessions.session = activeGatewaySignedSession({
      gatewayKeyId: "another-gateway-key",
    });
    context.clock.milliseconds = "1784275260000";
    const mismatch = await context.useCase.execute(deliveryInput());
    expect(mismatch).toMatchObject({
      ok: false,
      failure: { code: "AUTHENTICATION_INVALID" },
    });
    expect(JSON.stringify(mismatch)).not.toContain(signature);
    expect(JSON.stringify(mismatch)).not.toContain(gatewayKeyId);

    const resolverFailure = setup();
    resolverFailure.verifier.failure = new Error(
      `resolver leaked ${gatewayKeyId} ${signature}`,
    );
    const rejected = await resolverFailure.useCase.execute(heartbeatInput());
    expect(rejected).toEqual({
      ok: false,
      failure: {
        code: "AUTHENTICATION_INVALID",
        message: "Gateway uplink authentication is invalid",
      },
    });
    expect(JSON.stringify(rejected)).not.toContain(gatewayKeyId);
    expect(JSON.stringify(rejected)).not.toContain(signature);
  });

  it("rejects a non-canonical base64url alias before invoking a cryptographic adapter", async () => {
    const context = setup();
    const nonCanonicalAlias = `${signature.slice(0, -1)}B`;

    await expect(
      context.useCase.execute(
        heartbeatInput({
          messageAuthentication: {
            keyId: gatewayKeyId,
            algorithm: "Ed25519",
            signature: nonCanonicalAlias,
          },
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "INVALID_INPUT" },
    });
    expect(context.verifier.calls).toEqual([]);
    expect(context.repository.heartbeatCalls).toEqual([]);
  });

  it("is explicit and default-off", async () => {
    const disabled = new AuthenticateGatewaySignedCloudLinkUplink({
      sessions: new SessionReader(),
      repository: new StubAuthenticationRepository(),
      verifier: new RecordingVerifier(),
      clock: new MutableClock(),
    });
    await expect(disabled.execute(heartbeatInput())).resolves.toMatchObject({
      ok: false,
      failure: { code: "GATEWAY_SIGNED_UPLINK_DISABLED" },
    });
  });

  it("issues a runtime-unforgeable, non-serializable authentication capability", async () => {
    const context = setup();
    const result = await context.useCase.execute(deliveryInput());
    if (!result.ok) throw new Error("signed delivery must authenticate");

    expect(isGatewaySignedCloudLinkUplinkAuthenticationFact(result.value)).toBe(
      true,
    );
    expect(JSON.stringify(result.value)).toBe("{}");
    expect(
      isGatewaySignedCloudLinkUplinkAuthenticationFact({
        tenantId: result.value.tenantId,
        projectId: result.value.projectId,
        signingObjectDigest: result.value.signingObjectDigest,
      }),
    ).toBe(false);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.signingProjection)).toBe(true);
    expect(() => {
      (
        result.value.signingProjection as unknown as {
          message_kind: string;
        }
      ).message_kind = "integration-action-receipt";
    }).toThrow(TypeError);
    expect(result.value.signingProjection.message_kind).toBe("telemetry-batch");
  });

  it("recomputes the business payload digest and reevaluates expiry when consuming a fact", async () => {
    const context = setup();
    const authenticated = await context.useCase.execute(deliveryInput());
    if (!authenticated.ok) throw new Error("delivery must authenticate");
    const delivery = {
      sentAtMs: "1784275200000",
      expiresAtMs: "1784275260000",
      sessionId,
      sessionEpoch,
      credentialGeneration,
      streamId: parseStreamId("telemetry"),
      streamEpoch: parseStreamEpoch("4"),
      position: parseStreamPosition("18"),
      batchId: "telemetry-batch-18",
      digest: `sha256:${"b".repeat(64)}`,
      messageKind: "telemetry-batch",
    } as const;
    const payload = { samples: [{ value: 21.5 }] };

    await expect(
      validateGatewaySignedCloudLinkAuthenticationConsumption({
        kind: "delivery",
        fact: authenticated.value,
        delivery,
        payload,
        nowMs: "1784275259999",
        digestor: { digest: () => Promise.resolve(delivery.digest) },
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      validateGatewaySignedCloudLinkAuthenticationConsumption({
        kind: "delivery",
        fact: authenticated.value,
        delivery,
        payload: { samples: [{ value: 99 }] },
        nowMs: "1784275259999",
        digestor: {
          digest: () => Promise.resolve(`sha256:${"c".repeat(64)}`),
        },
      }),
    ).resolves.toEqual({
      ok: false,
      failure: "AUTHENTICATION_INVALID",
    });
    await expect(
      validateGatewaySignedCloudLinkAuthenticationConsumption({
        kind: "delivery",
        fact: authenticated.value,
        delivery,
        payload,
        nowMs: delivery.expiresAtMs,
        digestor: { digest: () => Promise.resolve(delivery.digest) },
      }),
    ).resolves.toEqual({ ok: false, failure: "MESSAGE_EXPIRED" });
  });
});
