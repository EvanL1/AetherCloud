import type {
  CloudLinkSessionReplaceResult,
  CloudLinkSessionRepository,
  CloudLinkSessionScope,
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

export class InMemoryCloudLinkSessionRepository implements CloudLinkSessionRepository {
  readonly #sessions = new Map<string, CloudLinkSession>();
  readonly #currentSessions = new Map<string, CloudLinkSessionId>();
  readonly #nextEpochs = new Map<string, bigint>();
  readonly #openRequests = new Map<string, StoredOpenRequest>();
  readonly #durableCursors = new Map<string, Map<string, StoredCursor>>();

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
    cursors.set(cursorKey, Object.freeze({ streamId, streamEpoch, position }));
    this.#durableCursors.set(key, cursors);
    return Promise.resolve("recorded");
  }
}
