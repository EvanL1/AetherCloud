import { describe, expect, it, vi } from "vitest";

import {
  AetherCloudMcpInterface,
  type McpAuthenticatedSubject,
} from "../src/index.js";

const subject: McpAuthenticatedSubject = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  subjectId: "agent-service-account-1",
  permissions: ["audit.event.read", "data.export.create", "edge.job.create"],
};

type ApplicationResult =
  | Readonly<{ ok: true; value: unknown; replayed?: boolean }>
  | Readonly<{
      ok: false;
      failure: Readonly<{ code: string; message: string }>;
    }>;
type ApplicationExecutor = (
  context: unknown,
  input: unknown,
) => Promise<ApplicationResult>;
type ApplicationMock = ReturnType<typeof vi.fn<ApplicationExecutor>>;

function build(overrides: {
  auditSearch?: ApplicationMock;
  createJob?: ApplicationMock;
  requestExport?: ApplicationMock;
}) {
  const auditSearch = overrides.auditSearch ?? vi.fn<ApplicationExecutor>();
  const createJob = overrides.createJob ?? vi.fn<ApplicationExecutor>();
  const requestExport = overrides.requestExport ?? vi.fn<ApplicationExecutor>();
  return {
    auditSearch,
    createJob,
    requestExport,
    mcp: new AetherCloudMcpInterface({
      searchAuditEvents: { execute: auditSearch },
      createGovernedJob: { execute: createJob },
      requestDataExport: { execute: requestExport },
    }),
  };
}

describe("AetherCloud MCP application interface", () => {
  it("publishes only executable tools with complete governance metadata", () => {
    const { mcp } = build({});

    expect(mcp.listTools()).toEqual([
      expect.objectContaining({
        name: "data.export.request",
        permission: "data.export.create",
        risk: "high",
        confirmation: "explicit",
        idempotency: "required",
        expiry: "required",
        audit: "required",
        status: "partial",
      }),
      expect.objectContaining({
        name: "edge.job.create",
        permission: "edge.job.create",
        risk: "medium",
        confirmation: "not-required",
        status: "partial",
      }),
    ]);
    expect(mcp.listResources()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: "aethercloud://capabilities" }),
        expect.objectContaining({
          uriTemplate: "aethercloud://audit/events{?cursor,limit}",
        }),
      ]),
    );
  });

  it("reads Tenant audit evidence only through the application query", async () => {
    const auditSearch = vi.fn<ApplicationExecutor>().mockResolvedValue({
      ok: true,
      value: { items: [], nextCursor: null },
    });
    const { mcp } = build({ auditSearch });

    const result = await mcp.readResource(subject, {
      uri: "aethercloud://audit/events?cursor=7&limit=10",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.contents).toHaveLength(1);
    expect(result.value.contents[0]?.uri).toBe(
      "aethercloud://audit/events?cursor=7&limit=10",
    );
    expect(result.value.contents[0]?.mimeType).toBe("application/json");
    expect(auditSearch).toHaveBeenCalledExactlyOnceWith(subject, {
      cursor: "7",
      limit: 10,
    });
  });

  it("injects authenticated scope and delegates command governance to the same use case", async () => {
    const requestExport = vi.fn<ApplicationExecutor>().mockResolvedValue({
      ok: false,
      failure: {
        code: "confirmation-required",
        message: "Data Export requires explicit confirmation",
      },
    });
    const { mcp } = build({ requestExport });
    const input = {
      exportId: "export-request-0001",
      kind: "audit-events",
      format: "ndjson",
      filterDigest: "a".repeat(64),
      exportExpiresAt: "2026-07-20T00:00:00.000Z",
    };

    const result = await mcp.callTool(subject, {
      name: "data.export.request",
      arguments: {
        confirmation: "not-confirmed",
        idempotencyKey: "mcp-export-request-0001",
        issuedAt: "2026-07-15T00:00:00.000Z",
        expiresAt: "2026-07-15T00:10:00.000Z",
        input,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "confirmation-required" },
    });
    expect(requestExport).toHaveBeenCalledExactlyOnceWith(
      {
        ...subject,
        confirmation: "not-confirmed",
        idempotencyKey: "mcp-export-request-0001",
        issuedAt: "2026-07-15T00:00:00.000Z",
        expiresAt: "2026-07-15T00:10:00.000Z",
      },
      input,
    );
  });

  it("rejects planned or unknown tools without invoking an application command", async () => {
    const createJob = vi.fn<ApplicationExecutor>();
    const requestExport = vi.fn<ApplicationExecutor>();
    const { mcp } = build({ createJob, requestExport });

    const result = await mcp.callTool(subject, {
      name: "integration.webhook.subscription.create",
      arguments: {},
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        code: "mcp-tool-not-implemented",
        message:
          "integration.webhook.subscription.create is not exposed as an MCP tool",
      },
    });
    expect(createJob).not.toHaveBeenCalled();
    expect(requestExport).not.toHaveBeenCalled();
  });

  it("serves capability exposure and rejects unknown or malformed resource URIs", async () => {
    const { mcp } = build({});

    const capabilities = await mcp.readResource(subject, {
      uri: "aethercloud://capabilities",
    });
    expect(capabilities.ok).toBe(true);
    if (!capabilities.ok) throw new Error(capabilities.failure.message);
    expect(capabilities.value.contents[0]?.text).toContain(
      '"mcpStatus":"planned"',
    );

    for (const request of [
      { uri: "aethercloud://capabilities?limit=1" },
      { uri: "https://audit/events" },
      { uri: "not a uri" },
      { uri: "aethercloud://unknown/resource" },
      { uri: "aethercloud://audit/events?tenantId=forged" },
      { uri: "aethercloud://audit/events?limit=1&limit=2" },
      { uri: "aethercloud://audit/events?limit=unbounded" },
    ]) {
      expect(await mcp.readResource(subject, request)).toMatchObject({
        ok: false,
      });
    }
  });

  it("returns application query failures and rejects malformed authenticated subjects", async () => {
    const auditSearch = vi.fn<ApplicationExecutor>().mockResolvedValue({
      ok: false,
      failure: { code: "permission-denied", message: "denied" },
    });
    const { mcp } = build({ auditSearch });

    expect(
      await mcp.readResource(subject, {
        uri: "aethercloud://audit/events",
      }),
    ).toEqual({
      ok: false,
      failure: { code: "permission-denied", message: "denied" },
    });

    for (const invalidSubject of [
      null,
      { ...subject, tenantId: "bad value" },
      { ...subject, permissions: "audit.event.read" },
      { ...subject, permissions: ["audit.event.read", 7] },
      { ...subject, permissions: ["audit.event.read", "audit.event.read"] },
      { ...subject, injectedTenant: subject.tenantId },
    ]) {
      expect(
        await mcp.readResource(invalidSubject, {
          uri: "aethercloud://capabilities",
        }),
      ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    }
  });

  it("returns successful command content and routes both implemented tools", async () => {
    const result = { resourceId: "created-resource-1" };
    const createJob = vi
      .fn<ApplicationExecutor>()
      .mockResolvedValue({ ok: true, value: result, replayed: true });
    const requestExport = vi
      .fn<ApplicationExecutor>()
      .mockResolvedValue({ ok: true, value: result });
    const { mcp } = build({ createJob, requestExport });
    const argumentsEnvelope = {
      confirmation: "confirmed",
      idempotencyKey: "mcp-command-request-0001",
      issuedAt: "2026-07-15T00:00:00.000Z",
      expiresAt: "2026-07-15T00:10:00.000Z",
      input: { resourceId: "requested-resource-1" },
    };

    const job = await mcp.callTool(subject, {
      name: "edge.job.create",
      arguments: argumentsEnvelope,
    });
    const dataExport = await mcp.callTool(subject, {
      name: "data.export.request",
      arguments: argumentsEnvelope,
    });

    expect(job).toMatchObject({
      ok: true,
      value: { structuredContent: result, replayed: true },
    });
    expect(dataExport).toMatchObject({
      ok: true,
      value: { structuredContent: result, replayed: false },
    });
    expect(createJob).toHaveBeenCalledOnce();
    expect(requestExport).toHaveBeenCalledOnce();
  });

  it("rejects malformed tool calls and command envelopes before delegation", async () => {
    const createJob = vi.fn<ApplicationExecutor>();
    const { mcp } = build({ createJob });
    const validEnvelope = {
      confirmation: "confirmed",
      idempotencyKey: "mcp-command-request-0001",
      issuedAt: "2026-07-15T00:00:00.000Z",
      expiresAt: "2026-07-15T00:10:00.000Z",
      input: {},
    };
    const invalidCalls: unknown[] = [
      null,
      { name: "edge.job.create" },
      { name: "bad tool name", arguments: validEnvelope },
      { name: "edge.job.create", arguments: null },
      {
        name: "edge.job.create",
        arguments: { ...validEnvelope, confirmation: "implicit" },
      },
      {
        name: "edge.job.create",
        arguments: { ...validEnvelope, idempotencyKey: "short" },
      },
      {
        name: "edge.job.create",
        arguments: { ...validEnvelope, issuedAt: 7 },
      },
      {
        name: "edge.job.create",
        arguments: { ...validEnvelope, expiresAt: "x".repeat(65) },
      },
      {
        name: "edge.job.create",
        arguments: { ...validEnvelope, extra: true },
      },
    ];

    for (const call of invalidCalls) {
      expect(await mcp.callTool(subject, call)).toMatchObject({
        ok: false,
        failure: { code: "invalid-input" },
      });
    }
    expect(createJob).not.toHaveBeenCalled();
  });
});
