import type {
  ArtifactId,
  ArtifactRevision,
  ArtifactRevisionId,
  ArtifactSignature,
  ContentDigest,
  ProjectId,
  TenantId,
  UtcInstant,
} from "@aether-cloud/domain";

export interface ArtifactScope {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

export interface ArtifactPublicationRequest extends ArtifactScope {
  readonly requestId: string;
  readonly subjectId: string;
  readonly revision: ArtifactRevision;
  readonly releaseChannel: string;
  readonly publishedAt: UtcInstant;
}

export type ArtifactPublicationPersistenceResult =
  | Readonly<{ outcome: "channel-conflict" }>
  | Readonly<{ outcome: "idempotency-conflict" }>
  | Readonly<{ outcome: "published"; revision?: ArtifactRevision }>
  | Readonly<{ outcome: "replayed"; revision: ArtifactRevision }>
  | Readonly<{ outcome: "revision-conflict" }>
  | Readonly<{ outcome: "storage-unavailable" }>;

export interface ArtifactRegistryRepository {
  publish(
    request: ArtifactPublicationRequest,
  ): Promise<ArtifactPublicationPersistenceResult>;
  findRevision(
    scope: ArtifactScope,
    artifactId: ArtifactId,
    revisionId: ArtifactRevisionId,
  ): Promise<ArtifactRevision | undefined>;
  findChannel(
    scope: ArtifactScope,
    artifactId: ArtifactId,
    releaseChannel: string,
  ): Promise<ArtifactRevision | undefined>;
}

export type ArtifactPublicationInput = ArtifactPublicationRequest;
export type ArtifactPublicationResult = ArtifactPublicationPersistenceResult;

export type ArtifactContentVerificationResult =
  | Readonly<{ outcome: "digest-mismatch" }>
  | Readonly<{ outcome: "missing" }>
  | Readonly<{ outcome: "unavailable" }>
  | Readonly<{ outcome: "verified" }>;

export interface ArtifactContentStore {
  verifyContent(input: {
    readonly digest: ContentDigest;
    readonly byteLength: string;
  }): Promise<ArtifactContentVerificationResult>;
}

export type ArtifactSignatureVerificationResult =
  | Readonly<{ outcome: "invalid" }>
  | Readonly<{ outcome: "unavailable" }>
  | Readonly<{ outcome: "verified" }>;

export interface ArtifactSignatureVerifier {
  verifySignature(input: {
    readonly contentDigest: ContentDigest;
    readonly signatureDigest: ContentDigest;
    readonly keyId: string;
    readonly algorithm: ArtifactSignature["algorithm"];
  }): Promise<ArtifactSignatureVerificationResult>;
}
