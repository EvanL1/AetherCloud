import type {
  GatewayIdentityInsertRequest,
  GatewayIdentityRepository,
  GatewayIdentityReplaceRequest,
  FleetGatewayQueryRepository,
  FleetGatewaySnapshot,
  GatewayInsertResult,
  GatewayReplaceResult,
  GatewayScope,
} from "@aether-cloud/application";
import type { GatewayId, GatewayIdentity } from "@aether-cloud/domain";

function gatewayKey(scope: GatewayScope, gatewayId: GatewayId): string {
  return `${scope.tenantId}:${scope.projectId}:${gatewayId}`;
}

export class InMemoryGatewayIdentityRepository
  implements GatewayIdentityRepository, FleetGatewayQueryRepository
{
  readonly #gateways = new Map<string, GatewayIdentity>();
  readonly #registeredAt = new Map<
    string,
    FleetGatewaySnapshot["registeredAt"]
  >();
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
    if (gateway.enrollment.state !== "registered")
      throw new Error("Gateway insertion requires registered state");
    const key = gatewayKey(gateway, gateway.gatewayId);
    if (this.#gateways.has(key)) return Promise.resolve("already-exists");
    this.#gateways.set(key, gateway);
    this.#registeredAt.set(key, gateway.enrollment.registeredAt);
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

  list(
    query: Parameters<FleetGatewayQueryRepository["list"]>[0],
  ): ReturnType<FleetGatewayQueryRepository["list"]> {
    const gateways = [...this.#gateways.values()]
      .filter(
        (gateway) =>
          gateway.tenantId === query.tenantId &&
          gateway.projectId === query.projectId &&
          (query.cursor === undefined || gateway.gatewayId > query.cursor),
      )
      .sort((left, right) => left.gatewayId.localeCompare(right.gatewayId));
    const page = gateways.slice(0, query.limit + 1);
    const hasNext = page.length > query.limit;
    if (hasNext) page.pop();
    return Promise.resolve({
      outcome: "found",
      gateways: page.map((gateway) => this.#snapshot(gateway)),
      nextCursor:
        hasNext && page.length > 0 ? (page.at(-1)?.gatewayId ?? null) : null,
    });
  }

  get(
    scope: Parameters<FleetGatewayQueryRepository["get"]>[0],
    gatewayId: Parameters<FleetGatewayQueryRepository["get"]>[1],
  ): ReturnType<FleetGatewayQueryRepository["get"]> {
    const gateway = this.#gateways.get(gatewayKey(scope, gatewayId));
    return Promise.resolve(
      gateway === undefined
        ? { outcome: "not-found" }
        : { outcome: "found", gateway: this.#snapshot(gateway) },
    );
  }

  auditEvents(): readonly GatewayIdentityInsertRequest["evidence"][] {
    return Object.freeze([...this.#audit]);
  }

  pendingOutboxEvents(): readonly GatewayIdentityInsertRequest["evidence"][] {
    return Object.freeze([...this.#outbox]);
  }

  #snapshot(gateway: GatewayIdentity): FleetGatewaySnapshot {
    const registeredAt = this.#registeredAt.get(
      gatewayKey(gateway, gateway.gatewayId),
    );
    if (registeredAt === undefined)
      throw new Error("Gateway registration time is missing");
    return {
      tenantId: gateway.tenantId,
      projectId: gateway.projectId,
      gatewayId: gateway.gatewayId,
      displayName: gateway.displayName,
      enrollmentState: gateway.enrollment.state,
      revision: gateway.revision,
      registeredAt,
      session: null,
      telemetry: { recordCount: "0" },
    };
  }

  #recordEvidence(request: GatewayIdentityInsertRequest): void {
    this.#audit.push(request.evidence);
    this.#outbox.push(request.evidence);
  }
}
