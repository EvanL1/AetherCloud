import { createHash } from "node:crypto";

import {
  StrictJsonError,
  decodeStrictJson,
} from "@aether-cloud/integration-aether-contracts-adapter";

const maximumDefaultBytes = 256 * 1024;
const maximumUint64 = 18_446_744_073_709_551_615n;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const topicSegmentPattern = /^[A-Za-z0-9._-]+$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;
const failureCodePattern = /^[A-Z][A-Z0-9_]*$/;
const traceparentPattern =
  /^(?!ff)[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;

type JsonRecord = Record<string, unknown>;

export type IntegrationControlCodecFailureCode =
  | "digest-mismatch"
  | "invalid-json"
  | "invalid-payload"
  | "payload-too-large";

export type IntegrationControlContractFailureCode =
  | "AUTHENTICATION_INVALID"
  | "CAPABILITY_DENIED"
  | "DIGEST_MISMATCH"
  | "DUPLICATE_JSON_KEY"
  | "FIELD_BOUND"
  | "INTEGER_NON_CANONICAL"
  | "INTEGER_OUT_OF_RANGE"
  | "INVALID_DIGEST"
  | "JSON_INVALID_UNICODE"
  | "JSON_NON_FINITE_NUMBER"
  | "JSON_SYNTAX_ERROR"
  | "JSON_UNSAFE_NUMBER"
  | "PHYSICAL_OUTCOME_UNPROVEN"
  | "UNKNOWN_FIELD";

export interface IntegrationControlWireAuthentication {
  readonly key_id: string;
  readonly algorithm: "Ed25519";
  readonly signature: string;
}

export interface IntegrationControlWireIntent {
  readonly schema: "aether.integration-control.action-intent.v1alpha1";
  readonly capability_id: "device.power.set.v1";
  readonly target: Readonly<{
    integration_id: string;
    snapshot_generation: string;
    entity_id: string;
    point_key: "is_on";
  }>;
  readonly arguments: Readonly<{ value: boolean }>;
  readonly governance: Readonly<{
    execution: "governed-job";
    default_authorization: "deny";
    permission: "integration.device.control";
    risk: "high";
    confirmation: "required";
    idempotency: "required";
    expiry: "required";
    audit: "required";
    edge_final_decision: true;
  }>;
  readonly authorization: Readonly<{
    policy_decision_id: string;
    subject_id: string;
    permission: "integration.device.control";
    authorized_at_ms: string;
  }>;
  readonly confirmation: Readonly<{
    confirmation_id: string;
    subject_id: string;
    confirmed_at_ms: string;
  }>;
}

export interface IntegrationControlWireActionOffer {
  readonly schema: "aether.cloudlink.integration-action-offer.v1alpha1";
  readonly protocol: "aether.cloudlink";
  readonly protocol_version: "1.0";
  readonly extension: "aether.cloudlink.integration-control.v1alpha1";
  readonly message_kind: "integration-action-offer";
  readonly gateway_id: string;
  readonly session_id: string;
  readonly session_epoch: string;
  readonly credential_generation: string;
  readonly job_id: string;
  readonly issued_at_ms: string;
  readonly expires_at_ms: string;
  readonly intent_digest: string;
  readonly intent: IntegrationControlWireIntent;
  readonly cloud_authentication: IntegrationControlWireAuthentication;
}

export interface IntegrationControlWireReceiptPayload {
  readonly schema: "aether.integration-control.action-receipt.v1alpha1";
  readonly job_id: string;
  readonly receipt_id: string;
  readonly receipt_sequence: string;
  readonly capability_id: "device.power.set.v1";
  readonly target: IntegrationControlWireIntent["target"];
  readonly intent_digest: string;
  readonly stage:
    | "edge-accepted"
    | "edge-rejected"
    | "provider-accepted"
    | "provider-rejected"
    | "unknown";
  readonly decision: "accepted" | "rejected" | "unknown";
  readonly physical_outcome: "unknown";
  readonly observed_at_ms: string;
  readonly evidence_digest?: string;
  readonly failure_code?: string;
  readonly audit: Readonly<{
    audit_record_id: string;
    status: "complete" | "incomplete";
  }>;
}

export interface IntegrationControlWireActionReceipt {
  readonly schema: "aether.cloudlink.envelope.v1";
  readonly protocol: "aether.cloudlink";
  readonly protocol_version: "1.0";
  readonly message_kind: "integration-action-receipt";
  readonly gateway_id: string;
  readonly session_id: string;
  readonly session_epoch: string;
  readonly credential_generation: string;
  readonly sent_at_ms: string;
  readonly expires_at_ms?: string;
  readonly traceparent?: string;
  readonly delivery: Readonly<{
    stream_id: string;
    stream_epoch: string;
    position: string;
    batch_id: string;
    digest: string;
  }>;
  readonly message_authentication: IntegrationControlWireAuthentication;
  readonly payload: IntegrationControlWireReceiptPayload;
}

export type IntegrationControlOfferDecodeResult =
  | Readonly<{ ok: true; value: IntegrationControlWireActionOffer }>
  | Readonly<{
      ok: false;
      failure: Readonly<{
        code: IntegrationControlCodecFailureCode;
        contract_code: IntegrationControlContractFailureCode;
        message: string;
      }>;
    }>;

export type IntegrationControlReceiptDecodeResult =
  | Readonly<{ ok: true; value: IntegrationControlWireActionReceipt }>
  | Readonly<{
      ok: false;
      failure: Readonly<{
        code: IntegrationControlCodecFailureCode;
        contract_code: IntegrationControlContractFailureCode;
        message: string;
      }>;
    }>;

class CodecInputError extends Error {
  readonly code: IntegrationControlCodecFailureCode;
  readonly contractCode: IntegrationControlContractFailureCode;

  constructor(
    message: string,
    contractCode: IntegrationControlContractFailureCode = "FIELD_BOUND",
    code: IntegrationControlCodecFailureCode = "invalid-payload",
  ) {
    super(message);
    this.code = code;
    this.contractCode = contractCode;
  }
}

function isRecord(input: unknown): input is JsonRecord {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function record(input: unknown, field: string): JsonRecord {
  if (!isRecord(input)) throw new CodecInputError(`${field} must be an object`);
  return input;
}

function exact(
  input: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in input)) ||
    Object.keys(input).some((key) => !allowed.has(key))
  ) {
    throw new CodecInputError(
      `${field} contains unknown or missing fields`,
      "UNKNOWN_FIELD",
    );
  }
}

function string(input: unknown, field: string, maximum = 128): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maximum
  ) {
    throw new CodecInputError(`${field} must be non-empty bounded text`);
  }
  return input;
}

function identifier(input: unknown, field: string, maximum = 128): string {
  const value = string(input, field, maximum);
  if (!identifierPattern.test(value)) {
    throw new CodecInputError(`${field} must be a bounded identifier`);
  }
  return value;
}

function uuid(input: unknown, field: string): string {
  if (typeof input !== "string" || !uuidPattern.test(input)) {
    throw new CodecInputError(`${field} must be a canonical lowercase UUID`);
  }
  return input;
}

function uint64(input: unknown, field: string, positive = false): string {
  if (typeof input !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(input)) {
    throw new CodecInputError(
      `${field} must be a canonical uint64`,
      "INTEGER_NON_CANONICAL",
    );
  }
  if (
    input.length > 20 ||
    BigInt(input) > maximumUint64 ||
    (positive && input === "0")
  ) {
    throw new CodecInputError(
      `${field} is outside uint64 bounds`,
      "INTEGER_OUT_OF_RANGE",
    );
  }
  return input;
}

function digest(input: unknown, field: string): string {
  if (typeof input !== "string" || !digestPattern.test(input)) {
    throw new CodecInputError(
      `${field} must be lowercase SHA-256`,
      "INVALID_DIGEST",
    );
  }
  return input;
}

function authentication(
  input: unknown,
  field: string,
  requireCanonicalEncoding = false,
): IntegrationControlWireAuthentication {
  const value = record(input, field);
  exact(value, ["algorithm", "key_id", "signature"], [], field);
  const signature = string(value.signature, `${field}.signature`, 86);
  const signatureBytes = Buffer.from(signature, "base64url");
  if (
    value.algorithm !== "Ed25519" ||
    !signaturePattern.test(signature) ||
    (requireCanonicalEncoding &&
      (signatureBytes.length !== 64 ||
        signatureBytes.toString("base64url") !== signature))
  ) {
    throw new CodecInputError(
      `${field} must be an Ed25519 base64url signature`,
      "AUTHENTICATION_INVALID",
    );
  }
  return Object.freeze({
    key_id: identifier(value.key_id, `${field}.key_id`),
    algorithm: "Ed25519",
    signature,
  });
}

function target(input: unknown): IntegrationControlWireIntent["target"] {
  const value = record(input, "target");
  exact(
    value,
    ["entity_id", "integration_id", "point_key", "snapshot_generation"],
    [],
    "target",
  );
  if (value.point_key !== "is_on") {
    throw new CodecInputError(
      "Integration Control point_key must be is_on",
      "CAPABILITY_DENIED",
    );
  }
  return Object.freeze({
    integration_id: identifier(value.integration_id, "integration_id"),
    snapshot_generation: uint64(
      value.snapshot_generation,
      "snapshot_generation",
    ),
    entity_id: identifier(value.entity_id, "entity_id"),
    point_key: "is_on",
  });
}

function intent(input: unknown): IntegrationControlWireIntent {
  const value = record(input, "intent");
  exact(
    value,
    [
      "arguments",
      "authorization",
      "capability_id",
      "confirmation",
      "governance",
      "schema",
      "target",
    ],
    [],
    "intent",
  );
  if (
    value.schema !== "aether.integration-control.action-intent.v1alpha1" ||
    value.capability_id !== "device.power.set.v1"
  ) {
    throw new CodecInputError(
      "Integration Control intent discriminator is unsupported",
      "CAPABILITY_DENIED",
    );
  }
  const argumentsValue = record(value.arguments, "intent.arguments");
  exact(argumentsValue, ["value"], [], "intent.arguments");
  if (typeof argumentsValue.value !== "boolean") {
    throw new CodecInputError(
      "Integration Control value must be Boolean",
      "CAPABILITY_DENIED",
    );
  }
  const governance = record(value.governance, "intent.governance");
  exact(
    governance,
    [
      "audit",
      "confirmation",
      "default_authorization",
      "edge_final_decision",
      "execution",
      "expiry",
      "idempotency",
      "permission",
      "risk",
    ],
    [],
    "intent.governance",
  );
  if (
    governance.execution !== "governed-job" ||
    governance.default_authorization !== "deny" ||
    governance.permission !== "integration.device.control" ||
    governance.risk !== "high" ||
    governance.confirmation !== "required" ||
    governance.idempotency !== "required" ||
    governance.expiry !== "required" ||
    governance.audit !== "required" ||
    governance.edge_final_decision !== true
  ) {
    throw new CodecInputError(
      "Integration Control governance is not the fixed high-risk profile",
      "CAPABILITY_DENIED",
    );
  }
  const authorization = record(value.authorization, "intent.authorization");
  exact(
    authorization,
    ["authorized_at_ms", "permission", "policy_decision_id", "subject_id"],
    [],
    "intent.authorization",
  );
  if (authorization.permission !== "integration.device.control") {
    throw new CodecInputError(
      "Integration Control authorization permission is invalid",
      "CAPABILITY_DENIED",
    );
  }
  const confirmation = record(value.confirmation, "intent.confirmation");
  exact(
    confirmation,
    ["confirmation_id", "confirmed_at_ms", "subject_id"],
    [],
    "intent.confirmation",
  );
  return Object.freeze({
    schema: "aether.integration-control.action-intent.v1alpha1",
    capability_id: "device.power.set.v1",
    target: target(value.target),
    arguments: Object.freeze({ value: argumentsValue.value }),
    governance: Object.freeze({
      execution: "governed-job",
      default_authorization: "deny",
      permission: "integration.device.control",
      risk: "high",
      confirmation: "required",
      idempotency: "required",
      expiry: "required",
      audit: "required",
      edge_final_decision: true,
    }),
    authorization: Object.freeze({
      policy_decision_id: identifier(
        authorization.policy_decision_id,
        "policy_decision_id",
      ),
      subject_id: identifier(
        authorization.subject_id,
        "authorization.subject_id",
      ),
      permission: "integration.device.control",
      authorized_at_ms: uint64(
        authorization.authorized_at_ms,
        "authorized_at_ms",
      ),
    }),
    confirmation: Object.freeze({
      confirmation_id: uuid(confirmation.confirmation_id, "confirmation_id"),
      subject_id: identifier(
        confirmation.subject_id,
        "confirmation.subject_id",
      ),
      confirmed_at_ms: uint64(confirmation.confirmed_at_ms, "confirmed_at_ms"),
    }),
  });
}

function decodeOfferRecord(
  input: JsonRecord,
): IntegrationControlWireActionOffer {
  exact(
    input,
    [
      "cloud_authentication",
      "credential_generation",
      "expires_at_ms",
      "extension",
      "gateway_id",
      "intent",
      "intent_digest",
      "issued_at_ms",
      "job_id",
      "message_kind",
      "protocol",
      "protocol_version",
      "schema",
      "session_epoch",
      "session_id",
    ],
    [],
    "Integration Control offer",
  );
  if (
    input.schema !== "aether.cloudlink.integration-action-offer.v1alpha1" ||
    input.protocol !== "aether.cloudlink" ||
    input.protocol_version !== "1.0" ||
    input.extension !== "aether.cloudlink.integration-control.v1alpha1" ||
    input.message_kind !== "integration-action-offer"
  ) {
    throw new CodecInputError(
      "Integration Control offer discriminator is unsupported",
    );
  }
  const issuedAt = uint64(input.issued_at_ms, "issued_at_ms");
  const expiresAt = uint64(input.expires_at_ms, "expires_at_ms");
  if (BigInt(expiresAt) < BigInt(issuedAt)) {
    throw new CodecInputError("expires_at_ms precedes issued_at_ms");
  }
  const decodedIntent = intent(input.intent);
  const expectedDigest = integrationControlIntentDigest(decodedIntent);
  const actualDigest = digest(input.intent_digest, "intent_digest");
  if (expectedDigest !== actualDigest) {
    throw new CodecInputError(
      "Integration Control intent digest does not match",
      "DIGEST_MISMATCH",
      "digest-mismatch",
    );
  }
  return Object.freeze({
    schema: "aether.cloudlink.integration-action-offer.v1alpha1",
    protocol: "aether.cloudlink",
    protocol_version: "1.0",
    extension: "aether.cloudlink.integration-control.v1alpha1",
    message_kind: "integration-action-offer",
    gateway_id: uuid(input.gateway_id, "gateway_id"),
    session_id: uuid(input.session_id, "session_id"),
    session_epoch: uint64(input.session_epoch, "session_epoch", true),
    credential_generation: uint64(
      input.credential_generation,
      "credential_generation",
      true,
    ),
    job_id: uuid(input.job_id, "job_id"),
    issued_at_ms: issuedAt,
    expires_at_ms: expiresAt,
    intent_digest: actualDigest,
    intent: decodedIntent,
    cloud_authentication: authentication(
      input.cloud_authentication,
      "cloud_authentication",
    ),
  });
}

function receiptPayload(input: unknown): IntegrationControlWireReceiptPayload {
  const value = record(input, "receipt payload");
  exact(
    value,
    [
      "audit",
      "capability_id",
      "decision",
      "intent_digest",
      "job_id",
      "observed_at_ms",
      "physical_outcome",
      "receipt_id",
      "receipt_sequence",
      "schema",
      "stage",
      "target",
    ],
    ["evidence_digest", "failure_code"],
    "receipt payload",
  );
  if (
    value.schema !== "aether.integration-control.action-receipt.v1alpha1" ||
    value.capability_id !== "device.power.set.v1"
  ) {
    throw new CodecInputError(
      "Integration Control receipt discriminator is unsupported",
      "CAPABILITY_DENIED",
    );
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
    ).includes(value.stage as IntegrationControlWireReceiptPayload["stage"])
  ) {
    throw new CodecInputError("Integration Control receipt stage is invalid");
  }
  if (value.physical_outcome !== "unknown") {
    throw new CodecInputError(
      "Integration Control never proves physical completion",
      "PHYSICAL_OUTCOME_UNPROVEN",
    );
  }
  const stage = value.stage as IntegrationControlWireReceiptPayload["stage"];
  const expectedDecision =
    stage === "edge-accepted" || stage === "provider-accepted"
      ? "accepted"
      : stage === "unknown"
        ? "unknown"
        : "rejected";
  if (value.decision !== expectedDecision) {
    throw new CodecInputError("receipt decision does not match its stage");
  }
  const providerStage =
    stage === "provider-accepted" || stage === "provider-rejected";
  if (providerStage && value.evidence_digest === undefined) {
    throw new CodecInputError(
      "provider receipt stage requires an evidence digest",
    );
  }
  if (stage === "edge-accepted" && value.evidence_digest !== undefined) {
    throw new CodecInputError(
      "edge-accepted receipt must not claim provider evidence",
    );
  }
  const failureRequired =
    stage === "edge-rejected" ||
    stage === "provider-rejected" ||
    stage === "unknown";
  if (failureRequired !== (value.failure_code !== undefined)) {
    throw new CodecInputError(
      "rejected or unknown receipt requires exactly one failure code",
    );
  }
  if (
    value.failure_code !== undefined &&
    (typeof value.failure_code !== "string" ||
      !failureCodePattern.test(value.failure_code))
  ) {
    throw new CodecInputError("receipt failure_code is invalid");
  }
  const audit = record(value.audit, "receipt audit");
  exact(audit, ["audit_record_id", "status"], [], "receipt audit");
  if (audit.status !== "complete" && audit.status !== "incomplete") {
    throw new CodecInputError("receipt audit status is invalid");
  }
  return Object.freeze({
    schema: "aether.integration-control.action-receipt.v1alpha1",
    job_id: uuid(value.job_id, "job_id"),
    receipt_id: uuid(value.receipt_id, "receipt_id"),
    receipt_sequence: uint64(value.receipt_sequence, "receipt_sequence", true),
    capability_id: "device.power.set.v1",
    target: target(value.target),
    intent_digest: digest(value.intent_digest, "intent_digest"),
    stage,
    decision: expectedDecision,
    physical_outcome: "unknown",
    observed_at_ms: uint64(value.observed_at_ms, "observed_at_ms"),
    ...(value.evidence_digest === undefined
      ? {}
      : { evidence_digest: digest(value.evidence_digest, "evidence_digest") }),
    ...(value.failure_code === undefined
      ? {}
      : { failure_code: value.failure_code }),
    audit: Object.freeze({
      audit_record_id: identifier(audit.audit_record_id, "audit_record_id"),
      status: audit.status,
    }),
  });
}

function decodeReceiptRecord(
  input: JsonRecord,
): IntegrationControlWireActionReceipt {
  exact(
    input,
    [
      "credential_generation",
      "delivery",
      "gateway_id",
      "message_authentication",
      "message_kind",
      "payload",
      "protocol",
      "protocol_version",
      "schema",
      "sent_at_ms",
      "session_epoch",
      "session_id",
    ],
    ["expires_at_ms", "traceparent"],
    "Integration Control receipt",
  );
  if (
    input.schema !== "aether.cloudlink.envelope.v1" ||
    input.protocol !== "aether.cloudlink" ||
    input.protocol_version !== "1.0" ||
    input.message_kind !== "integration-action-receipt"
  ) {
    throw new CodecInputError(
      "Integration Control receipt discriminator is unsupported",
    );
  }
  const delivery = record(input.delivery, "delivery");
  exact(
    delivery,
    ["batch_id", "digest", "position", "stream_epoch", "stream_id"],
    [],
    "delivery",
  );
  const sentAtMs = uint64(input.sent_at_ms, "sent_at_ms");
  const expiresAtMs =
    input.expires_at_ms === undefined
      ? undefined
      : uint64(input.expires_at_ms, "expires_at_ms");
  if (expiresAtMs !== undefined && BigInt(expiresAtMs) < BigInt(sentAtMs)) {
    throw new CodecInputError(
      "expires_at_ms must not precede sent_at_ms",
      "FIELD_BOUND",
    );
  }
  if (
    input.traceparent !== undefined &&
    (typeof input.traceparent !== "string" ||
      !traceparentPattern.test(input.traceparent))
  ) {
    throw new CodecInputError(
      "traceparent must be a canonical W3C trace context",
      "FIELD_BOUND",
    );
  }
  const decoded: IntegrationControlWireActionReceipt = Object.freeze({
    schema: "aether.cloudlink.envelope.v1",
    protocol: "aether.cloudlink",
    protocol_version: "1.0",
    message_kind: "integration-action-receipt",
    gateway_id: uuid(input.gateway_id, "gateway_id"),
    session_id: uuid(input.session_id, "session_id"),
    session_epoch: uint64(input.session_epoch, "session_epoch", true),
    credential_generation: uint64(
      input.credential_generation,
      "credential_generation",
      true,
    ),
    sent_at_ms: sentAtMs,
    ...(expiresAtMs === undefined ? {} : { expires_at_ms: expiresAtMs }),
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
    delivery: Object.freeze({
      stream_id: identifier(delivery.stream_id, "delivery.stream_id"),
      stream_epoch: uint64(
        delivery.stream_epoch,
        "delivery.stream_epoch",
        true,
      ),
      position: uint64(delivery.position, "delivery.position", true),
      batch_id: identifier(delivery.batch_id, "delivery.batch_id"),
      digest: digest(delivery.digest, "delivery.digest"),
    }),
    message_authentication: authentication(
      input.message_authentication,
      "message_authentication",
      true,
    ),
    payload: receiptPayload(input.payload),
  });
  if (
    integrationControlReceiptBusinessDigest(decoded) !== decoded.delivery.digest
  ) {
    throw new CodecInputError(
      "Integration Control receipt business digest does not match",
      "DIGEST_MISMATCH",
      "digest-mismatch",
    );
  }
  return decoded;
}

function canonicalJson(input: unknown): string {
  if (
    input === null ||
    typeof input === "boolean" ||
    typeof input === "string"
  ) {
    return JSON.stringify(input);
  }
  if (typeof input === "number" && Number.isFinite(input)) {
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    return `[${input.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(input)) {
    return `{${Object.keys(input)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`)
      .join(",")}}`;
  }
  throw new CodecInputError("canonical JSON input is invalid");
}

function sha256(input: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(input), "utf8")
    .digest("hex")}`;
}

function decodeRaw(
  payload: Uint8Array,
  maximumPayloadBytes: number | undefined,
): unknown {
  const maximum = maximumPayloadBytes ?? maximumDefaultBytes;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new CodecInputError(
      "payload byte limit is invalid",
      "FIELD_BOUND",
      "payload-too-large",
    );
  }
  if (payload.byteLength > maximum) {
    throw new CodecInputError(
      "Integration Control payload exceeds its byte limit",
      "FIELD_BOUND",
      "payload-too-large",
    );
  }
  return decodeStrictJson(payload, {
    maxBytes: maximum,
    maxDepth: 24,
    maxStringCodeUnits: 16_384,
    maxObjectMembers: 64,
    maxArrayItems: 64,
    maxNumberTokenLength: 128,
  });
}

function decodeFailure(error: unknown):
  | Readonly<{
      ok: false;
      failure: Readonly<{
        code: IntegrationControlCodecFailureCode;
        contract_code: IntegrationControlContractFailureCode;
        message: string;
      }>;
    }>
  | undefined {
  if (error instanceof CodecInputError) {
    return {
      ok: false,
      failure: {
        code: error.code,
        contract_code: error.contractCode,
        message: error.message,
      },
    };
  }
  if (error instanceof StrictJsonError) {
    return {
      ok: false,
      failure: {
        code: error.code === "FIELD_BOUND" ? "invalid-payload" : "invalid-json",
        contract_code: error.code,
        message: "Integration Control payload is not valid bounded UTF-8 JSON",
      },
    };
  }
  return undefined;
}

export function integrationControlIntentDigest(
  value: IntegrationControlWireIntent,
): string {
  return sha256(value);
}

export function integrationControlReceiptBusinessDigest(
  value: IntegrationControlWireActionReceipt,
): string {
  return sha256({
    protocol_version: "1.0",
    message_kind: "integration-action-receipt",
    payload: value.payload,
  });
}

export function integrationControlOfferSigningBytes(
  value: IntegrationControlWireActionOffer,
): Uint8Array {
  const { cloud_authentication: authentication, ...projection } = value;
  void authentication;
  return new TextEncoder().encode(canonicalJson(projection));
}

export function integrationControlReceiptSigningBytes(
  value: IntegrationControlWireActionReceipt,
): Uint8Array {
  return new TextEncoder().encode(
    canonicalJson({
      schema: "aether.cloudlink.uplink-signing.v1alpha1",
      gateway_id: value.gateway_id,
      credential_generation: value.credential_generation,
      session_id: value.session_id,
      session_epoch: value.session_epoch,
      message_kind: value.message_kind,
      sent_at_ms: value.sent_at_ms,
      expires_at_ms: value.expires_at_ms ?? null,
      stream_id: value.delivery.stream_id,
      stream_epoch: value.delivery.stream_epoch,
      position: value.delivery.position,
      batch_id: value.delivery.batch_id,
      business_digest: value.delivery.digest,
    }),
  );
}

export function decodeIntegrationControlActionOffer(
  payload: Uint8Array,
  maximumPayloadBytes?: number,
): IntegrationControlOfferDecodeResult {
  try {
    return {
      ok: true,
      value: decodeOfferRecord(
        record(
          decodeRaw(payload, maximumPayloadBytes),
          "Integration Control offer",
        ),
      ),
    };
  } catch (error: unknown) {
    const rejected = decodeFailure(error);
    if (rejected !== undefined) return rejected;
    throw error;
  }
}

export function decodeIntegrationControlActionReceipt(
  payload: Uint8Array,
  maximumPayloadBytes?: number,
): IntegrationControlReceiptDecodeResult {
  try {
    return {
      ok: true,
      value: decodeReceiptRecord(
        record(
          decodeRaw(payload, maximumPayloadBytes),
          "Integration Control receipt",
        ),
      ),
    };
  } catch (error: unknown) {
    const rejected = decodeFailure(error);
    if (rejected !== undefined) return rejected;
    throw error;
  }
}

export function encodeIntegrationControlActionOffer(
  value: IntegrationControlWireActionOffer,
): Uint8Array {
  const decoded = decodeOfferRecord(record(value, "Integration Control offer"));
  return new TextEncoder().encode(JSON.stringify(decoded));
}

function topicPrefix(prefix: string): string {
  const segments = prefix.split("/");
  if (
    prefix.length === 0 ||
    prefix.length > 256 ||
    segments.some((segment) => !topicSegmentPattern.test(segment))
  ) {
    throw new TypeError("MQTT topic prefix is invalid");
  }
  return prefix;
}

export function mqttIntegrationControlOfferTopic(
  prefix: string,
  gatewayId: string,
): string {
  return `${topicPrefix(prefix)}/v1/gateways/${uuid(
    gatewayId,
    "gatewayId",
  )}/down/integration-control`;
}

export function mqttIntegrationControlReceiptTopic(
  prefix: string,
  gatewayId: string,
): string {
  return `${topicPrefix(prefix)}/v1/gateways/${uuid(
    gatewayId,
    "gatewayId",
  )}/up/integration-control/receipts`;
}

export function mqttIntegrationControlReceiptFilter(prefix: string): string {
  return `${topicPrefix(prefix)}/v1/gateways/+/up/integration-control/receipts`;
}
