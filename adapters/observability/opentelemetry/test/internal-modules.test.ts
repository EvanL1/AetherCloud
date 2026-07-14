import { ROOT_CONTEXT, metrics, trace } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";

import type {
  IngestTelemetryBatchValue,
  TelemetryApplicationResult,
} from "@aether-cloud/application";

import { sanitizeOperationalAttributes } from "../src/attributes.js";
import { parseOpenTelemetryEnvironment } from "../src/config.js";
import { createOpenTelemetryRuntime } from "../src/runtime.js";
import {
  OpenTelemetrySignalSink,
  OpenTelemetryTelemetryIngestion,
  type TelemetryOperationalResultClass,
  type TelemetryOperationalSignalSink,
} from "../src/telemetry-ingestion.js";
import { extractW3CTraceContext } from "../src/trace-context.js";

function accepted(
  disposition: "duplicate" | "persisted",
  recordCount: number,
): TelemetryApplicationResult<IngestTelemetryBatchValue> {
  return {
    ok: true,
    replayed: disposition === "duplicate",
    value: {
      disposition,
      durablyAcknowledged: true,
      receipt: { recordCount } as IngestTelemetryBatchValue["receipt"],
    },
  };
}

function rejected(
  code:
    | "invalid-input"
    | "telemetry-conflicting-replay"
    | "telemetry-storage-unavailable",
): TelemetryApplicationResult<IngestTelemetryBatchValue> {
  return { ok: false, failure: { code, message: "bounded failure" } };
}

describe("OpenTelemetry internal adapter modules", () => {
  it("accepts only catalogued bounded operational attributes", () => {
    expect(
      sanitizeOperationalAttributes({
        "aethercloud.operation.kind": "query",
        "aethercloud.operation.name": "audit.event.search",
        "aethercloud.result.class": "duplicate",
        "aethercloud.telemetry.record_count": 256,
      }),
    ).toEqual({
      "aethercloud.operation.kind": "query",
      "aethercloud.operation.name": "audit.event.search",
      "aethercloud.result.class": "duplicate",
      "aethercloud.telemetry.record_count": 256,
    });
    expect(
      sanitizeOperationalAttributes({
        "aethercloud.operation.kind": "command",
        "aethercloud.result.class": "internal-error",
        "aethercloud.telemetry.record_count": 0,
      }),
    ).toMatchObject({ "aethercloud.operation.kind": "command" });

    for (const attributes of [
      { tenantId: "secret" },
      { "aethercloud.unknown": "value" },
      { "aethercloud.operation.kind": "mutation" },
      { "aethercloud.result.class": "unbounded" },
      { "aethercloud.result.class": 7 },
      { "aethercloud.operation.name": "Bad Name" },
      { "aethercloud.operation.name": 7 },
      { "aethercloud.telemetry.record_count": -1 },
      { "aethercloud.telemetry.record_count": 257 },
      { "aethercloud.telemetry.record_count": 1.5 },
      { "aethercloud.telemetry.record_count": "1" },
    ]) {
      expect(() => sanitizeOperationalAttributes(attributes)).toThrow();
    }
  });

  it("decodes no-op and fully bounded OTLP configuration", () => {
    expect(parseOpenTelemetryEnvironment({})).toEqual({ enabled: false });
    expect(
      parseOpenTelemetryEnvironment({ AETHERCLOUD_OTEL_ENABLED: "false" }),
    ).toEqual({ enabled: false });
    expect(
      parseOpenTelemetryEnvironment({
        AETHERCLOUD_OTEL_ENABLED: "true",
        OTEL_SERVICE_NAME: "aethercloud-worker",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.test/",
        AETHERCLOUD_OTEL_MAX_QUEUE_SIZE: "128",
        OTEL_METRIC_EXPORT_INTERVAL: "1000",
        OTEL_METRIC_EXPORT_TIMEOUT: "100",
        AETHERCLOUD_OTEL_SAMPLING_RATIO: "0",
      }),
    ).toEqual({
      enabled: true,
      serviceName: "aethercloud-worker",
      endpoint: "https://otel.example.test",
      maximumQueueSize: 128,
      exportIntervalMs: 1000,
      exportTimeoutMs: 100,
      samplingRatio: 0,
    });

    for (const environment of [
      { AETHERCLOUD_OTEL_ENABLED: "yes" },
      { AETHERCLOUD_OTEL_ENABLED: "true" },
      {
        AETHERCLOUD_OTEL_ENABLED: "true",
        OTEL_SERVICE_NAME: "bad service",
      },
      {
        AETHERCLOUD_OTEL_ENABLED: "true",
        OTEL_SERVICE_NAME: "api",
        AETHERCLOUD_OTEL_MAX_QUEUE_SIZE: "0",
      },
      {
        AETHERCLOUD_OTEL_ENABLED: "true",
        OTEL_SERVICE_NAME: "api",
        AETHERCLOUD_OTEL_MAX_QUEUE_SIZE: "2049",
      },
      {
        AETHERCLOUD_OTEL_ENABLED: "true",
        OTEL_SERVICE_NAME: "api",
        OTEL_METRIC_EXPORT_INTERVAL: "999",
      },
      {
        AETHERCLOUD_OTEL_ENABLED: "true",
        OTEL_SERVICE_NAME: "api",
        OTEL_METRIC_EXPORT_TIMEOUT: "30001",
      },
      {
        AETHERCLOUD_OTEL_ENABLED: "true",
        OTEL_SERVICE_NAME: "api",
        AETHERCLOUD_OTEL_SAMPLING_RATIO: "NaN",
      },
      {
        AETHERCLOUD_OTEL_ENABLED: "true",
        OTEL_SERVICE_NAME: "api",
        AETHERCLOUD_OTEL_SAMPLING_RATIO: "-0.1",
      },
      {
        AETHERCLOUD_OTEL_ENABLED: "true",
        OTEL_SERVICE_NAME: "api",
        AETHERCLOUD_OTEL_SAMPLING_RATIO: "1.1",
      },
      {
        AETHERCLOUD_OTEL_ENABLED: "true",
        OTEL_SERVICE_NAME: "api",
        OTEL_EXPORTER_OTLP_ENDPOINT: "not a url",
      },
      {
        AETHERCLOUD_OTEL_ENABLED: "true",
        OTEL_SERVICE_NAME: "api",
        OTEL_EXPORTER_OTLP_ENDPOINT: "grpc://otel.example.test",
      },
      {
        AETHERCLOUD_OTEL_ENABLED: "true",
        OTEL_SERVICE_NAME: "api",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:secret@otel.example.test",
      },
    ]) {
      expect(() => parseOpenTelemetryEnvironment(environment)).toThrow();
    }
  });

  it("extracts valid sampled and unsampled W3C parents and ignores invalid values", () => {
    const sampled = extractW3CTraceContext(
      {
        TraceParent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
      ROOT_CONTEXT,
    );
    const unsampled = extractW3CTraceContext(
      {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
      },
      ROOT_CONTEXT,
    );
    expect(trace.getSpanContext(sampled)?.traceFlags).toBe(1);
    expect(trace.getSpanContext(unsampled)?.traceFlags).toBe(0);
    for (const traceparent of [
      undefined,
      "invalid",
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
    ]) {
      expect(extractW3CTraceContext({ traceparent }, ROOT_CONTEXT)).toBe(
        ROOT_CONTEXT,
      );
    }
  });

  it("classifies every business result without changing it", async () => {
    const observed: Array<Readonly<{ result: string; count: number }>> = [];
    const spanResults: string[] = [];
    const sink: TelemetryOperationalSignalSink = {
      startTelemetryIngestion: () => ({
        setResult: (resultClass) => spanResults.push(resultClass),
        end: () => undefined,
      }),
      recordTelemetryResult: (resultClass, recordCount) =>
        observed.push({ result: resultClass, count: recordCount }),
    };
    const cases: ReadonlyArray<
      Readonly<{
        result: TelemetryApplicationResult<IngestTelemetryBatchValue>;
        expected: TelemetryOperationalResultClass;
        count: number;
      }>
    > = [
      { result: accepted("persisted", 2), expected: "accepted", count: 2 },
      { result: accepted("duplicate", 2), expected: "duplicate", count: 2 },
      {
        result: rejected("telemetry-conflicting-replay"),
        expected: "conflicting",
        count: 0,
      },
      {
        result: rejected("telemetry-storage-unavailable"),
        expected: "unavailable",
        count: 0,
      },
      { result: rejected("invalid-input"), expected: "rejected", count: 0 },
    ];

    for (const entry of cases) {
      const instrumented = new OpenTelemetryTelemetryIngestion({
        delegate: { execute: () => Promise.resolve(entry.result) },
        sink,
      });
      expect(await instrumented.execute({}, {})).toBe(entry.result);
    }
    expect(spanResults).toEqual(cases.map((entry) => entry.expected));
    expect(observed).toEqual(
      cases.map((entry) => ({ result: entry.expected, count: entry.count })),
    );
  });

  it("records spans and positive sample counts through API abstractions", () => {
    const sink = new OpenTelemetrySignalSink({
      tracer: trace.getTracer("internal-test"),
      meter: metrics.getMeter("internal-test"),
    });
    const acceptedSpan = sink.startTelemetryIngestion();
    acceptedSpan.setResult("accepted");
    acceptedSpan.end();
    const rejectedSpan = sink.startTelemetryIngestion();
    rejectedSpan.setResult("rejected");
    rejectedSpan.end();
    sink.recordTelemetryResult("accepted", 2);
    sink.recordTelemetryResult("rejected", 0);
  });

  it("isolates start, record, end, and delegate failures", async () => {
    const businessResult = accepted("persisted", 0);
    const startFailure = new OpenTelemetryTelemetryIngestion({
      delegate: { execute: () => Promise.resolve(businessResult) },
      sink: {
        startTelemetryIngestion: () => {
          throw new Error("start failed");
        },
        recordTelemetryResult: () => {
          throw new Error("record failed");
        },
      },
    });
    expect(await startFailure.execute({}, {})).toBe(businessResult);

    const failingSpan = {
      setResult: vi.fn(() => {
        throw new Error("set failed");
      }),
      end: vi.fn(() => {
        throw new Error("end failed");
      }),
    };
    const delegateFailure = new Error("business failed");
    const instrumented = new OpenTelemetryTelemetryIngestion({
      delegate: {
        execute: () => Promise.reject(delegateFailure),
      },
      sink: {
        startTelemetryIngestion: () => failingSpan,
        recordTelemetryResult: () => {
          throw new Error("record failed");
        },
      },
    });
    await expect(instrumented.execute({}, {})).rejects.toBe(delegateFailure);
    expect(failingSpan.setResult).toHaveBeenCalledWith("internal-error");
    expect(failingSpan.end).toHaveBeenCalledOnce();
  });

  it("constructs no-op and enabled runtimes without requiring a Collector", async () => {
    const delegate = {
      execute: () => Promise.resolve(rejected("invalid-input")),
    };
    const noop = createOpenTelemetryRuntime({ enabled: false });
    expect(noop.enabled).toBe(false);
    noop.start();
    expect(noop.instrumentTelemetry(delegate)).toBe(delegate);
    await noop.shutdown();

    const enabled = createOpenTelemetryRuntime({
      enabled: true,
      serviceName: "aethercloud-test",
      endpoint: "http://127.0.0.1:4318",
      maximumQueueSize: 8,
      exportIntervalMs: 60_000,
      exportTimeoutMs: 100,
      samplingRatio: 0,
    });
    expect(enabled.enabled).toBe(true);
    expect(enabled.instrumentTelemetry(delegate)).not.toBe(delegate);
    await enabled.shutdown();
  });
});
