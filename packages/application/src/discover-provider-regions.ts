import {
  InvalidCloudConnectionError,
  InvalidDomainValueError,
  defineProviderRegion,
  parseCloudConnectionId,
  parseProjectId,
  parseTenantId,
  type CloudConnection,
  type CloudConnectionId,
  type ProjectId,
  type ProviderRegion,
  type TenantId,
} from "@aether-cloud/domain";
/*
 * Adapter responses cross an external-system boundary even when an adapter's
 * TypeScript signature is correct. Reconstructing domain values below keeps
 * runtime validation at that boundary.
 */
import type {
  ProviderDiscoveryFailure,
  ProviderRegionDiscoverySnapshot,
} from "./provider-adapter.js";
import type { ProviderAdapterRegistry } from "./provider-adapter.js";

export const discoverProviderRegionsCapability = Object.freeze({
  kind: "query",
  name: "cloud.provider.regions.discover",
  risk: "low",
  permission: "cloud-connections:read",
  idempotent: true,
  confirmation: "never",
} as const);

export interface CloudConnectionReader {
  findByIdForScope(
    scope: Readonly<{ tenantId: TenantId; projectId: ProjectId }>,
    connectionId: CloudConnectionId,
  ): Promise<CloudConnection | undefined>;
}

export interface DiscoverProviderRegionsContext {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
}

export interface DiscoverProviderRegionsQuery {
  readonly connectionId: CloudConnectionId;
}

type LocalDiscoveryFailureCode =
  | "cloud-connection-disabled"
  | "cloud-connection-not-found"
  | "invalid-input"
  | "permission-denied"
  | "provider-adapter-contract-violation"
  | "provider-adapter-not-registered";

export interface LocalDiscoveryFailure {
  readonly code: LocalDiscoveryFailureCode;
  readonly retryable: false;
}

export type DiscoverProviderRegionsResult =
  | {
      readonly ok: true;
      readonly value: ProviderRegionDiscoverySnapshot;
    }
  | {
      readonly ok: false;
      readonly error: LocalDiscoveryFailure | ProviderDiscoveryFailure;
    };

function localFailure(code: LocalDiscoveryFailureCode): {
  readonly ok: false;
  readonly error: LocalDiscoveryFailure;
} {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, retryable: false }),
  });
}

class ProviderQueryInputError extends Error {}

function requireRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProviderQueryInputError("input must be an object");
  }
  return input as Record<string, unknown>;
}

function decodeContext(input: unknown): DiscoverProviderRegionsContext {
  const record = requireRecord(input);
  if (
    typeof record.subjectId !== "string" ||
    record.subjectId.trim().length === 0 ||
    !Array.isArray(record.permissions) ||
    record.permissions.some((permission) => typeof permission !== "string")
  ) {
    throw new ProviderQueryInputError(
      "query subject and permissions must be provided",
    );
  }
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
    subjectId: record.subjectId,
    permissions: new Set(record.permissions),
  };
}

function decodeQuery(input: unknown): DiscoverProviderRegionsQuery {
  const record = requireRecord(input);
  return { connectionId: parseCloudConnectionId(record.connectionId) };
}

function isCanonicalInstant(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function normalizeSnapshot(
  snapshot: ProviderRegionDiscoverySnapshot,
  connection: CloudConnection,
  declaredCapabilities: ReadonlySet<string>,
): ProviderRegionDiscoverySnapshot | undefined {
  if (
    snapshot.providerId !== connection.providerId ||
    snapshot.connectionId !== connection.id ||
    !isCanonicalInstant(snapshot.observedAt)
  ) {
    return undefined;
  }

  const regionIds = new Set<string>();
  const regions: ProviderRegion[] = [];
  for (const region of snapshot.regions) {
    try {
      const normalizedRegion = defineProviderRegion({
        id: region.id,
        displayName: region.displayName,
        availability: region.availability,
        capabilities: region.capabilities,
        zones: region.zones,
      });
      if (
        regionIds.has(normalizedRegion.id) ||
        normalizedRegion.capabilities.some(
          (capability) => !declaredCapabilities.has(capability),
        )
      ) {
        return undefined;
      }
      regionIds.add(normalizedRegion.id);
      regions.push(normalizedRegion);
    } catch {
      return undefined;
    }
  }

  regions.sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze({
    providerId: snapshot.providerId,
    connectionId: snapshot.connectionId,
    observedAt: snapshot.observedAt,
    regions: Object.freeze(regions),
  });
}

export class DiscoverProviderRegions {
  readonly #connections: CloudConnectionReader;
  readonly #adapters: ProviderAdapterRegistry;

  constructor(
    connections: CloudConnectionReader,
    adapters: ProviderAdapterRegistry,
  ) {
    this.#connections = connections;
    this.#adapters = adapters;
  }

  async execute(
    rawContext: unknown,
    rawQuery: unknown,
  ): Promise<DiscoverProviderRegionsResult> {
    let context: DiscoverProviderRegionsContext;
    let query: DiscoverProviderRegionsQuery;
    try {
      context = decodeContext(rawContext);
      query = decodeQuery(rawQuery);
    } catch (error: unknown) {
      if (
        error instanceof InvalidCloudConnectionError ||
        error instanceof InvalidDomainValueError ||
        error instanceof ProviderQueryInputError
      ) {
        return localFailure("invalid-input");
      }
      throw error;
    }

    if (
      !context.permissions.has(discoverProviderRegionsCapability.permission)
    ) {
      return localFailure("permission-denied");
    }

    const connection = await this.#connections.findByIdForScope(
      context,
      query.connectionId,
    );
    if (connection === undefined) {
      return localFailure("cloud-connection-not-found");
    }
    if (
      connection.id !== query.connectionId ||
      connection.tenantId !== context.tenantId ||
      connection.projectId !== context.projectId
    ) {
      return localFailure("cloud-connection-not-found");
    }
    if (connection.status === "disabled") {
      return localFailure("cloud-connection-disabled");
    }

    const adapter = this.#adapters.find(connection.providerId);
    if (adapter === undefined) {
      return localFailure("provider-adapter-not-registered");
    }

    const result = await adapter.discoverRegions({ connection });
    if (!result.ok) {
      return result;
    }

    const declaredCapabilities = new Set<string>(
      adapter.descriptor.capabilities,
    );
    const snapshot = normalizeSnapshot(
      result.value,
      connection,
      declaredCapabilities,
    );
    if (snapshot === undefined) {
      return localFailure("provider-adapter-contract-violation");
    }

    return Object.freeze({
      ok: true,
      value: snapshot,
    });
  }
}
