import { createHash, timingSafeEqual } from "node:crypto";

import type {
  GatewayCredentialAssertion,
  GatewayCredentialVerificationResult,
  GatewayCredentialVerifier,
} from "@aether-cloud/application";
import type { GatewayCredentialBinding } from "@aether-cloud/domain";

export interface InMemoryGatewayCredentialRecord {
  readonly assertion: GatewayCredentialAssertion;
  readonly binding: GatewayCredentialBinding;
}

interface StoredGatewayCredential {
  readonly proofDigest: Buffer;
  readonly binding: GatewayCredentialBinding;
}

function digestProof(proof: string): Buffer {
  return createHash("sha256").update(proof, "utf8").digest();
}

export class InMemoryGatewayCredentialVerifier implements GatewayCredentialVerifier {
  readonly #credentials = new Map<string, StoredGatewayCredential>();

  constructor(records: readonly InMemoryGatewayCredentialRecord[] = []) {
    for (const record of records) {
      if (this.#credentials.has(record.assertion.credentialId)) {
        throw new Error(
          `duplicate in-memory Gateway credential ${record.assertion.credentialId}`,
        );
      }
      this.#credentials.set(
        record.assertion.credentialId,
        Object.freeze({
          proofDigest: digestProof(record.assertion.proof),
          binding: Object.freeze({ ...record.binding }),
        }),
      );
    }
  }

  verify(
    assertion: GatewayCredentialAssertion,
  ): Promise<GatewayCredentialVerificationResult> {
    const stored = this.#credentials.get(assertion.credentialId);
    const actualDigest = digestProof(assertion.proof);
    if (
      stored === undefined ||
      stored.proofDigest.length !== actualDigest.length ||
      !timingSafeEqual(stored.proofDigest, actualDigest)
    ) {
      return Promise.resolve({
        ok: false,
        failure: {
          code: "invalid-gateway-credential",
          message: "Gateway credential was rejected",
        },
      });
    }
    return Promise.resolve({ ok: true, value: stored.binding });
  }
}
