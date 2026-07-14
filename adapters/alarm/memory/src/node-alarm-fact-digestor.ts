import { createHash } from "node:crypto";

import type { AlarmFactDigestor } from "@aether-cloud/application";
import type { AlarmFact } from "@aether-cloud/domain";

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    const encoded = JSON.stringify(value);
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("alarm fact contains an unsupported value");
}

export class NodeAlarmFactDigestor implements AlarmFactDigestor {
  digest(fact: AlarmFact): Promise<string> {
    return Promise.resolve(
      createHash("sha256").update(canonicalize(fact), "utf8").digest("hex"),
    );
  }
}
