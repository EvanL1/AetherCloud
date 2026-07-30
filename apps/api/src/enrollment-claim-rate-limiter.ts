export interface EnrollmentClaimRateLimiter {
  allow(key: string, nowMilliseconds: number): boolean;
}

/** Bounded process-local abuse guard; production ingress may add a stronger shared limit. */
export class FixedWindowEnrollmentClaimRateLimiter implements EnrollmentClaimRateLimiter {
  readonly #maximumKeys: number;
  readonly #maximumAttempts: number;
  readonly #windowMilliseconds: number;
  readonly #windows = new Map<
    string,
    Readonly<{ attempts: number; startedAt: number }>
  >();

  constructor(
    options: Readonly<{
      maximumKeys?: number;
      maximumAttempts?: number;
      windowMilliseconds?: number;
    }> = {},
  ) {
    this.#maximumKeys = options.maximumKeys ?? 10_000;
    this.#maximumAttempts = options.maximumAttempts ?? 20;
    this.#windowMilliseconds = options.windowMilliseconds ?? 60_000;
  }

  allow(key: string, nowMilliseconds: number): boolean {
    const current = this.#windows.get(key);
    if (
      current === undefined ||
      nowMilliseconds - current.startedAt >= this.#windowMilliseconds
    ) {
      if (current === undefined && this.#windows.size >= this.#maximumKeys) {
        const oldest = this.#windows.keys().next().value;
        if (oldest !== undefined) this.#windows.delete(oldest);
      }
      this.#windows.set(key, { attempts: 1, startedAt: nowMilliseconds });
      return true;
    }
    if (current.attempts >= this.#maximumAttempts) return false;
    this.#windows.delete(key);
    this.#windows.set(key, {
      attempts: current.attempts + 1,
      startedAt: current.startedAt,
    });
    return true;
  }
}
