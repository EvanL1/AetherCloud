import type {
  AuditEvent,
  AuditSequence,
  ProjectId,
  TenantId,
  UtcInstant,
} from "@aether-cloud/domain";

export interface AuditScope {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

export interface AuditEventSearch {
  readonly limit: number;
  readonly cursor?: AuditSequence;
  readonly action?: string;
  readonly subjectId?: string;
  readonly resourceKind?: string;
  readonly resourceId?: string;
  readonly from?: UtcInstant;
  readonly to?: UtcInstant;
}

export interface AuditEventSearchResult {
  readonly events: readonly AuditEvent[];
  readonly nextCursor: AuditSequence | undefined;
}

export interface AuditEventRepository {
  search(
    scope: AuditScope,
    query: AuditEventSearch,
  ): Promise<AuditEventSearchResult>;
}
