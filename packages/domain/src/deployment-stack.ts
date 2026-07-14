import type { CloudConnection, CloudConnectionId } from "./cloud-connection.js";
import type { CloudProviderId } from "./cloud-provider.js";
import {
  InvalidDomainValueError,
  parseUtcInstant,
} from "./resource-identities.js";
import type { ProjectId, TenantId, UtcInstant } from "./resource-identities.js";
import type { ProviderRegion } from "./provider-region.js";

const deploymentStackIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const stateBackendReferencePattern =
  /^state-backend:\/\/[a-zA-Z0-9][a-zA-Z0-9._~:/-]{2,493}$/;

declare const deploymentStackIdBrand: unique symbol;
export type DeploymentStackId = string & {
  readonly [deploymentStackIdBrand]: true;
};

export interface DeploymentStackStateBinding {
  readonly backendReference: string;
  readonly key: string;
  readonly locking: "required";
  readonly encryption: "required";
}

export interface DeploymentStack {
  readonly id: DeploymentStackId;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly connectionId: CloudConnectionId;
  readonly providerId: CloudProviderId;
  readonly displayName: string;
  readonly primaryRegionId: string;
  readonly placementObservedAt: UtcInstant;
  readonly state: DeploymentStackStateBinding;
}

export interface DeploymentStackRegionPlacement {
  readonly providerId: CloudProviderId;
  readonly connectionId: CloudConnectionId;
  readonly observedAt: string;
  readonly region: ProviderRegion;
}

export interface DeploymentStackInput {
  readonly id: string;
  readonly connection: CloudConnection;
  readonly displayName: string;
  readonly primaryRegion: DeploymentStackRegionPlacement;
  readonly stateBackendReference: string;
}

export class InvalidDeploymentStackError extends Error {
  readonly code = "invalid-deployment-stack";

  constructor(message: string) {
    super(message);
    this.name = "InvalidDeploymentStackError";
  }
}

export function parseDeploymentStackId(input: unknown): DeploymentStackId {
  if (typeof input !== "string" || !deploymentStackIdPattern.test(input)) {
    throw new InvalidDeploymentStackError(
      "deployment stack id must be a lowercase UUID",
    );
  }
  return input as DeploymentStackId;
}

export function defineDeploymentStack(
  input: DeploymentStackInput,
): DeploymentStack {
  const id = parseDeploymentStackId(input.id);
  if (input.connection.status !== "active") {
    throw new InvalidDeploymentStackError(
      "deployment stack requires an active Cloud Connection",
    );
  }
  if (
    input.primaryRegion.providerId !== input.connection.providerId ||
    input.primaryRegion.connectionId !== input.connection.id
  ) {
    throw new InvalidDeploymentStackError(
      "deployment stack placement must match its Cloud Connection",
    );
  }
  if (input.primaryRegion.region.availability !== "available") {
    throw new InvalidDeploymentStackError(
      "deployment stack primary region must be observed as available",
    );
  }
  let placementObservedAt: UtcInstant;
  try {
    placementObservedAt = parseUtcInstant(input.primaryRegion.observedAt);
  } catch (error: unknown) {
    if (error instanceof InvalidDomainValueError) {
      throw new InvalidDeploymentStackError(
        "deployment stack placement must have canonical observation time",
      );
    }
    throw error;
  }

  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 128) {
    throw new InvalidDeploymentStackError(
      "deployment stack display name must contain 1 to 128 characters",
    );
  }
  if (!stateBackendReferencePattern.test(input.stateBackendReference)) {
    throw new InvalidDeploymentStackError(
      "State backend must be a remote reference without credentials",
    );
  }

  const state = Object.freeze({
    backendReference: input.stateBackendReference,
    key: [
      "tenants",
      input.connection.tenantId,
      "projects",
      input.connection.projectId,
      "connections",
      input.connection.id,
      "stacks",
      id,
    ].join("/"),
    locking: "required" as const,
    encryption: "required" as const,
  });

  return Object.freeze({
    id,
    tenantId: input.connection.tenantId,
    projectId: input.connection.projectId,
    connectionId: input.connection.id,
    providerId: input.connection.providerId,
    displayName,
    primaryRegionId: input.primaryRegion.region.id,
    placementObservedAt,
    state,
  });
}
