import { createHash } from "node:crypto";

import type {
  InfrastructureEngine,
  InfrastructureEngineFailure,
  InfrastructureEngineFailureCode,
  InfrastructureEnginePlanRequest,
  InfrastructureEnginePlanResult,
  InfrastructureEnginePlanValue,
  InfrastructurePlanArtifact,
} from "@aether-cloud/application";

import type {
  OpenTofuArtifactResolutionRequest,
  OpenTofuArtifactResolver,
  OpenTofuExecutionEvent,
  OpenTofuExecutionObserver,
  OpenTofuExecutionStage,
  OpenTofuPlanArtifactStore,
  OpenTofuProcessRequest,
  OpenTofuProcessResult,
  OpenTofuProcessRunner,
  OpenTofuStateLockLease,
  OpenTofuStateLockManager,
  OpenTofuWorkspace,
  OpenTofuWorkspaceFactory,
} from "./open-tofu-contracts.js";
import { parseOpenTofuPlan } from "./open-tofu-plan-parser.js";

export interface OpenTofuInfrastructureEngineOptions {
  readonly executable: string;
  readonly processRunner: OpenTofuProcessRunner;
  readonly workspaceFactory: OpenTofuWorkspaceFactory;
  readonly artifactResolver: OpenTofuArtifactResolver;
  readonly planArtifactStore: OpenTofuPlanArtifactStore;
  readonly stateLockManager: OpenTofuStateLockManager;
  readonly observer: OpenTofuExecutionObserver;
  readonly commandEnvironment: Readonly<Record<string, string>>;
  readonly commandTimeoutMs: number;
  readonly stateLockTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxSourceArtifactBytes: number;
}

export type OpenTofuInfrastructureEngineCreateResult =
  | Readonly<{ ok: true; value: OpenTofuInfrastructureEngine }>
  | Readonly<{ ok: false; failure: InfrastructureEngineFailure }>;

const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const artifactReferencePattern =
  /^plan-artifact:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]{2,495}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

function failure(
  code: InfrastructureEngineFailureCode,
  retryable: boolean,
): InfrastructureEnginePlanResult {
  return Object.freeze({
    ok: false,
    failure: Object.freeze({ code, retryable }),
  });
}

function createFailure(
  code: InfrastructureEngineFailureCode,
  retryable: boolean,
): OpenTofuInfrastructureEngineCreateResult {
  return Object.freeze({
    ok: false,
    failure: Object.freeze({ code, retryable }),
  });
}

function sha256(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function isExactValue<T extends string>(
  value: unknown,
  expected: T,
): value is T {
  return value === expected;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function safeObserve(
  observer: OpenTofuExecutionObserver,
  event: OpenTofuExecutionEvent,
): void {
  try {
    observer.record(Object.freeze(event));
  } catch {
    // Operational observation must never change Plan behavior.
  }
}

function processEvent(
  correlationId: string,
  stage: OpenTofuExecutionStage,
  result: OpenTofuProcessResult,
): OpenTofuExecutionEvent {
  return result.outcome === "exited"
    ? {
        correlationId,
        stage,
        outcome: result.outcome,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
      }
    : {
        correlationId,
        stage,
        outcome: result.outcome,
        durationMs: result.durationMs,
      };
}

function processFailure(
  result: OpenTofuProcessResult,
  stageFailure: InfrastructureEngineFailureCode,
): InfrastructureEngineFailure | undefined {
  if (result.outcome === "timed-out") {
    return { code: "engine-timeout", retryable: true };
  }
  if (result.outcome === "cancelled") {
    return { code: "engine-cancelled", retryable: true };
  }
  if (result.outcome === "output-limit-exceeded") {
    return { code: "engine-output-limit-exceeded", retryable: false };
  }
  if (result.outcome === "not-found") {
    return { code: "engine-not-installed", retryable: false };
  }
  if (result.outcome === "spawn-failed") {
    return { code: stageFailure, retryable: true };
  }
  return undefined;
}

function isJsonObject(content: Uint8Array): boolean {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(content),
    );
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasStateLockDiagnostic(content: Uint8Array): boolean {
  let lines: string[];
  try {
    lines = new TextDecoder("utf-8", { fatal: true })
      .decode(content)
      .split("\n")
      .filter((line) => line.trim().length > 0);
  } catch {
    return false;
  }
  let supportedUi = false;
  for (const line of lines) {
    let message: Record<string, unknown> | undefined;
    try {
      message = record(JSON.parse(line));
    } catch {
      return false;
    }
    if (message?.type === "version") {
      supportedUi =
        typeof message.ui === "string" && /^1(?:\.|$)/.test(message.ui);
      continue;
    }
    if (!supportedUi || message?.type !== "diagnostic") continue;
    const diagnostic = record(message.diagnostic);
    if (
      diagnostic?.severity === "error" &&
      typeof diagnostic.summary === "string" &&
      /state lock|locking state/i.test(diagnostic.summary)
    ) {
      return true;
    }
  }
  return false;
}

export class OpenTofuInfrastructureEngine implements InfrastructureEngine {
  readonly descriptor: Readonly<{ kind: "opentofu"; version: string }>;
  readonly #options: OpenTofuInfrastructureEngineOptions;

  private constructor(
    options: OpenTofuInfrastructureEngineOptions,
    version: string,
  ) {
    this.#options = Object.freeze({
      ...options,
      commandEnvironment: Object.freeze({ ...options.commandEnvironment }),
    });
    this.descriptor = Object.freeze({ kind: "opentofu", version });
  }

  static async create(
    options: OpenTofuInfrastructureEngineOptions,
  ): Promise<OpenTofuInfrastructureEngineCreateResult> {
    let result: OpenTofuProcessResult;
    try {
      result = await options.processRunner.run({
        executable: options.executable,
        argv: Object.freeze(["version", "-json"]),
        environment: Object.freeze({ ...options.commandEnvironment }),
        timeoutMs: options.commandTimeoutMs,
        maxOutputBytes: options.maxOutputBytes,
      });
    } catch {
      return createFailure("engine-not-installed", false);
    }
    safeObserve(
      options.observer,
      processEvent("opentofu-engine-probe", "version", result),
    );
    const processProblem = processFailure(result, "engine-version-invalid");
    if (processProblem !== undefined) {
      return createFailure(processProblem.code, processProblem.retryable);
    }
    if (result.outcome !== "exited" || result.exitCode !== 0) {
      return createFailure("engine-version-invalid", false);
    }

    let version: unknown;
    try {
      const decoded: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(result.stdout),
      );
      version =
        typeof decoded === "object" && decoded !== null
          ? (decoded as Record<string, unknown>).terraform_version
          : undefined;
    } catch {
      return createFailure("engine-version-invalid", false);
    }
    if (typeof version !== "string" || !versionPattern.test(version)) {
      return createFailure("engine-version-invalid", false);
    }
    return Object.freeze({
      ok: true,
      value: new OpenTofuInfrastructureEngine(options, version),
    });
  }

  async plan(
    request: InfrastructureEnginePlanRequest,
  ): Promise<InfrastructureEnginePlanResult> {
    if (isAborted(request.signal)) {
      return failure("engine-cancelled", true);
    }

    let workspace: OpenTofuWorkspace;
    try {
      workspace = await this.#options.workspaceFactory.create(request.planId);
    } catch {
      return failure("workspace-creation-failed", true);
    }

    let lease: OpenTofuStateLockLease | undefined;
    let result: InfrastructureEnginePlanResult;
    try {
      const materialization = await this.#materialize(request, workspace);
      if (materialization !== undefined) {
        result = materialization;
      } else {
        let lock;
        try {
          lock = await this.#acquireLock(request);
        } catch {
          lock = {
            ok: false as const,
            failure: {
              code: "unavailable" as const,
              retryable: true,
            },
          };
        }
        if (!lock.ok) {
          result = failure(
            lock.failure.code === "cancelled"
              ? "engine-cancelled"
              : "state-lock-timeout",
            lock.failure.retryable,
          );
        } else {
          lease = lock.value;
          result = isAborted(request.signal)
            ? failure("engine-cancelled", true)
            : await this.#executeLockedPlan(request, workspace);
        }
      }
    } catch {
      result = failure("engine-plan-failed", true);
    }

    if (lease !== undefined) {
      try {
        const released = await lease.release();
        if (!released.ok) {
          result = failure("state-lock-release-failed", released.retryable);
        }
      } catch {
        result = failure("state-lock-release-failed", true);
      }
    }

    try {
      const cleaned = await workspace.cleanup();
      if (!cleaned.ok) {
        result = failure("workspace-cleanup-failed", cleaned.retryable);
      }
    } catch {
      result = failure("workspace-cleanup-failed", true);
    }
    return result;
  }

  async #materialize(
    request: InfrastructureEnginePlanRequest,
    workspace: OpenTofuWorkspace,
  ): Promise<InfrastructureEnginePlanResult | undefined> {
    const selections: readonly OpenTofuArtifactResolutionRequest[] = [
      {
        kind: "module",
        selection: request.module,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
      {
        kind: "topology",
        selection: request.topology,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    ];
    for (const selection of selections) {
      if (isAborted(request.signal)) {
        return failure("engine-cancelled", true);
      }
      let resolved;
      try {
        resolved = await this.#options.artifactResolver.resolve(selection);
      } catch {
        return failure("artifact-materialization-failed", true);
      }
      if (!resolved.ok) {
        return failure(
          "artifact-materialization-failed",
          resolved.failure.retryable,
        );
      }
      if (isAborted(request.signal)) {
        return failure("engine-cancelled", true);
      }
      if (sha256(resolved.value.content) !== selection.selection.digest) {
        return failure("artifact-digest-mismatch", false);
      }
      if (
        resolved.value.content.byteLength >
          this.#options.maxSourceArtifactBytes ||
        !isJsonObject(resolved.value.content)
      ) {
        return failure("artifact-materialization-failed", false);
      }
      try {
        if (selection.kind === "module") {
          await workspace.writeModuleConfiguration(resolved.value.content);
        } else {
          await workspace.writeTopologyVariables(resolved.value.content);
        }
      } catch {
        return failure("artifact-materialization-failed", false);
      }
    }
    return undefined;
  }

  #acquireLock(request: InfrastructureEnginePlanRequest) {
    const input = request.signal
      ? { stateKey: request.stack.state.key, signal: request.signal }
      : { stateKey: request.stack.state.key };
    return this.#options.stateLockManager.acquire(input);
  }

  async #run(
    request: InfrastructureEnginePlanRequest,
    workspace: OpenTofuWorkspace,
    stage: OpenTofuExecutionStage,
    argv: readonly string[],
  ): Promise<OpenTofuProcessResult> {
    const processRequest: OpenTofuProcessRequest = {
      executable: this.#options.executable,
      argv: Object.freeze([...argv]),
      workingDirectory: workspace.directory,
      environment: Object.freeze({ ...this.#options.commandEnvironment }),
      timeoutMs: this.#options.commandTimeoutMs,
      maxOutputBytes: this.#options.maxOutputBytes,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
    const result = await this.#options.processRunner.run(processRequest);
    safeObserve(
      this.#options.observer,
      processEvent(request.planId, stage, result),
    );
    return result;
  }

  async #executeLockedPlan(
    request: InfrastructureEnginePlanRequest,
    workspace: OpenTofuWorkspace,
  ): Promise<InfrastructureEnginePlanResult> {
    const init = await this.#run(request, workspace, "init", [
      "init",
      "-input=false",
      "-no-color",
    ]);
    const initProblem = processFailure(init, "engine-init-failed");
    if (initProblem !== undefined) {
      return failure(initProblem.code, initProblem.retryable);
    }
    if (init.outcome !== "exited" || init.exitCode !== 0) {
      return failure("engine-init-failed", false);
    }

    const validate = await this.#run(request, workspace, "validate", [
      "validate",
      "-json",
    ]);
    const validateProblem = processFailure(validate, "engine-validate-failed");
    if (validateProblem !== undefined) {
      return failure(validateProblem.code, validateProblem.retryable);
    }
    if (
      validate.outcome !== "exited" ||
      validate.exitCode !== 0 ||
      !this.#validValidationOutput(validate.stdout)
    ) {
      return failure("engine-validate-failed", false);
    }

    const plan = await this.#run(request, workspace, "plan", [
      "plan",
      "-json",
      "-input=false",
      "-lock=true",
      `-lock-timeout=${String(this.#options.stateLockTimeoutMs)}ms`,
      "-detailed-exitcode",
      "-no-color",
      `-out=${workspace.savedPlanPath}`,
    ]);
    const planProblem = processFailure(plan, "engine-plan-failed");
    if (planProblem !== undefined) {
      return failure(planProblem.code, planProblem.retryable);
    }
    if (
      plan.outcome !== "exited" ||
      (plan.exitCode !== 0 && plan.exitCode !== 2)
    ) {
      if (plan.outcome === "exited" && hasStateLockDiagnostic(plan.stdout)) {
        return failure("state-lock-timeout", true);
      }
      return failure("engine-plan-failed", false);
    }

    let savedPlan: Uint8Array;
    try {
      // Restrict and validate the sensitive file before another command reads it.
      savedPlan = await workspace.readSavedPlan();
    } catch {
      return failure("artifact-store-failed", true);
    }

    const show = await this.#run(request, workspace, "show", [
      "show",
      "-json",
      workspace.savedPlanPath,
    ]);
    const showProblem = processFailure(show, "engine-show-failed");
    if (showProblem !== undefined) {
      return failure(showProblem.code, showProblem.retryable);
    }
    if (show.outcome !== "exited" || show.exitCode !== 0) {
      return failure("engine-show-failed", false);
    }
    const parsed = parseOpenTofuPlan(show.stdout);
    if (parsed === undefined) return failure("plan-json-invalid", false);
    if (isAborted(request.signal)) {
      return failure("engine-cancelled", true);
    }
    const savedPlanDigest = sha256(savedPlan);
    let stored;
    try {
      stored = await this.#options.planArtifactStore.store({
        planId: request.planId,
        content: savedPlan,
        digest: savedPlanDigest,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch {
      return failure("artifact-store-failed", true);
    }
    if (!stored.ok) {
      return failure("artifact-store-failed", stored.failure.retryable);
    }
    if (isAborted(request.signal)) {
      return failure("engine-cancelled", true);
    }
    if (!this.#validArtifact(stored.value, savedPlanDigest)) {
      return failure("artifact-store-failed", false);
    }
    const value: InfrastructureEnginePlanValue = Object.freeze({
      planId: request.planId,
      stackId: request.stack.id,
      stateKey: request.stack.state.key,
      jsonFormatVersion: parsed.formatVersion,
      artifact: Object.freeze({ ...stored.value }),
      stateLock: Object.freeze({
        stateKey: request.stack.state.key,
        outcome: "acquired-and-released",
      }),
      resourceChanges: parsed.resourceChanges,
    });
    return Object.freeze({ ok: true, value });
  }

  #validValidationOutput(content: Uint8Array): boolean {
    try {
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(content),
      );
      return (
        typeof value === "object" &&
        value !== null &&
        (value as Record<string, unknown>).valid === true
      );
    } catch {
      return false;
    }
  }

  #validArtifact(
    artifact: InfrastructurePlanArtifact,
    expectedDigest: string,
  ): boolean {
    return (
      isExactValue(artifact.protection, "encrypted") &&
      isExactValue(artifact.sensitivity, "contains-sensitive-values") &&
      artifact.digest === expectedDigest &&
      digestPattern.test(artifact.digest) &&
      artifactReferencePattern.test(artifact.reference)
    );
  }
}
