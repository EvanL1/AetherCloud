import { describe, expect, it } from "vitest";

import type { RuntimeManifestRepositoryRecordInput } from "@aether-cloud/application";
import {
  defineRuntimeManifestObservation,
  parseGatewayId,
  parseProjectId,
  parseRuntimeManifestGeneration,
  parseTenantId,
  parseUtcInstant,
  type AetherRuntimeManifestV1,
} from "@aether-cloud/domain";

import {
  InMemoryRuntimeManifestRepository,
  NodeRuntimeManifestIntegrityVerifier,
} from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");

const manifest: AetherRuntimeManifestV1 = {
  schemaVersion: 1,
  composition: "aether-edge-six-service",
  aetherVersion: "0.5.0",
  targetTriple: "x86_64-unknown-linux-gnu",
  targetOs: "linux",
  services: [
    "aether-alarm",
    "aether-api",
    "aether-automation",
    "aether-history",
    "aether-io",
    "aether-uplink",
  ],
  cargoFeatures: [
    "aether-io/aether_485",
    "aether-io/can",
    "aether-io/gpio",
    "aether-io/iec61850",
    "aether-io/modbus",
  ],
  capabilities: [
    "alarm.alert.resolve",
    "alarm.rule.manage",
    "automation.instance.manage",
    "automation.routing.manage",
    "automation.rule.execute",
    "automation.rule.manage",
    "data_processing.process",
    "data_processing.processors.health",
    "data_processing.tasks.list",
    "device.read_point",
    "device.write_point",
    "io.channel.manage",
    "io.channel.reconcile",
  ],
  protocols: [
    "aether_485",
    "can",
    "di_do",
    "iec61850",
    "modbus_rtu",
    "modbus_tcp",
    "sunspec_rtu",
    "sunspec_tcp",
    "virtual",
  ],
  checksum: {
    algorithm: "sha256",
    digest: "ea91777559b1d46f363c7155a0908076369ce690c08da305c1d3052df9b940f7",
  },
};

function recordInput(
  generation: string,
  requestId: string,
  digest = manifest.checksum.digest,
): RuntimeManifestRepositoryRecordInput {
  return {
    requestId,
    observation: defineRuntimeManifestObservation({
      tenantId,
      projectId,
      gatewayId,
      generation: parseRuntimeManifestGeneration(generation),
      observedAt: parseUtcInstant(`2026-07-14T08:0${generation}:00.000Z`),
      receivedAt: parseUtcInstant(`2026-07-14T08:1${generation}:00.000Z`),
      manifest: { ...manifest, checksum: { algorithm: "sha256", digest } },
    }),
  };
}

describe("runtime manifest in-memory adapters", () => {
  it("verifies the checksum produced by the AetherIot canonical JSON contract", async () => {
    const verifier = new NodeRuntimeManifestIntegrityVerifier();

    expect(await verifier.verify(manifest)).toBe(true);
    expect(
      await verifier.verify({
        ...manifest,
        targetTriple: "aarch64-unknown-linux-musl",
      }),
    ).toBe(false);
  });

  it("records latest, replay, late history, and a monotonic current projection", async () => {
    const repository = new InMemoryRuntimeManifestRepository();
    const generation7 = recordInput("7", "runtime-manifest-report-007");
    const generation9 = recordInput("9", "runtime-manifest-report-009");
    const generation8 = recordInput("8", "runtime-manifest-report-008");

    expect(await repository.record(generation7)).toEqual({
      outcome: "recorded-latest",
    });
    expect(await repository.record(generation7)).toEqual({
      outcome: "replayed",
    });
    expect(await repository.record(generation9)).toEqual({
      outcome: "recorded-latest",
    });
    expect(await repository.record(generation8)).toEqual({
      outcome: "recorded-late",
    });
    expect(
      await repository.findCurrent({ tenantId, projectId }, gatewayId),
    ).toEqual(generation9.observation);
    expect(
      await repository.findByGeneration(
        { tenantId, projectId },
        gatewayId,
        parseRuntimeManifestGeneration("8"),
      ),
    ).toEqual(generation8.observation);
  });

  it("rejects request reuse and generation reuse with different content", async () => {
    const repository = new InMemoryRuntimeManifestRepository();
    await repository.record(recordInput("7", "runtime-manifest-report-007"));

    expect(
      await repository.record(recordInput("8", "runtime-manifest-report-007")),
    ).toEqual({ outcome: "idempotency-conflict" });
    expect(
      await repository.record(
        recordInput("7", "runtime-manifest-report-other", "b".repeat(64)),
      ),
    ).toEqual({ outcome: "generation-conflict" });
  });

  it("does not disclose current or history across tenant scope", async () => {
    const repository = new InMemoryRuntimeManifestRepository();
    await repository.record(recordInput("7", "runtime-manifest-report-007"));
    const otherTenantId = parseTenantId("99999999-9999-4999-8999-999999999999");

    expect(
      await repository.findCurrent(
        { tenantId: otherTenantId, projectId },
        gatewayId,
      ),
    ).toBeUndefined();
    expect(
      await repository.findByGeneration(
        { tenantId: otherTenantId, projectId },
        gatewayId,
        parseRuntimeManifestGeneration("7"),
      ),
    ).toBeUndefined();
  });
});
