import type { MqttInboundEvent } from "@aether-cloud/cloudlink-mqtt-adapter";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  startCloudLinkMqttIngress,
  type CloudLinkApplicationCommand,
  type CloudLinkMqttDuplexTransport,
  type CloudLinkMqttTransportConnector,
} from "../src/index.js";

const gatewayId = "33333333-3333-4333-8333-333333333333";

function sharedFixture(name: string): Uint8Array {
  return readFileSync(
    new URL(
      `../../../contracts/cloudlink/v1/fixtures/${name}`,
      import.meta.url,
    ),
  );
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

describe("CloudLink MQTT ingress composition", () => {
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
      payload: sharedFixture("session-hello.valid.json"),
      qos: 1,
      retain: false,
      duplicate: false,
    });
    await ingress.drain();
    expect(outcomes).toEqual(["internal-failure"]);
    await ingress.close();
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
