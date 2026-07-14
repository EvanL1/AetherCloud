import { InvalidDomainValueError } from "./resource-identities.js";
import type { GatewayCredentialGeneration } from "./cloudlink-session.js";
import type {
  GatewayId,
  ProjectId,
  TenantId,
  UtcInstant,
} from "./resource-identities.js";

const canonicalUnsignedPattern = /^(?:0|[1-9][0-9]*)$/;
const canonicalSignedPattern = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximumUint64 = 18_446_744_073_709_551_615n;
const maximumUint32 = 4_294_967_295n;
const minimumInt64 = -9_223_372_036_854_775_808n;
const maximumInt64 = 9_223_372_036_854_775_807n;

declare const telemetryStreamIdBrand: unique symbol;
declare const telemetryStreamEpochBrand: unique symbol;
declare const telemetryStreamPositionBrand: unique symbol;
declare const sourceTimestampMsBrand: unique symbol;
declare const edgeInstanceIdBrand: unique symbol;
declare const edgePointIdBrand: unique symbol;
declare const deviceEventIdBrand: unique symbol;
declare const modelRevisionBrand: unique symbol;

export type TelemetryStreamId = string & {
  readonly [telemetryStreamIdBrand]: true;
};
export type TelemetryStreamEpoch = string & {
  readonly [telemetryStreamEpochBrand]: true;
};
export type TelemetryStreamPosition = string & {
  readonly [telemetryStreamPositionBrand]: true;
};
export type SourceTimestampMs = string & {
  readonly [sourceTimestampMsBrand]: true;
};
export type EdgeInstanceId = string & { readonly [edgeInstanceIdBrand]: true };
export type EdgePointId = string & { readonly [edgePointIdBrand]: true };
export type DeviceEventId = string & { readonly [deviceEventIdBrand]: true };
export type ThingModelRevision = string & {
  readonly [modelRevisionBrand]: true;
};

export type PointQuality = "bad" | "good" | "uncertain" | "unavailable";
export type RetentionClass = "archive-365d" | "hot-7d" | "standard-30d";

export interface ThingModelReference {
  readonly modelId: string;
  readonly revision: ThingModelRevision;
}

export type TelemetryPointValue =
  | Readonly<{ type: "float64"; value: number }>
  | Readonly<{ type: "int64"; value: string }>;

export type TelemetryQuality = PointQuality;
export type TelemetryModelReference = ThingModelReference;
export type TelemetryValue = TelemetryPointValue;

export interface PointSample {
  readonly kind: "point-sample";
  readonly position: TelemetryStreamPosition;
  readonly sourceTimestampMs: SourceTimestampMs;
  readonly instanceId: EdgeInstanceId;
  readonly pointId: EdgePointId;
  readonly quality: PointQuality;
  readonly value: TelemetryPointValue;
  readonly model: ThingModelReference;
}

export type DeviceEventPayloadValue = boolean | null | number | string;

export interface DeviceEvent {
  readonly kind: "device-event";
  readonly position: TelemetryStreamPosition;
  readonly sourceTimestampMs: SourceTimestampMs;
  readonly eventId: DeviceEventId;
  readonly eventType: string;
  readonly instanceId: EdgeInstanceId;
  readonly payload: Readonly<Record<string, DeviceEventPayloadValue>>;
  readonly model: ThingModelReference;
}

export type TelemetryRecord = DeviceEvent | PointSample;

export interface TelemetryBatch {
  readonly streamId: TelemetryStreamId;
  readonly streamEpoch: TelemetryStreamEpoch;
  readonly retentionClass: RetentionClass;
  readonly replay: boolean;
  readonly records: readonly TelemetryRecord[];
  readonly batchIdentity: string;
  readonly firstPosition: TelemetryStreamPosition;
  readonly lastPosition: TelemetryStreamPosition;
  readonly recordCount: number;
}

export interface TelemetryStreamGap {
  readonly expectedPosition: TelemetryStreamPosition;
  readonly receivedPosition: TelemetryStreamPosition;
}

export interface TelemetryIngestionReceipt {
  readonly receiptId: string;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly batchIdentity: string;
  readonly payloadDigest: string;
  readonly streamId: TelemetryStreamId;
  readonly streamEpoch: TelemetryStreamEpoch;
  readonly firstPosition: TelemetryStreamPosition;
  readonly lastPosition: TelemetryStreamPosition;
  readonly recordCount: number;
  readonly persistedAt: UtcInstant;
  readonly contiguousPosition?: TelemetryStreamPosition;
  readonly gap?: TelemetryStreamGap;
  readonly auditEventId: string;
  readonly outboxEventId: string;
}

export interface PersistedTelemetryRecord {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly streamId: TelemetryStreamId;
  readonly streamEpoch: TelemetryStreamEpoch;
  readonly batchIdentity: string;
  readonly receivedAt: UtcInstant;
  readonly persistedAt: UtcInstant;
  readonly retentionClass: RetentionClass;
  readonly record: TelemetryRecord;
}

export interface TelemetryBatchInput {
  readonly streamId: TelemetryStreamId;
  readonly streamEpoch: TelemetryStreamEpoch;
  readonly retentionClass: RetentionClass;
  readonly replay: boolean;
  readonly records: readonly TelemetryRecord[];
}

function parseUnsigned(
  input: unknown,
  field: string,
  maximum: bigint,
  width: 32 | 64,
): string {
  if (
    typeof input !== "string" ||
    !canonicalUnsignedPattern.test(input) ||
    BigInt(input) > maximum
  ) {
    throw new InvalidDomainValueError(
      field,
      `${field} must be a canonical unsigned ${String(width)}-bit decimal string`,
    );
  }
  return input;
}

export function parseTelemetryStreamId(input: unknown): TelemetryStreamId {
  if (typeof input !== "string" || !identifierPattern.test(input)) {
    throw new InvalidDomainValueError(
      "telemetryStreamId",
      "telemetryStreamId must be a bounded identifier",
    );
  }
  return input as TelemetryStreamId;
}

export function parseTelemetryStreamEpoch(
  input: unknown,
): TelemetryStreamEpoch {
  return parseUnsigned(
    input,
    "telemetryStreamEpoch",
    maximumUint64,
    64,
  ) as TelemetryStreamEpoch;
}

export function parseTelemetryStreamPosition(
  input: unknown,
): TelemetryStreamPosition {
  return parseUnsigned(
    input,
    "telemetryStreamPosition",
    maximumUint64,
    64,
  ) as TelemetryStreamPosition;
}

export function parseSourceTimestampMs(input: unknown): SourceTimestampMs {
  return parseUnsigned(
    input,
    "sourceTimestampMs",
    maximumUint64,
    64,
  ) as SourceTimestampMs;
}

export function parseEdgeInstanceId(input: unknown): EdgeInstanceId {
  return parseUnsigned(
    input,
    "edgeInstanceId",
    maximumUint32,
    32,
  ) as EdgeInstanceId;
}

export function parseEdgePointId(input: unknown): EdgePointId {
  return parseUnsigned(input, "edgePointId", maximumUint32, 32) as EdgePointId;
}

export function parseDeviceEventId(input: unknown): DeviceEventId {
  if (typeof input !== "string" || !uuidPattern.test(input)) {
    throw new InvalidDomainValueError(
      "deviceEventId",
      "deviceEventId must be a canonical lowercase UUID",
    );
  }
  return input as DeviceEventId;
}

export function parseRetentionClass(input: unknown): RetentionClass {
  if (
    typeof input !== "string" ||
    !(["archive-365d", "hot-7d", "standard-30d"] as const).some(
      (candidate) => candidate === input,
    )
  ) {
    throw new InvalidDomainValueError(
      "retentionClass",
      "retentionClass is unsupported",
    );
  }
  return input as RetentionClass;
}

export function parseTelemetryQuality(input: unknown): TelemetryQuality {
  if (
    typeof input !== "string" ||
    !(["bad", "good", "uncertain", "unavailable"] as const).some(
      (candidate) => candidate === input,
    )
  ) {
    throw new InvalidDomainValueError(
      "pointQuality",
      "point quality is unsupported",
    );
  }
  return input as TelemetryQuality;
}

export function parseThingModelRevision(input: unknown): ThingModelRevision {
  return parseUnsigned(
    input,
    "modelRevision",
    maximumUint64,
    64,
  ) as ThingModelRevision;
}

function parseModelReference(input: ThingModelReference): ThingModelReference {
  if (!identifierPattern.test(input.modelId)) {
    throw new InvalidDomainValueError(
      "modelId",
      "modelId must be a bounded identifier",
    );
  }
  const revision = parseThingModelRevision(input.revision);
  return Object.freeze({ modelId: input.modelId, revision });
}

function parsePointValue(value: TelemetryPointValue): TelemetryPointValue {
  switch (value.type) {
    case "float64":
      if (!Number.isFinite(value.value)) {
        throw new InvalidDomainValueError(
          "pointValue",
          "float64 point value must be finite",
        );
      }
      return Object.freeze({ type: "float64", value: value.value });
    case "int64": {
      if (
        typeof value.value !== "string" ||
        !canonicalSignedPattern.test(value.value)
      ) {
        throw new InvalidDomainValueError(
          "pointValue",
          "int64 point value must be a canonical signed decimal string",
        );
      }
      const parsed = BigInt(value.value);
      if (parsed < minimumInt64 || parsed > maximumInt64) {
        throw new InvalidDomainValueError(
          "pointValue",
          "int64 point value is outside the signed 64-bit range",
        );
      }
      return Object.freeze({ type: "int64", value: value.value });
    }
    default:
      throw new InvalidDomainValueError(
        "pointValue",
        "point value type is unsupported",
      );
  }
}

function parsePayload(
  input: Readonly<Record<string, DeviceEventPayloadValue>>,
): Readonly<Record<string, DeviceEventPayloadValue>> {
  const entries = Object.entries(input);
  if (entries.length > 16) {
    throw new InvalidDomainValueError(
      "eventPayload",
      "device event payload may contain at most 16 fields",
    );
  }
  const output: Record<string, DeviceEventPayloadValue> = {};
  for (const [key, value] of entries) {
    if (!identifierPattern.test(key)) {
      throw new InvalidDomainValueError(
        "eventPayload",
        "device event payload keys must be bounded identifiers",
      );
    }
    if (
      !(
        value === null ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && value.length <= 256)
      )
    ) {
      throw new InvalidDomainValueError(
        "eventPayload",
        "device event payload values must be bounded scalar JSON values",
      );
    }
    output[key] = value;
  }
  return Object.freeze(output);
}

function parseRecord(record: TelemetryRecord): TelemetryRecord {
  const common = {
    position: parseTelemetryStreamPosition(record.position),
    sourceTimestampMs: parseSourceTimestampMs(record.sourceTimestampMs),
    instanceId: parseEdgeInstanceId(record.instanceId),
    model: parseModelReference(record.model),
  };
  switch (record.kind) {
    case "point-sample":
      return Object.freeze({
        kind: "point-sample",
        ...common,
        pointId: parseEdgePointId(record.pointId),
        quality: parseTelemetryQuality(record.quality),
        value: parsePointValue(record.value),
      });
    case "device-event":
      if (!identifierPattern.test(record.eventType)) {
        throw new InvalidDomainValueError(
          "eventType",
          "eventType must be a bounded versioned identifier",
        );
      }
      return Object.freeze({
        kind: "device-event",
        ...common,
        eventId: parseDeviceEventId(record.eventId),
        eventType: record.eventType,
        payload: parsePayload(record.payload),
      });
    default:
      throw new InvalidDomainValueError(
        "telemetryRecord",
        "telemetry record kind is unsupported",
      );
  }
}

export function defineTelemetryBatch(
  input: TelemetryBatchInput,
): TelemetryBatch {
  const streamId = parseTelemetryStreamId(input.streamId);
  const streamEpoch = parseTelemetryStreamEpoch(input.streamEpoch);
  const retentionClass = parseRetentionClass(input.retentionClass);
  if (typeof input.replay !== "boolean") {
    throw new InvalidDomainValueError("replay", "replay must be boolean");
  }
  if (input.records.length === 0 || input.records.length > 256) {
    throw new InvalidDomainValueError(
      "telemetryRecords",
      "telemetry batch must contain 1-256 records",
    );
  }
  const records = input.records.map(parseRecord);
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    if (
      previous === undefined ||
      current === undefined ||
      BigInt(current.position) !== BigInt(previous.position) + 1n
    ) {
      throw new InvalidDomainValueError(
        "telemetryRecords",
        "telemetry record positions must be contiguous and ordered",
      );
    }
  }
  const first = records[0];
  const last = records.at(-1);
  if (first === undefined || last === undefined) {
    throw new InvalidDomainValueError(
      "telemetryRecords",
      "telemetry batch cannot be empty",
    );
  }
  return Object.freeze({
    streamId,
    streamEpoch,
    retentionClass,
    replay: input.replay,
    records: Object.freeze(records),
    batchIdentity: `${streamId}:${streamEpoch}:${first.position}`,
    firstPosition: first.position,
    lastPosition: last.position,
    recordCount: records.length,
  });
}
