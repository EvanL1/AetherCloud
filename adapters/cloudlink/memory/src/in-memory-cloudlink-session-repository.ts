import type {
  AcceptCloudLinkSessionChallengeRepositoryInput,
  AcceptCloudLinkSessionChallengeRepositoryResult,
  CloudLinkSessionChallengeRecord,
  CloudLinkSessionChallengeRepository,
  CloudLinkSessionReplaceResult,
  CloudLinkSessionRepository,
  CloudLinkSessionScope,
  CloudLinkUplinkAuthenticationRepository,
  CloudLinkUplinkAuthenticationRepositoryResult,
  IntegrationCloudLinkSessionFence,
  IntegrationCloudLinkSessionFenceVerifier,
  AcceptCloudLinkHeartbeatAuthenticationInput,
  IssueCloudLinkSessionChallengeRepositoryInput,
  IssueCloudLinkSessionChallengeRepositoryResult,
  OpenCloudLinkSessionRepositoryInput,
  OpenCloudLinkSessionRepositoryResult,
  RecordCloudLinkDurableCursorRepositoryInput,
  RecordCloudLinkDurableCursorRepositoryResult,
} from "@aether-cloud/application";
import {
  activateCloudLinkSession,
  createCloudLinkSession,
  fenceCloudLinkSession,
  negotiateCloudLinkSession,
  parseCloudLinkSessionEpoch,
} from "@aether-cloud/domain";
import type {
  CloudLinkSession,
  CloudLinkSessionChallengeId,
  CloudLinkSessionId,
  GatewayCredentialBinding,
  GatewayId,
  ProtocolVersion,
  StreamEpoch,
  StreamId,
  StreamPosition,
} from "@aether-cloud/domain";

interface StoredOpenRequest {
  readonly binding: GatewayCredentialBinding;
  readonly protocolVersion: ProtocolVersion;
  readonly sessionId: CloudLinkSessionId;
}

interface StoredChallenge {
  readonly record: CloudLinkSessionChallengeRecord;
  consumption?: Readonly<{
    authenticationFingerprint: string;
    sessionId: CloudLinkSessionId;
  }>;
}

interface ChallengeRequestWindow {
  readonly startedAtMs: bigint;
  readonly count: number;
}

type StoredCursor = Readonly<{
  streamId: StreamId;
  streamEpoch: StreamEpoch;
  position: StreamPosition;
}>;

function gatewayKey(
  scope: CloudLinkSessionScope,
  gatewayId: GatewayId,
): string {
  return `${scope.tenantId}:${scope.projectId}:${gatewayId}`;
}

function sessionKey(sessionId: CloudLinkSessionId): string {
  return sessionId;
}

function openRequestKey(input: OpenCloudLinkSessionRepositoryInput): string {
  return `${gatewayKey(input.binding, input.binding.gatewayId)}:${input.requestId}`;
}

function sameOpenRequest(
  stored: StoredOpenRequest,
  input: OpenCloudLinkSessionRepositoryInput,
): boolean {
  return (
    stored.binding.tenantId === input.binding.tenantId &&
    stored.binding.projectId === input.binding.projectId &&
    stored.binding.gatewayId === input.binding.gatewayId &&
    stored.binding.generation === input.binding.generation &&
    stored.protocolVersion === input.protocolVersion
  );
}

function sameBinding(
  left: GatewayCredentialBinding,
  right: GatewayCredentialBinding,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.gatewayId === right.gatewayId &&
    left.generation === right.generation
  );
}

function sameChallengeRequest(
  left: CloudLinkSessionChallengeRecord["request"],
  right: CloudLinkSessionChallengeRecord["request"],
): boolean {
  return (
    left.gatewayId === right.gatewayId &&
    left.credentialId === right.credentialId &&
    left.credentialGeneration === right.credentialGeneration &&
    left.clientNonce === right.clientNonce &&
    left.offeredProtocolVersions.length ===
      right.offeredProtocolVersions.length &&
    left.offeredProtocolVersions.every(
      (version, index) => version === right.offeredProtocolVersions[index],
    ) &&
    left.resumeCursors.length === right.resumeCursors.length &&
    left.resumeCursors.every(
      (cursor, index) =>
        cursor.streamId === right.resumeCursors[index]?.streamId &&
        cursor.streamEpoch === right.resumeCursors[index].streamEpoch &&
        cursor.position === right.resumeCursors[index].position,
    )
  );
}

function freezeChallenge(
  input: CloudLinkSessionChallengeRecord,
): CloudLinkSessionChallengeRecord {
  return Object.freeze({
    binding: Object.freeze({ ...input.binding }),
    request: Object.freeze({
      ...input.request,
      offeredProtocolVersions: Object.freeze([
        ...input.request.offeredProtocolVersions,
      ]),
      resumeCursors: Object.freeze(
        input.request.resumeCursors.map((cursor) =>
          Object.freeze({ ...cursor }),
        ),
      ),
    }),
    challengeId: input.challengeId,
    cloudNonce: input.cloudNonce,
    issuedAtMs: input.issuedAtMs,
    expiresAtMs: input.expiresAtMs,
    cloudAuthentication: Object.freeze({ ...input.cloudAuthentication }),
  });
}

function challengeGatewayKey(
  challenge: CloudLinkSessionChallengeRecord,
): string {
  return gatewayKey(challenge.binding, challenge.binding.gatewayId);
}

export class InMemoryCloudLinkSessionRepository
  implements
    CloudLinkSessionRepository,
    CloudLinkSessionChallengeRepository,
    CloudLinkUplinkAuthenticationRepository,
    IntegrationCloudLinkSessionFenceVerifier
{
  readonly #sessions = new Map<string, CloudLinkSession>();
  readonly #currentSessions = new Map<string, CloudLinkSessionId>();
  readonly #nextEpochs = new Map<string, bigint>();
  readonly #openRequests = new Map<string, StoredOpenRequest>();
  readonly #durableCursors = new Map<string, Map<string, StoredCursor>>();
  readonly #challenges = new Map<string, StoredChallenge>();
  readonly #currentChallenges = new Map<string, CloudLinkSessionChallengeId>();
  readonly #challengeRequestWindows = new Map<string, ChallengeRequestWindow>();
  readonly #heartbeatAuthentication = new Map<
    string,
    Readonly<{
      highestObservedAtMs: string;
      exactSigningObjectDigest: string;
    }>
  >();

  issue(
    input: IssueCloudLinkSessionChallengeRepositoryInput,
  ): Promise<IssueCloudLinkSessionChallengeRepositoryResult> {
    const evaluationTime = BigInt(input.evaluationTimeMs);
    const key = challengeGatewayKey(input.candidate);
    const configuredWindow = BigInt(input.rateLimitWindowMs);
    const previousWindow = this.#challengeRequestWindows.get(key);
    const currentWindow =
      previousWindow === undefined ||
      evaluationTime >= previousWindow.startedAtMs + configuredWindow
        ? { startedAtMs: evaluationTime, count: 0 }
        : previousWindow;
    if (currentWindow.count >= input.rateLimitMaximumRequests) {
      return Promise.resolve({ outcome: "rate-limited" });
    }
    this.#challengeRequestWindows.set(key, {
      startedAtMs: currentWindow.startedAtMs,
      count: currentWindow.count + 1,
    });

    const currentId = this.#currentChallenges.get(key);
    const current =
      currentId === undefined ? undefined : this.#challenges.get(currentId);
    if (
      current !== undefined &&
      evaluationTime < BigInt(current.record.expiresAtMs)
    ) {
      if (
        sameChallengeRequest(current.record.request, input.candidate.request)
      ) {
        return Promise.resolve({
          outcome: "replayed",
          challenge: current.record,
        });
      }
      if (current.consumption === undefined) {
        return Promise.resolve({ outcome: "request-conflict" });
      }
    }
    if (this.#challenges.has(input.candidate.challengeId)) {
      return Promise.resolve({ outcome: "request-conflict" });
    }
    const record = freezeChallenge(input.candidate);
    this.#challenges.set(record.challengeId, { record });
    this.#currentChallenges.set(key, record.challengeId);
    return Promise.resolve({ outcome: "issued", challenge: record });
  }

  find(
    binding: GatewayCredentialBinding,
    challengeId: CloudLinkSessionChallengeId,
  ): Promise<CloudLinkSessionChallengeRecord | undefined> {
    const stored = this.#challenges.get(challengeId);
    return Promise.resolve(
      stored !== undefined && sameBinding(stored.record.binding, binding)
        ? stored.record
        : undefined,
    );
  }

  acceptAndOpen(
    input: AcceptCloudLinkSessionChallengeRepositoryInput,
  ): Promise<AcceptCloudLinkSessionChallengeRepositoryResult> {
    const stored = this.#challenges.get(input.challengeId);
    if (stored === undefined) return Promise.resolve({ outcome: "not-found" });
    if (!sameBinding(stored.record.binding, input.binding)) {
      return Promise.resolve({ outcome: "binding-conflict" });
    }
    if (BigInt(input.evaluationTimeMs) >= BigInt(stored.record.expiresAtMs)) {
      return Promise.resolve({ outcome: "expired" });
    }
    if (stored.consumption !== undefined) {
      const session = this.#sessions.get(stored.consumption.sessionId);
      if (
        stored.consumption.authenticationFingerprint !==
          input.authenticationFingerprint ||
        session === undefined
      ) {
        return Promise.resolve({ outcome: "consumed-conflict" });
      }
      return Promise.resolve({ outcome: "replayed", session });
    }

    const key = gatewayKey(input.binding, input.binding.gatewayId);
    const currentSessionId = this.#currentSessions.get(key);
    let fencedSessionId: CloudLinkSessionId | undefined;
    if (currentSessionId !== undefined) {
      const current = this.#sessions.get(sessionKey(currentSessionId));
      if (current !== undefined && current.state !== "closed") {
        const fenced = fenceCloudLinkSession(current, input.openedAt);
        if (!fenced.ok) {
          return Promise.resolve({ outcome: "binding-conflict" });
        }
        this.#sessions.set(sessionKey(currentSessionId), fenced.value);
        fencedSessionId = currentSessionId;
      }
    }

    const nextEpoch = (this.#nextEpochs.get(key) ?? 0n) + 1n;
    const negotiating = createCloudLinkSession({
      tenantId: input.binding.tenantId,
      projectId: input.binding.projectId,
      gatewayId: input.binding.gatewayId,
      sessionId: input.sessionId,
      credentialGeneration: input.binding.generation,
      epoch: parseCloudLinkSessionEpoch(nextEpoch.toString()),
      openedAt: input.openedAt,
      gatewayKeyId: input.gatewayKeyId,
      heartbeatIntervalMs: input.heartbeatIntervalMs,
    });
    const negotiated = negotiateCloudLinkSession(
      negotiating,
      input.protocolVersion,
    );
    if (!negotiated.ok) {
      return Promise.resolve({ outcome: "binding-conflict" });
    }
    const cursors = [...(this.#durableCursors.get(key)?.values() ?? [])].sort(
      (left, right) => {
        const streamOrder = left.streamId.localeCompare(right.streamId);
        if (streamOrder !== 0) return streamOrder;
        if (BigInt(left.streamEpoch) < BigInt(right.streamEpoch)) return -1;
        if (BigInt(left.streamEpoch) > BigInt(right.streamEpoch)) return 1;
        return 0;
      },
    );
    const activated = activateCloudLinkSession(negotiated.value, {
      activatedAt: input.openedAt,
      resumeCursors: cursors,
    });
    if (!activated.ok) {
      return Promise.resolve({ outcome: "binding-conflict" });
    }
    this.#nextEpochs.set(key, nextEpoch);
    this.#sessions.set(sessionKey(input.sessionId), activated.value);
    this.#currentSessions.set(key, input.sessionId);
    stored.consumption = Object.freeze({
      authenticationFingerprint: input.authenticationFingerprint,
      sessionId: input.sessionId,
    });
    return Promise.resolve({
      outcome: "opened",
      session: activated.value,
      ...(fencedSessionId === undefined ? {} : { fencedSessionId }),
    });
  }

  open(
    input: OpenCloudLinkSessionRepositoryInput,
  ): Promise<OpenCloudLinkSessionRepositoryResult> {
    const requestKey = openRequestKey(input);
    const priorRequest = this.#openRequests.get(requestKey);
    if (priorRequest !== undefined) {
      const priorSession = this.#sessions.get(
        sessionKey(priorRequest.sessionId),
      );
      if (!sameOpenRequest(priorRequest, input) || priorSession === undefined) {
        return Promise.resolve({ outcome: "idempotency-conflict" });
      }
      return Promise.resolve({ outcome: "replayed", session: priorSession });
    }

    const key = gatewayKey(input.binding, input.binding.gatewayId);
    const currentSessionId = this.#currentSessions.get(key);
    let fencedSessionId: CloudLinkSessionId | undefined;
    if (currentSessionId !== undefined) {
      const current = this.#sessions.get(sessionKey(currentSessionId));
      if (current !== undefined && current.state !== "closed") {
        const fenced = fenceCloudLinkSession(current, input.openedAt);
        if (!fenced.ok) {
          return Promise.resolve({ outcome: "idempotency-conflict" });
        }
        this.#sessions.set(sessionKey(currentSessionId), fenced.value);
        fencedSessionId = currentSessionId;
      }
    }

    const nextEpoch = (this.#nextEpochs.get(key) ?? 0n) + 1n;
    this.#nextEpochs.set(key, nextEpoch);
    const negotiating = createCloudLinkSession({
      tenantId: input.binding.tenantId,
      projectId: input.binding.projectId,
      gatewayId: input.binding.gatewayId,
      sessionId: input.sessionId,
      credentialGeneration: input.binding.generation,
      epoch: parseCloudLinkSessionEpoch(nextEpoch.toString()),
      openedAt: input.openedAt,
    });
    const negotiated = negotiateCloudLinkSession(
      negotiating,
      input.protocolVersion,
    );
    if (!negotiated.ok) {
      throw new Error(negotiated.failure.message);
    }
    const cursors = [...(this.#durableCursors.get(key)?.values() ?? [])].sort(
      (left, right) => {
        const streamOrder = left.streamId.localeCompare(right.streamId);
        if (streamOrder !== 0) return streamOrder;
        if (BigInt(left.streamEpoch) < BigInt(right.streamEpoch)) return -1;
        if (BigInt(left.streamEpoch) > BigInt(right.streamEpoch)) return 1;
        return 0;
      },
    );
    const activated = activateCloudLinkSession(negotiated.value, {
      activatedAt: input.openedAt,
      resumeCursors: cursors,
    });
    if (!activated.ok) {
      throw new Error(activated.failure.message);
    }
    this.#sessions.set(sessionKey(input.sessionId), activated.value);
    this.#currentSessions.set(key, input.sessionId);
    this.#openRequests.set(
      requestKey,
      Object.freeze({
        binding: Object.freeze({ ...input.binding }),
        protocolVersion: input.protocolVersion,
        sessionId: input.sessionId,
      }),
    );
    return Promise.resolve({
      outcome: "opened",
      session: activated.value,
      ...(fencedSessionId === undefined ? {} : { fencedSessionId }),
    });
  }

  findById(
    binding: GatewayCredentialBinding,
    requestedSessionId: CloudLinkSessionId,
  ): Promise<CloudLinkSession | undefined> {
    const session = this.#sessions.get(sessionKey(requestedSessionId));
    if (
      session === undefined ||
      session.tenantId !== binding.tenantId ||
      session.projectId !== binding.projectId ||
      session.gatewayId !== binding.gatewayId ||
      session.credentialGeneration !== binding.generation
    ) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(session);
  }

  findCurrent(
    scope: CloudLinkSessionScope,
    requestedGatewayId: GatewayId,
  ): Promise<CloudLinkSession | undefined> {
    const current = this.#currentSessions.get(
      gatewayKey(scope, requestedGatewayId),
    );
    return Promise.resolve(
      current === undefined
        ? undefined
        : this.#sessions.get(sessionKey(current)),
    );
  }

  isCurrentSessionFence(fence: IntegrationCloudLinkSessionFence): boolean {
    const currentId = this.#currentSessions.get(
      gatewayKey(fence, fence.gatewayId),
    );
    const current =
      currentId === undefined
        ? undefined
        : this.#sessions.get(sessionKey(currentId));
    return (
      current !== undefined &&
      current.state === "active" &&
      current.tenantId === fence.tenantId &&
      current.projectId === fence.projectId &&
      current.gatewayId === fence.gatewayId &&
      current.sessionId === fence.sessionId &&
      current.epoch === fence.sessionEpoch &&
      current.revision === fence.sessionRevision &&
      current.credentialGeneration === fence.credentialGeneration &&
      current.gatewayKeyId === fence.gatewayKeyId
    );
  }

  acceptHeartbeat(
    input: AcceptCloudLinkHeartbeatAuthenticationInput,
  ): Promise<CloudLinkUplinkAuthenticationRepositoryResult> {
    const key = [
      input.tenantId,
      input.projectId,
      input.gatewayId,
      input.sessionId,
      input.sessionEpoch,
      input.credentialGeneration,
    ].join("\u0000");
    const current = this.#heartbeatAuthentication.get(key);
    if (current === undefined) {
      this.#heartbeatAuthentication.set(
        key,
        Object.freeze({
          highestObservedAtMs: input.observedAtMs,
          exactSigningObjectDigest: input.exactSigningObjectDigest,
        }),
      );
      return Promise.resolve({ outcome: "accepted" });
    }
    const observedAt = BigInt(input.observedAtMs);
    const highestObservedAt = BigInt(current.highestObservedAtMs);
    if (observedAt < highestObservedAt) {
      return Promise.resolve({ outcome: "lower" });
    }
    if (observedAt === highestObservedAt) {
      return Promise.resolve({
        outcome:
          input.exactSigningObjectDigest === current.exactSigningObjectDigest
            ? "replayed"
            : "conflict",
      });
    }
    this.#heartbeatAuthentication.set(
      key,
      Object.freeze({
        highestObservedAtMs: input.observedAtMs,
        exactSigningObjectDigest: input.exactSigningObjectDigest,
      }),
    );
    return Promise.resolve({ outcome: "accepted" });
  }

  replace(
    session: CloudLinkSession,
    expectedRevision: number,
  ): Promise<CloudLinkSessionReplaceResult> {
    const key = sessionKey(session.sessionId);
    const current = this.#sessions.get(key);
    if (current === undefined) return Promise.resolve("not-found");
    if (current.revision !== expectedRevision) {
      return Promise.resolve("version-conflict");
    }
    this.#sessions.set(key, session);
    return Promise.resolve("replaced");
  }

  recordDurableCursor(
    input: RecordCloudLinkDurableCursorRepositoryInput,
  ): Promise<RecordCloudLinkDurableCursorRepositoryResult> {
    const session = this.#sessions.get(sessionKey(input.sessionId));
    if (
      session === undefined ||
      session.tenantId !== input.binding.tenantId ||
      session.projectId !== input.binding.projectId ||
      session.gatewayId !== input.binding.gatewayId ||
      session.credentialGeneration !== input.binding.generation
    ) {
      return Promise.resolve("not-found");
    }
    if (session.state !== "active" || session.epoch !== input.sessionEpoch) {
      return Promise.resolve("stale-session");
    }
    const key = gatewayKey(input.binding, input.binding.gatewayId);
    const cursors: Map<string, StoredCursor> =
      this.#durableCursors.get(key) ?? new Map<string, StoredCursor>();
    const { streamId, streamEpoch, position } = input.cursor;
    const cursorKey = `${streamId}:${streamEpoch}`;
    const current = cursors.get(cursorKey);
    if (current !== undefined && BigInt(position) <= BigInt(current.position)) {
      return Promise.resolve("replayed");
    }
    const expectedPosition =
      current === undefined ? 1n : BigInt(current.position) + 1n;
    if (BigInt(position) !== expectedPosition) {
      return Promise.resolve("position-gap");
    }
    cursors.set(cursorKey, Object.freeze({ streamId, streamEpoch, position }));
    this.#durableCursors.set(key, cursors);
    return Promise.resolve("recorded");
  }
}
