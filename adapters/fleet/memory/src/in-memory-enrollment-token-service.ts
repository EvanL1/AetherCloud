import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type {
  EnrollmentTokenService,
  IssueEnrollmentTokenInput,
  IssueEnrollmentTokenResult,
  IssuedEnrollmentToken,
} from "@aether-cloud/application";
import {
  InvalidDomainValueError,
  parseEnrollmentClaimId,
  parseEnrollmentTokenDigest,
} from "@aether-cloud/domain";

export interface InMemoryEnrollmentTokenServiceOptions {
  readonly tokenFactory?: () => string;
  readonly claimIdFactory?: () => string;
}

interface StoredTokenIssue {
  readonly input: IssueEnrollmentTokenInput;
  readonly value: IssuedEnrollmentToken;
}

function issueKey(input: IssueEnrollmentTokenInput): string {
  return `${input.tenantId}:${input.projectId}:${input.gatewayId}:${input.requestId}`;
}

function digestToken(token: string) {
  return parseEnrollmentTokenDigest(
    createHash("sha256").update(token, "utf8").digest("hex"),
  );
}

function sameIssue(
  left: IssueEnrollmentTokenInput,
  right: IssueEnrollmentTokenInput,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.gatewayId === right.gatewayId &&
    left.requestId === right.requestId &&
    left.expiresAt === right.expiresAt
  );
}

export class InMemoryEnrollmentTokenService implements EnrollmentTokenService {
  readonly #tokenFactory: () => string;
  readonly #claimIdFactory: () => string;
  readonly #issues = new Map<string, StoredTokenIssue>();

  constructor(options: InMemoryEnrollmentTokenServiceOptions = {}) {
    this.#tokenFactory =
      options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    this.#claimIdFactory = options.claimIdFactory ?? randomUUID;
  }

  issue(input: IssueEnrollmentTokenInput): Promise<IssueEnrollmentTokenResult> {
    const key = issueKey(input);
    const existing = this.#issues.get(key);
    if (existing !== undefined) {
      return Promise.resolve(
        sameIssue(existing.input, input)
          ? { ok: true, value: existing.value }
          : {
              ok: false,
              failure: {
                code: "idempotency-conflict",
                message:
                  "idempotency key was already used with a different token request",
              },
            },
      );
    }

    const token = this.#tokenFactory();
    if (token.length < 16 || token.length > 512) {
      throw new InvalidDomainValueError(
        "enrollmentToken",
        "generated enrollment token must contain 16-512 characters",
      );
    }
    const value = Object.freeze({
      claimId: parseEnrollmentClaimId(this.#claimIdFactory()),
      token,
      tokenDigest: digestToken(token),
    });
    this.#issues.set(key, Object.freeze({ input, value }));
    return Promise.resolve({ ok: true, value });
  }

  matches(
    token: string,
    expectedDigest: IssuedEnrollmentToken["tokenDigest"],
  ): Promise<boolean> {
    const actual = Buffer.from(digestToken(token), "hex");
    const expected = Buffer.from(expectedDigest, "hex");
    return Promise.resolve(
      actual.length === expected.length && timingSafeEqual(actual, expected),
    );
  }
}
