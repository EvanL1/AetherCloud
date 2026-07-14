import {
  SpanStatusCode,
  type Attributes,
  type Context,
  type Meter,
  type Span,
  type TextMapGetter,
  type Tracer,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

import type {
  IngestTelemetryBatchValue,
  TelemetryApplicationResult,
} from "@aether-cloud/application";

export interface ParsedOpenTelemetryEnvironmentDisabled {
  readonly enabled: false;
}

export interface ParsedOpenTelemetryEnvironmentEnabled {
  readonly enabled: true;
  readonly serviceName: string;
  readonly endpoint?: string;
  readonly maximumQueueSize: number;
  readonly exportIntervalMs: number;
  readonly exportTimeoutMs: number;
  readonly samplingRatio: number;
}

export type ParsedOpenTelemetryEnvironment =
  | ParsedOpenTelemetryEnvironmentDisabled
  | ParsedOpenTelemetryEnvironmentEnabled;

export interface OpenTelemetryEnvironmentInput {
  readonly AETHERCLOUD_OTEL_ENABLED?: string;
  readonly AETHERCLOUD_OTEL_EXPORT_INTERVAL_MS?: string;
  readonly AETHERCLOUD_OTEL_EXPORT_TIMEOUT_MS?: string;
  readonly AETHERCLOUD_OTEL_MAX_QUEUE_SIZE?: string;
  readonly AETHERCLOUD_OTEL_SAMPLING_RATIO?: string;
  readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  readonly OTEL_SERVICE_NAME?: string;
}

function parseInteger(
  input: string | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  if (input === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(input)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(input);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} exceeds its bounded maximum`);
  }
  return parsed;
}

function parseRatio(input: string | undefined): number {
  if (input === undefined) return 0.1;
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("sampling ratio must be between 0 and 1");
  }
  return parsed;
}

function parseEndpoint(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(input);
  } catch {
    throw new Error("OTLP endpoint must be an absolute HTTP URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("OTLP endpoint must use HTTP or HTTPS");
  }
  if (endpoint.username !== "" || endpoint.password !== "") {
    throw new Error("OTLP endpoint must not embed credentials");
  }
  return endpoint.toString().replace(/\/$/, "");
}

export function parseOpenTelemetryEnvironment(
  input: OpenTelemetryEnvironmentInput,
): ParsedOpenTelemetryEnvironment {
  if (input.AETHERCLOUD_OTEL_ENABLED !== "true") return { enabled: false };
  const serviceName = input.OTEL_SERVICE_NAME ?? "aethercloud";
  if (
    serviceName.trim().length === 0 ||
    serviceName.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(serviceName)
  ) {
    throw new Error("OTEL_SERVICE_NAME must be a bounded identifier");
  }
  const endpoint = parseEndpoint(input.OTEL_EXPORTER_OTLP_ENDPOINT);
  return {
    enabled: true,
    serviceName,
    ...(endpoint === undefined ? {} : { endpoint }),
    maximumQueueSize: parseInteger(
      input.AETHERCLOUD_OTEL_MAX_QUEUE_SIZE,
      2_048,
      "OpenTelemetry queue size",
      65_536,
    ),
    exportIntervalMs: parseInteger(
      input.AETHERCLOUD_OTEL_EXPORT_INTERVAL_MS,
      60_000,
      "OpenTelemetry export interval",
      3_600_000,
    ),
    exportTimeoutMs: parseInteger(
      input.AETHERCLOUD_OTEL_EXPORT_TIMEOUT_MS,
      10_000,
      "OpenTelemetry export timeout",
      60_000,
    ),
    samplingRatio: parseRatio(input.AETHERCLOUD_OTEL_SAMPLING_RATIO),
  };
}

const allowedOperationKinds = new Set(["command", "query", "worker"]);
const allowedResultClasses = new Set([
  "accepted",
  "conflict",
  "duplicate",
  "failed",
  "rejected",
  "unknown",
]);

export function sanitizeOperationalAttributes(
  attributes: Readonly<Record<string, unknown>>,
): Attributes {
  const sanitized: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "aethercloud.operation.kind") {
      if (typeof value !== "string" || !allowedOperationKinds.has(value)) {
        throw new Error("operation kind is not in the bounded catalog");
      }
      sanitized[key] = value;
      continue;
    }
    if (key === "aethercloud.result.class") {
      if (typeof value !== "string" || !allowedResultClasses.has(value)) {
        throw new Error("result class is not in the bounded catalog");
      }
      sanitized[key] = value;
      continue;
    }
    throw new Error(`forbidden operational attribute ${key}`);
  }
  return sanitized;
}

const traceCarrierGetter: TextMapGetter<Readonly<Record<string, string>>> = {
  get(carrier, key) {
    return carrier[key];
  },
  keys(carrier) {
    return Object.keys(carrier);
  },
};

export function extractW3CTraceContext(
  carrier: Readonly<Record<string, string>>,
  parent: Context,
): Context {
  const sanitized: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(carrier)) {
    const key = rawKey.toLowerCase();
    if (key === "traceparent" && value.length <= 256) sanitized[key] = value;
    if (key === "tracestate" && value.length <= 512) sanitized[key] = value;
  }
  if (Object.keys(sanitized).length === 0) return parent;
  return new W3CTraceContextPropagator().extract(
    parent,
    sanitized,
    traceCarrierGetter,
  );
}

export interface TelemetryIngestionExecutor {
  execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<TelemetryApplicationResult<IngestTelemetryBatchValue>>;
}

export interface TelemetryOperationalObservation {
  readonly span: Span;
  readonly startedAt: number;
}

export interface TelemetryOperationalSignalSink {
  startTelemetryIngestion(): TelemetryOperationalObservation | undefined;
  recordTelemetryResult(
    observation: TelemetryOperationalObservation | undefined,
    result: TelemetryApplicationResult<IngestTelemetryBatchValue>,
  ): void;
}

function resultClass(
  result: TelemetryApplicationResult<IngestTelemetryBatchValue>,
): "accepted" | "conflict" | "duplicate" | "failed" | "rejected" {
  if (result.ok) return result.replayed ? "duplicate" : "accepted";
  if (
    result.failure.code === "telemetry-conflicting-replay" ||
    result.failure.code === "telemetry-position-conflict"
  ) {
    return "conflict";
  }
  return result.failure.code === "telemetry-storage-unavailable"
    ? "failed"
    : "rejected";
}

export class OpenTelemetrySignalSink implements TelemetryOperationalSignalSink {
  readonly #tracer: Tracer;
  readonly #batchCounter: ReturnType<Meter["createCounter"]>;
  readonly #duration: ReturnType<Meter["createHistogram"]>;

  constructor(dependencies: {
    readonly tracer: Tracer;
    readonly meter: Meter;
  }) {
    this.#tracer = dependencies.tracer;
    this.#batchCounter = dependencies.meter.createCounter(
      "aethercloud.telemetry.batches",
      { unit: "{batch}" },
    );
    this.#duration = dependencies.meter.createHistogram(
      "aethercloud.telemetry.ingestion.duration",
      { unit: "ms" },
    );
  }

  startTelemetryIngestion(): TelemetryOperationalObservation {
    return {
      span: this.#tracer.startSpan("telemetry.batch.ingest", {
        attributes: sanitizeOperationalAttributes({
          "aethercloud.operation.kind": "command",
        }),
      }),
      startedAt: performance.now(),
    };
  }

  recordTelemetryResult(
    observation: TelemetryOperationalObservation | undefined,
    result: TelemetryApplicationResult<IngestTelemetryBatchValue>,
  ): void {
    const classification = resultClass(result);
    const attributes = sanitizeOperationalAttributes({
      "aethercloud.result.class": classification,
    });
    this.#batchCounter.add(1, { result: classification });
    if (observation !== undefined) {
      this.#duration.record(performance.now() - observation.startedAt, {
        result: classification,
      });
      observation.span.setAttributes(attributes);
      observation.span.setStatus({
        code: result.ok ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      });
      observation.span.end();
    }
  }
}

export class OpenTelemetryTelemetryIngestion {
  readonly #delegate: TelemetryIngestionExecutor;
  readonly #sink: TelemetryOperationalSignalSink;

  constructor(dependencies: {
    readonly delegate: TelemetryIngestionExecutor;
    readonly sink: TelemetryOperationalSignalSink;
  }) {
    this.#delegate = dependencies.delegate;
    this.#sink = dependencies.sink;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<TelemetryApplicationResult<IngestTelemetryBatchValue>> {
    let observation: TelemetryOperationalObservation | undefined;
    try {
      observation = this.#sink.startTelemetryIngestion();
    } catch {
      observation = undefined;
    }
    const result = await this.#delegate.execute(rawContext, rawInput);
    try {
      this.#sink.recordTelemetryResult(observation, result);
    } catch {
      // Operational signal loss cannot alter the durable business result.
    }
    return result;
  }
}
