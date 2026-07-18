import {
  parseIntegrationEntityId,
  parseIntegrationId,
  parseIntegrationPointKey,
  parseIntegrationSnapshotGeneration,
  type IntegrationEntityId,
  type IntegrationId,
  type IntegrationPointKey,
  type IntegrationSnapshotGeneration,
  type IntegrationTopologySnapshot,
} from "./integration-topology.js";
import { parseGovernedJobId, type GovernedJobId } from "./governed-job.js";
import { InvalidDomainValueError } from "./resource-identities.js";

export const INTEGRATION_CONTROL_PROTOCOL =
  "aether.cloudlink.integration-control.v1alpha1" as const;
export const INTEGRATION_POWER_CAPABILITY_ID = "device.power.set.v1" as const;
export const INTEGRATION_CONTROL_PERMISSION =
  "integration.device.control" as const;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const positiveUint64Pattern = /^[1-9][0-9]*$/;
const maximumUint64 = 18_446_744_073_709_551_615n;
const failureCodePattern = /^[A-Z][A-Z0-9_]*$/;
const supportedEntityKinds = new Set(["fan", "light", "switch"]);

declare const integrationControlReceiptIdBrand: unique symbol;
declare const integrationControlReceiptSequenceBrand: unique symbol;
declare const integrationControlDigestBrand: unique symbol;

export type IntegrationControlReceiptId = string & {
  readonly [integrationControlReceiptIdBrand]: true;
};
export type IntegrationControlReceiptSequence = string & {
  readonly [integrationControlReceiptSequenceBrand]: true;
};
export type IntegrationControlDigest = string & {
  readonly [integrationControlDigestBrand]: true;
};

export interface IntegrationControlTarget {
  readonly integrationId: IntegrationId;
  readonly snapshotGeneration: IntegrationSnapshotGeneration;
  readonly entityId: IntegrationEntityId;
  readonly pointKey: IntegrationPointKey;
}

export type IntegrationControlReceiptStage =
  | "edge-accepted"
  | "edge-rejected"
  | "provider-accepted"
  | "provider-rejected"
  | "unknown";

export interface IntegrationControlReceipt {
  readonly jobId: GovernedJobId;
  readonly receiptId: IntegrationControlReceiptId;
  readonly receiptSequence: IntegrationControlReceiptSequence;
  readonly capabilityId: typeof INTEGRATION_POWER_CAPABILITY_ID;
  readonly target: IntegrationControlTarget;
  readonly intentDigest: IntegrationControlDigest;
  readonly stage: IntegrationControlReceiptStage;
  readonly decision: "accepted" | "rejected" | "unknown";
  readonly physicalOutcome: "unknown";
  readonly observedAtMs: string;
  readonly evidenceDigest?: IntegrationControlDigest;
  readonly failureCode?: string;
  readonly audit: Readonly<{
    auditRecordId: string;
    status: "complete" | "incomplete";
  }>;
}

export type IntegrationPowerTargetResolution =
  | Readonly<{ ok: true; target: IntegrationControlTarget }>
  | Readonly<{
      ok: false;
      failure: Readonly<{
        code:
          | "integration-target-not-found"
          | "integration-target-not-writable"
          | "integration-topology-generation-future"
          | "integration-topology-generation-stale";
        message: string;
      }>;
    }>;

function invalid(field: string, message: string): never {
  throw new InvalidDomainValueError(field, message);
}

function parseUuid(input: unknown, field: string): string {
  if (typeof input !== "string" || !uuidPattern.test(input)) {
    return invalid(field, `${field} must be a canonical lowercase UUID`);
  }
  return input;
}

function parseIdentifier(input: unknown, field: string): string {
  if (typeof input !== "string" || !identifierPattern.test(input)) {
    return invalid(field, `${field} must be a bounded identifier`);
  }
  return input;
}

function parsePositiveUint64(input: unknown, field: string): string {
  if (
    typeof input !== "string" ||
    !positiveUint64Pattern.test(input) ||
    BigInt(input) > maximumUint64
  ) {
    return invalid(field, `${field} must be a canonical positive uint64`);
  }
  return input;
}

function parseUint64(input: unknown, field: string): string {
  if (
    typeof input !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(input) ||
    BigInt(input) > maximumUint64
  ) {
    return invalid(field, `${field} must be a canonical uint64`);
  }
  return input;
}

export function parseIntegrationControlDigest(
  input: unknown,
): IntegrationControlDigest {
  if (typeof input !== "string" || !digestPattern.test(input)) {
    return invalid(
      "integrationControlDigest",
      "Integration Control digest must be lowercase SHA-256",
    );
  }
  return input as IntegrationControlDigest;
}

export function parseIntegrationControlReceiptId(
  input: unknown,
): IntegrationControlReceiptId {
  return parseUuid(
    input,
    "integrationControlReceiptId",
  ) as IntegrationControlReceiptId;
}

export function parseIntegrationControlReceiptSequence(
  input: unknown,
): IntegrationControlReceiptSequence {
  return parsePositiveUint64(
    input,
    "integrationControlReceiptSequence",
  ) as IntegrationControlReceiptSequence;
}

export function resolveIntegrationPowerTarget(
  topology: IntegrationTopologySnapshot,
  input: {
    readonly integrationId: unknown;
    readonly snapshotGeneration: unknown;
    readonly entityId: unknown;
  },
): IntegrationPowerTargetResolution {
  const integrationId = parseIntegrationId(input.integrationId);
  const snapshotGeneration = parseIntegrationSnapshotGeneration(
    input.snapshotGeneration,
  );
  const entityId = parseIntegrationEntityId(input.entityId);
  if (integrationId !== topology.integrationId) {
    return {
      ok: false,
      failure: {
        code: "integration-target-not-found",
        message: "Integration control target does not exist",
      },
    };
  }
  if (BigInt(snapshotGeneration) < BigInt(topology.snapshotGeneration)) {
    return {
      ok: false,
      failure: {
        code: "integration-topology-generation-stale",
        message: "Integration control target uses a stale topology generation",
      },
    };
  }
  if (BigInt(snapshotGeneration) > BigInt(topology.snapshotGeneration)) {
    return {
      ok: false,
      failure: {
        code: "integration-topology-generation-future",
        message: "Integration control target generation is not available",
      },
    };
  }
  const entity = topology.entities.find(
    (candidate) => candidate.entityId === entityId,
  );
  if (entity === undefined) {
    return {
      ok: false,
      failure: {
        code: "integration-target-not-found",
        message: "Integration control entity does not exist",
      },
    };
  }
  const point = entity.points.find(
    (candidate) => candidate.pointKey === "is_on",
  );
  if (
    point === undefined ||
    !supportedEntityKinds.has(entity.entityKind) ||
    point.kind !== "status" ||
    point.valueType !== "boolean"
  ) {
    return {
      ok: false,
      failure: {
        code: "integration-target-not-writable",
        message:
          "Integration control permits only Boolean is_on status points on fan, light, or switch entities",
      },
    };
  }
  return {
    ok: true,
    target: Object.freeze({
      integrationId,
      snapshotGeneration,
      entityId,
      pointKey: parseIntegrationPointKey("is_on"),
    }),
  };
}

export function defineIntegrationControlReceipt(input: {
  readonly jobId: unknown;
  readonly receiptId: unknown;
  readonly receiptSequence: unknown;
  readonly capabilityId: unknown;
  readonly target: {
    readonly integrationId: unknown;
    readonly snapshotGeneration: unknown;
    readonly entityId: unknown;
    readonly pointKey: unknown;
  };
  readonly intentDigest: unknown;
  readonly stage: unknown;
  readonly decision: unknown;
  readonly physicalOutcome: unknown;
  readonly observedAtMs: unknown;
  readonly evidenceDigest?: unknown;
  readonly failureCode?: unknown;
  readonly audit: {
    readonly auditRecordId: unknown;
    readonly status: unknown;
  };
}): IntegrationControlReceipt {
  if (input.capabilityId !== INTEGRATION_POWER_CAPABILITY_ID) {
    return invalid(
      "capabilityId",
      "Integration Control capability is unsupported",
    );
  }
  if (input.target.pointKey !== "is_on") {
    return invalid("pointKey", "Integration Control point must be is_on");
  }
  if (
    !(
      [
        "edge-accepted",
        "edge-rejected",
        "provider-accepted",
        "provider-rejected",
        "unknown",
      ] as const
    ).includes(input.stage as IntegrationControlReceiptStage)
  ) {
    return invalid("stage", "Integration Control receipt stage is unsupported");
  }
  if (input.physicalOutcome !== "unknown") {
    return invalid(
      "physicalOutcome",
      "Integration Control never proves a physical outcome",
    );
  }
  const stage = input.stage as IntegrationControlReceiptStage;
  const expectedDecision =
    stage === "edge-accepted" || stage === "provider-accepted"
      ? "accepted"
      : stage === "unknown"
        ? "unknown"
        : "rejected";
  if (input.decision !== expectedDecision) {
    return invalid(
      "decision",
      "Integration Control receipt decision does not match its stage",
    );
  }
  const providerStage =
    stage === "provider-accepted" || stage === "provider-rejected";
  if (providerStage && input.evidenceDigest === undefined) {
    return invalid(
      "evidenceDigest",
      "Provider receipt stages require an evidence digest",
    );
  }
  if (stage === "edge-accepted" && input.evidenceDigest !== undefined) {
    return invalid(
      "evidenceDigest",
      "Edge acceptance must not claim provider evidence",
    );
  }
  const failureRequired =
    stage === "edge-rejected" ||
    stage === "provider-rejected" ||
    stage === "unknown";
  if (failureRequired !== (input.failureCode !== undefined)) {
    return invalid(
      "failureCode",
      "Rejected or unknown receipt stages require exactly one failure code",
    );
  }
  if (
    input.failureCode !== undefined &&
    (typeof input.failureCode !== "string" ||
      !failureCodePattern.test(input.failureCode))
  ) {
    return invalid("failureCode", "failureCode is invalid");
  }
  if (
    input.audit.status !== "complete" &&
    input.audit.status !== "incomplete"
  ) {
    return invalid("audit.status", "receipt audit status is unsupported");
  }

  return Object.freeze({
    jobId: parseGovernedJobId(input.jobId),
    receiptId: parseIntegrationControlReceiptId(input.receiptId),
    receiptSequence: parseIntegrationControlReceiptSequence(
      input.receiptSequence,
    ),
    capabilityId: INTEGRATION_POWER_CAPABILITY_ID,
    target: Object.freeze({
      integrationId: parseIntegrationId(input.target.integrationId),
      snapshotGeneration: parseIntegrationSnapshotGeneration(
        input.target.snapshotGeneration,
      ),
      entityId: parseIntegrationEntityId(input.target.entityId),
      pointKey: parseIntegrationPointKey(input.target.pointKey),
    }),
    intentDigest: parseIntegrationControlDigest(input.intentDigest),
    stage,
    decision: expectedDecision,
    physicalOutcome: "unknown",
    observedAtMs: parseUint64(input.observedAtMs, "observedAtMs"),
    ...(input.evidenceDigest === undefined
      ? {}
      : {
          evidenceDigest: parseIntegrationControlDigest(input.evidenceDigest),
        }),
    ...(input.failureCode === undefined
      ? {}
      : { failureCode: input.failureCode }),
    audit: Object.freeze({
      auditRecordId: parseIdentifier(
        input.audit.auditRecordId,
        "auditRecordId",
      ),
      status: input.audit.status,
    }),
  });
}
