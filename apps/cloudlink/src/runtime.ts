import {
  OpenCloudLinkSession,
  RecordCloudLinkDurableCursor,
  RecordCloudLinkHeartbeat,
  ReportGatewayRuntimeManifest,
  ReportIntegrationObservations,
  ReportIntegrationTopology,
  RestoreGatewayRuntimeProtocols,
  type GatewayCredentialAssertion,
} from "@aether-cloud/application";
import {
  InMemoryCloudLinkSessionRepository,
  InMemoryGatewayCredentialVerifier,
  type InMemoryGatewayCredentialRecord,
} from "@aether-cloud/cloudlink-memory-adapter";
import { PostgresCloudLinkSessionRepository } from "@aether-cloud/cloudlink-postgres-adapter";
import {
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";
import { NodeIntegrationPayloadDigestor } from "@aether-cloud/integration-projection-memory-adapter";
import {
  InMemoryRuntimeManifestRepository,
  NodeRuntimeManifestIntegrityVerifier,
} from "@aether-cloud/runtime-memory-adapter";
import { randomUUID } from "node:crypto";

import {
  startCloudLinkMqttIngress,
  type CloudLinkMqttTransportConnector,
  type RunningCloudLinkMqttIngress,
} from "./cloudlink-mqtt-ingress.js";
import {
  composeIntegrationProjectionStore,
  type IntegrationProjectionStore,
} from "./integration-projection-store.js";

const integrationExtension = "aether.cloudlink.integration.v1alpha1" as const;
const credentialsVariable =
  "AETHER_CLOUD_CLOUDLINK_TRUSTED_GATEWAY_CREDENTIALS";
const credentialFields = ["gatewayId", "credentialId", "generation", "proof"];
const maximumCredentials = 64;
const maximumCredentialIdLength = 256;
/** Matches the CloudLink bridge bound on a trusted connector proof. */
const maximumProofBytes = 4096;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalUint64Pattern = /^(?:0|[1-9][0-9]*)$/;

/**
 * A0 does not consume telemetry. A silent no-op would let a Gateway believe its
 * telemetry was accepted, so the composition rejects it explicitly instead.
 */
const rejectedTelemetryCommand = {
  execute: () =>
    Promise.resolve({
      ok: false as const,
      failure: {
        code: "invalid-input" as const,
        message:
          "telemetry ingestion is not part of the read-only A0 composition",
      },
    }),
};

export interface CloudLinkRuntime {
  readonly enabledExtensions: readonly [typeof integrationExtension];
  readonly projectionStoreMode: "memory" | "postgres";
  readonly running: boolean;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface CloudLinkRuntimeFactories {
  /** Production connects the Node MQTT transport; tests inject a fake. */
  readonly connector?: CloudLinkMqttTransportConnector;
  /** Production composes the store from the environment; tests inject one. */
  readonly projectionStore?: IntegrationProjectionStore;
}

interface TrustedGatewayCredential {
  readonly gatewayId: string;
  readonly credentialId: string;
  readonly generation: string;
  readonly proof: string;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredUuid(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name);
  if (!canonicalUuidPattern.test(value)) {
    throw new Error(`${name} must be a canonical lowercase UUID`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const credentialShapeMessage = `${credentialsVariable} entries must declare exactly gatewayId, credentialId, generation, and proof`;

function credentialField(
  entry: Record<string, unknown>,
  field: string,
): string {
  const value = entry[field];
  if (typeof value !== "string") throw new Error(credentialShapeMessage);
  return value;
}

/**
 * Decodes operator-supplied trusted connector credentials. Every rejection
 * names the environment variable and never reproduces any configured value,
 * because the `proof` of each entry is a long-lived secret.
 */
function decodeTrustedGatewayCredentials(
  environment: NodeJS.ProcessEnv,
): readonly TrustedGatewayCredential[] {
  const raw = required(environment, credentialsVariable);
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${credentialsVariable} must be a JSON array`);
  }
  if (!Array.isArray(decoded)) {
    throw new Error(`${credentialsVariable} must be a JSON array`);
  }
  if (decoded.length === 0 || decoded.length > maximumCredentials) {
    throw new Error(
      `${credentialsVariable} must declare 1-${String(maximumCredentials)} Gateway credentials`,
    );
  }
  const credentialIds = new Set<string>();
  return Object.freeze(
    decoded.map((entry) => {
      if (
        !isRecord(entry) ||
        Object.keys(entry).length !== credentialFields.length ||
        !credentialFields.every((field) =>
          Object.prototype.hasOwnProperty.call(entry, field),
        )
      ) {
        throw new Error(credentialShapeMessage);
      }
      const gatewayId = credentialField(entry, "gatewayId");
      const credentialId = credentialField(entry, "credentialId");
      const generation = credentialField(entry, "generation");
      const proof = credentialField(entry, "proof");
      if (!canonicalUuidPattern.test(gatewayId)) {
        throw new Error(
          `${credentialsVariable} gatewayId must be a canonical lowercase UUID`,
        );
      }
      if (
        credentialId.length === 0 ||
        credentialId.length > maximumCredentialIdLength
      ) {
        throw new Error(
          `${credentialsVariable} credentialId must be 1-${String(maximumCredentialIdLength)} characters`,
        );
      }
      if (credentialIds.has(credentialId)) {
        throw new Error(
          `${credentialsVariable} credentialId values must be unique`,
        );
      }
      credentialIds.add(credentialId);
      if (!canonicalUint64Pattern.test(generation)) {
        throw new Error(
          `${credentialsVariable} generation must be a canonical uint64 string`,
        );
      }
      if (
        proof.length === 0 ||
        Buffer.byteLength(proof, "utf8") > maximumProofBytes
      ) {
        throw new Error(
          `${credentialsVariable} proof must be 1-${String(maximumProofBytes)} bytes`,
        );
      }
      return Object.freeze({ gatewayId, credentialId, generation, proof });
    }),
  );
}

function credentialRecords(
  credentials: readonly TrustedGatewayCredential[],
  tenantId: string,
  projectId: string,
): readonly InMemoryGatewayCredentialRecord[] {
  return credentials.map((credential) => ({
    assertion: {
      credentialId: credential.credentialId,
      proof: credential.proof,
    },
    binding: {
      tenantId: parseTenantId(tenantId),
      projectId: parseProjectId(projectId),
      gatewayId: parseGatewayId(credential.gatewayId),
      generation: parseGatewayCredentialGeneration(credential.generation),
      status: "active",
    },
  }));
}

/**
 * Resolves the operator-configured attestation for a `session-hello` whose
 * origin model is not Gateway-signed. Publisher authorization itself is the
 * Broker's ACL, exactly as ADR-0014 decision 5 permits for a reviewed trusted
 * connector; this resolver only produces the credential the operator bound to
 * that Gateway out of band. Nothing derived from the wire is echoed back.
 */
class ConfiguredTrustedConnectorCredentials {
  readonly #credentials: ReadonlyMap<string, GatewayCredentialAssertion>;

  constructor(credentials: readonly TrustedGatewayCredential[]) {
    this.#credentials = new Map(
      credentials.map((credential) => [
        `${credential.gatewayId}\0${credential.credentialId}\0${credential.generation}`,
        Object.freeze({
          credentialId: credential.credentialId,
          proof: credential.proof,
        }),
      ]),
    );
  }

  execute(input: unknown): Promise<unknown> {
    const credential = this.#lookup(input);
    return Promise.resolve(
      credential === undefined
        ? {
            ok: false as const,
            failure: {
              code: "invalid-gateway-credential" as const,
              message: "no trusted connector credential is configured",
            },
          }
        : { ok: true as const, value: credential },
    );
  }

  /** The lookup key comes straight off the wire and is never trusted. */
  #lookup(input: unknown): GatewayCredentialAssertion | undefined {
    if (!isRecord(input)) return undefined;
    const { gatewayId, credentialId, credentialGeneration } = input;
    return typeof gatewayId === "string" &&
      typeof credentialId === "string" &&
      typeof credentialGeneration === "string"
      ? this.#credentials.get(
          `${gatewayId}\0${credentialId}\0${credentialGeneration}`,
        )
      : undefined;
  }
}

export function composeCloudLinkRuntime(
  environment: NodeJS.ProcessEnv,
  factories: CloudLinkRuntimeFactories = {},
): CloudLinkRuntime {
  const brokerUrl = required(environment, "AETHER_CLOUD_CLOUDLINK_MQTT_URL");
  const topicPrefix = required(
    environment,
    "AETHER_CLOUD_CLOUDLINK_TOPIC_PREFIX",
  );
  const tenantId = requiredUuid(environment, "AETHER_CLOUD_TENANT_ID");
  const projectId = requiredUuid(environment, "AETHER_CLOUD_PROJECT_ID");
  const credentials = decodeTrustedGatewayCredentials(environment);
  const username = environment.AETHER_CLOUD_CLOUDLINK_MQTT_USERNAME;
  const password = environment.AETHER_CLOUD_CLOUDLINK_MQTT_PASSWORD;

  const store =
    factories.projectionStore ?? composeIntegrationProjectionStore(environment);
  // Sessions follow the projection store so a deployment can never combine
  // durable projections with sessions that vanish on restart.
  const sessions =
    store.pool === undefined
      ? new InMemoryCloudLinkSessionRepository()
      : new PostgresCloudLinkSessionRepository(store.pool);
  // The source of truth for Gateway credentials is operator configuration, not
  // a cloud database: AetherCloud never persists a long-lived Gateway secret.
  const credentialVerifier = new InMemoryGatewayCredentialVerifier(
    credentialRecords(credentials, tenantId, projectId),
  );
  // A0 has no PostgreSQL Runtime Manifest adapter. Declarations therefore live
  // only in this process and a restart fails Integration uplinks closed until
  // the Gateway reports its manifest again.
  const manifests = new InMemoryRuntimeManifestRepository();
  const clock = { now: () => parseUtcInstant(new Date().toISOString()) };
  const projectionDependencies = {
    repository: store.repository,
    verifier: credentialVerifier,
    digestor: new NodeIntegrationPayloadDigestor(),
    clock,
  };

  let ingress: RunningCloudLinkMqttIngress | undefined;
  let closePromise: Promise<void> | undefined;

  return {
    enabledExtensions: [integrationExtension],
    projectionStoreMode: store.pool === undefined ? "memory" : "postgres",
    get running() {
      return ingress !== undefined;
    },
    async start(): Promise<void> {
      if (ingress !== undefined) {
        throw new Error("CloudLink ingress is already running");
      }
      ingress = await startCloudLinkMqttIngress({
        connection: {
          url: brokerUrl,
          clientId: `aether-cloud-cloudlink-${randomUUID()}`,
          protocolVersion: 4,
          connectTimeoutMs: 5_000,
          ...(username === undefined || username.length === 0
            ? {}
            : { username }),
          ...(password === undefined || password.length === 0
            ? {}
            : { password }),
        },
        ...(factories.connector === undefined
          ? {}
          : { connector: factories.connector }),
        topicPrefix,
        resolveTrustedConnectorCredential:
          new ConfiguredTrustedConnectorCredentials(credentials),
        openSession: new OpenCloudLinkSession({
          repository: sessions,
          credentialVerifier,
          clock,
          sessionIds: { next: () => parseCloudLinkSessionId(randomUUID()) },
          supportedProtocolVersions: ["1.0"],
        }),
        heartbeat: new RecordCloudLinkHeartbeat({
          repository: sessions,
          credentialVerifier,
          clock,
        }),
        reportManifest: new ReportGatewayRuntimeManifest({
          repository: manifests,
          credentialVerifier,
          integrityVerifier: new NodeRuntimeManifestIntegrityVerifier(),
          clock,
        }),
        restoreRuntimeProtocols: new RestoreGatewayRuntimeProtocols({
          repository: manifests,
          credentialVerifier,
        }),
        ingestTelemetry: rejectedTelemetryCommand,
        reportIntegrationTopology: new ReportIntegrationTopology(
          projectionDependencies,
        ),
        reportIntegrationObservations: new ReportIntegrationObservations(
          projectionDependencies,
        ),
        recordDurableCursor: new RecordCloudLinkDurableCursor({
          repository: sessions,
          credentialVerifier,
          clock,
        }),
        enabledExtensions: [integrationExtension],
        clock,
      });
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        const running = ingress;
        ingress = undefined;
        await running?.close();
        await store.pool?.end();
      })();
      return closePromise;
    },
  };
}
