export interface AuditEventView {
  readonly eventId: string;
  readonly sequence: string;
  readonly occurredAt: string;
  readonly subject: Readonly<{ kind: string; subjectId: string }>;
  readonly action: string;
  readonly resource: Readonly<{ kind: string; resourceId: string }>;
  readonly outcome: string;
  readonly risk: string;
  readonly confirmation: string;
  readonly correlationId: string;
  readonly traceId?: string;
  readonly detailsDigest?: string;
}

export interface AuditSearchResponse {
  readonly items: readonly AuditEventView[];
  readonly nextCursor: string | null;
}

export type FleetConnectionStatus =
  | "connecting"
  | "never-connected"
  | "offline"
  | "online"
  | "stale";

export interface FleetGatewayView {
  readonly gatewayId: string;
  readonly displayName: string;
  readonly enrollmentState: "awaiting-claim" | "claimed" | "registered";
  readonly revision: number;
  readonly registeredAt: string;
  readonly connection: Readonly<{
    status: FleetConnectionStatus;
    sessionState?: string;
    lastSeenAt?: string;
  }>;
  readonly telemetry: Readonly<{
    recordCount: string;
    lastReceivedAt?: string;
    latest?: Readonly<{
      streamId: string;
      streamEpoch: string;
      position: string;
      sourceTimestampMs: string;
      kind: "device-event" | "point-sample";
      payload: Readonly<Record<string, unknown>>;
    }>;
  }>;
}

export interface FleetListResponse {
  readonly items: readonly FleetGatewayView[];
  readonly nextCursor: string | null;
}

export interface AuditSearchInput {
  readonly limit: number;
  readonly action?: string;
  readonly resourceId?: string;
  readonly cursor?: string;
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function stringField(
  input: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = input[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("invalid Audit response");
  }
  return value;
}

function nestedIdentity(
  input: unknown,
  idField: "resourceId" | "subjectId",
):
  | Readonly<{ kind: string; resourceId: string }>
  | Readonly<{
      kind: string;
      subjectId: string;
    }> {
  if (!isRecord(input)) throw new Error("invalid Audit response");
  const kind = stringField(input, "kind");
  const identifier = stringField(input, idField);
  return idField === "resourceId"
    ? { kind, resourceId: identifier }
    : { kind, subjectId: identifier };
}

function decodeEvent(input: unknown): AuditEventView {
  if (!isRecord(input)) throw new Error("invalid Audit response");
  const sequence = stringField(input, "sequence");
  if (!/^(?:0|[1-9][0-9]*)$/.test(sequence)) {
    throw new Error("invalid Audit response");
  }
  const occurredAt = stringField(input, "occurredAt");
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new Error("invalid Audit response");
  }
  const subject = nestedIdentity(input.subject, "subjectId");
  const resource = nestedIdentity(input.resource, "resourceId");
  if (!("subjectId" in subject) || !("resourceId" in resource)) {
    throw new Error("invalid Audit response");
  }
  const event: AuditEventView = {
    eventId: stringField(input, "eventId"),
    sequence,
    occurredAt,
    subject,
    action: stringField(input, "action"),
    resource,
    outcome: stringField(input, "outcome"),
    risk: stringField(input, "risk"),
    confirmation: stringField(input, "confirmation"),
    correlationId: stringField(input, "correlationId"),
  };
  const traceId = input.traceId;
  const detailsDigest = input.detailsDigest;
  if (traceId !== undefined) {
    if (typeof traceId !== "string" || traceId.length === 0)
      throw new Error("invalid Audit response");
    return detailsDigest === undefined
      ? { ...event, traceId }
      : withDetailsDigest(event, traceId, detailsDigest);
  }
  if (detailsDigest === undefined) return event;
  if (typeof detailsDigest !== "string" || detailsDigest.length === 0)
    throw new Error("invalid Audit response");
  return { ...event, detailsDigest };
}

function withDetailsDigest(
  event: AuditEventView,
  traceId: string,
  detailsDigest: unknown,
): AuditEventView {
  if (typeof detailsDigest !== "string" || detailsDigest.length === 0)
    throw new Error("invalid Audit response");
  return { ...event, traceId, detailsDigest };
}

export function decodeAuditSearchResponse(input: unknown): AuditSearchResponse {
  if (!isRecord(input) || !Array.isArray(input.items)) {
    throw new Error("invalid Audit response");
  }
  const nextCursor = input.nextCursor;
  if (nextCursor !== null && typeof nextCursor !== "string") {
    throw new Error("invalid Audit response");
  }
  return Object.freeze({
    items: Object.freeze(input.items.map((item) => decodeEvent(item))),
    nextCursor,
  });
}

function fleetFailure(): never {
  throw new Error("invalid Fleet response");
}

function fleetString(
  input: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = input[field];
  if (typeof value !== "string" || value.length === 0) return fleetFailure();
  return value;
}

function optionalFleetString(
  input: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) return fleetFailure();
  return value;
}

function decimal(
  input: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = fleetString(input, field);
  return /^(?:0|[1-9][0-9]*)$/.test(value) ? value : fleetFailure();
}

function fleetRecord(input: unknown): Readonly<Record<string, unknown>> {
  return isRecord(input) ? input : fleetFailure();
}

function decodeFleetGateway(input: unknown): FleetGatewayView {
  const gateway = fleetRecord(input);
  const gatewayId = fleetString(gateway, "gatewayId");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      gatewayId,
    )
  )
    return fleetFailure();
  const enrollmentState = fleetString(gateway, "enrollmentState");
  if (
    enrollmentState !== "registered" &&
    enrollmentState !== "awaiting-claim" &&
    enrollmentState !== "claimed"
  )
    return fleetFailure();
  const revision = gateway.revision;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  )
    return fleetFailure();
  const registeredAt = fleetString(gateway, "registeredAt");
  if (Number.isNaN(Date.parse(registeredAt))) return fleetFailure();
  const connection = fleetRecord(gateway.connection);
  const status = fleetString(connection, "status");
  if (
    status !== "connecting" &&
    status !== "never-connected" &&
    status !== "offline" &&
    status !== "online" &&
    status !== "stale"
  )
    return fleetFailure();
  const sessionState = optionalFleetString(connection, "sessionState");
  const lastSeenAt = optionalFleetString(connection, "lastSeenAt");
  if (lastSeenAt !== undefined && Number.isNaN(Date.parse(lastSeenAt)))
    return fleetFailure();
  const telemetry = fleetRecord(gateway.telemetry);
  const lastReceivedAt = optionalFleetString(telemetry, "lastReceivedAt");
  if (lastReceivedAt !== undefined && Number.isNaN(Date.parse(lastReceivedAt)))
    return fleetFailure();
  const latestInput = telemetry.latest;
  let latest: FleetGatewayView["telemetry"]["latest"];
  if (latestInput !== undefined) {
    const candidate = fleetRecord(latestInput);
    const kind = fleetString(candidate, "kind");
    if (kind !== "device-event" && kind !== "point-sample")
      return fleetFailure();
    const payload = candidate.payload;
    if (!isRecord(payload)) return fleetFailure();
    latest = {
      streamId: fleetString(candidate, "streamId"),
      streamEpoch: decimal(candidate, "streamEpoch"),
      position: decimal(candidate, "position"),
      sourceTimestampMs: decimal(candidate, "sourceTimestampMs"),
      kind,
      payload,
    };
  }
  return {
    gatewayId,
    displayName: fleetString(gateway, "displayName"),
    enrollmentState,
    revision,
    registeredAt,
    connection: {
      status,
      ...(sessionState === undefined ? {} : { sessionState }),
      ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    },
    telemetry: {
      recordCount: decimal(telemetry, "recordCount"),
      ...(lastReceivedAt === undefined ? {} : { lastReceivedAt }),
      ...(latest === undefined ? {} : { latest }),
    },
  };
}

export function decodeFleetListResponse(input: unknown): FleetListResponse {
  const response = fleetRecord(input);
  if (!Array.isArray(response.items)) return fleetFailure();
  const nextCursor = response.nextCursor;
  if (nextCursor !== null && typeof nextCursor !== "string")
    return fleetFailure();
  return Object.freeze({
    items: Object.freeze(
      response.items.map((item) => decodeFleetGateway(item)),
    ),
    nextCursor,
  });
}

export function buildFleetListUrl(apiBaseUrl: string, limit: number): URL {
  const url = new URL("/api/v1/fleet/gateways", apiBaseUrl);
  url.searchParams.set("limit", String(limit));
  return url;
}

export function buildAuditSearchUrl(
  apiBaseUrl: string,
  input: AuditSearchInput,
): URL {
  const url = new URL("/api/v1/audit/events", apiBaseUrl);
  url.searchParams.set("limit", String(input.limit));
  if (input.action !== undefined && input.action.length > 0)
    url.searchParams.set("action", input.action);
  if (input.resourceId !== undefined && input.resourceId.length > 0)
    url.searchParams.set("resourceId", input.resourceId);
  if (input.cursor !== undefined && input.cursor.length > 0)
    url.searchParams.set("cursor", input.cursor);
  return url;
}

export class AetherCloudApiClient {
  readonly #apiBaseUrl: string;

  constructor(apiBaseUrl: string) {
    this.#apiBaseUrl = apiBaseUrl;
  }

  async listFleetGateways(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<FleetListResponse> {
    const response = await fetch(buildFleetListUrl(this.#apiBaseUrl, 50), {
      headers: { authorization: `Bearer ${accessToken}` },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok)
      throw new Error(`Fleet API returned ${String(response.status)}`);
    return decodeFleetListResponse(await response.json());
  }

  async registerGateway(
    accessToken: string,
    input: Readonly<{ gatewayId: string; displayName: string }>,
    idempotencyKey: string,
  ): Promise<void> {
    const response = await fetch(
      new URL("/api/v1/fleet/gateways", this.#apiBaseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(input),
      },
    );
    if (!response.ok)
      throw new Error(`Fleet API returned ${String(response.status)}`);
  }

  async searchAuditEvents(
    accessToken: string,
    input: AuditSearchInput,
    signal?: AbortSignal,
  ): Promise<AuditSearchResponse> {
    const response = await fetch(buildAuditSearchUrl(this.#apiBaseUrl, input), {
      headers: { authorization: `Bearer ${accessToken}` },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok)
      throw new Error(`Audit API returned ${String(response.status)}`);
    return decodeAuditSearchResponse(await response.json());
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(new URL("/health", this.#apiBaseUrl), {
        ...(signal === undefined ? {} : { signal }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
