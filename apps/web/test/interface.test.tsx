import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DashboardOverview,
  FleetView,
  LoginScreen,
  Overview,
} from "../src/app.js";

describe("AetherCloud console interface", () => {
  it("renders a dedicated control-plane login rather than a marketing subpage", () => {
    const html = renderToStaticMarkup(<LoginScreen />);

    expect(html).toContain("登录控制台");
    expect(html).toContain("管理每一处边缘");
    expect(html).toContain("管理员邀请");
    expect(html).toContain("切换到浅色主题");
    expect(html).toContain('href="https://aetheriot.dev"');
  });

  it("starts an empty Fleet with an AetherEdge gateway task", () => {
    const html = renderToStaticMarkup(
      <FleetView
        error={undefined}
        fleet={{ items: [], nextCursor: null }}
        loading={false}
        onIssueEnrollment={() => Promise.reject(new Error("not used"))}
        onRegister={() => Promise.reject(new Error("not used"))}
        onReload={() => undefined}
      />,
    );

    expect(html).toContain("添加第一个 AetherEdge 网关");
    expect(html).toContain("添加网关");
    expect(html).not.toContain("Gateway ID");
    expect(html).not.toContain("fleet.gateway.create");
  });

  it("renders a customizable Block dashboard from real Fleet evidence", () => {
    const html = renderToStaticMarkup(
      <DashboardOverview
        apiState="connected"
        audit={{ items: [], nextCursor: null }}
        fleet={{ items: [], nextCursor: null }}
        loading={false}
        onNavigate={() => undefined}
        onRefresh={() => undefined}
        scope={{
          tenantId: "tenant-1",
          projectId: "project-1",
          role: "owner",
          permissions: ["fleet.gateway.read"],
        }}
      />,
    );

    expect(html).toContain("添加 Block");
    expect(html).toContain("Fleet health");
    expect(html).toContain("CloudLink observation");
    expect(html).toContain("Enrollment");
    expect(html).toContain("Telemetry activity");
    expect(html).toContain("Recent audit events");
    expect(html).toContain("当前快照");
    expect(html).toContain("布局只保存在此浏览器");
    expect(html).not.toContain("CPU usage");
    expect(html).not.toContain("Memory usage");
  });

  it("keeps dashboard Blocks aligned to one consistent card height", () => {
    const css = readFileSync(
      new URL("../src/dashboard.css", import.meta.url),
      "utf8",
    );

    expect(css).toMatch(/\.dashboard-grid\s*\{[^}]*align-items:\s*stretch;/s);
    expect(css).toMatch(
      /\.dashboard-block\s*\{[^}]*height:\s*420px;[^}]*min-height:\s*420px;/s,
    );
  });

  it("distinguishes production services from modules that are not exposed", () => {
    const html = renderToStaticMarkup(
      <Overview
        apiState="connected"
        audit={{ items: [], nextCursor: null }}
        email="owner@example.com"
        onNavigate={() => undefined}
        scope={{
          tenantId: "tenant-1",
          projectId: "project-1",
          role: "owner",
          permissions: ["audit.event.read"],
        }}
      />,
    );

    expect(html).toContain("生产服务");
    expect(html).toContain("AetherEdge Fleet");
    expect(html).toContain("AetherEdge Fleet</strong><small>生产可用");
    expect(html).toContain("只展示真实实现");
  });
});
