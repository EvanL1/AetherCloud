import { afterEach, describe, expect, it } from "vitest";

import { SearchAuditEvents } from "@aether-cloud/application";
import type { AuditEventRepository } from "@aether-cloud/application";

import { buildApp } from "../src/app.js";
import type { HttpAuthenticator } from "../src/app.js";

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("AetherCloud API", () => {
  it("reports process liveness without external services", async () => {
    const app = buildApp({ version: "0.1.0" });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({
      status: "ok",
      service: "aether-cloud-api",
      version: "0.1.0",
    });
  });

  it("does not expose a write operation on the health route", async () => {
    const app = buildApp({ version: "0.1.0" });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/health" });

    expect(response.statusCode).toBe(404);
  });

  it("describes the platform authority boundary for clients and agents", async () => {
    const app = buildApp({ version: "0.1.0" });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/platform",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      name: "AetherCloud",
      role: "ai-native-multi-cloud-iot-control-plane",
      authority: {
        livePointState: "edge",
        physicalControl: "edge",
        tenantIdentity: "aether-cloud",
        desiredRevision: "aether-cloud",
        placementPolicy: "aether-cloud",
        actualInfrastructure: "provider",
      },
      multiCloud: {
        providerModel: "capability-driven-adapters",
        executionEngines: ["opentofu", "terraform"],
        stateIsolation: "deployment-stack",
      },
    });
  });

  it("allows only configured website origins to call browser API routes", async () => {
    const app = buildApp({
      version: "0.1.0",
      allowedOrigins: ["https://aetheriot.dev", "https://www.aetheriot.dev"],
    });
    apps.push(app);

    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/audit/events",
      headers: {
        origin: "https://www.aetheriot.dev",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    const denied = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/audit/events",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });

    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "https://www.aetheriot.dev",
    );
    expect(allowed.headers["access-control-allow-headers"]).toContain(
      "authorization",
    );
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("resolves trusted scope before invoking the Audit application query", async () => {
    let observedScope: unknown;
    let observedQuery: unknown;
    const repository: AuditEventRepository = {
      search: (scope, query) => {
        observedScope = scope;
        observedQuery = query;
        return Promise.resolve({ outcome: "found", events: [] });
      },
    };
    const authenticator: HttpAuthenticator = {
      authenticate: () =>
        Promise.resolve({
          ok: true,
          value: {
            tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            subjectId: "auditor-1",
            permissions: ["audit.event.read"],
          },
        }),
    };
    const app = buildApp({
      version: "0.1.0",
      audit: {
        query: new SearchAuditEvents({ repository }),
        authenticator,
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/audit/events?limit=25&action=edge.job.create",
      headers: { authorization: "Bearer opaque-test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).toBeTypeOf("string");
    expect(response.json()).toEqual({ items: [], nextCursor: null });
    expect(observedScope).toMatchObject({
      tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(observedQuery).toMatchObject({
      action: "edge.job.create",
      limit: 25,
    });
  });

  it("does not accept Tenant scope from Audit query parameters", async () => {
    let searched = false;
    const app = buildApp({
      version: "0.1.0",
      audit: {
        query: new SearchAuditEvents({
          repository: {
            search: () => {
              searched = true;
              return Promise.resolve({ outcome: "found", events: [] });
            },
          },
        }),
        authenticator: {
          authenticate: () =>
            Promise.resolve({
              ok: true,
              value: {
                tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                subjectId: "auditor-1",
                permissions: ["audit.event.read"],
              },
            }),
        },
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/audit/events?limit=10&tenantId=cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid-input" },
    });
    expect(searched).toBe(false);
  });

  it("maps authentication and application authorization failures", async () => {
    const repository: AuditEventRepository = {
      search: () => Promise.resolve({ outcome: "found", events: [] }),
    };
    const unauthenticated = buildApp({
      version: "0.1.0",
      audit: {
        query: new SearchAuditEvents({ repository }),
        authenticator: {
          authenticate: () =>
            Promise.resolve({
              ok: false,
              failure: { code: "unauthenticated" },
            }),
        },
      },
    });
    const forbidden = buildApp({
      version: "0.1.0",
      audit: {
        query: new SearchAuditEvents({ repository }),
        authenticator: {
          authenticate: () =>
            Promise.resolve({
              ok: true,
              value: {
                tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                subjectId: "auditor-1",
                permissions: [],
              },
            }),
        },
      },
    });
    apps.push(unauthenticated, forbidden);

    const unauthenticatedResponse = await unauthenticated.inject({
      method: "GET",
      url: "/api/v1/audit/events?limit=10",
    });
    const forbiddenResponse = await forbidden.inject({
      method: "GET",
      url: "/api/v1/audit/events?limit=10",
    });

    expect(unauthenticatedResponse.statusCode).toBe(401);
    expect(unauthenticatedResponse.json()).toMatchObject({
      error: { code: "unauthenticated" },
    });
    expect(forbiddenResponse.statusCode).toBe(403);
    expect(forbiddenResponse.json()).toMatchObject({
      error: { code: "permission-denied" },
    });
  });

  it("maps typed Audit storage failure to service unavailable", async () => {
    const app = buildApp({
      version: "0.1.0",
      audit: {
        query: new SearchAuditEvents({
          repository: {
            search: () => Promise.resolve({ outcome: "storage-unavailable" }),
          },
        }),
        authenticator: {
          authenticate: () =>
            Promise.resolve({
              ok: true,
              value: {
                tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                subjectId: "auditor-1",
                permissions: ["audit.event.read"],
              },
            }),
        },
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/audit/events?limit=10",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "storage-unavailable" },
    });
  });

  it("offers a resumable finite SSE Audit feed through the same query", async () => {
    let observedQuery: unknown;
    const app = buildApp({
      version: "0.1.0",
      audit: {
        query: new SearchAuditEvents({
          repository: {
            search: (_scope, query) => {
              observedQuery = query;
              return Promise.resolve({ outcome: "found", events: [] });
            },
          },
        }),
        authenticator: {
          authenticate: () =>
            Promise.resolve({
              ok: true,
              value: {
                tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                subjectId: "auditor-1",
                permissions: ["audit.event.read"],
              },
            }),
        },
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/audit/events/stream?limit=10",
      headers: { "last-event-id": "7" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain(": snapshot-complete");
    expect(observedQuery).toMatchObject({ cursor: "7", limit: 10 });
  });
});
