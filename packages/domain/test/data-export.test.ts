import { describe, expect, it } from "vitest";

import {
  completeDataExport,
  createDataExport,
  expireDataExport,
  failDataExport,
  parseContentDigest,
  parseDataExportByteLength,
  parseDataExportId,
  parseStorageObjectReference,
  parseUtcInstant,
  startDataExport,
} from "../src/index.js";

function requested() {
  return createDataExport({
    exportId: parseDataExportId("data-export-00000001"),
    kind: "telemetry-history",
    format: "ndjson",
    filterDigest: parseContentDigest("a".repeat(64)),
    requestedAt: parseUtcInstant("2026-07-15T04:00:00.000Z"),
    expiresAt: parseUtcInstant("2026-07-16T04:00:00.000Z"),
  });
}

describe("Data Export", () => {
  it("publishes only immutable object evidence after worker completion", () => {
    const running = startDataExport(
      requested(),
      parseUtcInstant("2026-07-15T04:01:00.000Z"),
    );
    const ready = completeDataExport(running, {
      completedAt: parseUtcInstant("2026-07-15T04:02:00.000Z"),
      objectReference: parseStorageObjectReference(
        "object:exports:data-export-00000001",
      ),
      contentDigest: parseContentDigest("b".repeat(64)),
      byteLength: parseDataExportByteLength("18446744073709551615"),
    });

    expect(ready).toMatchObject({
      state: "ready",
      byteLength: "18446744073709551615",
      objectReference: "object:exports:data-export-00000001",
    });
  });

  it("records typed failure evidence without fabricating an object", () => {
    const running = startDataExport(
      requested(),
      parseUtcInstant("2026-07-15T04:01:00.000Z"),
    );
    const failed = failDataExport(running, {
      failedAt: parseUtcInstant("2026-07-15T04:02:00.000Z"),
      failureCode: "source-unavailable",
      evidenceDigest: parseContentDigest("c".repeat(64)),
    });

    expect(failed).toMatchObject({
      state: "failed",
      failureCode: "source-unavailable",
    });
    expect(failed.objectReference).toBeUndefined();
  });

  it("validates identifiers, object references, lossless lengths, and expiry", () => {
    for (const invalid of ["short", "contains space", 7, null]) {
      expect(() => parseDataExportId(invalid)).toThrow();
    }
    for (const invalid of ["short", "object ref with space", 7]) {
      expect(() => parseStorageObjectReference(invalid)).toThrow();
    }
    for (const invalid of [
      -1,
      "-1",
      "01",
      "18446744073709551616",
      "not-a-number",
    ]) {
      expect(() => parseDataExportByteLength(invalid)).toThrow();
    }
    expect(parseDataExportByteLength("0")).toBe("0");
    expect(() =>
      createDataExport({
        ...requested(),
        requestedAt: parseUtcInstant("2026-07-16T04:00:00.000Z"),
        expiresAt: parseUtcInstant("2026-07-16T04:00:00.000Z"),
      }),
    ).toThrow(/expiry/u);
  });

  it("rejects invalid worker transitions and preserves idempotent states", () => {
    const queued = requested();
    const running = startDataExport(
      queued,
      parseUtcInstant("2026-07-15T04:01:00.000Z"),
    );
    expect(
      startDataExport(running, parseUtcInstant("2026-07-15T04:01:00.000Z")),
    ).toBe(running);
    expect(() =>
      startDataExport(queued, parseUtcInstant("2026-07-16T04:00:00.000Z")),
    ).toThrow(/expired/u);
    expect(() =>
      completeDataExport(queued, {
        completedAt: parseUtcInstant("2026-07-15T04:02:00.000Z"),
        objectReference: parseStorageObjectReference("object:exports:invalid"),
        contentDigest: parseContentDigest("b".repeat(64)),
        byteLength: parseDataExportByteLength("1"),
      }),
    ).toThrow(/completion/u);
    expect(() =>
      completeDataExport(running, {
        completedAt: parseUtcInstant("2026-07-15T04:00:59.000Z"),
        objectReference: parseStorageObjectReference("object:exports:invalid"),
        contentDigest: parseContentDigest("b".repeat(64)),
        byteLength: parseDataExportByteLength("1"),
      }),
    ).toThrow(/precedes/u);
    expect(() =>
      failDataExport(queued, {
        failedAt: parseUtcInstant("2026-07-15T04:02:00.000Z"),
        failureCode: "source-unavailable",
        evidenceDigest: parseContentDigest("c".repeat(64)),
      }),
    ).toThrow(/failure/u);
    expect(() =>
      failDataExport(running, {
        failedAt: parseUtcInstant("2026-07-15T04:02:00.000Z"),
        failureCode: "bad code",
        evidenceDigest: parseContentDigest("c".repeat(64)),
      }),
    ).toThrow(/failureCode/u);
  });

  it("expires only due non-running exports and treats repeated expiry as replay", () => {
    const queued = requested();
    expect(() =>
      expireDataExport(queued, parseUtcInstant("2026-07-16T03:59:59.999Z")),
    ).toThrow(/not due/u);
    expect(() =>
      expireDataExport(
        startDataExport(queued, parseUtcInstant("2026-07-15T04:01:00.000Z")),
        parseUtcInstant("2026-07-16T04:00:00.000Z"),
      ),
    ).toThrow(/reconciliation/u);
    const expired = expireDataExport(
      queued,
      parseUtcInstant("2026-07-16T04:00:00.000Z"),
    );
    expect(expired.state).toBe("expired");
    expect(
      expireDataExport(expired, parseUtcInstant("2026-07-17T04:00:00.000Z")),
    ).toBe(expired);
    expect(() =>
      startDataExport(expired, parseUtcInstant("2026-07-17T04:00:00.000Z")),
    ).toThrow(/invalid/u);
  });
});
