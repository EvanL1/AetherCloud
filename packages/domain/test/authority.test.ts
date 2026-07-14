import { describe, expect, it } from "vitest";

import { authorityFor } from "../src/index.js";

describe("edge/cloud authority", () => {
  it.each([
    "live-point-state",
    "physical-control",
    "deterministic-automation",
  ] as const)("keeps %s authoritative at the edge", (concern) => {
    expect(authorityFor(concern)).toBe("edge");
  });

  it.each(["tenant-identity", "fleet-membership", "desired-revision"] as const)(
    "keeps %s authoritative in AetherCloud",
    (concern) => {
      expect(authorityFor(concern)).toBe("aether-cloud");
    },
  );

  it("keeps actual infrastructure state authoritative at its provider", () => {
    expect(authorityFor("actual-infrastructure-state")).toBe("provider");
  });

  it("keeps placement policy authoritative in AetherCloud", () => {
    expect(authorityFor("placement-policy")).toBe("aether-cloud");
  });
});
