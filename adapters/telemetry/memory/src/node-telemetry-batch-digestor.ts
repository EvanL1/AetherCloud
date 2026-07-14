import { createHash } from "node:crypto";

import type { TelemetryBatchDigestor } from "@aether-cloud/application";
import type { TelemetryBatch } from "@aether-cloud/domain";

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        "canonical telemetry JSON cannot contain non-finite numbers",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("canonical telemetry JSON contains an unsupported value");
}

export class NodeTelemetryBatchDigestor implements TelemetryBatchDigestor {
  digest(batch: TelemetryBatch): Promise<string> {
    const businessContent = {
      streamId: batch.streamId,
      streamEpoch: batch.streamEpoch,
      retentionClass: batch.retentionClass,
      records: batch.records,
    };
    return Promise.resolve(
      createHash("sha256")
        .update(canonicalize(businessContent), "utf8")
        .digest("hex"),
    );
  }
}
