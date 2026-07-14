import { describe, expect, it } from "vitest";

import {
  GET_TELEMETRY_HISTORY_QUERY,
  GetTelemetryHistory,
  INGEST_TELEMETRY_BATCH_COMMAND,
  IngestTelemetryBatch,
  type ApplicationClock,
  type GatewayCredentialVerificationResult,
  type GatewayCredentialVerifier,
  type TelemetryBatchDigestor,
  type TelemetryPersistenceInput,
  type TelemetryPersistenceResult,
  type TelemetryRepository,
} from "../src/index.js";
import {
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
  parseTelemetryStreamPosition,
  parseUtcInstant,
  type GatewayCredentialBinding,
  type PersistedTelemetryRecord,
  type TelemetryIngestionReceipt,
} from "@aether-cloud/domain";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");

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

class FixedClock implements ApplicationClock {
  now() {
    return parseUtcInstant("2026-07-14T09:05:00.000Z");
  }
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

class StubDigestor implements TelemetryBatchDigestor {
  calls = 0;

  digest() {
    this.calls += 1;
    return Promise.resolve("a".repeat(64));
  }
}

class StubRepository implements TelemetryRepository {
  persisted: TelemetryPersistenceInput | undefined;
  history: readonly PersistedTelemetryRecord[] = [];
  result: TelemetryPersistenceResult | undefined;

  persist(
    input: TelemetryPersistenceInput,
  ): Promise<TelemetryPersistenceResult> {
    this.persisted = input;
    return Promise.resolve(
      this.result ?? { outcome: "persisted", receipt: receipt(input) },
    );
  }

  queryHistory() {
    return Promise.resolve(this.history);
  }
}

function receipt(input: TelemetryPersistenceInput): TelemetryIngestionReceipt {
  return {
    receiptId: "telemetry-receipt:business-telemetry:3:10",
    tenantId: input.binding.tenantId,
    projectId: input.binding.projectId,
    gatewayId: input.binding.gatewayId,
    credentialGeneration: input.binding.generation,
    batchIdentity: input.batch.batchIdentity,
    payloadDigest: input.payloadDigest,
    streamId: input.batch.streamId,
    streamEpoch: input.batch.streamEpoch,
    firstPosition: input.batch.firstPosition,
    lastPosition: input.batch.lastPosition,
    recordCount: input.batch.recordCount,
    persistedAt: parseUtcInstant("2026-07-14T09:05:00.000Z"),
    contiguousPosition: parseTelemetryStreamPosition("10"),
    auditEventId: "audit:telemetry:business-telemetry:3:10",
    outboxEventId: "event:telemetry:business-telemetry:3:10",
  };
}

const commandContext = {
  idempotencyKey: "telemetry-ingest-request-001",
  issuedAt: "2026-07-14T09:00:00.000Z",
  expiresAt: "2026-07-14T09:10:00.000Z",
};

const telemetryInput = {
  credential: {
    credentialId: "gateway-credential-003",
    proof: "opaque-test-proof-material",
  },
  streamId: "business-telemetry",
  streamEpoch: "3",
  retentionClass: "standard-30d",
  replay: false,
  records: [
    {
      kind: "point-sample",
      position: "10",
      sourceTimestampMs: "1784016000000",
      instanceId: "42",
      pointId: "7",
      quality: "good",
      value: { type: "float64", value: 21.5 },
      model: { modelId: "aether.temperature-sensor", revision: "7" },
    },
  ],
};

function makeUseCase(
  options: {
    verifier?: StubVerifier;
    digestor?: StubDigestor;
    repository?: StubRepository;
  } = {},
) {
  const verifier = options.verifier ?? new StubVerifier();
  const digestor = options.digestor ?? new StubDigestor();
  const repository = options.repository ?? new StubRepository();
  return {
    verifier,
    digestor,
    repository,
    useCase: new IngestTelemetryBatch({
      credentialVerifier: verifier,
      digestor,
      repository,
      clock: new FixedClock(),
    }),
  };
}

describe("telemetry application", () => {
  it("declares governed ingest and deny-by-default history metadata", () => {
    expect(INGEST_TELEMETRY_BATCH_COMMAND).toEqual({
      kind: "command",
      name: "telemetry.batch.ingest",
      permission: "telemetry.batch.ingest",
      risk: "low",
      confirmation: "not-required",
      idempotency: "required",
      expiry: "required",
      audit: "required",
      authorization: "gateway-credential",
    });
    expect(GET_TELEMETRY_HISTORY_QUERY).toEqual({
      kind: "query",
      name: "telemetry.history.query",
      permission: "telemetry.history.read",
    });
  });

  it("rejects unknown external fields before authentication or persistence", async () => {
    const fixture = makeUseCase();
    const result = await fixture.useCase.execute(commandContext, {
      ...telemetryInput,
      records: [{ ...telemetryInput.records[0], arbitrary: "unsafe" }],
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
    expect(fixture.verifier.calls).toBe(0);
    expect(fixture.digestor.calls).toBe(0);
    expect(fixture.repository.persisted).toBeUndefined();
  });

  it("derives scope from an active credential and acknowledges only a durable receipt", async () => {
    const fixture = makeUseCase();
    const result = await fixture.useCase.execute(
      commandContext,
      telemetryInput,
    );

    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        disposition: "persisted",
        durablyAcknowledged: true,
        receipt: {
          tenantId,
          projectId,
          gatewayId,
          batchIdentity: "business-telemetry:3:10",
          contiguousPosition: "10",
        },
      },
    });
    expect(fixture.repository.persisted).toMatchObject({
      requestId: "telemetry-ingest-request-001",
      binding: { tenantId, projectId, gatewayId, generation: "3" },
      payloadDigest: "a".repeat(64),
      receivedAt: "2026-07-14T09:05:00.000Z",
      batch: { recordCount: 1, replay: false },
    });
  });

  it("fails closed for rejected and inactive Gateway credentials", async () => {
    const rejected = makeUseCase({
      verifier: new StubVerifier({
        ok: false,
        failure: { code: "invalid-gateway-credential", message: "rejected" },
      }),
    });
    const suspended = makeUseCase({
      verifier: new StubVerifier({ ok: true, value: binding("suspended") }),
    });

    expect(
      await rejected.useCase.execute(commandContext, telemetryInput),
    ).toMatchObject({
      ok: false,
      failure: { code: "invalid-gateway-credential" },
    });
    expect(
      await suspended.useCase.execute(commandContext, telemetryInput),
    ).toMatchObject({
      ok: false,
      failure: { code: "gateway-credential-inactive" },
    });
  });

  it("maps duplicate, conflicting replay, position conflict, quota, and storage failure", async () => {
    const duplicateRepository = new StubRepository();
    const duplicateUseCase = makeUseCase({ repository: duplicateRepository });
    const first = await duplicateUseCase.useCase.execute(
      commandContext,
      telemetryInput,
    );
    if (!first.ok) throw new Error("fixture setup failed");
    duplicateRepository.result = {
      outcome: "duplicate",
      receipt: first.value.receipt,
    };
    expect(
      await duplicateUseCase.useCase.execute(commandContext, telemetryInput),
    ).toMatchObject({
      ok: true,
      replayed: true,
      value: { disposition: "duplicate", durablyAcknowledged: true },
    });

    const cases: readonly [TelemetryPersistenceResult, string][] = [
      [{ outcome: "conflicting-replay" }, "telemetry-conflicting-replay"],
      [{ outcome: "position-conflict" }, "telemetry-position-conflict"],
      [{ outcome: "quota-exceeded" }, "telemetry-quota-exceeded"],
      [{ outcome: "storage-unavailable" }, "telemetry-storage-unavailable"],
    ];

    for (const [repositoryResult, expected] of cases) {
      const repository = new StubRepository();
      repository.result = repositoryResult;
      const result = await makeUseCase({ repository }).useCase.execute(
        commandContext,
        telemetryInput,
      );
      expect(result).toMatchObject({ ok: false, failure: { code: expected } });
    }
  });

  it("queries scoped persisted history without claiming live-state authority", async () => {
    const fixture = makeUseCase();
    const ingested = await fixture.useCase.execute(
      commandContext,
      telemetryInput,
    );
    if (!ingested.ok || fixture.repository.persisted === undefined) {
      throw new Error("fixture setup failed");
    }
    const persisted = fixture.repository.persisted;
    fixture.repository.history = persisted.batch.records.map((record) => ({
      tenantId,
      projectId,
      gatewayId,
      streamId: persisted.batch.streamId,
      streamEpoch: persisted.batch.streamEpoch,
      batchIdentity: persisted.batch.batchIdentity,
      receivedAt: persisted.receivedAt,
      persistedAt: ingested.value.receipt.persistedAt,
      retentionClass: persisted.batch.retentionClass,
      record,
    }));
    const query = new GetTelemetryHistory({ repository: fixture.repository });
    const context = {
      tenantId,
      projectId,
      subjectId: "operator:alice",
      permissions: ["telemetry.history.read"],
    };
    const input = {
      gatewayId,
      streamId: "business-telemetry",
      streamEpoch: "3",
      fromPosition: "0",
      limit: 100,
    };

    expect(await query.execute(context, input)).toMatchObject({
      ok: true,
      value: {
        authority: "edge-reported-history-copy",
        liveStateAuthoritative: false,
        records: [{ record: { kind: "point-sample", position: "10" } }],
      },
    });
    expect(
      await query.execute({ ...context, permissions: [] }, input),
    ).toMatchObject({ ok: false, failure: { code: "permission-denied" } });
  });
});
