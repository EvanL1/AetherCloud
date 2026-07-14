import type {
  DeploymentStack,
  DeploymentStackId,
  InfrastructurePlanId,
} from "@aether-cloud/domain";

export type InfrastructureEngineKind = "opentofu" | "terraform";

export interface InfrastructureEngineDescriptor {
  readonly kind: InfrastructureEngineKind;
  readonly version: string;
}

export interface ImmutableArtifactSelection {
  readonly reference: string;
  readonly digest: string;
}

export interface InfrastructureModuleSelection extends ImmutableArtifactSelection {
  readonly version: string;
}

export type InfrastructureChangeAction =
  | "create"
  | "delete"
  | "no-op"
  | "read"
  | "update";

export interface InfrastructureResourceChange {
  readonly address: string;
  readonly providerResourceType: string;
  readonly actions: readonly InfrastructureChangeAction[];
}

export interface InfrastructurePlanArtifact {
  readonly reference: string;
  readonly digest: string;
  readonly protection: "encrypted";
  readonly sensitivity: "contains-sensitive-values";
}

export interface InfrastructureStateLockEvidence {
  readonly stateKey: string;
  readonly outcome: "acquired-and-released";
}

export interface InfrastructureEnginePlanRequest {
  readonly planId: InfrastructurePlanId;
  readonly stack: DeploymentStack;
  readonly module: InfrastructureModuleSelection;
  readonly topology: ImmutableArtifactSelection;
  readonly signal?: AbortSignal;
}

export interface InfrastructureEnginePlanValue {
  readonly planId: InfrastructurePlanId;
  readonly stackId: DeploymentStackId;
  readonly stateKey: string;
  readonly jsonFormatVersion: string;
  readonly artifact: InfrastructurePlanArtifact;
  readonly stateLock: InfrastructureStateLockEvidence;
  readonly resourceChanges: readonly InfrastructureResourceChange[];
}

export type InfrastructureEngineFailureCode =
  | "artifact-digest-mismatch"
  | "artifact-materialization-failed"
  | "artifact-store-failed"
  | "engine-cancelled"
  | "engine-init-failed"
  | "engine-not-installed"
  | "engine-output-limit-exceeded"
  | "engine-plan-failed"
  | "engine-show-failed"
  | "engine-timeout"
  | "engine-validate-failed"
  | "engine-version-invalid"
  | "plan-json-invalid"
  | "state-lock-release-failed"
  | "state-lock-timeout"
  | "workspace-cleanup-failed"
  | "workspace-creation-failed";

export interface InfrastructureEngineFailure {
  readonly code: InfrastructureEngineFailureCode;
  readonly retryable: boolean;
}

export type InfrastructureEnginePlanResult =
  | Readonly<{ ok: true; value: InfrastructureEnginePlanValue }>
  | Readonly<{ ok: false; failure: InfrastructureEngineFailure }>;

export interface InfrastructureEngine {
  readonly descriptor: InfrastructureEngineDescriptor;

  plan(
    request: InfrastructureEnginePlanRequest,
  ): Promise<InfrastructureEnginePlanResult>;
}

export class InvalidInfrastructureEngineDescriptorError extends Error {
  readonly code = "invalid-infrastructure-engine-descriptor";

  constructor() {
    super(
      "infrastructure engine kind and version must be supported identifiers",
    );
    this.name = "InvalidInfrastructureEngineDescriptorError";
  }
}

export class DuplicateInfrastructureEngineError extends Error {
  readonly code = "duplicate-infrastructure-engine";

  constructor(kind: InfrastructureEngineKind) {
    super(`multiple infrastructure engines declared kind: ${kind}`);
    this.name = "DuplicateInfrastructureEngineError";
  }
}

const engineVersionPattern = /^[0-9][0-9A-Za-z.+_-]{0,63}$/;

function isInfrastructureEngineKind(
  value: unknown,
): value is InfrastructureEngineKind {
  return value === "opentofu" || value === "terraform";
}

export class InfrastructureEngineRegistry {
  readonly #engines: ReadonlyMap<
    InfrastructureEngineKind,
    InfrastructureEngine
  >;

  constructor(engines: readonly InfrastructureEngine[]) {
    const byKind = new Map<InfrastructureEngineKind, InfrastructureEngine>();
    for (const engine of engines) {
      if (
        !isInfrastructureEngineKind(engine.descriptor.kind) ||
        !engineVersionPattern.test(engine.descriptor.version)
      ) {
        throw new InvalidInfrastructureEngineDescriptorError();
      }
      if (byKind.has(engine.descriptor.kind)) {
        throw new DuplicateInfrastructureEngineError(engine.descriptor.kind);
      }
      byKind.set(engine.descriptor.kind, engine);
    }
    this.#engines = byKind;
  }

  find(kind: InfrastructureEngineKind): InfrastructureEngine | undefined {
    return this.#engines.get(kind);
  }
}
