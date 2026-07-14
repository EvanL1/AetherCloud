import { describe, expect, it } from "vitest";

import {
  InvalidDeploymentStackError,
  defineCloudConnection,
  defineCloudProvider,
  defineDeploymentStack,
  defineProviderRegion,
} from "../src/index.js";

const tenantId = "018f6f89-4368-7c3a-b7f1-a9f2da491101";
const projectId = "018f6f89-4368-7c3a-b7f1-a9f2da491102";
const connectionId = "018f6f89-4368-7c3a-b7f1-a9f2da491103";
const stackId = "018f6f89-4368-7c3a-b7f1-a9f2da491104";

const provider = defineCloudProvider({
  id: "example-cloud",
  displayName: "Example Cloud",
  kind: "public-cloud",
  capabilities: ["compute", "private-network"],
});

function cloudConnection(status: "active" | "disabled" = "active") {
  return defineCloudConnection({
    id: connectionId,
    tenantId,
    projectId,
    providerId: provider.id,
    displayName: "Example production",
    providerScope: "production-account",
    credentialSource: {
      kind: "workload-identity",
      reference: "workload-identity://aether-cloud/providers/example-cloud",
    },
    status,
  });
}

function providerRegion(
  availability: "available" | "unavailable" = "available",
) {
  return defineProviderRegion({
    id: "region-one",
    displayName: "Region One",
    availability,
    capabilities: ["compute", "private-network"],
    zones: ["zone-a"],
  });
}

describe("deployment stack", () => {
  it("derives provider scope and an isolated State key from one Cloud Connection", () => {
    const connection = cloudConnection();
    const stack = defineDeploymentStack({
      id: stackId,
      connection,
      displayName: "  Edge data plane  ",
      primaryRegion: {
        providerId: connection.providerId,
        connectionId: connection.id,
        observedAt: "2026-07-14T12:00:00.000Z",
        region: providerRegion(),
      },
      stateBackendReference:
        "state-backend://aether-cloud/production-eu-backend",
    });

    expect(stack).toEqual({
      id: stackId,
      tenantId,
      projectId,
      connectionId,
      providerId: "example-cloud",
      displayName: "Edge data plane",
      primaryRegionId: "region-one",
      placementObservedAt: "2026-07-14T12:00:00.000Z",
      state: {
        backendReference: "state-backend://aether-cloud/production-eu-backend",
        key: `tenants/${tenantId}/projects/${projectId}/connections/${connectionId}/stacks/${stackId}`,
        locking: "required",
        encryption: "required",
      },
    });
    expect(Object.isFrozen(stack)).toBe(true);
    expect(Object.isFrozen(stack.state)).toBe(true);
  });

  it("rejects a disabled Cloud Connection", () => {
    const connection = cloudConnection("disabled");
    expect(() =>
      defineDeploymentStack({
        id: stackId,
        connection,
        displayName: "Edge data plane",
        primaryRegion: {
          providerId: connection.providerId,
          connectionId: connection.id,
          observedAt: "2026-07-14T12:00:00.000Z",
          region: providerRegion(),
        },
        stateBackendReference:
          "state-backend://aether-cloud/production-eu-backend",
      }),
    ).toThrow(InvalidDeploymentStackError);
  });

  it("rejects a region that was observed as unavailable", () => {
    const connection = cloudConnection();
    expect(() =>
      defineDeploymentStack({
        id: stackId,
        connection,
        displayName: "Edge data plane",
        primaryRegion: {
          providerId: connection.providerId,
          connectionId: connection.id,
          observedAt: "2026-07-14T12:00:00.000Z",
          region: providerRegion("unavailable"),
        },
        stateBackendReference:
          "state-backend://aether-cloud/production-eu-backend",
      }),
    ).toThrow(InvalidDeploymentStackError);
  });

  it.each([
    "file:///tmp/terraform.tfstate",
    "state-backend://backend/path?access_key=secret",
    "state-backend://",
  ])(
    "rejects a local, credential-bearing, or empty State reference",
    (reference) => {
      const connection = cloudConnection();
      expect(() =>
        defineDeploymentStack({
          id: stackId,
          connection,
          displayName: "Edge data plane",
          primaryRegion: {
            providerId: connection.providerId,
            connectionId: connection.id,
            observedAt: "2026-07-14T12:00:00.000Z",
            region: providerRegion(),
          },
          stateBackendReference: reference,
        }),
      ).toThrow(InvalidDeploymentStackError);
    },
  );

  it("rejects a placement observation from another provider", () => {
    const connection = cloudConnection();
    const otherProvider = defineCloudProvider({
      id: "other-cloud",
      displayName: "Other Cloud",
      kind: "public-cloud",
      capabilities: ["compute"],
    });

    expect(() =>
      defineDeploymentStack({
        id: stackId,
        connection,
        displayName: "Edge data plane",
        primaryRegion: {
          providerId: otherProvider.id,
          connectionId: connection.id,
          observedAt: "2026-07-14T12:00:00.000Z",
          region: providerRegion(),
        },
        stateBackendReference:
          "state-backend://aether-cloud/production-eu-backend",
      }),
    ).toThrow(InvalidDeploymentStackError);
  });

  it.each([
    { id: "stack-one", displayName: "Edge data plane" },
    { id: stackId, displayName: "" },
  ])("rejects invalid stack identity and display metadata", (metadata) => {
    const connection = cloudConnection();
    expect(() =>
      defineDeploymentStack({
        ...metadata,
        connection,
        primaryRegion: {
          providerId: connection.providerId,
          connectionId: connection.id,
          observedAt: "2026-07-14T12:00:00.000Z",
          region: providerRegion(),
        },
        stateBackendReference:
          "state-backend://aether-cloud/production-eu-backend",
      }),
    ).toThrow(InvalidDeploymentStackError);
  });

  it("rejects placement evidence without a canonical observation time", () => {
    const connection = cloudConnection();
    expect(() =>
      defineDeploymentStack({
        id: stackId,
        connection,
        displayName: "Edge data plane",
        primaryRegion: {
          providerId: connection.providerId,
          connectionId: connection.id,
          observedAt: "yesterday",
          region: providerRegion(),
        },
        stateBackendReference:
          "state-backend://aether-cloud/production-eu-backend",
      }),
    ).toThrow(InvalidDeploymentStackError);
  });
});
