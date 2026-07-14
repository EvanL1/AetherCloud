import {
  InvalidDomainValueError,
  claimGatewayEnrollment as claimGatewayEnrollmentInDomain,
  issueGatewayEnrollmentClaim,
  parseCredentialRequestFingerprint,
  parseEnrollmentRequestId,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  registerGatewayIdentity,
} from "@aether-cloud/domain";
import type {
  EnrollmentRequestId,
  GatewayId,
  GatewayIdentity,
  ProjectId,
  TenantId,
  UtcInstant,
} from "@aether-cloud/domain";

import {
  CLAIM_GATEWAY_ENROLLMENT_COMMAND,
  GET_GATEWAY_ENROLLMENT_QUERY,
  ISSUE_GATEWAY_ENROLLMENT_COMMAND,
  REGISTER_GATEWAY_COMMAND,
} from "./capability-definition.js";
import type {
  ApplicationClock,
  EnrollmentTokenService,
  GatewayIdentityRepository,
  GatewayScope,
} from "./gateway-identity-repository.js";

type GatewayEnrollmentFailureCode =
  | "command-expired"
  | "concurrent-modification"
  | "confirmation-required"
  | "enrollment-claim-expired"
  | "gateway-already-exists"
  | "gateway-not-found"
  | "idempotency-conflict"
  | "invalid-enrollment-token"
  | "invalid-gateway-enrollment-transition"
  | "invalid-input"
  | "permission-denied";

export interface GatewayEnrollmentApplicationFailure {
  readonly code: GatewayEnrollmentFailureCode;
  readonly message: string;
}

export type GatewayEnrollmentApplicationResult<Value> =
  | Readonly<{ ok: true; replayed: boolean; value: Value }>
  | Readonly<{ ok: false; failure: GatewayEnrollmentApplicationFailure }>;

export type GatewayEnrollmentQueryResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: GatewayEnrollmentApplicationFailure }>;

export interface GatewayEnrollmentView {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly displayName: string;
  readonly state: GatewayIdentity["enrollment"]["state"];
  readonly revision: number;
  readonly claimId?: string;
  readonly claimExpiresAt?: UtcInstant;
  readonly claimedAt?: UtcInstant;
}

interface TenantCommandContext extends GatewayScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
  readonly requestId: EnrollmentRequestId;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly confirmedAt?: UtcInstant;
}

interface EnrollmentClaimCommandContext extends GatewayScope {
  readonly requestId: EnrollmentRequestId;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

interface TenantQueryContext extends GatewayScope {
  readonly subjectId: string;
  readonly permissions: ReadonlySet<string>;
}

class InputDecodingError extends Error {}

function failure(
  code: GatewayEnrollmentFailureCode,
  message: string,
): Readonly<{ ok: false; failure: GatewayEnrollmentApplicationFailure }> {
  return { ok: false, failure: { code, message } };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function requireRecord(input: unknown, name: string): Record<string, unknown> {
  if (!isRecord(input))
    throw new InputDecodingError(`${name} must be an object`);
  return input;
}

function requireString(input: unknown, name: string, maximum = 128): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > maximum
  ) {
    throw new InputDecodingError(`${name} must be a non-empty string`);
  }
  return input;
}

function decodePermissions(input: unknown): ReadonlySet<string> {
  if (
    !Array.isArray(input) ||
    input.some((value) => typeof value !== "string")
  ) {
    throw new InputDecodingError("permissions must be an array of strings");
  }
  return new Set(input);
}

function decodeScope(record: Record<string, unknown>): GatewayScope {
  return {
    tenantId: parseTenantId(record.tenantId),
    projectId: parseProjectId(record.projectId),
  };
}

function decodeTenantCommandContext(input: unknown): TenantCommandContext {
  const record = requireRecord(input, "command context");
  const confirmation = record.confirmation;
  let confirmedAt: UtcInstant | undefined;
  if (confirmation !== undefined) {
    const confirmationRecord = requireRecord(confirmation, "confirmation");
    if (confirmationRecord.method !== "explicit") {
      throw new InputDecodingError("confirmation method must be explicit");
    }
    confirmedAt = parseUtcInstant(confirmationRecord.confirmedAt);
  }
  return {
    ...decodeScope(record),
    subjectId: requireString(record.subjectId, "subjectId"),
    permissions: decodePermissions(record.permissions),
    requestId: parseEnrollmentRequestId(record.idempotencyKey),
    issuedAt: parseUtcInstant(record.issuedAt),
    expiresAt: parseUtcInstant(record.expiresAt),
    ...(confirmedAt === undefined ? {} : { confirmedAt }),
  };
}

function decodeClaimCommandContext(
  input: unknown,
): EnrollmentClaimCommandContext {
  const record = requireRecord(input, "claim command context");
  return {
    ...decodeScope(record),
    requestId: parseEnrollmentRequestId(record.idempotencyKey),
    issuedAt: parseUtcInstant(record.issuedAt),
    expiresAt: parseUtcInstant(record.expiresAt),
  };
}

function decodeQueryContext(input: unknown): TenantQueryContext {
  const record = requireRecord(input, "query context");
  return {
    ...decodeScope(record),
    subjectId: requireString(record.subjectId, "subjectId"),
    permissions: decodePermissions(record.permissions),
  };
}

function decodeSafely<Value>(
  decoder: () => Value,
):
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; failure: GatewayEnrollmentApplicationFailure }> {
  try {
    return { ok: true, value: decoder() };
  } catch (error: unknown) {
    if (
      error instanceof InvalidDomainValueError ||
      error instanceof InputDecodingError
    ) {
      return {
        ok: false,
        failure: { code: "invalid-input", message: error.message },
      };
    }
    throw error;
  }
}

function validateCommandTime(
  context: Pick<TenantCommandContext, "expiresAt" | "issuedAt">,
  now: UtcInstant,
): GatewayEnrollmentApplicationFailure | undefined {
  if (context.expiresAt <= context.issuedAt) {
    return {
      code: "invalid-input",
      message: "command expiry must be after issue time",
    };
  }
  if (context.issuedAt > now) {
    return {
      code: "invalid-input",
      message: "command issue time is in the future",
    };
  }
  if (now >= context.expiresAt) {
    return { code: "command-expired", message: "command has expired" };
  }
  return undefined;
}

function authorize(
  context: TenantCommandContext | TenantQueryContext,
  permission: string,
): GatewayEnrollmentApplicationFailure | undefined {
  if (!context.permissions.has(permission)) {
    return {
      code: "permission-denied",
      message: `permission ${permission} is required`,
    };
  }
  return undefined;
}

function toGatewayEnrollmentView(
  gateway: GatewayIdentity,
): GatewayEnrollmentView {
  const common = {
    tenantId: gateway.tenantId,
    projectId: gateway.projectId,
    gatewayId: gateway.gatewayId,
    displayName: gateway.displayName,
    state: gateway.enrollment.state,
    revision: gateway.revision,
  };
  if (gateway.enrollment.state === "awaiting-claim") {
    return {
      ...common,
      claimId: gateway.enrollment.claim.claimId,
      claimExpiresAt: gateway.enrollment.claim.expiresAt,
    };
  }
  if (gateway.enrollment.state === "claimed") {
    return {
      ...common,
      claimId: gateway.enrollment.claimId,
      claimedAt: gateway.enrollment.claimedAt,
    };
  }
  return common;
}

function resolveExistingRegistration(
  gateway: GatewayIdentity,
  requestId: EnrollmentRequestId,
  displayName: string,
): GatewayEnrollmentApplicationResult<GatewayEnrollmentView> {
  if (
    gateway.enrollment.state === "registered" &&
    gateway.enrollment.requestId === requestId
  ) {
    if (gateway.displayName !== displayName.trim()) {
      return failure(
        "idempotency-conflict",
        "idempotency key was already used with a different request",
      );
    }
    return {
      ok: true,
      replayed: true,
      value: toGatewayEnrollmentView(gateway),
    };
  }
  return failure(
    "gateway-already-exists",
    "gateway identity already exists in this project",
  );
}

export class RegisterGateway {
  readonly #repository: GatewayIdentityRepository;
  readonly #clock: ApplicationClock;

  constructor(dependencies: {
    readonly repository: GatewayIdentityRepository;
    readonly clock: ApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<GatewayEnrollmentApplicationResult<GatewayEnrollmentView>> {
    const decoded = decodeSafely(() => {
      const context = decodeTenantCommandContext(rawContext);
      const input = requireRecord(rawInput, "register gateway input");
      return {
        context,
        gatewayId: parseGatewayId(input.gatewayId),
        displayName: requireString(input.displayName, "displayName"),
      };
    });
    if (!decoded.ok) return decoded;
    const { context, gatewayId, displayName } = decoded.value;
    const authorization = authorize(
      context,
      REGISTER_GATEWAY_COMMAND.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    const now = this.#clock.now();
    const timeFailure = validateCommandTime(context, now);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };

    const existing = await this.#repository.find(context, gatewayId);
    if (existing !== undefined) {
      return resolveExistingRegistration(
        existing,
        context.requestId,
        displayName,
      );
    }
    const gateway = registerGatewayIdentity({
      tenantId: context.tenantId,
      projectId: context.projectId,
      gatewayId,
      displayName,
      requestId: context.requestId,
      registeredAt: now,
    });
    const insert = await this.#repository.insert(gateway);
    if (insert === "already-exists") {
      const raced = await this.#repository.find(context, gatewayId);
      return raced === undefined
        ? failure("concurrent-modification", "gateway registration raced")
        : resolveExistingRegistration(raced, context.requestId, displayName);
    }
    return {
      ok: true,
      replayed: false,
      value: toGatewayEnrollmentView(gateway),
    };
  }
}

export type IssueGatewayEnrollmentValue =
  | Readonly<{
      gateway: GatewayEnrollmentView;
      enrollmentToken: string;
    }>
  | Readonly<{ gateway: GatewayEnrollmentView }>;

export class IssueGatewayEnrollment {
  readonly #repository: GatewayIdentityRepository;
  readonly #tokens: EnrollmentTokenService;
  readonly #clock: ApplicationClock;

  constructor(dependencies: {
    readonly repository: GatewayIdentityRepository;
    readonly tokens: EnrollmentTokenService;
    readonly clock: ApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#tokens = dependencies.tokens;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<GatewayEnrollmentApplicationResult<IssueGatewayEnrollmentValue>> {
    const decoded = decodeSafely(() => {
      const context = decodeTenantCommandContext(rawContext);
      const input = requireRecord(rawInput, "issue enrollment input");
      return {
        context,
        gatewayId: parseGatewayId(input.gatewayId),
        claimExpiresAt: parseUtcInstant(input.claimExpiresAt),
      };
    });
    if (!decoded.ok) return decoded;
    const { context, gatewayId, claimExpiresAt } = decoded.value;
    const authorization = authorize(
      context,
      ISSUE_GATEWAY_ENROLLMENT_COMMAND.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    if (context.confirmedAt === undefined) {
      return failure(
        "confirmation-required",
        "explicit confirmation is required",
      );
    }
    const now = this.#clock.now();
    const timeFailure = validateCommandTime(context, now);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    if (context.confirmedAt < context.issuedAt || context.confirmedAt > now) {
      return failure(
        "confirmation-required",
        "explicit confirmation time is outside the command window",
      );
    }
    if (claimExpiresAt <= now) {
      return failure(
        "invalid-input",
        "enrollment claim expiry must be in the future",
      );
    }

    const gateway = await this.#repository.find(context, gatewayId);
    if (gateway === undefined) {
      return failure("gateway-not-found", "gateway identity was not found");
    }
    if (gateway.enrollment.state === "awaiting-claim") {
      if (
        gateway.enrollment.requestId === context.requestId &&
        gateway.enrollment.claim.expiresAt === claimExpiresAt
      ) {
        return {
          ok: true,
          replayed: true,
          value: { gateway: toGatewayEnrollmentView(gateway) },
        };
      }
      return failure(
        gateway.enrollment.requestId === context.requestId
          ? "idempotency-conflict"
          : "invalid-gateway-enrollment-transition",
        "gateway already has an active enrollment claim",
      );
    }
    if (gateway.enrollment.state !== "registered") {
      return failure(
        "invalid-gateway-enrollment-transition",
        "claimed gateway requires an explicit recovery workflow",
      );
    }

    const issuedToken = await this.#tokens.issue({
      tenantId: context.tenantId,
      projectId: context.projectId,
      gatewayId,
      requestId: context.requestId,
      issuedAt: now,
      expiresAt: claimExpiresAt,
    });
    if (!issuedToken.ok) return issuedToken;
    const transition = issueGatewayEnrollmentClaim(gateway, {
      requestId: context.requestId,
      claimId: issuedToken.value.claimId,
      tokenDigest: issuedToken.value.tokenDigest,
      issuedAt: now,
      expiresAt: claimExpiresAt,
    });
    if (!transition.ok) return transition;
    const replaced = await this.#repository.replace(
      transition.value,
      gateway.revision,
    );
    if (replaced !== "replaced") {
      const raced = await this.#repository.find(context, gatewayId);
      if (
        raced?.enrollment.state === "awaiting-claim" &&
        raced.enrollment.requestId === context.requestId &&
        raced.enrollment.claim.expiresAt === claimExpiresAt
      ) {
        return {
          ok: true,
          replayed: true,
          value: { gateway: toGatewayEnrollmentView(raced) },
        };
      }
      return failure(
        "concurrent-modification",
        "gateway enrollment changed concurrently",
      );
    }
    return {
      ok: true,
      replayed: false,
      value: {
        gateway: toGatewayEnrollmentView(transition.value),
        enrollmentToken: issuedToken.value.token,
      },
    };
  }
}

export class ClaimGatewayEnrollment {
  static readonly definition = CLAIM_GATEWAY_ENROLLMENT_COMMAND;

  readonly #repository: GatewayIdentityRepository;
  readonly #tokens: EnrollmentTokenService;
  readonly #clock: ApplicationClock;

  constructor(dependencies: {
    readonly repository: GatewayIdentityRepository;
    readonly tokens: EnrollmentTokenService;
    readonly clock: ApplicationClock;
  }) {
    this.#repository = dependencies.repository;
    this.#tokens = dependencies.tokens;
    this.#clock = dependencies.clock;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<GatewayEnrollmentApplicationResult<GatewayEnrollmentView>> {
    const decoded = decodeSafely(() => {
      const context = decodeClaimCommandContext(rawContext);
      const input = requireRecord(rawInput, "claim enrollment input");
      return {
        context,
        gatewayId: parseGatewayId(input.gatewayId),
        enrollmentToken: requireString(
          input.enrollmentToken,
          "enrollmentToken",
          512,
        ),
        credentialRequestFingerprint: parseCredentialRequestFingerprint(
          input.credentialRequestFingerprint,
        ),
      };
    });
    if (!decoded.ok) return decoded;
    const {
      context,
      gatewayId,
      enrollmentToken,
      credentialRequestFingerprint,
    } = decoded.value;
    const now = this.#clock.now();
    const timeFailure = validateCommandTime(context, now);
    if (timeFailure !== undefined) return { ok: false, failure: timeFailure };
    const gateway = await this.#repository.find(context, gatewayId);
    if (
      gateway === undefined ||
      gateway.enrollment.state === "registered" ||
      !(await this.#tokens.matches(
        enrollmentToken,
        gateway.enrollment.state === "awaiting-claim"
          ? gateway.enrollment.claim.tokenDigest
          : gateway.enrollment.tokenDigest,
      ))
    ) {
      return failure(
        "invalid-enrollment-token",
        "enrollment claim was rejected",
      );
    }
    const transition = claimGatewayEnrollmentInDomain(gateway, {
      requestId: context.requestId,
      credentialRequestFingerprint,
      claimedAt: now,
    });
    if (!transition.ok) return transition;
    if (transition.replayed) {
      return {
        ok: true,
        replayed: true,
        value: toGatewayEnrollmentView(transition.value),
      };
    }
    const replaced = await this.#repository.replace(
      transition.value,
      gateway.revision,
    );
    if (replaced !== "replaced") {
      const raced = await this.#repository.find(context, gatewayId);
      if (
        raced !== undefined &&
        raced.enrollment.state === "claimed" &&
        raced.enrollment.requestId === context.requestId &&
        raced.enrollment.credentialRequestFingerprint ===
          credentialRequestFingerprint
      ) {
        return {
          ok: true,
          replayed: true,
          value: toGatewayEnrollmentView(raced),
        };
      }
      return failure(
        "concurrent-modification",
        "gateway enrollment changed concurrently",
      );
    }
    return {
      ok: true,
      replayed: false,
      value: toGatewayEnrollmentView(transition.value),
    };
  }
}

export class GetGatewayEnrollment {
  readonly #repository: GatewayIdentityRepository;

  constructor(dependencies: {
    readonly repository: GatewayIdentityRepository;
  }) {
    this.#repository = dependencies.repository;
  }

  async execute(
    rawContext: unknown,
    rawInput: unknown,
  ): Promise<GatewayEnrollmentQueryResult<GatewayEnrollmentView>> {
    const decoded = decodeSafely(() => {
      const context = decodeQueryContext(rawContext);
      const input = requireRecord(rawInput, "get gateway enrollment input");
      return { context, gatewayId: parseGatewayId(input.gatewayId) };
    });
    if (!decoded.ok) return decoded;
    const { context, gatewayId } = decoded.value;
    const authorization = authorize(
      context,
      GET_GATEWAY_ENROLLMENT_QUERY.permission,
    );
    if (authorization !== undefined)
      return { ok: false, failure: authorization };
    const gateway = await this.#repository.find(context, gatewayId);
    return gateway === undefined
      ? failure("gateway-not-found", "gateway identity was not found")
      : {
          ok: true,
          value: toGatewayEnrollmentView(gateway),
        };
  }
}
