import {
  connectNodeMqttTransport,
  mqttUplinkFilters,
  type CloudLinkExtension,
  type MqttInboundEvent,
} from "@aether-cloud/cloudlink-mqtt-adapter";

import {
  CloudLinkMqttApplicationBridge,
  type CloudLinkApplicationCommand,
  type CloudLinkApplicationUnaryCommand,
  type CloudLinkBridgeClock,
  type CloudLinkBridgeHandleResult,
  type CloudLinkCredentialQuery,
} from "./cloudlink-mqtt-application-bridge.js";
import {
  MqttIntegrationControlOfferPublisher,
  type CloudLinkIntegrationControlFactory,
} from "./integration-control-mqtt.js";

export interface CloudLinkMqttDuplexTransport {
  subscribe(
    topics: readonly string[],
    handler: (event: MqttInboundEvent) => void,
  ): Promise<void>;
  publish(topic: string, payload: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface CloudLinkMqttTransportConnector {
  connect(input: unknown): Promise<CloudLinkMqttDuplexTransport>;
}

export interface CloudLinkIngressObserver {
  messageHandled(result: CloudLinkBridgeHandleResult): void;
  internalFailure(): void;
}

export interface CloudLinkMqttIngressDependencies {
  readonly connection: unknown;
  readonly connector?: CloudLinkMqttTransportConnector;
  readonly topicPrefix: string;
  readonly requestSessionChallenge?: CloudLinkApplicationUnaryCommand;
  readonly acceptGatewaySignedSession?: CloudLinkApplicationUnaryCommand;
  readonly authenticateGatewaySignedUplink?: CloudLinkApplicationUnaryCommand;
  readonly gatewaySignedScope?: Readonly<{
    tenantId: string;
    projectId: string;
  }>;
  readonly openSession: CloudLinkApplicationCommand;
  readonly heartbeat: CloudLinkApplicationCommand;
  readonly reportManifest: CloudLinkApplicationCommand;
  readonly restoreRuntimeProtocols?: CloudLinkCredentialQuery;
  readonly ingestTelemetry: CloudLinkApplicationCommand;
  readonly reportIntegrationTopology?: CloudLinkApplicationCommand;
  readonly reportIntegrationObservations?: CloudLinkApplicationCommand;
  readonly integrationControlFactory?: CloudLinkIntegrationControlFactory;
  readonly resolveTrustedConnectorCredential?: CloudLinkCredentialQuery;
  readonly recordDurableCursor?: CloudLinkApplicationCommand;
  readonly recordDataLoss?: CloudLinkApplicationCommand;
  readonly clock: CloudLinkBridgeClock;
  readonly observer?: CloudLinkIngressObserver;
  readonly maximumPayloadBytes?: number;
  readonly enabledExtensions?: readonly CloudLinkExtension[];
}

export interface RunningCloudLinkMqttIngress {
  drain(): Promise<void>;
  pumpIntegrationControl(
    scope: unknown,
    input: unknown,
  ): Promise<CloudLinkBridgeHandleResult>;
  close(): Promise<void>;
}

const nodeMqttConnector: CloudLinkMqttTransportConnector = {
  connect: connectNodeMqttTransport,
};

function observeHandled(
  observer: CloudLinkIngressObserver | undefined,
  result: CloudLinkBridgeHandleResult,
): void {
  try {
    observer?.messageHandled(result);
  } catch {
    // Operational instrumentation cannot alter CloudLink business semantics.
  }
}

function observeFailure(observer: CloudLinkIngressObserver | undefined): void {
  try {
    observer?.internalFailure();
  } catch {
    // Operational instrumentation cannot alter CloudLink business semantics.
  }
}

function gatewayQueueKey(topicPrefix: string, topic: string): string {
  const prefix = `${topicPrefix}/v1/gateways/`;
  if (!topic.startsWith(prefix)) return topic;
  const remainder = topic.slice(prefix.length);
  const separator = remainder.indexOf("/");
  return separator === -1 ? topic : remainder.slice(0, separator);
}

export async function startCloudLinkMqttIngress(
  dependencies: CloudLinkMqttIngressDependencies,
): Promise<RunningCloudLinkMqttIngress> {
  const gatewaySignedComposition = [
    dependencies.requestSessionChallenge,
    dependencies.acceptGatewaySignedSession,
    dependencies.authenticateGatewaySignedUplink,
    dependencies.gatewaySignedScope,
  ];
  if (
    gatewaySignedComposition.some((dependency) => dependency !== undefined) &&
    !gatewaySignedComposition.every((dependency) => dependency !== undefined)
  ) {
    throw new TypeError(
      "CloudLink requires a complete Gateway-signed session composition including per-uplink authentication",
    );
  }
  const readOnlyIntegrationEnabled =
    dependencies.enabledExtensions?.includes(
      "aether.cloudlink.integration.v1alpha1",
    ) === true;
  const integrationControlEnabled =
    dependencies.enabledExtensions?.includes(
      "aether.cloudlink.integration-control.v1alpha1",
    ) === true;
  if (integrationControlEnabled && !readOnlyIntegrationEnabled) {
    throw new TypeError(
      "CloudLink Integration Control extension requires explicit read-only Integration enablement",
    );
  }
  if (
    integrationControlEnabled &&
    dependencies.integrationControlFactory === undefined
  ) {
    throw new TypeError(
      "CloudLink Integration Control extension requires a complete application composition",
    );
  }
  if (
    dependencies.enabledExtensions?.includes(
      "aether.cloudlink.integration.v1alpha1",
    ) === true &&
    (dependencies.reportIntegrationTopology === undefined ||
      dependencies.reportIntegrationObservations === undefined ||
      dependencies.recordDurableCursor === undefined)
  ) {
    throw new TypeError(
      "CloudLink Integration extension requires topology reporting, observation reporting, and durable cursor persistence",
    );
  }
  if (
    dependencies.enabledExtensions?.includes(
      "aether.cloudlink.integration.v1alpha1",
    ) === true &&
    dependencies.restoreRuntimeProtocols === undefined
  ) {
    throw new TypeError(
      "CloudLink Integration extension requires Runtime Manifest protocol restoration",
    );
  }
  const transport = await (dependencies.connector ?? nodeMqttConnector).connect(
    dependencies.connection,
  );
  let controlHandlers:
    | ReturnType<CloudLinkIntegrationControlFactory["create"]>
    | undefined;
  try {
    if (integrationControlEnabled) {
      const factory = dependencies.integrationControlFactory;
      if (factory === undefined) {
        throw new TypeError(
          "CloudLink Integration Control factory was not initialized",
        );
      }
      controlHandlers = factory.create(
        new MqttIntegrationControlOfferPublisher({
          topicPrefix: dependencies.topicPrefix,
          transport,
        }),
      );
      if (
        typeof controlHandlers.ingestReceipt.execute !== "function" ||
        typeof controlHandlers.publishOffers.execute !== "function" ||
        typeof controlHandlers.reoffer.execute !== "function"
      ) {
        throw new TypeError(
          "CloudLink Integration Control factory returned incomplete handlers",
        );
      }
    }
  } catch (error: unknown) {
    await transport.close();
    throw error;
  }
  const bridge = new CloudLinkMqttApplicationBridge({
    topicPrefix: dependencies.topicPrefix,
    publisher: transport,
    ...(dependencies.requestSessionChallenge === undefined
      ? {}
      : { requestSessionChallenge: dependencies.requestSessionChallenge }),
    ...(dependencies.acceptGatewaySignedSession === undefined
      ? {}
      : {
          acceptGatewaySignedSession: dependencies.acceptGatewaySignedSession,
        }),
    ...(dependencies.authenticateGatewaySignedUplink === undefined
      ? {}
      : {
          authenticateGatewaySignedUplink:
            dependencies.authenticateGatewaySignedUplink,
        }),
    ...(dependencies.gatewaySignedScope === undefined
      ? {}
      : { gatewaySignedScope: dependencies.gatewaySignedScope }),
    openSession: dependencies.openSession,
    heartbeat: dependencies.heartbeat,
    reportManifest: dependencies.reportManifest,
    ...(dependencies.restoreRuntimeProtocols === undefined
      ? {}
      : { restoreRuntimeProtocols: dependencies.restoreRuntimeProtocols }),
    ingestTelemetry: dependencies.ingestTelemetry,
    ...(dependencies.reportIntegrationTopology === undefined
      ? {}
      : {
          reportIntegrationTopology: dependencies.reportIntegrationTopology,
        }),
    ...(dependencies.reportIntegrationObservations === undefined
      ? {}
      : {
          reportIntegrationObservations:
            dependencies.reportIntegrationObservations,
        }),
    ...(controlHandlers === undefined
      ? {}
      : {
          ingestIntegrationControlReceipt: controlHandlers.ingestReceipt,
          publishIntegrationControlOffers: controlHandlers.publishOffers,
          reofferIntegrationControls: controlHandlers.reoffer,
        }),
    ...(dependencies.resolveTrustedConnectorCredential === undefined
      ? {}
      : {
          resolveTrustedConnectorCredential:
            dependencies.resolveTrustedConnectorCredential,
        }),
    ...(dependencies.recordDurableCursor === undefined
      ? {}
      : { recordDurableCursor: dependencies.recordDurableCursor }),
    ...(dependencies.recordDataLoss === undefined
      ? {}
      : { recordDataLoss: dependencies.recordDataLoss }),
    clock: dependencies.clock,
    ...(dependencies.maximumPayloadBytes === undefined
      ? {}
      : { maximumPayloadBytes: dependencies.maximumPayloadBytes }),
    ...(dependencies.enabledExtensions === undefined
      ? {}
      : { enabledExtensions: dependencies.enabledExtensions }),
  });
  const inFlight = new Set<Promise<void>>();
  const gatewayTails = new Map<string, Promise<void>>();
  let closing = false;
  let closed = false;

  const drain = async (): Promise<void> => {
    await Promise.allSettled([...inFlight]);
  };

  try {
    await transport.subscribe(
      mqttUplinkFilters(
        dependencies.topicPrefix,
        dependencies.enabledExtensions,
      ),
      (event) => {
        if (closing) return;
        if (event.retain || event.qos !== 1) {
          observeHandled(dependencies.observer, {
            outcome: "discarded",
            failure: {
              code: "invalid-mqtt-delivery",
              message:
                "CloudLink uplinks must be non-retained MQTT QoS 1 messages",
            },
          });
          return;
        }
        const queueKey = gatewayQueueKey(dependencies.topicPrefix, event.topic);
        const prior = gatewayTails.get(queueKey) ?? Promise.resolve();
        const work = prior
          .catch(() => {
            // A failed predecessor is observed below and must not poison the
            // ordered queue for later deliveries from the same Gateway.
          })
          .then(() => bridge.handle(event))
          .then((result) => {
            observeHandled(dependencies.observer, result);
          })
          .catch(() => {
            observeFailure(dependencies.observer);
          });
        gatewayTails.set(queueKey, work);
        inFlight.add(work);
        void work.then(() => {
          inFlight.delete(work);
          if (gatewayTails.get(queueKey) === work) {
            gatewayTails.delete(queueKey);
          }
        });
      },
    );
  } catch (error: unknown) {
    await transport.close();
    throw error;
  }

  return {
    drain,
    pumpIntegrationControl(scope, input) {
      return bridge.pumpIntegrationControl(scope, input);
    },
    async close(): Promise<void> {
      if (closed) return;
      closing = true;
      await drain();
      await transport.close();
      closed = true;
    },
  };
}
