import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import type { OpenTelemetryConfig } from "./config.js";
import {
  OpenTelemetrySignalSink,
  OpenTelemetryTelemetryIngestion,
} from "./telemetry-ingestion.js";
import type { TelemetryIngestionExecutor } from "./telemetry-ingestion.js";

export interface AetherCloudOpenTelemetryRuntime {
  readonly enabled: boolean;
  start(): void;
  instrumentTelemetry(
    delegate: TelemetryIngestionExecutor,
  ): TelemetryIngestionExecutor;
  shutdown(): Promise<void>;
}

class NoopOpenTelemetryRuntime implements AetherCloudOpenTelemetryRuntime {
  readonly enabled = false;

  start(): void {}

  instrumentTelemetry(
    delegate: TelemetryIngestionExecutor,
  ): TelemetryIngestionExecutor {
    return delegate;
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

class OtlpOpenTelemetryRuntime implements AetherCloudOpenTelemetryRuntime {
  readonly enabled = true;
  readonly #traceProvider: NodeTracerProvider;
  readonly #meterProvider: MeterProvider;
  readonly #exportTimeoutMs: number;
  #started = false;

  constructor(config: Extract<OpenTelemetryConfig, { enabled: true }>) {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
    });
    const traceExporter = new OTLPTraceExporter({
      url: `${config.endpoint}/v1/traces`,
      timeoutMillis: config.exportTimeoutMs,
      concurrencyLimit: 1,
    });
    this.#traceProvider = new NodeTracerProvider({
      resource,
      sampler: new TraceIdRatioBasedSampler(config.samplingRatio),
      spanProcessors: [
        new BatchSpanProcessor(traceExporter, {
          maxQueueSize: config.maximumQueueSize,
          maxExportBatchSize: Math.min(512, config.maximumQueueSize),
          exportTimeoutMillis: config.exportTimeoutMs,
        }),
      ],
    });
    const metricExporter = new OTLPMetricExporter({
      url: `${config.endpoint}/v1/metrics`,
      timeoutMillis: config.exportTimeoutMs,
      concurrencyLimit: 1,
    });
    this.#meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: config.exportIntervalMs,
          exportTimeoutMillis: config.exportTimeoutMs,
        }),
      ],
    });
    this.#exportTimeoutMs = config.exportTimeoutMs;
  }

  start(): void {
    if (this.#started) return;
    this.#traceProvider.register();
    metrics.setGlobalMeterProvider(this.#meterProvider);
    this.#started = true;
  }

  instrumentTelemetry(
    delegate: TelemetryIngestionExecutor,
  ): TelemetryIngestionExecutor {
    return new OpenTelemetryTelemetryIngestion({
      delegate,
      sink: new OpenTelemetrySignalSink({
        tracer: this.#traceProvider.getTracer("aethercloud.telemetry", "1.0.0"),
        meter: this.#meterProvider.getMeter("aethercloud.telemetry", "1.0.0"),
      }),
    });
  }

  async shutdown(): Promise<void> {
    if (!this.#started) return;
    const shutdown = Promise.allSettled([
      this.#traceProvider.forceFlush(),
      this.#meterProvider.forceFlush(),
    ]).then(() =>
      Promise.allSettled([
        this.#traceProvider.shutdown(),
        this.#meterProvider.shutdown(),
      ]),
    );
    await Promise.race([
      shutdown,
      new Promise<void>((resolve) => {
        setTimeout(resolve, this.#exportTimeoutMs).unref();
      }),
    ]);
    this.#started = false;
  }
}

export function createOpenTelemetryRuntime(
  config: OpenTelemetryConfig,
): AetherCloudOpenTelemetryRuntime {
  return config.enabled
    ? new OtlpOpenTelemetryRuntime(config)
    : new NoopOpenTelemetryRuntime();
}
