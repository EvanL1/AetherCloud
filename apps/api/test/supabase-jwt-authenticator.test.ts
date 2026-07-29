import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { SupabaseJwtAuthenticator } from "../src/supabase-jwt-authenticator.js";

const issuer = "https://exampleproject.supabase.co/auth/v1";
const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";

let privateKey: CryptoKey;
let keyResolver: JWTVerifyGetKey;

beforeAll(async () => {
  const generated = await generateKeyPair("ES256", { extractable: true });
  privateKey = generated.privateKey;
  const publicJwk = await exportJWK(generated.publicKey);
  keyResolver = createLocalJWKSet({
    keys: [{ ...publicJwk, alg: "ES256", kid: "test-key", use: "sig" }],
  });
});

async function accessToken(
  claims: Record<string, unknown> = {},
  options: Readonly<{
    audience?: string;
    expiresIn?: string;
    tokenIssuer?: string;
  }> = {},
): Promise<string> {
  return new SignJWT({
    role: "authenticated",
    app_metadata: {
      aethercloud_tenant_id: tenantId,
      aethercloud_project_id: projectId,
      aethercloud_permissions: ["audit.event.read"],
    },
    ...claims,
  })
    .setProtectedHeader({ alg: "ES256", kid: "test-key", typ: "JWT" })
    .setIssuer(options.tokenIssuer ?? issuer)
    .setAudience(options.audience ?? "authenticated")
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "5m")
    .sign(privateKey);
}

function authenticator(): SupabaseJwtAuthenticator {
  return new SupabaseJwtAuthenticator({ issuer }, keyResolver);
}

describe("Supabase JWT authenticator", () => {
  it("verifies an ES256 access token and maps only trusted app metadata", async () => {
    const token = await accessToken({
      user_metadata: {
        aethercloud_tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        aethercloud_permissions: ["platform.admin"],
      },
    });

    const result = await authenticator().authenticate({
      authorization: `Bearer ${token}`,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        tenantId,
        projectId,
        subjectId: `user:${userId}`,
        permissions: ["audit.event.read"],
      },
    });
  });

  it.each([
    ["missing header", undefined],
    ["wrong scheme", "Basic credentials"],
    ["malformed token", "Bearer not-a-jwt"],
  ])("rejects %s", async (_name, authorization) => {
    await expect(
      authenticator().authenticate({ authorization }),
    ).resolves.toEqual({
      ok: false,
      failure: { code: "unauthenticated" },
    });
  });

  it("rejects the wrong issuer, audience, and expired tokens", async () => {
    const tokens = await Promise.all([
      accessToken({}, { tokenIssuer: "https://attacker.example/auth/v1" }),
      accessToken({}, { audience: "service_role" }),
      accessToken({}, { expiresIn: "-10s" }),
    ]);

    for (const token of tokens) {
      await expect(
        authenticator().authenticate({ authorization: `Bearer ${token}` }),
      ).resolves.toEqual({
        ok: false,
        failure: { code: "unauthenticated" },
      });
    }
  });

  it.each([
    ["missing metadata", { app_metadata: undefined }],
    [
      "user metadata only",
      {
        app_metadata: {},
        user_metadata: {
          aethercloud_tenant_id: tenantId,
          aethercloud_project_id: projectId,
          aethercloud_permissions: ["audit.event.read"],
        },
      },
    ],
    [
      "invalid tenant",
      {
        app_metadata: {
          aethercloud_tenant_id: "not-a-uuid",
          aethercloud_project_id: projectId,
          aethercloud_permissions: ["audit.event.read"],
        },
      },
    ],
    [
      "invalid permissions",
      {
        app_metadata: {
          aethercloud_tenant_id: tenantId,
          aethercloud_project_id: projectId,
          aethercloud_permissions: [""],
        },
      },
    ],
  ])("rejects %s", async (_name, claims) => {
    const token = await accessToken(claims);

    await expect(
      authenticator().authenticate({ authorization: `Bearer ${token}` }),
    ).resolves.toEqual({
      ok: false,
      failure: { code: "unauthenticated" },
    });
  });

  it("rejects an issuer that is not a hosted Supabase Auth issuer", () => {
    expect(
      () =>
        new SupabaseJwtAuthenticator({
          issuer: "https://attacker.example/auth/v1",
        }),
    ).toThrow(/hosted Supabase Auth issuer/);
  });
});
