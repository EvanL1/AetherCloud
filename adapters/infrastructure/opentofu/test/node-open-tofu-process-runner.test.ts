import { describe, expect, it } from "vitest";

import {
  NodeOpenTofuProcessRunner,
  type OpenTofuProcessRequest,
} from "../src/index.js";

const decoder = new TextDecoder();

function request(
  argv: readonly string[],
  overrides: Partial<OpenTofuProcessRequest> = {},
): OpenTofuProcessRequest {
  return {
    executable: process.execPath,
    argv,
    environment: { PATH: process.env.PATH ?? "" },
    timeoutMs: 2_000,
    maxOutputBytes: 65_536,
    ...overrides,
  };
}

describe("NodeOpenTofuProcessRunner", () => {
  it("passes literal argv without a shell", async () => {
    const runner = new NodeOpenTofuProcessRunner();
    const literal = "value; $(touch must-not-exist) && echo unsafe";

    const result = await runner.run(
      request([
        "-e",
        "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
        literal,
      ]),
    );

    expect(result.outcome).toBe("exited");
    if (result.outcome !== "exited") return;
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(result.stdout))).toEqual([literal]);
  });

  it("passes only the explicitly supplied environment", async () => {
    const runner = new NodeOpenTofuProcessRunner();

    const result = await runner.run(
      request(
        [
          "-e",
          "process.stdout.write(JSON.stringify({only:process.env.ONLY_ME,home:process.env.HOME}))",
        ],
        { environment: { ONLY_ME: "visible" } },
      ),
    );

    expect(result.outcome).toBe("exited");
    if (result.outcome !== "exited") return;
    expect(JSON.parse(decoder.decode(result.stdout))).toEqual({
      only: "visible",
    });
  });

  it("returns not-found for a missing executable", async () => {
    const runner = new NodeOpenTofuProcessRunner();

    const result = await runner.run({
      ...request([]),
      executable: "/aether-cloud/missing/tofu",
    });

    expect(result).toMatchObject({ outcome: "not-found" });
  });

  it("terminates a command that exceeds its deadline", async () => {
    const runner = new NodeOpenTofuProcessRunner({ killGracePeriodMs: 10 });

    const result = await runner.run(
      request(["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 20 }),
    );

    expect(result).toMatchObject({ outcome: "timed-out" });
  });

  it("does not start an already-cancelled command", async () => {
    const runner = new NodeOpenTofuProcessRunner();
    const controller = new AbortController();
    controller.abort();

    const result = await runner.run(
      request(["-e", "setTimeout(() => {}, 10000)"], {
        signal: controller.signal,
      }),
    );

    expect(result).toMatchObject({ outcome: "cancelled" });
  });

  it("terminates a running command when cancellation is requested", async () => {
    const runner = new NodeOpenTofuProcessRunner({ killGracePeriodMs: 10 });
    const controller = new AbortController();
    const pending = runner.run(
      request(["-e", "setTimeout(() => {}, 10000)"], {
        signal: controller.signal,
      }),
    );

    controller.abort();

    await expect(pending).resolves.toMatchObject({ outcome: "cancelled" });
  });

  it("terminates a running command when cancellation is requested", async () => {
    const runner = new NodeOpenTofuProcessRunner({ killGracePeriodMs: 10 });
    const controller = new AbortController();
    const running = runner.run(
      request(["-e", "setTimeout(() => {}, 10000)"], {
        signal: controller.signal,
      }),
    );

    setTimeout(() => {
      controller.abort();
    }, 20);

    await expect(running).resolves.toMatchObject({ outcome: "cancelled" });
  });

  it("terminates a command whose captured output exceeds the limit", async () => {
    const runner = new NodeOpenTofuProcessRunner({ killGracePeriodMs: 10 });

    const result = await runner.run(
      request(["-e", 'process.stdout.write("x".repeat(4096))'], {
        maxOutputBytes: 128,
      }),
    );

    expect(result).toMatchObject({ outcome: "output-limit-exceeded" });
  });
});
