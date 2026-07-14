import { SpanStatusCode } from "@opentelemetry/api";
import type { Counter, Meter, Span, Tracer } from "@opentelemetry/api";
import type {
  IngestTelemetryBatchValue,
  TelemetryApplicationResult,
} from "@aether-cloud/application";

import { sanitizeOperationalAttributes } from "./attributes.js";

export type TelemetryOperationalResultClass =
  | "accepted"
  | "conflicting"
  | "duplicate"
  | "internal-error"
  | "rejected"
  | "unavailable";

export interface TelemetryIngestionExecutor {
  execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<TelemetryApplicationResult<IngestTelemetryBatchValue>>;
}

export interface TelemetryOperationalSpan {
  setResult(resultClass: TelemetryOperationalResultClass): void;
  end(): void;
}

export interface TelemetryOperationalSignalSink {
  startTelemetryIngestion(): TelemetryOperationalSpan;
  recordTelemetryResult(
    resultClass: TelemetryOperationalResultClass,
    recordCount: number,
  ): void;
}

function classify(
  result: TelemetryApplicationResult<IngestTelemetryBatchValue>,
): TelemetryOperationalResultClass {
  if (result.ok) {
    return result.value.disposition === "duplicate" ? "duplicate" : "accepted";
  }
  if (result.failure.code === "telemetry-conflicting-replay") {
    return "conflicting";
  }
  if (result.failure.code === "telemetry-storage-unavailable") {
    return "unavailable";
  }
  return "rejected";
}

class OpenTelemetrySpanHandle implements TelemetryOperationalSpan {
  readonly #span: Span;

  constructor(span: Span) {
    this.#span = span;
  }

  setResult(resultClass: TelemetryOperationalResultClass): void {
    this.#span.setAttributes(
      sanitizeOperationalAttributes({
        "aethercloud.result.class": resultClass,
      }),
    );
    this.#span.setStatus({
      code:
        resultClass === "accepted" || resultClass === "duplicate"
          ? SpanStatusCode.OK
          : SpanStatusCode.ERROR,
    });
  }

  end(): void {
    this.#span.end();
  }
}

export class OpenTelemetrySignalSink implements TelemetryOperationalSignalSink {
  readonly #tracer: Tracer;
  readonly #batchCounter: Counter;
  readonly #sampleCounter: Counter;

  constructor(dependencies: {
    readonly tracer: Tracer;
    readonly meter: Meter;
  }) {
    this.#tracer = dependencies.tracer;
    this.#batchCounter = dependencies.meter.createCounter(
      "aethercloud.telemetry.batches",
      { unit: "{batch}" },
    );
    this.#sampleCounter = dependencies.meter.createCounter(
      "aethercloud.telemetry.samples",
      { unit: "{sample}" },
    );
  }

  startTelemetryIngestion(): TelemetryOperationalSpan {
    const span = this.#tracer.startSpan("telemetry.batch.ingest", {
      attributes: sanitizeOperationalAttributes({
        "aethercloud.operation.kind": "command",
        "aethercloud.operation.name": "telemetry.batch.ingest",
      }),
    });
    return new OpenTelemetrySpanHandle(span);
  }

  recordTelemetryResult(
    resultClass: TelemetryOperationalResultClass,
    recordCount: number,
  ): void {
    const resultAttributes = sanitizeOperationalAttributes({
      "aethercloud.result.class": resultClass,
    });
    this.#batchCounter.add(1, resultAttributes);
    if (recordCount > 0) {
      this.#sampleCounter.add(recordCount, resultAttributes);
    }
  }
}

export class OpenTelemetryTelemetryIngestion implements TelemetryIngestionExecutor {
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
    let span: TelemetryOperationalSpan | undefined;
    try {
      span = this.#sink.startTelemetryIngestion();
    } catch {
      // Operational instrumentation is deliberately best effort.
    }

    let result: TelemetryApplicationResult<IngestTelemetryBatchValue>;
    try {
      result = await this.#delegate.execute(rawContext, rawInput);
    } catch (error: unknown) {
      try {
        span?.setResult("internal-error");
        this.#sink.recordTelemetryResult("internal-error", 0);
      } catch {
        // Preserve the original application failure.
      }
      try {
        span?.end();
      } catch {
        // Exporter failure cannot replace the application failure.
      }
      throw error;
    }

    const resultClass = classify(result);
    const recordCount = result.ok ? result.value.receipt.recordCount : 0;
    try {
      span?.setResult(resultClass);
      this.#sink.recordTelemetryResult(resultClass, recordCount);
    } catch {
      // Business completion and durable acknowledgement already happened.
    }
    try {
      span?.end();
    } catch {
      // Span finalization is not part of the business result.
    }
    return result;
  }
}
