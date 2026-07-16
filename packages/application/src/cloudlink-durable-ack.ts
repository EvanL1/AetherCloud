import type {
  CloudLinkDurableAckDeliveryRepository,
  CloudLinkDurableAckLeaseInput,
  CloudLinkDurableAckPublisher,
} from "./cloudlink-durable-ack-repository.js";

export interface CloudLinkDurableAckDeliveryInput extends CloudLinkDurableAckLeaseInput {
  readonly retryAt: CloudLinkDurableAckLeaseInput["now"];
}

export type CloudLinkDurableAckDeliveryResult =
  | Readonly<{
      outcome: "completed";
      claimed: number;
      published: number;
      deferred: number;
    }>
  | Readonly<{ outcome: "invalid-input" }>
  | Readonly<{ outcome: "storage-unavailable" }>;

const workerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const errorCodePattern = /^[a-z][a-z0-9-]{0,63}$/;

function validInput(input: CloudLinkDurableAckDeliveryInput): boolean {
  return (
    workerIdPattern.test(input.workerId) &&
    Number.isInteger(input.limit) &&
    input.limit >= 1 &&
    input.limit <= 100 &&
    input.leaseExpiresAt > input.now &&
    input.retryAt >= input.now
  );
}

function safeErrorCode(input: string): string {
  return errorCodePattern.test(input) ? input : "publisher-unavailable";
}

export class DeliverCloudLinkDurableAcknowledgements {
  readonly #repository: CloudLinkDurableAckDeliveryRepository;
  readonly #publisher: CloudLinkDurableAckPublisher;

  constructor(dependencies: {
    readonly repository: CloudLinkDurableAckDeliveryRepository;
    readonly publisher: CloudLinkDurableAckPublisher;
  }) {
    this.#repository = dependencies.repository;
    this.#publisher = dependencies.publisher;
  }

  async execute(
    input: CloudLinkDurableAckDeliveryInput,
  ): Promise<CloudLinkDurableAckDeliveryResult> {
    if (!validInput(input)) return { outcome: "invalid-input" };
    const claimed = await this.#repository.claimPending(input);
    if (claimed.outcome === "storage-unavailable") return claimed;
    if (claimed.acknowledgements.length > input.limit) {
      return { outcome: "storage-unavailable" };
    }
    const eventIds = new Set<string>();
    for (const acknowledgement of claimed.acknowledgements) {
      if (
        acknowledgement.tenantId !== input.tenantId ||
        acknowledgement.projectId !== input.projectId ||
        eventIds.has(acknowledgement.outboxEventId)
      ) {
        return { outcome: "storage-unavailable" };
      }
      eventIds.add(acknowledgement.outboxEventId);
    }

    let published = 0;
    let deferred = 0;
    for (const acknowledgement of claimed.acknowledgements) {
      let publication:
        | Awaited<ReturnType<CloudLinkDurableAckPublisher["publish"]>>
        | undefined;
      try {
        publication = await this.#publisher.publish(acknowledgement);
      } catch {
        publication = {
          outcome: "unavailable",
          errorCode: "publisher-exception",
        };
      }
      if (publication.outcome === "published") {
        const marked = await this.#repository.markPublished({
          tenantId: input.tenantId,
          projectId: input.projectId,
          workerId: input.workerId,
          outboxEventId: acknowledgement.outboxEventId,
          publishedAt: input.now,
        });
        if (marked !== "marked") return { outcome: "storage-unavailable" };
        published += 1;
        continue;
      }
      const released = await this.#repository.releaseForRetry({
        tenantId: input.tenantId,
        projectId: input.projectId,
        workerId: input.workerId,
        outboxEventId: acknowledgement.outboxEventId,
        retryAt: input.retryAt,
        errorCode: safeErrorCode(publication.errorCode),
      });
      if (released !== "released") return { outcome: "storage-unavailable" };
      deferred += 1;
    }
    return {
      outcome: "completed",
      claimed: claimed.acknowledgements.length,
      published,
      deferred,
    };
  }
}
