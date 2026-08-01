import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { composeCloudLinkRuntime } from "../src/runtime.js";

// These exercise the decoder in trusted-connector-credentials.ts through the
// composition root, which is the only place operator configuration enters.
const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const gatewayId = "33333333-3333-4333-8333-333333333333";
const credentialId = "development-binding-17";

/** Generated per run so no credential-shaped literal is committed. */
const proof = randomBytes(48).toString("base64url");

function credentialEntries(
  ...overrides: readonly Record<string, unknown>[]
): readonly Record<string, unknown>[] {
  return overrides.length === 0
    ? [{ gatewayId, credentialId, generation: "3", proof }]
    : overrides.map((override) => ({
        gatewayId,
        credentialId,
        generation: "3",
        proof,
        ...override,
      }));
}

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AETHER_CLOUD_CLOUDLINK_MQTT_URL: "mqtt://127.0.0.1:1883",
    AETHER_CLOUD_CLOUDLINK_TOPIC_PREFIX: "aethercloud",
    AETHER_CLOUD_TENANT_ID: tenantId,
    AETHER_CLOUD_PROJECT_ID: projectId,
    AETHER_CLOUD_CLOUDLINK_TRUSTED_GATEWAY_CREDENTIALS:
      JSON.stringify(credentialEntries()),
    ...overrides,
  };
}

describe("trusted connector credential configuration", () => {
  const variable = "AETHER_CLOUD_CLOUDLINK_TRUSTED_GATEWAY_CREDENTIALS";

  function rejects(value: string, message: string): void {
    expect(() =>
      composeCloudLinkRuntime(environment({ [variable]: value })),
    ).toThrow(message);
  }

  it("rejects a value that is not JSON", () => {
    rejects("{not json", `${variable} must be a JSON array`);
  });

  it("rejects a JSON value that is not an array", () => {
    rejects(
      JSON.stringify(credentialEntries()[0]),
      `${variable} must be a JSON array`,
    );
  });

  it("rejects an empty array so the ingress never starts unauthenticated", () => {
    rejects("[]", `${variable} must declare 1-64 Gateway credentials`);
  });

  it("rejects more credentials than the A0 deployment bound", () => {
    const entries = Array.from({ length: 65 }, (_unused, index) => ({
      credentialId: `binding-${String(index)}`,
    }));
    rejects(
      JSON.stringify(credentialEntries(...entries)),
      `${variable} must declare 1-64 Gateway credentials`,
    );
  });

  it("rejects an unknown field instead of silently ignoring it", () => {
    rejects(
      JSON.stringify(credentialEntries({ status: "active" })),
      `${variable} entries must declare exactly gatewayId, credentialId, generation, and proof`,
    );
  });

  it("rejects a missing field", () => {
    rejects(
      JSON.stringify([{ gatewayId, credentialId, generation: "3" }]),
      `${variable} entries must declare exactly gatewayId, credentialId, generation, and proof`,
    );
  });

  it("rejects a Gateway identity that is not a canonical UUID", () => {
    rejects(
      JSON.stringify(credentialEntries({ gatewayId: "gateway-a0" })),
      `${variable} gatewayId must be a canonical lowercase UUID`,
    );
  });

  // Length alone is not enough: the envelope schema bounds the charset, so a
  // credentialId outside it composes and starts cleanly, then loses every
  // session hello at decode.
  it("rejects a credentialId outside the CloudLink contract charset", () => {
    for (const credentialIdValue of [
      "home gateway #1",
      "-leading-hyphen",
      "café-gateway",
    ]) {
      rejects(
        JSON.stringify(credentialEntries({ credentialId: credentialIdValue })),
        `${variable} credentialId must be`,
      );
    }
  });

  it("rejects a credential generation above the uint64 range", () => {
    rejects(
      JSON.stringify(credentialEntries({ generation: "18446744073709551616" })),
      `${variable} generation must be a canonical uint64 string`,
    );
  });

  it("rejects a credential generation that is not a canonical uint64", () => {
    rejects(
      JSON.stringify(credentialEntries({ generation: "03" })),
      `${variable} generation must be a canonical uint64 string`,
    );
  });

  it("rejects an empty credentialId", () => {
    rejects(
      JSON.stringify(credentialEntries({ credentialId: "" })),
      `${variable} credentialId must be 1-256 characters`,
    );
  });

  it("rejects a duplicate credentialId", () => {
    rejects(
      JSON.stringify(credentialEntries({}, { gatewayId })),
      `${variable} credentialId values must be unique`,
    );
  });

  it("rejects a proof larger than the CloudLink bound", () => {
    rejects(
      JSON.stringify(credentialEntries({ proof: "B".repeat(4097) })),
      `${variable} proof must be 1-4096 bytes`,
    );
  });

  it("never echoes the proof in a rejection message", () => {
    const secret = randomBytes(24).toString("base64url");
    let thrown: unknown;
    try {
      composeCloudLinkRuntime(
        environment({
          [variable]: JSON.stringify(
            credentialEntries({ proof: secret, generation: "03" }),
          ),
        }),
      );
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const rendered = `${String(thrown)}\n${(thrown as Error).stack ?? ""}`;
    expect(rendered).toContain(variable);
    expect(rendered).not.toContain(secret);
  });
});
