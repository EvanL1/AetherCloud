import {
  OpenCloudLinkSession,
  RecordCloudLinkDurableCursor,
  RecordCloudLinkHeartbeat,
  ReportGatewayRuntimeManifest,
  ReportIntegrationObservations,
  ReportIntegrationTopology,
  RestoreGatewayRuntimeProtocols,
} from "@aether-cloud/application";
import {
  InMemoryCloudLinkSessionRepository,
  InMemoryGatewayCredentialVerifier,
} from "@aether-cloud/cloudlink-memory-adapter";
import {
  mqttUplinkFilters,
  type NodeMqttTlsFileConfig,
} from "@aether-cloud/cloudlink-mqtt-adapter";
import { PostgresCloudLinkSessionRepository } from "@aether-cloud/cloudlink-postgres-adapter";
import { parseCloudLinkSessionId, parseUtcInstant } from "@aether-cloud/domain";
import { NodeIntegrationPayloadDigestor } from "@aether-cloud/integration-projection-memory-adapter";
import {
  InMemoryRuntimeManifestRepository,
  NodeRuntimeManifestIntegrityVerifier,
} from "@aether-cloud/runtime-memory-adapter";
import { randomUUID } from "node:crypto";

import {
  startCloudLinkMqttIngress,
  type CloudLinkIngressObserver,
  type CloudLinkMqttIngressDependencies,
  type CloudLinkMqttTransportConnector,
  type RunningCloudLinkMqttIngress,
} from "./cloudlink-mqtt-ingress.js";
import {
  composeIntegrationProjectionStore,
  type IntegrationProjectionStore,
} from "./integration-projection-store.js";
import {
  ConfiguredTrustedConnectorCredentials,
  decodeTrustedGatewayCredentials,
  trustedGatewayCredentialRecords,
  type TrustedGatewayCredential,
} from "./trusted-connector-credentials.js";

const integrationExtension = "aether.cloudlink.integration.v1alpha1" as const;
/**
 * Stable so that the `clean: false` Broker session the transport opens is
 * resumed rather than orphaned on every restart. A stable identifier also means
 * two ingress instances sharing it would evict each other, so A0 supports
 * exactly one ingress instance per identifier; multi-instance socket ownership
 * is a planned capability, not a supported deployment today.
 */
const defaultClientId = "aether-cloud-cloudlink-ingress";
const maximumClientIdLength = 128;

/**
 * Raised when a close lands while a start is still connecting. `close()` treats
 * only this hand-off as expected; every other start-path failure propagates.
 */
class IngressClosedDuringStartError extends Error {
  constructor() {
    super("CloudLink ingress is closed");
    this.name = "IngressClosedDuringStartError";
  }
}

/**
 * A0 does not consume telemetry. A silent no-op would let a Gateway believe its
 * telemetry was accepted, so the composition rejects it explicitly instead.
 *
 * Exported so a test can pin the failure payload itself. The MQTT bridge maps
 * both an explicit failure and a malformed success to `rejected`, so observing
 * the outcome alone cannot tell an honest rejection from a silent acceptance.
 */
export const unsupportedTelemetryCommand = {
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
  /** Production writes to stderr; tests assert on the recorded outcomes. */
  readonly observer?: CloudLinkIngressObserver;
  /** Operator-facing diagnostics that carry no CloudLink message outcome. */
  readonly diagnostic?: (message: string) => void;
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
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  ) {
    throw new Error(`${name} must be a canonical lowercase UUID`);
  }
  return value;
}

/**
 * Rejects an invalid prefix at composition time. The transport would otherwise
 * only discover it inside the subscribe call, after a Broker connection exists.
 */
function requiredTopicPrefix(environment: NodeJS.ProcessEnv): string {
  const name = "AETHER_CLOUD_CLOUDLINK_TOPIC_PREFIX";
  const value = required(environment, name);
  try {
    mqttUplinkFilters(value, [integrationExtension]);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function clientId(environment: NodeJS.ProcessEnv): string {
  const name = "AETHER_CLOUD_CLOUDLINK_MQTT_CLIENT_ID";
  const value = environment[name];
  if (value === undefined || value.length === 0) return defaultClientId;
  if (value.length > maximumClientIdLength) {
    throw new Error(
      `${name} must be 1-${String(maximumClientIdLength)} characters`,
    );
  }
  return value;
}

const tlsVariables = {
  caPath: "AETHER_CLOUD_CLOUDLINK_MQTT_TLS_CA_PATH",
  clientCertificate: "AETHER_CLOUD_CLOUDLINK_MQTT_TLS_CLIENT_CERTIFICATE_PATH",
  clientPrivateKey: "AETHER_CLOUD_CLOUDLINK_MQTT_TLS_CLIENT_PRIVATE_KEY_PATH",
} as const;

/**
 * ADR-0014 decision 2 makes Broker TLS trust operator configuration, which a
 * self-signed homelab Broker needs; without it an operator's only options are
 * not connecting or turning verification off somewhere else.
 *
 * The transport accepts the three files only as one mutual-TLS bundle, so a CA
 * alone cannot be expressed and this reproduces that rule rather than inventing
 * a looser one. Absolute-path, symlink, size, permission, and `mqtts` checks
 * stay in the transport; only the all-or-nothing rule is enforced here, where
 * an operator sees it before any Broker connection exists.
 */
function tlsFiles(
  environment: NodeJS.ProcessEnv,
): NodeMqttTlsFileConfig | undefined {
  const caPath = environment[tlsVariables.caPath] ?? "";
  const clientCertificatePath =
    environment[tlsVariables.clientCertificate] ?? "";
  const clientPrivateKeyPath = environment[tlsVariables.clientPrivateKey] ?? "";
  const configured = [
    caPath,
    clientCertificatePath,
    clientPrivateKeyPath,
  ].filter((value) => value.length > 0).length;
  if (configured === 0) return undefined;
  if (configured !== 3) {
    throw new Error(
      `${tlsVariables.caPath}, ${tlsVariables.clientCertificate}, and ${tlsVariables.clientPrivateKey} must be set together or not at all`,
    );
  }
  return { caPath, clientCertificatePath, clientPrivateKeyPath };
}

/** Low-cardinality only: failure codes, never a failure message or payload. */
function stderrObserver(): CloudLinkIngressObserver {
  return {
    messageHandled(result) {
      if (result.outcome === "acknowledged") return;
      process.stderr.write(
        result.outcome === "discarded"
          ? `cloudlink uplink discarded: ${result.failure.code}\n`
          : `cloudlink uplink ${result.outcome}\n`,
      );
    },
    internalFailure() {
      process.stderr.write("cloudlink internal failure\n");
    },
  };
}

interface IngressCollaborators {
  readonly broker: Readonly<{
    url: string;
    clientId: string;
    username?: string;
    password?: string;
    tls?: NodeMqttTlsFileConfig;
  }>;
  readonly connector?: CloudLinkMqttTransportConnector;
  readonly topicPrefix: string;
  readonly credentials: readonly TrustedGatewayCredential[];
  readonly sessions: ConstructorParameters<
    typeof OpenCloudLinkSession
  >[0]["repository"];
  readonly manifests: ConstructorParameters<
    typeof ReportGatewayRuntimeManifest
  >[0]["repository"];
  readonly credentialVerifier: InMemoryGatewayCredentialVerifier;
  readonly projections: ConstructorParameters<
    typeof ReportIntegrationTopology
  >[0]["repository"];
  readonly clock: Readonly<{ now: () => ReturnType<typeof parseUtcInstant> }>;
  readonly observer: CloudLinkIngressObserver;
  readonly diagnostic: (message: string) => void;
}

/** The complete read-only ingress wiring, kept flat and free of lifecycle. */
function ingressDependencies(
  collaborators: IngressCollaborators,
): CloudLinkMqttIngressDependencies {
  const { sessions, manifests, credentialVerifier, clock } = collaborators;
  const projectionDependencies = {
    repository: collaborators.projections,
    verifier: credentialVerifier,
    digestor: new NodeIntegrationPayloadDigestor(),
    clock,
  };
  return {
    connection: {
      ...collaborators.broker,
      protocolVersion: 4,
      connectTimeoutMs: 5_000,
    },
    ...(collaborators.connector === undefined
      ? {}
      : { connector: collaborators.connector }),
    topicPrefix: collaborators.topicPrefix,
    resolveTrustedConnectorCredential:
      new ConfiguredTrustedConnectorCredentials(
        collaborators.credentials,
        collaborators.diagnostic,
      ),
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
    ingestTelemetry: unsupportedTelemetryCommand,
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
    observer: collaborators.observer,
  };
}

export function composeCloudLinkRuntime(
  environment: NodeJS.ProcessEnv,
  factories: CloudLinkRuntimeFactories = {},
): CloudLinkRuntime {
  const brokerUrl = required(environment, "AETHER_CLOUD_CLOUDLINK_MQTT_URL");
  const topicPrefix = requiredTopicPrefix(environment);
  const tenantId = requiredUuid(environment, "AETHER_CLOUD_TENANT_ID");
  const projectId = requiredUuid(environment, "AETHER_CLOUD_PROJECT_ID");
  const credentials = decodeTrustedGatewayCredentials(environment);
  const brokerClientId = clientId(environment);
  const username = environment.AETHER_CLOUD_CLOUDLINK_MQTT_USERNAME;
  const password = environment.AETHER_CLOUD_CLOUDLINK_MQTT_PASSWORD;
  const tls = tlsFiles(environment);

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
    trustedGatewayCredentialRecords(credentials, tenantId, projectId),
  );
  // A0 has no PostgreSQL Runtime Manifest adapter, so declarations live only in
  // this process and a restart fails Integration uplinks closed until each
  // Gateway reports its manifest again. In postgres mode that asymmetry bites
  // harder: the session survives the restart, so the Gateway still believes its
  // session is live and has no trigger to re-report, and its uplinks stay
  // refused until it reconnects for some other reason.
  const manifests = new InMemoryRuntimeManifestRepository();
  const clock = { now: () => parseUtcInstant(new Date().toISOString()) };
  const observer = factories.observer ?? stderrObserver();
  const diagnostic =
    factories.diagnostic ??
    ((message: string) => {
      process.stderr.write(`cloudlink ${message}\n`);
    });

  const collaborators: IngressCollaborators = {
    broker: {
      url: brokerUrl,
      clientId: brokerClientId,
      ...(username === undefined || username.length === 0 ? {} : { username }),
      ...(password === undefined || password.length === 0 ? {} : { password }),
      ...(tls === undefined ? {} : { tls }),
    },
    ...(factories.connector === undefined
      ? {}
      : { connector: factories.connector }),
    topicPrefix,
    credentials,
    sessions,
    manifests,
    credentialVerifier,
    projections: store.repository,
    clock,
    observer,
    diagnostic,
  };

  // Held in one record rather than separate locals so that a re-check after an
  // `await` reads the current value instead of a narrowed initial one.
  const lifecycle: {
    ingress: RunningCloudLinkMqttIngress | undefined;
    starting: Promise<void> | undefined;
    closing: Promise<void> | undefined;
  } = { ingress: undefined, starting: undefined, closing: undefined };

  return {
    enabledExtensions: [integrationExtension],
    projectionStoreMode: store.pool === undefined ? "memory" : "postgres",
    get running() {
      return lifecycle.ingress !== undefined;
    },
    async start(): Promise<void> {
      // A closed runtime has already ended its projection pool, which cannot be
      // reopened. Refusing to restart states that plainly instead of silently
      // opening a second Broker connection onto dead storage.
      if (lifecycle.closing !== undefined) {
        throw new Error("CloudLink ingress is closed");
      }
      if (lifecycle.ingress !== undefined) {
        throw new Error("CloudLink ingress is already running");
      }
      // Concurrent callers share one attempt. Without this each would connect,
      // and only the last assignment to `ingress` would ever be closable.
      lifecycle.starting ??= (async () => {
        try {
          const started = await startCloudLinkMqttIngress(
            ingressDependencies(collaborators),
          );
          // A close that landed while the Broker connect was in flight has
          // already run; this ingress would otherwise stay subscribed forever.
          if (lifecycle.closing !== undefined) {
            await started.close();
            throw new IngressClosedDuringStartError();
          }
          lifecycle.ingress = started;
        } finally {
          lifecycle.starting = undefined;
        }
      })();
      return lifecycle.starting;
    },
    close(): Promise<void> {
      // `running` stays true until the ingress has actually drained, so the
      // lifecycle never reports a stopped process while messages are in flight.
      lifecycle.closing ??= (async () => {
        try {
          // An in-flight start must finish before its transport can be closed.
          // Only the expected hand-off is swallowed: if the orphaned transport
          // itself failed to close, that error must reach the caller rather
          // than letting close() report a success the Broker did not perform.
          await lifecycle.starting?.catch((error: unknown) => {
            if (!(error instanceof IngressClosedDuringStartError)) throw error;
          });
          await lifecycle.ingress?.close();
        } finally {
          // The pool must be released even when the Broker close fails, and a
          // runtime that has given up on its ingress must not report running.
          lifecycle.ingress = undefined;
          await store.pool?.end();
        }
      })();
      return lifecycle.closing;
    },
  };
}
