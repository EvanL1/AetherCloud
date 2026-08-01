import { composeCloudLinkRuntime } from "./runtime.js";

/**
 * `close()` is unbounded. It awaits any in-flight `start()`, and while the
 * Broker connect is bounded by `connectTimeoutMs`, neither the subscribe, the
 * drain of in-flight uplinks, nor the transport close carries an upper bound.
 * A signal handler that simply awaits it can therefore wait forever, and a
 * process that never exits looks exactly like one that stopped cleanly.
 *
 * Fifteen seconds sits above the bounds this composition does set - a five
 * second Broker connect plus a five second PostgreSQL statement timeout for
 * work already in flight - and below the thirty second Railway draining window,
 * so an overrun reports itself instead of being replaced by an unexplained
 * SIGKILL. It is deliberately not configurable: an operator who needed to raise
 * it would be describing a stuck close, which is a defect to fix rather than a
 * value to tune.
 */
const shutdownDeadlineMs = 15_000;

const runtime = composeCloudLinkRuntime(process.env);

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
 * A signal during a failing start reaches both callers below, and `close()` is
 * itself idempotent, so the outcome is decided once rather than reported twice.
 */
let closing: Promise<CloseOutcome> | undefined;

function close(): Promise<CloseOutcome> {
  closing ??= runtime.close().then(
    (): CloseOutcome => "closed",
    (error: unknown): CloseOutcome => {
      process.stderr.write(`cloudlink close failed: ${String(error)}\n`);
      return "failed";
    },
  );
  return closing;
}

/**
 * Races the close against the deadline and leaves non-zero for anything but a
 * clean close. `process.exit` is the point: both losing outcomes mean the
 * Broker connection state is unknown, and this ingress owns a stable client id
 * that the next instance needs back.
 */
async function closeOrExit(): Promise<void> {
  const outcome = await Promise.race([close(), deadline()]);
  if (outcome === "closed") return;
  process.stderr.write(
    outcome === "timed-out"
      ? `cloudlink close exceeded ${String(shutdownDeadlineMs)}ms; exiting without a clean Broker close\n`
      : "cloudlink exiting without a clean Broker close\n",
  );
  process.exit(1);
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (closing === undefined) {
    process.stderr.write(`cloudlink shutting down on ${signal}\n`);
  }
  await closeOrExit();
}

/**
 * `on`, not `once`. A stop reaches this process more than once: a container
 * runtime signals the whole process group, and `pnpm run` forwards a signal to
 * the script as well. A one-shot listener removes itself on the first delivery,
 * which restores the default disposition, so the second delivery kills the
 * process mid-shutdown and the deadline below never gets to report anything.
 * Every path below is idempotent, so repeated signals are harmless.
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

try {
  await runtime.start();
  process.stderr.write(
    `cloudlink ingress started with ${runtime.projectionStoreMode} projection store\n`,
  );
} catch (error: unknown) {
  process.stderr.write(`cloudlink failed to start: ${String(error)}\n`);
  process.exitCode = 1;
  await closeOrExit();
}
