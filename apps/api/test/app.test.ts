import { afterEach, describe, expect, it } from "vitest";

import {
  ClaimGatewayEnrollment,
  GetFleetGateway,
  GetGatewayEnrollment,
  IssueGatewayEnrollment,
  ListFleetGateways,
  RegisterGateway,
  SearchAuditEvents,
} from "@aether-cloud/application";
import {
  InMemoryEnrollmentTokenService,
  InMemoryGatewayIdentityRepository,
} from "@aether-cloud/fleet-memory-adapter";
import { parseUtcInstant } from "@aether-cloud/domain";
import { createHash } from "node:crypto";
import type {
  AuditEventRepository,
  FleetGatewayView,
  GatewayEnrollmentView,
} from "@aether-cloud/application";

import { buildApp } from "../src/app.js";
import type { FleetHttpDependencies, HttpAuthenticator } from "../src/app.js";

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

  it("allows only the configured console origin to call browser API routes", async () => {
    const app = buildApp({
      version: "0.1.0",
      allowedOrigins: ["https://cloud.aetheriot.dev"],
    });
    apps.push(app);

    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/audit/events",
      headers: {
        origin: "https://cloud.aetheriot.dev",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,idempotency-key",
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
      "https://cloud.aetheriot.dev",
    );
    expect(allowed.headers["access-control-allow-headers"]).toContain(
      "idempotency-key",
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

  it("lists real Fleet projections using only authenticated scope", async () => {
    let observedContext: unknown;
    let observedInput: unknown;
    const fleet: FleetHttpDependencies = {
      authenticator: {
        authenticate: () =>
          Promise.resolve({
            ok: true,
            value: {
              tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              subjectId: "operator-1",
              permissions: ["fleet.gateway.read"],
            },
          }),
      },
      list: {
        execute: (context, input) => {
          observedContext = context;
          observedInput = input;
          return Promise.resolve({
            ok: true,
            value: {
              items: [
                {
                  gatewayId:
                    "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as FleetGatewayView["gatewayId"],
                  displayName: "Warehouse gateway",
                  enrollmentState: "registered",
                  revision: 1,
                  registeredAt:
                    "2026-07-29T12:00:00.000Z" as FleetGatewayView["registeredAt"],
                  connection: {
                    status: "never-connected",
                    reason: "no-session",
                  },
                  telemetry: { status: "no-data", recordCount: "0" },
                },
              ],
              nextCursor: null,
            },
          });
        },
      },
      get: {
        execute: () =>
          Promise.resolve({
            ok: false,
            failure: {
              code: "gateway-not-found",
              message: "gateway was not found",
            },
          }),
      },
      register: {
        execute: () =>
          Promise.resolve({
            ok: false,
            failure: { code: "invalid-input", message: "not used" },
          }),
      },
    };
    const app = buildApp({ version: "0.1.0", fleet });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/fleet/gateways?limit=25",
      headers: { authorization: "Bearer token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{ displayName: "Warehouse gateway" }],
      nextCursor: null,
    });
    expect(observedContext).toMatchObject({
      tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(observedInput).toEqual({ limit: 25 });
  });

  it("registers a Gateway through the governed application command", async () => {
    let observedContext: unknown;
    let observedInput: unknown;
    const authenticator: HttpAuthenticator = {
      authenticate: () =>
        Promise.resolve({
          ok: true,
          value: {
            tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            subjectId: "operator-1",
            permissions: ["fleet.gateway.create"],
          },
        }),
    };
    const app = buildApp({
      version: "0.1.0",
      fleet: {
        authenticator,
        list: {
          execute: () =>
            Promise.resolve({
              ok: true,
              value: { items: [], nextCursor: null },
            }),
        },
        get: {
          execute: () =>
            Promise.resolve({
              ok: false,
              failure: {
                code: "gateway-not-found",
                message: "gateway was not found",
              },
            }),
        },
        register: {
          execute: (context, input) => {
            observedContext = context;
            observedInput = input;
            return Promise.resolve({
              ok: true,
              replayed: false,
              value: {
                tenantId:
                  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as GatewayEnrollmentView["tenantId"],
                projectId:
                  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as GatewayEnrollmentView["projectId"],
                gatewayId:
                  "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as GatewayEnrollmentView["gatewayId"],
                displayName: "Warehouse gateway",
                state: "registered",
                revision: 1,
              },
            });
          },
        },
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/fleet/gateways",
      headers: {
        authorization: "Bearer token",
        "idempotency-key": "register-request-001",
      },
      payload: {
        gatewayId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        displayName: "Warehouse gateway",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      gatewayId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      state: "registered",
    });
    expect(observedContext).toMatchObject({
      subjectKind: "user",
      idempotencyKey: "register-request-001",
      permissions: ["fleet.gateway.create"],
    });
    expect(observedInput).toEqual({
      gatewayId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      displayName: "Warehouse gateway",
    });
  });

  it("issues and consumes the strict AetherEdge Enrollment Claim contract", async () => {
    const repository = new InMemoryGatewayIdentityRepository();
    const tokens = new InMemoryEnrollmentTokenService({
      tokenFactory: () => "edge-enrollment-token-with-entropy-123456",
      claimIdFactory: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    const clock = { now: () => parseUtcInstant(new Date().toISOString()) };
    const authenticator: HttpAuthenticator = {
      authenticate: () =>
        Promise.resolve({
          ok: true,
          value: {
            tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            subjectId: "operator-1",
            permissions: [
              "fleet.gateway.create",
              "fleet.gateway.enrollment.issue",
              "fleet.gateway.enrollment.read",
            ],
          },
        }),
    };
    const app = buildApp({
      version: "0.1.0",
      fleet: {
        authenticator,
        list: new ListFleetGateways({ repository, clock }),
        get: new GetFleetGateway({ repository, clock }),
        register: new RegisterGateway({ repository, clock }),
        issueEnrollment: new IssueGatewayEnrollment({
          repository,
          tokens,
          clock,
        }),
        claimEnrollment: new ClaimGatewayEnrollment({
          repository,
          tokens,
          clock,
        }),
        getEnrollment: new GetGatewayEnrollment({ repository }),
        claimRateLimiter: { allow: () => true },
      },
    });
    apps.push(app);

    const gatewayId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const registration = await app.inject({
      method: "POST",
      url: "/api/v1/fleet/gateways",
      headers: {
        authorization: "Bearer token",
        "idempotency-key": "register-request-001",
      },
      payload: { gatewayId, displayName: "Warehouse gateway" },
    });
    const issuance = await app.inject({
      method: "POST",
      url: `/api/v1/fleet/gateways/${gatewayId}/enrollment-claims`,
      headers: {
        authorization: "Bearer token",
        "idempotency-key": "issue-request-001",
        "x-aethercloud-confirmation": "issue-enrollment-claim",
      },
      payload: {},
    });
    const publicKeyBytes = Buffer.alloc(32, 7);
    const publicKey = publicKeyBytes.toString("base64url");
    const fingerprint = createHash("sha256")
      .update(publicKeyBytes)
      .digest("hex");
    const claim = await app.inject({
      method: "POST",
      url: "/api/v1/fleet/enrollment-claims:claim",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "de57d6aa-c9b6-5b4f-8da2-771b0cf11c6c",
      },
      payload: {
        schema: "aether.cloud.gateway-enrollment-claim.v1",
        tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        gatewayId,
        enrollmentToken: "edge-enrollment-token-with-entropy-123456",
        credentialRequest: {
          algorithm: "ed25519",
          publicKey,
          fingerprint,
        },
      },
    });
    const status = await app.inject({
      method: "GET",
      url: `/api/v1/fleet/gateways/${gatewayId}/enrollment`,
      headers: { authorization: "Bearer token" },
    });

    expect(registration.statusCode).toBe(200);
    expect(issuance.statusCode).toBe(200);
    expect(issuance.json()).toMatchObject({
      schema: "aether.cloud.gateway-enrollment-issued.v1",
      gatewayId,
      state: "awaiting-claim",
      revision: 2,
      enrollmentToken: "edge-enrollment-token-with-entropy-123456",
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.headers["content-type"]).toContain("application/json");
    expect(claim.json()).toEqual({
      schema: "aether.cloud.gateway-enrollment-claimed.v1",
      gatewayId,
      state: "claimed",
      revision: 3,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      gatewayId,
      state: "claimed",
      revision: 3,
    });
  });

  it("rejects malformed AetherEdge public-key evidence and limits Claim abuse", async () => {
    let allowed = true;
    const app = buildApp({
      version: "0.1.0",
      fleet: {
        authenticator: {
          authenticate: () =>
            Promise.resolve({
              ok: false,
              failure: { code: "unauthenticated" },
            }),
        },
        list: { execute: () => Promise.reject(new Error("not used")) },
        get: { execute: () => Promise.reject(new Error("not used")) },
        register: { execute: () => Promise.reject(new Error("not used")) },
        claimEnrollment: {
          execute: () => Promise.reject(new Error("must not be called")),
        },
        claimRateLimiter: { allow: () => allowed },
      },
    });
    apps.push(app);
    const payload = {
      schema: "aether.cloud.gateway-enrollment-claim.v1",
      tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      gatewayId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      enrollmentToken: "edge-enrollment-token-with-entropy-123456",
      credentialRequest: {
        algorithm: "ed25519",
        publicKey: Buffer.alloc(32, 7).toString("base64url"),
        fingerprint: "0".repeat(64),
      },
    };

    const malformed = await app.inject({
      method: "POST",
      url: "/api/v1/fleet/enrollment-claims:claim",
      headers: { "idempotency-key": "claim-request-001" },
      payload,
    });
    const unknownField = await app.inject({
      method: "POST",
      url: "/api/v1/fleet/enrollment-claims:claim",
      headers: { "idempotency-key": "claim-request-001" },
      payload: { ...payload, unexpected: true },
    });
    allowed = false;
    const limited = await app.inject({
      method: "POST",
      url: "/api/v1/fleet/enrollment-claims:claim",
      headers: { "idempotency-key": "claim-request-001" },
      payload,
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      error: { code: "invalid-input" },
    });
    expect(unknownField.statusCode).toBe(400);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: "rate-limited" } });
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
