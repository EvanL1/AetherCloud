import { createHash } from "node:crypto";

import type { IntegrationPayloadDigestor } from "@aether-cloud/application";
import type {
  IntegrationObservationBatch,
  IntegrationTopologySnapshot,
} from "@aether-cloud/domain";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("integration payload contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("integration payload contains an unsupported value");
}

export class NodeIntegrationPayloadDigestor implements IntegrationPayloadDigestor {
  digest(
    payload: IntegrationObservationBatch | IntegrationTopologySnapshot,
  ): Promise<string> {
    return Promise.resolve(
      createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex"),
    );
  }
}
