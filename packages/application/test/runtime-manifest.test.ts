import { describe, expect, it } from "vitest";

import {
  GET_GATEWAY_RUNTIME_MANIFEST_QUERY,
  GetGatewayRuntimeManifest,
  REPORT_GATEWAY_RUNTIME_MANIFEST_COMMAND,
  ReportGatewayRuntimeManifest,
  RestoreGatewayRuntimeProtocols,
  type ApplicationClock,
  type GatewayCredentialVerifier,
  type GatewayCredentialVerificationResult,
  type RuntimeManifestIntegrityVerifier,
  type RuntimeManifestRepository,
  type RuntimeManifestRepositoryRecordInput,
  type RuntimeManifestRepositoryRecordResult,
} from "../src/index.js";
import {
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
  type GatewayCredentialBinding,
  type RuntimeManifestObservation,
} from "@aether-cloud/domain";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const otherTenantId = parseTenantId("99999999-9999-4999-8999-999999999999");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");

class FixedClock implements ApplicationClock {
  now() {
    return parseUtcInstant("2026-07-14T08:05:00.000Z");
  }
}

function binding(
  status: GatewayCredentialBinding["status"] = "active",
): GatewayCredentialBinding {
  return {
    tenantId,
    projectId,
    gatewayId,
    generation: parseGatewayCredentialGeneration("3"),
    status,
  };
}

class StubCredentialVerifier implements GatewayCredentialVerifier {
  calls = 0;
  readonly #result: GatewayCredentialVerificationResult;

  constructor(
    result: GatewayCredentialVerificationResult = {
      ok: true,
      value: binding(),
    },
  ) {
    this.#result = result;
  }

  verify(): Promise<GatewayCredentialVerificationResult> {
    this.calls += 1;
    return Promise.resolve(this.#result);
  }
}

class StubIntegrityVerifier implements RuntimeManifestIntegrityVerifier {
  calls = 0;
  readonly #valid: boolean;

  constructor(valid = true) {
    this.#valid = valid;
  }

  verify(): Promise<boolean> {
    this.calls += 1;
    return Promise.resolve(this.#valid);
  }
}

class StubRuntimeManifestRepository implements RuntimeManifestRepository {
  recorded: RuntimeManifestRepositoryRecordInput | undefined;
  current: RuntimeManifestObservation | undefined;
  result: RuntimeManifestRepositoryRecordResult = {
    outcome: "recorded-latest",
  };

  record(input: RuntimeManifestRepositoryRecordInput) {
    this.recorded = input;
    this.current = input.observation;
    return Promise.resolve(this.result);
  }

  findCurrent(scope: {
    tenantId: typeof tenantId;
    projectId: typeof projectId;
  }) {
    return Promise.resolve(
      scope.tenantId === tenantId && scope.projectId === projectId
        ? this.current
        : undefined,
    );
  }

  findByGeneration() {
    return Promise.resolve(this.current);
  }
}

const commandContext = {
  idempotencyKey: "runtime-manifest-report-001",
  issuedAt: "2026-07-14T08:00:00.000Z",
  expiresAt: "2026-07-14T08:10:00.000Z",
};

const credential = {
  credentialId: "gateway-credential-003",
  proof: "opaque-test-proof-material",
};

const manifest = {
  schema_version: 1,
  composition: "aether-edge-six-service",
  aether_version: "0.5.0",
  target_triple: "x86_64-unknown-linux-gnu",
  target_os: "linux",
  services: [
    "aether-alarm",
    "aether-api",
    "aether-automation",
    "aether-history",
    "aether-io",
    "aether-uplink",
  ],
  cargo_features: [
    "aether-io/aether_485",
    "aether-io/can",
    "aether-io/gpio",
    "aether-io/iec61850",
    "aether-io/modbus",
  ],
  capabilities: [
    "alarm.alert.resolve",
    "alarm.rule.manage",
    "automation.instance.manage",
    "automation.routing.manage",
    "automation.rule.execute",
    "automation.rule.manage",
    "data_processing.process",
    "data_processing.processors.health",
    "data_processing.tasks.list",
    "device.read_point",
    "device.write_point",
    "io.channel.manage",
    "io.channel.reconcile",
  ],
  protocols: [
    "aether_485",
    "can",
    "di_do",
    "iec61850",
    "modbus_rtu",
    "modbus_tcp",
    "sunspec_rtu",
    "sunspec_tcp",
    "virtual",
  ],
  checksum: {
    algorithm: "sha256",
    digest: "ea91777559b1d46f363c7155a0908076369ce690c08da305c1d3052df9b940f7",
  },
} as const;

function input() {
  return {
    credential,
    generation: "7",
    observedAt: "2026-07-14T08:04:00.000Z",
    manifest,
  };
}

function makeUseCase(
  overrides: {
    repository?: StubRuntimeManifestRepository;
    credentialVerifier?: StubCredentialVerifier;
    integrityVerifier?: StubIntegrityVerifier;
  } = {},
) {
  return new ReportGatewayRuntimeManifest({
    repository: overrides.repository ?? new StubRuntimeManifestRepository(),
    credentialVerifier:
      overrides.credentialVerifier ?? new StubCredentialVerifier(),
    integrityVerifier:
      overrides.integrityVerifier ?? new StubIntegrityVerifier(),
    clock: new FixedClock(),
  });
}

describe("runtime manifest application", () => {
  it("declares governed command and deny-by-default query metadata", () => {
    expect(REPORT_GATEWAY_RUNTIME_MANIFEST_COMMAND).toEqual({
      kind: "command",
      name: "fleet.runtime-manifest.report",
      permission: "fleet.runtime-manifest.report",
      risk: "low",
      confirmation: "not-required",
      idempotency: "required",
      expiry: "required",
      audit: "required",
      authorization: "gateway-credential",
    });
    expect(GET_GATEWAY_RUNTIME_MANIFEST_QUERY).toEqual({
      kind: "query",
      name: "fleet.runtime-manifest.get",
      permission: "fleet.runtime-manifest.read",
    });
  });

  it("rejects malformed and additional external fields before authentication", async () => {
    const credentialVerifier = new StubCredentialVerifier();
    const integrityVerifier = new StubIntegrityVerifier();
    const useCase = makeUseCase({ credentialVerifier, integrityVerifier });

    const result = await useCase.execute(commandContext, {
      ...input(),
      manifest: { ...manifest, invented_cloudlink_field: true },
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
    expect(credentialVerifier.calls).toBe(0);
    expect(integrityVerifier.calls).toBe(0);
  });

  it("derives scope from the active credential and records a verified observation", async () => {
    const repository = new StubRuntimeManifestRepository();
    const useCase = makeUseCase({ repository });

    const result = await useCase.execute(commandContext, input());

    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        disposition: "accepted-latest",
        tenantId,
        projectId,
        gatewayId,
        generation: "7",
      },
    });
    if (!result.ok) throw new Error("expected runtime manifest acceptance");
    expect(result.value.capabilities).toEqual(manifest.capabilities);
    expect(repository.recorded).toMatchObject({
      requestId: "runtime-manifest-report-001",
      observation: {
        tenantId,
        projectId,
        gatewayId,
        generation: "7",
        observedAt: "2026-07-14T08:04:00.000Z",
        receivedAt: "2026-07-14T08:05:00.000Z",
        manifest: {
          schemaVersion: 1,
          targetOs: "linux",
          checksum: { digest: manifest.checksum.digest },
        },
      },
    });
  });

  it("fails closed for rejected, inactive, and integrity-invalid reports", async () => {
    const rejected = makeUseCase({
      credentialVerifier: new StubCredentialVerifier({
        ok: false,
        failure: {
          code: "invalid-gateway-credential",
          message: "do not disclose details",
        },
      }),
    });
    const suspended = makeUseCase({
      credentialVerifier: new StubCredentialVerifier({
        ok: true,
        value: binding("suspended"),
      }),
    });
    const integrityVerifier = new StubIntegrityVerifier(false);
    const invalidIntegrity = makeUseCase({ integrityVerifier });

    expect(await rejected.execute(commandContext, input())).toMatchObject({
      ok: false,
      failure: { code: "invalid-gateway-credential" },
    });
    expect(await suspended.execute(commandContext, input())).toMatchObject({
      ok: false,
      failure: { code: "gateway-credential-inactive" },
    });
    expect(
      await invalidIntegrity.execute(commandContext, input()),
    ).toMatchObject({
      ok: false,
      failure: { code: "runtime-manifest-integrity-failed" },
    });
    expect(integrityVerifier.calls).toBe(1);
  });

  it("maps durable replay, late history, request conflict, and generation conflict", async () => {
    const cases: readonly [
      RuntimeManifestRepositoryRecordResult,
      string,
      boolean?,
    ][] = [
      [{ outcome: "replayed" }, "replayed", true],
      [{ outcome: "recorded-late" }, "accepted-late", false],
      [{ outcome: "idempotency-conflict" }, "idempotency-conflict"],
      [
        { outcome: "generation-conflict" },
        "runtime-manifest-generation-conflict",
      ],
    ];

    for (const [repositoryResult, expected, replayed] of cases) {
      const repository = new StubRuntimeManifestRepository();
      repository.result = repositoryResult;
      const result = await makeUseCase({ repository }).execute(
        commandContext,
        input(),
      );
      if (expected === "replayed" || expected === "accepted-late") {
        expect(result).toMatchObject({
          ok: true,
          replayed,
          value: { disposition: expected },
        });
      } else {
        expect(result).toMatchObject({
          ok: false,
          failure: { code: expected },
        });
      }
    }
  });

  it("queries the current capability catalog only within an authorized tenant scope", async () => {
    const repository = new StubRuntimeManifestRepository();
    await makeUseCase({ repository }).execute(commandContext, input());
    const query = new GetGatewayRuntimeManifest({ repository });
    const context = {
      tenantId,
      projectId,
      subjectId: "user-001",
      permissions: ["fleet.runtime-manifest.read"],
    };

    expect(await query.execute(context, { gatewayId })).toMatchObject({
      ok: true,
      value: {
        tenantId,
        gatewayId,
        generation: "7",
      },
    });
    const current = await query.execute(context, { gatewayId });
    if (!current.ok) throw new Error("expected current runtime manifest");
    expect(current.value.protocols).toEqual(manifest.protocols);
    expect(
      await query.execute(
        { ...context, tenantId: otherTenantId },
        { gatewayId },
      ),
    ).toMatchObject({
      ok: false,
      failure: { code: "runtime-manifest-not-found" },
    });
    expect(
      await query.execute({ ...context, permissions: [] }, { gatewayId }),
    ).toMatchObject({
      ok: false,
      failure: { code: "permission-denied" },
    });
  });

  it("restores the current protocol declaration from an active Gateway credential", async () => {
    const repository = new StubRuntimeManifestRepository();
    await makeUseCase({ repository }).execute(commandContext, input());
    const credentialVerifier = new StubCredentialVerifier();
    const restore = new RestoreGatewayRuntimeProtocols({
      repository,
      credentialVerifier,
    });

    await expect(restore.execute({ credential })).resolves.toMatchObject({
      ok: true,
      value: {
        status: "present",
        tenantId,
        projectId,
        gatewayId,
        credentialGeneration: "3",
        manifestGeneration: "7",
        protocols: manifest.protocols,
      },
    });
    expect(credentialVerifier.calls).toBe(1);
  });

  it("restores from a composition-owned Gateway-signed binding without invoking the legacy credential verifier", async () => {
    const repository = new StubRuntimeManifestRepository();
    await makeUseCase({ repository }).execute(commandContext, input());
    const credentialVerifier = new StubCredentialVerifier();
    const restore = new RestoreGatewayRuntimeProtocols({
      repository,
      credentialVerifier,
    });

    await expect(
      restore.execute({
        gatewaySignedBinding: {
          tenantId,
          projectId,
          gatewayId,
          credentialGeneration: "3",
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        status: "present",
        tenantId,
        projectId,
        gatewayId,
        credentialGeneration: "3",
        protocols: manifest.protocols,
      },
    });
    expect(credentialVerifier.calls).toBe(0);
  });

  it("restores an explicit absent declaration without granting any protocol", async () => {
    const credentialVerifier = new StubCredentialVerifier();
    const restore = new RestoreGatewayRuntimeProtocols({
      repository: new StubRuntimeManifestRepository(),
      credentialVerifier,
    });

    const result = await restore.execute({ credential });

    expect(result).toEqual({
      ok: true,
      value: {
        status: "absent",
        tenantId,
        projectId,
        gatewayId,
        credentialGeneration: "3",
      },
    });
    expect(credentialVerifier.calls).toBe(1);
  });

  it("fails protocol restoration closed for malformed, rejected, and inactive credentials", async () => {
    const malformedVerifier = new StubCredentialVerifier();
    const malformed = new RestoreGatewayRuntimeProtocols({
      repository: new StubRuntimeManifestRepository(),
      credentialVerifier: malformedVerifier,
    });
    const rejected = new RestoreGatewayRuntimeProtocols({
      repository: new StubRuntimeManifestRepository(),
      credentialVerifier: new StubCredentialVerifier({
        ok: false,
        failure: {
          code: "invalid-gateway-credential",
          message: "do not disclose details",
        },
      }),
    });
    const inactive = new RestoreGatewayRuntimeProtocols({
      repository: new StubRuntimeManifestRepository(),
      credentialVerifier: new StubCredentialVerifier({
        ok: true,
        value: binding("suspended"),
      }),
    });

    await expect(
      malformed.execute({ credential, injectedScope: { tenantId } }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
    expect(malformedVerifier.calls).toBe(0);
    await expect(rejected.execute({ credential })).resolves.toMatchObject({
      ok: false,
      failure: { code: "invalid-gateway-credential" },
    });
    await expect(inactive.execute({ credential })).resolves.toMatchObject({
      ok: false,
      failure: { code: "gateway-credential-inactive" },
    });
  });
});
