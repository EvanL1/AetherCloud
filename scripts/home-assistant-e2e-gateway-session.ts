import {
  KeyObject,
  sign,
  verify,
  type KeyObject as NodeKeyObject,
} from "node:crypto";

import {
  decodeCloudLinkContractMessage,
  decodeCloudLinkMqttInbound,
  type CloudLinkSessionAccepted,
  type CloudLinkSessionChallenge,
  type CloudLinkSessionChallengeRequest,
  type CloudLinkSessionHello,
} from "../adapters/cloudlink/mqtt/src/index.js";

const protocolVersion = "1.0";
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;

type CloudSessionDownlink =
  | CloudLinkSessionAccepted
  | CloudLinkSessionChallenge;

type GatewaySignedSessionHello = CloudLinkSessionHello &
  Readonly<{
    gateway_key_id: string;
    gateway_signature: Readonly<{
      key_id: string;
      algorithm: "Ed25519";
      signature: string;
    }>;
  }>;

export interface EncodedGatewaySessionMessage<
  Message extends CloudLinkSessionChallengeRequest | GatewaySignedSessionHello,
> {
  readonly topic: string;
  readonly payload: Uint8Array;
  readonly message: Message;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function canonicalJson(input: unknown): string {
  if (
    input === null ||
    typeof input === "boolean" ||
    typeof input === "string"
  ) {
    return JSON.stringify(input);
  }
  if (typeof input === "number" && Number.isFinite(input)) {
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    return `[${input.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(input)) {
    return `{${Object.keys(input)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Gateway session canonical JSON input is invalid");
}

function canonicalBytes(input: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(input));
}

function assertEd25519Key(
  key: NodeKeyObject,
  expectedType: "private" | "public",
): void {
  if (
    !(key instanceof KeyObject) ||
    key.type !== expectedType ||
    key.asymmetricKeyType !== "ed25519"
  ) {
    throw new TypeError(
      `Gateway session authentication requires an Ed25519 ${expectedType} key`,
    );
  }
}

function sessionUplinkTopic(topicPrefix: string, gatewayId: string): string {
  return `${topicPrefix}/v1/gateways/${gatewayId}/up/session`;
}

function encodeValidatedSessionUplink<
  Message extends CloudLinkSessionChallengeRequest | GatewaySignedSessionHello,
>(
  topicPrefix: string,
  message: Message,
): EncodedGatewaySessionMessage<Message> {
  const topic = sessionUplinkTopic(topicPrefix, message.gateway_id);
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const decoded = decodeCloudLinkMqttInbound(topic, payload, { topicPrefix });
  if (
    !decoded.ok ||
    decoded.value.message_kind !== message.message_kind ||
    decoded.value.gateway_id !== message.gateway_id
  ) {
    throw new TypeError("Gateway session message failed the CloudLink codec");
  }
  return Object.freeze({
    topic,
    payload,
    message: Object.freeze(message),
  });
}

export function createGatewaySessionChallengeRequest(input: {
  readonly topicPrefix: string;
  readonly gatewayId: string;
  readonly credentialId: string;
  readonly credentialGeneration: string;
  readonly clientNonce: string;
}): EncodedGatewaySessionMessage<CloudLinkSessionChallengeRequest> {
  return encodeValidatedSessionUplink(input.topicPrefix, {
    schema: "aether.cloudlink.session-challenge-request.v1",
    protocol: "aether.cloudlink",
    message_kind: "session-challenge-request",
    gateway_id: input.gatewayId,
    credential_binding: {
      credential_id: input.credentialId,
      generation: input.credentialGeneration,
    },
    offered_protocol_versions: [protocolVersion],
    client_nonce: input.clientNonce,
    resume: [],
  });
}

function gatewayHelloSigningProjection(
  request: CloudLinkSessionChallengeRequest,
  challenge: CloudLinkSessionChallenge,
  gatewayKeyId: string,
): Record<string, unknown> {
  return {
    schema: "aether.cloudlink.session-establishment-signing.v1alpha1",
    gateway_id: request.gateway_id,
    credential_id: request.credential_binding.credential_id,
    credential_generation: request.credential_binding.generation,
    gateway_key_id: gatewayKeyId,
    challenge_id: challenge.challenge_id,
    cloud_nonce: challenge.cloud_nonce,
    client_nonce: request.client_nonce,
    offered_protocol_versions: request.offered_protocol_versions,
    resume: request.resume,
  };
}

export function createGatewaySignedSessionHello(input: {
  readonly topicPrefix: string;
  readonly request: CloudLinkSessionChallengeRequest;
  readonly challenge: CloudLinkSessionChallenge;
  readonly gatewayKeyId: string;
  readonly privateKey: NodeKeyObject;
}): EncodedGatewaySessionMessage<GatewaySignedSessionHello> {
  if (input.request.gateway_id !== input.challenge.gateway_id) {
    throw new TypeError("Gateway session challenge scope changed");
  }
  assertEd25519Key(input.privateKey, "private");
  const signature = sign(
    null,
    canonicalBytes(
      gatewayHelloSigningProjection(
        input.request,
        input.challenge,
        input.gatewayKeyId,
      ),
    ),
    input.privateKey,
  ).toString("base64url");
  if (!signaturePattern.test(signature)) {
    throw new TypeError("Gateway session signature is not canonical");
  }
  return encodeValidatedSessionUplink(input.topicPrefix, {
    schema: "aether.cloudlink.session-hello.v1",
    protocol: "aether.cloudlink",
    message_kind: "session-hello",
    gateway_id: input.request.gateway_id,
    credential_binding: {
      credential_id: input.request.credential_binding.credential_id,
      generation: input.request.credential_binding.generation,
      origin_model: "gateway-signed",
    },
    challenge_id: input.challenge.challenge_id,
    gateway_key_id: input.gatewayKeyId,
    gateway_signature: {
      key_id: input.gatewayKeyId,
      algorithm: "Ed25519",
      signature,
    },
    offered_protocol_versions: input.request.offered_protocol_versions,
    client_nonce: input.request.client_nonce,
    resume: input.request.resume,
  });
}

export function decodeCloudSessionDownlink(input: {
  readonly topicPrefix: string;
  readonly gatewayId: string;
  readonly topic: string;
  readonly payload: Uint8Array;
}): CloudSessionDownlink {
  const expectedTopic = `${input.topicPrefix}/v1/gateways/${input.gatewayId}/down/session`;
  if (input.topic !== expectedTopic) {
    throw new TypeError("Cloud session downlink arrived on the wrong topic");
  }
  const decoded = decodeCloudLinkContractMessage(input.payload);
  if (
    !decoded.ok ||
    (decoded.value.message_kind !== "session-challenge" &&
      decoded.value.message_kind !== "session-accepted") ||
    decoded.value.gateway_id !== input.gatewayId
  ) {
    throw new TypeError("Cloud session downlink failed the CloudLink codec");
  }
  return decoded.value;
}

export type CloudSessionChallengeEvaluation =
  | "expired"
  | "invalid-signature"
  | "not-yet-valid"
  | "valid";

export function evaluateCloudSessionChallenge(
  challenge: CloudLinkSessionChallenge,
  publicKey: NodeKeyObject,
  evaluationTimeMs: bigint,
): CloudSessionChallengeEvaluation {
  assertEd25519Key(publicKey, "public");
  const encodedSignature = challenge.cloud_signature.signature;
  if (!signaturePattern.test(encodedSignature)) return "invalid-signature";
  const signature = Buffer.from(encodedSignature, "base64url");
  if (
    signature.length !== 64 ||
    signature.toString("base64url") !== encodedSignature
  ) {
    return "invalid-signature";
  }
  const projection = {
    schema: "aether.cloudlink.session-challenge-signing.v1alpha1",
    gateway_id: challenge.gateway_id,
    challenge_id: challenge.challenge_id,
    cloud_nonce: challenge.cloud_nonce,
    issued_at_ms: challenge.issued_at_ms,
    expires_at_ms: challenge.expires_at_ms,
  };
  if (!verify(null, canonicalBytes(projection), publicKey, signature)) {
    return "invalid-signature";
  }
  const issuedAtMs = BigInt(challenge.issued_at_ms);
  const expiresAtMs = BigInt(challenge.expires_at_ms);
  if (evaluationTimeMs < issuedAtMs) return "not-yet-valid";
  if (evaluationTimeMs >= expiresAtMs) return "expired";
  return "valid";
}
