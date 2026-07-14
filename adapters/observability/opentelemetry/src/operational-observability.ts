import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Attributes,
  type Counter,
  type Histogram,
  type TextMapGetter,
  type Tracer,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  ParentBasedSampler,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import type {
  IngestTelemetryBatchValue,
  TelemetryApplicationResult,
} from "@aether-cloud/application";

import { BoundedSpanProcessor } from "./bounded-span-processor.js";

export const AETHERCLOUD_OPERATIONAL_SIGNAL_CATALOG = Object.freeze({
  version: "1.0.0",
  stability: "development",
  spans: ["telemetry.batch.ingest"],
  metrics: [
    "aethercloud.telemetry.batches",
    "aethercloud.telemetry.records",
    "aethercloud.telemetry.ingestion.duration",
    "aethercloud.observability.exporter.dropped_signals",
  ],
  forbiddenMetricLabels: [
    "tenantId",
    "projectId",
    "gatewayId",
    "pointId",
    "jobId",
    "userId",
  ],
} as const);

export interface TraceCarrierContext {
  readonly traceCarrier?: Readonly<Record<string, string>>;
}

export interface OperationalMetricPoint {
  readonly name: string;
  readonly value: number;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface OperationalObservabilityOptions {
  readonly mode: "custom" | "otlp";
  readonly spanExporter: SpanExporter;
  readonly metricExporter?: PushMetricExporter;
  readonly serviceName?: string;
  readonly maximumQueueSize?: number;
  readonly maximumExportBatchSize?: number;
  readonly exportTimeoutMillis?: number;
  readonly sampler?: "always-off" | "always-on";
}

export interface OperationalEnvironment {
  readonly AETHERCLOUD_OTEL_ENABLED?: string;
  readonly OTEL_BSP_EXPORT_TIMEOUT?: string;
  readonly OTEL_BSP_MAX_EXPORT_BATCH_SIZE?: string;
  readonly OTEL_BSP_MAX_QUEUE_SIZE?: string;
  readonly OTEL_SERVICE_NAME?: string;
  readonly OTEL_TRACES_SAMPLER?: string;
}

interface TelemetryIngestionUseCase {
  execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<TelemetryApplicationResult<IngestTelemetryBatchValue>>;
}

const carrierGetter: TextMapGetter<Readonly<Record<string, string>>> = {
  get(carrier, key) {
    return carrier[key];
  },
  keys(carrier) {
    return Object.keys(carrier);
  },
};

let contextManagerInstalled = false;

function ensureContextManager(): void {
  if (contextManagerInstalled) return;
  const manager = new AsyncLocalStorageContextManager().enable();
  contextManagerInstalled = context.setGlobalContextManager(manager);
}

function parseBoundedEnvironmentInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : fallback;
}

function sanitizedTraceCarrier(
  input: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (input === undefined) return {};
  const output: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(input)) {
    const key = rawKey.toLowerCase();
    if (key === "traceparent" && value.length <= 256) output[key] = value;
    if (key === "tracestate" && value.length <= 512) output[key] = value;
  }
  return output;
}

function telemetryOutcome(
  result: TelemetryApplicationResult<IngestTelemetryBatchValue>,
): string {
  if (result.ok) return result.value.disposition;
  switch (result.failure.code) {
    case "gateway-credential-inactive":
    case "invalid-gateway-credential":
    case "permission-denied":
      return "unauthorized";
    case "telemetry-conflicting-replay":
    case "telemetry-position-conflict":
      return "conflict";
    case "telemetry-quota-exceeded":
      return "quota-rejected";
    case "telemetry-storage-unavailable":
      return "storage-failed";
    case "command-expired":
      return "expired";
    default:
      return "invalid";
  }
}

export class OperationalObservability {
  readonly mode: "custom" | "memory" | "noop" | "otlp";
  readonly #tracerProvider: BasicTracerProvider | undefined;
  readonly #meterProvider: MeterProvider | undefined;
  readonly #tracer: Tracer | undefined;
  readonly #batchCounter: Counter | undefined;
  readonly #recordCounter: Counter | undefined;
  readonly #duration: Histogram | undefined;
  readonly #droppedCounter: Counter | undefined;
  readonly #spanProcessor: BoundedSpanProcessor | undefined;
  readonly #memorySpanExporter: InMemorySpanExporter | undefined;
  readonly #memoryMetricExporter: InMemoryMetricExporter | undefined;
  readonly #propagator = new W3CTraceContextPropagator();
  #shutdown = false;

  constructor(
    mode: OperationalObservability["mode"],
    dependencies: {
      readonly tracerProvider?: BasicTracerProvider;
      readonly meterProvider?: MeterProvider;
      readonly spanProcessor?: BoundedSpanProcessor;
      readonly memorySpanExporter?: InMemorySpanExporter;
      readonly memoryMetricExporter?: InMemoryMetricExporter;
    } = {},
  ) {
    this.mode = mode;
    this.#tracerProvider = dependencies.tracerProvider;
    this.#meterProvider = dependencies.meterProvider;
    this.#spanProcessor = dependencies.spanProcessor;
    this.#memorySpanExporter = dependencies.memorySpanExporter;
    this.#memoryMetricExporter = dependencies.memoryMetricExporter;
    this.#tracer = this.#tracerProvider?.getTracer("aethercloud", "1.0.0");
    const meter = this.#meterProvider?.getMeter("aethercloud", "1.0.0");
    this.#batchCounter = meter?.createCounter("aethercloud.telemetry.batches", {
      unit: "{batch}",
    });
    this.#recordCounter = meter?.createCounter(
      "aethercloud.telemetry.records",
      { unit: "{record}" },
    );
    this.#duration = meter?.createHistogram(
      "aethercloud.telemetry.ingestion.duration",
      { unit: "ms" },
    );
    this.#droppedCounter = meter?.createCounter(
      "aethercloud.observability.exporter.dropped_signals",
      { unit: "{signal}" },
    );
  }

  async observeTelemetryIngestion(
    work: () => Promise<TelemetryApplicationResult<IngestTelemetryBatchValue>>,
    operationalContext: TraceCarrierContext = {},
  ): Promise<TelemetryApplicationResult<IngestTelemetryBatchValue>> {
    const startedAt = performance.now();
    if (this.#tracer === undefined) return work();
    let span: ReturnType<Tracer["startSpan"]>;
    try {
      const parent = this.#propagator.extract(
        ROOT_CONTEXT,
        sanitizedTraceCarrier(operationalContext.traceCarrier),
        carrierGetter,
      );
      span = this.#tracer.startSpan(
        "telemetry.batch.ingest",
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            "aethercloud.operation.kind": "command",
          },
        },
        parent,
      );
      return await context.with(trace.setSpan(parent, span), async () => {
        try {
          const result = await work();
          const outcome = telemetryOutcome(result);
          this.#recordTelemetryResult(
            span,
            result,
            outcome,
            performance.now() - startedAt,
          );
          return result;
        } catch (error: unknown) {
          try {
            span.setAttribute(
              "aethercloud.telemetry.outcome",
              "internal-error",
            );
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
          } catch {
            // Preserve the business exception without allowing instrumentation to mask it.
          }
          throw error;
        }
      });
    } catch {
      return work();
    }
  }

  forceFlush(): Promise<void> {
    return Promise.allSettled([
      this.#tracerProvider?.forceFlush() ?? Promise.resolve(),
      this.#meterProvider?.forceFlush({ timeoutMillis: 5_000 }) ??
        Promise.resolve(),
    ]).then(() => undefined);
  }

  async shutdown(): Promise<void> {
    if (this.#shutdown) return;
    this.#shutdown = true;
    await Promise.allSettled([
      this.#tracerProvider?.shutdown() ?? Promise.resolve(),
      this.#meterProvider?.shutdown({ timeoutMillis: 5_000 }) ??
        Promise.resolve(),
    ]);
  }

  finishedSpans(): readonly ReadableSpan[] {
    return this.#memorySpanExporter?.getFinishedSpans() ?? [];
  }

  metricPoints(): readonly OperationalMetricPoint[] {
    const snapshots = this.#memoryMetricExporter?.getMetrics() ?? [];
    const points: OperationalMetricPoint[] = [];
    for (const snapshot of snapshots) {
      for (const scope of snapshot.scopeMetrics) {
        for (const metric of scope.metrics) {
          for (const point of metric.dataPoints) {
            if (typeof point.value !== "number") continue;
            points.push({
              name: metric.descriptor.name,
              value: point.value,
              attributes: { ...point.attributes },
            });
          }
        }
      }
    }
    return points;
  }

  droppedSignalCount(): number {
    return this.#spanProcessor?.droppedCount() ?? 0;
  }

  #recordTelemetryResult(
    span: ReturnType<Tracer["startSpan"]>,
    result: TelemetryApplicationResult<IngestTelemetryBatchValue>,
    outcome: string,
    durationMillis: number,
  ): void {
    const attributes: Attributes = { outcome };
    try {
      span.setAttribute("aethercloud.telemetry.outcome", outcome);
      span.setStatus({
        code: result.ok ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      });
      this.#batchCounter?.add(1, attributes);
      if (result.ok) {
        this.#recordCounter?.add(result.value.receipt.recordCount, attributes);
      }
      this.#duration?.record(durationMillis, attributes);
    } catch {
      // Metrics and trace failures never alter acknowledgement semantics.
    } finally {
      try {
        span.end();
      } catch {
        // Ending a span is best effort.
      }
    }
  }

  recordDroppedSignals(count: number): void {
    try {
      this.#droppedCounter?.add(count, { signal: "span" });
    } catch {
      // Self-observability remains best effort.
    }
  }
}

function buildOperationalObservability(
  options: OperationalObservabilityOptions,
  memory: {
    readonly spanExporter?: InMemorySpanExporter;
    readonly metricExporter?: InMemoryMetricExporter;
  } = {},
): OperationalObservability {
  ensureContextManager();
  const serviceName = options.serviceName ?? "aethercloud";
  const maximumQueueSize = options.maximumQueueSize ?? 2_048;
  const maximumExportBatchSize = Math.min(
    options.maximumExportBatchSize ?? 512,
    maximumQueueSize,
  );
  const exportTimeoutMillis = options.exportTimeoutMillis ?? 5_000;
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName });
  const metricReader =
    options.metricExporter === undefined
      ? undefined
      : new PeriodicExportingMetricReader({
          exporter: options.metricExporter,
          exportIntervalMillis: 60_000,
          exportTimeoutMillis,
          cardinalityLimits: { default: 32 },
          maxExportBatchSize: 128,
        });
  const meterProvider = new MeterProvider({
    resource,
    ...(metricReader === undefined ? {} : { readers: [metricReader] }),
  });
  const observabilityReference: { current?: OperationalObservability } = {};
  const spanProcessor = new BoundedSpanProcessor(options.spanExporter, {
    maximumQueueSize,
    maximumExportBatchSize,
    exportTimeoutMillis,
    onDropped: (count) =>
      observabilityReference.current?.recordDroppedSignals(count),
  });
  const tracerProvider = new BasicTracerProvider({
    resource,
    sampler:
      options.sampler === "always-off"
        ? new AlwaysOffSampler()
        : new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    spanProcessors: [spanProcessor],
    forceFlushTimeoutMillis: exportTimeoutMillis * 2,
    generalLimits: { attributeCountLimit: 16, attributeValueLengthLimit: 256 },
  });
  const observability = new OperationalObservability(
    options.mode === "custom" ? "custom" : "otlp",
    {
      tracerProvider,
      meterProvider,
      spanProcessor,
      ...(memory.spanExporter === undefined
        ? {}
        : { memorySpanExporter: memory.spanExporter }),
      ...(memory.metricExporter === undefined
        ? {}
        : { memoryMetricExporter: memory.metricExporter }),
    },
  );
  observabilityReference.current = observability;
  return observability;
}

export function createOperationalObservability(
  options: OperationalObservabilityOptions,
): OperationalObservability {
  return buildOperationalObservability(options);
}

export function createInMemoryOperationalObservability(
  options: {
    readonly maximumQueueSize?: number;
    readonly exportTimeoutMillis?: number;
  } = {},
): OperationalObservability {
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE,
  );
  const built = buildOperationalObservability(
    {
      mode: "custom",
      spanExporter,
      metricExporter,
      ...(options.maximumQueueSize === undefined
        ? {}
        : { maximumQueueSize: options.maximumQueueSize }),
      ...(options.exportTimeoutMillis === undefined
        ? {}
        : { exportTimeoutMillis: options.exportTimeoutMillis }),
    },
    { spanExporter, metricExporter },
  );
  Object.defineProperty(built, "mode", { value: "memory" });
  return built;
}

export function createOperationalObservabilityFromEnvironment(
  environment?: OperationalEnvironment,
): OperationalObservability {
  const source = environment ?? process.env;
  if (source.AETHERCLOUD_OTEL_ENABLED !== "true") {
    return new OperationalObservability("noop");
  }
  const maximumQueueSize = parseBoundedEnvironmentInteger(
    source.OTEL_BSP_MAX_QUEUE_SIZE,
    2_048,
    65_536,
  );
  return buildOperationalObservability({
    mode: "otlp",
    spanExporter: new OTLPTraceExporter(),
    metricExporter: new OTLPMetricExporter({ concurrencyLimit: 1 }),
    serviceName: source.OTEL_SERVICE_NAME ?? "aethercloud",
    maximumQueueSize,
    maximumExportBatchSize: Math.min(
      parseBoundedEnvironmentInteger(
        source.OTEL_BSP_MAX_EXPORT_BATCH_SIZE,
        512,
        4_096,
      ),
      maximumQueueSize,
    ),
    exportTimeoutMillis: parseBoundedEnvironmentInteger(
      source.OTEL_BSP_EXPORT_TIMEOUT,
      5_000,
      60_000,
    ),
    sampler:
      source.OTEL_TRACES_SAMPLER === "always_off" ? "always-off" : "always-on",
  });
}

export class ObservedTelemetryIngestion {
  readonly #useCase: TelemetryIngestionUseCase;
  readonly #observability: OperationalObservability;

  constructor(dependencies: {
    readonly useCase: TelemetryIngestionUseCase;
    readonly observability: OperationalObservability;
  }) {
    this.#useCase = dependencies.useCase;
    this.#observability = dependencies.observability;
  }

  execute(
    rawContext: unknown,
    rawInput: unknown,
    operationalContext: TraceCarrierContext = {},
  ): Promise<TelemetryApplicationResult<IngestTelemetryBatchValue>> {
    return this.#observability.observeTelemetryIngestion(
      () => this.#useCase.execute(rawContext, rawInput),
      operationalContext,
    );
  }
}
