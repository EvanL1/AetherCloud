import { describe, expect, it } from "vitest";

import {
  IntegrationProjectionStorageUnavailableError,
  type IntegrationProjectionCatalog,
} from "@aether-cloud/application";
import {
  parseGatewayId,
  parseIntegrationId,
  parseProjectId,
  parseTenantId,
} from "@aether-cloud/domain";

import {
  PostgresIntegrationProjectionRepository,
  type PostgresIntegrationProjectionClient,
  type PostgresIntegrationProjectionPool,
  type PostgresIntegrationProjectionQueryResult,
} from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const nextGatewayId = parseGatewayId("44444444-4444-4444-8444-444444444444");

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

function result(
  rows: readonly Record<string, unknown>[] = [],
): PostgresIntegrationProjectionQueryResult<Record<string, unknown>> {
  return { rowCount: rows.length, rows };
}

function catalogRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    project_id: projectId,
    gateway_id: gatewayId,
    integration_id: "home-assistant:home",
    integration_kind: "home-assistant",
    snapshot_generation: "12",
    entity_count: "3",
    latest_observation_count: "2",
    received_at: "2026-07-17T10:00:00.000Z",
    revision: "4",
    ...overrides,
  };
}

class CatalogClient implements PostgresIntegrationProjectionClient {
  readonly calls: QueryCall[] = [];
  released = false;
  rows: readonly Record<string, unknown>[] = [];

  query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresIntegrationProjectionQueryResult<Row>> {
    this.calls.push({ text, values });
    return Promise.resolve(
      (text.includes("integration-projection:list-catalog")
        ? result(this.rows)
        : result()) as PostgresIntegrationProjectionQueryResult<Row>,
    );
  }

  release(): void {
    this.released = true;
  }
}

class CatalogPool implements PostgresIntegrationProjectionPool {
  readonly client: CatalogClient;

  constructor(client: CatalogClient) {
    this.client = client;
  }

  connect(): Promise<PostgresIntegrationProjectionClient> {
    return Promise.resolve(this.client);
  }
}

function createCatalog(client: CatalogClient): IntegrationProjectionCatalog {
  return new PostgresIntegrationProjectionRepository(new CatalogPool(client));
}

describe("PostgreSQL integration projection catalog", () => {
  it("uses an RLS-scoped, parameterized keyset query and decodes only summary fields", async () => {
    const client = new CatalogClient();
    client.rows = [
      catalogRow({
        gateway_id: nextGatewayId,
        integration_id: "zigbee2mqtt:house",
        entity_count: "7",
        latest_observation_count: "5",
      }),
    ];
    const catalog = createCatalog(client);

    await expect(
      catalog.list({
        tenantId,
        projectId,
        gatewayId: nextGatewayId,
        after: {
          gatewayId: nextGatewayId,
          integrationId: parseIntegrationId("home-assistant:home"),
        },
        limit: 3,
      }),
    ).resolves.toEqual([
      {
        tenantId,
        projectId,
        gatewayId: nextGatewayId,
        integrationId: "zigbee2mqtt:house",
        integrationKind: "home-assistant",
        snapshotGeneration: "12",
        entityCount: 7,
        latestObservationCount: 5,
        receivedAt: "2026-07-17T10:00:00.000Z",
        revision: 4,
      },
    ]);

    const scopeCall = client.calls.find((call) =>
      call.text.includes("set_config"),
    );
    const listCall = client.calls.find((call) =>
      call.text.includes("integration-projection:list-catalog"),
    );
    expect(scopeCall?.values).toEqual([tenantId]);
    expect(listCall?.values).toEqual([
      tenantId,
      projectId,
      nextGatewayId,
      nextGatewayId,
      "home-assistant:home",
      3,
    ]);
    expect(listCall?.text).toContain("jsonb_array_length");
    expect(listCall?.text).toContain(
      'ORDER BY gateway_id ASC, integration_id COLLATE "C" ASC',
    );
    expect(listCall?.text).toContain("LIMIT $6");
    expect(listCall?.text).not.toContain(tenantId);
    expect(client.calls.at(0)?.text).toBe("BEGIN");
    expect(client.calls.at(-1)?.text).toBe("COMMIT");
    expect(client.released).toBe(true);
  });

  it("binds tenant and project while omitting the optional Gateway filter", async () => {
    const client = new CatalogClient();
    const catalog = createCatalog(client);

    await expect(
      catalog.list({ tenantId, projectId, limit: 51 }),
    ).resolves.toEqual([]);

    const listCall = client.calls.find((call) =>
      call.text.includes("integration-projection:list-catalog"),
    );
    expect(listCall?.values).toEqual([
      tenantId,
      projectId,
      null,
      null,
      null,
      51,
    ]);
  });

  it("fails closed and rolls back on corrupt or unstable repository rows", async () => {
    const client = new CatalogClient();
    client.rows = [
      catalogRow({
        gateway_id: nextGatewayId,
        integration_id: "zigbee2mqtt:z",
      }),
      catalogRow({
        gateway_id: gatewayId,
        integration_id: "home-assistant:a",
      }),
    ];
    const catalog = createCatalog(client);

    await expect(
      catalog.list({ tenantId, projectId, limit: 3 }),
    ).rejects.toBeInstanceOf(IntegrationProjectionStorageUnavailableError);

    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(client.released).toBe(true);
  });

  it("rejects extra columns and rows outside the requested scope", async () => {
    const client = new CatalogClient();
    const catalog = createCatalog(client);
    client.rows = [catalogRow({ provider_payload: { token: "secret" } })];

    await expect(
      catalog.list({ tenantId, projectId, gatewayId, limit: 2 }),
    ).rejects.toBeInstanceOf(IntegrationProjectionStorageUnavailableError);

    client.calls.length = 0;
    client.rows = [catalogRow({ gateway_id: nextGatewayId })];
    await expect(
      catalog.list({ tenantId, projectId, gatewayId, limit: 2 }),
    ).rejects.toBeInstanceOf(IntegrationProjectionStorageUnavailableError);
  });

  it("rejects limits outside the application fetch bound without querying", async () => {
    const client = new CatalogClient();
    const catalog = createCatalog(client);

    await expect(
      catalog.list({ tenantId, projectId, limit: 102 }),
    ).rejects.toBeInstanceOf(IntegrationProjectionStorageUnavailableError);
    expect(
      client.calls.some((call) =>
        call.text.includes("integration-projection:list-catalog"),
      ),
    ).toBe(false);
  });
});
