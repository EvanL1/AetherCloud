import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  buildIntegrationCatalogUrl,
  buildIntegrationProjectionUrl,
  decodeIntegrationCatalogResponse,
  decodeIntegrationProjectionResponse,
} from "../src/api-client.js";
import type { IntegrationProjectionView } from "../src/api-client.js";
import {
  IntegrationsView,
  formatElapsed,
  formatObservedAt,
  formatReportedAt,
} from "../src/integrations.js";

const gatewayId = "33333333-3333-4333-8333-333333333333";
const reportedAt = "2026-07-31T10:00:00.000Z";
const now = Date.parse("2026-07-31T10:03:00.000Z");

const catalogItem = {
  gatewayId,
  integrationId: "home-assistant-main",
  integrationKind: "home-assistant",
  snapshotGeneration: "7",
  entityCount: 2,
  latestObservationCount: 1,
  receivedAt: reportedAt,
  revision: 4,
};

const catalogResponse = {
  authority: "edge-reported-copy",
  liveStateAuthoritative: false,
  items: [catalogItem],
};

const projectionResponse = {
  authority: "edge-reported-copy",
  liveStateAuthoritative: false,
  tenantId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  gatewayId,
  integrationId: "home-assistant-main",
  topology: {
    schema: "aether.integration.topology.v1",
    integrationId: "home-assistant-main",
    integrationKind: "home-assistant",
    snapshotGeneration: "7",
    observedAtMs: "1785326385000",
    areas: [{ areaId: "living-room", name: "客厅" }],
    devices: [{ deviceId: "device-1", name: "客厅温湿度计" }],
    entities: [
      {
        entityId: "sensor.living_room_temperature",
        sourceAddress: "sensor.living_room_temperature",
        name: "客厅温度",
        entityKind: "sensor",
        deviceId: "device-1",
        areaId: "living-room",
        points: [
          {
            pointKey: "state",
            title: "温度",
            kind: "telemetry",
            valueType: "decimal",
            unit: "°C",
          },
        ],
      },
    ],
  },
  topologyDigest: "a".repeat(64),
  latestObservations: [
    {
      entityId: "sensor.living_room_temperature",
      pointKey: "state",
      observedAtMs: String(Date.parse("2026-07-31T09:58:00.000Z")),
      quality: "good",
      value: { type: "decimal", value: "21.4" },
    },
  ],
  receivedAt: reportedAt,
  revision: 4,
};

function view(
  overrides: Partial<React.ComponentProps<typeof IntegrationsView>> = {},
): string {
  return renderToStaticMarkup(
    <IntegrationsView
      catalog={undefined}
      error={undefined}
      loading={false}
      now={now}
      onNext={() => undefined}
      onReload={() => undefined}
      onSelect={() => undefined}
      projection={undefined}
      projectionError={undefined}
      projectionLoading={false}
      selected={undefined}
      {...overrides}
    />,
  );
}

describe("AetherCloud Integration projection console", () => {
  it("reads freshness as elapsed time instead of a bare wall clock", () => {
    expect(formatElapsed(now - 3_000, now)).toBe("刚刚");
    expect(formatElapsed(now - 42_000, now)).toBe("42 秒前");
    expect(formatElapsed(now - 3 * 60_000, now)).toBe("3 分钟前");
    expect(formatElapsed(now - 5 * 3_600_000, now)).toBe("5 小时前");
    expect(formatElapsed(now - 2 * 86_400_000, now)).toBe("2 天前");
  });

  it("keeps a browser clock ahead of the edge from reading as a future report", () => {
    expect(formatElapsed(now + 90_000, now)).toBe("刚刚");
  });

  it("attributes the elapsed report to the edge rather than to live state", () => {
    expect(formatReportedAt(reportedAt, now)).toBe("边缘 3 分钟前上报");
    expect(formatReportedAt("not-an-instant", now)).toBe("上报时间未知");
  });

  it("refuses to convert an observation instant outside the safe integer range", () => {
    expect(formatObservedAt("1785326385000", 1_785_326_445_000)).toBe(
      "1 分钟前",
    );
    expect(formatObservedAt("9007199254740993", now)).toBe(
      "观测时间超出安全范围",
    );
  });

  it("rejects a catalog that does not pin the edge-reported-copy authority", () => {
    expect(() =>
      decodeIntegrationCatalogResponse({
        ...catalogResponse,
        liveStateAuthoritative: true,
      }),
    ).toThrow("invalid Integration response");
    expect(() =>
      decodeIntegrationCatalogResponse({ items: [catalogItem] }),
    ).toThrow("invalid Integration response");
  });

  it("decodes the catalog without converting unsigned protocol integers", () => {
    const decoded = decodeIntegrationCatalogResponse({
      ...catalogResponse,
      items: [{ ...catalogItem, snapshotGeneration: "9007199254740993" }],
      nextCursor: "cursor-2",
    });

    expect(decoded.authority).toBe("edge-reported-copy");
    expect(decoded.liveStateAuthoritative).toBe(false);
    expect(decoded.nextCursor).toBe("cursor-2");
    expect(decoded.items[0]?.snapshotGeneration).toBe("9007199254740993");
  });

  it("keeps int64 observations textual and rejects unsafe numeric ones", () => {
    const decoded = decodeIntegrationProjectionResponse({
      ...projectionResponse,
      latestObservations: [
        {
          ...projectionResponse.latestObservations[0],
          value: { type: "int64", value: "9007199254740993" },
        },
      ],
    });

    expect(decoded.latestObservations[0]?.value).toEqual({
      type: "int64",
      value: "9007199254740993",
    });
    expect(() =>
      decodeIntegrationProjectionResponse({
        ...projectionResponse,
        latestObservations: [
          {
            ...projectionResponse.latestObservations[0],
            value: { type: "int64", value: 9_007_199_254_740_992 },
          },
        ],
      }),
    ).toThrow("invalid Integration response");
  });

  it("builds bounded read-only Integration URLs", () => {
    expect(
      buildIntegrationCatalogUrl("https://api.aetheriot.dev", {
        limit: 50,
        gatewayId,
        cursor: "cursor-2",
      }).toString(),
    ).toBe(
      `https://api.aetheriot.dev/api/v1/integrations?limit=50&gatewayId=${gatewayId}&cursor=cursor-2`,
    );
    expect(
      buildIntegrationProjectionUrl(
        "https://api.aetheriot.dev",
        gatewayId,
        "home-assistant-main",
      ).toString(),
    ).toBe(
      `https://api.aetheriot.dev/api/v1/integrations/${gatewayId}/home-assistant-main`,
    );
  });

  it("states the edge-reported authority in prose on the catalog view", () => {
    const html = view({
      catalog: decodeIntegrationCatalogResponse(catalogResponse),
    });

    expect(html).toContain("边缘上报副本，不是设备当前状态");
    expect(html).toContain(
      "authority=edge-reported-copy · liveStateAuthoritative=false",
    );
    expect(html).toContain(
      "现场点位、规则、安全联锁和物理控制的权威始终留在边缘",
    );
    expect(html).toContain("没有从这里下发控制的通路");
  });

  it("renders catalog freshness as elapsed time with the absolute time kept available", () => {
    const html = view({
      catalog: decodeIntegrationCatalogResponse(catalogResponse),
    });

    expect(html).toContain("边缘 3 分钟前上报");
    // The absolute instant stays reachable for anyone who needs it, without
    // being the label a reader sees first.
    const absolute = new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(reportedAt));
    expect(html).toContain(`dateTime="${reportedAt}"`);
    expect(html).toContain(`title="${absolute}"`);
    expect(html).toContain("home-assistant-main");
    expect(html).toContain("2 实体 · 1 观测");
  });

  it("tells an operator what to do when the catalog is genuinely empty", () => {
    const html = view({
      catalog: decodeIntegrationCatalogResponse({
        ...catalogResponse,
        items: [],
      }),
    });

    expect(html).toContain("还没有收到集成投影");
    expect(html).toContain(
      "AETHER_CLOUD_INTEGRATION_PROJECTION_STORE=postgres",
    );
    expect(html).toContain("互相看不见的内存实例");
    expect(html).not.toContain("无法读取集成投影目录");
  });

  it("separates a failed catalog request from an empty catalog", () => {
    const html = view({
      catalog: undefined,
      error: "无法读取集成投影目录，请稍后重试。",
    });

    expect(html).toContain("无法读取集成投影目录");
    expect(html).toContain("这不是空结果，是请求失败");
    expect(html).toContain("integration.projection.read");
    expect(html).not.toContain("还没有收到集成投影");
  });

  it("shows reported topology, points and observation quality in the detail", () => {
    const projection: IntegrationProjectionView =
      decodeIntegrationProjectionResponse(projectionResponse);
    const html = view({
      catalog: decodeIntegrationCatalogResponse(catalogResponse),
      selected: { gatewayId, integrationId: "home-assistant-main" },
      projection,
    });

    expect(html).toContain("客厅温度");
    expect(html).toContain("温度");
    expect(html).toContain("state · telemetry · decimal");
    expect(html).toContain("21.4 °C");
    expect(html).toContain("良好");
    expect(html).toContain("5 分钟前");
    expect(html).toContain(
      "云端保存的是边缘上报的副本，不是设备当前状态；云端无法读取或控制这些设备。",
    );
  });

  it("keeps observations the current topology snapshot cannot place", () => {
    const html = view({
      catalog: decodeIntegrationCatalogResponse(catalogResponse),
      selected: { gatewayId, integrationId: "home-assistant-main" },
      projection: decodeIntegrationProjectionResponse({
        ...projectionResponse,
        latestObservations: [
          ...projectionResponse.latestObservations,
          {
            entityId: "sensor.retired_entity",
            pointKey: "state",
            observedAtMs: String(Date.parse("2026-07-31T09:00:00.000Z")),
            quality: "bad",
          },
        ],
      }),
    });

    expect(html).toContain("找不到对应点位");
    expect(html).toContain("sensor.retired_entity");
  });

  it("reports a failed detail request instead of an empty projection", () => {
    const html = view({
      catalog: decodeIntegrationCatalogResponse(catalogResponse),
      selected: { gatewayId, integrationId: "home-assistant-main" },
      projectionError: "无法读取这个集成投影，请稍后重试。",
    });

    expect(html).toContain("无法读取这个集成投影");
    expect(html).toContain("返回列表");
  });

  it("exposes no field the cloud is forbidden to hold and no control affordance", () => {
    const html = view({
      catalog: decodeIntegrationCatalogResponse(catalogResponse),
      selected: { gatewayId, integrationId: "home-assistant-main" },
      projection: decodeIntegrationProjectionResponse(projectionResponse),
    });

    expect(html).not.toContain("token");
    expect(html).not.toContain("Token");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("连接设置");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("开关");
  });
});
