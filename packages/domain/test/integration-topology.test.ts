import { describe, expect, it } from "vitest";

import {
  InvalidDomainValueError,
  defineIntegrationObservationBatch,
  defineIntegrationTopologySnapshot,
} from "../src/index.js";

const topologyInput = {
  schema: "aether.integration.topology-snapshot.v1alpha1",
  integrationId: "home-assistant:home",
  integrationKind: "home-assistant",
  snapshotGeneration: "12",
  observedAtMs: "1784016000000",
  areas: [{ areaId: "area:kitchen", name: "Kitchen" }],
  devices: [
    {
      deviceId: "device:climate",
      name: "Kitchen climate",
      areaId: "area:kitchen",
      manufacturer: "Example",
      model: "Thermostat 1",
    },
  ],
  entities: [
    {
      entityId: "entity-registry:climate-kitchen",
      sourceAddress: "climate.kitchen",
      name: "Kitchen climate",
      entityKind: "climate",
      deviceId: "device:climate",
      areaId: "area:kitchen",
      points: [
        {
          pointKey: "state",
          title: "Mode",
          kind: "status",
          valueType: "string",
        },
        {
          pointKey: "current_temperature",
          title: "Current temperature",
          kind: "telemetry",
          valueType: "float64",
          unit: "°C",
        },
      ],
    },
  ],
} as const;

describe("integration topology", () => {
  it("defines a vendor-neutral multi-point topology snapshot", () => {
    const snapshot = defineIntegrationTopologySnapshot(topologyInput);
    const initial = defineIntegrationTopologySnapshot({
      ...topologyInput,
      snapshotGeneration: "0",
    });

    expect(snapshot.integrationKind).toBe("home-assistant");
    expect(initial.snapshotGeneration).toBe("0");
    expect(snapshot.entities[0]?.points.map((point) => point.pointKey)).toEqual(
      ["state", "current_temperature"],
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() =>
      defineIntegrationTopologySnapshot({
        ...topologyInput,
        areas: [{ areaId: "area:kitchen", name: "😀".repeat(256) }],
      }),
    ).not.toThrow();
    expect(() =>
      defineIntegrationTopologySnapshot({
        ...topologyInput,
        areas: [{ areaId: "area:kitchen", name: "😀".repeat(257) }],
      }),
    ).toThrow(InvalidDomainValueError);
  });

  it("keeps unit text separate from display-text restrictions", () => {
    const snapshot = defineIntegrationTopologySnapshot({
      ...topologyInput,
      entities: [
        {
          ...topologyInput.entities[0],
          points: [
            {
              ...topologyInput.entities[0].points[1],
              unit: " \u0007",
            },
          ],
        },
      ],
    });

    expect(snapshot.entities[0]?.points[0]?.unit).toBe(" \u0007");
  });

  it("rejects duplicate identities, duplicate point keys, and dangling references", () => {
    expect(() =>
      defineIntegrationTopologySnapshot({
        ...topologyInput,
        entities: [
          topologyInput.entities[0],
          {
            ...topologyInput.entities[0],
            name: "Duplicate identity",
          },
        ],
      }),
    ).toThrow(InvalidDomainValueError);

    expect(() =>
      defineIntegrationTopologySnapshot({
        ...topologyInput,
        entities: [
          {
            ...topologyInput.entities[0],
            points: [
              topologyInput.entities[0].points[0],
              {
                ...topologyInput.entities[0].points[0],
                title: "Duplicate point",
              },
            ],
          },
        ],
      }),
    ).toThrow(InvalidDomainValueError);

    expect(() =>
      defineIntegrationTopologySnapshot({
        ...topologyInput,
        devices: [
          {
            ...topologyInput.devices[0],
            areaId: "area:missing",
          },
        ],
      }),
    ).toThrow(InvalidDomainValueError);
  });

  it("reports identity conflicts before dangling references", () => {
    try {
      defineIntegrationTopologySnapshot({
        ...topologyInput,
        devices: [
          {
            ...topologyInput.devices[0],
            areaId: "area:missing",
          },
          {
            ...topologyInput.devices[0],
            areaId: "area:also-missing",
          },
        ],
      });
      throw new Error("expected topology validation to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidDomainValueError);
      expect((error as InvalidDomainValueError).field).toBe("deviceId");
    }
  });

  it("binds observation generation, entity, point, value type, and quality", () => {
    const snapshot = defineIntegrationTopologySnapshot(topologyInput);
    const batch = defineIntegrationObservationBatch(
      {
        schema: "aether.integration.observation-batch.v1alpha1",
        integrationId: "home-assistant:home",
        snapshotGeneration: "12",
        batchId: "ha-event-0001",
        observedAtMs: "1784016000100",
        observations: [
          {
            entityId: "entity-registry:climate-kitchen",
            pointKey: "current_temperature",
            observedAtMs: "1784016000100",
            quality: "good",
            value: { type: "float64", value: 21.5 },
          },
          {
            entityId: "entity-registry:climate-kitchen",
            pointKey: "state",
            observedAtMs: "1784016000100",
            quality: "unavailable",
            diagnostic: "provider reported unavailable",
          },
        ],
      },
      snapshot,
    );

    expect(batch.observations).toHaveLength(2);
    expect(Object.isFrozen(batch.observations)).toBe(true);

    expect(() =>
      defineIntegrationObservationBatch(
        {
          ...batch,
          observations: [
            {
              entityId: "entity-registry:climate-kitchen",
              pointKey: "current_temperature",
              observedAtMs: "1784016000100",
              quality: "good",
              value: { type: "string", value: "21.5" },
            },
          ],
        },
        snapshot,
      ),
    ).toThrow(InvalidDomainValueError);

    expect(() =>
      defineIntegrationObservationBatch(
        {
          ...batch,
          observations: [
            {
              entityId: "entity-registry:climate-kitchen",
              pointKey: "state",
              observedAtMs: "1784016000100",
              quality: "unavailable",
              value: { type: "string", value: "unknown" },
            },
          ],
        },
        snapshot,
      ),
    ).toThrow(InvalidDomainValueError);
  });

  it("preserves exact scalar boundaries without JavaScript number coercion", () => {
    const snapshot = defineIntegrationTopologySnapshot({
      ...topologyInput,
      entities: [
        {
          ...topologyInput.entities[0],
          points: [
            {
              pointKey: "counter",
              title: "Counter",
              kind: "telemetry",
              valueType: "uint64",
            },
            {
              pointKey: "energy",
              title: "Energy",
              kind: "telemetry",
              valueType: "decimal",
            },
            {
              pointKey: "payload",
              title: "Payload",
              kind: "event",
              valueType: "bytes",
            },
          ],
        },
      ],
    });

    const batch = defineIntegrationObservationBatch(
      {
        schema: "aether.integration.observation-batch.v1alpha1",
        integrationId: "home-assistant:home",
        snapshotGeneration: "12",
        batchId: "ha-event-0002",
        observedAtMs: "1784016000200",
        observations: [
          {
            entityId: "entity-registry:climate-kitchen",
            pointKey: "counter",
            observedAtMs: "1784016000200",
            quality: "good",
            value: { type: "uint64", value: "18446744073709551615" },
          },
          {
            entityId: "entity-registry:climate-kitchen",
            pointKey: "energy",
            observedAtMs: "1784016000200",
            quality: "good",
            value: { type: "decimal", value: "999999999999999999.125" },
          },
          {
            entityId: "entity-registry:climate-kitchen",
            pointKey: "payload",
            observedAtMs: "1784016000200",
            quality: "good",
            value: {
              type: "bytes",
              encoding: "base64url",
              value: "AAECAwQF",
            },
          },
        ],
      },
      snapshot,
    );

    expect(batch.observations[0]?.value).toEqual({
      type: "uint64",
      value: "18446744073709551615",
    });
    expect(() =>
      defineIntegrationObservationBatch(
        {
          ...batch,
          observations: [
            {
              entityId: "entity-registry:climate-kitchen",
              pointKey: "counter",
              observedAtMs: "1784016000200",
              quality: "good",
              value: { type: "uint64", value: "18446744073709551616" },
            },
          ],
        },
        snapshot,
      ),
    ).toThrow(InvalidDomainValueError);
  });

  it("accepts repeated point observations and rejects unsafe integer-like float64 values", () => {
    const snapshot = defineIntegrationTopologySnapshot(topologyInput);
    const repeated = defineIntegrationObservationBatch(
      {
        schema: "aether.integration.observation-batch.v1alpha1",
        integrationId: "home-assistant:home",
        snapshotGeneration: "12",
        batchId: "ha-event-repeated",
        observedAtMs: "1784016000300",
        observations: [
          {
            entityId: "entity-registry:climate-kitchen",
            pointKey: "current_temperature",
            observedAtMs: "1784016000200",
            quality: "good",
            value: { type: "float64", value: 21.5 },
          },
          {
            entityId: "entity-registry:climate-kitchen",
            pointKey: "current_temperature",
            observedAtMs: "1784016000300",
            quality: "good",
            value: { type: "float64", value: 22 },
          },
        ],
      },
      snapshot,
    );

    expect(repeated.observations).toHaveLength(2);
    expect(() =>
      defineIntegrationObservationBatch(
        {
          ...repeated,
          observations: [
            {
              entityId: "entity-registry:climate-kitchen",
              pointKey: "current_temperature",
              observedAtMs: "1784016000300",
              quality: "good",
              value: { type: "float64", value: 1e100 },
            },
          ],
        },
        snapshot,
      ),
    ).toThrow(InvalidDomainValueError);
    expect(() =>
      defineIntegrationObservationBatch(
        {
          ...repeated,
          observations: [
            {
              entityId: "entity-registry:climate-kitchen",
              pointKey: "current_temperature",
              observedAtMs: "1784016000300",
              quality: "good",
              value: { type: "float64", value: Number.MAX_VALUE },
            },
          ],
        },
        snapshot,
      ),
    ).not.toThrow();
  });
});
