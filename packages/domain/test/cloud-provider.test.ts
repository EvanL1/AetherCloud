import { describe, expect, it } from "vitest";

import {
  InvalidCloudProviderDescriptorError,
  defineCloudProvider,
  providerSupports,
} from "../src/index.js";

describe("cloud provider descriptor", () => {
  it("accepts a provider without adding it to a hard-coded vendor enum", () => {
    const provider = defineCloudProvider({
      id: "private-openstack-a",
      displayName: "Private OpenStack A",
      kind: "private-cloud",
      capabilities: ["compute", "object-storage", "private-network"],
    });

    expect(provider.id).toBe("private-openstack-a");
    expect(providerSupports(provider, "compute")).toBe(true);
    expect(providerSupports(provider, "managed-kubernetes")).toBe(false);
  });

  it("rejects provider identities that are unsafe in contracts and paths", () => {
    expect(() =>
      defineCloudProvider({
        id: "AWS/Production",
        displayName: "Unsafe provider",
        kind: "public-cloud",
        capabilities: ["compute"],
      }),
    ).toThrow(InvalidCloudProviderDescriptorError);
  });

  it("rejects duplicate capabilities instead of silently normalizing input", () => {
    expect(() =>
      defineCloudProvider({
        id: "example-cloud",
        displayName: "Example Cloud",
        kind: "public-cloud",
        capabilities: ["compute", "compute"],
      }),
    ).toThrow(InvalidCloudProviderDescriptorError);
  });
});
