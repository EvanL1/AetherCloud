import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

import {
  AcceptGatewaySignedCloudLinkSession,
  AuthenticateGatewaySignedCloudLinkUplink,
  RequestCloudLinkSessionChallenge,
  type ApplicationClock,
  type CloudLinkSessionIdGenerator,
  type CloudLinkUplinkEvaluationClock,
} from "../packages/application/src/index.js";
import {
  InMemoryGatewayCredentialVerifier,
  type InMemoryCloudLinkSessionRepository,
} from "../adapters/cloudlink/memory/src/index.js";
import {
  NodeCloudLinkSessionChallengeMaterialGenerator,
  NodeEd25519CloudLinkGatewayHelloAuthenticator,
  NodeEd25519CloudLinkSessionChallengeSigner,
  NodeEd25519CloudLinkUplinkVerifier,
} from "../adapters/cloudlink/node-crypto/src/index.js";
import {
  parseGatewayCredentialGeneration,
  type GatewayId,
  type ProjectId,
  type TenantId,
} from "../packages/domain/src/index.js";
import type { CloudLinkMqttIngressDependencies } from "../apps/cloudlink/src/index.js";

export const CLOUDLINK_DUAL_CREDENTIAL_ID = "development-integration-binding";
export const CLOUDLINK_DUAL_CREDENTIAL_GENERATION = "1";
export const CLOUDLINK_DUAL_CLOUD_KEY_ID = "development-cloud-key";
export const CLOUDLINK_DUAL_GATEWAY_KEY_ID = "development-integration-key";

const ed25519Pkcs8SeedPrefix = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

export type GatewaySignedSessionCommands = Required<
  Pick<
    CloudLinkMqttIngressDependencies,
    | "requestSessionChallenge"
    | "acceptGatewaySignedSession"
    | "authenticateGatewaySignedUplink"
    | "gatewaySignedScope"
  >
>;

function ed25519PrivateKeyFromSeed(seedByte: number): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([ed25519Pkcs8SeedPrefix, Buffer.alloc(32, seedByte)]),
    format: "der",
    type: "pkcs8",
  });
}

export function createCloudLinkDualSessionComposition(input: {
  readonly sessions: InMemoryCloudLinkSessionRepository;
  readonly clock: ApplicationClock & CloudLinkUplinkEvaluationClock;
  readonly sessionIds: CloudLinkSessionIdGenerator;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly gatewayId: GatewayId;
  readonly gatewayKeyId?: string;
  readonly gatewayPublicKey?: KeyObject;
}) {
  const credentialGeneration = parseGatewayCredentialGeneration(
    CLOUDLINK_DUAL_CREDENTIAL_GENERATION,
  );
  const credentialVerifier = new InMemoryGatewayCredentialVerifier([
    {
      assertion: {
        credentialId: CLOUDLINK_DUAL_CREDENTIAL_ID,
        proof: "B".repeat(86),
      },
      binding: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        gatewayId: input.gatewayId,
        generation: credentialGeneration,
        status: "active",
      },
    },
  ]);
  const cloudPrivateKey = ed25519PrivateKeyFromSeed(7);
  const gatewayKeyId = input.gatewayKeyId ?? CLOUDLINK_DUAL_GATEWAY_KEY_ID;
  const gatewayPublicKey =
    input.gatewayPublicKey ?? createPublicKey(ed25519PrivateKeyFromSeed(9));
  const requestSessionChallenge = new RequestCloudLinkSessionChallenge({
    repository: input.sessions,
    credentials: credentialVerifier,
    signer: new NodeEd25519CloudLinkSessionChallengeSigner({
      keyReference: CLOUDLINK_DUAL_CLOUD_KEY_ID,
      privateKey: cloudPrivateKey,
    }),
    materials: new NodeCloudLinkSessionChallengeMaterialGenerator(),
    clock: input.clock,
    supportedProtocolVersions: ["1.0"],
    enabled: true,
  });
  const acceptGatewaySignedSession = new AcceptGatewaySignedCloudLinkSession({
    repository: input.sessions,
    credentials: credentialVerifier,
    authenticator: new NodeEd25519CloudLinkGatewayHelloAuthenticator({
      resolvePublicKey(key) {
        return Promise.resolve(
          key.gatewayId === input.gatewayId &&
            key.credentialId === CLOUDLINK_DUAL_CREDENTIAL_ID &&
            key.credentialGeneration === credentialGeneration &&
            key.gatewayKeyId === gatewayKeyId
            ? gatewayPublicKey
            : undefined,
        );
      },
    }),
    clock: input.clock,
    sessionIds: input.sessionIds,
    supportedProtocolVersions: ["1.0"],
    enabled: true,
  });
  const authenticateGatewaySignedUplink =
    new AuthenticateGatewaySignedCloudLinkUplink({
      sessions: input.sessions,
      repository: input.sessions,
      verifier: new NodeEd25519CloudLinkUplinkVerifier({
        resolvePublicKey(key) {
          return Promise.resolve(
            key.tenantId === input.tenantId &&
              key.projectId === input.projectId &&
              key.gatewayId === input.gatewayId &&
              key.credentialGeneration === credentialGeneration &&
              key.gatewayKeyId === gatewayKeyId
              ? {
                  status: "active" as const,
                  publicKey: gatewayPublicKey,
                }
              : undefined,
          );
        },
      }),
      clock: input.clock,
      enabled: true,
    });

  const sessionCommands = Object.freeze({
    requestSessionChallenge,
    acceptGatewaySignedSession,
    authenticateGatewaySignedUplink,
    gatewaySignedScope: Object.freeze({
      tenantId: input.tenantId,
      projectId: input.projectId,
    }),
  }) satisfies GatewaySignedSessionCommands;

  return Object.freeze({
    credentialVerifier,
    sessionCommands,
  });
}
