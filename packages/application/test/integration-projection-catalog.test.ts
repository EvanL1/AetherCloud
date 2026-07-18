import { describe, expect, it } from "vitest";

import {
  LIST_INTEGRATION_PROJECTIONS_QUERY,
  ListIntegrationProjections,
  type ApplicationClock,
  type IntegrationProjectionCatalog,
  type IntegrationProjectionCatalogQuery,
  type IntegrationProjectionCatalogRecord,
} from "../src/index.js";
import {
  parseGatewayId,
  parseIntegrationId,
  parseIntegrationKind,
  parseIntegrationSnapshotGeneration,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayA = parseGatewayId("33333333-3333-4333-8333-333333333333");
const gatewayB = parseGatewayId("44444444-4444-4444-8444-444444444444");

class FixedClock implements ApplicationClock {
  now() {
    return parseUtcInstant("2026-07-17T10:00:00.000Z");
  }
}

function context(permissions = ["integration.projection.read"]) {
  return {
    tenantId,
    projectId,
    subjectId: "agent-household-1",
    permissions,
  };
}

function record(
  gatewayId: typeof gatewayA,
  integrationId: string,
  overrides: Partial<IntegrationProjectionCatalogRecord> = {},
): IntegrationProjectionCatalogRecord {
  return {
    tenantId,
    projectId,
    gatewayId,
    integrationId: parseIntegrationId(integrationId),
    integrationKind: parseIntegrationKind("home-assistant"),
    snapshotGeneration: parseIntegrationSnapshotGeneration("9"),
    entityCount: 3,
    latestObservationCount: 2,
    receivedAt: parseUtcInstant("2026-07-17T09:59:00.000Z"),
    revision: 4,
    ...overrides,
  };
}

class RecordingCatalog implements IntegrationProjectionCatalog {
  readonly calls: IntegrationProjectionCatalogQuery[] = [];
  records: readonly IntegrationProjectionCatalogRecord[] = [];
  failure: Error | undefined;

  list(
    query: IntegrationProjectionCatalogQuery,
  ): Promise<readonly IntegrationProjectionCatalogRecord[]> {
    this.calls.push(query);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve(this.records);
  }
}

function useCase(catalog: IntegrationProjectionCatalog) {
  return new ListIntegrationProjections({
    catalog,
    clock: new FixedClock(),
  });
}

describe("ListIntegrationProjections", () => {
  it("declares a read-only capability and returns only bounded edge-reported summaries", async () => {
    const catalog = new RecordingCatalog();
    catalog.records = [
      record(gatewayA, "home-assistant.home"),
      record(gatewayB, "home-assistant.cottage", {
        entityCount: 8,
        latestObservationCount: 6,
      }),
    ];

    expect(LIST_INTEGRATION_PROJECTIONS_QUERY).toEqual({
      kind: "query",
      name: "integration.projection.list",
      permission: "integration.projection.read",
    });
    await expect(useCase(catalog).execute(context(), {})).resolves.toEqual({
      ok: true,
      value: {
        authority: "edge-reported-copy",
        liveStateAuthoritative: false,
        items: [
          {
            gatewayId: gatewayA,
            integrationId: "home-assistant.home",
            integrationKind: "home-assistant",
            snapshotGeneration: "9",
            entityCount: 3,
            latestObservationCount: 2,
            receivedAt: "2026-07-17T09:59:00.000Z",
            revision: 4,
          },
          {
            gatewayId: gatewayB,
            integrationId: "home-assistant.cottage",
            integrationKind: "home-assistant",
            snapshotGeneration: "9",
            entityCount: 8,
            latestObservationCount: 6,
            receivedAt: "2026-07-17T09:59:00.000Z",
            revision: 4,
          },
        ],
      },
    });
    expect(catalog.calls).toEqual([
      {
        tenantId,
        projectId,
        limit: 51,
      },
    ]);
  });

  it("requires permission before touching the catalog", async () => {
    const catalog = new RecordingCatalog();

    await expect(
      useCase(catalog).execute(context([]), {}),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "permission-denied" },
    });
    expect(catalog.calls).toEqual([]);
  });

  it.each([
    [{ extra: true }],
    [{ limit: 0 }],
    [{ limit: 101 }],
    [{ limit: 1.5 }],
    [{ limit: "10" }],
    [{ cursor: "***" }],
    [{ cursor: "x".repeat(513) }],
    [{ gatewayId: "not-a-gateway" }],
  ])("rejects closed or unbounded input %#", async (input) => {
    const catalog = new RecordingCatalog();

    await expect(
      useCase(catalog).execute(context(), input),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
    expect(catalog.calls).toEqual([]);
  });

  it("uses an opaque cursor for stable gateway and Integration pagination", async () => {
    const catalog = new RecordingCatalog();
    catalog.records = [
      record(gatewayA, "home-assistant.alpha"),
      record(gatewayA, "home-assistant.beta"),
      record(gatewayB, "home-assistant.gamma"),
    ];
    const query = useCase(catalog);

    const first = await query.execute(context(), { limit: 2 });
    expect(first).toMatchObject({
      ok: true,
      value: {
        items: [
          { gatewayId: gatewayA, integrationId: "home-assistant.alpha" },
          { gatewayId: gatewayA, integrationId: "home-assistant.beta" },
        ],
      },
    });
    if (!first.ok || first.value.nextCursor === undefined) return;
    expect(first.value.nextCursor).not.toContain("home-assistant.beta");

    catalog.records = [record(gatewayB, "home-assistant.gamma")];
    const second = await query.execute(context(), {
      cursor: first.value.nextCursor,
      limit: 2,
    });
    expect(second).toMatchObject({
      ok: true,
      value: {
        items: [{ gatewayId: gatewayB, integrationId: "home-assistant.gamma" }],
      },
    });
    expect(catalog.calls[1]).toEqual({
      tenantId,
      projectId,
      after: {
        gatewayId: gatewayA,
        integrationId: "home-assistant.beta",
      },
      limit: 3,
    });
  });

  it("binds cursors and records to the optional Gateway filter", async () => {
    const catalog = new RecordingCatalog();
    catalog.records = [
      record(gatewayA, "home-assistant.alpha"),
      record(gatewayA, "home-assistant.beta"),
    ];
    const query = useCase(catalog);
    const first = await query.execute(context(), {
      gatewayId: gatewayA,
      limit: 1,
    });
    if (!first.ok || first.value.nextCursor === undefined) {
      throw new Error("expected a filtered cursor");
    }
    expect(catalog.calls[0]).toEqual({
      tenantId,
      projectId,
      gatewayId: gatewayA,
      limit: 2,
    });

    await expect(
      query.execute(context(), {
        gatewayId: gatewayB,
        cursor: first.value.nextCursor,
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
    expect(catalog.calls).toHaveLength(1);
  });

  it.each([
    [
      "cross-tenant row",
      [
        record(gatewayA, "home-assistant.home", {
          tenantId: parseTenantId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        }),
      ],
    ],
    [
      "cross-Gateway filtered row",
      [record(gatewayB, "home-assistant.home")],
      { gatewayId: gatewayA },
    ],
    [
      "unsorted rows",
      [
        record(gatewayB, "home-assistant.home"),
        record(gatewayA, "home-assistant.home"),
      ],
    ],
    [
      "duplicate rows",
      [
        record(gatewayA, "home-assistant.home"),
        record(gatewayA, "home-assistant.home"),
      ],
    ],
    [
      "negative count",
      [
        record(gatewayA, "home-assistant.home", {
          entityCount: -1,
        }),
      ],
    ],
    [
      "future evidence",
      [
        record(gatewayA, "home-assistant.home", {
          receivedAt: parseUtcInstant("2026-07-17T10:00:00.001Z"),
        }),
      ],
    ],
    [
      "extra provider data",
      [
        {
          ...record(gatewayA, "home-assistant.home"),
          providerData: { token: "must-not-cross" },
        },
      ],
    ],
  ])(
    "fails closed for malformed catalog output: %s",
    async (
      _name,
      records,
      input = {} as Readonly<{ gatewayId: typeof gatewayA }>,
    ) => {
      const catalog = new RecordingCatalog();
      catalog.records =
        records as readonly IntegrationProjectionCatalogRecord[];

      await expect(
        useCase(catalog).execute(context(), input),
      ).resolves.toMatchObject({
        ok: false,
        failure: { code: "invalid-integration-repository-result" },
      });
    },
  );

  it("maps catalog failure without leaking storage details", async () => {
    const catalog = new RecordingCatalog();
    catalog.failure = new Error("postgresql://secret@example.invalid");

    await expect(useCase(catalog).execute(context(), {})).resolves.toEqual({
      ok: false,
      failure: {
        code: "integration-storage-unavailable",
        message: "integration projection catalog is unavailable",
      },
    });
  });
});
