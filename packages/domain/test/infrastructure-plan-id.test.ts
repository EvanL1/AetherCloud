import { describe, expect, it } from "vitest";

import {
  InvalidInfrastructurePlanIdError,
  parseInfrastructurePlanId,
} from "../src/index.js";

describe("infrastructure plan identity", () => {
  it("accepts a canonical server-generated identity", () => {
    expect(
      parseInfrastructurePlanId("018f6f89-4368-7c3a-b7f1-a9f2da491105"),
    ).toBe("018f6f89-4368-7c3a-b7f1-a9f2da491105");
  });

  it.each(["plan-one", "00000000-0000-0000-0000-000000000000", 42])(
    "rejects an invalid infrastructure plan identity",
    (value) => {
      expect(() => parseInfrastructurePlanId(value)).toThrow(
        InvalidInfrastructurePlanIdError,
      );
    },
  );
});
