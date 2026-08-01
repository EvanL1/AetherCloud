import { composeApiRuntime } from "./runtime.js";

/**
 * `close()` is unbounded. `app.close()` is bounded in practice because Fastify
 * force-closes every connection, but the CloudLink health sweep and both
 * PostgreSQL pools are not: `connectionTimeoutMillis` bounds only connection
 * acquisition, and `statement_timeout` is a server-side setting, so a database
 * that accepts a connection and then stops answering leaves a client checked
 * out and `pool.end()` waiting for it forever. A signal handler that simply
 * awaits the close then hangs until the platform kills it, which is
 * indistinguishable from a clean stop.
 *
 * Twenty seconds sits above the close this composition can actually bound - a
 * ten second health-sweep statement timeout plus a five second connection
 * acquisition - and ten seconds below the Railway draining window, so an
 * overrun reports itself instead of being replaced by an unexplained SIGKILL.
 * It is longer than the CloudLink ingress deadline because the slowest bounded
 * step here is a ten second statement timeout rather than a five second one.
 */
const shutdownDeadlineMs = 20_000;

const runtime = composeApiRuntime(process.env);
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";

type CloseOutcome = "closed" | "failed" | "timed-out";

/** Unreferenced so a clean close exits immediately instead of waiting it out. */
function deadline(): Promise<CloseOutcome> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve("timed-out");
    }, shutdownDeadlineMs).unref();
  });
}

/**
 * A signal during a failing listen reaches both callers below, and the runtime
 * close is itself idempotent, so the outcome is decided once rather than
 * reported twice.
 */
let closing: Promise<CloseOutcome> | undefined;

function close(): Promise<CloseOutcome> {
  closing ??= runtime.close().then(
    (): CloseOutcome => "closed",
    (error: unknown): CloseOutcome => {
      process.stderr.write(`api close failed: ${String(error)}\n`);
      return "failed";
    },
  );
  return closing;
}

/**
 * Races the close against the deadline and leaves non-zero for anything but a
 * clean close. `process.exit` is the point: both losing outcomes mean requests
 * or database clients are still outstanding, and the platform must see a
 * failure rather than a process that quietly refuses to stop.
 */
async function closeOrExit(): Promise<void> {
  const outcome = await Promise.race([close(), deadline()]);
  if (outcome === "closed") return;
  process.stderr.write(
    outcome === "timed-out"
      ? `api close exceeded ${String(shutdownDeadlineMs)}ms; exiting without a clean shutdown\n`
      : "api exiting without a clean shutdown\n",
  );
  process.exit(1);
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (closing === undefined) {
    // The app is composed with `logger: false`, so its logger discards
    // everything; stderr is the only channel an operator actually sees.
    process.stderr.write(`api shutting down on ${signal}\n`);
  }
  await closeOrExit();
}

/**
 * `on`, not `once`. A stop reaches this process more than once: a container
 * runtime signals the whole process group, and `pnpm run` forwards a signal to
 * the script as well. A one-shot listener removes itself on the first delivery,
 * which restores the default disposition, so the second delivery kills the
 * process mid-shutdown. Measured before this change: a group SIGTERM through
 * `pnpm --filter @aether-cloud/api start` exited 143 without ever draining.
 * Every path below is idempotent, so repeated signals are harmless.
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

try {
  await runtime.app.listen({ host, port });
} catch (error: unknown) {
  process.stderr.write(`api failed to listen: ${String(error)}\n`);
  process.exitCode = 1;
  await closeOrExit();
}
