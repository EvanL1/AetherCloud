import type {
  DataExport,
  DataExportId,
  ProjectId,
  TenantId,
} from "@aether-cloud/domain";

export interface DataExportScope {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

export interface DataExportInsertRequest extends DataExportScope {
  readonly requestId: string;
  readonly subjectId: string;
  readonly exportRequest: DataExport;
}

export type DataExportInsertResult =
  | Readonly<{ outcome: "already-exists" }>
  | Readonly<{ outcome: "idempotency-conflict" }>
  | Readonly<{ outcome: "inserted"; exportRequest: DataExport }>
  | Readonly<{ outcome: "replayed"; exportRequest: DataExport }>
  | Readonly<{ outcome: "storage-unavailable" }>;

export interface DataExportReplaceRequest extends DataExportScope {
  readonly requestId: string;
  readonly subjectId: string;
  readonly expectedRevision: number;
  readonly exportRequest: DataExport;
}

export type DataExportReplaceResult =
  | Readonly<{ outcome: "idempotency-conflict" }>
  | Readonly<{ outcome: "not-found" }>
  | Readonly<{ outcome: "replaced"; exportRequest: DataExport }>
  | Readonly<{ outcome: "replayed"; exportRequest: DataExport }>
  | Readonly<{ outcome: "storage-unavailable" }>
  | Readonly<{ outcome: "version-conflict" }>;

export interface DataExportRepository {
  insert(request: DataExportInsertRequest): Promise<DataExportInsertResult>;
  replace(request: DataExportReplaceRequest): Promise<DataExportReplaceResult>;
  find(
    scope: DataExportScope,
    exportId: DataExportId,
  ): Promise<DataExport | undefined>;
}
