import { describe, expect, it, vi } from "vitest";

import {
  DuplicateProviderAdapterError,
  DiscoverProviderRegions,
  ProviderAdapterRegistry,
  discoverProviderRegionsCapability,
  type CloudConnectionReader,
  type ProviderAdapter,
} from "../src/index.js";
import {
  defineCloudConnection,
  defineCloudProvider,
  defineProviderRegion,
} from "@aether-cloud/domain";

const tenantId = "018f6f89-4368-7c3a-b7f1-a9f2da491101";
const otherTenantId = "018f6f89-4368-7c3a-b7f1-a9f2da491199";
const projectId = "018f6f89-4368-7c3a-b7f1-a9f2da491102";
const connectionId = "018f6f89-4368-7c3a-b7f1-a9f2da491103";

const descriptor = defineCloudProvider({
  id: "example-cloud",
  displayName: "Example Cloud",
  kind: "public-cloud",
  capabilities: ["compute", "object-storage", "example-cloud.edge-zone"],
});

const connection = defineCloudConnection({
  id: connectionId,
  tenantId,
  projectId,
  providerId: descriptor.id,
  displayName: "Example production",
  providerScope: "production-account",
  credentialSource: {
    kind: "workload-identity",
    reference: "workload-identity://aether-cloud/providers/example-cloud",
  },
  status: "active",
});

const queryInput = { connectionId };

function queryContext(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    tenantId,
    projectId,
    subjectId: "operator:alice",
    permissions: ["cloud-connections:read"],
    ...overrides,
  };
}

function readerForConnection(): CloudConnectionReader {
  return {
    findByIdForScope: vi.fn<CloudConnectionReader["findByIdForScope"]>(
      (scope, requestedConnectionId) =>
        Promise.resolve(
          scope.tenantId === tenantId &&
            scope.projectId === projectId &&
            requestedConnectionId === connectionId
            ? connection
            : undefined,
        ),
    ),
  };
}

function successfulAdapter() {
  const discoverRegions = vi.fn<ProviderAdapter["discoverRegions"]>(
    ({ connection: requestedConnection }) =>
      Promise.resolve({
        ok: true,
        value: {
          providerId: descriptor.id,
          connectionId: requestedConnection.id,
          observedAt: "2026-07-14T12:00:00.000Z",
          regions: [
            defineProviderRegion({
              id: "region-b",
              displayName: "Region B",
              availability: "restricted",
              capabilities: ["compute", "example-cloud.edge-zone"],
              zones: ["zone-b"],
            }),
            defineProviderRegion({
              id: "region-a",
              displayName: "Region A",
              availability: "available",
              capabilities: ["compute", "object-storage"],
              zones: ["zone-a"],
            }),
          ],
        },
      }),
  );
  const adapter: ProviderAdapter = {
    descriptor,
    discoverRegions,
  };
  return { adapter, discoverRegions };
}

describe("discover provider regions query", () => {
  it("declares its agent-visible safety and permission policy", () => {
    expect(discoverProviderRegionsCapability).toEqual({
      kind: "query",
      name: "cloud.provider.regions.discover",
      risk: "low",
      permission: "cloud-connections:read",
      idempotent: true,
      confirmation: "never",
    });
  });

  it("returns a deterministic provider observation for a tenant connection", async () => {
    const { adapter } = successfulAdapter();
    const handler = new DiscoverProviderRegions(
      readerForConnection(),
      new ProviderAdapterRegistry([adapter]),
    );

    const result = await handler.execute(queryContext(), queryInput);

    expect(result).toEqual({
      ok: true,
      value: {
        providerId: "example-cloud",
        connectionId,
        observedAt: "2026-07-14T12:00:00.000Z",
        regions: [
          expect.objectContaining({ id: "region-a" }),
          expect.objectContaining({ id: "region-b" }),
        ],
      },
    });
  });

  it("does not reveal whether another tenant owns a connection", async () => {
    const { adapter, discoverRegions } = successfulAdapter();
    const handler = new DiscoverProviderRegions(
      readerForConnection(),
      new ProviderAdapterRegistry([adapter]),
    );

    const result = await handler.execute(
      queryContext({ tenantId: otherTenantId }),
      queryInput,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "cloud-connection-not-found",
        retryable: false,
      },
    });
    expect(discoverRegions).not.toHaveBeenCalled();
  });

  it("does not call a provider adapter for a disabled connection", async () => {
    const { adapter, discoverRegions } = successfulAdapter();
    const disabledConnection = defineCloudConnection({
      ...connection,
      status: "disabled",
    });
    const reader: CloudConnectionReader = {
      findByIdForScope: vi.fn(() => Promise.resolve(disabledConnection)),
    };
    const handler = new DiscoverProviderRegions(
      reader,
      new ProviderAdapterRegistry([adapter]),
    );

    const result = await handler.execute(queryContext(), queryInput);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "cloud-connection-disabled",
        retryable: false,
      },
    });
    expect(discoverRegions).not.toHaveBeenCalled();
  });

  it("fails with a typed error when no adapter is registered", async () => {
    const handler = new DiscoverProviderRegions(
      readerForConnection(),
      new ProviderAdapterRegistry([]),
    );

    const result = await handler.execute(queryContext(), queryInput);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider-adapter-not-registered",
        retryable: false,
      },
    });
  });

  it("preserves a typed retryable provider failure", async () => {
    const adapter: ProviderAdapter = {
      descriptor,
      discoverRegions: vi.fn<ProviderAdapter["discoverRegions"]>(() =>
        Promise.resolve({
          ok: false,
          error: {
            code: "provider-rate-limited",
            retryable: true,
          },
        }),
      ),
    };
    const handler = new DiscoverProviderRegions(
      readerForConnection(),
      new ProviderAdapterRegistry([adapter]),
    );

    const result = await handler.execute(queryContext(), queryInput);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider-rate-limited",
        retryable: true,
      },
    });
  });

  it("fails closed when an adapter returns an observation for another provider", async () => {
    const adapter: ProviderAdapter = {
      descriptor,
      discoverRegions: vi.fn<ProviderAdapter["discoverRegions"]>(() =>
        Promise.resolve({
          ok: true,
          value: {
            providerId: defineCloudProvider({
              id: "wrong-provider",
              displayName: "Wrong Provider",
              kind: "public-cloud",
              capabilities: ["compute"],
            }).id,
            connectionId: connection.id,
            observedAt: "2026-07-14T12:00:00.000Z",
            regions: [],
          },
        }),
      ),
    };
    const handler = new DiscoverProviderRegions(
      readerForConnection(),
      new ProviderAdapterRegistry([adapter]),
    );

    const result = await handler.execute(queryContext(), queryInput);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider-adapter-contract-violation",
        retryable: false,
      },
    });
  });

  it("fails closed when a region claims an undeclared capability", async () => {
    const adapter: ProviderAdapter = {
      descriptor,
      discoverRegions: vi.fn<ProviderAdapter["discoverRegions"]>(() =>
        Promise.resolve({
          ok: true,
          value: {
            providerId: descriptor.id,
            connectionId: connection.id,
            observedAt: "2026-07-14T12:00:00.000Z",
            regions: [
              defineProviderRegion({
                id: "region-a",
                displayName: "Region A",
                availability: "available",
                capabilities: ["other-provider.private-service"],
                zones: [],
              }),
            ],
          },
        }),
      ),
    };
    const handler = new DiscoverProviderRegions(
      readerForConnection(),
      new ProviderAdapterRegistry([adapter]),
    );

    const result = await handler.execute(queryContext(), queryInput);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider-adapter-contract-violation",
        retryable: false,
      },
    });
  });

  it("runtime-validates malformed region output from an adapter", async () => {
    const malformedRegion = {
      id: "invalid region id",
      displayName: "Invalid region",
      availability: "available",
      capabilities: ["compute"],
      zones: [],
    } as unknown as ReturnType<typeof defineProviderRegion>;
    const adapter: ProviderAdapter = {
      descriptor,
      discoverRegions: vi.fn<ProviderAdapter["discoverRegions"]>(() =>
        Promise.resolve({
          ok: true,
          value: {
            providerId: descriptor.id,
            connectionId: connection.id,
            observedAt: "2026-07-14T12:00:00.000Z",
            regions: [malformedRegion],
          },
        }),
      ),
    };
    const handler = new DiscoverProviderRegions(
      readerForConnection(),
      new ProviderAdapterRegistry([adapter]),
    );

    const result = await handler.execute(queryContext(), queryInput);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider-adapter-contract-violation",
        retryable: false,
      },
    });
  });

  it("fails closed before reading a connection when permission is missing", async () => {
    const { adapter, discoverRegions } = successfulAdapter();
    const findByIdForScope = vi.fn<CloudConnectionReader["findByIdForScope"]>(
      () => Promise.resolve(connection),
    );
    const reader: CloudConnectionReader = { findByIdForScope };
    const handler = new DiscoverProviderRegions(
      reader,
      new ProviderAdapterRegistry([adapter]),
    );

    const result = await handler.execute(
      queryContext({ permissions: [] }),
      queryInput,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "permission-denied",
        retryable: false,
      },
    });
    expect(findByIdForScope).not.toHaveBeenCalled();
    expect(discoverRegions).not.toHaveBeenCalled();
  });

  it("rejects malformed query identities at runtime", async () => {
    const handler = new DiscoverProviderRegions(
      readerForConnection(),
      new ProviderAdapterRegistry([]),
    );

    const result = await handler.execute(
      queryContext({ tenantId: "tenant-one" }),
      queryInput,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid-input",
        retryable: false,
      },
    });
  });

  it.each([
    [null, queryInput],
    [queryContext({ subjectId: "" }), queryInput],
    [queryContext(), { connectionId: 42 }],
  ])("rejects malformed external query shapes", async (context, input) => {
    const handler = new DiscoverProviderRegions(
      readerForConnection(),
      new ProviderAdapterRegistry([]),
    );

    const result = await handler.execute(context, input);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid-input",
        retryable: false,
      },
    });
  });

  it("rejects a repository result outside the requested project scope", async () => {
    const { adapter, discoverRegions } = successfulAdapter();
    const reader: CloudConnectionReader = {
      findByIdForScope: vi.fn(() => Promise.resolve(connection)),
    };
    const handler = new DiscoverProviderRegions(
      reader,
      new ProviderAdapterRegistry([adapter]),
    );

    const result = await handler.execute(
      queryContext({ projectId: "018f6f89-4368-7c3a-b7f1-a9f2da491198" }),
      queryInput,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "cloud-connection-not-found",
        retryable: false,
      },
    });
    expect(discoverRegions).not.toHaveBeenCalled();
  });
});

describe("provider adapter registry", () => {
  it("rejects duplicate provider identities", () => {
    expect(
      () =>
        new ProviderAdapterRegistry([
          successfulAdapter().adapter,
          successfulAdapter().adapter,
        ]),
    ).toThrow(DuplicateProviderAdapterError);
  });
});
