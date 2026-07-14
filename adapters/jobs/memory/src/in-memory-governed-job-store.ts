import type {
  EdgeCapabilityCatalog,
  EdgeCapabilityDeclaration,
  GovernedJobInsertRequest,
  GovernedJobInsertResult,
  GovernedJobReplaceRequest,
  GovernedJobReplaceResult,
  GovernedJobRepository,
  GovernedJobScope,
} from "@aether-cloud/application";
import type {
  GovernedJob,
  GovernedJobId,
  GatewayId,
} from "@aether-cloud/domain";

export interface InMemoryGovernedJobAuditEvent {
  readonly eventId: string;
  readonly jobId: GovernedJobId;
  readonly subjectId: string;
  readonly action: "created" | "updated";
}

export interface InMemoryGovernedJobOutboxEvent {
  readonly eventId: string;
  readonly jobId: GovernedJobId;
  readonly eventName:
    | "edge.job-created.v1"
    | "edge.job-controlled.v1"
    | "edge.job-receipt-ingested.v1";
}

interface StoredRequest {
  readonly fingerprint: string;
  readonly job: GovernedJob;
}

function scopeKey(scope: GovernedJobScope): string {
  return `${scope.tenantId}:${scope.projectId}`;
}

function jobKey(scope: GovernedJobScope, jobId: GovernedJobId): string {
  return `${scopeKey(scope)}:${jobId}`;
}

function requestKey(scope: GovernedJobScope, requestId: string): string {
  return `${scopeKey(scope)}:${requestId}`;
}

function fingerprint(job: GovernedJob): string {
  return JSON.stringify({
    jobId: job.jobId,
    gatewayId: job.gatewayId,
    capabilityId: job.capabilityId,
    capabilityPermission: job.capabilityPermission,
    risk: job.risk,
    confirmation: job.confirmation,
    replaySafety: job.replaySafety,
    physicalEffect: job.physicalEffect,
    argumentsDigest: job.argumentsDigest,
    preconditionDigest: job.preconditionDigest,
    state: job.state,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    confirmedBy: job.confirmedBy ?? null,
    confirmedAt: job.confirmedAt ?? null,
    queuedAt: job.queuedAt ?? null,
    offeredAt: job.offeredAt ?? null,
    unknownAt: job.unknownAt ?? null,
    cancelRequestedAt: job.cancelRequestedAt ?? null,
    receipts: job.receipts,
    lastContiguousSequence: job.lastContiguousSequence,
    revision: job.revision,
  });
}

export class InMemoryGovernedJobStore
  implements GovernedJobRepository, EdgeCapabilityCatalog
{
  readonly #jobs = new Map<string, GovernedJob>();
  readonly #requests = new Map<string, StoredRequest>();
  readonly #capabilities = new Map<string, EdgeCapabilityDeclaration>();
  readonly #audit: InMemoryGovernedJobAuditEvent[] = [];
  readonly #outbox: InMemoryGovernedJobOutboxEvent[] = [];
  #failNext = false;

  registerCapability(descriptor: EdgeCapabilityDeclaration): void {
    this.#capabilities.set(
      descriptor.capabilityId,
      Object.freeze({ ...descriptor }),
    );
  }

  find(
    scope: GovernedJobScope,
    jobId: GovernedJobId,
  ): Promise<GovernedJob | undefined>;
  find(
    scope: GovernedJobScope,
    gatewayId: GatewayId,
    capabilityId: string,
  ): Promise<EdgeCapabilityDeclaration | undefined>;
  find(
    scope: GovernedJobScope,
    identity: GovernedJobId | GatewayId,
    capabilityId?: string,
  ): Promise<GovernedJob | EdgeCapabilityDeclaration | undefined> {
    if (capabilityId !== undefined) {
      return Promise.resolve(this.#capabilities.get(capabilityId));
    }
    return Promise.resolve(
      this.#jobs.get(jobKey(scope, identity as GovernedJobId)),
    );
  }

  insert(request: GovernedJobInsertRequest): Promise<GovernedJobInsertResult> {
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const replay = this.#replay(request, request.job);
    if (replay !== undefined) return Promise.resolve(replay);
    const identity = jobKey(request, request.job.jobId);
    if (this.#jobs.has(identity)) {
      return Promise.resolve({ outcome: "already-exists" });
    }
    this.#jobs.set(identity, request.job);
    this.#remember(request, request.job);
    this.#recordEvidence(request, "created", "edge.job-created.v1");
    return Promise.resolve({ outcome: "inserted", job: request.job });
  }

  replace(
    request: GovernedJobReplaceRequest,
  ): Promise<GovernedJobReplaceResult> {
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const replay = this.#replay(request, request.job);
    if (replay !== undefined) return Promise.resolve(replay);
    const identity = jobKey(request, request.job.jobId);
    const current = this.#jobs.get(identity);
    if (current === undefined) return Promise.resolve({ outcome: "not-found" });
    if (current.revision !== request.expectedRevision) {
      return Promise.resolve({ outcome: "version-conflict" });
    }
    this.#jobs.set(identity, request.job);
    this.#remember(request, request.job);
    this.#recordEvidence(request, "updated", request.eventName);
    return Promise.resolve({ outcome: "replaced", job: request.job });
  }

  failNextPersistence(): void {
    this.#failNext = true;
  }

  jobCount(): number {
    return this.#jobs.size;
  }

  auditEvents(): readonly InMemoryGovernedJobAuditEvent[] {
    return Object.freeze([...this.#audit]);
  }

  pendingOutboxEvents(): readonly InMemoryGovernedJobOutboxEvent[] {
    return Object.freeze([...this.#outbox]);
  }

  #replay(
    request: GovernedJobInsertRequest | GovernedJobReplaceRequest,
    job: GovernedJob,
  ):
    | Readonly<{ outcome: "idempotency-conflict" }>
    | Readonly<{ outcome: "replayed"; job: GovernedJob }>
    | undefined {
    const prior = this.#requests.get(requestKey(request, request.requestId));
    if (prior === undefined) return undefined;
    return prior.fingerprint === fingerprint(job)
      ? { outcome: "replayed", job: prior.job }
      : { outcome: "idempotency-conflict" };
  }

  #remember(
    request: GovernedJobInsertRequest | GovernedJobReplaceRequest,
    job: GovernedJob,
  ): void {
    this.#requests.set(requestKey(request, request.requestId), {
      fingerprint: fingerprint(job),
      job,
    });
  }

  #recordEvidence(
    request: GovernedJobInsertRequest | GovernedJobReplaceRequest,
    action: InMemoryGovernedJobAuditEvent["action"],
    eventName: InMemoryGovernedJobOutboxEvent["eventName"],
  ): void {
    const suffix = `${scopeKey(request)}:${request.job.jobId}:${request.requestId}`;
    this.#audit.push(
      Object.freeze({
        eventId: `audit:job:${suffix}`,
        jobId: request.job.jobId,
        subjectId: request.subjectId,
        action,
      }),
    );
    this.#outbox.push(
      Object.freeze({
        eventId: `outbox:job:${suffix}`,
        jobId: request.job.jobId,
        eventName,
      }),
    );
  }
}
