import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

import type {
  HttpAuthenticatedSubject,
  HttpAuthenticationResult,
  HttpAuthenticator,
} from "./app.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const permissionPattern = /^[a-z][a-z0-9]*(?:[.:_-][a-z0-9]+)*$/;

export interface SupabaseJwtAuthenticationConfiguration {
  readonly issuer: string;
}

function denied(): HttpAuthenticationResult {
  return { ok: false, failure: { code: "unauthenticated" } };
}

function hostedSupabaseIssuer(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(
      "Supabase JWT issuer must be a hosted Supabase Auth issuer",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    !/^[a-z0-9]{8,64}\.supabase\.co$/.test(parsed.hostname) ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/auth/v1" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "Supabase JWT issuer must be a hosted Supabase Auth issuer",
    );
  }
  return parsed;
}

function record(input: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  return input as Readonly<Record<string, unknown>>;
}

function uuidClaim(input: unknown): string | undefined {
  return typeof input === "string" && uuidPattern.test(input)
    ? input
    : undefined;
}

function permissionsClaim(input: unknown): readonly string[] | undefined {
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) {
    return undefined;
  }
  const permissions: string[] = [];
  for (const permission of input) {
    if (
      typeof permission !== "string" ||
      permission.length > 128 ||
      !permissionPattern.test(permission) ||
      permissions.includes(permission)
    ) {
      return undefined;
    }
    permissions.push(permission);
  }
  return Object.freeze(permissions);
}

function authenticatedSubject(
  payload: JWTPayload,
): HttpAuthenticatedSubject | undefined {
  if (payload.role !== "authenticated") return undefined;
  const subjectId = uuidClaim(payload.sub);
  const metadata = record(payload.app_metadata);
  if (subjectId === undefined || metadata === undefined) return undefined;
  const tenantId = uuidClaim(metadata.aethercloud_tenant_id);
  const projectId = uuidClaim(metadata.aethercloud_project_id);
  const permissions = permissionsClaim(metadata.aethercloud_permissions);
  if (
    tenantId === undefined ||
    projectId === undefined ||
    permissions === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    tenantId,
    projectId,
    subjectId: `user:${subjectId}`,
    permissions,
  });
}

export class SupabaseJwtAuthenticator implements HttpAuthenticator {
  readonly #issuer: string;
  readonly #keyResolver: JWTVerifyGetKey;

  constructor(
    configuration: SupabaseJwtAuthenticationConfiguration,
    keyResolver?: JWTVerifyGetKey,
  ) {
    const issuer = hostedSupabaseIssuer(configuration.issuer);
    this.#issuer = issuer.href.replace(/\/$/, "");
    this.#keyResolver =
      keyResolver ??
      createRemoteJWKSet(
        new URL(`${this.#issuer}/.well-known/jwks.json`),
        Object.freeze({
          cooldownDuration: 30_000,
          timeoutDuration: 5_000,
        }),
      );
  }

  async authenticate(
    input: Readonly<{ authorization: string | undefined }>,
  ): Promise<HttpAuthenticationResult> {
    const prefix = "Bearer ";
    if (
      input.authorization === undefined ||
      !input.authorization.startsWith(prefix)
    ) {
      return denied();
    }
    const token = input.authorization.slice(prefix.length);
    if (token.length === 0 || token.length > 16_384) return denied();
    try {
      const verified = await jwtVerify(token, this.#keyResolver, {
        algorithms: ["ES256"],
        audience: "authenticated",
        clockTolerance: 5,
        issuer: this.#issuer,
        requiredClaims: ["sub", "role", "app_metadata"],
      });
      const subject = authenticatedSubject(verified.payload);
      return subject === undefined
        ? denied()
        : Object.freeze({ ok: true, value: subject });
    } catch {
      return denied();
    }
  }
}
