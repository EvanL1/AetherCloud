import type {
  GatewayIdentityInsertRequest,
  GatewayIdentityRepository,
  GatewayIdentityReplaceRequest,
  GatewayInsertResult,
  GatewayReplaceResult,
  GatewayScope,
} from "@aether-cloud/application";
import type { GatewayId, GatewayIdentity } from "@aether-cloud/domain";

function gatewayKey(scope: GatewayScope, gatewayId: GatewayId): string {
  return `${scope.tenantId}:${scope.projectId}:${gatewayId}`;
}

export class InMemoryGatewayIdentityRepository implements GatewayIdentityRepository {
  readonly #gateways = new Map<string, GatewayIdentity>();
  readonly #audit: GatewayIdentityInsertRequest["evidence"][] = [];
  readonly #outbox: GatewayIdentityInsertRequest["evidence"][] = [];

  find(
    scope: GatewayScope,
    gatewayId: GatewayId,
  ): ReturnType<GatewayIdentityRepository["find"]> {
    const gateway = this.#gateways.get(gatewayKey(scope, gatewayId));
    return Promise.resolve(
      gateway === undefined
        ? { outcome: "not-found" }
        : { outcome: "found", gateway },
    );
  }

  insert(request: GatewayIdentityInsertRequest): Promise<GatewayInsertResult> {
    const { gateway } = request;
    const key = gatewayKey(gateway, gateway.gatewayId);
    if (this.#gateways.has(key)) return Promise.resolve("already-exists");
    this.#gateways.set(key, gateway);
    this.#recordEvidence(request);
    return Promise.resolve("inserted");
  }

  replace(
    request: GatewayIdentityReplaceRequest,
  ): Promise<GatewayReplaceResult> {
    const { gateway, expectedRevision } = request;
    const key = gatewayKey(gateway, gateway.gatewayId);
    const current = this.#gateways.get(key);
    if (current === undefined) return Promise.resolve("not-found");
    if (current.revision !== expectedRevision) {
      return Promise.resolve("version-conflict");
    }
    this.#gateways.set(key, gateway);
    this.#recordEvidence(request);
    return Promise.resolve("replaced");
  }

  auditEvents(): readonly GatewayIdentityInsertRequest["evidence"][] {
    return Object.freeze([...this.#audit]);
  }

  pendingOutboxEvents(): readonly GatewayIdentityInsertRequest["evidence"][] {
    return Object.freeze([...this.#outbox]);
  }

  #recordEvidence(request: GatewayIdentityInsertRequest): void {
    this.#audit.push(request.evidence);
    this.#outbox.push(request.evidence);
  }
}
