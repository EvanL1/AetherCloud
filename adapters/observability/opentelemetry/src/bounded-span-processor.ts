import { ExportResultCode } from "@opentelemetry/core";
import type {
  ReadableSpan,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

export interface BoundedSpanProcessorOptions {
  readonly maximumQueueSize: number;
  readonly maximumExportBatchSize: number;
  readonly exportTimeoutMillis: number;
  readonly onDropped: (count: number) => void;
}

function boundedPositiveInteger(
  value: number,
  name: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive bounded integer`);
  }
  return value;
}

export class BoundedSpanProcessor implements SpanProcessor {
  readonly #exporter: SpanExporter;
  readonly #maximumQueueSize: number;
  readonly #maximumExportBatchSize: number;
  readonly #exportTimeoutMillis: number;
  readonly #onDropped: (count: number) => void;
  readonly #queue: ReadableSpan[] = [];
  readonly #idleWaiters: Array<() => void> = [];
  #exporting = false;
  #shutdown = false;
  #dropped = 0;

  constructor(exporter: SpanExporter, options: BoundedSpanProcessorOptions) {
    this.#exporter = exporter;
    this.#maximumQueueSize = boundedPositiveInteger(
      options.maximumQueueSize,
      "maximumQueueSize",
      65_536,
    );
    this.#maximumExportBatchSize = boundedPositiveInteger(
      options.maximumExportBatchSize,
      "maximumExportBatchSize",
      this.#maximumQueueSize,
    );
    this.#exportTimeoutMillis = boundedPositiveInteger(
      options.exportTimeoutMillis,
      "exportTimeoutMillis",
      60_000,
    );
    this.#onDropped = options.onDropped;
  }

  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    if (this.#shutdown) return;
    if (this.#queue.length >= this.#maximumQueueSize) {
      this.#recordDropped(1);
      return;
    }
    this.#queue.push(span);
    queueMicrotask(() => {
      this.#startDrain();
    });
  }

  forceFlush(): Promise<void> {
    if (this.#queue.length === 0 && !this.#exporting) return Promise.resolve();
    this.#startDrain();
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, this.#exportTimeoutMillis * 2);
      this.#idleWaiters.push(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async shutdown(): Promise<void> {
    if (this.#shutdown) return;
    await this.forceFlush();
    this.#shutdown = true;
    try {
      await Promise.race([
        this.#exporter.shutdown(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, this.#exportTimeoutMillis);
        }),
      ]);
    } catch {
      // Exporter shutdown is operational best effort and cannot fail business work.
    }
  }

  droppedCount(): number {
    return this.#dropped;
  }

  #recordDropped(count: number): void {
    this.#dropped += count;
    try {
      this.#onDropped(count);
    } catch {
      // Self-observability is also isolated from the business path.
    }
  }

  #startDrain(): void {
    if (this.#exporting || this.#queue.length === 0) {
      if (!this.#exporting && this.#queue.length === 0) this.#notifyIdle();
      return;
    }
    const batch = this.#queue.splice(0, this.#maximumExportBatchSize);
    this.#exporting = true;
    void this.#exportBatch(batch).then((succeeded) => {
      if (!succeeded) this.#recordDropped(batch.length);
      this.#exporting = false;
      if (this.#queue.length > 0) {
        this.#startDrain();
      } else {
        this.#notifyIdle();
      }
    });
  }

  #exportBatch(batch: ReadableSpan[]): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (succeeded: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(succeeded);
      };
      const timeout = setTimeout(() => {
        finish(false);
      }, this.#exportTimeoutMillis);
      try {
        this.#exporter.export(batch, (result) => {
          finish(result.code === ExportResultCode.SUCCESS);
        });
      } catch {
        finish(false);
      }
    });
  }

  #notifyIdle(): void {
    for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }
}
