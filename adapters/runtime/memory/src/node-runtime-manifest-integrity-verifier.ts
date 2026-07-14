import { createHash, timingSafeEqual } from "node:crypto";

import type { RuntimeManifestIntegrityVerifier } from "@aether-cloud/application";
import type { AetherRuntimeManifestV1 } from "@aether-cloud/domain";

type CanonicalJson =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalJson[]
  | Readonly<{ [key: string]: CanonicalJson }>;

function encodePrimitive(value: boolean | null | number | string): string {
  const encoded = JSON.stringify(value);
  return encoded;
}

function canonicalize(value: CanonicalJson): string {
  if (value === null || typeof value !== "object") {
    return encodePrimitive(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as Readonly<Record<string, CanonicalJson>>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${encodePrimitive(key)}:${canonicalize(record[key] as CanonicalJson)}`,
    )
    .join(",")}}`;
}

function manifestPayload(manifest: AetherRuntimeManifestV1): CanonicalJson {
  return {
    schema_version: manifest.schemaVersion,
    composition: manifest.composition,
    aether_version: manifest.aetherVersion,
    target_triple: manifest.targetTriple,
    target_os: manifest.targetOs,
    services: manifest.services,
    cargo_features: manifest.cargoFeatures,
    capabilities: manifest.capabilities,
    protocols: manifest.protocols,
  };
}

export class NodeRuntimeManifestIntegrityVerifier implements RuntimeManifestIntegrityVerifier {
  verify(manifest: AetherRuntimeManifestV1): Promise<boolean> {
    const calculated = createHash("sha256")
      .update(canonicalize(manifestPayload(manifest)), "utf8")
      .digest();
    const expected = Buffer.from(manifest.checksum.digest, "hex");
    return Promise.resolve(
      calculated.length === expected.length &&
        timingSafeEqual(calculated, expected),
    );
  }
}
