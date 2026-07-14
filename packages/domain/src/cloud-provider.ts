const providerIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const capabilityIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export type CloudProviderKind =
  | "on-premises"
  | "private-cloud"
  | "public-cloud"
  | "sovereign-cloud";

export type CoreCloudCapability =
  | "compute"
  | "iot-ingress"
  | "managed-kubernetes"
  | "object-storage"
  | "private-network";

export type CloudCapability = CoreCloudCapability | `${string}.${string}`;

declare const cloudProviderIdBrand: unique symbol;
export type CloudProviderId = string & {
  readonly [cloudProviderIdBrand]: true;
};

export interface CloudProviderDescriptor {
  readonly id: CloudProviderId;
  readonly displayName: string;
  readonly kind: CloudProviderKind;
  readonly capabilities: readonly CloudCapability[];
}

export interface CloudProviderDescriptorInput {
  readonly id: string;
  readonly displayName: string;
  readonly kind: CloudProviderKind;
  readonly capabilities: readonly CloudCapability[];
}

export class InvalidCloudProviderDescriptorError extends Error {
  readonly code = "invalid-cloud-provider-descriptor";

  constructor(message: string) {
    super(message);
    this.name = "InvalidCloudProviderDescriptorError";
  }
}

export function defineCloudProvider(
  input: CloudProviderDescriptorInput,
): CloudProviderDescriptor {
  if (!providerIdPattern.test(input.id) || input.id.length > 63) {
    throw new InvalidCloudProviderDescriptorError(
      "provider id must be a lowercase, hyphen-separated identifier",
    );
  }
  if (input.displayName.trim().length === 0) {
    throw new InvalidCloudProviderDescriptorError(
      "provider display name must not be empty",
    );
  }
  if (input.capabilities.length === 0) {
    throw new InvalidCloudProviderDescriptorError(
      "provider must declare at least one capability",
    );
  }

  const capabilities = [...input.capabilities];
  const uniqueCapabilities = new Set(capabilities);
  if (
    uniqueCapabilities.size !== capabilities.length ||
    capabilities.some((capability) => !capabilityIdPattern.test(capability))
  ) {
    throw new InvalidCloudProviderDescriptorError(
      "provider capabilities must be unique, lowercase identifiers",
    );
  }

  return Object.freeze({
    id: input.id as CloudProviderId,
    displayName: input.displayName.trim(),
    kind: input.kind,
    capabilities: Object.freeze(capabilities),
  });
}

export function providerSupports(
  provider: CloudProviderDescriptor,
  capability: CloudCapability,
): boolean {
  return provider.capabilities.includes(capability);
}

export function isCloudCapabilityId(value: string): value is CloudCapability {
  return capabilityIdPattern.test(value);
}
