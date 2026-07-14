import type {
  CloudConnection,
  CloudConnectionId,
  CloudProviderDescriptor,
  CloudProviderId,
  ProviderRegion,
} from "@aether-cloud/domain";

export type ProviderDiscoveryFailureCode =
  | "provider-authentication-failed"
  | "provider-configuration-invalid"
  | "provider-permission-denied"
  | "provider-rate-limited"
  | "provider-unavailable";

export interface ProviderDiscoveryFailure {
  readonly code: ProviderDiscoveryFailureCode;
  readonly retryable: boolean;
}

export interface ProviderRegionDiscoverySnapshot {
  readonly providerId: CloudProviderId;
  readonly connectionId: CloudConnectionId;
  readonly observedAt: string;
  readonly regions: readonly ProviderRegion[];
}

export type ProviderRegionDiscoveryResult =
  | {
      readonly ok: true;
      readonly value: ProviderRegionDiscoverySnapshot;
    }
  | {
      readonly ok: false;
      readonly error: ProviderDiscoveryFailure;
    };

export interface ProviderRegionDiscoveryRequest {
  readonly connection: CloudConnection;
}

export interface ProviderAdapter {
  readonly descriptor: CloudProviderDescriptor;

  discoverRegions(
    request: ProviderRegionDiscoveryRequest,
  ): Promise<ProviderRegionDiscoveryResult>;
}

export class DuplicateProviderAdapterError extends Error {
  readonly code = "duplicate-provider-adapter";

  constructor(providerId: string) {
    super(`multiple provider adapters declared id: ${providerId}`);
    this.name = "DuplicateProviderAdapterError";
  }
}

export class ProviderAdapterRegistry {
  readonly #adapters: ReadonlyMap<string, ProviderAdapter>;

  constructor(adapters: readonly ProviderAdapter[]) {
    const byId = new Map<string, ProviderAdapter>();
    for (const adapter of adapters) {
      if (byId.has(adapter.descriptor.id)) {
        throw new DuplicateProviderAdapterError(adapter.descriptor.id);
      }
      byId.set(adapter.descriptor.id, adapter);
    }
    this.#adapters = byId;
  }

  find(providerId: string): ProviderAdapter | undefined {
    return this.#adapters.get(providerId);
  }
}
