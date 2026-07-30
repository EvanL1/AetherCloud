import type { ReconcileCloudLinkSessionHealth } from "@aether-cloud/application";

export interface CloudLinkHealthSchedulerObserver {
  sweepFailed(): void;
}

export interface RunningCloudLinkHealthScheduler {
  close(): Promise<void>;
}

export function startCloudLinkHealthScheduler(dependencies: {
  readonly reconcile: Pick<ReconcileCloudLinkSessionHealth, "execute">;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly observer?: CloudLinkHealthSchedulerObserver;
}): RunningCloudLinkHealthScheduler {
  const intervalMs = dependencies.intervalMs ?? 30_000;
  const batchSize = dependencies.batchSize ?? 100;
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1_000 ||
    intervalMs > 300_000
  ) {
    throw new TypeError(
      "CloudLink health interval must be 1000-300000 milliseconds",
    );
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new TypeError("CloudLink health batch size must be 1-500");
  }

  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let closing = false;

  const schedule = (): void => {
    if (closing) return;
    timer = setTimeout(run, intervalMs);
    timer.unref();
  };

  const run = (): void => {
    if (closing || inFlight !== undefined) return;
    inFlight = dependencies.reconcile
      .execute({ limit: batchSize })
      .then((result) => {
        if (!result.ok) dependencies.observer?.sweepFailed();
      })
      .catch(() => {
        dependencies.observer?.sweepFailed();
      })
      .then(() => {
        inFlight = undefined;
        schedule();
      });
  };

  run();
  return {
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      if (timer !== undefined) clearTimeout(timer);
      await inFlight;
    },
  };
}
