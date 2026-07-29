import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LoginScreen, Overview } from "../src/app.js";

describe("AetherCloud console interface", () => {
  it("renders a dedicated control-plane login rather than a marketing subpage", () => {
    const html = renderToStaticMarkup(<LoginScreen />);

    expect(html).toContain("登录控制台");
    expect(html).toContain("管理每一处边缘");
    expect(html).toContain("管理员邀请");
    expect(html).toContain("切换到浅色主题");
    expect(html).toContain('href="https://aetheriot.dev"');
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
    expect(html).toContain("边缘 Fleet");
    expect(html).toContain("边缘 Fleet</strong><small>生产可用");
    expect(html).toContain("只展示真实实现");
  });
});
