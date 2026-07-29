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
