import type {
  EdgeDeploymentInsertRequest,
  EdgeDeploymentInsertResult,
  EdgeDeploymentReplaceRequest,
  EdgeDeploymentReplaceResult,
  EdgeDeploymentRepository,
  EdgeDeploymentScope,
} from "@aether-cloud/application";
import type { EdgeDeployment, EdgeDeploymentId } from "@aether-cloud/domain";

export interface InMemoryDeploymentAuditEvent {
  readonly eventId: string;
  readonly deploymentId: EdgeDeploymentId;
  readonly subjectId: string;
  readonly action: "created" | "updated";
}

export interface InMemoryDeploymentOutboxEvent {
  readonly eventId: string;
  readonly deploymentId: EdgeDeploymentId;
  readonly eventName:
    | "deployment.desired-created.v1"
    | "deployment.observation-recorded.v1"
    | "deployment.rollout-controlled.v1";
}

interface StoredRequest {
  readonly fingerprint: string;
  readonly deployment: EdgeDeployment;
}

function scopeKey(scope: EdgeDeploymentScope): string {
  return `${scope.tenantId}:${scope.projectId}`;
}

function deploymentKey(
  scope: EdgeDeploymentScope,
  deploymentId: EdgeDeploymentId,
): string {
  return `${scopeKey(scope)}:${deploymentId}`;
}

function requestKey(scope: EdgeDeploymentScope, requestId: string): string {
  return `${scopeKey(scope)}:${requestId}`;
}

function fingerprint(deployment: EdgeDeployment): string {
  return [
    deployment.deploymentId,
    deployment.gatewayId,
    deployment.desired.generation,
    deployment.desired.revisionId,
    deployment.rolloutState,
    deployment.reported?.observationId ?? "none",
  ].join(":");
}

export class InMemoryEdgeDeploymentRepository implements EdgeDeploymentRepository {
  readonly #deployments = new Map<string, EdgeDeployment>();
  readonly #requests = new Map<string, StoredRequest>();
  readonly #audit: InMemoryDeploymentAuditEvent[] = [];
  readonly #outbox: InMemoryDeploymentOutboxEvent[] = [];
  #failNext = false;

  insert(
    request: EdgeDeploymentInsertRequest,
  ): Promise<EdgeDeploymentInsertResult> {
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const replay = this.#replay(request, request.deployment);
    if (replay !== undefined) return Promise.resolve(replay);
    const identity = deploymentKey(request, request.deployment.deploymentId);
    if (this.#deployments.has(identity)) {
      return Promise.resolve({ outcome: "already-exists" });
    }
    this.#deployments.set(identity, request.deployment);
    this.#remember(request, request.deployment);
    this.#recordEvidence(request, "created", "deployment.desired-created.v1");
    return Promise.resolve({
      outcome: "inserted",
      deployment: request.deployment,
    });
  }

  replace(
    request: EdgeDeploymentReplaceRequest,
  ): Promise<EdgeDeploymentReplaceResult> {
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const replay = this.#replay(request, request.deployment);
    if (replay !== undefined) return Promise.resolve(replay);
    const identity = deploymentKey(request, request.deployment.deploymentId);
    const current = this.#deployments.get(identity);
    if (current === undefined) return Promise.resolve({ outcome: "not-found" });
    if (current.revision !== request.expectedRevision) {
      return Promise.resolve({ outcome: "version-conflict" });
    }
    this.#deployments.set(identity, request.deployment);
    this.#remember(request, request.deployment);
    this.#recordEvidence(request, "updated", request.eventName);
    return Promise.resolve({
      outcome: "replaced",
      deployment: request.deployment,
    });
  }

  find(
    scope: EdgeDeploymentScope,
    deploymentId: EdgeDeploymentId,
  ): Promise<EdgeDeployment | undefined> {
    return Promise.resolve(
      this.#deployments.get(deploymentKey(scope, deploymentId)),
    );
  }

  failNextPersistence(): void {
    this.#failNext = true;
  }

  deploymentCount(): number {
    return this.#deployments.size;
  }

  auditEvents(): readonly InMemoryDeploymentAuditEvent[] {
    return Object.freeze([...this.#audit]);
  }

  pendingOutboxEvents(): readonly InMemoryDeploymentOutboxEvent[] {
    return Object.freeze([...this.#outbox]);
  }

  #replay(
    request: EdgeDeploymentInsertRequest | EdgeDeploymentReplaceRequest,
    deployment: EdgeDeployment,
  ):
    | Readonly<{ outcome: "idempotency-conflict" }>
    | Readonly<{ outcome: "replayed"; deployment: EdgeDeployment }>
    | undefined {
    const prior = this.#requests.get(requestKey(request, request.requestId));
    if (prior === undefined) return undefined;
    return prior.fingerprint === fingerprint(deployment)
      ? { outcome: "replayed", deployment: prior.deployment }
      : { outcome: "idempotency-conflict" };
  }

  #remember(
    request: EdgeDeploymentInsertRequest | EdgeDeploymentReplaceRequest,
    deployment: EdgeDeployment,
  ): void {
    this.#requests.set(requestKey(request, request.requestId), {
      fingerprint: fingerprint(deployment),
      deployment,
    });
  }

  #recordEvidence(
    request: EdgeDeploymentInsertRequest | EdgeDeploymentReplaceRequest,
    action: InMemoryDeploymentAuditEvent["action"],
    eventName: InMemoryDeploymentOutboxEvent["eventName"],
  ): void {
    const suffix = `${scopeKey(request)}:${request.deployment.deploymentId}:${request.requestId}`;
    this.#audit.push(
      Object.freeze({
        eventId: `audit:deployment:${suffix}`,
        deploymentId: request.deployment.deploymentId,
        subjectId: request.subjectId,
        action,
      }),
    );
    this.#outbox.push(
      Object.freeze({
        eventId: `outbox:deployment:${suffix}`,
        deploymentId: request.deployment.deploymentId,
        eventName,
      }),
    );
  }
}
