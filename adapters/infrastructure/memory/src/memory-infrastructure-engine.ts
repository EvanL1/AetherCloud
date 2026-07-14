import type {
  InfrastructureEngine,
  InfrastructureEngineDescriptor,
  InfrastructureEnginePlanRequest,
  InfrastructureEnginePlanResult,
  InfrastructureResourceChange,
} from "@aether-cloud/application";

export interface MemoryInfrastructureEngineOptions {
  readonly descriptor: InfrastructureEngineDescriptor;
  readonly artifactDigest: string;
  readonly jsonFormatVersion: string;
  readonly resourceChanges: readonly InfrastructureResourceChange[];
}

export class MemoryInfrastructureEngine implements InfrastructureEngine {
  readonly descriptor: InfrastructureEngineDescriptor;
  readonly #artifactDigest: string;
  readonly #jsonFormatVersion: string;
  readonly #resourceChanges: readonly InfrastructureResourceChange[];

  constructor(options: MemoryInfrastructureEngineOptions) {
    this.descriptor = Object.freeze({ ...options.descriptor });
    this.#artifactDigest = options.artifactDigest;
    this.#jsonFormatVersion = options.jsonFormatVersion;
    this.#resourceChanges = Object.freeze(
      options.resourceChanges.map((change) =>
        Object.freeze({
          ...change,
          actions: Object.freeze([...change.actions]),
        }),
      ),
    );
  }

  plan(
    request: InfrastructureEnginePlanRequest,
  ): Promise<InfrastructureEnginePlanResult> {
    return Promise.resolve(
      Object.freeze({
        ok: true,
        value: Object.freeze({
          planId: request.planId,
          stackId: request.stack.id,
          stateKey: request.stack.state.key,
          jsonFormatVersion: this.#jsonFormatVersion,
          artifact: Object.freeze({
            reference: `plan-artifact://memory/${request.planId}`,
            digest: this.#artifactDigest,
            protection: "encrypted",
            sensitivity: "contains-sensitive-values",
          }),
          stateLock: Object.freeze({
            stateKey: request.stack.state.key,
            outcome: "acquired-and-released",
          }),
          resourceChanges: this.#resourceChanges,
        }),
      }),
    );
  }
}
