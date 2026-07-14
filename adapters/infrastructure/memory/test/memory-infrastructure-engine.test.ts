import { infrastructureEngineConformance } from "@aether-cloud/infrastructure-conformance";
import { describe, expect, it } from "vitest";
import type { InfrastructurePlanRecord } from "@aether-cloud/application";
import {
  defineCloudConnection,
  defineCloudProvider,
  defineDeploymentStack,
  defineProviderRegion,
  parseInfrastructurePlanId,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";

import {
  InMemoryInfrastructurePlanRepository,
  MemoryInfrastructureEngine,
} from "../src/index.js";

const provider = defineCloudProvider({
  id: "fixture-cloud",
  displayName: "Fixture Cloud",
  kind: "private-cloud",
  capabilities: ["compute", "private-network"],
});
const connection = defineCloudConnection({
  id: "018f6f89-4368-7c3a-b7f1-a9f2da491103",
  tenantId: "018f6f89-4368-7c3a-b7f1-a9f2da491101",
  projectId: "018f6f89-4368-7c3a-b7f1-a9f2da491102",
  providerId: provider.id,
  displayName: "Fixture connection",
  providerScope: "fixture-scope",
  credentialSource: {
    kind: "workload-identity",
    reference: "workload-identity://aether-cloud/providers/fixture-cloud",
  },
  status: "active",
});
const region = defineProviderRegion({
  id: "fixture-region",
  displayName: "Fixture Region",
  availability: "available",
  capabilities: ["compute", "private-network"],
  zones: ["fixture-zone-a"],
});
const stack = defineDeploymentStack({
  id: "018f6f89-4368-7c3a-b7f1-a9f2da491104",
  connection,
  displayName: "Fixture Stack",
  primaryRegion: {
    providerId: provider.id,
    connectionId: connection.id,
    observedAt: "2026-07-14T12:00:00.000Z",
    region,
  },
  stateBackendReference: "state-backend://aether-cloud/fixture-backend",
});

infrastructureEngineConformance({
  engineName: "MemoryInfrastructureEngine",
  createEngine: () =>
    new MemoryInfrastructureEngine({
      descriptor: { kind: "opentofu", version: "1.10.0" },
      artifactDigest: `sha256:${"c".repeat(64)}`,
      jsonFormatVersion: "1.2",
      resourceChanges: [
        {
          address: "fixture_compute.edge",
          providerResourceType: "fixture_compute",
          actions: ["create"],
        },
      ],
    }),
  request: {
    planId: parseInfrastructurePlanId("018f6f89-4368-7c3a-b7f1-a9f2da491105"),
    stack,
    module: {
      reference: "module://aether-cloud/fixture-cloud/data-plane",
      version: "1.0.0",
      digest: `sha256:${"a".repeat(64)}`,
    },
    topology: {
      reference: "topology://fixtures/data-plane/revision-1",
      digest: `sha256:${"b".repeat(64)}`,
    },
  },
});

const planRecord: InfrastructurePlanRecord = {
  planId: parseInfrastructurePlanId("018f6f89-4368-7c3a-b7f1-a9f2da491105"),
  requestId: "plan-request-001",
  subjectId: "operator:fixture",
  tenantId: stack.tenantId,
  projectId: stack.projectId,
  stackId: stack.id,
  connectionId: stack.connectionId,
  providerId: stack.providerId,
  engine: { kind: "opentofu", version: "1.10.0" },
  module: {
    reference: "module://aether-cloud/fixture-cloud/data-plane",
    version: "1.0.0",
    digest: `sha256:${"a".repeat(64)}`,
  },
  topology: {
    reference: "topology://fixtures/data-plane/revision-1",
    digest: `sha256:${"b".repeat(64)}`,
  },
  createdAt: parseUtcInstant("2026-07-14T12:00:00.000Z"),
  jsonFormatVersion: "1.2",
  artifact: {
    reference: "plan-artifact://memory/fixture-plan",
    digest: `sha256:${"c".repeat(64)}`,
    protection: "encrypted",
    sensitivity: "contains-sensitive-values",
  },
  stateLock: {
    stateKey: stack.state.key,
    outcome: "acquired-and-released",
  },
  changes: { create: 1, update: 0, delete: 0, replace: 0, read: 0 },
  policy: {
    decision: "allow",
    policyVersion: "infrastructure-plan/v1",
    reasons: [],
  },
  status: "policy-approved",
  approval: "not-requested",
};

describe("in-memory infrastructure Plan repository", () => {
  it("inserts once and replays within the same tenant and project scope", async () => {
    const repository = new InMemoryInfrastructurePlanRepository();

    await expect(repository.insert(planRecord)).resolves.toBe("inserted");
    await expect(repository.insert(planRecord)).resolves.toBe("already-exists");
    await expect(
      repository.findByRequest(planRecord, planRecord.requestId),
    ).resolves.toBe(planRecord);
  });

  it("does not disclose a request across tenant scope", async () => {
    const repository = new InMemoryInfrastructurePlanRepository();
    await repository.insert(planRecord);

    await expect(
      repository.findByRequest(
        {
          tenantId: parseTenantId("018f6f89-4368-7c3a-b7f1-a9f2da491198"),
          projectId: planRecord.projectId,
        },
        planRecord.requestId,
      ),
    ).resolves.toBeUndefined();
  });
});
