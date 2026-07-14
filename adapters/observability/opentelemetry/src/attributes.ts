export type OperationalAttributeValue = boolean | number | string;

const resultClasses = new Set([
  "accepted",
  "conflicting",
  "duplicate",
  "internal-error",
  "rejected",
  "unavailable",
]);

const allowedKeys = new Set([
  "aethercloud.operation.kind",
  "aethercloud.operation.name",
  "aethercloud.result.class",
  "aethercloud.telemetry.record_count",
]);

const forbiddenKeyPattern =
  /(?:authorization|certificate|error|gateway|job|payload|point|project|tenant|token|url|user)/i;

export function sanitizeOperationalAttributes(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, OperationalAttributeValue>> {
  const output: Record<string, OperationalAttributeValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (forbiddenKeyPattern.test(key)) {
      throw new TypeError(`forbidden operational attribute: ${key}`);
    }
    if (!allowedKeys.has(key)) {
      throw new TypeError(`uncatalogued operational attribute: ${key}`);
    }
    if (key === "aethercloud.operation.kind") {
      if (value !== "command" && value !== "query") {
        throw new TypeError("operation kind must be a bounded catalog value");
      }
    } else if (key === "aethercloud.result.class") {
      if (typeof value !== "string" || !resultClasses.has(value)) {
        throw new TypeError("result class must be a bounded catalog value");
      }
    } else if (key === "aethercloud.operation.name") {
      if (
        typeof value !== "string" ||
        !/^[a-z][a-z0-9.-]{0,127}$/.test(value)
      ) {
        throw new TypeError("operation name must be a bounded catalog value");
      }
    } else if (
      key === "aethercloud.telemetry.record_count" &&
      (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 256)
    ) {
      throw new TypeError("record count must be a bounded integer");
    }
    if (
      typeof value !== "boolean" &&
      typeof value !== "number" &&
      typeof value !== "string"
    ) {
      throw new TypeError(`operational attribute ${key} has an invalid value`);
    }
    output[key] = value;
  }
  return Object.freeze(output);
}
