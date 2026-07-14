import { describe, expect, it } from "vitest";

import {
  InvalidProviderRegionError,
  defineProviderRegion,
  type ProviderRegionAvailability,
} from "../src/index.js";

describe("provider region observation", () => {
  it("preserves portable and provider-specific capabilities", () => {
    const region = defineProviderRegion({
      id: "region-one",
      displayName: "Region One",
      availability: "available",
      capabilities: ["compute", "openstack-a.edge-accelerator"],
      zones: ["zone-a", "zone-b"],
    });

    expect(region).toEqual({
      id: "region-one",
      displayName: "Region One",
      availability: "available",
      capabilities: ["compute", "openstack-a.edge-accelerator"],
      zones: ["zone-a", "zone-b"],
    });
    expect(Object.isFrozen(region.capabilities)).toBe(true);
    expect(Object.isFrozen(region.zones)).toBe(true);
  });

  it("rejects duplicate provider-native zone identifiers", () => {
    expect(() =>
      defineProviderRegion({
        id: "region-one",
        displayName: "Region One",
        availability: "available",
        capabilities: ["compute"],
        zones: ["zone-a", "zone-a"],
      }),
    ).toThrow(InvalidProviderRegionError);
  });

  it.each([
    {
      id: "invalid region",
      displayName: "Invalid region",
      capabilities: ["compute"],
    },
    { id: "region-one", displayName: "", capabilities: ["compute"] },
    {
      id: "region-one",
      displayName: "Region One",
      capabilities: ["compute", "compute"],
    },
  ])("rejects malformed region metadata", (metadata) => {
    expect(() =>
      defineProviderRegion({
        ...metadata,
        availability: "available",
        capabilities: metadata.capabilities as readonly "compute"[],
        zones: [],
      }),
    ).toThrow(InvalidProviderRegionError);
  });

  it("runtime-validates the availability discriminator", () => {
    expect(() =>
      defineProviderRegion({
        id: "region-one",
        displayName: "Region One",
        availability: "sometimes" as ProviderRegionAvailability,
        capabilities: ["compute"],
        zones: [],
      }),
    ).toThrow(InvalidProviderRegionError);
  });
});
