import type {
  ArtifactContentStore,
  ArtifactPublicationInput,
  ArtifactPublicationResult,
  ArtifactRegistryRepository,
  ArtifactScope,
  ArtifactSignatureVerifier,
} from "@aether-cloud/application";
import type {
  ArtifactContentLength,
  ArtifactId,
  ArtifactRevision,
  ArtifactRevisionId,
  ContentDigest,
} from "@aether-cloud/domain";
import {
  parseArtifactContentLength,
  parseContentDigest,
} from "@aether-cloud/domain";

export interface InMemoryArtifactAuditEvent {
  readonly eventId: string;
  readonly kind: "artifact-revision-published";
  readonly subjectId: string;
  readonly revisionId: ArtifactRevisionId;
}

export interface InMemoryArtifactOutboxEvent {
  readonly eventId: string;
  readonly eventName: "artifact.revision-published.v1";
  readonly revisionId: ArtifactRevisionId;
}

interface StoredRequest {
  readonly fingerprint: string;
  readonly revision: ArtifactRevision;
}

function scopeKey(scope: ArtifactScope): string {
  return `${scope.tenantId}:${scope.projectId}`;
}

function revisionKey(
  scope: ArtifactScope,
  artifactId: ArtifactId,
  revisionId: ArtifactRevisionId,
): string {
  return `${scopeKey(scope)}:${artifactId}:${revisionId}`;
}

function channelKey(
  scope: ArtifactScope,
  artifactId: ArtifactId,
  channel: string,
): string {
  return `${scopeKey(scope)}:${artifactId}:${channel}`;
}

function requestKey(input: ArtifactPublicationInput): string {
  return `${scopeKey(input)}:${input.requestId}`;
}

function publicationFingerprint(input: ArtifactPublicationInput): string {
  return [
    input.revision.artifactId,
    input.revision.revisionId,
    input.revision.contentDigest,
    input.releaseChannel,
  ].join(":");
}

export class InMemoryArtifactRegistry
  implements
    ArtifactRegistryRepository,
    ArtifactContentStore,
    ArtifactSignatureVerifier
{
  readonly #revisions = new Map<string, ArtifactRevision>();
  readonly #channels = new Map<string, ArtifactRevision>();
  readonly #requests = new Map<string, StoredRequest>();
  readonly #content = new Map<ContentDigest, ArtifactContentLength>();
  readonly #trustedSignatures = new Set<string>();
  readonly #auditEvents: InMemoryArtifactAuditEvent[] = [];
  readonly #outboxEvents: InMemoryArtifactOutboxEvent[] = [];
  #failNext = false;

  publish(input: ArtifactPublicationInput): Promise<ArtifactPublicationResult> {
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.resolve({ outcome: "storage-unavailable" });
    }
    const requestIdentity = requestKey(input);
    const fingerprint = publicationFingerprint(input);
    const priorRequest = this.#requests.get(requestIdentity);
    if (priorRequest !== undefined) {
      return Promise.resolve(
        priorRequest.fingerprint === fingerprint
          ? { outcome: "replayed", revision: priorRequest.revision }
          : { outcome: "idempotency-conflict" },
      );
    }

    const identity = revisionKey(
      input,
      input.revision.artifactId,
      input.revision.revisionId,
    );
    if (this.#revisions.has(identity)) {
      return Promise.resolve({ outcome: "revision-conflict" });
    }
    const channelIdentity = channelKey(
      input,
      input.revision.artifactId,
      input.releaseChannel,
    );
    const channelRevision = this.#channels.get(channelIdentity);
    if (
      channelRevision !== undefined &&
      channelRevision.revisionId !== input.revision.revisionId
    ) {
      return Promise.resolve({ outcome: "channel-conflict" });
    }

    this.#revisions.set(identity, input.revision);
    this.#channels.set(channelIdentity, input.revision);
    this.#requests.set(requestIdentity, {
      fingerprint,
      revision: input.revision,
    });
    const suffix = `${scopeKey(input)}:${input.revision.revisionId}`;
    this.#auditEvents.push(
      Object.freeze({
        eventId: `audit:artifact:${suffix}`,
        kind: "artifact-revision-published",
        subjectId: input.subjectId,
        revisionId: input.revision.revisionId,
      }),
    );
    this.#outboxEvents.push(
      Object.freeze({
        eventId: `outbox:artifact:${suffix}`,
        eventName: "artifact.revision-published.v1",
        revisionId: input.revision.revisionId,
      }),
    );
    return Promise.resolve({
      outcome: "published",
      revision: input.revision,
    });
  }

  findRevision(
    scope: ArtifactScope,
    artifactId: ArtifactId,
    revisionId: ArtifactRevisionId,
  ): Promise<ArtifactRevision | undefined> {
    return Promise.resolve(
      this.#revisions.get(revisionKey(scope, artifactId, revisionId)),
    );
  }

  findChannel(
    scope: ArtifactScope,
    artifactId: ArtifactId,
    releaseChannel: string,
  ): Promise<ArtifactRevision | undefined> {
    return Promise.resolve(
      this.#channels.get(channelKey(scope, artifactId, releaseChannel)),
    );
  }

  verifyContent(input: {
    readonly digest: ContentDigest;
    readonly byteLength: ArtifactContentLength;
  }): Promise<
    Readonly<{
      outcome: "digest-mismatch" | "missing" | "unavailable" | "verified";
    }>
  > {
    const length = this.#content.get(input.digest);
    if (length === undefined) return Promise.resolve({ outcome: "missing" });
    return Promise.resolve({
      outcome: length === input.byteLength ? "verified" : "digest-mismatch",
    });
  }

  verifySignature(input: {
    readonly contentDigest: ContentDigest;
    readonly signatureDigest: ContentDigest;
    readonly keyId: string;
    readonly algorithm: "ed25519";
  }): Promise<Readonly<{ outcome: "invalid" | "unavailable" | "verified" }>> {
    return Promise.resolve({
      outcome: this.#trustedSignatures.has(
        `${input.contentDigest}:${input.signatureDigest}`,
      )
        ? "verified"
        : "invalid",
    });
  }

  putContent(input: {
    readonly digest: string;
    readonly byteLength: string;
  }): void {
    this.#content.set(
      parseContentDigest(input.digest),
      parseArtifactContentLength(input.byteLength),
    );
  }

  trustSignature(input: {
    readonly contentDigest: string;
    readonly signatureDigest: string;
  }): void {
    this.#trustedSignatures.add(
      `${parseContentDigest(input.contentDigest)}:${parseContentDigest(input.signatureDigest)}`,
    );
  }

  failNextPersistence(): void {
    this.#failNext = true;
  }

  revisionCount(): number {
    return this.#revisions.size;
  }

  auditEvents(): readonly InMemoryArtifactAuditEvent[] {
    return Object.freeze([...this.#auditEvents]);
  }

  pendingOutboxEvents(): readonly InMemoryArtifactOutboxEvent[] {
    return Object.freeze([...this.#outboxEvents]);
  }
}
