import { describe, expect, it } from "vitest";

import {
  ConfirmGovernedJob,
  ControlGovernedJob,
  CreateGovernedJob,
  GetGovernedJob,
  IngestGovernedJobReceipt,
} from "../src/index.js";
import type {
  EdgeCapabilityDeclaration,
  EdgeCapabilityCatalog,
  GovernedJobRepository,
  GatewayCredentialVerifier,
} from "../src/index.js";
import {
  createGovernedJob,
  offerGovernedJob,
  parseContentDigest,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseGovernedJobId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  queueGovernedJob,
} from "@aether-cloud/domain";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const gatewayId = "22222222-2222-4222-8222-222222222222";
const jobId = "11111111-1111-4111-8111-111111111111";
const createInput = {
  jobId,
  gatewayId,
  capabilityId: "diagnostics.collect.v1",
  argumentsDigest: "a".repeat(64),
  preconditionDigest: "b".repeat(64),
  jobExpiresAt: "2026-07-14T00:08:00.000Z",
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    tenantId,
    projectId,
    subjectId: "operator-1",
    permissions: ["edge.job.create", "edge.diagnostics.collect"],
    confirmation: "not-confirmed",
    idempotencyKey: "job-request-0000001",
    issuedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2026-07-14T00:10:00.000Z",
    ...overrides,
  };
}

const catalog: EdgeCapabilityCatalog = {
  find: () =>
    Promise.resolve({
      capabilityId: "diagnostics.collect.v1",
      permission: "edge.diagnostics.collect",
      risk: "high",
      confirmation: "explicit",
      replaySafety: "safe",
      physicalEffect: false,
    }),
};

function repository(
  overrides: Partial<GovernedJobRepository> = {},
): GovernedJobRepository {
  return {
    insert: (request) =>
      Promise.resolve({ outcome: "inserted", job: request.job }),
    replace: (request) =>
      Promise.resolve({ outcome: "replaced", job: request.job }),
    find: () => Promise.resolve(undefined),
    ...overrides,
  };
}

describe("Governed Job application", () => {
  it("denies unknown capabilities and creates declared work awaiting confirmation", async () => {
    const create = new CreateGovernedJob({
      repository: repository(),
      capabilities: catalog,
      clock: { now: () => "2026-07-14T00:01:00.000Z" },
    });
    expect(await create.execute(context(), createInput)).toMatchObject({
      ok: true,
      value: { state: "awaiting-confirmation", physicalEffect: false },
    });
    expect(
      await new CreateGovernedJob({
        repository: repository(),
        capabilities: { find: () => Promise.resolve(undefined) },
        clock: { now: () => "2026-07-14T00:01:00.000Z" },
      }).execute(context(), createInput),
    ).toMatchObject({ ok: false, failure: { code: "job-capability-denied" } });
  });

  it("requires both platform and capability permission", async () => {
    const create = new CreateGovernedJob({
      repository: repository(),
      capabilities: catalog,
      clock: { now: () => "2026-07-14T00:01:00.000Z" },
    });
    expect(
      await create.execute(
        context({ permissions: ["edge.job.create"] }),
        createInput,
      ),
    ).toMatchObject({ ok: false, failure: { code: "permission-denied" } });
  });

  it("confirms, queues, offers, marks unknown, and requests cancellation through governed controls", async () => {
    const current = createGovernedJob({
      jobId: parseGovernedJobId(jobId),
      gatewayId: parseGatewayId(gatewayId),
      capabilityId: "diagnostics.collect.v1",
      capabilityPermission: "edge.diagnostics.collect",
      risk: "high",
      confirmation: "explicit",
      replaySafety: "safe",
      physicalEffect: false,
      argumentsDigest: parseContentDigest("a".repeat(64)),
      preconditionDigest: parseContentDigest("b".repeat(64)),
      createdAt: parseUtcInstant("2026-07-14T00:00:00.000Z"),
      expiresAt: parseUtcInstant("2026-07-14T00:08:00.000Z"),
    });
    let stored = current;
    const repo = repository({
      find: () => Promise.resolve(stored),
      replace: (request) => {
        stored = request.job;
        return Promise.resolve({ outcome: "replaced", job: stored });
      },
    });
    const confirm = new ConfirmGovernedJob({
      repository: repo,
      clock: { now: () => "2026-07-14T00:01:00.000Z" },
    });
    const control = new ControlGovernedJob({
      repository: repo,
      clock: { now: () => "2026-07-14T00:02:00.000Z" },
    });

    expect(
      await confirm.execute(
        context({
          permissions: ["edge.job.confirm"],
          confirmation: "confirmed",
        }),
        { jobId },
      ),
    ).toMatchObject({ ok: true, value: { state: "authorized" } });
    await control.execute(context({ permissions: ["edge.job.dispatch"] }), {
      jobId,
      action: "queue",
    });
    expect(
      await control.execute(
        context({
          permissions: ["edge.job.dispatch"],
          idempotencyKey: "job-offer-request-01",
        }),
        { jobId, action: "offer" },
      ),
    ).toMatchObject({ ok: true, value: { state: "offered" } });
  });

  it("accepts receipts only from the target active Gateway and exposes Tenant query", async () => {
    const created = createGovernedJob({
      jobId: parseGovernedJobId(jobId),
      gatewayId: parseGatewayId(gatewayId),
      capabilityId: "diagnostics.collect.v1",
      capabilityPermission: "edge.diagnostics.collect",
      risk: "low",
      confirmation: "not-required",
      replaySafety: "safe",
      physicalEffect: false,
      argumentsDigest: parseContentDigest("a".repeat(64)),
      preconditionDigest: parseContentDigest("b".repeat(64)),
      createdAt: parseUtcInstant("2026-07-14T00:00:00.000Z"),
      expiresAt: parseUtcInstant("2026-07-14T00:08:00.000Z"),
    });
    const queued = queueGovernedJob(
      created,
      parseUtcInstant("2026-07-14T00:00:30.000Z"),
    );
    const current = offerGovernedJob(
      queued,
      parseUtcInstant("2026-07-14T00:01:00.000Z"),
    );
    const repo = repository({ find: () => Promise.resolve(current) });
    const verifier: GatewayCredentialVerifier = {
      verify: () =>
        Promise.resolve({
          ok: true,
          value: {
            tenantId: parseTenantId(tenantId),
            projectId: parseProjectId(projectId),
            gatewayId: parseGatewayId(gatewayId),
            generation: parseGatewayCredentialGeneration("1"),
            status: "active",
          },
        }),
    };
    const ingest = new IngestGovernedJobReceipt({
      repository: repo,
      credentialVerifier: verifier,
      clock: { now: () => "2026-07-14T00:02:00.000Z" },
    });
    expect(
      await ingest.execute(
        {
          credentialId: "gateway-credential-1",
          proof: "opaque-proof",
          idempotencyKey: "receipt-request-0001",
          issuedAt: "2026-07-14T00:01:00.000Z",
          expiresAt: "2026-07-14T00:05:00.000Z",
        },
        {
          jobId,
          receiptId: "receipt-accepted-0001",
          sequence: "1",
          kind: "accepted",
          observedAt: "2026-07-14T00:01:30.000Z",
          payloadDigest: "c".repeat(64),
        },
      ),
    ).toMatchObject({ ok: true });
    expect(
      await new GetGovernedJob({ repository: repo }).execute(
        {
          tenantId,
          projectId,
          subjectId: "reader-1",
          permissions: ["edge.job.read"],
        },
        { jobId },
      ),
    ).toMatchObject({
      ok: true,
      value: { capabilityId: "diagnostics.collect.v1" },
    });
  });

  it("fails closed on malformed command context, time, input, and capability evidence", async () => {
    const create = new CreateGovernedJob({
      repository: repository(),
      capabilities: catalog,
      clock: { now: () => "2026-07-14T00:01:00.000Z" },
    });
    for (const invalidContext of [
      null,
      { ...context(), extra: true },
      { ...context(), confirmation: "implicit" },
      { ...context(), subjectId: "" },
      { ...context(), permissions: "edge.job.create" },
      { ...context(), permissions: [7] },
      { ...context(), idempotencyKey: "short" },
      { ...context(), tenantId: "bad-tenant" },
    ]) {
      expect(await create.execute(invalidContext, createInput)).toMatchObject({
        ok: false,
        failure: { code: "invalid-input" },
      });
    }
    expect(
      await create.execute(
        context({ permissions: ["edge.diagnostics.collect"] }),
        createInput,
      ),
    ).toMatchObject({ ok: false, failure: { code: "permission-denied" } });
    expect(
      await create.execute(
        context({ issuedAt: "2026-07-14T00:01:01.000Z" }),
        createInput,
      ),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    expect(
      await create.execute(
        context({ expiresAt: "2026-07-14T00:01:00.000Z" }),
        createInput,
      ),
    ).toMatchObject({ ok: false, failure: { code: "command-expired" } });
    for (const invalidInput of [
      null,
      { ...createInput, extra: true },
      { ...createInput, jobId: "short" },
      { ...createInput, gatewayId: "short" },
      { ...createInput, capabilityId: "bad capability" },
      { ...createInput, argumentsDigest: "bad" },
      { ...createInput, preconditionDigest: "bad" },
      { ...createInput, jobExpiresAt: "not-a-time" },
    ]) {
      expect(await create.execute(context(), invalidInput)).toMatchObject({
        ok: false,
        failure: { code: "invalid-input" },
      });
    }
    for (const jobExpiresAt of [
      "2026-07-14T00:01:00.000Z",
      "2026-07-14T00:10:01.000Z",
    ]) {
      expect(
        await create.execute(context(), { ...createInput, jobExpiresAt }),
      ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    }
    expect(
      await new CreateGovernedJob({
        repository: repository(),
        capabilities: catalog,
        clock: { now: () => "not-a-time" },
      }).execute(context(), createInput),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });

    const baseDeclaration: EdgeCapabilityDeclaration = {
      capabilityId: "diagnostics.collect.v1",
      permission: "edge.diagnostics.collect",
      risk: "high",
      confirmation: "explicit",
      replaySafety: "safe",
      physicalEffect: false,
    };
    const invalidDeclarations: EdgeCapabilityDeclaration[] = [
      {
        ...baseDeclaration,
        capabilityId: "different.capability.v1",
      },
      {
        ...baseDeclaration,
        permission: "bad permission",
      },
      {
        ...baseDeclaration,
        risk: "low",
        confirmation: "not-required",
        replaySafety: "unsafe",
        physicalEffect: true,
      },
    ];
    for (const declaration of invalidDeclarations) {
      expect(
        await new CreateGovernedJob({
          repository: repository(),
          capabilities: { find: () => Promise.resolve(declaration) },
          clock: { now: () => "2026-07-14T00:01:00.000Z" },
        }).execute(context(), createInput),
      ).toMatchObject({
        ok: false,
        failure: { code: "job-capability-denied" },
      });
    }
  });

  it("maps creation replay and every persistence failure", async () => {
    for (const [outcome, code] of [
      ["already-exists", "job-already-exists"],
      ["idempotency-conflict", "job-idempotency-conflict"],
      ["storage-unavailable", "job-storage-unavailable"],
    ] as const) {
      expect(
        await new CreateGovernedJob({
          repository: repository({
            insert: () => Promise.resolve({ outcome }),
          }),
          capabilities: catalog,
          clock: { now: () => "2026-07-14T00:01:00.000Z" },
        }).execute(context(), createInput),
      ).toMatchObject({ ok: false, failure: { code } });
    }
    expect(
      await new CreateGovernedJob({
        repository: repository({
          insert: (request) =>
            Promise.resolve({ outcome: "replayed", job: request.job }),
        }),
        capabilities: catalog,
        clock: { now: () => "2026-07-14T00:01:00.000Z" },
      }).execute(context(), createInput),
    ).toMatchObject({ ok: true, replayed: true });
  });
});
