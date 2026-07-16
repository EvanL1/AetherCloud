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

  it("builds the complete broker-neutral topic set and validates downlinks", () => {
    expect(mqttUplinkFilters(topicPrefix)).toEqual([
      `${topicPrefix}/v1/gateways/+/up/session`,
      `${topicPrefix}/v1/gateways/+/up/heartbeat`,
      `${topicPrefix}/v1/gateways/+/up/manifest`,
      `${topicPrefix}/v1/gateways/+/up/telemetry`,
      `${topicPrefix}/v1/gateways/+/up/data-loss`,
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
