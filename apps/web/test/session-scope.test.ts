import { describe, expect, it } from "vitest";

import { decodeSessionScope } from "../src/session-scope.js";

describe("AetherCloud console session scope", () => {
  it("reads authorization scope only from administrator-controlled app metadata", () => {
    expect(
      decodeSessionScope({
        app_metadata: {
          aethercloud_tenant_id: "tenant-1",
          aethercloud_project_id: "project-1",
          aethercloud_role: "owner",
          aethercloud_permissions: ["audit.event.read"],
        },
        user_metadata: {
          tenant_id: "forged-tenant",
          role: "owner",
          permissions: ["everything"],
        },
      }),
    ).toEqual({
      tenantId: "tenant-1",
      projectId: "project-1",
      role: "owner",
      permissions: ["audit.event.read"],
    });
  });

  it("fails closed when required administrator metadata is absent", () => {
    expect(
      decodeSessionScope({
        app_metadata: {},
        user_metadata: {
          tenant_id: "forged-tenant",
          project_id: "forged-project",
        },
      }),
    ).toBeNull();
  });
});
