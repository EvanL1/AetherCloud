import { authorityFor } from "@aether-cloud/domain";

export interface PlatformProfile {
  readonly name: "AetherCloud";
  readonly role: "ai-native-multi-cloud-iot-control-plane";
  readonly authority: {
    readonly livePointState: "edge";
    readonly physicalControl: "edge";
    readonly tenantIdentity: "aether-cloud";
    readonly desiredRevision: "aether-cloud";
    readonly placementPolicy: "aether-cloud";
    readonly actualInfrastructure: "provider";
  };
  readonly multiCloud: {
    readonly providerModel: "capability-driven-adapters";
    readonly executionEngines: readonly ["opentofu", "terraform"];
    readonly stateIsolation: "deployment-stack";
  };
}

export function getPlatformProfile(): PlatformProfile {
  return {
    name: "AetherCloud",
    role: "ai-native-multi-cloud-iot-control-plane",
    authority: {
      livePointState: authorityFor("live-point-state"),
      physicalControl: authorityFor("physical-control"),
      tenantIdentity: authorityFor("tenant-identity"),
      desiredRevision: authorityFor("desired-revision"),
      placementPolicy: authorityFor("placement-policy"),
      actualInfrastructure: authorityFor("actual-infrastructure-state"),
    },
    multiCloud: {
      providerModel: "capability-driven-adapters",
      executionEngines: ["opentofu", "terraform"],
      stateIsolation: "deployment-stack",
    },
  };
}
