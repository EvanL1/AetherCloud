import type {
  GatewayId,
  IntegrationId,
  IntegrationKind,
  IntegrationSnapshotGeneration,
  ProjectId,
  TenantId,
  UtcInstant,
} from "@aether-cloud/domain";

export interface IntegrationProjectionCatalogPosition {
  readonly gatewayId: GatewayId;
  readonly integrationId: IntegrationId;
}

export interface IntegrationProjectionCatalogQuery {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId?: GatewayId;
  readonly after?: IntegrationProjectionCatalogPosition;
  /**
   * Maximum rows fetched from storage. The application passes requested
   * page-size + 1 so adapters can provide stable keyset pagination.
   */
  readonly limit: number;
}

export interface IntegrationProjectionCatalogRecord {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly integrationId: IntegrationId;
  readonly integrationKind: IntegrationKind;
  readonly snapshotGeneration: IntegrationSnapshotGeneration;
  readonly entityCount: number;
  readonly latestObservationCount: number;
  readonly receivedAt: UtcInstant;
  readonly revision: number;
}

/**
 * Read-only discovery port kept separate from the projection write repository.
 */
export interface IntegrationProjectionCatalog {
  list(
    query: IntegrationProjectionCatalogQuery,
  ): Promise<readonly IntegrationProjectionCatalogRecord[]>;
}
