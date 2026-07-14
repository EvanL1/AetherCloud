export { BoundedSpanProcessor } from "./bounded-span-processor.js";
export type { BoundedSpanProcessorOptions } from "./bounded-span-processor.js";
export {
  AETHERCLOUD_OPERATIONAL_SIGNAL_CATALOG,
  ObservedTelemetryIngestion,
  OperationalObservability,
  createInMemoryOperationalObservability,
  createOperationalObservability,
  createOperationalObservabilityFromEnvironment,
} from "./operational-observability.js";
export type {
  OperationalEnvironment,
  OperationalMetricPoint,
  OperationalObservabilityOptions,
  TraceCarrierContext,
} from "./operational-observability.js";
export {
  OpenTelemetrySignalSink,
  OpenTelemetryTelemetryIngestion,
  extractW3CTraceContext,
  parseOpenTelemetryEnvironment,
  sanitizeOperationalAttributes,
} from "./compatibility-api.js";
export type {
  OpenTelemetryEnvironmentInput,
  ParsedOpenTelemetryEnvironment,
  ParsedOpenTelemetryEnvironmentDisabled,
  ParsedOpenTelemetryEnvironmentEnabled,
  TelemetryIngestionExecutor,
  TelemetryOperationalObservation,
  TelemetryOperationalSignalSink,
} from "./compatibility-api.js";
