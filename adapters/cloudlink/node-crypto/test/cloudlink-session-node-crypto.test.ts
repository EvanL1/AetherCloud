import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

import type {
  CloudLinkGatewayHelloAuthenticationInput,
  CloudLinkSessionChallengeSigningProjection,
  CloudLinkUplinkCryptographicVerifierInput,
  CloudLinkUplinkSigningProjection,
} from "@aether-cloud/application";
import {
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
} from "@aether-cloud/domain";
import { describe, expect, it } from "vitest";

import {
  NodeCloudLinkBusinessPayloadDigestor,
  NodeCloudLinkSessionChallengeMaterialGenerator,
  NodeEd25519CloudLinkGatewayHelloAuthenticator,
  NodeEd25519CloudLinkSessionChallengeSigner,
  NodeEd25519CloudLinkUplinkVerifier,
} from "../src/index.js";

const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const challengeId = parseCloudLinkSessionChallengeId(
  "55555555-5555-4555-8555-555555555555",
);

function canonicalJson(input: unknown): string {
  if (
    input === null ||
    typeof input === "boolean" ||
    typeof input === "string" ||
    (typeof input === "number" && Number.isFinite(input))
  ) {
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    return `[${input.map(canonicalJson).join(",")}]`;
  }
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("invalid canonical test input");
}

function bytes(input: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(input));
}

function nonCanonicalBase64UrlAlias(canonical: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = canonical.at(-1);
  if (last === undefined) throw new TypeError("signature must not be empty");
  const index = alphabet.indexOf(last);
  if (index < 0 || index % 16 !== 0) {
    throw new TypeError("test signature must have canonical base64url tail");
  }
  const aliasedTail = alphabet.at(index + 1);
  if (aliasedTail === undefined) {
    throw new TypeError("test signature alias is outside base64url");
  }
  return `${canonical.slice(0, -1)}${aliasedTail}`;
}

function challengeProjection(): CloudLinkSessionChallengeSigningProjection {
  return {
    schema: "aether.cloudlink.session-challenge-signing.v1alpha1",
    gateway_id: gatewayId,
    challenge_id: challengeId,
    cloud_nonce: "C".repeat(43),
    issued_at_ms: "1784275200000",
    expires_at_ms: "1784275260000",
  };
}

function unsignedHello(): Omit<
  CloudLinkGatewayHelloAuthenticationInput,
  "gatewayAuthentication"
> {
  return {
    gatewayId,
    credentialId: "development-binding-17",
    credentialGeneration: parseGatewayCredentialGeneration("3"),
    gatewayKeyId: "gateway-session-key-17",
    challengeId,
    cloudNonce: "C".repeat(43),
    clientNonce: "A".repeat(43),
    offeredProtocolVersions: [parseProtocolVersion("1.0")],
    resumeCursors: [
      {
        streamId: parseStreamId("telemetry"),
        streamEpoch: parseStreamEpoch("4"),
        position: parseStreamPosition("18"),
      },
    ],
  };
}

function helloSigningProjection() {
  const input = unsignedHello();
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

function uplinkProjection(): CloudLinkUplinkSigningProjection {
  return {
    schema: "aether.cloudlink.uplink-signing.v1alpha1",
    gateway_id: gatewayId,
    credential_generation: parseGatewayCredentialGeneration("3"),
    session_id: parseCloudLinkSessionId("44444444-4444-4444-8444-444444444444"),
    session_epoch: parseCloudLinkSessionEpoch("7"),
    message_kind: "telemetry-batch",
    sent_at_ms: "1784275200000",
    expires_at_ms: "1784275260000",
    stream_id: parseStreamId("telemetry"),
    stream_epoch: parseStreamEpoch("4"),
    position: parseStreamPosition("18"),
    batch_id: "telemetry-batch-18",
    business_digest: `sha256:${"b".repeat(64)}`,
  };
}

function uplinkVerifierInput(
  signature: string,
  projection: CloudLinkUplinkSigningProjection = uplinkProjection(),
): CloudLinkUplinkCryptographicVerifierInput {
  return {
    tenantId,
    projectId,
    gatewayId,
    credentialGeneration: parseGatewayCredentialGeneration("3"),
    gatewayKeyId: "gateway-session-key-17",
    authentication: {
      keyId: "gateway-session-key-17",
      algorithm: "Ed25519",
      signature,
    },
    projection,
  };
}

describe("CloudLink gateway-signed Node cryptography", () => {
  it("digests the exact canonical CloudLink business envelope", async () => {
    const digestor = new NodeCloudLinkBusinessPayloadDigestor();
    const payload = { z: [3, 2, 1], a: { enabled: true } };
    const expected = `sha256:${createHash("sha256")
      .update(
        canonicalJson({
          protocol_version: "1.0",
          message_kind: "telemetry-batch",
          payload,
        }),
      )
      .digest("hex")}`;

    await expect(
      digestor.digest({
        protocolVersion: "1.0",
        messageKind: "telemetry-batch",
        payload,
      }),
    ).resolves.toBe(expected);
    await expect(
      digestor.digest({
        protocolVersion: "1.0",
        messageKind: "runtime-manifest-report",
        payload,
      }),
    ).resolves.not.toBe(expected);
  });

  it("signs the exact Cloud challenge JCS projection with a distinct Cloud key reference", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signer = new NodeEd25519CloudLinkSessionChallengeSigner({
      keyReference: "cloud-session-key-1",
      privateKey,
    });

    const authentication = await signer.sign(challengeProjection());

    expect(authentication).toMatchObject({
      keyId: "cloud-session-key-1",
      algorithm: "Ed25519",
    });
    expect(
      verify(
        null,
        bytes(challengeProjection()),
        publicKey,
        Buffer.from(authentication.signature, "base64url"),
      ),
    ).toBe(true);
    expect(JSON.stringify(signer)).not.toContain("PRIVATE");
  });

  it("verifies the exact Gateway establishment projection and returns only an opaque replay fingerprint", async () => {
    const gatewayKeys = generateKeyPairSync("ed25519");
    const signature = sign(
      null,
      bytes(helloSigningProjection()),
      gatewayKeys.privateKey,
    ).toString("base64url");
    const resolved: unknown[] = [];
    const authenticator = new NodeEd25519CloudLinkGatewayHelloAuthenticator({
      resolvePublicKey(input) {
        resolved.push(input);
        return Promise.resolve(gatewayKeys.publicKey);
      },
    });
    const input: CloudLinkGatewayHelloAuthenticationInput = {
      ...unsignedHello(),
      gatewayAuthentication: {
        keyId: "gateway-session-key-17",
        algorithm: "Ed25519",
        signature,
      },
    };

    await expect(authenticator.verify(input)).resolves.toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(resolved).toEqual([
      {
        gatewayId,
        credentialId: "development-binding-17",
        credentialGeneration: "3",
        gatewayKeyId: "gateway-session-key-17",
      },
    ]);
    await expect(
      authenticator.verify({ ...input, cloudNonce: "Z".repeat(43) }),
    ).resolves.toBeUndefined();
    await expect(
      authenticator.verify({
        ...input,
        gatewayAuthentication: {
          ...input.gatewayAuthentication,
          signature: "B".repeat(86),
        },
      }),
    ).resolves.toBeUndefined();
    const aliasedSignature = nonCanonicalBase64UrlAlias(signature);
    expect(Buffer.from(aliasedSignature, "base64url")).toEqual(
      Buffer.from(signature, "base64url"),
    );
    await expect(
      authenticator.verify({
        ...input,
        gatewayAuthentication: {
          ...input.gatewayAuthentication,
          signature: aliasedSignature,
        },
      }),
    ).resolves.toBeUndefined();
    expect(JSON.stringify(authenticator)).not.toContain(signature);
  });

  it("fails closed for unresolved, non-Ed25519, or mismatched Gateway keys", async () => {
    const gatewayKeys = generateKeyPairSync("ed25519");
    const rsaKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signature = sign(
      null,
      bytes(helloSigningProjection()),
      gatewayKeys.privateKey,
    ).toString("base64url");
    const input: CloudLinkGatewayHelloAuthenticationInput = {
      ...unsignedHello(),
      gatewayAuthentication: {
        keyId: "gateway-session-key-17",
        algorithm: "Ed25519",
        signature,
      },
    };

    await expect(
      new NodeEd25519CloudLinkGatewayHelloAuthenticator({
        resolvePublicKey: () => Promise.resolve(undefined),
      }).verify(input),
    ).resolves.toBeUndefined();
    await expect(
      new NodeEd25519CloudLinkGatewayHelloAuthenticator({
        resolvePublicKey: () => Promise.resolve(rsaKeys.publicKey),
      }).verify(input),
    ).resolves.toBeUndefined();
    await expect(
      new NodeEd25519CloudLinkGatewayHelloAuthenticator({
        resolvePublicKey: () =>
          Promise.reject(new Error("sensitive key lookup failure")),
      }).verify(input),
    ).resolves.toBeUndefined();
  });

  it("verifies the exact 13-field uplink JCS object with an active scoped Gateway key", async () => {
    const gatewayKeys = generateKeyPairSync("ed25519");
    const projection = uplinkProjection();
    const signingBytes = bytes(projection);
    const signature = sign(null, signingBytes, gatewayKeys.privateKey).toString(
      "base64url",
    );
    const lookups: unknown[] = [];
    const verifier = new NodeEd25519CloudLinkUplinkVerifier({
      resolvePublicKey(input) {
        lookups.push(input);
        return Promise.resolve({
          status: "active",
          publicKey: gatewayKeys.publicKey,
        });
      },
    });

    await expect(
      verifier.verify(uplinkVerifierInput(signature, projection)),
    ).resolves.toEqual({
      gatewayKeyActive: true,
      signatureVerified: true,
      signingObjectDigest: `sha256:${createHash("sha256")
        .update(signingBytes)
        .digest("hex")}`,
    });
    expect(lookups).toEqual([
      {
        tenantId,
        projectId,
        gatewayId,
        credentialGeneration: "3",
        gatewayKeyId: "gateway-session-key-17",
      },
    ]);
  });

  it("fails uplink verification closed for aliases, inactive or wrong key types, resolver failures, and non-exact projections", async () => {
    const gatewayKeys = generateKeyPairSync("ed25519");
    const rsaKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const projection = uplinkProjection();
    const signature = sign(
      null,
      bytes(projection),
      gatewayKeys.privateKey,
    ).toString("base64url");
    const aliasedSignature = nonCanonicalBase64UrlAlias(signature);
    expect(Buffer.from(aliasedSignature, "base64url")).toEqual(
      Buffer.from(signature, "base64url"),
    );

    for (const [resolver, input] of [
      [
        {
          resolvePublicKey: () =>
            Promise.resolve({
              status: "active" as const,
              publicKey: gatewayKeys.publicKey,
            }),
        },
        uplinkVerifierInput(aliasedSignature),
      ],
      [
        {
          resolvePublicKey: () =>
            Promise.resolve({
              status: "inactive" as const,
              publicKey: gatewayKeys.publicKey,
            }),
        },
        uplinkVerifierInput(signature),
      ],
      [
        {
          resolvePublicKey: () =>
            Promise.resolve({
              status: "active" as const,
              publicKey: rsaKeys.publicKey,
            }),
        },
        uplinkVerifierInput(signature),
      ],
      [
        {
          resolvePublicKey: () =>
            Promise.reject(new Error(`secret:${signature}`)),
        },
        uplinkVerifierInput(signature),
      ],
      [
        {
          resolvePublicKey: () =>
            Promise.resolve({
              status: "active" as const,
              publicKey: gatewayKeys.publicKey,
            }),
        },
        uplinkVerifierInput(signature, {
          ...projection,
          forbidden: "field",
        } as CloudLinkUplinkSigningProjection),
      ],
    ] as const) {
      const verifier = new NodeEd25519CloudLinkUplinkVerifier(resolver);
      const result = await verifier.verify(input);
      expect(result?.signatureVerified ?? false).toBe(false);
      expect(JSON.stringify(result ?? null)).not.toContain(signature);
    }
  });

  it("generates unique canonical UUIDs and 32-byte cryptographic nonces", () => {
    const generator = new NodeCloudLinkSessionChallengeMaterialGenerator();
    const ids = new Set<string>();
    const nonces = new Set<string>();
    for (let index = 0; index < 64; index += 1) {
      const id = generator.nextChallengeId();
      const nonce = generator.nextNonce();
      expect(() => parseCloudLinkSessionChallengeId(id)).not.toThrow();
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(nonce, "base64url")).toHaveLength(32);
      ids.add(id);
      nonces.add(nonce);
    }
    expect(ids.size).toBe(64);
    expect(nonces.size).toBe(64);
  });
});
