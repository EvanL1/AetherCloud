import type {
  DeploymentStackScope,
  InfrastructurePlanInsertResult,
  InfrastructurePlanRecord,
  InfrastructurePlanRepository,
} from "@aether-cloud/application";

function requestKey(scope: DeploymentStackScope, requestId: string): string {
  return JSON.stringify([scope.tenantId, scope.projectId, requestId]);
}

export class InMemoryInfrastructurePlanRepository implements InfrastructurePlanRepository {
  readonly #records = new Map<string, InfrastructurePlanRecord>();

  findByRequest(
    scope: DeploymentStackScope,
    requestId: string,
  ): Promise<InfrastructurePlanRecord | undefined> {
    return Promise.resolve(this.#records.get(requestKey(scope, requestId)));
  }

  insert(
    record: InfrastructurePlanRecord,
  ): Promise<InfrastructurePlanInsertResult> {
    const key = requestKey(record, record.requestId);
    if (this.#records.has(key)) return Promise.resolve("already-exists");
    this.#records.set(key, record);
    return Promise.resolve("inserted");
  }
}
