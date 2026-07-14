import type {
  InfrastructureModuleSelection,
  InfrastructurePlanArtifact,
} from "@aether-cloud/application";
import type { InfrastructurePlanId } from "@aether-cloud/domain";

export type OpenTofuExecutionStage =
  | "init"
  | "plan"
  | "show"
  | "validate"
  | "version";

export interface OpenTofuProcessRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly workingDirectory?: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export type OpenTofuProcessResult =
  | Readonly<{
      outcome: "exited";
      exitCode: number;
      stdout: Uint8Array;
      stderr: Uint8Array;
      durationMs: number;
    }>
  | Readonly<{
      outcome:
        | "cancelled"
        | "not-found"
        | "output-limit-exceeded"
        | "spawn-failed"
        | "timed-out";
      durationMs: number;
    }>;

export interface OpenTofuProcessRunner {
  run(request: OpenTofuProcessRequest): Promise<OpenTofuProcessResult>;
}

export type OpenTofuArtifactResolutionRequest =
  | Readonly<{
      kind: "module";
      selection: InfrastructureModuleSelection;
      signal?: AbortSignal;
    }>
  | Readonly<{
      kind: "topology";
      selection: Readonly<{ reference: string; digest: string }>;
      signal?: AbortSignal;
    }>;

export type OpenTofuArtifactResolutionResult =
  | Readonly<{ ok: true; value: Readonly<{ content: Uint8Array }> }>
  | Readonly<{ ok: false; failure: Readonly<{ retryable: boolean }> }>;

export interface OpenTofuArtifactResolver {
  resolve(
    request: OpenTofuArtifactResolutionRequest,
  ): Promise<OpenTofuArtifactResolutionResult>;
}

export interface OpenTofuPlanArtifactStoreRequest {
  readonly planId: InfrastructurePlanId;
  readonly content: Uint8Array;
  readonly digest: string;
  readonly signal?: AbortSignal;
}

export type OpenTofuPlanArtifactStoreResult =
  | Readonly<{ ok: true; value: InfrastructurePlanArtifact }>
  | Readonly<{ ok: false; failure: Readonly<{ retryable: boolean }> }>;

export interface OpenTofuPlanArtifactStore {
  store(
    request: OpenTofuPlanArtifactStoreRequest,
  ): Promise<OpenTofuPlanArtifactStoreResult>;
}

export interface OpenTofuWorkspace {
  readonly directory: string;
  readonly savedPlanPath: string;

  writeModuleConfiguration(content: Uint8Array): Promise<void>;
  writeTopologyVariables(content: Uint8Array): Promise<void>;
  readSavedPlan(): Promise<Uint8Array>;
  cleanup(): Promise<
    Readonly<{ ok: true } | { ok: false; retryable: boolean }>
  >;
}

export interface OpenTofuWorkspaceFactory {
  create(planId: InfrastructurePlanId): Promise<OpenTofuWorkspace>;
}

export interface OpenTofuStateLockLease {
  release(): Promise<
    Readonly<{ ok: true } | { ok: false; retryable: boolean }>
  >;
}

export interface OpenTofuStateLockManager {
  acquire(
    input: Readonly<{
      stateKey: string;
      signal?: AbortSignal;
    }>,
  ): Promise<
    | Readonly<{ ok: true; value: OpenTofuStateLockLease }>
    | Readonly<{
        ok: false;
        failure: Readonly<{
          code: "cancelled" | "contended" | "unavailable";
          retryable: boolean;
        }>;
      }>
  >;
}

export interface OpenTofuExecutionEvent {
  readonly correlationId: string;
  readonly stage: OpenTofuExecutionStage;
  readonly outcome: OpenTofuProcessResult["outcome"];
  readonly durationMs: number;
  readonly exitCode?: number;
}

export interface OpenTofuExecutionObserver {
  record(event: OpenTofuExecutionEvent): void;
}
