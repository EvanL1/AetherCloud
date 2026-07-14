import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  InfrastructureEnginePlanRequest,
  InfrastructurePlanArtifact,
} from "@aether-cloud/application";
import {
  defineCloudConnection,
  defineCloudProvider,
  defineDeploymentStack,
  defineProviderRegion,
  parseInfrastructurePlanId,
} from "@aether-cloud/domain";

import {
  NodeOpenTofuProcessRunner,
  NodeOpenTofuWorkspaceFactory,
  OpenTofuInfrastructureEngine,
  type OpenTofuArtifactResolutionRequest,
  type OpenTofuArtifactResolver,
  type OpenTofuExecutionEvent,
  type OpenTofuExecutionObserver,
  type OpenTofuPlanArtifactStore,
  type OpenTofuPlanArtifactStoreRequest,
  type OpenTofuStateLockLease,
  type OpenTofuStateLockManager,
} from "../src/index.js";

if (process.env.AETHER_CLOUD_RUN_OPENTOFU_INTEGRATION !== "1") {
  throw new Error(
    "run this opt-in test through pnpm test:opentofu-integration",
  );
}

const roots: string[] = [];
const encoder = new TextEncoder();

function digest(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

const moduleContent = encoder.encode(
  JSON.stringify({
    terraform: { required_version: ">= 1.8.0" },
    variable: { message: { type: "string" } },
    output: { message: { value: "${var.message}", sensitive: true } },
  }),
);
const topologyContent = encoder.encode(
  JSON.stringify({ message: "integration-sensitive-value" }),
);

class FixtureArtifactResolver implements OpenTofuArtifactResolver {
  resolve(request: OpenTofuArtifactResolutionRequest) {
    return Promise.resolve({
      ok: true as const,
      value: {
        content: request.kind === "module" ? moduleContent : topologyContent,
      },
    });
  }
}

class EphemeralEncryptedPlanStore implements OpenTofuPlanArtifactStore {
  encryptedPayload: Uint8Array | undefined;

  store(request: OpenTofuPlanArtifactStoreRequest) {
    const key = randomBytes(32);
    const initializationVector = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, initializationVector);
    const ciphertext = Buffer.concat([
      cipher.update(request.content),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    this.encryptedPayload = new Uint8Array(ciphertext);
    const artifact: InfrastructurePlanArtifact = {
      reference: `plan-artifact://integration-encrypted/${request.planId}`,
      digest: request.digest,
      protection: "encrypted",
      sensitivity: "contains-sensitive-values",
    };
    return Promise.resolve({ ok: true as const, value: artifact });
  }
}

class IntegrationLockLease implements OpenTofuStateLockLease {
  released = false;

  release() {
    this.released = true;
    return Promise.resolve({ ok: true as const });
  }
}

class IntegrationLockManager implements OpenTofuStateLockManager {
  readonly lease = new IntegrationLockLease();
  stateKey: string | undefined;

  acquire(input: { readonly stateKey: string; readonly signal?: AbortSignal }) {
    this.stateKey = input.stateKey;
    return Promise.resolve({ ok: true as const, value: this.lease });
  }
}

class IntegrationObserver implements OpenTofuExecutionObserver {
  readonly events: OpenTofuExecutionEvent[] = [];

  record(event: OpenTofuExecutionEvent): void {
    this.events.push(event);
  }
}

const provider = defineCloudProvider({
  id: "integration-cloud",
  displayName: "Integration Cloud",
  kind: "private-cloud",
  capabilities: ["compute"],
});
const connection = defineCloudConnection({
  id: "018f6f89-4368-7c3a-b7f1-a9f2da491203",
  tenantId: "018f6f89-4368-7c3a-b7f1-a9f2da491201",
  projectId: "018f6f89-4368-7c3a-b7f1-a9f2da491202",
  providerId: provider.id,
  displayName: "Integration connection",
  providerScope: "local-integration-only",
  credentialSource: {
    kind: "workload-identity",
    reference: "workload-identity://aether-cloud/integration/no-credentials",
  },
  status: "active",
});
const region = defineProviderRegion({
  id: "local-integration",
  displayName: "Local integration",
  availability: "available",
  capabilities: ["compute"],
  zones: [],
});
const stack = defineDeploymentStack({
  id: "018f6f89-4368-7c3a-b7f1-a9f2da491204",
  connection,
  displayName: "OpenTofu local integration",
  primaryRegion: {
    providerId: provider.id,
    connectionId: connection.id,
    observedAt: "2026-07-14T12:00:00.000Z",
    region,
  },
  stateBackendReference:
    "state-backend://aether-cloud/integration/local-ephemeral",
});
const request: InfrastructureEnginePlanRequest = {
  planId: parseInfrastructurePlanId("018f6f89-4368-7c3a-b7f1-a9f2da491205"),
  stack,
  module: {
    reference: "module://aether-cloud/integration/plan-only",
    version: "1.0.0",
    digest: digest(moduleContent),
  },
  topology: {
    reference: "topology://integration/plan-only/revision-1",
    digest: digest(topologyContent),
  },
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("OpenTofu real CLI opt-in integration", () => {
  it("runs a saved Plan without a provider, cloud account, or durable local State", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "aether-cloud-tofu-integration-"),
    );
    roots.push(root);
    const artifactStore = new EphemeralEncryptedPlanStore();
    const stateLocks = new IntegrationLockManager();
    const observer = new IntegrationObserver();
    const created = await OpenTofuInfrastructureEngine.create({
      executable:
        process.env.AETHER_CLOUD_TOFU_BINARY ?? "/opt/homebrew/bin/tofu",
      processRunner: new NodeOpenTofuProcessRunner(),
      workspaceFactory: new NodeOpenTofuWorkspaceFactory({
        baseDirectory: root,
        maxSavedPlanBytes: 8 * 1024 * 1024,
      }),
      artifactResolver: new FixtureArtifactResolver(),
      planArtifactStore: artifactStore,
      stateLockManager: stateLocks,
      observer,
      commandEnvironment: {
        PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
        TF_IN_AUTOMATION: "1",
        CHECKPOINT_DISABLE: "1",
      },
      commandTimeoutMs: 20_000,
      stateLockTimeoutMs: 1_000,
      maxOutputBytes: 4 * 1024 * 1024,
      maxSourceArtifactBytes: 64 * 1024,
    });
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) return;

    const result = await created.value.plan(request);

    expect(created.value.descriptor.kind).toBe("opentofu");
    expect(created.value.descriptor.version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
    expect(result).toMatchObject({
      ok: true,
      value: {
        planId: request.planId,
        stackId: stack.id,
        resourceChanges: [],
        artifact: {
          protection: "encrypted",
          sensitivity: "contains-sensitive-values",
        },
      },
    });
    expect(stateLocks.stateKey).toBe(stack.state.key);
    expect(stateLocks.lease.released).toBe(true);
    expect(observer.events.map((event) => event.stage)).toEqual([
      "version",
      "init",
      "validate",
      "plan",
      "show",
    ]);
    expect(JSON.stringify(observer.events)).not.toContain(
      "integration-sensitive-value",
    );
    expect(artifactStore.encryptedPayload).toBeDefined();
    expect(
      Buffer.from(artifactStore.encryptedPayload ?? []).includes(
        Buffer.from("integration-sensitive-value"),
      ),
    ).toBe(false);
    expect(await readdir(root)).toEqual([]);
    expect("apply" in created.value).toBe(false);
  });
});
