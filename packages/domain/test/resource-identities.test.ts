import { describe, expect, it } from "vitest";

import {
  InvalidDomainValueError,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "../src/index.js";

describe("IoT resource identities", () => {
  it("keeps tenant, project, and gateway identities explicit", () => {
    expect(parseTenantId("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(parseProjectId("22222222-2222-4222-8222-222222222222")).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(parseGatewayId("33333333-3333-4333-8333-333333333333")).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
  });

  it.each([
    ["tenant", "tenant-one"],
    ["project", "00000000-0000-0000-0000-000000000000"],
    ["gateway", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"],
  ])("rejects an invalid %s identity at runtime", (kind, value) => {
    const parse = {
      tenant: parseTenantId,
      project: parseProjectId,
      gateway: parseGatewayId,
    }[kind];

    expect(() => parse?.(value)).toThrow(InvalidDomainValueError);
  });

  it("accepts only canonical UTC instants", () => {
    expect(parseUtcInstant("2026-07-14T08:00:00.000Z")).toBe(
      "2026-07-14T08:00:00.000Z",
    );
    expect(() => parseUtcInstant("2026-07-14 08:00:00")).toThrow(
      InvalidDomainValueError,
    );
  });
});
