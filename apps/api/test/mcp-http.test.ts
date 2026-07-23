import { afterEach, describe, expect, it } from "vitest";

import type {
  McpInterfaceResult,
  McpReadResourceResult,
  McpToolCallResult,
} from "@aether-cloud/mcp-interface";

import { buildApp } from "../src/app.js";
import type { HttpAuthenticator, McpHttpInterface } from "../src/app.js";

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

const subjectFixture = {
  tenantId: "tenant-a",
  projectId: "project-a",
  subjectId: "operator-1",
  permissions: ["audit.read"],
} as const;

const allowAll: HttpAuthenticator = {
  authenticate: () => Promise.resolve({ ok: true, value: subjectFixture }),
};

const denyAll: HttpAuthenticator = {
  authenticate: () =>
    Promise.resolve({ ok: false, failure: { code: "unauthenticated" } }),
};

function stubInterface(
  overrides: Partial<McpHttpInterface> = {},
): McpHttpInterface {
  return {
    listTools: () => [
      {
        name: "audit.search",
        description: "Search audit events",
        permission: "audit.read",
        risk: "low",
        confirmation: "not-required",
        idempotency: "required",
        expiry: "required",
        audit: "required",
        status: "partial",
        inputSchema: { type: "object" },
      },
    ],
    listResources: () => [
      {
        name: "capabilities",
        description: "Capability exposure",
        mimeType: "application/json",
        uri: "aethercloud://capabilities",
      },
      {
        name: "integration-projection",
        description: "One projection by id",
        mimeType: "application/json",
        uriTemplate: "aethercloud://integration-projections/{integration_id}",
      },
    ],
    callTool: (): Promise<McpInterfaceResult<McpToolCallResult>> =>
      Promise.resolve({
        ok: true,
        value: {
          content: [{ type: "text", text: "accepted" }],
          structuredContent: { requestId: "r-1" },
          replayed: false,
        },
      }),
    readResource: (): Promise<McpInterfaceResult<McpReadResourceResult>> =>
      Promise.resolve({
        ok: true,
        value: {
          contents: [
            {
              uri: "aethercloud://capabilities",
              mimeType: "application/json",
              text: "{}",
            },
          ],
        },
      }),
    ...overrides,
  };
}

function appWith(
  mcpInterface: McpHttpInterface,
  authenticator: HttpAuthenticator = allowAll,
) {
  const app = buildApp({
    version: "0.1.0",
    mcp: { interface: mcpInterface, authenticator },
  });
  apps.push(app);
  return app;
}

async function rpc(app: ReturnType<typeof buildApp>, body: unknown) {
  return app.inject({
    method: "POST",
    url: "/api/v1/mcp",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

describe("MCP streamable HTTP endpoint", () => {
  it("is absent when the dependency group is not provided", async () => {
    const app = buildApp({ version: "0.1.0" });
    apps.push(app);
    const response = await rpc(app, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(response.statusCode).toBe(404);
  });

  it("rejects unauthenticated requests with 401 before any dispatch", async () => {
    let called = false;
    const app = appWith(
      stubInterface({
        callTool: () => {
          called = true;
          return Promise.resolve({
            ok: false,
            failure: { code: "invalid-input", message: "x" },
          });
        },
      }),
      denyAll,
    );
    const response = await rpc(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "audit.search", arguments: {} },
    });
    expect(response.statusCode).toBe(401);
    expect(called).toBe(false);
    expect(response.json()).toMatchObject({
      error: { code: "unauthenticated" },
    });
  });

  it("negotiates initialize with tools and resources capabilities", async () => {
    const app = appWith(stubInterface());
    const response = await rpc(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "aether-cloud-api", version: "0.1.0" },
      },
    });
    expect(response.headers["mcp-session-id"]).toBeUndefined();
  });

  it("falls back to the newest supported protocol version", async () => {
    const app = appWith(stubInterface());
    const response = await rpc(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(response.json()).toMatchObject({
      result: { protocolVersion: "2025-06-18" },
    });
  });

  it("accepts the initialized notification with 202 and no body", async () => {
    const app = appWith(stubInterface());
    const response = await rpc(app, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response.statusCode).toBe(202);
    expect(response.body).toBe("");
  });

  it("answers ping with an empty result", async () => {
    const app = appWith(stubInterface());
    const response = await rpc(app, { jsonrpc: "2.0", id: 7, method: "ping" });
    expect(response.json()).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("lists tools with name, description, and input schema only", async () => {
    const app = appWith(stubInterface());
    const response = await rpc(app, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(response.json()).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          {
            name: "audit.search",
            description: "Search audit events",
            inputSchema: { type: "object" },
          },
        ],
      },
    });
  });

  it("splits static resources from templated ones", async () => {
    const app = appWith(stubInterface());
    const listed = await rpc(app, {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/list",
    });
    expect(listed.json()).toMatchObject({
      result: {
        resources: [
          {
            name: "capabilities",
            description: "Capability exposure",
            mimeType: "application/json",
            uri: "aethercloud://capabilities",
          },
        ],
      },
    });
    const templates = await rpc(app, {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/templates/list",
    });
    expect(templates.json()).toMatchObject({
      result: {
        resourceTemplates: [
          {
            name: "integration-projection",
            description: "One projection by id",
            mimeType: "application/json",
            uriTemplate:
              "aethercloud://integration-projections/{integration_id}",
          },
        ],
      },
    });
  });

  it("passes the authenticated subject and call through to the interface", async () => {
    const seen: unknown[] = [];
    const app = appWith(
      stubInterface({
        callTool: (subject, call) => {
          seen.push(subject, call);
          return Promise.resolve({
            ok: true,
            value: {
              content: [{ type: "text", text: "accepted" }],
              structuredContent: { requestId: "r-1" },
              replayed: true,
            },
          });
        },
      }),
    );
    const response = await rpc(app, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "audit.search", arguments: { limit: 1 } },
    });
    expect(seen).toEqual([
      subjectFixture,
      { name: "audit.search", arguments: { limit: 1 } },
    ]);
    expect(response.json()).toMatchObject({
      result: {
        isError: false,
        structuredContent: { requestId: "r-1" },
        _meta: { "aethercloud/replayed": true },
      },
    });
  });

  it("maps tool failures to in-band isError results", async () => {
    const app = appWith(
      stubInterface({
        callTool: () =>
          Promise.resolve({
            ok: false,
            failure: { code: "invalid-input", message: "bad envelope" },
          }),
      }),
    );
    const response = await rpc(app, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "audit.search", arguments: {} },
    });
    expect(response.json()).toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text", text: "invalid-input: bad envelope" }],
      },
    });
  });

  it("reads resources and maps failures to invalid params", async () => {
    const app = appWith(
      stubInterface({
        readResource: (_subject, request) => {
          const uri = (request as Readonly<{ uri: string }>).uri;
          if (uri === "aethercloud://capabilities") {
            return Promise.resolve({
              ok: true,
              value: {
                contents: [
                  {
                    uri,
                    mimeType: "application/json",
                    text: "{}",
                  },
                ],
              },
            });
          }
          return Promise.resolve({
            ok: false,
            failure: { code: "invalid-input", message: "unknown resource" },
          });
        },
      }),
    );
    const ok = await rpc(app, {
      jsonrpc: "2.0",
      id: 8,
      method: "resources/read",
      params: { uri: "aethercloud://capabilities" },
    });
    expect(ok.json()).toMatchObject({
      result: {
        contents: [{ uri: "aethercloud://capabilities" }],
      },
    });

    const bad = await rpc(app, {
      jsonrpc: "2.0",
      id: 9,
      method: "resources/read",
      params: { uri: "aethercloud://nope" },
    });
    expect(bad.json()).toMatchObject({ error: { code: -32602 } });
  });

  it("rejects unknown methods, batches, and non-post transports", async () => {
    const app = appWith(stubInterface());
    const unknown = await rpc(app, {
      jsonrpc: "2.0",
      id: 10,
      method: "prompts/list",
    });
    expect(unknown.json()).toMatchObject({ error: { code: -32601 } });

    const batch = await rpc(app, [{ jsonrpc: "2.0", id: 11, method: "ping" }]);
    expect(batch.json()).toMatchObject({ error: { code: -32600 } });

    const get = await app.inject({ method: "GET", url: "/api/v1/mcp" });
    expect(get.statusCode).toBe(405);
    expect(get.headers.allow).toBe("POST");
  });
});
