import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  TelemetryStorageUnavailableError,
  type TelemetryPersistenceInput,
} from "@aether-cloud/application";
import {
  defineTelemetryBatch,
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseEdgeInstanceId,
  parseEdgePointId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseSourceTimestampMs,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
  parseTelemetryStreamEpoch,
  parseTelemetryStreamId,
  parseTelemetryStreamPosition,
  parseTenantId,
  parseTopologyPublicationEpoch,
  parseTopologySnapshotDigest,
  parseUtcInstant,
} from "@aether-cloud/domain";

import {
  PostgresTelemetryRepository,
  telemetryPostgresMigrationUrl,
  type PostgresTelemetryClient,
  type PostgresTelemetryPool,
  type PostgresTelemetryQueryResult,
} from "../src/index.js";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

function result(
  rows: readonly Record<string, unknown>[] = [],
  rowCount = rows.length,
): PostgresTelemetryQueryResult<Record<string, unknown>> {
  return { rows, rowCount };
}

class ScenarioClient implements PostgresTelemetryClient {
  readonly calls: QueryCall[] = [];
  released = false;
  failOn: string | undefined;
  handler:
    | ((
        text: string,
        values: readonly unknown[],
      ) => PostgresTelemetryQueryResult<Record<string, unknown>> | undefined)
    | undefined;

  query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresTelemetryQueryResult<Row>> {
    this.calls.push({ text, values });
    if (this.failOn !== undefined && text.includes(this.failOn)) {
      return Promise.reject(new Error("simulated storage failure"));
    }
    const handled = this.handler?.(text, values);
    if (handled !== undefined) {
      return Promise.resolve(handled as PostgresTelemetryQueryResult<Row>);
    }
    if (
      text.includes("SELECT") &&
      text.includes("telemetry_ingress_requests")
    ) {
      return Promise.resolve(result() as PostgresTelemetryQueryResult<Row>);
    }
    if (text.includes("SELECT") && text.includes("telemetry_batches")) {
      return Promise.resolve(result() as PostgresTelemetryQueryResult<Row>);
    }
    if (text.includes("SELECT") && text.includes("telemetry_records")) {
      return Promise.resolve(result() as PostgresTelemetryQueryResult<Row>);
    }
    if (
      text.includes("telemetry_gateway_usage") &&
      text.includes("RETURNING")
    ) {
      return Promise.resolve(
        result([{ record_count: "1" }], 1) as PostgresTelemetryQueryResult<Row>,
      );
    }
    if (text.includes("FOR UPDATE") && text.includes("telemetry_streams")) {
      return Promise.resolve(
        result([
          { contiguous_position: "6" },
        ]) as PostgresTelemetryQueryResult<Row>,
      );
    }
    if (text.includes("INSERT INTO aethercloud.cloudlink_durable_ack_outbox")) {
      return Promise.resolve(
        result([acknowledgementRow()]) as PostgresTelemetryQueryResult<Row>,
      );
    }
    return Promise.resolve(result([], 1) as PostgresTelemetryQueryResult<Row>);
  }

  release(): void {
    this.released = true;
  }
}

class ScenarioPool implements PostgresTelemetryPool {
  readonly client: ScenarioClient;

  constructor(client: ScenarioClient) {
    this.client = client;
  }

  connect(): Promise<PostgresTelemetryClient> {
    return Promise.resolve(this.client);
  }
}

function persistenceInput(
  options: {
    readonly batchId?: string;
    readonly position?: string;
    readonly requestId?: string;
    readonly withAcknowledgement?: boolean;
  } = {},
): TelemetryPersistenceInput {
  const position = options.position ?? "7";
  const batchId = options.batchId ?? "batch-007";
  return {
    requestId: options.requestId ?? "cloudlink:batch-007",
    binding: {
      tenantId,
      projectId,
      gatewayId,
      generation: parseGatewayCredentialGeneration("3"),
      status: "active",
    },
    batch: defineTelemetryBatch({
      streamId: parseTelemetryStreamId("telemetry"),
      streamEpoch: parseTelemetryStreamEpoch("4"),
      topology: {
        publicationEpoch: parseTopologyPublicationEpoch("11"),
        snapshotDigest: parseTopologySnapshotDigest("fx64:0123456789abcdef"),
      },
      retentionClass: "standard-30d",
      replay: false,
      records: [
        {
          kind: "point-sample",
          position: parseTelemetryStreamPosition(position),
          sourceTimestampMs: parseSourceTimestampMs("1784016000000"),
          instanceId: parseEdgeInstanceId("42"),
          pointKind: "telemetry",
          pointId: parseEdgePointId("7"),
          quality: "good",
          value: { type: "float64", value: 21.5 },
        },
      ],
    }),
    payloadDigest: "b".repeat(64),
    receivedAt: parseUtcInstant("2026-07-16T01:00:00.000Z"),
    ...(options.withAcknowledgement === false
      ? {}
      : {
          durableAcknowledgement: {
            sessionId: parseCloudLinkSessionId(
              "44444444-4444-4444-8444-444444444444",
            ),
            sessionEpoch: parseCloudLinkSessionEpoch("4"),
            credentialGeneration: parseGatewayCredentialGeneration("3"),
            streamId: parseStreamId("telemetry"),
            streamEpoch: parseStreamEpoch("4"),
            acknowledgedPosition: parseStreamPosition(position),
            acceptedTelemetryPosition: parseTelemetryStreamPosition(position),
            batchId,
            digest: `sha256:${"a".repeat(64)}`,
            acknowledgedAt: parseUtcInstant("2026-07-16T01:00:00.000Z"),
          },
        }),
  };
}

function receiptRow(
  input: TelemetryPersistenceInput,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    tenant_id: input.binding.tenantId,
    project_id: input.binding.projectId,
    gateway_id: input.binding.gatewayId,
    credential_generation: input.binding.generation,
    batch_identity: input.batch.batchIdentity,
    payload_digest: input.payloadDigest,
    stream_id: input.batch.streamId,
    stream_epoch: input.batch.streamEpoch,
    first_position: input.batch.firstPosition,
    last_position: input.batch.lastPosition,
    record_count: String(input.batch.recordCount),
    persisted_at_text: input.receivedAt,
    contiguous_position_text: input.batch.lastPosition,
    gap_expected_position_text: null,
    gap_received_position_text: null,
    receipt_id: "receipt:telemetry:stored",
    audit_event_id: "audit:telemetry:stored",
    outbox_event_id: "outbox:telemetry:stored",
    ...extra,
  };
}

function acknowledgementRow(
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    outbox_event_id: "outbox:cloudlink-ack:001",
    tenant_id: tenantId,
    project_id: projectId,
    gateway_id: gatewayId,
    session_id: "44444444-4444-4444-8444-444444444444",
    session_epoch: "4",
    credential_generation: "3",
    stream_id: "telemetry",
    stream_epoch: "4",
    acknowledged_position: "7",
    batch_id: "batch-007",
    digest: `sha256:${"a".repeat(64)}`,
    receipt_id: "receipt:cloudlink:batch-007",
    acknowledged_at: "2026-07-16T01:00:00.000Z",
    ...extra,
  };
}

describe("PostgresTelemetryRepository", () => {
  it("atomically writes inbox, business fact, cursor, receipt, Audit, integration Outbox, and exact ACK Outbox", async () => {
    const client = new ScenarioClient();
    const repository = new PostgresTelemetryRepository(
      new ScenarioPool(client),
    );

    const persisted = await repository.persist(persistenceInput());

    expect(persisted).toMatchObject({
      outcome: "persisted",
      receipt: {
        batchIdentity: "telemetry:4:7",
        contiguousPosition: "7",
      },
      durableAcknowledgement: {
        sessionEpoch: "4",
        acknowledgedPosition: "7",
        batchId: "batch-007",
        digest: `sha256:${"a".repeat(64)}`,
        acknowledgedAt: "2026-07-16T01:00:00.000Z",
      },
    });
    const statements = client.calls.map((call) => call.text);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toContain("set_config");
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining("telemetry_ingress_requests"),
        expect.stringContaining("telemetry_batches"),
        expect.stringContaining("telemetry_records"),
        expect.stringContaining("telemetry_streams"),
        expect.stringContaining("audit_events"),
        expect.stringContaining("outbox_events"),
        expect.stringContaining("cloudlink_durable_ack_outbox"),
      ]),
    );
    expect(statements.at(-1)).toBe("COMMIT");
    expect(client.released).toBe(true);
    const evidenceValues = client.calls
      .filter(
        (call) =>
          call.text.includes("audit_events") ||
          call.text.includes("outbox_events"),
      )
      .flatMap((call) => call.values);
    expect(evidenceValues).not.toContain(21.5);
  });

  it("rolls back the complete acceptance when ACK Outbox insertion fails before commit", async () => {
    const client = new ScenarioClient();
    client.failOn = "INSERT INTO aethercloud.cloudlink_durable_ack_outbox";
    const repository = new PostgresTelemetryRepository(
      new ScenarioPool(client),
    );

    await expect(repository.persist(persistenceInput())).resolves.toEqual({
      outcome: "storage-unavailable",
    });
    expect(client.calls.map((call) => call.text).at(-1)).toBe("ROLLBACK");
    expect(client.calls.some((call) => call.text === "COMMIT")).toBe(false);
    expect(client.released).toBe(true);
  });

  it("returns stable duplicates by request or batch identity and rejects conflicting digests", async () => {
    const input = persistenceInput({ withAcknowledgement: false });
    const requestClient = new ScenarioClient();
    requestClient.handler = (text) =>
      text.includes("FROM aethercloud.telemetry_ingress_requests")
        ? result([
            receiptRow(input, {
              request_batch_identity: input.batch.batchIdentity,
              request_payload_digest: input.payloadDigest,
            }),
          ])
        : undefined;
    await expect(
      new PostgresTelemetryRepository(new ScenarioPool(requestClient)).persist(
        input,
      ),
    ).resolves.toMatchObject({
      outcome: "duplicate",
      receipt: { receiptId: "receipt:telemetry:stored" },
    });

    const requestConflict = new ScenarioClient();
    requestConflict.handler = (text) =>
      text.includes("FROM aethercloud.telemetry_ingress_requests")
        ? result([
            receiptRow(input, {
              request_batch_identity: input.batch.batchIdentity,
              request_payload_digest: "c".repeat(64),
            }),
          ])
        : undefined;
    await expect(
      new PostgresTelemetryRepository(
        new ScenarioPool(requestConflict),
      ).persist(input),
    ).resolves.toEqual({ outcome: "conflicting-replay" });

    const batchClient = new ScenarioClient();
    batchClient.handler = (text) =>
      text.includes("FROM aethercloud.telemetry_batches AS batch")
        ? result([receiptRow(input)])
        : undefined;
    await expect(
      new PostgresTelemetryRepository(new ScenarioPool(batchClient)).persist({
        ...input,
        requestId: "cloudlink:another-request",
      }),
    ).resolves.toMatchObject({ outcome: "duplicate" });
    expect(
      batchClient.calls.some((call) =>
        call.text.includes(
          "INSERT INTO aethercloud.telemetry_ingress_requests",
        ),
      ),
    ).toBe(true);

    const batchConflict = new ScenarioClient();
    batchConflict.handler = (text) =>
      text.includes("FROM aethercloud.telemetry_batches AS batch")
        ? result([receiptRow(input, { payload_digest: "d".repeat(64) })])
        : undefined;
    await expect(
      new PostgresTelemetryRepository(new ScenarioPool(batchConflict)).persist(
        input,
      ),
    ).resolves.toEqual({ outcome: "conflicting-replay" });
  });

  it("fails closed for overlap, stale cursor, excessive reorder distance, and quota", async () => {
    const overlap = new ScenarioClient();
    overlap.handler = (text) =>
      text.includes("position BETWEEN $6::numeric AND $7::numeric")
        ? result([{ position: "7" }])
        : undefined;
    await expect(
      new PostgresTelemetryRepository(new ScenarioPool(overlap)).persist(
        persistenceInput({ withAcknowledgement: false }),
      ),
    ).resolves.toEqual({ outcome: "position-conflict" });

    const stale = new ScenarioClient();
    stale.handler = (text) =>
      text.includes("FOR UPDATE") && text.includes("telemetry_streams")
        ? result([{ contiguous_position: "8" }])
        : undefined;
    await expect(
      new PostgresTelemetryRepository(new ScenarioPool(stale)).persist(
        persistenceInput({ withAcknowledgement: false }),
      ),
    ).resolves.toEqual({ outcome: "position-conflict" });

    const excessive = new ScenarioClient();
    excessive.handler = (text) =>
      text.includes("FOR UPDATE") && text.includes("telemetry_streams")
        ? result([{ contiguous_position: null }])
        : undefined;
    await expect(
      new PostgresTelemetryRepository(new ScenarioPool(excessive)).persist(
        persistenceInput({
          position: "5000",
          withAcknowledgement: false,
        }),
      ),
    ).resolves.toEqual({ outcome: "position-conflict" });

    const quota = new ScenarioClient();
    quota.handler = (text) =>
      text.includes("telemetry_gateway_usage") && text.includes("RETURNING")
        ? result([], 0)
        : undefined;
    await expect(
      new PostgresTelemetryRepository(new ScenarioPool(quota)).persist(
        persistenceInput({ withAcknowledgement: false }),
      ),
    ).resolves.toEqual({ outcome: "quota-exceeded" });
  });

  it("persists bounded gaps without advancing and coalesces only contiguous pending positions", async () => {
    const gapClient = new ScenarioClient();
    const gap = await new PostgresTelemetryRepository(
      new ScenarioPool(gapClient),
    ).persist(persistenceInput({ position: "9", withAcknowledgement: false }));
    expect(gap).toMatchObject({
      outcome: "persisted",
      receipt: {
        contiguousPosition: "6",
        gap: { expectedPosition: "7", receivedPosition: "9" },
      },
    });
    expect(
      gapClient.calls.some((call) =>
        call.text.includes("UPDATE aethercloud.telemetry_streams"),
      ),
    ).toBe(false);

    const coalescingClient = new ScenarioClient();
    coalescingClient.handler = (text) =>
      text.includes("AND position > $6::numeric")
        ? result([{ position: "8" }, { position: "10" }])
        : undefined;
    await expect(
      new PostgresTelemetryRepository(
        new ScenarioPool(coalescingClient),
      ).persist(persistenceInput({ withAcknowledgement: false })),
    ).resolves.toMatchObject({
      outcome: "persisted",
      receipt: { contiguousPosition: "8" },
    });
  });

  it("rejects contradictory ACK intent and malformed or cross-scope ACK rows", async () => {
    const input = persistenceInput();
    if (input.durableAcknowledgement === undefined) {
      throw new Error("test input is missing its ACK");
    }
    const contradictory = {
      ...input,
      durableAcknowledgement: {
        ...input.durableAcknowledgement,
        acceptedTelemetryPosition: parseTelemetryStreamPosition("8"),
      },
    };
    await expect(
      new PostgresTelemetryRepository(
        new ScenarioPool(new ScenarioClient()),
      ).persist(contradictory),
    ).resolves.toEqual({ outcome: "storage-unavailable" });

    for (const row of [
      acknowledgementRow({ digest: "not-a-digest" }),
      acknowledgementRow({
        tenant_id: "99999999-9999-4999-8999-999999999999",
      }),
    ]) {
      const client = new ScenarioClient();
      client.handler = (text) =>
        text.includes("INSERT INTO aethercloud.cloudlink_durable_ack_outbox")
          ? result([row])
          : undefined;
      await expect(
        new PostgresTelemetryRepository(new ScenarioPool(client)).persist(
          input,
        ),
      ).resolves.toEqual({ outcome: "storage-unavailable" });
      expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    }
  });

  it("queries decoded Tenant history and converts contradictory rows to a typed storage failure", async () => {
    const historyRow = {
      batch_identity: "telemetry:4:7",
      record_kind: "point-sample",
      record_payload: {
        kind: "point-sample",
        position: "7",
        sourceTimestampMs: "1784016000000",
        instanceId: "42",
        pointKind: "telemetry",
        pointId: "7",
        quality: "good",
        value: { type: "float64", value: 21.5 },
      },
      received_at: "2026-07-16T01:00:00.000Z",
      persisted_at: "2026-07-16T01:00:00.000Z",
      retention_class: "standard-30d",
      topology_publication_epoch: "11",
      topology_snapshot_digest: "fx64:0123456789abcdef",
    };
    const query = {
      tenantId,
      projectId,
      gatewayId,
      streamId: parseTelemetryStreamId("telemetry"),
      streamEpoch: parseTelemetryStreamEpoch("4"),
      fromPosition: parseTelemetryStreamPosition("0"),
      limit: 10,
    };
    const client = new ScenarioClient();
    client.handler = (text) =>
      text.includes("FROM aethercloud.telemetry_records AS record")
        ? result([historyRow])
        : undefined;
    await expect(
      new PostgresTelemetryRepository(new ScenarioPool(client)).queryHistory(
        query,
      ),
    ).resolves.toMatchObject([
      {
        tenantId,
        record: { kind: "point-sample", position: "7" },
      },
    ]);
    expect(client.calls.at(-1)?.text).toBe("COMMIT");

    const contradictory = new ScenarioClient();
    contradictory.handler = (text) =>
      text.includes("FROM aethercloud.telemetry_records AS record")
        ? result([{ ...historyRow, record_kind: "device-event" }])
        : undefined;
    await expect(
      new PostgresTelemetryRepository(
        new ScenarioPool(contradictory),
      ).queryHistory(query),
    ).rejects.toBeInstanceOf(TelemetryStorageUnavailableError);
    expect(contradictory.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it.each([0, 101])(
    "rejects an invalid ACK claim limit of %i before opening a transaction",
    async (limit) => {
      const client = new ScenarioClient();
      await expect(
        new PostgresTelemetryRepository(new ScenarioPool(client)).claimPending({
          tenantId,
          projectId,
          workerId: "cloudlink-ack-worker-01",
          now: parseUtcInstant("2026-07-16T01:01:00.000Z"),
          leaseExpiresAt: parseUtcInstant("2026-07-16T01:01:30.000Z"),
          limit,
        }),
      ).resolves.toEqual({ outcome: "storage-unavailable" });
      expect(client.calls).toEqual([]);
    },
  );

  it("distinguishes missing and conflicting ACK leases and releases an owned retry", async () => {
    for (const [existence, expected] of [
      [result([], 0), "not-found"],
      [result([{ leased_by: "another-worker" }]), "lease-conflict"],
    ] as const) {
      const client = new ScenarioClient();
      client.handler = (text) => {
        if (text.includes("SET\n  published_at")) return result([], 0);
        if (text.includes("SELECT leased_by")) return existence;
        return undefined;
      };
      await expect(
        new PostgresTelemetryRepository(new ScenarioPool(client)).markPublished(
          {
            tenantId,
            projectId,
            workerId: "cloudlink-ack-worker-01",
            outboxEventId: "outbox:cloudlink-ack:001",
            publishedAt: parseUtcInstant("2026-07-16T01:01:01.000Z"),
          },
        ),
      ).resolves.toBe(expected);
    }

    const released = new ScenarioClient();
    await expect(
      new PostgresTelemetryRepository(
        new ScenarioPool(released),
      ).releaseForRetry({
        tenantId,
        projectId,
        workerId: "cloudlink-ack-worker-01",
        outboxEventId: "outbox:cloudlink-ack:001",
        retryAt: parseUtcInstant("2026-07-16T01:01:05.000Z"),
        errorCode: "broker-unavailable",
      }),
    ).resolves.toBe("released");
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid maximum Gateway record quota of %s",
    (maximumRecordsPerGateway) => {
      expect(
        () =>
          new PostgresTelemetryRepository(
            new ScenarioPool(new ScenarioClient()),
            { maximumRecordsPerGateway },
          ),
      ).toThrow(/positive safe integer/);
    },
  );

  it("claims ACKs with a bounded Tenant lease and SKIP LOCKED, then marks only the owned lease", async () => {
    const client = new ScenarioClient();
    client.handler = (text) => {
      if (text.includes("FOR UPDATE SKIP LOCKED")) {
        return result([
          {
            outbox_event_id: "outbox:cloudlink-ack:001",
            tenant_id: tenantId,
            project_id: projectId,
            gateway_id: gatewayId,
            session_id: "44444444-4444-4444-8444-444444444444",
            session_epoch: "4",
            credential_generation: "3",
            stream_id: "telemetry",
            stream_epoch: "4",
            acknowledged_position: "7",
            batch_id: "batch-007",
            digest: `sha256:${"a".repeat(64)}`,
            receipt_id: "receipt:cloudlink:batch-007",
            acknowledged_at: "2026-07-16T01:00:00.000Z",
          },
        ]);
      }
      return undefined;
    };
    const repository = new PostgresTelemetryRepository(
      new ScenarioPool(client),
    );
    const lease = {
      tenantId,
      projectId,
      workerId: "cloudlink-ack-worker-01",
      now: parseUtcInstant("2026-07-16T01:01:00.000Z"),
      leaseExpiresAt: parseUtcInstant("2026-07-16T01:01:30.000Z"),
      limit: 10,
    };

    await expect(repository.claimPending(lease)).resolves.toMatchObject({
      outcome: "claimed",
      acknowledgements: [
        {
          outboxEventId: "outbox:cloudlink-ack:001",
          digest: `sha256:${"a".repeat(64)}`,
        },
      ],
    });
    await expect(
      repository.markPublished({
        tenantId,
        projectId,
        workerId: lease.workerId,
        outboxEventId: "outbox:cloudlink-ack:001",
        publishedAt: parseUtcInstant("2026-07-16T01:01:01.000Z"),
      }),
    ).resolves.toBe("marked");
    expect(
      client.calls.some((call) => call.text.includes("FOR UPDATE SKIP LOCKED")),
    ).toBe(true);
    const mark = client.calls.find((call) =>
      call.text.includes("published_at = $5::timestamptz"),
    );
    expect(mark?.values).toEqual([
      tenantId,
      projectId,
      "outbox:cloudlink-ack:001",
      lease.workerId,
      "2026-07-16T01:01:01.000Z",
    ]);
  });

  it("defines uint64-safe storage, forced Tenant RLS, replay uniqueness, and a partial pending-ACK index", async () => {
    const migration = await readFile(telemetryPostgresMigrationUrl, "utf8");

    expect(migration).toContain("CREATE TABLE aethercloud.telemetry_batches");
    expect(migration).toContain(
      "CREATE TABLE aethercloud.cloudlink_durable_ack_outbox",
    );
    expect(migration).toContain("numeric(20, 0)");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("telemetry_batches_identity_uq");
    expect(migration).toContain("cloudlink_durable_ack_pending_idx");
    expect(migration).toContain("WHERE published_at IS NULL");
    expect(migration).not.toMatch(/CREATE\s+THING/i);
  });
});
