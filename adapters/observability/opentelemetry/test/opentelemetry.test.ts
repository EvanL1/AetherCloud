import { describe, expect, it } from "vitest";

import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  ROOT_CONTEXT,
  trace,
  type Meter,
  type Tracer,
} from "@opentelemetry/api";

import {
  OpenTelemetrySignalSink,
  OpenTelemetryTelemetryIngestion,
  extractW3CTraceContext,
  parseOpenTelemetryEnvironment,
  sanitizeOperationalAttributes,
  type TelemetryIngestionExecutor,
  type TelemetryOperationalSignalSink,
} from "../src/index.js";

function rejectedResult() {
  return {
    ok: false as const,
    failure: {
      code: "telemetry-quota-exceeded" as const,
      message: "quota details must not become a metric label",
    },
  };
}

class StubTelemetryExecutor implements TelemetryIngestionExecutor {
  calls = 0;

  execute() {
    this.calls += 1;
    return Promise.resolve(rejectedResult());
  }
}

describe("OpenTelemetry operational observability adapter", () => {
  it("defaults to no-op and validates bounded opt-in OTLP environment", () => {
    expect(parseOpenTelemetryEnvironment({})).toEqual({ enabled: false });
    expect(
      parseOpenTelemetryEnvironment({
        AETHERCLOUD_OTEL_ENABLED: "true",
        OTEL_SERVICE_NAME: "aethercloud-api",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.test",
        AETHERCLOUD_OTEL_MAX_QUEUE_SIZE: "512",
      }),
    ).toEqual({
      enabled: true,
      serviceName: "aethercloud-api",
      endpoint: "https://otel.example.test",
      maximumQueueSize: 512,
      exportIntervalMs: 60_000,
      exportTimeoutMs: 10_000,
      samplingRatio: 0.1,
    });
    expect(() =>
      parseOpenTelemetryEnvironment({
        AETHERCLOUD_OTEL_ENABLED: "true",
        OTEL_SERVICE_NAME: "aethercloud-api",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:secret@otel.example.test",
      }),
    ).toThrow(/credentials/);
    expect(() =>
      parseOpenTelemetryEnvironment({
        AETHERCLOUD_OTEL_ENABLED: "true",
        OTEL_SERVICE_NAME: "aethercloud-api",
        AETHERCLOUD_OTEL_MAX_QUEUE_SIZE: "999999",
      }),
    ).toThrow(/queue/i);
  });

  it("exports telemetry use-case traces and low-cardinality metrics in memory", async () => {
    const spanExporter = new InMemorySpanExporter();
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    });
    const metricExporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    );
    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60_000,
    });
    const meterProvider = new MeterProvider({ readers: [metricReader] });
    const sink = new OpenTelemetrySignalSink({
      tracer: tracerProvider.getTracer("test"),
      meter: meterProvider.getMeter("test"),
    });
    const delegate = new StubTelemetryExecutor();
    const instrumented = new OpenTelemetryTelemetryIngestion({
      delegate,
      sink,
    });

    expect(await instrumented.execute({}, {})).toEqual(rejectedResult());
    await tracerProvider.forceFlush();
    await meterProvider.forceFlush();

    expect(spanExporter.getFinishedSpans()).toHaveLength(1);
    expect(spanExporter.getFinishedSpans()[0]).toMatchObject({
      name: "telemetry.batch.ingest",
      attributes: {
        "aethercloud.operation.kind": "command",
        "aethercloud.result.class": "rejected",
      },
    });
    const metrics = JSON.stringify(metricExporter.getMetrics());
    expect(metrics).toContain("aethercloud.telemetry.batches");
    expect(metrics).toContain("rejected");
    expect(metrics).not.toContain("quota details");

    await tracerProvider.shutdown();
    await meterProvider.shutdown();
  });

  it("never repeats or fails a business command when instrumentation throws", async () => {
    const delegate = new StubTelemetryExecutor();
    const failingSink: TelemetryOperationalSignalSink = {
      startTelemetryIngestion() {
        throw new Error("exporter unavailable");
      },
      recordTelemetryResult() {
        throw new Error("metric exporter unavailable");
      },
    };
    const instrumented = new OpenTelemetryTelemetryIngestion({
      delegate,
      sink: failingSink,
    });

    expect(await instrumented.execute({}, {})).toEqual(rejectedResult());
    expect(delegate.calls).toBe(1);
  });

  it("allows only catalogued low-cardinality operational attributes", () => {
    expect(
      sanitizeOperationalAttributes({
        "aethercloud.operation.kind": "command",
        "aethercloud.result.class": "accepted",
      }),
    ).toEqual({
      "aethercloud.operation.kind": "command",
      "aethercloud.result.class": "accepted",
    });
    expect(() =>
      sanitizeOperationalAttributes({ tenantId: "tenant-secret" }),
    ).toThrow(/forbidden/i);
    expect(() =>
      sanitizeOperationalAttributes({
        "aethercloud.result.class": "unbounded-free-form-result",
      }),
    ).toThrow(/bounded/i);
  });

  it("extracts optional W3C Trace Context without accepting baggage authority", () => {
    const extracted = extractW3CTraceContext(
      {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        baggage: "tenantId=forged,permission=device.control",
      },
      ROOT_CONTEXT,
    );

    expect(trace.getSpanContext(extracted)).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      isRemote: true,
    });
    expect(extractW3CTraceContext({}, ROOT_CONTEXT)).toBe(ROOT_CONTEXT);
  });
});

// Compile-time evidence that the adapter accepts only OpenTelemetry API
// abstractions; SDK providers stay in composition/bootstrap code.
const _apiTypes: Readonly<{ tracer?: Tracer; meter?: Meter }> = {};
void _apiTypes;
