import { describe, expect, it, vi } from "vitest";

import {
  AetherCloudMcpInterface,
  type IntegrationControlGovernanceResolver,
  type McpAuthenticatedSubject,
} from "../src/index.js";

const subject: McpAuthenticatedSubject = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  subjectId: "agent-service-account-1",
  permissions: ["audit.event.read", "data.export.create", "edge.job.create"],
};

const controlSubject: McpAuthenticatedSubject = {
  ...subject,
  permissions: [...subject.permissions, "integration.device.control"],
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
type GovernanceMock = ReturnType<
  typeof vi.fn<IntegrationControlGovernanceResolver["resolve"]>
>;

function build(overrides: {
  auditSearch?: ApplicationMock;
  createJob?: ApplicationMock;
  requestExport?: ApplicationMock;
  createIntegrationPowerControl?: ApplicationMock;
  getIntegrationProjection?: ApplicationMock;
  listIntegrationProjections?: ApplicationMock;
  integrationControlGovernance?: {
    resolve: GovernanceMock;
  };
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
      ...(overrides.createIntegrationPowerControl === undefined
        ? {}
        : {
            createIntegrationPowerControl: {
              execute: overrides.createIntegrationPowerControl,
            },
          }),
      ...(overrides.integrationControlGovernance === undefined
        ? {}
        : {
            integrationControlGovernance:
              overrides.integrationControlGovernance,
          }),
      ...(overrides.getIntegrationProjection === undefined
        ? {}
        : {
            getIntegrationProjection: {
              execute: overrides.getIntegrationProjection,
            },
          }),
      ...(overrides.listIntegrationProjections === undefined
        ? {}
        : {
            listIntegrationProjections: {
              execute: overrides.listIntegrationProjections,
            },
          }),
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

  it("keeps Integration Control absent unless both the use case and trusted governance resolver are injected", () => {
    expect(build({}).mcp.listTools()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "integration.device.power.set" }),
      ]),
    );

    expect(
      () =>
        new AetherCloudMcpInterface({
          searchAuditEvents: { execute: vi.fn<ApplicationExecutor>() },
          createGovernedJob: { execute: vi.fn<ApplicationExecutor>() },
          requestDataExport: { execute: vi.fn<ApplicationExecutor>() },
          createIntegrationPowerControl: {
            execute: vi.fn<ApplicationExecutor>(),
          },
        }),
    ).toThrow(/governance/i);
  });

  it("resolves trusted governance evidence and returns accepted while waiting for edge evidence", async () => {
    const createIntegrationPowerControl = vi
      .fn<ApplicationExecutor>()
      .mockResolvedValue({
        ok: true,
        replayed: false,
        value: {
          disposition: "persisted",
          intent: {
            jobId: "55555555-5555-4555-8555-555555555555",
          },
          providerAccepted: false,
          physicalCompleted: false,
          jobSucceeded: false,
        },
      });
    const resolve = vi
      .fn<IntegrationControlGovernanceResolver["resolve"]>()
      .mockResolvedValue({
        ok: true,
        value: {
          authorization: {
            policyDecisionId: "trusted-policy-decision-1",
            subjectId: controlSubject.subjectId,
            permission: "integration.device.control",
            authorizedAtMs: "1784217599000",
          },
          confirmation: {
            confirmationId: "66666666-6666-4666-8666-666666666666",
            subjectId: controlSubject.subjectId,
            confirmedAtMs: "1784217599500",
          },
        },
      });
    const { mcp } = build({
      createIntegrationPowerControl,
      integrationControlGovernance: { resolve },
    });
    const input = {
      gatewayId: "33333333-3333-4333-8333-333333333333",
      jobId: "55555555-5555-4555-8555-555555555555",
      integrationId: "home-assistant.home",
      snapshotGeneration: "1",
      entityId: "entity-registry-light-bedroom",
      value: false,
      jobExpiresAtMs: "1784217660000",
    };

    expect(mcp.listTools()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "integration.device.power.set",
          permission: "integration.device.control",
          risk: "high",
          confirmation: "explicit",
        }),
      ]),
    );
    const result = await mcp.callTool(controlSubject, {
      name: "integration.device.power.set",
      arguments: {
        confirmation: "confirmed",
        idempotencyKey: "mcp-integration-control-0001",
        issuedAt: "2026-07-16T08:59:59.000Z",
        expiresAt: "2026-07-16T09:01:00.000Z",
        input,
      },
    });

    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      subject: controlSubject,
      idempotencyKey: "mcp-integration-control-0001",
      issuedAt: "2026-07-16T08:59:59.000Z",
      expiresAt: "2026-07-16T09:01:00.000Z",
      action: input,
    });
    expect(createIntegrationPowerControl).toHaveBeenCalledExactlyOnceWith(
      {
        ...controlSubject,
        idempotencyKey: "mcp-integration-control-0001",
        issuedAt: "2026-07-16T08:59:59.000Z",
        expiresAt: "2026-07-16T09:01:00.000Z",
        authorization: {
          policyDecisionId: "trusted-policy-decision-1",
          subjectId: controlSubject.subjectId,
          permission: "integration.device.control",
          authorizedAtMs: "1784217599000",
        },
        confirmation: {
          confirmationId: "66666666-6666-4666-8666-666666666666",
          subjectId: controlSubject.subjectId,
          confirmedAtMs: "1784217599500",
        },
      },
      input,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        content: [
          {
            type: "text",
            text: "已受理，正在等待边缘端证据。",
          },
        ],
        structuredContent: {
          status: "accepted-awaiting-edge-evidence",
          jobId: "55555555-5555-4555-8555-555555555555",
          providerAccepted: false,
          physicalCompleted: false,
          jobSucceeded: false,
        },
        replayed: false,
      },
    });
  });

  it("rejects caller-supplied governance references before resolving or executing", async () => {
    const createIntegrationPowerControl = vi.fn<ApplicationExecutor>();
    const resolve = vi.fn<IntegrationControlGovernanceResolver["resolve"]>();
    const { mcp } = build({
      createIntegrationPowerControl,
      integrationControlGovernance: { resolve },
    });

    const result = await mcp.callTool(controlSubject, {
      name: "integration.device.power.set",
      arguments: {
        confirmation: "confirmed",
        idempotencyKey: "mcp-integration-control-0002",
        issuedAt: "2026-07-16T08:59:59.000Z",
        expiresAt: "2026-07-16T09:01:00.000Z",
        input: {
          gatewayId: "33333333-3333-4333-8333-333333333333",
          jobId: "55555555-5555-4555-8555-555555555555",
          integrationId: "home-assistant.home",
          snapshotGeneration: "1",
          entityId: "entity-registry-light-bedroom",
          value: true,
          jobExpiresAtMs: "1784217660000",
          authorization: { policyDecisionId: "forged" },
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(createIntegrationPowerControl).not.toHaveBeenCalled();
  });

  it("exposes one Integration projection by strict identity only when its application query is injected", async () => {
    expect(build({}).mcp.listResources()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uriTemplate:
            "aethercloud://integration/projections/{gatewayId}/{integrationId}",
        }),
      ]),
    );
    const getIntegrationProjection = vi
      .fn<ApplicationExecutor>()
      .mockResolvedValue({
        ok: true,
        value: {
          authority: "edge-reported-copy",
          liveStateAuthoritative: false,
          topology: { snapshotGeneration: "7", entities: [] },
          latestObservations: [],
        },
      });
    const { mcp } = build({ getIntegrationProjection });
    expect(mcp.listResources()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uriTemplate:
            "aethercloud://integration/projections/{gatewayId}/{integrationId}",
        }),
      ]),
    );

    const result = await mcp.readResource(controlSubject, {
      uri: `aethercloud://integration/projections/33333333-3333-4333-8333-333333333333/home-assistant.home`,
    });

    expect(getIntegrationProjection).toHaveBeenCalledExactlyOnceWith(
      controlSubject,
      {
        gatewayId: "33333333-3333-4333-8333-333333333333",
        integrationId: "home-assistant.home",
      },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        contents: [
          {
            mimeType: "application/json",
          },
        ],
      },
    });
    if (!result.ok) return;
    expect(result.value.contents[0]?.text).toContain(
      '"authority":"edge-reported-copy"',
    );
    for (const uri of [
      "aethercloud://integration/projections/not-a-gateway/home-assistant.home",
      `aethercloud://integration/projections/33333333-3333-4333-8333-333333333333/home-assistant.home/extra`,
      `aethercloud://integration/projections/33333333-3333-4333-8333-333333333333/home-assistant.home?tenantId=forged`,
    ]) {
      expect(await mcp.readResource(controlSubject, { uri })).toMatchObject({
        ok: false,
        failure: { code: "invalid-input" },
      });
    }
    expect(getIntegrationProjection).toHaveBeenCalledOnce();
  });

  it("keeps the Integration projection catalog hidden until its application query is injected", () => {
    expect(build({}).mcp.listResources()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uriTemplate:
            "aethercloud://integration/projections{?gatewayId,cursor,limit}",
        }),
      ]),
    );
    const listIntegrationProjections = vi.fn<ApplicationExecutor>();
    const { mcp } = build({ listIntegrationProjections });

    expect(mcp.listResources()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uriTemplate:
            "aethercloud://integration/projections{?gatewayId,cursor,limit}",
        }),
      ]),
    );
  });

  it("reads a bounded Integration projection catalog only through the application query", async () => {
    const listIntegrationProjections = vi
      .fn<ApplicationExecutor>()
      .mockResolvedValue({
        ok: true,
        value: {
          authority: "edge-reported-copy",
          liveStateAuthoritative: false,
          items: [
            {
              gatewayId: "33333333-3333-4333-8333-333333333333",
              integrationId: "home-assistant.home",
              integrationKind: "home-assistant",
              snapshotGeneration: "7",
              entityCount: 4,
              latestObservationCount: 3,
              receivedAt: "2026-07-17T10:00:00.000Z",
              revision: 8,
            },
          ],
          nextCursor: "opaqueCursorToken_abcdef",
        },
      });
    const { mcp } = build({ listIntegrationProjections });

    const result = await mcp.readResource(controlSubject, {
      uri: "aethercloud://integration/projections?gatewayId=33333333-3333-4333-8333-333333333333&cursor=opaqueCursorToken_123456&limit=25",
    });

    expect(listIntegrationProjections).toHaveBeenCalledExactlyOnceWith(
      controlSubject,
      {
        gatewayId: "33333333-3333-4333-8333-333333333333",
        cursor: "opaqueCursorToken_123456",
        limit: 25,
      },
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.contents[0]?.mimeType).toBe("application/json");
    expect(result.value.contents[0]?.text).toContain('"entityCount":4');
  });

  it("rejects malformed Integration catalog filters before the application query", async () => {
    const listIntegrationProjections = vi.fn<ApplicationExecutor>();
    const { mcp } = build({ listIntegrationProjections });
    const invalidUris = [
      "aethercloud://integration/projections?gatewayId=not-a-gateway",
      "aethercloud://integration/projections?cursor=short",
      "aethercloud://integration/projections?limit=0",
      "aethercloud://integration/projections?limit=101",
      "aethercloud://integration/projections?limit=2.5",
      "aethercloud://integration/projections?limit=2&limit=3",
      "aethercloud://integration/projections?tenantId=forged",
      "aethercloud://integration/projections#fragment",
    ];

    for (const uri of invalidUris) {
      expect(await mcp.readResource(controlSubject, { uri })).toMatchObject({
        ok: false,
        failure: { code: "invalid-input" },
      });
    }
    expect(listIntegrationProjections).not.toHaveBeenCalled();
  });

  it("supports the catalog-to-detail Agent journey without bypassing either application query", async () => {
    const listIntegrationProjections = vi
      .fn<ApplicationExecutor>()
      .mockResolvedValue({
        ok: true,
        value: {
          authority: "edge-reported-copy",
          liveStateAuthoritative: false,
          items: [
            {
              gatewayId: "33333333-3333-4333-8333-333333333333",
              integrationId: "home-assistant.home",
            },
          ],
        },
      });
    const getIntegrationProjection = vi
      .fn<ApplicationExecutor>()
      .mockResolvedValue({
        ok: true,
        value: {
          authority: "edge-reported-copy",
          liveStateAuthoritative: false,
          topology: { snapshotGeneration: "7", entities: [] },
          latestObservations: [],
        },
      });
    const { mcp } = build({
      getIntegrationProjection,
      listIntegrationProjections,
    });

    const catalog = await mcp.readResource(controlSubject, {
      uri: "aethercloud://integration/projections?limit=10",
    });
    expect(catalog.ok).toBe(true);
    const detail = await mcp.readResource(controlSubject, {
      uri: "aethercloud://integration/projections/33333333-3333-4333-8333-333333333333/home-assistant.home",
    });

    expect(detail.ok).toBe(true);
    expect(listIntegrationProjections).toHaveBeenCalledExactlyOnceWith(
      controlSubject,
      { limit: 10 },
    );
    expect(getIntegrationProjection).toHaveBeenCalledExactlyOnceWith(
      controlSubject,
      {
        gatewayId: "33333333-3333-4333-8333-333333333333",
        integrationId: "home-assistant.home",
      },
    );
  });
});
