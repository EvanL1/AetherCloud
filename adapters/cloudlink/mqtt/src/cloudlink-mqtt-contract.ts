import { createHash } from "node:crypto";

import {
  IntegrationWireError,
  StrictJsonError,
  decodeIntegrationObservationPayloadInput,
  decodeIntegrationTopologyPayload,
  decodeStrictJson,
} from "@aether-cloud/integration-aether-contracts-adapter";

const protocol = "aether.cloudlink" as const;
const protocolVersion = "1.0" as const;
const integrationExtension = "aether.cloudlink.integration.v1alpha1" as const;
const integrationControlExtension =
  "aether.cloudlink.integration-control.v1alpha1" as const;
const maximumDefaultPayloadBytes = 256 * 1024;
const maximumPointSamples = 256;
const maximumUint64 = 18_446_744_073_709_551_615n;
const canonicalUint64Pattern = /^(?:0|[1-9][0-9]*)$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const topicSegmentPattern = /^[A-Za-z0-9._-]+$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const topologyDigestPattern = /^(?:fx64:[0-9a-f]{16}|sha256:[0-9a-f]{64})$/;
const traceparentPattern =
  /^(?!ff)[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;
const semverPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const unpaddedBase64UrlPattern = /^[A-Za-z0-9_-]+$/;

type JsonRecord = Record<string, unknown>;

export interface CloudLinkMqttDecodeOptions {
  readonly topicPrefix: string;
  readonly maximumPayloadBytes?: number;
  readonly enabledExtensions?: readonly CloudLinkExtension[];
}

export type CloudLinkExtension =
  | typeof integrationControlExtension
  | typeof integrationExtension;

export type CloudLinkMqttDecodeFailureCode =
  | "digest-mismatch"
  | "invalid-json"
  | "invalid-payload"
  | "invalid-topic"
  | "invalid-topic-binding"
  | "payload-too-large"
  | "unsupported-contract-version"
  | "unsupported-message";

/** Stable string codes from the pinned AetherContracts alpha.3 taxonomy. */
export type CloudLinkContractFailureCode =
  | "AUTHENTICATION_INVALID"
  | "AUTHENTICATION_REQUIRED"
  | "BATCH_ID_MISMATCH"
  | "CURSOR_CONFLICT"
  | "DIGEST_MISMATCH"
  | "DUPLICATE_JSON_KEY"
  | "FIELD_BOUND"
  | "IDENTITY_CONFLICT"
  | "INTEGER_NON_CANONICAL"
  | "INTEGER_OUT_OF_RANGE"
  | "INVALID_ARGUMENT"
  | "INVALID_DIGEST"
  | "JSON_INVALID_UNICODE"
  | "JSON_NON_FINITE_NUMBER"
  | "JSON_SYNTAX_ERROR"
  | "JSON_UNSAFE_NUMBER"
  | "MANIFEST_INVALID"
  | "OBSERVATION_VALUE_INVALID"
  | "REFERENCE_NOT_FOUND"
  | "SEMVER_INVALID"
  | "TEXT_INVALID"
  | "UNKNOWN_FIELD"
  | "UNSUPPORTED_VERSION"
  | "VALUE_ENCODING_INVALID"
  | "VALUE_TYPE_MISMATCH";

export type CloudLinkMqttDecodeResult =
  | Readonly<{ ok: true; value: CloudLinkContractMessage }>
  | Readonly<{
      ok: false;
      failure: Readonly<{
        code: CloudLinkMqttDecodeFailureCode;
        contract_code: CloudLinkContractFailureCode;
        message: string;
      }>;
    }>;

export interface CloudLinkResumeCursor {
  readonly stream_id: string;
  readonly stream_epoch: string;
  readonly acknowledged_position: string;
}

export interface CloudLinkCredentialBinding {
  readonly credential_id: string;
  readonly generation: string;
  readonly origin_model:
    | "gateway-signed"
    | "trusted-connector-broker-attestation";
}

export interface CloudLinkMessageAuthentication {
  readonly key_id: string;
  readonly algorithm: "Ed25519";
  readonly signature: string;
}

export interface CloudLinkSessionHello {
  readonly schema: "aether.cloudlink.session-hello.v1";
  readonly protocol: typeof protocol;
  readonly message_kind: "session-hello";
  readonly gateway_id: string;
  readonly credential_binding: CloudLinkCredentialBinding;
  readonly challenge_id: string;
  readonly gateway_key_id?: string;
  readonly gateway_signature?: CloudLinkMessageAuthentication;
  readonly offered_protocol_versions: readonly string[];
  readonly client_nonce: string;
  readonly resume: readonly CloudLinkResumeCursor[];
}

export interface CloudLinkSessionChallengeRequest {
  readonly schema: "aether.cloudlink.session-challenge-request.v1";
  readonly protocol: typeof protocol;
  readonly message_kind: "session-challenge-request";
  readonly gateway_id: string;
  readonly credential_binding: Readonly<{
    credential_id: string;
    generation: string;
  }>;
  readonly offered_protocol_versions: readonly string[];
  readonly client_nonce: string;
  readonly resume: readonly CloudLinkResumeCursor[];
}

export interface CloudLinkSessionChallenge {
  readonly schema: "aether.cloudlink.session-challenge.v1";
  readonly protocol: typeof protocol;
  readonly message_kind: "session-challenge";
  readonly gateway_id: string;
  readonly challenge_id: string;
  readonly cloud_nonce: string;
  readonly issued_at_ms: string;
  readonly expires_at_ms: string;
  readonly cloud_signature: CloudLinkMessageAuthentication;
}

export interface CloudLinkSessionAccepted {
  readonly schema: "aether.cloudlink.session-accepted.v1";
  readonly protocol: typeof protocol;
  readonly message_kind: "session-accepted";
  readonly gateway_id: string;
  readonly selected_protocol_version: typeof protocolVersion;
  readonly session_id: string;
  readonly session_epoch: string;
  readonly credential_generation: string;
  readonly server_time_ms: string;
  readonly heartbeat_interval_ms: string;
  readonly resume: readonly CloudLinkResumeCursor[];
}

export interface CloudLinkHeartbeat {
  readonly schema: "aether.cloudlink.heartbeat.v1";
  readonly protocol: typeof protocol;
  readonly protocol_version: typeof protocolVersion;
  readonly message_kind: "heartbeat" | "heartbeat-ack";
  readonly gateway_id: string;
  readonly session_id: string;
  readonly session_epoch: string;
  readonly credential_generation: string;
  readonly observed_at_ms: string;
  readonly cursors: readonly CloudLinkResumeCursor[];
  readonly message_authentication?: CloudLinkMessageAuthentication;
}

export interface CloudLinkDeliveryDescriptor {
  readonly stream_id: string;
  readonly stream_epoch: string;
  readonly position: string;
  readonly batch_id: string;
  readonly digest: string;
}

export interface CloudLinkTopologyBinding {
  readonly publication_epoch: string;
  readonly snapshot_digest: string;
}

export interface CloudLinkPointModelBinding {
  readonly model_id: string;
  readonly revision: string;
}

export interface CloudLinkPointFact {
  readonly instance_id: string;
  readonly point_kind: "status" | "telemetry";
  readonly point_id: string;
  readonly value: number;
  readonly source_timestamp_ms: string;
  readonly quality: "bad" | "good" | "uncertain" | "unavailable";
  readonly model?: CloudLinkPointModelBinding;
}

export interface CloudLinkRuntimeManifestPayload {
  readonly observed_at_ms: string;
  readonly manifest: JsonRecord;
}

export interface CloudLinkTelemetryPayload {
  readonly topology: CloudLinkTopologyBinding;
  readonly samples: readonly CloudLinkPointFact[];
}

export interface CloudLinkDataLossPayload {
  readonly stream_id: string;
  readonly stream_epoch: string;
  readonly first_lost_position: string;
  readonly last_lost_position: string;
  readonly earliest_retained_position: string;
  readonly reason: string;
  readonly recorded_at_ms: string;
}

export type CloudLinkIntegrationTopologyPayload = Readonly<
  Record<string, unknown>
>;

export type CloudLinkIntegrationObservationPayload = Readonly<
  Record<string, unknown>
>;

interface CloudLinkDeliveryEnvelopeBase {
  readonly schema: "aether.cloudlink.envelope.v1";
  readonly protocol: typeof protocol;
  readonly protocol_version: typeof protocolVersion;
  readonly gateway_id: string;
  readonly session_id: string;
  readonly session_epoch: string;
  readonly credential_generation: string;
  readonly sent_at_ms: string;
  readonly expires_at_ms?: string;
  readonly delivery: CloudLinkDeliveryDescriptor;
  readonly message_authentication?: CloudLinkMessageAuthentication;
  readonly traceparent?: string;
}

export type CloudLinkDeliveryEnvelope =
  | (CloudLinkDeliveryEnvelopeBase &
      Readonly<{
        message_kind: "data-loss";
        payload: CloudLinkDataLossPayload;
      }>)
  | (CloudLinkDeliveryEnvelopeBase &
      Readonly<{
        message_kind: "runtime-manifest-report";
        payload: CloudLinkRuntimeManifestPayload;
      }>)
  | (CloudLinkDeliveryEnvelopeBase &
      Readonly<{
        message_kind: "telemetry-batch";
        payload: CloudLinkTelemetryPayload;
      }>)
  | (CloudLinkDeliveryEnvelopeBase &
      Readonly<{
        message_kind: "integration-topology-snapshot";
        payload: CloudLinkIntegrationTopologyPayload;
      }>)
  | (CloudLinkDeliveryEnvelopeBase &
      Readonly<{
        message_kind: "integration-observation-batch";
        payload: CloudLinkIntegrationObservationPayload;
      }>);

export interface CloudLinkDurableAck {
  readonly schema: "aether.cloudlink.durable-ack.v1";
  readonly protocol: typeof protocol;
  readonly protocol_version: typeof protocolVersion;
  readonly message_kind: "durable-ack";
  readonly gateway_id: string;
  readonly session_id: string;
  readonly session_epoch: string;
  readonly credential_generation: string;
  readonly stream_id: string;
  readonly stream_epoch: string;
  readonly acknowledged_position: string;
  readonly batch_id: string;
  readonly digest: string;
  readonly receipt_id: string;
  readonly acknowledged_at_ms: string;
}

export interface CloudLinkReplayRequest {
  readonly schema: "aether.cloudlink.replay-request.v1";
  readonly protocol: typeof protocol;
  readonly protocol_version: typeof protocolVersion;
  readonly message_kind: "replay-request";
  readonly gateway_id: string;
  readonly session_id: string;
  readonly session_epoch: string;
  readonly credential_generation: string;
  readonly stream_id: string;
  readonly stream_epoch: string;
  readonly from_position: string;
  readonly requested_at_ms: string;
}

export type CloudLinkMqttInbound =
  | CloudLinkDeliveryEnvelope
  | (CloudLinkHeartbeat & Readonly<{ message_kind: "heartbeat" }>)
  | CloudLinkSessionChallengeRequest
  | CloudLinkSessionHello;

export type CloudLinkMqttInboundDecodeResult =
  | Readonly<{ ok: true; value: CloudLinkMqttInbound }>
  | Readonly<{
      ok: false;
      failure: Readonly<{
        code: CloudLinkMqttDecodeFailureCode;
        contract_code: CloudLinkContractFailureCode;
        message: string;
      }>;
    }>;

export type CloudLinkMqttOutbound =
  | CloudLinkDurableAck
  | (CloudLinkHeartbeat & Readonly<{ message_kind: "heartbeat-ack" }>)
  | CloudLinkReplayRequest
  | CloudLinkSessionAccepted
  | CloudLinkSessionChallenge;

export type CloudLinkContractMessage =
  | CloudLinkDeliveryEnvelope
  | CloudLinkDurableAck
  | CloudLinkHeartbeat
  | CloudLinkReplayRequest
  | CloudLinkSessionAccepted
  | CloudLinkSessionChallenge
  | CloudLinkSessionChallengeRequest
  | CloudLinkSessionHello;

class ContractInputError extends Error {
  readonly code: CloudLinkMqttDecodeFailureCode;
  readonly contractCode: CloudLinkContractFailureCode;

  constructor(
    message: string,
    code: CloudLinkMqttDecodeFailureCode = "invalid-payload",
    contractCode: CloudLinkContractFailureCode = defaultContractFailureCode(
      code,
    ),
  ) {
    super(message);
    this.code = code;
    this.contractCode = contractCode;
  }
}

function defaultContractFailureCode(
  code: CloudLinkMqttDecodeFailureCode,
): CloudLinkContractFailureCode {
  switch (code) {
    case "digest-mismatch":
      return "DIGEST_MISMATCH";
    case "invalid-json":
      return "JSON_SYNTAX_ERROR";
    case "payload-too-large":
    case "invalid-payload":
      return "FIELD_BOUND";
    case "unsupported-contract-version":
    case "unsupported-message":
      return "UNSUPPORTED_VERSION";
    case "invalid-topic":
    case "invalid-topic-binding":
      return "INVALID_ARGUMENT";
  }
}

function failure(
  code: CloudLinkMqttDecodeFailureCode,
  message: string,
  contractCode: CloudLinkContractFailureCode = defaultContractFailureCode(code),
): CloudLinkMqttDecodeResult {
  return { ok: false, failure: { code, contract_code: contractCode, message } };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, name: string): JsonRecord {
  if (!isRecord(value)) {
    throw new ContractInputError(`${name} must be an object`);
  }
  return value;
}

function requireExactKeys(
  record: JsonRecord,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(record).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new ContractInputError(
      `${name} must contain exactly: ${canonical.join(", ")}`,
      "invalid-payload",
      "UNKNOWN_FIELD",
    );
  }
}

function requireString(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new ContractInputError(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function requireIdentifier(
  value: unknown,
  name: string,
  maximum = 128,
): string {
  const decoded = requireString(value, name, maximum);
  if (!identifierPattern.test(decoded)) {
    throw new ContractInputError(`${name} must be a transport-safe identifier`);
  }
  return decoded;
}

function requireUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ContractInputError(`${name} must be a canonical lowercase UUID`);
  }
  return value;
}

function requireUint64(value: unknown, name: string, positive = false): string {
  if (typeof value !== "string" || value.length > 20) {
    throw new ContractInputError(
      `${name} must fit uint64`,
      "invalid-payload",
      "INTEGER_OUT_OF_RANGE",
    );
  }
  if (!canonicalUint64Pattern.test(value)) {
    throw new ContractInputError(
      `${name} must be a canonical uint64 string`,
      "invalid-payload",
      "INTEGER_NON_CANONICAL",
    );
  }
  if (BigInt(value) > maximumUint64) {
    throw new ContractInputError(
      `${name} must fit uint64`,
      "invalid-payload",
      "INTEGER_OUT_OF_RANGE",
    );
  }
  if (positive && value === "0") {
    throw new ContractInputError(
      `${name} must be a canonical positive uint64 string`,
    );
  }
  return value;
}

function requireDigest(value: unknown, name: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new ContractInputError(
      `${name} must be a lowercase SHA-256 digest`,
      "invalid-payload",
      "INVALID_DIGEST",
    );
  }
  return value;
}

function decodeProtocol(record: JsonRecord): void {
  if (record.protocol !== protocol) {
    throw new ContractInputError("CloudLink protocol family is unsupported");
  }
}

function decodeVersion(record: JsonRecord): void {
  if (record.protocol_version !== protocolVersion) {
    throw new ContractInputError(
      "CloudLink protocol version is unsupported",
      "unsupported-contract-version",
    );
  }
}

function decodeResume(
  value: unknown,
  name: string,
): readonly CloudLinkResumeCursor[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new ContractInputError(`${name} must contain at most 32 cursors`);
  }
  const identities = new Set<string>();
  return value.map((entry) => {
    const record = requireRecord(entry, name);
    requireExactKeys(
      record,
      ["acknowledged_position", "stream_epoch", "stream_id"],
      name,
    );
    const streamId = requireIdentifier(record.stream_id, `${name}.stream_id`);
    const streamEpoch = requireUint64(
      record.stream_epoch,
      `${name}.stream_epoch`,
      true,
    );
    const identity = `${streamId}\u0000${streamEpoch}`;
    if (identities.has(identity)) {
      throw new ContractInputError(
        `${name} must use unique stream/epoch identities`,
        "invalid-payload",
        "CURSOR_CONFLICT",
      );
    }
    identities.add(identity);
    return {
      stream_id: streamId,
      stream_epoch: streamEpoch,
      acknowledged_position: requireUint64(
        record.acknowledged_position,
        `${name}.acknowledged_position`,
      ),
    };
  });
}

function decodeMessageAuthentication(
  value: unknown,
  name: string,
  requireCanonicalEncoding = false,
): CloudLinkMessageAuthentication {
  const record = requireRecord(value, name);
  requireExactKeys(record, ["algorithm", "key_id", "signature"], name);
  const signature = requireString(record.signature, `${name}.signature`, 86);
  if (
    record.algorithm !== "Ed25519" ||
    signature.length !== 86 ||
    !unpaddedBase64UrlPattern.test(signature) ||
    (requireCanonicalEncoding &&
      (() => {
        const bytes = Buffer.from(signature, "base64url");
        return bytes.length !== 64 || bytes.toString("base64url") !== signature;
      })())
  ) {
    throw new ContractInputError(
      `${name} must be an Ed25519 base64url signature`,
      "invalid-payload",
      "AUTHENTICATION_INVALID",
    );
  }
  return {
    key_id: requireIdentifier(record.key_id, `${name}.key_id`),
    algorithm: "Ed25519",
    signature,
  };
}

function decodeSessionHello(record: JsonRecord): CloudLinkSessionHello {
  requireExactKeys(
    record,
    [
      "client_nonce",
      "challenge_id",
      "credential_binding",
      ...(record.gateway_key_id === undefined ? [] : ["gateway_key_id"]),
      ...(record.gateway_signature === undefined ? [] : ["gateway_signature"]),
      "gateway_id",
      "message_kind",
      "offered_protocol_versions",
      "protocol",
      "resume",
      "schema",
    ],
    "session hello",
  );
  decodeProtocol(record);
  if (
    record.schema !== "aether.cloudlink.session-hello.v1" ||
    record.message_kind !== "session-hello"
  ) {
    throw new ContractInputError("session hello discriminator is invalid");
  }
  const credential = requireRecord(
    record.credential_binding,
    "credential binding",
  );
  requireExactKeys(
    credential,
    ["credential_id", "generation", "origin_model"],
    "credential binding",
  );
  if (
    !Array.isArray(record.offered_protocol_versions) ||
    record.offered_protocol_versions.length === 0 ||
    record.offered_protocol_versions.length > 8 ||
    record.offered_protocol_versions.some(
      (version) => version !== protocolVersion,
    )
  ) {
    throw new ContractInputError(
      "offered_protocol_versions must contain supported unique versions",
    );
  }
  const offered = record.offered_protocol_versions as string[];
  if (new Set(offered).size !== offered.length) {
    throw new ContractInputError("offered_protocol_versions must be unique");
  }
  if (
    credential.origin_model !== "gateway-signed" &&
    credential.origin_model !== "trusted-connector-broker-attestation"
  ) {
    throw new ContractInputError("credential origin model is unsupported");
  }
  const gatewaySigned = credential.origin_model === "gateway-signed";
  if (
    gatewaySigned !==
    (record.gateway_key_id !== undefined &&
      record.gateway_signature !== undefined)
  ) {
    throw new ContractInputError(
      "gateway-signed origin requires exactly one Gateway key and signature",
      "invalid-payload",
      gatewaySigned ? "AUTHENTICATION_REQUIRED" : "AUTHENTICATION_INVALID",
    );
  }
  const gatewaySignature = gatewaySigned
    ? decodeMessageAuthentication(record.gateway_signature, "gateway signature")
    : undefined;
  const gatewayKeyId = gatewaySigned
    ? requireIdentifier(record.gateway_key_id, "gateway_key_id")
    : undefined;
  if (
    gatewaySignature !== undefined &&
    gatewaySignature.key_id !== gatewayKeyId
  ) {
    throw new ContractInputError(
      "Gateway signature key binding is inconsistent",
      "invalid-payload",
      "AUTHENTICATION_INVALID",
    );
  }
  return {
    schema: "aether.cloudlink.session-hello.v1",
    protocol,
    message_kind: "session-hello",
    gateway_id: requireUuid(record.gateway_id, "gateway_id"),
    credential_binding: {
      credential_id: requireIdentifier(
        credential.credential_id,
        "credential_id",
        256,
      ),
      generation: requireUint64(
        credential.generation,
        "credential generation",
        true,
      ),
      origin_model: credential.origin_model,
    },
    challenge_id: requireUuid(record.challenge_id, "challenge_id"),
    ...(gatewayKeyId === undefined ? {} : { gateway_key_id: gatewayKeyId }),
    ...(gatewaySignature === undefined
      ? {}
      : { gateway_signature: gatewaySignature }),
    offered_protocol_versions: Object.freeze([...offered]),
    client_nonce: (() => {
      const nonce = requireString(record.client_nonce, "client_nonce", 43);
      if (nonce.length !== 43 || !unpaddedBase64UrlPattern.test(nonce)) {
        throw new ContractInputError("client_nonce must be 32-byte base64url");
      }
      return nonce;
    })(),
    resume: decodeResume(record.resume, "resume"),
  };
}

function decodeSessionChallengeRequest(
  record: JsonRecord,
): CloudLinkSessionChallengeRequest {
  requireExactKeys(
    record,
    [
      "client_nonce",
      "credential_binding",
      "gateway_id",
      "message_kind",
      "offered_protocol_versions",
      "protocol",
      "resume",
      "schema",
    ],
    "session challenge request",
  );
  decodeProtocol(record);
  if (
    record.schema !== "aether.cloudlink.session-challenge-request.v1" ||
    record.message_kind !== "session-challenge-request"
  ) {
    throw new ContractInputError(
      "session challenge request discriminator is invalid",
    );
  }
  const credential = requireRecord(
    record.credential_binding,
    "credential binding",
  );
  requireExactKeys(
    credential,
    ["credential_id", "generation"],
    "credential binding",
  );
  if (
    !Array.isArray(record.offered_protocol_versions) ||
    record.offered_protocol_versions.length === 0 ||
    record.offered_protocol_versions.length > 8 ||
    record.offered_protocol_versions.some(
      (version) => version !== protocolVersion,
    )
  ) {
    throw new ContractInputError(
      "offered_protocol_versions must contain supported unique versions",
    );
  }
  const offered = record.offered_protocol_versions as string[];
  if (new Set(offered).size !== offered.length) {
    throw new ContractInputError("offered_protocol_versions must be unique");
  }
  const clientNonce = requireString(record.client_nonce, "client_nonce", 43);
  if (
    clientNonce.length !== 43 ||
    !unpaddedBase64UrlPattern.test(clientNonce)
  ) {
    throw new ContractInputError("client_nonce must be 32-byte base64url");
  }
  return {
    schema: "aether.cloudlink.session-challenge-request.v1",
    protocol,
    message_kind: "session-challenge-request",
    gateway_id: requireUuid(record.gateway_id, "gateway_id"),
    credential_binding: {
      credential_id: requireIdentifier(
        credential.credential_id,
        "credential_id",
        256,
      ),
      generation: requireUint64(
        credential.generation,
        "credential generation",
        true,
      ),
    },
    offered_protocol_versions: Object.freeze([...offered]),
    client_nonce: clientNonce,
    resume: decodeResume(record.resume, "resume"),
  };
}

function decodeSessionChallenge(record: JsonRecord): CloudLinkSessionChallenge {
  requireExactKeys(
    record,
    [
      "challenge_id",
      "cloud_nonce",
      "cloud_signature",
      "expires_at_ms",
      "gateway_id",
      "issued_at_ms",
      "message_kind",
      "protocol",
      "schema",
    ],
    "session challenge",
  );
  decodeProtocol(record);
  if (
    record.schema !== "aether.cloudlink.session-challenge.v1" ||
    record.message_kind !== "session-challenge"
  ) {
    throw new ContractInputError("session challenge discriminator is invalid");
  }
  const cloudNonce = requireString(record.cloud_nonce, "cloud_nonce", 43);
  if (cloudNonce.length !== 43 || !unpaddedBase64UrlPattern.test(cloudNonce)) {
    throw new ContractInputError("cloud_nonce must be 32-byte base64url");
  }
  const issuedAt = requireUint64(record.issued_at_ms, "issued_at_ms");
  const expiresAt = requireUint64(record.expires_at_ms, "expires_at_ms");
  if (BigInt(expiresAt) < BigInt(issuedAt)) {
    throw new ContractInputError(
      "challenge expiry must not precede issue time",
    );
  }
  return {
    schema: "aether.cloudlink.session-challenge.v1",
    protocol,
    message_kind: "session-challenge",
    gateway_id: requireUuid(record.gateway_id, "gateway_id"),
    challenge_id: requireUuid(record.challenge_id, "challenge_id"),
    cloud_nonce: cloudNonce,
    issued_at_ms: issuedAt,
    expires_at_ms: expiresAt,
    cloud_signature: decodeMessageAuthentication(
      record.cloud_signature,
      "cloud signature",
    ),
  };
}

function decodeSessionAccepted(record: JsonRecord): CloudLinkSessionAccepted {
  requireExactKeys(
    record,
    [
      "credential_generation",
      "gateway_id",
      "heartbeat_interval_ms",
      "message_kind",
      "protocol",
      "resume",
      "schema",
      "selected_protocol_version",
      "server_time_ms",
      "session_epoch",
      "session_id",
    ],
    "session accepted",
  );
  decodeProtocol(record);
  if (
    record.schema !== "aether.cloudlink.session-accepted.v1" ||
    record.message_kind !== "session-accepted" ||
    record.selected_protocol_version !== protocolVersion
  ) {
    throw new ContractInputError(
      "session acceptance protocol version is unsupported",
      "unsupported-contract-version",
    );
  }
  return {
    schema: "aether.cloudlink.session-accepted.v1",
    protocol,
    message_kind: "session-accepted",
    gateway_id: requireUuid(record.gateway_id, "gateway_id"),
    selected_protocol_version: protocolVersion,
    session_id: requireUuid(record.session_id, "session_id"),
    session_epoch: requireUint64(record.session_epoch, "session_epoch", true),
    credential_generation: requireUint64(
      record.credential_generation,
      "credential_generation",
      true,
    ),
    server_time_ms: requireUint64(record.server_time_ms, "server_time_ms"),
    heartbeat_interval_ms: requireUint64(
      record.heartbeat_interval_ms,
      "heartbeat_interval_ms",
      true,
    ),
    resume: decodeResume(record.resume, "resume"),
  };
}

function decodeHeartbeat(record: JsonRecord): CloudLinkHeartbeat {
  const hasAuthentication = record.message_authentication !== undefined;
  requireExactKeys(
    record,
    [
      "credential_generation",
      "cursors",
      "gateway_id",
      "message_kind",
      ...(hasAuthentication ? ["message_authentication"] : []),
      "observed_at_ms",
      "protocol",
      "protocol_version",
      "schema",
      "session_epoch",
      "session_id",
    ],
    "heartbeat",
  );
  decodeProtocol(record);
  decodeVersion(record);
  if (
    record.schema !== "aether.cloudlink.heartbeat.v1" ||
    !(
      record.message_kind === "heartbeat" ||
      record.message_kind === "heartbeat-ack"
    )
  ) {
    throw new ContractInputError("heartbeat discriminator is invalid");
  }
  return {
    schema: "aether.cloudlink.heartbeat.v1",
    protocol,
    protocol_version: protocolVersion,
    message_kind: record.message_kind,
    gateway_id: requireUuid(record.gateway_id, "gateway_id"),
    session_id: requireUuid(record.session_id, "session_id"),
    session_epoch: requireUint64(record.session_epoch, "session_epoch", true),
    credential_generation: requireUint64(
      record.credential_generation,
      "credential_generation",
      true,
    ),
    observed_at_ms: requireUint64(record.observed_at_ms, "observed_at_ms"),
    cursors: decodeResume(record.cursors, "cursors"),
    ...(hasAuthentication
      ? {
          message_authentication: decodeMessageAuthentication(
            record.message_authentication,
            "message_authentication",
            true,
          ),
        }
      : {}),
  };
}

function decodeRuntimeManifest(value: unknown): JsonRecord {
  const manifest = requireRecord(value, "runtime manifest");
  requireExactKeys(
    manifest,
    [
      "aether_version",
      "capabilities",
      "cargo_features",
      "checksum",
      "composition",
      "protocols",
      "schema_version",
      "services",
      "target_os",
      "target_triple",
    ],
    "runtime manifest",
  );
  if (manifest.schema_version !== 1) {
    throw new ContractInputError(
      "runtime manifest schema version is unsupported",
    );
  }
  for (const field of ["composition", "target_os", "target_triple"] as const) {
    requireIdentifier(manifest[field], `manifest.${field}`);
  }
  const aetherVersion = requireString(
    manifest.aether_version,
    "manifest.aether_version",
    128,
  );
  if (!semverPattern.test(aetherVersion)) {
    throw new ContractInputError(
      "manifest.aether_version must be strict SemVer 2.0.0",
      "invalid-payload",
      "SEMVER_INVALID",
    );
  }
  for (const field of ["capabilities", "protocols", "services"] as const) {
    if (!Array.isArray(manifest[field])) {
      throw new ContractInputError(`manifest.${field} must be an array`);
    }
    for (const item of manifest[field]) {
      requireIdentifier(item, `manifest.${field}`);
    }
  }
  if (!Array.isArray(manifest.cargo_features)) {
    throw new ContractInputError("manifest.cargo_features must be an array");
  }
  for (const feature of manifest.cargo_features) {
    const decoded = requireString(feature, "manifest.cargo_features", 256);
    if (!/^aether-io\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(decoded)) {
      throw new ContractInputError("manifest.cargo_features is invalid");
    }
  }
  if (
    (manifest.services as unknown[]).length === 0 ||
    (manifest.protocols as unknown[]).length === 0
  ) {
    throw new ContractInputError(
      "runtime manifest services/protocols cannot be empty",
    );
  }
  const checksum = requireRecord(manifest.checksum, "manifest checksum");
  requireExactKeys(checksum, ["algorithm", "digest"], "manifest checksum");
  if (
    checksum.algorithm !== "sha256" ||
    typeof checksum.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(checksum.digest)
  ) {
    throw new ContractInputError("runtime manifest checksum is invalid");
  }
  const unsigned = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== "checksum"),
  );
  const actual = createHash("sha256")
    .update(canonicalize(unsigned))
    .digest("hex");
  if (actual !== checksum.digest) {
    throw new ContractInputError(
      "runtime manifest checksum does not match content",
    );
  }
  return manifest;
}

function decodePointFact(value: unknown): CloudLinkPointFact {
  const record = requireRecord(value, "point sample");
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
    "point sample",
  );
  if (!(record.point_kind === "status" || record.point_kind === "telemetry")) {
    throw new ContractInputError("point_kind must be acquisition-owned");
  }
  if (
    !(
      record.quality === "bad" ||
      record.quality === "good" ||
      record.quality === "uncertain" ||
      record.quality === "unavailable"
    )
  ) {
    throw new ContractInputError("point quality is unsupported");
  }
  if (typeof record.value !== "number" || !Number.isFinite(record.value)) {
    throw new ContractInputError("point value must be a finite float64");
  }
  const instanceId = requireUint64(record.instance_id, "instance_id");
  const pointId = requireUint64(record.point_id, "point_id");
  if (BigInt(instanceId) > 4_294_967_295n || BigInt(pointId) > 4_294_967_295n) {
    throw new ContractInputError("point identity must fit Edge uint32 values");
  }
  let model: CloudLinkPointModelBinding | undefined;
  if (record.model !== undefined) {
    const decoded = requireRecord(record.model, "model binding");
    requireExactKeys(decoded, ["model_id", "revision"], "model binding");
    model = {
      model_id: requireIdentifier(decoded.model_id, "model_id"),
      revision: requireUint64(decoded.revision, "model revision", true),
    };
  }
  return {
    instance_id: instanceId,
    point_kind: record.point_kind,
    point_id: pointId,
    value: record.value,
    source_timestamp_ms: requireUint64(
      record.source_timestamp_ms,
      "source_timestamp_ms",
    ),
    quality: record.quality,
    ...(model === undefined ? {} : { model }),
  };
}

function rethrowIntegrationWireFailure(error: unknown): never {
  if (error instanceof StrictJsonError) {
    const contractCode: CloudLinkContractFailureCode =
      error.code === "FIELD_BOUND" ? "FIELD_BOUND" : error.code;
    throw new ContractInputError(
      "Integration payload is invalid",
      error.code === "JSON_SYNTAX_ERROR" ? "invalid-json" : "invalid-payload",
      contractCode,
    );
  }
  if (error instanceof IntegrationWireError) {
    let contractCode: CloudLinkContractFailureCode;
    switch (error.code) {
      case "FIELD_TYPE":
      case "REQUIRED_FIELD_MISSING":
        contractCode = "FIELD_BOUND";
        break;
      case "SCHEMA_UNSUPPORTED":
        contractCode = "UNSUPPORTED_VERSION";
        break;
      default:
        contractCode = error.code;
        break;
    }
    throw new ContractInputError(
      "Integration payload is invalid",
      contractCode === "UNSUPPORTED_VERSION"
        ? "unsupported-contract-version"
        : "invalid-payload",
      contractCode,
    );
  }
  throw error;
}

function decodeIntegrationPayload(
  kind: "integration-observation-batch" | "integration-topology-snapshot",
  payload: JsonRecord,
): JsonRecord {
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  try {
    if (kind === "integration-topology-snapshot") {
      decodeIntegrationTopologyPayload(encoded, {
        maxBytes: maximumDefaultPayloadBytes,
      });
    } else {
      decodeIntegrationObservationPayloadInput(encoded, {
        maxBytes: maximumDefaultPayloadBytes,
      });
    }
    return payload;
  } catch (error: unknown) {
    return rethrowIntegrationWireFailure(error);
  }
}

function decodeBusinessPayload(
  kind: CloudLinkDeliveryEnvelope["message_kind"],
  value: unknown,
): CloudLinkDeliveryEnvelope["payload"] {
  const payload = requireRecord(value, `${kind} payload`);
  if (
    kind === "integration-topology-snapshot" ||
    kind === "integration-observation-batch"
  ) {
    return decodeIntegrationPayload(kind, payload);
  }
  if (kind === "runtime-manifest-report") {
    requireExactKeys(
      payload,
      ["manifest", "observed_at_ms"],
      "manifest payload",
    );
    return {
      observed_at_ms: requireUint64(payload.observed_at_ms, "observed_at_ms"),
      manifest: decodeRuntimeManifest(payload.manifest),
    };
  }
  if (kind === "telemetry-batch") {
    requireExactKeys(payload, ["samples", "topology"], "telemetry payload");
    const topology = requireRecord(payload.topology, "topology binding");
    requireExactKeys(
      topology,
      ["publication_epoch", "snapshot_digest"],
      "topology binding",
    );
    if (
      !Array.isArray(payload.samples) ||
      payload.samples.length === 0 ||
      payload.samples.length > maximumPointSamples
    ) {
      throw new ContractInputError("samples must contain 1-256 point facts");
    }
    const snapshotDigest = requireString(
      topology.snapshot_digest,
      "topology.snapshot_digest",
      71,
    );
    if (!topologyDigestPattern.test(snapshotDigest)) {
      throw new ContractInputError("topology snapshot digest is invalid");
    }
    return {
      topology: {
        publication_epoch: requireUint64(
          topology.publication_epoch,
          "topology.publication_epoch",
          true,
        ),
        snapshot_digest: snapshotDigest,
      },
      samples: payload.samples.map(decodePointFact),
    };
  }
  requireExactKeys(
    payload,
    [
      "earliest_retained_position",
      "first_lost_position",
      "last_lost_position",
      "reason",
      "recorded_at_ms",
      "stream_epoch",
      "stream_id",
    ],
    "data-loss payload",
  );
  const first = requireUint64(
    payload.first_lost_position,
    "first_lost_position",
    true,
  );
  const last = requireUint64(
    payload.last_lost_position,
    "last_lost_position",
    true,
  );
  const earliest = requireUint64(
    payload.earliest_retained_position,
    "earliest_retained_position",
    true,
  );
  if (BigInt(first) > BigInt(last) || BigInt(earliest) <= BigInt(last)) {
    throw new ContractInputError("data-loss range is invalid");
  }
  return {
    stream_id: requireIdentifier(payload.stream_id, "stream_id"),
    stream_epoch: requireUint64(payload.stream_epoch, "stream_epoch", true),
    first_lost_position: first,
    last_lost_position: last,
    earliest_retained_position: earliest,
    reason: requireIdentifier(payload.reason, "reason", 64),
    recorded_at_ms: requireUint64(payload.recorded_at_ms, "recorded_at_ms"),
  };
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  throw new ContractInputError("business content is not canonical JSON");
}

export function cloudLinkBusinessDigest(
  messageKind: CloudLinkDeliveryEnvelope["message_kind"],
  payload: CloudLinkDeliveryEnvelope["payload"],
): string {
  const canonical = canonicalize({
    protocol_version: protocolVersion,
    message_kind: messageKind,
    payload,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function decodeDelivery(record: JsonRecord): CloudLinkDeliveryEnvelope {
  const hasExpiry = record.expires_at_ms !== undefined;
  const hasAuthentication = record.message_authentication !== undefined;
  const hasTrace = record.traceparent !== undefined;
  requireExactKeys(
    record,
    [
      "credential_generation",
      "delivery",
      ...(hasExpiry ? ["expires_at_ms"] : []),
      "gateway_id",
      "message_kind",
      ...(hasAuthentication ? ["message_authentication"] : []),
      "payload",
      "protocol",
      "protocol_version",
      "schema",
      "sent_at_ms",
      "session_epoch",
      "session_id",
      ...(hasTrace ? ["traceparent"] : []),
    ],
    "delivery envelope",
  );
  decodeProtocol(record);
  decodeVersion(record);
  if (record.schema !== "aether.cloudlink.envelope.v1") {
    throw new ContractInputError("delivery envelope schema is unsupported");
  }
  if (
    !(
      record.message_kind === "data-loss" ||
      record.message_kind === "integration-observation-batch" ||
      record.message_kind === "integration-topology-snapshot" ||
      record.message_kind === "runtime-manifest-report" ||
      record.message_kind === "telemetry-batch"
    )
  ) {
    throw new ContractInputError("delivery message kind is unsupported");
  }
  const delivery = requireRecord(record.delivery, "delivery descriptor");
  requireExactKeys(
    delivery,
    ["batch_id", "digest", "position", "stream_epoch", "stream_id"],
    "delivery descriptor",
  );
  const descriptor: CloudLinkDeliveryDescriptor = {
    stream_id: requireIdentifier(delivery.stream_id, "delivery.stream_id"),
    stream_epoch: requireUint64(
      delivery.stream_epoch,
      "delivery.stream_epoch",
      true,
    ),
    position: requireUint64(delivery.position, "delivery.position", true),
    batch_id: requireIdentifier(delivery.batch_id, "delivery.batch_id"),
    digest: requireDigest(delivery.digest, "delivery.digest"),
  };
  const sentAt = requireUint64(record.sent_at_ms, "sent_at_ms");
  const expiresAt =
    record.expires_at_ms === undefined
      ? undefined
      : requireUint64(record.expires_at_ms, "expires_at_ms");
  if (expiresAt !== undefined && BigInt(expiresAt) < BigInt(sentAt)) {
    throw new ContractInputError("expires_at_ms must not precede sent_at_ms");
  }
  const traceparent =
    record.traceparent === undefined
      ? undefined
      : requireString(record.traceparent, "traceparent", 55);
  if (traceparent !== undefined && !traceparentPattern.test(traceparent)) {
    throw new ContractInputError("traceparent is invalid");
  }
  const businessPayload = decodeBusinessPayload(
    record.message_kind,
    record.payload,
  );
  if (record.message_kind === "integration-topology-snapshot") {
    const integrationPayload = requireRecord(
      businessPayload,
      "Integration topology payload",
    );
    const generation = requireString(
      integrationPayload.snapshot_generation,
      "payload.snapshot_generation",
      20,
    );
    if (descriptor.batch_id !== `topology-${generation}`) {
      throw new ContractInputError(
        "Integration topology batch identity does not match its generation",
        "invalid-payload",
        "BATCH_ID_MISMATCH",
      );
    }
  }
  if (record.message_kind === "integration-observation-batch") {
    const integrationPayload = requireRecord(
      businessPayload,
      "Integration observation payload",
    );
    const batchId = requireString(
      integrationPayload.batch_id,
      "payload.batch_id",
      128,
    );
    if (descriptor.batch_id !== batchId) {
      throw new ContractInputError(
        "Integration observation batch identities do not match",
        "invalid-payload",
        "BATCH_ID_MISMATCH",
      );
    }
  }
  if (
    cloudLinkBusinessDigest(record.message_kind, businessPayload) !==
    descriptor.digest
  ) {
    throw new ContractInputError(
      "delivery digest does not match canonical business content",
      "digest-mismatch",
    );
  }
  return {
    schema: "aether.cloudlink.envelope.v1",
    protocol,
    protocol_version: protocolVersion,
    message_kind: record.message_kind,
    gateway_id: requireUuid(record.gateway_id, "gateway_id"),
    session_id: requireUuid(record.session_id, "session_id"),
    session_epoch: requireUint64(record.session_epoch, "session_epoch", true),
    credential_generation: requireUint64(
      record.credential_generation,
      "credential_generation",
      true,
    ),
    sent_at_ms: sentAt,
    ...(expiresAt === undefined ? {} : { expires_at_ms: expiresAt }),
    delivery: descriptor,
    ...(hasAuthentication
      ? {
          message_authentication: decodeMessageAuthentication(
            record.message_authentication,
            "message_authentication",
            true,
          ),
        }
      : {}),
    ...(traceparent === undefined ? {} : { traceparent }),
    payload: businessPayload,
  } as CloudLinkDeliveryEnvelope;
}

function decodeDurableAck(record: JsonRecord): CloudLinkDurableAck {
  requireExactKeys(
    record,
    [
      "acknowledged_at_ms",
      "acknowledged_position",
      "batch_id",
      "credential_generation",
      "digest",
      "gateway_id",
      "message_kind",
      "protocol",
      "protocol_version",
      "receipt_id",
      "schema",
      "session_epoch",
      "session_id",
      "stream_epoch",
      "stream_id",
    ],
    "durable ACK",
  );
  decodeProtocol(record);
  decodeVersion(record);
  if (
    record.schema !== "aether.cloudlink.durable-ack.v1" ||
    record.message_kind !== "durable-ack"
  ) {
    throw new ContractInputError("durable ACK discriminator is invalid");
  }
  return {
    schema: "aether.cloudlink.durable-ack.v1",
    protocol,
    protocol_version: protocolVersion,
    message_kind: "durable-ack",
    gateway_id: requireUuid(record.gateway_id, "gateway_id"),
    session_id: requireUuid(record.session_id, "session_id"),
    session_epoch: requireUint64(record.session_epoch, "session_epoch", true),
    credential_generation: requireUint64(
      record.credential_generation,
      "credential_generation",
      true,
    ),
    stream_id: requireIdentifier(record.stream_id, "stream_id"),
    stream_epoch: requireUint64(record.stream_epoch, "stream_epoch", true),
    acknowledged_position: requireUint64(
      record.acknowledged_position,
      "acknowledged_position",
      true,
    ),
    batch_id: requireIdentifier(record.batch_id, "batch_id"),
    digest: requireDigest(record.digest, "digest"),
    receipt_id: requireIdentifier(record.receipt_id, "receipt_id"),
    acknowledged_at_ms: requireUint64(
      record.acknowledged_at_ms,
      "acknowledged_at_ms",
    ),
  };
}

function decodeReplayRequest(record: JsonRecord): CloudLinkReplayRequest {
  requireExactKeys(
    record,
    [
      "credential_generation",
      "from_position",
      "gateway_id",
      "message_kind",
      "protocol",
      "protocol_version",
      "requested_at_ms",
      "schema",
      "session_epoch",
      "session_id",
      "stream_epoch",
      "stream_id",
    ],
    "replay request",
  );
  decodeProtocol(record);
  decodeVersion(record);
  if (
    record.schema !== "aether.cloudlink.replay-request.v1" ||
    record.message_kind !== "replay-request"
  ) {
    throw new ContractInputError("replay request discriminator is invalid");
  }
  return {
    schema: "aether.cloudlink.replay-request.v1",
    protocol,
    protocol_version: protocolVersion,
    message_kind: "replay-request",
    gateway_id: requireUuid(record.gateway_id, "gateway_id"),
    session_id: requireUuid(record.session_id, "session_id"),
    session_epoch: requireUint64(record.session_epoch, "session_epoch", true),
    credential_generation: requireUint64(
      record.credential_generation,
      "credential_generation",
      true,
    ),
    stream_id: requireIdentifier(record.stream_id, "stream_id"),
    stream_epoch: requireUint64(record.stream_epoch, "stream_epoch", true),
    from_position: requireUint64(record.from_position, "from_position", true),
    requested_at_ms: requireUint64(record.requested_at_ms, "requested_at_ms"),
  };
}

function decodeRecord(record: JsonRecord): CloudLinkContractMessage {
  switch (record.schema) {
    case "aether.cloudlink.durable-ack.v1":
      return decodeDurableAck(record);
    case "aether.cloudlink.envelope.v1":
      return decodeDelivery(record);
    case "aether.cloudlink.heartbeat.v1":
      return decodeHeartbeat(record);
    case "aether.cloudlink.replay-request.v1":
      return decodeReplayRequest(record);
    case "aether.cloudlink.session-accepted.v1":
      return decodeSessionAccepted(record);
    case "aether.cloudlink.session-challenge.v1":
      return decodeSessionChallenge(record);
    case "aether.cloudlink.session-challenge-request.v1":
      return decodeSessionChallengeRequest(record);
    case "aether.cloudlink.session-hello.v1":
      return decodeSessionHello(record);
    default:
      throw new ContractInputError(
        "CloudLink message schema is unsupported",
        "unsupported-message",
      );
  }
}

function boundedMaximum(value: number | undefined): number {
  const maximum = value ?? maximumDefaultPayloadBytes;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new ContractInputError(
      "CloudLink payload limit is invalid",
      "payload-too-large",
    );
  }
  return maximum;
}

export function decodeCloudLinkContractMessage(
  payload: Uint8Array,
  maximumPayloadBytes?: number,
): CloudLinkMqttDecodeResult {
  let maximum: number;
  try {
    maximum = boundedMaximum(maximumPayloadBytes);
  } catch (error: unknown) {
    const inputError = error as ContractInputError;
    return failure(
      inputError.code,
      inputError.message,
      inputError.contractCode,
    );
  }
  if (payload.byteLength > maximum) {
    return failure("payload-too-large", "CloudLink payload exceeds its limit");
  }
  let raw: unknown;
  try {
    raw = decodeStrictJson(payload, {
      maxBytes: maximum,
      maxDepth: 32,
      maxStringCodeUnits: 65_536,
      maxObjectMembers: 1_024,
      maxArrayItems: 65_536,
      maxNumberTokenLength: 128,
    });
  } catch (error: unknown) {
    if (error instanceof StrictJsonError) {
      return failure(
        error.code === "FIELD_BOUND" ? "invalid-payload" : "invalid-json",
        "CloudLink payload is not valid bounded UTF-8 JSON",
        error.code,
      );
    }
    throw error;
  }
  try {
    return {
      ok: true,
      value: decodeRecord(requireRecord(raw, "CloudLink message")),
    };
  } catch (error: unknown) {
    if (error instanceof ContractInputError) {
      return failure(error.code, error.message, error.contractCode);
    }
    throw error;
  }
}

function validateTopicPrefix(topicPrefix: string): readonly string[] {
  const segments = topicPrefix.split("/");
  if (
    segments.length === 0 ||
    topicPrefix.length > 256 ||
    segments.some((segment) => !topicSegmentPattern.test(segment))
  ) {
    throw new ContractInputError(
      "MQTT topic prefix is invalid",
      "invalid-topic",
    );
  }
  return segments;
}

function parseUplinkTopic(
  topic: string,
  topicPrefix: string,
): Readonly<{ gatewayId: string; route: string }> {
  const prefix = validateTopicPrefix(topicPrefix);
  const segments = topic.split("/");
  const suffix = segments.slice(prefix.length);
  if (
    !prefix.every((segment, index) => segments[index] === segment) ||
    (suffix.length !== 5 && suffix.length !== 6) ||
    suffix[0] !== "v1" ||
    suffix[1] !== "gateways" ||
    suffix[3] !== "up"
  ) {
    throw new ContractInputError(
      "MQTT topic is outside CloudLink v1 uplink",
      "invalid-topic",
    );
  }
  return {
    gatewayId: requireUuid(suffix[2], "topic gateway ID"),
    route: requireString(suffix.slice(4).join("/"), "topic route", 32),
  };
}

function inboundRoute(message: CloudLinkContractMessage): string | undefined {
  if (
    message.message_kind === "session-challenge-request" ||
    message.message_kind === "session-hello"
  ) {
    return "session";
  }
  if (message.message_kind === "heartbeat") return "heartbeat";
  if (message.message_kind === "runtime-manifest-report") return "manifest";
  if (message.message_kind === "telemetry-batch") return "telemetry";
  if (message.message_kind === "integration-topology-snapshot") {
    return "integration/topology";
  }
  if (message.message_kind === "integration-observation-batch") {
    return "integration/observations";
  }
  if (message.message_kind === "data-loss") return "data-loss";
  return undefined;
}

function integrationExtensionIsEnabled(
  extensions: readonly CloudLinkExtension[] | undefined,
): boolean {
  return extensions?.includes(integrationExtension) === true;
}

function integrationControlExtensionIsEnabled(
  extensions: readonly CloudLinkExtension[] | undefined,
): boolean {
  return extensions?.includes(integrationControlExtension) === true;
}

function isIntegrationMessage(
  message: CloudLinkContractMessage,
): message is Extract<
  CloudLinkDeliveryEnvelope,
  {
    message_kind:
      | "integration-observation-batch"
      | "integration-topology-snapshot";
  }
> {
  return (
    message.message_kind === "integration-observation-batch" ||
    message.message_kind === "integration-topology-snapshot"
  );
}

export function decodeCloudLinkMqttInbound(
  topic: string,
  payload: Uint8Array,
  options: CloudLinkMqttDecodeOptions,
): CloudLinkMqttInboundDecodeResult {
  let parsedTopic: Readonly<{ gatewayId: string; route: string }>;
  try {
    parsedTopic = parseUplinkTopic(topic, options.topicPrefix);
  } catch (error: unknown) {
    return {
      ok: false,
      failure: {
        code: "invalid-topic",
        contract_code: "INVALID_ARGUMENT",
        message:
          error instanceof Error ? error.message : "MQTT topic is invalid",
      },
    };
  }
  const decoded = decodeCloudLinkContractMessage(
    payload,
    options.maximumPayloadBytes,
  );
  if (!decoded.ok) return { ok: false, failure: decoded.failure };
  if (
    isIntegrationMessage(decoded.value) &&
    !integrationExtensionIsEnabled(options.enabledExtensions)
  ) {
    return {
      ok: false,
      failure: {
        code: "unsupported-message",
        contract_code: "UNSUPPORTED_VERSION",
        message: "CloudLink Integration extension is not enabled",
      },
    };
  }
  const route = inboundRoute(decoded.value);
  if (
    route === undefined ||
    decoded.value.gateway_id !== parsedTopic.gatewayId ||
    route !== parsedTopic.route
  ) {
    return {
      ok: false,
      failure: {
        code: "invalid-topic-binding",
        contract_code: "INVALID_ARGUMENT",
        message: "CloudLink topic does not match the message identity or kind",
      },
    };
  }
  return { ok: true, value: decoded.value as CloudLinkMqttInbound };
}

export function mqttUplinkFilters(
  topicPrefix: string,
  enabledExtensions?: readonly CloudLinkExtension[],
): readonly string[] {
  validateTopicPrefix(topicPrefix);
  const base = [
    "session",
    "heartbeat",
    "manifest",
    "telemetry",
    "data-loss",
  ].map((route) => `${topicPrefix}/v1/gateways/+/up/${route}`);
  const filters = [...base];
  if (integrationExtensionIsEnabled(enabledExtensions)) {
    filters.push(
      `${topicPrefix}/v1/gateways/+/up/integration/topology`,
      `${topicPrefix}/v1/gateways/+/up/integration/observations`,
    );
  }
  if (
    integrationExtensionIsEnabled(enabledExtensions) &&
    integrationControlExtensionIsEnabled(enabledExtensions)
  ) {
    filters.push(
      `${topicPrefix}/v1/gateways/+/up/integration-control/receipts`,
    );
  }
  return filters;
}

export function mqttDownlinkTopic(
  topicPrefix: string,
  gatewayId: string,
  channel: "ack" | "replay" | "session",
): string {
  validateTopicPrefix(topicPrefix);
  return `${topicPrefix}/v1/gateways/${requireUuid(gatewayId, "gateway_id")}/down/${channel}`;
}

export function encodeCloudLinkMqttOutbound(
  message: CloudLinkMqttOutbound,
): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(message));
  const validated = decodeCloudLinkContractMessage(encoded);
  if (!validated.ok) {
    throw new ContractInputError(
      validated.failure.message,
      validated.failure.code,
    );
  }
  if (inboundRoute(validated.value) !== undefined) {
    throw new ContractInputError("outbound CloudLink message kind is invalid");
  }
  return encoded;
}
