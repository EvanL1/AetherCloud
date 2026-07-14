import { describe, expect, it } from "vitest";

import { DuplicateCloudProviderError, ProviderCatalog } from "../src/index.js";
import { defineCloudProvider } from "@aether-cloud/domain";

describe("provider catalog", () => {
  it("registers independently developed provider adapters by descriptor", () => {
    const privateCloud = defineCloudProvider({
      id: "private-openstack-a",
      displayName: "Private OpenStack A",
      kind: "private-cloud",
      capabilities: ["compute", "private-network"],
    });
    const publicCloud = defineCloudProvider({
      id: "public-cloud-a",
      displayName: "Public Cloud A",
      kind: "public-cloud",
      capabilities: ["compute", "object-storage"],
    });

    const catalog = new ProviderCatalog([privateCloud, publicCloud]);

    expect(catalog.list().map((provider) => provider.id)).toEqual([
      "private-openstack-a",
      "public-cloud-a",
    ]);
    expect(catalog.find("private-openstack-a")).toBe(privateCloud);
  });

  it("fails closed when two adapters claim the same provider identity", () => {
    const first = defineCloudProvider({
      id: "example-cloud",
      displayName: "Example Cloud",
      kind: "public-cloud",
      capabilities: ["compute"],
    });
    const second = defineCloudProvider({
      id: "example-cloud",
      displayName: "Example Cloud Duplicate",
      kind: "public-cloud",
      capabilities: ["object-storage"],
    });

    expect(() => new ProviderCatalog([first, second])).toThrow(
      DuplicateCloudProviderError,
    );
  });
});
