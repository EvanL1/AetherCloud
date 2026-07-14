import { describe, expect, it } from "vitest";

import type { AlarmIngestionInput } from "@aether-cloud/application";
import {
  defineAlarmFact,
  parseAlarmFactId,
  parseAlarmGeneration,
  parseAlarmOccurrenceId,
  parseAlarmRuleId,
  parseAlarmSequence,
  parseEdgeInstanceId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseSourceTimestampMs,
  parseTenantId,
  parseUtcInstant,
  type AlarmFactKind,
  type GatewayCredentialBinding,
} from "@aether-cloud/domain";

import {
  InMemoryAlarmRepository,
  NodeAlarmFactDigestor,
} from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const occurrenceId = parseAlarmOccurrenceId(
  "55555555-5555-4555-8555-555555555555",
);
const binding: GatewayCredentialBinding = {
  tenantId,
  projectId,
  gatewayId,
  generation: parseGatewayCredentialGeneration("3"),
  status: "active",
};

function fact(sequence: string, kind: AlarmFactKind = "raised") {
  return defineAlarmFact({
    factId: parseAlarmFactId(`44444444-4444-4444-8444-44444444444${sequence}`),
    occurrenceId,
    ruleId: parseAlarmRuleId("temperature.high"),
    generation: parseAlarmGeneration("3"),
    sequence: parseAlarmSequence(sequence),
    kind,
    severity: kind === "cleared" ? "info" : "high",
    sourceTimestampMs: parseSourceTimestampMs(
      (1_784_016_000_000n + BigInt(sequence)).toString(),
    ),
    instanceId: parseEdgeInstanceId("42"),
    summary: kind === "cleared" ? "Temperature recovered" : "Temperature high",
  });
}

async function input(
  sequence: string,
  requestId: string,
  kind: AlarmFactKind = "raised",
): Promise<AlarmIngestionInput> {
  const alarmFact = fact(sequence, kind);
  return {
    requestId,
    binding,
    fact: alarmFact,
    payloadDigest: await new NodeAlarmFactDigestor().digest(alarmFact),
    receivedAt: parseUtcInstant("2026-07-14T10:05:00.000Z"),
  };
}

describe("alarm in-memory adapters", () => {
  it("returns the same replay result without duplicate audit or outbox events", async () => {
    const repository = new InMemoryAlarmRepository();
    const original = await input("0", "alarm-fact-ingest-000");

    expect(await repository.ingest(original)).toMatchObject({
      outcome: "persisted",
      disposition: "accepted-latest",
      record: { projection: { state: "active" } },
    });
    expect(await repository.ingest(original)).toMatchObject({
      outcome: "replayed",
      disposition: "replayed",
    });
    expect(repository.auditEvents()).toHaveLength(1);
    expect(repository.pendingOutboxEvents()).toHaveLength(1);
  });

  it("keeps gaps and late facts without rolling the current projection backward", async () => {
    const repository = new InMemoryAlarmRepository();
    await repository.ingest(await input("0", "alarm-fact-ingest-000"));
    expect(
      await repository.ingest(
        await input("2", "alarm-fact-ingest-002", "cleared"),
      ),
    ).toMatchObject({
      disposition: "accepted-gap",
      record: {
        projection: {
          state: "cleared",
          gap: { expectedSequence: "1", receivedSequence: "2" },
        },
      },
    });
    expect(
      await repository.ingest(
        await input("1", "alarm-fact-ingest-001", "updated"),
      ),
    ).toMatchObject({
      disposition: "accepted-late",
      record: { projection: { state: "cleared", lastSequence: "2" } },
    });
  });

  it("rejects fact identity conflict and sequence identity conflict", async () => {
    const repository = new InMemoryAlarmRepository();
    const original = await input("0", "alarm-fact-ingest-000");
    await repository.ingest(original);

    expect(
      await repository.ingest({ ...original, payloadDigest: "b".repeat(64) }),
    ).toEqual({ outcome: "fact-conflict" });
    const sequenceConflict = await input("0", "alarm-fact-ingest-other");
    const conflictingFact = defineAlarmFact({
      ...sequenceConflict.fact,
      factId: parseAlarmFactId("66666666-6666-4666-8666-666666666666"),
    });
    expect(
      await repository.ingest({
        ...sequenceConflict,
        fact: conflictingFact,
        payloadDigest: await new NodeAlarmFactDigestor().digest(
          conflictingFact,
        ),
      }),
    ).toEqual({ outcome: "sequence-conflict" });
  });

  it("acknowledges cloud workflow idempotently without changing edge state", async () => {
    const repository = new InMemoryAlarmRepository();
    await repository.ingest(await input("0", "alarm-fact-ingest-000"));
    const acknowledgement = {
      tenantId,
      projectId,
      occurrenceId,
      requestId: "alarm-acknowledge-001",
      subjectId: "operator:alice",
      acknowledgedAt: parseUtcInstant("2026-07-14T10:06:00.000Z"),
    };

    expect(await repository.acknowledge(acknowledgement)).toMatchObject({
      outcome: "acknowledged",
      record: {
        projection: { state: "active", cloudWorkflowState: "acknowledged" },
      },
    });
    expect(await repository.acknowledge(acknowledgement)).toMatchObject({
      outcome: "replayed",
      record: { projection: { state: "active" } },
    });
  });

  it("isolates tenant queries and fails storage atomically", async () => {
    const repository = new InMemoryAlarmRepository();
    repository.failNextPersistence();
    expect(
      await repository.ingest(await input("0", "alarm-fact-ingest-000")),
    ).toEqual({ outcome: "storage-unavailable" });
    expect(
      await repository.findCurrent({ tenantId, projectId }, occurrenceId),
    ).toBeUndefined();
    await repository.ingest(await input("0", "alarm-fact-ingest-000"));
    expect(
      await repository.findCurrent(
        {
          tenantId: parseTenantId("99999999-9999-4999-8999-999999999999"),
          projectId,
        },
        occurrenceId,
      ),
    ).toBeUndefined();
  });
});
