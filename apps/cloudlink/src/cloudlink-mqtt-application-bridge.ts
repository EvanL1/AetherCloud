import { createHash } from "node:crypto";

import {
  decodeCloudLinkMqttInbound,
  decodeIntegrationControlActionReceipt,
  encodeCloudLinkMqttOutbound,
  mqttDownlinkTopic,
  mqttIntegrationControlReceiptTopic,
  type CloudLinkDeliveryEnvelope,
  type CloudLinkExtension,
  type CloudLinkHeartbeat,
  type CloudLinkMqttOutbound,
  type CloudLinkPointFact,
  type CloudLinkSessionAccepted,
  type CloudLinkSessionChallenge,
  type CloudLinkSessionChallengeRequest,
  type CloudLinkSessionHello,
  type IntegrationControlWireActionReceipt,
} from "@aether-cloud/cloudlink-mqtt-adapter";
import {
  decodeIntegrationObservationPayloadInput,
  decodeIntegrationTopologyPayload,
} from "@aether-cloud/integration-aether-contracts-adapter";

type JsonRecord = Record<string, unknown>;

export interface CloudLinkApplicationCommand {
  execute(context: unknown, input: unknown): Promise<unknown>;
}

export interface CloudLinkApplicationUnaryCommand {
  execute(input: unknown): Promise<unknown>;
}

export interface CloudLinkCredentialQuery {
  execute(input: unknown): Promise<unknown>;
}

export interface CloudLinkMqttResponsePublisher {
  publish(topic: string, payload: Uint8Array): Promise<void>;
}

export interface CloudLinkBridgeClock {
  now(): string;
}

export interface CloudLinkBridgeDependencies {
  readonly topicPrefix: string;
  readonly publisher: CloudLinkMqttResponsePublisher;
  readonly requestSessionChallenge?: CloudLinkApplicationUnaryCommand;
  readonly acceptGatewaySignedSession?: CloudLinkApplicationUnaryCommand;
  readonly authenticateGatewaySignedUplink?: CloudLinkApplicationUnaryCommand;
  /** Trusted deployment-cell scope for this MQTT namespace. Never read from wire payloads. */
  readonly gatewaySignedScope?: Readonly<{
    tenantId: string;
    projectId: string;
  }>;
  readonly openSession: CloudLinkApplicationCommand;
  readonly heartbeat: CloudLinkApplicationCommand;
  readonly reportManifest: CloudLinkApplicationCommand;
  readonly restoreRuntimeProtocols?: CloudLinkCredentialQuery;
  readonly ingestTelemetry: CloudLinkApplicationCommand;
  readonly reportIntegrationTopology?: CloudLinkApplicationCommand;
  readonly reportIntegrationObservations?: CloudLinkApplicationCommand;
  readonly ingestIntegrationControlReceipt?: CloudLinkApplicationCommand;
  readonly publishIntegrationControlOffers?: CloudLinkApplicationCommand;
  readonly reofferIntegrationControls?: CloudLinkApplicationCommand;
  readonly recordDurableCursor?: CloudLinkApplicationCommand;
  readonly recordDataLoss?: CloudLinkApplicationCommand;
  readonly resolveTrustedConnectorCredential?: CloudLinkCredentialQuery;
  readonly clock: CloudLinkBridgeClock;
  readonly heartbeatIntervalMs?: number;
  readonly retentionClass?: "archive-365d" | "hot-7d" | "standard-30d";
  readonly maximumPayloadBytes?: number;
  readonly enabledExtensions?: readonly CloudLinkExtension[];
}

export type CloudLinkBridgeHandleResult =
  | Readonly<{ outcome: "acknowledged" }>
  | Readonly<{ outcome: "deferred" }>
  | Readonly<{ outcome: "rejected" }>
  | Readonly<{
      outcome: "discarded";
      failure: Readonly<{ code: string; message: string }>;
    }>;

interface ActiveSessionAssertion {
  readonly tenantId: string;
  readonly projectId: string;
  readonly gatewayId: string;
  readonly sessionId: string;
  readonly epoch: string;
  readonly credentialGeneration: string;
  readonly originModel:
    | "gateway-signed"
    | "trusted-connector-broker-attestation";
  readonly credential?: Readonly<{ credentialId: string; proof: string }>;
  readonly declaredRuntimeProtocols: ReadonlySet<string>;
  readonly integrationStreamBindings: ReadonlyMap<string, string>;
}

interface GatewaySignedUplinkAuthentication {
  readonly assertion: ActiveSessionAssertion;
  readonly fact: JsonRecord;
  readonly replayed: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: JsonRecord, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function successfulValue(result: unknown): JsonRecord | undefined {
  if (!isRecord(result) || result.ok !== true || !isRecord(result.value)) {
    return undefined;
  }
  return result.value;
}

function hasExactKeys(
  record: JsonRecord,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(record).sort();
  const canonicalExpected = [...expected].sort();
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  );
}

function trustedConnectorCredential(
  result: unknown,
  expectedCredentialId: string,
): Readonly<{ credentialId: string; proof: string }> | undefined {
  const input = successfulValue(result);
  if (
    input === undefined ||
    !hasExactKeys(input, ["credentialId", "proof"]) ||
    stringField(input, "credentialId") !== expectedCredentialId
  ) {
    return undefined;
  }
  const proof = stringField(input, "proof");
  if (proof === undefined || proof.length > 4096) return undefined;
  return Object.freeze({
    credentialId: expectedCredentialId,
    proof,
  });
}

function restoredRuntimeProtocols(
  value: JsonRecord,
  expected: Readonly<{
    tenantId: string;
    projectId: string;
    gatewayId: string;
    credentialGeneration: string;
  }>,
): ReadonlySet<string> | undefined {
  const commonKeys = [
    "credentialGeneration",
    "gatewayId",
    "projectId",
    "status",
    "tenantId",
  ] as const;
  if (
    stringField(value, "tenantId") !== expected.tenantId ||
    stringField(value, "projectId") !== expected.projectId ||
    stringField(value, "gatewayId") !== expected.gatewayId ||
    stringField(value, "credentialGeneration") !== expected.credentialGeneration
  ) {
    return undefined;
  }
  if (value.status === "absent") {
    return hasExactKeys(value, commonKeys) ? new Set() : undefined;
  }
  if (
    value.status !== "present" ||
    !hasExactKeys(value, [...commonKeys, "manifestGeneration", "protocols"]) ||
    stringField(value, "manifestGeneration") === undefined ||
    !Array.isArray(value.protocols) ||
    value.protocols.length > 256
  ) {
    return undefined;
  }
  const protocols = new Set<string>();
  for (const protocol of value.protocols) {
    if (
      typeof protocol !== "string" ||
      protocol.trim().length === 0 ||
      protocol.length > 256 ||
      protocols.has(protocol)
    ) {
      return undefined;
    }
    protocols.add(protocol);
  }
  return protocols;
}

const positiveUint64Pattern = /^[1-9][0-9]*$/;
const maximumUint64 = 18_446_744_073_709_551_615n;
const streamIdPattern = /^[a-z][a-z0-9.-]{0,63}$/;
const sha256DigestPattern = /^sha256:[0-9a-f]{64}$/;

function resumeCursors(
  value: JsonRecord,
): CloudLinkSessionAccepted["resume"] | undefined {
  const raw = value.resumeCursors;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 32) return undefined;
  const identities = new Set<string>();
  const decoded: CloudLinkSessionAccepted["resume"][number][] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) return undefined;
    const streamId = stringField(candidate, "streamId");
    const streamEpoch = stringField(candidate, "streamEpoch");
    const position = stringField(candidate, "position");
    if (
      streamId === undefined ||
      !streamIdPattern.test(streamId) ||
      streamEpoch === undefined ||
      !positiveUint64Pattern.test(streamEpoch) ||
      BigInt(streamEpoch) > maximumUint64 ||
      position === undefined ||
      !positiveUint64Pattern.test(position) ||
      BigInt(position) > maximumUint64
    ) {
      return undefined;
    }
    const identity = `${streamId}:${streamEpoch}`;
    if (identities.has(identity)) return undefined;
    identities.add(identity);
    decoded.push({
      stream_id: streamId,
      stream_epoch: streamEpoch,
      acknowledged_position: position,
    });
  }
  return decoded;
}

function applicationFailure(result: unknown): Readonly<{
  code: string;
  message: string;
}> {
  if (isRecord(result) && result.ok === false && isRecord(result.failure)) {
    return {
      code:
        stringField(result.failure, "code") ?? "application-command-rejected",
      message:
        stringField(result.failure, "message") ??
        "The application command rejected the CloudLink message",
    };
  }
  return {
    code: "invalid-application-result",
    message: "The application command returned an invalid result",
  };
}

function applicationFailureCode(result: unknown): string | undefined {
  return isRecord(result) && result.ok === false && isRecord(result.failure)
    ? stringField(result.failure, "code")
    : undefined;
}

function addMilliseconds(instant: string, milliseconds: number): string {
  const parsed = Date.parse(instant);
  if (!Number.isFinite(parsed)) {
    throw new Error("CloudLink bridge clock returned an invalid UTC instant");
  }
  return new Date(parsed + milliseconds).toISOString();
}

function unixMilliseconds(instant: string): string {
  const parsed = Date.parse(instant);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("CloudLink bridge clock is outside the Unix-ms profile");
  }
  return String(parsed);
}

function unixMillisecondsToInstant(milliseconds: string): string {
  const numeric = Number(milliseconds);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(
      "CloudLink Unix-ms value cannot enter the application clock",
    );
  }
  const instant = new Date(numeric);
  if (Number.isNaN(instant.valueOf())) {
    throw new Error("CloudLink Unix-ms value is outside the application clock");
  }
  return instant.toISOString();
}

function commandContext(now: string, idempotencyKey: string) {
  return {
    idempotencyKey,
    issuedAt: now,
    expiresAt: addMilliseconds(now, 5 * 60 * 1000),
  };
}

function deliveryIdentityDigest(message: CloudLinkDeliveryEnvelope): string {
  return createHash("sha256")
    .update(message.gateway_id)
    .update("\0")
    .update(message.delivery.stream_id)
    .update("\0")
    .update(message.delivery.stream_epoch)
    .update("\0")
    .update(message.delivery.position)
    .digest("hex");
}

function sessionRequestId(message: CloudLinkSessionHello): string {
  const digest = createHash("sha256")
    .update(message.gateway_id)
    .update("\0")
    .update(message.credential_binding.credential_id)
    .update("\0")
    .update(message.credential_binding.generation)
    .update("\0")
    .update(message.challenge_id)
    .update("\0")
    .update(message.client_nonce)
    .update("\0")
    .update(JSON.stringify(message.offered_protocol_versions))
    .update("\0")
    .update(JSON.stringify(message.resume))
    .digest("hex");
  return `cloudlink:session:${digest}`;
}

function integrationReceiptId(
  result: unknown,
  message: Extract<
    CloudLinkDeliveryEnvelope,
    {
      message_kind:
        | "integration-observation-batch"
        | "integration-topology-snapshot";
    }
  >,
  requestId: string,
  hasStrictCurrentAcknowledgement: boolean,
): string | undefined {
  const value = successfulValue(result);
  if (
    value === undefined ||
    (value.disposition !== "persisted" && value.disposition !== "replayed") ||
    !isRecord(value.receipt)
  ) {
    return undefined;
  }
  const receipt = value.receipt;
  const integrationId = stringField(message.payload, "integration_id");
  const snapshotGeneration = stringField(
    message.payload,
    "snapshot_generation",
  );
  const outboxEventId = stringField(receipt, "outboxEventId");
  const auditEventId = stringField(receipt, "auditEventId");
  const payloadDigest = stringField(receipt, "payloadDigest");
  const receiptCredentialGeneration = stringField(
    receipt,
    "credentialGeneration",
  );
  const exactHistoricalReplay =
    isRecord(result) &&
    result.replayed === true &&
    value.disposition === "replayed" &&
    hasStrictCurrentAcknowledgement &&
    receiptCredentialGeneration !== undefined &&
    positiveUint64Pattern.test(receiptCredentialGeneration) &&
    BigInt(receiptCredentialGeneration) <= maximumUint64 &&
    BigInt(receiptCredentialGeneration) < BigInt(message.credential_generation);
  if (
    integrationId === undefined ||
    snapshotGeneration === undefined ||
    receipt.kind !==
      (message.message_kind === "integration-topology-snapshot"
        ? "topology"
        : "observations") ||
    stringField(receipt, "tenantId") === undefined ||
    stringField(receipt, "projectId") === undefined ||
    stringField(receipt, "gatewayId") !== message.gateway_id ||
    stringField(receipt, "integrationId") !== integrationId ||
    (receiptCredentialGeneration !== message.credential_generation &&
      !exactHistoricalReplay) ||
    stringField(receipt, "requestId") !== requestId ||
    stringField(receipt, "snapshotGeneration") !== snapshotGeneration ||
    payloadDigest === undefined ||
    !/^[0-9a-f]{64}$/.test(payloadDigest) ||
    outboxEventId === undefined ||
    auditEventId === undefined ||
    outboxEventId === auditEventId ||
    stringField(receipt, "committedAt") === undefined ||
    typeof receipt.revision !== "number" ||
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision < 1
  ) {
    return undefined;
  }
  if (
    message.message_kind === "integration-observation-batch" &&
    stringField(receipt, "batchId") !== stringField(message.payload, "batch_id")
  ) {
    return undefined;
  }
  return `receipt:integration:${createHash("sha256")
    .update(outboxEventId)
    .digest("hex")}`;
}

function sessionMatches(
  message: Readonly<{
    gateway_id: string;
    session_id: string;
    session_epoch: string;
    credential_generation: string;
  }>,
  assertion: ActiveSessionAssertion,
): boolean {
  return (
    assertion.gatewayId === message.gateway_id &&
    assertion.sessionId === message.session_id &&
    assertion.epoch === message.session_epoch &&
    assertion.credentialGeneration === message.credential_generation
  );
}

function gatewaySignedUplinkCommandInput(
  message:
    | CloudLinkDeliveryEnvelope
    | (CloudLinkHeartbeat & Readonly<{ message_kind: "heartbeat" }>)
    | IntegrationControlWireActionReceipt,
  scope: Readonly<{ tenantId: string; projectId: string }>,
): JsonRecord | undefined {
  const authentication = message.message_authentication;
  if (authentication === undefined) return undefined;
  const common = {
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    gatewayId: message.gateway_id,
    sessionId: message.session_id,
    sessionEpoch: message.session_epoch,
    credentialGeneration: message.credential_generation,
    messageKind: message.message_kind,
    messageAuthentication: {
      keyId: authentication.key_id,
      algorithm: authentication.algorithm,
      signature: authentication.signature,
    },
  };
  if (message.message_kind === "heartbeat") {
    return {
      ...common,
      observedAtMs: message.observed_at_ms,
    };
  }
  return {
    ...common,
    sentAtMs: message.sent_at_ms,
    ...(message.expires_at_ms !== undefined
      ? { expiresAtMs: message.expires_at_ms }
      : {}),
    delivery: {
      streamId: message.delivery.stream_id,
      streamEpoch: message.delivery.stream_epoch,
      position: message.delivery.position,
      batchId: message.delivery.batch_id,
      digest: message.delivery.digest,
    },
  };
}

function gatewaySignedAuthenticationFailure(
  result?: unknown,
): CloudLinkBridgeHandleResult {
  const code = applicationFailureCode(result);
  return {
    outcome: "discarded",
    failure: {
      code:
        code === "MESSAGE_EXPIRED"
          ? "MESSAGE_EXPIRED"
          : "AUTHENTICATION_INVALID",
      message:
        code === "MESSAGE_EXPIRED"
          ? "Gateway uplink message has expired"
          : "Gateway uplink authentication is invalid",
    },
  };
}

function applicationAuthenticationInput(
  assertion: ActiveSessionAssertion,
  gatewaySignedAuthentication: JsonRecord | undefined,
): JsonRecord {
  return gatewaySignedAuthentication === undefined
    ? { credential: assertion.credential }
    : { gatewaySignedAuthentication };
}

function applicationCloudLinkBusinessDelivery(
  message: CloudLinkDeliveryEnvelope,
): JsonRecord {
  return {
    sentAtMs: message.sent_at_ms,
    expiresAtMs: message.expires_at_ms ?? null,
    sessionId: message.session_id,
    sessionEpoch: message.session_epoch,
    credentialGeneration: message.credential_generation,
    streamId: message.delivery.stream_id,
    streamEpoch: message.delivery.stream_epoch,
    position: message.delivery.position,
    batchId: message.delivery.batch_id,
    digest: message.delivery.digest,
    messageKind: message.message_kind,
  };
}

function signingProjectionMatchesMessage(
  input: unknown,
  message:
    | CloudLinkDeliveryEnvelope
    | (CloudLinkHeartbeat & Readonly<{ message_kind: "heartbeat" }>)
    | IntegrationControlWireActionReceipt,
): boolean {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "batch_id",
      "business_digest",
      "credential_generation",
      "expires_at_ms",
      "gateway_id",
      "message_kind",
      "position",
      "schema",
      "sent_at_ms",
      "session_epoch",
      "session_id",
      "stream_epoch",
      "stream_id",
    ]) ||
    input.schema !== "aether.cloudlink.uplink-signing.v1alpha1" ||
    input.gateway_id !== message.gateway_id ||
    input.credential_generation !== message.credential_generation ||
    input.session_id !== message.session_id ||
    input.session_epoch !== message.session_epoch ||
    input.message_kind !== message.message_kind
  ) {
    return false;
  }
  if (message.message_kind === "heartbeat") {
    return (
      input.sent_at_ms === message.observed_at_ms &&
      input.expires_at_ms === null &&
      input.stream_id === null &&
      input.stream_epoch === null &&
      input.position === null &&
      input.batch_id === null &&
      input.business_digest === null
    );
  }
  return (
    input.sent_at_ms === message.sent_at_ms &&
    input.expires_at_ms === (message.expires_at_ms ?? null) &&
    input.stream_id === message.delivery.stream_id &&
    input.stream_epoch === message.delivery.stream_epoch &&
    input.position === message.delivery.position &&
    input.batch_id === message.delivery.batch_id &&
    input.business_digest === message.delivery.digest
  );
}

function integrationControlReceiptTopicCandidate(
  topicPrefix: string,
  topic: string,
): boolean {
  const prefix = `${topicPrefix}/v1/gateways/`;
  const suffix = "/up/integration-control/receipts";
  if (!topic.startsWith(prefix) || !topic.endsWith(suffix)) return false;
  const gatewaySegment = topic.slice(
    prefix.length,
    topic.length - suffix.length,
  );
  return gatewaySegment.length > 0 && !gatewaySegment.includes("/");
}

function controlEnabled(dependencies: CloudLinkBridgeDependencies): boolean {
  return (
    dependencies.enabledExtensions?.includes(
      "aether.cloudlink.integration-control.v1alpha1",
    ) === true
  );
}

function pointRecord(sample: CloudLinkPointFact, position: string) {
  return {
    kind: "point-sample",
    // CloudLink positions are positive and Edge starts at one. The existing
    // application telemetry model is zero-based, so preserve a bijection at
    // this boundary instead of teaching either domain the other's convention.
    position: (BigInt(position) - 1n).toString(),
    sourceTimestampMs: sample.source_timestamp_ms,
    instanceId: sample.instance_id,
    pointKind: sample.point_kind,
    pointId: sample.point_id,
    quality: sample.quality,
    value: { type: "float64", value: sample.value },
    ...(sample.model === undefined
      ? {}
      : {
          model: {
            modelId: sample.model.model_id,
            revision: sample.model.revision,
          },
        }),
  };
}

function runtimeProtocols(manifest: JsonRecord): readonly string[] | undefined {
  const protocols = manifest.protocols;
  if (!Array.isArray(protocols)) return undefined;
  const decoded: string[] = [];
  for (const protocol of protocols as readonly unknown[]) {
    if (typeof protocol !== "string") return undefined;
    decoded.push(protocol);
  }
  return decoded;
}

export class CloudLinkMqttApplicationBridge {
  readonly #dependencies: CloudLinkBridgeDependencies;
  readonly #sessions = new Map<string, ActiveSessionAssertion>();

  constructor(dependencies: CloudLinkBridgeDependencies) {
    const gatewaySignedComposition = [
      dependencies.requestSessionChallenge,
      dependencies.acceptGatewaySignedSession,
      dependencies.authenticateGatewaySignedUplink,
      dependencies.gatewaySignedScope,
    ];
    if (
      gatewaySignedComposition.some((dependency) => dependency !== undefined) &&
      !gatewaySignedComposition.every((dependency) => dependency !== undefined)
    ) {
      throw new TypeError(
        "CloudLink requires a complete Gateway-signed session composition including per-uplink authentication",
      );
    }
    const readOnlyIntegrationEnabled =
      dependencies.enabledExtensions?.includes(
        "aether.cloudlink.integration.v1alpha1",
      ) ?? false;
    const controlEnabled =
      dependencies.enabledExtensions?.includes(
        "aether.cloudlink.integration-control.v1alpha1",
      ) ?? false;
    if (controlEnabled && !readOnlyIntegrationEnabled) {
      throw new TypeError(
        "CloudLink Integration Control extension requires explicit read-only Integration enablement",
      );
    }
    if (
      controlEnabled &&
      (dependencies.ingestIntegrationControlReceipt === undefined ||
        dependencies.publishIntegrationControlOffers === undefined ||
        dependencies.reofferIntegrationControls === undefined)
    ) {
      throw new TypeError(
        "CloudLink Integration Control extension requires a complete application composition",
      );
    }
    if (
      dependencies.enabledExtensions?.includes(
        "aether.cloudlink.integration.v1alpha1",
      ) === true &&
      dependencies.restoreRuntimeProtocols === undefined
    ) {
      throw new TypeError(
        "CloudLink Integration extension requires Runtime Manifest protocol restoration",
      );
    }
    this.#dependencies = dependencies;
  }

  async #restoreDeclaredRuntimeProtocols(
    input: Readonly<{
      tenantId: string;
      projectId: string;
      gatewayId: string;
      credentialGeneration: string;
      credential?: Readonly<{ credentialId: string; proof: string }>;
    }>,
  ): Promise<
    | Readonly<{ ok: true; value: ReadonlySet<string> }>
    | Readonly<{ ok: false; result: CloudLinkBridgeHandleResult }>
  > {
    if (
      this.#dependencies.enabledExtensions?.includes(
        "aether.cloudlink.integration.v1alpha1",
      ) !== true
    ) {
      return { ok: true, value: new Set() };
    }
    const restore = this.#dependencies.restoreRuntimeProtocols;
    if (restore === undefined) {
      throw new Error(
        "Runtime Manifest restoration dependency was not initialized",
      );
    }
    let restoredResult: unknown;
    try {
      restoredResult = await restore.execute(
        input.credential === undefined
          ? {
              gatewaySignedBinding: {
                tenantId: input.tenantId,
                projectId: input.projectId,
                gatewayId: input.gatewayId,
                credentialGeneration: input.credentialGeneration,
              },
            }
          : { credential: input.credential },
      );
    } catch {
      return {
        ok: false,
        result: {
          outcome: "discarded",
          failure: {
            code: "runtime-protocol-restoration-failed",
            message: "Runtime Manifest protocol restoration failed closed",
          },
        },
      };
    }
    const restoredValue = successfulValue(restoredResult);
    if (restoredValue === undefined) {
      return {
        ok: false,
        result: {
          outcome: "discarded",
          failure: applicationFailure(restoredResult),
        },
      };
    }
    const restored = restoredRuntimeProtocols(restoredValue, input);
    if (restored === undefined) {
      return {
        ok: false,
        result: {
          outcome: "discarded",
          failure: {
            code: "invalid-runtime-protocol-restoration",
            message:
              "Runtime Manifest restoration returned mismatched identity or malformed protocols",
          },
        },
      };
    }
    return { ok: true, value: restored };
  }

  async #authenticateGatewaySignedUplink(
    message:
      | CloudLinkDeliveryEnvelope
      | (CloudLinkHeartbeat & Readonly<{ message_kind: "heartbeat" }>)
      | IntegrationControlWireActionReceipt,
  ): Promise<
    | Readonly<{ ok: true; value: GatewaySignedUplinkAuthentication }>
    | Readonly<{ ok: false; result: CloudLinkBridgeHandleResult }>
  > {
    const command = this.#dependencies.authenticateGatewaySignedUplink;
    const scope = this.#dependencies.gatewaySignedScope;
    if (command === undefined || scope === undefined) {
      return {
        ok: false,
        result: gatewaySignedAuthenticationFailure(),
      };
    }
    const input = gatewaySignedUplinkCommandInput(message, scope);
    if (input === undefined) {
      return {
        ok: false,
        result: gatewaySignedAuthenticationFailure(),
      };
    }
    let result: unknown;
    try {
      result = await command.execute(input);
    } catch {
      return {
        ok: false,
        result: gatewaySignedAuthenticationFailure(),
      };
    }
    const value = successfulValue(result);
    const replayed =
      isRecord(result) && typeof result.replayed === "boolean"
        ? result.replayed
        : undefined;
    const authentication = message.message_authentication;
    if (
      value === undefined ||
      replayed === undefined ||
      authentication === undefined ||
      stringField(value, "tenantId") !== scope.tenantId ||
      stringField(value, "projectId") !== scope.projectId ||
      stringField(value, "gatewayId") !== message.gateway_id ||
      stringField(value, "sessionId") !== message.session_id ||
      stringField(value, "sessionEpoch") !== message.session_epoch ||
      stringField(value, "credentialGeneration") !==
        message.credential_generation ||
      stringField(value, "gatewayKeyId") !== authentication.key_id ||
      stringField(value, "messageKind") !== message.message_kind ||
      !sha256DigestPattern.test(
        stringField(value, "signingObjectDigest") ?? "",
      ) ||
      !signingProjectionMatchesMessage(value.signingProjection, message) ||
      typeof value.refreshServerLiveness !== "boolean" ||
      (message.message_kind === "heartbeat"
        ? value.refreshServerLiveness !== !replayed
        : value.refreshServerLiveness)
    ) {
      return {
        ok: false,
        result: gatewaySignedAuthenticationFailure(result),
      };
    }
    const current = this.#sessions.get(message.session_id);
    if (
      current !== undefined &&
      (current.originModel !== "gateway-signed" ||
        current.tenantId !== scope.tenantId ||
        current.projectId !== scope.projectId ||
        !sessionMatches(message, current))
    ) {
      return {
        ok: false,
        result: gatewaySignedAuthenticationFailure(),
      };
    }
    let assertion = current;
    if (assertion === undefined) {
      const restored = await this.#restoreDeclaredRuntimeProtocols({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        gatewayId: message.gateway_id,
        credentialGeneration: message.credential_generation,
      });
      if (!restored.ok) return restored;
      assertion = Object.freeze({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        gatewayId: message.gateway_id,
        sessionId: message.session_id,
        epoch: message.session_epoch,
        credentialGeneration: message.credential_generation,
        originModel: "gateway-signed",
        declaredRuntimeProtocols: restored.value,
        integrationStreamBindings: new Map<string, string>(),
      });
    }
    this.#sessions.set(message.session_id, assertion);
    return {
      ok: true,
      value: {
        assertion,
        fact: value,
        replayed,
      },
    };
  }

  async handle(
    event: Readonly<{ topic: string; payload: Uint8Array }>,
  ): Promise<CloudLinkBridgeHandleResult> {
    if (
      integrationControlReceiptTopicCandidate(
        this.#dependencies.topicPrefix,
        event.topic,
      )
    ) {
      return this.#ingestIntegrationControlReceipt(event);
    }
    const decoded = decodeCloudLinkMqttInbound(event.topic, event.payload, {
      topicPrefix: this.#dependencies.topicPrefix,
      ...(this.#dependencies.maximumPayloadBytes === undefined
        ? {}
        : { maximumPayloadBytes: this.#dependencies.maximumPayloadBytes }),
      ...(this.#dependencies.enabledExtensions === undefined
        ? {}
        : { enabledExtensions: this.#dependencies.enabledExtensions }),
    });
    if (!decoded.ok) {
      return { outcome: "discarded", failure: decoded.failure };
    }

    const message = decoded.value;
    if (message.message_kind === "session-challenge-request") {
      return this.#requestSessionChallenge(message);
    }
    if (message.message_kind === "session-hello") {
      return this.#openSession(message);
    }

    const cachedAssertion = this.#sessions.get(message.session_id);
    let assertion: ActiveSessionAssertion;
    let gatewaySignedAuthentication:
      | GatewaySignedUplinkAuthentication
      | undefined;
    if (
      cachedAssertion?.originModel === "trusted-connector-broker-attestation"
    ) {
      if (!sessionMatches(message, cachedAssertion)) {
        return { outcome: "rejected" };
      }
      assertion = cachedAssertion;
    } else if (
      cachedAssertion === undefined &&
      this.#dependencies.authenticateGatewaySignedUplink === undefined
    ) {
      return { outcome: "rejected" };
    } else {
      const authenticated =
        await this.#authenticateGatewaySignedUplink(message);
      if (!authenticated.ok) return authenticated.result;
      gatewaySignedAuthentication = authenticated.value;
      assertion = authenticated.value.assertion;
    }

    if (
      gatewaySignedAuthentication === undefined &&
      "expires_at_ms" in message &&
      BigInt(unixMilliseconds(this.#dependencies.clock.now())) >=
        BigInt(message.expires_at_ms)
    ) {
      return {
        outcome: "discarded",
        failure: {
          code: "message-expired",
          message: "CloudLink delivery expired before application handling",
        },
      };
    }

    switch (message.message_kind) {
      case "heartbeat":
        return this.#heartbeat(message, assertion, gatewaySignedAuthentication);
      case "runtime-manifest-report":
        return this.#reportManifest(
          message,
          assertion,
          gatewaySignedAuthentication?.fact,
        );
      case "telemetry-batch":
        return this.#ingestTelemetry(
          message,
          assertion,
          gatewaySignedAuthentication?.fact,
        );
      case "integration-topology-snapshot":
        return this.#reportIntegrationTopology(
          message,
          assertion,
          gatewaySignedAuthentication?.fact,
        );
      case "integration-observation-batch":
        return this.#reportIntegrationObservations(
          message,
          assertion,
          gatewaySignedAuthentication?.fact,
        );
      case "data-loss":
        return this.#recordDataLoss(
          message,
          assertion,
          gatewaySignedAuthentication?.fact,
        );
    }
  }

  async #requestSessionChallenge(
    message: CloudLinkSessionChallengeRequest,
  ): Promise<CloudLinkBridgeHandleResult> {
    const command = this.#dependencies.requestSessionChallenge;
    if (command === undefined) {
      return {
        outcome: "discarded",
        failure: {
          code: "gateway-signed-session-disabled",
          message: "Gateway-signed CloudLink sessions are disabled",
        },
      };
    }
    const result = await command.execute({
      gatewayId: message.gateway_id,
      credentialId: message.credential_binding.credential_id,
      credentialGeneration: message.credential_binding.generation,
      protocolVersions: message.offered_protocol_versions,
      clientNonce: message.client_nonce,
      clientPositions: message.resume.map((cursor) => ({
        streamId: cursor.stream_id,
        streamEpoch: cursor.stream_epoch,
        position: cursor.acknowledged_position,
      })),
    });
    const value = successfulValue(result);
    if (
      value === undefined ||
      !hasExactKeys(value, [
        "challengeId",
        "cloudAuthentication",
        "cloudNonce",
        "expiresAtMs",
        "gatewayId",
        "issuedAtMs",
      ]) ||
      stringField(value, "gatewayId") !== message.gateway_id ||
      stringField(value, "challengeId") === undefined ||
      stringField(value, "cloudNonce") === undefined ||
      stringField(value, "issuedAtMs") === undefined ||
      stringField(value, "expiresAtMs") === undefined ||
      !isRecord(value.cloudAuthentication) ||
      !hasExactKeys(value.cloudAuthentication, [
        "algorithm",
        "keyId",
        "signature",
      ]) ||
      value.cloudAuthentication.algorithm !== "Ed25519" ||
      stringField(value.cloudAuthentication, "keyId") === undefined ||
      stringField(value.cloudAuthentication, "signature") === undefined
    ) {
      return {
        outcome: "discarded",
        failure: applicationFailure(result),
      };
    }
    const challenge: CloudLinkSessionChallenge = {
      schema: "aether.cloudlink.session-challenge.v1",
      protocol: "aether.cloudlink",
      message_kind: "session-challenge",
      gateway_id: message.gateway_id,
      challenge_id: stringField(value, "challengeId") as string,
      cloud_nonce: stringField(value, "cloudNonce") as string,
      issued_at_ms: stringField(value, "issuedAtMs") as string,
      expires_at_ms: stringField(value, "expiresAtMs") as string,
      cloud_signature: {
        key_id: stringField(value.cloudAuthentication, "keyId") as string,
        algorithm: "Ed25519",
        signature: stringField(
          value.cloudAuthentication,
          "signature",
        ) as string,
      },
    };
    const publication = this.#preparePublication(
      message.gateway_id,
      "session",
      challenge,
    );
    if (publication === undefined) {
      return {
        outcome: "discarded",
        failure: applicationFailure(result),
      };
    }
    try {
      await this.#dependencies.publisher.publish(
        publication.topic,
        publication.payload,
      );
    } catch {
      return { outcome: "deferred" };
    }
    return { outcome: "acknowledged" };
  }

  async #acceptGatewaySignedSession(
    message: CloudLinkSessionHello,
  ): Promise<CloudLinkBridgeHandleResult> {
    const command = this.#dependencies.acceptGatewaySignedSession;
    if (
      command === undefined ||
      message.gateway_key_id === undefined ||
      message.gateway_signature === undefined
    ) {
      return {
        outcome: "discarded",
        failure: {
          code: "authentication-evidence-missing",
          message:
            "Gateway-signed CloudLink session authentication is unavailable",
        },
      };
    }
    const result = await command.execute({
      originModel: "gateway-signed",
      gatewayId: message.gateway_id,
      credentialId: message.credential_binding.credential_id,
      credentialGeneration: message.credential_binding.generation,
      gatewayKeyId: message.gateway_key_id,
      gatewayAuthentication: {
        keyId: message.gateway_signature.key_id,
        algorithm: message.gateway_signature.algorithm,
        signature: message.gateway_signature.signature,
      },
      challengeId: message.challenge_id,
      protocolVersions: message.offered_protocol_versions,
      clientNonce: message.client_nonce,
      clientPositions: message.resume.map((cursor) => ({
        streamId: cursor.stream_id,
        streamEpoch: cursor.stream_epoch,
        position: cursor.acknowledged_position,
      })),
    });
    const value = successfulValue(result);
    const sessionId =
      value === undefined ? undefined : stringField(value, "sessionId");
    const epoch = value === undefined ? undefined : stringField(value, "epoch");
    const acceptedGatewayId =
      value === undefined ? undefined : stringField(value, "gatewayId");
    const tenantId =
      value === undefined ? undefined : stringField(value, "tenantId");
    const projectId =
      value === undefined ? undefined : stringField(value, "projectId");
    const credentialGeneration =
      value === undefined
        ? undefined
        : stringField(value, "credentialGeneration");
    const selectedProtocol =
      value === undefined ? undefined : stringField(value, "protocolVersion");
    const gatewayKeyId =
      value === undefined ? undefined : stringField(value, "gatewayKeyId");
    const heartbeatIntervalMs =
      value === undefined
        ? undefined
        : stringField(value, "heartbeatIntervalMs");
    const serverResume = value === undefined ? undefined : resumeCursors(value);
    if (
      sessionId === undefined ||
      epoch === undefined ||
      tenantId === undefined ||
      projectId === undefined ||
      acceptedGatewayId !== message.gateway_id ||
      credentialGeneration !== message.credential_binding.generation ||
      gatewayKeyId !== message.gateway_key_id ||
      heartbeatIntervalMs === undefined ||
      !positiveUint64Pattern.test(heartbeatIntervalMs) ||
      BigInt(heartbeatIntervalMs) > maximumUint64 ||
      selectedProtocol !== "1.0" ||
      value?.state !== "active" ||
      serverResume === undefined
    ) {
      return {
        outcome: "discarded",
        failure: applicationFailure(result),
      };
    }

    for (const [existingSessionId, assertion] of this.#sessions) {
      if (
        assertion.tenantId === tenantId &&
        assertion.projectId === projectId &&
        assertion.gatewayId === acceptedGatewayId
      ) {
        this.#sessions.delete(existingSessionId);
      }
    }
    const restored = await this.#restoreDeclaredRuntimeProtocols({
      tenantId,
      projectId,
      gatewayId: acceptedGatewayId,
      credentialGeneration,
    });
    if (!restored.ok) return restored.result;
    const assertion: ActiveSessionAssertion = {
      tenantId,
      projectId,
      gatewayId: acceptedGatewayId,
      sessionId,
      epoch,
      credentialGeneration,
      originModel: "gateway-signed",
      declaredRuntimeProtocols: restored.value,
      integrationStreamBindings: new Map(),
    };
    this.#sessions.set(sessionId, assertion);
    const now = this.#dependencies.clock.now();
    const accepted: CloudLinkSessionAccepted = {
      schema: "aether.cloudlink.session-accepted.v1",
      protocol: "aether.cloudlink",
      message_kind: "session-accepted",
      gateway_id: acceptedGatewayId,
      selected_protocol_version: "1.0",
      session_id: sessionId,
      session_epoch: epoch,
      credential_generation: credentialGeneration,
      server_time_ms: unixMilliseconds(now),
      heartbeat_interval_ms: heartbeatIntervalMs,
      resume: serverResume,
    };
    const publication = this.#preparePublication(
      acceptedGatewayId,
      "session",
      accepted,
    );
    if (publication === undefined) {
      return {
        outcome: "discarded",
        failure: applicationFailure(result),
      };
    }
    try {
      await this.#dependencies.publisher.publish(
        publication.topic,
        publication.payload,
      );
    } catch {
      return { outcome: "deferred" };
    }
    return { outcome: "acknowledged" };
  }

  async #openSession(
    message: CloudLinkSessionHello,
  ): Promise<CloudLinkBridgeHandleResult> {
    if (message.credential_binding.origin_model === "gateway-signed") {
      return this.#acceptGatewaySignedSession(message);
    }
    const now = this.#dependencies.clock.now();
    let credential:
      | Readonly<{ credentialId: string; proof: string }>
      | undefined;
    const resolver = this.#dependencies.resolveTrustedConnectorCredential;
    if (resolver !== undefined) {
      try {
        credential = trustedConnectorCredential(
          await resolver.execute({
            gatewayId: message.gateway_id,
            credentialId: message.credential_binding.credential_id,
            credentialGeneration: message.credential_binding.generation,
          }),
          message.credential_binding.credential_id,
        );
      } catch {
        credential = undefined;
      }
    }
    if (credential === undefined) {
      return {
        outcome: "discarded",
        failure: {
          code: "authentication-evidence-missing",
          message:
            "CloudLink session origin requires verified authentication evidence",
        },
      };
    }
    const result = await this.#dependencies.openSession.execute(
      commandContext(now, sessionRequestId(message)),
      {
        credential,
        protocolVersions: message.offered_protocol_versions,
        clientPositions: message.resume.map((cursor) => ({
          streamId: cursor.stream_id,
          streamEpoch: cursor.stream_epoch,
          position: cursor.acknowledged_position,
        })),
      },
    );
    const value = successfulValue(result);
    const sessionId =
      value === undefined ? undefined : stringField(value, "sessionId");
    const epoch = value === undefined ? undefined : stringField(value, "epoch");
    const gatewayId =
      value === undefined ? undefined : stringField(value, "gatewayId");
    const tenantId =
      value === undefined ? undefined : stringField(value, "tenantId");
    const projectId =
      value === undefined ? undefined : stringField(value, "projectId");
    const credentialGeneration =
      value === undefined
        ? undefined
        : stringField(value, "credentialGeneration");
    const selectedProtocol =
      value === undefined ? undefined : stringField(value, "protocolVersion");
    const serverResume = value === undefined ? undefined : resumeCursors(value);
    if (
      sessionId === undefined ||
      epoch === undefined ||
      tenantId === undefined ||
      projectId === undefined ||
      gatewayId !== message.gateway_id ||
      credentialGeneration !== message.credential_binding.generation ||
      selectedProtocol !== "1.0" ||
      serverResume === undefined
    ) {
      return {
        outcome: "discarded",
        failure: applicationFailure(result),
      };
    }

    for (const [existingSessionId, assertion] of this.#sessions) {
      if (
        assertion.tenantId === tenantId &&
        assertion.projectId === projectId &&
        assertion.gatewayId === gatewayId
      ) {
        this.#sessions.delete(existingSessionId);
      }
    }

    const restored = await this.#restoreDeclaredRuntimeProtocols({
      tenantId,
      projectId,
      gatewayId,
      credentialGeneration,
      credential,
    });
    if (!restored.ok) return restored.result;

    const assertion: ActiveSessionAssertion = {
      tenantId,
      projectId,
      gatewayId,
      sessionId,
      epoch,
      credentialGeneration,
      originModel: "trusted-connector-broker-attestation",
      credential: {
        credentialId: credential.credentialId,
        proof: credential.proof,
      },
      declaredRuntimeProtocols: restored.value,
      integrationStreamBindings: new Map(),
    };
    this.#sessions.set(sessionId, assertion);
    const accepted: CloudLinkSessionAccepted = {
      schema: "aether.cloudlink.session-accepted.v1",
      protocol: "aether.cloudlink",
      message_kind: "session-accepted",
      gateway_id: gatewayId,
      selected_protocol_version: "1.0",
      session_id: sessionId,
      session_epoch: epoch,
      credential_generation: credentialGeneration,
      server_time_ms: unixMilliseconds(now),
      heartbeat_interval_ms: String(
        this.#dependencies.heartbeatIntervalMs ?? 30_000,
      ),
      resume: serverResume,
    };
    const publication = this.#preparePublication(
      gatewayId,
      "session",
      accepted,
    );
    if (publication === undefined) {
      return {
        outcome: "discarded",
        failure: applicationFailure(result),
      };
    }
    try {
      await this.#dependencies.publisher.publish(
        publication.topic,
        publication.payload,
      );
    } catch {
      return { outcome: "deferred" };
    }
    if (
      assertion.declaredRuntimeProtocols.has(
        "aether.cloudlink.integration-control.v1alpha1",
      )
    ) {
      return this.#reofferAndPublishIntegrationControls(assertion);
    }
    return { outcome: "acknowledged" };
  }

  async pumpIntegrationControl(
    rawScope: unknown,
    rawInput: unknown,
  ): Promise<CloudLinkBridgeHandleResult> {
    if (!controlEnabled(this.#dependencies)) {
      return {
        outcome: "discarded",
        failure: {
          code: "integration-control-disabled",
          message: "CloudLink Integration Control is disabled",
        },
      };
    }
    if (!isRecord(rawScope) || !isRecord(rawInput)) {
      return {
        outcome: "discarded",
        failure: {
          code: "invalid-integration-control-pump",
          message: "Integration Control pump scope is invalid",
        },
      };
    }
    if (
      !hasExactKeys(rawScope, ["projectId", "tenantId"]) ||
      !hasExactKeys(rawInput, ["gatewayId"])
    ) {
      return {
        outcome: "discarded",
        failure: {
          code: "invalid-integration-control-pump",
          message: "Integration Control pump fields are invalid",
        },
      };
    }
    const tenantId = stringField(rawScope, "tenantId");
    const projectId = stringField(rawScope, "projectId");
    const gatewayId = stringField(rawInput, "gatewayId");
    const assertion = [...this.#sessions.values()].find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.projectId === projectId &&
        candidate.gatewayId === gatewayId &&
        candidate.declaredRuntimeProtocols.has(
          "aether.cloudlink.integration-control.v1alpha1",
        ),
    );
    if (
      tenantId === undefined ||
      projectId === undefined ||
      gatewayId === undefined ||
      assertion === undefined
    ) {
      return { outcome: "rejected" };
    }
    return this.#publishIntegrationControls(
      { tenantId, projectId },
      { gatewayId },
    );
  }

  async #ingestIntegrationControlReceipt(
    event: Readonly<{ topic: string; payload: Uint8Array }>,
  ): Promise<CloudLinkBridgeHandleResult> {
    if (!controlEnabled(this.#dependencies)) {
      return {
        outcome: "discarded",
        failure: {
          code: "integration-control-disabled",
          message: "CloudLink Integration Control is disabled",
        },
      };
    }
    const decoded = decodeIntegrationControlActionReceipt(
      event.payload,
      this.#dependencies.maximumPayloadBytes,
    );
    if (!decoded.ok) {
      return {
        outcome: "discarded",
        failure: {
          code: decoded.failure.code,
          message: decoded.failure.message,
        },
      };
    }
    const message = decoded.value;
    if (
      event.topic !==
      mqttIntegrationControlReceiptTopic(
        this.#dependencies.topicPrefix,
        message.gateway_id,
      )
    ) {
      return {
        outcome: "discarded",
        failure: {
          code: "topic-payload-mismatch",
          message:
            "Integration Control receipt topic does not match its gateway identity",
        },
      };
    }
    const cachedAssertion = this.#sessions.get(message.session_id);
    let assertion: ActiveSessionAssertion;
    let gatewaySignedAuthentication:
      | GatewaySignedUplinkAuthentication
      | undefined;
    if (
      cachedAssertion?.originModel === "trusted-connector-broker-attestation"
    ) {
      if (!sessionMatches(message, cachedAssertion)) {
        return { outcome: "rejected" };
      }
      assertion = cachedAssertion;
    } else if (
      cachedAssertion === undefined &&
      this.#dependencies.authenticateGatewaySignedUplink === undefined
    ) {
      return { outcome: "rejected" };
    } else {
      const authenticated =
        await this.#authenticateGatewaySignedUplink(message);
      if (!authenticated.ok) return authenticated.result;
      gatewaySignedAuthentication = authenticated.value;
      assertion = authenticated.value.assertion;
    }
    if (
      !assertion.declaredRuntimeProtocols.has(
        "aether.cloudlink.integration.v1alpha1",
      ) ||
      !assertion.declaredRuntimeProtocols.has(
        "aether.cloudlink.integration-control.v1alpha1",
      )
    ) {
      return { outcome: "rejected" };
    }
    const now = this.#dependencies.clock.now();
    if (
      gatewaySignedAuthentication === undefined &&
      message.expires_at_ms !== undefined &&
      BigInt(unixMilliseconds(now)) >= BigInt(message.expires_at_ms)
    ) {
      return {
        outcome: "discarded",
        failure: {
          code: "message-expired",
          message: "CloudLink delivery expired before application handling",
        },
      };
    }
    const command = this.#dependencies.ingestIntegrationControlReceipt;
    if (command === undefined) {
      throw new Error(
        "Integration Control receipt dependency was not initialized",
      );
    }
    const requestId = `control-receipt:${createHash("sha256")
      .update(message.gateway_id)
      .update("\0")
      .update(message.delivery.stream_id)
      .update("\0")
      .update(message.delivery.stream_epoch)
      .update("\0")
      .update(message.delivery.position)
      .digest("hex")}`;
    const result = await command.execute(commandContext(now, requestId), {
      ...applicationAuthenticationInput(
        assertion,
        gatewaySignedAuthentication?.fact,
      ),
      sessionId: message.session_id,
      sessionEpoch: message.session_epoch,
      credentialGeneration: message.credential_generation,
      sentAtMs: message.sent_at_ms,
      ...(message.expires_at_ms === undefined
        ? {}
        : { expiresAtMs: message.expires_at_ms }),
      ...(message.traceparent === undefined
        ? {}
        : { traceparent: message.traceparent }),
      delivery: {
        streamId: message.delivery.stream_id,
        streamEpoch: message.delivery.stream_epoch,
        position: message.delivery.position,
        batchId: message.delivery.batch_id,
        digest: message.delivery.digest,
      },
      ...(gatewaySignedAuthentication === undefined
        ? {
            messageAuthentication: {
              keyId: message.message_authentication.key_id,
              algorithm: message.message_authentication.algorithm,
              signature: message.message_authentication.signature,
            },
          }
        : {}),
      receipt: {
        jobId: message.payload.job_id,
        receiptId: message.payload.receipt_id,
        receiptSequence: message.payload.receipt_sequence,
        capabilityId: message.payload.capability_id,
        target: {
          integrationId: message.payload.target.integration_id,
          snapshotGeneration: message.payload.target.snapshot_generation,
          entityId: message.payload.target.entity_id,
          pointKey: message.payload.target.point_key,
        },
        intentDigest: message.payload.intent_digest,
        stage: message.payload.stage,
        decision: message.payload.decision,
        physicalOutcome: message.payload.physical_outcome,
        observedAtMs: message.payload.observed_at_ms,
        ...(message.payload.evidence_digest === undefined
          ? {}
          : { evidenceDigest: message.payload.evidence_digest }),
        ...(message.payload.failure_code === undefined
          ? {}
          : { failureCode: message.payload.failure_code }),
        audit: {
          auditRecordId: message.payload.audit.audit_record_id,
          status: message.payload.audit.status,
        },
      },
    });
    if (applicationFailureCode(result) === "integration-delivery-gap") {
      return { outcome: "deferred" };
    }
    const value = successfulValue(result);
    if (
      value === undefined ||
      !hasExactKeys(value, [
        "auditEventId",
        "disposition",
        "durableAcknowledgement",
        "jobSucceeded",
        "physicalCompleted",
        "providerAccepted",
        "stage",
      ]) ||
      (value.disposition !== "persisted" && value.disposition !== "replayed") ||
      stringField(value, "auditEventId") === undefined ||
      value.physicalCompleted !== false ||
      value.jobSucceeded !== false ||
      typeof value.providerAccepted !== "boolean" ||
      !isRecord(value.durableAcknowledgement)
    ) {
      return { outcome: "rejected" };
    }
    const acknowledgement = this.#integrationControlDurableAck(
      message,
      assertion,
      value.durableAcknowledgement,
    );
    if (acknowledgement === undefined) {
      return { outcome: "rejected" };
    }
    await this.#publish(message.gateway_id, "ack", acknowledgement);
    return { outcome: "acknowledged" };
  }

  #integrationControlDurableAck(
    message: IntegrationControlWireActionReceipt,
    assertion: ActiveSessionAssertion,
    acknowledgement: JsonRecord,
  ): CloudLinkMqttOutbound | undefined {
    if (
      !hasExactKeys(acknowledgement, [
        "acknowledgedAt",
        "acknowledgedPosition",
        "batchId",
        "credentialGeneration",
        "digest",
        "gatewayId",
        "projectId",
        "receiptId",
        "sessionEpoch",
        "sessionId",
        "streamEpoch",
        "streamId",
        "tenantId",
      ])
    ) {
      return undefined;
    }
    const acknowledgedAt = stringField(acknowledgement, "acknowledgedAt");
    if (
      stringField(acknowledgement, "tenantId") !== assertion.tenantId ||
      stringField(acknowledgement, "projectId") !== assertion.projectId ||
      stringField(acknowledgement, "gatewayId") !== message.gateway_id ||
      stringField(acknowledgement, "sessionId") !== message.session_id ||
      stringField(acknowledgement, "sessionEpoch") !== message.session_epoch ||
      stringField(acknowledgement, "credentialGeneration") !==
        message.credential_generation ||
      stringField(acknowledgement, "streamId") !== message.delivery.stream_id ||
      stringField(acknowledgement, "streamEpoch") !==
        message.delivery.stream_epoch ||
      stringField(acknowledgement, "acknowledgedPosition") !==
        message.delivery.position ||
      stringField(acknowledgement, "batchId") !== message.delivery.batch_id ||
      stringField(acknowledgement, "digest") !== message.delivery.digest ||
      stringField(acknowledgement, "receiptId") === undefined ||
      acknowledgedAt === undefined
    ) {
      return undefined;
    }
    return {
      schema: "aether.cloudlink.durable-ack.v1",
      protocol: "aether.cloudlink",
      protocol_version: "1.0",
      message_kind: "durable-ack",
      gateway_id: message.gateway_id,
      session_id: message.session_id,
      session_epoch: message.session_epoch,
      credential_generation: message.credential_generation,
      stream_id: message.delivery.stream_id,
      stream_epoch: message.delivery.stream_epoch,
      acknowledged_position: message.delivery.position,
      batch_id: message.delivery.batch_id,
      digest: message.delivery.digest,
      receipt_id: stringField(acknowledgement, "receiptId") as string,
      acknowledged_at_ms: unixMilliseconds(acknowledgedAt),
    };
  }

  async #reofferAndPublishIntegrationControls(
    assertion: ActiveSessionAssertion,
  ): Promise<CloudLinkBridgeHandleResult> {
    if (
      !assertion.declaredRuntimeProtocols.has(
        "aether.cloudlink.integration.v1alpha1",
      ) ||
      !assertion.declaredRuntimeProtocols.has(
        "aether.cloudlink.integration-control.v1alpha1",
      )
    ) {
      return { outcome: "rejected" };
    }
    const command = this.#dependencies.reofferIntegrationControls;
    if (command === undefined) {
      throw new Error(
        "Integration Control reoffer dependency was not initialized",
      );
    }
    const scope = {
      tenantId: assertion.tenantId,
      projectId: assertion.projectId,
    };
    const input = { gatewayId: assertion.gatewayId };
    const result = await command.execute(scope, input);
    const value = successfulValue(result);
    if (
      value === undefined ||
      typeof value.staged !== "number" ||
      !Number.isSafeInteger(value.staged) ||
      value.staged < 0 ||
      typeof value.deferred !== "number" ||
      !Number.isSafeInteger(value.deferred) ||
      value.deferred < 0 ||
      !Array.isArray(value.offers)
    ) {
      return { outcome: "rejected" };
    }
    return this.#publishIntegrationControls(scope, input);
  }

  async #publishIntegrationControls(
    scope: Readonly<{ tenantId: string; projectId: string }>,
    input: Readonly<{ gatewayId: string }>,
  ): Promise<CloudLinkBridgeHandleResult> {
    const command = this.#dependencies.publishIntegrationControlOffers;
    if (command === undefined) {
      throw new Error(
        "Integration Control publisher dependency was not initialized",
      );
    }
    const result = await command.execute(scope, input);
    const value = successfulValue(result);
    if (
      value === undefined ||
      !hasExactKeys(value, ["deferred", "published"]) ||
      typeof value.published !== "number" ||
      !Number.isSafeInteger(value.published) ||
      value.published < 0 ||
      typeof value.deferred !== "number" ||
      !Number.isSafeInteger(value.deferred) ||
      value.deferred < 0
    ) {
      return { outcome: "rejected" };
    }
    if (value.published > 0) return { outcome: "acknowledged" };
    return value.deferred > 0
      ? { outcome: "deferred" }
      : { outcome: "acknowledged" };
  }

  async #heartbeat(
    message: CloudLinkHeartbeat & Readonly<{ message_kind: "heartbeat" }>,
    assertion: ActiveSessionAssertion,
    gatewaySignedAuthentication?: GatewaySignedUplinkAuthentication,
  ): Promise<CloudLinkBridgeHandleResult> {
    const now = this.#dependencies.clock.now();
    if (gatewaySignedAuthentication?.replayed !== true) {
      const result = await this.#dependencies.heartbeat.execute(
        commandContext(
          now,
          `heartbeat:${message.session_id}:${message.observed_at_ms}`,
        ),
        gatewaySignedAuthentication === undefined
          ? {
              credential: assertion.credential,
              sessionId: assertion.sessionId,
              sessionEpoch: assertion.epoch,
            }
          : {
              gatewaySignedAuthentication: gatewaySignedAuthentication.fact,
              observedAtMs: message.observed_at_ms,
            },
      );
      if (successfulValue(result) === undefined) {
        return { outcome: "rejected" };
      }
    }
    const response: CloudLinkHeartbeat &
      Readonly<{ message_kind: "heartbeat-ack" }> = {
      schema: "aether.cloudlink.heartbeat.v1",
      protocol: "aether.cloudlink",
      protocol_version: "1.0",
      message_kind: "heartbeat-ack",
      gateway_id: message.gateway_id,
      session_id: message.session_id,
      session_epoch: message.session_epoch,
      credential_generation: message.credential_generation,
      observed_at_ms: unixMilliseconds(now),
      cursors: [],
    };
    await this.#publish(message.gateway_id, "ack", response);
    return { outcome: "acknowledged" };
  }

  async #reportManifest(
    message: Extract<
      CloudLinkDeliveryEnvelope,
      { message_kind: "runtime-manifest-report" }
    >,
    assertion: ActiveSessionAssertion,
    gatewaySignedAuthentication?: JsonRecord,
  ): Promise<CloudLinkBridgeHandleResult> {
    const now = this.#dependencies.clock.now();
    const reportInput =
      gatewaySignedAuthentication === undefined
        ? {
            credential: assertion.credential,
            generation: message.delivery.position,
            observedAt: unixMillisecondsToInstant(
              message.payload.observed_at_ms,
            ),
            manifest: message.payload.manifest,
          }
        : {
            gatewaySignedAuthentication,
            cloudLinkDelivery: applicationCloudLinkBusinessDelivery(message),
            cloudLinkPayload: message.payload,
          };
    const result = await this.#dependencies.reportManifest.execute(
      commandContext(now, `cloudlink:${message.delivery.batch_id}`),
      reportInput,
    );
    if (successfulValue(result) === undefined) {
      return { outcome: "rejected" };
    }
    const protocols = runtimeProtocols(message.payload.manifest);
    if (protocols === undefined) {
      return { outcome: "rejected" };
    }
    const cursorCommand = this.#dependencies.recordDurableCursor;
    if (cursorCommand !== undefined) {
      const cursorResult = await cursorCommand.execute(
        commandContext(
          now,
          `cursor:${message.delivery.stream_id}:${message.delivery.stream_epoch}:${message.delivery.position}`,
        ),
        gatewaySignedAuthentication === undefined
          ? {
              credential: assertion.credential,
              sessionId: assertion.sessionId,
              sessionEpoch: assertion.epoch,
              streamId: message.delivery.stream_id,
              streamEpoch: message.delivery.stream_epoch,
              position: message.delivery.position,
            }
          : {
              gatewaySignedAuthentication,
              cloudLinkDelivery: applicationCloudLinkBusinessDelivery(message),
              cloudLinkPayload: message.payload,
            },
      );
      if (successfulValue(cursorResult) === undefined) {
        return { outcome: "rejected" };
      }
    }
    this.#sessions.set(assertion.sessionId, {
      ...assertion,
      declaredRuntimeProtocols: new Set(protocols),
    });
    await this.#publishDurableAck(
      message,
      `receipt:manifest:${message.delivery.batch_id}`,
    );
    return { outcome: "acknowledged" };
  }

  #integrationPreflight(
    message: Extract<
      CloudLinkDeliveryEnvelope,
      {
        message_kind:
          | "integration-observation-batch"
          | "integration-topology-snapshot";
      }
    >,
    assertion: ActiveSessionAssertion,
  ): CloudLinkBridgeHandleResult | undefined {
    if (
      !assertion.declaredRuntimeProtocols.has(
        "aether.cloudlink.integration.v1alpha1",
      )
    ) {
      return {
        outcome: "discarded",
        failure: {
          code: "integration-extension-not-declared",
          message:
            "The accepted Runtime Manifest does not declare the Integration extension",
        },
      };
    }
    const integrationId = stringField(message.payload, "integration_id");
    if (integrationId === undefined) {
      return {
        outcome: "discarded",
        failure: {
          code: "invalid-integration-payload",
          message: "Integration identity is missing",
        },
      };
    }
    const key = `${message.delivery.stream_id}\0${message.delivery.stream_epoch}`;
    const expected = `${message.message_kind}\0${integrationId}`;
    const current = assertion.integrationStreamBindings.get(key);
    if (current !== undefined && current !== expected) {
      return {
        outcome: "discarded",
        failure: {
          code: "integration-stream-binding-conflict",
          message:
            "Integration stream epoch is already bound to another message kind or Integration",
        },
      };
    }
    return undefined;
  }

  #recordIntegrationStreamBinding(
    message: Extract<
      CloudLinkDeliveryEnvelope,
      {
        message_kind:
          | "integration-observation-batch"
          | "integration-topology-snapshot";
      }
    >,
    assertion: ActiveSessionAssertion,
  ): void {
    const integrationId = stringField(message.payload, "integration_id");
    if (integrationId === undefined) return;
    const bindings = new Map(assertion.integrationStreamBindings);
    bindings.set(
      `${message.delivery.stream_id}\0${message.delivery.stream_epoch}`,
      `${message.message_kind}\0${integrationId}`,
    );
    this.#sessions.set(assertion.sessionId, {
      ...assertion,
      integrationStreamBindings: bindings,
    });
  }

  async #reportIntegrationTopology(
    message: Extract<
      CloudLinkDeliveryEnvelope,
      { message_kind: "integration-topology-snapshot" }
    >,
    assertion: ActiveSessionAssertion,
    gatewaySignedAuthentication?: JsonRecord,
  ): Promise<CloudLinkBridgeHandleResult> {
    const preflight = this.#integrationPreflight(message, assertion);
    if (preflight !== undefined) return preflight;
    const command = this.#dependencies.reportIntegrationTopology;
    if (command === undefined) {
      return {
        outcome: "discarded",
        failure: {
          code: "integration-application-port-unavailable",
          message: "Integration topology reporting is not configured",
        },
      };
    }
    let topology;
    try {
      topology = decodeIntegrationTopologyPayload(
        new TextEncoder().encode(JSON.stringify(message.payload)),
        { maxBytes: 256 * 1024 },
      );
    } catch {
      return {
        outcome: "discarded",
        failure: {
          code: "invalid-integration-payload",
          message: "Integration topology payload is invalid",
        },
      };
    }
    const now = this.#dependencies.clock.now();
    const requestId = `cloudlink:${deliveryIdentityDigest(message)}`;
    const result = await command.execute(
      commandContext(now, requestId),
      gatewaySignedAuthentication === undefined
        ? {
            credential: assertion.credential,
            ...topology,
            cloudLinkDelivery: applicationCloudLinkBusinessDelivery(message),
          }
        : {
            gatewaySignedAuthentication,
            cloudLinkDelivery: applicationCloudLinkBusinessDelivery(message),
            cloudLinkPayload: message.payload,
          },
    );
    if (applicationFailureCode(result) === "integration-delivery-gap") {
      return { outcome: "deferred" };
    }
    const value = successfulValue(result);
    if (value === undefined) return { outcome: "rejected" };
    const acknowledgement =
      value.durableAcknowledgement === undefined
        ? undefined
        : isRecord(value.durableAcknowledgement)
          ? this.#persistedDurableAck(message, value.durableAcknowledgement)
          : undefined;
    if (
      value.durableAcknowledgement !== undefined &&
      acknowledgement === undefined
    ) {
      return { outcome: "rejected" };
    }
    if (
      integrationReceiptId(
        result,
        message,
        requestId,
        acknowledgement !== undefined,
      ) === undefined
    ) {
      return { outcome: "rejected" };
    }
    this.#recordIntegrationStreamBinding(message, assertion);
    if (acknowledgement === undefined) return { outcome: "deferred" };
    await this.#publish(message.gateway_id, "ack", acknowledgement);
    return { outcome: "acknowledged" };
  }

  async #reportIntegrationObservations(
    message: Extract<
      CloudLinkDeliveryEnvelope,
      { message_kind: "integration-observation-batch" }
    >,
    assertion: ActiveSessionAssertion,
    gatewaySignedAuthentication?: JsonRecord,
  ): Promise<CloudLinkBridgeHandleResult> {
    const preflight = this.#integrationPreflight(message, assertion);
    if (preflight !== undefined) return preflight;
    const command = this.#dependencies.reportIntegrationObservations;
    if (command === undefined) {
      return {
        outcome: "discarded",
        failure: {
          code: "integration-application-port-unavailable",
          message: "Integration observation reporting is not configured",
        },
      };
    }
    let batch;
    try {
      batch = decodeIntegrationObservationPayloadInput(
        new TextEncoder().encode(JSON.stringify(message.payload)),
        { maxBytes: 256 * 1024 },
      );
    } catch {
      return {
        outcome: "discarded",
        failure: {
          code: "invalid-integration-payload",
          message: "Integration observation payload is invalid",
        },
      };
    }
    const now = this.#dependencies.clock.now();
    const requestId = `cloudlink:${deliveryIdentityDigest(message)}`;
    const result = await command.execute(
      commandContext(now, requestId),
      gatewaySignedAuthentication === undefined
        ? {
            credential: assertion.credential,
            ...batch,
            cloudLinkDelivery: applicationCloudLinkBusinessDelivery(message),
          }
        : {
            gatewaySignedAuthentication,
            cloudLinkDelivery: applicationCloudLinkBusinessDelivery(message),
            cloudLinkPayload: message.payload,
          },
    );
    if (applicationFailureCode(result) === "integration-delivery-gap") {
      return { outcome: "deferred" };
    }
    const value = successfulValue(result);
    if (value === undefined) return { outcome: "rejected" };
    const acknowledgement =
      value.durableAcknowledgement === undefined
        ? undefined
        : isRecord(value.durableAcknowledgement)
          ? this.#persistedDurableAck(message, value.durableAcknowledgement)
          : undefined;
    if (
      value.durableAcknowledgement !== undefined &&
      acknowledgement === undefined
    ) {
      return { outcome: "rejected" };
    }
    if (
      integrationReceiptId(
        result,
        message,
        requestId,
        acknowledgement !== undefined,
      ) === undefined
    ) {
      return { outcome: "rejected" };
    }
    this.#recordIntegrationStreamBinding(message, assertion);
    if (acknowledgement === undefined) return { outcome: "deferred" };
    await this.#publish(message.gateway_id, "ack", acknowledgement);
    return { outcome: "acknowledged" };
  }

  async #ingestTelemetry(
    message: Extract<
      CloudLinkDeliveryEnvelope,
      { message_kind: "telemetry-batch" }
    >,
    assertion: ActiveSessionAssertion,
    gatewaySignedAuthentication?: JsonRecord,
  ): Promise<CloudLinkBridgeHandleResult> {
    // Cloud's current application port models one global position per point,
    // while the frozen wire assigns one atomic position per batch. Accepting a
    // multi-sample batch here would invent or overlap positions.
    if (message.payload.samples.length !== 1) {
      return {
        outcome: "discarded",
        failure: {
          code: "cloud-telemetry-position-model-pending",
          message:
            "Cloud telemetry application indexing is not aligned for multi-sample CloudLink batches",
        },
      };
    }
    const now = this.#dependencies.clock.now();
    const telemetryInput =
      gatewaySignedAuthentication === undefined
        ? {
            credential: assertion.credential,
            streamId: message.delivery.stream_id,
            streamEpoch: message.delivery.stream_epoch,
            topology: {
              publicationEpoch: message.payload.topology.publication_epoch,
              snapshotDigest: message.payload.topology.snapshot_digest,
            },
            retentionClass: this.#dependencies.retentionClass ?? "standard-30d",
            replay: false,
            durableAcknowledgement: {
              sessionId: message.session_id,
              sessionEpoch: message.session_epoch,
              credentialGeneration: message.credential_generation,
              streamId: message.delivery.stream_id,
              streamEpoch: message.delivery.stream_epoch,
              acknowledgedPosition: message.delivery.position,
              acceptedTelemetryPosition: (
                BigInt(message.delivery.position) - 1n
              ).toString(),
              batchId: message.delivery.batch_id,
              digest: message.delivery.digest,
            },
            records: [
              pointRecord(
                message.payload.samples[0] as CloudLinkPointFact,
                message.delivery.position,
              ),
            ],
          }
        : {
            gatewaySignedAuthentication,
            cloudLinkDelivery: applicationCloudLinkBusinessDelivery(message),
            cloudLinkPayload: message.payload,
            retentionClass: this.#dependencies.retentionClass ?? "standard-30d",
          };
    const result = await this.#dependencies.ingestTelemetry.execute(
      commandContext(now, `cloudlink:${message.delivery.batch_id}`),
      telemetryInput,
    );
    const value = successfulValue(result);
    if (
      value === undefined ||
      value.durablyAcknowledged !== true ||
      !isRecord(value.receipt)
    ) {
      return { outcome: "rejected" };
    }
    if (stringField(value.receipt, "receiptId") === undefined) {
      return { outcome: "rejected" };
    }
    if (isRecord(value.receipt.gap)) {
      // The fact may be retained for investigation, but a cumulative ACK would
      // silently skip the missing range. Edge must retain its cursor until an
      // explicit replay or data-loss decision closes that gap.
      return { outcome: "rejected" };
    }
    if (isRecord(value.durableAcknowledgement)) {
      const persistedAck = this.#persistedDurableAck(
        message,
        value.durableAcknowledgement,
      );
      if (persistedAck === undefined) return { outcome: "rejected" };
      await this.#publish(message.gateway_id, "ack", persistedAck);
      return { outcome: "acknowledged" };
    }
    await this.#publishDurableAck(
      message,
      `receipt:cloudlink:${message.delivery.batch_id}`,
    );
    return { outcome: "acknowledged" };
  }

  #persistedDurableAck(
    message: CloudLinkDeliveryEnvelope,
    acknowledgement: JsonRecord,
  ): CloudLinkMqttOutbound | undefined {
    const gatewayId = stringField(acknowledgement, "gatewayId");
    const sessionId = stringField(acknowledgement, "sessionId");
    const sessionEpoch = stringField(acknowledgement, "sessionEpoch");
    const credentialGeneration = stringField(
      acknowledgement,
      "credentialGeneration",
    );
    const streamId = stringField(acknowledgement, "streamId");
    const streamEpoch = stringField(acknowledgement, "streamEpoch");
    const acknowledgedPosition = stringField(
      acknowledgement,
      "acknowledgedPosition",
    );
    const batchId = stringField(acknowledgement, "batchId");
    const digest = stringField(acknowledgement, "digest");
    const receiptId = stringField(acknowledgement, "receiptId");
    const acknowledgedAt = stringField(acknowledgement, "acknowledgedAt");
    if (
      stringField(acknowledgement, "outboxEventId") === undefined ||
      stringField(acknowledgement, "tenantId") === undefined ||
      stringField(acknowledgement, "projectId") === undefined ||
      gatewayId !== message.gateway_id ||
      sessionId !== message.session_id ||
      sessionEpoch !== message.session_epoch ||
      credentialGeneration !== message.credential_generation ||
      streamId !== message.delivery.stream_id ||
      streamEpoch !== message.delivery.stream_epoch ||
      acknowledgedPosition === undefined ||
      batchId === undefined ||
      digest === undefined ||
      acknowledgedPosition !== message.delivery.position ||
      batchId !== message.delivery.batch_id ||
      digest !== message.delivery.digest ||
      receiptId === undefined ||
      acknowledgedAt === undefined
    ) {
      return undefined;
    }
    if (
      "integration_id" in message.payload &&
      (stringField(acknowledgement, "integrationId") !==
        stringField(message.payload, "integration_id") ||
        acknowledgement.messageKind !== message.message_kind)
    ) {
      return undefined;
    }
    return {
      schema: "aether.cloudlink.durable-ack.v1",
      protocol: "aether.cloudlink",
      protocol_version: "1.0",
      message_kind: "durable-ack",
      gateway_id: gatewayId,
      session_id: sessionId,
      session_epoch: sessionEpoch,
      credential_generation: credentialGeneration,
      stream_id: streamId,
      stream_epoch: streamEpoch,
      acknowledged_position: acknowledgedPosition,
      batch_id: batchId,
      digest,
      receipt_id: receiptId,
      acknowledged_at_ms: unixMilliseconds(acknowledgedAt),
    };
  }

  async #recordDataLoss(
    message: Extract<CloudLinkDeliveryEnvelope, { message_kind: "data-loss" }>,
    assertion: ActiveSessionAssertion,
    gatewaySignedAuthentication?: JsonRecord,
  ): Promise<CloudLinkBridgeHandleResult> {
    const command = this.#dependencies.recordDataLoss;
    if (command === undefined) {
      return {
        outcome: "discarded",
        failure: {
          code: "cloud-data-loss-application-port-pending",
          message: "Cloud data-loss persistence is not implemented",
        },
      };
    }
    const now = this.#dependencies.clock.now();
    const result = await command.execute(
      commandContext(now, `cloudlink:${message.delivery.batch_id}`),
      {
        ...applicationAuthenticationInput(
          assertion,
          gatewaySignedAuthentication,
        ),
        ...message.payload,
      },
    );
    if (successfulValue(result) === undefined) {
      return { outcome: "rejected" };
    }
    await this.#publishDurableAck(
      message,
      `receipt:data-loss:${message.delivery.batch_id}`,
    );
    return { outcome: "acknowledged" };
  }

  #publishDurableAck(
    message: CloudLinkDeliveryEnvelope,
    receiptId: string,
  ): Promise<void> {
    const ack: CloudLinkMqttOutbound = {
      schema: "aether.cloudlink.durable-ack.v1",
      protocol: "aether.cloudlink",
      protocol_version: "1.0",
      message_kind: "durable-ack",
      gateway_id: message.gateway_id,
      session_id: message.session_id,
      session_epoch: message.session_epoch,
      credential_generation: message.credential_generation,
      stream_id: message.delivery.stream_id,
      stream_epoch: message.delivery.stream_epoch,
      acknowledged_position: message.delivery.position,
      batch_id: message.delivery.batch_id,
      digest: message.delivery.digest,
      receipt_id: receiptId,
      acknowledged_at_ms: unixMilliseconds(this.#dependencies.clock.now()),
    };
    return this.#publish(message.gateway_id, "ack", ack);
  }

  #publish(
    gatewayId: string,
    channel: "ack" | "replay" | "session",
    message: CloudLinkMqttOutbound,
  ): Promise<void> {
    const publication = this.#preparePublication(gatewayId, channel, message);
    if (publication === undefined) {
      throw new TypeError("CloudLink outbound projection is invalid");
    }
    return this.#dependencies.publisher.publish(
      publication.topic,
      publication.payload,
    );
  }

  #preparePublication(
    gatewayId: string,
    channel: "ack" | "replay" | "session",
    message: CloudLinkMqttOutbound,
  ): Readonly<{ topic: string; payload: Uint8Array }> | undefined {
    try {
      return {
        topic: mqttDownlinkTopic(
          this.#dependencies.topicPrefix,
          gatewayId,
          channel,
        ),
        payload: encodeCloudLinkMqttOutbound(message),
      };
    } catch {
      return undefined;
    }
  }
}
