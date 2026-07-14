import { isCloudCapabilityId, type CloudCapability } from "./cloud-provider.js";

const providerLocationIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;
const providerRegionAvailabilities: ReadonlySet<string> = new Set([
  "available",
  "restricted",
  "unavailable",
  "unknown",
]);

export type ProviderRegionAvailability =
  | "available"
  | "restricted"
  | "unavailable"
  | "unknown";

export interface ProviderRegion {
  readonly id: string;
  readonly displayName: string;
  readonly availability: ProviderRegionAvailability;
  readonly capabilities: readonly CloudCapability[];
  readonly zones: readonly string[];
}

export interface ProviderRegionInput {
  readonly id: string;
  readonly displayName: string;
  readonly availability: ProviderRegionAvailability;
  readonly capabilities: readonly CloudCapability[];
  readonly zones: readonly string[];
}

export class InvalidProviderRegionError extends Error {
  readonly code = "invalid-provider-region";

  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderRegionError";
  }
}

export function defineProviderRegion(
  input: ProviderRegionInput,
): ProviderRegion {
  if (!providerLocationIdPattern.test(input.id)) {
    throw new InvalidProviderRegionError(
      "provider region id must be a portable provider-native identifier",
    );
  }
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 128) {
    throw new InvalidProviderRegionError(
      "provider region display name must contain 1 to 128 characters",
    );
  }
  if (!providerRegionAvailabilities.has(input.availability)) {
    throw new InvalidProviderRegionError(
      "provider region availability must be a known observation state",
    );
  }

  const capabilities = [...input.capabilities];
  if (
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some((capability) => !isCloudCapabilityId(capability))
  ) {
    throw new InvalidProviderRegionError(
      "provider region capabilities must be unique, lowercase identifiers",
    );
  }

  const zones = [...input.zones];
  if (
    new Set(zones).size !== zones.length ||
    zones.some((zone) => !providerLocationIdPattern.test(zone))
  ) {
    throw new InvalidProviderRegionError(
      "provider region zones must be unique provider-native identifiers",
    );
  }

  return Object.freeze({
    id: input.id,
    displayName,
    availability: input.availability,
    capabilities: Object.freeze(capabilities),
    zones: Object.freeze(zones),
  });
}
