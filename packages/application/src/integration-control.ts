import {
  INTEGRATION_CONTROL_PERMISSION,
  INTEGRATION_CONTROL_PROTOCOL,
  INTEGRATION_POWER_CAPABILITY_ID,
  InvalidDomainValueError,
  defineIntegrationControlReceipt,
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseGovernedJobId,
  parseIntegrationControlDigest,
  parseIntegrationId,
  parseProjectId,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
  parseTenantId,
  parseUtcInstant,
  resolveIntegrationPowerTarget,
} from "@aether-cloud/domain";
import type {
  CloudLinkSession,
  GatewayCredentialBinding,
  GatewayId,
  IntegrationControlReceipt,
  IntegrationControlTarget,
  UtcInstant,
} from "@aether-cloud/domain";

import {
  CREATE_INTEGRATION_POWER_CONTROL_COMMAND,
  INGEST_INTEGRATION_CONTROL_RECEIPT_COMMAND,
} from "./capability-definition.js";
import type {
  GatewayCredentialAssertion,
  GatewayCredentialVerifier,
} from "./cloudlink-session-repository.js";
import {
  isGatewaySignedCloudLinkUplinkAuthenticationFact,
  type GatewaySignedCloudLinkUplinkAuthenticationFact,
} from "./cloudlink-uplink-authentication.js";
import type { IntegrationProjectionScope } from "./integration-projection-repository.js";
import type {
  IntegrationControlActionIntent,
  IntegrationControlActionOffer,
  IntegrationControlDurableAcknowledgement,
  IntegrationControlIntentDigestor,
  IntegrationControlOfferPublisher,
  IntegrationControlOfferSigner,
  IntegrationControlReceiptAuthenticationInput,
  IntegrationControlReceiptAuthenticator,
  IntegrationControlProjectionReader,
  IntegrationControlRepository,
  IntegrationControlRuntimeProtocolReader,
  IntegrationControlSessionReader,
  IntegrationControlScope,
  IntegrationOfferOutboxRecord,
  IntegrationStoredIntent,
} from "./integration-control-repository.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const opaqueIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const uint64Pattern = /^(?:0|[1-9][0-9]*)$/;
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;
const sha256DigestPattern = /^sha256:[0-9a-f]{64}$/;
const traceparentPattern =
  /^(?!ff)[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;
const maximumUint64 = 18_446_744_073_709_551_615n;

type IntegrationControlFailureCode =
  | "cloudlink-session-not-active"
  | "command-expired"
  | "confirmation-required"
  | "gateway-credential-inactive"
  | "integration-control-disabled"
  | "integration-control-intent-conflict"
  | "integration-control-not-found"
  | "integration-control-protocol-not-declared"
  | "integration-control-publish-failed"
  | "integration-control-storage-unavailable"
  | "integration-delivery-conflict"
  | "integration-delivery-gap"
  | "integration-receipt-authentication-invalid"
  | "integration-receipt-conflict"
  | "integration-stream-binding-conflict"
  | "integration-target-not-found"
  | "integration-target-not-writable"
  | "integration-topology-generation-future"
  | "integration-topology-generation-stale"
  | "invalid-gateway-credential"
  | "invalid-input"
  | "permission-denied";

export interface IntegrationControlFailure {
  readonly code: IntegrationControlFailureCode;
  readonly message: string;
}

export type IntegrationControlApplicationResult<Value> =
  | Readonly<{ ok: true; replayed: boolean; value: Value }>
  | Readonly<{ ok: false; failure: IntegrationControlFailure }>;

export interface IntegrationControlApplicationClock {
  now(): string;
}

export interface IntegrationPowerControlView {
  readonly disposition: "persisted" | "replayed";
  readonly intent: IntegrationStoredIntent;
  readonly offer: IntegrationControlActionOffer;
  readonly outboxEventId: string;
  readonly providerAccepted: false;
  readonly physicalCompleted: false;
  readonly jobSucceeded: false;
}

export interface IntegrationControlReceiptView {
  readonly disposition: "persisted" | "replayed";
  readonly auditEventId: string;
  readonly stage: IntegrationControlReceipt["stage"];
  readonly providerAccepted: boolean;
  readonly physicalCompleted: false;
  readonly jobSucceeded: false;
  readonly durableAcknowledgement: IntegrationControlDurableAcknowledgement;
}

export interface IntegrationControlReofferView {
  readonly staged: number;
  readonly deferred: number;
  readonly offers: readonly IntegrationControlActionOffer[];
}

export interface IntegrationControlPublishView {
  readonly published: number;
  readonly deferred: number;
}

interface TenantCommandContext extends IntegrationControlScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
  readonly confirmation: Readonly<{
    confirmationId: string;
    subjectId: string;
    confirmedAtMs: string;
  }> | null;
  readonly authorization: Readonly<{
    policyDecisionId: string;
    subjectId: string;
    permission: typeof INTEGRATION_CONTROL_PERMISSION;
    authorizedAtMs: string;
  }>;
  readonly requestId: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

interface PowerControlInput {
  readonly gatewayId: GatewayId;
  readonly jobId: ReturnType<typeof parseGovernedJobId>;
  readonly integrationId: string;
  readonly snapshotGeneration: string;
  readonly entityId: string;
  readonly value: boolean;
  readonly jobExpiresAtMs: string;
}

interface ReceiptCommandContext {
  readonly requestId: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

type ReceiptAuthentication =
  | Readonly<{
      kind: "credential";
      credential: GatewayCredentialAssertion;
      messageAuthentication: IntegrationControlReceiptAuthenticationInput["messageAuthentication"];
    }>
  | Readonly<{
      kind: "gateway-signed";
      fact: GatewaySignedCloudLinkUplinkAuthenticationFact;
    }>;

interface ReceiptInput extends Omit<
  IntegrationControlReceiptAuthenticationInput,
  "gatewayId" | "messageAuthentication"
> {
  readonly authentication: ReceiptAuthentication;
}

class IntegrationControlInputError extends Error {}

function failure(
  code: IntegrationControlFailureCode,
  message: string,
): Readonly<{ ok: false; failure: IntegrationControlFailure }> {
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
    throw new IntegrationControlInputError(`${field} must be an object`);
  }
  return input;
}

function requireExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new IntegrationControlInputError(
      `${field} contains unknown or missing fields`,
    );
  }
}

function requireString(input: unknown, field: string, maximum = 128): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maximum
  ) {
    throw new IntegrationControlInputError(
      `${field} must be non-empty bounded text`,
    );
  }
  return input;
}

function requireIdentifier(input: unknown, field: string): string {
  const value = requireString(input, field);
  if (!identifierPattern.test(value)) {
    throw new IntegrationControlInputError(
      `${field} must be a bounded identifier`,
    );
  }
  return value;
}

function requireUuid(input: unknown, field: string): string {
  if (typeof input !== "string" || !uuidPattern.test(input)) {
    throw new IntegrationControlInputError(
      `${field} must be a canonical lowercase UUID`,
    );
  }
  return input;
}

function requireUint64(
  input: unknown,
  field: string,
  positive = false,
): string {
  if (
    typeof input !== "string" ||
    !uint64Pattern.test(input) ||
    BigInt(input) > maximumUint64 ||
    (positive && input === "0")
  ) {
    throw new IntegrationControlInputError(
      `${field} must be a canonical ${positive ? "positive " : ""}uint64`,
    );
  }
  return input;
}

function decodePermissions(input: unknown): ReadonlySet<string> {
  if (
    !Array.isArray(input) ||
    input.length > 256 ||
    input.some(
      (permission) =>
        typeof permission !== "string" || !identifierPattern.test(permission),
    )
  ) {
    throw new IntegrationControlInputError(
      "permissions must be bounded identifiers",
    );
  }
  return new Set(input);
}

function decodeConfirmation(
  input: unknown,
): TenantCommandContext["confirmation"] {
  if (input === null) return null;
  const record = requireRecord(input, "confirmation");
  requireExactKeys(
    record,
    ["confirmationId", "confirmedAtMs", "subjectId"],
    [],
    "confirmation",
  );
  return Object.freeze({
    confirmationId: requireUuid(record.confirmationId, "confirmationId"),
    subjectId: requireIdentifier(record.subjectId, "confirmation.subjectId"),
    confirmedAtMs: requireUint64(
      record.confirmedAtMs,
      "confirmation.confirmedAtMs",
    ),
  });
}

function decodeAuthorization(
  input: unknown,
): TenantCommandContext["authorization"] {
  const record = requireRecord(input, "authorization");
  requireExactKeys(
    record,
    ["authorizedAtMs", "permission", "policyDecisionId", "subjectId"],
    [],
    "authorization",
  );
  if (record.permission !== INTEGRATION_CONTROL_PERMISSION) {
    throw new IntegrationControlInputError(
      `authorization permission must be ${INTEGRATION_CONTROL_PERMISSION}`,
    );
  }
  return Object.freeze({
    policyDecisionId: requireIdentifier(
      record.policyDecisionId,
      "policyDecisionId",
    ),
    subjectId: requireIdentifier(record.subjectId, "authorization.subjectId"),
    permission: INTEGRATION_CONTROL_PERMISSION,
    authorizedAtMs: requireUint64(
      record.authorizedAtMs,
      "authorization.authorizedAtMs",
    ),
  });
}

function decodeTenantCommandContext(input: unknown): TenantCommandContext {
  const record = requireRecord(input, "command context");
  requireExactKeys(
    record,
    [
      "authorization",
      "confirmation",
      "expiresAt",
      "idempotencyKey",
      "issuedAt",
      "permissions",
      "projectId",
      "subjectId",
      "tenantId",
    ],
    [],
    "command context",
  );
  const requestId = requireString(record.idempotencyKey, "idempotencyKey");
  if (!opaqueIdentifierPattern.test(requestId)) {
    throw new IntegrationControlInputError(
      "idempotencyKey must be an opaque identifier",
    );
  }
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
    subjectId: requireIdentifier(record.subjectId, "subjectId"),
    permissions: decodePermissions(record.permissions),
    confirmation: decodeConfirmation(record.confirmation),
    authorization: decodeAuthorization(record.authorization),
    requestId,
    issuedAt: parseUtcInstant(record.issuedAt),
    expiresAt: parseUtcInstant(record.expiresAt),
  };
}

function decodePowerControlInput(input: unknown): PowerControlInput {
  const record = requireRecord(input, "power control input");
  requireExactKeys(
    record,
    [
      "entityId",
      "gatewayId",
      "integrationId",
      "jobExpiresAtMs",
      "jobId",
      "snapshotGeneration",
      "value",
    ],
    [],
    "power control input",
  );
  if (typeof record.value !== "boolean") {
    throw new IntegrationControlInputError("value must be Boolean");
  }
  return {
    gatewayId: parseGatewayId(record.gatewayId),
    jobId: parseGovernedJobId(record.jobId),
    integrationId: requireIdentifier(record.integrationId, "integrationId"),
    snapshotGeneration: requireUint64(
      record.snapshotGeneration,
      "snapshotGeneration",
    ),
    entityId: requireIdentifier(record.entityId, "entityId"),
    value: record.value,
    jobExpiresAtMs: requireUint64(record.jobExpiresAtMs, "jobExpiresAtMs"),
  };
}

function decodeReceiptCommandContext(input: unknown): ReceiptCommandContext {
  const record = requireRecord(input, "receipt command context");
  requireExactKeys(
    record,
    ["expiresAt", "idempotencyKey", "issuedAt"],
    [],
    "receipt command context",
  );
  const requestId = requireString(record.idempotencyKey, "idempotencyKey");
  if (!opaqueIdentifierPattern.test(requestId)) {
    throw new IntegrationControlInputError(
      "idempotencyKey must be an opaque identifier",
    );
  }
  return {
    requestId,
    issuedAt: parseUtcInstant(record.issuedAt),
    expiresAt: parseUtcInstant(record.expiresAt),
  };
}

function decodeCredential(input: unknown): GatewayCredentialAssertion {
  const record = requireRecord(input, "credential");
  requireExactKeys(record, ["credentialId", "proof"], [], "credential");
  return {
    credentialId: requireString(record.credentialId, "credentialId", 256),
    proof: requireString(record.proof, "credential.proof", 4_096),
  };
}

function decodeReceipt(input: unknown): IntegrationControlReceipt {
  const record = requireRecord(input, "receipt");
  requireExactKeys(
    record,
    [
      "audit",
      "capabilityId",
      "decision",
      "intentDigest",
      "jobId",
      "observedAtMs",
      "physicalOutcome",
      "receiptId",
      "receiptSequence",
      "stage",
      "target",
    ],
    ["evidenceDigest", "failureCode"],
    "receipt",
  );
  const target = requireRecord(record.target, "receipt.target");
  requireExactKeys(
    target,
    ["entityId", "integrationId", "pointKey", "snapshotGeneration"],
    [],
    "receipt.target",
  );
  const audit = requireRecord(record.audit, "receipt.audit");
  requireExactKeys(audit, ["auditRecordId", "status"], [], "receipt.audit");
  return defineIntegrationControlReceipt({
    jobId: record.jobId,
    receiptId: record.receiptId,
    receiptSequence: record.receiptSequence,
    capabilityId: record.capabilityId,
    target: {
      integrationId: target.integrationId,
      snapshotGeneration: target.snapshotGeneration,
      entityId: target.entityId,
      pointKey: target.pointKey,
    },
    intentDigest: record.intentDigest,
    stage: record.stage,
    decision: record.decision,
    physicalOutcome: record.physicalOutcome,
    observedAtMs: record.observedAtMs,
    ...(record.evidenceDigest === undefined
      ? {}
      : { evidenceDigest: record.evidenceDigest }),
    ...(record.failureCode === undefined
      ? {}
      : { failureCode: record.failureCode }),
    audit: {
      auditRecordId: audit.auditRecordId,
      status: audit.status,
    },
  });
}

function receiptProjectionMatches(
  fact: GatewaySignedCloudLinkUplinkAuthenticationFact,
  input: Omit<ReceiptInput, "authentication" | "receipt">,
): boolean {
  const projection = fact.signingProjection;
  return (
    fact.messageKind === "integration-action-receipt" &&
    !fact.refreshServerLiveness &&
    sha256DigestPattern.test(fact.signingObjectDigest) &&
    hasExpectedSigningProjectionSchema(projection) &&
    projection.gateway_id === fact.gatewayId &&
    projection.credential_generation === fact.credentialGeneration &&
    projection.session_id === fact.sessionId &&
    projection.session_epoch === fact.sessionEpoch &&
    projection.message_kind === "integration-action-receipt" &&
    projection.sent_at_ms === input.sentAtMs &&
    projection.expires_at_ms === (input.expiresAtMs ?? null) &&
    projection.stream_id === input.delivery.streamId &&
    projection.stream_epoch === input.delivery.streamEpoch &&
    projection.position === input.delivery.position &&
    projection.batch_id === input.delivery.batchId &&
    projection.business_digest === input.delivery.digest &&
    fact.sessionId === input.sessionId &&
    fact.sessionEpoch === input.sessionEpoch &&
    fact.credentialGeneration === input.credentialGeneration
  );
}

function decodeReceiptInput(input: unknown): ReceiptInput {
  const record = requireRecord(input, "receipt input");
  const gatewaySigned = record.gatewaySignedAuthentication !== undefined;
  requireExactKeys(
    record,
    [
      ...(gatewaySigned
        ? ["gatewaySignedAuthentication"]
        : ["credential", "messageAuthentication"]),
      "credentialGeneration",
      "delivery",
      "receipt",
      "sentAtMs",
      "sessionEpoch",
      "sessionId",
    ],
    ["expiresAtMs", "traceparent"],
    "receipt input",
  );
  const deliveryRecord = requireRecord(record.delivery, "delivery");
  requireExactKeys(
    deliveryRecord,
    ["batchId", "digest", "position", "streamEpoch", "streamId"],
    [],
    "delivery",
  );
  const sentAtMs = requireUint64(record.sentAtMs, "sentAtMs");
  const expiresAtMs =
    record.expiresAtMs === undefined
      ? undefined
      : requireUint64(record.expiresAtMs, "expiresAtMs");
  if (expiresAtMs !== undefined && BigInt(expiresAtMs) < BigInt(sentAtMs)) {
    throw new IntegrationControlInputError(
      "expiresAtMs must not precede sentAtMs",
    );
  }
  if (
    record.traceparent !== undefined &&
    (typeof record.traceparent !== "string" ||
      !traceparentPattern.test(record.traceparent))
  ) {
    throw new IntegrationControlInputError(
      "traceparent must be a canonical W3C trace context",
    );
  }
  const common = {
    sessionId: parseCloudLinkSessionId(record.sessionId),
    sessionEpoch: parseCloudLinkSessionEpoch(record.sessionEpoch),
    credentialGeneration: parseGatewayCredentialGeneration(
      record.credentialGeneration,
    ),
    sentAtMs,
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    ...(record.traceparent === undefined
      ? {}
      : { traceparent: record.traceparent }),
    delivery: {
      streamId: parseStreamId(deliveryRecord.streamId),
      streamEpoch: parseStreamEpoch(deliveryRecord.streamEpoch),
      position: parseStreamPosition(deliveryRecord.position),
      batchId: requireIdentifier(deliveryRecord.batchId, "delivery.batchId"),
      digest: parseIntegrationControlDigest(deliveryRecord.digest),
    },
  } satisfies Omit<ReceiptInput, "authentication" | "receipt">;
  let authentication: ReceiptAuthentication;
  if (gatewaySigned) {
    const fact = record.gatewaySignedAuthentication;
    if (
      !isGatewaySignedCloudLinkUplinkAuthenticationFact(fact) ||
      !receiptProjectionMatches(fact, common)
    ) {
      throw new IntegrationControlInputError(
        "Gateway-signed receipt authentication does not match delivery",
      );
    }
    authentication = { kind: "gateway-signed", fact };
  } else {
    const rawAuthentication = requireRecord(
      record.messageAuthentication,
      "messageAuthentication",
    );
    requireExactKeys(
      rawAuthentication,
      ["algorithm", "keyId", "signature"],
      [],
      "messageAuthentication",
    );
    const signature = requireString(
      rawAuthentication.signature,
      "messageAuthentication.signature",
      86,
    );
    if (
      rawAuthentication.algorithm !== "Ed25519" ||
      !signaturePattern.test(signature)
    ) {
      throw new IntegrationControlInputError(
        "messageAuthentication must be an Ed25519 signature",
      );
    }
    authentication = {
      kind: "credential",
      credential: decodeCredential(record.credential),
      messageAuthentication: {
        keyId: requireIdentifier(
          rawAuthentication.keyId,
          "messageAuthentication.keyId",
        ),
        algorithm: "Ed25519",
        signature,
      },
    };
  }
  return {
    ...common,
    authentication,
    receipt: decodeReceipt(record.receipt),
  };
}

function decodeScope(input: unknown): IntegrationControlScope {
  const record = requireRecord(input, "scope");
  requireExactKeys(record, ["projectId", "tenantId"], [], "scope");
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
  };
}

function decodeGatewayInput(
  input: unknown,
): Readonly<{ gatewayId: GatewayId }> {
  const record = requireRecord(input, "Gateway input");
  requireExactKeys(record, ["gatewayId"], [], "Gateway input");
  return { gatewayId: parseGatewayId(record.gatewayId) };
}

function decodeSafely<Value>(
  decoder: () => Value,
):
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: IntegrationControlFailure }> {
  try {
    return { ok: true, value: decoder() };
  } catch (error: unknown) {
    if (
      error instanceof IntegrationControlInputError ||
      error instanceof InvalidDomainValueError
    ) {
      return failure("invalid-input", error.message);
    }
    throw error;
  }
}

function validateCommandTime(
  context: Readonly<{ issuedAt: UtcInstant; expiresAt: UtcInstant }>,
  now: UtcInstant,
): IntegrationControlFailure | undefined {
  if (context.expiresAt <= context.issuedAt || context.issuedAt > now) {
    return { code: "invalid-input", message: "command time window is invalid" };
  }
  return now >= context.expiresAt
    ? { code: "command-expired", message: "command has expired" }
    : undefined;
}

function milliseconds(instant: UtcInstant): string {
  return String(Date.parse(instant));
}

function runtimeSupportsControl(
  protocols: readonly string[] | undefined,
): boolean {
  return protocols?.includes(INTEGRATION_CONTROL_PROTOCOL) === true;
}

async function currentDispatchState(
  scope: IntegrationControlScope,
  gatewayId: GatewayId,
  sessions: IntegrationControlSessionReader,
  manifests: IntegrationControlRuntimeProtocolReader,
): Promise<
  | Readonly<{ ok: true; session: CloudLinkSession }>
  | Readonly<{ ok: false; failure: IntegrationControlFailure }>
> {
  const [session, manifest] = await Promise.all([
    sessions.findCurrent(scope, gatewayId),
    manifests.findCurrent(scope, gatewayId),
  ]);
  if (
    session === undefined ||
    session.tenantId !== scope.tenantId ||
    session.projectId !== scope.projectId ||
    session.gatewayId !== gatewayId ||
    session.state !== "active" ||
    session.protocolVersion !== "1.0"
  ) {
    return failure(
      "cloudlink-session-not-active",
      "Current CloudLink session is not active",
    );
  }
  if (
    manifest === undefined ||
    manifest.tenantId !== scope.tenantId ||
    manifest.projectId !== scope.projectId ||
    manifest.gatewayId !== gatewayId ||
    !runtimeSupportsControl(manifest.manifest.protocols)
  ) {
    return failure(
      "integration-control-protocol-not-declared",
      "Persisted Runtime Manifest does not declare Integration Control",
    );
  }
  return { ok: true, session };
}

function buildIntent(
  context: TenantCommandContext,
  target: IntegrationControlTarget,
  value: boolean,
): IntegrationControlActionIntent {
  const confirmation = context.confirmation;
  if (confirmation === null) {
    throw new IntegrationControlInputError("explicit confirmation is required");
  }
  return Object.freeze({
    schema: "aether.integration-control.action-intent.v1alpha1",
    capability_id: INTEGRATION_POWER_CAPABILITY_ID,
    target: Object.freeze({
      integration_id: target.integrationId,
      snapshot_generation: target.snapshotGeneration,
      entity_id: target.entityId,
      point_key: "is_on",
    }),
    arguments: Object.freeze({ value }),
    governance: Object.freeze({
      execution: "governed-job",
      default_authorization: "deny",
      permission: INTEGRATION_CONTROL_PERMISSION,
      risk: "high",
      confirmation: "required",
      idempotency: "required",
      expiry: "required",
      audit: "required",
      edge_final_decision: true,
    }),
    authorization: Object.freeze({
      policy_decision_id: context.authorization.policyDecisionId,
      subject_id: context.authorization.subjectId,
      permission: INTEGRATION_CONTROL_PERMISSION,
      authorized_at_ms: context.authorization.authorizedAtMs,
    }),
    confirmation: Object.freeze({
      confirmation_id: confirmation.confirmationId,
      subject_id: confirmation.subjectId,
      confirmed_at_ms: confirmation.confirmedAtMs,
    }),
  });
}

async function signedOffer(
  input: {
    readonly gatewayId: GatewayId;
    readonly session: CloudLinkSession;
    readonly jobId: ReturnType<typeof parseGovernedJobId>;
    readonly issuedAtMs: string;
    readonly expiresAtMs: string;
    readonly intentDigest: ReturnType<typeof parseIntegrationControlDigest>;
    readonly intent: IntegrationControlActionIntent;
  },
  signer: IntegrationControlOfferSigner,
): Promise<IntegrationControlActionOffer> {
  const projection = Object.freeze({
    schema: "aether.cloudlink.integration-action-offer.v1alpha1" as const,
    protocol: "aether.cloudlink" as const,
    protocol_version: "1.0" as const,
    extension: INTEGRATION_CONTROL_PROTOCOL,
    message_kind: "integration-action-offer" as const,
    gateway_id: input.gatewayId,
    session_id: input.session.sessionId,
    session_epoch: input.session.epoch,
    credential_generation: input.session.credentialGeneration,
    job_id: input.jobId,
    issued_at_ms: input.issuedAtMs,
    expires_at_ms: input.expiresAtMs,
    intent_digest: input.intentDigest,
    intent: input.intent,
  });
  const authentication = await signer.sign(projection);
  const authenticationAlgorithm: unknown = authentication.algorithm;
  if (
    authenticationAlgorithm !== "Ed25519" ||
    !identifierPattern.test(authentication.keyId) ||
    !signaturePattern.test(authentication.signature)
  ) {
    throw new IntegrationControlInputError(
      "Integration Control signer returned invalid authentication metadata",
    );
  }
  return Object.freeze({
    ...projection,
    cloud_authentication: Object.freeze({
      key_id: authentication.keyId,
      algorithm: "Ed25519",
      signature: authentication.signature,
    }),
  });
}

function mapPersistenceFailure(
  outcome:
    | "idempotency-conflict"
    | "intent-conflict"
    | "not-found"
    | "storage-unavailable",
): Readonly<{ ok: false; failure: IntegrationControlFailure }> {
  switch (outcome) {
    case "idempotency-conflict":
    case "intent-conflict":
      return failure(
        "integration-control-intent-conflict",
        "Integration Control Job identity conflicts with another intent",
      );
    case "not-found":
      return failure(
        "integration-control-not-found",
        "Integration Control intent was not found",
      );
    case "storage-unavailable":
      return failure(
        "integration-control-storage-unavailable",
        "Integration Control persistence is unavailable",
      );
  }
}

export class CreateIntegrationPowerControl {
  static readonly capability = CREATE_INTEGRATION_POWER_CONTROL_COMMAND;
  readonly #repository: IntegrationControlRepository;
  readonly #sessions: IntegrationControlSessionReader;
  readonly #manifests: IntegrationControlRuntimeProtocolReader;
  readonly #projections: IntegrationControlProjectionReader;
  readonly #digestor: IntegrationControlIntentDigestor;
  readonly #signer: IntegrationControlOfferSigner;
  readonly #clock: IntegrationControlApplicationClock;
  readonly #enabled: boolean;

  constructor(dependencies: {
    readonly repository: IntegrationControlRepository;
    readonly sessions: IntegrationControlSessionReader;
    readonly manifests: IntegrationControlRuntimeProtocolReader;
    readonly projections: IntegrationControlProjectionReader;
    readonly digestor: IntegrationControlIntentDigestor;
    readonly signer: IntegrationControlOfferSigner;
    readonly clock: IntegrationControlApplicationClock;
    readonly enabled?: boolean;
  }) {
    this.#repository = dependencies.repository;
    this.#sessions = dependencies.sessions;
    this.#manifests = dependencies.manifests;
    this.#projections = dependencies.projections;
    this.#digestor = dependencies.digestor;
    this.#signer = dependencies.signer;
    this.#clock = dependencies.clock;
    this.#enabled = dependencies.enabled ?? false;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<IntegrationControlApplicationResult<IntegrationPowerControlView>> {
    if (!this.#enabled) {
      return failure(
        "integration-control-disabled",
        "Integration Control is disabled",
      );
    }
    const decoded = decodeSafely(() => ({
      context: decodeTenantCommandContext(rawContext),
      input: decodePowerControlInput(rawInput),
      now: parseUtcInstant(this.#clock.now()),
    }));
    if (!decoded.ok) return decoded;
    const { context, input, now } = decoded.value;
    if (!context.permissions.has(INTEGRATION_CONTROL_PERMISSION)) {
      return failure(
        "permission-denied",
        `permission ${INTEGRATION_CONTROL_PERMISSION} is required`,
      );
    }
    if (context.confirmation === null) {
      return failure(
        "confirmation-required",
        "Integration power control requires explicit confirmation",
      );
    }
    const timeFailure = validateCommandTime(context, now);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    const nowMs = milliseconds(now);
    const contextExpiryMs = milliseconds(context.expiresAt);
    if (
      context.authorization.subjectId !== context.subjectId ||
      context.confirmation.subjectId !== context.subjectId ||
      BigInt(context.authorization.authorizedAtMs) > BigInt(nowMs) ||
      BigInt(context.confirmation.confirmedAtMs) > BigInt(nowMs) ||
      BigInt(input.jobExpiresAtMs) <= BigInt(nowMs) ||
      BigInt(input.jobExpiresAtMs) > BigInt(contextExpiryMs)
    ) {
      return failure(
        "invalid-input",
        "Authorization, confirmation, or expiry binding is invalid",
      );
    }

    const dispatch = await currentDispatchState(
      context,
      input.gatewayId,
      this.#sessions,
      this.#manifests,
    );
    if (!dispatch.ok) return dispatch;
    const projectionScope: IntegrationProjectionScope = {
      tenantId: context.tenantId,
      projectId: context.projectId,
      gatewayId: input.gatewayId,
      integrationId: parseIntegrationId(input.integrationId),
    };
    const projection = await this.#projections.findCurrent(projectionScope);
    if (projection === undefined) {
      return failure(
        "integration-target-not-found",
        "Current Integration topology was not found",
      );
    }
    const target = resolveIntegrationPowerTarget(projection.topology, input);
    if (!target.ok) return { ok: false, failure: target.failure };
    const intent = buildIntent(context, target.target, input.value);
    let intentDigest;
    let offer;
    try {
      intentDigest = parseIntegrationControlDigest(
        await this.#digestor.digest(intent),
      );
      offer = await signedOffer(
        {
          gatewayId: input.gatewayId,
          session: dispatch.session,
          jobId: input.jobId,
          issuedAtMs: nowMs,
          expiresAtMs: input.jobExpiresAtMs,
          intentDigest,
          intent,
        },
        this.#signer,
      );
    } catch (error: unknown) {
      if (
        error instanceof InvalidDomainValueError ||
        error instanceof IntegrationControlInputError
      ) {
        return failure("invalid-input", error.message);
      }
      throw error;
    }
    const persisted = await this.#repository.persistIntentAndOffer({
      scope: context,
      gatewayId: input.gatewayId,
      requestId: context.requestId,
      subjectId: context.subjectId,
      offer,
      createdAt: now,
    });
    if (persisted.outcome !== "persisted" && persisted.outcome !== "replayed") {
      return mapPersistenceFailure(persisted.outcome);
    }
    return {
      ok: true,
      replayed: persisted.outcome === "replayed",
      value: Object.freeze({
        disposition: persisted.outcome,
        intent: persisted.intent,
        offer: persisted.offer.offer,
        outboxEventId: persisted.offer.eventId,
        providerAccepted: false,
        physicalCompleted: false,
        jobSucceeded: false,
      }),
    };
  }
}

function targetsEqual(
  receipt: IntegrationControlReceipt,
  intent: IntegrationControlActionIntent,
): boolean {
  return (
    receipt.target.integrationId === intent.target.integration_id &&
    receipt.target.snapshotGeneration === intent.target.snapshot_generation &&
    receipt.target.entityId === intent.target.entity_id &&
    receipt.target.pointKey === intent.target.point_key
  );
}

function mapReceiptFailure(
  outcome:
    | "delivery-conflict"
    | "delivery-gap"
    | "intent-conflict"
    | "not-found"
    | "receipt-conflict"
    | "storage-unavailable"
    | "stream-binding-conflict",
): Readonly<{ ok: false; failure: IntegrationControlFailure }> {
  switch (outcome) {
    case "delivery-conflict":
      return failure(
        "integration-delivery-conflict",
        "Integration Control delivery conflicts with prior evidence",
      );
    case "delivery-gap":
      return failure(
        "integration-delivery-gap",
        "Integration Control delivery has a position gap",
      );
    case "intent-conflict":
    case "receipt-conflict":
      return failure(
        "integration-receipt-conflict",
        "Integration Control receipt conflicts with its immutable intent",
      );
    case "not-found":
      return failure(
        "integration-control-not-found",
        "Integration Control intent was not found",
      );
    case "storage-unavailable":
      return failure(
        "integration-control-storage-unavailable",
        "Integration Control persistence is unavailable",
      );
    case "stream-binding-conflict":
      return failure(
        "integration-stream-binding-conflict",
        "Integration Control receipt stream binding conflicts",
      );
  }
}

export class IngestIntegrationControlReceipt {
  static readonly capability = INGEST_INTEGRATION_CONTROL_RECEIPT_COMMAND;
  readonly #repository: IntegrationControlRepository;
  readonly #sessions: IntegrationControlSessionReader;
  readonly #credentialVerifier: GatewayCredentialVerifier;
  readonly #authenticator: IntegrationControlReceiptAuthenticator;
  readonly #clock: IntegrationControlApplicationClock;

  constructor(dependencies: {
    readonly repository: IntegrationControlRepository;
    readonly sessions: IntegrationControlSessionReader;
    readonly credentialVerifier: GatewayCredentialVerifier;
    readonly authenticator: IntegrationControlReceiptAuthenticator;
    readonly clock: IntegrationControlApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#sessions = dependencies.sessions;
    this.#credentialVerifier = dependencies.credentialVerifier;
    this.#authenticator = dependencies.authenticator;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<
    IntegrationControlApplicationResult<IntegrationControlReceiptView>
  > {
    const decoded = decodeSafely(() => ({
      context: decodeReceiptCommandContext(rawContext),
      input: decodeReceiptInput(rawInput),
      now: parseUtcInstant(this.#clock.now()),
    }));
    if (!decoded.ok) return decoded;
    const { context, input, now } = decoded.value;
    const timeFailure = validateCommandTime(context, now);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    let binding: GatewayCredentialBinding;
    if (input.authentication.kind === "gateway-signed") {
      binding = Object.freeze({
        tenantId: input.authentication.fact.tenantId,
        projectId: input.authentication.fact.projectId,
        gatewayId: input.authentication.fact.gatewayId,
        generation: input.authentication.fact.credentialGeneration,
        status: "active",
      });
    } else {
      const verified = await this.#credentialVerifier.verify(
        input.authentication.credential,
      );
      if (!verified.ok) {
        return failure(
          "invalid-gateway-credential",
          "Gateway credential was rejected",
        );
      }
      if (verified.value.status !== "active") {
        return failure(
          "gateway-credential-inactive",
          "Gateway credential is inactive",
        );
      }
      if (verified.value.generation !== input.credentialGeneration) {
        return failure(
          "invalid-gateway-credential",
          "Gateway credential generation does not match the receipt",
        );
      }
      binding = verified.value;
    }
    const session = await this.#sessions.findCurrent(
      binding,
      binding.gatewayId,
    );
    if (
      session === undefined ||
      session.state !== "active" ||
      session.tenantId !== binding.tenantId ||
      session.projectId !== binding.projectId ||
      session.gatewayId !== binding.gatewayId ||
      session.sessionId !== input.sessionId ||
      session.epoch !== input.sessionEpoch ||
      session.credentialGeneration !== input.credentialGeneration
    ) {
      return failure(
        "cloudlink-session-not-active",
        "Receipt is not bound to the active current CloudLink session",
      );
    }
    if (input.authentication.kind === "credential") {
      const authenticationInput: IntegrationControlReceiptAuthenticationInput =
        {
          gatewayId: binding.gatewayId,
          credentialGeneration: input.credentialGeneration,
          sessionId: input.sessionId,
          sessionEpoch: input.sessionEpoch,
          sentAtMs: input.sentAtMs,
          ...(input.expiresAtMs === undefined
            ? {}
            : { expiresAtMs: input.expiresAtMs }),
          ...(input.traceparent === undefined
            ? {}
            : { traceparent: input.traceparent }),
          delivery: input.delivery,
          messageAuthentication: input.authentication.messageAuthentication,
          receipt: input.receipt,
        };
      if (!(await this.#authenticator.verify(authenticationInput))) {
        return failure(
          "integration-receipt-authentication-invalid",
          "Integration Control receipt authentication is invalid",
        );
      }
    }
    const intent = await this.#repository.findIntent(
      binding,
      binding.gatewayId,
      input.receipt.jobId,
    );
    if (intent === undefined) {
      return failure(
        "integration-control-not-found",
        "Integration Control intent was not found",
      );
    }
    const receiptCapabilityId: unknown = input.receipt.capabilityId;
    if (
      intent.intentDigest !== input.receipt.intentDigest ||
      receiptCapabilityId !== intent.intent.capability_id ||
      !targetsEqual(input.receipt, intent.intent)
    ) {
      return failure(
        "integration-receipt-conflict",
        "Integration Control receipt does not match its immutable intent",
      );
    }
    const persisted = await this.#repository.persistReceipt({
      scope: {
        tenantId: binding.tenantId,
        projectId: binding.projectId,
      },
      gatewayId: binding.gatewayId,
      requestId: context.requestId,
      credentialGeneration: binding.generation,
      sessionId: input.sessionId,
      sessionEpoch: input.sessionEpoch,
      delivery: {
        ...input.delivery,
        messageKind: "integration-action-receipt",
        sentAtMs: input.sentAtMs,
        expiresAtMs: input.expiresAtMs ?? null,
      },
      receipt: input.receipt,
      receivedAt: now,
    });
    if (persisted.outcome !== "persisted" && persisted.outcome !== "replayed") {
      return mapReceiptFailure(persisted.outcome);
    }
    return {
      ok: true,
      replayed: persisted.outcome === "replayed",
      value: Object.freeze({
        disposition: persisted.outcome,
        auditEventId: persisted.evidence.auditEventId,
        stage: persisted.evidence.receipt.stage,
        providerAccepted: persisted.evidence.providerAccepted,
        physicalCompleted: false,
        jobSucceeded: false,
        durableAcknowledgement: persisted.durableAcknowledgement,
      }),
    };
  }
}

export class ReofferIntegrationPowerControls {
  readonly #repository: IntegrationControlRepository;
  readonly #sessions: IntegrationControlSessionReader;
  readonly #manifests: IntegrationControlRuntimeProtocolReader;
  readonly #signer: IntegrationControlOfferSigner;
  readonly #clock: IntegrationControlApplicationClock;
  readonly #enabled: boolean;

  constructor(dependencies: {
    readonly repository: IntegrationControlRepository;
    readonly sessions: IntegrationControlSessionReader;
    readonly manifests: IntegrationControlRuntimeProtocolReader;
    readonly signer: IntegrationControlOfferSigner;
    readonly clock: IntegrationControlApplicationClock;
    readonly enabled?: boolean;
  }) {
    this.#repository = dependencies.repository;
    this.#sessions = dependencies.sessions;
    this.#manifests = dependencies.manifests;
    this.#signer = dependencies.signer;
    this.#clock = dependencies.clock;
    this.#enabled = dependencies.enabled ?? false;
  }

  async execute(
    rawScope: unknown,
    rawInput: unknown,
  ): Promise<
    IntegrationControlApplicationResult<IntegrationControlReofferView>
  > {
    if (!this.#enabled) {
      return failure(
        "integration-control-disabled",
        "Integration Control is disabled",
      );
    }
    const decoded = decodeSafely(() => ({
      scope: decodeScope(rawScope),
      input: decodeGatewayInput(rawInput),
      now: parseUtcInstant(this.#clock.now()),
    }));
    if (!decoded.ok) return decoded;
    const { scope, input, now } = decoded.value;
    const dispatch = await currentDispatchState(
      scope,
      input.gatewayId,
      this.#sessions,
      this.#manifests,
    );
    if (!dispatch.ok) return dispatch;
    const pendingCurrentOffers = await this.#repository.listDispatchableOffers(
      scope,
      input.gatewayId,
    );
    const pendingCurrentIntentKeys = new Set(
      pendingCurrentOffers
        .filter(
          (event) =>
            event.status === "pending" &&
            offerMatchesSession(event, dispatch.session),
        )
        .map((event) => `${event.jobId}\0${event.intentDigest}`),
    );
    const unresolved = await this.#repository.listUnresolvedIntents(
      scope,
      input.gatewayId,
    );
    const nowMs = milliseconds(now);
    const offers: IntegrationControlActionOffer[] = [];
    let deferred = 0;
    for (const intent of unresolved) {
      if (
        intent.tenantId !== scope.tenantId ||
        intent.projectId !== scope.projectId ||
        intent.gatewayId !== input.gatewayId ||
        intent.latestReceipt?.stage === "edge-rejected" ||
        intent.latestReceipt?.stage === "provider-rejected" ||
        BigInt(intent.expiresAtMs) <= BigInt(nowMs)
      ) {
        deferred += 1;
        continue;
      }
      if (
        pendingCurrentIntentKeys.has(`${intent.jobId}\0${intent.intentDigest}`)
      ) {
        continue;
      }
      let offer;
      try {
        offer = await signedOffer(
          {
            gatewayId: input.gatewayId,
            session: dispatch.session,
            jobId: intent.jobId,
            issuedAtMs: nowMs,
            expiresAtMs: intent.expiresAtMs,
            intentDigest: intent.intentDigest,
            intent: intent.intent,
          },
          this.#signer,
        );
      } catch (error: unknown) {
        if (
          error instanceof InvalidDomainValueError ||
          error instanceof IntegrationControlInputError
        ) {
          return failure("invalid-input", error.message);
        }
        throw error;
      }
      const persisted = await this.#repository.persistReoffer({
        scope,
        gatewayId: input.gatewayId,
        requestId: `reoffer:${intent.jobId}:${dispatch.session.sessionId}:${dispatch.session.epoch}`,
        subjectId: "system:cloudlink-reconnect",
        offer,
        createdAt: now,
      });
      if (
        persisted.outcome !== "persisted" &&
        persisted.outcome !== "replayed"
      ) {
        return mapPersistenceFailure(persisted.outcome);
      }
      offers.push(persisted.offer.offer);
    }
    return {
      ok: true,
      replayed: false,
      value: Object.freeze({
        staged: offers.length,
        deferred,
        offers: Object.freeze(offers),
      }),
    };
  }
}

function offerMatchesSession(
  event: IntegrationOfferOutboxRecord,
  session: CloudLinkSession,
): boolean {
  return (
    event.gatewayId === session.gatewayId &&
    event.sessionId === session.sessionId &&
    event.sessionEpoch === session.epoch &&
    event.offer.credential_generation === session.credentialGeneration
  );
}

export class PublishIntegrationControlOffers {
  readonly #repository: IntegrationControlRepository;
  readonly #sessions: IntegrationControlSessionReader;
  readonly #manifests: IntegrationControlRuntimeProtocolReader;
  readonly #publisher: IntegrationControlOfferPublisher;
  readonly #clock: IntegrationControlApplicationClock;
  readonly #enabled: boolean;

  constructor(dependencies: {
    readonly repository: IntegrationControlRepository;
    readonly sessions: IntegrationControlSessionReader;
    readonly manifests: IntegrationControlRuntimeProtocolReader;
    readonly publisher: IntegrationControlOfferPublisher;
    readonly clock: IntegrationControlApplicationClock;
    readonly enabled?: boolean;
  }) {
    this.#repository = dependencies.repository;
    this.#sessions = dependencies.sessions;
    this.#manifests = dependencies.manifests;
    this.#publisher = dependencies.publisher;
    this.#clock = dependencies.clock;
    this.#enabled = dependencies.enabled ?? false;
  }

  async execute(
    rawScope: unknown,
    rawInput: unknown,
  ): Promise<
    IntegrationControlApplicationResult<IntegrationControlPublishView>
  > {
    if (!this.#enabled) {
      return failure(
        "integration-control-disabled",
        "Integration Control is disabled",
      );
    }
    const decoded = decodeSafely(() => ({
      scope: decodeScope(rawScope),
      input: decodeGatewayInput(rawInput),
      now: parseUtcInstant(this.#clock.now()),
    }));
    if (!decoded.ok) return decoded;
    const { scope, input, now } = decoded.value;
    const nowMs = milliseconds(now);
    const dispatch = await currentDispatchState(
      scope,
      input.gatewayId,
      this.#sessions,
      this.#manifests,
    );
    if (!dispatch.ok) return dispatch;
    const events = await this.#repository.listDispatchableOffers(
      scope,
      input.gatewayId,
    );
    let published = 0;
    let deferred = 0;
    for (const event of events) {
      if (
        !offerMatchesSession(event, dispatch.session) ||
        BigInt(event.offer.expires_at_ms) <= BigInt(nowMs)
      ) {
        deferred += 1;
        continue;
      }
      try {
        await this.#publisher.publish(event.offer);
      } catch {
        return failure(
          "integration-control-publish-failed",
          "Integration Control offer publication failed",
        );
      }
      const marked = await this.#repository.markOfferPublished(
        scope,
        event.eventId,
        now,
      );
      if (marked.outcome === "storage-unavailable") {
        return failure(
          "integration-control-storage-unavailable",
          "Integration Control publication evidence is unavailable",
        );
      }
      if (marked.outcome === "not-found") {
        return failure(
          "integration-control-not-found",
          "Integration Control outbox event was not found",
        );
      }
      published += 1;
    }
    return {
      ok: true,
      replayed: false,
      value: Object.freeze({ published, deferred }),
    };
  }
}

export type {
  IntegrationControlActionIntent,
  IntegrationControlActionOffer,
  IntegrationControlIntentDigestor,
  IntegrationControlOfferPublisher,
  IntegrationControlOfferSigner,
  IntegrationControlReceiptAuthenticator,
  IntegrationControlRepository,
  IntegrationControlScope,
} from "./integration-control-repository.js";
