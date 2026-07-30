import { describe, expect, it } from "vitest";

import { NodeEnrollmentTokenService } from "../src/node-enrollment-token-service.js";

describe("NodeEnrollmentTokenService", () => {
  it("issues high-entropy tokens and compares only their digests", async () => {
    const service = new NodeEnrollmentTokenService();
    const issued = await service.issue();

    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.value.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.value.tokenDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await service.matches(issued.value.token, issued.value.tokenDigest),
    ).toBe(true);
    expect(
      await service.matches("x".repeat(43), issued.value.tokenDigest),
    ).toBe(false);
  });
});
