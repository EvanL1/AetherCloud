import type { ContentDigest } from "./artifact-registry.js";
import { parseContentDigest } from "./artifact-registry.js";
import type { GatewayId, UtcInstant } from "./resource-identities.js";
import {
  InvalidDomainValueError,
  parseGatewayId,
  parseUtcInstant,
} from "./resource-identities.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const boundedIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const opaqueIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const uint64Pattern = /^(?:0|[1-9][0-9]*)$/;
const maximumUint64 = 18_446_744_073_709_551_615n;

declare const governedJobIdBrand: unique symbol;
declare const edgeCapabilityIdBrand: unique symbol;
declare const jobReceiptIdBrand: unique symbol;
declare const jobReceiptSequenceBrand: unique symbol;

export type GovernedJobId = string & { readonly [governedJobIdBrand]: true };
export type EdgeCapabilityId = string & {
  readonly [edgeCapabilityIdBrand]: true;
};
export type JobReceiptId = string & { readonly [jobReceiptIdBrand]: true };
export type JobReceiptSequence = string & {
  readonly [jobReceiptSequenceBrand]: true;
};
export type JobRisk = "critical" | "high" | "low" | "medium";
export type JobConfirmation = "explicit" | "not-required";
export type JobReplaySafety = "safe" | "unsafe";
export type GovernedJobState =
  | "accepted"
  | "authorized"
  | "awaiting-confirmation"
  | "cancel-requested"
  | "canceled"
  | "expired"
  | "failed"
  | "offered"
  | "partial"
  | "queued"
  | "rejected"
  | "running"
  | "succeeded"
  | "unknown";

export type JobReceiptKind =
  | "accepted"
  | "canceled"
  | "expired"
  | "failed"
  | "partial"
  | "rejected"
  | "running"
  | "succeeded";

export interface GovernedJobReceipt {
  readonly receiptId: JobReceiptId;
  readonly sequence: JobReceiptSequence;
  readonly kind: JobReceiptKind;
  readonly observedAt: UtcInstant;
  readonly payloadDigest: ContentDigest;
  readonly evidenceDigest?: ContentDigest;
}

export interface GovernedJob {
  readonly jobId: GovernedJobId;
  readonly gatewayId: GatewayId;
  readonly capabilityId: EdgeCapabilityId;
  readonly capabilityPermission: string;
  readonly risk: JobRisk;
  readonly confirmation: JobConfirmation;
  readonly replaySafety: JobReplaySafety;
  readonly physicalEffect: boolean;
  readonly argumentsDigest: ContentDigest;
  readonly preconditionDigest: ContentDigest;
  readonly state: GovernedJobState;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly confirmedBy?: string;
  readonly confirmedAt?: UtcInstant;
  readonly queuedAt?: UtcInstant;
  readonly offeredAt?: UtcInstant;
  readonly unknownAt?: UtcInstant;
  readonly cancelRequestedAt?: UtcInstant;
  readonly receipts: readonly GovernedJobReceipt[];
  readonly lastContiguousSequence: JobReceiptSequence;
  readonly revision: number;
}

export type GovernedJobReceiptDisposition =
  | "accepted-current"
  | "pending-predecessor"
  | "replayed";

export type GovernedJobReceiptResult =
  | Readonly<{
      ok: true;
      replayed: boolean;
      disposition: GovernedJobReceiptDisposition;
      job: GovernedJob;
    }>
  | Readonly<{
      ok: false;
      failure: Readonly<{
        code: "job-receipt-conflict" | "job-receipt-invalid";
        message: string;
      }>;
    }>;

export class GovernedJobTransitionError extends Error {
  readonly code = "invalid-governed-job-transition";

  constructor(message: string) {
    super(message);
    this.name = "GovernedJobTransitionError";
  }
}

export function parseGovernedJobId(input: unknown): GovernedJobId {
  if (typeof input !== "string" || !uuidPattern.test(input)) {
    throw new InvalidDomainValueError(
      "governedJobId",
      "governedJobId must be a canonical lowercase UUID",
    );
  }
  return input as GovernedJobId;
}

export function parseEdgeCapabilityId(input: unknown): EdgeCapabilityId {
  if (typeof input !== "string" || !boundedIdentifier.test(input)) {
    throw new InvalidDomainValueError(
      "edgeCapabilityId",
      "edgeCapabilityId must be a bounded identifier",
    );
  }
  return input as EdgeCapabilityId;
}

export function parseJobReceiptId(input: unknown): JobReceiptId {
  if (typeof input !== "string" || !opaqueIdentifier.test(input)) {
    throw new InvalidDomainValueError(
      "jobReceiptId",
      "jobReceiptId must be an opaque 8-128 character identifier",
    );
  }
  return input as JobReceiptId;
}

export function parseJobReceiptSequence(input: unknown): JobReceiptSequence {
  if (
    typeof input !== "string" ||
    !uint64Pattern.test(input) ||
    BigInt(input) > maximumUint64
  ) {
    throw new InvalidDomainValueError(
      "jobReceiptSequence",
      "jobReceiptSequence must be a canonical uint64 decimal string",
    );
  }
  return input as JobReceiptSequence;
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

function freezeReceipt(input: GovernedJobReceipt): GovernedJobReceipt {
  return Object.freeze({ ...input });
}

function freezeJob(input: GovernedJob): GovernedJob {
  return Object.freeze({
    ...input,
    receipts: Object.freeze(input.receipts.map(freezeReceipt)),
  });
}

export function createGovernedJob(input: {
  readonly jobId: GovernedJobId;
  readonly gatewayId: GatewayId;
  readonly capabilityId: EdgeCapabilityId | string;
  readonly capabilityPermission: string;
  readonly risk: JobRisk;
  readonly confirmation: JobConfirmation;
  readonly replaySafety: JobReplaySafety;
  readonly physicalEffect: boolean;
  readonly argumentsDigest: ContentDigest;
  readonly preconditionDigest: ContentDigest;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}): GovernedJob {
  const createdAt = parseUtcInstant(input.createdAt);
  const expiresAt = parseUtcInstant(input.expiresAt);
  if (expiresAt <= createdAt) {
    throw new InvalidDomainValueError(
      "job.expiresAt",
      "job expiry must follow creation",
    );
  }
  if (!(["critical", "high", "low", "medium"] as const).includes(input.risk)) {
    throw new InvalidDomainValueError("job.risk", "job risk is unsupported");
  }
  if (typeof input.physicalEffect !== "boolean") {
    throw new InvalidDomainValueError(
      "job.physicalEffect",
      "job physicalEffect must be boolean",
    );
  }
  return freezeJob({
    jobId: parseGovernedJobId(input.jobId),
    gatewayId: parseGatewayId(input.gatewayId),
    capabilityId: parseEdgeCapabilityId(input.capabilityId),
    capabilityPermission: parseIdentifier(
      input.capabilityPermission,
      "job.capabilityPermission",
    ),
    risk: input.risk,
    confirmation: input.confirmation,
    replaySafety: input.replaySafety,
    physicalEffect: input.physicalEffect,
    argumentsDigest: parseContentDigest(input.argumentsDigest),
    preconditionDigest: parseContentDigest(input.preconditionDigest),
    state:
      input.confirmation === "explicit"
        ? "awaiting-confirmation"
        : "authorized",
    createdAt,
    expiresAt,
    receipts: [],
    lastContiguousSequence: parseJobReceiptSequence("0"),
    revision: 1,
  });
}

export function confirmGovernedJob(
  job: GovernedJob,
  subjectId: string,
  confirmedAt: UtcInstant,
): GovernedJob {
  if (job.state === "authorized") return job;
  if (job.state !== "awaiting-confirmation") {
    throw new GovernedJobTransitionError(
      `confirmation is invalid from ${job.state}`,
    );
  }
  const at = parseUtcInstant(confirmedAt);
  if (at >= job.expiresAt) {
    throw new GovernedJobTransitionError("an expired Job cannot be confirmed");
  }
  return freezeJob({
    ...job,
    state: "authorized",
    confirmedBy: parseIdentifier(subjectId, "confirmedBy"),
    confirmedAt: at,
    revision: job.revision + 1,
  });
}

export function queueGovernedJob(
  job: GovernedJob,
  queuedAt: UtcInstant,
): GovernedJob {
  if (job.state === "queued") return job;
  if (job.state !== "authorized") {
    throw new GovernedJobTransitionError(`queue is invalid from ${job.state}`);
  }
  return freezeJob({
    ...job,
    state: "queued",
    queuedAt: parseUtcInstant(queuedAt),
    revision: job.revision + 1,
  });
}

export function offerGovernedJob(
  job: GovernedJob,
  offeredAt: UtcInstant,
): GovernedJob {
  if (job.state === "offered") return job;
  if (job.state !== "queued") {
    throw new GovernedJobTransitionError(`offer is invalid from ${job.state}`);
  }
  const at = parseUtcInstant(offeredAt);
  if (at >= job.expiresAt) {
    throw new GovernedJobTransitionError("an expired Job cannot be offered");
  }
  return freezeJob({
    ...job,
    state: "offered",
    offeredAt: at,
    revision: job.revision + 1,
  });
}

export function expireGovernedJob(
  job: GovernedJob,
  expiredAt: UtcInstant,
): GovernedJob {
  const at = parseUtcInstant(expiredAt);
  if (job.state === "expired") return job;
  if (at < job.expiresAt) {
    throw new GovernedJobTransitionError("Job expiry has not been reached");
  }
  if (
    !["awaiting-confirmation", "authorized", "queued", "offered"].includes(
      job.state,
    )
  ) {
    throw new GovernedJobTransitionError(
      `Job cannot expire after edge state ${job.state}`,
    );
  }
  return freezeJob({ ...job, state: "expired", revision: job.revision + 1 });
}

export function markGovernedJobUnknown(
  job: GovernedJob,
  unknownAt: UtcInstant,
): GovernedJob {
  if (job.state === "unknown") return job;
  if (
    job.state !== "offered" &&
    job.state !== "accepted" &&
    job.state !== "running" &&
    job.state !== "cancel-requested"
  ) {
    throw new GovernedJobTransitionError(
      `unknown is invalid from ${job.state}`,
    );
  }
  return freezeJob({
    ...job,
    state: "unknown",
    unknownAt: parseUtcInstant(unknownAt),
    revision: job.revision + 1,
  });
}

export function requestGovernedJobCancellation(
  job: GovernedJob,
  requestedAt: UtcInstant,
): GovernedJob {
  if (job.state === "cancel-requested") return job;
  if (
    job.state !== "queued" &&
    job.state !== "offered" &&
    job.state !== "accepted" &&
    job.state !== "running" &&
    job.state !== "unknown"
  ) {
    throw new GovernedJobTransitionError(
      `cancellation is invalid from ${job.state}`,
    );
  }
  return freezeJob({
    ...job,
    state: "cancel-requested",
    cancelRequestedAt: parseUtcInstant(requestedAt),
    revision: job.revision + 1,
  });
}

function parseReceipt(input: GovernedJobReceipt): GovernedJobReceipt {
  const sequence = parseJobReceiptSequence(input.sequence);
  if (sequence === "0") {
    throw new InvalidDomainValueError(
      "jobReceiptSequence",
      "a Job Receipt sequence must be positive",
    );
  }
  if (
    !(
      [
        "accepted",
        "canceled",
        "expired",
        "failed",
        "partial",
        "rejected",
        "running",
        "succeeded",
      ] as const
    ).includes(input.kind)
  ) {
    throw new InvalidDomainValueError(
      "jobReceiptKind",
      "Job Receipt kind is unsupported",
    );
  }
  return freezeReceipt({
    receiptId: parseJobReceiptId(input.receiptId),
    sequence,
    kind: input.kind,
    observedAt: parseUtcInstant(input.observedAt),
    payloadDigest: parseContentDigest(input.payloadDigest),
    ...(input.evidenceDigest === undefined
      ? {}
      : { evidenceDigest: parseContentDigest(input.evidenceDigest) }),
  });
}

function receiptsEqual(
  left: GovernedJobReceipt,
  right: GovernedJobReceipt,
): boolean {
  return (
    left.receiptId === right.receiptId &&
    left.sequence === right.sequence &&
    left.kind === right.kind &&
    left.observedAt === right.observedAt &&
    left.payloadDigest === right.payloadDigest &&
    left.evidenceDigest === right.evidenceDigest
  );
}

function isTerminalReceipt(kind: JobReceiptKind): boolean {
  return (
    kind === "canceled" ||
    kind === "expired" ||
    kind === "failed" ||
    kind === "partial" ||
    kind === "rejected" ||
    kind === "succeeded"
  );
}

function receiptTransitionIsAllowed(
  state: GovernedJobState,
  kind: JobReceiptKind,
): boolean {
  if (state === "offered") {
    return (
      kind === "accepted" || kind === "rejected" || isTerminalReceipt(kind)
    );
  }
  if (state === "accepted")
    return kind === "running" || isTerminalReceipt(kind);
  if (state === "running") return isTerminalReceipt(kind);
  if (state === "unknown" || state === "cancel-requested") {
    return kind === "accepted" || kind === "running" || isTerminalReceipt(kind);
  }
  return false;
}

function advanceContiguousReceipts(
  initialState: GovernedJobState,
  initialSequence: JobReceiptSequence,
  receipts: readonly GovernedJobReceipt[],
):
  | Readonly<{
      ok: true;
      state: GovernedJobState;
      sequence: JobReceiptSequence;
    }>
  | Readonly<{ ok: false; message: string }> {
  let state = initialState;
  let sequence = BigInt(initialSequence);
  let next = receipts.find(
    (candidate) => BigInt(candidate.sequence) === sequence + 1n,
  );
  while (next !== undefined) {
    if (!receiptTransitionIsAllowed(state, next.kind)) {
      return {
        ok: false,
        message: `Receipt ${next.kind} is invalid from Job state ${state}`,
      };
    }
    state = next.kind;
    sequence += 1n;
    next = receipts.find(
      (candidate) => BigInt(candidate.sequence) === sequence + 1n,
    );
  }
  return {
    ok: true,
    state,
    sequence: parseJobReceiptSequence(sequence.toString()),
  };
}

export function recordGovernedJobReceipt(
  job: GovernedJob,
  input: GovernedJobReceipt,
): GovernedJobReceiptResult {
  let receipt: GovernedJobReceipt;
  try {
    receipt = parseReceipt(input);
  } catch (error: unknown) {
    if (error instanceof InvalidDomainValueError) {
      return {
        ok: false,
        failure: { code: "job-receipt-invalid", message: error.message },
      };
    }
    throw error;
  }
  const prior = job.receipts.find(
    (candidate) =>
      candidate.receiptId === receipt.receiptId ||
      candidate.sequence === receipt.sequence,
  );
  if (prior !== undefined) {
    return receiptsEqual(prior, receipt)
      ? { ok: true, replayed: true, disposition: "replayed", job }
      : {
          ok: false,
          failure: {
            code: "job-receipt-conflict",
            message:
              "Receipt identity or sequence was reused with different content",
          },
        };
  }
  if (
    isTerminalReceipt(receipt.kind) &&
    (receipt.kind === "succeeded" ||
      receipt.kind === "failed" ||
      receipt.kind === "partial") &&
    receipt.evidenceDigest === undefined
  ) {
    return {
      ok: false,
      failure: {
        code: "job-receipt-invalid",
        message: "terminal execution Receipt requires evidence",
      },
    };
  }
  if (
    job.state === "awaiting-confirmation" ||
    job.state === "authorized" ||
    job.state === "queued"
  ) {
    return {
      ok: false,
      failure: {
        code: "job-receipt-invalid",
        message: "Receipt arrived before the Job was offered",
      },
    };
  }
  const receipts = Object.freeze([...job.receipts, receipt]);
  const expected = BigInt(job.lastContiguousSequence) + 1n;
  if (BigInt(receipt.sequence) > expected) {
    return {
      ok: true,
      replayed: false,
      disposition: "pending-predecessor",
      job: freezeJob({ ...job, receipts, revision: job.revision + 1 }),
    };
  }
  const advanced = advanceContiguousReceipts(
    job.state,
    job.lastContiguousSequence,
    receipts,
  );
  if (!advanced.ok) {
    return {
      ok: false,
      failure: { code: "job-receipt-invalid", message: advanced.message },
    };
  }
  return {
    ok: true,
    replayed: false,
    disposition: "accepted-current",
    job: freezeJob({
      ...job,
      state: advanced.state,
      receipts,
      lastContiguousSequence: advanced.sequence,
      revision: job.revision + 1,
    }),
  };
}
