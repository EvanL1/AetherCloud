import { describe, expect, it } from "vitest";

import {
  ACKNOWLEDGE_ALARM_COMMAND,
  AcknowledgeAlarm,
  GET_ALARM_PROJECTION_QUERY,
  GetAlarmProjection,
  INGEST_ALARM_FACT_COMMAND,
  IngestAlarmFact,
  type AlarmAcknowledgementInput,
  type AlarmAcknowledgementResult,
  type AlarmFactDigestor,
  type AlarmIngestionInput,
  type AlarmIngestionResult,
  type AlarmProjectionRecord,
  type AlarmRepository,
  type ApplicationClock,
  type GatewayCredentialVerificationResult,
  type GatewayCredentialVerifier,
} from "../src/index.js";
import {
  parseAlarmOccurrenceId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  type GatewayCredentialBinding,
} from "@aether-cloud/domain";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const occurrenceId = parseAlarmOccurrenceId(
  "55555555-5555-4555-8555-555555555555",
);

class FixedClock implements ApplicationClock {
  now() {
    return parseUtcInstant("2026-07-14T10:05:00.000Z");
  }
}

function binding(
  status: GatewayCredentialBinding["status"] = "active",
): GatewayCredentialBinding {
  return {
    tenantId,
    projectId,
    gatewayId,
    generation: parseGatewayCredentialGeneration("3"),
    status,
  };
}

class StubVerifier implements GatewayCredentialVerifier {
  calls = 0;
  readonly #result: GatewayCredentialVerificationResult;

  constructor(
    result: GatewayCredentialVerificationResult = {
      ok: true,
      value: binding(),
    },
  ) {
    this.#result = result;
  }

  verify(): Promise<GatewayCredentialVerificationResult> {
    this.calls += 1;
    return Promise.resolve(this.#result);
  }
}

class StubDigestor implements AlarmFactDigestor {
  calls = 0;

  digest() {
    this.calls += 1;
    return Promise.resolve("a".repeat(64));
  }
}

class StubAlarmRepository implements AlarmRepository {
  ingested: AlarmIngestionInput | undefined;
  acknowledged: AlarmAcknowledgementInput | undefined;
  current: AlarmProjectionRecord | undefined;
  ingestionResult: AlarmIngestionResult | undefined;
  acknowledgementResult: AlarmAcknowledgementResult | undefined;

  ingest(input: AlarmIngestionInput): Promise<AlarmIngestionResult> {
    this.ingested = input;
    if (this.ingestionResult !== undefined) {
      return Promise.resolve(this.ingestionResult);
    }
    const record: AlarmProjectionRecord = {
      tenantId: input.binding.tenantId,
      projectId: input.binding.projectId,
      gatewayId: input.binding.gatewayId,
      receivedAt: input.receivedAt,
      projection: {
        occurrenceId: input.fact.occurrenceId,
        ruleId: input.fact.ruleId,
        generation: input.fact.generation,
        lastSequence: input.fact.sequence,
        lastFactId: input.fact.factId,
        state: input.fact.kind === "cleared" ? "cleared" : "active",
        severity: input.fact.severity,
        summary: input.fact.summary,
        sourceTimestampMs: input.fact.sourceTimestampMs,
        instanceId: input.fact.instanceId,
        ...(input.fact.pointId === undefined
          ? {}
          : { pointId: input.fact.pointId }),
        raisedAt: input.fact.sourceTimestampMs,
        edgeFactAuthoritative: true,
        cloudWorkflowState: "unacknowledged",
        revision: 1,
      },
    };
    this.current = record;
    return Promise.resolve({
      outcome: "persisted",
      disposition: "accepted-latest",
      record,
    });
  }

  findCurrent(scope: {
    tenantId: typeof tenantId;
    projectId: typeof projectId;
  }) {
    return Promise.resolve(
      scope.tenantId === tenantId && scope.projectId === projectId
        ? this.current
        : undefined,
    );
  }

  acknowledge(
    input: AlarmAcknowledgementInput,
  ): Promise<AlarmAcknowledgementResult> {
    this.acknowledged = input;
    if (this.acknowledgementResult !== undefined) {
      return Promise.resolve(this.acknowledgementResult);
    }
    if (this.current === undefined) {
      return Promise.resolve({ outcome: "not-found" });
    }
    this.current = {
      ...this.current,
      projection: {
        ...this.current.projection,
        cloudWorkflowState: "acknowledged",
        revision: this.current.projection.revision + 1,
      },
      acknowledgement: {
        subjectId: input.subjectId,
        acknowledgedAt: input.acknowledgedAt,
      },
    };
    return Promise.resolve({ outcome: "acknowledged", record: this.current });
  }
}

const gatewayCommandContext = {
  idempotencyKey: "alarm-fact-ingest-001",
  issuedAt: "2026-07-14T10:00:00.000Z",
  expiresAt: "2026-07-14T10:10:00.000Z",
};

const tenantCommandContext = {
  tenantId,
  projectId,
  subjectId: "operator:alice",
  permissions: ["alarm.workflow.acknowledge"],
  idempotencyKey: "alarm-acknowledge-001",
  issuedAt: "2026-07-14T10:00:00.000Z",
  expiresAt: "2026-07-14T10:10:00.000Z",
};

const alarmInput = {
  credential: {
    credentialId: "gateway-credential-003",
    proof: "opaque-test-proof-material",
  },
  fact: {
    factId: "44444444-4444-4444-8444-444444444440",
    occurrenceId,
    ruleId: "temperature.high",
    generation: "3",
    sequence: "0",
    kind: "raised",
    severity: "high",
    sourceTimestampMs: "1784016000000",
    instanceId: "42",
    pointId: "7",
    summary: "Temperature high",
  },
};

function fixture() {
  const verifier = new StubVerifier();
  const digestor = new StubDigestor();
  const repository = new StubAlarmRepository();
  return {
    verifier,
    digestor,
    repository,
    ingest: new IngestAlarmFact({
      verifier,
      digestor,
      repository,
      clock: new FixedClock(),
    }),
  };
}

describe("alarm projection application", () => {
  it("declares separate edge-fact, query, and cloud-workflow governance", () => {
    expect(INGEST_ALARM_FACT_COMMAND).toMatchObject({
      kind: "command",
      permission: "alarm.fact.ingest",
      authorization: "gateway-credential",
      audit: "required",
    });
    expect(GET_ALARM_PROJECTION_QUERY).toEqual({
      kind: "query",
      name: "alarm.projection.get",
      permission: "alarm.projection.read",
    });
    expect(ACKNOWLEDGE_ALARM_COMMAND).toMatchObject({
      kind: "command",
      permission: "alarm.workflow.acknowledge",
      authorization: "tenant-permission",
      audit: "required",
    });
  });

  it("rejects unknown fact fields before authentication", async () => {
    const value = fixture();

    expect(
      await value.ingest.execute(gatewayCommandContext, {
        ...alarmInput,
        fact: { ...alarmInput.fact, directDeviceControl: true },
      }),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    expect(value.verifier.calls).toBe(0);
    expect(value.digestor.calls).toBe(0);
  });

  it("derives scope from the active credential and persists edge authority", async () => {
    const value = fixture();
    const result = await value.ingest.execute(
      gatewayCommandContext,
      alarmInput,
    );

    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        disposition: "accepted-latest",
        projection: {
          tenantId,
          projectId,
          gatewayId,
          occurrenceId,
          state: "active",
          edgeFactAuthoritative: true,
          cloudWorkflowState: "unacknowledged",
        },
      },
    });
    expect(value.repository.ingested).toMatchObject({
      requestId: "alarm-fact-ingest-001",
      binding: { tenantId, projectId, gatewayId },
      payloadDigest: "a".repeat(64),
    });
  });

  it("maps replay, fact conflict, sequence conflict, and storage failure", async () => {
    const replay = fixture();
    await replay.ingest.execute(gatewayCommandContext, alarmInput);
    if (replay.repository.current === undefined) {
      throw new Error("expected replay fixture projection");
    }
    replay.repository.ingestionResult = {
      outcome: "replayed",
      disposition: "replayed",
      record: replay.repository.current,
    };
    expect(
      await replay.ingest.execute(gatewayCommandContext, alarmInput),
    ).toMatchObject({
      ok: true,
      replayed: true,
      value: { disposition: "replayed" },
    });

    const cases: readonly [AlarmIngestionResult, string][] = [
      [{ outcome: "fact-conflict" }, "alarm-fact-conflict"],
      [{ outcome: "sequence-conflict" }, "alarm-sequence-conflict"],
      [{ outcome: "storage-unavailable" }, "alarm-storage-unavailable"],
    ];

    for (const [repositoryResult, expected] of cases) {
      const value = fixture();
      value.repository.ingestionResult = repositoryResult;
      const result = await value.ingest.execute(
        gatewayCommandContext,
        alarmInput,
      );
      expect(result).toMatchObject({ ok: false, failure: { code: expected } });
    }
  });

  it("queries a tenant-scoped projection without presenting cloud workflow as edge clear", async () => {
    const value = fixture();
    await value.ingest.execute(gatewayCommandContext, alarmInput);
    const query = new GetAlarmProjection({ repository: value.repository });
    const context = {
      tenantId,
      projectId,
      subjectId: "operator:alice",
      permissions: ["alarm.projection.read"],
    };

    expect(await query.execute(context, { occurrenceId })).toMatchObject({
      ok: true,
      value: {
        state: "active",
        edgeFactAuthoritative: true,
        cloudWorkflowState: "unacknowledged",
      },
    });
    expect(
      await query.execute({ ...context, permissions: [] }, { occurrenceId }),
    ).toMatchObject({ ok: false, failure: { code: "permission-denied" } });
  });

  it("acknowledges only the cloud workflow and preserves the edge alarm state", async () => {
    const value = fixture();
    await value.ingest.execute(gatewayCommandContext, alarmInput);
    const acknowledge = new AcknowledgeAlarm({
      repository: value.repository,
      clock: new FixedClock(),
    });

    expect(
      await acknowledge.execute(tenantCommandContext, { occurrenceId }),
    ).toMatchObject({
      ok: true,
      value: {
        state: "active",
        cloudWorkflowState: "acknowledged",
        edgeFactAuthoritative: true,
        acknowledgement: { subjectId: "operator:alice" },
      },
    });
  });
});
