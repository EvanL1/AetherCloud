import { describe, expect, it } from "vitest";

import {
  classifyRuntimeManifestReport,
  defineRuntimeManifestObservation,
  parseGatewayId,
  parseProjectId,
  parseRuntimeManifestGeneration,
  parseTenantId,
  parseUtcInstant,
} from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");

function observation(generation = "1", digest = "a".repeat(64)) {
  return defineRuntimeManifestObservation({
    tenantId,
    projectId,
    gatewayId,
    generation: parseRuntimeManifestGeneration(generation),
    observedAt: parseUtcInstant("2026-07-14T08:00:00.000Z"),
    receivedAt: parseUtcInstant("2026-07-14T08:00:01.000Z"),
    manifest: {
      schemaVersion: 1,
      composition: "aether-edge-six-service",
      aetherVersion: "0.1.0",
      targetTriple: "aarch64-unknown-linux-musl",
      targetOs: "linux",
      services: ["aether-api", "aether-io"],
      cargoFeatures: ["aether-io/modbus"],
      capabilities: ["device.control", "point.read"],
      protocols: ["modbus_rtu", "virtual"],
      checksum: { algorithm: "sha256", digest },
    },
  });
}

describe("runtime manifest domain", () => {
  it("preserves lossless uint64 manifest generations", () => {
    expect(parseRuntimeManifestGeneration("18446744073709551615")).toBe(
      "18446744073709551615",
    );
    expect(() => parseRuntimeManifestGeneration(1)).toThrow();
    expect(() => parseRuntimeManifestGeneration("01")).toThrow();
    expect(() =>
      parseRuntimeManifestGeneration("18446744073709551616"),
    ).toThrow();
  });

  it("defines an immutable explicit runtime and capability observation", () => {
    const value = observation();

    expect(value).toMatchObject({
      tenantId,
      projectId,
      gatewayId,
      generation: "1",
      manifest: {
        schemaVersion: 1,
        capabilities: ["device.control", "point.read"],
        protocols: ["modbus_rtu", "virtual"],
      },
    });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.manifest)).toBe(true);
    expect(Object.isFrozen(value.manifest.capabilities)).toBe(true);
  });

  it("rejects non-canonical or duplicate identifier catalogs", () => {
    const input = {
      ...observation(),
      manifest: {
        ...observation().manifest,
        capabilities: ["point.read", "device.control"],
      },
    };

    expect(() => defineRuntimeManifestObservation(input)).toThrow();
    expect(() =>
      defineRuntimeManifestObservation({
        ...input,
        manifest: {
          ...input.manifest,
          capabilities: ["point.read", "point.read"],
        },
      }),
    ).toThrow();
  });

  it("classifies exact replay, conflicting generation, late history, and latest", () => {
    const current = observation("2", "b".repeat(64));

    expect(classifyRuntimeManifestReport(current, current)).toEqual({
      ok: true,
      disposition: "replayed",
      updatesLatest: false,
    });
    expect(
      classifyRuntimeManifestReport(current, observation("2", "c".repeat(64))),
    ).toMatchObject({
      ok: false,
      failure: { code: "runtime-manifest-generation-conflict" },
    });
    expect(
      classifyRuntimeManifestReport(current, observation("1", "a".repeat(64))),
    ).toEqual({ ok: true, disposition: "accepted-late", updatesLatest: false });
    expect(
      classifyRuntimeManifestReport(current, observation("3", "d".repeat(64))),
    ).toEqual({
      ok: true,
      disposition: "accepted-latest",
      updatesLatest: true,
    });
  });
});
