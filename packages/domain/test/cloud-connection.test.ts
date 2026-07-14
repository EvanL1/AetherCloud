import { describe, expect, it } from "vitest";

import {
  InvalidCloudConnectionError,
  defineCloudConnection,
  defineCloudProvider,
  parseCloudConnectionId,
  type CloudConnectionStatus,
  type CredentialSource,
} from "../src/index.js";

const tenantId = "018f6f89-4368-7c3a-b7f1-a9f2da491101";
const projectId = "018f6f89-4368-7c3a-b7f1-a9f2da491102";
const connectionId = "018f6f89-4368-7c3a-b7f1-a9f2da491103";

const provider = defineCloudProvider({
  id: "private-openstack-a",
  displayName: "Private OpenStack A",
  kind: "private-cloud",
  capabilities: ["compute", "private-network"],
});

describe("cloud connection", () => {
  it("binds one tenant project to an explicit provider and credential reference", () => {
    const connection = defineCloudConnection({
      id: connectionId,
      tenantId,
      projectId,
      providerId: provider.id,
      displayName: "  Factory private cloud  ",
      providerScope: "operations-project",
      credentialSource: {
        kind: "secret-reference",
        reference: "secret://vault/aether-cloud/openstack/operations",
      },
      status: "active",
    });

    expect(connection).toMatchObject({
      id: connectionId,
      tenantId,
      projectId,
      providerId: "private-openstack-a",
      displayName: "Factory private cloud",
      providerScope: "operations-project",
      credentialSource: {
        kind: "secret-reference",
        reference: "secret://vault/aether-cloud/openstack/operations",
      },
      status: "active",
    });
    expect(Object.isFrozen(connection)).toBe(true);
    expect(Object.isFrozen(connection.credentialSource)).toBe(true);
  });

  it("accepts workload identity without storing a long-lived credential", () => {
    const connection = defineCloudConnection({
      id: connectionId,
      tenantId,
      projectId,
      providerId: provider.id,
      displayName: "Workload identity connection",
      providerScope: "production-account",
      credentialSource: {
        kind: "workload-identity",
        reference: "workload-identity://aether-cloud/providers/openstack",
      },
      status: "active",
    });

    expect(connection.credentialSource.kind).toBe("workload-identity");
  });

  it("rejects credential values masquerading as references", () => {
    expect(() =>
      defineCloudConnection({
        id: connectionId,
        tenantId,
        projectId,
        providerId: provider.id,
        displayName: "Unsafe connection",
        providerScope: "production-account",
        credentialSource: {
          kind: "secret-reference",
          reference: "AKIA-THIS-IS-NOT-A-REFERENCE",
        },
        status: "active",
      }),
    ).toThrow(InvalidCloudConnectionError);
  });

  it("rejects an invalid public resource identity", () => {
    expect(() =>
      defineCloudConnection({
        id: "connection-one",
        tenantId,
        projectId,
        providerId: provider.id,
        displayName: "Invalid connection",
        providerScope: "production-account",
        credentialSource: {
          kind: "secret-reference",
          reference: "secret://vault/aether-cloud/openstack/production",
        },
        status: "active",
      }),
    ).toThrow(InvalidCloudConnectionError);
  });

  it.each([
    { displayName: "", providerScope: "production-account" },
    { displayName: "Production", providerScope: "" },
  ])("rejects incomplete connection metadata", (metadata) => {
    expect(() =>
      defineCloudConnection({
        id: connectionId,
        tenantId,
        projectId,
        providerId: provider.id,
        ...metadata,
        credentialSource: {
          kind: "secret-reference",
          reference: "secret://vault/aether-cloud/openstack/production",
        },
        status: "active",
      }),
    ).toThrow(InvalidCloudConnectionError);
  });

  it("runtime-validates status and credential source discriminators", () => {
    const base = {
      id: connectionId,
      tenantId,
      projectId,
      providerId: provider.id,
      displayName: "Production",
      providerScope: "production-account",
    };

    expect(() =>
      defineCloudConnection({
        ...base,
        credentialSource: {
          kind: "secret-reference",
          reference: "secret://vault/aether-cloud/openstack/production",
        },
        status: "unknown" as CloudConnectionStatus,
      }),
    ).toThrow(InvalidCloudConnectionError);
    expect(() =>
      defineCloudConnection({
        ...base,
        credentialSource: {
          kind: "raw-value",
          reference: "workload-identity://aether-cloud/providers/openstack",
        } as unknown as CredentialSource,
        status: "active",
      }),
    ).toThrow(InvalidCloudConnectionError);
  });

  it("rejects a non-string Cloud Connection identity at an external boundary", () => {
    expect(() => parseCloudConnectionId(42)).toThrow(
      InvalidCloudConnectionError,
    );
  });
});
