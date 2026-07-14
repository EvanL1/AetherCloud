export interface DisabledOpenTelemetryConfig {
  readonly enabled: false;
}

export interface EnabledOpenTelemetryConfig {
  readonly enabled: true;
  readonly serviceName: string;
  readonly endpoint: string;
  readonly maximumQueueSize: number;
  readonly exportIntervalMs: number;
  readonly exportTimeoutMs: number;
  readonly samplingRatio: number;
}

export type OpenTelemetryConfig =
  | DisabledOpenTelemetryConfig
  | EnabledOpenTelemetryConfig;

type Environment = Readonly<Record<string, string | undefined>>;

function parseInteger(
  input: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (input === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(input)) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is outside its bounded range`);
  }
  return value;
}

function parseSamplingRatio(input: string | undefined): number {
  if (input === undefined) return 0.1;
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError("AETHERCLOUD_OTEL_SAMPLING_RATIO must be from 0 to 1");
  }
  return value;
}

function parseEndpoint(input: string | undefined): string {
  const endpoint = input ?? "http://127.0.0.1:4318";
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new TypeError("OTEL_EXPORTER_OTLP_ENDPOINT must be an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("OTLP endpoint must use HTTP or HTTPS");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new TypeError("OTLP endpoint must not embed credentials");
  }
  return endpoint.replace(/\/$/, "");
}

export function parseOpenTelemetryEnvironment(
  environment: Environment,
): OpenTelemetryConfig {
  const enabled = environment.AETHERCLOUD_OTEL_ENABLED;
  if (enabled === undefined || enabled === "false") return { enabled: false };
  if (enabled !== "true") {
    throw new TypeError("AETHERCLOUD_OTEL_ENABLED must be true or false");
  }
  const serviceName = environment.OTEL_SERVICE_NAME;
  if (
    serviceName === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(serviceName)
  ) {
    throw new TypeError(
      "OTEL_SERVICE_NAME must be a bounded service identifier",
    );
  }
  const maximumQueueSize = parseInteger(
    environment.AETHERCLOUD_OTEL_MAX_QUEUE_SIZE,
    512,
    "OpenTelemetry queue size",
    1,
    2048,
  );
  const exportIntervalMs = parseInteger(
    environment.OTEL_METRIC_EXPORT_INTERVAL,
    60_000,
    "OpenTelemetry export interval",
    1_000,
    300_000,
  );
  const exportTimeoutMs = parseInteger(
    environment.OTEL_METRIC_EXPORT_TIMEOUT,
    10_000,
    "OpenTelemetry export timeout",
    100,
    30_000,
  );
  return {
    enabled: true,
    serviceName,
    endpoint: parseEndpoint(environment.OTEL_EXPORTER_OTLP_ENDPOINT),
    maximumQueueSize,
    exportIntervalMs,
    exportTimeoutMs,
    samplingRatio: parseSamplingRatio(
      environment.AETHERCLOUD_OTEL_SAMPLING_RATIO,
    ),
  };
}
