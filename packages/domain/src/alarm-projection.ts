import { InvalidDomainValueError } from "./resource-identities.js";
import type {
  EdgeInstanceId,
  EdgePointId,
  SourceTimestampMs,
} from "./telemetry.js";

const canonicalUint64Pattern = /^(?:0|[1-9][0-9]*)$/;
const maximumUint64 = 18_446_744_073_709_551_615n;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

declare const alarmFactIdBrand: unique symbol;
declare const alarmOccurrenceIdBrand: unique symbol;
declare const alarmRuleIdBrand: unique symbol;
declare const alarmGenerationBrand: unique symbol;
declare const alarmSequenceBrand: unique symbol;

export type AlarmFactId = string & { readonly [alarmFactIdBrand]: true };
export type AlarmOccurrenceId = string & {
  readonly [alarmOccurrenceIdBrand]: true;
};
export type AlarmRuleId = string & { readonly [alarmRuleIdBrand]: true };
export type AlarmGeneration = string & {
  readonly [alarmGenerationBrand]: true;
};
export type AlarmSequence = string & { readonly [alarmSequenceBrand]: true };

export type AlarmFactKind = "cleared" | "raised" | "updated";
export type AlarmSeverity = "critical" | "high" | "info" | "low" | "medium";

export interface AlarmFact {
  readonly factId: AlarmFactId;
  readonly occurrenceId: AlarmOccurrenceId;
  readonly ruleId: AlarmRuleId;
  readonly generation: AlarmGeneration;
  readonly sequence: AlarmSequence;
  readonly kind: AlarmFactKind;
  readonly severity: AlarmSeverity;
  readonly sourceTimestampMs: SourceTimestampMs;
  readonly instanceId: EdgeInstanceId;
  readonly pointId?: EdgePointId;
  readonly summary: string;
}

export interface AlarmProjectionGap {
  readonly expectedSequence: AlarmSequence;
  readonly receivedSequence: AlarmSequence;
}

export interface AlarmProjection {
  readonly occurrenceId: AlarmOccurrenceId;
  readonly ruleId: AlarmRuleId;
  readonly generation: AlarmGeneration;
  readonly lastSequence: AlarmSequence;
  readonly lastFactId: AlarmFactId;
  readonly state: "active" | "cleared";
  readonly severity: AlarmSeverity;
  readonly summary: string;
  readonly sourceTimestampMs: SourceTimestampMs;
  readonly instanceId: EdgeInstanceId;
  readonly pointId?: EdgePointId;
  readonly raisedAt?: SourceTimestampMs;
  readonly clearedAt?: SourceTimestampMs;
  readonly gap?: AlarmProjectionGap;
  readonly edgeFactAuthoritative: true;
  readonly cloudWorkflowState: "acknowledged" | "unacknowledged";
  readonly revision: number;
}

export type AlarmProjectionResult =
  | Readonly<{
      ok: true;
      disposition:
        | "accepted-gap"
        | "accepted-late"
        | "accepted-latest"
        | "replayed";
      updatesProjection: boolean;
      projection?: AlarmProjection;
    }>
  | Readonly<{
      ok: false;
      failure: Readonly<{
        code: "alarm-sequence-conflict";
        message: string;
      }>;
    }>;

function parseUuid(input: unknown, field: string): string {
  if (typeof input !== "string" || !uuidPattern.test(input)) {
    throw new InvalidDomainValueError(
      field,
      `${field} must be a canonical lowercase UUID`,
    );
  }
  return input;
}

function parseUint64(input: unknown, field: string): string {
  if (
    typeof input !== "string" ||
    !canonicalUint64Pattern.test(input) ||
    BigInt(input) > maximumUint64
  ) {
    throw new InvalidDomainValueError(
      field,
      `${field} must be a canonical unsigned 64-bit decimal string`,
    );
  }
  return input;
}

export function parseAlarmFactId(input: unknown): AlarmFactId {
  return parseUuid(input, "alarmFactId") as AlarmFactId;
}

export function parseAlarmOccurrenceId(input: unknown): AlarmOccurrenceId {
  return parseUuid(input, "alarmOccurrenceId") as AlarmOccurrenceId;
}

export function parseAlarmRuleId(input: unknown): AlarmRuleId {
  if (typeof input !== "string" || !identifierPattern.test(input)) {
    throw new InvalidDomainValueError(
      "alarmRuleId",
      "alarmRuleId must be a bounded identifier",
    );
  }
  return input as AlarmRuleId;
}

export function parseAlarmGeneration(input: unknown): AlarmGeneration {
  return parseUint64(input, "alarmGeneration") as AlarmGeneration;
}

export function parseAlarmSequence(input: unknown): AlarmSequence {
  return parseUint64(input, "alarmSequence") as AlarmSequence;
}

export function defineAlarmFact(input: AlarmFact): AlarmFact {
  const kinds = ["cleared", "raised", "updated"] as const;
  const severities = ["critical", "high", "info", "low", "medium"] as const;
  if (!kinds.includes(input.kind)) {
    throw new InvalidDomainValueError(
      "alarmFactKind",
      "alarm fact kind is unsupported",
    );
  }
  if (!severities.includes(input.severity)) {
    throw new InvalidDomainValueError(
      "alarmSeverity",
      "alarm severity is unsupported",
    );
  }
  if (
    typeof input.summary !== "string" ||
    input.summary.trim().length === 0 ||
    input.summary.length > 512
  ) {
    throw new InvalidDomainValueError(
      "alarmSummary",
      "alarm summary must be a non-empty bounded string",
    );
  }
  return Object.freeze({
    factId: parseAlarmFactId(input.factId),
    occurrenceId: parseAlarmOccurrenceId(input.occurrenceId),
    ruleId: parseAlarmRuleId(input.ruleId),
    generation: parseAlarmGeneration(input.generation),
    sequence: parseAlarmSequence(input.sequence),
    kind: input.kind,
    severity: input.severity,
    sourceTimestampMs: input.sourceTimestampMs,
    instanceId: input.instanceId,
    ...(input.pointId === undefined ? {} : { pointId: input.pointId }),
    summary: input.summary.trim(),
  });
}

function nextProjection(
  current: AlarmProjection | undefined,
  fact: AlarmFact,
  gap: AlarmProjectionGap | undefined,
): AlarmProjection {
  const state = fact.kind === "cleared" ? "cleared" : "active";
  const raisedAt =
    fact.kind === "raised"
      ? fact.sourceTimestampMs
      : current?.state === "active"
        ? current.raisedAt
        : undefined;
  return Object.freeze({
    occurrenceId: fact.occurrenceId,
    ruleId: fact.ruleId,
    generation: fact.generation,
    lastSequence: fact.sequence,
    lastFactId: fact.factId,
    state,
    severity: fact.severity,
    summary: fact.summary,
    sourceTimestampMs: fact.sourceTimestampMs,
    instanceId: fact.instanceId,
    ...(fact.pointId === undefined ? {} : { pointId: fact.pointId }),
    ...(raisedAt === undefined ? {} : { raisedAt }),
    ...(fact.kind === "cleared" ? { clearedAt: fact.sourceTimestampMs } : {}),
    ...(gap === undefined
      ? current?.gap === undefined
        ? {}
        : { gap: current.gap }
      : { gap: Object.freeze(gap) }),
    edgeFactAuthoritative: true,
    cloudWorkflowState: current?.cloudWorkflowState ?? "unacknowledged",
    revision: (current?.revision ?? 0) + 1,
  });
}

export function projectAlarmFact(
  current: AlarmProjection | undefined,
  candidate: AlarmFact,
): AlarmProjectionResult {
  if (
    current !== undefined &&
    current.occurrenceId !== candidate.occurrenceId
  ) {
    return {
      ok: false,
      failure: {
        code: "alarm-sequence-conflict",
        message: "alarm occurrence identity cannot change within a projection",
      },
    };
  }
  if (current === undefined) {
    const sequence = BigInt(candidate.sequence);
    const gap =
      sequence === 0n
        ? undefined
        : {
            expectedSequence: parseAlarmSequence("0"),
            receivedSequence: candidate.sequence,
          };
    return {
      ok: true,
      disposition: gap === undefined ? "accepted-latest" : "accepted-gap",
      updatesProjection: true,
      projection: nextProjection(undefined, candidate, gap),
    };
  }

  const currentGeneration = BigInt(current.generation);
  const candidateGeneration = BigInt(candidate.generation);
  if (candidateGeneration < currentGeneration) {
    return {
      ok: true,
      disposition: "accepted-late",
      updatesProjection: false,
    };
  }
  if (candidateGeneration === currentGeneration) {
    const currentSequence = BigInt(current.lastSequence);
    const candidateSequence = BigInt(candidate.sequence);
    if (candidateSequence < currentSequence) {
      return {
        ok: true,
        disposition: "accepted-late",
        updatesProjection: false,
      };
    }
    if (candidateSequence === currentSequence) {
      return candidate.factId === current.lastFactId
        ? {
            ok: true,
            disposition: "replayed",
            updatesProjection: false,
          }
        : {
            ok: false,
            failure: {
              code: "alarm-sequence-conflict",
              message: "alarm sequence was reused by a different fact",
            },
          };
    }
    const expected = currentSequence + 1n;
    const gap =
      candidateSequence === expected
        ? undefined
        : {
            expectedSequence: parseAlarmSequence(expected.toString()),
            receivedSequence: candidate.sequence,
          };
    return {
      ok: true,
      disposition: gap === undefined ? "accepted-latest" : "accepted-gap",
      updatesProjection: true,
      projection: nextProjection(current, candidate, gap),
    };
  }

  const sequence = BigInt(candidate.sequence);
  const gap =
    sequence === 0n
      ? undefined
      : {
          expectedSequence: parseAlarmSequence("0"),
          receivedSequence: candidate.sequence,
        };
  return {
    ok: true,
    disposition: gap === undefined ? "accepted-latest" : "accepted-gap",
    updatesProjection: true,
    projection: nextProjection(current, candidate, gap),
  };
}

export function acknowledgeAlarmProjection(
  current: AlarmProjection,
): AlarmProjection {
  if (current.cloudWorkflowState === "acknowledged") return current;
  return Object.freeze({
    ...current,
    cloudWorkflowState: "acknowledged",
    revision: current.revision + 1,
  });
}

export function resolveAlarmProjectionGap(
  current: AlarmProjection,
): AlarmProjection {
  if (current.gap === undefined) return current;
  const withoutGap = { ...current };
  delete withoutGap.gap;
  return Object.freeze({
    ...withoutGap,
    revision: current.revision + 1,
  });
}
