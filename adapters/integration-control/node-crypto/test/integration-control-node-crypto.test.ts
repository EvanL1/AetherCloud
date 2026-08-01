import { generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  decodeIntegrationControlActionOffer,
  decodeIntegrationControlActionReceipt,
  integrationControlOfferSigningBytes,
  integrationControlReceiptSigningBytes,
  type IntegrationControlWireActionReceipt,
} from "@aether-cloud/cloudlink-mqtt-adapter";
import type {
  IntegrationControlActionIntent,
  IntegrationControlOfferSigningProjection,
  IntegrationControlReceiptAuthenticationInput,
} from "@aether-cloud/application";
import {
  defineIntegrationControlReceipt,
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseIntegrationControlDigest,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
} from "@aether-cloud/domain";
import { describe, expect, it } from "vitest";

import {
  NodeEd25519IntegrationControlOfferSigner,
  NodeEd25519IntegrationControlReceiptAuthenticator,
  NodeIntegrationControlIntentDigestor,
} from "../src/index.js";

const canonicalGatewaySignature = Buffer.alloc(64, 0xa5).toString("base64url");

function fixture(name: string): Uint8Array {
  return readFileSync(
    new URL(
      `../../../../contracts/aether-contracts/v0.1.0-alpha.4/fixtures/integration-control/v1alpha1/${name}`,
      import.meta.url,
    ),
  );
}

function canonicalReceiptFixture(): Uint8Array {
  const receipt = JSON.parse(
    new TextDecoder().decode(
      fixture("action-receipt-provider-accepted.valid.json"),
    ),
  ) as Record<string, unknown>;
  const authentication = receipt.message_authentication as Record<
    string,
    unknown
  >;
  authentication.signature = canonicalGatewaySignature;
  return new TextEncoder().encode(JSON.stringify(receipt));
}

describe("Integration Control Node cryptography", () => {
  it("computes the frozen RFC 8785 intent digest", async () => {
    const decoded = decodeIntegrationControlActionOffer(
      fixture("action-offer.valid.json"),
    );
    if (!decoded.ok) throw new Error("offer fixture must decode");
    const digestor = new NodeIntegrationControlIntentDigestor();

    await expect(
      digestor.digest(
        decoded.value.intent as unknown as IntegrationControlActionIntent,
      ),
    ).resolves.toBe(
      "sha256:40108827ca617c95f9d9c48c357fdd94b2b5f019d8ccf8a23842642e934c7327",
    );
  });

  it("signs the exact offer projection using only an opaque key reference and private KeyObject", async () => {
    const decoded = decodeIntegrationControlActionOffer(
      fixture("action-offer.valid.json"),
    );
    if (!decoded.ok) throw new Error("offer fixture must decode");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signer = new NodeEd25519IntegrationControlOfferSigner({
      keyReference: "development-cloud-key-1",
      privateKey,
    });
    const { cloud_authentication: fixtureAuthentication, ...projection } =
      decoded.value;
    void fixtureAuthentication;

    const signedAuthentication = await signer.sign(
      projection as unknown as IntegrationControlOfferSigningProjection,
    );
    const signedOffer = {
      ...decoded.value,
      cloud_authentication: {
        key_id: signedAuthentication.keyId,
        algorithm: signedAuthentication.algorithm,
        signature: signedAuthentication.signature,
      },
    };

    expect(signedAuthentication).toMatchObject({
      keyId: "development-cloud-key-1",
      algorithm: "Ed25519",
    });
    expect(signedAuthentication.signature).toHaveLength(86);
    expect(
      verify(
        null,
        integrationControlOfferSigningBytes(signedOffer),
        publicKey,
        Buffer.from(signedAuthentication.signature, "base64url"),
      ),
    ).toBe(true);
    expect(JSON.stringify(signer)).not.toContain("PRIVATE");
  });

  it("rejects a non-Ed25519 or public signing key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(
      () =>
        new NodeEd25519IntegrationControlOfferSigner({
          keyReference: "wrong-key",
          privateKey: rsa.privateKey,
        }),
    ).toThrow();
    const ed25519 = generateKeyPairSync("ed25519");
    expect(
      () =>
        new NodeEd25519IntegrationControlOfferSigner({
          keyReference: "public-key",
          privateKey: ed25519.publicKey,
        }),
    ).toThrow();
  });

  it("verifies the exact authenticated receipt and its business digest through a public-key resolver", async () => {
    const decoded = decodeIntegrationControlActionReceipt(
      canonicalReceiptFixture(),
    );
    if (!decoded.ok) throw new Error("receipt fixture must decode");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signature = sign(
      null,
      integrationControlReceiptSigningBytes(decoded.value),
      privateKey,
    ).toString("base64url");
    const input = authenticationInput(decoded.value, signature);
    const resolved: string[] = [];
    const authenticator = new NodeEd25519IntegrationControlReceiptAuthenticator(
      {
        resolvePublicKey(keyReference, gatewayId) {
          resolved.push(`${keyReference}:${gatewayId}`);
          return Promise.resolve(publicKey);
        },
      },
    );

    await expect(authenticator.verify(input)).resolves.toBe(true);
    expect(resolved).toEqual([
      "development-gateway-key-1:33333333-3333-4333-8333-333333333333",
    ]);
    await expect(
      authenticator.verify({
        ...input,
        delivery: {
          ...input.delivery,
          digest: parseIntegrationControlDigest(
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          ),
        },
      }),
    ).resolves.toBe(false);
  });

  it("binds the optional expiry into the Ed25519 projection but treats traceparent as unsigned transport correlation", async () => {
    const receipt = JSON.parse(
      new TextDecoder().decode(canonicalReceiptFixture()),
    ) as Record<string, unknown>;
    receipt.expires_at_ms = "1784217600600";
    receipt.traceparent =
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const decoded = decodeIntegrationControlActionReceipt(
      new TextEncoder().encode(JSON.stringify(receipt)),
    );
    if (!decoded.ok) throw new Error("receipt envelope options must decode");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signature = sign(
      null,
      integrationControlReceiptSigningBytes(decoded.value),
      privateKey,
    ).toString("base64url");
    const input = authenticationInput(decoded.value, signature);
    const authenticator = new NodeEd25519IntegrationControlReceiptAuthenticator(
      {
        resolvePublicKey() {
          return Promise.resolve(publicKey);
        },
      },
    );

    expect(input).toMatchObject({
      expiresAtMs: "1784217600600",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });
    await expect(authenticator.verify(input)).resolves.toBe(true);
    await expect(
      authenticator.verify({
        ...input,
        expiresAtMs: "1784217600601",
      }),
    ).resolves.toBe(false);
    await expect(
      authenticator.verify({
        ...input,
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00",
      }),
    ).resolves.toBe(true);
  });

  it("fails closed when the key reference is unresolved", async () => {
    const decoded = decodeIntegrationControlActionReceipt(
      canonicalReceiptFixture(),
    );
    if (!decoded.ok) throw new Error("receipt fixture must decode");
    const authenticator = new NodeEd25519IntegrationControlReceiptAuthenticator(
      {
        resolvePublicKey() {
          return Promise.resolve(undefined);
        },
      },
    );
    await expect(
      authenticator.verify(authenticationInput(decoded.value, "E".repeat(86))),
    ).resolves.toBe(false);
  });
});

function authenticationInput(
  wire: IntegrationControlWireActionReceipt,
  signature: string,
): IntegrationControlReceiptAuthenticationInput {
  return {
    gatewayId: parseGatewayId(wire.gateway_id),
    credentialGeneration: parseGatewayCredentialGeneration(
      wire.credential_generation,
    ),
    sessionId: parseCloudLinkSessionId(wire.session_id),
    sessionEpoch: parseCloudLinkSessionEpoch(wire.session_epoch),
    sentAtMs: wire.sent_at_ms,
    ...(wire.expires_at_ms === undefined
      ? {}
      : { expiresAtMs: wire.expires_at_ms }),
    ...(wire.traceparent === undefined
      ? {}
      : { traceparent: wire.traceparent }),
    delivery: {
      streamId: parseStreamId(wire.delivery.stream_id),
      streamEpoch: parseStreamEpoch(wire.delivery.stream_epoch),
      position: parseStreamPosition(wire.delivery.position),
      batchId: wire.delivery.batch_id,
      digest: parseIntegrationControlDigest(wire.delivery.digest),
    },
    messageAuthentication: {
      keyId: wire.message_authentication.key_id,
      algorithm: "Ed25519",
      signature,
    },
    receipt: defineIntegrationControlReceipt({
      jobId: wire.payload.job_id,
      receiptId: wire.payload.receipt_id,
      receiptSequence: wire.payload.receipt_sequence,
      capabilityId: wire.payload.capability_id,
      target: {
        integrationId: wire.payload.target.integration_id,
        snapshotGeneration: wire.payload.target.snapshot_generation,
        entityId: wire.payload.target.entity_id,
        pointKey: wire.payload.target.point_key,
      },
      intentDigest: wire.payload.intent_digest,
      stage: wire.payload.stage,
      decision: wire.payload.decision,
      physicalOutcome: wire.payload.physical_outcome,
      observedAtMs: wire.payload.observed_at_ms,
      ...(wire.payload.evidence_digest === undefined
        ? {}
        : { evidenceDigest: wire.payload.evidence_digest }),
      ...(wire.payload.failure_code === undefined
        ? {}
        : { failureCode: wire.payload.failure_code }),
      audit: {
        auditRecordId: wire.payload.audit.audit_record_id,
        status: wire.payload.audit.status,
      },
    }),
  };
}
