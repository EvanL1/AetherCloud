import type { CloudProviderDescriptor } from "@aether-cloud/domain";

export class DuplicateCloudProviderError extends Error {
  readonly code = "duplicate-cloud-provider";

  constructor(providerId: string) {
    super(`multiple provider adapters declared id: ${providerId}`);
    this.name = "DuplicateCloudProviderError";
  }
}

export class ProviderCatalog {
  readonly #providers: ReadonlyMap<string, CloudProviderDescriptor>;

  constructor(providers: readonly CloudProviderDescriptor[]) {
    const byId = new Map<string, CloudProviderDescriptor>();
    for (const provider of providers) {
      if (byId.has(provider.id)) {
        throw new DuplicateCloudProviderError(provider.id);
      }
      byId.set(provider.id, provider);
    }
    this.#providers = byId;
  }

  list(): readonly CloudProviderDescriptor[] {
    return [...this.#providers.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  find(providerId: string): CloudProviderDescriptor | undefined {
    return this.#providers.get(providerId);
  }
}
