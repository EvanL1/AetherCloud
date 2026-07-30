import { describe, expect, it } from "vitest";

import {
  RECONCILE_CLOUDLINK_SESSION_HEALTH_COMMAND,
  ReconcileCloudLinkSessionHealth,
  type ApplicationClock,
  type CloudLinkSessionHealthIdGenerator,
  type CloudLinkSessionHealthRepository,
  type CompleteCloudLinkSessionHealthInput,
} from "../src/index.js";
import {
  activateCloudLinkSession,
  createCloudLinkSession,
  markCloudLinkSessionSuspect,
  negotiateCloudLinkSession,
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseProtocolVersion,
  parseTenantId,
  parseUtcInstant,
  type CloudLinkSession,
} from "@aether-cloud/domain";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");

class FixedClock implements ApplicationClock {
  now() {
    return parseUtcInstant("2026-07-14T08:05:00.000Z");
  }
}

class SequentialIds implements CloudLinkSessionHealthIdGenerator {
  #value = 0;

  next(): string {
    this.#value += 1;
    return `00000000-0000-4000-8000-${this.#value.toString().padStart(12, "0")}`;
  }
}

function activeSession(id: string, epoch: string): CloudLinkSession {
  const negotiating = createCloudLinkSession({
    tenantId,
    projectId,
    gatewayId,
    sessionId: parseCloudLinkSessionId(id),
    credentialGeneration: parseGatewayCredentialGeneration("3"),
    epoch: parseCloudLinkSessionEpoch(epoch),
    openedAt: parseUtcInstant("2026-07-14T08:00:00.000Z"),
  });
  const negotiated = negotiateCloudLinkSession(
    negotiating,
    parseProtocolVersion("1.0"),
  );
  if (!negotiated.ok) throw new Error(negotiated.failure.message);
  const active = activateCloudLinkSession(negotiated.value, {
    activatedAt: parseUtcInstant("2026-07-14T08:00:01.000Z"),
    resumeCursors: [],
  });
  if (!active.ok) throw new Error(active.failure.message);
  return active.value;
}

class HealthRepository implements CloudLinkSessionHealthRepository {
  readonly sessions: CloudLinkSession[];
  readonly completions: CompleteCloudLinkSessionHealthInput[] = [];
  completeResult: "completed" | "lease-lost" | "storage-unavailable" =
    "completed";

  constructor(sessions: readonly CloudLinkSession[]) {
    this.sessions = [...sessions];
  }

  leaseDue(input: Parameters<CloudLinkSessionHealthRepository["leaseDue"]>[0]) {
    return Promise.resolve({
      outcome: "leased" as const,
      leases: this.sessions.slice(0, input.limit).map((session) => ({
        leaseId: input.leaseId,
        session,
      })),
    });
  }

  complete(input: CompleteCloudLinkSessionHealthInput) {
    this.completions.push(input);
    return Promise.resolve(this.completeResult);
  }
}

describe("CloudLink session health reconciliation", () => {
  it("declares an audited platform-worker command", () => {
    expect(RECONCILE_CLOUDLINK_SESSION_HEALTH_COMMAND).toMatchObject({
      kind: "command",
      name: "cloudlink.session.health.reconcile",
      authorization: "platform-worker",
      audit: "required",
    });
  });

  it("leases due sessions and persists suspect and timeout transitions", async () => {
    const active = activeSession("44444444-4444-4444-8444-444444444444", "9");
    const suspect = markCloudLinkSessionSuspect(
      activeSession("55555555-5555-4555-8555-555555555555", "10"),
      parseUtcInstant("2026-07-14T08:04:00.000Z"),
    );
    if (!suspect.ok) throw new Error(suspect.failure.message);
    const repository = new HealthRepository([active, suspect.value]);
    const useCase = new ReconcileCloudLinkSessionHealth({
      repository,
      clock: new FixedClock(),
      ids: new SequentialIds(),
      leaseDurationMs: 30_000,
    });

    await expect(useCase.execute({ limit: 10 })).resolves.toEqual({
      ok: true,
      value: {
        evaluated: 2,
        suspected: 1,
        closed: 1,
        leaseConflicts: 0,
        invalidCandidates: 0,
      },
    });
    expect(repository.completions).toHaveLength(2);
    expect(repository.completions[0]).toMatchObject({
      expectedRevision: active.revision,
      session: { state: "suspect" },
      evidence: { eventName: "cloudlink.session.suspected.v1" },
    });
    expect(repository.completions[1]).toMatchObject({
      expectedRevision: suspect.value.revision,
      session: { state: "closed", closeReason: "heartbeat-timeout" },
      evidence: { eventName: "cloudlink.session.heartbeat-timed-out.v1" },
    });
  });

  it("reports lease conflicts and fails closed for storage or malformed input", async () => {
    const repository = new HealthRepository([
      activeSession("44444444-4444-4444-8444-444444444444", "9"),
    ]);
    repository.completeResult = "lease-lost";
    const useCase = new ReconcileCloudLinkSessionHealth({
      repository,
      clock: new FixedClock(),
      ids: new SequentialIds(),
    });

    await expect(useCase.execute({ limit: 1 })).resolves.toMatchObject({
      ok: true,
      value: { leaseConflicts: 1, suspected: 0 },
    });
    await expect(useCase.execute({ limit: 0 })).resolves.toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });

    repository.completeResult = "storage-unavailable";
    await expect(useCase.execute({ limit: 1 })).resolves.toEqual({
      ok: false,
      failure: {
        code: "cloudlink-health-storage-unavailable",
        message: "CloudLink health storage is unavailable",
      },
    });
  });
});
