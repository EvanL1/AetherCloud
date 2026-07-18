import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  decodeIntegrationControlActionOffer,
  decodeIntegrationControlActionReceipt,
  encodeIntegrationControlActionOffer,
  integrationControlIntentDigest,
  integrationControlOfferSigningBytes,
  integrationControlReceiptBusinessDigest,
  integrationControlReceiptSigningBytes,
  mqttIntegrationControlOfferTopic,
  mqttIntegrationControlReceiptFilter,
  mqttIntegrationControlReceiptTopic,
} from "../src/index.js";

const gatewayId = "33333333-3333-4333-8333-333333333333";
const expectedIntentDigest =
  "sha256:40108827ca617c95f9d9c48c357fdd94b2b5f019d8ccf8a23842642e934c7327";
const expectedReceiptDigest =
  "sha256:f42bb6dfcd28ca27a7c1079569ffcd0f6144f741461cd362c3c679f471af80a7";
const canonicalGatewaySignature = Buffer.alloc(64, 0xa5).toString("base64url");

function fixture(name: string): Uint8Array {
  return readFileSync(
    new URL(
      `../../../../contracts/aether-contracts/v0.1.0-alpha.4-candidate/fixtures/integration-control/v1alpha1/${name}`,
      import.meta.url,
    ),
  );
}

function fixtureObject(name: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fixture(name))) as Record<
    string,
    unknown
  >;
}

function canonicalReceipt(
  name = "action-receipt-provider-accepted.valid.json",
): Record<string, unknown> {
  const receipt = fixtureObject(name);
  const authentication = receipt.message_authentication as Record<
    string,
    unknown
  >;
  authentication.signature = canonicalGatewaySignature;
  return receipt;
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe("Integration Control strict codec", () => {
  it("decodes and re-encodes only the fixed signed power offer", () => {
    const decoded = decodeIntegrationControlActionOffer(
      fixture("action-offer.valid.json"),
    );
    expect(decoded).toMatchObject({
      ok: true,
      value: {
        extension: "aether.cloudlink.integration-control.v1alpha1",
        message_kind: "integration-action-offer",
        gateway_id: gatewayId,
        intent_digest: expectedIntentDigest,
        intent: {
          capability_id: "device.power.set.v1",
          target: { point_key: "is_on" },
          arguments: { value: true },
          governance: {
            permission: "integration.device.control",
            risk: "high",
            edge_final_decision: true,
          },
        },
      },
    });
    if (!decoded.ok) throw new Error("valid offer must decode");
    expect(
      decodeIntegrationControlActionOffer(
        encodeIntegrationControlActionOffer(decoded.value),
      ),
    ).toEqual(decoded);
    expect(integrationControlIntentDigest(decoded.value.intent)).toBe(
      expectedIntentDigest,
    );
    expect(
      new TextDecoder().decode(
        integrationControlOfferSigningBytes(decoded.value),
      ),
    ).not.toContain("cloud_authentication");
  });

  it.each([
    "invalid/action-offer-missing-confirmation.json",
    "invalid/action-offer-provider-material.json",
    "invalid/action-offer-unknown-capability.json",
  ])("rejects the closed-surface invalid offer %s", (name) => {
    expect(decodeIntegrationControlActionOffer(fixture(name))).toMatchObject({
      ok: false,
    });
  });

  it("rejects arbitrary Home Assistant operations, secrets, and unknown fields", () => {
    for (const [field, value] of [
      ["domain", "light"],
      ["service", "turn_on"],
      ["service_data", { brightness: 255 }],
      ["url", "https://home-assistant.invalid"],
      ["token", "secret"],
      ["payload", { arbitrary: true }],
    ] as const) {
      const offer = fixtureObject("action-offer.valid.json");
      const intent = offer.intent as Record<string, unknown>;
      const argumentsRecord = intent.arguments as Record<string, unknown>;
      argumentsRecord[field] = value;
      expect(
        decodeIntegrationControlActionOffer(bytes(offer)),
        field,
      ).toMatchObject({
        ok: false,
        failure: { code: "invalid-payload", contract_code: "UNKNOWN_FIELD" },
      });
    }
  });

  it("rejects a validly shaped offer whose intent digest was not recomputed", () => {
    const offer = fixtureObject("action-offer.valid.json");
    const intent = offer.intent as Record<string, unknown>;
    (intent.arguments as Record<string, unknown>).value = false;
    expect(decodeIntegrationControlActionOffer(bytes(offer))).toMatchObject({
      ok: false,
      failure: { code: "digest-mismatch", contract_code: "DIGEST_MISMATCH" },
    });
  });

  it("decodes authenticated receipt evidence without inventing physical completion", () => {
    const decoded = decodeIntegrationControlActionReceipt(
      bytes(canonicalReceipt()),
    );
    expect(decoded).toMatchObject({
      ok: true,
      value: {
        gateway_id: gatewayId,
        delivery: { digest: expectedReceiptDigest },
        payload: {
          stage: "provider-accepted",
          decision: "accepted",
          physical_outcome: "unknown",
        },
      },
    });
    if (!decoded.ok) throw new Error("valid receipt must decode");
    expect(integrationControlReceiptBusinessDigest(decoded.value)).toBe(
      expectedReceiptDigest,
    );
    expect(decoded.value.payload).not.toHaveProperty("succeeded");
    expect(decoded.value.payload).not.toHaveProperty("physical-confirmed");
  });

  it("preserves a valid optional expiry and W3C trace context while signing only the authoritative expiry", () => {
    const receipt = canonicalReceipt();
    (receipt.message_authentication as Record<string, unknown>).signature =
      canonicalGatewaySignature;
    receipt.expires_at_ms = receipt.sent_at_ms;
    receipt.traceparent =
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    const decoded = decodeIntegrationControlActionReceipt(bytes(receipt));

    expect(decoded).toMatchObject({
      ok: true,
      value: {
        expires_at_ms: "1784217600500",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    });
    if (!decoded.ok) throw new Error("optional envelope fields must decode");
    const signingBytes = new TextDecoder().decode(
      integrationControlReceiptSigningBytes(decoded.value),
    );
    expect(signingBytes).toContain('"expires_at_ms":"1784217600500"');
    expect(signingBytes).not.toContain("traceparent");
    expect(
      integrationControlReceiptSigningBytes({
        ...decoded.value,
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00",
      }),
    ).toEqual(integrationControlReceiptSigningBytes(decoded.value));
  });

  it.each([
    ["expiry before sent time", { expires_at_ms: "1784217600499" }],
    ["numeric expiry", { expires_at_ms: 1_784_217_600_500 }],
    ["non-canonical expiry", { expires_at_ms: "01784217600500" }],
    ["out-of-range expiry", { expires_at_ms: "18446744073709551616" }],
    [
      "forbidden trace version",
      {
        traceparent: "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    ],
    [
      "zero trace id",
      {
        traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      },
    ],
    [
      "zero parent id",
      {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      },
    ],
    [
      "uppercase trace context",
      {
        traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
      },
    ],
  ])("rejects invalid optional receipt envelope data: %s", (_name, patch) => {
    const receipt = fixtureObject(
      "action-receipt-provider-accepted.valid.json",
    );
    Object.assign(receipt, patch);

    expect(decodeIntegrationControlActionReceipt(bytes(receipt))).toMatchObject(
      {
        ok: false,
        failure: { code: "invalid-payload" },
      },
    );
  });

  it.each([
    ["unknown", "unknown", "PROVIDER_TIMEOUT"],
    ["edge-rejected", "rejected", "LOCAL_POLICY_DENIED"],
  ] as const)(
    "accepts optional evidence for the %s receipt stage",
    (stage, decision, failureCode) => {
      const decoded = decodeIntegrationControlActionReceipt(
        bytes(canonicalReceipt()),
      );
      if (!decoded.ok) throw new Error("valid base receipt must decode");
      const receipt = {
        ...decoded.value,
        payload: {
          ...decoded.value.payload,
          stage,
          decision,
          failure_code: failureCode,
        },
      };
      const encoded = {
        ...receipt,
        delivery: {
          ...receipt.delivery,
          digest: integrationControlReceiptBusinessDigest(receipt),
        },
      };

      expect(
        decodeIntegrationControlActionReceipt(bytes(encoded)),
      ).toMatchObject({
        ok: true,
        value: {
          payload: {
            stage,
            decision,
            evidence_digest:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        },
      });
    },
  );

  it("rejects evidence only for an edge-accepted receipt", () => {
    const receipt = fixtureObject(
      "action-receipt-provider-accepted.valid.json",
    );
    const payload = receipt.payload as Record<string, unknown>;
    payload.stage = "edge-accepted";
    payload.decision = "accepted";

    expect(decodeIntegrationControlActionReceipt(bytes(receipt))).toMatchObject(
      {
        ok: false,
        failure: { code: "invalid-payload" },
      },
    );
  });

  it("enforces the envelope identifier bound for receipt authentication keys", () => {
    const receipt = canonicalReceipt();
    const authentication = receipt.message_authentication as Record<
      string,
      unknown
    >;
    authentication.key_id = "k".repeat(128);
    expect(decodeIntegrationControlActionReceipt(bytes(receipt))).toMatchObject(
      { ok: true },
    );

    authentication.key_id = "k".repeat(129);
    expect(decodeIntegrationControlActionReceipt(bytes(receipt))).toMatchObject(
      {
        ok: false,
        failure: { code: "invalid-payload", contract_code: "FIELD_BOUND" },
      },
    );
  });

  it("rejects unknown receipt authentication fields and non-canonical base64url aliases", () => {
    const unknown = canonicalReceipt();
    (
      unknown.message_authentication as Record<string, unknown>
    ).payload_attestation = "forbidden";
    expect(decodeIntegrationControlActionReceipt(bytes(unknown))).toMatchObject(
      {
        ok: false,
        failure: { contract_code: "UNKNOWN_FIELD" },
      },
    );

    const aliased = canonicalReceipt();
    const authentication = aliased.message_authentication as Record<
      string,
      unknown
    >;
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = canonicalGatewaySignature.at(-1);
    if (last === undefined) throw new Error("signature must not be empty");
    const index = alphabet.indexOf(last);
    const aliasTail = alphabet.at(index + 1);
    if (aliasTail === undefined) {
      throw new Error("test signature alias tail must exist");
    }
    authentication.signature = `${canonicalGatewaySignature.slice(0, -1)}${aliasTail}`;
    expect(
      Buffer.from(authentication.signature as string, "base64url"),
    ).toEqual(Buffer.from(canonicalGatewaySignature, "base64url"));
    expect(decodeIntegrationControlActionReceipt(bytes(aliased))).toMatchObject(
      {
        ok: false,
        failure: { contract_code: "AUTHENTICATION_INVALID" },
      },
    );
  });

  it("rejects physical completion and receipt business-digest conflicts", () => {
    expect(
      decodeIntegrationControlActionReceipt(
        fixture("invalid/action-receipt-physical-completion.json"),
      ),
    ).toMatchObject({ ok: false });

    const receipt = canonicalReceipt();
    (receipt.payload as Record<string, unknown>).observed_at_ms =
      "1784217600451";
    expect(decodeIntegrationControlActionReceipt(bytes(receipt))).toMatchObject(
      {
        ok: false,
        failure: { code: "digest-mismatch", contract_code: "DIGEST_MISMATCH" },
      },
    );
  });

  it("binds the fixed default-off MQTT routes", () => {
    expect(mqttIntegrationControlOfferTopic("aethercloud", gatewayId)).toBe(
      `aethercloud/v1/gateways/${gatewayId}/down/integration-control`,
    );
    expect(mqttIntegrationControlReceiptTopic("aethercloud", gatewayId)).toBe(
      `aethercloud/v1/gateways/${gatewayId}/up/integration-control/receipts`,
    );
    expect(mqttIntegrationControlReceiptFilter("aethercloud")).toBe(
      "aethercloud/v1/gateways/+/up/integration-control/receipts",
    );
    expect(() =>
      mqttIntegrationControlOfferTopic("bad/#", gatewayId),
    ).toThrow();
  });
});
