import { InvalidDomainValueError } from "./resource-identities.js";
import type {
  GatewayId,
  ProjectId,
  TenantId,
  UtcInstant,
} from "./resource-identities.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalUint64Pattern = /^(?:0|[1-9][0-9]*)$/;
const maximumUint64 = 18_446_744_073_709_551_615n;
const protocolVersionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const streamIdPattern = /^[a-z][a-z0-9.-]{0,63}$/;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

declare const cloudLinkSessionIdBrand: unique symbol;
declare const gatewayCredentialGenerationBrand: unique symbol;
declare const cloudLinkSessionEpochBrand: unique symbol;
declare const protocolVersionBrand: unique symbol;
declare const streamIdBrand: unique symbol;
declare const streamEpochBrand: unique symbol;
declare const streamPositionBrand: unique symbol;

export type CloudLinkSessionId = string & {
  readonly [cloudLinkSessionIdBrand]: true;
};
export type GatewayCredentialGeneration = string & {
  readonly [gatewayCredentialGenerationBrand]: true;
};
export type CloudLinkSessionEpoch = string & {
  readonly [cloudLinkSessionEpochBrand]: true;
};
export type ProtocolVersion = string & {
  readonly [protocolVersionBrand]: true;
};
export type StreamId = string & { readonly [streamIdBrand]: true };
export type StreamEpoch = string & { readonly [streamEpochBrand]: true };
export type StreamPosition = string & {
  readonly [streamPositionBrand]: true;
};

export type GatewayCredentialStatus = "active" | "revoked" | "suspended";

export interface GatewayCredentialBinding {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly generation: GatewayCredentialGeneration;
  readonly status: GatewayCredentialStatus;
}

export interface CloudLinkStreamCursor {
  readonly streamId: StreamId;
  readonly streamEpoch: StreamEpoch;
  readonly position: StreamPosition;
}

export type CloudLinkSessionState =
  | "active"
  | "closed"
  | "draining"
  | "negotiating"
  | "resuming"
  | "suspect";

export interface CloudLinkSession {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly sessionId: CloudLinkSessionId;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly epoch: CloudLinkSessionEpoch;
  readonly state: CloudLinkSessionState;
  readonly openedAt: UtcInstant;
  readonly revision: number;
  readonly protocolVersion?: ProtocolVersion;
  readonly resumeCursors?: readonly CloudLinkStreamCursor[];
  readonly activatedAt?: UtcInstant;
  readonly lastHeartbeatAt?: UtcInstant;
  readonly lastHeartbeatRequestId?: string;
  readonly suspectAt?: UtcInstant;
  readonly closedAt?: UtcInstant;
  readonly closeReason?: "drained" | "fenced" | "heartbeat-timeout";
}

export interface CloudLinkSessionTransitionFailure {
  readonly code:
    | "duplicate-cloudlink-stream"
    | "invalid-cloudlink-session-transition"
    | "stale-cloudlink-session-epoch";
  readonly message: string;
}

export type CloudLinkSessionTransitionResult =
  | Readonly<{ ok: true; replayed: boolean; value: CloudLinkSession }>
  | Readonly<{ ok: false; failure: CloudLinkSessionTransitionFailure }>;

function parseUint64(input: unknown, field: string): string {
  if (
    typeof input !== "string" ||
    !canonicalUint64Pattern.test(input) ||
    BigInt(input) > maximumUint64
  ) {
    throw new InvalidDomainValueError(
      field,
      `${field} must be a canonical unsigned 64-bit decimal string`,
    );
  }
  return input;
}

export function parseCloudLinkSessionId(input: unknown): CloudLinkSessionId {
  if (typeof input !== "string" || !canonicalUuidPattern.test(input)) {
    throw new InvalidDomainValueError(
      "cloudLinkSessionId",
      "cloudLinkSessionId must be a canonical lowercase UUID",
    );
  }
  return input as CloudLinkSessionId;
}

export function parseGatewayCredentialGeneration(
  input: unknown,
): GatewayCredentialGeneration {
  return parseUint64(
    input,
    "gatewayCredentialGeneration",
  ) as GatewayCredentialGeneration;
}

export function parseCloudLinkSessionEpoch(
  input: unknown,
): CloudLinkSessionEpoch {
  return parseUint64(input, "cloudLinkSessionEpoch") as CloudLinkSessionEpoch;
}

export function parseProtocolVersion(input: unknown): ProtocolVersion {
  if (typeof input !== "string" || !protocolVersionPattern.test(input)) {
    throw new InvalidDomainValueError(
      "protocolVersion",
      "protocolVersion must contain canonical major.minor integers",
    );
  }
  return input as ProtocolVersion;
}

export function parseStreamId(input: unknown): StreamId {
  if (typeof input !== "string" || !streamIdPattern.test(input)) {
    throw new InvalidDomainValueError(
      "streamId",
      "streamId must be a lower-case bounded protocol identifier",
    );
  }
  return input as StreamId;
}

export function parseStreamEpoch(input: unknown): StreamEpoch {
  const value = parseUint64(input, "streamEpoch");
  if (value === "0") {
    throw new InvalidDomainValueError(
      "streamEpoch",
      "streamEpoch must be a positive unsigned 64-bit decimal string",
    );
  }
  return value as StreamEpoch;
}

export function parseStreamPosition(input: unknown): StreamPosition {
  return parseUint64(input, "streamPosition") as StreamPosition;
}

function freezeSession(session: CloudLinkSession): CloudLinkSession {
  const resumeCursors = session.resumeCursors?.map((cursor) =>
    Object.freeze({ ...cursor }),
  );
  return Object.freeze({
    ...session,
    ...(resumeCursors === undefined
      ? {}
      : { resumeCursors: Object.freeze(resumeCursors) }),
  });
}

function transitionFailure(
  code: CloudLinkSessionTransitionFailure["code"],
  message: string,
): CloudLinkSessionTransitionResult {
  return { ok: false, failure: { code, message } };
}

export function createCloudLinkSession(input: {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly sessionId: CloudLinkSessionId;
  readonly credentialGeneration: GatewayCredentialGeneration;
  readonly epoch: CloudLinkSessionEpoch;
  readonly openedAt: UtcInstant;
}): CloudLinkSession {
  return freezeSession({
    ...input,
    state: "negotiating",
    revision: 1,
  });
}

export function negotiateCloudLinkSession(
  session: CloudLinkSession,
  protocolVersion: ProtocolVersion,
): CloudLinkSessionTransitionResult {
  if (session.state !== "negotiating") {
    return transitionFailure(
      "invalid-cloudlink-session-transition",
      "only a negotiating CloudLink session can select a protocol version",
    );
  }
  return {
    ok: true,
    replayed: false,
    value: freezeSession({
      ...session,
      state: "resuming",
      protocolVersion,
      revision: session.revision + 1,
    }),
  };
}

export function activateCloudLinkSession(
  session: CloudLinkSession,
  input: {
    readonly activatedAt: UtcInstant;
    readonly resumeCursors: readonly CloudLinkStreamCursor[];
  },
): CloudLinkSessionTransitionResult {
  if (session.state !== "resuming" || session.protocolVersion === undefined) {
    return transitionFailure(
      "invalid-cloudlink-session-transition",
      "only a resuming CloudLink session can become active",
    );
  }
  if (input.activatedAt < session.openedAt) {
    return transitionFailure(
      "invalid-cloudlink-session-transition",
      "CloudLink activation cannot precede connection opening",
    );
  }
  const streamEpochs = new Set(
    input.resumeCursors.map(
      (cursor) => `${cursor.streamId}:${cursor.streamEpoch}`,
    ),
  );
  if (streamEpochs.size !== input.resumeCursors.length) {
    return transitionFailure(
      "duplicate-cloudlink-stream",
      "CloudLink resume cursors must contain unique stream/epoch identities",
    );
  }
  return {
    ok: true,
    replayed: false,
    value: freezeSession({
      ...session,
      state: "active",
      activatedAt: input.activatedAt,
      resumeCursors: input.resumeCursors,
      revision: session.revision + 1,
    }),
  };
}

export function observeCloudLinkHeartbeat(
  session: CloudLinkSession,
  input: {
    readonly epoch: CloudLinkSessionEpoch;
    readonly requestId: string;
    readonly observedAt: UtcInstant;
  },
): CloudLinkSessionTransitionResult {
  if (input.epoch !== session.epoch) {
    return transitionFailure(
      "stale-cloudlink-session-epoch",
      "heartbeat belongs to a fenced CloudLink session epoch",
    );
  }
  if (session.lastHeartbeatRequestId === input.requestId) {
    return { ok: true, replayed: true, value: session };
  }
  if (!requestIdPattern.test(input.requestId)) {
    return transitionFailure(
      "invalid-cloudlink-session-transition",
      "heartbeat request identity is invalid",
    );
  }
  if (session.state !== "active" && session.state !== "suspect") {
    return transitionFailure(
      "invalid-cloudlink-session-transition",
      "heartbeat requires an active or suspect CloudLink session",
    );
  }
  const lowerBound = session.lastHeartbeatAt ?? session.activatedAt;
  if (lowerBound === undefined || input.observedAt < lowerBound) {
    return transitionFailure(
      "invalid-cloudlink-session-transition",
      "heartbeat observation cannot move session time backward",
    );
  }
  return {
    ok: true,
    replayed: false,
    value: freezeSession({
      ...session,
      state: "active",
      lastHeartbeatAt: input.observedAt,
      lastHeartbeatRequestId: input.requestId,
      revision: session.revision + 1,
    }),
  };
}

export function markCloudLinkSessionSuspect(
  session: CloudLinkSession,
  suspectAt: UtcInstant,
): CloudLinkSessionTransitionResult {
  if (session.state !== "active") {
    return transitionFailure(
      "invalid-cloudlink-session-transition",
      "only an active CloudLink session can become suspect",
    );
  }
  const lowerBound = session.lastHeartbeatAt ?? session.activatedAt;
  if (lowerBound === undefined || suspectAt < lowerBound) {
    return transitionFailure(
      "invalid-cloudlink-session-transition",
      "suspect time cannot move session time backward",
    );
  }
  return {
    ok: true,
    replayed: false,
    value: freezeSession({
      ...session,
      state: "suspect",
      suspectAt,
      revision: session.revision + 1,
    }),
  };
}

export function fenceCloudLinkSession(
  session: CloudLinkSession,
  closedAt: UtcInstant,
): CloudLinkSessionTransitionResult {
  if (session.state === "closed") {
    return session.closeReason === "fenced"
      ? { ok: true, replayed: true, value: session }
      : transitionFailure(
          "invalid-cloudlink-session-transition",
          "closed CloudLink session cannot be fenced again",
        );
  }
  if (closedAt < session.openedAt) {
    return transitionFailure(
      "invalid-cloudlink-session-transition",
      "CloudLink close time cannot precede connection opening",
    );
  }
  return {
    ok: true,
    replayed: false,
    value: freezeSession({
      ...session,
      state: "closed",
      closedAt,
      closeReason: "fenced",
      revision: session.revision + 1,
    }),
  };
}
