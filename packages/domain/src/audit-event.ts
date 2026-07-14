import type { ContentDigest } from "./artifact-registry.js";
import { parseContentDigest } from "./artifact-registry.js";
import type { ProjectId, TenantId, UtcInstant } from "./resource-identities.js";
import {
  InvalidDomainValueError,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "./resource-identities.js";

const opaqueIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const boundedIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const uint64Pattern = /^(?:0|[1-9][0-9]*)$/;
const maximumUint64 = 18_446_744_073_709_551_615n;
const traceIdPattern = /^[0-9a-f]{32}$/;

declare const auditEventIdBrand: unique symbol;
declare const auditSequenceBrand: unique symbol;

export type AuditEventId = string & { readonly [auditEventIdBrand]: true };
export type AuditSequence = string & { readonly [auditSequenceBrand]: true };
export type AuditSubjectKind =
  | "gateway"
  | "service-account"
  | "system"
  | "user";
export type AuditOutcome =
  | "accepted"
  | "denied"
  | "failed"
  | "succeeded"
  | "unknown";
export type AuditRisk = "critical" | "high" | "low" | "medium";
export type AuditConfirmation = "explicit" | "not-required";

export interface AuditSubject {
  readonly kind: AuditSubjectKind;
  readonly subjectId: string;
}

export interface AuditResource {
  readonly kind: string;
  readonly resourceId: string;
}

export interface AuditEvent {
  readonly eventId: AuditEventId;
  readonly sequence: AuditSequence;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly occurredAt: UtcInstant;
  readonly subject: AuditSubject;
  readonly action: string;
  readonly resource: AuditResource;
  readonly outcome: AuditOutcome;
  readonly risk: AuditRisk;
  readonly confirmation: AuditConfirmation;
  readonly correlationId: string;
  readonly traceId?: string;
  readonly detailsDigest?: ContentDigest;
}

export function parseAuditEventId(input: unknown): AuditEventId {
  if (typeof input !== "string" || !opaqueIdentifier.test(input)) {
    throw new InvalidDomainValueError(
      "auditEventId",
      "auditEventId must be an opaque 8-128 character identifier",
    );
  }
  return input as AuditEventId;
}

export function parseAuditSequence(input: unknown): AuditSequence {
  if (typeof input !== "string" || !uint64Pattern.test(input)) {
    throw new InvalidDomainValueError(
      "auditSequence",
      "auditSequence must be a canonical uint64 decimal string",
    );
  }
  if (BigInt(input) > maximumUint64) {
    throw new InvalidDomainValueError(
      "auditSequence",
      "auditSequence exceeds uint64",
    );
  }
  return input as AuditSequence;
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

function parseOpaqueIdentifier(input: unknown, field: string): string {
  if (typeof input !== "string" || !opaqueIdentifier.test(input)) {
    throw new InvalidDomainValueError(
      field,
      `${field} must be an opaque 8-128 character identifier`,
    );
  }
  return input;
}

export function defineAuditEvent(input: AuditEvent): AuditEvent {
  const sequence = parseAuditSequence(input.sequence);
  if (sequence === "0") {
    throw new InvalidDomainValueError(
      "auditSequence",
      "an Audit Event sequence must be positive",
    );
  }
  if (
    !(["gateway", "service-account", "system", "user"] as const).includes(
      input.subject.kind,
    )
  ) {
    throw new InvalidDomainValueError(
      "auditSubject.kind",
      "audit subject kind is unsupported",
    );
  }
  if (
    !(
      ["accepted", "denied", "failed", "succeeded", "unknown"] as const
    ).includes(input.outcome)
  ) {
    throw new InvalidDomainValueError(
      "auditOutcome",
      "audit outcome is unsupported",
    );
  }
  if (!(["critical", "high", "low", "medium"] as const).includes(input.risk)) {
    throw new InvalidDomainValueError("auditRisk", "audit risk is unsupported");
  }
  if (!(["explicit", "not-required"] as const).includes(input.confirmation)) {
    throw new InvalidDomainValueError(
      "auditConfirmation",
      "audit confirmation is unsupported",
    );
  }
  if (input.traceId !== undefined && !traceIdPattern.test(input.traceId)) {
    throw new InvalidDomainValueError(
      "traceId",
      "traceId must be a lowercase W3C Trace Context identifier",
    );
  }
  return Object.freeze({
    eventId: parseAuditEventId(input.eventId),
    sequence,
    tenantId: parseTenantId(input.tenantId),
    projectId: parseProjectId(input.projectId),
    occurredAt: parseUtcInstant(input.occurredAt),
    subject: Object.freeze({
      kind: input.subject.kind,
      subjectId: parseIdentifier(
        input.subject.subjectId,
        "auditSubject.subjectId",
      ),
    }),
    action: parseIdentifier(input.action, "auditAction"),
    resource: Object.freeze({
      kind: parseIdentifier(input.resource.kind, "auditResource.kind"),
      resourceId: parseOpaqueIdentifier(
        input.resource.resourceId,
        "auditResource.resourceId",
      ),
    }),
    outcome: input.outcome,
    risk: input.risk,
    confirmation: input.confirmation,
    correlationId: parseOpaqueIdentifier(input.correlationId, "correlationId"),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    ...(input.detailsDigest === undefined
      ? {}
      : { detailsDigest: parseContentDigest(input.detailsDigest) }),
  });
}
