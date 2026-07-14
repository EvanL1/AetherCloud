import type {
  EdgeDeployment,
  EdgeDeploymentId,
  ProjectId,
  TenantId,
} from "@aether-cloud/domain";

export interface EdgeDeploymentScope {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

export interface EdgeDeploymentInsertRequest extends EdgeDeploymentScope {
  readonly requestId: string;
  readonly subjectId: string;
  readonly deployment: EdgeDeployment;
}

export type EdgeDeploymentInsertResult =
  | Readonly<{ outcome: "already-exists" }>
  | Readonly<{ outcome: "idempotency-conflict" }>
  | Readonly<{ outcome: "inserted"; deployment: EdgeDeployment }>
  | Readonly<{ outcome: "replayed"; deployment: EdgeDeployment }>
  | Readonly<{ outcome: "storage-unavailable" }>;

export interface EdgeDeploymentReplaceRequest extends EdgeDeploymentScope {
  readonly requestId: string;
  readonly subjectId: string;
  readonly expectedRevision: number;
  readonly deployment: EdgeDeployment;
  readonly eventName:
    | "deployment.observation-recorded.v1"
    | "deployment.rollout-controlled.v1";
}

export type EdgeDeploymentReplaceResult =
  | Readonly<{ outcome: "idempotency-conflict" }>
  | Readonly<{ outcome: "not-found" }>
  | Readonly<{ outcome: "replaced"; deployment: EdgeDeployment }>
  | Readonly<{ outcome: "replayed"; deployment: EdgeDeployment }>
  | Readonly<{ outcome: "storage-unavailable" }>
  | Readonly<{ outcome: "version-conflict" }>;

export interface EdgeDeploymentRepository {
  insert(
    request: EdgeDeploymentInsertRequest,
  ): Promise<EdgeDeploymentInsertResult>;
  replace(
    request: EdgeDeploymentReplaceRequest,
  ): Promise<EdgeDeploymentReplaceResult>;
  find(
    scope: EdgeDeploymentScope,
    deploymentId: EdgeDeploymentId,
  ): Promise<EdgeDeployment | undefined>;
}
