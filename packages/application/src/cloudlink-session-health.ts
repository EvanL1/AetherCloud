import {
  InvalidDomainValueError,
  markCloudLinkSessionHeartbeatTimedOut,
  markCloudLinkSessionSuspect,
  parseUtcInstant,
} from "@aether-cloud/domain";
import type { UtcInstant } from "@aether-cloud/domain";

import { RECONCILE_CLOUDLINK_SESSION_HEALTH_COMMAND } from "./capability-definition.js";
import type {
  CloudLinkSessionHealthIdGenerator,
  CloudLinkSessionHealthRepository,
} from "./cloudlink-session-repository.js";
import type { ApplicationClock } from "./gateway-identity-repository.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface CloudLinkSessionHealthSweepView {
  readonly evaluated: number;
  readonly suspected: number;
  readonly closed: number;
  readonly leaseConflicts: number;
  readonly invalidCandidates: number;
}

export type CloudLinkSessionHealthSweepResult =
  | Readonly<{ ok: true; value: CloudLinkSessionHealthSweepView }>
  | Readonly<{
      ok: false;
      failure: Readonly<{
        code: "cloudlink-health-storage-unavailable" | "invalid-input";
        message: string;
      }>;
    }>;

class CloudLinkSessionHealthInputError extends Error {}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function nextId(generator: CloudLinkSessionHealthIdGenerator): string {
  const value = generator.next();
  if (!canonicalUuidPattern.test(value)) {
    throw new Error("CloudLink health ID generator returned an invalid UUID");
  }
  return value;
}

function addMilliseconds(
  instant: UtcInstant,
  milliseconds: number,
): UtcInstant {
  const value = Date.parse(instant);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new Error("CloudLink health lease duration is invalid");
  }
  const result = value + milliseconds;
  if (!Number.isSafeInteger(result)) {
    throw new Error("CloudLink health lease expiry is outside the safe range");
  }
  return parseUtcInstant(new Date(result).toISOString());
}

export class ReconcileCloudLinkSessionHealth {
  static readonly definition = RECONCILE_CLOUDLINK_SESSION_HEALTH_COMMAND;

  readonly #repository: CloudLinkSessionHealthRepository;
  readonly #clock: ApplicationClock;
  readonly #ids: CloudLinkSessionHealthIdGenerator;
  readonly #leaseDurationMs: number;

  constructor(dependencies: {
    readonly repository: CloudLinkSessionHealthRepository;
    readonly clock: ApplicationClock;
    readonly ids: CloudLinkSessionHealthIdGenerator;
    readonly leaseDurationMs?: number;
  }) {
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
    this.#leaseDurationMs = dependencies.leaseDurationMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#leaseDurationMs) ||
      this.#leaseDurationMs < 1_000 ||
      this.#leaseDurationMs > 300_000
    ) {
      throw new TypeError(
        "CloudLink health lease duration must be 1000-300000 milliseconds",
      );
    }
  }

  async execute(rawInput: unknown): Promise<CloudLinkSessionHealthSweepResult> {
    let limit: number;
    try {
      if (!isRecord(rawInput)) {
        throw new CloudLinkSessionHealthInputError(
          "sweep input must be an object",
        );
      }
      const keys = Object.keys(rawInput);
      if (keys.some((key) => key !== "limit")) {
        throw new CloudLinkSessionHealthInputError(
          "sweep input contains unknown fields",
        );
      }
      const candidate = rawInput.limit ?? 100;
      if (
        typeof candidate !== "number" ||
        !Number.isInteger(candidate) ||
        candidate < 1 ||
        candidate > 500
      ) {
        throw new CloudLinkSessionHealthInputError(
          "limit must be an integer from 1 to 500",
        );
      }
      limit = candidate;
    } catch (error: unknown) {
      if (
        error instanceof CloudLinkSessionHealthInputError ||
        error instanceof InvalidDomainValueError
      ) {
        return {
          ok: false,
          failure: { code: "invalid-input", message: error.message },
        };
      }
      throw error;
    }

    const evaluatedAt = this.#clock.now();
    const leaseId = nextId(this.#ids);
    const leased = await this.#repository.leaseDue({
      leaseId,
      evaluatedAt,
      leaseExpiresAt: addMilliseconds(evaluatedAt, this.#leaseDurationMs),
      limit,
    });
    if (leased.outcome === "storage-unavailable") {
      return {
        ok: false,
        failure: {
          code: "cloudlink-health-storage-unavailable",
          message: "CloudLink health storage is unavailable",
        },
      };
    }

    let suspected = 0;
    let closed = 0;
    let leaseConflicts = 0;
    let invalidCandidates = 0;
    for (const lease of leased.leases) {
      if (lease.leaseId !== leaseId) {
        invalidCandidates += 1;
        continue;
      }
      const transition =
        lease.session.state === "active"
          ? markCloudLinkSessionSuspect(lease.session, evaluatedAt)
          : lease.session.state === "suspect"
            ? markCloudLinkSessionHeartbeatTimedOut(lease.session, evaluatedAt)
            : undefined;
      if (transition === undefined || !transition.ok) {
        invalidCandidates += 1;
        continue;
      }
      const closing = transition.value.state === "closed";
      const completed = await this.#repository.complete({
        leaseId,
        session: transition.value,
        expectedRevision: lease.session.revision,
        evidence: {
          eventId: nextId(this.#ids),
          outboxId: nextId(this.#ids),
          occurredAt: evaluatedAt,
          eventName: closing
            ? "cloudlink.session.heartbeat-timed-out.v1"
            : "cloudlink.session.suspected.v1",
        },
      });
      if (completed === "storage-unavailable") {
        return {
          ok: false,
          failure: {
            code: "cloudlink-health-storage-unavailable",
            message: "CloudLink health storage is unavailable",
          },
        };
      }
      if (completed === "lease-lost") {
        leaseConflicts += 1;
      } else if (closing) {
        closed += 1;
      } else {
        suspected += 1;
      }
    }

    return {
      ok: true,
      value: {
        evaluated: leased.leases.length,
        suspected,
        closed,
        leaseConflicts,
        invalidCandidates,
      },
    };
  }
}
