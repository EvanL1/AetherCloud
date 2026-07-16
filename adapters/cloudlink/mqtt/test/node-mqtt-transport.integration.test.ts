import { randomUUID } from "node:crypto";

import { expect, it } from "vitest";

import { connectNodeMqttTransport } from "../src/index.js";

if (process.env.AETHER_CLOUD_RUN_MQTT_INTEGRATION !== "1") {
  throw new Error("run this opt-in test through pnpm test:mqtt-integration");
}

function optionalBrokerCredentials() {
  return {
    ...(process.env.AETHER_CLOUD_MQTT_INTEGRATION_USERNAME === undefined
      ? {}
      : { username: process.env.AETHER_CLOUD_MQTT_INTEGRATION_USERNAME }),
    ...(process.env.AETHER_CLOUD_MQTT_INTEGRATION_PASSWORD === undefined
      ? {}
      : { password: process.env.AETHER_CLOUD_MQTT_INTEGRATION_PASSWORD }),
  };
}

it("exchanges isolated QoS 1 CloudLink bytes through a shared MQTT broker", async () => {
  const suffix = randomUUID();
  const url =
    process.env.AETHER_CLOUD_MQTT_INTEGRATION_URL ?? "mqtt://127.0.0.1:1883";
  const subscriber = await connectNodeMqttTransport({
    url,
    clientId: `aethercloud-test-subscriber-${suffix}`,
    ...optionalBrokerCredentials(),
  });
  const publisher = await connectNodeMqttTransport({
    url,
    clientId: `aethercloud-test-publisher-${suffix}`,
    ...optionalBrokerCredentials(),
  });
  const topic = `aethercloud-integration/${suffix}/v1/gateways/test/up/session`;
  const expected = new TextEncoder().encode("shared-broker-cloudlink-proof");

  try {
    const received: Uint8Array[] = [];
    await subscriber.subscribe([topic], (event) => {
      received.push(event.payload);
    });
    await publisher.publish(topic, expected);
    await expect.poll(() => received[0], { timeout: 5_000 }).toEqual(expected);
  } finally {
    await Promise.all([subscriber.close(), publisher.close()]);
  }
});
