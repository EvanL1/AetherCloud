import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import { InMemoryCloudLinkSessionRepository } from "../../../adapters/cloudlink/memory/src/index.js";
import {
  parseCloudLinkSessionId,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "../../../packages/domain/src/index.js";
import {
  CloudLinkMqttApplicationBridge,
  type CloudLinkApplicationCommand,
} from "../src/index.js";
import {
  CLOUDLINK_DUAL_CLOUD_KEY_ID,
  CLOUDLINK_DUAL_CREDENTIAL_GENERATION,
  CLOUDLINK_DUAL_CREDENTIAL_ID,
  createCloudLinkDualSessionComposition,
} from "../../../scripts/cloudlink-dual-session-composition.js";
import {
  createGatewaySessionChallengeRequest,
  createGatewaySignedSessionHello,
  decodeCloudSessionDownlink,
  evaluateCloudSessionChallenge,
} from "../../../scripts/home-assistant-e2e-gateway-session.js";

const topicPrefix = "aether-dual/composition-test";
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const commissionedGatewayKeyId = `ed25519:${"a".repeat(64)}`;

class FixedClock {
  now() {
    return parseUtcInstant("2024-07-14T23:33:20.400Z");
  }

  nowMilliseconds(): string {
    return "1721000000400";
  }
}

class FixedSessionIds {
  next() {
    return parseCloudLinkSessionId("44444444-4444-4444-8444-444444444444");
  }
}

class UnusedCommand implements CloudLinkApplicationCommand {
  execute(): Promise<unknown> {
    return Promise.resolve({
      ok: false,
      failure: { code: "unused", message: "unused in session test" },
    });
  }
}

function ed25519PrivateKeyFromSeed(seedByte: number): KeyObject {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({
    key: Buffer.concat([prefix, Buffer.alloc(32, seedByte)]),
    format: "der",
    type: "pkcs8",
  });
}

describe("CloudLink dual worker Gateway-signed session composition", () => {
  it("issues an Edge-verifiable challenge and accepts only the commissioned Gateway key", async () => {
    const sessions = new InMemoryCloudLinkSessionRepository();
    const composition = createCloudLinkDualSessionComposition({
      sessions,
      clock: new FixedClock(),
      sessionIds: new FixedSessionIds(),
      tenantId,
      projectId,
      gatewayId,
      gatewayKeyId: commissionedGatewayKeyId,
      gatewayPublicKey: createPublicKey(ed25519PrivateKeyFromSeed(11)),
    });
    await expect(
      composition.sessionCommands.authenticateGatewaySignedUplink.execute({}),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "INVALID_INPUT" },
    });
    const publications: Array<{
      readonly topic: string;
      readonly payload: Uint8Array;
    }> = [];
    const unused = new UnusedCommand();
    const bridge = new CloudLinkMqttApplicationBridge({
      topicPrefix,
      publisher: {
        publish(topic, payload) {
          publications.push({ topic, payload });
          return Promise.resolve();
        },
      },
      ...composition.sessionCommands,
      openSession: unused,
      heartbeat: unused,
      reportManifest: unused,
      ingestTelemetry: unused,
      clock: new FixedClock(),
    });
    const request = createGatewaySessionChallengeRequest({
      topicPrefix,
      gatewayId,
      credentialId: CLOUDLINK_DUAL_CREDENTIAL_ID,
      credentialGeneration: CLOUDLINK_DUAL_CREDENTIAL_GENERATION,
      clientNonce: "A".repeat(43),
    });

    await expect(bridge.handle(request)).resolves.toEqual({
      outcome: "acknowledged",
    });
    expect(publications).toHaveLength(1);
    const challengePublication = publications[0];
    if (challengePublication === undefined) {
      throw new Error("challenge publication is missing");
    }
    const challenge = decodeCloudSessionDownlink({
      topicPrefix,
      gatewayId,
      ...challengePublication,
    });
    expect(challenge.message_kind).toBe("session-challenge");
    if (challenge.message_kind !== "session-challenge") {
      throw new Error("expected a session challenge");
    }
    expect(challenge.cloud_signature.key_id).toBe(CLOUDLINK_DUAL_CLOUD_KEY_ID);
    expect(
      evaluateCloudSessionChallenge(
        challenge,
        createPublicKey(ed25519PrivateKeyFromSeed(7)),
        1_721_000_000_401n,
      ),
    ).toBe("valid");

    const invalidHello = createGatewaySignedSessionHello({
      topicPrefix,
      request: request.message,
      challenge,
      gatewayKeyId: commissionedGatewayKeyId,
      privateKey: ed25519PrivateKeyFromSeed(8),
    });
    await expect(bridge.handle(invalidHello)).resolves.toMatchObject({
      outcome: "discarded",
      failure: { code: "gateway-hello-authentication-invalid" },
    });
    expect(publications).toHaveLength(1);

    const hello = createGatewaySignedSessionHello({
      topicPrefix,
      request: request.message,
      challenge,
      gatewayKeyId: commissionedGatewayKeyId,
      privateKey: ed25519PrivateKeyFromSeed(11),
    });
    await expect(bridge.handle(hello)).resolves.toEqual({
      outcome: "acknowledged",
    });
    expect(publications).toHaveLength(2);
    const acceptedPublication = publications[1];
    if (acceptedPublication === undefined) {
      throw new Error("session acceptance publication is missing");
    }
    const accepted = decodeCloudSessionDownlink({
      topicPrefix,
      gatewayId,
      ...acceptedPublication,
    });
    expect(accepted).toMatchObject({
      message_kind: "session-accepted",
      gateway_id: gatewayId,
      credential_generation: CLOUDLINK_DUAL_CREDENTIAL_GENERATION,
      session_id: "44444444-4444-4444-8444-444444444444",
    });
  });
});
