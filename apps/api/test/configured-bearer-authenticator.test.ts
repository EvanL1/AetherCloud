import { describe, expect, it } from "vitest";

import { ConfiguredBearerAuthenticator } from "../src/configured-bearer-authenticator.js";

const subject = {
  token: "opaque-development-token-0001",
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  subjectId: "local-auditor",
  permissions: ["audit.event.read"],
} as const;

describe("ConfiguredBearerAuthenticator", () => {
  it("denies by default and returns configured scope only for an exact Bearer token", async () => {
    expect(
      await new ConfiguredBearerAuthenticator().authenticate({
        authorization: "Bearer opaque-development-token-0001",
      }),
    ).toMatchObject({ ok: false });

    const authenticator = new ConfiguredBearerAuthenticator(subject);
    expect(
      await authenticator.authenticate({
        authorization: "Bearer opaque-development-token-0001",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        tenantId: subject.tenantId,
        projectId: subject.projectId,
        permissions: ["audit.event.read"],
      },
    });
    expect(
      await authenticator.authenticate({
        authorization: "Bearer opaque-development-token-0002",
      }),
    ).toMatchObject({ ok: false });
  });
});
