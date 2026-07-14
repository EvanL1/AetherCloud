import { describe, expect, it } from "vitest";

import { RequestDataExport } from "@aether-cloud/application";
import {
  createDataExport,
  parseContentDigest,
  parseDataExportId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  startDataExport,
} from "@aether-cloud/domain";

import { InMemoryDataExportRepository } from "../src/index.js";

describe("InMemoryDataExportRepository", () => {
  it("atomically stores exact replay, audit, and outbox evidence", async () => {
    const repository = new InMemoryDataExportRepository();
    const request = new RequestDataExport({
      repository,
      clock: { now: () => "2026-07-15T04:00:01.000Z" },
    });
    const context = {
      tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      subjectId: "export-operator-1",
      permissions: ["data.export.create"],
      confirmation: "confirmed",
      idempotencyKey: "data-export-request-0001",
      issuedAt: "2026-07-15T04:00:00.000Z",
      expiresAt: "2026-07-15T04:10:00.000Z",
    };
    const input = {
      exportId: "data-export-00000001",
      kind: "audit-events",
      format: "ndjson",
      filterDigest: "a".repeat(64),
      exportExpiresAt: "2026-07-16T04:00:00.000Z",
    };

    expect(await request.execute(context, input)).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(await request.execute(context, input)).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(repository.exportCount()).toBe(1);
    expect(repository.auditEvents()).toHaveLength(1);
    expect(repository.pendingOutboxEvents()).toHaveLength(1);
  });

  it("conforms for insert conflicts, optimistic replacement, failure, and Tenant scope", async () => {
    const repository = new InMemoryDataExportRepository();
    const scope = {
      tenantId: parseTenantId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      projectId: parseProjectId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    };
    const exportRequest = createDataExport({
      exportId: parseDataExportId("data-export-00000001"),
      kind: "audit-events",
      format: "ndjson",
      filterDigest: parseContentDigest("a".repeat(64)),
      requestedAt: parseUtcInstant("2026-07-15T04:00:00.000Z"),
      expiresAt: parseUtcInstant("2026-07-16T04:00:00.000Z"),
    });
    const insert = {
      ...scope,
      requestId: "insert-request-0001",
      subjectId: "operator-1",
      exportRequest,
    };
    expect(await repository.insert(insert)).toMatchObject({
      outcome: "inserted",
    });
    expect(await repository.insert(insert)).toMatchObject({
      outcome: "replayed",
    });
    expect(
      await repository.insert({
        ...insert,
        requestId: "insert-request-0002",
      }),
    ).toEqual({ outcome: "already-exists" });
    expect(
      await repository.insert({
        ...insert,
        exportRequest: { ...exportRequest, format: "parquet" },
      }),
    ).toEqual({ outcome: "idempotency-conflict" });
    expect(
      await repository.find(
        {
          tenantId: parseTenantId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
          projectId: scope.projectId,
        },
        exportRequest.exportId,
      ),
    ).toBeUndefined();

    const running = startDataExport(
      exportRequest,
      parseUtcInstant("2026-07-15T04:01:00.000Z"),
    );
    expect(
      await repository.replace({
        ...scope,
        requestId: "replace-request-0001",
        subjectId: "worker-1",
        expectedRevision: 99,
        exportRequest: running,
      }),
    ).toEqual({ outcome: "version-conflict" });
    repository.failNextPersistence();
    expect(
      await repository.replace({
        ...scope,
        requestId: "replace-request-0001",
        subjectId: "worker-1",
        expectedRevision: 1,
        exportRequest: running,
      }),
    ).toEqual({ outcome: "storage-unavailable" });
    const replace = {
      ...scope,
      requestId: "replace-request-0001",
      subjectId: "worker-1",
      expectedRevision: 1,
      exportRequest: running,
    };
    expect(await repository.replace(replace)).toMatchObject({
      outcome: "replaced",
    });
    expect(await repository.replace(replace)).toMatchObject({
      outcome: "replayed",
    });
    expect(await new InMemoryDataExportRepository().replace(replace)).toEqual({
      outcome: "not-found",
    });
    expect(repository.auditEvents()).toHaveLength(2);
    expect(repository.pendingOutboxEvents()).toHaveLength(2);
  });
});
