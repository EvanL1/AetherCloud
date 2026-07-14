import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { infrastructureEngineConformance } from "@aether-cloud/infrastructure-conformance";
import type {
  InfrastructureEngine,
  InfrastructureEngineFailureCode,
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
  OpenTofuInfrastructureEngine,
  type OpenTofuArtifactResolutionRequest,
  type OpenTofuArtifactResolver,
  type OpenTofuExecutionEvent,
  type OpenTofuExecutionObserver,
  type OpenTofuPlanArtifactStore,
  type OpenTofuPlanArtifactStoreRequest,
  type OpenTofuProcessRequest,
  type OpenTofuProcessResult,
  type OpenTofuProcessRunner,
  type OpenTofuStateLockLease,
  type OpenTofuStateLockManager,
  type OpenTofuWorkspace,
  type OpenTofuWorkspaceFactory,
} from "../src/index.js";

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function digest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exited(exitCode: number, stdout = ""): OpenTofuProcessResult {
  return {
    outcome: "exited",
    exitCode,
    stdout: bytes(stdout),
    stderr: bytes("sensitive stderr must never be observed"),
    durationMs: 4,
  };
}

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

const moduleContent = bytes(
  JSON.stringify({
    variable: { message: { type: "string" } },
    output: { message: { value: "${var.message}" } },
  }),
);
const topologyContent = bytes(JSON.stringify({ message: "fixture-secret" }));
const savedPlanContent = bytes("opaque saved plan with fixture-secret");
const planId = parseInfrastructurePlanId(
  "018f6f89-4368-7c3a-b7f1-a9f2da491105",
);

const request: InfrastructureEnginePlanRequest = {
  planId,
  stack,
  module: {
    reference: "module://aether-cloud/fixture-cloud/data-plane",
    version: "1.0.0",
    digest: digest(moduleContent),
  },
  topology: {
    reference: "topology://fixtures/data-plane/revision-1",
    digest: digest(topologyContent),
  },
};

const planJson = JSON.stringify({
  format_version: "1.2",
  terraform_version: "1.12.4",
  resource_changes: [
    {
      address: "fixture_compute.create",
      type: "fixture_compute",
      change: { actions: ["create"] },
    },
    {
      address: "fixture_compute.update",
      type: "fixture_compute",
      change: { actions: ["update"] },
    },
    {
      address: "fixture_compute.delete",
      type: "fixture_compute",
      change: { actions: ["delete"] },
    },
    {
      address: "fixture_compute.read",
      type: "fixture_compute",
      change: { actions: ["read"] },
    },
    {
      address: "fixture_compute.noop",
      type: "fixture_compute",
      change: { actions: ["no-op"] },
    },
    {
      address: "fixture_compute.replace",
      type: "fixture_compute",
      change: { actions: ["delete", "create"] },
    },
  ],
});

const successfulProcessResults = (): OpenTofuProcessResult[] => [
  exited(0, JSON.stringify({ terraform_version: "1.12.4" })),
  exited(0),
  exited(0, JSON.stringify({ valid: true, diagnostics: [] })),
  exited(
    2,
    `${JSON.stringify({ type: "version", ui: "1.0", tofu: "1.12.4" })}\n`,
  ),
  exited(0, planJson),
];

class ScriptedProcessRunner implements OpenTofuProcessRunner {
  readonly requests: OpenTofuProcessRequest[] = [];
  readonly #results: OpenTofuProcessResult[];

  constructor(results: readonly OpenTofuProcessResult[]) {
    this.#results = [...results];
  }

  run(requested: OpenTofuProcessRequest): Promise<OpenTofuProcessResult> {
    this.requests.push(requested);
    const result = this.#results.shift();
    if (result === undefined) {
      throw new Error("unexpected OpenTofu process invocation");
    }
    return Promise.resolve(result);
  }
}

class FakeWorkspace implements OpenTofuWorkspace {
  readonly directory = "/isolated/opentofu/plan-workspace";
  readonly savedPlanPath = `${this.directory}/aether.plan`;
  moduleWrites: Uint8Array[] = [];
  topologyWrites: Uint8Array[] = [];
  cleanupCalls = 0;
  cleanupSucceeds = true;

  writeModuleConfiguration(content: Uint8Array): Promise<void> {
    this.moduleWrites.push(content);
    return Promise.resolve();
  }

  writeTopologyVariables(content: Uint8Array): Promise<void> {
    this.topologyWrites.push(content);
    return Promise.resolve();
  }

  readSavedPlan(): Promise<Uint8Array> {
    return Promise.resolve(savedPlanContent);
  }

  cleanup(): Promise<
    Readonly<{ ok: true } | { ok: false; retryable: boolean }>
  > {
    this.cleanupCalls += 1;
    return Promise.resolve(
      this.cleanupSucceeds ? { ok: true } : { ok: false, retryable: true },
    );
  }
}

class FakeWorkspaceFactory implements OpenTofuWorkspaceFactory {
  readonly workspace: FakeWorkspace;
  createCalls = 0;
  succeeds = true;

  constructor(workspace = new FakeWorkspace()) {
    this.workspace = workspace;
  }

  create(): Promise<OpenTofuWorkspace> {
    this.createCalls += 1;
    if (!this.succeeds) {
      return Promise.reject(new Error("workspace unavailable"));
    }
    return Promise.resolve(this.workspace);
  }
}

class FakeArtifactResolver implements OpenTofuArtifactResolver {
  readonly requests: OpenTofuArtifactResolutionRequest[] = [];
  moduleBytes = moduleContent;
  topologyBytes = topologyContent;
  succeeds = true;

  resolve(requested: OpenTofuArtifactResolutionRequest) {
    this.requests.push(requested);
    if (!this.succeeds) {
      return Promise.resolve({
        ok: false as const,
        failure: { retryable: true },
      });
    }
    return Promise.resolve({
      ok: true as const,
      value: {
        content:
          requested.kind === "module" ? this.moduleBytes : this.topologyBytes,
      },
    });
  }
}

class FakePlanArtifactStore implements OpenTofuPlanArtifactStore {
  readonly requests: OpenTofuPlanArtifactStoreRequest[] = [];
  succeeds = true;
  overrideDigest: string | undefined;
  onStore: (() => void) | undefined;

  store(requested: OpenTofuPlanArtifactStoreRequest) {
    this.requests.push(requested);
    this.onStore?.();
    if (!this.succeeds) {
      return Promise.resolve({
        ok: false as const,
        failure: { retryable: true },
      });
    }
    const artifact: InfrastructurePlanArtifact = {
      reference: `plan-artifact://encrypted/${requested.planId}`,
      digest: this.overrideDigest ?? requested.digest,
      protection: "encrypted",
      sensitivity: "contains-sensitive-values",
    };
    return Promise.resolve({ ok: true as const, value: artifact });
  }
}

class FakeStateLockLease implements OpenTofuStateLockLease {
  releaseCalls = 0;
  releases = true;

  release() {
    this.releaseCalls += 1;
    return Promise.resolve(
      this.releases
        ? ({ ok: true } as const)
        : ({ ok: false, retryable: true } as const),
    );
  }
}

class FakeStateLockManager implements OpenTofuStateLockManager {
  readonly lease = new FakeStateLockLease();
  acquiredStateKeys: string[] = [];
  succeeds = true;
  throws = false;

  acquire(input: { readonly stateKey: string; readonly signal?: AbortSignal }) {
    this.acquiredStateKeys.push(input.stateKey);
    if (this.throws) {
      return Promise.reject(new Error("lock service unavailable"));
    }
    if (!this.succeeds) {
      return Promise.resolve({
        ok: false as const,
        failure: { code: "contended" as const, retryable: true },
      });
    }
    return Promise.resolve({ ok: true as const, value: this.lease });
  }
}

class RecordingObserver implements OpenTofuExecutionObserver {
  readonly events: OpenTofuExecutionEvent[] = [];

  record(event: OpenTofuExecutionEvent): void {
    this.events.push(event);
  }
}

interface HarnessOverrides {
  readonly processResults?: readonly OpenTofuProcessResult[];
  readonly workspaceFactory?: FakeWorkspaceFactory;
  readonly artifactResolver?: FakeArtifactResolver;
  readonly artifactStore?: FakePlanArtifactStore;
  readonly stateLocks?: FakeStateLockManager;
  readonly observer?: RecordingObserver;
}

async function createHarness(overrides: HarnessOverrides = {}) {
  const runner = new ScriptedProcessRunner(
    overrides.processResults ?? successfulProcessResults(),
  );
  const workspaceFactory =
    overrides.workspaceFactory ?? new FakeWorkspaceFactory();
  const artifactResolver =
    overrides.artifactResolver ?? new FakeArtifactResolver();
  const artifactStore = overrides.artifactStore ?? new FakePlanArtifactStore();
  const stateLocks = overrides.stateLocks ?? new FakeStateLockManager();
  const observer = overrides.observer ?? new RecordingObserver();
  const commandEnvironment: Record<string, string> = {
    PATH: "/safe/bin",
    AETHER_FIXTURE_SECRET: "must-not-enter-observer-events",
  };
  const created = await OpenTofuInfrastructureEngine.create({
    executable: "tofu",
    processRunner: runner,
    workspaceFactory,
    artifactResolver,
    planArtifactStore: artifactStore,
    stateLockManager: stateLocks,
    observer,
    commandEnvironment,
    commandTimeoutMs: 10_000,
    stateLockTimeoutMs: 5_000,
    maxOutputBytes: 1_048_576,
    maxSourceArtifactBytes: 65_536,
  });
  return {
    created,
    runner,
    workspaceFactory,
    artifactResolver,
    artifactStore,
    stateLocks,
    observer,
    commandEnvironment,
  };
}

function requireEngine(
  harness: Awaited<ReturnType<typeof createHarness>>,
): Promise<InfrastructureEngine> {
  expect(harness.created).toMatchObject({ ok: true });
  if (!harness.created.ok) {
    throw new Error("expected OpenTofu engine creation to succeed");
  }
  return Promise.resolve(harness.created.value);
}

describe("OpenTofuInfrastructureEngine", () => {
  it("probes the version and executes a locked saved Plan using argv", async () => {
    const harness = await createHarness();
    const engine = await requireEngine(harness);

    const result = await engine.plan(request);

    expect(engine.descriptor).toEqual({ kind: "opentofu", version: "1.12.4" });
    expect(harness.runner.requests.map((entry) => entry.argv)).toEqual([
      ["version", "-json"],
      ["init", "-input=false", "-no-color"],
      ["validate", "-json"],
      [
        "plan",
        "-json",
        "-input=false",
        "-lock=true",
        "-lock-timeout=5000ms",
        "-detailed-exitcode",
        "-no-color",
        `-out=${harness.workspaceFactory.workspace.savedPlanPath}`,
      ],
      ["show", "-json", harness.workspaceFactory.workspace.savedPlanPath],
    ]);
    expect(
      harness.runner.requests
        .slice(1)
        .every(
          (entry) =>
            entry.workingDirectory ===
            harness.workspaceFactory.workspace.directory,
        ),
    ).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      value: {
        planId,
        stackId: stack.id,
        stateKey: stack.state.key,
        jsonFormatVersion: "1.2",
        stateLock: {
          stateKey: stack.state.key,
          outcome: "acquired-and-released",
        },
        resourceChanges: [
          { actions: ["create"] },
          { actions: ["update"] },
          { actions: ["delete"] },
          { actions: ["read"] },
          { actions: ["no-op"] },
          { actions: ["delete", "create"] },
        ],
      },
    });
    expect(harness.workspaceFactory.workspace.moduleWrites).toEqual([
      moduleContent,
    ]);
    expect(harness.workspaceFactory.workspace.topologyWrites).toEqual([
      topologyContent,
    ]);
    expect(harness.stateLocks.acquiredStateKeys).toEqual([stack.state.key]);
    expect(harness.stateLocks.lease.releaseCalls).toBe(1);
    expect(harness.workspaceFactory.workspace.cleanupCalls).toBe(1);
    expect(harness.artifactStore.requests).toEqual([
      {
        planId,
        content: savedPlanContent,
        digest: digest(savedPlanContent),
      },
    ]);
    expect(JSON.stringify(harness.observer.events)).not.toContain(
      "must-not-enter-observer-events",
    );
    expect(JSON.stringify(harness.observer.events)).not.toContain(
      "fixture-secret",
    );
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });

  it("accepts plan exit code zero as a successful empty diff", async () => {
    const processResults = successfulProcessResults();
    processResults[3] = exited(
      0,
      `${JSON.stringify({ type: "version", ui: "1.0", tofu: "1.12.4" })}\n`,
    );
    processResults[4] = exited(
      0,
      JSON.stringify({
        format_version: "1.2",
        terraform_version: "1.12.4",
        resource_changes: [],
      }),
    );
    const harness = await createHarness({ processResults });
    const engine = await requireEngine(harness);

    const result = await engine.plan(request);

    expect(result).toMatchObject({
      ok: true,
      value: { resourceChanges: [] },
    });
  });

  it("snapshots the allowed environment when the engine is created", async () => {
    const harness = await createHarness();
    const engine = await requireEngine(harness);
    harness.commandEnvironment.AETHER_FIXTURE_SECRET = "mutated-after-create";

    await engine.plan(request);

    expect(harness.runner.requests[1]?.environment).toMatchObject({
      AETHER_FIXTURE_SECRET: "must-not-enter-observer-events",
    });
  });

  it("returns a typed failure when OpenTofu is not installed", async () => {
    const harness = await createHarness({
      processResults: [{ outcome: "not-found", durationMs: 1 }],
    });

    expect(harness.created).toEqual({
      ok: false,
      failure: { code: "engine-not-installed", retryable: false },
    });
  });

  it("rejects malformed version JSON instead of hardcoding a version", async () => {
    const harness = await createHarness({
      processResults: [exited(0, "not-json")],
    });

    expect(harness.created).toEqual({
      ok: false,
      failure: { code: "engine-version-invalid", retryable: false },
    });
  });

  it.each([
    { stage: "init", index: 1, code: "engine-init-failed" },
    { stage: "validate", index: 2, code: "engine-validate-failed" },
    { stage: "plan", index: 3, code: "engine-plan-failed" },
    { stage: "show", index: 4, code: "engine-show-failed" },
  ] as const)(
    "maps a non-zero $stage exit to $code and cleans the workspace",
    async ({ index, code }) => {
      const processResults = successfulProcessResults();
      processResults[index] = exited(1);
      const harness = await createHarness({ processResults });
      const engine = await requireEngine(harness);

      const result = await engine.plan(request);

      expect(result).toEqual({
        ok: false,
        failure: { code, retryable: false },
      });
      expect(harness.workspaceFactory.workspace.cleanupCalls).toBe(1);
      expect(harness.stateLocks.lease.releaseCalls).toBe(1);
    },
  );

  it.each([
    {
      outcome: "timed-out",
      code: "engine-timeout",
      retryable: true,
    },
    {
      outcome: "cancelled",
      code: "engine-cancelled",
      retryable: true,
    },
    {
      outcome: "output-limit-exceeded",
      code: "engine-output-limit-exceeded",
      retryable: false,
    },
  ] as const)(
    "maps process outcome $outcome to a typed failure",
    async ({ outcome, code, retryable }) => {
      const processResults = successfulProcessResults();
      processResults[3] = { outcome, durationMs: 10 };
      const harness = await createHarness({ processResults });
      const engine = await requireEngine(harness);

      const result = await engine.plan(request);

      expect(result).toEqual({
        ok: false,
        failure: { code, retryable },
      });
    },
  );

  it("fails before OpenTofu when the module digest does not match", async () => {
    const artifactResolver = new FakeArtifactResolver();
    artifactResolver.moduleBytes = bytes("tampered module");
    const harness = await createHarness({ artifactResolver });
    const engine = await requireEngine(harness);

    const result = await engine.plan(request);

    expect(result).toEqual({
      ok: false,
      failure: { code: "artifact-digest-mismatch", retryable: false },
    });
    expect(harness.runner.requests).toHaveLength(1);
    expect(harness.stateLocks.acquiredStateKeys).toEqual([]);
    expect(harness.workspaceFactory.workspace.cleanupCalls).toBe(1);
  });

  it("maps artifact resolution failure without invoking OpenTofu", async () => {
    const artifactResolver = new FakeArtifactResolver();
    artifactResolver.succeeds = false;
    const harness = await createHarness({ artifactResolver });
    const engine = await requireEngine(harness);

    const result = await engine.plan(request);

    expect(result).toEqual({
      ok: false,
      failure: { code: "artifact-materialization-failed", retryable: true },
    });
    expect(harness.runner.requests).toHaveLength(1);
  });

  it("returns a typed State lock conflict without starting init", async () => {
    const stateLocks = new FakeStateLockManager();
    stateLocks.succeeds = false;
    const harness = await createHarness({ stateLocks });
    const engine = await requireEngine(harness);

    const result = await engine.plan(request);

    expect(result).toEqual({
      ok: false,
      failure: { code: "state-lock-timeout", retryable: true },
    });
    expect(harness.runner.requests).toHaveLength(1);
    expect(harness.workspaceFactory.workspace.cleanupCalls).toBe(1);
  });

  it("maps a rejected State lock dependency to State lock timeout", async () => {
    const stateLocks = new FakeStateLockManager();
    stateLocks.throws = true;
    const harness = await createHarness({ stateLocks });
    const engine = await requireEngine(harness);

    const result = await engine.plan(request);

    expect(result).toEqual({
      ok: false,
      failure: { code: "state-lock-timeout", retryable: true },
    });
  });

  it("recognizes a versioned JSON backend State lock diagnostic", async () => {
    const processResults = successfulProcessResults();
    processResults[3] = exited(
      1,
      [
        JSON.stringify({ type: "version", ui: "1.0", tofu: "1.12.4" }),
        JSON.stringify({
          type: "diagnostic",
          diagnostic: {
            severity: "error",
            summary: "Error acquiring the state lock",
            detail: "sensitive backend details",
          },
        }),
      ].join("\n"),
    );
    const harness = await createHarness({ processResults });
    const engine = await requireEngine(harness);

    const result = await engine.plan(request);

    expect(result).toEqual({
      ok: false,
      failure: { code: "state-lock-timeout", retryable: true },
    });
    expect(JSON.stringify(harness.observer.events)).not.toContain(
      "sensitive backend details",
    );
  });

  it.each([
    { json: "not-json", name: "malformed JSON" },
    {
      json: JSON.stringify({ format_version: "2.0", resource_changes: [] }),
      name: "unsupported major format",
    },
    {
      json: JSON.stringify({
        format_version: "1.2",
        resource_changes: [
          {
            address: "fixture.invalid",
            type: "fixture_invalid",
            change: { actions: ["forget"] },
          },
        ],
      }),
      name: "unknown resource action",
    },
  ])("rejects $name from tofu show", async ({ json }) => {
    const processResults = successfulProcessResults();
    processResults[4] = exited(0, json);
    const harness = await createHarness({ processResults });
    const engine = await requireEngine(harness);

    const result = await engine.plan(request);

    expect(result).toEqual({
      ok: false,
      failure: { code: "plan-json-invalid", retryable: false },
    });
  });

  it("fails closed when encrypted Plan storage fails", async () => {
    const artifactStore = new FakePlanArtifactStore();
    artifactStore.succeeds = false;
    const harness = await createHarness({ artifactStore });
    const engine = await requireEngine(harness);

    const result = await engine.plan(request);

    expect(result).toEqual({
      ok: false,
      failure: { code: "artifact-store-failed", retryable: true },
    });
  });

  it("rejects an encrypted store receipt with the wrong digest", async () => {
    const artifactStore = new FakePlanArtifactStore();
    artifactStore.overrideDigest = `sha256:${"f".repeat(64)}`;
    const harness = await createHarness({ artifactStore });
    const engine = await requireEngine(harness);

    const result = await engine.plan(request);

    expect(result).toEqual({
      ok: false,
      failure: { code: "artifact-store-failed", retryable: false },
    });
  });

  it("returns cancellation when a Plan is cancelled during artifact storage", async () => {
    const controller = new AbortController();
    const artifactStore = new FakePlanArtifactStore();
    artifactStore.onStore = () => {
      controller.abort();
    };
    const harness = await createHarness({ artifactStore });
    const engine = await requireEngine(harness);

    const result = await engine.plan({
      ...request,
      signal: controller.signal,
    });

    expect(result).toEqual({
      ok: false,
      failure: { code: "engine-cancelled", retryable: true },
    });
    expect(harness.stateLocks.lease.releaseCalls).toBe(1);
    expect(harness.workspaceFactory.workspace.cleanupCalls).toBe(1);
  });

  it("fails closed when the State lock cannot be proven released", async () => {
    const stateLocks = new FakeStateLockManager();
    stateLocks.lease.releases = false;
    const harness = await createHarness({ stateLocks });
    const engine = await requireEngine(harness);

    const result = await engine.plan(request);

    expect(result).toEqual({
      ok: false,
      failure: { code: "state-lock-release-failed", retryable: true },
    });
    expect(harness.workspaceFactory.workspace.cleanupCalls).toBe(1);
  });

  it("fails closed when the isolated workspace cannot be cleaned", async () => {
    const workspaceFactory = new FakeWorkspaceFactory();
    workspaceFactory.workspace.cleanupSucceeds = false;
    const harness = await createHarness({ workspaceFactory });
    const engine = await requireEngine(harness);

    const result = await engine.plan(request);

    expect(result).toEqual({
      ok: false,
      failure: { code: "workspace-cleanup-failed", retryable: true },
    });
  });

  it("returns a typed failure when the isolated workspace cannot be created", async () => {
    const workspaceFactory = new FakeWorkspaceFactory();
    workspaceFactory.succeeds = false;
    const harness = await createHarness({ workspaceFactory });
    const engine = await requireEngine(harness);

    const result = await engine.plan(request);

    expect(result).toEqual({
      ok: false,
      failure: { code: "workspace-creation-failed", retryable: true },
    });
  });

  it("isolates observer failure from Plan behavior", async () => {
    const observer: OpenTofuExecutionObserver = {
      record: () => {
        throw new Error("observer unavailable");
      },
    };
    const runner = new ScriptedProcessRunner(successfulProcessResults());
    const created = await OpenTofuInfrastructureEngine.create({
      executable: "tofu",
      processRunner: runner,
      workspaceFactory: new FakeWorkspaceFactory(),
      artifactResolver: new FakeArtifactResolver(),
      planArtifactStore: new FakePlanArtifactStore(),
      stateLockManager: new FakeStateLockManager(),
      observer,
      commandEnvironment: { PATH: "/safe/bin" },
      commandTimeoutMs: 10_000,
      stateLockTimeoutMs: 5_000,
      maxOutputBytes: 1_048_576,
      maxSourceArtifactBytes: 65_536,
    });
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) return;

    await expect(created.value.plan(request)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("does not create a workspace for an already-cancelled Plan", async () => {
    const harness = await createHarness();
    const engine = await requireEngine(harness);
    const controller = new AbortController();
    controller.abort();

    const result = await engine.plan({ ...request, signal: controller.signal });

    expect(result).toEqual({
      ok: false,
      failure: { code: "engine-cancelled", retryable: true },
    });
    expect(harness.workspaceFactory.createCalls).toBe(0);
  });

  it("exposes no infrastructure mutation operation", async () => {
    const harness = await createHarness();
    const engine = await requireEngine(harness);

    expect("apply" in engine).toBe(false);
    expect("destroy" in engine).toBe(false);
    expect("import" in engine).toBe(false);
    expect("refresh" in engine).toBe(false);
  });

  it("keeps every expected failure code in the application contract", () => {
    const codes = [
      "artifact-digest-mismatch",
      "artifact-materialization-failed",
      "artifact-store-failed",
      "engine-cancelled",
      "engine-init-failed",
      "engine-not-installed",
      "engine-output-limit-exceeded",
      "engine-plan-failed",
      "engine-show-failed",
      "engine-timeout",
      "engine-validate-failed",
      "engine-version-invalid",
      "plan-json-invalid",
      "state-lock-release-failed",
      "state-lock-timeout",
      "workspace-cleanup-failed",
      "workspace-creation-failed",
    ] satisfies InfrastructureEngineFailureCode[];

    expect(codes).toHaveLength(17);
  });
});

infrastructureEngineConformance({
  engineName: "OpenTofuInfrastructureEngine",
  createEngine: async () => requireEngine(await createHarness()),
  request,
});
