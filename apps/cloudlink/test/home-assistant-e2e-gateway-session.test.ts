import { generateKeyPairSync, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  NodeEd25519CloudLinkGatewayHelloAuthenticator,
  NodeEd25519CloudLinkSessionChallengeSigner,
} from "../../../adapters/cloudlink/node-crypto/src/index.js";
import {
  parseCloudLinkSessionChallengeId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProtocolVersion,
} from "../../../packages/domain/src/index.js";
import {
  createGatewaySessionChallengeRequest,
  createGatewaySignedSessionHello,
  decodeCloudSessionDownlink,
  evaluateCloudSessionChallenge,
} from "../../../scripts/home-assistant-e2e-gateway-session.js";

const topicPrefix = "aether-ha-e2e/test-run";
const gatewayId = "33333333-3333-4333-8333-333333333333";
const parsedGatewayId = parseGatewayId(gatewayId);
const clientNonce = "A".repeat(43);

describe("Home Assistant E2E Gateway-signed session client", () => {
  it("uses the formal codec and produces a verifiable Gateway hello without credential proof", async () => {
    const gatewayKeys = generateKeyPairSync("ed25519");
    const request = createGatewaySessionChallengeRequest({
      topicPrefix,
      gatewayId,
      credentialId: "development-binding-17",
      credentialGeneration: "3",
      clientNonce,
    });
    const challenge = {
      schema: "aether.cloudlink.session-challenge.v1" as const,
      protocol: "aether.cloudlink" as const,
      message_kind: "session-challenge" as const,
      gateway_id: gatewayId,
      challenge_id: "55555555-5555-4555-8555-555555555555",
      cloud_nonce: "C".repeat(43),
      issued_at_ms: "1784275200000",
      expires_at_ms: "1784275260000",
      cloud_signature: {
        key_id: "cloud-session-key-1",
        algorithm: "Ed25519" as const,
        signature: "D".repeat(86),
      },
    };

    const first = createGatewaySignedSessionHello({
      topicPrefix,
      request: request.message,
      challenge,
      gatewayKeyId: "gateway-session-key-17",
      privateKey: gatewayKeys.privateKey,
    });
    const retry = createGatewaySignedSessionHello({
      topicPrefix,
      request: request.message,
      challenge,
      gatewayKeyId: "gateway-session-key-17",
      privateKey: gatewayKeys.privateKey,
    });

    expect(retry.payload).toEqual(first.payload);
    expect(first.message.credential_binding).toEqual({
      credential_id: "development-binding-17",
      generation: "3",
      origin_model: "gateway-signed",
    });
    expect(first.message).not.toHaveProperty("credential");
    expect(first.message).not.toHaveProperty("proof");

    const authenticator = new NodeEd25519CloudLinkGatewayHelloAuthenticator({
      resolvePublicKey: () => Promise.resolve(gatewayKeys.publicKey),
    });
    await expect(
      authenticator.verify({
        gatewayId: parsedGatewayId,
        credentialId: "development-binding-17",
        credentialGeneration: parseGatewayCredentialGeneration("3"),
        gatewayKeyId: "gateway-session-key-17",
        challengeId: parseCloudLinkSessionChallengeId(challenge.challenge_id),
        cloudNonce: challenge.cloud_nonce,
        clientNonce,
        offeredProtocolVersions: [parseProtocolVersion("1.0")],
        resumeCursors: [],
        gatewayAuthentication: {
          keyId: first.message.gateway_signature.key_id,
          algorithm: first.message.gateway_signature.algorithm,
          signature: first.message.gateway_signature.signature,
        },
      }),
    ).resolves.toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("accepts only the configured Cloud key and treats equality with expiry as expired", async () => {
    const cloudKeys = generateKeyPairSync("ed25519");
    const wrongCloudKeys = generateKeyPairSync("ed25519");
    const challenge = decodeCloudSessionDownlink({
      topicPrefix,
      gatewayId,
      topic: `${topicPrefix}/v1/gateways/${gatewayId}/down/session`,
      payload: await signedChallengePayload(cloudKeys.privateKey),
    });
    expect(challenge.message_kind).toBe("session-challenge");
    if (challenge.message_kind !== "session-challenge") {
      throw new Error("expected a session challenge");
    }

    expect(
      evaluateCloudSessionChallenge(
        challenge,
        cloudKeys.publicKey,
        1_784_275_200_100n,
      ),
    ).toBe("valid");
    expect(
      evaluateCloudSessionChallenge(
        challenge,
        wrongCloudKeys.publicKey,
        1_784_275_200_100n,
      ),
    ).toBe("invalid-signature");
    expect(
      evaluateCloudSessionChallenge(
        challenge,
        cloudKeys.publicKey,
        1_784_275_260_000n,
      ),
    ).toBe("expired");
  });
});

async function signedChallengePayload(
  privateKey: KeyObject,
): Promise<Uint8Array> {
  const projection = {
    schema: "aether.cloudlink.session-challenge-signing.v1alpha1" as const,
    gateway_id: parsedGatewayId,
    challenge_id: parseCloudLinkSessionChallengeId(
      "55555555-5555-4555-8555-555555555555",
    ),
    cloud_nonce: "C".repeat(43),
    issued_at_ms: "1784275200000",
    expires_at_ms: "1784275260000",
  };
  const authentication = await new NodeEd25519CloudLinkSessionChallengeSigner({
    keyReference: "cloud-session-key-1",
    privateKey,
  }).sign(projection);
  return new TextEncoder().encode(
    JSON.stringify({
      schema: "aether.cloudlink.session-challenge.v1",
      protocol: "aether.cloudlink",
      message_kind: "session-challenge",
      gateway_id: gatewayId,
      challenge_id: projection.challenge_id,
      cloud_nonce: projection.cloud_nonce,
      issued_at_ms: projection.issued_at_ms,
      expires_at_ms: projection.expires_at_ms,
      cloud_signature: {
        key_id: authentication.keyId,
        algorithm: authentication.algorithm,
        signature: authentication.signature,
      },
    }),
  );
}
