import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type {
  EnrollmentTokenService,
  IssueEnrollmentTokenResult,
  IssuedEnrollmentToken,
} from "@aether-cloud/application";
import {
  parseEnrollmentClaimId,
  parseEnrollmentTokenDigest,
} from "@aether-cloud/domain";

function digest(token: string): IssuedEnrollmentToken["tokenDigest"] {
  return parseEnrollmentTokenDigest(
    createHash("sha256").update(token, "utf8").digest("hex"),
  );
}

/** Stateless CSPRNG-backed Enrollment Token service for production composition. */
export class NodeEnrollmentTokenService implements EnrollmentTokenService {
  issue(): Promise<IssueEnrollmentTokenResult> {
    const token = randomBytes(32).toString("base64url");
    return Promise.resolve({
      ok: true,
      value: {
        claimId: parseEnrollmentClaimId(randomUUID()),
        token,
        tokenDigest: digest(token),
      },
    });
  }

  matches(
    token: string,
    expectedDigest: IssuedEnrollmentToken["tokenDigest"],
  ): Promise<boolean> {
    const actual = Buffer.from(digest(token), "hex");
    const expected = Buffer.from(expectedDigest, "hex");
    return Promise.resolve(
      actual.length === expected.length && timingSafeEqual(actual, expected),
    );
  }
}
