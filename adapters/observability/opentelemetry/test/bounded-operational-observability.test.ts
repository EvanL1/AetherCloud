import { describe, expect, it } from "vitest";

import type {
  IngestTelemetryBatchValue,
  TelemetryApplicationResult,
} from "@aether-cloud/application";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

import {
  ObservedTelemetryIngestion,
  createInMemoryOperationalObservability,
  createOperationalObservability,
  createOperationalObservabilityFromEnvironment,
} from "../src/index.js";

const rejected: TelemetryApplicationResult<IngestTelemetryBatchValue> = {
  ok: false,
  failure: {
    code: "telemetry-quota-exceeded",
    message: "secret tenant quota detail must never be exported",
  },
};

function delegate() {
  return { execute: () => Promise.resolve(rejected) };
}

describe("bounded operational observability", () => {
  it("keeps default no-op behavior independent of a Collector", async () => {
    const observability = createOperationalObservabilityFromEnvironment({});
    const observed = new ObservedTelemetryIngestion({
      useCase: delegate(),
      observability,
    });

    expect(observability.mode).toBe("noop");
    expect(await observed.execute({}, {})).toEqual(rejected);
    await observability.shutdown();
  });

  it("propagates optional W3C context and exports only catalogued attributes", async () => {
    const observability = createInMemoryOperationalObservability();
    const observed = new ObservedTelemetryIngestion({
      useCase: delegate(),
      observability,
    });
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

    await observed.execute(
      {},
      { proof: "never-export" },
      {
        traceCarrier: {
          traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
          baggage: "tenantId=forged,permission=device.control",
        },
      },
    );
    await observed.execute({}, {});
    await observability.forceFlush();

    expect(
      observability
        .finishedSpans()
        .some((span) => span.spanContext().traceId === traceId),
    ).toBe(true);
    expect(observability.finishedSpans()).toHaveLength(2);
    expect(
      JSON.stringify({
        spans: observability.finishedSpans(),
        metrics: observability.metricPoints(),
      }),
    ).not.toMatch(/never-export|forged|device\.control|secret tenant/);
    expect(observability.metricPoints()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "aethercloud.telemetry.batches",
          attributes: { outcome: "quota-rejected" },
        }),
      ]),
    );
    await observability.shutdown();
  });

  it("does not alter the command result when an exporter fails", async () => {
    const exporter: SpanExporter = {
      export(_spans, callback) {
        callback({ code: 1, error: new Error("unavailable") });
      },
      shutdown: () => Promise.resolve(),
    };
    const observability = createOperationalObservability({
      mode: "custom",
      spanExporter: exporter,
      maximumQueueSize: 8,
    });

    expect(
      await new ObservedTelemetryIngestion({
        useCase: delegate(),
        observability,
      }).execute({}, {}),
    ).toEqual(rejected);
    await observability.forceFlush();
    expect(observability.droppedSignalCount()).toBe(1);
    await observability.shutdown();
  });

  it("drops excess spans from a bounded queue without applying backpressure", async () => {
    let release: ((result: { code: number }) => void) | undefined;
    const held = new Promise<{ code: number }>((resolve) => {
      release = resolve;
    });
    const exporter: SpanExporter = {
      export(_spans: ReadableSpan[], callback) {
        void held.then(callback);
      },
      shutdown: () => Promise.resolve(),
    };
    const observability = createOperationalObservability({
      mode: "custom",
      spanExporter: exporter,
      maximumQueueSize: 2,
      maximumExportBatchSize: 1,
      exportTimeoutMillis: 50,
    });
    const observed = new ObservedTelemetryIngestion({
      useCase: delegate(),
      observability,
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => observed.execute({}, {})),
    );
    expect(results).toHaveLength(10);
    expect(results.every((result) => result === rejected)).toBe(true);
    expect(observability.droppedSignalCount()).toBeGreaterThan(0);
    release?.({ code: 0 });
    await observability.shutdown();
  });
});
