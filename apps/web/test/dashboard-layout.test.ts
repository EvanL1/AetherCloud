import { describe, expect, it } from "vitest";

import {
  DEFAULT_DASHBOARD_LAYOUT,
  addDashboardBlock,
  dashboardStorageKey,
  decodeDashboardLayout,
  removeDashboardBlock,
  reorderDashboardBlocks,
  resizeDashboardBlock,
} from "../src/dashboard-layout.js";

describe("custom dashboard layout", () => {
  it("strictly restores a versioned unique layout", () => {
    expect(
      decodeDashboardLayout(
        JSON.stringify({
          schema: "aether.cloud.console-dashboard.v1",
          blocks: [
            { id: "audit-activity", size: "full" },
            { id: "fleet-health", size: "half" },
          ],
        }),
      ),
    ).toEqual([
      { id: "audit-activity", size: "full" },
      { id: "fleet-health", size: "half" },
    ]);

    for (const malformed of [
      "not-json",
      JSON.stringify({ schema: "unknown", blocks: [] }),
      JSON.stringify({
        schema: "aether.cloud.console-dashboard.v1",
        blocks: [
          { id: "fleet-health", size: "half" },
          { id: "fleet-health", size: "full" },
        ],
      }),
      JSON.stringify({
        schema: "aether.cloud.console-dashboard.v1",
        blocks: [{ id: "invented-metric", size: "half" }],
      }),
    ]) {
      expect(decodeDashboardLayout(malformed)).toEqual(
        DEFAULT_DASHBOARD_LAYOUT,
      );
    }
  });

  it("reorders resizes removes and restores only catalogued blocks", () => {
    const moved = reorderDashboardBlocks(
      DEFAULT_DASHBOARD_LAYOUT,
      "fleet-health",
      "telemetry-activity",
    );
    expect(moved.map((block) => block.id)).toEqual([
      "cloudlink-health",
      "enrollment-state",
      "telemetry-activity",
      "fleet-health",
      "audit-activity",
    ]);
    expect(resizeDashboardBlock(moved, "fleet-health", "full")).toContainEqual({
      id: "fleet-health",
      size: "full",
    });

    const removed = removeDashboardBlock(moved, "fleet-health");
    expect(removed.some((block) => block.id === "fleet-health")).toBe(false);
    expect(addDashboardBlock(removed, "fleet-health")).toEqual([
      ...removed,
      { id: "fleet-health", size: "half" },
    ]);
    expect(addDashboardBlock(moved, "fleet-health")).toEqual(moved);
  });

  it("scopes browser preferences to the signed tenant and project", () => {
    expect(dashboardStorageKey("tenant-a", "project-b")).toBe(
      "aethercloud.dashboard.v1:tenant-a:project-b",
    );
  });
});
