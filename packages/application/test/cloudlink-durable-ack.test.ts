import { describe, expect, it } from "vitest";

import {
  DeliverCloudLinkDurableAcknowledgements,
  type CloudLinkDurableAckDeliveryRepository,
  type CloudLinkDurableAckPublisher,
  type CloudLinkDurableAcknowledgement,
} from "../src/index.js";
import {
  parseCloudLinkSessionEpoch,
  parseCloudLinkSessionId,
  parseGatewayCredentialGeneration,
  parseGatewayId,
  parseProjectId,
  parseStreamEpoch,
  parseStreamId,
  parseStreamPosition,
  parseTenantId,
  parseUtcInstant,
} from "@aether-cloud/domain";

const tenantId = parseTenantId("11111111-1111-4111-8111-111111111111");
const projectId = parseProjectId("22222222-2222-4222-8222-222222222222");
const gatewayId = parseGatewayId("33333333-3333-4333-8333-333333333333");

function acknowledgement(
  outboxEventId = "outbox:cloudlink-ack:001",
): CloudLinkDurableAcknowledgement {
  return {
    outboxEventId,
    tenantId,
    projectId,
    gatewayId,
    sessionId: parseCloudLinkSessionId("44444444-4444-4444-8444-444444444444"),
    sessionEpoch: parseCloudLinkSessionEpoch("4"),
    credentialGeneration: parseGatewayCredentialGeneration("3"),
    streamId: parseStreamId("telemetry"),
    streamEpoch: parseStreamEpoch("4"),
    acknowledgedPosition: parseStreamPosition("7"),
    batchId: "batch-007",
    digest: `sha256:${"a".repeat(64)}`,
    receiptId: "receipt:cloudlink:batch-007",
    acknowledgedAt: parseUtcInstant("2026-07-16T01:00:00.000Z"),
  };
}

class StubRepository implements CloudLinkDurableAckDeliveryRepository {
  readonly marked: string[] = [];
  readonly released: Array<{ eventId: string; errorCode: string }> = [];
  acknowledgements: readonly CloudLinkDurableAcknowledgement[] = [
    acknowledgement(),
  ];
  claimUnavailable = false;
  markUnavailable = false;
  releaseUnavailable = false;
  claimCalls = 0;

  claimPending() {
    this.claimCalls += 1;
    return Promise.resolve(
      this.claimUnavailable
        ? ({ outcome: "storage-unavailable" } as const)
        : ({
            outcome: "claimed",
            acknowledgements: this.acknowledgements,
          } as const),
    );
  }

  markPublished(input: { readonly outboxEventId: string }) {
    if (this.markUnavailable) {
      return Promise.resolve("storage-unavailable" as const);
    }
    this.marked.push(input.outboxEventId);
    return Promise.resolve("marked" as const);
  }

  releaseForRetry(input: {
    readonly outboxEventId: string;
    readonly errorCode: string;
  }) {
    if (this.releaseUnavailable) {
      return Promise.resolve("storage-unavailable" as const);
    }
    this.released.push({
      eventId: input.outboxEventId,
      errorCode: input.errorCode,
    });
    return Promise.resolve("released" as const);
  }
}

class StubPublisher implements CloudLinkDurableAckPublisher {
  readonly published: CloudLinkDurableAcknowledgement[] = [];
  unavailable = false;
  throws = false;
  errorCode = "broker-unavailable";

  publish(value: CloudLinkDurableAcknowledgement) {
    this.published.push(value);
    if (this.throws) return Promise.reject(new Error("publisher failed"));
    return Promise.resolve(
      this.unavailable
        ? ({ outcome: "unavailable", errorCode: this.errorCode } as const)
        : ({ outcome: "published" } as const),
    );
  }
}

function deliveryInput() {
  return {
    tenantId,
    projectId,
    workerId: "cloudlink-ack-worker-01",
    now: parseUtcInstant("2026-07-16T01:01:00.000Z"),
    leaseExpiresAt: parseUtcInstant("2026-07-16T01:01:30.000Z"),
    retryAt: parseUtcInstant("2026-07-16T01:01:05.000Z"),
    limit: 10,
  };
}

describe("DeliverCloudLinkDurableAcknowledgements", () => {
  it("publishes claimed acknowledgements and marks them only after Broker success", async () => {
    const repository = new StubRepository();
    repository.acknowledgements = [
      acknowledgement("outbox:cloudlink-ack:001"),
      acknowledgement("outbox:cloudlink-ack:002"),
    ];
    const publisher = new StubPublisher();
    const delivery = new DeliverCloudLinkDurableAcknowledgements({
      repository,
      publisher,
    });

    await expect(delivery.execute(deliveryInput())).resolves.toEqual({
      outcome: "completed",
      claimed: 2,
      published: 2,
      deferred: 0,
    });
    expect(publisher.published).toEqual(repository.acknowledgements);
    expect(repository.marked).toEqual([
      "outbox:cloudlink-ack:001",
      "outbox:cloudlink-ack:002",
    ]);
    expect(repository.released).toEqual([]);
  });

  it("releases an identical acknowledgement for retry when publishing fails", async () => {
    const repository = new StubRepository();
    const publisher = new StubPublisher();
    publisher.unavailable = true;
    const delivery = new DeliverCloudLinkDurableAcknowledgements({
      repository,
      publisher,
    });

    await expect(delivery.execute(deliveryInput())).resolves.toEqual({
      outcome: "completed",
      claimed: 1,
      published: 0,
      deferred: 1,
    });
    expect(repository.marked).toEqual([]);
    expect(repository.released).toEqual([
      {
        eventId: "outbox:cloudlink-ack:001",
        errorCode: "broker-unavailable",
      },
    ]);
  });

  it("fails closed on claim or completion storage uncertainty", async () => {
    const unavailable = new StubRepository();
    unavailable.claimUnavailable = true;
    const publisher = new StubPublisher();
    await expect(
      new DeliverCloudLinkDurableAcknowledgements({
        repository: unavailable,
        publisher,
      }).execute(deliveryInput()),
    ).resolves.toEqual({ outcome: "storage-unavailable" });
    expect(publisher.published).toEqual([]);

    const uncertain = new StubRepository();
    uncertain.markUnavailable = true;
    await expect(
      new DeliverCloudLinkDurableAcknowledgements({
        repository: uncertain,
        publisher,
      }).execute(deliveryInput()),
    ).resolves.toEqual({ outcome: "storage-unavailable" });

    const releaseUncertain = new StubRepository();
    releaseUncertain.releaseUnavailable = true;
    const unavailablePublisher = new StubPublisher();
    unavailablePublisher.unavailable = true;
    await expect(
      new DeliverCloudLinkDurableAcknowledgements({
        repository: releaseUncertain,
        publisher: unavailablePublisher,
      }).execute(deliveryInput()),
    ).resolves.toEqual({ outcome: "storage-unavailable" });
  });

  it.each([
    { workerId: "short" },
    { limit: 0 },
    { limit: 101 },
    { leaseExpiresAt: parseUtcInstant("2026-07-16T01:01:00.000Z") },
    { retryAt: parseUtcInstant("2026-07-16T01:00:59.999Z") },
  ])(
    "rejects invalid bounded worker input without claiming",
    async (change) => {
      const repository = new StubRepository();
      const delivery = new DeliverCloudLinkDurableAcknowledgements({
        repository,
        publisher: new StubPublisher(),
      });

      await expect(
        delivery.execute({ ...deliveryInput(), ...change }),
      ).resolves.toEqual({ outcome: "invalid-input" });
      expect(repository.claimCalls).toBe(0);
    },
  );

  it("sanitizes publisher failures and retries thrown publications", async () => {
    const invalidCodeRepository = new StubRepository();
    const invalidCodePublisher = new StubPublisher();
    invalidCodePublisher.unavailable = true;
    invalidCodePublisher.errorCode = "UNSAFE internal details";
    await new DeliverCloudLinkDurableAcknowledgements({
      repository: invalidCodeRepository,
      publisher: invalidCodePublisher,
    }).execute(deliveryInput());
    expect(invalidCodeRepository.released[0]?.errorCode).toBe(
      "publisher-unavailable",
    );

    const thrownRepository = new StubRepository();
    const thrownPublisher = new StubPublisher();
    thrownPublisher.throws = true;
    await new DeliverCloudLinkDurableAcknowledgements({
      repository: thrownRepository,
      publisher: thrownPublisher,
    }).execute(deliveryInput());
    expect(thrownRepository.released[0]?.errorCode).toBe("publisher-exception");
  });

  it("rejects oversized, duplicate, and cross-scope repository claims", async () => {
    const oversized = new StubRepository();
    oversized.acknowledgements = Array.from({ length: 11 }, (_, index) =>
      acknowledgement(`outbox:cloudlink-ack:${String(index).padStart(3, "0")}`),
    );
    await expect(
      new DeliverCloudLinkDurableAcknowledgements({
        repository: oversized,
        publisher: new StubPublisher(),
      }).execute(deliveryInput()),
    ).resolves.toEqual({ outcome: "storage-unavailable" });

    const duplicate = new StubRepository();
    duplicate.acknowledgements = [acknowledgement(), acknowledgement()];
    await expect(
      new DeliverCloudLinkDurableAcknowledgements({
        repository: duplicate,
        publisher: new StubPublisher(),
      }).execute(deliveryInput()),
    ).resolves.toEqual({ outcome: "storage-unavailable" });

    const crossScope = new StubRepository();
    crossScope.acknowledgements = [
      {
        ...acknowledgement(),
        tenantId: parseTenantId("99999999-9999-4999-8999-999999999999"),
      },
    ];
    await expect(
      new DeliverCloudLinkDurableAcknowledgements({
        repository: crossScope,
        publisher: new StubPublisher(),
      }).execute(deliveryInput()),
    ).resolves.toEqual({ outcome: "storage-unavailable" });
  });
});
