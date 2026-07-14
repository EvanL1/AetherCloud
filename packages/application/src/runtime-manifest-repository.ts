import type {
  GatewayId,
  ProjectId,
  RuntimeManifestObservation,
  TenantId,
} from "@aether-cloud/domain";

export interface RuntimeManifestScope {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

export interface RuntimeManifestIntegrityVerifier {
  verify(manifest: RuntimeManifestObservation["manifest"]): Promise<boolean>;
}

export interface RuntimeManifestRepositoryRecordInput {
  readonly requestId: string;
  readonly observation: RuntimeManifestObservation;
}

export type RuntimeManifestRepositoryRecordResult = Readonly<{
  outcome:
    | "generation-conflict"
    | "idempotency-conflict"
    | "recorded-late"
    | "recorded-latest"
    | "replayed";
}>;

export interface RuntimeManifestRepository {
  record(
    input: RuntimeManifestRepositoryRecordInput,
  ): Promise<RuntimeManifestRepositoryRecordResult>;
  findCurrent(
    scope: RuntimeManifestScope,
    gatewayId: GatewayId,
  ): Promise<RuntimeManifestObservation | undefined>;
  findByGeneration(
    scope: RuntimeManifestScope,
    gatewayId: GatewayId,
    generation: RuntimeManifestObservation["generation"],
  ): Promise<RuntimeManifestObservation | undefined>;
}
