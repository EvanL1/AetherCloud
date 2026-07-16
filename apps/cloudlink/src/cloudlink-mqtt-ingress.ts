import {
  connectNodeMqttTransport,
  mqttUplinkFilters,
  type MqttInboundEvent,
} from "@aether-cloud/cloudlink-mqtt-adapter";

import {
  CloudLinkMqttApplicationBridge,
  type CloudLinkApplicationCommand,
  type CloudLinkBridgeClock,
  type CloudLinkBridgeHandleResult,
} from "./cloudlink-mqtt-application-bridge.js";

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
  readonly openSession: CloudLinkApplicationCommand;
  readonly heartbeat: CloudLinkApplicationCommand;
  readonly reportManifest: CloudLinkApplicationCommand;
  readonly ingestTelemetry: CloudLinkApplicationCommand;
  readonly recordDurableCursor?: CloudLinkApplicationCommand;
  readonly recordDataLoss?: CloudLinkApplicationCommand;
  readonly clock: CloudLinkBridgeClock;
  readonly observer?: CloudLinkIngressObserver;
  readonly maximumPayloadBytes?: number;
}

export interface RunningCloudLinkMqttIngress {
  drain(): Promise<void>;
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

export async function startCloudLinkMqttIngress(
  dependencies: CloudLinkMqttIngressDependencies,
): Promise<RunningCloudLinkMqttIngress> {
  const transport = await (dependencies.connector ?? nodeMqttConnector).connect(
    dependencies.connection,
  );
  const bridge = new CloudLinkMqttApplicationBridge({
    topicPrefix: dependencies.topicPrefix,
    publisher: transport,
    openSession: dependencies.openSession,
    heartbeat: dependencies.heartbeat,
    reportManifest: dependencies.reportManifest,
    ingestTelemetry: dependencies.ingestTelemetry,
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
  });
  const inFlight = new Set<Promise<void>>();
  let closing = false;
  let closed = false;

  const drain = async (): Promise<void> => {
    await Promise.allSettled([...inFlight]);
  };

  try {
    await transport.subscribe(
      mqttUplinkFilters(dependencies.topicPrefix),
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
        const work = bridge
          .handle(event)
          .then((result) => {
            observeHandled(dependencies.observer, result);
          })
          .catch(() => {
            observeFailure(dependencies.observer);
          });
        inFlight.add(work);
        void work.then(() => {
          inFlight.delete(work);
        });
      },
    );
  } catch (error: unknown) {
    await transport.close();
    throw error;
  }

  return {
    drain,
    async close(): Promise<void> {
      if (closed) return;
      closing = true;
      await drain();
      await transport.close();
      closed = true;
    },
  };
}
