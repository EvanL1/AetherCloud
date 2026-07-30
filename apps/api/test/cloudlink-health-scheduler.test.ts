import { afterEach, describe, expect, it, vi } from "vitest";

import { startCloudLinkHealthScheduler } from "../src/cloudlink-health-scheduler.js";

const emptySweep = {
  evaluated: 0,
  suspected: 0,
  closed: 0,
  leaseConflicts: 0,
  invalidCandidates: 0,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("CloudLink health scheduler", () => {
  it("runs immediately, never overlaps, and stops cleanly", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise<Readonly<{ ok: true; value: typeof emptySweep }>>(
          (resolve) => {
            release = () => {
              resolve({ ok: true, value: emptySweep });
            };
          },
        ),
    );
    const scheduler = startCloudLinkHealthScheduler({
      reconcile: { execute },
      intervalMs: 1_000,
      batchSize: 25,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(execute).toHaveBeenCalledTimes(1);
    release?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(execute).toHaveBeenCalledTimes(2);
    release?.();
    await scheduler.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("contains failures and schedules the next sweep", async () => {
    vi.useFakeTimers();
    const sweepFailed = vi.fn();
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("storage detail must stay internal"))
      .mockResolvedValue({ ok: true, value: emptySweep });
    const scheduler = startCloudLinkHealthScheduler({
      reconcile: { execute },
      observer: { sweepFailed },
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweepFailed).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    await scheduler.close();
  });
});
