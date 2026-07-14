import { SearchAuditEvents } from "@aether-cloud/application";
import { InMemoryAuditEventStore } from "@aether-cloud/audit-memory-adapter";

import { buildApp } from "./app.js";
import {
  ConfiguredBearerAuthenticator,
  type ConfiguredBearerSubject,
} from "./configured-bearer-authenticator.js";

function configuredSubject(
  environment: NodeJS.ProcessEnv,
): ConfiguredBearerSubject | undefined {
  const token = environment.AETHER_CLOUD_API_BEARER_TOKEN;
  const tenantId = environment.AETHER_CLOUD_API_TENANT_ID;
  const projectId = environment.AETHER_CLOUD_API_PROJECT_ID;
  const subjectId = environment.AETHER_CLOUD_API_SUBJECT_ID;
  if (
    token === undefined ||
    tenantId === undefined ||
    projectId === undefined ||
    subjectId === undefined
  ) {
    return undefined;
  }
  return {
    token,
    tenantId,
    projectId,
    subjectId,
    permissions: (environment.AETHER_CLOUD_API_PERMISSIONS ?? "")
      .split(",")
      .map((permission) => permission.trim())
      .filter((permission) => permission.length > 0),
  };
}

const auditStore = new InMemoryAuditEventStore();
const app = buildApp({
  version: "0.1.0",
  audit: {
    query: new SearchAuditEvents({ repository: auditStore }),
    authenticator: new ConfiguredBearerAuthenticator(
      configuredSubject(process.env),
    ),
  },
});
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await app.listen({ host, port });
} catch (error: unknown) {
  app.log.error(error);
  process.exitCode = 1;
}
