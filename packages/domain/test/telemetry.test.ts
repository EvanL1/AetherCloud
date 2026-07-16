import { describe, expect, it } from "vitest";

import {
  defineTelemetryBatch,
  parseDeviceEventId,
  parseEdgeInstanceId,
  parseEdgePointId,
  parseSourceTimestampMs,
  parseTelemetryStreamEpoch,
  parseTelemetryStreamId,
  parseTelemetryStreamPosition,
  parseThingModelRevision,
  parseTopologyPublicationEpoch,
  parseTopologySnapshotDigest,
} from "../src/index.js";

const model = {
  modelId: "aether.temperature-sensor",
  revision: parseThingModelRevision("7"),
} as const;

function topology() {
  return {
    publicationEpoch: parseTopologyPublicationEpoch("11"),
    snapshotDigest: parseTopologySnapshotDigest("fx64:0123456789abcdef"),
  };
}

function point(position: string) {
  return {
    kind: "point-sample" as const,
    position: parseTelemetryStreamPosition(position),
    sourceTimestampMs: parseSourceTimestampMs("1784016000000"),
    instanceId: parseEdgeInstanceId("42"),
    pointKind: "telemetry" as const,
    pointId: parseEdgePointId("7"),
    quality: "good" as const,
    value: { type: "float64" as const, value: 21.5 },
  };
}

function event(position: string) {
  return {
    kind: "device-event" as const,
    position: parseTelemetryStreamPosition(position),
    sourceTimestampMs: parseSourceTimestampMs("1784016000100"),
    eventId: parseDeviceEventId("44444444-4444-4444-8444-444444444444"),
    eventType: "device.connection.v1",
    instanceId: parseEdgeInstanceId("42"),
    payload: { connected: true, reason: "recovered" },
    model,
  };
}

describe("IoT telemetry domain", () => {
  it("preserves protocol-width identifiers without JavaScript number conversion", () => {
    expect(parseTelemetryStreamPosition("18446744073709551615")).toBe(
      "18446744073709551615",
    );
    expect(parseSourceTimestampMs("18446744073709551615")).toBe(
      "18446744073709551615",
    );
    expect(() => parseTelemetryStreamPosition("18446744073709551616")).toThrow(
      /unsigned 64-bit/,
    );
    expect(() => parseEdgePointId("4294967296")).toThrow(/unsigned 32-bit/);
  });

  it("defines an immutable atomic batch with stable stream identity", () => {
    const batch = defineTelemetryBatch({
      streamId: parseTelemetryStreamId("business-telemetry"),
      streamEpoch: parseTelemetryStreamEpoch("3"),
      topology: topology(),
      retentionClass: "standard-30d",
      replay: false,
      records: [point("10"), event("11")],
    });

    expect(batch).toMatchObject({
      batchIdentity: "business-telemetry:3:10",
      topology: {
        publicationEpoch: "11",
        snapshotDigest: "fx64:0123456789abcdef",
      },
      firstPosition: "10",
      lastPosition: "11",
      recordCount: 2,
    });
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.records)).toBe(true);
    expect(Object.isFrozen(batch.records[1])).toBe(true);
  });

  it("rejects non-contiguous positions and invalid point values atomically", () => {
    expect(() =>
      defineTelemetryBatch({
        streamId: parseTelemetryStreamId("business-telemetry"),
        streamEpoch: parseTelemetryStreamEpoch("3"),
        topology: topology(),
        retentionClass: "standard-30d",
        replay: false,
        records: [point("10"), event("12")],
      }),
    ).toThrow(/contiguous/);
    expect(() =>
      defineTelemetryBatch({
        streamId: parseTelemetryStreamId("business-telemetry"),
        streamEpoch: parseTelemetryStreamEpoch("3"),
        topology: topology(),
        retentionClass: "standard-30d",
        replay: false,
        records: [
          { ...point("10"), value: { type: "float64", value: Number.NaN } },
        ],
      }),
    ).toThrow(/finite/);
  });

  it("validates signed int64 and bounded event payloads", () => {
    expect(
      defineTelemetryBatch({
        streamId: parseTelemetryStreamId("business-telemetry"),
        streamEpoch: parseTelemetryStreamEpoch("3"),
        topology: topology(),
        retentionClass: "hot-7d",
        replay: true,
        records: [
          {
            ...point("0"),
            value: { type: "int64", value: "-9223372036854775808" },
          },
        ],
      }).records[0],
    ).toMatchObject({ value: { value: "-9223372036854775808" } });
    expect(() =>
      defineTelemetryBatch({
        streamId: parseTelemetryStreamId("business-telemetry"),
        streamEpoch: parseTelemetryStreamEpoch("3"),
        topology: topology(),
        retentionClass: "hot-7d",
        replay: false,
        records: [
          {
            ...event("0"),
            payload: Object.fromEntries(
              Array.from({ length: 17 }, (_, index) => [
                `field${String(index)}`,
                index,
              ]),
            ),
          },
        ],
      }),
    ).toThrow(/at most 16/);
  });
});
