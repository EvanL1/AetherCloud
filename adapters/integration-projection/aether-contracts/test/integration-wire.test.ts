import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  IntegrationWireError,
  decodeIntegrationObservationEnvelope,
  decodeIntegrationObservationPayload,
  decodeIntegrationObservationPayloadInput,
  decodeIntegrationObservedValue,
  decodeIntegrationTopologyEnvelope,
  decodeIntegrationTopologyPayload,
  toReportIntegrationObservationsInput,
  toReportIntegrationTopologyInput,
} from "../src/index.js";

const candidateRoot = new URL(
  "../../../../contracts/aether-contracts/v0.1.0-alpha.4-candidate/",
  import.meta.url,
);
const fixtureRoot = new URL("fixtures/integration/v1alpha1/", candidateRoot);

async function fixture(path: string): Promise<Uint8Array> {
  return readFile(new URL(path, fixtureRoot));
}

async function fixtureValue(path: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(path, fixtureRoot), "utf8"),
  ) as unknown;
}

const credential = {
  credential_id: "gateway-credential-003",
  proof: "opaque-test-proof",
} as const;

function envelope(payload: unknown): string {
  return JSON.stringify({ credential, payload });
}

function expectWireFailure(operation: () => unknown, code: string): void {
  let captured: unknown;
  try {
    operation();
  } catch (error: unknown) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(Error);
  expect((captured as { readonly code?: unknown }).code).toBe(code);
}

function testRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("test fixture value is not an object");
  }
  return input as Record<string, unknown>;
}

function testArray(input: unknown): unknown[] {
  if (!Array.isArray(input)) {
    throw new TypeError("test fixture value is not an array");
  }
  return input;
}

describe("AetherContracts integration v1alpha1 wire adapter", () => {
  it("maps the official topology fixture from closed snake_case wire data", async () => {
    const topology = decodeIntegrationTopologyPayload(
      await fixture("valid/home-assistant-topology.json"),
    );

    expect(topology).toMatchObject({
      integrationId: "home-assistant.home",
      integrationKind: "home-assistant",
      snapshotGeneration: "1",
    });
    expect(topology.entities[0]).toMatchObject({
      entityId: "entity-registry-climate-living",
      sourceAddress: "climate.living_room",
    });
    expect(topology.entities[0]?.points[0]).toMatchObject({
      pointKey: "current_temperature",
      valueType: "float64",
    });
    expect(Object.isFrozen(topology)).toBe(true);
  });

  it("maps the official observation fixture against the accepted topology", async () => {
    const topology = decodeIntegrationTopologyPayload(
      await fixture("valid/home-assistant-topology.json"),
    );
    const batch = decodeIntegrationObservationPayload(
      await fixture("valid/home-assistant-observations.json"),
      topology,
    );

    expect(batch).toMatchObject({
      integrationId: "home-assistant.home",
      snapshotGeneration: "1",
      batchId: "batch-0001",
    });
    expect(batch.observations[0]).toMatchObject({
      pointKey: "current_temperature",
      value: { type: "float64", value: 23.5 },
    });
    expect(Object.isFrozen(batch)).toBe(true);
  });

  it("keeps credentials in a closed outer envelope and outside the public payload", async () => {
    const payload = await fixtureValue("valid/home-assistant-topology.json");
    const decoded = decodeIntegrationTopologyEnvelope(envelope(payload));

    expect(decoded.credential).toEqual({
      credentialId: "gateway-credential-003",
      proof: "opaque-test-proof",
    });
    expect(decoded.payload).not.toHaveProperty("credential");
    expect(decoded.payload).not.toHaveProperty("credentialId");
    expect(decoded.payload).not.toHaveProperty("proof");

    const applicationInput = toReportIntegrationTopologyInput(decoded);
    expect(applicationInput).toMatchObject({
      credential: decoded.credential,
      integrationId: "home-assistant.home",
      snapshotGeneration: "1",
    });
  });

  it("maps an observation envelope into the current application command input", async () => {
    const payload = await fixtureValue(
      "valid/home-assistant-observations.json",
    );
    const decoded = decodeIntegrationObservationEnvelope(envelope(payload));

    const applicationInput = toReportIntegrationObservationsInput(decoded);
    expect(applicationInput).toMatchObject({
      credential: {
        credentialId: "gateway-credential-003",
        proof: "opaque-test-proof",
      },
      batchId: "batch-0001",
    });
    expect(applicationInput.observations[0]).toMatchObject({
      entityId: "entity-registry-climate-living",
    });
  });

  it("leaves topology resolution to the authenticated application command", async () => {
    const raw = await fixture("invalid/observation-dangling-point.json");
    const wireInput = decodeIntegrationObservationPayloadInput(raw);
    const decoded = decodeIntegrationObservationEnvelope(
      envelope(await fixtureValue("invalid/observation-dangling-point.json")),
    );

    expect(wireInput.observations[0]).toMatchObject({
      pointKey: "missing_point",
    });
    expect(
      toReportIntegrationObservationsInput(decoded).observations[0],
    ).toMatchObject({ pointKey: "missing_point" });
  });

  it("rejects credentials flattened into or added beside a public payload", async () => {
    const payload = await fixtureValue("valid/home-assistant-topology.json");

    expectWireFailure(
      () =>
        decodeIntegrationTopologyPayload(
          JSON.stringify({ ...(payload as object), access_token: "secret" }),
        ),
      "UNKNOWN_FIELD",
    );
    expectWireFailure(
      () =>
        decodeIntegrationTopologyEnvelope(
          JSON.stringify({
            credential,
            payload,
            access_token: "secret",
          }),
        ),
      "UNKNOWN_FIELD",
    );
    expectWireFailure(
      () =>
        decodeIntegrationTopologyEnvelope(
          JSON.stringify({
            credential: { ...credential, access_token: "secret" },
            payload,
          }),
        ),
      "UNKNOWN_FIELD",
    );
  });

  it("rejects camelCase aliases instead of silently accepting a mixed wire shape", async () => {
    const payload = await fixtureValue("valid/home-assistant-topology.json");
    const record = payload as Record<string, unknown>;
    const { integration_id: integrationId, ...withoutIntegrationId } = record;

    expectWireFailure(
      () =>
        decodeIntegrationTopologyPayload(
          JSON.stringify({ ...withoutIntegrationId, integrationId }),
        ),
      "UNKNOWN_FIELD",
    );
  });

  it("fails closed on malformed topology fields before domain mapping", async () => {
    const original = testRecord(
      await fixtureValue("valid/home-assistant-topology.json"),
    );
    const expectMutation = (
      mutate: (payload: Record<string, unknown>) => void,
      code: string,
    ): void => {
      const payload = structuredClone(original);
      mutate(payload);
      expectWireFailure(
        () => decodeIntegrationTopologyPayload(JSON.stringify(payload)),
        code,
      );
    };

    expectWireFailure(
      () => decodeIntegrationTopologyPayload("null"),
      "FIELD_TYPE",
    );
    expectMutation((payload) => {
      delete payload.schema;
    }, "REQUIRED_FIELD_MISSING");
    expectMutation((payload) => {
      payload.schema = "aether.integration.topology-snapshot.v2";
    }, "SCHEMA_UNSUPPORTED");
    expectMutation((payload) => {
      payload.integration_id = 3;
    }, "FIELD_TYPE");
    expectMutation((payload) => {
      payload.integration_id = "";
    }, "FIELD_BOUND");
    expectMutation((payload) => {
      payload.integration_id = "contains space";
    }, "VALUE_ENCODING_INVALID");
    expectMutation((payload) => {
      payload.areas = {};
    }, "FIELD_TYPE");
    expectMutation((payload) => {
      payload.snapshot_generation = 3;
    }, "FIELD_TYPE");
    expectMutation((payload) => {
      payload.snapshot_generation = "000000000000000000000";
    }, "INTEGER_OUT_OF_RANGE");
    expectMutation((payload) => {
      payload.snapshot_generation = "01";
    }, "INTEGER_NON_CANONICAL");
    expectMutation((payload) => {
      payload.snapshot_generation = "18446744073709551616";
    }, "INTEGER_OUT_OF_RANGE");
    expectMutation((payload) => {
      testArray(payload.areas)[0] = null;
    }, "FIELD_TYPE");
    expectMutation((payload) => {
      const point = testRecord(
        testArray(testRecord(testArray(payload.entities)[0]).points)[0],
      );
      point.kind = "configuration";
    }, "VALUE_ENCODING_INVALID");
    expectMutation((payload) => {
      const point = testRecord(
        testArray(testRecord(testArray(payload.entities)[0]).points)[0],
      );
      point.value_type = "json";
    }, "VALUE_ENCODING_INVALID");

    const withHardware = structuredClone(original);
    testRecord(testArray(withHardware.devices)[0]).hardware_version = "rev-a";
    expect(
      decodeIntegrationTopologyPayload(JSON.stringify(withHardware)).devices[0],
    ).toMatchObject({ hardwareVersion: "rev-a" });

    const unicodeBoundary = structuredClone(original);
    testRecord(testArray(unicodeBoundary.areas)[0]).name = "🌍".repeat(256);
    expect(
      decodeIntegrationTopologyPayload(JSON.stringify(unicodeBoundary)).areas[0]
        ?.name,
    ).toBe("🌍".repeat(256));
    testRecord(testArray(unicodeBoundary.areas)[0]).name = "🌍".repeat(257);
    expectWireFailure(
      () => decodeIntegrationTopologyPayload(JSON.stringify(unicodeBoundary)),
      "FIELD_BOUND",
    );
  });

  it("returns the official contextual failure codes", async () => {
    const topology = decodeIntegrationTopologyPayload(
      await fixture("valid/home-assistant-topology.json"),
    );
    const cases = [
      ["invalid/topology-duplicate-entity.json", "IDENTITY_CONFLICT"],
      ["invalid/topology-dangling-device-area.json", "REFERENCE_NOT_FOUND"],
    ] as const;
    for (const [path, code] of cases) {
      const raw = await fixture(path);
      expectWireFailure(() => decodeIntegrationTopologyPayload(raw), code);
    }

    for (const [path, code] of [
      ["invalid/observation-dangling-point.json", "REFERENCE_NOT_FOUND"],
      ["invalid/observation-type-mismatch.json", "VALUE_TYPE_MISMATCH"],
      [
        "invalid/observation-good-without-value.json",
        "OBSERVATION_VALUE_INVALID",
      ],
      [
        "invalid/observation-unavailable-with-value.json",
        "OBSERVATION_VALUE_INVALID",
      ],
    ] as const) {
      const raw = await fixture(path);
      expectWireFailure(
        () => decodeIntegrationObservationPayload(raw, topology),
        code,
      );
    }
  });

  it("rejects the official display and diagnostic text failures with the frozen code", async () => {
    const invalidTopology = await fixture(
      "invalid/topology-display-text-invalid.json",
    );
    const invalidObservations = await fixture(
      "invalid/observation-diagnostic-text-invalid.json",
    );
    expectWireFailure(
      () => decodeIntegrationTopologyPayload(invalidTopology),
      "TEXT_INVALID",
    );
    expectWireFailure(
      () => decodeIntegrationObservationPayloadInput(invalidObservations),
      "TEXT_INVALID",
    );
  });

  it("checks topology identity conflicts before dangling references", async () => {
    const duplicate = (await fixtureValue(
      "invalid/topology-duplicate-entity.json",
    )) as {
      entities: Array<Record<string, unknown>>;
    };
    const first = duplicate.entities[0];
    if (first === undefined) {
      throw new TypeError("candidate fixture has no entity");
    }
    first.area_id = "also-missing";

    expectWireFailure(
      () => decodeIntegrationTopologyPayload(JSON.stringify(duplicate)),
      "IDENTITY_CONFLICT",
    );
  });

  it("reports integration or generation mismatch as an unresolved topology reference", async () => {
    const topology = decodeIntegrationTopologyPayload(
      await fixture("valid/home-assistant-topology.json"),
    );
    const batch = (await fixtureValue(
      "valid/home-assistant-observations.json",
    )) as Record<string, unknown>;

    expectWireFailure(
      () =>
        decodeIntegrationObservationPayload(
          JSON.stringify({ ...batch, snapshot_generation: "2" }),
          topology,
        ),
      "REFERENCE_NOT_FOUND",
    );
  });

  it("fails closed on malformed observation fields and values", async () => {
    const topology = decodeIntegrationTopologyPayload(
      await fixture("valid/home-assistant-topology.json"),
    );
    const original = testRecord(
      await fixtureValue("valid/home-assistant-observations.json"),
    );
    const expectMutation = (
      mutate: (payload: Record<string, unknown>) => void,
      code: string,
    ): void => {
      const payload = structuredClone(original);
      mutate(payload);
      expectWireFailure(
        () =>
          decodeIntegrationObservationPayload(
            JSON.stringify(payload),
            topology,
          ),
        code,
      );
    };

    expectMutation((payload) => {
      payload.schema = "aether.integration.observation-batch.v2";
    }, "SCHEMA_UNSUPPORTED");
    expectMutation((payload) => {
      payload.observations = [];
    }, "FIELD_BOUND");
    expectMutation((payload) => {
      testRecord(testArray(payload.observations)[0]).quality = "unknown";
    }, "VALUE_ENCODING_INVALID");
    expectMutation((payload) => {
      testRecord(testArray(payload.observations)[0]).observed_at_ms = {};
    }, "FIELD_TYPE");
    expectMutation((payload) => {
      testRecord(testArray(payload.observations)[0]).unexpected = true;
    }, "UNKNOWN_FIELD");
    expectMutation((payload) => {
      const observation = testRecord(testArray(payload.observations)[0]);
      observation.diagnostic = "";
    }, "FIELD_BOUND");

    for (const [source, code] of [
      [
        '{"type":"bytes","encoding":"hex","value":"AA"}',
        "VALUE_ENCODING_INVALID",
      ],
      ['{"type":"boolean","value":"true"}', "FIELD_TYPE"],
      ['{"type":"int64","value":1}', "FIELD_TYPE"],
      ['{"type":"uint64","value":1}', "FIELD_TYPE"],
      ['{"type":"float64","value":"1.5"}', "FIELD_TYPE"],
      ['{"type":"json","value":"{}"}', "VALUE_ENCODING_INVALID"],
      ['{"type":"string","value":"","extra":true}', "UNKNOWN_FIELD"],
    ] as const) {
      expectWireFailure(() => decodeIntegrationObservedValue(source), code);
    }
    expect(
      decodeIntegrationObservedValue('{"type":"string","value":""}'),
    ).toEqual({ type: "string", value: "" });
  });

  it("returns the official wire failure codes for unknown fields and value encodings", async () => {
    const raw = await fixture("invalid/topology-unknown-field.json");
    expectWireFailure(
      () => decodeIntegrationTopologyPayload(raw),
      "UNKNOWN_FIELD",
    );
  });

  it("rejects official standalone invalid observed values", async () => {
    for (const [path, code] of [
      ["invalid/value-int64-overflow.json", "INTEGER_OUT_OF_RANGE"],
      ["invalid/value-uint64-overflow.json", "INTEGER_OUT_OF_RANGE"],
      ["invalid/value-decimal-noncanonical.json", "VALUE_ENCODING_INVALID"],
      ["invalid/value-bytes-noncanonical.json", "VALUE_ENCODING_INVALID"],
    ] as const) {
      const raw = await fixture(path);
      expectWireFailure(() => decodeIntegrationObservedValue(raw), code);
    }
  });

  it("uses INTEGER_OUT_OF_RANGE precedence for overlength integer strings", () => {
    expectWireFailure(
      () =>
        decodeIntegrationObservedValue(
          '{"type":"uint64","value":"000000000000000000000"}',
        ),
      "INTEGER_OUT_OF_RANGE",
    );
    expectWireFailure(
      () =>
        decodeIntegrationObservedValue(
          '{"type":"int64","value":"-000000000000000000000"}',
        ),
      "INTEGER_OUT_OF_RANGE",
    );
    expectWireFailure(
      () =>
        decodeIntegrationObservedValue(
          `{"type":"uint64","value":"${"🌍".repeat(6)}"}`,
        ),
      "INTEGER_OUT_OF_RANGE",
    );
    expectWireFailure(
      () =>
        decodeIntegrationObservedValue(
          `{"type":"uint64","value":"${"🌍".repeat(5)}"}`,
        ),
      "INTEGER_NON_CANONICAL",
    );
  });

  it("rejects dangerous finite float64 tokens before domain mapping", async () => {
    const payload = await fixtureValue(
      "valid/home-assistant-observations.json",
    );
    const text = JSON.stringify(payload).replace("23.5", "1.5e20");
    const topology = decodeIntegrationTopologyPayload(
      await fixture("valid/home-assistant-topology.json"),
    );

    expectWireFailure(
      () => decodeIntegrationObservationPayload(text, topology),
      "JSON_UNSAFE_NUMBER",
    );
  });

  it("exposes sanitized stable errors without including credential proof", async () => {
    const payload = await fixtureValue("valid/home-assistant-topology.json");
    let captured: unknown;
    try {
      decodeIntegrationTopologyEnvelope(
        JSON.stringify({
          credential: { credential_id: "id", proof: "" },
          payload,
        }),
      );
    } catch (error: unknown) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(IntegrationWireError);
    expect(captured).toMatchObject({ code: "FIELD_BOUND" });
    expect(String(captured)).not.toContain("opaque-test-proof");
  });
});
