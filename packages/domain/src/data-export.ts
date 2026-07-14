import type { ContentDigest } from "./artifact-registry.js";
import { parseContentDigest } from "./artifact-registry.js";
import type { UtcInstant } from "./resource-identities.js";
import {
  InvalidDomainValueError,
  parseUtcInstant,
} from "./resource-identities.js";

const opaqueIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const boundedIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const storageReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,511}$/;
const uint64Pattern = /^(?:0|[1-9][0-9]*)$/;
const maximumUint64 = 18_446_744_073_709_551_615n;

declare const dataExportIdBrand: unique symbol;
declare const storageObjectReferenceBrand: unique symbol;
declare const dataExportByteLengthBrand: unique symbol;

export type DataExportId = string & { readonly [dataExportIdBrand]: true };
export type StorageObjectReference = string & {
  readonly [storageObjectReferenceBrand]: true;
};
export type DataExportByteLength = string & {
  readonly [dataExportByteLengthBrand]: true;
};
export type DataExportKind =
  | "alarm-history"
  | "audit-events"
  | "telemetry-history";
export type DataExportFormat = "ndjson" | "parquet";
export type DataExportState =
  | "expired"
  | "failed"
  | "queued"
  | "ready"
  | "running";

export interface DataExport {
  readonly exportId: DataExportId;
  readonly kind: DataExportKind;
  readonly format: DataExportFormat;
  readonly filterDigest: ContentDigest;
  readonly requestedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly state: DataExportState;
  readonly startedAt?: UtcInstant;
  readonly completedAt?: UtcInstant;
  readonly failedAt?: UtcInstant;
  readonly objectReference?: StorageObjectReference;
  readonly contentDigest?: ContentDigest;
  readonly byteLength?: DataExportByteLength;
  readonly failureCode?: string;
  readonly evidenceDigest?: ContentDigest;
  readonly revision: number;
}

export class DataExportTransitionError extends Error {
  readonly code = "invalid-data-export-transition";

  constructor(message: string) {
    super(message);
    this.name = "DataExportTransitionError";
  }
}

export function parseDataExportId(input: unknown): DataExportId {
  if (typeof input !== "string" || !opaqueIdentifier.test(input)) {
    throw new InvalidDomainValueError(
      "dataExportId",
      "dataExportId must be an opaque 8-128 character identifier",
    );
  }
  return input as DataExportId;
}

export function parseStorageObjectReference(
  input: unknown,
): StorageObjectReference {
  if (typeof input !== "string" || !storageReferencePattern.test(input)) {
    throw new InvalidDomainValueError(
      "storageObjectReference",
      "storageObjectReference must be an opaque bounded reference",
    );
  }
  return input as StorageObjectReference;
}

export function parseDataExportByteLength(
  input: unknown,
): DataExportByteLength {
  if (
    typeof input !== "string" ||
    !uint64Pattern.test(input) ||
    BigInt(input) > maximumUint64
  ) {
    throw new InvalidDomainValueError(
      "dataExportByteLength",
      "dataExportByteLength must be a canonical uint64 decimal string",
    );
  }
  return input as DataExportByteLength;
}

function parseIdentifier(input: unknown, field: string): string {
  if (typeof input !== "string" || !boundedIdentifier.test(input)) {
    throw new InvalidDomainValueError(
      field,
      `${field} must be a bounded identifier`,
    );
  }
  return input;
}

export function createDataExport(input: {
  readonly exportId: DataExportId;
  readonly kind: DataExportKind;
  readonly format: DataExportFormat;
  readonly filterDigest: ContentDigest;
  readonly requestedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}): DataExport {
  const requestedAt = parseUtcInstant(input.requestedAt);
  const expiresAt = parseUtcInstant(input.expiresAt);
  if (expiresAt <= requestedAt) {
    throw new InvalidDomainValueError(
      "dataExport.expiresAt",
      "Data Export expiry must follow request time",
    );
  }
  return Object.freeze({
    exportId: parseDataExportId(input.exportId),
    kind: input.kind,
    format: input.format,
    filterDigest: parseContentDigest(input.filterDigest),
    requestedAt,
    expiresAt,
    state: "queued",
    revision: 1,
  });
}

export function startDataExport(
  exportRequest: DataExport,
  startedAt: UtcInstant,
): DataExport {
  if (exportRequest.state === "running") return exportRequest;
  if (exportRequest.state !== "queued") {
    throw new DataExportTransitionError(
      `start is invalid from ${exportRequest.state}`,
    );
  }
  const at = parseUtcInstant(startedAt);
  if (at >= exportRequest.expiresAt) {
    throw new DataExportTransitionError("an expired Data Export cannot start");
  }
  return Object.freeze({
    ...exportRequest,
    state: "running",
    startedAt: at,
    revision: exportRequest.revision + 1,
  });
}

export function completeDataExport(
  exportRequest: DataExport,
  input: {
    readonly completedAt: UtcInstant;
    readonly objectReference: StorageObjectReference;
    readonly contentDigest: ContentDigest;
    readonly byteLength: DataExportByteLength;
  },
): DataExport {
  if (exportRequest.state !== "running") {
    throw new DataExportTransitionError(
      `completion is invalid from ${exportRequest.state}`,
    );
  }
  const completedAt = parseUtcInstant(input.completedAt);
  if (
    exportRequest.startedAt !== undefined &&
    completedAt < exportRequest.startedAt
  ) {
    throw new DataExportTransitionError("completion precedes export start");
  }
  return Object.freeze({
    ...exportRequest,
    state: "ready",
    completedAt,
    objectReference: parseStorageObjectReference(input.objectReference),
    contentDigest: parseContentDigest(input.contentDigest),
    byteLength: parseDataExportByteLength(input.byteLength),
    revision: exportRequest.revision + 1,
  });
}

export function failDataExport(
  exportRequest: DataExport,
  input: {
    readonly failedAt: UtcInstant;
    readonly failureCode: string;
    readonly evidenceDigest: ContentDigest;
  },
): DataExport {
  if (exportRequest.state !== "running") {
    throw new DataExportTransitionError(
      `failure is invalid from ${exportRequest.state}`,
    );
  }
  return Object.freeze({
    ...exportRequest,
    state: "failed",
    failedAt: parseUtcInstant(input.failedAt),
    failureCode: parseIdentifier(input.failureCode, "failureCode"),
    evidenceDigest: parseContentDigest(input.evidenceDigest),
    revision: exportRequest.revision + 1,
  });
}

export function expireDataExport(
  exportRequest: DataExport,
  expiredAt: UtcInstant,
): DataExport {
  if (exportRequest.state === "expired") return exportRequest;
  if (exportRequest.state === "running") {
    throw new DataExportTransitionError(
      "a running Data Export requires worker reconciliation before expiry",
    );
  }
  const at = parseUtcInstant(expiredAt);
  if (at < exportRequest.expiresAt) {
    throw new DataExportTransitionError("Data Export expiry is not due");
  }
  return Object.freeze({
    ...exportRequest,
    state: "expired",
    revision: exportRequest.revision + 1,
  });
}
