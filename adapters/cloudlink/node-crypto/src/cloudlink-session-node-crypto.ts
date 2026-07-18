import {
  KeyObject,
  createHash,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";

import type {
  CloudLinkGatewayHelloAuthenticationInput,
  CloudLinkGatewayHelloAuthenticator,
  CloudLinkBusinessPayloadDigestor,
  CloudLinkSessionChallengeMaterialGenerator,
  CloudLinkSessionChallengeSigner,
  CloudLinkSessionChallengeSigningProjection,
  CloudLinkUplinkCryptographicVerification,
  CloudLinkUplinkCryptographicVerifier,
  CloudLinkUplinkCryptographicVerifierInput,
  CloudLinkUplinkSigningProjection,
} from "@aether-cloud/application";
import {
  parseCloudLinkSessionChallengeId,
  type CloudLinkSessionChallengeId,
  type GatewayCredentialGeneration,
  type GatewayId,
  type ProjectId,
  type TenantId,
} from "@aether-cloud/domain";

const keyReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uint64Pattern = /^(?:0|[1-9][0-9]*)$/;
const maximumUint64 = 18_446_744_073_709_551_615n;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const uplinkProjectionKeys = Object.freeze([
  "schema",
  "gateway_id",
  "credential_generation",
  "session_id",
  "session_epoch",
  "message_kind",
  "sent_at_ms",
  "expires_at_ms",
  "stream_id",
  "stream_epoch",
  "position",
  "batch_id",
  "business_digest",
]);

type JsonRecord = Record<string, unknown>;

function isRecord(input: unknown): input is JsonRecord {
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
  throw new TypeError("CloudLink canonical JSON input is invalid");
}

function canonicalBytes(input: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(input));
}

export class NodeCloudLinkBusinessPayloadDigestor implements CloudLinkBusinessPayloadDigestor {
  digest(input: {
    readonly protocolVersion: "1.0";
    readonly messageKind: string;
    readonly payload: unknown;
  }): Promise<string> {
    return Promise.resolve(
      `sha256:${createHash("sha256")
        .update(
          canonicalJson({
            protocol_version: input.protocolVersion,
            message_kind: input.messageKind,
            payload: input.payload,
          }),
        )
        .digest("hex")}`,
    );
  }
}

function assertEd25519Key(
  key: KeyObject,
  expectedType: "private" | "public",
): void {
  if (
    !(key instanceof KeyObject) ||
    key.type !== expectedType ||
    key.asymmetricKeyType !== "ed25519"
  ) {
    throw new TypeError(
      `CloudLink session authentication requires an Ed25519 ${expectedType} KeyObject`,
    );
  }
}

export class NodeCloudLinkSessionChallengeMaterialGenerator implements CloudLinkSessionChallengeMaterialGenerator {
  nextChallengeId(): CloudLinkSessionChallengeId {
    return parseCloudLinkSessionChallengeId(randomUUID());
  }

  nextNonce(): string {
    return randomBytes(32).toString("base64url");
  }
}

export class NodeEd25519CloudLinkSessionChallengeSigner implements CloudLinkSessionChallengeSigner {
  readonly #keyReference: string;
  readonly #privateKey: KeyObject;

  constructor(input: {
    readonly keyReference: string;
    readonly privateKey: KeyObject;
  }) {
    if (!keyReferencePattern.test(input.keyReference)) {
      throw new TypeError(
        "CloudLink challenge signing key reference is invalid",
      );
    }
    assertEd25519Key(input.privateKey, "private");
    this.#keyReference = input.keyReference;
    this.#privateKey = input.privateKey;
  }

  sign(projection: CloudLinkSessionChallengeSigningProjection): Promise<{
    readonly keyId: string;
    readonly algorithm: "Ed25519";
    readonly signature: string;
  }> {
    const signature = sign(
      null,
      canonicalBytes(projection),
      this.#privateKey,
    ).toString("base64url");
    if (!signaturePattern.test(signature)) {
      throw new TypeError(
        "CloudLink challenge signer returned a non-canonical signature",
      );
    }
    return Promise.resolve(
      Object.freeze({
        keyId: this.#keyReference,
        algorithm: "Ed25519",
        signature,
      }),
    );
  }
}

export interface CloudLinkGatewayPublicKeyLookup {
  readonly gatewayId: GatewayId;
  readonly credentialId: string;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly gatewayKeyId: string;
}

export interface CloudLinkGatewayPublicKeyResolver {
  resolvePublicKey(
    input: CloudLinkGatewayPublicKeyLookup,
  ): Promise<KeyObject | undefined>;
}

function helloSigningProjection(
  input: CloudLinkGatewayHelloAuthenticationInput,
): JsonRecord {
  return {
    schema: "aether.cloudlink.session-establishment-signing.v1alpha1",
    gateway_id: input.gatewayId,
    credential_id: input.credentialId,
    credential_generation: input.credentialGeneration,
    gateway_key_id: input.gatewayKeyId,
    challenge_id: input.challengeId,
    cloud_nonce: input.cloudNonce,
    client_nonce: input.clientNonce,
    offered_protocol_versions: input.offeredProtocolVersions,
    resume: input.resumeCursors.map((cursor) => ({
      stream_id: cursor.streamId,
      stream_epoch: cursor.streamEpoch,
      acknowledged_position: cursor.position,
    })),
  };
}

export class NodeEd25519CloudLinkGatewayHelloAuthenticator implements CloudLinkGatewayHelloAuthenticator {
  readonly #resolver: CloudLinkGatewayPublicKeyResolver;

  constructor(resolver: CloudLinkGatewayPublicKeyResolver) {
    this.#resolver = resolver;
  }

  async verify(
    input: CloudLinkGatewayHelloAuthenticationInput,
  ): Promise<string | undefined> {
    if (
      input.gatewayAuthentication.keyId !== input.gatewayKeyId ||
      !keyReferencePattern.test(input.gatewayKeyId) ||
      !signaturePattern.test(input.gatewayAuthentication.signature)
    ) {
      return undefined;
    }
    try {
      const publicKey = await this.#resolver.resolvePublicKey({
        gatewayId: input.gatewayId,
        credentialId: input.credentialId,
        credentialGeneration: input.credentialGeneration,
        gatewayKeyId: input.gatewayKeyId,
      });
      if (publicKey === undefined) return undefined;
      assertEd25519Key(publicKey, "public");
      const signingBytes = canonicalBytes(helloSigningProjection(input));
      const signature = Buffer.from(
        input.gatewayAuthentication.signature,
        "base64url",
      );
      if (
        signature.length !== 64 ||
        signature.toString("base64url") !==
          input.gatewayAuthentication.signature
      ) {
        return undefined;
      }
      if (!verify(null, signingBytes, publicKey, signature)) return undefined;
      return `sha256:${createHash("sha256")
        .update(signingBytes)
        .update(Uint8Array.of(0))
        .update(signature)
        .digest("hex")}`;
    } catch {
      return undefined;
    }
  }
}

export interface CloudLinkUplinkGatewayPublicKeyLookup {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly gatewayKeyId: string;
}

export interface CloudLinkUplinkGatewayPublicKey {
  readonly status: "active" | "inactive";
  readonly publicKey: KeyObject;
}

export interface CloudLinkUplinkGatewayPublicKeyResolver {
  resolvePublicKey(
    input: CloudLinkUplinkGatewayPublicKeyLookup,
  ): Promise<CloudLinkUplinkGatewayPublicKey | undefined>;
}

function isCanonicalUint64(input: unknown, positive = false): input is string {
  return (
    typeof input === "string" &&
    uint64Pattern.test(input) &&
    BigInt(input) <= maximumUint64 &&
    (!positive || input !== "0")
  );
}

function isBoundedIdentifier(input: unknown): input is string {
  return typeof input === "string" && keyReferencePattern.test(input);
}

function usesEd25519(input: unknown): boolean {
  return isRecord(input) && input.algorithm === "Ed25519";
}

function hasExactUplinkProjection(
  input: unknown,
): input is CloudLinkUplinkSigningProjection {
  if (!isRecord(input)) return false;
  const actualKeys = Object.keys(input).sort();
  const expectedKeys = [...uplinkProjectionKeys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return false;
  }
  if (
    input.schema !== "aether.cloudlink.uplink-signing.v1alpha1" ||
    typeof input.gateway_id !== "string" ||
    !uuidPattern.test(input.gateway_id) ||
    typeof input.session_id !== "string" ||
    !uuidPattern.test(input.session_id) ||
    !isCanonicalUint64(input.credential_generation, true) ||
    !isCanonicalUint64(input.session_epoch, true) ||
    typeof input.message_kind !== "string" ||
    input.message_kind.length === 0 ||
    input.message_kind.length > 128 ||
    !isCanonicalUint64(input.sent_at_ms) ||
    !(input.expires_at_ms === null || isCanonicalUint64(input.expires_at_ms))
  ) {
    return false;
  }
  if (input.message_kind === "heartbeat") {
    return (
      input.expires_at_ms === null &&
      input.stream_id === null &&
      input.stream_epoch === null &&
      input.position === null &&
      input.batch_id === null &&
      input.business_digest === null
    );
  }
  return (
    isBoundedIdentifier(input.stream_id) &&
    isCanonicalUint64(input.stream_epoch, true) &&
    isCanonicalUint64(input.position, true) &&
    isBoundedIdentifier(input.batch_id) &&
    typeof input.business_digest === "string" &&
    digestPattern.test(input.business_digest)
  );
}

export class NodeEd25519CloudLinkUplinkVerifier implements CloudLinkUplinkCryptographicVerifier {
  readonly #resolver: CloudLinkUplinkGatewayPublicKeyResolver;

  constructor(resolver: CloudLinkUplinkGatewayPublicKeyResolver) {
    this.#resolver = resolver;
  }

  async verify(
    input: CloudLinkUplinkCryptographicVerifierInput,
  ): Promise<CloudLinkUplinkCryptographicVerification | undefined> {
    if (
      !usesEd25519(input.authentication) ||
      input.authentication.keyId !== input.gatewayKeyId ||
      !keyReferencePattern.test(input.gatewayKeyId) ||
      !signaturePattern.test(input.authentication.signature) ||
      !hasExactUplinkProjection(input.projection) ||
      input.projection.gateway_id !== input.gatewayId ||
      input.projection.credential_generation !== input.credentialGeneration
    ) {
      return undefined;
    }
    const signature = Buffer.from(input.authentication.signature, "base64url");
    if (
      signature.length !== 64 ||
      signature.toString("base64url") !== input.authentication.signature
    ) {
      return undefined;
    }
    try {
      const resolved = await this.#resolver.resolvePublicKey({
        tenantId: input.tenantId,
        projectId: input.projectId,
        gatewayId: input.gatewayId,
        credentialGeneration: input.credentialGeneration,
        gatewayKeyId: input.gatewayKeyId,
      });
      if (resolved === undefined || resolved.status !== "active") {
        return Object.freeze({
          gatewayKeyActive: false,
          signatureVerified: false,
        });
      }
      assertEd25519Key(resolved.publicKey, "public");
      const signingBytes = canonicalBytes(input.projection);
      const signatureVerified = verify(
        null,
        signingBytes,
        resolved.publicKey,
        signature,
      );
      return Object.freeze({
        gatewayKeyActive: true,
        signatureVerified,
        ...(signatureVerified
          ? {
              signingObjectDigest: `sha256:${createHash("sha256")
                .update(signingBytes)
                .digest("hex")}`,
            }
          : {}),
      });
    } catch {
      return undefined;
    }
  }
}
