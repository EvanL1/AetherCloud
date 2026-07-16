import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { IClientOptions } from "mqtt";
import { describe, expect, it } from "vitest";

import {
  NodeMqttTransport,
  connectNodeMqttTransport,
  decodeNodeMqttConnectionConfig,
  type MqttDriverClient,
  type MqttInboundEvent,
  type NodeMqttClientConnector,
} from "../src/index.js";

class FakeMqttDriver implements MqttDriverClient {
  readonly subscriptions: string[][] = [];
  readonly publications: Array<{
    readonly topic: string;
    readonly payload: Uint8Array;
    readonly qos: 1;
    readonly retain: false;
  }> = [];
  handler:
    | ((
        topic: string,
        payload: Uint8Array,
        metadata: Readonly<{ qos: 0 | 1 | 2; retain: boolean; dup: boolean }>,
      ) => void)
    | undefined;
  ended = false;

  subscribe(topics: readonly string[]): Promise<void> {
    this.subscriptions.push([...topics]);
    return Promise.resolve();
  }

  publish(
    topic: string,
    payload: Uint8Array,
    options: { readonly qos: 1; readonly retain: false },
  ): Promise<void> {
    this.publications.push({ topic, payload, ...options });
    return Promise.resolve();
  }

  onMessage(
    handler: (
      topic: string,
      payload: Uint8Array,
      metadata: Readonly<{ qos: 0 | 1 | 2; retain: boolean; dup: boolean }>,
    ) => void,
  ): void {
    this.handler = handler;
  }

  end(): Promise<void> {
    this.ended = true;
    return Promise.resolve();
  }
}

class FakeNodeMqttClientConnector implements NodeMqttClientConnector {
  readonly driver = new FakeMqttDriver();
  url: string | undefined;
  options: IClientOptions | undefined;

  connect(url: string, options: IClientOptions): Promise<MqttDriverClient> {
    this.url = url;
    this.options = options;
    return Promise.resolve(this.driver);
  }
}

describe("NodeMqttTransport", () => {
  it("decodes a bounded connection configuration without URL credentials", () => {
    expect(
      decodeNodeMqttConnectionConfig({
        url: "mqtt://127.0.0.1:1883",
        clientId: "aethercloud-test-ingress",
      }),
    ).toEqual({
      url: "mqtt://127.0.0.1:1883",
      clientId: "aethercloud-test-ingress",
      protocolVersion: 4,
      connectTimeoutMs: 30_000,
    });
    expect(() =>
      decodeNodeMqttConnectionConfig({
        url: "mqtt://user:secret@127.0.0.1:1883",
        clientId: "aethercloud-test-ingress",
      }),
    ).toThrow(/credentials must not be embedded/);
    expect(() =>
      decodeNodeMqttConnectionConfig({
        url: "mqtt://127.0.0.1:1883",
        clientId: "aethercloud-test-ingress",
        inventedTlsBypass: true,
      }),
    ).toThrow(/unsupported fields/);
  });

  it("supports explicit MQTT 5 and separate Broker credentials", () => {
    expect(
      decodeNodeMqttConnectionConfig({
        url: "mqtts://broker.example.test:8883",
        clientId: "aethercloud-test-ingress",
        username: "cloudlink-ingress",
        password: "secret-reference-resolved-at-composition",
        protocolVersion: 5,
        connectTimeoutMs: 5_000,
      }),
    ).toEqual({
      url: "mqtts://broker.example.test:8883",
      clientId: "aethercloud-test-ingress",
      username: "cloudlink-ingress",
      password: "secret-reference-resolved-at-composition",
      protocolVersion: 5,
      connectTimeoutMs: 5_000,
    });
  });

  it("decodes a closed mTLS file configuration only for mqtts", () => {
    expect(
      decodeNodeMqttConnectionConfig({
        url: "mqtts://iot.example.test:8883",
        clientId: "aethercloud-test-ingress",
        tls: {
          caPath: "/run/aethercloud/amazon-root-ca.pem",
          clientCertificatePath: "/run/aethercloud/cloud.crt",
          clientPrivateKeyPath: "/run/aethercloud/cloud.pkcs8.key",
        },
      }),
    ).toMatchObject({
      tls: {
        caPath: "/run/aethercloud/amazon-root-ca.pem",
        clientCertificatePath: "/run/aethercloud/cloud.crt",
        clientPrivateKeyPath: "/run/aethercloud/cloud.pkcs8.key",
      },
    });

    expect(() =>
      decodeNodeMqttConnectionConfig({
        url: "mqtt://iot.example.test:1883",
        clientId: "aethercloud-test-ingress",
        tls: {
          caPath: "/run/aethercloud/amazon-root-ca.pem",
          clientCertificatePath: "/run/aethercloud/cloud.crt",
          clientPrivateKeyPath: "/run/aethercloud/cloud.pkcs8.key",
        },
      }),
    ).toThrow(/mTLS requires mqtts/);
    expect(() =>
      decodeNodeMqttConnectionConfig({
        url: "mqtts://iot.example.test:8883",
        clientId: "aethercloud-test-ingress",
        tls: {
          caPath: "/run/aethercloud/amazon-root-ca.pem",
          clientCertificatePath: "/run/aethercloud/cloud.crt",
        },
      }),
    ).toThrow(/clientPrivateKeyPath/);
    expect(() =>
      decodeNodeMqttConnectionConfig({
        url: "mqtts://iot.example.test:8883",
        clientId: "aethercloud-test-ingress",
        tls: {
          caPath: "/run/aethercloud/amazon-root-ca.pem",
          clientCertificatePath: "/run/aethercloud/cloud.crt",
          clientPrivateKeyPath: "/run/aethercloud/cloud.pkcs8.key",
          rejectUnauthorized: false,
        },
      }),
    ).toThrow(/unsupported fields/);
    expect(() =>
      decodeNodeMqttConnectionConfig({
        url: "mqtts://iot.example.test:8883",
        clientId: "aethercloud-test-ingress",
        tls: {
          caPath: "relative/ca.pem",
          clientCertificatePath: "/run/aethercloud/cloud.crt",
          clientPrivateKeyPath: "/run/aethercloud/cloud.pkcs8.key",
        },
      }),
    ).toThrow(/absolute path/);
  });

  it("loads bounded non-symlink mTLS files and keeps verification enabled", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "aethercloud-mtls-test-"));
    const caPath = resolve(root, "ca.pem");
    const clientCertificatePath = resolve(root, "client.crt");
    const clientPrivateKeyPath = resolve(root, "client.pkcs8.key");
    try {
      await Promise.all([
        writeFile(caPath, "TEST-CA", { mode: 0o600 }),
        writeFile(clientCertificatePath, "TEST-CERTIFICATE", { mode: 0o600 }),
        writeFile(clientPrivateKeyPath, "TEST-PRIVATE-SECRET", { mode: 0o600 }),
      ]);
      const connector = new FakeNodeMqttClientConnector();

      const transport = await connectNodeMqttTransport(
        {
          url: "mqtts://iot.example.test:8883",
          clientId: "aethercloud-test-ingress",
          tls: { caPath, clientCertificatePath, clientPrivateKeyPath },
        },
        connector,
      );

      expect(connector.url).toBe("mqtts://iot.example.test:8883");
      expect(connector.options?.rejectUnauthorized).toBe(true);
      expect(connector.options?.ca?.toString()).toBe("TEST-CA");
      expect(connector.options?.cert?.toString()).toBe("TEST-CERTIFICATE");
      expect(connector.options?.key?.toString()).toBe("TEST-PRIVATE-SECRET");
      await transport.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked TLS material and overly broad private-key permissions without leaking bytes", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "aethercloud-mtls-test-"));
    const caPath = resolve(root, "ca.pem");
    const realCertificatePath = resolve(root, "real-client.crt");
    const clientCertificatePath = resolve(root, "client.crt");
    const clientPrivateKeyPath = resolve(root, "client.pkcs8.key");
    const input = {
      url: "mqtts://iot.example.test:8883",
      clientId: "aethercloud-test-ingress",
      tls: { caPath, clientCertificatePath, clientPrivateKeyPath },
    };
    try {
      await Promise.all([
        writeFile(caPath, "TEST-CA", { mode: 0o600 }),
        writeFile(realCertificatePath, "TEST-CERTIFICATE", { mode: 0o600 }),
        writeFile(clientPrivateKeyPath, "TEST-PRIVATE-SECRET", { mode: 0o600 }),
      ]);
      await symlink(realCertificatePath, clientCertificatePath);
      const connector = new FakeNodeMqttClientConnector();

      await expect(connectNodeMqttTransport(input, connector)).rejects.toThrow(
        /regular non-symlink/,
      );

      await rm(clientCertificatePath);
      await writeFile(clientCertificatePath, "TEST-CERTIFICATE", {
        mode: 0o600,
      });
      await chmod(clientPrivateKeyPath, 0o644);
      let message = "";
      try {
        await connectNodeMqttTransport(input, connector);
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/private key permissions/);
      expect(message).not.toContain("TEST-PRIVATE-SECRET");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [null, /must be an object/],
    [
      { url: "https://broker.example.test", clientId: "cloudlink-ingress" },
      /must use mqtt or mqtts/,
    ],
    [
      {
        url: "mqtt://broker.example.test",
        clientId: "cloudlink-ingress",
        protocolVersion: 3,
      },
      /protocolVersion/,
    ],
    [
      {
        url: "mqtt://broker.example.test",
        clientId: "cloudlink-ingress",
        connectTimeoutMs: 999,
      },
      /connectTimeoutMs/,
    ],
    [
      {
        url: "mqtt://broker.example.test",
        clientId: "cloudlink-ingress",
        username: "",
      },
      /username/,
    ],
  ])("rejects unsafe MQTT configuration %#", (input, expected) => {
    expect(() => decodeNodeMqttConnectionConfig(input)).toThrow(expected);
  });

  it("uses QoS 1 without retained delivery and forwards isolated byte copies", async () => {
    const driver = new FakeMqttDriver();
    const transport = new NodeMqttTransport(driver);
    const received: MqttInboundEvent[] = [];

    await transport.subscribe(
      ["aethercloud/v1/gateways/+/up/session"],
      (event) => {
        received.push(event);
      },
    );
    const outbound = new Uint8Array([1, 2, 3]);
    await transport.publish("aethercloud/v1/gateways/g/down/ack", outbound);
    driver.handler?.("aethercloud/v1/gateways/g/up/session", outbound, {
      qos: 1,
      retain: false,
      dup: false,
    });
    outbound[0] = 9;

    expect(driver.subscriptions).toEqual([
      ["aethercloud/v1/gateways/+/up/session"],
    ]);
    expect(driver.publications[0]).toMatchObject({ qos: 1, retain: false });
    expect(received[0]?.payload).toEqual(new Uint8Array([1, 2, 3]));
    expect(received[0]).toMatchObject({ qos: 1, retain: false });
    await transport.close();
    expect(driver.ended).toBe(true);
  });
});
