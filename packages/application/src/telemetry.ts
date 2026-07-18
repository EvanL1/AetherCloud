import {
  InvalidDomainValueError,
  defineTelemetryBatch,
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseDeviceEventId,
  parseEdgeInstanceId,
  parseEdgePointId,
  parseGatewayId,
  parseGatewayCredentialGeneration,
  parseProjectId,
  parseRetentionClass,
  parseSourceTimestampMs,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
  parseTelemetryQuality,
  parseTelemetryStreamEpoch,
  parseTelemetryStreamId,
  parseTelemetryStreamPosition,
  parseTenantId,
  parseThingModelRevision,
  parseTopologyPublicationEpoch,
  parseTopologySnapshotDigest,
  parseUtcInstant,
} from "@aether-cloud/domain";
import type {
  DeviceEventPayloadValue,
  GatewayCredentialBinding,
  PersistedTelemetryRecord,
  TelemetryIngestionReceipt,
  TelemetryRecord,
  ThingModelReference,
  UtcInstant,
} from "@aether-cloud/domain";

import type {
  CloudLinkDurableAcknowledgement,
  CloudLinkDurableAcknowledgementIntent,
} from "./cloudlink-durable-ack-repository.js";

import {
  GET_TELEMETRY_HISTORY_QUERY,
  INGEST_TELEMETRY_BATCH_COMMAND,
} from "./capability-definition.js";
import type {
  GatewayCredentialAssertion,
  GatewayCredentialVerifier,
} from "./cloudlink-session-repository.js";
import {
  decodeGatewaySignedCloudLinkBusinessDelivery,
  isGatewaySignedCloudLinkUplinkAuthenticationFact,
  validateGatewaySignedCloudLinkAuthenticationConsumption,
  type CloudLinkBusinessPayloadDigestor,
  type GatewaySignedCloudLinkUplinkAuthenticationFact,
} from "./cloudlink-uplink-authentication.js";
import type { ApplicationClock } from "./gateway-identity-repository.js";
import type {
  TelemetryBatchDigestor,
  TelemetryPersistenceResult,
  TelemetryRepository,
} from "./telemetry-repository.js";
import { TelemetryStorageUnavailableError } from "./telemetry-repository.js";

type TelemetryApplicationFailureCode =
  | "command-expired"
  | "gateway-credential-inactive"
  | "gateway-signed-authentication-invalid"
  | "invalid-gateway-credential"
  | "invalid-input"
  | "invalid-telemetry-repository-result"
  | "permission-denied"
  | "telemetry-conflicting-replay"
  | "telemetry-digest-invalid"
  | "telemetry-position-conflict"
  | "telemetry-quota-exceeded"
  | "telemetry-storage-unavailable";

export interface TelemetryApplicationFailure {
  readonly code: TelemetryApplicationFailureCode;
  readonly message: string;
}

export type TelemetryApplicationResult<Value> =
  | Readonly<{ ok: true; replayed: boolean; value: Value }>
  | Readonly<{ ok: false; failure: TelemetryApplicationFailure }>;

export type TelemetryQueryResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: TelemetryApplicationFailure }>;

export interface IngestTelemetryBatchValue {
  readonly disposition: "duplicate" | "persisted";
  readonly durablyAcknowledged: true;
  readonly receipt: TelemetryIngestionReceipt;
  readonly durableAcknowledgement?: CloudLinkDurableAcknowledgement;
}

export interface TelemetryHistoryView {
  readonly authority: "edge-reported-history-copy";
  readonly liveStateAuthoritative: false;
  readonly records: readonly PersistedTelemetryRecord[];
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

class TelemetryInputError extends Error {}

type TelemetryIngestAuthentication =
  | Readonly<{
      kind: "credential";
      credential: GatewayCredentialAssertion;
    }>
  | Readonly<{
      kind: "gateway-signed";
      fact: GatewaySignedCloudLinkUplinkAuthenticationFact;
      payload: Readonly<Record<string, unknown>>;
      delivery: NonNullable<
        ReturnType<typeof decodeGatewaySignedCloudLinkBusinessDelivery>
      >;
    }>;

const sha256Pattern = /^[0-9a-f]{64}$/;

function failure(
  code: TelemetryApplicationFailureCode,
  message: string,
): Readonly<{ ok: false; failure: TelemetryApplicationFailure }> {
  return { ok: false, failure: { code, message } };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function requireRecord(input: unknown, name: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new TelemetryInputError(`${name} must be an object`);
  }
  return input;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(record).sort();
  const canonicalExpected = [...expected].sort();
  if (
    actual.length !== canonicalExpected.length ||
    actual.some((key, index) => key !== canonicalExpected[index])
  ) {
    throw new TelemetryInputError(
      `${name} must contain exactly: ${canonicalExpected.join(", ")}`,
    );
  }
}

function requireString(input: unknown, name: string, maximum = 256): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > maximum
  ) {
    throw new TelemetryInputError(`${name} must be a non-empty bounded string`);
  }
  return input;
}

function parseRequestId(input: unknown): string {
  const value = requireString(input, "idempotencyKey", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new TelemetryInputError(
      "idempotencyKey must be an opaque 8-128 character identifier",
    );
  }
  return value;
}

function decodeCommandContext(input: unknown): CommandContext {
  const record = requireRecord(input, "command context");
  requireExactKeys(
    record,
    ["expiresAt", "idempotencyKey", "issuedAt"],
    "command context",
  );
  return {
    requestId: parseRequestId(record.idempotencyKey),
    issuedAt: parseUtcInstant(record.issuedAt),
    expiresAt: parseUtcInstant(record.expiresAt),
  };
}

function decodeCredential(input: unknown): GatewayCredentialAssertion {
  const record = requireRecord(input, "Gateway credential");
  requireExactKeys(record, ["credentialId", "proof"], "Gateway credential");
  return {
    credentialId: requireString(record.credentialId, "credentialId"),
    proof: requireString(record.proof, "credential proof", 4096),
  };
}

function decodeModel(input: unknown): ThingModelReference {
  const record = requireRecord(input, "model reference");
  requireExactKeys(record, ["modelId", "revision"], "model reference");
  return {
    modelId: requireString(record.modelId, "modelId", 128),
    revision: parseThingModelRevision(record.revision),
  };
}

function decodeOptionalModel(input: unknown): ThingModelReference | undefined {
  return input === undefined ? undefined : decodeModel(input);
}

function decodeTopology(input: unknown) {
  const record = requireRecord(input, "telemetry topology binding");
  requireExactKeys(
    record,
    ["publicationEpoch", "snapshotDigest"],
    "telemetry topology binding",
  );
  return {
    publicationEpoch: parseTopologyPublicationEpoch(record.publicationEpoch),
    snapshotDigest: parseTopologySnapshotDigest(record.snapshotDigest),
  };
}

type DecodedDurableAcknowledgementIntent = Omit<
  CloudLinkDurableAcknowledgementIntent,
  "acknowledgedAt"
>;

function decodeDurableAcknowledgementIntent(
  input: unknown,
): DecodedDurableAcknowledgementIntent {
  const record = requireRecord(input, "durable acknowledgement intent");
  requireExactKeys(
    record,
    [
      "acknowledgedPosition",
      "acceptedTelemetryPosition",
      "batchId",
      "credentialGeneration",
      "digest",
      "sessionEpoch",
      "sessionId",
      "streamEpoch",
      "streamId",
    ],
    "durable acknowledgement intent",
  );
  const digest = requireString(record.digest, "delivery digest", 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new TelemetryInputError(
      "delivery digest must be an algorithm-qualified lowercase SHA-256 digest",
    );
  }
  const batchId = requireString(record.batchId, "delivery batchId", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(batchId)) {
    throw new TelemetryInputError(
      "delivery batchId must be a bounded identifier",
    );
  }
  return {
    sessionId: parseCloudLinkSessionId(record.sessionId),
    sessionEpoch: parseCloudLinkSessionEpoch(record.sessionEpoch),
    credentialGeneration: parseGatewayCredentialGeneration(
      record.credentialGeneration,
    ),
    streamId: parseStreamId(record.streamId),
    streamEpoch: parseStreamEpoch(record.streamEpoch),
    acknowledgedPosition: parseStreamPosition(record.acknowledgedPosition),
    acceptedTelemetryPosition: parseTelemetryStreamPosition(
      record.acceptedTelemetryPosition,
    ),
    batchId,
    digest,
  };
}

function decodePointKind(input: unknown): "status" | "telemetry" {
  if (!(input === "status" || input === "telemetry")) {
    throw new TelemetryInputError(
      "pointKind must be acquisition-owned telemetry or status",
    );
  }
  return input;
}

function decodePointValue(
  input: unknown,
): Extract<TelemetryRecord, { kind: "point-sample" }>["value"] {
  const record = requireRecord(input, "point value");
  requireExactKeys(record, ["type", "value"], "point value");
  if (record.type === "float64") {
    if (typeof record.value !== "number") {
      throw new TelemetryInputError("float64 point value must be a number");
    }
    return { type: "float64", value: record.value };
  }
  if (record.type === "int64") {
    return {
      type: "int64",
      value: requireString(record.value, "int64 point value", 20),
    };
  }
  throw new TelemetryInputError("point value type is unsupported");
}

function decodeEventPayload(
  input: unknown,
): Readonly<Record<string, DeviceEventPayloadValue>> {
  const record = requireRecord(input, "device event payload");
  const decoded: Record<string, DeviceEventPayloadValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (
      !(
        value === null ||
        typeof value === "boolean" ||
        typeof value === "number" ||
        typeof value === "string"
      )
    ) {
      throw new TelemetryInputError(
        "device event payload values must be scalar JSON values",
      );
    }
    decoded[key] = value;
  }
  return decoded;
}

function decodeTelemetryRecord(input: unknown): TelemetryRecord {
  const record = requireRecord(input, "telemetry record");
  if (record.kind === "point-sample") {
    const hasModel = record.model !== undefined;
    requireExactKeys(
      record,
      [
        "instanceId",
        "kind",
        ...(hasModel ? ["model"] : []),
        "pointId",
        "pointKind",
        "position",
        "quality",
        "sourceTimestampMs",
        "value",
      ],
      "point sample",
    );
    const model = decodeOptionalModel(record.model);
    return {
      kind: "point-sample",
      position: parseTelemetryStreamPosition(record.position),
      sourceTimestampMs: parseSourceTimestampMs(record.sourceTimestampMs),
      instanceId: parseEdgeInstanceId(record.instanceId),
      pointKind: decodePointKind(record.pointKind),
      pointId: parseEdgePointId(record.pointId),
      quality: parseTelemetryQuality(record.quality),
      value: decodePointValue(record.value),
      ...(model === undefined ? {} : { model }),
    };
  }
  if (record.kind === "device-event") {
    const hasModel = record.model !== undefined;
    requireExactKeys(
      record,
      [
        "eventId",
        "eventType",
        "instanceId",
        "kind",
        ...(hasModel ? ["model"] : []),
        "payload",
        "position",
        "sourceTimestampMs",
      ],
      "device event",
    );
    const model = decodeOptionalModel(record.model);
    return {
      kind: "device-event",
      position: parseTelemetryStreamPosition(record.position),
      sourceTimestampMs: parseSourceTimestampMs(record.sourceTimestampMs),
      eventId: parseDeviceEventId(record.eventId),
      eventType: requireString(record.eventType, "eventType", 128),
      instanceId: parseEdgeInstanceId(record.instanceId),
      payload: decodeEventPayload(record.payload),
      ...(model === undefined ? {} : { model }),
    };
  }
  throw new TelemetryInputError("telemetry record kind is unsupported");
}

function decodeCloudLinkPointFact(
  input: unknown,
  position: string,
): TelemetryRecord {
  const record = requireRecord(input, "CloudLink point fact");
  const hasModel = record.model !== undefined;
  requireExactKeys(
    record,
    [
      "instance_id",
      ...(hasModel ? ["model"] : []),
      "point_id",
      "point_kind",
      "quality",
      "source_timestamp_ms",
      "value",
    ],
    "CloudLink point fact",
  );
  if (typeof record.value !== "number" || !Number.isFinite(record.value)) {
    throw new TelemetryInputError(
      "CloudLink point value must be a finite number",
    );
  }
  let model: ThingModelReference | undefined;
  if (hasModel) {
    const rawModel = requireRecord(record.model, "CloudLink point model");
    requireExactKeys(
      rawModel,
      ["model_id", "revision"],
      "CloudLink point model",
    );
    model = {
      modelId: requireString(rawModel.model_id, "model_id", 128),
      revision: parseThingModelRevision(rawModel.revision),
    };
  }
  return {
    kind: "point-sample",
    position: parseTelemetryStreamPosition(
      (BigInt(parseStreamPosition(position)) - 1n).toString(),
    ),
    sourceTimestampMs: parseSourceTimestampMs(record.source_timestamp_ms),
    instanceId: parseEdgeInstanceId(record.instance_id),
    pointKind: decodePointKind(record.point_kind),
    pointId: parseEdgePointId(record.point_id),
    quality: parseTelemetryQuality(record.quality),
    value: { type: "float64", value: record.value },
    ...(model === undefined ? {} : { model }),
  };
}

function decodeIngestInput(input: unknown) {
  const record = requireRecord(input, "telemetry ingest input");
  if (record.gatewaySignedAuthentication !== undefined) {
    requireExactKeys(
      record,
      [
        "cloudLinkDelivery",
        "cloudLinkPayload",
        "gatewaySignedAuthentication",
        "retentionClass",
      ],
      "Gateway-signed telemetry ingest input",
    );
    const fact = record.gatewaySignedAuthentication;
    const delivery = decodeGatewaySignedCloudLinkBusinessDelivery(
      record.cloudLinkDelivery,
    );
    const payload = requireRecord(
      record.cloudLinkPayload,
      "CloudLink telemetry payload",
    );
    requireExactKeys(
      payload,
      ["samples", "topology"],
      "CloudLink telemetry payload",
    );
    const topology = requireRecord(
      payload.topology,
      "CloudLink telemetry topology",
    );
    requireExactKeys(
      topology,
      ["publication_epoch", "snapshot_digest"],
      "CloudLink telemetry topology",
    );
    if (
      !isGatewaySignedCloudLinkUplinkAuthenticationFact(fact) ||
      delivery === undefined ||
      delivery.messageKind !== "telemetry-batch" ||
      !Array.isArray(payload.samples) ||
      payload.samples.length !== 1
    ) {
      throw new TelemetryInputError(
        "Gateway-signed telemetry authentication is invalid",
      );
    }
    const batch = defineTelemetryBatch({
      streamId: parseTelemetryStreamId(delivery.streamId),
      streamEpoch: parseTelemetryStreamEpoch(delivery.streamEpoch),
      topology: {
        publicationEpoch: parseTopologyPublicationEpoch(
          topology.publication_epoch,
        ),
        snapshotDigest: parseTopologySnapshotDigest(topology.snapshot_digest),
      },
      retentionClass: parseRetentionClass(record.retentionClass),
      replay: false,
      records: payload.samples.map((sample) =>
        decodeCloudLinkPointFact(sample, delivery.position),
      ),
    });
    return {
      authentication: {
        kind: "gateway-signed",
        fact,
        payload: Object.freeze({ ...payload }),
        delivery,
      } satisfies TelemetryIngestAuthentication,
      batch,
      durableAcknowledgement: {
        sessionId: delivery.sessionId,
        sessionEpoch: delivery.sessionEpoch,
        credentialGeneration: delivery.credentialGeneration,
        streamId: delivery.streamId,
        streamEpoch: delivery.streamEpoch,
        acknowledgedPosition: delivery.position,
        acceptedTelemetryPosition: batch.lastPosition,
        batchId: delivery.batchId,
        digest: delivery.digest,
      } satisfies DecodedDurableAcknowledgementIntent,
    };
  }
  const hasDurableAcknowledgement = record.durableAcknowledgement !== undefined;
  requireExactKeys(
    record,
    [
      "credential",
      ...(hasDurableAcknowledgement ? ["durableAcknowledgement"] : []),
      "records",
      "replay",
      "retentionClass",
      "streamEpoch",
      "streamId",
      "topology",
    ],
    "telemetry ingest input",
  );
  let encodedSize: number;
  try {
    encodedSize = new TextEncoder().encode(JSON.stringify(record)).byteLength;
  } catch {
    throw new TelemetryInputError(
      "telemetry ingest input must be JSON serializable",
    );
  }
  if (encodedSize > 1024 * 1024) {
    throw new TelemetryInputError("telemetry ingest input exceeds 1 MiB");
  }
  if (!Array.isArray(record.records)) {
    throw new TelemetryInputError("records must be an array");
  }
  if (typeof record.replay !== "boolean") {
    throw new TelemetryInputError("replay must be boolean");
  }
  return {
    authentication: {
      kind: "credential",
      credential: decodeCredential(record.credential),
    } satisfies TelemetryIngestAuthentication,
    batch: defineTelemetryBatch({
      streamId: parseTelemetryStreamId(record.streamId),
      streamEpoch: parseTelemetryStreamEpoch(record.streamEpoch),
      topology: decodeTopology(record.topology),
      retentionClass: parseRetentionClass(record.retentionClass),
      replay: record.replay,
      records: record.records.map(decodeTelemetryRecord),
    }),
    ...(hasDurableAcknowledgement
      ? {
          durableAcknowledgement: decodeDurableAcknowledgementIntent(
            record.durableAcknowledgement,
          ),
        }
      : {}),
  };
}

function durableAcknowledgementForPersistence(
  decoded: Readonly<{
    batch: ReturnType<typeof defineTelemetryBatch>;
    durableAcknowledgement?: DecodedDurableAcknowledgementIntent;
  }>,
  binding: GatewayCredentialBinding,
  acknowledgedAt: UtcInstant,
): CloudLinkDurableAcknowledgementIntent | undefined {
  const intent = decoded.durableAcknowledgement;
  if (intent === undefined) return undefined;
  if (
    intent.credentialGeneration !== binding.generation ||
    String(intent.streamId) !== decoded.batch.streamId ||
    String(intent.streamEpoch) !== decoded.batch.streamEpoch ||
    intent.acceptedTelemetryPosition !== decoded.batch.lastPosition
  ) {
    throw new TelemetryInputError(
      "durable acknowledgement intent does not match the verified telemetry delivery",
    );
  }
  return { ...intent, acknowledgedAt };
}

function durableAcknowledgementMatches(
  acknowledgement: CloudLinkDurableAcknowledgement,
  intent: CloudLinkDurableAcknowledgementIntent,
  binding: GatewayCredentialBinding,
): boolean {
  return (
    acknowledgement.outboxEventId.length >= 8 &&
    acknowledgement.outboxEventId.length <= 128 &&
    acknowledgement.tenantId === binding.tenantId &&
    acknowledgement.projectId === binding.projectId &&
    acknowledgement.gatewayId === binding.gatewayId &&
    acknowledgement.sessionId === intent.sessionId &&
    acknowledgement.sessionEpoch === intent.sessionEpoch &&
    acknowledgement.credentialGeneration === intent.credentialGeneration &&
    acknowledgement.streamId === intent.streamId &&
    acknowledgement.streamEpoch === intent.streamEpoch &&
    acknowledgement.acknowledgedPosition === intent.acknowledgedPosition &&
    acknowledgement.batchId === intent.batchId &&
    acknowledgement.digest === intent.digest &&
    acknowledgement.receiptId.length >= 8 &&
    acknowledgement.receiptId.length <= 128 &&
    acknowledgement.acknowledgedAt <= intent.acknowledgedAt
  );
}

function decodeQueryContext(input: unknown): QueryContext {
  const record = requireRecord(input, "query context");
  requireExactKeys(
    record,
    ["permissions", "projectId", "subjectId", "tenantId"],
    "query context",
  );
  if (
    !Array.isArray(record.permissions) ||
    record.permissions.some((permission) => typeof permission !== "string")
  ) {
    throw new TelemetryInputError("permissions must be an array of strings");
  }
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
    subjectId: requireString(record.subjectId, "subjectId"),
    permissions: new Set(record.permissions),
  };
}

function decodeSafely<Value>(
  decoder: () => Value,
):
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: TelemetryApplicationFailure }> {
  try {
    return { ok: true, value: decoder() };
  } catch (error: unknown) {
    if (
      error instanceof InvalidDomainValueError ||
      error instanceof TelemetryInputError
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
): TelemetryApplicationFailure | undefined {
  if (context.expiresAt <= context.issuedAt || context.issuedAt > now) {
    return { code: "invalid-input", message: "command time window is invalid" };
  }
  if (now >= context.expiresAt) {
    return { code: "command-expired", message: "command has expired" };
  }
  return undefined;
}

async function verifyActiveCredential(
  verifier: GatewayCredentialVerifier,
  assertion: GatewayCredentialAssertion,
): Promise<
  | Readonly<{ ok: true; value: GatewayCredentialBinding }>
  | Readonly<{ ok: false; failure: TelemetryApplicationFailure }>
> {
  const verified = await verifier.verify(assertion);
  if (!verified.ok) {
    return failure(
      "invalid-gateway-credential",
      "Gateway credential was rejected",
    );
  }
  if (verified.value.status !== "active") {
    return failure(
      "gateway-credential-inactive",
      "Gateway credential is not active",
    );
  }
  return verified;
}

function mapPersistenceFailure(
  result: TelemetryPersistenceResult,
): Readonly<{ ok: false; failure: TelemetryApplicationFailure }> {
  switch (result.outcome) {
    case "conflicting-replay":
      return failure(
        "telemetry-conflicting-replay",
        "telemetry batch identity was replayed with different content",
      );
    case "position-conflict":
      return failure(
        "telemetry-position-conflict",
        "telemetry stream position conflicts with persisted history",
      );
    case "quota-exceeded":
      return failure(
        "telemetry-quota-exceeded",
        "telemetry ingestion quota was exceeded",
      );
    case "storage-unavailable":
      return failure(
        "telemetry-storage-unavailable",
        "telemetry persistence is unavailable",
      );
    case "duplicate":
    case "persisted":
      throw new Error("durable telemetry result is not a persistence failure");
  }
}

export class IngestTelemetryBatch {
  static readonly definition = INGEST_TELEMETRY_BATCH_COMMAND;

  readonly #credentialVerifier: GatewayCredentialVerifier;
  readonly #digestor: TelemetryBatchDigestor;
  readonly #repository: TelemetryRepository;
  readonly #clock: ApplicationClock;
  readonly #businessPayloadDigestor:
    | CloudLinkBusinessPayloadDigestor
    | undefined;

  constructor(dependencies: {
    readonly credentialVerifier: GatewayCredentialVerifier;
    readonly digestor: TelemetryBatchDigestor;
    readonly repository: TelemetryRepository;
    readonly clock: ApplicationClock;
    readonly businessPayloadDigestor?: CloudLinkBusinessPayloadDigestor;
  }) {
    this.#credentialVerifier = dependencies.credentialVerifier;
    this.#digestor = dependencies.digestor;
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock;
    this.#businessPayloadDigestor = dependencies.businessPayloadDigestor;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<TelemetryApplicationResult<IngestTelemetryBatchValue>> {
    const decoded = decodeSafely(() => ({
      context: decodeCommandContext(rawContext),
      input: decodeIngestInput(rawInput),
    }));
    if (!decoded.ok) return decoded;
    const now = this.#clock.now();
    const timeFailure = validateCommandTime(decoded.value.context, now);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    const verified =
      decoded.value.input.authentication.kind === "gateway-signed"
        ? {
            ok: true as const,
            value: Object.freeze({
              tenantId: decoded.value.input.authentication.fact.tenantId,
              projectId: decoded.value.input.authentication.fact.projectId,
              gatewayId: decoded.value.input.authentication.fact.gatewayId,
              generation:
                decoded.value.input.authentication.fact.credentialGeneration,
              status: "active" as const,
            }),
          }
        : await verifyActiveCredential(
            this.#credentialVerifier,
            decoded.value.input.authentication.credential,
          );
    if (!verified.ok) return verified;
    if (decoded.value.input.authentication.kind === "gateway-signed") {
      if (this.#businessPayloadDigestor === undefined) {
        return failure(
          "gateway-signed-authentication-invalid",
          "Gateway-signed telemetry validation is unavailable",
        );
      }
      const consumed =
        await validateGatewaySignedCloudLinkAuthenticationConsumption({
          kind: "delivery",
          fact: decoded.value.input.authentication.fact,
          delivery: decoded.value.input.authentication.delivery,
          payload: decoded.value.input.authentication.payload,
          nowMs: String(Date.parse(now)),
          digestor: this.#businessPayloadDigestor,
        });
      if (!consumed.ok) {
        return failure(
          "gateway-signed-authentication-invalid",
          consumed.failure === "MESSAGE_EXPIRED"
            ? "Gateway-signed telemetry delivery expired before consumption"
            : "Gateway-signed telemetry authentication is invalid",
        );
      }
    }
    const payloadDigest = await this.#digestor.digest(
      decoded.value.input.batch,
    );
    if (!sha256Pattern.test(payloadDigest)) {
      return failure(
        "telemetry-digest-invalid",
        "telemetry digest adapter returned an invalid SHA-256 digest",
      );
    }
    const durableAcknowledgement = decodeSafely(() =>
      durableAcknowledgementForPersistence(
        decoded.value.input,
        verified.value,
        now,
      ),
    );
    if (!durableAcknowledgement.ok) return durableAcknowledgement;
    const persisted = await this.#repository.persist({
      requestId: decoded.value.context.requestId,
      binding: verified.value,
      batch: decoded.value.input.batch,
      payloadDigest,
      receivedAt: now,
      ...(durableAcknowledgement.value === undefined
        ? {}
        : { durableAcknowledgement: durableAcknowledgement.value }),
    });
    if (
      persisted.outcome !== "persisted" &&
      persisted.outcome !== "duplicate"
    ) {
      return mapPersistenceFailure(persisted);
    }
    if (
      persisted.receipt.tenantId !== verified.value.tenantId ||
      persisted.receipt.projectId !== verified.value.projectId ||
      persisted.receipt.gatewayId !== verified.value.gatewayId ||
      persisted.receipt.credentialGeneration !== verified.value.generation ||
      persisted.receipt.batchIdentity !==
        decoded.value.input.batch.batchIdentity ||
      persisted.receipt.payloadDigest !== payloadDigest
    ) {
      return failure(
        "invalid-telemetry-repository-result",
        "telemetry repository returned a mismatched durable receipt",
      );
    }
    if (
      (durableAcknowledgement.value === undefined &&
        persisted.durableAcknowledgement !== undefined) ||
      (durableAcknowledgement.value !== undefined &&
        persisted.durableAcknowledgement === undefined) ||
      (durableAcknowledgement.value !== undefined &&
        persisted.durableAcknowledgement !== undefined &&
        !durableAcknowledgementMatches(
          persisted.durableAcknowledgement,
          durableAcknowledgement.value,
          verified.value,
        ))
    ) {
      return failure(
        "invalid-telemetry-repository-result",
        "telemetry repository returned a mismatched durable acknowledgement",
      );
    }
    return {
      ok: true,
      replayed: persisted.outcome === "duplicate",
      value: {
        disposition: persisted.outcome,
        durablyAcknowledged: true,
        receipt: persisted.receipt,
        ...(persisted.durableAcknowledgement === undefined
          ? {}
          : {
              durableAcknowledgement: persisted.durableAcknowledgement,
            }),
      },
    };
  }
}

export class GetTelemetryHistory {
  static readonly definition = GET_TELEMETRY_HISTORY_QUERY;

  readonly #repository: TelemetryRepository;

  constructor(dependencies: { readonly repository: TelemetryRepository }) {
    this.#repository = dependencies.repository;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<TelemetryQueryResult<TelemetryHistoryView>> {
    const decoded = decodeSafely(() => {
      const context = decodeQueryContext(rawContext);
      const input = requireRecord(rawInput, "telemetry history query");
      requireExactKeys(
        input,
        ["fromPosition", "gatewayId", "limit", "streamEpoch", "streamId"],
        "telemetry history query",
      );
      if (
        typeof input.limit !== "number" ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 1000
      ) {
        throw new TelemetryInputError(
          "limit must be an integer from 1 to 1000",
        );
      }
      return {
        context,
        query: {
          tenantId: context.tenantId,
          projectId: context.projectId,
          gatewayId: parseGatewayId(input.gatewayId),
          streamId: parseTelemetryStreamId(input.streamId),
          streamEpoch: parseTelemetryStreamEpoch(input.streamEpoch),
          fromPosition: parseTelemetryStreamPosition(input.fromPosition),
          limit: input.limit,
        },
      };
    });
    if (!decoded.ok) return decoded;
    if (
      !decoded.value.context.permissions.has(
        GET_TELEMETRY_HISTORY_QUERY.permission,
      )
    ) {
      return failure(
        "permission-denied",
        `permission ${GET_TELEMETRY_HISTORY_QUERY.permission} is required`,
      );
    }
    let records: readonly PersistedTelemetryRecord[];
    try {
      records = await this.#repository.queryHistory(decoded.value.query);
    } catch (error: unknown) {
      if (error instanceof TelemetryStorageUnavailableError) {
        return failure(
          "telemetry-storage-unavailable",
          "telemetry persistence is unavailable",
        );
      }
      throw error;
    }
    if (
      records.some(
        (record) =>
          record.tenantId !== decoded.value.query.tenantId ||
          record.projectId !== decoded.value.query.projectId ||
          record.gatewayId !== decoded.value.query.gatewayId ||
          record.streamId !== decoded.value.query.streamId ||
          record.streamEpoch !== decoded.value.query.streamEpoch,
      )
    ) {
      return failure(
        "invalid-telemetry-repository-result",
        "telemetry repository returned records outside the requested scope",
      );
    }
    return {
      ok: true,
      value: {
        authority: "edge-reported-history-copy",
        liveStateAuthoritative: false,
        records,
      },
    };
  }
}
