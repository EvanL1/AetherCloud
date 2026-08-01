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

export type FleetConnectionStatusReason =
  | "heartbeat-current"
  | "heartbeat-overdue"
  | "heartbeat-pending"
  | "no-session"
  | "session-closed"
  | "session-draining"
  | "session-negotiating"
  | "session-resuming"
  | "session-suspect";

export interface FleetGatewayView {
  readonly gatewayId: string;
  readonly displayName: string;
  readonly enrollmentState: "awaiting-claim" | "claimed" | "registered";
  readonly revision: number;
  readonly registeredAt: string;
  readonly connection: Readonly<{
    status: FleetConnectionStatus;
    reason: FleetConnectionStatusReason;
    sessionId?: string;
    sessionState?: string;
    protocolVersion?: string;
    openedAt?: string;
    activatedAt?: string;
    lastSeenAt?: string;
    heartbeatIntervalMs?: string;
    staleAfter?: string;
    suspectAt?: string;
    closedAt?: string;
    closeReason?: "drained" | "fenced" | "heartbeat-timeout";
  }>;
  readonly telemetry: Readonly<{
    status: "no-data" | "receiving";
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

export interface EnrollmentIssuedView {
  readonly gatewayId: string;
  readonly state: "awaiting-claim";
  readonly revision: number;
  readonly expiresAt: string;
  readonly enrollmentToken: string;
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

function optionalFleetInstant(
  input: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const value = optionalFleetString(input, field);
  if (value !== undefined && Number.isNaN(Date.parse(value)))
    return fleetFailure();
  return value;
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
  const reason = fleetString(connection, "reason");
  if (
    reason !== "heartbeat-current" &&
    reason !== "heartbeat-overdue" &&
    reason !== "heartbeat-pending" &&
    reason !== "no-session" &&
    reason !== "session-closed" &&
    reason !== "session-draining" &&
    reason !== "session-negotiating" &&
    reason !== "session-resuming" &&
    reason !== "session-suspect"
  )
    return fleetFailure();
  const sessionId = optionalFleetString(connection, "sessionId");
  if (
    sessionId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      sessionId,
    )
  )
    return fleetFailure();
  const sessionState = optionalFleetString(connection, "sessionState");
  const protocolVersion = optionalFleetString(connection, "protocolVersion");
  const openedAt = optionalFleetInstant(connection, "openedAt");
  const activatedAt = optionalFleetInstant(connection, "activatedAt");
  const lastSeenAt = optionalFleetInstant(connection, "lastSeenAt");
  const heartbeatIntervalMs = optionalFleetString(
    connection,
    "heartbeatIntervalMs",
  );
  if (
    heartbeatIntervalMs !== undefined &&
    !/^(?:0|[1-9][0-9]*)$/.test(heartbeatIntervalMs)
  )
    return fleetFailure();
  const staleAfter = optionalFleetInstant(connection, "staleAfter");
  const suspectAt = optionalFleetInstant(connection, "suspectAt");
  const closedAt = optionalFleetInstant(connection, "closedAt");
  const closeReason = optionalFleetString(connection, "closeReason");
  if (
    closeReason !== undefined &&
    closeReason !== "drained" &&
    closeReason !== "fenced" &&
    closeReason !== "heartbeat-timeout"
  )
    return fleetFailure();
  const telemetry = fleetRecord(gateway.telemetry);
  const telemetryStatus = fleetString(telemetry, "status");
  if (telemetryStatus !== "no-data" && telemetryStatus !== "receiving")
    return fleetFailure();
  const lastReceivedAt = optionalFleetInstant(telemetry, "lastReceivedAt");
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
      reason,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(sessionState === undefined ? {} : { sessionState }),
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
      ...(openedAt === undefined ? {} : { openedAt }),
      ...(activatedAt === undefined ? {} : { activatedAt }),
      ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
      ...(heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs }),
      ...(staleAfter === undefined ? {} : { staleAfter }),
      ...(suspectAt === undefined ? {} : { suspectAt }),
      ...(closedAt === undefined ? {} : { closedAt }),
      ...(closeReason === undefined ? {} : { closeReason }),
    },
    telemetry: {
      status: telemetryStatus,
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

export type IntegrationPointKind = "event" | "status" | "telemetry";

export type IntegrationValueType =
  | "boolean"
  | "bytes"
  | "decimal"
  | "float64"
  | "int64"
  | "string"
  | "uint64";

export type IntegrationObservationQuality =
  | "bad"
  | "good"
  | "uncertain"
  | "unavailable";

export interface IntegrationCatalogItemView {
  readonly gatewayId: string;
  readonly integrationId: string;
  readonly integrationKind: string;
  readonly snapshotGeneration: string;
  readonly entityCount: number;
  readonly latestObservationCount: number;
  readonly receivedAt: string;
  readonly revision: number;
}

export interface IntegrationCatalogResponse {
  readonly authority: "edge-reported-copy";
  readonly liveStateAuthoritative: false;
  readonly items: readonly IntegrationCatalogItemView[];
  readonly nextCursor?: string;
}

export interface IntegrationAreaView {
  readonly areaId: string;
  readonly name: string;
}

export interface IntegrationDeviceView {
  readonly deviceId: string;
  readonly name: string;
  readonly areaId?: string;
  readonly manufacturer?: string;
  readonly model?: string;
  readonly softwareVersion?: string;
  readonly hardwareVersion?: string;
}

export interface IntegrationPointView {
  readonly pointKey: string;
  readonly title: string;
  readonly kind: IntegrationPointKind;
  readonly valueType: IntegrationValueType;
  readonly unit?: string;
}

export interface IntegrationEntityView {
  readonly entityId: string;
  readonly sourceAddress: string;
  readonly name: string;
  readonly entityKind: string;
  readonly deviceId?: string;
  readonly areaId?: string;
  readonly points: readonly IntegrationPointView[];
}

export interface IntegrationTopologyView {
  readonly schema: string;
  readonly integrationId: string;
  readonly integrationKind: string;
  readonly snapshotGeneration: string;
  readonly observedAtMs: string;
  readonly areas: readonly IntegrationAreaView[];
  readonly devices: readonly IntegrationDeviceView[];
  readonly entities: readonly IntegrationEntityView[];
}

export interface IntegrationObservedValueView {
  readonly type: IntegrationValueType;
  readonly value: boolean | number | string;
  readonly encoding?: "base64url";
}

export interface IntegrationObservationView {
  readonly entityId: string;
  readonly pointKey: string;
  readonly observedAtMs: string;
  readonly quality: IntegrationObservationQuality;
  readonly value?: IntegrationObservedValueView;
  readonly diagnostic?: string;
}

export interface IntegrationProjectionView {
  readonly authority: "edge-reported-copy";
  readonly liveStateAuthoritative: false;
  readonly tenantId: string;
  readonly projectId: string;
  readonly gatewayId: string;
  readonly integrationId: string;
  readonly topology: IntegrationTopologyView;
  readonly topologyDigest: string;
  readonly latestObservations: readonly IntegrationObservationView[];
  readonly receivedAt: string;
  readonly revision: number;
}

export interface IntegrationCatalogInput {
  readonly limit: number;
  readonly gatewayId?: string;
  readonly cursor?: string;
}

function integrationFailure(): never {
  throw new Error("invalid Integration response");
}

function integrationRecord(input: unknown): Readonly<Record<string, unknown>> {
  return isRecord(input) ? input : integrationFailure();
}

function integrationString(
  input: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = input[field];
  if (typeof value !== "string" || value.length === 0)
    return integrationFailure();
  return value;
}

function optionalIntegrationString(
  input: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0)
    return integrationFailure();
  return value;
}

function integrationUnsigned64(
  input: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = integrationString(input, field);
  return /^(?:0|[1-9][0-9]*)$/.test(value) ? value : integrationFailure();
}

function integrationInstant(
  input: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = integrationString(input, field);
  return Number.isNaN(Date.parse(value)) ? integrationFailure() : value;
}

function integrationCount(
  input: Readonly<Record<string, unknown>>,
  field: string,
): number {
  const value = input[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return integrationFailure();
  return value;
}

function integrationRevision(input: Readonly<Record<string, unknown>>): number {
  const value = input.revision;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    return integrationFailure();
  return value;
}

/**
 * The API pins `authority` and `liveStateAuthoritative` as schema constants so
 * the read-only claim cannot drift. A response that does not carry both is not
 * an Integration projection and never reaches the console.
 */
function requireEdgeReportedCopy(
  input: Readonly<Record<string, unknown>>,
): void {
  if (
    input.authority !== "edge-reported-copy" ||
    input.liveStateAuthoritative !== false
  ) {
    integrationFailure();
  }
}

function integrationArray(
  input: Readonly<Record<string, unknown>>,
  field: string,
): readonly unknown[] {
  const value = input[field];
  return Array.isArray(value) ? value : integrationFailure();
}

function decodeIntegrationCatalogItem(
  input: unknown,
): IntegrationCatalogItemView {
  const item = integrationRecord(input);
  return {
    gatewayId: integrationString(item, "gatewayId"),
    integrationId: integrationString(item, "integrationId"),
    integrationKind: integrationString(item, "integrationKind"),
    snapshotGeneration: integrationUnsigned64(item, "snapshotGeneration"),
    entityCount: integrationCount(item, "entityCount"),
    latestObservationCount: integrationCount(item, "latestObservationCount"),
    receivedAt: integrationInstant(item, "receivedAt"),
    revision: integrationRevision(item),
  };
}

export function decodeIntegrationCatalogResponse(
  input: unknown,
): IntegrationCatalogResponse {
  const response = integrationRecord(input);
  requireEdgeReportedCopy(response);
  const items = integrationArray(response, "items");
  const nextCursor = optionalIntegrationString(response, "nextCursor");
  return Object.freeze({
    authority: "edge-reported-copy" as const,
    liveStateAuthoritative: false as const,
    items: Object.freeze(
      items.map((item) => decodeIntegrationCatalogItem(item)),
    ),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

function decodeIntegrationArea(input: unknown): IntegrationAreaView {
  const area = integrationRecord(input);
  return {
    areaId: integrationString(area, "areaId"),
    name: integrationString(area, "name"),
  };
}

function decodeIntegrationDevice(input: unknown): IntegrationDeviceView {
  const device = integrationRecord(input);
  const areaId = optionalIntegrationString(device, "areaId");
  const manufacturer = optionalIntegrationString(device, "manufacturer");
  const model = optionalIntegrationString(device, "model");
  const softwareVersion = optionalIntegrationString(device, "softwareVersion");
  const hardwareVersion = optionalIntegrationString(device, "hardwareVersion");
  return {
    deviceId: integrationString(device, "deviceId"),
    name: integrationString(device, "name"),
    ...(areaId === undefined ? {} : { areaId }),
    ...(manufacturer === undefined ? {} : { manufacturer }),
    ...(model === undefined ? {} : { model }),
    ...(softwareVersion === undefined ? {} : { softwareVersion }),
    ...(hardwareVersion === undefined ? {} : { hardwareVersion }),
  };
}

function decodeIntegrationValueType(input: unknown): IntegrationValueType {
  if (
    input === "boolean" ||
    input === "bytes" ||
    input === "decimal" ||
    input === "float64" ||
    input === "int64" ||
    input === "string" ||
    input === "uint64"
  ) {
    return input;
  }
  return integrationFailure();
}

function decodeIntegrationPoint(input: unknown): IntegrationPointView {
  const point = integrationRecord(input);
  const kind = point.kind;
  if (kind !== "event" && kind !== "status" && kind !== "telemetry")
    return integrationFailure();
  const unit = optionalIntegrationString(point, "unit");
  return {
    pointKey: integrationString(point, "pointKey"),
    title: integrationString(point, "title"),
    kind,
    valueType: decodeIntegrationValueType(point.valueType),
    ...(unit === undefined ? {} : { unit }),
  };
}

function decodeIntegrationEntity(input: unknown): IntegrationEntityView {
  const entity = integrationRecord(input);
  const deviceId = optionalIntegrationString(entity, "deviceId");
  const areaId = optionalIntegrationString(entity, "areaId");
  return {
    entityId: integrationString(entity, "entityId"),
    sourceAddress: integrationString(entity, "sourceAddress"),
    name: integrationString(entity, "name"),
    entityKind: integrationString(entity, "entityKind"),
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(areaId === undefined ? {} : { areaId }),
    points: Object.freeze(
      integrationArray(entity, "points").map((point) =>
        decodeIntegrationPoint(point),
      ),
    ),
  };
}

function decodeIntegrationTopology(input: unknown): IntegrationTopologyView {
  const topology = integrationRecord(input);
  return {
    schema: integrationString(topology, "schema"),
    integrationId: integrationString(topology, "integrationId"),
    integrationKind: integrationString(topology, "integrationKind"),
    snapshotGeneration: integrationUnsigned64(topology, "snapshotGeneration"),
    observedAtMs: integrationUnsigned64(topology, "observedAtMs"),
    areas: Object.freeze(
      integrationArray(topology, "areas").map((area) =>
        decodeIntegrationArea(area),
      ),
    ),
    devices: Object.freeze(
      integrationArray(topology, "devices").map((device) =>
        decodeIntegrationDevice(device),
      ),
    ),
    entities: Object.freeze(
      integrationArray(topology, "entities").map((entity) =>
        decodeIntegrationEntity(entity),
      ),
    ),
  };
}

/**
 * `int64`, `uint64` and `decimal` observations stay textual so a protocol
 * integer never passes through a JavaScript number.
 */
function decodeIntegrationObservedValue(
  input: unknown,
): IntegrationObservedValueView {
  const observed = integrationRecord(input);
  const type = decodeIntegrationValueType(observed.type);
  const value = observed.value;
  if (type === "boolean") {
    if (typeof value !== "boolean") return integrationFailure();
    return { type, value };
  }
  if (type === "float64") {
    if (typeof value !== "number" || !Number.isFinite(value))
      return integrationFailure();
    return { type, value };
  }
  if (typeof value !== "string") return integrationFailure();
  if (type === "bytes") {
    if (observed.encoding !== "base64url") return integrationFailure();
    return { type, value, encoding: "base64url" };
  }
  return { type, value };
}

function decodeIntegrationObservation(
  input: unknown,
): IntegrationObservationView {
  const observation = integrationRecord(input);
  const quality = observation.quality;
  if (
    quality !== "bad" &&
    quality !== "good" &&
    quality !== "uncertain" &&
    quality !== "unavailable"
  ) {
    return integrationFailure();
  }
  const rawValue = observation.value;
  const value =
    rawValue === undefined
      ? undefined
      : decodeIntegrationObservedValue(rawValue);
  const diagnostic = optionalIntegrationString(observation, "diagnostic");
  return {
    entityId: integrationString(observation, "entityId"),
    pointKey: integrationString(observation, "pointKey"),
    observedAtMs: integrationUnsigned64(observation, "observedAtMs"),
    quality,
    ...(value === undefined ? {} : { value }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

export function decodeIntegrationProjectionResponse(
  input: unknown,
): IntegrationProjectionView {
  const response = integrationRecord(input);
  requireEdgeReportedCopy(response);
  const topologyDigest = integrationString(response, "topologyDigest");
  if (!/^[0-9a-f]{64}$/.test(topologyDigest)) return integrationFailure();
  return Object.freeze({
    authority: "edge-reported-copy" as const,
    liveStateAuthoritative: false as const,
    tenantId: integrationString(response, "tenantId"),
    projectId: integrationString(response, "projectId"),
    gatewayId: integrationString(response, "gatewayId"),
    integrationId: integrationString(response, "integrationId"),
    topology: decodeIntegrationTopology(response.topology),
    topologyDigest,
    latestObservations: Object.freeze(
      integrationArray(response, "latestObservations").map((observation) =>
        decodeIntegrationObservation(observation),
      ),
    ),
    receivedAt: integrationInstant(response, "receivedAt"),
    revision: integrationRevision(response),
  });
}

export function buildIntegrationCatalogUrl(
  apiBaseUrl: string,
  input: IntegrationCatalogInput,
): URL {
  const url = new URL("/api/v1/integrations", apiBaseUrl);
  url.searchParams.set("limit", String(input.limit));
  if (input.gatewayId !== undefined && input.gatewayId.length > 0)
    url.searchParams.set("gatewayId", input.gatewayId);
  if (input.cursor !== undefined && input.cursor.length > 0)
    url.searchParams.set("cursor", input.cursor);
  return url;
}

export function buildIntegrationProjectionUrl(
  apiBaseUrl: string,
  gatewayId: string,
  integrationId: string,
): URL {
  return new URL(
    `/api/v1/integrations/${encodeURIComponent(gatewayId)}/${encodeURIComponent(integrationId)}`,
    apiBaseUrl,
  );
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

  async issueGatewayEnrollment(
    accessToken: string,
    gatewayId: string,
    idempotencyKey: string,
  ): Promise<EnrollmentIssuedView> {
    const response = await fetch(
      new URL(
        `/api/v1/fleet/gateways/${encodeURIComponent(gatewayId)}/enrollment-claims`,
        this.#apiBaseUrl,
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "x-aethercloud-confirmation": "issue-enrollment-claim",
        },
        body: "{}",
      },
    );
    if (!response.ok)
      throw new Error(`Fleet API returned ${String(response.status)}`);
    const value: unknown = await response.json();
    if (!isRecord(value)) return fleetFailure();
    const state = value.state;
    const revision = value.revision;
    const expiresAt = value.expiresAt;
    if (
      value.schema !== "aether.cloud.gateway-enrollment-issued.v1" ||
      state !== "awaiting-claim" ||
      typeof revision !== "number" ||
      !Number.isSafeInteger(revision) ||
      revision < 2 ||
      typeof expiresAt !== "string" ||
      Number.isNaN(Date.parse(expiresAt))
    ) {
      return fleetFailure();
    }
    return {
      gatewayId: fleetString(value, "gatewayId"),
      state,
      revision,
      expiresAt,
      enrollmentToken: fleetString(value, "enrollmentToken"),
    };
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

  async listIntegrationProjections(
    accessToken: string,
    input: IntegrationCatalogInput,
    signal?: AbortSignal,
  ): Promise<IntegrationCatalogResponse> {
    const response = await fetch(
      buildIntegrationCatalogUrl(this.#apiBaseUrl, input),
      {
        headers: { authorization: `Bearer ${accessToken}` },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (!response.ok)
      throw new Error(`Integration API returned ${String(response.status)}`);
    return decodeIntegrationCatalogResponse(await response.json());
  }

  async getIntegrationProjection(
    accessToken: string,
    gatewayId: string,
    integrationId: string,
    signal?: AbortSignal,
  ): Promise<IntegrationProjectionView> {
    const response = await fetch(
      buildIntegrationProjectionUrl(this.#apiBaseUrl, gatewayId, integrationId),
      {
        headers: { authorization: `Bearer ${accessToken}` },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (!response.ok)
      throw new Error(`Integration API returned ${String(response.status)}`);
    return decodeIntegrationProjectionResponse(await response.json());
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
