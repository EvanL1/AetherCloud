import { providerAdapterConformance } from "@aether-cloud/provider-conformance";
import {
  defineCloudConnection,
  defineCloudProvider,
  defineProviderRegion,
} from "@aether-cloud/domain";

import { MemoryProviderAdapter } from "../src/index.js";

const descriptor = defineCloudProvider({
  id: "fixture-cloud",
  displayName: "Fixture Cloud",
  kind: "private-cloud",
  capabilities: ["compute", "private-network", "fixture-cloud.edge-zone"],
});

const connection = defineCloudConnection({
  id: "018f6f89-4368-7c3a-b7f1-a9f2da491103",
  tenantId: "018f6f89-4368-7c3a-b7f1-a9f2da491101",
  projectId: "018f6f89-4368-7c3a-b7f1-a9f2da491102",
  providerId: descriptor.id,
  displayName: "Fixture connection",
  providerScope: "fixture-scope",
  credentialSource: {
    kind: "workload-identity",
    reference: "workload-identity://aether-cloud/providers/fixture-cloud",
  },
  status: "active",
});

providerAdapterConformance({
  adapterName: "MemoryProviderAdapter",
  createAdapter: () =>
    new MemoryProviderAdapter({
      descriptor,
      observedAt: () => "2026-07-14T12:00:00.000Z",
      regions: [
        defineProviderRegion({
          id: "fixture-region",
          displayName: "Fixture Region",
          availability: "available",
          capabilities: ["compute", "private-network"],
          zones: ["fixture-zone-a"],
        }),
      ],
    }),
  connection,
});
