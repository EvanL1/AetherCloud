import { describe, expect, it } from "vitest";

import {
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
} from "@aether-cloud/domain";

import { InMemoryCloudLinkSessionRepository } from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const sessionId = parseCloudLinkSessionId(
  "44444444-4444-4444-8444-444444444444",
);
const sessionEpoch = parseCloudLinkSessionEpoch("7");
const credentialGeneration = parseGatewayCredentialGeneration("3");
const firstDigest = `sha256:${"a".repeat(64)}`;
const secondDigest = `sha256:${"b".repeat(64)}`;

function common() {
  return {
    tenantId,
    projectId,
    gatewayId,
    sessionId,
    sessionEpoch,
    credentialGeneration,
  };
}

function heartbeat(
  observedAtMs = "1784275200000",
  exactSigningObjectDigest = firstDigest,
) {
  return { ...common(), observedAtMs, exactSigningObjectDigest };
}

describe("in-memory Gateway-signed uplink replay repository", () => {
  it("atomically advances one heartbeat and treats only its exact digest as replay", async () => {
    const repository = new InMemoryCloudLinkSessionRepository();

    const [left, right] = await Promise.all([
      repository.acceptHeartbeat(heartbeat()),
      repository.acceptHeartbeat(heartbeat()),
    ]);
    expect([left.outcome, right.outcome].sort()).toEqual([
      "accepted",
      "replayed",
    ]);
    await expect(
      repository.acceptHeartbeat(heartbeat("1784275200000", secondDigest)),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      repository.acceptHeartbeat(heartbeat("1784275199999", secondDigest)),
    ).resolves.toEqual({ outcome: "lower" });
    await expect(
      repository.acceptHeartbeat(heartbeat("1784275200001", secondDigest)),
    ).resolves.toEqual({ outcome: "accepted" });
  });

  it("isolates heartbeat replay state by tenant, project, gateway, and session", async () => {
    const repository = new InMemoryCloudLinkSessionRepository();
    await repository.acceptHeartbeat(heartbeat());

    await expect(
      repository.acceptHeartbeat({
        ...heartbeat("1784275200000", secondDigest),
        tenantId: parseTenantId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      }),
    ).resolves.toEqual({ outcome: "accepted" });
    await expect(
      repository.acceptHeartbeat({
        ...heartbeat("1784275200000", secondDigest),
        projectId: parseProjectId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      }),
    ).resolves.toEqual({ outcome: "accepted" });
    await expect(
      repository.acceptHeartbeat({
        ...heartbeat("1784275200000", secondDigest),
        gatewayId: parseGatewayId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      }),
    ).resolves.toEqual({ outcome: "accepted" });
    await expect(
      repository.acceptHeartbeat({
        ...heartbeat("1784275200000", secondDigest),
        sessionId: parseCloudLinkSessionId(
          "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        ),
      }),
    ).resolves.toEqual({ outcome: "accepted" });
  });

  it("retains replay state when an application component is reconstructed over the same repository", async () => {
    const repository = new InMemoryCloudLinkSessionRepository();
    await repository.acceptHeartbeat(heartbeat());

    const reconstructedComponentRepository = repository;
    await expect(
      reconstructedComponentRepository.acceptHeartbeat(heartbeat()),
    ).resolves.toEqual({ outcome: "replayed" });
  });
});
