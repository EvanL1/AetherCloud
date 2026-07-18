import { describe, expect, it } from "vitest";

import type {
  IntegrationProjectionCatalog,
  IntegrationProjectionCatalogQuery,
} from "@aether-cloud/application";
import {
  defineIntegrationObservationBatch,
  defineIntegrationTopologySnapshot,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseIntegrationId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  type GatewayCredentialBinding,
} from "@aether-cloud/domain";

import {
  InMemoryIntegrationProjectionRepository,
  NodeIntegrationPayloadDigestor,
} from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayA = parseGatewayId("33333333-3333-4333-8333-333333333333");
const gatewayB = parseGatewayId("44444444-4444-4444-8444-444444444444");

function binding(gatewayId: typeof gatewayA): GatewayCredentialBinding {
  return {
    tenantId,
    projectId,
    gatewayId,
    generation: parseGatewayCredentialGeneration("3"),
    status: "active",
  };
}

async function persistProjection(
  repository: InMemoryIntegrationProjectionRepository,
  gatewayId: typeof gatewayA,
  integrationId: string,
  entityCount: number,
  withObservation = false,
): Promise<void> {
  const topology = defineIntegrationTopologySnapshot({
    schema: "aether.integration.topology-snapshot.v1alpha1",
    integrationId,
    integrationKind: "home-assistant",
    snapshotGeneration: "9",
    observedAtMs: "1784275199000",
    areas: [],
    devices: [],
    entities: Array.from({ length: entityCount }, (_, index) => ({
      entityId: `entity-registry-light-${String(index)}`,
      sourceAddress: `light.room_${String(index)}`,
      name: `Room light ${String(index)}`,
      entityKind: "light",
      points: [
        {
          pointKey: "is_on",
          title: "Power",
          kind: "status" as const,
          valueType: "boolean" as const,
        },
      ],
    })),
  });
  const digestor = new NodeIntegrationPayloadDigestor();
  const accepted = await repository.persistTopology({
    requestId: `topology-${gatewayId}-${integrationId}`,
    binding: binding(gatewayId),
    topology,
    payloadDigest: await digestor.digest(topology),
    receivedAt: parseUtcInstant("2026-07-17T08:00:00.000Z"),
  });
  expect(accepted).toMatchObject({ outcome: "persisted" });
  if (!withObservation) return;
  const batch = defineIntegrationObservationBatch(
    {
      schema: "aether.integration.observation-batch.v1alpha1",
      integrationId,
      snapshotGeneration: "9",
      batchId: `observation-${gatewayId}-${integrationId}`,
      observedAtMs: "1784275200000",
      observations: [
        {
          entityId: "entity-registry-light-0",
          pointKey: "is_on",
          observedAtMs: "1784275200000",
          quality: "good",
          value: { type: "boolean", value: true },
        },
      ],
    },
    topology,
  );
  await repository.persistObservations({
    requestId: `observations-${gatewayId}-${integrationId}`,
    binding: binding(gatewayId),
    batch,
    payloadDigest: await digestor.digest(batch),
    receivedAt: parseUtcInstant("2026-07-17T08:01:00.000Z"),
  });
}

describe("InMemoryIntegrationProjectionRepository catalog", () => {
  it("lists stable summaries with keyset pagination and no provider payload", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    const catalog: IntegrationProjectionCatalog = repository;
    await persistProjection(repository, gatewayB, "home-assistant.gamma", 3);
    await persistProjection(
      repository,
      gatewayA,
      "home-assistant.beta",
      2,
      true,
    );
    await persistProjection(repository, gatewayA, "home-assistant.alpha", 1);

    const query: IntegrationProjectionCatalogQuery = {
      tenantId,
      projectId,
      limit: 2,
    };
    const first = await catalog.list(query);
    expect(first).toEqual([
      {
        tenantId,
        projectId,
        gatewayId: gatewayA,
        integrationId: "home-assistant.alpha",
        integrationKind: "home-assistant",
        snapshotGeneration: "9",
        entityCount: 1,
        latestObservationCount: 0,
        receivedAt: "2026-07-17T08:00:00.000Z",
        revision: 1,
      },
      {
        tenantId,
        projectId,
        gatewayId: gatewayA,
        integrationId: "home-assistant.beta",
        integrationKind: "home-assistant",
        snapshotGeneration: "9",
        entityCount: 2,
        latestObservationCount: 1,
        receivedAt: "2026-07-17T08:01:00.000Z",
        revision: 2,
      },
    ]);
    expect(JSON.stringify(first)).not.toContain("sourceAddress");

    await expect(
      catalog.list({
        ...query,
        after: {
          gatewayId: gatewayA,
          integrationId: parseIntegrationId("home-assistant.beta"),
        },
      }),
    ).resolves.toMatchObject([
      {
        gatewayId: gatewayB,
        integrationId: "home-assistant.gamma",
      },
    ]);
  });

  it("isolates Tenant, Project, and optional Gateway scopes", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    const catalog: IntegrationProjectionCatalog = repository;
    await persistProjection(repository, gatewayA, "home-assistant.alpha", 1);
    await persistProjection(repository, gatewayB, "home-assistant.beta", 1);

    await expect(
      catalog.list({
        tenantId,
        projectId,
        gatewayId: gatewayB,
        limit: 10,
      }),
    ).resolves.toMatchObject([
      {
        gatewayId: gatewayB,
        integrationId: "home-assistant.beta",
      },
    ]);
    await expect(
      catalog.list({
        tenantId: parseTenantId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        projectId,
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      catalog.list({
        tenantId,
        projectId: parseProjectId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });
});
