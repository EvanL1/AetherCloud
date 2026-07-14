import { describe, expect, it } from "vitest";

import type { ProviderAdapter } from "@aether-cloud/application";
import type { CloudConnection, CloudProviderId } from "@aether-cloud/domain";

export interface ProviderAdapterConformanceOptions {
  readonly adapterName: string;
  readonly createAdapter: () => ProviderAdapter;
  readonly connection: CloudConnection;
}

function isCanonicalInstant(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function providerAdapterConformance(
  options: ProviderAdapterConformanceOptions,
): void {
  describe(`${options.adapterName} provider adapter conformance`, () => {
    it("returns provider-scoped, connection-scoped region observations", async () => {
      const adapter = options.createAdapter();

      const result = await adapter.discoverRegions({
        connection: options.connection,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.providerId).toBe(adapter.descriptor.id);
      expect(result.value.connectionId).toBe(options.connection.id);
      expect(isCanonicalInstant(result.value.observedAt)).toBe(true);
      expect(
        new Set(result.value.regions.map((region) => region.id)).size,
      ).toBe(result.value.regions.length);
      const declaredCapabilities = new Set(adapter.descriptor.capabilities);
      expect(
        result.value.regions.every((region) =>
          region.capabilities.every((capability) =>
            declaredCapabilities.has(capability),
          ),
        ),
      ).toBe(true);
    });

    it("rejects a connection configured for another provider", async () => {
      const adapter = options.createAdapter();
      const mismatchedConnection: CloudConnection = Object.freeze({
        ...options.connection,
        providerId: "conformance-mismatch" as CloudProviderId,
      });

      const result = await adapter.discoverRegions({
        connection: mismatchedConnection,
      });

      expect(result).toEqual({
        ok: false,
        error: {
          code: "provider-configuration-invalid",
          retryable: false,
        },
      });
    });
  });
}
