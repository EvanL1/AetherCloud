import {
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
} from "@aether-cloud/domain";

import type { GatewayCredentialAssertion } from "@aether-cloud/application";
import type { InMemoryGatewayCredentialRecord } from "@aether-cloud/cloudlink-memory-adapter";

const trustedGatewayCredentialsVariable =
  "AETHER_CLOUD_CLOUDLINK_TRUSTED_GATEWAY_CREDENTIALS";

const credentialFields = [
  "gatewayId",
  "credentialId",
  "generation",
  "proof",
] as const;
const maximumCredentials = 64;
/**
 * The CloudLink bridge bounds a trusted connector proof at 4096 UTF-16 code
 * units. This decoder bounds UTF-8 bytes instead, which is never weaker.
 */
const maximumProofBytes = 4096;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** `credentialId` in `contracts/cloudlink/v1/envelope.schema.json`. */
const credentialIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const maximumCredentialIdLength = 256;
const canonicalUint64Pattern = /^(?:0|[1-9][0-9]*)$/;
const maximumUint64 = 18_446_744_073_709_551_615n;
const shapeMessage = `${trustedGatewayCredentialsVariable} entries must declare exactly gatewayId, credentialId, generation, and proof`;

export interface TrustedGatewayCredential {
  readonly gatewayId: string;
  readonly credentialId: string;
  readonly generation: string;
  readonly proof: string;
}

export type TrustedConnectorCredentialResult =
  | Readonly<{
      ok: true;
      /** The bridge requires exactly these two keys and no others. */
      value: Readonly<{ credentialId: string; proof: string }>;
    }>
  | Readonly<{
      ok: false;
      failure: Readonly<{
        code: "invalid-gateway-credential";
        message: string;
      }>;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialField(
  entry: Record<string, unknown>,
  field: string,
): string {
  const value = entry[field];
  if (typeof value !== "string") throw new Error(shapeMessage);
  return value;
}

/**
 * Bounds and escapes a wire identifier before it can reach a log line. The
 * bound matches the longest `credentialId` the envelope schema permits, so a
 * legitimate identifier is always reproduced whole: a truncated one is exactly
 * what an operator needs to find the mismatched entry. Envelope decoding
 * already rejects anything outside the contract charset before this runs, so
 * the escaping is defence in depth rather than the only guard.
 */
function safeIdentifier(value: string): string {
  return JSON.stringify(value.slice(0, maximumCredentialIdLength));
}

/**
 * Decodes operator-supplied trusted connector credentials. Every rejection
 * names the environment variable and never reproduces any configured value,
 * because the `proof` of each entry is a long-lived secret.
 */
export function decodeTrustedGatewayCredentials(
  environment: NodeJS.ProcessEnv,
): readonly TrustedGatewayCredential[] {
  const raw = environment[trustedGatewayCredentialsVariable];
  if (raw === undefined || raw.length === 0) {
    throw new Error(`${trustedGatewayCredentialsVariable} is required`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(
      `${trustedGatewayCredentialsVariable} must be a JSON array`,
    );
  }
  if (!Array.isArray(decoded)) {
    throw new Error(
      `${trustedGatewayCredentialsVariable} must be a JSON array`,
    );
  }
  if (decoded.length === 0 || decoded.length > maximumCredentials) {
    throw new Error(
      `${trustedGatewayCredentialsVariable} must declare 1-${String(maximumCredentials)} Gateway credentials`,
    );
  }
  const credentialIds = new Set<string>();
  return Object.freeze(
    decoded.map((entry) => {
      if (
        !isRecord(entry) ||
        Object.keys(entry).length !== credentialFields.length ||
        !credentialFields.every((field) =>
          Object.prototype.hasOwnProperty.call(entry, field),
        )
      ) {
        throw new Error(shapeMessage);
      }
      const gatewayId = credentialField(entry, "gatewayId");
      const credentialId = credentialField(entry, "credentialId");
      const generation = credentialField(entry, "generation");
      const proof = credentialField(entry, "proof");
      if (!canonicalUuidPattern.test(gatewayId)) {
        throw new Error(
          `${trustedGatewayCredentialsVariable} gatewayId must be a canonical lowercase UUID`,
        );
      }
      // A credentialId outside the contract charset would seed the verifier and
      // start cleanly, then be rejected at envelope decode on every hello.
      if (
        credentialId.length > maximumCredentialIdLength ||
        !credentialIdPattern.test(credentialId)
      ) {
        throw new Error(
          `${trustedGatewayCredentialsVariable} credentialId must be 1-${String(maximumCredentialIdLength)} characters matching ${credentialIdPattern.source}`,
        );
      }
      if (credentialIds.has(credentialId)) {
        throw new Error(
          `${trustedGatewayCredentialsVariable} credentialId values must be unique`,
        );
      }
      credentialIds.add(credentialId);
      if (
        !canonicalUint64Pattern.test(generation) ||
        BigInt(generation) > maximumUint64
      ) {
        throw new Error(
          `${trustedGatewayCredentialsVariable} generation must be a canonical uint64 string`,
        );
      }
      if (
        proof.length === 0 ||
        Buffer.byteLength(proof, "utf8") > maximumProofBytes
      ) {
        throw new Error(
          `${trustedGatewayCredentialsVariable} proof must be 1-${String(maximumProofBytes)} bytes`,
        );
      }
      return Object.freeze({ gatewayId, credentialId, generation, proof });
    }),
  );
}

export function trustedGatewayCredentialRecords(
  credentials: readonly TrustedGatewayCredential[],
  tenantId: string,
  projectId: string,
): readonly InMemoryGatewayCredentialRecord[] {
  return credentials.map((credential) => ({
    assertion: {
      credentialId: credential.credentialId,
      proof: credential.proof,
    },
    binding: {
      tenantId: parseTenantId(tenantId),
      projectId: parseProjectId(projectId),
      gatewayId: parseGatewayId(credential.gatewayId),
      generation: parseGatewayCredentialGeneration(credential.generation),
      status: "active",
    },
  }));
}

/**
 * Resolves the operator-configured attestation for a `session-hello` whose
 * origin model is not Gateway-signed. Publisher authorization itself is the
 * Broker's ACL, exactly as ADR-0014 decision 5 permits for a reviewed trusted
 * connector; this resolver only produces the credential the operator bound to
 * that Gateway out of band.
 */
export class ConfiguredTrustedConnectorCredentials {
  readonly #credentials: ReadonlyMap<string, GatewayCredentialAssertion>;
  readonly #report: ((message: string) => void) | undefined;

  constructor(
    credentials: readonly TrustedGatewayCredential[],
    report?: (message: string) => void,
  ) {
    this.#credentials = new Map(
      credentials.map((credential) => [
        `${credential.gatewayId}\0${credential.credentialId}\0${credential.generation}`,
        Object.freeze({
          credentialId: credential.credentialId,
          proof: credential.proof,
        }),
      ]),
    );
    this.#report = report;
  }

  execute(input: unknown): Promise<TrustedConnectorCredentialResult> {
    const requested = this.#requested(input);
    const credential =
      requested === undefined
        ? undefined
        : this.#credentials.get(
            `${requested.gatewayId}\0${requested.credentialId}\0${requested.credentialGeneration}`,
          );
    if (credential !== undefined) {
      return Promise.resolve({ ok: true, value: credential });
    }
    // The identifiers are non-secret; only `proof` is a secret. Naming them is
    // what lets an operator find the mismatched entry among many bindings.
    const detail =
      requested === undefined
        ? "the session hello carried no usable credential binding"
        : `gatewayId ${safeIdentifier(requested.gatewayId)}, credentialId ${safeIdentifier(requested.credentialId)}, generation ${safeIdentifier(requested.credentialGeneration)}`;
    this.#report?.(`no trusted connector credential is configured: ${detail}`);
    return Promise.resolve({
      ok: false,
      failure: {
        code: "invalid-gateway-credential",
        message: `no trusted connector credential is configured for ${detail}`,
      },
    });
  }

  /** The lookup key comes straight off the wire and is never trusted. */
  #requested(input: unknown):
    | Readonly<{
        gatewayId: string;
        credentialId: string;
        credentialGeneration: string;
      }>
    | undefined {
    if (!isRecord(input)) return undefined;
    const { gatewayId, credentialId, credentialGeneration } = input;
    return typeof gatewayId === "string" &&
      typeof credentialId === "string" &&
      typeof credentialGeneration === "string"
      ? { gatewayId, credentialId, credentialGeneration }
      : undefined;
  }
}
