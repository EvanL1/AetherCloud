import { afterEach, describe, expect, it } from "vitest";

import {
  defineIntegrationObservationBatch,
  defineIntegrationTopologySnapshot,
  parseGatewayId,
  parseIntegrationId,
  parseIntegrationKind,
  parseIntegrationSnapshotGeneration,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";
import { Buffer } from "node:buffer";
import type {
  IntegrationProjectionCatalogResult,
  IntegrationProjectionCatalogView,
  IntegrationProjectionQueryResult,
  IntegrationProjectionView,
} from "@aether-cloud/application";

import { buildApp } from "../src/app.js";
import type { HttpAuthenticator } from "../src/app.js";
import type { IntegrationHttpDependencies } from "../src/integration-routes.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const integrationId = parseIntegrationId("home-assistant-1");

const subject = {
  tenantId,
  projectId,
  subjectId: "user:operator",
  permissions: ["integration.projection.read"],
} as const;

const authenticator: HttpAuthenticator = {
  authenticate: (input) =>
    Promise.resolve(
      input.authorization === "Bearer valid"
        ? ({ ok: true, value: subject } as const)
        : ({ ok: false, failure: { code: "unauthenticated" } } as const),
    ),
};

const nextCursor = Buffer.from(
  JSON.stringify({
    gatewayFilter: null,
    gatewayId,
    integrationId,
    version: 1,
  }),
  "utf8",
).toString("base64url");

const catalogView: IntegrationProjectionCatalogView = {
  authority: "edge-reported-copy",
  liveStateAuthoritative: false,
  items: [
    {
      gatewayId,
      integrationId,
      integrationKind: parseIntegrationKind("home-assistant"),
      snapshotGeneration: parseIntegrationSnapshotGeneration("7"),
      entityCount: 2,
      latestObservationCount: 2,
      receivedAt: parseUtcInstant("2026-07-31T00:00:00.000Z"),
      revision: 3,
    },
  ],
  nextCursor,
};

const topology = defineIntegrationTopologySnapshot({
  schema: "aether.integration.topology-snapshot.v1alpha1",
  integrationId,
  integrationKind: "home-assistant",
  snapshotGeneration: "7",
  observedAtMs: "1785000000000",
  areas: [{ areaId: "kitchen", name: "Kitchen" }],
  devices: [
    {
      deviceId: "device-1",
      name: "Kettle",
      areaId: "kitchen",
      manufacturer: "Acme",
      model: "K-1",
      softwareVersion: "1.2.3",
      hardwareVersion: "rev-b",
    },
  ],
  entities: [
    {
      entityId: "switch.kettle",
      sourceAddress: "switch.kettle",
      name: "Kettle",
      entityKind: "switch",
      deviceId: "device-1",
      areaId: "kitchen",
      points: [
        {
          pointKey: "state",
          title: "State",
          kind: "status",
          valueType: "boolean",
        },
        {
          pointKey: "power",
          title: "Power",
          kind: "telemetry",
          valueType: "float64",
          unit: "W",
        },
        {
          pointKey: "raw",
          title: "Raw frame",
          kind: "event",
          valueType: "bytes",
        },
        {
          pointKey: "status_text",
          title: "Status text",
          kind: "status",
          valueType: "string",
        },
      ],
    },
  ],
});

const latestObservations = defineIntegrationObservationBatch(
  {
    schema: "aether.integration.observation-batch.v1alpha1",
    integrationId,
    snapshotGeneration: "7",
    batchId: "batch-1",
    observedAtMs: "1785000000000",
    observations: [
      {
        entityId: "switch.kettle",
        pointKey: "state",
        observedAtMs: "1785000000000",
        quality: "good",
        value: { type: "boolean", value: true },
      },
      {
        entityId: "switch.kettle",
        pointKey: "power",
        observedAtMs: "1785000000001",
        quality: "good",
        value: { type: "float64", value: 1834.5 },
      },
      {
        entityId: "switch.kettle",
        pointKey: "raw",
        observedAtMs: "1785000000002",
        quality: "good",
        value: { type: "bytes", encoding: "base64url", value: "AQID" },
      },
      {
        entityId: "switch.kettle",
        pointKey: "status_text",
        observedAtMs: "1785000000003",
        quality: "unavailable",
        diagnostic: "integration reported no state",
      },
    ],
  },
  topology,
).observations;

const detailView: IntegrationProjectionView = {
  authority: "edge-reported-copy",
  liveStateAuthoritative: false,
  tenantId,
  projectId,
  gatewayId,
  integrationId,
  topology,
  topologyDigest:
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  latestObservations,
  receivedAt: parseUtcInstant("2026-07-31T00:00:00.000Z"),
  revision: 3,
};

interface RecordedCall {
  readonly context: unknown;
  readonly input: unknown;
}

function recordingList(result: IntegrationProjectionCatalogResult): Readonly<{
  calls: readonly RecordedCall[];
  stub: IntegrationHttpDependencies["list"];
}> {
  const calls: RecordedCall[] = [];
  return {
    calls,
    stub: {
      execute: (context: unknown, input: unknown) => {
        calls.push({ context, input });
        return Promise.resolve(result);
      },
    },
  };
}

function recordingGet(
  result: IntegrationProjectionQueryResult<IntegrationProjectionView>,
): Readonly<{
  calls: readonly RecordedCall[];
  stub: IntegrationHttpDependencies["get"];
}> {
  const calls: RecordedCall[] = [];
  return {
    calls,
    stub: {
      execute: (context: unknown, input: unknown) => {
        calls.push({ context, input });
        return Promise.resolve(result);
      },
    },
  };
}

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function appWithIntegrations(
  overrides: Partial<Pick<IntegrationHttpDependencies, "get" | "list">> = {},
): ReturnType<typeof buildApp> {
  const app = buildApp({
    version: "0.1.0",
    integrations: {
      authenticator,
      list:
        overrides.list ?? recordingList({ ok: true, value: catalogView }).stub,
      get:
        overrides.get ??
        recordingGet({
          ok: false,
          failure: {
            code: "integration-projection-not-found",
            message: "integration projection was not found",
          },
        }).stub,
    },
  });
  apps.push(app);
  return app;
}

describe("GET /api/v1/integrations", () => {
  it("rejects an unauthenticated request", async () => {
    const list = recordingList({ ok: true, value: catalogView });
    const app = appWithIntegrations({ list: list.stub });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "unauthenticated" },
    });
    expect(list.calls).toHaveLength(0);
  });

  it("returns the catalog with its edge-reported authority intact", async () => {
    const app = appWithIntegrations();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations",
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toMatchObject({
      authority: "edge-reported-copy",
      liveStateAuthoritative: false,
    });
    expect(body).toEqual({
      authority: "edge-reported-copy",
      liveStateAuthoritative: false,
      items: [
        {
          gatewayId,
          integrationId,
          integrationKind: "home-assistant",
          snapshotGeneration: "7",
          entityCount: 2,
          latestObservationCount: 2,
          receivedAt: "2026-07-31T00:00:00.000Z",
          revision: 3,
        },
      ],
      nextCursor,
    });
  });

  it("rejects an unsupported query field", async () => {
    const list = recordingList({ ok: true, value: catalogView });
    const app = appWithIntegrations({ list: list.stub });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations?unexpected=1",
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "invalid-input" } });
    expect(list.calls).toHaveLength(0);
  });

  it("rejects a limit outside the supported range", async () => {
    const list = recordingList({ ok: true, value: catalogView });
    const app = appWithIntegrations({ list: list.stub });

    const responses = await Promise.all(
      ["0", "101", "-1", "5.5"].map(async (limit) =>
        app.inject({
          method: "GET",
          url: `/api/v1/integrations?limit=${limit}`,
          headers: { authorization: "Bearer valid" },
        }),
      ),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([
      400, 400, 400, 400,
    ]);
    expect(list.calls).toHaveLength(0);
  });

  it("translates permission-denied to 403", async () => {
    const app = appWithIntegrations({
      list: recordingList({
        ok: false,
        failure: {
          code: "permission-denied",
          message: "permission integration.projection.read is required",
        },
      }).stub,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations",
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "permission-denied" },
    });
  });

  it("translates an undecodable stored projection to 503, not 400", async () => {
    // The application returns this when a stored row fails to decode: schema
    // drift, or a bad ingress write. 400 would tell the console the operator's
    // request was wrong and stop it retrying; 503 says the platform is at
    // fault. Deleting the clause from catalogFailureStatus makes this fail.
    const app = appWithIntegrations({
      list: recordingList({
        ok: false,
        failure: {
          code: "invalid-integration-repository-result",
          message: "integration projection catalog returned invalid data",
        },
      }).stub,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations",
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "invalid-integration-repository-result" },
    });
  });

  it("translates a catalog input rejection from the application to 400", async () => {
    // The route rejects unknown query fields itself, so this default branch is
    // otherwise only reachable when the application decodes the input more
    // strictly than the route does.
    const app = appWithIntegrations({
      list: recordingList({
        ok: false,
        failure: { code: "invalid-input", message: "cursor is not canonical" },
      }).stub,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations",
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("translates storage unavailability to 503", async () => {
    const app = appWithIntegrations({
      list: recordingList({
        ok: false,
        failure: {
          code: "integration-storage-unavailable",
          message: "integration projection catalog is unavailable",
        },
      }).stub,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations",
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "integration-storage-unavailable" },
    });
  });

  it("forwards exactly the authenticated tenant and project scope", async () => {
    const list = recordingList({ ok: true, value: catalogView });
    const app = appWithIntegrations({ list: list.stub });

    await app.inject({
      method: "GET",
      url: "/api/v1/integrations",
      headers: { authorization: "Bearer valid" },
    });

    expect(list.calls).toHaveLength(1);
    expect(list.calls[0]?.context).toEqual({
      tenantId,
      projectId,
      subjectId: "user:operator",
      permissions: ["integration.projection.read"],
    });
    expect(list.calls[0]?.input).toEqual({ limit: 50 });
  });

  it("round-trips an opaque cursor through the query and the response", async () => {
    const list = recordingList({ ok: true, value: catalogView });
    const app = appWithIntegrations({ list: list.stub });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/integrations?limit=25&cursor=${nextCursor}&gatewayId=${gatewayId}`,
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(200);
    expect(list.calls[0]?.input).toEqual({
      limit: 25,
      cursor: nextCursor,
      gatewayId,
    });
    expect(response.json()).toMatchObject({ nextCursor });
  });
});

describe("GET /api/v1/integrations/:gatewayId/:integrationId", () => {
  it("rejects an unauthenticated request", async () => {
    const get = recordingGet({ ok: true, value: detailView });
    const app = appWithIntegrations({ get: get.stub });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/${gatewayId}/${integrationId}`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "unauthenticated" },
    });
    expect(get.calls).toHaveLength(0);
  });

  it("reaches the handler for the longest Integration id the domain allows", async () => {
    // Fastify's default maxParamLength is 100 while the domain allows 128. A
    // longer id was rejected by the router with a 414 whose error was a string
    // rather than the documented object, and with no correlation header, so
    // the catalog could list a projection the detail route could never return.
    const longest = parseIntegrationId(`h${"x".repeat(127)}`);
    const app = appWithIntegrations();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/${gatewayId}/${longest}`,
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["x-correlation-id"]).toBeDefined();
    expect(response.json()).toMatchObject({
      error: { code: "integration-projection-not-found" },
    });
  });

  it("translates a missing projection to 404", async () => {
    const app = appWithIntegrations();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/${gatewayId}/${integrationId}`,
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "integration-projection-not-found" },
    });
  });

  it("returns the detail view with its authority labels and reported data", async () => {
    const get = recordingGet({ ok: true, value: detailView });
    const app = appWithIntegrations({ get: get.stub });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/${gatewayId}/${integrationId}`,
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toMatchObject({
      authority: "edge-reported-copy",
      liveStateAuthoritative: false,
    });
    expect(body).toEqual({
      authority: "edge-reported-copy",
      liveStateAuthoritative: false,
      tenantId,
      projectId,
      gatewayId,
      integrationId,
      topology,
      topologyDigest:
        "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      latestObservations,
      receivedAt: "2026-07-31T00:00:00.000Z",
      revision: 3,
    });
  });

  it("forwards exactly the authenticated scope and the addressed projection", async () => {
    const get = recordingGet({ ok: true, value: detailView });
    const app = appWithIntegrations({ get: get.stub });

    await app.inject({
      method: "GET",
      url: `/api/v1/integrations/${gatewayId}/${integrationId}`,
      headers: { authorization: "Bearer valid" },
    });

    expect(get.calls).toHaveLength(1);
    expect(get.calls[0]?.context).toEqual({
      tenantId,
      projectId,
      subjectId: "user:operator",
      permissions: ["integration.projection.read"],
    });
    expect(get.calls[0]?.input).toEqual({ gatewayId, integrationId });
  });

  it("translates an undecodable stored projection detail to 503, not 400", async () => {
    // Same reasoning as the catalog case: a row that fails to decode is the
    // platform's fault, and the console should retry rather than treat it as a
    // bad request. Deleting the clause from projectionFailureStatus fails this.
    const app = appWithIntegrations({
      get: recordingGet({
        ok: false,
        failure: {
          code: "invalid-integration-repository-result",
          message: "integration projection returned invalid data",
        },
      }).stub,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/${gatewayId}/${integrationId}`,
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "invalid-integration-repository-result" },
    });
  });

  it("translates a detail storage failure to 503", async () => {
    const app = appWithIntegrations({
      get: recordingGet({
        ok: false,
        failure: {
          code: "integration-storage-unavailable",
          message: "integration projection persistence is unavailable",
        },
      }).stub,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/${gatewayId}/${integrationId}`,
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(503);
  });

  it("translates a detail permission failure to 403", async () => {
    const app = appWithIntegrations({
      get: recordingGet({
        ok: false,
        failure: {
          code: "permission-denied",
          message: "permission integration.projection.read is required",
        },
      }).stub,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/${gatewayId}/${integrationId}`,
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("translates an invalid detail request to 400", async () => {
    const app = appWithIntegrations({
      get: recordingGet({
        ok: false,
        failure: {
          code: "invalid-input",
          message: "gatewayId must be a canonical lowercase UUID",
        },
      }).stub,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/not-a-uuid/home-assistant-1",
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(400);
  });
});
