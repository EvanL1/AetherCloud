import { describe, expect, it } from "vitest";

import type {
  InfrastructureEngine,
  InfrastructureEnginePlanRequest,
} from "@aether-cloud/application";

export interface InfrastructureEngineConformanceOptions {
  readonly engineName: string;
  readonly createEngine: () =>
    | InfrastructureEngine
    | Promise<InfrastructureEngine>;
  readonly request: InfrastructureEnginePlanRequest;
}

export function infrastructureEngineConformance(
  options: InfrastructureEngineConformanceOptions,
): void {
  describe(`${options.engineName} infrastructure engine conformance`, () => {
    it("creates an encrypted saved Plan for the requested Stack and State", async () => {
      const engine = await options.createEngine();

      const result = await engine.plan(options.request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        planId: options.request.planId,
        stackId: options.request.stack.id,
        stateKey: options.request.stack.state.key,
        artifact: {
          protection: "encrypted",
          sensitivity: "contains-sensitive-values",
        },
        stateLock: {
          stateKey: options.request.stack.state.key,
          outcome: "acquired-and-released",
        },
      });
      expect(result.value.artifact.reference).toMatch(/^plan-artifact:\/\//);
      expect(result.value.artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.value.jsonFormatVersion).toMatch(/^[0-9]+\.[0-9]+$/);
    });

    it("exposes no Apply operation", async () => {
      const engine = await options.createEngine();

      expect("apply" in engine).toBe(false);
    });
  });
}
