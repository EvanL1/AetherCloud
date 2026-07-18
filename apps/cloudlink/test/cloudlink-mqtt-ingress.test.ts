import type { MqttInboundEvent } from "@aether-cloud/cloudlink-mqtt-adapter";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  startCloudLinkMqttIngress,
  type CloudLinkApplicationCommand,
  type CloudLinkCredentialQuery,
  type CloudLinkMqttDuplexTransport,
  type CloudLinkMqttTransportConnector,
} from "../src/index.js";

const gatewayId = "33333333-3333-4333-8333-333333333333";
const credential = {
  credentialId: "development-binding-17",
  proof: "B".repeat(86),
};

function sharedFixture(name: string): Uint8Array {
  return readFileSync(
    new URL(
      `../../../contracts/cloudlink/v1/fixtures/${name}`,
      import.meta.url,
    ),
  );
}

function trustedConnectorSessionHello(): Uint8Array {
  const hello = JSON.parse(
    new TextDecoder().decode(sharedFixture("session-hello.valid.json")),
  ) as Record<string, unknown>;
  const binding = hello.credential_binding as Record<string, unknown>;
  binding.origin_model = "trusted-connector-broker-attestation";
  delete hello.gateway_key_id;
  delete hello.gateway_signature;
  return new TextEncoder().encode(JSON.stringify(hello));
}

class TrustedConnectorCredentialQuery implements CloudLinkCredentialQuery {
  execute(): Promise<unknown> {
    return Promise.resolve({ ok: true, value: credential });
  }
}

class FakeTransport implements CloudLinkMqttDuplexTransport {
  subscriptions: readonly string[] = [];
  handler: ((event: MqttInboundEvent) => void) | undefined;
  publications: Array<{ topic: string; payload: Uint8Array }> = [];
  closed = false;
  failSubscription = false;

  subscribe(
    topics: readonly string[],
    handler: (event: MqttInboundEvent) => void,
  ): Promise<void> {
    if (this.failSubscription) {
      return Promise.reject(new Error("subscription failed"));
    }
    this.subscriptions = [...topics];
    this.handler = handler;
    return Promise.resolve();
  }

  publish(topic: string, payload: Uint8Array): Promise<void> {
    this.publications.push({ topic, payload });
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class Connector implements CloudLinkMqttTransportConnector {
  readonly transport = new FakeTransport();
  input: unknown;

  connect(input: unknown): Promise<CloudLinkMqttDuplexTransport> {
    this.input = input;
    return Promise.resolve(this.transport);
  }
}

class Command implements CloudLinkApplicationCommand {
  execute(): Promise<unknown> {
    return Promise.resolve({
      ok: false,
      failure: { code: "not-used", message: "not used in this test" },
    });
  }
}

class ThrowingCommand implements CloudLinkApplicationCommand {
  execute(): Promise<unknown> {
    return Promise.reject(new Error("internal command failure"));
  }
}

class FirstCallBlockingSessionCommand implements CloudLinkApplicationCommand {
  calls = 0;
  readonly #firstReleased: Promise<void>;
  #releaseFirst: (() => void) | undefined;

  constructor() {
    this.#firstReleased = new Promise((resolve) => {
      this.#releaseFirst = resolve;
    });
  }

  releaseFirst(): void {
    this.#releaseFirst?.();
  }

  async execute(): Promise<unknown> {
    this.calls += 1;
    if (this.calls === 1) await this.#firstReleased;
    return {
      ok: true,
      replayed: false,
      value: {
        gatewayId,
        tenantId: "11111111-1111-4111-8111-111111111111",
        projectId: "22222222-2222-4222-8222-222222222222",
        sessionId: "44444444-4444-4444-8444-444444444444",
        credentialGeneration: "3",
        epoch: "7",
        state: "active",
        protocolVersion: "1.0",
        resumeCursors: [],
      },
    };
  }
}

describe("CloudLink MQTT ingress composition", () => {
  it("serializes messages for one Gateway in Broker arrival order", async () => {
    const connector = new Connector();
    const openSession = new FirstCallBlockingSessionCommand();
    const command = new Command();
    const ingress = await startCloudLinkMqttIngress({
      connection: {},
      connector,
      topicPrefix: "aethercloud",
      openSession,
      resolveTrustedConnectorCredential: new TrustedConnectorCredentialQuery(),
      heartbeat: command,
      reportManifest: command,
      ingestTelemetry: command,
      clock: { now: () => "2024-07-14T23:33:20.400Z" },
    });
    const event: MqttInboundEvent = {
      topic: `aethercloud/v1/gateways/${gatewayId}/up/session`,
      payload: trustedConnectorSessionHello(),
      qos: 1,
      retain: false,
      duplicate: false,
    };

    connector.transport.handler?.(event);
    connector.transport.handler?.(event);
    await vi.waitFor(() => {
      expect(openSession.calls).toBe(1);
    });

    openSession.releaseFirst();
    await ingress.drain();
    expect(openSession.calls).toBe(2);
    await ingress.close();
  });

  it("subscribes only to bounded uplinks, observes invalid input, and closes", async () => {
    const connector = new Connector();
    const outcomes: string[] = [];
    const command = new Command();
    const ingress = await startCloudLinkMqttIngress({
      connection: {
        url: "mqtt://broker.example.test:1883",
        clientId: "aethercloud-cloudlink-ingress",
      },
      connector,
      topicPrefix: "aethercloud",
      openSession: command,
      heartbeat: command,
      reportManifest: command,
      ingestTelemetry: command,
      clock: { now: () => "2026-07-15T09:00:00.000Z" },
      observer: {
        messageHandled(result) {
          outcomes.push(
            result.outcome === "discarded"
              ? `${result.outcome}:${result.failure.code}`
              : result.outcome,
          );
        },
        internalFailure() {
          outcomes.push("internal-failure");
        },
      },
    });

    expect(connector.input).toMatchObject({
      url: "mqtt://broker.example.test:1883",
    });
    expect(connector.transport.subscriptions).toEqual([
      "aethercloud/v1/gateways/+/up/session",
      "aethercloud/v1/gateways/+/up/heartbeat",
      "aethercloud/v1/gateways/+/up/manifest",
      "aethercloud/v1/gateways/+/up/telemetry",
      "aethercloud/v1/gateways/+/up/data-loss",
    ]);
    connector.transport.handler?.({
      topic: `aethercloud/v1/gateways/${gatewayId}/up/session`,
      payload: new TextEncoder().encode("{bad-json"),
      qos: 1,
      retain: false,
      duplicate: false,
    });
    connector.transport.handler?.({
      topic: `aethercloud/v1/gateways/${gatewayId}/up/session`,
      payload: new TextEncoder().encode("{}"),
      qos: 1,
      retain: true,
      duplicate: false,
    });
    await ingress.drain();
    expect(outcomes).toEqual([
      "discarded:invalid-mqtt-delivery",
      "discarded:invalid-json",
    ]);
    expect(connector.transport.publications).toEqual([]);

    await ingress.close();
    await ingress.close();
    expect(connector.transport.closed).toBe(true);
  });

  it("isolates internal command failure from the MQTT callback", async () => {
    const connector = new Connector();
    const outcomes: string[] = [];
    const throwing = new ThrowingCommand();
    const ingress = await startCloudLinkMqttIngress({
      connection: { url: "mqtt://broker.example.test", clientId: "ingress" },
      connector,
      topicPrefix: "aethercloud",
      openSession: throwing,
      resolveTrustedConnectorCredential: new TrustedConnectorCredentialQuery(),
      heartbeat: throwing,
      reportManifest: throwing,
      ingestTelemetry: throwing,
      clock: { now: () => "2026-07-15T09:00:00.000Z" },
      observer: {
        messageHandled(result) {
          outcomes.push(result.outcome);
        },
        internalFailure() {
          outcomes.push("internal-failure");
        },
      },
    });

    connector.transport.handler?.({
      topic: `aethercloud/v1/gateways/${gatewayId}/up/session`,
      payload: trustedConnectorSessionHello(),
      qos: 1,
      retain: false,
      duplicate: false,
    });
    await ingress.drain();
    expect(outcomes).toEqual(["internal-failure"]);
    await ingress.close();
  });

  it("subscribes to Integration routes only when the exact extension is enabled", async () => {
    const connector = new Connector();
    const command = new Command();
    const ingress = await startCloudLinkMqttIngress({
      connection: {},
      connector,
      topicPrefix: "aethercloud",
      openSession: command,
      heartbeat: command,
      reportManifest: command,
      ingestTelemetry: command,
      reportIntegrationTopology: command,
      reportIntegrationObservations: command,
      recordDurableCursor: command,
      restoreRuntimeProtocols: command,
      enabledExtensions: ["aether.cloudlink.integration.v1alpha1"],
      clock: { now: () => "2026-07-15T09:00:00.000Z" },
    });

    expect(connector.transport.subscriptions).toContain(
      "aethercloud/v1/gateways/+/up/integration/topology",
    );
    expect(connector.transport.subscriptions).toContain(
      "aethercloud/v1/gateways/+/up/integration/observations",
    );
    expect(connector.transport.subscriptions).not.toContain(
      "aethercloud/v1/gateways/+/up/integration-control/receipts",
    );
    await ingress.close();
  });

  it("rejects an incomplete Gateway-signed composition before connecting", async () => {
    const connector = new Connector();
    const command = new Command();

    await expect(
      startCloudLinkMqttIngress({
        connection: {},
        connector,
        topicPrefix: "aethercloud",
        requestSessionChallenge: command,
        openSession: command,
        heartbeat: command,
        reportManifest: command,
        ingestTelemetry: command,
        clock: { now: () => "2026-07-15T09:00:00.000Z" },
      }),
    ).rejects.toThrow(/complete Gateway-signed session composition/);
    expect(connector.input).toBeUndefined();
  });

  it("requires explicit read-only Integration and complete control composition before connecting", async () => {
    const command = new Command();
    const controlFactory = {
      create: () => ({
        ingestReceipt: command,
        publishOffers: command,
        reoffer: command,
      }),
    };

    for (const configuration of [
      {
        enabledExtensions: [
          "aether.cloudlink.integration-control.v1alpha1",
        ] as const,
        integrationControlFactory: controlFactory,
      },
      {
        enabledExtensions: [
          "aether.cloudlink.integration.v1alpha1",
          "aether.cloudlink.integration-control.v1alpha1",
        ] as const,
      },
    ]) {
      const connector = new Connector();
      await expect(
        startCloudLinkMqttIngress({
          connection: {},
          connector,
          topicPrefix: "aethercloud",
          openSession: command,
          heartbeat: command,
          reportManifest: command,
          restoreRuntimeProtocols: command,
          ingestTelemetry: command,
          reportIntegrationTopology: command,
          reportIntegrationObservations: command,
          recordDurableCursor: command,
          ...configuration,
          clock: { now: () => "2026-07-15T09:00:00.000Z" },
        }),
      ).rejects.toThrow(
        /Control extension requires (?:explicit read-only Integration|a complete application composition)/,
      );
      expect(connector.input).toBeUndefined();
    }
  });

  it("subscribes to the exact control receipt filter only after complete explicit enablement", async () => {
    const connector = new Connector();
    const command = new Command();
    const ingress = await startCloudLinkMqttIngress({
      connection: {},
      connector,
      topicPrefix: "aethercloud",
      openSession: command,
      heartbeat: command,
      reportManifest: command,
      restoreRuntimeProtocols: command,
      ingestTelemetry: command,
      reportIntegrationTopology: command,
      reportIntegrationObservations: command,
      recordDurableCursor: command,
      enabledExtensions: [
        "aether.cloudlink.integration.v1alpha1",
        "aether.cloudlink.integration-control.v1alpha1",
      ],
      integrationControlFactory: {
        create: () => ({
          ingestReceipt: command,
          publishOffers: command,
          reoffer: command,
        }),
      },
      clock: { now: () => "2026-07-15T09:00:00.000Z" },
    });

    expect(connector.transport.subscriptions).toContain(
      "aethercloud/v1/gateways/+/up/integration-control/receipts",
    );
    await ingress.close();
  });

  it("fails startup when Integration is enabled without both reports and durable cursor persistence", async () => {
    const connector = new Connector();
    const command = new Command();

    await expect(
      startCloudLinkMqttIngress({
        connection: {},
        connector,
        topicPrefix: "aethercloud",
        openSession: command,
        heartbeat: command,
        reportManifest: command,
        ingestTelemetry: command,
        enabledExtensions: ["aether.cloudlink.integration.v1alpha1"],
        clock: { now: () => "2026-07-15T09:00:00.000Z" },
      }),
    ).rejects.toThrow(/Integration extension requires/);
    expect(connector.input).toBeUndefined();
  });

  it("fails startup before connecting when Integration protocol restoration is missing", async () => {
    const connector = new Connector();
    const command = new Command();

    await expect(
      startCloudLinkMqttIngress({
        connection: {},
        connector,
        topicPrefix: "aethercloud",
        openSession: command,
        heartbeat: command,
        reportManifest: command,
        ingestTelemetry: command,
        reportIntegrationTopology: command,
        reportIntegrationObservations: command,
        recordDurableCursor: command,
        enabledExtensions: ["aether.cloudlink.integration.v1alpha1"],
        clock: { now: () => "2026-07-15T09:00:00.000Z" },
      }),
    ).rejects.toThrow(/Runtime Manifest protocol restoration/);
    expect(connector.input).toBeUndefined();
  });

  it("closes a connected transport when initial subscription fails", async () => {
    const connector = new Connector();
    connector.transport.failSubscription = true;
    const command = new Command();

    await expect(
      startCloudLinkMqttIngress({
        connection: {},
        connector,
        topicPrefix: "aethercloud",
        openSession: command,
        heartbeat: command,
        reportManifest: command,
        ingestTelemetry: command,
        clock: { now: () => "2026-07-15T09:00:00.000Z" },
      }),
    ).rejects.toThrow(/subscription failed/);
    expect(connector.transport.closed).toBe(true);
  });
});
