import { describe, expect, it } from "vitest";

import type {
  ApplicationClock,
  CloudLinkSessionIdGenerator,
  OpenCloudLinkSessionRepositoryInput,
  GatewayCredentialAssertion,
} from "@aether-cloud/application";
import { OpenCloudLinkSession } from "@aether-cloud/application";
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
  type GatewayCredentialBinding,
} from "@aether-cloud/domain";

import {
  InMemoryCloudLinkSessionRepository,
  InMemoryGatewayCredentialVerifier,
} from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const binding: GatewayCredentialBinding = {
  tenantId,
  projectId,
  gatewayId,
  generation: parseGatewayCredentialGeneration("3"),
  status: "active",
};
const assertion: GatewayCredentialAssertion = {
  credentialId: "gateway-credential-003",
  proof: "opaque-test-proof-material",
};

function openInput(
  requestId: string,
  sessionId: string,
  protocolVersion = "1.0",
): OpenCloudLinkSessionRepositoryInput {
  return {
    binding,
    requestId,
    sessionId: parseCloudLinkSessionId(sessionId),
    protocolVersion: parseProtocolVersion(protocolVersion),
    openedAt: parseUtcInstant("2026-07-14T08:05:00.000Z"),
  };
}

describe("CloudLink in-memory adapters", () => {
  it("supports an application open replay without minting a second session", async () => {
    const verifier = new InMemoryGatewayCredentialVerifier([
      { assertion, binding },
    ]);
    const repository = new InMemoryCloudLinkSessionRepository();
    const generated = [
      parseCloudLinkSessionId("44444444-4444-4444-8444-444444444444"),
      parseCloudLinkSessionId("55555555-5555-4555-8555-555555555555"),
    ];
    const sessionIds: CloudLinkSessionIdGenerator = {
      next: () => {
        const next = generated.shift();
        if (next === undefined) throw new Error("session ID fixture exhausted");
        return next;
      },
    };
    const clock: ApplicationClock = {
      now: () => parseUtcInstant("2026-07-14T08:05:00.000Z"),
    };
    const useCase = new OpenCloudLinkSession({
      repository,
      credentialVerifier: verifier,
      sessionIds,
      clock,
      supportedProtocolVersions: ["1.0"],
    });
    const context = {
      idempotencyKey: "cloudlink-open-request-001",
      issuedAt: "2026-07-14T08:00:00.000Z",
      expiresAt: "2026-07-14T08:10:00.000Z",
    };
    const input = { credential: assertion, protocolVersions: ["1.0"] };

    const first = await useCase.execute(context, input);
    const replay = await useCase.execute(context, input);

    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      value: { sessionId: "44444444-4444-4444-8444-444444444444" },
    });
  });

  it("verifies configured credential proof without treating status as active", async () => {
    const verifier = new InMemoryGatewayCredentialVerifier([
      { assertion, binding },
      {
        assertion: {
          credentialId: "gateway-credential-suspended",
          proof: "other-opaque-test-proof",
        },
        binding: { ...binding, status: "suspended" },
      },
    ]);

    expect(await verifier.verify(assertion)).toEqual({
      ok: true,
      value: binding,
    });
    expect(
      await verifier.verify({
        ...assertion,
        proof: "incorrect-proof-material",
      }),
    ).toMatchObject({
      ok: false,
      failure: { code: "invalid-gateway-credential" },
    });
    expect(
      await verifier.verify({
        credentialId: "gateway-credential-suspended",
        proof: "other-opaque-test-proof",
      }),
    ).toMatchObject({ ok: true, value: { status: "suspended" } });
  });

  it("opens with server durable cursors and replays one request idempotently", async () => {
    const repository = new InMemoryCloudLinkSessionRepository();
    const firstInput = openInput(
      "cloudlink-open-request-001",
      "44444444-4444-4444-8444-444444444444",
    );
    await expect(
      repository.recordDurableCursor({
        binding,
        sessionId: firstInput.sessionId,
        sessionEpoch: parseCloudLinkSessionEpoch("1"),
        cursor: {
          streamId: parseStreamId("telemetry"),
          streamEpoch: parseStreamEpoch("4"),
          position: parseStreamPosition("42"),
        },
      }),
    ).resolves.toBe("not-found");
    await repository.open(firstInput);
    await expect(
      repository.recordDurableCursor({
        binding,
        sessionId: firstInput.sessionId,
        sessionEpoch: parseCloudLinkSessionEpoch("2"),
        cursor: {
          streamId: parseStreamId("telemetry"),
          streamEpoch: parseStreamEpoch("4"),
          position: parseStreamPosition("42"),
        },
      }),
    ).resolves.toBe("stale-session");
    await expect(
      repository.recordDurableCursor({
        binding,
        sessionId: firstInput.sessionId,
        sessionEpoch: parseCloudLinkSessionEpoch("1"),
        cursor: {
          streamId: parseStreamId("telemetry"),
          streamEpoch: parseStreamEpoch("4"),
          position: parseStreamPosition("42"),
        },
      }),
    ).resolves.toBe("recorded");
    await expect(
      repository.recordDurableCursor({
        binding,
        sessionId: firstInput.sessionId,
        sessionEpoch: parseCloudLinkSessionEpoch("1"),
        cursor: {
          streamId: parseStreamId("telemetry"),
          streamEpoch: parseStreamEpoch("4"),
          position: parseStreamPosition("42"),
        },
      }),
    ).resolves.toBe("replayed");
    const secondInput = openInput(
      "cloudlink-open-request-002",
      "55555555-5555-4555-8555-555555555555",
    );
    const second = await repository.open(secondInput);
    const replay = await repository.open({
      ...secondInput,
      sessionId: parseCloudLinkSessionId(
        "66666666-6666-4666-8666-666666666666",
      ),
    });

    expect(second).toMatchObject({
      outcome: "opened",
      session: {
        state: "active",
        epoch: "2",
        resumeCursors: [
          { streamId: "telemetry", streamEpoch: "4", position: "42" },
        ],
      },
    });
    expect(replay).toMatchObject({
      outcome: "replayed",
      session: {
        sessionId: second.outcome === "opened" ? second.session.sessionId : "",
      },
    });
  });

  it("rejects conflicting idempotency reuse", async () => {
    const repository = new InMemoryCloudLinkSessionRepository();
    await repository.open(
      openInput(
        "cloudlink-open-request-001",
        "44444444-4444-4444-8444-444444444444",
      ),
    );

    expect(
      await repository.open(
        openInput(
          "cloudlink-open-request-001",
          "55555555-5555-4555-8555-555555555555",
          "1.1",
        ),
      ),
    ).toEqual({ outcome: "idempotency-conflict" });
  });

  it("allocates a new epoch and fences the old session atomically", async () => {
    const repository = new InMemoryCloudLinkSessionRepository();
    const first = await repository.open(
      openInput(
        "cloudlink-open-request-001",
        "44444444-4444-4444-8444-444444444444",
      ),
    );
    const second = await repository.open(
      openInput(
        "cloudlink-open-request-002",
        "55555555-5555-4555-8555-555555555555",
      ),
    );
    if (first.outcome !== "opened" || second.outcome !== "opened") {
      throw new Error("test setup failed to open sessions");
    }
    const old = await repository.findById(binding, first.session.sessionId);

    expect(second).toMatchObject({
      outcome: "opened",
      fencedSessionId: first.session.sessionId,
      session: { epoch: "2", state: "active" },
    });
    expect(old).toMatchObject({ state: "closed", closeReason: "fenced" });
    expect(await repository.findCurrent(binding, gatewayId)).toEqual(
      second.session,
    );
  });

  it("does not disclose sessions through another credential binding", async () => {
    const repository = new InMemoryCloudLinkSessionRepository();
    const opened = await repository.open(
      openInput(
        "cloudlink-open-request-001",
        "44444444-4444-4444-8444-444444444444",
      ),
    );
    if (opened.outcome !== "opened") throw new Error("test open failed");

    expect(
      await repository.findById(
        { ...binding, generation: parseGatewayCredentialGeneration("4") },
        opened.session.sessionId,
      ),
    ).toBeUndefined();
  });
});
