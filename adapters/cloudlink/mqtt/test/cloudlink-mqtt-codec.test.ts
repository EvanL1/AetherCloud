import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  cloudLinkBusinessDigest,
  decodeCloudLinkContractMessage,
  decodeCloudLinkMqttInbound,
  encodeCloudLinkMqttOutbound,
  mqttDownlinkTopic,
  mqttUplinkFilters,
  type CloudLinkDeliveryEnvelope,
  type CloudLinkSessionAccepted,
} from "../src/index.js";

const gatewayId = "33333333-3333-4333-8333-333333333333";
const topicPrefix = "aethercloud";
const canonicalSignature = Buffer.alloc(64, 0xa5).toString("base64url");

function nonCanonicalSignatureAlias(value: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = value.at(-1);
  if (last === undefined) throw new Error("signature must not be empty");
  const index = alphabet.indexOf(last);
  if (index < 0 || index % 16 !== 0) {
    throw new Error("test signature must use a canonical two-bit tail");
  }
  const aliasTail = alphabet.at(index + 1);
  if (aliasTail === undefined) {
    throw new Error("test signature alias tail must exist");
  }
  return `${value.slice(0, -1)}${aliasTail}`;
}

function messageAuthentication() {
  return {
    key_id: "gateway-session-key-17",
    algorithm: "Ed25519",
    signature: canonicalSignature,
  };
}

function challengeRequest(): Record<string, unknown> {
  return {
    schema: "aether.cloudlink.session-challenge-request.v1",
    protocol: "aether.cloudlink",
    message_kind: "session-challenge-request",
    gateway_id: gatewayId,
    credential_binding: {
      credential_id: "development-binding-17",
      generation: "3",
    },
    offered_protocol_versions: ["1.0"],
    client_nonce: "A".repeat(43),
    resume: [
      {
        stream_id: "telemetry",
        stream_epoch: "4",
        acknowledged_position: "18",
      },
    ],
  };
}

function payload(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function fixture(name: string): Uint8Array {
  return readFileSync(
    new URL(
      `../../../../contracts/cloudlink/v1/fixtures/${name}`,
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

function integrationFixture(name: string): Uint8Array {
  return readFileSync(
    new URL(
      `../../../../contracts/aether-contracts/v0.1.0-alpha.4-candidate/fixtures/cloudlink-integration/v1alpha1/${name}`,
      import.meta.url,
    ),
  );
}

describe("AetherContracts alpha.3 CloudLink MQTT consumer codec", () => {
  it("pins every shared fixture byte in the freeze manifest", () => {
    const contractRoot = new URL(
      "../../../../contracts/cloudlink/v1/",
      import.meta.url,
    );
    const manifest = JSON.parse(
      readFileSync(new URL("fixture-manifest.json", contractRoot), "utf8"),
    ) as {
      fixtures: Array<{ file: string; sha256: string }>;
    };
    expect(manifest.fixtures.map((entry) => entry.file).sort()).toEqual(
      readdirSync(new URL("fixtures/", contractRoot)).sort(),
    );
    for (const entry of manifest.fixtures) {
      const actual = createHash("sha256")
        .update(readFileSync(new URL(`fixtures/${entry.file}`, contractRoot)))
        .digest("hex");
      expect(actual, entry.file).toBe(entry.sha256);
    }
  });

  it("consumes every shared valid fixture unchanged", () => {
    for (const name of [
      "data-loss.valid.json",
      "durable-ack.valid.json",
      "heartbeat-ack.valid.json",
      "heartbeat.valid.json",
      "replay-request.valid.json",
      "runtime-manifest-report.valid.json",
      "session-accepted.valid.json",
      "session-challenge.valid.json",
      "session-hello.valid.json",
      "telemetry-batch.valid.json",
    ]) {
      expect(decodeCloudLinkContractMessage(fixture(name)), name).toMatchObject(
        { ok: true },
      );
    }
  });

  it("executes the complete public fixture manifest with stable failure codes", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL(
          "../../../../contracts/cloudlink/v1/fixture-manifest.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      fixtures: Array<{
        file: string;
        expectation: "valid" | "wire-invalid" | "context-invalid";
        failure_code?: string;
      }>;
    };
    expect(manifest.fixtures).toHaveLength(25);
    for (const entry of manifest.fixtures) {
      const decoded = decodeCloudLinkContractMessage(fixture(entry.file));
      const decoderRejectsContext = [
        "conflicting-replay.json",
        "session-accepted-duplicate-cursor.json",
      ].includes(entry.file);
      if (entry.expectation === "wire-invalid" || decoderRejectsContext) {
        expect(decoded, entry.file).toMatchObject({
          ok: false,
          failure: { contract_code: entry.failure_code },
        });
        continue;
      }
      expect(decoded, entry.file).toMatchObject({ ok: true });
      if (entry.expectation === "context-invalid") {
        const contractCode =
          entry.file === "conflicting-replay.valid-digest.json"
            ? "DIGEST_CONFLICT"
            : entry.file === "stale-ack.json" ||
                entry.file === "wrong-session-epoch.json"
              ? "STALE_SESSION"
              : undefined;
        expect(contractCode, entry.file).toBe(entry.failure_code);
      }
    }
  });

  it("consumes the pinned public snake-case fixture vocabulary", () => {
    const hello = fixtureObject("session-hello.valid.json");
    expect(hello).toMatchObject({
      schema: "aether.cloudlink.session-hello.v1",
      protocol: "aether.cloudlink",
      message_kind: "session-hello",
      gateway_id: gatewayId,
      credential_binding: {
        generation: "3",
        origin_model: "gateway-signed",
      },
    });
    const credentialBinding = hello.credential_binding as Record<
      string,
      unknown
    >;
    expect(credentialBinding).not.toHaveProperty("proof");
    expect(hello).toHaveProperty("gateway_signature.signature");
    expect(
      decodeCloudLinkMqttInbound(
        `${topicPrefix}/v1/gateways/${gatewayId}/up/session`,
        fixture("session-hello.valid.json"),
        { topicPrefix },
      ),
    ).toMatchObject({
      ok: true,
      value: { message_kind: "session-hello", gateway_id: gatewayId },
    });
  });

  it("strictly decodes a challenge request on the existing Gateway up/session route", () => {
    expect(
      decodeCloudLinkMqttInbound(
        `${topicPrefix}/v1/gateways/${gatewayId}/up/session`,
        payload(challengeRequest()),
        { topicPrefix },
      ),
    ).toEqual({
      ok: true,
      value: challengeRequest(),
    });

    expect(
      decodeCloudLinkMqttInbound(
        `${topicPrefix}/v1/gateways/${gatewayId}/up/telemetry`,
        payload(challengeRequest()),
        { topicPrefix },
      ),
    ).toMatchObject({
      ok: false,
      failure: { code: "invalid-topic-binding" },
    });

    expect(
      decodeCloudLinkContractMessage(
        payload({ ...challengeRequest(), credential_proof: "not-authority" }),
      ),
    ).toMatchObject({
      ok: false,
      failure: { contract_code: "UNKNOWN_FIELD" },
    });
  });

  it.each([
    ["heartbeat.valid.json", "heartbeat"],
    ["runtime-manifest-report.valid.json", "manifest"],
    ["telemetry-batch.valid.json", "telemetry"],
    ["data-loss.valid.json", "data-loss"],
  ] as const)("binds %s to its exact Gateway route", (name, route) => {
    expect(
      decodeCloudLinkMqttInbound(
        `${topicPrefix}/v1/gateways/${gatewayId}/up/${route}`,
        fixture(name),
        { topicPrefix },
      ),
    ).toMatchObject({ ok: true });
  });

  it("strictly decodes message_authentication on heartbeat and every core or Integration delivery", () => {
    for (const name of [
      "heartbeat.valid.json",
      "runtime-manifest-report.valid.json",
      "telemetry-batch.valid.json",
      "data-loss.valid.json",
    ]) {
      const message = fixtureObject(name);
      message.message_authentication = messageAuthentication();
      expect(
        decodeCloudLinkContractMessage(payload(message)),
        name,
      ).toMatchObject({
        ok: true,
        value: { message_authentication: messageAuthentication() },
      });
    }

    for (const name of [
      "integration-topology.valid.json",
      "integration-observations.valid.json",
    ]) {
      const message = JSON.parse(
        new TextDecoder().decode(integrationFixture(name)),
      ) as Record<string, unknown>;
      message.message_authentication = messageAuthentication();
      expect(
        decodeCloudLinkContractMessage(payload(message)),
        name,
      ).toMatchObject({
        ok: true,
        value: { message_authentication: messageAuthentication() },
      });
    }
  });

  it("rejects unknown authentication members, overlong key IDs, and non-canonical base64url aliases", () => {
    const heartbeat = fixtureObject("heartbeat.valid.json");
    heartbeat.message_authentication = {
      ...messageAuthentication(),
      payload_attestation: "forbidden",
    };
    expect(decodeCloudLinkContractMessage(payload(heartbeat))).toMatchObject({
      ok: false,
      failure: { contract_code: "UNKNOWN_FIELD" },
    });

    const delivery = fixtureObject("telemetry-batch.valid.json");
    delivery.message_authentication = {
      ...messageAuthentication(),
      key_id: "k".repeat(129),
    };
    expect(decodeCloudLinkContractMessage(payload(delivery))).toMatchObject({
      ok: false,
      failure: { contract_code: "FIELD_BOUND" },
    });

    const alias = nonCanonicalSignatureAlias(canonicalSignature);
    expect(Buffer.from(alias, "base64url")).toEqual(
      Buffer.from(canonicalSignature, "base64url"),
    );
    delivery.message_authentication = {
      ...messageAuthentication(),
      signature: alias,
    };
    expect(decodeCloudLinkContractMessage(payload(delivery))).toMatchObject({
      ok: false,
      failure: { contract_code: "AUTHENTICATION_INVALID" },
    });
  });

  it("decodes the pinned Integration extension but activates MQTT routes only when explicitly enabled", () => {
    expect(
      decodeCloudLinkContractMessage(
        integrationFixture("integration-topology.valid.json"),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        message_kind: "integration-topology-snapshot",
        payload: {
          integration_id: "home-assistant.home",
          snapshot_generation: "1",
        },
      },
    });
    expect(
      decodeCloudLinkContractMessage(
        integrationFixture("integration-observations.valid.json"),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        message_kind: "integration-observation-batch",
        payload: { batch_id: "batch-0001" },
      },
    });

    const topologyTopic = `${topicPrefix}/v1/gateways/${gatewayId}/up/integration/topology`;
    expect(
      decodeCloudLinkMqttInbound(
        topologyTopic,
        integrationFixture("integration-topology.valid.json"),
        { topicPrefix },
      ),
    ).toMatchObject({
      ok: false,
      failure: { code: "unsupported-message" },
    });
    expect(
      decodeCloudLinkMqttInbound(
        topologyTopic,
        integrationFixture("integration-topology.valid.json"),
        {
          topicPrefix,
          enabledExtensions: ["aether.cloudlink.integration.v1alpha1"],
        },
      ),
    ).toMatchObject({
      ok: true,
      value: { message_kind: "integration-topology-snapshot" },
    });
    expect(
      decodeCloudLinkMqttInbound(
        `${topicPrefix}/v1/gateways/${gatewayId}/up/integration/observations`,
        integrationFixture("integration-observations.valid.json"),
        {
          topicPrefix,
          enabledExtensions: ["aether.cloudlink.integration.v1alpha1"],
        },
      ),
    ).toMatchObject({
      ok: true,
      value: { message_kind: "integration-observation-batch" },
    });
  });

  it("rejects Integration secrets and outer/payload batch binding conflicts", () => {
    expect(
      decodeCloudLinkContractMessage(
        integrationFixture("integration-topology-secret.invalid.json"),
      ),
    ).toMatchObject({
      ok: false,
      failure: { contract_code: "UNKNOWN_FIELD" },
    });

    const observations = JSON.parse(
      new TextDecoder().decode(
        integrationFixture("integration-observations.valid.json"),
      ),
    ) as Record<string, unknown>;
    (observations.delivery as Record<string, unknown>).batch_id =
      "different-batch";
    expect(decodeCloudLinkContractMessage(payload(observations))).toMatchObject(
      {
        ok: false,
        failure: { code: "invalid-payload" },
      },
    );
  });

  it("rejects duplicate Integration JSON keys before digest or domain decoding", () => {
    const topology = new TextDecoder().decode(
      integrationFixture("integration-topology.valid.json"),
    );
    const duplicated = topology.replace(
      '"integration_id": "home-assistant.home",',
      '"integration_id": "other", "integration_id": "home-assistant.home",',
    );
    expect(
      decodeCloudLinkContractMessage(new TextEncoder().encode(duplicated)),
    ).toMatchObject({
      ok: false,
      failure: {
        code: "invalid-json",
        contract_code: "DUPLICATE_JSON_KEY",
      },
    });
  });

  it.each([
    ["unsupported-version.json", "unsupported-contract-version"],
    ["unknown-field.json", "invalid-payload"],
    ["unsafe-uint64.json", "invalid-payload"],
    ["overflow-uint64.json", "invalid-payload"],
    ["oversized-payload.json", "invalid-payload"],
    ["invalid-digest.json", "invalid-payload"],
    ["conflicting-replay.json", "digest-mismatch"],
    ["payload-broker-attestation.json", "invalid-payload"],
    ["runtime-manifest-invalid-semver.json", "invalid-payload"],
    ["session-accepted-duplicate-cursor.json", "invalid-payload"],
    ["session-hello-auth-invalid.json", "invalid-payload"],
    ["session-hello-auth-required.json", "invalid-payload"],
  ] as const)("rejects shared invalid fixture %s", (name, code) => {
    expect(decodeCloudLinkContractMessage(fixture(name))).toMatchObject({
      ok: false,
      failure: { code },
    });
  });

  it("leaves stale epoch fixtures structurally valid for session fencing", () => {
    expect(
      decodeCloudLinkContractMessage(fixture("wrong-session-epoch.json")),
    ).toMatchObject({ ok: true, value: { session_epoch: "6" } });
    expect(
      decodeCloudLinkContractMessage(fixture("stale-ack.json")),
    ).toMatchObject({ ok: true, value: { session_epoch: "6" } });
  });

  it("preserves real Edge point facts and verifies the frozen digest", () => {
    const decoded = decodeCloudLinkContractMessage(
      fixture("telemetry-batch.valid.json"),
    );
    expect(decoded).toMatchObject({
      ok: true,
      value: {
        message_kind: "telemetry-batch",
        delivery: {
          position: "19",
          digest:
            "sha256:397dafb32f984e975221bb3aa13481808692d24850a201be8818dd1517f38c35",
        },
        payload: {
          topology: {
            publication_epoch: "11",
            snapshot_digest: "fx64:0123456789abcdef",
          },
          samples: [
            {
              instance_id: "42",
              point_kind: "telemetry",
              point_id: "8",
              value: 12.5,
              source_timestamp_ms: "1721000000123",
              quality: "uncertain",
            },
          ],
        },
      },
    });
  });

  it("accepts optional commissioned model binding without requiring one", () => {
    const envelope = fixtureObject(
      "telemetry-batch.valid.json",
    ) as unknown as CloudLinkDeliveryEnvelope;
    if (envelope.message_kind !== "telemetry-batch") {
      throw new Error("fixture must be telemetry");
    }
    const first = envelope.payload.samples[0];
    if (first === undefined) throw new Error("fixture must contain one sample");
    const payloadWithModel = {
      ...envelope.payload,
      samples: [
        {
          ...first,
          model: { model_id: "aether.temperature", revision: "7" },
        },
      ],
    };
    const changed = {
      ...envelope,
      delivery: {
        ...envelope.delivery,
        digest: cloudLinkBusinessDigest("telemetry-batch", payloadWithModel),
      },
      payload: payloadWithModel,
    };
    expect(decodeCloudLinkContractMessage(payload(changed))).toMatchObject({
      ok: true,
      value: { payload: { samples: [{ model: { revision: "7" } }] } },
    });
  });

  it("rejects topic identity/route mismatch and malformed transport input", () => {
    const otherGateway = "99999999-9999-4999-8999-999999999999";
    expect(
      decodeCloudLinkMqttInbound(
        `${topicPrefix}/v1/gateways/${otherGateway}/up/session`,
        fixture("session-hello.valid.json"),
        { topicPrefix },
      ),
    ).toMatchObject({ ok: false, failure: { code: "invalid-topic-binding" } });
    expect(
      decodeCloudLinkMqttInbound(
        `${topicPrefix}/v1/gateways/${gatewayId}/up/telemetry`,
        fixture("session-hello.valid.json"),
        { topicPrefix },
      ),
    ).toMatchObject({ ok: false, failure: { code: "invalid-topic-binding" } });
    expect(
      decodeCloudLinkContractMessage(new Uint8Array(1025), 1024),
    ).toMatchObject({ ok: false, failure: { code: "payload-too-large" } });
    expect(
      decodeCloudLinkContractMessage(new TextEncoder().encode("{not-json")),
    ).toMatchObject({ ok: false, failure: { code: "invalid-json" } });
  });

  it("never includes authentication material in validation errors", () => {
    const hello = fixtureObject("session-hello.valid.json");
    const credential = hello.credential_binding as Record<string, unknown>;
    const signature = hello.gateway_signature as Record<string, unknown>;
    signature.signature = "secret-proof-value-that-must-not-appear";
    credential.credential_id = "contains unsafe spaces";
    const result = decodeCloudLinkContractMessage(payload(hello));
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("secret-proof-value");
  });

  it("enforces the common 128-character key identifier bound", () => {
    const hello = fixtureObject("session-hello.valid.json");
    const helloSignature = hello.gateway_signature as Record<string, unknown>;
    hello.gateway_key_id = "g".repeat(128);
    helloSignature.key_id = "g".repeat(128);
    expect(decodeCloudLinkContractMessage(payload(hello))).toMatchObject({
      ok: true,
    });
    hello.gateway_key_id = "g".repeat(129);
    helloSignature.key_id = "g".repeat(129);
    expect(decodeCloudLinkContractMessage(payload(hello))).toMatchObject({
      ok: false,
      failure: { contract_code: "FIELD_BOUND" },
    });

    const challenge = fixtureObject("session-challenge.valid.json");
    const cloudSignature = challenge.cloud_signature as Record<string, unknown>;
    cloudSignature.key_id = "c".repeat(128);
    expect(decodeCloudLinkContractMessage(payload(challenge))).toMatchObject({
      ok: true,
    });
    cloudSignature.key_id = "c".repeat(129);
    expect(decodeCloudLinkContractMessage(payload(challenge))).toMatchObject({
      ok: false,
      failure: { contract_code: "FIELD_BOUND" },
    });
  });

  it("builds the complete broker-neutral topic set and validates downlinks", () => {
    expect(mqttUplinkFilters(topicPrefix)).toEqual([
      `${topicPrefix}/v1/gateways/+/up/session`,
      `${topicPrefix}/v1/gateways/+/up/heartbeat`,
      `${topicPrefix}/v1/gateways/+/up/manifest`,
      `${topicPrefix}/v1/gateways/+/up/telemetry`,
      `${topicPrefix}/v1/gateways/+/up/data-loss`,
    ]);
    expect(
      mqttUplinkFilters(topicPrefix, ["aether.cloudlink.integration.v1alpha1"]),
    ).toEqual([
      `${topicPrefix}/v1/gateways/+/up/session`,
      `${topicPrefix}/v1/gateways/+/up/heartbeat`,
      `${topicPrefix}/v1/gateways/+/up/manifest`,
      `${topicPrefix}/v1/gateways/+/up/telemetry`,
      `${topicPrefix}/v1/gateways/+/up/data-loss`,
      `${topicPrefix}/v1/gateways/+/up/integration/topology`,
      `${topicPrefix}/v1/gateways/+/up/integration/observations`,
    ]);
    expect(
      mqttUplinkFilters(topicPrefix, [
        "aether.cloudlink.integration-control.v1alpha1",
      ]),
    ).toEqual(mqttUplinkFilters(topicPrefix));
    expect(
      mqttUplinkFilters(topicPrefix, [
        "aether.cloudlink.integration.v1alpha1",
        "aether.cloudlink.integration-control.v1alpha1",
      ]),
    ).toEqual([
      `${topicPrefix}/v1/gateways/+/up/session`,
      `${topicPrefix}/v1/gateways/+/up/heartbeat`,
      `${topicPrefix}/v1/gateways/+/up/manifest`,
      `${topicPrefix}/v1/gateways/+/up/telemetry`,
      `${topicPrefix}/v1/gateways/+/up/data-loss`,
      `${topicPrefix}/v1/gateways/+/up/integration/topology`,
      `${topicPrefix}/v1/gateways/+/up/integration/observations`,
      `${topicPrefix}/v1/gateways/+/up/integration-control/receipts`,
    ]);
    expect(mqttDownlinkTopic(topicPrefix, gatewayId, "ack")).toBe(
      `${topicPrefix}/v1/gateways/${gatewayId}/down/ack`,
    );
    expect(mqttDownlinkTopic(topicPrefix, gatewayId, "replay")).toBe(
      `${topicPrefix}/v1/gateways/${gatewayId}/down/replay`,
    );
    expect(() => mqttUplinkFilters("unsafe//prefix")).toThrow(/invalid/);

    const accepted = fixtureObject(
      "session-accepted.valid.json",
    ) as unknown as CloudLinkSessionAccepted;
    expect(
      JSON.parse(
        new TextDecoder().decode(encodeCloudLinkMqttOutbound(accepted)),
      ),
    ).toMatchObject({
      schema: "aether.cloudlink.session-accepted.v1",
      session_epoch: "7",
    });
  });
});
