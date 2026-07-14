import { timingSafeEqual } from "node:crypto";

import type {
  HttpAuthenticatedSubject,
  HttpAuthenticationResult,
  HttpAuthenticator,
} from "./app.js";

export interface ConfiguredBearerSubject extends HttpAuthenticatedSubject {
  readonly token: string;
}

function denied(): HttpAuthenticationResult {
  return { ok: false, failure: { code: "unauthenticated" } };
}

function tokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export class ConfiguredBearerAuthenticator implements HttpAuthenticator {
  readonly #configuration: ConfiguredBearerSubject | undefined;

  constructor(configuration?: ConfiguredBearerSubject) {
    this.#configuration =
      configuration === undefined
        ? undefined
        : Object.freeze({
            ...configuration,
            permissions: Object.freeze([...configuration.permissions]),
          });
  }

  authenticate(
    input: Readonly<{
      authorization: string | undefined;
    }>,
  ): Promise<HttpAuthenticationResult> {
    const configuration = this.#configuration;
    const prefix = "Bearer ";
    if (
      configuration === undefined ||
      input.authorization === undefined ||
      !input.authorization.startsWith(prefix)
    ) {
      return Promise.resolve(denied());
    }
    const presented = input.authorization.slice(prefix.length);
    if (!tokensEqual(presented, configuration.token)) {
      return Promise.resolve(denied());
    }
    return Promise.resolve({
      ok: true,
      value: Object.freeze({
        tenantId: configuration.tenantId,
        projectId: configuration.projectId,
        subjectId: configuration.subjectId,
        permissions: Object.freeze([...configuration.permissions]),
      }),
    });
  }
}
