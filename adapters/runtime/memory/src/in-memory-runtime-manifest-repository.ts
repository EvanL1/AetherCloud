import type {
  RuntimeManifestRepository,
  RuntimeManifestRepositoryRecordInput,
  RuntimeManifestRepositoryRecordResult,
  RuntimeManifestScope,
} from "@aether-cloud/application";
import { classifyRuntimeManifestReport } from "@aether-cloud/domain";
import type {
  GatewayId,
  RuntimeManifestGeneration,
  RuntimeManifestObservation,
} from "@aether-cloud/domain";

interface StoredRequest {
  readonly digest: string;
  readonly generation: RuntimeManifestGeneration;
}

function gatewayKey(scope: RuntimeManifestScope, gatewayId: GatewayId): string {
  return `${scope.tenantId}:${scope.projectId}:${gatewayId}`;
}

function generationKey(
  scope: RuntimeManifestScope,
  gatewayId: GatewayId,
  generation: RuntimeManifestGeneration,
): string {
  return `${gatewayKey(scope, gatewayId)}:${generation}`;
}

function requestKey(
  observation: RuntimeManifestObservation,
  requestId: string,
): string {
  return `${gatewayKey(observation, observation.gatewayId)}:${requestId}`;
}

function sameReport(
  stored: StoredRequest,
  observation: RuntimeManifestObservation,
): boolean {
  return (
    stored.generation === observation.generation &&
    stored.digest === observation.manifest.checksum.digest
  );
}

export class InMemoryRuntimeManifestRepository implements RuntimeManifestRepository {
  readonly #current = new Map<string, RuntimeManifestObservation>();
  readonly #history = new Map<string, RuntimeManifestObservation>();
  readonly #requests = new Map<string, StoredRequest>();

  record(
    input: RuntimeManifestRepositoryRecordInput,
  ): Promise<RuntimeManifestRepositoryRecordResult> {
    const { observation } = input;
    const reportRequestKey = requestKey(observation, input.requestId);
    const priorRequest = this.#requests.get(reportRequestKey);
    if (priorRequest !== undefined) {
      return Promise.resolve({
        outcome: sameReport(priorRequest, observation)
          ? "replayed"
          : "idempotency-conflict",
      });
    }

    const reportGenerationKey = generationKey(
      observation,
      observation.gatewayId,
      observation.generation,
    );
    const priorGeneration = this.#history.get(reportGenerationKey);
    if (priorGeneration !== undefined) {
      if (
        priorGeneration.manifest.checksum.digest !==
        observation.manifest.checksum.digest
      ) {
        return Promise.resolve({ outcome: "generation-conflict" });
      }
      this.#requests.set(reportRequestKey, {
        generation: observation.generation,
        digest: observation.manifest.checksum.digest,
      });
      return Promise.resolve({ outcome: "replayed" });
    }

    const currentKey = gatewayKey(observation, observation.gatewayId);
    const current = this.#current.get(currentKey);
    const classification = classifyRuntimeManifestReport(current, observation);
    if (!classification.ok) {
      return Promise.resolve({ outcome: "generation-conflict" });
    }
    this.#history.set(reportGenerationKey, observation);
    this.#requests.set(reportRequestKey, {
      generation: observation.generation,
      digest: observation.manifest.checksum.digest,
    });
    if (classification.updatesLatest) {
      this.#current.set(currentKey, observation);
    }
    return Promise.resolve({
      outcome:
        classification.disposition === "accepted-late"
          ? "recorded-late"
          : classification.disposition === "replayed"
            ? "replayed"
            : "recorded-latest",
    });
  }

  findCurrent(
    scope: RuntimeManifestScope,
    gatewayId: GatewayId,
  ): Promise<RuntimeManifestObservation | undefined> {
    return Promise.resolve(this.#current.get(gatewayKey(scope, gatewayId)));
  }

  findByGeneration(
    scope: RuntimeManifestScope,
    gatewayId: GatewayId,
    generation: RuntimeManifestGeneration,
  ): Promise<RuntimeManifestObservation | undefined> {
    return Promise.resolve(
      this.#history.get(generationKey(scope, gatewayId, generation)),
    );
  }
}
