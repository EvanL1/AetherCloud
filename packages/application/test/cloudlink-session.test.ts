import { describe, expect, it } from "vitest";

import {
  GET_CLOUDLINK_SESSION_QUERY,
  OPEN_CLOUDLINK_SESSION_COMMAND,
  OpenCloudLinkSession,
  RecordCloudLinkDurableCursor,
  RECORD_CLOUDLINK_HEARTBEAT_COMMAND,
  RecordCloudLinkHeartbeat,
  GetCurrentCloudLinkSession,
  type ApplicationClock,
  type CloudLinkSessionRepository,
  type GatewayCredentialVerifier,
  type GatewayCredentialVerificationResult,
  type OpenCloudLinkSessionRepositoryInput,
  type RecordCloudLinkDurableCursorRepositoryResult,
} from "../src/index.js";
import {
  activateCloudLinkSession,
  createCloudLinkSession,
  negotiateCloudLinkSession,
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseProtocolVersion,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
  parseTenantId,
  parseUtcInstant,
  type CloudLinkSession,
  type GatewayCredentialBinding,
} from "@aether-cloud/domain";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const otherTenantId = parseTenantId("99999999-9999-4999-8999-999999999999");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");
const sessionId = parseCloudLinkSessionId(
  "44444444-4444-4444-8444-444444444444",
);

class FixedClock implements ApplicationClock {
  now() {
    return parseUtcInstant("2026-07-14T08:05:00.000Z");
  }
}

class FixedSessionIdGenerator {
  next() {
    return sessionId;
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
  readonly #result:
    | Readonly<{ ok: true; value: GatewayCredentialBinding }>
    | Readonly<{
        ok: false;
        failure: Readonly<{
          code: "invalid-gateway-credential";
          message: string;
        }>;
      }>;

  constructor(
    result:
      | Readonly<{ ok: true; value: GatewayCredentialBinding }>
      | Readonly<{
          ok: false;
          failure: Readonly<{
            code: "invalid-gateway-credential";
            message: string;
          }>;
        }>,
  ) {
    this.#result = result;
  }

  verify(): Promise<GatewayCredentialVerificationResult> {
    this.calls += 1;
    return Promise.resolve(this.#result);
  }
}

function makeActiveSession(): CloudLinkSession {
  const negotiating = createCloudLinkSession({
    tenantId,
    projectId,
    gatewayId,
    sessionId,
    credentialGeneration: parseGatewayCredentialGeneration("3"),
    epoch: parseCloudLinkSessionEpoch("9"),
    openedAt: parseUtcInstant("2026-07-14T08:05:00.000Z"),
  });
  const negotiated = negotiateCloudLinkSession(
    negotiating,
    parseProtocolVersion("1.0"),
  );
  if (!negotiated.ok) throw new Error("test negotiation failed");
  const active = activateCloudLinkSession(negotiated.value, {
    activatedAt: parseUtcInstant("2026-07-14T08:05:00.000Z"),
    resumeCursors: [
      {
        streamId: parseStreamId("telemetry"),
        streamEpoch: parseStreamEpoch("4"),
        position: parseStreamPosition("42"),
      },
    ],
  });
  if (!active.ok) throw new Error("test activation failed");
  return active.value;
}

class StubSessionRepository implements CloudLinkSessionRepository {
  opened: OpenCloudLinkSessionRepositoryInput | undefined;
  cursor: unknown;
  cursorResult: RecordCloudLinkDurableCursorRepositoryResult = "recorded";
  session: CloudLinkSession | undefined = makeActiveSession();

  open(input: OpenCloudLinkSessionRepositoryInput) {
    this.opened = input;
    return Promise.resolve({
      outcome: "opened" as const,
      session: this.session ?? makeActiveSession(),
    });
  }

  findById() {
    return Promise.resolve(this.session);
  }

  findCurrent(scope: {
    readonly tenantId: typeof tenantId;
    readonly projectId: typeof projectId;
  }) {
    return Promise.resolve(
      scope.tenantId === tenantId && scope.projectId === projectId
        ? this.session
        : undefined,
    );
  }

  replace(session: CloudLinkSession, expectedRevision: number) {
    if (this.session?.revision !== expectedRevision) {
      return Promise.resolve("version-conflict" as const);
    }
    this.session = session;
    return Promise.resolve("replaced" as const);
  }

  recordDurableCursor(input: unknown) {
    this.cursor = input;
    return Promise.resolve(this.cursorResult);
  }
}

const validCommandContext = {
  idempotencyKey: "cloudlink-open-request-001",
  issuedAt: "2026-07-14T08:00:00.000Z",
  expiresAt: "2026-07-14T08:10:00.000Z",
};

const credential = {
  credentialId: "gateway-credential-003",
  proof: "opaque-test-proof-material",
};

describe("CloudLink session application", () => {
  it("declares deny-by-default governed command and query metadata", () => {
    expect(OPEN_CLOUDLINK_SESSION_COMMAND).toMatchObject({
      kind: "command",
      permission: "cloudlink.session.open",
      risk: "low",
      confirmation: "not-required",
      idempotency: "required",
      expiry: "required",
      audit: "required",
      authorization: "gateway-credential",
    });
    expect(RECORD_CLOUDLINK_HEARTBEAT_COMMAND).toMatchObject({
      permission: "cloudlink.session.heartbeat",
      authorization: "gateway-credential",
    });
    expect(GET_CLOUDLINK_SESSION_QUERY).toEqual({
      kind: "query",
      name: "fleet.cloudlink.session.get",
      permission: "fleet.cloudlink.session.read",
    });
  });

  it("decodes external input before credential verification", async () => {
    const verifier = new StubCredentialVerifier({ ok: true, value: binding() });
    const useCase = new OpenCloudLinkSession({
      repository: new StubSessionRepository(),
      credentialVerifier: verifier,
      clock: new FixedClock(),
      sessionIds: new FixedSessionIdGenerator(),
      supportedProtocolVersions: ["1.0"],
    });

    const result = await useCase.execute(validCommandContext, {
      credential,
      protocolVersions: [1],
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "invalid-input" },
    });
    expect(verifier.calls).toBe(0);
  });

  it("fails closed for invalid, suspended, or revoked Gateway credentials", async () => {
    const invalid = new OpenCloudLinkSession({
      repository: new StubSessionRepository(),
      credentialVerifier: new StubCredentialVerifier({
        ok: false,
        failure: {
          code: "invalid-gateway-credential",
          message: "credential rejected",
        },
      }),
      clock: new FixedClock(),
      sessionIds: new FixedSessionIdGenerator(),
      supportedProtocolVersions: ["1.0"],
    });
    const suspended = new OpenCloudLinkSession({
      repository: new StubSessionRepository(),
      credentialVerifier: new StubCredentialVerifier({
        ok: true,
        value: binding("suspended"),
      }),
      clock: new FixedClock(),
      sessionIds: new FixedSessionIdGenerator(),
      supportedProtocolVersions: ["1.0"],
    });

    expect(
      await invalid.execute(validCommandContext, {
        credential,
        protocolVersions: ["1.0"],
      }),
    ).toMatchObject({
      ok: false,
      failure: { code: "invalid-gateway-credential" },
    });
    expect(
      await suspended.execute(validCommandContext, {
        credential,
        protocolVersions: ["1.0"],
      }),
    ).toMatchObject({
      ok: false,
      failure: { code: "gateway-credential-inactive" },
    });
  });

  it("selects a supported version and returns cloud-owned resume cursors", async () => {
    const repository = new StubSessionRepository();
    const useCase = new OpenCloudLinkSession({
      repository,
      credentialVerifier: new StubCredentialVerifier({
        ok: true,
        value: binding(),
      }),
      clock: new FixedClock(),
      sessionIds: new FixedSessionIdGenerator(),
      supportedProtocolVersions: ["1.0", "1.1"],
    });

    const result = await useCase.execute(validCommandContext, {
      credential,
      protocolVersions: ["2.0", "1.1", "1.0"],
      clientPositions: [
        { streamId: "telemetry", streamEpoch: "4", position: "99" },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        tenantId,
        projectId,
        gatewayId,
        state: "active",
        protocolVersion: "1.0",
        resumeCursors: [
          { streamId: "telemetry", streamEpoch: "4", position: "42" },
        ],
      },
    });
    expect(repository.opened).toMatchObject({
      binding: { tenantId, projectId, gatewayId, status: "active" },
      requestId: "cloudlink-open-request-001",
      protocolVersion: "1.0",
    });
    expect(repository.opened).not.toHaveProperty("clientPositions");
  });

  it("records a durable cursor only through the authenticated session use case", async () => {
    const repository = new StubSessionRepository();
    const useCase = new RecordCloudLinkDurableCursor({
      repository,
      credentialVerifier: new StubCredentialVerifier({
        ok: true,
        value: binding(),
      }),
      clock: new FixedClock(),
    });

    const result = await useCase.execute(validCommandContext, {
      credential,
      sessionId,
      sessionEpoch: "9",
      streamId: "manifest",
      streamEpoch: "1",
      position: "7",
    });

    expect(result).toEqual({
      ok: true,
      replayed: false,
      value: {
        streamId: "manifest",
        streamEpoch: "1",
        position: "7",
      },
    });
    expect(repository.cursor).toMatchObject({
      binding: { tenantId, projectId, gatewayId, generation: "3" },
      sessionId,
      sessionEpoch: "9",
      cursor: { streamId: "manifest", streamEpoch: "1", position: "7" },
    });

    repository.cursorResult = "replayed";
    await expect(
      useCase.execute(validCommandContext, {
        credential,
        sessionId,
        sessionEpoch: "9",
        streamId: "manifest",
        streamEpoch: "1",
        position: "7",
      }),
    ).resolves.toMatchObject({ ok: true, replayed: true });
    repository.cursorResult = "position-gap";
    await expect(
      useCase.execute(validCommandContext, {
        credential,
        sessionId,
        sessionEpoch: "9",
        streamId: "manifest",
        streamEpoch: "1",
        position: "9",
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "cloudlink-cursor-gap" },
    });
    repository.cursorResult = "stale-session";
    await expect(
      useCase.execute(validCommandContext, {
        credential,
        sessionId,
        sessionEpoch: "8",
        streamId: "manifest",
        streamEpoch: "1",
        position: "7",
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "stale-cloudlink-session-epoch" },
    });
    repository.cursorResult = "not-found";
    await expect(
      useCase.execute(validCommandContext, {
        credential,
        sessionId,
        sessionEpoch: "9",
        streamId: "manifest",
        streamEpoch: "1",
        position: "7",
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "session-not-found" },
    });
  });

  it("rejects expired commands and unsupported protocol versions", async () => {
    const verifier = new StubCredentialVerifier({ ok: true, value: binding() });
    const useCase = new OpenCloudLinkSession({
      repository: new StubSessionRepository(),
      credentialVerifier: verifier,
      clock: new FixedClock(),
      sessionIds: new FixedSessionIdGenerator(),
      supportedProtocolVersions: ["1.0"],
    });

    expect(
      await useCase.execute(
        { ...validCommandContext, expiresAt: "2026-07-14T08:05:00.000Z" },
        { credential, protocolVersions: ["1.0"] },
      ),
    ).toMatchObject({ ok: false, failure: { code: "command-expired" } });
    expect(
      await useCase.execute(validCommandContext, {
        credential,
        protocolVersions: ["2.0"],
      }),
    ).toMatchObject({
      ok: false,
      failure: { code: "unsupported-protocol-version" },
    });
  });

  it("records an authenticated heartbeat and rejects a stale epoch", async () => {
    const repository = new StubSessionRepository();
    const heartbeat = new RecordCloudLinkHeartbeat({
      repository,
      credentialVerifier: new StubCredentialVerifier({
        ok: true,
        value: binding(),
      }),
      clock: new FixedClock(),
    });

    const result = await heartbeat.execute(
      {
        ...validCommandContext,
        idempotencyKey: "heartbeat-request-001",
      },
      { credential, sessionId, sessionEpoch: "8" },
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "stale-cloudlink-session-epoch" },
    });
    expect(repository.session?.lastHeartbeatAt).toBeUndefined();
  });

  it("authorizes a tenant-scoped current-session query", async () => {
    const query = new GetCurrentCloudLinkSession({
      repository: new StubSessionRepository(),
    });

    expect(
      await query.execute(
        {
          tenantId,
          projectId,
          subjectId: "operator:alice",
          permissions: ["fleet.cloudlink.session.read"],
        },
        { gatewayId },
      ),
    ).toMatchObject({ ok: true, value: { sessionId, state: "active" } });
    expect(
      await query.execute(
        {
          tenantId: otherTenantId,
          projectId,
          subjectId: "operator:mallory",
          permissions: [],
        },
        { gatewayId },
      ),
    ).toMatchObject({ ok: false, failure: { code: "permission-denied" } });
  });
});
