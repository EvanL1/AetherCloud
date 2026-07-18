import { describe, expect, it } from "vitest";

import {
  AcceptGatewaySignedCloudLinkSession,
  RequestCloudLinkSessionChallenge,
  type AcceptCloudLinkSessionChallengeRepositoryInput,
  type AcceptCloudLinkSessionChallengeRepositoryResult,
  type CloudLinkGatewayHelloAuthenticationInput,
  type CloudLinkGatewayHelloAuthenticator,
  type CloudLinkSessionChallengeMaterialGenerator,
  type CloudLinkSessionChallengeRecord,
  type CloudLinkSessionChallengeRepository,
  type CloudLinkSessionChallengeSigner,
  type GatewayCredentialClaim,
  type GatewayCredentialClaimResolver,
  type IssueCloudLinkSessionChallengeRepositoryInput,
  type IssueCloudLinkSessionChallengeRepositoryResult,
} from "../src/index.js";
import {
  activateCloudLinkSession,
  createCloudLinkSession,
  negotiateCloudLinkSession,
  parseCloudLinkSessionChallengeId,
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
  type GatewayCredentialBinding,
} from "@aether-cloud/domain";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const challengeId = parseCloudLinkSessionChallengeId(
  "55555555-5555-4555-8555-555555555555",
);
const sessionId = parseCloudLinkSessionId(
  "66666666-6666-4666-8666-666666666666",
);
const now = parseUtcInstant("2026-07-17T08:00:00.000Z");
const clientNonce = "A".repeat(43);
const cloudNonce = "C".repeat(43);

function binding(
  status: GatewayCredentialBinding["status"] = "active",
): GatewayCredentialBinding {
  return {
    tenantId,
    projectId,
    gatewayId,
    generation: parseGatewayCredentialGeneration("3"),
    status,
  };
}

function resumeCursors() {
  return [
    {
      streamId: parseStreamId("telemetry"),
      streamEpoch: parseStreamEpoch("4"),
      position: parseStreamPosition("18"),
    },
  ];
}

function requestInput() {
  return {
    gatewayId,
    credentialId: "development-binding-17",
    credentialGeneration: "3",
    protocolVersions: ["1.0"],
    clientNonce,
    clientPositions: [
      {
        streamId: "telemetry",
        streamEpoch: "4",
        position: "18",
      },
    ],
  };
}

function challengeRecord(): CloudLinkSessionChallengeRecord {
  return {
    binding: binding(),
    request: {
      gatewayId,
      credentialId: "development-binding-17",
      credentialGeneration: parseGatewayCredentialGeneration("3"),
      offeredProtocolVersions: [parseProtocolVersion("1.0")],
      clientNonce,
      resumeCursors: resumeCursors(),
    },
    challengeId,
    cloudNonce,
    issuedAtMs: "1784275200000",
    expiresAtMs: "1784275260000",
    cloudAuthentication: {
      keyId: "cloud-session-key-1",
      algorithm: "Ed25519",
      signature: "D".repeat(86),
    },
  };
}

function activeSession(protocolVersion = "1.0"): CloudLinkSession {
  const created = createCloudLinkSession({
    tenantId,
    projectId,
    gatewayId,
    sessionId,
    credentialGeneration: parseGatewayCredentialGeneration("3"),
    epoch: parseCloudLinkSessionEpoch("1"),
    openedAt: now,
  });
  const negotiated = negotiateCloudLinkSession(
    created,
    parseProtocolVersion(protocolVersion),
  );
  if (!negotiated.ok) throw new Error("test session must negotiate");
  const activated = activateCloudLinkSession(negotiated.value, {
    activatedAt: now,
    resumeCursors: [],
  });
  if (!activated.ok) throw new Error("test session must activate");
  return activated.value;
}

class FixedClock {
  now() {
    return now;
  }
}

class FixedClaims implements GatewayCredentialClaimResolver {
  readonly calls: GatewayCredentialClaim[] = [];
  result: GatewayCredentialBinding | undefined = binding();

  resolveClaim(claim: GatewayCredentialClaim) {
    this.calls.push(claim);
    return Promise.resolve(this.result);
  }
}

class FixedMaterials implements CloudLinkSessionChallengeMaterialGenerator {
  nextChallengeId() {
    return challengeId;
  }

  nextNonce() {
    return cloudNonce;
  }
}

class RecordingSigner implements CloudLinkSessionChallengeSigner {
  readonly calls: unknown[] = [];

  sign(input: Parameters<CloudLinkSessionChallengeSigner["sign"]>[0]) {
    this.calls.push(input);
    return Promise.resolve({
      keyId: "cloud-session-key-1",
      algorithm: "Ed25519" as const,
      signature: "D".repeat(86),
    });
  }
}

class StubChallengeRepository implements CloudLinkSessionChallengeRepository {
  issueInput: IssueCloudLinkSessionChallengeRepositoryInput | undefined;
  acceptInput: AcceptCloudLinkSessionChallengeRepositoryInput | undefined;
  found: CloudLinkSessionChallengeRecord | undefined = challengeRecord();
  issueResult: IssueCloudLinkSessionChallengeRepositoryResult | undefined;
  acceptResult: AcceptCloudLinkSessionChallengeRepositoryResult = {
    outcome: "opened",
    session: activeSession(),
  };

  issue(input: IssueCloudLinkSessionChallengeRepositoryInput) {
    this.issueInput = input;
    return Promise.resolve(
      this.issueResult ?? {
        outcome: "issued" as const,
        challenge: input.candidate,
      },
    );
  }

  find() {
    return Promise.resolve(this.found);
  }

  acceptAndOpen(input: AcceptCloudLinkSessionChallengeRepositoryInput) {
    this.acceptInput = input;
    return Promise.resolve(this.acceptResult);
  }
}

class RecordingAuthenticator implements CloudLinkGatewayHelloAuthenticator {
  readonly calls: CloudLinkGatewayHelloAuthenticationInput[] = [];
  fingerprint: string | undefined =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  verify(input: CloudLinkGatewayHelloAuthenticationInput) {
    this.calls.push(input);
    return Promise.resolve(this.fingerprint);
  }
}

function makeRequest(
  overrides: Partial<
    ConstructorParameters<typeof RequestCloudLinkSessionChallenge>[0]
  > = {},
) {
  return new RequestCloudLinkSessionChallenge({
    repository: new StubChallengeRepository(),
    credentials: new FixedClaims(),
    signer: new RecordingSigner(),
    materials: new FixedMaterials(),
    clock: new FixedClock(),
    supportedProtocolVersions: ["1.0"],
    challengeTtlMs: 60_000,
    rateLimitWindowMs: 60_000,
    rateLimitMaximumRequests: 4,
    enabled: true,
    ...overrides,
  });
}

describe("CloudLink gateway-signed session challenge application", () => {
  it("publishes governed partial capability definitions for challenge and acceptance", () => {
    expect(RequestCloudLinkSessionChallenge.definition).toMatchObject({
      name: "cloudlink.session.challenge.request",
      authorization: "gateway-credential-claim",
      audit: "required",
    });
    expect(AcceptGatewaySignedCloudLinkSession.definition).toMatchObject({
      name: "cloudlink.session.gateway-signed.accept",
      authorization: "gateway-session-challenge",
      audit: "required",
    });
  });

  it("issues a short-lived signed challenge only for an active commissioned claim", async () => {
    const repository = new StubChallengeRepository();
    const claims = new FixedClaims();
    const signer = new RecordingSigner();
    const useCase = makeRequest({
      repository,
      credentials: claims,
      signer,
    });

    await expect(useCase.execute(requestInput())).resolves.toMatchObject({
      ok: true,
      replayed: false,
      value: {
        gatewayId,
        challengeId,
        cloudNonce,
        issuedAtMs: "1784275200000",
        expiresAtMs: "1784275260000",
        cloudAuthentication: {
          keyId: "cloud-session-key-1",
          algorithm: "Ed25519",
        },
      },
    });
    expect(claims.calls).toEqual([
      {
        gatewayId,
        credentialId: "development-binding-17",
        generation: "3",
      },
    ]);
    expect(signer.calls).toEqual([
      {
        schema: "aether.cloudlink.session-challenge-signing.v1alpha1",
        gateway_id: gatewayId,
        challenge_id: challengeId,
        cloud_nonce: cloudNonce,
        issued_at_ms: "1784275200000",
        expires_at_ms: "1784275260000",
      },
    ]);
    expect(repository.issueInput).toMatchObject({
      evaluationTimeMs: "1784275200000",
      rateLimitWindowMs: 60_000,
      rateLimitMaximumRequests: 4,
      candidate: {
        request: {
          credentialId: "development-binding-17",
          clientNonce,
        },
      },
    });
    expect(JSON.stringify(await useCase.execute(requestInput()))).not.toContain(
      "development-binding-17",
    );
  });

  it("is default-off and issues nothing for inactive, mismatched, limited, or conflicting claims", async () => {
    const repository = new StubChallengeRepository();
    const claims = new FixedClaims();
    const disabled = new RequestCloudLinkSessionChallenge({
      repository,
      credentials: claims,
      signer: new RecordingSigner(),
      materials: new FixedMaterials(),
      clock: new FixedClock(),
      supportedProtocolVersions: ["1.0"],
    });
    await expect(disabled.execute(requestInput())).resolves.toMatchObject({
      ok: false,
      failure: { code: "gateway-signed-session-disabled" },
    });
    expect(claims.calls).toEqual([]);

    claims.result = binding("suspended");
    await expect(
      makeRequest({ repository, credentials: claims }).execute(requestInput()),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "gateway-challenge-ineligible" },
    });
    expect(repository.issueInput).toBeUndefined();

    claims.result = binding();
    repository.issueResult = { outcome: "rate-limited" };
    await expect(
      makeRequest({ repository, credentials: claims }).execute(requestInput()),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "gateway-challenge-rate-limited" },
    });
    repository.issueResult = { outcome: "request-conflict" };
    await expect(
      makeRequest({ repository, credentials: claims }).execute(requestInput()),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "gateway-challenge-request-conflict" },
    });
  });

  it("accepts an exact authenticated hello and passes only a fingerprint into atomic consumption", async () => {
    const repository = new StubChallengeRepository();
    const claims = new FixedClaims();
    const authenticator = new RecordingAuthenticator();
    const useCase = new AcceptGatewaySignedCloudLinkSession({
      repository,
      credentials: claims,
      authenticator,
      clock: new FixedClock(),
      sessionIds: { next: () => sessionId },
      supportedProtocolVersions: ["1.0"],
      enabled: true,
    });

    const result = await useCase.execute({
      ...requestInput(),
      originModel: "gateway-signed",
      challengeId,
      gatewayKeyId: "gateway-session-key-17",
      gatewayAuthentication: {
        keyId: "gateway-session-key-17",
        algorithm: "Ed25519",
        signature: "B".repeat(86),
      },
    });

    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        gatewayId,
        sessionId,
        credentialGeneration: "3",
        epoch: "1",
        state: "active",
        protocolVersion: "1.0",
      },
    });
    expect(authenticator.calls[0]).toMatchObject({
      gatewayId,
      credentialId: "development-binding-17",
      credentialGeneration: "3",
      gatewayKeyId: "gateway-session-key-17",
      challengeId,
      cloudNonce,
      clientNonce,
      offeredProtocolVersions: ["1.0"],
    });
    expect(repository.acceptInput).toMatchObject({
      challengeId,
      authenticationFingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      evaluationTimeMs: "1784275200000",
      sessionId,
      protocolVersion: "1.0",
    });
    expect(JSON.stringify(repository.acceptInput)).not.toContain(
      "BBBBBBBBBBBB",
    );
  });

  it("replays the original supported protocol after component restart changes Cloud preference order", async () => {
    const repository = new StubChallengeRepository();
    repository.found = {
      ...challengeRecord(),
      request: {
        ...challengeRecord().request,
        offeredProtocolVersions: [
          parseProtocolVersion("1.0"),
          parseProtocolVersion("1.1"),
        ],
      },
    };
    repository.acceptResult = {
      outcome: "replayed",
      session: activeSession("1.0"),
    };
    const useCase = new AcceptGatewaySignedCloudLinkSession({
      repository,
      credentials: new FixedClaims(),
      authenticator: new RecordingAuthenticator(),
      clock: new FixedClock(),
      sessionIds: { next: () => sessionId },
      supportedProtocolVersions: ["1.1", "1.0"],
      enabled: true,
    });

    await expect(
      useCase.execute({
        ...requestInput(),
        protocolVersions: ["1.0", "1.1"],
        originModel: "gateway-signed",
        challengeId,
        gatewayKeyId: "gateway-session-key-17",
        gatewayAuthentication: {
          keyId: "gateway-session-key-17",
          algorithm: "Ed25519",
          signature: "B".repeat(86),
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: {
        sessionId,
        protocolVersion: "1.0",
      },
    });
    expect(repository.acceptInput).toMatchObject({
      protocolVersion: "1.1",
    });
  });

  it("rejects expiry equality and request-state changes without authenticating or consuming", async () => {
    const repository = new StubChallengeRepository();
    repository.found = {
      ...challengeRecord(),
      expiresAtMs: "1784275200000",
    };
    const authenticator = new RecordingAuthenticator();
    const useCase = new AcceptGatewaySignedCloudLinkSession({
      repository,
      credentials: new FixedClaims(),
      authenticator,
      clock: new FixedClock(),
      sessionIds: { next: () => sessionId },
      supportedProtocolVersions: ["1.0"],
      enabled: true,
    });
    const hello = {
      ...requestInput(),
      originModel: "gateway-signed",
      challengeId,
      gatewayKeyId: "gateway-session-key-17",
      gatewayAuthentication: {
        keyId: "gateway-session-key-17",
        algorithm: "Ed25519",
        signature: "B".repeat(86),
      },
    };

    await expect(useCase.execute(hello)).resolves.toMatchObject({
      ok: false,
      failure: { code: "gateway-challenge-expired" },
    });
    expect(authenticator.calls).toEqual([]);
    expect(repository.acceptInput).toBeUndefined();

    repository.found = challengeRecord();
    await expect(
      useCase.execute({ ...hello, clientNonce: "Z".repeat(43) }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "gateway-hello-binding-mismatch" },
    });
    expect(authenticator.calls).toEqual([]);
    expect(repository.acceptInput).toBeUndefined();
  });

  it("does not consume a challenge when Gateway signature verification fails", async () => {
    const repository = new StubChallengeRepository();
    const authenticator = new RecordingAuthenticator();
    authenticator.fingerprint = undefined;
    const useCase = new AcceptGatewaySignedCloudLinkSession({
      repository,
      credentials: new FixedClaims(),
      authenticator,
      clock: new FixedClock(),
      sessionIds: { next: () => sessionId },
      supportedProtocolVersions: ["1.0"],
      enabled: true,
    });

    await expect(
      useCase.execute({
        ...requestInput(),
        originModel: "gateway-signed",
        challengeId,
        gatewayKeyId: "gateway-session-key-17",
        gatewayAuthentication: {
          keyId: "gateway-session-key-17",
          algorithm: "Ed25519",
          signature: "B".repeat(86),
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "gateway-hello-authentication-invalid" },
    });
    expect(repository.acceptInput).toBeUndefined();
  });
});
