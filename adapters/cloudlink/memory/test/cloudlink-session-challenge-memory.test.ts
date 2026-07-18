import { describe, expect, it } from "vitest";

import type {
  AcceptCloudLinkSessionChallengeRepositoryInput,
  CloudLinkSessionChallengeRecord,
  IssueCloudLinkSessionChallengeRepositoryInput,
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

import {
  InMemoryCloudLinkSessionRepository,
  InMemoryGatewayCredentialVerifier,
} from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const generation = parseGatewayCredentialGeneration("3");
const binding: GatewayCredentialBinding = {
  tenantId,
  projectId,
  gatewayId,
  generation,
  status: "active",
};

function challenge(
  id = "55555555-5555-4555-8555-555555555555",
  clientNonce = "A".repeat(43),
): CloudLinkSessionChallengeRecord {
  return {
    binding,
    request: {
      gatewayId,
      credentialId: "development-binding-17",
      credentialGeneration: generation,
      offeredProtocolVersions: [parseProtocolVersion("1.0")],
      clientNonce,
      resumeCursors: [
        {
          streamId: parseStreamId("telemetry"),
          streamEpoch: parseStreamEpoch("4"),
          position: parseStreamPosition("18"),
        },
      ],
    },
    challengeId: parseCloudLinkSessionChallengeId(id),
    cloudNonce: "C".repeat(43),
    issuedAtMs: "1784275200000",
    expiresAtMs: "1784275260000",
    cloudAuthentication: {
      keyId: "cloud-session-key-1",
      algorithm: "Ed25519",
      signature: "D".repeat(86),
    },
  };
}

function issueInput(
  candidate: CloudLinkSessionChallengeRecord = challenge(),
  evaluationTimeMs = "1784275200000",
): IssueCloudLinkSessionChallengeRepositoryInput {
  return {
    candidate,
    evaluationTimeMs,
    rateLimitWindowMs: 60_000,
    rateLimitMaximumRequests: 4,
  };
}

function reboundChallenge(
  id: string,
  credentialId: string,
  credentialGeneration: string,
  clientNonce: string,
): CloudLinkSessionChallengeRecord {
  const generation = parseGatewayCredentialGeneration(credentialGeneration);
  const candidate = challenge(id, clientNonce);
  return {
    ...candidate,
    binding: {
      ...candidate.binding,
      generation,
    },
    request: {
      ...candidate.request,
      credentialId,
      credentialGeneration: generation,
    },
  };
}

function acceptInput(
  authenticationFingerprint = `sha256:${"a".repeat(64)}`,
  sessionId = "66666666-6666-4666-8666-666666666666",
  evaluationTimeMs = "1784275200000",
): AcceptCloudLinkSessionChallengeRepositoryInput {
  return {
    binding,
    challengeId: challenge().challengeId,
    authenticationFingerprint,
    evaluationTimeMs,
    sessionId: parseCloudLinkSessionId(sessionId),
    protocolVersion: parseProtocolVersion("1.0"),
    openedAt: parseUtcInstant("2026-07-17T08:00:00.000Z"),
    gatewayKeyId: "gateway-session-key-17",
    heartbeatIntervalMs: "30000",
  };
}

describe("in-memory CloudLink session challenge repository", () => {
  it("atomically issues once and returns the exact persisted challenge across retry and component restart", async () => {
    const repository = new InMemoryCloudLinkSessionRepository();
    const candidate = challenge();

    const [left, right] = await Promise.all([
      repository.issue(issueInput(candidate)),
      repository.issue(
        issueInput({
          ...candidate,
          challengeId: parseCloudLinkSessionChallengeId(
            "77777777-7777-4777-8777-777777777777",
          ),
          cloudNonce: "Z".repeat(43),
          cloudAuthentication: {
            ...candidate.cloudAuthentication,
            signature: "E".repeat(86),
          },
        }),
      ),
    ]);

    expect([left.outcome, right.outcome].sort()).toEqual([
      "issued",
      "replayed",
    ]);
    if (!("challenge" in left) || !("challenge" in right)) {
      throw new Error("both exact retries must return a challenge");
    }
    expect(right.challenge).toEqual(left.challenge);
    expect(right.challenge).toBe(left.challenge);

    const restartedUseCaseRepository = repository;
    await expect(
      restartedUseCaseRepository.issue(
        issueInput({
          ...candidate,
          challengeId: parseCloudLinkSessionChallengeId(
            "88888888-8888-4888-8888-888888888888",
          ),
        }),
      ),
    ).resolves.toMatchObject({
      outcome: "replayed",
      challenge: left.challenge,
    });
  });

  it("rejects changed request state while unexpired and enforces an atomic bounded request limit", async () => {
    const repository = new InMemoryCloudLinkSessionRepository();
    await repository.issue(issueInput());
    await expect(
      repository.issue(
        issueInput(
          challenge("77777777-7777-4777-8777-777777777777", "Z".repeat(43)),
        ),
      ),
    ).resolves.toEqual({ outcome: "request-conflict" });

    await repository.issue(issueInput());
    await repository.issue(issueInput());
    await expect(repository.issue(issueInput())).resolves.toEqual({
      outcome: "rate-limited",
    });
    await expect(repository.issue(issueInput())).resolves.toEqual({
      outcome: "rate-limited",
    });
  });

  it("uses one pending challenge and one rate budget across credential claims for the same Gateway", async () => {
    const repository = new InMemoryCloudLinkSessionRepository();
    const first = {
      ...issueInput(),
      rateLimitMaximumRequests: 2,
    };
    const changedCredential = {
      ...issueInput(
        reboundChallenge(
          "77777777-7777-4777-8777-777777777777",
          "replacement-binding",
          "4",
          "Y".repeat(43),
        ),
      ),
      rateLimitMaximumRequests: 2,
    };
    const anotherGeneration = {
      ...issueInput(
        reboundChallenge(
          "88888888-8888-4888-8888-888888888888",
          "another-binding",
          "5",
          "Z".repeat(43),
        ),
      ),
      rateLimitMaximumRequests: 2,
    };

    await expect(repository.issue(first)).resolves.toMatchObject({
      outcome: "issued",
    });
    await expect(repository.issue(changedCredential)).resolves.toEqual({
      outcome: "request-conflict",
    });
    await expect(repository.issue(anotherGeneration)).resolves.toEqual({
      outcome: "rate-limited",
    });
  });

  it("resets the fixed Gateway request window exactly at its end boundary", async () => {
    const repository = new InMemoryCloudLinkSessionRepository();
    const limited = {
      ...issueInput(),
      rateLimitMaximumRequests: 2,
    };

    await expect(repository.issue(limited)).resolves.toMatchObject({
      outcome: "issued",
    });
    await expect(
      repository.issue({
        ...issueInput(challenge(), "1784275230000"),
        rateLimitMaximumRequests: 2,
      }),
    ).resolves.toMatchObject({ outcome: "replayed" });
    const nextWindow = {
      ...issueInput(
        {
          ...reboundChallenge(
            "88888888-8888-4888-8888-888888888888",
            "replacement-binding",
            "4",
            "Z".repeat(43),
          ),
          issuedAtMs: "1784275260000",
          expiresAtMs: "1784275320000",
        },
        "1784275260000",
      ),
      rateLimitMaximumRequests: 2,
    };
    await expect(repository.issue(nextWindow)).resolves.toMatchObject({
      outcome: "issued",
    });
    await expect(repository.issue(nextWindow)).resolves.toMatchObject({
      outcome: "replayed",
    });
  });

  it("atomically consumes once, fences the prior session, and makes identical concurrent hello replay idempotent", async () => {
    const repository = new InMemoryCloudLinkSessionRepository();
    await repository.issue(issueInput());

    const [left, right] = await Promise.all([
      repository.acceptAndOpen(acceptInput()),
      repository.acceptAndOpen(
        acceptInput(
          `sha256:${"a".repeat(64)}`,
          "77777777-7777-4777-8777-777777777777",
        ),
      ),
    ]);

    expect([left.outcome, right.outcome].sort()).toEqual([
      "opened",
      "replayed",
    ]);
    if (!("session" in left) || !("session" in right)) {
      throw new Error("same hello must return one accepted session");
    }
    expect(right.session.sessionId).toBe(left.session.sessionId);
    expect(left.session).toMatchObject({
      gatewayKeyId: "gateway-session-key-17",
      heartbeatIntervalMs: "30000",
    });
    await expect(
      repository.acceptAndOpen(acceptInput(`sha256:${"b".repeat(64)}`)),
    ).resolves.toEqual({ outcome: "consumed-conflict" });
  });

  it("replays an exact consumed challenge but permits a new request for the same active Gateway", async () => {
    const repository = new InMemoryCloudLinkSessionRepository();
    const firstChallenge = challenge();
    await repository.issue(issueInput(firstChallenge));
    await expect(
      repository.acceptAndOpen(acceptInput()),
    ).resolves.toMatchObject({ outcome: "opened" });

    await expect(
      repository.issue(
        issueInput({
          ...firstChallenge,
          challengeId: parseCloudLinkSessionChallengeId(
            "77777777-7777-4777-8777-777777777777",
          ),
          cloudNonce: "Y".repeat(43),
          cloudAuthentication: {
            ...firstChallenge.cloudAuthentication,
            signature: "E".repeat(86),
          },
        }),
      ),
    ).resolves.toMatchObject({
      outcome: "replayed",
      challenge: firstChallenge,
    });

    const nextChallenge = challenge(
      "88888888-8888-4888-8888-888888888888",
      "Z".repeat(43),
    );
    await expect(repository.issue(issueInput(nextChallenge))).resolves.toEqual({
      outcome: "issued",
      challenge: nextChallenge,
    });
    await expect(
      repository.acceptAndOpen({
        ...acceptInput(
          `sha256:${"b".repeat(64)}`,
          "99999999-9999-4999-8999-999999999999",
        ),
        challengeId: nextChallenge.challengeId,
      }),
    ).resolves.toMatchObject({
      outcome: "opened",
      session: {
        sessionId: "99999999-9999-4999-8999-999999999999",
        epoch: "2",
        state: "active",
      },
    });
  });

  it("does not consume at expiry equality or under a different binding", async () => {
    const repository = new InMemoryCloudLinkSessionRepository();
    await repository.issue(issueInput());

    await expect(
      repository.acceptAndOpen(
        acceptInput(
          `sha256:${"a".repeat(64)}`,
          "66666666-6666-4666-8666-666666666666",
          "1784275260000",
        ),
      ),
    ).resolves.toEqual({ outcome: "expired" });
    await expect(
      repository.acceptAndOpen({
        ...acceptInput(),
        binding: {
          ...binding,
          generation: parseGatewayCredentialGeneration("4"),
        },
      }),
    ).resolves.toEqual({ outcome: "binding-conflict" });
    await expect(
      repository.acceptAndOpen(acceptInput()),
    ).resolves.toMatchObject({
      outcome: "opened",
    });
  });

  it("resolves only exact commissioned Gateway credential claims without treating them as proof", async () => {
    const credentials = new InMemoryGatewayCredentialVerifier([
      {
        assertion: {
          credentialId: "development-binding-17",
          proof: "secret-proof",
        },
        binding,
      },
    ]);

    await expect(
      credentials.resolveClaim({
        gatewayId,
        credentialId: "development-binding-17",
        generation,
      }),
    ).resolves.toEqual(binding);
    await expect(
      credentials.resolveClaim({
        gatewayId,
        credentialId: "development-binding-17",
        generation: parseGatewayCredentialGeneration("4"),
      }),
    ).resolves.toBeUndefined();
  });
});
