import { KeyObject, createHash, sign, verify } from "node:crypto";

import type {
  IntegrationControlActionIntent,
  IntegrationControlIntentDigestor,
  IntegrationControlOfferAuthentication,
  IntegrationControlOfferSigner,
  IntegrationControlOfferSigningProjection,
  IntegrationControlReceiptAuthenticationInput,
  IntegrationControlReceiptAuthenticator,
} from "@aether-cloud/application";
import {
  parseIntegrationControlDigest,
  type GatewayId,
} from "@aether-cloud/domain";

const keyReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;

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
  throw new TypeError("Integration Control canonical JSON input is invalid");
}

function canonicalBytes(input: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(input));
}

function sha256(input: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(input), "utf8")
    .digest("hex")}`;
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
      `Integration Control requires an Ed25519 ${expectedType} KeyObject`,
    );
  }
}

export class NodeIntegrationControlIntentDigestor implements IntegrationControlIntentDigestor {
  digest(intent: IntegrationControlActionIntent) {
    return Promise.resolve(parseIntegrationControlDigest(sha256(intent)));
  }
}

export class NodeEd25519IntegrationControlOfferSigner implements IntegrationControlOfferSigner {
  readonly #keyReference: string;
  readonly #privateKey: KeyObject;

  constructor(input: {
    readonly keyReference: string;
    readonly privateKey: KeyObject;
  }) {
    if (!keyReferencePattern.test(input.keyReference)) {
      throw new TypeError(
        "Integration Control signing key reference is invalid",
      );
    }
    assertEd25519Key(input.privateKey, "private");
    this.#keyReference = input.keyReference;
    this.#privateKey = input.privateKey;
  }

  sign(
    offer: IntegrationControlOfferSigningProjection,
  ): Promise<IntegrationControlOfferAuthentication> {
    const signature = sign(
      null,
      canonicalBytes(offer),
      this.#privateKey,
    ).toString("base64url");
    if (!signaturePattern.test(signature)) {
      throw new TypeError("Ed25519 signer returned a non-canonical signature");
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

export interface IntegrationControlPublicKeyResolver {
  resolvePublicKey(
    keyReference: string,
    gatewayId: GatewayId,
  ): Promise<KeyObject | undefined>;
}

function receiptPayload(
  input: IntegrationControlReceiptAuthenticationInput,
): JsonRecord {
  const receipt = input.receipt;
  return {
    schema: "aether.integration-control.action-receipt.v1alpha1",
    job_id: receipt.jobId,
    receipt_id: receipt.receiptId,
    receipt_sequence: receipt.receiptSequence,
    capability_id: receipt.capabilityId,
    target: {
      integration_id: receipt.target.integrationId,
      snapshot_generation: receipt.target.snapshotGeneration,
      entity_id: receipt.target.entityId,
      point_key: receipt.target.pointKey,
    },
    intent_digest: receipt.intentDigest,
    stage: receipt.stage,
    decision: receipt.decision,
    physical_outcome: receipt.physicalOutcome,
    observed_at_ms: receipt.observedAtMs,
    ...(receipt.evidenceDigest === undefined
      ? {}
      : { evidence_digest: receipt.evidenceDigest }),
    ...(receipt.failureCode === undefined
      ? {}
      : { failure_code: receipt.failureCode }),
    audit: {
      audit_record_id: receipt.audit.auditRecordId,
      status: receipt.audit.status,
    },
  };
}

function receiptBusinessDigest(
  input: IntegrationControlReceiptAuthenticationInput,
): string {
  return sha256({
    protocol_version: "1.0",
    message_kind: "integration-action-receipt",
    payload: receiptPayload(input),
  });
}

function receiptSigningProjection(
  input: IntegrationControlReceiptAuthenticationInput,
): JsonRecord {
  return {
    schema: "aether.cloudlink.uplink-signing.v1alpha1",
    gateway_id: input.gatewayId,
    credential_generation: input.credentialGeneration,
    session_id: input.sessionId,
    session_epoch: input.sessionEpoch,
    message_kind: "integration-action-receipt",
    sent_at_ms: input.sentAtMs,
    expires_at_ms: input.expiresAtMs ?? null,
    stream_id: input.delivery.streamId,
    stream_epoch: input.delivery.streamEpoch,
    position: input.delivery.position,
    batch_id: input.delivery.batchId,
    business_digest: input.delivery.digest,
  };
}

export class NodeEd25519IntegrationControlReceiptAuthenticator implements IntegrationControlReceiptAuthenticator {
  readonly #resolver: IntegrationControlPublicKeyResolver;

  constructor(resolver: IntegrationControlPublicKeyResolver) {
    this.#resolver = resolver;
  }

  async verify(
    input: IntegrationControlReceiptAuthenticationInput,
  ): Promise<boolean> {
    const algorithm: unknown = input.messageAuthentication.algorithm;
    if (
      algorithm !== "Ed25519" ||
      !keyReferencePattern.test(input.messageAuthentication.keyId) ||
      !signaturePattern.test(input.messageAuthentication.signature) ||
      receiptBusinessDigest(input) !== input.delivery.digest
    ) {
      return false;
    }
    const publicKey = await this.#resolver.resolvePublicKey(
      input.messageAuthentication.keyId,
      input.gatewayId,
    );
    if (publicKey === undefined) return false;
    try {
      assertEd25519Key(publicKey, "public");
      return verify(
        null,
        canonicalBytes(receiptSigningProjection(input)),
        publicKey,
        Buffer.from(input.messageAuthentication.signature, "base64url"),
      );
    } catch {
      return false;
    }
  }
}
