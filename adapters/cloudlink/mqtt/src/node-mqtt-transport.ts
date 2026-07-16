import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { connectAsync, type IClientOptions, type MqttClient } from "mqtt";

const maximumTlsFileBytes = 1024 * 1024;

export interface MqttInboundEvent {
  readonly topic: string;
  readonly payload: Uint8Array;
  readonly qos: 0 | 1 | 2;
  readonly retain: boolean;
  readonly duplicate: boolean;
}

export interface MqttDriverClient {
  subscribe(topics: readonly string[]): Promise<void>;
  publish(
    topic: string,
    payload: Uint8Array,
    options: Readonly<{ qos: 1; retain: false }>,
  ): Promise<void>;
  onMessage(
    handler: (
      topic: string,
      payload: Uint8Array,
      metadata: Readonly<{ qos: 0 | 1 | 2; retain: boolean; dup: boolean }>,
    ) => void,
  ): void;
  end(): Promise<void>;
}

export interface NodeMqttClientConnector {
  connect(url: string, options: IClientOptions): Promise<MqttDriverClient>;
}

export interface NodeMqttTlsFileConfig {
  readonly caPath: string;
  readonly clientCertificatePath: string;
  readonly clientPrivateKeyPath: string;
}

export interface NodeMqttConnectionConfig {
  readonly url: string;
  readonly clientId: string;
  readonly username?: string;
  readonly password?: string;
  readonly protocolVersion: 4 | 5;
  readonly connectTimeoutMs: number;
  readonly tls?: NodeMqttTlsFileConfig;
}

function driverFromClient(client: MqttClient): MqttDriverClient {
  return {
    async subscribe(topics): Promise<void> {
      await client.subscribeAsync([...topics], { qos: 1 });
    },
    async publish(topic, payload, options): Promise<void> {
      await client.publishAsync(topic, Buffer.from(payload), options);
    },
    onMessage(handler): void {
      client.on("message", (topic, payload, packet) => {
        handler(topic, new Uint8Array(payload), {
          qos: packet.qos,
          retain: packet.retain,
          dup: packet.dup,
        });
      });
    },
    async end(): Promise<void> {
      await client.endAsync();
    },
  };
}

function requireString(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  ) {
    throw new TypeError(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function requireFilePath(value: unknown, name: string): string {
  const path = requireString(value, name, 4096);
  if (path.includes("\0") || path.split("").some((part) => part < " ")) {
    throw new TypeError(`${name} contains unsafe characters`);
  }
  if (!isAbsolute(path)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return path;
}

function decodeTlsFileConfig(
  value: unknown,
  protocol: string,
): NodeMqttTlsFileConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("MQTT tls must be an object");
  }
  if (protocol !== "mqtts:") {
    throw new TypeError("MQTT mTLS requires mqtts");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "caPath",
    "clientCertificatePath",
    "clientPrivateKeyPath",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new TypeError("MQTT tls has unsupported fields");
  }
  return {
    caPath: requireFilePath(record.caPath, "MQTT tls caPath"),
    clientCertificatePath: requireFilePath(
      record.clientCertificatePath,
      "MQTT tls clientCertificatePath",
    ),
    clientPrivateKeyPath: requireFilePath(
      record.clientPrivateKeyPath,
      "MQTT tls clientPrivateKeyPath",
    ),
  };
}

async function readTlsFile(
  path: string,
  role: "CA" | "client certificate" | "private key",
): Promise<Buffer> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new TypeError(`MQTT TLS ${role} file is missing or unreadable`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new TypeError(`MQTT TLS ${role} must be a regular non-symlink file`);
  }
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
  } catch {
    throw new TypeError(`MQTT TLS ${role} file is missing or unreadable`);
  }
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) {
      throw new TypeError(
        `MQTT TLS ${role} must be a regular non-symlink file`,
      );
    }
    if (
      openedMetadata.size === 0 ||
      openedMetadata.size > maximumTlsFileBytes
    ) {
      throw new TypeError(`MQTT TLS ${role} file must be 1 byte-1 MiB`);
    }
    if (
      role === "private key" &&
      process.platform !== "win32" &&
      (openedMetadata.mode & 0o077) !== 0
    ) {
      throw new TypeError(
        "MQTT TLS private key permissions must deny group and other access",
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function loadTlsOptions(
  config: NodeMqttTlsFileConfig | undefined,
): Promise<Pick<IClientOptions, "ca" | "cert" | "key" | "rejectUnauthorized">> {
  if (config === undefined) return {};
  const [ca, cert, key] = await Promise.all([
    readTlsFile(config.caPath, "CA"),
    readTlsFile(config.clientCertificatePath, "client certificate"),
    readTlsFile(config.clientPrivateKeyPath, "private key"),
  ]);
  return { ca, cert, key, rejectUnauthorized: true };
}

export function decodeNodeMqttConnectionConfig(
  input: unknown,
): NodeMqttConnectionConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("MQTT connection config must be an object");
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set([
    "clientId",
    "connectTimeoutMs",
    "password",
    "protocolVersion",
    "tls",
    "url",
    "username",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new TypeError("MQTT connection config has unsupported fields");
  }
  const url = new URL(requireString(record.url, "MQTT URL", 2048));
  if (!(url.protocol === "mqtt:" || url.protocol === "mqtts:")) {
    throw new TypeError("MQTT URL must use mqtt or mqtts");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError("MQTT credentials must not be embedded in the URL");
  }
  const protocolVersion = record.protocolVersion ?? 4;
  if (!(protocolVersion === 4 || protocolVersion === 5)) {
    throw new TypeError("MQTT protocolVersion must be 4 or 5");
  }
  const connectTimeoutMs = record.connectTimeoutMs ?? 30_000;
  if (
    typeof connectTimeoutMs !== "number" ||
    !Number.isSafeInteger(connectTimeoutMs) ||
    connectTimeoutMs < 1_000 ||
    connectTimeoutMs > 120_000
  ) {
    throw new TypeError("MQTT connectTimeoutMs must be 1000-120000");
  }
  const tls = decodeTlsFileConfig(record.tls, url.protocol);
  return {
    url: url.toString(),
    clientId: requireString(record.clientId, "MQTT clientId", 128),
    protocolVersion,
    connectTimeoutMs,
    ...(record.username === undefined
      ? {}
      : { username: requireString(record.username, "MQTT username", 256) }),
    ...(record.password === undefined
      ? {}
      : { password: requireString(record.password, "MQTT password", 4096) }),
    ...(tls === undefined ? {} : { tls }),
  };
}

const nodeMqttClientConnector: NodeMqttClientConnector = {
  async connect(url, options): Promise<MqttDriverClient> {
    return driverFromClient(await connectAsync(url, options));
  },
};

export async function connectNodeMqttTransport(
  input: unknown,
  connector: NodeMqttClientConnector = nodeMqttClientConnector,
): Promise<NodeMqttTransport> {
  const config = decodeNodeMqttConnectionConfig(input);
  const tlsOptions = await loadTlsOptions(config.tls);
  const options: IClientOptions = {
    clientId: config.clientId,
    protocolVersion: config.protocolVersion,
    connectTimeout: config.connectTimeoutMs,
    clean: false,
    reconnectPeriod: 1_000,
    resubscribe: true,
    ...(config.username === undefined ? {} : { username: config.username }),
    ...(config.password === undefined ? {} : { password: config.password }),
    ...tlsOptions,
  };
  return new NodeMqttTransport(await connector.connect(config.url, options));
}

export class NodeMqttTransport {
  readonly #driver: MqttDriverClient;

  constructor(driver: MqttDriverClient) {
    this.#driver = driver;
  }

  async subscribe(
    topics: readonly string[],
    handler: (event: MqttInboundEvent) => void,
  ): Promise<void> {
    this.#driver.onMessage((topic, payload, metadata) => {
      handler({
        topic,
        payload: new Uint8Array(payload),
        qos: metadata.qos,
        retain: metadata.retain,
        duplicate: metadata.dup,
      });
    });
    await this.#driver.subscribe(topics);
  }

  publish(topic: string, payload: Uint8Array): Promise<void> {
    return this.#driver.publish(topic, new Uint8Array(payload), {
      qos: 1,
      retain: false,
    });
  }

  close(): Promise<void> {
    return this.#driver.end();
  }
}
