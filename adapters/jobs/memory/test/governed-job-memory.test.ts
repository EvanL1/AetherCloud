import { describe, expect, it } from "vitest";

import { CreateGovernedJob, GetGovernedJob } from "@aether-cloud/application";
import {
  confirmGovernedJob,
  createGovernedJob,
  parseContentDigest,
  parseGatewayId,
  parseGovernedJobId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  queueGovernedJob,
} from "@aether-cloud/domain";

import { InMemoryGovernedJobStore } from "../src/index.js";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const gatewayId = "22222222-2222-4222-8222-222222222222";
const jobId = "11111111-1111-4111-8111-111111111111";

function context(idempotencyKey = "job-request-0000001") {
  return {
    tenantId,
    projectId,
    subjectId: "operator-1",
    permissions: ["edge.job.create", "edge.diagnostics.collect"],
    confirmation: "not-confirmed",
    idempotencyKey,
    issuedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2026-07-14T00:10:00.000Z",
  };
}

function input() {
  return {
    jobId,
    gatewayId,
    capabilityId: "diagnostics.collect.v1",
    argumentsDigest: "a".repeat(64),
    preconditionDigest: "b".repeat(64),
    jobExpiresAt: "2026-07-14T00:08:00.000Z",
  };
}

describe("InMemoryGovernedJobStore", () => {
  it("denies undeclared capability and atomically creates exact replay", async () => {
    const store = new InMemoryGovernedJobStore();
    const create = new CreateGovernedJob({
      repository: store,
      capabilities: store,
      clock: { now: () => "2026-07-14T00:01:00.000Z" },
    });
    expect(await create.execute(context(), input())).toMatchObject({
      ok: false,
      failure: { code: "job-capability-denied" },
    });
    store.registerCapability({
      capabilityId: "diagnostics.collect.v1",
      permission: "edge.diagnostics.collect",
      risk: "high",
      confirmation: "explicit",
      replaySafety: "safe",
      physicalEffect: false,
    });
    expect(await create.execute(context(), input())).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(await create.execute(context(), input())).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(store.jobCount()).toBe(1);
    expect(store.auditEvents()).toHaveLength(1);
    expect(store.pendingOutboxEvents()).toHaveLength(1);
  });

  it("keeps conflicting idempotency and cross-Tenant reads closed", async () => {
    const store = new InMemoryGovernedJobStore();
    store.registerCapability({
      capabilityId: "diagnostics.collect.v1",
      permission: "edge.diagnostics.collect",
      risk: "high",
      confirmation: "explicit",
      replaySafety: "safe",
      physicalEffect: false,
    });
    const create = new CreateGovernedJob({
      repository: store,
      capabilities: store,
      clock: { now: () => "2026-07-14T00:01:00.000Z" },
    });
    await create.execute(context(), input());
    expect(
      await create.execute(context(), {
        ...input(),
        gatewayId: "33333333-3333-4333-8333-333333333333",
      }),
    ).toMatchObject({
      ok: false,
      failure: { code: "job-idempotency-conflict" },
    });
    expect(
      await new GetGovernedJob({ repository: store }).execute(
        {
          tenantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          projectId,
          subjectId: "reader-1",
          permissions: ["edge.job.read"],
        },
        { jobId },
      ),
    ).toMatchObject({ ok: false, failure: { code: "job-not-found" } });
  });

  it("writes no job, audit, or outbox evidence on persistence failure", async () => {
    const store = new InMemoryGovernedJobStore();
    store.registerCapability({
      capabilityId: "diagnostics.collect.v1",
      permission: "edge.diagnostics.collect",
      risk: "high",
      confirmation: "explicit",
      replaySafety: "safe",
      physicalEffect: false,
    });
    store.failNextPersistence();
    const create = new CreateGovernedJob({
      repository: store,
      capabilities: store,
      clock: { now: () => "2026-07-14T00:01:00.000Z" },
    });
    expect(await create.execute(context(), input())).toMatchObject({
      ok: false,
      failure: { code: "job-storage-unavailable" },
    });
    expect(store.jobCount()).toBe(0);
    expect(store.auditEvents()).toHaveLength(0);
    expect(store.pendingOutboxEvents()).toHaveLength(0);
  });

  it("implements optimistic replacement and idempotent replay outcomes", async () => {
    const scope = {
      tenantId: parseTenantId(tenantId),
      projectId: parseProjectId(projectId),
    };
    const created = createGovernedJob({
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
    const confirmed = confirmGovernedJob(
      created,
      "operator-1",
      parseUtcInstant("2026-07-14T00:01:00.000Z"),
    );
    const insertRequest = {
      ...scope,
      requestId: "insert-request-0001",
      subjectId: "operator-1",
      job: created,
    };
    const replacement = {
      ...scope,
      requestId: "replace-request-0001",
      subjectId: "operator-1",
      expectedRevision: created.revision,
      eventName: "edge.job-controlled.v1" as const,
      job: confirmed,
    };
    const store = new InMemoryGovernedJobStore();

    expect(await store.insert(insertRequest)).toMatchObject({
      outcome: "inserted",
    });
    expect(
      await store.insert({
        ...insertRequest,
        requestId: "insert-request-0002",
      }),
    ).toEqual({ outcome: "already-exists" });
    expect(await new InMemoryGovernedJobStore().replace(replacement)).toEqual({
      outcome: "not-found",
    });
    expect(
      await store.replace({ ...replacement, expectedRevision: 99 }),
    ).toEqual({ outcome: "version-conflict" });
    expect(await store.replace(replacement)).toMatchObject({
      outcome: "replaced",
      job: { state: "authorized" },
    });
    expect(await store.replace(replacement)).toMatchObject({
      outcome: "replayed",
    });
    expect(
      await store.replace({
        ...replacement,
        job: queueGovernedJob(
          confirmed,
          parseUtcInstant("2026-07-14T00:02:00.000Z"),
        ),
      }),
    ).toEqual({ outcome: "idempotency-conflict" });

    store.failNextPersistence();
    expect(
      await store.replace({
        ...replacement,
        requestId: "replace-request-0002",
      }),
    ).toEqual({ outcome: "storage-unavailable" });
    expect(store.auditEvents()).toHaveLength(2);
    expect(store.pendingOutboxEvents()).toHaveLength(2);
  });
});
