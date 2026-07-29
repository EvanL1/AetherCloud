import {
  InvalidDomainValueError,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
} from "@aether-cloud/domain";
import type { GatewayId, UtcInstant } from "@aether-cloud/domain";

import {
  GET_FLEET_GATEWAY_QUERY,
  LIST_FLEET_GATEWAYS_QUERY,
} from "./capability-definition.js";
import type {
  ApplicationClock,
  GatewayScope,
} from "./gateway-identity-repository.js";

export type FleetConnectionStatus =
  | "connecting"
  | "never-connected"
  | "offline"
  | "online"
  | "stale";

export interface FleetSessionSnapshot {
  readonly state:
    | "active"
    | "closed"
    | "draining"
    | "negotiating"
    | "resuming"
    | "suspect";
  readonly activatedAt?: UtcInstant;
  readonly lastHeartbeatAt?: UtcInstant;
  readonly heartbeatIntervalMs?: string;
}

export interface FleetLatestTelemetrySnapshot {
  readonly streamId: string;
  readonly streamEpoch: string;
  readonly position: string;
  readonly sourceTimestampMs: string;
  readonly kind: "device-event" | "point-sample";
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface FleetGatewaySnapshot extends GatewayScope {
  readonly gatewayId: GatewayId;
  readonly displayName: string;
  readonly enrollmentState: "awaiting-claim" | "claimed" | "registered";
  readonly revision: number;
  readonly registeredAt: UtcInstant;
  readonly session: FleetSessionSnapshot | null;
  readonly telemetry: Readonly<{
    recordCount: string;
    lastReceivedAt?: UtcInstant;
    latest?: FleetLatestTelemetrySnapshot;
  }>;
}

export interface FleetGatewayView {
  readonly gatewayId: GatewayId;
  readonly displayName: string;
  readonly enrollmentState: FleetGatewaySnapshot["enrollmentState"];
  readonly revision: number;
  readonly registeredAt: UtcInstant;
  readonly connection: Readonly<{
    status: FleetConnectionStatus;
    sessionState?: FleetSessionSnapshot["state"];
    lastSeenAt?: UtcInstant;
  }>;
  readonly telemetry: FleetGatewaySnapshot["telemetry"];
}

export type FleetGatewayListResult =
  | Readonly<{
      outcome: "found";
      gateways: readonly FleetGatewaySnapshot[];
      nextCursor: GatewayId | null;
    }>
  | Readonly<{ outcome: "storage-unavailable" }>;

export type FleetGatewayGetResult =
  | Readonly<{ outcome: "found"; gateway: FleetGatewaySnapshot }>
  | Readonly<{ outcome: "not-found" }>
  | Readonly<{ outcome: "storage-unavailable" }>;

export interface FleetGatewayQueryRepository {
  list(
    query: GatewayScope & Readonly<{ limit: number; cursor?: GatewayId }>,
  ): Promise<FleetGatewayListResult>;
  get(
    scope: GatewayScope,
    gatewayId: GatewayId,
  ): Promise<FleetGatewayGetResult>;
}

export type FleetQueryFailure = Readonly<{
  code:
    | "gateway-not-found"
    | "gateway-storage-unavailable"
    | "invalid-input"
    | "permission-denied";
  message: string;
}>;

export type FleetQueryResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: FleetQueryFailure }>;

interface QueryContext extends GatewayScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
}

class FleetQueryInputError extends Error {}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function decodeContext(input: unknown): QueryContext {
  if (!isRecord(input))
    throw new FleetQueryInputError("query context must be an object");
  if (typeof input.subjectId !== "string" || input.subjectId.length === 0)
    throw new FleetQueryInputError("subjectId must be a non-empty string");
  if (
    !Array.isArray(input.permissions) ||
    input.permissions.some((permission) => typeof permission !== "string")
  ) {
    throw new FleetQueryInputError("permissions must be an array of strings");
  }
  return {
    tenantId: parseTenantId(input.tenantId),
    projectId: parseProjectId(input.projectId),
    subjectId: input.subjectId,
    permissions: new Set(input.permissions),
  };
}

function decode<Value>(operation: () => Value): FleetQueryResult<Value> {
  try {
    return { ok: true, value: operation() };
  } catch (error: unknown) {
    if (
      error instanceof InvalidDomainValueError ||
      error instanceof FleetQueryInputError
    ) {
      return {
        ok: false,
        failure: { code: "invalid-input", message: error.message },
      };
    }
    throw error;
  }
}

function authorize(
  context: QueryContext,
  permission: string,
): FleetQueryFailure | undefined {
  if (!context.permissions.has(permission)) {
    return {
      code: "permission-denied",
      message: `permission ${permission} is required`,
    };
  }
  return undefined;
}

function parseDecimal(input: string, field: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(input))
    throw new Error(`Fleet repository returned invalid ${field}`);
  return BigInt(input);
}

function connectionView(
  session: FleetSessionSnapshot | null,
  now: UtcInstant,
): FleetGatewayView["connection"] {
  if (session === null) return { status: "never-connected" };
  const lastSeenAt = session.lastHeartbeatAt ?? session.activatedAt;
  const common = {
    sessionState: session.state,
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
  };
  if (session.state === "suspect") return { status: "stale", ...common };
  if (session.state !== "active") return { status: "offline", ...common };
  if (lastSeenAt === undefined || session.heartbeatIntervalMs === undefined)
    return { status: "connecting", ...common };
  const lastSeenMs = Date.parse(lastSeenAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(lastSeenMs) || Number.isNaN(nowMs))
    throw new Error("Fleet repository returned invalid session time");
  const elapsedMs = BigInt(Math.max(0, nowMs - lastSeenMs));
  const graceMs =
    parseDecimal(session.heartbeatIntervalMs, "heartbeatIntervalMs") * 3n;
  return {
    status: elapsedMs <= graceMs ? "online" : "stale",
    ...common,
  };
}

function toView(
  snapshot: FleetGatewaySnapshot,
  now: UtcInstant,
): FleetGatewayView {
  return Object.freeze({
    gatewayId: snapshot.gatewayId,
    displayName: snapshot.displayName,
    enrollmentState: snapshot.enrollmentState,
    revision: snapshot.revision,
    registeredAt: snapshot.registeredAt,
    connection: Object.freeze(connectionView(snapshot.session, now)),
    telemetry: snapshot.telemetry,
  });
}

function storageFailure(): Readonly<{ ok: false; failure: FleetQueryFailure }> {
  return {
    ok: false,
    failure: {
      code: "gateway-storage-unavailable",
      message: "Fleet storage is unavailable",
    },
  };
}

export class ListFleetGateways {
  readonly #repository: FleetGatewayQueryRepository;
  readonly #clock: ApplicationClock;

  constructor(dependencies: {
    readonly repository: FleetGatewayQueryRepository;
    readonly clock: ApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<
    FleetQueryResult<
      Readonly<{
        items: readonly FleetGatewayView[];
        nextCursor: GatewayId | null;
      }>
    >
  > {
    const decoded = decode(() => {
      const context = decodeContext(rawContext);
      if (!isRecord(rawInput))
        throw new FleetQueryInputError("Fleet query must be an object");
      const limit = rawInput.limit ?? 50;
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100)
        throw new FleetQueryInputError(
          "limit must be an integer from 1 to 100",
        );
      const cursor =
        rawInput.cursor === undefined
          ? undefined
          : parseGatewayId(rawInput.cursor);
      return { context, limit: Number(limit), cursor };
    });
    if (!decoded.ok) return decoded;
    const authorization = authorize(
      decoded.value.context,
      LIST_FLEET_GATEWAYS_QUERY.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    const result = await this.#repository.list({
      ...decoded.value.context,
      limit: decoded.value.limit,
      ...(decoded.value.cursor === undefined
        ? {}
        : { cursor: decoded.value.cursor }),
    });
    if (result.outcome === "storage-unavailable") return storageFailure();
    const now = this.#clock.now();
    return {
      ok: true,
      value: {
        items: Object.freeze(
          result.gateways.map((gateway) => toView(gateway, now)),
        ),
        nextCursor: result.nextCursor,
      },
    };
  }
}

export class GetFleetGateway {
  readonly #repository: FleetGatewayQueryRepository;
  readonly #clock: ApplicationClock;

  constructor(dependencies: {
    readonly repository: FleetGatewayQueryRepository;
    readonly clock: ApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<FleetQueryResult<FleetGatewayView>> {
    const decoded = decode(() => {
      const context = decodeContext(rawContext);
      if (!isRecord(rawInput))
        throw new FleetQueryInputError("Fleet query must be an object");
      return { context, gatewayId: parseGatewayId(rawInput.gatewayId) };
    });
    if (!decoded.ok) return decoded;
    const authorization = authorize(
      decoded.value.context,
      GET_FLEET_GATEWAY_QUERY.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    const result = await this.#repository.get(
      decoded.value.context,
      decoded.value.gatewayId,
    );
    if (result.outcome === "storage-unavailable") return storageFailure();
    if (result.outcome === "not-found") {
      return {
        ok: false,
        failure: {
          code: "gateway-not-found",
          message: "gateway was not found",
        },
      };
    }
    return { ok: true, value: toView(result.gateway, this.#clock.now()) };
  }
}
