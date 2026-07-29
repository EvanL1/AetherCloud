import { composeApiRuntime } from "./runtime.js";

const runtime = composeApiRuntime(process.env);
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  runtime.app.log.info({ signal }, "shutting down");
  await runtime.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await runtime.app.listen({ host, port });
} catch (error: unknown) {
  runtime.app.log.error(error);
  await runtime.close();
  process.exitCode = 1;
}
