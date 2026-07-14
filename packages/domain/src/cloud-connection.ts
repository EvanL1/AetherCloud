import type { CloudProviderId } from "./cloud-provider.js";
import { parseProjectId, parseTenantId } from "./resource-identities.js";
import type { ProjectId, TenantId } from "./resource-identities.js";

const resourceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const providerScopePattern = /^[^\p{Cc}\p{Zl}\p{Zp}]{1,256}$/u;
const secretReferencePattern =
  /^secret:\/\/[a-zA-Z0-9][a-zA-Z0-9._~:/-]{2,509}$/;
const workloadIdentityReferencePattern =
  /^workload-identity:\/\/[a-zA-Z0-9][a-zA-Z0-9._~:/-]{2,498}$/;

declare const cloudConnectionIdBrand: unique symbol;

export type CloudConnectionId = string & {
  readonly [cloudConnectionIdBrand]: true;
};

export type CloudConnectionStatus = "active" | "disabled";

export type CredentialSource =
  | {
      readonly kind: "secret-reference";
      readonly reference: string;
    }
  | {
      readonly kind: "workload-identity";
      readonly reference: string;
    };

export interface CredentialSourceInput {
  readonly kind: string;
  readonly reference: string;
}

export interface CloudConnection {
  readonly id: CloudConnectionId;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly providerId: CloudProviderId;
  readonly displayName: string;
  readonly providerScope: string;
  readonly credentialSource: CredentialSource;
  readonly status: CloudConnectionStatus;
}

export interface CloudConnectionInput {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly providerId: CloudProviderId;
  readonly displayName: string;
  readonly providerScope: string;
  readonly credentialSource: CredentialSourceInput;
  readonly status: string;
}

export class InvalidCloudConnectionError extends Error {
  readonly code = "invalid-cloud-connection";

  constructor(message: string) {
    super(message);
    this.name = "InvalidCloudConnectionError";
  }
}

function assertResourceId(value: string, field: string): void {
  if (!resourceIdPattern.test(value)) {
    throw new InvalidCloudConnectionError(`${field} must be a lowercase UUID`);
  }
}

export function parseCloudConnectionId(input: unknown): CloudConnectionId {
  if (typeof input !== "string") {
    throw new InvalidCloudConnectionError(
      "cloud connection id must be a lowercase UUID",
    );
  }
  assertResourceId(input, "cloud connection id");
  return input as CloudConnectionId;
}

function isCredentialReferenceValid(
  source: CredentialSourceInput,
): source is CredentialSource {
  if (source.kind === "secret-reference") {
    return secretReferencePattern.test(source.reference);
  }
  if (source.kind === "workload-identity") {
    return workloadIdentityReferencePattern.test(source.reference);
  }
  return false;
}

export function defineCloudConnection(
  input: CloudConnectionInput,
): CloudConnection {
  const id = parseCloudConnectionId(input.id);
  const tenantId = parseTenantId(input.tenantId);
  const projectId = parseProjectId(input.projectId);

  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 128) {
    throw new InvalidCloudConnectionError(
      "cloud connection display name must contain 1 to 128 characters",
    );
  }
  if (!providerScopePattern.test(input.providerScope)) {
    throw new InvalidCloudConnectionError(
      "provider scope must contain 1 to 256 printable characters",
    );
  }
  if (!isCredentialReferenceValid(input.credentialSource)) {
    throw new InvalidCloudConnectionError(
      "credential source must contain a secret or workload identity reference",
    );
  }
  if (input.status !== "active" && input.status !== "disabled") {
    throw new InvalidCloudConnectionError(
      "cloud connection status must be active or disabled",
    );
  }

  const credentialSource = Object.freeze({ ...input.credentialSource });
  return Object.freeze({
    id,
    tenantId,
    projectId,
    providerId: input.providerId,
    displayName,
    providerScope: input.providerScope,
    credentialSource,
    status: input.status,
  });
}
