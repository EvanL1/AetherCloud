import { InvalidDomainValueError } from "./resource-identities.js";

export const INTEGRATION_TOPOLOGY_SCHEMA =
  "aether.integration.topology-snapshot.v1alpha1" as const;
export const INTEGRATION_OBSERVATION_SCHEMA =
  "aether.integration.observation-batch.v1alpha1" as const;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const unsignedPattern = /^(?:0|[1-9][0-9]*)$/;
const signedPattern = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const base64UrlPattern = /^[A-Za-z0-9_-]*$/;
const maximumUint64 = 18_446_744_073_709_551_615n;
const minimumInt64 = -9_223_372_036_854_775_808n;
const maximumInt64 = 9_223_372_036_854_775_807n;
const maximumAreas = 4_096;
const maximumDevices = 16_384;
const maximumEntities = 65_536;
const maximumPointsPerEntity = 64;
const maximumObservations = 65_536;

declare const integrationIdBrand: unique symbol;
declare const integrationKindBrand: unique symbol;
declare const areaIdBrand: unique symbol;
declare const deviceIdBrand: unique symbol;
declare const entityIdBrand: unique symbol;
declare const entityKindBrand: unique symbol;
declare const pointKeyBrand: unique symbol;
declare const snapshotGenerationBrand: unique symbol;
declare const observedAtMsBrand: unique symbol;
declare const integrationBatchIdBrand: unique symbol;

export type IntegrationId = string & { readonly [integrationIdBrand]: true };
export type IntegrationKind = string & {
  readonly [integrationKindBrand]: true;
};
export type IntegrationAreaId = string & { readonly [areaIdBrand]: true };
export type IntegrationDeviceId = string & { readonly [deviceIdBrand]: true };
export type IntegrationEntityId = string & { readonly [entityIdBrand]: true };
export type IntegrationEntityKind = string & {
  readonly [entityKindBrand]: true;
};
export type IntegrationPointKey = string & { readonly [pointKeyBrand]: true };
export type IntegrationSnapshotGeneration = string & {
  readonly [snapshotGenerationBrand]: true;
};
export type IntegrationObservedAtMs = string & {
  readonly [observedAtMsBrand]: true;
};
export type IntegrationBatchId = string & {
  readonly [integrationBatchIdBrand]: true;
};

export type IntegrationPointKind = "event" | "status" | "telemetry";
export type IntegrationValueType =
  | "boolean"
  | "bytes"
  | "decimal"
  | "float64"
  | "int64"
  | "string"
  | "uint64";
export type IntegrationObservationQuality =
  | "bad"
  | "good"
  | "uncertain"
  | "unavailable";

export type IntegrationObservedValue =
  | Readonly<{ type: "boolean"; value: boolean }>
  | Readonly<{
      type: "bytes";
      encoding: "base64url";
      value: string;
    }>
  | Readonly<{ type: "decimal"; value: string }>
  | Readonly<{ type: "float64"; value: number }>
  | Readonly<{ type: "int64"; value: string }>
  | Readonly<{ type: "string"; value: string }>
  | Readonly<{ type: "uint64"; value: string }>;

export interface IntegrationArea {
  readonly areaId: IntegrationAreaId;
  readonly name: string;
}

export interface IntegrationDevice {
  readonly deviceId: IntegrationDeviceId;
  readonly name: string;
  readonly areaId?: IntegrationAreaId;
  readonly manufacturer?: string;
  readonly model?: string;
  readonly softwareVersion?: string;
  readonly hardwareVersion?: string;
}

export interface IntegrationEntityPointDescriptor {
  readonly pointKey: IntegrationPointKey;
  readonly title: string;
  readonly kind: IntegrationPointKind;
  readonly valueType: IntegrationValueType;
  readonly unit?: string;
}

export interface IntegrationEntity {
  readonly entityId: IntegrationEntityId;
  readonly sourceAddress: string;
  readonly name: string;
  readonly entityKind: IntegrationEntityKind;
  readonly deviceId?: IntegrationDeviceId;
  readonly areaId?: IntegrationAreaId;
  readonly points: readonly IntegrationEntityPointDescriptor[];
}

export interface IntegrationTopologySnapshot {
  readonly schema: typeof INTEGRATION_TOPOLOGY_SCHEMA;
  readonly integrationId: IntegrationId;
  readonly integrationKind: IntegrationKind;
  readonly snapshotGeneration: IntegrationSnapshotGeneration;
  readonly observedAtMs: IntegrationObservedAtMs;
  readonly areas: readonly IntegrationArea[];
  readonly devices: readonly IntegrationDevice[];
  readonly entities: readonly IntegrationEntity[];
}

export interface IntegrationObservation {
  readonly entityId: IntegrationEntityId;
  readonly pointKey: IntegrationPointKey;
  readonly observedAtMs: IntegrationObservedAtMs;
  readonly quality: IntegrationObservationQuality;
  readonly value?: IntegrationObservedValue;
  readonly diagnostic?: string;
}

export interface IntegrationObservationBatch {
  readonly schema: typeof INTEGRATION_OBSERVATION_SCHEMA;
  readonly integrationId: IntegrationId;
  readonly snapshotGeneration: IntegrationSnapshotGeneration;
  readonly batchId: IntegrationBatchId;
  readonly observedAtMs: IntegrationObservedAtMs;
  readonly observations: readonly IntegrationObservation[];
}

export interface IntegrationAreaInput {
  readonly areaId: string;
  readonly name: string;
}

export interface IntegrationDeviceInput {
  readonly deviceId: string;
  readonly name: string;
  readonly areaId?: string;
  readonly manufacturer?: string;
  readonly model?: string;
  readonly softwareVersion?: string;
  readonly hardwareVersion?: string;
}

export interface IntegrationEntityPointDescriptorInput {
  readonly pointKey: string;
  readonly title: string;
  readonly kind: IntegrationPointKind;
  readonly valueType: IntegrationValueType;
  readonly unit?: string;
}

export interface IntegrationEntityInput {
  readonly entityId: string;
  readonly sourceAddress: string;
  readonly name: string;
  readonly entityKind: string;
  readonly deviceId?: string;
  readonly areaId?: string;
  readonly points: readonly IntegrationEntityPointDescriptorInput[];
}

export interface IntegrationTopologySnapshotInput {
  readonly schema: string;
  readonly integrationId: string;
  readonly integrationKind: string;
  readonly snapshotGeneration: string;
  readonly observedAtMs: string;
  readonly areas: readonly IntegrationAreaInput[];
  readonly devices: readonly IntegrationDeviceInput[];
  readonly entities: readonly IntegrationEntityInput[];
}

export interface IntegrationObservationInput {
  readonly entityId: string;
  readonly pointKey: string;
  readonly observedAtMs: string;
  readonly quality: IntegrationObservationQuality;
  readonly value?: IntegrationObservedValue;
  readonly diagnostic?: string;
}

export interface IntegrationObservationBatchInput {
  readonly schema: string;
  readonly integrationId: string;
  readonly snapshotGeneration: string;
  readonly batchId: string;
  readonly observedAtMs: string;
  readonly observations: readonly IntegrationObservationInput[];
}

function invalid(field: string, message: string): never {
  throw new InvalidDomainValueError(field, message);
}

function parseIdentifier(input: unknown, field: string): string {
  if (typeof input !== "string" || !identifierPattern.test(input)) {
    return invalid(field, `${field} must be a bounded identifier`);
  }
  return input;
}

function containsControlCharacter(input: string): boolean {
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit < 0x20 || codeUnit === 0x7f) return true;
  }
  return false;
}

function exceedsCodePointLimit(input: string, maximum: number): boolean {
  let count = 0;
  for (const character of input) {
    if (character.codePointAt(0) !== undefined) count += 1;
    if (count > maximum) return true;
  }
  return false;
}

function parseBoundedText(
  input: unknown,
  field: string,
  maximum: number,
): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    exceedsCodePointLimit(input, maximum) ||
    containsControlCharacter(input)
  ) {
    return invalid(field, `${field} must be non-empty bounded text`);
  }
  return input;
}

function parseOptionalText(
  input: string | undefined,
  field: string,
  maximum: number,
): string | undefined {
  return input === undefined
    ? undefined
    : parseBoundedText(input, field, maximum);
}

function parseOptionalUnit(
  input: string | undefined,
  field: string,
  maximum: number,
): string | undefined {
  if (input === undefined) return undefined;
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    exceedsCodePointLimit(input, maximum)
  ) {
    return invalid(field, `${field} must be non-empty bounded unit text`);
  }
  return input;
}

function parseUnsigned64(input: unknown, field: string, positive: boolean) {
  if (
    typeof input !== "string" ||
    !unsignedPattern.test(input) ||
    BigInt(input) > maximumUint64 ||
    (positive && input === "0")
  ) {
    return invalid(
      field,
      `${field} must be a canonical ${positive ? "positive " : ""}uint64 decimal string`,
    );
  }
  return input;
}

export function parseIntegrationId(input: unknown): IntegrationId {
  return parseIdentifier(input, "integrationId") as IntegrationId;
}

export function parseIntegrationKind(input: unknown): IntegrationKind {
  return parseIdentifier(input, "integrationKind") as IntegrationKind;
}

export function parseIntegrationAreaId(input: unknown): IntegrationAreaId {
  return parseIdentifier(input, "areaId") as IntegrationAreaId;
}

export function parseIntegrationDeviceId(input: unknown): IntegrationDeviceId {
  return parseIdentifier(input, "deviceId") as IntegrationDeviceId;
}

export function parseIntegrationEntityId(input: unknown): IntegrationEntityId {
  return parseIdentifier(input, "entityId") as IntegrationEntityId;
}

export function parseIntegrationEntityKind(
  input: unknown,
): IntegrationEntityKind {
  return parseIdentifier(input, "entityKind") as IntegrationEntityKind;
}

export function parseIntegrationPointKey(input: unknown): IntegrationPointKey {
  return parseIdentifier(input, "pointKey") as IntegrationPointKey;
}

export function parseIntegrationSnapshotGeneration(
  input: unknown,
): IntegrationSnapshotGeneration {
  return parseUnsigned64(
    input,
    "snapshotGeneration",
    false,
  ) as IntegrationSnapshotGeneration;
}

export function parseIntegrationObservedAtMs(
  input: unknown,
): IntegrationObservedAtMs {
  return parseUnsigned64(
    input,
    "observedAtMs",
    false,
  ) as IntegrationObservedAtMs;
}

export function parseIntegrationBatchId(input: unknown): IntegrationBatchId {
  return parseIdentifier(input, "batchId") as IntegrationBatchId;
}

function requireBoundedArray(
  input: readonly unknown[],
  field: string,
  maximum: number,
  allowEmpty: boolean,
): void {
  if (
    !Array.isArray(input) ||
    input.length > maximum ||
    (!allowEmpty && input.length === 0)
  ) {
    invalid(
      field,
      `${field} must contain ${allowEmpty ? "zero or more" : "one or more"} bounded items`,
    );
  }
}

function ensureUnique(
  values: readonly string[],
  field: string,
  scope: string,
): void {
  if (new Set(values).size !== values.length) {
    invalid(field, `${scope} contains duplicate ${field} values`);
  }
}

function parsePointKind(input: unknown): IntegrationPointKind {
  if (input !== "event" && input !== "status" && input !== "telemetry") {
    return invalid("kind", "point kind is unsupported");
  }
  return input;
}

function parseValueType(input: unknown): IntegrationValueType {
  if (
    input !== "boolean" &&
    input !== "bytes" &&
    input !== "decimal" &&
    input !== "float64" &&
    input !== "int64" &&
    input !== "string" &&
    input !== "uint64"
  ) {
    return invalid("valueType", "point value type is unsupported");
  }
  return input;
}

function parseQuality(input: unknown): IntegrationObservationQuality {
  if (
    input !== "bad" &&
    input !== "good" &&
    input !== "uncertain" &&
    input !== "unavailable"
  ) {
    return invalid("quality", "observation quality is unsupported");
  }
  return input;
}

function isCanonicalDecimal(input: string): boolean {
  if (
    input.length > 96 ||
    !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(input)
  ) {
    return false;
  }
  return input !== "-0";
}

function base64UrlValue(character: string): number {
  if (character >= "A" && character <= "Z") {
    return character.charCodeAt(0) - 65;
  }
  if (character >= "a" && character <= "z") {
    return character.charCodeAt(0) - 71;
  }
  if (character >= "0" && character <= "9") {
    return character.charCodeAt(0) + 4;
  }
  return character === "-" ? 62 : 63;
}

function isCanonicalBase64Url(input: string): boolean {
  if (
    input.length > 16_384 ||
    !base64UrlPattern.test(input) ||
    input.length % 4 === 1
  ) {
    return false;
  }
  if (input.length === 0 || input.length % 4 === 0) return true;
  const finalCharacter = input.at(-1);
  if (finalCharacter === undefined) return false;
  const finalValue = base64UrlValue(finalCharacter);
  return input.length % 4 === 2
    ? (finalValue & 0b00_1111) === 0
    : (finalValue & 0b00_0011) === 0;
}

function defineObservedValue(
  input: IntegrationObservedValue,
): IntegrationObservedValue {
  switch (input.type) {
    case "boolean":
      if (typeof input.value !== "boolean") {
        return invalid("value", "boolean observation value is invalid");
      }
      return Object.freeze({ type: input.type, value: input.value });
    case "bytes":
      if (
        typeof input.value !== "string" ||
        !isCanonicalBase64Url(input.value)
      ) {
        return invalid("value", "bytes value must use canonical base64url");
      }
      return Object.freeze({
        type: input.type,
        encoding: input.encoding,
        value: input.value,
      });
    case "decimal":
      if (typeof input.value !== "string" || !isCanonicalDecimal(input.value)) {
        return invalid("value", "decimal value must be canonical decimal text");
      }
      return Object.freeze({ type: input.type, value: input.value });
    case "float64":
      if (
        typeof input.value !== "number" ||
        !Number.isFinite(input.value) ||
        (Number.isInteger(input.value) &&
          !Number.isSafeInteger(input.value) &&
          !JSON.stringify(input.value).includes("."))
      ) {
        return invalid(
          "value",
          "float64 observation value must be finite and interoperable",
        );
      }
      return Object.freeze({ type: input.type, value: input.value });
    case "int64": {
      if (
        typeof input.value !== "string" ||
        !signedPattern.test(input.value) ||
        BigInt(input.value) < minimumInt64 ||
        BigInt(input.value) > maximumInt64
      ) {
        return invalid("value", "int64 value must be canonical and in range");
      }
      return Object.freeze({ type: input.type, value: input.value });
    }
    case "string":
      if (
        typeof input.value !== "string" ||
        exceedsCodePointLimit(input.value, 4_096)
      ) {
        return invalid("value", "string observation value is too large");
      }
      return Object.freeze({ type: input.type, value: input.value });
    case "uint64":
      return Object.freeze({
        type: input.type,
        value: parseUnsigned64(input.value, "value", false),
      });
  }
}

export function defineIntegrationTopologySnapshot(
  input: IntegrationTopologySnapshotInput,
): IntegrationTopologySnapshot {
  if (input.schema !== INTEGRATION_TOPOLOGY_SCHEMA) {
    invalid("schema", "integration topology schema is unsupported");
  }
  requireBoundedArray(input.areas, "areas", maximumAreas, true);
  requireBoundedArray(input.devices, "devices", maximumDevices, true);
  requireBoundedArray(input.entities, "entities", maximumEntities, true);

  const areas = input.areas.map<IntegrationArea>((area) =>
    Object.freeze({
      areaId: parseIntegrationAreaId(area.areaId),
      name: parseBoundedText(area.name, "area.name", 256),
    }),
  );
  ensureUnique(
    areas.map((area) => area.areaId),
    "areaId",
    "integration topology",
  );
  const areaIds = new Set(areas.map((area) => area.areaId));

  const devices = input.devices.map<IntegrationDevice>((device) => {
    const areaId =
      device.areaId === undefined
        ? undefined
        : parseIntegrationAreaId(device.areaId);
    const manufacturer = parseOptionalText(
      device.manufacturer,
      "device.manufacturer",
      256,
    );
    const model = parseOptionalText(device.model, "device.model", 256);
    const softwareVersion = parseOptionalText(
      device.softwareVersion,
      "device.softwareVersion",
      128,
    );
    const hardwareVersion = parseOptionalText(
      device.hardwareVersion,
      "device.hardwareVersion",
      128,
    );
    return Object.freeze({
      deviceId: parseIntegrationDeviceId(device.deviceId),
      name: parseBoundedText(device.name, "device.name", 256),
      ...(areaId === undefined ? {} : { areaId }),
      ...(manufacturer === undefined ? {} : { manufacturer }),
      ...(model === undefined ? {} : { model }),
      ...(softwareVersion === undefined ? {} : { softwareVersion }),
      ...(hardwareVersion === undefined ? {} : { hardwareVersion }),
    });
  });
  ensureUnique(
    devices.map((device) => device.deviceId),
    "deviceId",
    "integration topology",
  );
  const deviceIds = new Set(devices.map((device) => device.deviceId));

  const entities = input.entities.map<IntegrationEntity>((entity) => {
    const deviceId =
      entity.deviceId === undefined
        ? undefined
        : parseIntegrationDeviceId(entity.deviceId);
    const areaId =
      entity.areaId === undefined
        ? undefined
        : parseIntegrationAreaId(entity.areaId);
    requireBoundedArray(
      entity.points,
      "entity.points",
      maximumPointsPerEntity,
      false,
    );
    const points = entity.points.map<IntegrationEntityPointDescriptor>(
      (point) => {
        const unit = parseOptionalUnit(point.unit, "point.unit", 32);
        return Object.freeze({
          pointKey: parseIntegrationPointKey(point.pointKey),
          title: parseBoundedText(point.title, "point.title", 256),
          kind: parsePointKind(point.kind),
          valueType: parseValueType(point.valueType),
          ...(unit === undefined ? {} : { unit }),
        });
      },
    );
    ensureUnique(
      points.map((point) => point.pointKey),
      "pointKey",
      `entity ${entity.entityId}`,
    );
    return Object.freeze({
      entityId: parseIntegrationEntityId(entity.entityId),
      sourceAddress: parseIdentifier(
        entity.sourceAddress,
        "entity.sourceAddress",
      ),
      name: parseBoundedText(entity.name, "entity.name", 256),
      entityKind: parseIntegrationEntityKind(entity.entityKind),
      ...(deviceId === undefined ? {} : { deviceId }),
      ...(areaId === undefined ? {} : { areaId }),
      points: Object.freeze(points),
    });
  });
  ensureUnique(
    entities.map((entity) => entity.entityId),
    "entityId",
    "integration topology",
  );
  ensureUnique(
    entities.map((entity) => entity.sourceAddress),
    "sourceAddress",
    "integration topology",
  );
  for (const device of devices) {
    if (device.areaId !== undefined && !areaIds.has(device.areaId)) {
      invalid("device.areaId", "device references an unknown area");
    }
  }
  for (const entity of entities) {
    if (entity.deviceId !== undefined && !deviceIds.has(entity.deviceId)) {
      invalid("entity.deviceId", "entity references an unknown device");
    }
    if (entity.areaId !== undefined && !areaIds.has(entity.areaId)) {
      invalid("entity.areaId", "entity references an unknown area");
    }
  }

  return Object.freeze({
    schema: INTEGRATION_TOPOLOGY_SCHEMA,
    integrationId: parseIntegrationId(input.integrationId),
    integrationKind: parseIntegrationKind(input.integrationKind),
    snapshotGeneration: parseIntegrationSnapshotGeneration(
      input.snapshotGeneration,
    ),
    observedAtMs: parseIntegrationObservedAtMs(input.observedAtMs),
    areas: Object.freeze(areas),
    devices: Object.freeze(devices),
    entities: Object.freeze(entities),
  });
}

export function defineIntegrationObservationBatch(
  input: IntegrationObservationBatchInput,
  topology: IntegrationTopologySnapshot,
): IntegrationObservationBatch {
  if (input.schema !== INTEGRATION_OBSERVATION_SCHEMA) {
    invalid("schema", "integration observation schema is unsupported");
  }
  const integrationId = parseIntegrationId(input.integrationId);
  const snapshotGeneration = parseIntegrationSnapshotGeneration(
    input.snapshotGeneration,
  );
  if (integrationId !== topology.integrationId) {
    invalid(
      "integrationId",
      "observation batch integration does not match topology",
    );
  }
  if (snapshotGeneration !== topology.snapshotGeneration) {
    invalid(
      "snapshotGeneration",
      "observation batch generation does not match topology",
    );
  }
  requireBoundedArray(
    input.observations,
    "observations",
    maximumObservations,
    false,
  );
  const points = new Map<
    string,
    Readonly<{ valueType: IntegrationValueType }>
  >();
  for (const entity of topology.entities) {
    for (const point of entity.points) {
      points.set(`${entity.entityId}\u0000${point.pointKey}`, point);
    }
  }
  const observations = input.observations.map<IntegrationObservation>(
    (observation) => {
      const entityId = parseIntegrationEntityId(observation.entityId);
      const pointKey = parseIntegrationPointKey(observation.pointKey);
      const identity = `${entityId}\u0000${pointKey}`;
      const point = points.get(identity);
      if (point === undefined) {
        invalid(
          "observations",
          "observation references an unknown entity point",
        );
      }
      const quality = parseQuality(observation.quality);
      const requiresValue = quality === "good" || quality === "uncertain";
      if (requiresValue !== (observation.value !== undefined)) {
        invalid(
          "observation.value",
          "good and uncertain observations require a value; bad and unavailable observations forbid it",
        );
      }
      const value =
        observation.value === undefined
          ? undefined
          : defineObservedValue(observation.value);
      if (value !== undefined && value.type !== point.valueType) {
        invalid(
          "observation.value",
          "observation value type does not match the topology point",
        );
      }
      const diagnostic = parseOptionalText(
        observation.diagnostic,
        "observation.diagnostic",
        512,
      );
      return Object.freeze({
        entityId,
        pointKey,
        observedAtMs: parseIntegrationObservedAtMs(observation.observedAtMs),
        quality,
        ...(value === undefined ? {} : { value }),
        ...(diagnostic === undefined ? {} : { diagnostic }),
      });
    },
  );

  return Object.freeze({
    schema: INTEGRATION_OBSERVATION_SCHEMA,
    integrationId,
    snapshotGeneration,
    batchId: parseIntegrationBatchId(input.batchId),
    observedAtMs: parseIntegrationObservedAtMs(input.observedAtMs),
    observations: Object.freeze(observations),
  });
}
