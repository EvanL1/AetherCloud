import type {
  EdgeCapabilityId,
  GatewayId,
  GovernedJob,
  GovernedJobId,
  JobConfirmation,
  JobReplaySafety,
  JobRisk,
  ProjectId,
  TenantId,
} from "@aether-cloud/domain";

export interface GovernedJobScope {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

export interface EdgeCapabilityDeclaration {
  readonly capabilityId: string;
  readonly permission: string;
  readonly risk: JobRisk;
  readonly confirmation: JobConfirmation;
  readonly replaySafety: JobReplaySafety;
  readonly physicalEffect: boolean;
}

export interface EdgeCapabilityCatalog {
  find(
    scope: GovernedJobScope,
    gatewayId: GatewayId,
    capabilityId: EdgeCapabilityId,
  ): Promise<EdgeCapabilityDeclaration | undefined>;
}

export interface GovernedJobInsertRequest extends GovernedJobScope {
  readonly requestId: string;
  readonly subjectId: string;
  readonly job: GovernedJob;
}

export type GovernedJobInsertResult =
  | Readonly<{ outcome: "already-exists" }>
  | Readonly<{ outcome: "idempotency-conflict" }>
  | Readonly<{ outcome: "inserted"; job: GovernedJob }>
  | Readonly<{ outcome: "replayed"; job: GovernedJob }>
  | Readonly<{ outcome: "storage-unavailable" }>;

export interface GovernedJobReplaceRequest extends GovernedJobScope {
  readonly requestId: string;
  readonly subjectId: string;
  readonly expectedRevision: number;
  readonly eventName: "edge.job-controlled.v1" | "edge.job-receipt-ingested.v1";
  readonly job: GovernedJob;
}

export type GovernedJobReplaceResult =
  | Readonly<{ outcome: "idempotency-conflict" }>
  | Readonly<{ outcome: "not-found" }>
  | Readonly<{ outcome: "replaced"; job: GovernedJob }>
  | Readonly<{ outcome: "replayed"; job: GovernedJob }>
  | Readonly<{ outcome: "storage-unavailable" }>
  | Readonly<{ outcome: "version-conflict" }>;

export interface GovernedJobRepository {
  insert(request: GovernedJobInsertRequest): Promise<GovernedJobInsertResult>;
  replace(
    request: GovernedJobReplaceRequest,
  ): Promise<GovernedJobReplaceResult>;
  find(
    scope: GovernedJobScope,
    jobId: GovernedJobId,
  ): Promise<GovernedJob | undefined>;
}
