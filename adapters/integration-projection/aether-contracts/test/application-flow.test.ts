import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  ReportIntegrationObservations,
  ReportIntegrationTopology,
  type ApplicationClock,
  type GatewayCredentialVerifier,
} from "@aether-cloud/application";
import {
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  type GatewayCredentialBinding,
} from "@aether-cloud/domain";
import {
  InMemoryIntegrationProjectionRepository,
  NodeIntegrationPayloadDigestor,
} from "@aether-cloud/integration-projection-memory-adapter";

import {
  decodeIntegrationObservationEnvelope,
  decodeIntegrationTopologyEnvelope,
  toReportIntegrationObservationsInput,
  toReportIntegrationTopologyInput,
} from "../src/index.js";

const fixtureRoot = new URL(
  "../../../../contracts/aether-contracts/v0.1.0-alpha.4-candidate/fixtures/integration/v1alpha1/",
  import.meta.url,
);
const credential = {
  credential_id: "gateway-credential-003",
  proof: "opaque-test-proof",
} as const;
const binding: GatewayCredentialBinding = {
  tenantId: parseTenantId("11111111-1111-4111-8111-111111111111"),
  projectId: parseProjectId("22222222-2222-4222-8222-222222222222"),
  gatewayId: parseGatewayId("33333333-3333-4333-8333-333333333333"),
  generation: parseGatewayCredentialGeneration("3"),
  status: "active",
};
const clock: ApplicationClock = {
  now: () => parseUtcInstant("2026-07-17T06:00:00.000Z"),
};
const verifier: GatewayCredentialVerifier = {
  verify(assertion) {
    return Promise.resolve(
      assertion.credentialId === "gateway-credential-003" &&
        assertion.proof === "opaque-test-proof"
        ? { ok: true, value: binding }
        : {
            ok: false,
            failure: {
              code: "invalid-gateway-credential",
              message: "Gateway credential was rejected",
            },
          },
    );
  },
};

async function envelope(path: string): Promise<Uint8Array> {
  const payload = JSON.parse(
    await readFile(new URL(path, fixtureRoot), "utf8"),
  ) as unknown;
  return new TextEncoder().encode(JSON.stringify({ credential, payload }));
}

describe("AetherContracts adapter application flow", () => {
  it("projects official Home Assistant topology and observations through the real use cases", async () => {
    const repository = new InMemoryIntegrationProjectionRepository();
    const dependencies = {
      repository,
      verifier,
      digestor: new NodeIntegrationPayloadDigestor(),
      clock,
    };
    const topology = await new ReportIntegrationTopology(dependencies).execute(
      {
        idempotencyKey: "integration-topology-0001",
        issuedAt: "2026-07-17T05:55:00.000Z",
        expiresAt: "2026-07-17T06:05:00.000Z",
      },
      toReportIntegrationTopologyInput(
        decodeIntegrationTopologyEnvelope(
          await envelope("valid/home-assistant-topology.json"),
        ),
      ),
    );

    expect(topology).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        projection: {
          authority: "edge-reported-copy",
          liveStateAuthoritative: false,
          revision: 1,
        },
      },
    });

    const observations = await new ReportIntegrationObservations(
      dependencies,
    ).execute(
      {
        idempotencyKey: "integration-observations-0001",
        issuedAt: "2026-07-17T05:55:00.000Z",
        expiresAt: "2026-07-17T06:05:00.000Z",
      },
      toReportIntegrationObservationsInput(
        decodeIntegrationObservationEnvelope(
          await envelope("valid/home-assistant-observations.json"),
        ),
      ),
    );

    expect(observations).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        projection: {
          authority: "edge-reported-copy",
          liveStateAuthoritative: false,
          revision: 2,
        },
      },
    });
    if (!observations.ok) {
      throw new Error(observations.failure.message);
    }
    expect(observations.value.projection.latestObservations).toHaveLength(7);
    expect(repository.auditEvents()).toHaveLength(2);
    expect(repository.pendingOutboxEvents()).toHaveLength(2);
  });
});
