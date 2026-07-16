import {
  decodeCloudLinkMqttInbound,
  encodeCloudLinkMqttOutbound,
  mqttDownlinkTopic,
  type CloudLinkDeliveryEnvelope,
  type CloudLinkHeartbeat,
  type CloudLinkMqttOutbound,
  type CloudLinkPointFact,
  type CloudLinkSessionAccepted,
  type CloudLinkSessionHello,
} from "@aether-cloud/cloudlink-mqtt-adapter";

type JsonRecord = Record<string, unknown>;

export interface CloudLinkApplicationCommand {
  execute(context: unknown, input: unknown): Promise<unknown>;
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
  readonly openSession: CloudLinkApplicationCommand;
  readonly heartbeat: CloudLinkApplicationCommand;
  readonly reportManifest: CloudLinkApplicationCommand;
  readonly ingestTelemetry: CloudLinkApplicationCommand;
  readonly recordDurableCursor?: CloudLinkApplicationCommand;
  readonly recordDataLoss?: CloudLinkApplicationCommand;
  readonly clock: CloudLinkBridgeClock;
  readonly heartbeatIntervalMs?: number;
  readonly retentionClass?: "archive-365d" | "hot-7d" | "standard-30d";
  readonly maximumPayloadBytes?: number;
}

export type CloudLinkBridgeHandleResult =
  | Readonly<{ outcome: "acknowledged" }>
  | Readonly<{ outcome: "rejected" }>
  | Readonly<{
      outcome: "discarded";
      failure: Readonly<{ code: string; message: string }>;
    }>;

interface ActiveSessionAssertion {
  readonly gatewayId: string;
  readonly sessionId: string;
  readonly epoch: string;
  readonly credentialGeneration: string;
  readonly credential: Readonly<{ credentialId: string; proof: string }>;
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

const positiveUint64Pattern = /^[1-9][0-9]*$/;
const maximumUint64 = 18_446_744_073_709_551_615n;
const streamIdPattern = /^[a-z][a-z0-9.-]{0,63}$/;

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

function sessionMatches(
  message: Exclude<
    CloudLinkDeliveryEnvelope | CloudLinkHeartbeat,
    CloudLinkSessionHello
  >,
  assertion: ActiveSessionAssertion,
): boolean {
  return (
    assertion.gatewayId === message.gateway_id &&
    assertion.sessionId === message.session_id &&
    assertion.epoch === message.session_epoch &&
    assertion.credentialGeneration === message.credential_generation
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

export class CloudLinkMqttApplicationBridge {
  readonly #dependencies: CloudLinkBridgeDependencies;
  readonly #sessions = new Map<string, ActiveSessionAssertion>();

  constructor(dependencies: CloudLinkBridgeDependencies) {
    this.#dependencies = dependencies;
  }

  async handle(
    event: Readonly<{ topic: string; payload: Uint8Array }>,
  ): Promise<CloudLinkBridgeHandleResult> {
    const decoded = decodeCloudLinkMqttInbound(event.topic, event.payload, {
      topicPrefix: this.#dependencies.topicPrefix,
      ...(this.#dependencies.maximumPayloadBytes === undefined
        ? {}
        : { maximumPayloadBytes: this.#dependencies.maximumPayloadBytes }),
    });
    if (!decoded.ok) {
      return { outcome: "discarded", failure: decoded.failure };
    }

    const message = decoded.value;
    if (message.message_kind === "session-hello") {
      return this.#openSession(message);
    }

    const assertion = this.#sessions.get(message.session_id);
    if (assertion === undefined || !sessionMatches(message, assertion)) {
      return { outcome: "rejected" };
    }

    if (
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
        return this.#heartbeat(message, assertion);
      case "runtime-manifest-report":
        return this.#reportManifest(message, assertion);
      case "telemetry-batch":
        return this.#ingestTelemetry(message, assertion);
      case "data-loss":
        return this.#recordDataLoss(message, assertion);
    }
  }

  async #openSession(
    message: CloudLinkSessionHello,
  ): Promise<CloudLinkBridgeHandleResult> {
    const now = this.#dependencies.clock.now();
    const proof = message.gateway_signature?.signature;
    if (
      message.credential_binding.origin_model !== "gateway-signed" ||
      proof === undefined
    ) {
      return {
        outcome: "discarded",
        failure: {
          code: "authentication-evidence-missing",
          message:
            "Trusted-connector origin requires verified external ingress metadata",
        },
      };
    }
    const result = await this.#dependencies.openSession.execute(
      commandContext(now, message.client_nonce),
      {
        credential: {
          credentialId: message.credential_binding.credential_id,
          proof,
        },
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
      if (assertion.gatewayId === gatewayId) {
        this.#sessions.delete(existingSessionId);
      }
    }
    const assertion: ActiveSessionAssertion = {
      gatewayId,
      sessionId,
      epoch,
      credentialGeneration,
      credential: {
        credentialId: message.credential_binding.credential_id,
        proof,
      },
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
    await this.#publish(gatewayId, "session", accepted);
    return { outcome: "acknowledged" };
  }

  async #heartbeat(
    message: CloudLinkHeartbeat & Readonly<{ message_kind: "heartbeat" }>,
    assertion: ActiveSessionAssertion,
  ): Promise<CloudLinkBridgeHandleResult> {
    const now = this.#dependencies.clock.now();
    const result = await this.#dependencies.heartbeat.execute(
      commandContext(
        now,
        `heartbeat:${message.session_id}:${message.observed_at_ms}`,
      ),
      {
        credential: assertion.credential,
        sessionId: assertion.sessionId,
        sessionEpoch: assertion.epoch,
      },
    );
    if (successfulValue(result) === undefined) {
      return { outcome: "rejected" };
    }
    const response: CloudLinkHeartbeat &
      Readonly<{ message_kind: "heartbeat-ack" }> = {
      ...message,
      message_kind: "heartbeat-ack",
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
  ): Promise<CloudLinkBridgeHandleResult> {
    const now = this.#dependencies.clock.now();
    const result = await this.#dependencies.reportManifest.execute(
      commandContext(now, `cloudlink:${message.delivery.batch_id}`),
      {
        credential: assertion.credential,
        generation: message.delivery.position,
        observedAt: unixMillisecondsToInstant(message.payload.observed_at_ms),
        manifest: message.payload.manifest,
      },
    );
    if (successfulValue(result) === undefined) {
      return { outcome: "rejected" };
    }
    const cursorCommand = this.#dependencies.recordDurableCursor;
    if (cursorCommand !== undefined) {
      const cursorResult = await cursorCommand.execute(
        commandContext(
          now,
          `cursor:${message.delivery.stream_id}:${message.delivery.stream_epoch}:${message.delivery.position}`,
        ),
        {
          credential: assertion.credential,
          sessionId: assertion.sessionId,
          sessionEpoch: assertion.epoch,
          streamId: message.delivery.stream_id,
          streamEpoch: message.delivery.stream_epoch,
          position: message.delivery.position,
        },
      );
      if (successfulValue(cursorResult) === undefined) {
        return { outcome: "rejected" };
      }
    }
    await this.#publishDurableAck(
      message,
      `receipt:manifest:${message.delivery.batch_id}`,
    );
    return { outcome: "acknowledged" };
  }

  async #ingestTelemetry(
    message: Extract<
      CloudLinkDeliveryEnvelope,
      { message_kind: "telemetry-batch" }
    >,
    assertion: ActiveSessionAssertion,
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
    const result = await this.#dependencies.ingestTelemetry.execute(
      commandContext(now, `cloudlink:${message.delivery.batch_id}`),
      {
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
      },
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
      acknowledgedPosition !== message.delivery.position ||
      batchId !== message.delivery.batch_id ||
      digest !== message.delivery.digest ||
      receiptId === undefined ||
      acknowledgedAt === undefined
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
      { credential: assertion.credential, ...message.payload },
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
    return this.#dependencies.publisher.publish(
      mqttDownlinkTopic(this.#dependencies.topicPrefix, gatewayId, channel),
      encodeCloudLinkMqttOutbound(message),
    );
  }
}
