import type {
  GatewayIdentityRepository,
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

  find(
    scope: GatewayScope,
    gatewayId: GatewayId,
  ): Promise<GatewayIdentity | undefined> {
    return Promise.resolve(this.#gateways.get(gatewayKey(scope, gatewayId)));
  }

  insert(gateway: GatewayIdentity): Promise<GatewayInsertResult> {
    const key = gatewayKey(gateway, gateway.gatewayId);
    if (this.#gateways.has(key)) return Promise.resolve("already-exists");
    this.#gateways.set(key, gateway);
    return Promise.resolve("inserted");
  }

  replace(
    gateway: GatewayIdentity,
    expectedRevision: number,
  ): Promise<GatewayReplaceResult> {
    const key = gatewayKey(gateway, gateway.gatewayId);
    const current = this.#gateways.get(key);
    if (current === undefined) return Promise.resolve("not-found");
    if (current.revision !== expectedRevision) {
      return Promise.resolve("version-conflict");
    }
    this.#gateways.set(key, gateway);
    return Promise.resolve("replaced");
  }
}
