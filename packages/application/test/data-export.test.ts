import { describe, expect, it } from "vitest";

import {
  GetDataExport,
  ReportDataExportOutcome,
  RequestDataExport,
} from "../src/index.js";
import type { DataExportRepository } from "../src/index.js";
import {
  createDataExport,
  parseContentDigest,
  parseDataExportId,
  parseUtcInstant,
} from "@aether-cloud/domain";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const exportId = "data-export-00000001";
const requestInput = {
  exportId,
  kind: "audit-events",
  format: "ndjson",
  filterDigest: "a".repeat(64),
  exportExpiresAt: "2026-07-16T04:00:00.000Z",
};

function commandContext(overrides: Record<string, unknown> = {}) {
  return {
    tenantId,
    projectId,
    subjectId: "export-operator-1",
    permissions: ["data.export.create"],
    confirmation: "confirmed",
    idempotencyKey: "data-export-request-0001",
    issuedAt: "2026-07-15T04:00:00.000Z",
    expiresAt: "2026-07-15T04:10:00.000Z",
    ...overrides,
  };
}

function repository(
  overrides: Partial<DataExportRepository> = {},
): DataExportRepository {
  return {
    insert: (request) =>
      Promise.resolve({
        outcome: "inserted",
        exportRequest: request.exportRequest,
      }),
    replace: (request) =>
      Promise.resolve({
        outcome: "replaced",
        exportRequest: request.exportRequest,
      }),
    find: () => Promise.resolve(undefined),
    ...overrides,
  };
}

describe("Data Export application", () => {
  it("requires explicit confirmation and stores a bounded filter digest", async () => {
    const request = new RequestDataExport({
      repository: repository(),
      clock: { now: () => "2026-07-15T04:00:01.000Z" },
    });
    expect(
      await request.execute(
        commandContext({ confirmation: "not-confirmed" }),
        requestInput,
      ),
    ).toMatchObject({
      ok: false,
      failure: { code: "confirmation-required" },
    });
    expect(await request.execute(commandContext(), requestInput)).toMatchObject(
      {
        ok: true,
        value: { state: "queued", kind: "audit-events" },
      },
    );
  });

  it("separates worker outcome command from Tenant query", async () => {
    let current = createDataExport({
      exportId: parseDataExportId(exportId),
      kind: "audit-events",
      format: "ndjson",
      filterDigest: parseContentDigest("a".repeat(64)),
      requestedAt: parseUtcInstant("2026-07-15T04:00:00.000Z"),
      expiresAt: parseUtcInstant("2026-07-16T04:00:00.000Z"),
    });
    const store = repository({
      find: () => Promise.resolve(current),
      replace: (request) => {
        current = request.exportRequest;
        return Promise.resolve({ outcome: "replaced", exportRequest: current });
      },
    });
    const report = new ReportDataExportOutcome({
      repository: store,
      clock: { now: () => "2026-07-15T04:01:00.000Z" },
    });

    expect(
      await report.execute(
        commandContext({
          subjectId: "export-worker-1",
          permissions: ["data.export.process"],
          confirmation: "not-confirmed",
        }),
        { action: "start", exportId },
      ),
    ).toMatchObject({ ok: true, value: { state: "running" } });
    expect(
      await new GetDataExport({ repository: store }).execute(
        {
          tenantId,
          projectId,
          subjectId: "export-reader-1",
          permissions: ["data.export.read"],
        },
        { exportId },
      ),
    ).toMatchObject({ ok: true, value: { state: "running" } });
  });

  it("fails closed on malformed, unauthorized, future, expired, and invalid request input", async () => {
    const request = new RequestDataExport({
      repository: repository(),
      clock: { now: () => "2026-07-15T04:00:01.000Z" },
    });
    const invalidContexts: unknown[] = [
      null,
      { ...commandContext(), extra: true },
      { ...commandContext(), confirmation: "implicit" },
      { ...commandContext(), subjectId: "bad subject" },
      { ...commandContext(), permissions: "data.export.create" },
      { ...commandContext(), permissions: [7] },
      { ...commandContext(), idempotencyKey: "short" },
      { ...commandContext(), tenantId: "bad-tenant" },
    ];
    for (const invalidContext of invalidContexts) {
      expect(await request.execute(invalidContext, requestInput)).toMatchObject(
        { ok: false, failure: { code: "invalid-input" } },
      );
    }
    expect(
      await request.execute(commandContext({ permissions: [] }), requestInput),
    ).toMatchObject({ ok: false, failure: { code: "permission-denied" } });
    expect(
      await request.execute(
        commandContext({ issuedAt: "2026-07-15T04:00:02.000Z" }),
        requestInput,
      ),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    expect(
      await request.execute(
        commandContext({ expiresAt: "2026-07-15T04:00:01.000Z" }),
        requestInput,
      ),
    ).toMatchObject({ ok: false, failure: { code: "command-expired" } });
    const malformedInputs: unknown[] = [
      null,
      { ...requestInput, extra: true },
      { ...requestInput, kind: "live-state" },
      { ...requestInput, format: "csv" },
      { ...requestInput, exportId: "short" },
      { ...requestInput, filterDigest: "bad" },
      { ...requestInput, exportExpiresAt: "not-a-time" },
    ];
    for (const malformedInput of malformedInputs) {
      expect(
        await request.execute(commandContext(), malformedInput),
      ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    }
    for (const exportExpiresAt of [
      "2026-07-15T04:00:01.000Z",
      "2026-08-16T04:00:01.000Z",
    ]) {
      expect(
        await request.execute(commandContext(), {
          ...requestInput,
          exportExpiresAt,
        }),
      ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    }
  });

  it("maps every request persistence outcome and invalid clock", async () => {
    for (const [outcome, code] of [
      ["already-exists", "data-export-conflict"],
      ["idempotency-conflict", "data-export-idempotency-conflict"],
      ["storage-unavailable", "data-export-storage-unavailable"],
    ] as const) {
      const request = new RequestDataExport({
        repository: repository({
          insert: () => Promise.resolve({ outcome }),
        }),
        clock: { now: () => "2026-07-15T04:00:01.000Z" },
      });
      expect(
        await request.execute(commandContext(), requestInput),
      ).toMatchObject({ ok: false, failure: { code } });
    }
    const replayed = new RequestDataExport({
      repository: repository({
        insert: (request) =>
          Promise.resolve({
            outcome: "replayed",
            exportRequest: request.exportRequest,
          }),
      }),
      clock: { now: () => "2026-07-15T04:00:01.000Z" },
    });
    expect(
      await replayed.execute(commandContext(), requestInput),
    ).toMatchObject({ ok: true, replayed: true });
    expect(
      await new RequestDataExport({
        repository: repository(),
        clock: { now: () => "not-a-time" },
      }).execute(commandContext(), requestInput),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
  });

  it("reports ready and failed outcomes and maps transition or repository failures", async () => {
    let current = createDataExport({
      exportId: parseDataExportId(exportId),
      kind: "audit-events",
      format: "ndjson",
      filterDigest: parseContentDigest("a".repeat(64)),
      requestedAt: parseUtcInstant("2026-07-15T04:00:00.000Z"),
      expiresAt: parseUtcInstant("2026-07-16T04:00:00.000Z"),
    });
    const store = repository({
      find: () => Promise.resolve(current),
      replace: (request) => {
        current = request.exportRequest;
        return Promise.resolve({ outcome: "replaced", exportRequest: current });
      },
    });
    const report = new ReportDataExportOutcome({
      repository: store,
      clock: { now: () => "2026-07-15T04:01:00.000Z" },
    });
    const workerContext = commandContext({
      permissions: ["data.export.process"],
      confirmation: "not-confirmed",
    });
    await report.execute(workerContext, { action: "start", exportId });
    expect(
      await report.execute(
        { ...workerContext, idempotencyKey: "data-export-ready-0001" },
        {
          action: "ready",
          exportId,
          objectReference: "object:exports:data-export-00000001",
          contentDigest: "b".repeat(64),
          byteLength: "42",
        },
      ),
    ).toMatchObject({ ok: true, value: { state: "ready", byteLength: "42" } });
    current = createDataExport({
      exportId: parseDataExportId(exportId),
      kind: "audit-events",
      format: "ndjson",
      filterDigest: parseContentDigest("a".repeat(64)),
      requestedAt: parseUtcInstant("2026-07-15T04:00:00.000Z"),
      expiresAt: parseUtcInstant("2026-07-16T04:00:00.000Z"),
    });
    await report.execute(workerContext, { action: "start", exportId });
    expect(
      await report.execute(
        { ...workerContext, idempotencyKey: "data-export-failed-0001" },
        {
          action: "failed",
          exportId,
          failureCode: "source-unavailable",
          evidenceDigest: "c".repeat(64),
        },
      ),
    ).toMatchObject({ ok: true, value: { state: "failed" } });

    expect(
      await new ReportDataExportOutcome({
        repository: repository(),
        clock: { now: () => "2026-07-15T04:01:00.000Z" },
      }).execute(workerContext, { action: "start", exportId }),
    ).toMatchObject({ ok: false, failure: { code: "data-export-not-found" } });
    expect(
      await report.execute(workerContext, { action: "unsupported", exportId }),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    expect(
      await report.execute(workerContext, { action: "start", exportId }),
    ).toMatchObject({
      ok: false,
      failure: { code: "data-export-transition-invalid" },
    });
  });

  it("maps update persistence outcomes and enforces query input and permission", async () => {
    const queued = createDataExport({
      exportId: parseDataExportId(exportId),
      kind: "audit-events",
      format: "ndjson",
      filterDigest: parseContentDigest("a".repeat(64)),
      requestedAt: parseUtcInstant("2026-07-15T04:00:00.000Z"),
      expiresAt: parseUtcInstant("2026-07-16T04:00:00.000Z"),
    });
    const workerContext = commandContext({
      permissions: ["data.export.process"],
      confirmation: "not-confirmed",
    });
    for (const [outcome, code] of [
      ["idempotency-conflict", "data-export-idempotency-conflict"],
      ["not-found", "data-export-not-found"],
      ["storage-unavailable", "data-export-storage-unavailable"],
      ["version-conflict", "data-export-version-conflict"],
    ] as const) {
      const report = new ReportDataExportOutcome({
        repository: repository({
          find: () => Promise.resolve(queued),
          replace: () => Promise.resolve({ outcome }),
        }),
        clock: { now: () => "2026-07-15T04:01:00.000Z" },
      });
      expect(
        await report.execute(workerContext, { action: "start", exportId }),
      ).toMatchObject({ ok: false, failure: { code } });
    }

    const query = new GetDataExport({
      repository: repository({ find: () => Promise.resolve(queued) }),
    });
    expect(
      await query.execute(
        {
          tenantId,
          projectId,
          subjectId: "reader-1",
          permissions: [],
        },
        { exportId },
      ),
    ).toMatchObject({ ok: false, failure: { code: "permission-denied" } });
    expect(
      await query.execute(
        {
          tenantId,
          projectId,
          subjectId: "reader-1",
          permissions: ["data.export.read"],
        },
        { exportId, extra: true },
      ),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    expect(
      await new GetDataExport({ repository: repository() }).execute(
        {
          tenantId,
          projectId,
          subjectId: "reader-1",
          permissions: ["data.export.read"],
        },
        { exportId },
      ),
    ).toMatchObject({ ok: false, failure: { code: "data-export-not-found" } });
  });
});
