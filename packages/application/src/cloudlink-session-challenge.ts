import {
  InvalidDomainValueError,
  parseCloudLinkGatewayKeyId,
  parseCloudLinkHeartbeatIntervalMs,
  parseCloudLinkSessionChallengeId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProtocolVersion,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
} from "@aether-cloud/domain";
import type {
  CloudLinkSession,
  CloudLinkSessionChallengeId,
  CloudLinkStreamCursor,
  GatewayCredentialBinding,
  GatewayCredentialGeneration,
  GatewayId,
  ProtocolVersion,
} from "@aether-cloud/domain";

import type {
  CloudLinkApplicationResult,
  CloudLinkSessionView,
} from "./cloudlink-session.js";
import type {
  CloudLinkSessionChallengeAuthentication,
  CloudLinkSessionChallengeRecord,
  CloudLinkSessionChallengeRepository,
  CloudLinkSessionIdGenerator,
  GatewayCredentialClaimResolver,
} from "./cloudlink-session-repository.js";
import type { ApplicationClock } from "./gateway-identity-repository.js";
import {
  ACCEPT_GATEWAY_SIGNED_CLOUDLINK_SESSION_COMMAND,
  REQUEST_CLOUDLINK_SESSION_CHALLENGE_COMMAND,
} from "./capability-definition.js";

const credentialIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const noncePattern = /^[A-Za-z0-9_-]{43}$/;
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;
const fingerprintPattern = /^sha256:[0-9a-f]{64}$/;
const minimumChallengeTtlMs = 1_000;
const maximumChallengeTtlMs = 300_000;
const maximumRateLimitWindowMs = 3_600_000;

type ChallengeFailureCode =
  | "gateway-challenge-expired"
  | "gateway-challenge-ineligible"
  | "gateway-challenge-not-found"
  | "gateway-challenge-rate-limited"
  | "gateway-challenge-request-conflict"
  | "gateway-hello-authentication-invalid"
  | "gateway-hello-binding-mismatch"
  | "gateway-signed-session-disabled"
  | "idempotency-conflict"
  | "invalid-input"
  | "invalid-session-repository-result"
  | "unsupported-protocol-version";

type ChallengeApplicationResult<Value> =
  | Readonly<{ ok: true; replayed: boolean; value: Value }>
  | Readonly<{
      ok: false;
      failure: Readonly<{ code: ChallengeFailureCode; message: string }>;
    }>;

export interface CloudLinkSessionChallengeSigningProjection {
  readonly schema: "aether.cloudlink.session-challenge-signing.v1alpha1";
  readonly gateway_id: GatewayId;
  readonly challenge_id: CloudLinkSessionChallengeId;
  readonly cloud_nonce: string;
  readonly issued_at_ms: string;
  readonly expires_at_ms: string;
}

export interface CloudLinkSessionChallengeSigner {
  sign(
    projection: CloudLinkSessionChallengeSigningProjection,
  ): Promise<CloudLinkSessionChallengeAuthentication>;
}

export interface CloudLinkSessionChallengeMaterialGenerator {
  nextChallengeId(): CloudLinkSessionChallengeId;
  nextNonce(): string;
}

export interface CloudLinkGatewayHelloAuthenticationInput {
  readonly gatewayId: GatewayId;
  readonly credentialId: string;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly gatewayKeyId: string;
  readonly challengeId: CloudLinkSessionChallengeId;
  readonly cloudNonce: string;
  readonly clientNonce: string;
  readonly offeredProtocolVersions: readonly ProtocolVersion[];
  readonly resumeCursors: readonly CloudLinkStreamCursor[];
  readonly gatewayAuthentication: CloudLinkSessionChallengeAuthentication;
}

export interface CloudLinkGatewayHelloAuthenticator {
  verify(
    input: CloudLinkGatewayHelloAuthenticationInput,
  ): Promise<string | undefined>;
}

export interface CloudLinkSessionChallengeView {
  readonly gatewayId: GatewayId;
  readonly challengeId: CloudLinkSessionChallengeId;
  readonly cloudNonce: string;
  readonly issuedAtMs: string;
  readonly expiresAtMs: string;
  readonly cloudAuthentication: CloudLinkSessionChallengeAuthentication;
}

class ChallengeInputError extends Error {}

function failure(
  code: ChallengeFailureCode,
  message: string,
): Readonly<{
  ok: false;
  failure: Readonly<{ code: ChallengeFailureCode; message: string }>;
}> {
  return { ok: false, failure: { code, message } };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function requireRecord(input: unknown, field: string): Record<string, unknown> {
  if (!isRecord(input))
    throw new ChallengeInputError(`${field} must be an object`);
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
    throw new ChallengeInputError(
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
    throw new ChallengeInputError(`${field} is invalid`);
  }
  return input;
}

function decodeProtocolVersions(input: unknown): readonly ProtocolVersion[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 8) {
    throw new ChallengeInputError("protocolVersions must contain 1-8 versions");
  }
  const versions = input.map(parseProtocolVersion);
  if (new Set(versions).size !== versions.length) {
    throw new ChallengeInputError("protocolVersions must be unique");
  }
  return Object.freeze(versions);
}

function decodeResume(input: unknown): readonly CloudLinkStreamCursor[] {
  if (!Array.isArray(input) || input.length > 32) {
    throw new ChallengeInputError(
      "clientPositions must contain at most 32 cursors",
    );
  }
  const identities = new Set<string>();
  return Object.freeze(
    input.map((rawCursor, index) => {
      const cursor = requireRecord(
        rawCursor,
        `clientPositions[${String(index)}]`,
      );
      requireExactKeys(
        cursor,
        ["position", "streamEpoch", "streamId"],
        `clientPositions[${String(index)}]`,
      );
      const streamId = parseStreamId(cursor.streamId);
      const streamEpoch = parseStreamEpoch(cursor.streamEpoch);
      const identity = `${streamId}\0${streamEpoch}`;
      if (identities.has(identity)) {
        throw new ChallengeInputError(
          "clientPositions must use unique stream/epoch identities",
        );
      }
      identities.add(identity);
      return Object.freeze({
        streamId,
        streamEpoch,
        position: parseStreamPosition(cursor.position),
      });
    }),
  );
}

interface DecodedRequest {
  readonly gatewayId: GatewayId;
  readonly credentialId: string;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly protocolVersions: readonly ProtocolVersion[];
  readonly clientNonce: string;
  readonly clientPositions: readonly CloudLinkStreamCursor[];
}

function decodeRequest(input: unknown): DecodedRequest {
  const record = requireRecord(input, "session challenge request");
  requireExactKeys(
    record,
    [
      "clientNonce",
      "clientPositions",
      "credentialGeneration",
      "credentialId",
      "gatewayId",
      "protocolVersions",
    ],
    "session challenge request",
  );
  const generation = parseGatewayCredentialGeneration(
    record.credentialGeneration,
  );
  if (generation === "0") {
    throw new ChallengeInputError("credentialGeneration must be positive");
  }
  return {
    gatewayId: parseGatewayId(record.gatewayId),
    credentialId: requirePattern(
      record.credentialId,
      credentialIdPattern,
      "credentialId",
    ),
    credentialGeneration: generation,
    protocolVersions: decodeProtocolVersions(record.protocolVersions),
    clientNonce: requirePattern(
      record.clientNonce,
      noncePattern,
      "clientNonce",
    ),
    clientPositions: decodeResume(record.clientPositions),
  };
}

interface DecodedHello extends DecodedRequest {
  readonly originModel: "gateway-signed";
  readonly challengeId: CloudLinkSessionChallengeId;
  readonly gatewayKeyId: string;
  readonly gatewayAuthentication: CloudLinkSessionChallengeAuthentication;
}

function decodeHello(input: unknown): DecodedHello {
  const record = requireRecord(input, "gateway-signed session hello");
  requireExactKeys(
    record,
    [
      "challengeId",
      "clientNonce",
      "clientPositions",
      "credentialGeneration",
      "credentialId",
      "gatewayAuthentication",
      "gatewayId",
      "gatewayKeyId",
      "originModel",
      "protocolVersions",
    ],
    "gateway-signed session hello",
  );
  if (record.originModel !== "gateway-signed") {
    throw new ChallengeInputError(
      "originModel must be gateway-signed for this command",
    );
  }
  const request = decodeRequest({
    gatewayId: record.gatewayId,
    credentialId: record.credentialId,
    credentialGeneration: record.credentialGeneration,
    protocolVersions: record.protocolVersions,
    clientNonce: record.clientNonce,
    clientPositions: record.clientPositions,
  });
  const authentication = requireRecord(
    record.gatewayAuthentication,
    "gatewayAuthentication",
  );
  requireExactKeys(
    authentication,
    ["algorithm", "keyId", "signature"],
    "gatewayAuthentication",
  );
  const keyId = requirePattern(
    record.gatewayKeyId,
    keyIdPattern,
    "gatewayKeyId",
  );
  const authenticationKeyId = requirePattern(
    authentication.keyId,
    keyIdPattern,
    "gatewayAuthentication.keyId",
  );
  if (keyId !== authenticationKeyId || authentication.algorithm !== "Ed25519") {
    throw new ChallengeInputError(
      "Gateway authentication key binding is invalid",
    );
  }
  return {
    ...request,
    originModel: "gateway-signed",
    challengeId: parseCloudLinkSessionChallengeId(record.challengeId),
    gatewayKeyId: keyId,
    gatewayAuthentication: {
      keyId: authenticationKeyId,
      algorithm: "Ed25519",
      signature: requirePattern(
        authentication.signature,
        signaturePattern,
        "gatewayAuthentication.signature",
      ),
    },
  };
}

function decodeSafely<Value>(decoder: () => Value):
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{
      ok: false;
      failure: Readonly<{ code: "invalid-input"; message: string }>;
    }> {
  try {
    return { ok: true, value: decoder() };
  } catch (error: unknown) {
    if (
      error instanceof ChallengeInputError ||
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

function unixMilliseconds(instant: string): string {
  const parsed = Date.parse(instant);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ChallengeInputError("clock is outside the Unix-ms profile");
  }
  return String(parsed);
}

function credentialMatches(
  binding: GatewayCredentialBinding | undefined,
  request: DecodedRequest,
): binding is GatewayCredentialBinding {
  return (
    binding !== undefined &&
    binding.status === "active" &&
    binding.gatewayId === request.gatewayId &&
    binding.generation === request.credentialGeneration
  );
}

function sameResume(
  left: readonly CloudLinkStreamCursor[],
  right: readonly CloudLinkStreamCursor[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (cursor, index) =>
        cursor.streamId === right[index]?.streamId &&
        cursor.streamEpoch === right[index].streamEpoch &&
        cursor.position === right[index].position,
    )
  );
}

function sameRequestState(
  challenge: CloudLinkSessionChallengeRecord,
  hello: DecodedHello,
): boolean {
  const request = challenge.request;
  return (
    challenge.binding.gatewayId === hello.gatewayId &&
    challenge.binding.generation === hello.credentialGeneration &&
    request.gatewayId === hello.gatewayId &&
    request.credentialId === hello.credentialId &&
    request.credentialGeneration === hello.credentialGeneration &&
    request.clientNonce === hello.clientNonce &&
    request.offeredProtocolVersions.length === hello.protocolVersions.length &&
    request.offeredProtocolVersions.every(
      (version, index) => version === hello.protocolVersions[index],
    ) &&
    sameResume(request.resumeCursors, hello.clientPositions)
  );
}

function validatePositiveBoundedInteger(
  value: number,
  field: string,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ChallengeInputError(`${field} is outside its configured bounds`);
  }
}

function toChallengeView(
  challenge: CloudLinkSessionChallengeRecord,
): CloudLinkSessionChallengeView {
  return {
    gatewayId: challenge.binding.gatewayId,
    challengeId: challenge.challengeId,
    cloudNonce: challenge.cloudNonce,
    issuedAtMs: challenge.issuedAtMs,
    expiresAtMs: challenge.expiresAtMs,
    cloudAuthentication: { ...challenge.cloudAuthentication },
  };
}

function toSessionView(session: CloudLinkSession): CloudLinkSessionView {
  return {
    tenantId: session.tenantId,
    projectId: session.projectId,
    gatewayId: session.gatewayId,
    sessionId: session.sessionId,
    credentialGeneration: session.credentialGeneration,
    epoch: session.epoch,
    state: session.state,
    openedAt: session.openedAt,
    ...(session.protocolVersion === undefined
      ? {}
      : { protocolVersion: session.protocolVersion }),
    ...(session.resumeCursors === undefined
      ? {}
      : {
          resumeCursors: session.resumeCursors.map((cursor) => ({ ...cursor })),
        }),
    ...(session.activatedAt === undefined
      ? {}
      : { activatedAt: session.activatedAt }),
    ...(session.lastHeartbeatAt === undefined
      ? {}
      : { lastHeartbeatAt: session.lastHeartbeatAt }),
    ...(session.gatewayKeyId === undefined
      ? {}
      : { gatewayKeyId: session.gatewayKeyId }),
    ...(session.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: session.heartbeatIntervalMs }),
  };
}

export class RequestCloudLinkSessionChallenge {
  static readonly definition = REQUEST_CLOUDLINK_SESSION_CHALLENGE_COMMAND;
  readonly #repository: CloudLinkSessionChallengeRepository;
  readonly #credentials: GatewayCredentialClaimResolver;
  readonly #signer: CloudLinkSessionChallengeSigner;
  readonly #materials: CloudLinkSessionChallengeMaterialGenerator;
  readonly #clock: ApplicationClock;
  readonly #supported: readonly ProtocolVersion[];
  readonly #challengeTtlMs: number;
  readonly #rateLimitWindowMs: number;
  readonly #rateLimitMaximumRequests: number;
  readonly #enabled: boolean;

  constructor(dependencies: {
    readonly repository: CloudLinkSessionChallengeRepository;
    readonly credentials: GatewayCredentialClaimResolver;
    readonly signer: CloudLinkSessionChallengeSigner;
    readonly materials: CloudLinkSessionChallengeMaterialGenerator;
    readonly clock: ApplicationClock;
    readonly supportedProtocolVersions: readonly string[];
    readonly challengeTtlMs?: number;
    readonly rateLimitWindowMs?: number;
    readonly rateLimitMaximumRequests?: number;
    readonly enabled?: boolean;
  }) {
    this.#repository = dependencies.repository;
    this.#credentials = dependencies.credentials;
    this.#signer = dependencies.signer;
    this.#materials = dependencies.materials;
    this.#clock = dependencies.clock;
    this.#supported =
      dependencies.supportedProtocolVersions.map(parseProtocolVersion);
    if (this.#supported.length === 0) {
      throw new ChallengeInputError(
        "at least one supported protocol version is required",
      );
    }
    this.#challengeTtlMs = dependencies.challengeTtlMs ?? 60_000;
    this.#rateLimitWindowMs = dependencies.rateLimitWindowMs ?? 60_000;
    this.#rateLimitMaximumRequests = dependencies.rateLimitMaximumRequests ?? 4;
    if (
      this.#challengeTtlMs < minimumChallengeTtlMs ||
      this.#challengeTtlMs > maximumChallengeTtlMs
    ) {
      throw new ChallengeInputError("challengeTtlMs must be short and bounded");
    }
    validatePositiveBoundedInteger(
      this.#rateLimitWindowMs,
      "rateLimitWindowMs",
      maximumRateLimitWindowMs,
    );
    validatePositiveBoundedInteger(
      this.#rateLimitMaximumRequests,
      "rateLimitMaximumRequests",
      100,
    );
    this.#enabled = dependencies.enabled ?? false;
  }

  async execute(
    rawInput: unknown,
  ): Promise<ChallengeApplicationResult<CloudLinkSessionChallengeView>> {
    if (!this.#enabled) {
      return failure(
        "gateway-signed-session-disabled",
        "Gateway-signed CloudLink sessions are disabled",
      );
    }
    const decoded = decodeSafely(() => decodeRequest(rawInput));
    if (!decoded.ok) return decoded;
    const request = decoded.value;
    if (
      !this.#supported.some((version) =>
        request.protocolVersions.includes(version),
      )
    ) {
      return failure(
        "unsupported-protocol-version",
        "No mutually supported CloudLink protocol version exists",
      );
    }
    const binding = await this.#credentials.resolveClaim({
      gatewayId: request.gatewayId,
      credentialId: request.credentialId,
      generation: request.credentialGeneration,
    });
    if (!credentialMatches(binding, request)) {
      return failure(
        "gateway-challenge-ineligible",
        "Gateway challenge request is not eligible",
      );
    }
    const issuedAtMs = unixMilliseconds(this.#clock.now());
    const expiresAtMs = (
      BigInt(issuedAtMs) + BigInt(this.#challengeTtlMs)
    ).toString();
    const challengeId = this.#materials.nextChallengeId();
    const cloudNonce = requirePattern(
      this.#materials.nextNonce(),
      noncePattern,
      "generated cloud nonce",
    );
    const projection: CloudLinkSessionChallengeSigningProjection = {
      schema: "aether.cloudlink.session-challenge-signing.v1alpha1",
      gateway_id: request.gatewayId,
      challenge_id: challengeId,
      cloud_nonce: cloudNonce,
      issued_at_ms: issuedAtMs,
      expires_at_ms: expiresAtMs,
    };
    const cloudAuthentication = await this.#signer.sign(projection);
    if (
      !keyIdPattern.test(cloudAuthentication.keyId) ||
      !signaturePattern.test(cloudAuthentication.signature)
    ) {
      throw new Error("CloudLink challenge signer returned invalid output");
    }
    const candidate: CloudLinkSessionChallengeRecord = {
      binding,
      request: {
        gatewayId: request.gatewayId,
        credentialId: request.credentialId,
        credentialGeneration: request.credentialGeneration,
        offeredProtocolVersions: request.protocolVersions,
        clientNonce: request.clientNonce,
        resumeCursors: request.clientPositions,
      },
      challengeId,
      cloudNonce,
      issuedAtMs,
      expiresAtMs,
      cloudAuthentication,
    };
    const issued = await this.#repository.issue({
      candidate,
      evaluationTimeMs: issuedAtMs,
      rateLimitWindowMs: this.#rateLimitWindowMs,
      rateLimitMaximumRequests: this.#rateLimitMaximumRequests,
    });
    if (issued.outcome === "rate-limited") {
      return failure(
        "gateway-challenge-rate-limited",
        "Gateway challenge request is rate limited",
      );
    }
    if (issued.outcome === "request-conflict") {
      return failure(
        "gateway-challenge-request-conflict",
        "An unexpired challenge is already bound to different request state",
      );
    }
    if (!("challenge" in issued)) {
      throw new Error(
        "CloudLink challenge repository returned an unknown issue outcome",
      );
    }
    return {
      ok: true,
      replayed: issued.outcome === "replayed",
      value: toChallengeView(issued.challenge),
    };
  }
}

export class AcceptGatewaySignedCloudLinkSession {
  static readonly definition = ACCEPT_GATEWAY_SIGNED_CLOUDLINK_SESSION_COMMAND;
  readonly #repository: CloudLinkSessionChallengeRepository;
  readonly #credentials: GatewayCredentialClaimResolver;
  readonly #authenticator: CloudLinkGatewayHelloAuthenticator;
  readonly #clock: ApplicationClock;
  readonly #sessionIds: CloudLinkSessionIdGenerator;
  readonly #supported: readonly ProtocolVersion[];
  readonly #heartbeatIntervalMs: string;
  readonly #enabled: boolean;

  constructor(dependencies: {
    readonly repository: CloudLinkSessionChallengeRepository;
    readonly credentials: GatewayCredentialClaimResolver;
    readonly authenticator: CloudLinkGatewayHelloAuthenticator;
    readonly clock: ApplicationClock;
    readonly sessionIds: CloudLinkSessionIdGenerator;
    readonly supportedProtocolVersions: readonly string[];
    readonly heartbeatIntervalMs?: string;
    readonly enabled?: boolean;
  }) {
    this.#repository = dependencies.repository;
    this.#credentials = dependencies.credentials;
    this.#authenticator = dependencies.authenticator;
    this.#clock = dependencies.clock;
    this.#sessionIds = dependencies.sessionIds;
    this.#supported =
      dependencies.supportedProtocolVersions.map(parseProtocolVersion);
    if (this.#supported.length === 0) {
      throw new ChallengeInputError(
        "at least one supported protocol version is required",
      );
    }
    this.#heartbeatIntervalMs = parseCloudLinkHeartbeatIntervalMs(
      dependencies.heartbeatIntervalMs ?? "30000",
    );
    this.#enabled = dependencies.enabled ?? false;
  }

  async execute(
    rawInput: unknown,
  ): Promise<
    | CloudLinkApplicationResult<CloudLinkSessionView>
    | ChallengeApplicationResult<CloudLinkSessionView>
  > {
    if (!this.#enabled) {
      return failure(
        "gateway-signed-session-disabled",
        "Gateway-signed CloudLink sessions are disabled",
      );
    }
    const decoded = decodeSafely(() => decodeHello(rawInput));
    if (!decoded.ok) return decoded;
    const hello = decoded.value;
    const selected = this.#supported.find((version) =>
      hello.protocolVersions.includes(version),
    );
    if (selected === undefined) {
      return failure(
        "unsupported-protocol-version",
        "No mutually supported CloudLink protocol version exists",
      );
    }
    const binding = await this.#credentials.resolveClaim({
      gatewayId: hello.gatewayId,
      credentialId: hello.credentialId,
      generation: hello.credentialGeneration,
    });
    if (!credentialMatches(binding, hello)) {
      return failure(
        "gateway-challenge-ineligible",
        "Gateway credential claim is not active",
      );
    }
    const challenge = await this.#repository.find(binding, hello.challengeId);
    if (challenge === undefined) {
      return failure(
        "gateway-challenge-not-found",
        "Gateway session challenge was not found",
      );
    }
    if (!sameRequestState(challenge, hello)) {
      return failure(
        "gateway-hello-binding-mismatch",
        "Gateway hello does not match the persisted challenge request",
      );
    }
    const evaluationTimeMs = unixMilliseconds(this.#clock.now());
    if (BigInt(evaluationTimeMs) >= BigInt(challenge.expiresAtMs)) {
      return failure(
        "gateway-challenge-expired",
        "Gateway session challenge has expired",
      );
    }
    const authenticationFingerprint = await this.#authenticator.verify({
      gatewayId: hello.gatewayId,
      credentialId: hello.credentialId,
      credentialGeneration: hello.credentialGeneration,
      gatewayKeyId: hello.gatewayKeyId,
      challengeId: hello.challengeId,
      cloudNonce: challenge.cloudNonce,
      clientNonce: hello.clientNonce,
      offeredProtocolVersions: hello.protocolVersions,
      resumeCursors: hello.clientPositions,
      gatewayAuthentication: hello.gatewayAuthentication,
    });
    if (
      authenticationFingerprint === undefined ||
      !fingerprintPattern.test(authenticationFingerprint)
    ) {
      return failure(
        "gateway-hello-authentication-invalid",
        "Gateway hello authentication is invalid",
      );
    }
    const openedAt = this.#clock.now();
    const opened = await this.#repository.acceptAndOpen({
      binding,
      challengeId: hello.challengeId,
      authenticationFingerprint,
      evaluationTimeMs,
      sessionId: this.#sessionIds.next(),
      protocolVersion: selected,
      openedAt,
      gatewayKeyId: parseCloudLinkGatewayKeyId(hello.gatewayKeyId),
      heartbeatIntervalMs: this.#heartbeatIntervalMs,
    });
    if (opened.outcome === "not-found") {
      return failure(
        "gateway-challenge-not-found",
        "Gateway session challenge was not found",
      );
    }
    if (opened.outcome === "expired") {
      return failure(
        "gateway-challenge-expired",
        "Gateway session challenge has expired",
      );
    }
    if (opened.outcome === "binding-conflict") {
      return failure(
        "gateway-hello-binding-mismatch",
        "Gateway hello binding changed before acceptance",
      );
    }
    if (opened.outcome === "consumed-conflict") {
      return failure(
        "idempotency-conflict",
        "Gateway session challenge was consumed by a different hello",
      );
    }
    if (!("session" in opened)) {
      throw new Error(
        "CloudLink challenge repository returned an unknown acceptance outcome",
      );
    }
    const session = opened.session;
    const sessionProtocolIsAcceptable =
      opened.outcome === "opened"
        ? session.protocolVersion === selected
        : session.protocolVersion !== undefined &&
          hello.protocolVersions.includes(session.protocolVersion) &&
          this.#supported.includes(session.protocolVersion);
    if (
      session.gatewayId !== binding.gatewayId ||
      session.tenantId !== binding.tenantId ||
      session.projectId !== binding.projectId ||
      session.credentialGeneration !== binding.generation ||
      !sessionProtocolIsAcceptable ||
      session.state !== "active"
    ) {
      return failure(
        "invalid-session-repository-result",
        "CloudLink challenge repository returned mismatched session state",
      );
    }
    return {
      ok: true,
      replayed: opened.outcome === "replayed",
      value: toSessionView(session),
    };
  }
}
