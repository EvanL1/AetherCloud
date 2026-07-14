import {
  InvalidDomainValueError,
  observeCloudLinkHeartbeat,
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseGatewayId,
  parseProjectId,
  parseProtocolVersion,
  parseStreamId,
  parseStreamPosition,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";
import type {
  CloudLinkSession,
  GatewayCredentialBinding,
  GatewayId,
  ProjectId,
  ProtocolVersion,
  TenantId,
  UtcInstant,
} from "@aether-cloud/domain";

import {
  GET_CLOUDLINK_SESSION_QUERY,
  OPEN_CLOUDLINK_SESSION_COMMAND,
  RECORD_CLOUDLINK_HEARTBEAT_COMMAND,
} from "./capability-definition.js";
import type {
  CloudLinkSessionIdGenerator,
  CloudLinkSessionRepository,
  CloudLinkSessionScope,
  GatewayCredentialAssertion,
  GatewayCredentialVerifier,
} from "./cloudlink-session-repository.js";
import type { ApplicationClock } from "./gateway-identity-repository.js";

type CloudLinkApplicationFailureCode =
  | "command-expired"
  | "concurrent-modification"
  | "gateway-credential-inactive"
  | "idempotency-conflict"
  | "invalid-cloudlink-session-transition"
  | "invalid-gateway-credential"
  | "invalid-input"
  | "invalid-session-repository-result"
  | "permission-denied"
  | "session-not-found"
  | "stale-cloudlink-session-epoch"
  | "unsupported-protocol-version";

export interface CloudLinkApplicationFailure {
  readonly code: CloudLinkApplicationFailureCode;
  readonly message: string;
}

export type CloudLinkApplicationResult<Value> =
  | Readonly<{ ok: true; replayed: boolean; value: Value }>
  | Readonly<{ ok: false; failure: CloudLinkApplicationFailure }>;

export type CloudLinkQueryResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: CloudLinkApplicationFailure }>;

export interface CloudLinkSessionView {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly sessionId: string;
  readonly credentialGeneration: string;
  readonly epoch: string;
  readonly state: CloudLinkSession["state"];
  readonly protocolVersion?: string;
  readonly resumeCursors?: readonly Readonly<{
    streamId: string;
    position: string;
  }>[];
  readonly openedAt: UtcInstant;
  readonly activatedAt?: UtcInstant;
  readonly lastHeartbeatAt?: UtcInstant;
}

interface CommandContext {
  readonly requestId: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

interface QueryContext extends CloudLinkSessionScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
}

class CloudLinkInputError extends Error {}

function failure(
  code: CloudLinkApplicationFailureCode,
  message: string,
): Readonly<{ ok: false; failure: CloudLinkApplicationFailure }> {
  return { ok: false, failure: { code, message } };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function requireRecord(input: unknown, name: string): Record<string, unknown> {
  if (!isRecord(input))
    throw new CloudLinkInputError(`${name} must be an object`);
  return input;
}

function requireString(input: unknown, name: string, maximum = 128): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > maximum
  ) {
    throw new CloudLinkInputError(`${name} must be a non-empty bounded string`);
  }
  return input;
}

function parseRequestId(input: unknown): string {
  const value = requireString(input, "idempotencyKey");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new CloudLinkInputError(
      "idempotencyKey must be an opaque 8-128 character identifier",
    );
  }
  return value;
}

function decodeCommandContext(input: unknown): CommandContext {
  const record = requireRecord(input, "command context");
  return {
    requestId: parseRequestId(record.idempotencyKey),
    issuedAt: parseUtcInstant(record.issuedAt),
    expiresAt: parseUtcInstant(record.expiresAt),
  };
}

function decodeCredential(input: unknown): GatewayCredentialAssertion {
  const record = requireRecord(input, "Gateway credential");
  return {
    credentialId: requireString(record.credentialId, "credentialId", 256),
    proof: requireString(record.proof, "credential proof", 4096),
  };
}

function decodeProtocolVersions(input: unknown): readonly ProtocolVersion[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 16) {
    throw new CloudLinkInputError(
      "protocolVersions must contain 1-16 version strings",
    );
  }
  const versions = input.map(parseProtocolVersion);
  if (new Set(versions).size !== versions.length) {
    throw new CloudLinkInputError("protocolVersions must be unique");
  }
  return versions;
}

function decodeClientPositions(input: unknown): void {
  if (input === undefined) return;
  if (!Array.isArray(input) || input.length > 32) {
    throw new CloudLinkInputError(
      "clientPositions must contain at most 32 cursors",
    );
  }
  const streams = new Set<string>();
  for (const rawCursor of input) {
    const cursor = requireRecord(rawCursor, "client position");
    const streamId = parseStreamId(cursor.streamId);
    parseStreamPosition(cursor.position);
    if (streams.has(streamId)) {
      throw new CloudLinkInputError("clientPositions must use unique streams");
    }
    streams.add(streamId);
  }
}

function decodeQueryContext(input: unknown): QueryContext {
  const record = requireRecord(input, "query context");
  if (
    !Array.isArray(record.permissions) ||
    record.permissions.some((permission) => typeof permission !== "string")
  ) {
    throw new CloudLinkInputError("permissions must be an array of strings");
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
  | Readonly<{ ok: false; failure: CloudLinkApplicationFailure }> {
  try {
    return { ok: true, value: decoder() };
  } catch (error: unknown) {
    if (
      error instanceof InvalidDomainValueError ||
      error instanceof CloudLinkInputError
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
): CloudLinkApplicationFailure | undefined {
  if (context.expiresAt <= context.issuedAt || context.issuedAt > now) {
    return {
      code: "invalid-input",
      message: "command time window is invalid",
    };
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
  | Readonly<{ ok: false; failure: CloudLinkApplicationFailure }>
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

function toView(session: CloudLinkSession): CloudLinkSessionView {
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
  };
}

function sessionMatchesOpenRequest(
  session: CloudLinkSession,
  binding: GatewayCredentialBinding,
  sessionId: string,
  protocolVersion: ProtocolVersion,
): boolean {
  return (
    session.tenantId === binding.tenantId &&
    session.projectId === binding.projectId &&
    session.gatewayId === binding.gatewayId &&
    session.credentialGeneration === binding.generation &&
    session.sessionId === sessionId &&
    session.protocolVersion === protocolVersion &&
    session.state === "active"
  );
}

export class OpenCloudLinkSession {
  static readonly definition = OPEN_CLOUDLINK_SESSION_COMMAND;

  readonly #repository: CloudLinkSessionRepository;
  readonly #credentialVerifier: GatewayCredentialVerifier;
  readonly #clock: ApplicationClock;
  readonly #sessionIds: CloudLinkSessionIdGenerator;
  readonly #supportedProtocolVersions: readonly ProtocolVersion[];

  constructor(dependencies: {
    readonly repository: CloudLinkSessionRepository;
    readonly credentialVerifier: GatewayCredentialVerifier;
    readonly clock: ApplicationClock;
    readonly sessionIds: CloudLinkSessionIdGenerator;
    readonly supportedProtocolVersions: readonly string[];
  }) {
    this.#repository = dependencies.repository;
    this.#credentialVerifier = dependencies.credentialVerifier;
    this.#clock = dependencies.clock;
    this.#sessionIds = dependencies.sessionIds;
    this.#supportedProtocolVersions =
      dependencies.supportedProtocolVersions.map(parseProtocolVersion);
    if (this.#supportedProtocolVersions.length === 0) {
      throw new CloudLinkInputError(
        "at least one supported CloudLink protocol version is required",
      );
    }
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<CloudLinkApplicationResult<CloudLinkSessionView>> {
    const decoded = decodeSafely(() => {
      const context = decodeCommandContext(rawContext);
      const input = requireRecord(rawInput, "open CloudLink session input");
      const credential = decodeCredential(input.credential);
      const protocolVersions = decodeProtocolVersions(input.protocolVersions);
      decodeClientPositions(input.clientPositions);
      return { context, credential, protocolVersions };
    });
    if (!decoded.ok) return decoded;
    const now = this.#clock.now();
    const timeFailure = validateCommandTime(decoded.value.context, now);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    const verified = await verifyActiveCredential(
      this.#credentialVerifier,
      decoded.value.credential,
    );
    if (!verified.ok) return verified;
    const selected = this.#supportedProtocolVersions.find((candidate) =>
      decoded.value.protocolVersions.includes(candidate),
    );
    if (selected === undefined) {
      return failure(
        "unsupported-protocol-version",
        "no mutually supported CloudLink protocol version exists",
      );
    }
    const nextSessionId = this.#sessionIds.next();
    const opened = await this.#repository.open({
      binding: verified.value,
      requestId: decoded.value.context.requestId,
      sessionId: nextSessionId,
      protocolVersion: selected,
      openedAt: now,
    });
    if (opened.outcome === "idempotency-conflict") {
      return failure(
        "idempotency-conflict",
        "CloudLink open idempotency key was reused with different input",
      );
    }
    if (
      !sessionMatchesOpenRequest(
        opened.session,
        verified.value,
        opened.outcome === "opened" ? nextSessionId : opened.session.sessionId,
        selected,
      )
    ) {
      return failure(
        "invalid-session-repository-result",
        "CloudLink session repository returned mismatched state",
      );
    }
    return {
      ok: true,
      replayed: opened.outcome === "replayed",
      value: toView(opened.session),
    };
  }
}

export class RecordCloudLinkHeartbeat {
  static readonly definition = RECORD_CLOUDLINK_HEARTBEAT_COMMAND;

  readonly #repository: CloudLinkSessionRepository;
  readonly #credentialVerifier: GatewayCredentialVerifier;
  readonly #clock: ApplicationClock;

  constructor(dependencies: {
    readonly repository: CloudLinkSessionRepository;
    readonly credentialVerifier: GatewayCredentialVerifier;
    readonly clock: ApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#credentialVerifier = dependencies.credentialVerifier;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<CloudLinkApplicationResult<CloudLinkSessionView>> {
    const decoded = decodeSafely(() => {
      const context = decodeCommandContext(rawContext);
      const input = requireRecord(rawInput, "CloudLink heartbeat input");
      return {
        context,
        credential: decodeCredential(input.credential),
        sessionId: parseCloudLinkSessionId(input.sessionId),
        epoch: parseCloudLinkSessionEpoch(input.sessionEpoch),
      };
    });
    if (!decoded.ok) return decoded;
    const now = this.#clock.now();
    const timeFailure = validateCommandTime(decoded.value.context, now);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    const verified = await verifyActiveCredential(
      this.#credentialVerifier,
      decoded.value.credential,
    );
    if (!verified.ok) return verified;
    const session = await this.#repository.findById(
      verified.value,
      decoded.value.sessionId,
    );
    if (
      session === undefined ||
      session.tenantId !== verified.value.tenantId ||
      session.projectId !== verified.value.projectId ||
      session.gatewayId !== verified.value.gatewayId ||
      session.credentialGeneration !== verified.value.generation
    ) {
      return failure("session-not-found", "CloudLink session was not found");
    }
    const transition = observeCloudLinkHeartbeat(session, {
      epoch: decoded.value.epoch,
      requestId: decoded.value.context.requestId,
      observedAt: now,
    });
    if (!transition.ok) {
      return failure(
        transition.failure.code === "stale-cloudlink-session-epoch"
          ? "stale-cloudlink-session-epoch"
          : "invalid-cloudlink-session-transition",
        transition.failure.message,
      );
    }
    if (transition.replayed) {
      return { ok: true, replayed: true, value: toView(transition.value) };
    }
    const replaced = await this.#repository.replace(
      transition.value,
      session.revision,
    );
    if (replaced !== "replaced") {
      return failure(
        "concurrent-modification",
        "CloudLink session changed concurrently",
      );
    }
    return { ok: true, replayed: false, value: toView(transition.value) };
  }
}

export class GetCurrentCloudLinkSession {
  static readonly definition = GET_CLOUDLINK_SESSION_QUERY;

  readonly #repository: CloudLinkSessionRepository;

  constructor(dependencies: {
    readonly repository: CloudLinkSessionRepository;
  }) {
    this.#repository = dependencies.repository;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<CloudLinkQueryResult<CloudLinkSessionView>> {
    const decoded = decodeSafely(() => {
      const context = decodeQueryContext(rawContext);
      const input = requireRecord(rawInput, "get CloudLink session input");
      return { context, gatewayId: parseGatewayId(input.gatewayId) };
    });
    if (!decoded.ok) return decoded;
    if (
      !decoded.value.context.permissions.has(
        GET_CLOUDLINK_SESSION_QUERY.permission,
      )
    ) {
      return failure(
        "permission-denied",
        `permission ${GET_CLOUDLINK_SESSION_QUERY.permission} is required`,
      );
    }
    const session = await this.#repository.findCurrent(
      decoded.value.context,
      decoded.value.gatewayId,
    );
    return session === undefined
      ? failure("session-not-found", "CloudLink session was not found")
      : { ok: true, value: toView(session) };
  }
}
