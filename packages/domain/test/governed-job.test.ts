import { describe, expect, it } from "vitest";

import {
  createGovernedJob,
  expireGovernedJob,
  markGovernedJobUnknown,
  offerGovernedJob,
  parseContentDigest,
  parseEdgeCapabilityId,
  parseGatewayId,
  parseGovernedJobId,
  parseJobReceiptId,
  parseJobReceiptSequence,
  parseUtcInstant,
  queueGovernedJob,
  recordGovernedJobReceipt,
  requestGovernedJobCancellation,
} from "../src/index.js";

const jobId = parseGovernedJobId("11111111-1111-4111-8111-111111111111");
const gatewayId = parseGatewayId("22222222-2222-4222-8222-222222222222");

function job() {
  return createGovernedJob({
    jobId,
    gatewayId,
    capabilityId: parseEdgeCapabilityId("diagnostics.snapshot.v1"),
    capabilityPermission: "edge.job.diagnostics.snapshot",
    risk: "low",
    confirmation: "not-required",
    replaySafety: "safe",
    physicalEffect: false,
    argumentsDigest: parseContentDigest("a".repeat(64)),
    preconditionDigest: parseContentDigest("b".repeat(64)),
    createdAt: parseUtcInstant("2026-07-14T02:00:00.000Z"),
    expiresAt: parseUtcInstant("2026-07-14T02:10:00.000Z"),
  });
}

function receipt(
  sequence: string,
  kind:
    | "accepted"
    | "failed"
    | "partial"
    | "rejected"
    | "running"
    | "succeeded",
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    receiptId: parseJobReceiptId(
      sequence === "1"
        ? "33333333-3333-4333-8333-333333333333"
        : sequence === "2"
          ? "44444444-4444-4444-8444-444444444444"
          : "55555555-5555-4555-8555-555555555555",
    ),
    payloadDigest: parseContentDigest(sequence.repeat(64)),
    sequence: parseJobReceiptSequence(sequence),
    kind,
    observedAt: parseUtcInstant(`2026-07-14T02:0${sequence}:00.000Z`),
    ...overrides,
  } as const;
}

function offeredJob() {
  const queued = queueGovernedJob(
    job(),
    parseUtcInstant("2026-07-14T02:00:15.000Z"),
  );
  return offerGovernedJob(queued, parseUtcInstant("2026-07-14T02:00:30.000Z"));
}

describe("Governed capability Job", () => {
  it("moves only through governed offer and edge receipt facts", () => {
    const offered = offeredJob();
    const accepted = recordGovernedJobReceipt(
      offered,
      receipt("1", "accepted"),
    );
    if (!accepted.ok) throw new Error("accepted fixture failed");
    const running = recordGovernedJobReceipt(
      accepted.job,
      receipt("2", "running"),
    );
    if (!running.ok) throw new Error("running fixture failed");
    const succeeded = recordGovernedJobReceipt(
      running.job,
      receipt("3", "succeeded", {
        evidenceDigest: parseContentDigest("d".repeat(64)),
      }),
    );

    expect(offered.state).toBe("offered");
    expect(accepted.job.state).toBe("accepted");
    expect(running.job.state).toBe("running");
    expect(succeeded).toMatchObject({
      ok: true,
      disposition: "accepted-current",
      job: { state: "succeeded", lastContiguousSequence: "3" },
    });
  });

  it("retains an out-of-order receipt pending its predecessor", () => {
    const offered = offeredJob();
    const gap = recordGovernedJobReceipt(offered, receipt("2", "running"));
    if (!gap.ok) throw new Error("gap fixture failed");
    const filled = recordGovernedJobReceipt(gap.job, receipt("1", "accepted"));

    expect(gap).toMatchObject({
      ok: true,
      disposition: "pending-predecessor",
      job: { state: "offered", lastContiguousSequence: "0" },
    });
    expect(filled).toMatchObject({
      ok: true,
      disposition: "accepted-current",
      job: { state: "running", lastContiguousSequence: "2" },
    });
  });

  it("replays identical Receipts and rejects a conflicting identity", () => {
    const offered = offeredJob();
    const first = recordGovernedJobReceipt(offered, receipt("1", "accepted"));
    if (!first.ok) throw new Error("accepted fixture failed");

    expect(
      recordGovernedJobReceipt(first.job, receipt("1", "accepted")),
    ).toMatchObject({
      ok: true,
      replayed: true,
      disposition: "replayed",
    });
    expect(
      recordGovernedJobReceipt(
        first.job,
        receipt("1", "accepted", {
          payloadDigest: parseContentDigest("e".repeat(64)),
        }),
      ),
    ).toMatchObject({
      ok: false,
      failure: { code: "job-receipt-conflict" },
    });
  });

  it("uses unknown for timeout and lets a late Receipt resolve it", () => {
    const offered = offeredJob();
    const unknown = markGovernedJobUnknown(
      offered,
      parseUtcInstant("2026-07-14T02:01:00.000Z"),
    );
    const resolved = recordGovernedJobReceipt(
      unknown,
      receipt("1", "succeeded", {
        evidenceDigest: parseContentDigest("f".repeat(64)),
      }),
    );

    expect(unknown.state).toBe("unknown");
    expect(resolved).toMatchObject({ ok: true, job: { state: "succeeded" } });
  });

  it("treats cancellation as intent and preserves a late terminal Receipt", () => {
    const offered = offeredJob();
    const cancelling = requestGovernedJobCancellation(
      offered,
      parseUtcInstant("2026-07-14T02:01:00.000Z"),
    );
    const completed = recordGovernedJobReceipt(
      cancelling,
      receipt("1", "succeeded", {
        evidenceDigest: parseContentDigest("f".repeat(64)),
      }),
    );

    expect(cancelling.state).toBe("cancel-requested");
    expect(completed).toMatchObject({ ok: true, job: { state: "succeeded" } });
  });

  it("expires only before edge acceptance and never fabricates a Receipt", () => {
    const expired = expireGovernedJob(
      job(),
      parseUtcInstant("2026-07-14T02:10:00.000Z"),
    );

    expect(expired).toMatchObject({ state: "expired", receipts: [] });
  });
});
