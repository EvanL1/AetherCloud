import { spawn } from "node:child_process";

import type {
  OpenTofuProcessRequest,
  OpenTofuProcessResult,
  OpenTofuProcessRunner,
} from "./open-tofu-contracts.js";

export interface NodeOpenTofuProcessRunnerOptions {
  readonly killGracePeriodMs?: number;
}

type TerminationOutcome = Exclude<
  OpenTofuProcessResult["outcome"],
  "exited" | "not-found" | "spawn-failed"
>;

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export class NodeOpenTofuProcessRunner implements OpenTofuProcessRunner {
  readonly #killGracePeriodMs: number;

  constructor(options: NodeOpenTofuProcessRunnerOptions = {}) {
    this.#killGracePeriodMs = options.killGracePeriodMs ?? 1_000;
  }

  run(request: OpenTofuProcessRequest): Promise<OpenTofuProcessResult> {
    const startedAt = performance.now();
    if (request.signal?.aborted === true) {
      return Promise.resolve({
        outcome: "cancelled",
        durationMs: elapsedMilliseconds(startedAt),
      });
    }

    return new Promise((resolve) => {
      let settled = false;
      let requestedTermination: TerminationOutcome | undefined;
      let forcedKill: ReturnType<typeof setTimeout> | undefined;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let capturedBytes = 0;

      let child;
      try {
        child = spawn(request.executable, [...request.argv], {
          cwd: request.workingDirectory,
          env: { ...request.environment },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        resolve({
          outcome: "spawn-failed",
          durationMs: elapsedMilliseconds(startedAt),
        });
        return;
      }

      const onAbort = () => {
        terminate("cancelled");
      };

      const finish = (result: OpenTofuProcessResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (forcedKill !== undefined) clearTimeout(forcedKill);
        request.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const terminate = (outcome: TerminationOutcome) => {
        if (requestedTermination !== undefined || settled) return;
        requestedTermination = outcome;
        child.kill("SIGTERM");
        forcedKill = setTimeout(() => {
          child.kill("SIGKILL");
        }, this.#killGracePeriodMs);
        forcedKill.unref();
      };

      const capture = (target: Buffer[], chunk: Buffer) => {
        if (requestedTermination !== undefined) return;
        capturedBytes += chunk.byteLength;
        if (capturedBytes > request.maxOutputBytes) {
          terminate("output-limit-exceeded");
          return;
        }
        target.push(chunk);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        capture(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        capture(stderr, chunk);
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        finish({
          outcome: error.code === "ENOENT" ? "not-found" : "spawn-failed",
          durationMs: elapsedMilliseconds(startedAt),
        });
      });
      child.once("close", (exitCode) => {
        if (requestedTermination !== undefined) {
          finish({
            outcome: requestedTermination,
            durationMs: elapsedMilliseconds(startedAt),
          });
          return;
        }
        finish({
          outcome: "exited",
          exitCode: exitCode ?? 1,
          stdout: new Uint8Array(Buffer.concat(stdout)),
          stderr: new Uint8Array(Buffer.concat(stderr)),
          durationMs: elapsedMilliseconds(startedAt),
        });
      });

      const deadline = setTimeout(() => {
        terminate("timed-out");
      }, request.timeoutMs);
      deadline.unref();
      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.signal?.aborted === true) onAbort();
    });
  }
}
