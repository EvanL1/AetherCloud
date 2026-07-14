import type {
  ProviderAdapter,
  ProviderRegionDiscoveryRequest,
  ProviderRegionDiscoveryResult,
} from "@aether-cloud/application";
import type {
  CloudProviderDescriptor,
  ProviderRegion,
} from "@aether-cloud/domain";

export interface MemoryProviderAdapterOptions {
  readonly descriptor: CloudProviderDescriptor;
  readonly observedAt: () => string;
  readonly regions: readonly ProviderRegion[];
}

export class MemoryProviderAdapter implements ProviderAdapter {
  readonly descriptor: CloudProviderDescriptor;
  readonly #observedAt: () => string;
  readonly #regions: readonly ProviderRegion[];

  constructor(options: MemoryProviderAdapterOptions) {
    this.descriptor = options.descriptor;
    this.#observedAt = options.observedAt;
    this.#regions = Object.freeze([...options.regions]);
  }

  async discoverRegions(
    request: ProviderRegionDiscoveryRequest,
  ): Promise<ProviderRegionDiscoveryResult> {
    if (request.connection.providerId !== this.descriptor.id) {
      return Object.freeze({
        ok: false,
        error: Object.freeze({
          code: "provider-configuration-invalid",
          retryable: false,
        }),
      });
    }

    return Promise.resolve(
      Object.freeze({
        ok: true,
        value: Object.freeze({
          providerId: this.descriptor.id,
          connectionId: request.connection.id,
          observedAt: this.#observedAt(),
          regions: this.#regions,
        }),
      }),
    );
  }
}
