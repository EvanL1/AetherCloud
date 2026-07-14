import type {
  DataExportInsertRequest,
  DataExportInsertResult,
  DataExportReplaceRequest,
  DataExportReplaceResult,
  DataExportRepository,
  DataExportScope,
} from "@aether-cloud/application";
import type { DataExport, DataExportId } from "@aether-cloud/domain";

export interface InMemoryDataExportAuditEvent {
  readonly eventId: string;
  readonly exportId: DataExportId;
  readonly subjectId: string;
  readonly action: "requested" | "updated";
}

export interface InMemoryDataExportOutboxEvent {
  readonly eventId: string;
  readonly exportId: DataExportId;
  readonly eventName:
    | "data.export-requested.v1"
    | "data.export-state-changed.v1";
}

interface StoredRequest {
  readonly fingerprint: string;
  readonly exportRequest: DataExport;
}

function scopeKey(scope: DataExportScope): string {
  return `${scope.tenantId}:${scope.projectId}`;
}

function exportKey(scope: DataExportScope, exportId: DataExportId): string {
  return `${scopeKey(scope)}:${exportId}`;
}

function requestKey(scope: DataExportScope, requestId: string): string {
  return `${scopeKey(scope)}:${requestId}`;
}

function fingerprint(exportRequest: DataExport): string {
  return JSON.stringify(exportRequest);
}

export class InMemoryDataExportRepository implements DataExportRepository {
  readonly #exports = new Map<string, DataExport>();
  readonly #requests = new Map<string, StoredRequest>();
  readonly #audit: InMemoryDataExportAuditEvent[] = [];
  readonly #outbox: InMemoryDataExportOutboxEvent[] = [];
  #failNext = false;

  insert(request: DataExportInsertRequest): Promise<DataExportInsertResult> {
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const replay = this.#replay(request, request.exportRequest);
    if (replay !== undefined) return Promise.resolve(replay);
    const identity = exportKey(request, request.exportRequest.exportId);
    if (this.#exports.has(identity)) {
      return Promise.resolve({ outcome: "already-exists" });
    }
    this.#exports.set(identity, request.exportRequest);
    this.#remember(request, request.exportRequest);
    this.#recordEvidence(request, "requested", "data.export-requested.v1");
    return Promise.resolve({
      outcome: "inserted",
      exportRequest: request.exportRequest,
    });
  }

  replace(request: DataExportReplaceRequest): Promise<DataExportReplaceResult> {
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const replay = this.#replay(request, request.exportRequest);
    if (replay !== undefined) return Promise.resolve(replay);
    const identity = exportKey(request, request.exportRequest.exportId);
    const current = this.#exports.get(identity);
    if (current === undefined) return Promise.resolve({ outcome: "not-found" });
    if (current.revision !== request.expectedRevision) {
      return Promise.resolve({ outcome: "version-conflict" });
    }
    this.#exports.set(identity, request.exportRequest);
    this.#remember(request, request.exportRequest);
    this.#recordEvidence(request, "updated", "data.export-state-changed.v1");
    return Promise.resolve({
      outcome: "replaced",
      exportRequest: request.exportRequest,
    });
  }

  find(
    scope: DataExportScope,
    exportId: DataExportId,
  ): Promise<DataExport | undefined> {
    return Promise.resolve(this.#exports.get(exportKey(scope, exportId)));
  }

  failNextPersistence(): void {
    this.#failNext = true;
  }

  exportCount(): number {
    return this.#exports.size;
  }

  auditEvents(): readonly InMemoryDataExportAuditEvent[] {
    return Object.freeze([...this.#audit]);
  }

  pendingOutboxEvents(): readonly InMemoryDataExportOutboxEvent[] {
    return Object.freeze([...this.#outbox]);
  }

  #replay(
    request: DataExportInsertRequest | DataExportReplaceRequest,
    exportRequest: DataExport,
  ):
    | Readonly<{ outcome: "idempotency-conflict" }>
    | Readonly<{ outcome: "replayed"; exportRequest: DataExport }>
    | undefined {
    const prior = this.#requests.get(requestKey(request, request.requestId));
    if (prior === undefined) return undefined;
    return prior.fingerprint === fingerprint(exportRequest)
      ? { outcome: "replayed", exportRequest: prior.exportRequest }
      : { outcome: "idempotency-conflict" };
  }

  #remember(
    request: DataExportInsertRequest | DataExportReplaceRequest,
    exportRequest: DataExport,
  ): void {
    this.#requests.set(requestKey(request, request.requestId), {
      fingerprint: fingerprint(exportRequest),
      exportRequest,
    });
  }

  #recordEvidence(
    request: DataExportInsertRequest | DataExportReplaceRequest,
    action: InMemoryDataExportAuditEvent["action"],
    eventName: InMemoryDataExportOutboxEvent["eventName"],
  ): void {
    const suffix = `${scopeKey(request)}:${request.exportRequest.exportId}:${request.requestId}`;
    this.#audit.push(
      Object.freeze({
        eventId: `audit:data-export:${suffix}`,
        exportId: request.exportRequest.exportId,
        subjectId: request.subjectId,
        action,
      }),
    );
    this.#outbox.push(
      Object.freeze({
        eventId: `outbox:data-export:${suffix}`,
        exportId: request.exportRequest.exportId,
        eventName,
      }),
    );
  }
}
