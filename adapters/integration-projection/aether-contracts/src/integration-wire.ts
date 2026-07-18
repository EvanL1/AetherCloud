import {
  InvalidDomainValueError,
  defineIntegrationObservationBatch,
  defineIntegrationTopologySnapshot,
} from "@aether-cloud/domain";
import type {
  IntegrationAreaInput,
  IntegrationDeviceInput,
  IntegrationEntityInput,
  IntegrationEntityPointDescriptorInput,
  IntegrationObservationBatch,
  IntegrationObservationBatchInput,
  IntegrationObservationInput,
  IntegrationObservationQuality,
  IntegrationObservedValue,
  IntegrationPointKind,
  IntegrationTopologySnapshot,
  IntegrationTopologySnapshotInput,
  IntegrationValueType,
} from "@aether-cloud/domain";
import type { GatewayCredentialAssertion } from "@aether-cloud/application";

import {
  decodeStrictJson,
  type StrictJsonBudgetOverrides,
  type StrictJsonFailureCode,
  type StrictJsonInput,
} from "./strict-json.js";

export const AETHER_CONTRACTS_INTEGRATION_CANDIDATE_VERSION =
  "0.1.0-alpha.4" as const;
export const AETHER_CONTRACTS_INTEGRATION_PUBLICATION_STATUS =
  "candidate-unpublished" as const;

export type IntegrationWireFailureCode =
  | StrictJsonFailureCode
  | "FIELD_TYPE"
  | "IDENTITY_CONFLICT"
  | "INTEGER_NON_CANONICAL"
  | "INTEGER_OUT_OF_RANGE"
  | "OBSERVATION_VALUE_INVALID"
  | "REFERENCE_NOT_FOUND"
  | "REQUIRED_FIELD_MISSING"
  | "SCHEMA_UNSUPPORTED"
  | "TEXT_INVALID"
  | "UNKNOWN_FIELD"
  | "VALUE_ENCODING_INVALID"
  | "VALUE_TYPE_MISMATCH";

export class IntegrationWireError extends Error {
  readonly code: IntegrationWireFailureCode;
  readonly path: string | undefined;

  constructor(
    code: IntegrationWireFailureCode,
    message: string,
    path?: string,
  ) {
    super(message);
    this.name = "IntegrationWireError";
    this.code = code;
    this.path = path;
  }
}

export interface IntegrationTopologyEnvelope {
  readonly credential: GatewayCredentialAssertion;
  readonly payload: IntegrationTopologySnapshot;
}

export interface IntegrationObservationEnvelope {
  readonly credential: GatewayCredentialAssertion;
  readonly payload: IntegrationObservationBatchInput;
}

export type ReportIntegrationTopologyWireInput =
  IntegrationTopologySnapshotInput &
    Readonly<{ credential: GatewayCredentialAssertion }>;

export type ReportIntegrationObservationsWireInput =
  IntegrationObservationBatchInput &
    Readonly<{ credential: GatewayCredentialAssertion }>;

const topologySchema = "aether.integration.topology-snapshot.v1alpha1" as const;
const observationSchema =
  "aether.integration.observation-batch.v1alpha1" as const;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const signedIntegerPattern = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const unsignedIntegerPattern = /^(?:0|[1-9][0-9]*)$/;
const decimalPattern = /^(?:0|-?[1-9][0-9]*|-?(?:0|[1-9][0-9]*)\.[0-9]*[1-9])$/;
const base64UrlPattern =
  /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-][AQgw]|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048])?$/;
const maximumUint64 = 18_446_744_073_709_551_615n;
const minimumInt64 = -9_223_372_036_854_775_808n;
const maximumInt64 = 9_223_372_036_854_775_807n;
const utf8Encoder = new TextEncoder();

function wireFailure(
  code: IntegrationWireFailureCode,
  message: string,
  path?: string,
): never {
  throw new IntegrationWireError(code, message, path);
}

function requireRecord(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return wireFailure("FIELD_TYPE", `${path} must be an object`, path);
  }
  return input as Record<string, unknown>;
}

function requireClosedObject(
  input: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): Record<string, unknown> {
  const record = requireRecord(input, path);
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    return wireFailure(
      "UNKNOWN_FIELD",
      `${path} contains an unknown field`,
      path,
    );
  }
  if (required.some((key) => !Object.hasOwn(record, key))) {
    return wireFailure(
      "REQUIRED_FIELD_MISSING",
      `${path} is missing a required field`,
      path,
    );
  }
  return record;
}

function exceedsCodePointLimit(input: string, maximum: number): boolean {
  const iterator = input[Symbol.iterator]();
  let codePoints = 0;
  for (
    let current = iterator.next();
    !current.done;
    current = iterator.next()
  ) {
    codePoints += 1;
    if (codePoints > maximum) return true;
  }
  return false;
}

function exceedsUtf8ByteLimit(input: string, maximum: number): boolean {
  return utf8Encoder.encode(input).byteLength > maximum;
}

function requireString(
  input: unknown,
  path: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (typeof input !== "string") {
    return wireFailure("FIELD_TYPE", `${path} must be a string`, path);
  }
  if (
    exceedsCodePointLimit(input, maximum) ||
    (!allowEmpty && input.length === 0)
  ) {
    return wireFailure("FIELD_BOUND", `${path} is outside its bounds`, path);
  }
  return input;
}

function requireEvidenceText(
  input: unknown,
  path: string,
  maximum: number,
): string {
  const value = requireString(input, path, maximum);
  let containsControl = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      containsControl = true;
      break;
    }
  }
  if (value.trim().length === 0 || containsControl) {
    return wireFailure(
      "TEXT_INVALID",
      `${path} is not valid user-facing text`,
      path,
    );
  }
  return value;
}

function requireIdentifier(input: unknown, path: string): string {
  const value = requireString(input, path, 128);
  if (!identifierPattern.test(value)) {
    return wireFailure(
      "VALUE_ENCODING_INVALID",
      `${path} is not a canonical identifier`,
      path,
    );
  }
  return value;
}

function requireArray(
  input: unknown,
  path: string,
  maximum: number,
  allowEmpty: boolean,
): readonly unknown[] {
  if (!Array.isArray(input)) {
    return wireFailure("FIELD_TYPE", `${path} must be an array`, path);
  }
  if (input.length > maximum || (!allowEmpty && input.length === 0)) {
    return wireFailure("FIELD_BOUND", `${path} is outside its bounds`, path);
  }
  return input;
}

function requireUint64(input: unknown, path: string): string {
  if (typeof input !== "string") {
    return wireFailure("FIELD_TYPE", `${path} must be a string`, path);
  }
  if (exceedsUtf8ByteLimit(input, 20)) {
    return wireFailure(
      "INTEGER_OUT_OF_RANGE",
      `${path} is not a canonical uint64`,
      path,
    );
  }
  if (!unsignedIntegerPattern.test(input)) {
    return wireFailure(
      "INTEGER_NON_CANONICAL",
      `${path} is not a canonical uint64`,
      path,
    );
  }
  if (BigInt(input) > maximumUint64) {
    return wireFailure(
      "INTEGER_OUT_OF_RANGE",
      `${path} is outside the uint64 range`,
      path,
    );
  }
  return input;
}

function requirePointKind(input: unknown, path: string): IntegrationPointKind {
  if (input !== "event" && input !== "status" && input !== "telemetry") {
    return wireFailure(
      "VALUE_ENCODING_INVALID",
      `${path} is not a supported point kind`,
      path,
    );
  }
  return input;
}

function requireValueType(input: unknown, path: string): IntegrationValueType {
  if (
    input !== "boolean" &&
    input !== "bytes" &&
    input !== "decimal" &&
    input !== "float64" &&
    input !== "int64" &&
    input !== "string" &&
    input !== "uint64"
  ) {
    return wireFailure(
      "VALUE_ENCODING_INVALID",
      `${path} is not a supported value type`,
      path,
    );
  }
  return input;
}

function requireQuality(
  input: unknown,
  path: string,
): IntegrationObservationQuality {
  if (
    input !== "bad" &&
    input !== "good" &&
    input !== "uncertain" &&
    input !== "unavailable"
  ) {
    return wireFailure(
      "VALUE_ENCODING_INVALID",
      `${path} is not a supported quality`,
      path,
    );
  }
  return input;
}

function decodeArea(input: unknown, index: number): IntegrationAreaInput {
  const path = `payload.areas[${String(index)}]`;
  const record = requireClosedObject(input, ["area_id", "name"], [], path);
  return {
    areaId: requireIdentifier(record.area_id, `${path}.area_id`),
    name: requireEvidenceText(record.name, `${path}.name`, 256),
  };
}

function decodeDevice(input: unknown, index: number): IntegrationDeviceInput {
  const path = `payload.devices[${String(index)}]`;
  const record = requireClosedObject(
    input,
    ["device_id", "name"],
    [
      "area_id",
      "hardware_version",
      "manufacturer",
      "model",
      "software_version",
    ],
    path,
  );
  return {
    deviceId: requireIdentifier(record.device_id, `${path}.device_id`),
    name: requireEvidenceText(record.name, `${path}.name`, 256),
    ...(record.area_id === undefined
      ? {}
      : { areaId: requireIdentifier(record.area_id, `${path}.area_id`) }),
    ...(record.manufacturer === undefined
      ? {}
      : {
          manufacturer: requireEvidenceText(
            record.manufacturer,
            `${path}.manufacturer`,
            256,
          ),
        }),
    ...(record.model === undefined
      ? {}
      : {
          model: requireEvidenceText(record.model, `${path}.model`, 256),
        }),
    ...(record.software_version === undefined
      ? {}
      : {
          softwareVersion: requireEvidenceText(
            record.software_version,
            `${path}.software_version`,
            128,
          ),
        }),
    ...(record.hardware_version === undefined
      ? {}
      : {
          hardwareVersion: requireEvidenceText(
            record.hardware_version,
            `${path}.hardware_version`,
            128,
          ),
        }),
  };
}

function decodePoint(
  input: unknown,
  entityIndex: number,
  pointIndex: number,
): IntegrationEntityPointDescriptorInput {
  const path = `payload.entities[${String(entityIndex)}].points[${String(pointIndex)}]`;
  const record = requireClosedObject(
    input,
    ["kind", "point_key", "title", "value_type"],
    ["unit"],
    path,
  );
  return {
    pointKey: requireIdentifier(record.point_key, `${path}.point_key`),
    title: requireEvidenceText(record.title, `${path}.title`, 256),
    kind: requirePointKind(record.kind, `${path}.kind`),
    valueType: requireValueType(record.value_type, `${path}.value_type`),
    ...(record.unit === undefined
      ? {}
      : { unit: requireString(record.unit, `${path}.unit`, 32) }),
  };
}

function decodeEntity(input: unknown, index: number): IntegrationEntityInput {
  const path = `payload.entities[${String(index)}]`;
  const record = requireClosedObject(
    input,
    ["entity_id", "entity_kind", "name", "points", "source_address"],
    ["area_id", "device_id"],
    path,
  );
  return {
    entityId: requireIdentifier(record.entity_id, `${path}.entity_id`),
    sourceAddress: requireIdentifier(
      record.source_address,
      `${path}.source_address`,
    ),
    name: requireEvidenceText(record.name, `${path}.name`, 256),
    entityKind: requireIdentifier(record.entity_kind, `${path}.entity_kind`),
    ...(record.device_id === undefined
      ? {}
      : {
          deviceId: requireIdentifier(record.device_id, `${path}.device_id`),
        }),
    ...(record.area_id === undefined
      ? {}
      : {
          areaId: requireIdentifier(record.area_id, `${path}.area_id`),
        }),
    points: requireArray(record.points, `${path}.points`, 64, false).map(
      (point, pointIndex) => decodePoint(point, index, pointIndex),
    ),
  };
}

function mapDomainFailure(error: InvalidDomainValueError): never {
  const message = error.message;
  if (message.includes("duplicate")) {
    return wireFailure("IDENTITY_CONFLICT", "payload identities conflict");
  }
  if (
    message.includes("references an unknown") ||
    message.includes("unknown entity point") ||
    message.includes("does not match topology")
  ) {
    return wireFailure("REFERENCE_NOT_FOUND", "payload reference is unknown");
  }
  if (message.includes("value type does not match")) {
    return wireFailure(
      "VALUE_TYPE_MISMATCH",
      "observation value type does not match its point",
    );
  }
  if (message.includes("good and uncertain observations")) {
    return wireFailure(
      "OBSERVATION_VALUE_INVALID",
      "observation quality and value presence conflict",
    );
  }
  if (message.includes("canonical and in range")) {
    return wireFailure(
      "INTEGER_OUT_OF_RANGE",
      "integer observation value is outside its range",
    );
  }
  if (
    message.includes("canonical decimal") ||
    message.includes("canonical base64url")
  ) {
    return wireFailure(
      "VALUE_ENCODING_INVALID",
      "observation value encoding is invalid",
    );
  }
  if (
    message.includes("bounded") ||
    message.includes("too large") ||
    message.includes("one or more")
  ) {
    return wireFailure("FIELD_BOUND", "payload field is outside its bounds");
  }
  return wireFailure("FIELD_TYPE", "payload failed domain validation");
}

function defineTopology(
  input: IntegrationTopologySnapshotInput,
): IntegrationTopologySnapshot {
  try {
    return defineIntegrationTopologySnapshot(input);
  } catch (error: unknown) {
    if (error instanceof InvalidDomainValueError) {
      return mapDomainFailure(error);
    }
    throw error;
  }
}

function decodeTopologyValue(input: unknown): IntegrationTopologySnapshot {
  const record = requireClosedObject(
    input,
    [
      "areas",
      "devices",
      "entities",
      "integration_id",
      "integration_kind",
      "observed_at_ms",
      "schema",
      "snapshot_generation",
    ],
    [],
    "payload",
  );
  const schema = requireString(record.schema, "payload.schema", 128);
  if (schema !== topologySchema) {
    return wireFailure(
      "SCHEMA_UNSUPPORTED",
      "integration topology schema is unsupported",
      "payload.schema",
    );
  }
  return defineTopology({
    schema,
    integrationId: requireIdentifier(
      record.integration_id,
      "payload.integration_id",
    ),
    integrationKind: requireIdentifier(
      record.integration_kind,
      "payload.integration_kind",
    ),
    snapshotGeneration: requireUint64(
      record.snapshot_generation,
      "payload.snapshot_generation",
    ),
    observedAtMs: requireUint64(
      record.observed_at_ms,
      "payload.observed_at_ms",
    ),
    areas: requireArray(record.areas, "payload.areas", 4_096, true).map(
      decodeArea,
    ),
    devices: requireArray(record.devices, "payload.devices", 16_384, true).map(
      decodeDevice,
    ),
    entities: requireArray(
      record.entities,
      "payload.entities",
      65_536,
      true,
    ).map(decodeEntity),
  });
}

function decodeObservedValueValue(input: unknown): IntegrationObservedValue {
  const valueRecord = requireRecord(input, "observed_value");
  const type = requireString(valueRecord.type, "observed_value.type", 16);
  if (type === "bytes") {
    const record = requireClosedObject(
      valueRecord,
      ["encoding", "type", "value"],
      [],
      "observed_value",
    );
    if (record.encoding !== "base64url") {
      return wireFailure(
        "VALUE_ENCODING_INVALID",
        "bytes observation encoding is unsupported",
        "observed_value.encoding",
      );
    }
    const value = requireString(
      record.value,
      "observed_value.value",
      16_384,
      true,
    );
    if (!base64UrlPattern.test(value)) {
      return wireFailure(
        "VALUE_ENCODING_INVALID",
        "bytes observation value is not canonical base64url",
        "observed_value.value",
      );
    }
    return Object.freeze({ type, encoding: "base64url", value });
  }

  const record = requireClosedObject(
    valueRecord,
    ["type", "value"],
    [],
    "observed_value",
  );
  switch (type) {
    case "boolean":
      if (typeof record.value !== "boolean") {
        return wireFailure(
          "FIELD_TYPE",
          "boolean observation value must be a boolean",
          "observed_value.value",
        );
      }
      return Object.freeze({ type, value: record.value });
    case "int64": {
      if (typeof record.value !== "string") {
        return wireFailure(
          "FIELD_TYPE",
          "int64 observation value must be a string",
          "observed_value.value",
        );
      }
      if (exceedsUtf8ByteLimit(record.value, 20)) {
        return wireFailure(
          "INTEGER_OUT_OF_RANGE",
          "int64 observation value is outside its range",
          "observed_value.value",
        );
      }
      const value = record.value;
      if (!signedIntegerPattern.test(value)) {
        return wireFailure(
          "INTEGER_NON_CANONICAL",
          "int64 observation value is not canonical",
          "observed_value.value",
        );
      }
      if (BigInt(value) < minimumInt64 || BigInt(value) > maximumInt64) {
        return wireFailure(
          "INTEGER_OUT_OF_RANGE",
          "int64 observation value is outside its range",
          "observed_value.value",
        );
      }
      return Object.freeze({ type, value });
    }
    case "uint64": {
      if (typeof record.value !== "string") {
        return wireFailure(
          "FIELD_TYPE",
          "uint64 observation value must be a string",
          "observed_value.value",
        );
      }
      if (exceedsUtf8ByteLimit(record.value, 20)) {
        return wireFailure(
          "INTEGER_OUT_OF_RANGE",
          "uint64 observation value is outside its range",
          "observed_value.value",
        );
      }
      const value = record.value;
      if (!unsignedIntegerPattern.test(value)) {
        return wireFailure(
          "INTEGER_NON_CANONICAL",
          "uint64 observation value is not canonical",
          "observed_value.value",
        );
      }
      if (BigInt(value) > maximumUint64) {
        return wireFailure(
          "INTEGER_OUT_OF_RANGE",
          "uint64 observation value is outside its range",
          "observed_value.value",
        );
      }
      return Object.freeze({ type, value });
    }
    case "float64":
      if (typeof record.value !== "number" || !Number.isFinite(record.value)) {
        return wireFailure(
          "FIELD_TYPE",
          "float64 observation value must be finite",
          "observed_value.value",
        );
      }
      return Object.freeze({ type, value: record.value });
    case "decimal": {
      const value = requireString(record.value, "observed_value.value", 96);
      if (!decimalPattern.test(value)) {
        return wireFailure(
          "VALUE_ENCODING_INVALID",
          "decimal observation value is not canonical",
          "observed_value.value",
        );
      }
      return Object.freeze({ type, value });
    }
    case "string":
      return Object.freeze({
        type,
        value: requireString(record.value, "observed_value.value", 4_096, true),
      });
    default:
      return wireFailure(
        "VALUE_ENCODING_INVALID",
        "observed value type is unsupported",
        "observed_value.type",
      );
  }
}

function decodeObservation(
  input: unknown,
  index: number,
): IntegrationObservationInput {
  const path = `payload.observations[${String(index)}]`;
  const record = requireClosedObject(
    input,
    ["entity_id", "observed_at_ms", "point_key", "quality"],
    ["diagnostic", "value"],
    path,
  );
  return Object.freeze({
    entityId: requireIdentifier(record.entity_id, `${path}.entity_id`),
    pointKey: requireIdentifier(record.point_key, `${path}.point_key`),
    observedAtMs: requireUint64(
      record.observed_at_ms,
      `${path}.observed_at_ms`,
    ),
    quality: requireQuality(record.quality, `${path}.quality`),
    ...(record.value === undefined
      ? {}
      : { value: decodeObservedValueValue(record.value) }),
    ...(record.diagnostic === undefined
      ? {}
      : {
          diagnostic: requireEvidenceText(
            record.diagnostic,
            `${path}.diagnostic`,
            512,
          ),
        }),
  });
}

function decodeObservationInputValue(
  input: unknown,
): IntegrationObservationBatchInput {
  const record = requireClosedObject(
    input,
    [
      "batch_id",
      "integration_id",
      "observations",
      "observed_at_ms",
      "schema",
      "snapshot_generation",
    ],
    [],
    "payload",
  );
  const schema = requireString(record.schema, "payload.schema", 128);
  if (schema !== observationSchema) {
    return wireFailure(
      "SCHEMA_UNSUPPORTED",
      "integration observation schema is unsupported",
      "payload.schema",
    );
  }
  return Object.freeze({
    schema,
    integrationId: requireIdentifier(
      record.integration_id,
      "payload.integration_id",
    ),
    snapshotGeneration: requireUint64(
      record.snapshot_generation,
      "payload.snapshot_generation",
    ),
    batchId: requireIdentifier(record.batch_id, "payload.batch_id"),
    observedAtMs: requireUint64(
      record.observed_at_ms,
      "payload.observed_at_ms",
    ),
    observations: Object.freeze(
      requireArray(
        record.observations,
        "payload.observations",
        65_536,
        false,
      ).map(decodeObservation),
    ),
  });
}

function decodeObservationValue(
  input: unknown,
  topology: IntegrationTopologySnapshot,
): IntegrationObservationBatch {
  const batch = decodeObservationInputValue(input);
  try {
    return defineIntegrationObservationBatch(batch, topology);
  } catch (error: unknown) {
    if (error instanceof InvalidDomainValueError) {
      return mapDomainFailure(error);
    }
    throw error;
  }
}

function decodeCredential(input: unknown): GatewayCredentialAssertion {
  const record = requireClosedObject(
    input,
    ["credential_id", "proof"],
    [],
    "credential",
  );
  return Object.freeze({
    credentialId: requireString(
      record.credential_id,
      "credential.credential_id",
      256,
    ),
    proof: requireString(record.proof, "credential.proof", 4_096),
  });
}

function decodeEnvelope(
  input: StrictJsonInput,
  budgetOverrides: StrictJsonBudgetOverrides | undefined,
): Readonly<{
  credential: GatewayCredentialAssertion;
  payload: unknown;
}> {
  const record = requireClosedObject(
    decodeStrictJson(input, budgetOverrides),
    ["credential", "payload"],
    [],
    "envelope",
  );
  return Object.freeze({
    credential: decodeCredential(record.credential),
    payload: record.payload,
  });
}

export function decodeIntegrationTopologyPayload(
  input: StrictJsonInput,
  budgetOverrides?: StrictJsonBudgetOverrides,
): IntegrationTopologySnapshot {
  return decodeTopologyValue(decodeStrictJson(input, budgetOverrides));
}

export function decodeIntegrationObservationPayload(
  input: StrictJsonInput,
  topology: IntegrationTopologySnapshot,
  budgetOverrides?: StrictJsonBudgetOverrides,
): IntegrationObservationBatch {
  return decodeObservationValue(
    decodeStrictJson(input, budgetOverrides),
    topology,
  );
}

export function decodeIntegrationObservationPayloadInput(
  input: StrictJsonInput,
  budgetOverrides?: StrictJsonBudgetOverrides,
): IntegrationObservationBatchInput {
  return decodeObservationInputValue(decodeStrictJson(input, budgetOverrides));
}

export function decodeIntegrationObservedValue(
  input: StrictJsonInput,
  budgetOverrides?: StrictJsonBudgetOverrides,
): IntegrationObservedValue {
  return decodeObservedValueValue(decodeStrictJson(input, budgetOverrides));
}

export function decodeIntegrationTopologyEnvelope(
  input: StrictJsonInput,
  budgetOverrides?: StrictJsonBudgetOverrides,
): IntegrationTopologyEnvelope {
  const envelope = decodeEnvelope(input, budgetOverrides);
  return Object.freeze({
    credential: envelope.credential,
    payload: decodeTopologyValue(envelope.payload),
  });
}

export function decodeIntegrationObservationEnvelope(
  input: StrictJsonInput,
  budgetOverrides?: StrictJsonBudgetOverrides,
): IntegrationObservationEnvelope {
  const envelope = decodeEnvelope(input, budgetOverrides);
  return Object.freeze({
    credential: envelope.credential,
    payload: decodeObservationInputValue(envelope.payload),
  });
}

export function toReportIntegrationTopologyInput(
  envelope: IntegrationTopologyEnvelope,
): ReportIntegrationTopologyWireInput {
  return Object.freeze({
    credential: envelope.credential,
    ...envelope.payload,
  });
}

export function toReportIntegrationObservationsInput(
  envelope: IntegrationObservationEnvelope,
): ReportIntegrationObservationsWireInput {
  return Object.freeze({
    credential: envelope.credential,
    ...envelope.payload,
  });
}
