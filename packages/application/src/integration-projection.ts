import {
  InvalidDomainValueError,
  defineIntegrationObservationBatch,
  defineIntegrationTopologySnapshot,
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseIntegrationBatchId,
  parseIntegrationId,
  parseIntegrationSnapshotGeneration,
  parseProjectId,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";
import type {
  IntegrationAreaInput,
  IntegrationDeviceInput,
  IntegrationEntityInput,
  IntegrationEntityPointDescriptorInput,
  IntegrationObservation,
  IntegrationObservationBatchInput,
  IntegrationObservationInput,
  IntegrationObservationQuality,
  IntegrationObservedValue,
  IntegrationPointKind,
  IntegrationTopologySnapshotInput,
  IntegrationValueType,
  UtcInstant,
} from "@aether-cloud/domain";

import {
  GET_INTEGRATION_PROJECTION_QUERY,
  REPORT_INTEGRATION_OBSERVATIONS_COMMAND,
  REPORT_INTEGRATION_TOPOLOGY_COMMAND,
} from "./capability-definition.js";
import type {
  GatewayCredentialAssertion,
  GatewayCredentialVerifier,
} from "./cloudlink-session-repository.js";
import {
  isGatewaySignedCloudLinkUplinkAuthenticationFact,
  validateGatewaySignedCloudLinkAuthenticationConsumption,
  type CloudLinkBusinessPayloadDigestor,
  type GatewaySignedCloudLinkBusinessDelivery,
  type GatewaySignedCloudLinkUplinkAuthenticationFact,
} from "./cloudlink-uplink-authentication.js";
import type { ApplicationClock } from "./gateway-identity-repository.js";
import type {
  IntegrationPayloadDigestor,
  IntegrationCloudLinkDelivery,
  IntegrationCloudLinkDurableAcknowledgement,
  IntegrationCloudLinkMessageKind,
  IntegrationCloudLinkSessionFence,
  IntegrationObservationPersistenceReceipt,
  IntegrationProjectionRecord,
  IntegrationProjectionRepository,
  IntegrationProjectionScope,
  IntegrationTopologyPersistenceReceipt,
  IntegrationTopologyHistoryRecord,
} from "./integration-projection-repository.js";

type IntegrationProjectionFailureCode =
  | "command-expired"
  | "gateway-credential-inactive"
  | "integration-batch-conflict"
  | "integration-delivery-conflict"
  | "integration-delivery-gap"
  | "integration-generation-conflict"
  | "integration-idempotency-conflict"
  | "gateway-signed-authentication-invalid"
  | "integration-projection-not-found"
  | "integration-session-fenced"
  | "integration-stale-generation"
  | "integration-storage-unavailable"
  | "integration-stream-binding-conflict"
  | "integration-topology-required"
  | "invalid-gateway-credential"
  | "invalid-input"
  | "invalid-integration-repository-result"
  | "permission-denied";

export interface IntegrationProjectionFailure {
  readonly code: IntegrationProjectionFailureCode;
  readonly message: string;
}

export type IntegrationProjectionApplicationResult<Value> =
  | Readonly<{ ok: true; replayed: boolean; value: Value }>
  | Readonly<{ ok: false; failure: IntegrationProjectionFailure }>;

export type IntegrationProjectionQueryResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: IntegrationProjectionFailure }>;

export interface IntegrationProjectionView {
  readonly authority: "edge-reported-copy";
  readonly liveStateAuthoritative: false;
  readonly tenantId: IntegrationProjectionRecord["tenantId"];
  readonly projectId: IntegrationProjectionRecord["projectId"];
  readonly gatewayId: IntegrationProjectionRecord["gatewayId"];
  readonly integrationId: IntegrationProjectionRecord["integrationId"];
  readonly topology: IntegrationProjectionRecord["topology"];
  readonly topologyDigest: string;
  readonly latestObservations: readonly IntegrationObservation[];
  readonly receivedAt: UtcInstant;
  readonly revision: number;
}

export interface ReportIntegrationProjectionValue {
  readonly disposition: "persisted" | "replayed";
  readonly projection: IntegrationProjectionView;
  readonly receipt:
    | IntegrationObservationPersistenceReceipt
    | IntegrationTopologyPersistenceReceipt;
  readonly durableAcknowledgement?: IntegrationCloudLinkDurableAcknowledgement;
}

interface CommandContext {
  readonly requestId: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

interface QueryContext {
  readonly tenantId: ReturnType<typeof parseTenantId>;
  readonly projectId: ReturnType<typeof parseProjectId>;
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
}

type IntegrationReportAuthentication =
  | Readonly<{
      kind: "credential";
      credential: GatewayCredentialAssertion;
    }>
  | Readonly<{
      kind: "gateway-signed";
      fact: GatewaySignedCloudLinkUplinkAuthenticationFact;
    }>;

interface DecodedTopologyReport {
  readonly authentication: IntegrationReportAuthentication;
  readonly topology: ReturnType<typeof defineIntegrationTopologySnapshot>;
  readonly cloudLinkDelivery?: IntegrationCloudLinkDelivery;
  readonly cloudLinkPayload?: Readonly<Record<string, unknown>>;
}

interface DecodedObservationReport {
  readonly authentication: IntegrationReportAuthentication;
  readonly batch: IntegrationObservationBatchInput;
  readonly cloudLinkDelivery?: IntegrationCloudLinkDelivery;
  readonly cloudLinkPayload?: Readonly<Record<string, unknown>>;
}

class IntegrationProjectionInputError extends Error {}

const sha256Pattern = /^[0-9a-f]{64}$/;
const cloudLinkDigestPattern = /^sha256:[0-9a-f]{64}$/;
const canonicalUint64Pattern = /^(?:0|[1-9][0-9]*)$/;
const maximumUint64 = 18_446_744_073_709_551_615n;

function failure(
  code: IntegrationProjectionFailureCode,
  message: string,
): Readonly<{ ok: false; failure: IntegrationProjectionFailure }> {
  return { ok: false, failure: { code, message } };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function hasExpectedSigningProjectionSchema(input: unknown): boolean {
  return (
    isRecord(input) &&
    input.schema === "aether.cloudlink.uplink-signing.v1alpha1"
  );
}

function requireRecord(input: unknown, field: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new IntegrationProjectionInputError(`${field} must be an object`);
  }
  return input;
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new IntegrationProjectionInputError(
      `${field} contains unknown or missing fields`,
    );
  }
}

function keysWithOptional(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): readonly string[] {
  return [...required, ...optional.filter((key) => record[key] !== undefined)];
}

function exceedsCodePointLimit(input: string, maximum: number): boolean {
  let count = 0;
  for (const character of input) {
    if (character.codePointAt(0) !== undefined) count += 1;
    if (count > maximum) return true;
  }
  return false;
}

function requireString(input: unknown, field: string, maximum = 8_192): string {
  if (typeof input !== "string" || exceedsCodePointLimit(input, maximum)) {
    throw new IntegrationProjectionInputError(`${field} must be bounded text`);
  }
  return input;
}

function requireNonEmptyString(
  input: unknown,
  field: string,
  maximum = 512,
): string {
  const value = requireString(input, field, maximum);
  if (value.trim().length === 0) {
    throw new IntegrationProjectionInputError(
      `${field} must be non-empty text`,
    );
  }
  return value;
}

function requireArray(
  input: unknown,
  field: string,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(input) || input.length > maximum) {
    throw new IntegrationProjectionInputError(
      `${field} must be a bounded array`,
    );
  }
  return input;
}

function decodeCredential(input: unknown): GatewayCredentialAssertion {
  const record = requireRecord(input, "credential");
  requireExactKeys(record, ["credentialId", "proof"], "credential");
  return {
    credentialId: requireNonEmptyString(
      record.credentialId,
      "credentialId",
      256,
    ),
    proof: requireNonEmptyString(record.proof, "credential proof", 4_096),
  };
}

function decodeCommandContext(input: unknown): CommandContext {
  const record = requireRecord(input, "command context");
  requireExactKeys(
    record,
    ["expiresAt", "idempotencyKey", "issuedAt"],
    "command context",
  );
  const requestId = requireNonEmptyString(
    record.idempotencyKey,
    "idempotencyKey",
    128,
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(requestId)) {
    throw new IntegrationProjectionInputError(
      "idempotencyKey must be an opaque 8-128 character identifier",
    );
  }
  return {
    requestId,
    issuedAt: parseUtcInstant(record.issuedAt),
    expiresAt: parseUtcInstant(record.expiresAt),
  };
}

function decodePermissions(input: unknown): ReadonlySet<string> {
  if (
    !Array.isArray(input) ||
    input.some((permission) => typeof permission !== "string")
  ) {
    throw new IntegrationProjectionInputError(
      "permissions must be an array of strings",
    );
  }
  if (input.length > 256) {
    throw new IntegrationProjectionInputError(
      "permissions must be a bounded array",
    );
  }
  return new Set(input);
}

function decodeQueryContext(input: unknown): QueryContext {
  const record = requireRecord(input, "query context");
  requireExactKeys(
    record,
    ["permissions", "projectId", "subjectId", "tenantId"],
    "query context",
  );
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
    subjectId: requireNonEmptyString(record.subjectId, "subjectId", 128),
    permissions: decodePermissions(record.permissions),
  };
}

function decodeArea(input: unknown): IntegrationAreaInput {
  const record = requireRecord(input, "area");
  requireExactKeys(record, ["areaId", "name"], "area");
  return {
    areaId: requireString(record.areaId, "areaId", 128),
    name: requireString(record.name, "area name", 256),
  };
}

function decodeDevice(input: unknown): IntegrationDeviceInput {
  const record = requireRecord(input, "device");
  requireExactKeys(
    record,
    keysWithOptional(
      record,
      ["deviceId", "name"],
      ["areaId", "hardwareVersion", "manufacturer", "model", "softwareVersion"],
    ),
    "device",
  );
  return {
    deviceId: requireString(record.deviceId, "deviceId", 128),
    name: requireString(record.name, "device name", 256),
    ...(record.areaId === undefined
      ? {}
      : { areaId: requireString(record.areaId, "device areaId", 128) }),
    ...(record.manufacturer === undefined
      ? {}
      : {
          manufacturer: requireString(
            record.manufacturer,
            "device manufacturer",
            256,
          ),
        }),
    ...(record.model === undefined
      ? {}
      : { model: requireString(record.model, "device model", 256) }),
    ...(record.softwareVersion === undefined
      ? {}
      : {
          softwareVersion: requireString(
            record.softwareVersion,
            "device softwareVersion",
            128,
          ),
        }),
    ...(record.hardwareVersion === undefined
      ? {}
      : {
          hardwareVersion: requireString(
            record.hardwareVersion,
            "device hardwareVersion",
            128,
          ),
        }),
  };
}

function decodePointKind(input: unknown): IntegrationPointKind {
  if (input !== "event" && input !== "status" && input !== "telemetry") {
    throw new IntegrationProjectionInputError("point kind is unsupported");
  }
  return input;
}

function decodeValueType(input: unknown): IntegrationValueType {
  if (
    input !== "boolean" &&
    input !== "bytes" &&
    input !== "decimal" &&
    input !== "float64" &&
    input !== "int64" &&
    input !== "string" &&
    input !== "uint64"
  ) {
    throw new IntegrationProjectionInputError(
      "point value type is unsupported",
    );
  }
  return input;
}

function decodePoint(input: unknown): IntegrationEntityPointDescriptorInput {
  const record = requireRecord(input, "entity point");
  requireExactKeys(
    record,
    keysWithOptional(
      record,
      ["kind", "pointKey", "title", "valueType"],
      ["unit"],
    ),
    "entity point",
  );
  return {
    pointKey: requireString(record.pointKey, "pointKey", 128),
    title: requireString(record.title, "point title", 256),
    kind: decodePointKind(record.kind),
    valueType: decodeValueType(record.valueType),
    ...(record.unit === undefined
      ? {}
      : { unit: requireString(record.unit, "point unit", 32) }),
  };
}

function decodeEntity(input: unknown): IntegrationEntityInput {
  const record = requireRecord(input, "entity");
  requireExactKeys(
    record,
    keysWithOptional(
      record,
      ["entityId", "entityKind", "name", "points", "sourceAddress"],
      ["areaId", "deviceId"],
    ),
    "entity",
  );
  return {
    entityId: requireString(record.entityId, "entityId", 128),
    sourceAddress: requireString(
      record.sourceAddress,
      "entity sourceAddress",
      128,
    ),
    name: requireString(record.name, "entity name", 256),
    entityKind: requireString(record.entityKind, "entityKind", 128),
    ...(record.deviceId === undefined
      ? {}
      : { deviceId: requireString(record.deviceId, "entity deviceId", 128) }),
    ...(record.areaId === undefined
      ? {}
      : { areaId: requireString(record.areaId, "entity areaId", 128) }),
    points: requireArray(record.points, "entity points", 64).map(decodePoint),
  };
}

const topologyKeys = [
  "areas",
  "devices",
  "entities",
  "integrationId",
  "integrationKind",
  "observedAtMs",
  "schema",
  "snapshotGeneration",
] as const;

function decodeTopologyFields(
  record: Record<string, unknown>,
): IntegrationTopologySnapshotInput {
  return {
    schema: requireString(record.schema, "schema", 128),
    integrationId: requireString(record.integrationId, "integrationId", 128),
    integrationKind: requireString(
      record.integrationKind,
      "integrationKind",
      128,
    ),
    snapshotGeneration: requireString(
      record.snapshotGeneration,
      "snapshotGeneration",
      20,
    ),
    observedAtMs: requireString(record.observedAtMs, "observedAtMs", 20),
    areas: requireArray(record.areas, "areas", 4_096).map(decodeArea),
    devices: requireArray(record.devices, "devices", 16_384).map(decodeDevice),
    entities: requireArray(record.entities, "entities", 65_536).map(
      decodeEntity,
    ),
  };
}

function decodeWireTopologyFields(
  record: Record<string, unknown>,
): IntegrationTopologySnapshotInput {
  requireExactKeys(
    record,
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
    "CloudLink integration topology payload",
  );
  return {
    schema: requireString(record.schema, "schema", 128),
    integrationId: requireString(record.integration_id, "integration_id", 128),
    integrationKind: requireString(
      record.integration_kind,
      "integration_kind",
      128,
    ),
    snapshotGeneration: requireString(
      record.snapshot_generation,
      "snapshot_generation",
      20,
    ),
    observedAtMs: requireString(record.observed_at_ms, "observed_at_ms", 20),
    areas: requireArray(record.areas, "areas", 4_096).map((input) => {
      const area = requireRecord(input, "area");
      requireExactKeys(area, ["area_id", "name"], "area");
      return {
        areaId: requireString(area.area_id, "area_id", 128),
        name: requireString(area.name, "area name", 256),
      };
    }),
    devices: requireArray(record.devices, "devices", 16_384).map((input) => {
      const device = requireRecord(input, "device");
      requireExactKeys(
        device,
        keysWithOptional(
          device,
          ["device_id", "name"],
          [
            "area_id",
            "hardware_version",
            "manufacturer",
            "model",
            "software_version",
          ],
        ),
        "device",
      );
      return {
        deviceId: requireString(device.device_id, "device_id", 128),
        name: requireString(device.name, "device name", 256),
        ...(device.area_id === undefined
          ? {}
          : { areaId: requireString(device.area_id, "area_id", 128) }),
        ...(device.manufacturer === undefined
          ? {}
          : {
              manufacturer: requireString(
                device.manufacturer,
                "manufacturer",
                256,
              ),
            }),
        ...(device.model === undefined
          ? {}
          : { model: requireString(device.model, "model", 256) }),
        ...(device.software_version === undefined
          ? {}
          : {
              softwareVersion: requireString(
                device.software_version,
                "software_version",
                128,
              ),
            }),
        ...(device.hardware_version === undefined
          ? {}
          : {
              hardwareVersion: requireString(
                device.hardware_version,
                "hardware_version",
                128,
              ),
            }),
      };
    }),
    entities: requireArray(record.entities, "entities", 65_536).map((input) => {
      const entity = requireRecord(input, "entity");
      requireExactKeys(
        entity,
        keysWithOptional(
          entity,
          ["entity_id", "entity_kind", "name", "points", "source_address"],
          ["area_id", "device_id"],
        ),
        "entity",
      );
      return {
        entityId: requireString(entity.entity_id, "entity_id", 128),
        sourceAddress: requireString(
          entity.source_address,
          "source_address",
          128,
        ),
        name: requireString(entity.name, "entity name", 256),
        entityKind: requireString(entity.entity_kind, "entity_kind", 128),
        ...(entity.device_id === undefined
          ? {}
          : {
              deviceId: requireString(entity.device_id, "device_id", 128),
            }),
        ...(entity.area_id === undefined
          ? {}
          : { areaId: requireString(entity.area_id, "area_id", 128) }),
        points: requireArray(entity.points, "entity points", 64).map(
          (input) => {
            const point = requireRecord(input, "entity point");
            requireExactKeys(
              point,
              keysWithOptional(
                point,
                ["kind", "point_key", "title", "value_type"],
                ["unit"],
              ),
              "entity point",
            );
            return {
              pointKey: requireString(point.point_key, "point_key", 128),
              title: requireString(point.title, "point title", 256),
              kind: decodePointKind(point.kind),
              valueType: decodeValueType(point.value_type),
              ...(point.unit === undefined
                ? {}
                : { unit: requireString(point.unit, "point unit", 32) }),
            };
          },
        ),
      };
    }),
  };
}

function decodeCloudLinkDelivery(
  input: unknown,
  expectedKind: IntegrationCloudLinkMessageKind,
  expectedBatchId: string,
): IntegrationCloudLinkDelivery {
  const record = requireRecord(input, "CloudLink delivery");
  requireExactKeys(
    record,
    keysWithOptional(
      record,
      [
        "batchId",
        "credentialGeneration",
        "digest",
        "messageKind",
        "position",
        "sessionEpoch",
        "sessionId",
        "streamEpoch",
        "streamId",
      ],
      ["expiresAtMs", "sentAtMs"],
    ),
    "CloudLink delivery",
  );
  const sessionEpoch = parseCloudLinkSessionEpoch(record.sessionEpoch);
  const credentialGeneration = parseGatewayCredentialGeneration(
    record.credentialGeneration,
  );
  const position = parseStreamPosition(record.position);
  const batchId = requireNonEmptyString(
    record.batchId,
    "CloudLink delivery batchId",
    128,
  );
  const digest = requireString(record.digest, "CloudLink delivery digest", 71);
  const sentAtMs =
    record.sentAtMs === undefined
      ? undefined
      : requireString(record.sentAtMs, "CloudLink delivery sentAtMs", 20);
  const expiresAtMs =
    record.expiresAtMs === undefined
      ? undefined
      : record.expiresAtMs === null
        ? null
        : requireString(
            record.expiresAtMs,
            "CloudLink delivery expiresAtMs",
            20,
          );
  if (
    record.messageKind !== expectedKind ||
    batchId !== expectedBatchId ||
    sessionEpoch === "0" ||
    credentialGeneration === "0" ||
    position === "0" ||
    !cloudLinkDigestPattern.test(digest) ||
    (sentAtMs !== undefined &&
      (!canonicalUint64Pattern.test(sentAtMs) ||
        BigInt(sentAtMs) > maximumUint64)) ||
    (typeof expiresAtMs === "string" &&
      (!canonicalUint64Pattern.test(expiresAtMs) ||
        BigInt(expiresAtMs) > maximumUint64 ||
        (sentAtMs !== undefined && BigInt(expiresAtMs) < BigInt(sentAtMs))))
  ) {
    throw new IntegrationProjectionInputError(
      "CloudLink delivery does not match the Integration report",
    );
  }
  return Object.freeze({
    ...(sentAtMs === undefined ? {} : { sentAtMs }),
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    sessionId: parseCloudLinkSessionId(record.sessionId),
    sessionEpoch,
    credentialGeneration,
    streamId: parseStreamId(record.streamId),
    streamEpoch: parseStreamEpoch(record.streamEpoch),
    position,
    batchId,
    digest,
    messageKind: expectedKind,
  });
}

function projectionMatchesDelivery(
  fact: GatewaySignedCloudLinkUplinkAuthenticationFact,
  delivery: IntegrationCloudLinkDelivery,
  expectedKind: IntegrationCloudLinkMessageKind,
): boolean {
  const projection = fact.signingProjection;
  return (
    fact.messageKind === expectedKind &&
    hasExpectedSigningProjectionSchema(projection) &&
    projection.gateway_id === fact.gatewayId &&
    projection.credential_generation === fact.credentialGeneration &&
    projection.session_id === fact.sessionId &&
    projection.session_epoch === fact.sessionEpoch &&
    projection.message_kind === expectedKind &&
    projection.sent_at_ms === delivery.sentAtMs &&
    projection.expires_at_ms === delivery.expiresAtMs &&
    projection.stream_id === delivery.streamId &&
    projection.stream_epoch === delivery.streamEpoch &&
    projection.position === delivery.position &&
    projection.batch_id === delivery.batchId &&
    projection.business_digest === delivery.digest &&
    fact.sessionId === delivery.sessionId &&
    fact.sessionEpoch === delivery.sessionEpoch &&
    fact.credentialGeneration === delivery.credentialGeneration
  );
}

function sessionFenceFromAuthentication(
  authentication: IntegrationReportAuthentication,
): IntegrationCloudLinkSessionFence | undefined {
  if (authentication.kind !== "gateway-signed") return undefined;
  const fact = authentication.fact;
  return Object.freeze({
    tenantId: fact.tenantId,
    projectId: fact.projectId,
    gatewayId: fact.gatewayId,
    sessionId: fact.sessionId,
    sessionEpoch: fact.sessionEpoch,
    sessionRevision: fact.sessionRevision,
    credentialGeneration: fact.credentialGeneration,
    gatewayKeyId: fact.gatewayKeyId,
  });
}

function decodeReportAuthentication(
  record: Record<string, unknown>,
  delivery: IntegrationCloudLinkDelivery | undefined,
  expectedKind: IntegrationCloudLinkMessageKind,
): IntegrationReportAuthentication {
  const hasCredential = record.credential !== undefined;
  const hasGatewaySigned = record.gatewaySignedAuthentication !== undefined;
  if (hasCredential === hasGatewaySigned) {
    throw new IntegrationProjectionInputError(
      "Integration report requires exactly one authenticated Gateway origin",
    );
  }
  if (hasCredential) {
    return {
      kind: "credential",
      credential: decodeCredential(record.credential),
    };
  }
  const fact = record.gatewaySignedAuthentication;
  if (
    delivery === undefined ||
    !isGatewaySignedCloudLinkUplinkAuthenticationFact(fact) ||
    !projectionMatchesDelivery(fact, delivery, expectedKind)
  ) {
    throw new IntegrationProjectionInputError(
      "Gateway-signed Integration authentication does not match delivery",
    );
  }
  return { kind: "gateway-signed", fact };
}

function decodeTopologyReport(input: unknown): DecodedTopologyReport {
  const record = requireRecord(input, "integration topology report");
  if (record.gatewaySignedAuthentication !== undefined) {
    requireExactKeys(
      record,
      ["cloudLinkDelivery", "cloudLinkPayload", "gatewaySignedAuthentication"],
      "Gateway-signed integration topology report",
    );
    const payload = requireRecord(
      record.cloudLinkPayload,
      "CloudLink integration topology payload",
    );
    const topology = defineIntegrationTopologySnapshot(
      decodeWireTopologyFields(payload),
    );
    const cloudLinkDelivery = decodeCloudLinkDelivery(
      record.cloudLinkDelivery,
      "integration-topology-snapshot",
      `topology-${topology.snapshotGeneration}`,
    );
    return {
      authentication: decodeReportAuthentication(
        record,
        cloudLinkDelivery,
        "integration-topology-snapshot",
      ),
      topology,
      cloudLinkDelivery,
      cloudLinkPayload: Object.freeze({ ...payload }),
    };
  }
  requireExactKeys(
    record,
    keysWithOptional(
      record,
      [...topologyKeys, "credential"],
      ["cloudLinkDelivery"],
    ),
    "integration topology report",
  );
  const topology = defineIntegrationTopologySnapshot(
    decodeTopologyFields(record),
  );
  const cloudLinkDelivery =
    record.cloudLinkDelivery === undefined
      ? undefined
      : decodeCloudLinkDelivery(
          record.cloudLinkDelivery,
          "integration-topology-snapshot",
          `topology-${topology.snapshotGeneration}`,
        );
  return {
    authentication: decodeReportAuthentication(
      record,
      cloudLinkDelivery,
      "integration-topology-snapshot",
    ),
    topology,
    ...(cloudLinkDelivery === undefined ? {} : { cloudLinkDelivery }),
  };
}

function decodeQuality(input: unknown): IntegrationObservationQuality {
  if (
    input !== "bad" &&
    input !== "good" &&
    input !== "uncertain" &&
    input !== "unavailable"
  ) {
    throw new IntegrationProjectionInputError(
      "observation quality is unsupported",
    );
  }
  return input;
}

function decodeObservedValue(input: unknown): IntegrationObservedValue {
  const record = requireRecord(input, "observed value");
  if (record.type === "bytes") {
    requireExactKeys(record, ["encoding", "type", "value"], "observed value");
    if (record.encoding !== "base64url") {
      throw new IntegrationProjectionInputError(
        "bytes observation encoding is unsupported",
      );
    }
    return {
      type: "bytes",
      encoding: record.encoding,
      value: requireString(record.value, "bytes value", 16_384),
    };
  }
  requireExactKeys(record, ["type", "value"], "observed value");
  switch (record.type) {
    case "boolean":
      if (typeof record.value !== "boolean") {
        throw new IntegrationProjectionInputError(
          "boolean observation value is invalid",
        );
      }
      return { type: record.type, value: record.value };
    case "decimal":
    case "int64":
    case "uint64":
      return {
        type: record.type,
        value: requireString(record.value, `${record.type} value`, 96),
      };
    case "float64":
      if (typeof record.value !== "number") {
        throw new IntegrationProjectionInputError(
          "float64 observation value is invalid",
        );
      }
      return { type: record.type, value: record.value };
    case "string":
      return {
        type: record.type,
        value: requireString(record.value, "string value", 4_096),
      };
    default:
      throw new IntegrationProjectionInputError(
        "observation value type is unsupported",
      );
  }
}

function decodeObservation(input: unknown): IntegrationObservationInput {
  const record = requireRecord(input, "observation");
  requireExactKeys(
    record,
    keysWithOptional(
      record,
      ["entityId", "observedAtMs", "pointKey", "quality"],
      ["diagnostic", "value"],
    ),
    "observation",
  );
  return {
    entityId: requireString(record.entityId, "observation entityId", 128),
    pointKey: requireString(record.pointKey, "observation pointKey", 128),
    observedAtMs: requireString(
      record.observedAtMs,
      "observation observedAtMs",
      20,
    ),
    quality: decodeQuality(record.quality),
    ...(record.value === undefined
      ? {}
      : { value: decodeObservedValue(record.value) }),
    ...(record.diagnostic === undefined
      ? {}
      : {
          diagnostic: requireString(
            record.diagnostic,
            "observation diagnostic",
            512,
          ),
        }),
  };
}

function decodeObservationReport(input: unknown): DecodedObservationReport {
  const record = requireRecord(input, "integration observation report");
  if (record.gatewaySignedAuthentication !== undefined) {
    requireExactKeys(
      record,
      ["cloudLinkDelivery", "cloudLinkPayload", "gatewaySignedAuthentication"],
      "Gateway-signed integration observation report",
    );
    const payload = requireRecord(
      record.cloudLinkPayload,
      "CloudLink integration observation payload",
    );
    const batchId = requireString(payload.batch_id, "batch_id", 128);
    const cloudLinkDelivery = decodeCloudLinkDelivery(
      record.cloudLinkDelivery,
      "integration-observation-batch",
      batchId,
    );
    return {
      authentication: decodeReportAuthentication(
        record,
        cloudLinkDelivery,
        "integration-observation-batch",
      ),
      batch: {
        schema: requireString(payload.schema, "schema", 128),
        integrationId: requireString(
          payload.integration_id,
          "integration_id",
          128,
        ),
        snapshotGeneration: requireString(
          payload.snapshot_generation,
          "snapshot_generation",
          20,
        ),
        batchId,
        observedAtMs: requireString(
          payload.observed_at_ms,
          "observed_at_ms",
          20,
        ),
        observations: requireArray(
          payload.observations,
          "observations",
          65_536,
        ).map((observation) => {
          const raw = requireRecord(observation, "observation");
          requireExactKeys(
            raw,
            keysWithOptional(
              raw,
              ["entity_id", "observed_at_ms", "point_key", "quality"],
              ["diagnostic", "value"],
            ),
            "observation",
          );
          return decodeObservation({
            entityId: raw.entity_id,
            pointKey: raw.point_key,
            observedAtMs: raw.observed_at_ms,
            quality: raw.quality,
            ...(raw.value === undefined ? {} : { value: raw.value }),
            ...(raw.diagnostic === undefined
              ? {}
              : { diagnostic: raw.diagnostic }),
          });
        }),
      },
      cloudLinkDelivery,
      cloudLinkPayload: Object.freeze({ ...payload }),
    };
  }
  requireExactKeys(
    record,
    keysWithOptional(
      record,
      [
        "batchId",
        "credential",
        "integrationId",
        "observations",
        "observedAtMs",
        "schema",
        "snapshotGeneration",
      ],
      ["cloudLinkDelivery"],
    ),
    "integration observation report",
  );
  const batchId = requireString(record.batchId, "batchId", 128);
  const cloudLinkDelivery =
    record.cloudLinkDelivery === undefined
      ? undefined
      : decodeCloudLinkDelivery(
          record.cloudLinkDelivery,
          "integration-observation-batch",
          batchId,
        );
  return {
    authentication: decodeReportAuthentication(
      record,
      cloudLinkDelivery,
      "integration-observation-batch",
    ),
    batch: {
      schema: requireString(record.schema, "schema", 128),
      integrationId: requireString(record.integrationId, "integrationId", 128),
      snapshotGeneration: requireString(
        record.snapshotGeneration,
        "snapshotGeneration",
        20,
      ),
      batchId,
      observedAtMs: requireString(record.observedAtMs, "observedAtMs", 20),
      observations: requireArray(
        record.observations,
        "observations",
        65_536,
      ).map(decodeObservation),
    },
    ...(cloudLinkDelivery === undefined ? {} : { cloudLinkDelivery }),
  };
}

function decodeSafely<Value>(
  operation: () => Value,
):
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: IntegrationProjectionFailure }> {
  try {
    return { ok: true, value: operation() };
  } catch (error: unknown) {
    if (
      error instanceof IntegrationProjectionInputError ||
      error instanceof InvalidDomainValueError
    ) {
      return {
        ok: false,
        failure: { code: "invalid-input", message: error.message },
      };
    }
    throw error;
  }
}

function validateCommandTime(
  context: CommandContext,
  now: UtcInstant,
): IntegrationProjectionFailure | undefined {
  if (context.expiresAt <= context.issuedAt || context.issuedAt > now) {
    return { code: "invalid-input", message: "command time window is invalid" };
  }
  return now >= context.expiresAt
    ? { code: "command-expired", message: "integration report has expired" }
    : undefined;
}

function validateProviderTimes(
  observedAtValues: readonly string[],
  now: UtcInstant,
): IntegrationProjectionFailure | undefined {
  const maximumAccepted = BigInt(Date.parse(now)) + 300_000n;
  return observedAtValues.some(
    (observedAtMs) => BigInt(observedAtMs) > maximumAccepted,
  )
    ? {
        code: "invalid-input",
        message: "provider timestamp exceeds the allowed future clock skew",
      }
    : undefined;
}

function projectionRecordTimesAreValid(
  record: IntegrationProjectionRecord,
  now: UtcInstant,
): boolean {
  return (
    record.receivedAt <= now &&
    validateProviderTimes(
      [
        record.topology.observedAtMs,
        ...record.latestObservations.map(
          (observation) => observation.observedAtMs,
        ),
      ],
      now,
    ) === undefined
  );
}

function projectionView(
  record: IntegrationProjectionRecord,
): IntegrationProjectionView {
  return Object.freeze({
    authority: "edge-reported-copy",
    liveStateAuthoritative: false,
    tenantId: record.tenantId,
    projectId: record.projectId,
    gatewayId: record.gatewayId,
    integrationId: record.integrationId,
    topology: record.topology,
    topologyDigest: record.topologyDigest,
    latestObservations: record.latestObservations,
    receivedAt: record.receivedAt,
    revision: record.revision,
  });
}

function invalidRepositoryResult(): Readonly<{
  ok: false;
  failure: IntegrationProjectionFailure;
}> {
  return failure(
    "invalid-integration-repository-result",
    "integration repository returned an invalid result",
  );
}

function decodeRepositorySafely<Value>(
  operation: () => Value,
):
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: IntegrationProjectionFailure }> {
  try {
    return { ok: true, value: operation() };
  } catch {
    return invalidRepositoryResult();
  }
}

function decodeProjectionRecord(
  input: unknown,
  expectedScope: IntegrationProjectionScope,
): IntegrationProjectionRecord {
  const record = requireRecord(input, "integration projection record");
  requireExactKeys(
    record,
    [
      "gatewayId",
      "integrationId",
      "latestObservations",
      "projectId",
      "receivedAt",
      "revision",
      "tenantId",
      "topology",
      "topologyDigest",
    ],
    "integration projection record",
  );
  const tenantId = parseTenantId(record.tenantId);
  const projectId = parseProjectId(record.projectId);
  const gatewayId = parseGatewayId(record.gatewayId);
  const integrationId = parseIntegrationId(record.integrationId);
  if (
    tenantId !== expectedScope.tenantId ||
    projectId !== expectedScope.projectId ||
    gatewayId !== expectedScope.gatewayId ||
    integrationId !== expectedScope.integrationId
  ) {
    throw new IntegrationProjectionInputError(
      "projection record is outside the expected scope",
    );
  }
  const rawTopology = requireRecord(
    record.topology,
    "integration projection topology",
  );
  requireExactKeys(
    rawTopology,
    topologyKeys,
    "integration projection topology",
  );
  const topology = defineIntegrationTopologySnapshot(
    decodeTopologyFields(rawTopology),
  );
  if (topology.integrationId !== integrationId) {
    throw new IntegrationProjectionInputError(
      "projection topology is outside the expected integration",
    );
  }
  const topologyDigest = requireString(
    record.topologyDigest,
    "topologyDigest",
    64,
  );
  if (!sha256Pattern.test(topologyDigest)) {
    throw new IntegrationProjectionInputError(
      "projection topology digest is invalid",
    );
  }
  if (
    typeof record.revision !== "number" ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1
  ) {
    throw new IntegrationProjectionInputError(
      "projection revision must be a positive safe integer",
    );
  }
  const decodedObservations = requireArray(
    record.latestObservations,
    "latestObservations",
    65_536,
  ).map(decodeObservation);
  const identities = decodedObservations.map(
    (observation) => `${observation.entityId}\u0000${observation.pointKey}`,
  );
  if (new Set(identities).size !== identities.length) {
    throw new IntegrationProjectionInputError(
      "latestObservations contains duplicate entity points",
    );
  }
  const latestObservations =
    decodedObservations.length === 0
      ? Object.freeze([] as IntegrationObservation[])
      : defineIntegrationObservationBatch(
          {
            schema: "aether.integration.observation-batch.v1alpha1",
            integrationId: topology.integrationId,
            snapshotGeneration: topology.snapshotGeneration,
            batchId: "repository-validation",
            observedAtMs: topology.observedAtMs,
            observations: decodedObservations,
          },
          topology,
        ).observations;
  return Object.freeze({
    tenantId,
    projectId,
    gatewayId,
    integrationId,
    topology,
    topologyDigest,
    latestObservations,
    receivedAt: parseUtcInstant(record.receivedAt),
    revision: record.revision,
  });
}

function decodeTopologyHistoryRecord(
  input: unknown,
  expectedScope: IntegrationProjectionScope,
): IntegrationTopologyHistoryRecord {
  const history = requireRecord(input, "integration topology history record");
  requireExactKeys(
    history,
    [
      "gatewayId",
      "integrationId",
      "projectId",
      "receivedAt",
      "revision",
      "tenantId",
      "topology",
      "topologyDigest",
    ],
    "integration topology history record",
  );
  const decoded = decodeProjectionRecord(
    { ...history, latestObservations: [] },
    expectedScope,
  );
  return Object.freeze({
    tenantId: decoded.tenantId,
    projectId: decoded.projectId,
    gatewayId: decoded.gatewayId,
    integrationId: decoded.integrationId,
    topology: decoded.topology,
    topologyDigest: decoded.topologyDigest,
    receivedAt: decoded.receivedAt,
    revision: decoded.revision,
  });
}

interface PersistenceReceiptExpectation {
  readonly kind: "observations" | "topology";
  readonly outcome: "persisted" | "replayed";
  readonly scope: IntegrationProjectionScope;
  readonly credentialGeneration: string;
  readonly allowPriorCredentialGeneration?: boolean;
  readonly requestId: string;
  readonly payloadDigest: string;
  readonly snapshotGeneration: string;
  readonly recordRevision: number;
  readonly notAfter: UtcInstant;
  readonly batchId?: string;
}

function receiptCredentialGenerationMatches(
  actual: string,
  expected: PersistenceReceiptExpectation,
): boolean {
  return (
    actual === expected.credentialGeneration ||
    (expected.allowPriorCredentialGeneration === true &&
      BigInt(actual) < BigInt(expected.credentialGeneration))
  );
}

function decodePersistenceReceipt(
  input: unknown,
  expected: PersistenceReceiptExpectation,
):
  | IntegrationObservationPersistenceReceipt
  | IntegrationTopologyPersistenceReceipt {
  const receipt = requireRecord(input, "integration persistence receipt");
  const keys = [
    "auditEventId",
    "committedAt",
    "credentialGeneration",
    "gatewayId",
    "integrationId",
    "kind",
    "outboxEventId",
    "payloadDigest",
    "projectId",
    "requestId",
    "revision",
    "snapshotGeneration",
    "tenantId",
    ...(expected.kind === "observations" ? ["batchId"] : []),
  ];
  requireExactKeys(receipt, keys, "integration persistence receipt");
  const tenantId = parseTenantId(receipt.tenantId);
  const projectId = parseProjectId(receipt.projectId);
  const gatewayId = parseGatewayId(receipt.gatewayId);
  const integrationId = parseIntegrationId(receipt.integrationId);
  const credentialGeneration = parseGatewayCredentialGeneration(
    receipt.credentialGeneration,
  );
  const requestId = requireNonEmptyString(
    receipt.requestId,
    "receipt requestId",
    128,
  );
  const payloadDigest = requireString(
    receipt.payloadDigest,
    "receipt payloadDigest",
    64,
  );
  const snapshotGeneration = parseIntegrationSnapshotGeneration(
    receipt.snapshotGeneration,
  );
  const auditEventId = requireNonEmptyString(
    receipt.auditEventId,
    "receipt auditEventId",
    128,
  );
  const outboxEventId = requireNonEmptyString(
    receipt.outboxEventId,
    "receipt outboxEventId",
    128,
  );
  const committedAt = parseUtcInstant(receipt.committedAt);
  if (
    receipt.kind !== expected.kind ||
    tenantId !== expected.scope.tenantId ||
    projectId !== expected.scope.projectId ||
    gatewayId !== expected.scope.gatewayId ||
    integrationId !== expected.scope.integrationId ||
    !receiptCredentialGenerationMatches(credentialGeneration, expected) ||
    requestId !== expected.requestId ||
    payloadDigest !== expected.payloadDigest ||
    snapshotGeneration !== expected.snapshotGeneration ||
    !sha256Pattern.test(payloadDigest) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(auditEventId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(outboxEventId) ||
    auditEventId === outboxEventId ||
    committedAt > expected.notAfter ||
    typeof receipt.revision !== "number" ||
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision < 1 ||
    (expected.outcome === "persisted" &&
      receipt.revision !== expected.recordRevision) ||
    (expected.outcome === "replayed" &&
      receipt.revision > expected.recordRevision)
  ) {
    throw new IntegrationProjectionInputError(
      "integration persistence receipt does not match the command",
    );
  }
  if (expected.kind === "topology") {
    return Object.freeze({
      kind: expected.kind,
      tenantId,
      projectId,
      gatewayId,
      integrationId,
      credentialGeneration,
      requestId,
      payloadDigest,
      snapshotGeneration,
      revision: receipt.revision,
      auditEventId,
      outboxEventId,
      committedAt,
    });
  }
  const batchId = parseIntegrationBatchId(receipt.batchId);
  if (batchId !== expected.batchId) {
    throw new IntegrationProjectionInputError(
      "integration persistence receipt batch does not match the command",
    );
  }
  return Object.freeze({
    kind: expected.kind,
    tenantId,
    projectId,
    gatewayId,
    integrationId,
    credentialGeneration,
    requestId,
    payloadDigest,
    snapshotGeneration,
    batchId,
    revision: receipt.revision,
    auditEventId,
    outboxEventId,
    committedAt,
  });
}

function decodeCloudLinkDurableAcknowledgement(
  input: unknown,
  expected: Readonly<{
    delivery: IntegrationCloudLinkDelivery;
    scope: IntegrationProjectionScope;
    projectionReceipt:
      | IntegrationObservationPersistenceReceipt
      | IntegrationTopologyPersistenceReceipt;
    notAfter: UtcInstant;
  }>,
): IntegrationCloudLinkDurableAcknowledgement {
  const acknowledgement = requireRecord(
    input,
    "Integration CloudLink durable acknowledgement",
  );
  requireExactKeys(
    acknowledgement,
    [
      "acknowledgedAt",
      "acknowledgedPosition",
      "batchId",
      "credentialGeneration",
      "digest",
      "gatewayId",
      "integrationId",
      "messageKind",
      "outboxEventId",
      "projectId",
      "receiptId",
      "sessionEpoch",
      "sessionId",
      "streamEpoch",
      "streamId",
      "tenantId",
    ],
    "Integration CloudLink durable acknowledgement",
  );
  const tenantId = parseTenantId(acknowledgement.tenantId);
  const projectId = parseProjectId(acknowledgement.projectId);
  const gatewayId = parseGatewayId(acknowledgement.gatewayId);
  const integrationId = parseIntegrationId(acknowledgement.integrationId);
  const sessionId = parseCloudLinkSessionId(acknowledgement.sessionId);
  const sessionEpoch = parseCloudLinkSessionEpoch(acknowledgement.sessionEpoch);
  const credentialGeneration = parseGatewayCredentialGeneration(
    acknowledgement.credentialGeneration,
  );
  const streamId = parseStreamId(acknowledgement.streamId);
  const streamEpoch = parseStreamEpoch(acknowledgement.streamEpoch);
  const acknowledgedPosition = parseStreamPosition(
    acknowledgement.acknowledgedPosition,
  );
  const batchId = requireNonEmptyString(
    acknowledgement.batchId,
    "CloudLink acknowledgement batchId",
    128,
  );
  const digest = requireString(
    acknowledgement.digest,
    "CloudLink acknowledgement digest",
    71,
  );
  const outboxEventId = requireNonEmptyString(
    acknowledgement.outboxEventId,
    "CloudLink acknowledgement outboxEventId",
    128,
  );
  const receiptId = requireNonEmptyString(
    acknowledgement.receiptId,
    "CloudLink acknowledgement receiptId",
    128,
  );
  const acknowledgedAt = parseUtcInstant(acknowledgement.acknowledgedAt);
  if (
    tenantId !== expected.scope.tenantId ||
    projectId !== expected.scope.projectId ||
    gatewayId !== expected.scope.gatewayId ||
    integrationId !== expected.scope.integrationId ||
    sessionId !== expected.delivery.sessionId ||
    sessionEpoch !== expected.delivery.sessionEpoch ||
    credentialGeneration !== expected.delivery.credentialGeneration ||
    streamId !== expected.delivery.streamId ||
    streamEpoch !== expected.delivery.streamEpoch ||
    acknowledgement.messageKind !== expected.delivery.messageKind ||
    acknowledgedPosition === "0" ||
    acknowledgedPosition !== expected.delivery.position ||
    batchId !== expected.delivery.batchId ||
    digest !== expected.delivery.digest ||
    !cloudLinkDigestPattern.test(digest) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(outboxEventId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(receiptId) ||
    outboxEventId === receiptId ||
    outboxEventId === expected.projectionReceipt.outboxEventId ||
    outboxEventId === expected.projectionReceipt.auditEventId ||
    acknowledgedAt > expected.notAfter
  ) {
    throw new IntegrationProjectionInputError(
      "Integration CloudLink durable acknowledgement contradicts the committed delivery",
    );
  }
  return Object.freeze({
    tenantId,
    projectId,
    gatewayId,
    integrationId,
    outboxEventId,
    receiptId,
    sessionId,
    sessionEpoch,
    credentialGeneration,
    streamId,
    streamEpoch,
    acknowledgedPosition,
    batchId,
    digest,
    messageKind: expected.delivery.messageKind,
    acknowledgedAt,
  });
}

function repositoryOutcome(input: unknown): string {
  const result = requireRecord(input, "integration repository result");
  if (typeof result.outcome !== "string") {
    throw new IntegrationProjectionInputError(
      "integration repository outcome is invalid",
    );
  }
  return result.outcome;
}

function requireRepositoryFailure(
  input: unknown,
  expectedOutcome: string,
): void {
  const result = requireRecord(input, "integration repository result");
  requireExactKeys(result, ["outcome"], "integration repository result");
  if (result.outcome !== expectedOutcome) {
    throw new IntegrationProjectionInputError(
      "integration repository outcome changed during validation",
    );
  }
}

function decodeRepositorySuccess(
  input: unknown,
  expected: Omit<
    PersistenceReceiptExpectation,
    "outcome" | "recordRevision"
  > & {
    readonly scope: IntegrationProjectionScope;
    readonly cloudLinkDelivery?: IntegrationCloudLinkDelivery;
  },
): Readonly<{
  outcome: "persisted" | "replayed";
  record: IntegrationProjectionRecord;
  receipt:
    | IntegrationObservationPersistenceReceipt
    | IntegrationTopologyPersistenceReceipt;
  durableAcknowledgement?: IntegrationCloudLinkDurableAcknowledgement;
}> {
  const result = requireRecord(input, "integration repository result");
  requireExactKeys(
    result,
    expected.cloudLinkDelivery === undefined
      ? ["outcome", "receipt", "record"]
      : keysWithOptional(
          result,
          ["outcome", "receipt", "record"],
          ["durableAcknowledgement"],
        ),
    "integration repository result",
  );
  if (result.outcome !== "persisted" && result.outcome !== "replayed") {
    throw new IntegrationProjectionInputError(
      "integration repository success outcome is invalid",
    );
  }
  const record = decodeProjectionRecord(result.record, expected.scope);
  const receipt = decodePersistenceReceipt(result.receipt, {
    ...expected,
    outcome: result.outcome,
    recordRevision: record.revision,
    ...(result.outcome === "replayed" &&
    expected.cloudLinkDelivery !== undefined
      ? { allowPriorCredentialGeneration: true }
      : {}),
  });
  const durableAcknowledgement =
    expected.cloudLinkDelivery === undefined ||
    result.durableAcknowledgement === undefined
      ? undefined
      : decodeCloudLinkDurableAcknowledgement(result.durableAcknowledgement, {
          delivery: expected.cloudLinkDelivery,
          scope: expected.scope,
          projectionReceipt: receipt,
          notAfter: expected.notAfter,
        });
  return {
    outcome: result.outcome,
    record,
    receipt,
    ...(durableAcknowledgement === undefined ? {} : { durableAcknowledgement }),
  };
}

function validateDigest(
  digest: string,
):
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ ok: false; failure: IntegrationProjectionFailure }> {
  return sha256Pattern.test(digest)
    ? { ok: true, value: digest }
    : failure(
        "invalid-integration-repository-result",
        "integration digestor returned a non-SHA-256 digest",
      );
}

abstract class ReportIntegrationBase {
  readonly repository: IntegrationProjectionRepository;
  readonly verifier: GatewayCredentialVerifier;
  readonly digestor: IntegrationPayloadDigestor;
  readonly clock: ApplicationClock;
  readonly businessPayloadDigestor:
    | CloudLinkBusinessPayloadDigestor
    | undefined;

  constructor(dependencies: {
    readonly repository: IntegrationProjectionRepository;
    readonly verifier: GatewayCredentialVerifier;
    readonly digestor: IntegrationPayloadDigestor;
    readonly clock: ApplicationClock;
    readonly businessPayloadDigestor?: CloudLinkBusinessPayloadDigestor;
  }) {
    this.repository = dependencies.repository;
    this.verifier = dependencies.verifier;
    this.digestor = dependencies.digestor;
    this.clock = dependencies.clock;
    this.businessPayloadDigestor = dependencies.businessPayloadDigestor;
  }

  decodeContext(
    rawContext: unknown,
  ):
    | Readonly<{ ok: true; value: CommandContext }>
    | Readonly<{ ok: false; failure: IntegrationProjectionFailure }> {
    const context = decodeSafely(() => decodeCommandContext(rawContext));
    if (!context.ok) return context;
    const timeFailure = validateCommandTime(context.value, this.clock.now());
    if (timeFailure !== undefined) {
      return { ok: false, failure: timeFailure };
    }
    return context;
  }

  async verify(authentication: IntegrationReportAuthentication): Promise<
    | Readonly<{
        ok: true;
        value: Extract<
          Awaited<ReturnType<GatewayCredentialVerifier["verify"]>>,
          { ok: true }
        >["value"];
      }>
    | Readonly<{ ok: false; failure: IntegrationProjectionFailure }>
  > {
    if (authentication.kind === "gateway-signed") {
      return {
        ok: true,
        value: Object.freeze({
          tenantId: authentication.fact.tenantId,
          projectId: authentication.fact.projectId,
          gatewayId: authentication.fact.gatewayId,
          generation: authentication.fact.credentialGeneration,
          status: "active" as const,
        }),
      };
    }
    const verified = await this.verifier.verify(authentication.credential);
    if (!verified.ok) {
      return failure(
        "invalid-gateway-credential",
        "gateway credential was rejected",
      );
    }
    if (verified.value.status !== "active") {
      return failure(
        "gateway-credential-inactive",
        "gateway credential is not active",
      );
    }
    return verified;
  }

  async consumeGatewaySignedDelivery(
    decoded: DecodedObservationReport | DecodedTopologyReport,
    now: UtcInstant,
  ): Promise<
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; failure: IntegrationProjectionFailure }>
  > {
    if (decoded.authentication.kind !== "gateway-signed") {
      return { ok: true };
    }
    const delivery = decoded.cloudLinkDelivery;
    if (
      delivery === undefined ||
      delivery.sentAtMs === undefined ||
      delivery.expiresAtMs === undefined ||
      decoded.cloudLinkPayload === undefined ||
      this.businessPayloadDigestor === undefined
    ) {
      return failure(
        "gateway-signed-authentication-invalid",
        "Gateway-signed Integration validation is unavailable",
      );
    }
    const consumed =
      await validateGatewaySignedCloudLinkAuthenticationConsumption({
        kind: "delivery",
        fact: decoded.authentication.fact,
        delivery: {
          sentAtMs: delivery.sentAtMs,
          expiresAtMs: delivery.expiresAtMs,
          sessionId: delivery.sessionId,
          sessionEpoch: delivery.sessionEpoch,
          credentialGeneration: delivery.credentialGeneration,
          streamId: delivery.streamId,
          streamEpoch: delivery.streamEpoch,
          position: delivery.position,
          batchId: delivery.batchId,
          digest: delivery.digest,
          messageKind: delivery.messageKind,
        } satisfies GatewaySignedCloudLinkBusinessDelivery,
        payload: decoded.cloudLinkPayload,
        nowMs: String(Date.parse(now)),
        digestor: this.businessPayloadDigestor,
      });
    return consumed.ok
      ? { ok: true }
      : failure(
          "gateway-signed-authentication-invalid",
          consumed.failure === "MESSAGE_EXPIRED"
            ? "Gateway-signed Integration delivery expired before consumption"
            : "Gateway-signed Integration authentication is invalid",
        );
  }
}

export class ReportIntegrationTopology extends ReportIntegrationBase {
  static readonly definition = REPORT_INTEGRATION_TOPOLOGY_COMMAND;

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<
    IntegrationProjectionApplicationResult<ReportIntegrationProjectionValue>
  > {
    const context = this.decodeContext(rawContext);
    if (!context.ok) return context;
    const decoded = decodeSafely(() => decodeTopologyReport(rawInput));
    if (!decoded.ok) return decoded;
    const verified = await this.verify(decoded.value.authentication);
    if (!verified.ok) return verified;
    const consumed = await this.consumeGatewaySignedDelivery(
      decoded.value,
      this.clock.now(),
    );
    if (!consumed.ok) return consumed;
    if (
      decoded.value.cloudLinkDelivery !== undefined &&
      decoded.value.cloudLinkDelivery.credentialGeneration !==
        verified.value.generation
    ) {
      return failure(
        "invalid-input",
        "CloudLink delivery credential generation does not match the authenticated Gateway",
      );
    }
    const providerTimeFailure = validateProviderTimes(
      [decoded.value.topology.observedAtMs],
      this.clock.now(),
    );
    if (providerTimeFailure !== undefined) {
      return { ok: false, failure: providerTimeFailure };
    }
    const digest = validateDigest(
      await this.digestor.digest(decoded.value.topology),
    );
    if (!digest.ok) return digest;
    const scope: IntegrationProjectionScope = {
      tenantId: verified.value.tenantId,
      projectId: verified.value.projectId,
      gatewayId: verified.value.gatewayId,
      integrationId: decoded.value.topology.integrationId,
    };
    const cloudLinkSessionFence = sessionFenceFromAuthentication(
      decoded.value.authentication,
    );
    let persistedRaw: unknown;
    try {
      persistedRaw = await this.repository.persistTopology({
        requestId: context.value.requestId,
        binding: verified.value,
        topology: decoded.value.topology,
        payloadDigest: digest.value,
        receivedAt: this.clock.now(),
        ...(decoded.value.cloudLinkDelivery === undefined
          ? {}
          : { cloudLinkDelivery: decoded.value.cloudLinkDelivery }),
        ...(cloudLinkSessionFence === undefined
          ? {}
          : { cloudLinkSessionFence }),
      });
    } catch {
      return failure(
        "integration-storage-unavailable",
        "integration projection persistence is unavailable",
      );
    }
    const decodedOutcome = decodeRepositorySafely(() =>
      repositoryOutcome(persistedRaw),
    );
    if (!decodedOutcome.ok) return decodedOutcome;
    switch (decodedOutcome.value) {
      case "storage-unavailable":
      case "delivery-conflict":
      case "delivery-gap":
      case "generation-conflict":
      case "idempotency-conflict":
      case "session-fenced":
      case "stale-generation":
      case "stream-binding-conflict": {
        const validFailure = decodeRepositorySafely(() => {
          requireRepositoryFailure(persistedRaw, decodedOutcome.value);
        });
        if (!validFailure.ok) return validFailure;
        if (decodedOutcome.value === "storage-unavailable") {
          return failure(
            "integration-storage-unavailable",
            "integration projection persistence is unavailable",
          );
        }
        if (decodedOutcome.value === "generation-conflict") {
          return failure(
            "integration-generation-conflict",
            "topology generation conflicts with persisted content",
          );
        }
        if (decodedOutcome.value === "idempotency-conflict") {
          return failure(
            "integration-idempotency-conflict",
            "idempotency key was reused for different integration content",
          );
        }
        if (decodedOutcome.value === "session-fenced") {
          return failure(
            "integration-session-fenced",
            "the authenticated CloudLink session is no longer current",
          );
        }
        if (decodedOutcome.value === "delivery-conflict") {
          return failure(
            "integration-delivery-conflict",
            "CloudLink delivery identity conflicts with persisted content",
          );
        }
        if (decodedOutcome.value === "delivery-gap") {
          return failure(
            "integration-delivery-gap",
            "CloudLink delivery is ahead of the contiguous stream cursor",
          );
        }
        if (decodedOutcome.value === "stream-binding-conflict") {
          return failure(
            "integration-stream-binding-conflict",
            "CloudLink stream epoch is bound to another Integration fact",
          );
        }
        return failure(
          "integration-stale-generation",
          "topology generation is older than the current projection",
        );
      }
      case "persisted":
      case "replayed":
        break;
      default:
        return invalidRepositoryResult();
    }
    const persisted = decodeRepositorySafely(() =>
      decodeRepositorySuccess(persistedRaw, {
        kind: "topology",
        scope,
        credentialGeneration: verified.value.generation,
        requestId: context.value.requestId,
        payloadDigest: digest.value,
        snapshotGeneration: decoded.value.topology.snapshotGeneration,
        notAfter: this.clock.now(),
        ...(decoded.value.cloudLinkDelivery === undefined
          ? {}
          : { cloudLinkDelivery: decoded.value.cloudLinkDelivery }),
      }),
    );
    if (!persisted.ok) return persisted;
    const returnedDigest = validateDigest(
      await this.digestor.digest(persisted.value.record.topology),
    );
    if (
      !returnedDigest.ok ||
      returnedDigest.value !== digest.value ||
      persisted.value.record.topologyDigest !== digest.value ||
      persisted.value.receipt.kind !== "topology" ||
      !projectionRecordTimesAreValid(persisted.value.record, this.clock.now())
    ) {
      return invalidRepositoryResult();
    }
    return {
      ok: true,
      replayed: persisted.value.outcome === "replayed",
      value: {
        disposition: persisted.value.outcome,
        projection: projectionView(persisted.value.record),
        receipt: persisted.value.receipt,
        ...(persisted.value.durableAcknowledgement === undefined
          ? {}
          : {
              durableAcknowledgement: persisted.value.durableAcknowledgement,
            }),
      },
    };
  }
}

export class ReportIntegrationObservations extends ReportIntegrationBase {
  static readonly definition = REPORT_INTEGRATION_OBSERVATIONS_COMMAND;

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<
    IntegrationProjectionApplicationResult<ReportIntegrationProjectionValue>
  > {
    const context = this.decodeContext(rawContext);
    if (!context.ok) return context;
    const decoded = decodeSafely(() => decodeObservationReport(rawInput));
    if (!decoded.ok) return decoded;
    const verified = await this.verify(decoded.value.authentication);
    if (!verified.ok) return verified;
    const consumed = await this.consumeGatewaySignedDelivery(
      decoded.value,
      this.clock.now(),
    );
    if (!consumed.ok) return consumed;
    if (
      decoded.value.cloudLinkDelivery !== undefined &&
      decoded.value.cloudLinkDelivery.credentialGeneration !==
        verified.value.generation
    ) {
      return failure(
        "invalid-input",
        "CloudLink delivery credential generation does not match the authenticated Gateway",
      );
    }
    const integrationId = decodeSafely(() =>
      parseIntegrationId(decoded.value.batch.integrationId),
    );
    if (!integrationId.ok) return integrationId;
    const scope: IntegrationProjectionScope = {
      tenantId: verified.value.tenantId,
      projectId: verified.value.projectId,
      gatewayId: verified.value.gatewayId,
      integrationId: integrationId.value,
    };
    let currentRaw: unknown;
    try {
      currentRaw = await this.repository.findCurrent(scope);
    } catch {
      return failure(
        "integration-storage-unavailable",
        "integration projection persistence is unavailable",
      );
    }
    if (currentRaw === undefined) {
      return failure(
        "integration-topology-required",
        "a current integration topology is required before observations",
      );
    }
    const current = decodeRepositorySafely(() =>
      decodeProjectionRecord(currentRaw, scope),
    );
    if (!current.ok) return current;
    if (!projectionRecordTimesAreValid(current.value, this.clock.now())) {
      return invalidRepositoryResult();
    }
    const currentTopologyDigest = validateDigest(
      await this.digestor.digest(current.value.topology),
    );
    if (
      !currentTopologyDigest.ok ||
      currentTopologyDigest.value !== current.value.topologyDigest
    ) {
      return invalidRepositoryResult();
    }
    const requestedGeneration = decodeSafely(() =>
      parseIntegrationSnapshotGeneration(
        decoded.value.batch.snapshotGeneration,
      ),
    );
    if (!requestedGeneration.ok) return requestedGeneration;
    let validationTopology = current.value.topology;
    if (
      requestedGeneration.value !== current.value.topology.snapshotGeneration
    ) {
      if (decoded.value.cloudLinkDelivery === undefined) {
        return failure(
          "integration-generation-conflict",
          "observation batch generation is no longer current",
        );
      }
      let historicalRaw: unknown;
      try {
        historicalRaw = await this.repository.findTopology(
          scope,
          requestedGeneration.value,
        );
      } catch {
        return failure(
          "integration-storage-unavailable",
          "integration topology history is unavailable",
        );
      }
      if (historicalRaw === undefined) {
        return failure(
          "integration-generation-conflict",
          "observation batch topology generation was not accepted",
        );
      }
      const historical = decodeRepositorySafely(() =>
        decodeTopologyHistoryRecord(historicalRaw, scope),
      );
      if (!historical.ok) return historical;
      const historicalDigest = validateDigest(
        await this.digestor.digest(historical.value.topology),
      );
      if (
        !historicalDigest.ok ||
        historicalDigest.value !== historical.value.topologyDigest ||
        historical.value.topology.snapshotGeneration !==
          requestedGeneration.value ||
        historical.value.receivedAt > this.clock.now() ||
        validateProviderTimes(
          [historical.value.topology.observedAtMs],
          this.clock.now(),
        ) !== undefined
      ) {
        return invalidRepositoryResult();
      }
      validationTopology = historical.value.topology;
    }
    const batch = decodeSafely(() =>
      defineIntegrationObservationBatch(
        decoded.value.batch,
        validationTopology,
      ),
    );
    if (!batch.ok) return batch;
    const providerTimeFailure = validateProviderTimes(
      [
        batch.value.observedAtMs,
        ...batch.value.observations.map(
          (observation) => observation.observedAtMs,
        ),
      ],
      this.clock.now(),
    );
    if (providerTimeFailure !== undefined) {
      return { ok: false, failure: providerTimeFailure };
    }
    const digest = validateDigest(await this.digestor.digest(batch.value));
    if (!digest.ok) return digest;
    const cloudLinkSessionFence = sessionFenceFromAuthentication(
      decoded.value.authentication,
    );
    let persistedRaw: unknown;
    try {
      persistedRaw = await this.repository.persistObservations({
        requestId: context.value.requestId,
        binding: verified.value,
        batch: batch.value,
        payloadDigest: digest.value,
        receivedAt: this.clock.now(),
        ...(decoded.value.cloudLinkDelivery === undefined
          ? {}
          : { cloudLinkDelivery: decoded.value.cloudLinkDelivery }),
        ...(cloudLinkSessionFence === undefined
          ? {}
          : { cloudLinkSessionFence }),
      });
    } catch {
      return failure(
        "integration-storage-unavailable",
        "integration projection persistence is unavailable",
      );
    }
    const decodedOutcome = decodeRepositorySafely(() =>
      repositoryOutcome(persistedRaw),
    );
    if (!decodedOutcome.ok) return decodedOutcome;
    switch (decodedOutcome.value) {
      case "storage-unavailable":
      case "batch-conflict":
      case "delivery-conflict":
      case "delivery-gap":
      case "generation-conflict":
      case "idempotency-conflict":
      case "session-fenced":
      case "stream-binding-conflict":
      case "topology-required": {
        const validFailure = decodeRepositorySafely(() => {
          requireRepositoryFailure(persistedRaw, decodedOutcome.value);
        });
        if (!validFailure.ok) return validFailure;
        if (decodedOutcome.value === "storage-unavailable") {
          return failure(
            "integration-storage-unavailable",
            "integration projection persistence is unavailable",
          );
        }
        if (decodedOutcome.value === "batch-conflict") {
          return failure(
            "integration-batch-conflict",
            "observation batch identity conflicts with persisted content",
          );
        }
        if (decodedOutcome.value === "delivery-conflict") {
          return failure(
            "integration-delivery-conflict",
            "CloudLink delivery identity conflicts with persisted content",
          );
        }
        if (decodedOutcome.value === "delivery-gap") {
          return failure(
            "integration-delivery-gap",
            "CloudLink delivery is ahead of the contiguous stream cursor",
          );
        }
        if (decodedOutcome.value === "stream-binding-conflict") {
          return failure(
            "integration-stream-binding-conflict",
            "CloudLink stream epoch is bound to another Integration fact",
          );
        }
        if (decodedOutcome.value === "generation-conflict") {
          return failure(
            "integration-generation-conflict",
            "observation batch generation is no longer current",
          );
        }
        if (decodedOutcome.value === "idempotency-conflict") {
          return failure(
            "integration-idempotency-conflict",
            "idempotency key was reused for different integration content",
          );
        }
        if (decodedOutcome.value === "session-fenced") {
          return failure(
            "integration-session-fenced",
            "the authenticated CloudLink session is no longer current",
          );
        }
        return failure(
          "integration-topology-required",
          "a current integration topology is required before observations",
        );
      }
      case "persisted":
      case "replayed":
        break;
      default:
        return invalidRepositoryResult();
    }
    const persisted = decodeRepositorySafely(() =>
      decodeRepositorySuccess(persistedRaw, {
        kind: "observations",
        scope,
        credentialGeneration: verified.value.generation,
        requestId: context.value.requestId,
        payloadDigest: digest.value,
        snapshotGeneration: batch.value.snapshotGeneration,
        notAfter: this.clock.now(),
        batchId: batch.value.batchId,
        ...(decoded.value.cloudLinkDelivery === undefined
          ? {}
          : { cloudLinkDelivery: decoded.value.cloudLinkDelivery }),
      }),
    );
    if (!persisted.ok) return persisted;
    const returnedTopologyDigest = validateDigest(
      await this.digestor.digest(persisted.value.record.topology),
    );
    const replaysHistoricalCloudLinkDelivery =
      persisted.value.outcome === "replayed" &&
      decoded.value.cloudLinkDelivery !== undefined &&
      batch.value.snapshotGeneration !==
        current.value.topology.snapshotGeneration;
    if (
      !returnedTopologyDigest.ok ||
      returnedTopologyDigest.value !== currentTopologyDigest.value ||
      persisted.value.record.topologyDigest !== current.value.topologyDigest ||
      (replaysHistoricalCloudLinkDelivery &&
        (persisted.value.record.topology.snapshotGeneration !==
          current.value.topology.snapshotGeneration ||
          persisted.value.record.revision !== current.value.revision)) ||
      (!replaysHistoricalCloudLinkDelivery &&
        persisted.value.record.topology.snapshotGeneration !==
          batch.value.snapshotGeneration) ||
      persisted.value.receipt.kind !== "observations" ||
      !projectionRecordTimesAreValid(
        persisted.value.record,
        this.clock.now(),
      ) ||
      (!replaysHistoricalCloudLinkDelivery &&
        persisted.value.outcome === "persisted" &&
        persisted.value.record.revision <= current.value.revision) ||
      (!replaysHistoricalCloudLinkDelivery &&
        persisted.value.outcome === "replayed" &&
        persisted.value.record.revision < current.value.revision)
    ) {
      return invalidRepositoryResult();
    }
    return {
      ok: true,
      replayed: persisted.value.outcome === "replayed",
      value: {
        disposition: persisted.value.outcome,
        projection: projectionView(persisted.value.record),
        receipt: persisted.value.receipt,
        ...(persisted.value.durableAcknowledgement === undefined
          ? {}
          : {
              durableAcknowledgement: persisted.value.durableAcknowledgement,
            }),
      },
    };
  }
}

export class GetIntegrationProjection {
  static readonly definition = GET_INTEGRATION_PROJECTION_QUERY;

  readonly #repository: IntegrationProjectionRepository;
  readonly #digestor: IntegrationPayloadDigestor;
  readonly #clock: ApplicationClock;

  constructor(dependencies: {
    readonly repository: IntegrationProjectionRepository;
    readonly digestor: IntegrationPayloadDigestor;
    readonly clock: ApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#digestor = dependencies.digestor;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<IntegrationProjectionQueryResult<IntegrationProjectionView>> {
    const decoded = decodeSafely(() => {
      const context = decodeQueryContext(rawContext);
      const input = requireRecord(rawInput, "integration projection query");
      requireExactKeys(
        input,
        ["gatewayId", "integrationId"],
        "integration projection query",
      );
      return {
        context,
        scope: {
          tenantId: context.tenantId,
          projectId: context.projectId,
          gatewayId: parseGatewayId(input.gatewayId),
          integrationId: parseIntegrationId(input.integrationId),
        },
      };
    });
    if (!decoded.ok) return decoded;
    if (
      !decoded.value.context.permissions.has(
        GET_INTEGRATION_PROJECTION_QUERY.permission,
      )
    ) {
      return failure(
        "permission-denied",
        `permission ${GET_INTEGRATION_PROJECTION_QUERY.permission} is required`,
      );
    }
    let recordRaw: unknown;
    try {
      recordRaw = await this.#repository.findCurrent(decoded.value.scope);
    } catch {
      return failure(
        "integration-storage-unavailable",
        "integration projection persistence is unavailable",
      );
    }
    if (recordRaw === undefined) {
      return failure(
        "integration-projection-not-found",
        "integration projection was not found",
      );
    }
    const record = decodeRepositorySafely(() =>
      decodeProjectionRecord(recordRaw, decoded.value.scope),
    );
    if (!record.ok) return record;
    if (!projectionRecordTimesAreValid(record.value, this.#clock.now())) {
      return invalidRepositoryResult();
    }
    const topologyDigest = validateDigest(
      await this.#digestor.digest(record.value.topology),
    );
    if (
      !topologyDigest.ok ||
      topologyDigest.value !== record.value.topologyDigest
    ) {
      return invalidRepositoryResult();
    }
    return { ok: true, value: projectionView(record.value) };
  }
}
