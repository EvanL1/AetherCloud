import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseIntegrationControlDigest,
  parseStreamId,
} from "@aether-cloud/domain";

import {
  integrationControlPostgresMigrationUrl,
  PostgresIntegrationControlRepository,
  type PostgresIntegrationControlClient,
  type PostgresIntegrationControlFaultInjector,
  type PostgresIntegrationControlPool,
  type PostgresIntegrationControlQueryResult,
} from "../src/index.js";
import {
  createInput,
  createRequestFingerprint,
  deliveryRow,
  gatewayId,
  intentDigest,
  intentRow,
  jobId,
  now,
  offer,
  offerRow,
  projectId,
  receiptEvidenceRow,
  receiptInput,
  scope,
  sessionId,
  tenantId,
} from "./fixtures.js";

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

function result(
  rows: readonly Record<string, unknown>[] = [],
  rowCount = rows.length,
): PostgresIntegrationControlQueryResult<Record<string, unknown>> {
  return { rows, rowCount };
}

function hasTag(text: string, tag: string): boolean {
  return text.includes(`integration-control:${tag}`);
}

class ScenarioClient implements PostgresIntegrationControlClient {
  readonly calls: QueryCall[] = [];
  released = false;
  handler:
    | ((
        text: string,
        values: readonly unknown[],
      ) =>
        | Error
        | PostgresIntegrationControlQueryResult<Record<string, unknown>>
        | undefined)
    | undefined;

  query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresIntegrationControlQueryResult<Row>> {
    this.calls.push({ text, values });
    const response =
      this.handler?.(text, values) ??
      (/\b(?:INSERT|UPDATE)\b/u.test(text) ? result([], 1) : result());
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response as PostgresIntegrationControlQueryResult<Row>);
  }

  release(): void {
    this.released = true;
  }
}

class ScenarioPool implements PostgresIntegrationControlPool {
  readonly client: ScenarioClient;

  constructor(client: ScenarioClient) {
    this.client = client;
  }

  connect(): Promise<PostgresIntegrationControlClient> {
    return Promise.resolve(this.client);
  }
}

describe("integration control PostgreSQL migration", () => {
  it("defines 0004 tenant-scoped durable intent, offer, receipt, cursor, and ACK tables", async () => {
    const migration = await readFile(
      integrationControlPostgresMigrationUrl,
      "utf8",
    );

    expect(
      integrationControlPostgresMigrationUrl.pathname.endsWith(
        "/0004_integration_control.sql",
      ),
    ).toBe(true);
    for (const table of [
      "integration_control_intents",
      "integration_control_requests",
      "integration_control_offer_outbox",
      "integration_control_receipt_stream_bindings",
      "integration_control_receipt_streams",
      "integration_control_receipts",
      "integration_control_receipt_deliveries",
      "integration_control_ack_outbox",
    ]) {
      expect(migration).toContain(`aethercloud.${table}`);
      expect(migration).toContain(
        `ALTER TABLE aethercloud.${table} FORCE ROW LEVEL SECURITY`,
      );
    }
    expect(migration).toContain(
      "stage IN ('edge-accepted', 'edge-rejected', 'provider-accepted', 'provider-rejected', 'unknown')",
    );
    expect(migration).toContain("physical_completed = false");
    expect(migration).toContain("job_succeeded = false");
    expect(migration).toContain("receipt_payload - ARRAY[");
    expect(migration).toContain("intent_payload - ARRAY[");
    expect(migration).toContain("offer_payload - ARRAY[");
    for (const stage of ["edge-rejected", "unknown"]) {
      const stageStart = migration.indexOf(`stage = '${stage}'`);
      const nextStage = migration.indexOf(") OR (", stageStart);
      const stageConstraint = migration.slice(stageStart, nextStage);
      expect(stageStart).toBeGreaterThan(-1);
      expect(stageConstraint).toContain(
        "NOT (receipt_payload ? 'evidenceDigest') OR",
      );
      expect(stageConstraint).toContain(
        "receipt_payload->>'evidenceDigest' ~ '^sha256:[0-9a-f]{64}$'",
      );
    }
    for (const stage of ["provider-accepted", "provider-rejected"]) {
      const stageStart = migration.indexOf(`stage = '${stage}'`);
      const nextStage = migration.indexOf(") OR (", stageStart);
      const stageConstraint = migration.slice(stageStart, nextStage);
      expect(stageConstraint).toContain("receipt_payload ? 'evidenceDigest'");
      expect(stageConstraint).toContain(
        "receipt_payload->>'evidenceDigest' ~ '^sha256:[0-9a-f]{64}$'",
      );
    }
    expect(migration).toMatch(
      /capability_id'?\s*=\s*'device\.power\.set\.v1'/u,
    );
    expect(migration).toContain(
      "CREATE POLICY integration_control_intents_tenant_policy",
    );
  });
});

describe("PostgresIntegrationControlRepository", () => {
  it("atomically writes intent, idempotency, governance audit, and offer outbox", async () => {
    const client = new ScenarioClient();
    const repository = new PostgresIntegrationControlRepository(
      new ScenarioPool(client),
    );

    await expect(
      repository.persistIntentAndOffer(createInput()),
    ).resolves.toMatchObject({
      outcome: "persisted",
      intent: {
        tenantId,
        projectId,
        gatewayId,
        jobId,
        intentDigest,
        latestReceipt: undefined,
        revision: 1,
      },
      offer: {
        tenantId,
        projectId,
        gatewayId,
        jobId,
        sessionId,
        status: "pending",
      },
    });
    expect(client.calls.map(({ text }) => text)).toEqual([
      "BEGIN",
      expect.stringContaining("set_config"),
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("integration-control:select-request"),
      expect.stringContaining("integration-control:select-intent-for-update"),
      expect.stringContaining("integration-control:select-offer-for-update"),
      expect.stringContaining("integration-control:insert-intent"),
      expect.stringContaining("integration-control:insert-request"),
      expect.stringContaining("INSERT INTO aethercloud.audit_events"),
      expect.stringContaining("integration-control:insert-offer"),
      "COMMIT",
    ]);
    expect(client.calls[1]?.values).toEqual([tenantId]);
    expect(client.released).toBe(true);
  });

  it("rolls back every create write when the transaction fails before commit", async () => {
    const client = new ScenarioClient();
    const faultInjector: PostgresIntegrationControlFaultInjector = {
      afterStep(step) {
        if (step === "offer-written") {
          throw new Error("simulated process failure");
        }
      },
    };
    const repository = new PostgresIntegrationControlRepository(
      new ScenarioPool(client),
      { faultInjector },
    );

    await expect(
      repository.persistIntentAndOffer(createInput()),
    ).resolves.toEqual({ outcome: "storage-unavailable" });
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(client.calls.some(({ text }) => text === "COMMIT")).toBe(false);
    expect(client.released).toBe(true);
  });

  it("distinguishes request reuse from immutable Job digest conflict", async () => {
    const reusedRequest = new ScenarioClient();
    reusedRequest.handler = (text) =>
      hasTag(text, "select-request")
        ? result([{ request_fingerprint: "f".repeat(64) }])
        : undefined;
    await expect(
      new PostgresIntegrationControlRepository(
        new ScenarioPool(reusedRequest),
      ).persistIntentAndOffer(createInput()),
    ).resolves.toEqual({ outcome: "idempotency-conflict" });
    expect(
      reusedRequest.calls.some(({ text }) => hasTag(text, "insert-intent")),
    ).toBe(false);

    const conflictingIntent = new ScenarioClient();
    conflictingIntent.handler = (text) =>
      hasTag(text, "select-intent-for-update")
        ? result([
            intentRow(
              offer({
                intent_digest: parseIntegrationControlDigest(
                  `sha256:${"b".repeat(64)}`,
                ),
              }),
            ),
          ])
        : undefined;
    await expect(
      new PostgresIntegrationControlRepository(
        new ScenarioPool(conflictingIntent),
      ).persistIntentAndOffer(
        createInput(offer(), "integration-control-create-002"),
      ),
    ).resolves.toEqual({ outcome: "intent-conflict" });
    expect(
      conflictingIntent.calls.some(({ text }) => hasTag(text, "insert-offer")),
    ).toBe(false);
  });

  it("replays one exact create request without duplicating durable evidence", async () => {
    const input = createInput();
    const client = new ScenarioClient();
    client.handler = (text) => {
      if (hasTag(text, "select-request")) {
        return result([
          {
            request_fingerprint: createRequestFingerprint(input),
            offer_event_id: offerRow().event_id,
          },
        ]);
      }
      if (hasTag(text, "select-intent-for-update")) {
        return result([intentRow()]);
      }
      if (hasTag(text, "select-offer-by-event")) {
        return result([offerRow()]);
      }
      return undefined;
    };

    await expect(
      new PostgresIntegrationControlRepository(
        new ScenarioPool(client),
      ).persistIntentAndOffer(input),
    ).resolves.toMatchObject({
      outcome: "replayed",
      intent: { revision: 1 },
      offer: { status: "pending" },
    });
    expect(
      client.calls.some(({ text }) => /^\s*(?:INSERT|UPDATE)\b/u.test(text)),
    ).toBe(false);
  });

  it("atomically reoffers only the same intent and does not update receipt state", async () => {
    const next = offer({
      session_id: parseCloudLinkSessionId(
        "88888888-8888-4888-8888-888888888888",
      ),
      session_epoch: parseCloudLinkSessionEpoch("8"),
      cloud_authentication: {
        key_id: "development-cloud-key-1",
        algorithm: "Ed25519",
        signature: "E".repeat(86),
      },
    });
    const client = new ScenarioClient();
    client.handler = (text) =>
      hasTag(text, "select-intent-for-update")
        ? result([intentRow()])
        : undefined;
    const repository = new PostgresIntegrationControlRepository(
      new ScenarioPool(client),
    );

    await expect(
      repository.persistReoffer({
        scope,
        gatewayId,
        requestId: "reoffer:job:session-8",
        subjectId: "system:cloudlink-reconnect",
        offer: next,
        createdAt: now,
      }),
    ).resolves.toMatchObject({
      outcome: "persisted",
      offer: {
        sessionId: "88888888-8888-4888-8888-888888888888",
        sessionEpoch: "8",
      },
    });
    expect(
      client.calls.some(({ text }) => text.includes("latest_receipt_payload")),
    ).toBe(false);
    expect(
      client.calls.filter(({ text }) => hasTag(text, "insert-offer")),
    ).toHaveLength(1);
  });

  it("locks the exact receipt stream and atomically persists evidence, cursor, audit, and ACK", async () => {
    const input = receiptInput();
    const client = new ScenarioClient();
    client.handler = (text) =>
      hasTag(text, "select-intent-for-update")
        ? result([intentRow()])
        : undefined;
    const repository = new PostgresIntegrationControlRepository(
      new ScenarioPool(client),
    );

    await expect(repository.persistReceipt(input)).resolves.toMatchObject({
      outcome: "persisted",
      evidence: {
        receipt: { stage: "edge-accepted" },
        providerAccepted: false,
        physicalCompleted: false,
        jobSucceeded: false,
      },
      durableAcknowledgement: {
        acknowledgedPosition: "1",
        batchId: input.delivery.batchId,
        digest: input.delivery.digest,
      },
    });
    expect(
      client.calls.filter(({ text }) => text.includes("pg_advisory_xact_lock")),
    ).toHaveLength(1);
    for (const tag of [
      "insert-stream-binding",
      "insert-stream",
      "insert-receipt",
      "insert-delivery",
      "update-intent-receipt",
      "update-stream-cursor",
      "insert-ack",
    ]) {
      expect(
        client.calls.some(({ text }) => hasTag(text, tag)),
        tag,
      ).toBe(true);
    }
    expect(client.calls.at(-1)?.text).toBe("COMMIT");
  });

  it("replays only an identical complete delivery and receipt while emitting a session-bound ACK", async () => {
    const input = receiptInput();
    const client = new ScenarioClient();
    client.handler = (text) => {
      if (hasTag(text, "select-intent-for-update")) {
        return result([intentRow(offer(), input.receipt)]);
      }
      if (hasTag(text, "select-stream-binding-for-update")) {
        return result([{ stream_id: input.delivery.streamId }]);
      }
      if (hasTag(text, "select-stream-for-update")) {
        return result([{ contiguous_position: input.delivery.position }]);
      }
      if (hasTag(text, "select-delivery")) {
        return result([deliveryRow(input)]);
      }
      return undefined;
    };
    const replaySession = parseCloudLinkSessionId(
      "88888888-8888-4888-8888-888888888888",
    );

    await expect(
      new PostgresIntegrationControlRepository(
        new ScenarioPool(client),
      ).persistReceipt({
        ...input,
        requestId: "integration-control-receipt-replay",
        sessionId: replaySession,
        sessionEpoch: parseCloudLinkSessionEpoch("8"),
      }),
    ).resolves.toMatchObject({
      outcome: "replayed",
      evidence: {
        receipt: { receiptId: input.receipt.receiptId },
      },
      durableAcknowledgement: {
        sessionId: replaySession,
        sessionEpoch: "8",
      },
    });
    expect(
      client.calls.some(({ text }) => hasTag(text, "insert-receipt")),
    ).toBe(false);
    expect(
      client.calls.filter(({ text }) => hasTag(text, "insert-ack")),
    ).toHaveLength(1);
  });

  it("strictly distinguishes stream binding, gap, delivery, and receipt identity conflicts", async () => {
    const bindingClient = new ScenarioClient();
    bindingClient.handler = (text) => {
      if (hasTag(text, "select-intent-for-update")) {
        return result([intentRow()]);
      }
      if (hasTag(text, "select-stream-binding-for-update")) {
        return result([{ stream_id: "another-receipt-stream" }]);
      }
      return undefined;
    };
    await expect(
      new PostgresIntegrationControlRepository(
        new ScenarioPool(bindingClient),
      ).persistReceipt(receiptInput()),
    ).resolves.toEqual({ outcome: "stream-binding-conflict" });

    const gapClient = new ScenarioClient();
    gapClient.handler = (text) => {
      if (hasTag(text, "select-intent-for-update")) {
        return result([intentRow()]);
      }
      if (hasTag(text, "select-stream-binding-for-update")) {
        return result([{ stream_id: "integration-control-receipts" }]);
      }
      if (hasTag(text, "select-stream-for-update")) {
        return result([{ contiguous_position: "1" }]);
      }
      return undefined;
    };
    await expect(
      new PostgresIntegrationControlRepository(
        new ScenarioPool(gapClient),
      ).persistReceipt(receiptInput("3")),
    ).resolves.toEqual({ outcome: "delivery-gap" });

    const deliveryClient = new ScenarioClient();
    deliveryClient.handler = (text) => {
      if (hasTag(text, "select-intent-for-update")) {
        return result([intentRow()]);
      }
      if (hasTag(text, "select-stream-binding-for-update")) {
        return result([{ stream_id: "integration-control-receipts" }]);
      }
      if (hasTag(text, "select-stream-for-update")) {
        return result([{ contiguous_position: "1" }]);
      }
      if (hasTag(text, "select-delivery")) {
        return result([
          {
            ...deliveryRow(),
            business_digest: `sha256:${"f".repeat(64)}`,
          },
        ]);
      }
      return undefined;
    };
    await expect(
      new PostgresIntegrationControlRepository(
        new ScenarioPool(deliveryClient),
      ).persistReceipt(receiptInput()),
    ).resolves.toEqual({ outcome: "delivery-conflict" });

    const receiptClient = new ScenarioClient();
    receiptClient.handler = (text) => {
      if (hasTag(text, "select-intent-for-update")) {
        return result([intentRow()]);
      }
      if (hasTag(text, "select-stream-binding-for-update")) {
        return result([{ stream_id: "integration-control-receipts" }]);
      }
      if (hasTag(text, "select-receipt-by-id")) {
        return result([
          receiptEvidenceRow(
            receiptInput("2", {
              delivery: {
                ...receiptInput("2").delivery,
                streamId: parseStreamId("integration-control-receipts"),
              },
            }),
          ),
        ]);
      }
      return undefined;
    };
    await expect(
      new PostgresIntegrationControlRepository(
        new ScenarioPool(receiptClient),
      ).persistReceipt(receiptInput()),
    ).resolves.toEqual({ outcome: "receipt-conflict" });
  });

  it("keeps provider acceptance separate from physical completion and job success", async () => {
    const input = receiptInput("2");
    const client = new ScenarioClient();
    client.handler = (text) => {
      if (hasTag(text, "select-intent-for-update")) {
        return result([intentRow()]);
      }
      if (hasTag(text, "select-stream-binding-for-update")) {
        return result([{ stream_id: input.delivery.streamId }]);
      }
      if (hasTag(text, "select-stream-for-update")) {
        return result([{ contiguous_position: "1" }]);
      }
      return undefined;
    };

    await expect(
      new PostgresIntegrationControlRepository(
        new ScenarioPool(client),
      ).persistReceipt(input),
    ).resolves.toMatchObject({
      outcome: "persisted",
      evidence: {
        providerAccepted: true,
        physicalCompleted: false,
        jobSucceeded: false,
      },
    });
    const insertReceipt = client.calls.find(({ text }) =>
      hasTag(text, "insert-receipt"),
    );
    expect(insertReceipt?.values).toContain(false);
  });

  it("returns stable scoped ordering for unresolved intents and dispatchable offers", async () => {
    const client = new ScenarioClient();
    client.handler = (text) => {
      if (hasTag(text, "list-unresolved-intents")) {
        return result([intentRow()]);
      }
      if (hasTag(text, "list-dispatchable-offers")) {
        return result([offerRow()]);
      }
      return undefined;
    };
    const repository = new PostgresIntegrationControlRepository(
      new ScenarioPool(client),
    );

    await expect(
      repository.listUnresolvedIntents(scope, gatewayId),
    ).resolves.toMatchObject([{ jobId }]);
    await expect(
      repository.listDispatchableOffers(scope, gatewayId),
    ).resolves.toMatchObject([{ eventId: offerRow().event_id }]);
    const intentQuery = client.calls.find(({ text }) =>
      hasTag(text, "list-unresolved-intents"),
    );
    const offerQuery = client.calls.find(({ text }) =>
      hasTag(text, "list-dispatchable-offers"),
    );
    expect(intentQuery?.text).toContain("ORDER BY created_at, job_id");
    expect(offerQuery?.text).toContain("ORDER BY sequence");
    expect(intentQuery?.values).toEqual([tenantId, projectId, gatewayId]);
  });

  it("marks offer publication idempotently inside the tenant and project boundary", async () => {
    const pendingClient = new ScenarioClient();
    pendingClient.handler = (text) =>
      hasTag(text, "select-offer-publish-for-update")
        ? result([offerRow()])
        : undefined;
    await expect(
      new PostgresIntegrationControlRepository(
        new ScenarioPool(pendingClient),
      ).markOfferPublished(scope, offerRow().event_id as string, now),
    ).resolves.toEqual({ outcome: "published" });
    expect(
      pendingClient.calls.some(({ text }) =>
        hasTag(text, "update-offer-published"),
      ),
    ).toBe(true);

    const publishedClient = new ScenarioClient();
    publishedClient.handler = (text) =>
      hasTag(text, "select-offer-publish-for-update")
        ? result([offerRow(offer(), "1", now)])
        : undefined;
    await expect(
      new PostgresIntegrationControlRepository(
        new ScenarioPool(publishedClient),
      ).markOfferPublished(scope, offerRow().event_id as string, now),
    ).resolves.toEqual({ outcome: "replayed" });
    expect(
      publishedClient.calls.some(({ text }) =>
        hasTag(text, "update-offer-published"),
      ),
    ).toBe(false);
  });

  it("strictly decodes JSONB reads and fails closed on injected database payloads", async () => {
    const client = new ScenarioClient();
    client.handler = (text) =>
      hasTag(text, "select-intent")
        ? result([
            {
              ...intentRow(),
              intent_payload: {
                ...offer().intent,
                arbitrary_service_call: {
                  domain: "shell_command",
                  service: "run",
                },
              },
            },
          ])
        : undefined;
    const repository = new PostgresIntegrationControlRepository(
      new ScenarioPool(client),
    );

    await expect(
      repository.findIntent(scope, gatewayId, jobId),
    ).resolves.toBeUndefined();
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("returns storage-unavailable and rolls back receipt writes on injected failure", async () => {
    const input = receiptInput();
    const client = new ScenarioClient();
    client.handler = (text) =>
      hasTag(text, "select-intent-for-update")
        ? result([intentRow()])
        : undefined;
    const repository = new PostgresIntegrationControlRepository(
      new ScenarioPool(client),
      {
        faultInjector: {
          afterStep(step) {
            if (step === "ack-written") {
              throw new Error("simulated crash before commit");
            }
          },
        },
      },
    );

    await expect(repository.persistReceipt(input)).resolves.toEqual({
      outcome: "storage-unavailable",
    });
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(client.calls.some(({ text }) => text === "COMMIT")).toBe(false);
  });
});
