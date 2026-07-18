import {
  InvalidDomainValueError,
  parseCloudLinkGatewayKeyId,
  parseCloudLinkHeartbeatIntervalMs,
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
  parseTenantId,
} from "@aether-cloud/domain";
import type {
  CloudLinkSession,
  CloudLinkSessionEpoch,
  CloudLinkSessionId,
  GatewayCredentialGeneration,
  GatewayId,
  ProjectId,
  StreamEpoch,
  StreamId,
  StreamPosition,
  TenantId,
} from "@aether-cloud/domain";

import type {
  CloudLinkUplinkAuthenticationRepository,
  CloudLinkUplinkAuthenticationRepositoryResult,
} from "./cloudlink-uplink-authentication-repository.js";

const maximumUint64 = 18_446_744_073_709_551_615n;
const canonicalUint64Pattern = /^(?:0|[1-9][0-9]*)$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const base64urlAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;
const deliveryMessageKinds = new Set([
  "data-loss",
  "integration-action-receipt",
  "integration-observation-batch",
  "integration-topology-snapshot",
  "runtime-manifest-report",
  "telemetry-batch",
]);

export interface CloudLinkUplinkSigningProjection {
  readonly schema: "aether.cloudlink.uplink-signing.v1alpha1";
  readonly gateway_id: GatewayId;
  readonly credential_generation: GatewayCredentialGeneration;
  readonly session_id: CloudLinkSessionId;
  readonly session_epoch: CloudLinkSessionEpoch;
  readonly message_kind: string;
  readonly sent_at_ms: string;
  readonly expires_at_ms: string | null;
  readonly stream_id: StreamId | null;
  readonly stream_epoch: StreamEpoch | null;
  readonly position: StreamPosition | null;
  readonly batch_id: string | null;
  readonly business_digest: string | null;
}

export interface CloudLinkUplinkMessageAuthentication {
  readonly keyId: string;
  readonly algorithm: "Ed25519";
  readonly signature: string;
}

export interface CloudLinkUplinkCryptographicVerifierInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly gatewayKeyId: string;
  readonly authentication: CloudLinkUplinkMessageAuthentication;
  readonly projection: CloudLinkUplinkSigningProjection;
}

export interface CloudLinkUplinkCryptographicVerification {
  readonly gatewayKeyActive: boolean;
  readonly signatureVerified: boolean;
  readonly signingObjectDigest?: string;
}

export interface CloudLinkUplinkCryptographicVerifier {
  verify(
    input: CloudLinkUplinkCryptographicVerifierInput,
  ): Promise<CloudLinkUplinkCryptographicVerification | undefined>;
}

export interface CloudLinkUplinkEvaluationClock {
  nowMilliseconds(): string;
}

export interface CloudLinkBusinessPayloadDigestor {
  digest(input: {
    readonly protocolVersion: "1.0";
    readonly messageKind: string;
    readonly payload: unknown;
  }): Promise<string>;
}

export interface GatewaySignedCloudLinkBusinessDelivery {
  readonly sentAtMs: string;
  readonly expiresAtMs: string | null;
  readonly sessionId: CloudLinkSessionId;
  readonly sessionEpoch: CloudLinkSessionEpoch;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly streamId: StreamId;
  readonly streamEpoch: StreamEpoch;
  readonly position: StreamPosition;
  readonly batchId: string;
  readonly digest: string;
  readonly messageKind: string;
}

export function decodeGatewaySignedCloudLinkBusinessDelivery(
  input: unknown,
): GatewaySignedCloudLinkBusinessDelivery | undefined {
  try {
    const record = requireRecord(input, "CloudLink business delivery");
    requireExactKeys(
      record,
      [
        "batchId",
        "credentialGeneration",
        "digest",
        "expiresAtMs",
        "messageKind",
        "position",
        "sentAtMs",
        "sessionEpoch",
        "sessionId",
        "streamEpoch",
        "streamId",
      ],
      "CloudLink business delivery",
    );
    if (
      typeof record.messageKind !== "string" ||
      !deliveryMessageKinds.has(record.messageKind) ||
      typeof record.batchId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.batchId) ||
      typeof record.digest !== "string" ||
      !digestPattern.test(record.digest)
    ) {
      return undefined;
    }
    const sentAtMs = parseUint64(record.sentAtMs, "sentAtMs");
    const expiresAtMs =
      record.expiresAtMs === null
        ? null
        : parseUint64(record.expiresAtMs, "expiresAtMs");
    if (expiresAtMs !== null && BigInt(expiresAtMs) < BigInt(sentAtMs)) {
      return undefined;
    }
    return Object.freeze({
      sentAtMs,
      expiresAtMs,
      sessionId: parseCloudLinkSessionId(record.sessionId),
      sessionEpoch: parseCloudLinkSessionEpoch(record.sessionEpoch),
      credentialGeneration: parseGatewayCredentialGeneration(
        record.credentialGeneration,
      ),
      streamId: parseStreamId(record.streamId),
      streamEpoch: parseStreamEpoch(record.streamEpoch),
      position: parseStreamPosition(record.position),
      batchId: record.batchId,
      digest: record.digest,
      messageKind: record.messageKind,
    });
  } catch {
    return undefined;
  }
}

export interface CloudLinkUplinkSessionReader {
  findCurrent(
    scope: Readonly<{ tenantId: TenantId; projectId: ProjectId }>,
    gatewayId: GatewayId,
  ): Promise<CloudLinkSession | undefined>;
}

export interface GatewaySignedCloudLinkUplinkAuthenticationFact {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly sessionId: CloudLinkSessionId;
  readonly sessionEpoch: CloudLinkSessionEpoch;
  readonly sessionRevision: number;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly gatewayKeyId: string;
  readonly messageKind: string;
  readonly signingObjectDigest: string;
  readonly signingProjection: CloudLinkUplinkSigningProjection;
  readonly refreshServerLiveness: boolean;
}

const authenticatedUplinkFacts = new WeakSet<object>();

export function isGatewaySignedCloudLinkUplinkAuthenticationFact(
  input: unknown,
): input is GatewaySignedCloudLinkUplinkAuthenticationFact {
  return (
    typeof input === "object" &&
    input !== null &&
    authenticatedUplinkFacts.has(input)
  );
}

export type GatewaySignedCloudLinkAuthenticationConsumptionResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      failure: "AUTHENTICATION_INVALID" | "MESSAGE_EXPIRED";
    }>;

function factBaseIsValid(
  fact: GatewaySignedCloudLinkUplinkAuthenticationFact,
): boolean {
  const projection = fact.signingProjection;
  return (
    Number.isSafeInteger(fact.sessionRevision) &&
    fact.sessionRevision > 0 &&
    digestPattern.test(fact.signingObjectDigest) &&
    hasExpectedSigningProjectionSchema(projection) &&
    projection.gateway_id === fact.gatewayId &&
    projection.credential_generation === fact.credentialGeneration &&
    projection.session_id === fact.sessionId &&
    projection.session_epoch === fact.sessionEpoch &&
    projection.message_kind === fact.messageKind
  );
}

/**
 * Revalidates an opaque authentication fact at the business-use-case boundary.
 *
 * Delivery consumers must provide the exact decoded wire payload. The digest
 * adapter canonicalizes that payload independently of the interface bridge,
 * and expiry is evaluated again at the instant of consumption.
 */
export async function validateGatewaySignedCloudLinkAuthenticationConsumption(
  input:
    | Readonly<{
        kind: "heartbeat";
        fact: GatewaySignedCloudLinkUplinkAuthenticationFact;
        observedAtMs: string;
        nowMs: string;
      }>
    | Readonly<{
        kind: "delivery";
        fact: GatewaySignedCloudLinkUplinkAuthenticationFact;
        delivery: GatewaySignedCloudLinkBusinessDelivery;
        payload: unknown;
        nowMs: string;
        digestor: CloudLinkBusinessPayloadDigestor;
      }>,
): Promise<GatewaySignedCloudLinkAuthenticationConsumptionResult> {
  if (
    !isGatewaySignedCloudLinkUplinkAuthenticationFact(input.fact) ||
    !factBaseIsValid(input.fact)
  ) {
    return { ok: false, failure: "AUTHENTICATION_INVALID" };
  }
  let nowMs: string;
  try {
    nowMs = parseUint64(input.nowMs, "nowMs");
  } catch {
    return { ok: false, failure: "AUTHENTICATION_INVALID" };
  }
  const projection = input.fact.signingProjection;
  if (input.kind === "heartbeat") {
    let observedAtMs: string;
    try {
      observedAtMs = parseUint64(input.observedAtMs, "observedAtMs");
    } catch {
      return { ok: false, failure: "AUTHENTICATION_INVALID" };
    }
    return input.fact.messageKind === "heartbeat" &&
      projection.sent_at_ms === observedAtMs &&
      projection.expires_at_ms === null &&
      projection.stream_id === null &&
      projection.stream_epoch === null &&
      projection.position === null &&
      projection.batch_id === null &&
      projection.business_digest === null
      ? { ok: true }
      : { ok: false, failure: "AUTHENTICATION_INVALID" };
  }
  const delivery = input.delivery;
  let sentAtMs: string;
  let expiresAtMs: string | null;
  try {
    sentAtMs = parseUint64(delivery.sentAtMs, "sentAtMs");
    expiresAtMs =
      delivery.expiresAtMs === null
        ? null
        : parseUint64(delivery.expiresAtMs, "expiresAtMs");
  } catch {
    return { ok: false, failure: "AUTHENTICATION_INVALID" };
  }
  if (
    expiresAtMs !== null &&
    (BigInt(expiresAtMs) < BigInt(sentAtMs) ||
      BigInt(nowMs) >= BigInt(expiresAtMs))
  ) {
    return { ok: false, failure: "MESSAGE_EXPIRED" };
  }
  if (
    input.fact.messageKind !== delivery.messageKind ||
    input.fact.sessionId !== delivery.sessionId ||
    input.fact.sessionEpoch !== delivery.sessionEpoch ||
    input.fact.credentialGeneration !== delivery.credentialGeneration ||
    projection.sent_at_ms !== sentAtMs ||
    projection.expires_at_ms !== expiresAtMs ||
    projection.stream_id !== delivery.streamId ||
    projection.stream_epoch !== delivery.streamEpoch ||
    projection.position !== delivery.position ||
    projection.batch_id !== delivery.batchId ||
    projection.business_digest !== delivery.digest ||
    !digestPattern.test(delivery.digest)
  ) {
    return { ok: false, failure: "AUTHENTICATION_INVALID" };
  }
  try {
    const actualDigest = await input.digestor.digest({
      protocolVersion: "1.0",
      messageKind: delivery.messageKind,
      payload: input.payload,
    });
    return digestPattern.test(actualDigest) && actualDigest === delivery.digest
      ? { ok: true }
      : { ok: false, failure: "AUTHENTICATION_INVALID" };
  } catch {
    return { ok: false, failure: "AUTHENTICATION_INVALID" };
  }
}

function mintGatewaySignedUplinkAuthenticationFact(
  input: GatewaySignedCloudLinkUplinkAuthenticationFact,
): GatewaySignedCloudLinkUplinkAuthenticationFact {
  const signingProjection = Object.freeze({
    schema: input.signingProjection.schema,
    gateway_id: input.signingProjection.gateway_id,
    credential_generation: input.signingProjection.credential_generation,
    session_id: input.signingProjection.session_id,
    session_epoch: input.signingProjection.session_epoch,
    message_kind: input.signingProjection.message_kind,
    sent_at_ms: input.signingProjection.sent_at_ms,
    expires_at_ms: input.signingProjection.expires_at_ms,
    stream_id: input.signingProjection.stream_id,
    stream_epoch: input.signingProjection.stream_epoch,
    position: input.signingProjection.position,
    batch_id: input.signingProjection.batch_id,
    business_digest: input.signingProjection.business_digest,
  } satisfies CloudLinkUplinkSigningProjection);
  const fact = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries({
    ...input,
    signingProjection,
  })) {
    Object.defineProperty(fact, key, {
      configurable: false,
      enumerable: false,
      writable: false,
      value,
    });
  }
  Object.freeze(fact);
  authenticatedUplinkFacts.add(fact);
  return fact as unknown as GatewaySignedCloudLinkUplinkAuthenticationFact;
}

export type GatewaySignedCloudLinkUplinkAuthenticationFailureCode =
  | "AUTHENTICATION_INVALID"
  | "GATEWAY_SIGNED_UPLINK_DISABLED"
  | "INVALID_INPUT"
  | "MESSAGE_EXPIRED";

export type GatewaySignedCloudLinkUplinkAuthenticationResult =
  | Readonly<{
      ok: true;
      replayed: boolean;
      value: GatewaySignedCloudLinkUplinkAuthenticationFact;
    }>
  | Readonly<{
      ok: false;
      failure: Readonly<{
        code: GatewaySignedCloudLinkUplinkAuthenticationFailureCode;
        message: string;
      }>;
    }>;

interface DecodedCommon {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly sessionId: CloudLinkSessionId;
  readonly sessionEpoch: CloudLinkSessionEpoch;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly messageKind: string;
  readonly authentication: CloudLinkUplinkMessageAuthentication;
}

interface DecodedHeartbeat extends DecodedCommon {
  readonly kind: "heartbeat";
  readonly observedAtMs: string;
}

interface DecodedDelivery extends DecodedCommon {
  readonly kind: "delivery";
  readonly sentAtMs: string;
  readonly expiresAtMs?: string;
  readonly delivery: Readonly<{
    streamId: StreamId;
    streamEpoch: StreamEpoch;
    position: StreamPosition;
    batchId: string;
    digest: string;
  }>;
}

type DecodedUplink = DecodedDelivery | DecodedHeartbeat;

class UplinkAuthenticationInputError extends Error {}

function failure(
  code: GatewaySignedCloudLinkUplinkAuthenticationFailureCode,
  message: string,
): Extract<GatewaySignedCloudLinkUplinkAuthenticationResult, { ok: false }> {
  return { ok: false, failure: { code, message } };
}

function authenticationFailure(): Extract<
  GatewaySignedCloudLinkUplinkAuthenticationResult,
  { ok: false }
> {
  return failure(
    "AUTHENTICATION_INVALID",
    "Gateway uplink authentication is invalid",
  );
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
    throw new UplinkAuthenticationInputError(`${field} must be an object`);
  }
  return input;
}

function requireExactKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new UplinkAuthenticationInputError(
      `${field} contains unknown or missing fields`,
    );
  }
}

function requirePattern(
  input: unknown,
  pattern: RegExp,
  field: string,
): string {
  if (typeof input !== "string" || !pattern.test(input)) {
    throw new UplinkAuthenticationInputError(`${field} is invalid`);
  }
  return input;
}

function parseUint64(input: unknown, field: string, positive = false): string {
  if (
    typeof input !== "string" ||
    !canonicalUint64Pattern.test(input) ||
    BigInt(input) > maximumUint64 ||
    (positive && input === "0")
  ) {
    throw new UplinkAuthenticationInputError(
      `${field} must be a canonical bounded uint64`,
    );
  }
  return input;
}

function decodeAuthentication(
  input: unknown,
): CloudLinkUplinkMessageAuthentication {
  const authentication = requireRecord(
    input,
    "CloudLink message authentication",
  );
  requireExactKeys(
    authentication,
    ["algorithm", "keyId", "signature"],
    "CloudLink message authentication",
  );
  if (authentication.algorithm !== "Ed25519") {
    throw new UplinkAuthenticationInputError(
      "CloudLink message authentication algorithm is invalid",
    );
  }
  const signature = requirePattern(
    authentication.signature,
    signaturePattern,
    "CloudLink message authentication signature",
  );
  const finalSextet = base64urlAlphabet.indexOf(signature.at(-1) ?? "");
  const decodedByteLength = Math.floor((signature.length * 6) / 8);
  const unusedTailBits = signature.length * 6 - decodedByteLength * 8;
  if (
    decodedByteLength !== 64 ||
    unusedTailBits !== 4 ||
    finalSextet < 0 ||
    (finalSextet & ((1 << unusedTailBits) - 1)) !== 0
  ) {
    throw new UplinkAuthenticationInputError(
      "CloudLink message authentication signature is invalid",
    );
  }
  return {
    keyId: parseCloudLinkGatewayKeyId(authentication.keyId),
    algorithm: "Ed25519",
    signature,
  };
}

function decodeCommon(
  record: Record<string, unknown>,
): Omit<DecodedCommon, "messageKind"> {
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
    gatewayId: parseGatewayId(record.gatewayId),
    sessionId: parseCloudLinkSessionId(record.sessionId),
    sessionEpoch: parseCloudLinkSessionEpoch(record.sessionEpoch),
    credentialGeneration: parseGatewayCredentialGeneration(
      record.credentialGeneration,
    ),
    authentication: decodeAuthentication(record.messageAuthentication),
  };
}

function decodeUplink(input: unknown): DecodedUplink {
  const record = requireRecord(input, "Gateway-signed CloudLink uplink");
  if (record.messageKind === "heartbeat") {
    requireExactKeys(
      record,
      [
        "credentialGeneration",
        "gatewayId",
        "messageAuthentication",
        "messageKind",
        "observedAtMs",
        "projectId",
        "sessionEpoch",
        "sessionId",
        "tenantId",
      ],
      "Gateway-signed CloudLink heartbeat",
    );
    return {
      ...decodeCommon(record),
      kind: "heartbeat",
      messageKind: "heartbeat",
      observedAtMs: parseUint64(record.observedAtMs, "observedAtMs"),
    };
  }
  if (
    typeof record.messageKind !== "string" ||
    !deliveryMessageKinds.has(record.messageKind)
  ) {
    throw new UplinkAuthenticationInputError(
      "Gateway-signed CloudLink message kind is unsupported",
    );
  }
  requireExactKeys(
    record,
    [
      "credentialGeneration",
      "delivery",
      ...(record.expiresAtMs === undefined ? [] : ["expiresAtMs"]),
      "gatewayId",
      "messageAuthentication",
      "messageKind",
      "projectId",
      "sentAtMs",
      "sessionEpoch",
      "sessionId",
      "tenantId",
    ],
    "Gateway-signed CloudLink delivery",
  );
  const delivery = requireRecord(record.delivery, "CloudLink delivery");
  requireExactKeys(
    delivery,
    ["batchId", "digest", "position", "streamEpoch", "streamId"],
    "CloudLink delivery",
  );
  const position = parseStreamPosition(delivery.position);
  if (position === "0") {
    throw new UplinkAuthenticationInputError(
      "CloudLink delivery position must be positive",
    );
  }
  const sentAtMs = parseUint64(record.sentAtMs, "sentAtMs");
  const expiresAtMs =
    record.expiresAtMs === undefined
      ? undefined
      : parseUint64(record.expiresAtMs, "expiresAtMs");
  return {
    ...decodeCommon(record),
    kind: "delivery",
    messageKind: record.messageKind,
    sentAtMs,
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    delivery: {
      streamId: parseStreamId(delivery.streamId),
      streamEpoch: parseStreamEpoch(delivery.streamEpoch),
      position,
      batchId: requirePattern(
        delivery.batchId,
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
        "delivery.batchId",
      ),
      digest: requirePattern(delivery.digest, digestPattern, "delivery.digest"),
    },
  };
}

function decodeSafely(
  input: unknown,
):
  | Readonly<{ ok: true; value: DecodedUplink }>
  | Extract<GatewaySignedCloudLinkUplinkAuthenticationResult, { ok: false }> {
  try {
    return { ok: true, value: decodeUplink(input) };
  } catch (error: unknown) {
    if (
      error instanceof InvalidDomainValueError ||
      error instanceof UplinkAuthenticationInputError
    ) {
      return failure("INVALID_INPUT", "Gateway uplink input is invalid");
    }
    throw error;
  }
}

function projectUplink(input: DecodedUplink): CloudLinkUplinkSigningProjection {
  const common = {
    schema: "aether.cloudlink.uplink-signing.v1alpha1" as const,
    gateway_id: input.gatewayId,
    credential_generation: input.credentialGeneration,
    session_id: input.sessionId,
    session_epoch: input.sessionEpoch,
    message_kind: input.messageKind,
  };
  if (input.kind === "heartbeat") {
    return {
      ...common,
      sent_at_ms: input.observedAtMs,
      expires_at_ms: null,
      stream_id: null,
      stream_epoch: null,
      position: null,
      batch_id: null,
      business_digest: null,
    };
  }
  return {
    ...common,
    sent_at_ms: input.sentAtMs,
    expires_at_ms: input.expiresAtMs ?? null,
    stream_id: input.delivery.streamId,
    stream_epoch: input.delivery.streamEpoch,
    position: input.delivery.position,
    batch_id: input.delivery.batchId,
    business_digest: input.delivery.digest,
  };
}

function sessionMatches(
  session: CloudLinkSession | undefined,
  input: DecodedUplink,
): session is CloudLinkSession & {
  readonly gatewayKeyId: string;
  readonly heartbeatIntervalMs: string;
} {
  return (
    session !== undefined &&
    session.state === "active" &&
    session.tenantId === input.tenantId &&
    session.projectId === input.projectId &&
    session.gatewayId === input.gatewayId &&
    session.sessionId === input.sessionId &&
    session.epoch === input.sessionEpoch &&
    session.credentialGeneration === input.credentialGeneration &&
    session.gatewayKeyId !== undefined &&
    session.heartbeatIntervalMs !== undefined &&
    session.gatewayKeyId === input.authentication.keyId
  );
}

function checkedAdd(left: bigint, right: bigint): bigint | undefined {
  return left > maximumUint64 - right ? undefined : left + right;
}

function checkedMultiply(value: bigint, factor: bigint): bigint | undefined {
  return value > maximumUint64 / factor ? undefined : value * factor;
}

function validateFreshness(
  input: DecodedUplink,
  session: CloudLinkSession & { readonly heartbeatIntervalMs: string },
  evaluationTimeMs: string,
): GatewaySignedCloudLinkUplinkAuthenticationResult | undefined {
  const evaluationTime = BigInt(evaluationTimeMs);
  if (input.kind === "delivery") {
    if (
      input.expiresAtMs !== undefined &&
      BigInt(input.expiresAtMs) < BigInt(input.sentAtMs)
    ) {
      return failure("INVALID_INPUT", "Gateway uplink input is invalid");
    }
    return input.expiresAtMs !== undefined &&
      evaluationTime >= BigInt(input.expiresAtMs)
      ? failure("MESSAGE_EXPIRED", "Gateway uplink message has expired")
      : undefined;
  }
  const observedAt = BigInt(input.observedAtMs);
  const heartbeatInterval = BigInt(
    parseCloudLinkHeartbeatIntervalMs(session.heartbeatIntervalMs),
  );
  const futureBoundary = checkedAdd(evaluationTime, heartbeatInterval);
  const staleWidth = checkedMultiply(heartbeatInterval, 3n);
  const staleBoundary =
    staleWidth === undefined ? undefined : checkedAdd(observedAt, staleWidth);
  if (futureBoundary === undefined || staleBoundary === undefined) {
    return authenticationFailure();
  }
  if (observedAt > futureBoundary) return authenticationFailure();
  if (evaluationTime >= staleBoundary) {
    return failure("MESSAGE_EXPIRED", "Gateway uplink message has expired");
  }
  return undefined;
}

function repositoryFailure(
  result: CloudLinkUplinkAuthenticationRepositoryResult,
): GatewaySignedCloudLinkUplinkAuthenticationResult | undefined {
  return result.outcome === "conflict" || result.outcome === "lower"
    ? authenticationFailure()
    : undefined;
}

export class AuthenticateGatewaySignedCloudLinkUplink {
  readonly #sessions: CloudLinkUplinkSessionReader;
  readonly #repository: CloudLinkUplinkAuthenticationRepository;
  readonly #verifier: CloudLinkUplinkCryptographicVerifier;
  readonly #clock: CloudLinkUplinkEvaluationClock;
  readonly #enabled: boolean;

  constructor(dependencies: {
    readonly sessions: CloudLinkUplinkSessionReader;
    readonly repository: CloudLinkUplinkAuthenticationRepository;
    readonly verifier: CloudLinkUplinkCryptographicVerifier;
    readonly clock: CloudLinkUplinkEvaluationClock;
    readonly enabled?: boolean;
  }) {
    this.#sessions = dependencies.sessions;
    this.#repository = dependencies.repository;
    this.#verifier = dependencies.verifier;
    this.#clock = dependencies.clock;
    this.#enabled = dependencies.enabled ?? false;
  }

  async execute(
    rawInput: unknown,
  ): Promise<GatewaySignedCloudLinkUplinkAuthenticationResult> {
    if (!this.#enabled) {
      return failure(
        "GATEWAY_SIGNED_UPLINK_DISABLED",
        "Gateway-signed CloudLink uplinks are disabled",
      );
    }
    const decoded = decodeSafely(rawInput);
    if (!decoded.ok) return decoded;
    const input = decoded.value;
    let session: CloudLinkSession | undefined;
    try {
      session = await this.#sessions.findCurrent(input, input.gatewayId);
    } catch {
      return authenticationFailure();
    }
    if (!sessionMatches(session, input)) return authenticationFailure();
    const projection = projectUplink(input);
    let verified: CloudLinkUplinkCryptographicVerification | undefined;
    try {
      verified = await this.#verifier.verify({
        tenantId: input.tenantId,
        projectId: input.projectId,
        gatewayId: input.gatewayId,
        credentialGeneration: input.credentialGeneration,
        gatewayKeyId: session.gatewayKeyId,
        authentication: input.authentication,
        projection,
      });
    } catch {
      return authenticationFailure();
    }
    if (
      verified?.gatewayKeyActive !== true ||
      !verified.signatureVerified ||
      verified.signingObjectDigest === undefined ||
      !digestPattern.test(verified.signingObjectDigest)
    ) {
      return authenticationFailure();
    }
    let evaluationTimeMs: string;
    try {
      evaluationTimeMs = parseUint64(
        this.#clock.nowMilliseconds(),
        "evaluationTimeMs",
      );
    } catch {
      return authenticationFailure();
    }
    const freshnessFailure = validateFreshness(
      input,
      session,
      evaluationTimeMs,
    );
    if (freshnessFailure !== undefined) return freshnessFailure;
    if (input.kind === "delivery") {
      const fact = mintGatewaySignedUplinkAuthenticationFact({
        tenantId: input.tenantId,
        projectId: input.projectId,
        gatewayId: input.gatewayId,
        sessionId: input.sessionId,
        sessionEpoch: input.sessionEpoch,
        sessionRevision: session.revision,
        credentialGeneration: input.credentialGeneration,
        gatewayKeyId: session.gatewayKeyId,
        messageKind: input.messageKind,
        signingObjectDigest: verified.signingObjectDigest,
        signingProjection: projection,
        refreshServerLiveness: false,
      });
      return {
        ok: true,
        replayed: false,
        value: fact,
      };
    }
    let persisted: CloudLinkUplinkAuthenticationRepositoryResult;
    try {
      persisted = await this.#repository.acceptHeartbeat({
        tenantId: input.tenantId,
        projectId: input.projectId,
        gatewayId: input.gatewayId,
        sessionId: input.sessionId,
        sessionEpoch: input.sessionEpoch,
        credentialGeneration: input.credentialGeneration,
        observedAtMs: input.observedAtMs,
        exactSigningObjectDigest: verified.signingObjectDigest,
      });
    } catch {
      return authenticationFailure();
    }
    const replayFailure = repositoryFailure(persisted);
    if (replayFailure !== undefined) return replayFailure;
    const replayed = persisted.outcome === "replayed";
    const fact = mintGatewaySignedUplinkAuthenticationFact({
      tenantId: input.tenantId,
      projectId: input.projectId,
      gatewayId: input.gatewayId,
      sessionId: input.sessionId,
      sessionEpoch: input.sessionEpoch,
      sessionRevision: session.revision,
      credentialGeneration: input.credentialGeneration,
      gatewayKeyId: session.gatewayKeyId,
      messageKind: input.messageKind,
      signingObjectDigest: verified.signingObjectDigest,
      signingProjection: projection,
      refreshServerLiveness: !replayed,
    });
    return {
      ok: true,
      replayed,
      value: fact,
    };
  }
}
