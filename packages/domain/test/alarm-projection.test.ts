import { describe, expect, it } from "vitest";

import {
  defineAlarmFact,
  parseAlarmFactId,
  parseAlarmGeneration,
  parseAlarmOccurrenceId,
  parseAlarmRuleId,
  parseAlarmSequence,
  parseEdgeInstanceId,
  parseEdgePointId,
  parseSourceTimestampMs,
  projectAlarmFact,
} from "../src/index.js";

function fact(
  sequence: string,
  kind: "cleared" | "raised" | "updated" = "raised",
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return defineAlarmFact({
    factId: parseAlarmFactId(
      sequence === "0"
        ? "44444444-4444-4444-8444-444444444440"
        : sequence === "1"
          ? "44444444-4444-4444-8444-444444444441"
          : "44444444-4444-4444-8444-444444444442",
    ),
    occurrenceId: parseAlarmOccurrenceId(
      "55555555-5555-4555-8555-555555555555",
    ),
    ruleId: parseAlarmRuleId("temperature.high"),
    generation: parseAlarmGeneration("3"),
    sequence: parseAlarmSequence(sequence),
    kind,
    severity: kind === "cleared" ? "info" : "high",
    sourceTimestampMs: parseSourceTimestampMs(
      (1_784_016_000_000n + BigInt(sequence)).toString(),
    ),
    instanceId: parseEdgeInstanceId("42"),
    pointId: parseEdgePointId("7"),
    summary: kind === "cleared" ? "Temperature recovered" : "Temperature high",
    ...overrides,
  });
}

describe("alarm projection domain", () => {
  it("preserves lossless generation and sequence values", () => {
    expect(parseAlarmGeneration("18446744073709551615")).toBe(
      "18446744073709551615",
    );
    expect(parseAlarmSequence("18446744073709551615")).toBe(
      "18446744073709551615",
    );
    expect(() => parseAlarmSequence(1)).toThrow(/unsigned 64-bit/);
    expect(() => parseAlarmGeneration("01")).toThrow(/unsigned 64-bit/);
  });

  it("projects raised, updated, and cleared edge facts without cloud authority", () => {
    const raised = projectAlarmFact(undefined, fact("0"));
    if (!raised.ok || raised.projection === undefined) {
      throw new Error("expected raised projection");
    }
    const updated = projectAlarmFact(
      raised.projection,
      fact("1", "updated", { severity: "critical" }),
    );
    if (!updated.ok || updated.projection === undefined) {
      throw new Error("expected updated projection");
    }
    const cleared = projectAlarmFact(updated.projection, fact("2", "cleared"));

    expect(raised.projection).toMatchObject({
      state: "active",
      severity: "high",
      edgeFactAuthoritative: true,
      cloudWorkflowState: "unacknowledged",
    });
    expect(updated.projection).toMatchObject({
      state: "active",
      severity: "critical",
      lastSequence: "1",
    });
    expect(cleared).toMatchObject({
      ok: true,
      disposition: "accepted-latest",
      projection: { state: "cleared", lastSequence: "2" },
    });
  });

  it("keeps forward gaps explicit and prevents late facts rolling back state", () => {
    const raised = projectAlarmFact(undefined, fact("0"));
    if (!raised.ok || raised.projection === undefined) {
      throw new Error("expected raised projection");
    }
    const gap = projectAlarmFact(raised.projection, fact("2", "cleared"));
    if (!gap.ok || gap.projection === undefined) {
      throw new Error("expected gap projection");
    }
    const late = projectAlarmFact(gap.projection, fact("1", "updated"));

    expect(gap).toMatchObject({
      disposition: "accepted-gap",
      projection: {
        state: "cleared",
        gap: { expectedSequence: "1", receivedSequence: "2" },
      },
    });
    expect(late).toEqual({
      ok: true,
      disposition: "accepted-late",
      updatesProjection: false,
    });
  });

  it("classifies exact replay and rejects sequence identity conflicts", () => {
    const raised = projectAlarmFact(undefined, fact("0"));
    if (!raised.ok || raised.projection === undefined) {
      throw new Error("expected raised projection");
    }

    expect(projectAlarmFact(raised.projection, fact("0"))).toEqual({
      ok: true,
      disposition: "replayed",
      updatesProjection: false,
    });
    expect(
      projectAlarmFact(
        raised.projection,
        fact("0", "raised", {
          factId: parseAlarmFactId("66666666-6666-4666-8666-666666666666"),
        }),
      ),
    ).toMatchObject({
      ok: false,
      failure: { code: "alarm-sequence-conflict" },
    });
  });

  it("does not clear an alarm because connectivity becomes stale", () => {
    const raised = projectAlarmFact(undefined, fact("0"));
    if (!raised.ok || raised.projection === undefined) {
      throw new Error("expected raised projection");
    }

    expect(raised.projection.state).toBe("active");
    expect(raised.projection).not.toHaveProperty("connectionState");
  });
});
