import {
  createHash,
  generateKeyPairSync,
  sign as signEd25519,
} from "node:crypto";
import { readFileSync } from "node:fs";

import {
  CreateIntegrationPowerControl,
  OpenCloudLinkSession,
  RecordCloudLinkDurableCursor,
  ReportGatewayRuntimeManifest,
  RestoreGatewayRuntimeProtocols,
  type ApplicationClock,
  type IntegrationControlReceiptAuthenticationInput,
  type IntegrationProjectionRecord,
} from "@aether-cloud/application";
import {
  InMemoryCloudLinkSessionRepository,
  InMemoryGatewayCredentialVerifier,
} from "@aether-cloud/cloudlink-memory-adapter";
import {
  decodeIntegrationControlActionOffer,
  integrationControlReceiptBusinessDigest,
  integrationControlReceiptSigningBytes,
  type IntegrationControlWireActionOffer,
  type IntegrationControlWireActionReceipt,
  type MqttInboundEvent,
} from "@aether-cloud/cloudlink-mqtt-adapter";
import {
  INTEGRATION_CONTROL_PROTOCOL,
  defineIntegrationTopologySnapshot,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseGovernedJobId,
  parseIntegrationId,
  parseProjectId,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";
import { InMemoryIntegrationControlRepository } from "@aether-cloud/integration-control-memory-adapter";
import {
  NodeEd25519IntegrationControlOfferSigner,
  NodeEd25519IntegrationControlReceiptAuthenticator,
  NodeIntegrationControlIntentDigestor,
} from "@aether-cloud/integration-control-node-crypto-adapter";
import {
  InMemoryRuntimeManifestRepository,
  NodeRuntimeManifestIntegrityVerifier,
} from "@aether-cloud/runtime-memory-adapter";
import { describe, expect, it } from "vitest";

import {
  createCloudLinkIntegrationControlFactory,
  startCloudLinkMqttIngress,
  type CloudLinkApplicationCommand,
  type CloudLinkMqttDuplexTransport,
  type CloudLinkMqttTransportConnector,
} from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const firstSessionId = "44444444-4444-4444-8444-444444444444";
const secondSessionId = "88888888-8888-4888-8888-888888888888";
const jobId = "55555555-5555-4555-8555-555555555555";
const credential = {
  credentialId: "development-binding-17",
  proof:
    "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
};

class FixedClock implements ApplicationClock {
  now() {
    return parseUtcInstant("2026-07-17T08:00:00.000Z");
  }
}

class SequenceSessionIds {
  readonly #values = [firstSessionId, secondSessionId].map(
    parseCloudLinkSessionId,
  );

  next() {
    const next = this.#values.shift();
    if (next === undefined) throw new Error("test session IDs exhausted");
    return next;
  }
}

class UnusedCommand implements CloudLinkApplicationCommand {
  execute(): Promise<unknown> {
    return Promise.resolve({
      ok: false,
      failure: { code: "unused-command", message: "not used" },
    });
  }
}

class FakeTransport implements CloudLinkMqttDuplexTransport {
  subscriptions: readonly string[] = [];
  handler: ((event: MqttInboundEvent) => void) | undefined;
  readonly publications: Array<{ topic: string; payload: Uint8Array }> = [];

  subscribe(
    topics: readonly string[],
    handler: (event: MqttInboundEvent) => void,
  ): Promise<void> {
    this.subscriptions = [...topics];
    this.handler = handler;
    return Promise.resolve();
  }

  publish(topic: string, payload: Uint8Array): Promise<void> {
    this.publications.push({ topic, payload });
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class Connector implements CloudLinkMqttTransportConnector {
  readonly transport = new FakeTransport();

  connect(): Promise<CloudLinkMqttDuplexTransport> {
    return Promise.resolve(this.transport);
  }
}

function sharedFixture(name: string): Uint8Array {
  return readFileSync(
    new URL(
      `../../../contracts/cloudlink/v1/fixtures/${name}`,
      import.meta.url,
    ),
  );
}

function record(input: unknown, field: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError(`${field} must be a test object`);
  }
  return input as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = record(value, "canonical value");
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function businessDigest(messageKind: string, payload: unknown): string {
  return `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        protocol_version: "1.0",
        message_kind: messageKind,
        payload,
      }),
    )
    .digest("hex")}`;
}

function controlManifest(): Uint8Array {
  const envelope = JSON.parse(
    new TextDecoder().decode(
      sharedFixture("runtime-manifest-report.valid.json"),
    ),
  ) as Record<string, unknown>;
  envelope.session_epoch = "1";
  const delivery = record(envelope.delivery, "manifest delivery");
  delivery.position = "1";
  delivery.batch_id = "manifest-control-1";
  const payload = record(envelope.payload, "manifest payload");
  const manifest = record(payload.manifest, "runtime manifest");
  const protocols = manifest.protocols;
  if (!Array.isArray(protocols)) {
    throw new TypeError("manifest protocols must be an array");
  }
  protocols.push(
    "aether.cloudlink.integration.v1alpha1",
    INTEGRATION_CONTROL_PROTOCOL,
  );
  protocols.sort();
  const unsigned = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== "checksum"),
  );
  record(manifest.checksum, "manifest checksum").digest = createHash("sha256")
    .update(canonicalJson(unsigned))
    .digest("hex");
  delivery.digest = businessDigest("runtime-manifest-report", payload);
  return new TextEncoder().encode(JSON.stringify(envelope));
}

function sessionHello(clientNonce: string): Uint8Array {
  const envelope = JSON.parse(
    new TextDecoder().decode(sharedFixture("session-hello.valid.json")),
  ) as Record<string, unknown>;
  envelope.client_nonce = clientNonce;
  const binding = record(envelope.credential_binding, "credential binding");
  binding.origin_model = "trusted-connector-broker-attestation";
  delete envelope.gateway_key_id;
  delete envelope.gateway_signature;
  return new TextEncoder().encode(JSON.stringify(envelope));
}

function publishedJson(
  transport: FakeTransport,
): readonly Record<string, unknown>[] {
  return transport.publications.map(
    ({ payload }) =>
      JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>,
  );
}

function offerPublications(
  transport: FakeTransport,
): readonly { topic: string; offer: IntegrationControlWireActionOffer }[] {
  return transport.publications
    .filter(({ topic }) => topic.endsWith("/down/integration-control"))
    .map(({ topic, payload }) => {
      const decoded = decodeIntegrationControlActionOffer(payload);
      if (!decoded.ok) throw new Error(decoded.failure.message);
      return { topic, offer: decoded.value };
    });
}

function signedReceipt(
  offer: IntegrationControlWireActionOffer,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  input: Readonly<{
    position: string;
    sessionId?: string;
    sessionEpoch?: string;
    credentialGeneration?: string;
    sentAtMs?: string;
    expiresAtMs?: string;
    traceparent?: string;
    corruptDigest?: boolean;
    corruptSignature?: boolean;
  }>,
): IntegrationControlWireActionReceipt {
  const unsigned: IntegrationControlWireActionReceipt = {
    schema: "aether.cloudlink.envelope.v1",
    protocol: "aether.cloudlink",
    protocol_version: "1.0",
    message_kind: "integration-action-receipt",
    gateway_id: offer.gateway_id,
    session_id: input.sessionId ?? offer.session_id,
    session_epoch: input.sessionEpoch ?? offer.session_epoch,
    credential_generation:
      input.credentialGeneration ?? offer.credential_generation,
    sent_at_ms: input.sentAtMs ?? "1784275200100",
    ...(input.expiresAtMs === undefined
      ? {}
      : { expires_at_ms: input.expiresAtMs }),
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
    delivery: {
      stream_id: "integration-control-receipts",
      stream_epoch: "1",
      position: input.position,
      batch_id: `integration-control-receipt-${input.position}`,
      digest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
    message_authentication: {
      key_id: "edge-control-key-1",
      algorithm: "Ed25519",
      signature: "A".repeat(86),
    },
    payload: {
      schema: "aether.integration-control.action-receipt.v1alpha1",
      job_id: offer.job_id,
      receipt_id: "77777777-7777-4777-8777-777777777777",
      receipt_sequence: "1",
      capability_id: "device.power.set.v1",
      target: offer.intent.target,
      intent_digest: offer.intent_digest,
      stage: "edge-accepted",
      decision: "accepted",
      physical_outcome: "unknown",
      observed_at_ms: "1784275200100",
      audit: {
        audit_record_id: "edge-audit-control-1",
        status: "complete",
      },
    },
  };
  const digest = integrationControlReceiptBusinessDigest(unsigned);
  const withDigest: IntegrationControlWireActionReceipt = {
    ...unsigned,
    delivery: {
      ...unsigned.delivery,
      digest: input.corruptDigest
        ? "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        : digest,
    },
  };
  const signature = signEd25519(
    null,
    integrationControlReceiptSigningBytes(withDigest),
    privateKey,
  ).toString("base64url");
  return {
    ...withDigest,
    message_authentication: {
      ...withDigest.message_authentication,
      signature: input.corruptSignature ? "A".repeat(86) : signature,
    },
  };
}

const topology = defineIntegrationTopologySnapshot({
  schema: "aether.integration.topology-snapshot.v1alpha1",
  integrationId: "home-assistant.home",
  integrationKind: "home-assistant",
  snapshotGeneration: "9",
  observedAtMs: "1784275199000",
  areas: [],
  devices: [],
  entities: [
    {
      entityId: "entity-registry-light-bedroom",
      sourceAddress: "light.bedroom",
      name: "Bedroom light",
      entityKind: "light",
      points: [
        {
          pointKey: "is_on",
          title: "Power",
          kind: "status",
          valueType: "boolean",
        },
      ],
    },
  ],
});

const projection: IntegrationProjectionRecord = {
  tenantId,
  projectId,
  gatewayId,
  integrationId: parseIntegrationId("home-assistant.home"),
  topology,
  topologyDigest: "a".repeat(64),
  latestObservations: [],
  receivedAt: parseUtcInstant("2026-07-17T08:00:00.000Z"),
  revision: 1,
};

describe("CloudLink MQTT Integration Control composition", () => {
  it("reoffers on reconnect and emits a durable ACK only for authenticated contiguous current-session evidence", async () => {
    const clock = new FixedClock();
    const connector = new Connector();
    const sessions = new InMemoryCloudLinkSessionRepository();
    const manifests = new InMemoryRuntimeManifestRepository();
    const controls = new InMemoryIntegrationControlRepository();
    const outcomes: string[] = [];
    const cloudKeys = generateKeyPairSync("ed25519");
    const edgeKeys = generateKeyPairSync("ed25519");
    const receiptAuthenticationInputs: IntegrationControlReceiptAuthenticationInput[] =
      [];
    const verifier = new InMemoryGatewayCredentialVerifier([
      {
        assertion: credential,
        binding: {
          tenantId,
          projectId,
          gatewayId,
          generation: parseGatewayCredentialGeneration("3"),
          status: "active",
        },
      },
    ]);
    const offerSigner = new NodeEd25519IntegrationControlOfferSigner({
      keyReference: "cloud-control-key-1",
      privateKey: cloudKeys.privateKey,
    });
    const receiptVerifier =
      new NodeEd25519IntegrationControlReceiptAuthenticator({
        resolvePublicKey(keyReference, requestedGatewayId) {
          return Promise.resolve(
            keyReference === "edge-control-key-1" &&
              requestedGatewayId === gatewayId
              ? edgeKeys.publicKey
              : undefined,
          );
        },
      });
    const receiptAuthenticator = {
      verify(input: IntegrationControlReceiptAuthenticationInput) {
        receiptAuthenticationInputs.push(input);
        return receiptVerifier.verify(input);
      },
    };
    const unused = new UnusedCommand();
    const ingress = await startCloudLinkMqttIngress({
      connection: {},
      connector,
      topicPrefix: "aethercloud",
      openSession: new OpenCloudLinkSession({
        repository: sessions,
        credentialVerifier: verifier,
        clock,
        sessionIds: new SequenceSessionIds(),
        supportedProtocolVersions: ["1.0"],
      }),
      resolveTrustedConnectorCredential: {
        execute: () => Promise.resolve({ ok: true, value: credential }),
      },
      heartbeat: unused,
      reportManifest: new ReportGatewayRuntimeManifest({
        repository: manifests,
        credentialVerifier: verifier,
        integrityVerifier: new NodeRuntimeManifestIntegrityVerifier(),
        clock,
      }),
      restoreRuntimeProtocols: new RestoreGatewayRuntimeProtocols({
        repository: manifests,
        credentialVerifier: verifier,
      }),
      ingestTelemetry: unused,
      reportIntegrationTopology: unused,
      reportIntegrationObservations: unused,
      recordDurableCursor: new RecordCloudLinkDurableCursor({
        repository: sessions,
        credentialVerifier: verifier,
        clock,
      }),
      enabledExtensions: [
        "aether.cloudlink.integration.v1alpha1",
        "aether.cloudlink.integration-control.v1alpha1",
      ],
      integrationControlFactory: createCloudLinkIntegrationControlFactory({
        repository: controls,
        sessions,
        manifests,
        credentialVerifier: verifier,
        authenticator: receiptAuthenticator,
        signer: offerSigner,
        clock,
      }),
      clock,
      observer: {
        messageHandled(result) {
          outcomes.push(
            result.outcome === "discarded"
              ? `${result.outcome}:${result.failure.code}`
              : result.outcome,
          );
        },
        internalFailure() {
          outcomes.push("internal-failure");
        },
      },
    });

    const emit = async (topic: string, payload: Uint8Array) => {
      connector.transport.handler?.({
        topic,
        payload,
        qos: 1,
        retain: false,
        duplicate: false,
      });
      await ingress.drain();
    };
    await emit(
      `aethercloud/v1/gateways/${gatewayId}/up/session`,
      sessionHello("A".repeat(43)),
    );
    await emit(
      `aethercloud/v1/gateways/${gatewayId}/up/manifest`,
      controlManifest(),
    );

    const create = new CreateIntegrationPowerControl({
      repository: controls,
      sessions,
      manifests,
      projections: {
        findCurrent() {
          return Promise.resolve(projection);
        },
      },
      digestor: new NodeIntegrationControlIntentDigestor(),
      signer: offerSigner,
      clock,
      enabled: true,
    });
    await expect(
      create.execute(
        {
          tenantId,
          projectId,
          subjectId: "user-homeowner",
          permissions: ["integration.device.control"],
          confirmation: {
            confirmationId: "66666666-6666-4666-8666-666666666666",
            subjectId: "user-homeowner",
            confirmedAtMs: "1784275199500",
          },
          authorization: {
            policyDecisionId: "trusted-policy-decision-1",
            subjectId: "user-homeowner",
            permission: "integration.device.control",
            authorizedAtMs: "1784275199000",
          },
          idempotencyKey: "integration-control-create-composition-1",
          issuedAt: "2026-07-17T07:59:59.000Z",
          expiresAt: "2026-07-17T08:02:00.000Z",
        },
        {
          gatewayId,
          jobId,
          integrationId: "home-assistant.home",
          snapshotGeneration: "9",
          entityId: "entity-registry-light-bedroom",
          value: true,
          jobExpiresAtMs: "1784275320000",
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        providerAccepted: false,
        physicalCompleted: false,
        jobSucceeded: false,
      },
    });
    await expect(
      ingress.pumpIntegrationControl({ tenantId, projectId }, { gatewayId }),
    ).resolves.toEqual({ outcome: "acknowledged" });

    const firstOffer = offerPublications(connector.transport)[0];
    if (firstOffer === undefined) {
      throw new Error("expected the initial control offer");
    }
    expect(firstOffer).toMatchObject({
      topic: `aethercloud/v1/gateways/${gatewayId}/down/integration-control`,
      offer: {
        session_id: firstSessionId,
        session_epoch: "1",
        job_id: jobId,
      },
    });
    await expect(
      controls.findIntent(
        { tenantId, projectId },
        gatewayId,
        parseGovernedJobId(firstOffer.offer.job_id),
      ),
    ).resolves.toMatchObject({ latestReceipt: undefined });

    await emit(
      `aethercloud/v1/gateways/${gatewayId}/up/session`,
      sessionHello("CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"),
    );
    const offers = offerPublications(connector.transport);
    expect(offers).toHaveLength(2);
    expect(offers[1]?.offer).toMatchObject({
      session_id: secondSessionId,
      session_epoch: "2",
      job_id: offers[0]?.offer.job_id,
      intent_digest: offers[0]?.offer.intent_digest,
    });

    const currentOffer = offers[1]?.offer;
    if (currentOffer === undefined) {
      throw new Error("expected both control offers");
    }
    const receiptTopic = `aethercloud/v1/gateways/${gatewayId}/up/integration-control/receipts`;
    const ackCount = () =>
      publishedJson(connector.transport).filter(
        (message) => message.message_kind === "durable-ack",
      ).length;
    const baselineAcks = ackCount();

    const authenticationAttemptsBeforeExpiry =
      receiptAuthenticationInputs.length;
    await emit(
      receiptTopic,
      new TextEncoder().encode(
        JSON.stringify(
          signedReceipt(currentOffer, edgeKeys.privateKey, {
            position: "1",
            sentAtMs: "1784275199000",
            expiresAtMs: "1784275200000",
            traceparent:
              "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          }),
        ),
      ),
    );
    expect(outcomes.at(-1)).toBe("discarded:message-expired");
    expect(receiptAuthenticationInputs).toHaveLength(
      authenticationAttemptsBeforeExpiry,
    );
    expect(ackCount()).toBe(baselineAcks);

    for (const receipt of [
      signedReceipt(firstOffer.offer, edgeKeys.privateKey, { position: "1" }),
      signedReceipt(currentOffer, edgeKeys.privateKey, {
        position: "1",
        credentialGeneration: "4",
      }),
      signedReceipt(currentOffer, edgeKeys.privateKey, {
        position: "1",
        corruptDigest: true,
      }),
      signedReceipt(currentOffer, edgeKeys.privateKey, {
        position: "1",
        corruptSignature: true,
      }),
      signedReceipt(currentOffer, edgeKeys.privateKey, { position: "2" }),
    ]) {
      await emit(
        receiptTopic,
        new TextEncoder().encode(JSON.stringify(receipt)),
      );
      expect(ackCount()).toBe(baselineAcks);
    }

    await emit(
      receiptTopic,
      new TextEncoder().encode(
        JSON.stringify(
          signedReceipt(currentOffer, edgeKeys.privateKey, {
            position: "1",
            expiresAtMs: "1784275201000",
            traceparent:
              "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          }),
        ),
      ),
    );
    expect(ackCount(), outcomes.join(",")).toBe(baselineAcks + 1);
    expect(receiptAuthenticationInputs.at(-1)).toMatchObject({
      expiresAtMs: "1784275201000",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });
    expect(publishedJson(connector.transport).at(-1)).toMatchObject({
      message_kind: "durable-ack",
      gateway_id: gatewayId,
      session_id: secondSessionId,
      session_epoch: "2",
      credential_generation: "3",
      stream_id: "integration-control-receipts",
      stream_epoch: "1",
      acknowledged_position: "1",
      batch_id: "integration-control-receipt-1",
      receipt_id:
        "ack:integration-control:77777777-7777-4777-8777-777777777777:1",
    });
    expect(controls.acknowledgementOutbox()).toHaveLength(1);
    expect(controls.auditEvents().at(-1)).toMatchObject({
      action: "receipt-persisted",
      jobId,
    });
    await ingress.close();
  });
});
