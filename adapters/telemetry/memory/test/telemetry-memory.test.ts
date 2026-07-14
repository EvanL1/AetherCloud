import { describe, expect, it } from "vitest";

import type { TelemetryPersistenceInput } from "@aether-cloud/application";
import {
  defineTelemetryBatch,
  parseEdgeInstanceId,
  parseEdgePointId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseSourceTimestampMs,
  parseTelemetryStreamEpoch,
  parseTelemetryStreamId,
  parseTelemetryStreamPosition,
  parseTenantId,
  parseThingModelRevision,
  parseUtcInstant,
  type GatewayCredentialBinding,
  type TelemetryBatch,
} from "@aether-cloud/domain";

import {
  InMemoryTelemetryRepository,
  NodeTelemetryBatchDigestor,
} from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const binding: GatewayCredentialBinding = {
  tenantId,
  projectId,
  gatewayId,
  generation: parseGatewayCredentialGeneration("3"),
  status: "active",
};

function batch(first: string, count: number, replay = false): TelemetryBatch {
  return defineTelemetryBatch({
    streamId: parseTelemetryStreamId("business-telemetry"),
    streamEpoch: parseTelemetryStreamEpoch("3"),
    retentionClass: "standard-30d",
    replay,
    records: Array.from({ length: count }, (_, offset) => ({
      kind: "point-sample" as const,
      position: parseTelemetryStreamPosition(
        (BigInt(first) + BigInt(offset)).toString(),
      ),
      sourceTimestampMs: parseSourceTimestampMs(
        (1_784_016_000_000n + BigInt(offset)).toString(),
      ),
      instanceId: parseEdgeInstanceId("42"),
      pointId: parseEdgePointId("7"),
      quality: "good" as const,
      value: { type: "float64" as const, value: 21.5 + offset },
      model: {
        modelId: "aether.temperature-sensor",
        revision: parseThingModelRevision("7"),
      },
    })),
  });
}

async function persistenceInput(
  value: TelemetryBatch,
  requestId: string,
  digestor = new NodeTelemetryBatchDigestor(),
): Promise<TelemetryPersistenceInput> {
  return {
    requestId,
    binding,
    batch: value,
    payloadDigest: await digestor.digest(value),
    receivedAt: parseUtcInstant("2026-07-14T09:05:00.000Z"),
  };
}

describe("telemetry in-memory adapters", () => {
  it("digests canonical business content without transport replay metadata", async () => {
    const digestor = new NodeTelemetryBatchDigestor();

    expect(await digestor.digest(batch("0", 2, false))).toBe(
      await digestor.digest(batch("0", 2, true)),
    );
    expect(await digestor.digest(batch("0", 2))).not.toBe(
      await digestor.digest(batch("1", 2)),
    );
  });

  it("persists atomically, returns the identical receipt on replay, and emits once", async () => {
    const repository = new InMemoryTelemetryRepository();
    const input = await persistenceInput(
      batch("0", 2),
      "telemetry-request-001",
    );

    const first = await repository.persist(input);
    const replay = await repository.persist({
      ...input,
      receivedAt: parseUtcInstant("2026-07-14T09:06:00.000Z"),
    });

    expect(first).toMatchObject({
      outcome: "persisted",
      receipt: { contiguousPosition: "1", recordCount: 2 },
    });
    expect(replay).toEqual(
      first.outcome === "persisted"
        ? { outcome: "duplicate", receipt: first.receipt }
        : undefined,
    );
    expect(repository.historyRecordCount()).toBe(2);
    expect(repository.pendingOutboxEvents()).toHaveLength(1);
    expect(repository.auditEvents()).toHaveLength(1);
  });

  it("persists a forward gap without advancing the cursor, then coalesces when filled", async () => {
    const repository = new InMemoryTelemetryRepository();
    const later = await repository.persist(
      await persistenceInput(batch("3", 2), "telemetry-request-003"),
    );
    const fill = await repository.persist(
      await persistenceInput(batch("0", 3), "telemetry-request-000"),
    );

    expect(later).toMatchObject({
      outcome: "persisted",
      receipt: {
        gap: { expectedPosition: "0", receivedPosition: "3" },
      },
    });
    if (later.outcome === "persisted") {
      expect(later.receipt).not.toHaveProperty("contiguousPosition");
    }
    expect(fill).toMatchObject({
      outcome: "persisted",
      receipt: { contiguousPosition: "4" },
    });
  });

  it("detects conflicting replay and overlapping position identities", async () => {
    const repository = new InMemoryTelemetryRepository();
    const original = await persistenceInput(
      batch("3", 2),
      "telemetry-request-003",
    );
    await repository.persist(original);

    expect(
      await repository.persist({ ...original, payloadDigest: "b".repeat(64) }),
    ).toEqual({ outcome: "conflicting-replay" });
    expect(
      await repository.persist(
        await persistenceInput(batch("2", 2), "telemetry-request-002"),
      ),
    ).toEqual({ outcome: "position-conflict" });
  });

  it("fails atomically for storage and quota rejection", async () => {
    const unavailable = new InMemoryTelemetryRepository();
    unavailable.failNextPersistence();
    expect(
      await unavailable.persist(
        await persistenceInput(batch("0", 2), "telemetry-request-001"),
      ),
    ).toEqual({ outcome: "storage-unavailable" });
    expect(unavailable.historyRecordCount()).toBe(0);

    const quota = new InMemoryTelemetryRepository({
      maximumRecordsPerGateway: 1,
    });
    expect(
      await quota.persist(
        await persistenceInput(batch("0", 2), "telemetry-request-001"),
      ),
    ).toEqual({ outcome: "quota-exceeded" });
    expect(quota.historyRecordCount()).toBe(0);
  });

  it("queries ordered history within trusted tenant and epoch scope", async () => {
    const repository = new InMemoryTelemetryRepository();
    await repository.persist(
      await persistenceInput(batch("3", 2), "telemetry-request-003"),
    );
    await repository.persist(
      await persistenceInput(batch("0", 3), "telemetry-request-000"),
    );
    const query = {
      tenantId,
      projectId,
      gatewayId,
      streamId: parseTelemetryStreamId("business-telemetry"),
      streamEpoch: parseTelemetryStreamEpoch("3"),
      fromPosition: parseTelemetryStreamPosition("2"),
      limit: 2,
    };

    expect(
      (await repository.queryHistory(query)).map(
        (item) => item.record.position,
      ),
    ).toEqual(["2", "3"]);
    expect(
      await repository.queryHistory({
        ...query,
        tenantId: parseTenantId("99999999-9999-4999-8999-999999999999"),
      }),
    ).toEqual([]);
  });
});
