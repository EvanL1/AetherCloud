import { describe, expect, it, vi } from "vitest";

import {
  DuplicateInfrastructureEngineError,
  InfrastructureEngineRegistry,
  PLAN_DEPLOYMENT_STACK_COMMAND,
  PlanDeploymentStack,
  type ApplicationClock,
  type DeploymentStackReader,
  type InfrastructureEngine,
  type InfrastructurePlanIdGenerator,
  type InfrastructurePlanPolicy,
  type InfrastructurePlanRecord,
  type InfrastructurePlanRepository,
} from "../src/index.js";
import {
  defineCloudConnection,
  defineCloudProvider,
  defineDeploymentStack,
  defineProviderRegion,
  parseInfrastructurePlanId,
  parseUtcInstant,
} from "@aether-cloud/domain";

const tenantId = "018f6f89-4368-7c3a-b7f1-a9f2da491101";
const otherTenantId = "018f6f89-4368-7c3a-b7f1-a9f2da491199";
const projectId = "018f6f89-4368-7c3a-b7f1-a9f2da491102";
const connectionId = "018f6f89-4368-7c3a-b7f1-a9f2da491103";
const stackId = "018f6f89-4368-7c3a-b7f1-a9f2da491104";
const planId = parseInfrastructurePlanId(
  "018f6f89-4368-7c3a-b7f1-a9f2da491105",
);

const provider = defineCloudProvider({
  id: "example-cloud",
  displayName: "Example Cloud",
  kind: "public-cloud",
  capabilities: ["compute", "private-network"],
});
const connection = defineCloudConnection({
  id: connectionId,
  tenantId,
  projectId,
  providerId: provider.id,
  displayName: "Example production",
  providerScope: "production-account",
  credentialSource: {
    kind: "workload-identity",
    reference: "workload-identity://aether-cloud/providers/example-cloud",
  },
  status: "active",
});
const region = defineProviderRegion({
  id: "region-one",
  displayName: "Region One",
  availability: "available",
  capabilities: ["compute", "private-network"],
  zones: ["zone-a"],
});
const stack = defineDeploymentStack({
  id: stackId,
  connection,
  displayName: "Edge data plane",
  primaryRegion: {
    providerId: provider.id,
    connectionId: connection.id,
    observedAt: "2026-07-14T12:00:00.000Z",
    region,
  },
  stateBackendReference: "state-backend://aether-cloud/production-backend",
});

const planInput = {
  stackId,
  engine: "opentofu",
  module: {
    reference: "module://aether-cloud/example-cloud/iot-data-plane",
    version: "1.0.0",
    digest: `sha256:${"a".repeat(64)}`,
  },
  topology: {
    reference: "topology://tenants/production/iot-data-plane/revision-7",
    digest: `sha256:${"b".repeat(64)}`,
  },
};

function commandContext(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    tenantId,
    projectId,
    subjectId: "operator:alice",
    permissions: ["infrastructure.stack.plan"],
    idempotencyKey: "plan-request-001",
    issuedAt: "2026-07-14T12:00:00.000Z",
    expiresAt: "2026-07-14T12:10:00.000Z",
    ...overrides,
  };
}

class FixedClock implements ApplicationClock {
  now() {
    return parseUtcInstant("2026-07-14T12:05:00.000Z");
  }
}

class FixedPlanIdGenerator implements InfrastructurePlanIdGenerator {
  next() {
    return planId;
  }
}

class MemoryPlanRepository implements InfrastructurePlanRepository {
  readonly #records = new Map<string, InfrastructurePlanRecord>();

  findByRequest(
    scope: { tenantId: string; projectId: string },
    requestId: string,
  ) {
    return Promise.resolve(
      this.#records.get(`${scope.tenantId}:${scope.projectId}:${requestId}`),
    );
  }

  insert(record: InfrastructurePlanRecord) {
    const key = `${record.tenantId}:${record.projectId}:${record.requestId}`;
    if (this.#records.has(key))
      return Promise.resolve("already-exists" as const);
    this.#records.set(key, record);
    return Promise.resolve("inserted" as const);
  }
}

function stackReader(): DeploymentStackReader {
  return {
    findByScope: vi.fn<DeploymentStackReader["findByScope"]>(
      (scope, requestedStackId) =>
        Promise.resolve(
          scope.tenantId === tenantId &&
            scope.projectId === projectId &&
            requestedStackId === stackId
            ? stack
            : undefined,
        ),
    ),
  };
}

function successfulEngine() {
  const plan = vi.fn<InfrastructureEngine["plan"]>((request) =>
    Promise.resolve({
      ok: true,
      value: {
        planId: request.planId,
        stackId: request.stack.id,
        stateKey: request.stack.state.key,
        jsonFormatVersion: "1.2",
        artifact: {
          reference: `plan-artifact://vault/${request.planId}`,
          digest: `sha256:${"c".repeat(64)}`,
          protection: "encrypted",
          sensitivity: "contains-sensitive-values",
        },
        stateLock: {
          stateKey: request.stack.state.key,
          outcome: "acquired-and-released",
        },
        resourceChanges: [
          {
            address: "example_compute.edge",
            providerResourceType: "example_compute",
            actions: ["create"],
          },
          {
            address: "example_network.private",
            providerResourceType: "example_network",
            actions: ["update"],
          },
          {
            address: "example_compute.old",
            providerResourceType: "example_compute",
            actions: ["delete", "create"],
          },
        ],
      },
    }),
  );
  const engine: InfrastructureEngine = {
    descriptor: { kind: "opentofu", version: "1.10.0" },
    plan,
  };
  return { engine, plan };
}

function allowPolicy(): InfrastructurePlanPolicy {
  return {
    evaluate: vi.fn<InfrastructurePlanPolicy["evaluate"]>(() =>
      Promise.resolve({
        decision: "allow" as const,
        policyVersion: "infrastructure-plan/v1",
        reasons: [],
      }),
    ),
  };
}

function createUseCase(
  options: {
    engine?: InfrastructureEngine;
    policy?: InfrastructurePlanPolicy;
    plans?: InfrastructurePlanRepository;
  } = {},
) {
  const engine = options.engine ?? successfulEngine().engine;
  const plans = options.plans ?? new MemoryPlanRepository();
  return {
    useCase: new PlanDeploymentStack({
      stacks: stackReader(),
      plans,
      engines: new InfrastructureEngineRegistry([engine]),
      policy: options.policy ?? allowPolicy(),
      planIds: new FixedPlanIdGenerator(),
      clock: new FixedClock(),
    }),
    plans,
  };
}

describe("plan deployment stack command", () => {
  it("declares governed, non-applying command metadata", () => {
    expect(PLAN_DEPLOYMENT_STACK_COMMAND).toEqual({
      kind: "command",
      name: "infrastructure.stack.plan",
      permission: "infrastructure.stack.plan",
      risk: "medium",
      confirmation: "not-required",
      idempotency: "required",
      expiry: "required",
      audit: "required",
      authorization: "tenant-permission",
    });
  });

  it("stores an encrypted saved-plan receipt with policy and State lock evidence", async () => {
    const { engine, plan } = successfulEngine();
    const { useCase } = createUseCase({ engine });

    const result = await useCase.execute(commandContext(), planInput);

    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        planId,
        stackId,
        providerId: "example-cloud",
        engine: { kind: "opentofu", version: "1.10.0" },
        status: "policy-approved",
        approval: "not-requested",
        artifact: {
          reference: `plan-artifact://vault/${planId}`,
          protection: "encrypted",
          sensitivity: "contains-sensitive-values",
        },
        stateLock: {
          stateKey: stack.state.key,
          outcome: "acquired-and-released",
        },
        changes: { create: 1, update: 1, delete: 0, replace: 1, read: 0 },
        policy: {
          decision: "allow",
          policyVersion: "infrastructure-plan/v1",
        },
      },
    });
    expect(plan).toHaveBeenCalledWith(
      expect.objectContaining({
        planId,
        stack,
        module: planInput.module,
        topology: planInput.topology,
      }),
    );
    expect(JSON.stringify(result)).not.toContain("resourceChanges");
  });

  it("replays the same request without running the engine twice", async () => {
    const { engine, plan } = successfulEngine();
    const plans = new MemoryPlanRepository();
    const { useCase } = createUseCase({ engine, plans });

    const first = await useCase.execute(commandContext(), planInput);
    const replay = await useCase.execute(commandContext(), planInput);

    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it("fails before reading a Stack or invoking an engine without permission", async () => {
    const { engine, plan } = successfulEngine();
    const findByScope = vi.fn<DeploymentStackReader["findByScope"]>();
    const stacks: DeploymentStackReader = { findByScope };
    const useCase = new PlanDeploymentStack({
      stacks,
      plans: new MemoryPlanRepository(),
      engines: new InfrastructureEngineRegistry([engine]),
      policy: allowPolicy(),
      planIds: new FixedPlanIdGenerator(),
      clock: new FixedClock(),
    });

    const result = await useCase.execute(
      commandContext({ permissions: [] }),
      planInput,
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "permission-denied" },
    });
    expect(findByScope).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "expiry before issue time",
      context: {
        issuedAt: "2026-07-14T12:06:00.000Z",
        expiresAt: "2026-07-14T12:05:00.000Z",
      },
      code: "invalid-input",
    },
    {
      name: "issue time in the future",
      context: {
        issuedAt: "2026-07-14T12:06:00.000Z",
        expiresAt: "2026-07-14T12:10:00.000Z",
      },
      code: "invalid-input",
    },
    {
      name: "expired command",
      context: {
        issuedAt: "2026-07-14T11:50:00.000Z",
        expiresAt: "2026-07-14T12:05:00.000Z",
      },
      code: "command-expired",
    },
  ])("rejects $name before invoking an engine", async ({ context, code }) => {
    const { engine, plan } = successfulEngine();
    const { useCase } = createUseCase({ engine });

    const result = await useCase.execute(commandContext(context), planInput);

    expect(result).toMatchObject({ ok: false, failure: { code } });
    expect(plan).not.toHaveBeenCalled();
  });

  it("rejects conflicting reuse of an idempotency key", async () => {
    const { engine, plan } = successfulEngine();
    const { useCase } = createUseCase({ engine });

    await useCase.execute(commandContext(), planInput);
    const conflict = await useCase.execute(commandContext(), {
      ...planInput,
      module: { ...planInput.module, version: "1.0.1" },
    });

    expect(conflict).toMatchObject({
      ok: false,
      failure: { code: "idempotency-conflict" },
    });
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it("does not replay another subject's idempotency request", async () => {
    const { useCase } = createUseCase();

    await useCase.execute(commandContext(), planInput);
    const result = await useCase.execute(
      commandContext({ subjectId: "operator:bob" }),
      planInput,
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "idempotency-conflict" },
    });
  });

  it("fails when the selected infrastructure engine is not registered", async () => {
    const useCase = new PlanDeploymentStack({
      stacks: stackReader(),
      plans: new MemoryPlanRepository(),
      engines: new InfrastructureEngineRegistry([]),
      policy: allowPolicy(),
      planIds: new FixedPlanIdGenerator(),
      clock: new FixedClock(),
    });

    const result = await useCase.execute(commandContext(), planInput);

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "infrastructure-engine-not-registered" },
    });
  });

  it("preserves a retryable State lock failure", async () => {
    const engine: InfrastructureEngine = {
      descriptor: { kind: "opentofu", version: "1.10.0" },
      plan: vi.fn<InfrastructureEngine["plan"]>(() =>
        Promise.resolve({
          ok: false as const,
          failure: { code: "state-lock-timeout", retryable: true },
        }),
      ),
    };
    const { useCase } = createUseCase({ engine });

    const result = await useCase.execute(commandContext(), planInput);

    expect(result).toEqual({
      ok: false,
      failure: { code: "state-lock-timeout", retryable: true },
    });
  });

  it("passes transport cancellation to the infrastructure engine", async () => {
    const { engine, plan } = successfulEngine();
    const { useCase } = createUseCase({ engine });
    const controller = new AbortController();

    await useCase.execute(commandContext(), planInput, controller.signal);

    expect(plan).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("fails closed when engine lock evidence targets another State", async () => {
    const { engine } = successfulEngine();
    const unsafeEngine: InfrastructureEngine = {
      descriptor: engine.descriptor,
      plan: vi.fn<InfrastructureEngine["plan"]>(async (request) => {
        const result = await engine.plan(request);
        if (!result.ok) return result;
        return {
          ok: true as const,
          value: {
            ...result.value,
            stateLock: {
              stateKey: "tenants/other/stacks/other",
              outcome: "acquired-and-released" as const,
            },
          },
        };
      }),
    };
    const { useCase } = createUseCase({ engine: unsafeEngine });

    const result = await useCase.execute(commandContext(), planInput);

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "infrastructure-engine-contract-violation" },
    });
  });

  it("records a denied policy decision without making it an applyable plan", async () => {
    const policy: InfrastructurePlanPolicy = {
      evaluate: vi.fn<InfrastructurePlanPolicy["evaluate"]>(() =>
        Promise.resolve({
          decision: "deny" as const,
          policyVersion: "infrastructure-plan/v1",
          reasons: ["replacement is not allowed in this environment"],
        }),
      ),
    };
    const { useCase } = createUseCase({ policy });

    const result = await useCase.execute(commandContext(), planInput);

    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "policy-rejected",
        approval: "not-requested",
        policy: {
          decision: "deny",
          reasons: ["replacement is not allowed in this environment"],
        },
      },
    });
  });

  it("does not disclose a Stack owned by another tenant", async () => {
    const { useCase } = createUseCase();

    const result = await useCase.execute(
      commandContext({ tenantId: otherTenantId }),
      planInput,
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "deployment-stack-not-found" },
    });
  });
});

describe("infrastructure engine registry", () => {
  it("rejects duplicate engine kinds", () => {
    const { engine } = successfulEngine();
    expect(() => new InfrastructureEngineRegistry([engine, engine])).toThrow(
      DuplicateInfrastructureEngineError,
    );
  });

  it("rejects an invalid engine version", () => {
    const { engine } = successfulEngine();
    expect(
      () =>
        new InfrastructureEngineRegistry([
          { ...engine, descriptor: { kind: "opentofu", version: "" } },
        ]),
    ).toThrow("infrastructure engine kind and version");
  });
});
