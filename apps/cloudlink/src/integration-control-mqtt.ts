import {
  IngestIntegrationControlReceipt,
  PublishIntegrationControlOffers,
  ReofferIntegrationPowerControls,
  type GatewayCredentialVerifier,
  type IntegrationControlApplicationClock,
  type IntegrationControlOfferPublisher,
  type IntegrationControlOfferSigner,
  type IntegrationControlReceiptAuthenticator,
  type IntegrationControlRepository,
  type IntegrationControlRuntimeProtocolReader,
  type IntegrationControlSessionReader,
} from "@aether-cloud/application";
import {
  encodeIntegrationControlActionOffer,
  mqttIntegrationControlOfferTopic,
} from "@aether-cloud/cloudlink-mqtt-adapter";

export interface IntegrationControlMqttPublisherTransport {
  publish(topic: string, payload: Uint8Array): Promise<void>;
}

export class MqttIntegrationControlOfferPublisher implements IntegrationControlOfferPublisher {
  readonly #topicPrefix: string;
  readonly #transport: IntegrationControlMqttPublisherTransport;

  constructor(input: {
    readonly topicPrefix: string;
    readonly transport: IntegrationControlMqttPublisherTransport;
  }) {
    this.#topicPrefix = input.topicPrefix;
    this.#transport = input.transport;
  }

  publish(
    offer: Parameters<IntegrationControlOfferPublisher["publish"]>[0],
  ): Promise<void> {
    return this.#transport.publish(
      mqttIntegrationControlOfferTopic(this.#topicPrefix, offer.gateway_id),
      encodeIntegrationControlActionOffer(offer),
    );
  }
}

export interface CloudLinkIntegrationControlCommand {
  execute(context: unknown, input: unknown): Promise<unknown>;
}

export interface CloudLinkIntegrationControlHandlers {
  readonly ingestReceipt: CloudLinkIntegrationControlCommand;
  readonly publishOffers: CloudLinkIntegrationControlCommand;
  readonly reoffer: CloudLinkIntegrationControlCommand;
}

export interface CloudLinkIntegrationControlFactory {
  create(
    publisher: IntegrationControlOfferPublisher,
  ): CloudLinkIntegrationControlHandlers;
}

export function createCloudLinkIntegrationControlFactory(dependencies: {
  readonly repository: IntegrationControlRepository;
  readonly sessions: IntegrationControlSessionReader;
  readonly manifests: IntegrationControlRuntimeProtocolReader;
  readonly credentialVerifier: GatewayCredentialVerifier;
  readonly authenticator: IntegrationControlReceiptAuthenticator;
  readonly signer: IntegrationControlOfferSigner;
  readonly clock: IntegrationControlApplicationClock;
}): CloudLinkIntegrationControlFactory {
  return Object.freeze({
    create(
      publisher: IntegrationControlOfferPublisher,
    ): CloudLinkIntegrationControlHandlers {
      return Object.freeze({
        ingestReceipt: new IngestIntegrationControlReceipt({
          repository: dependencies.repository,
          sessions: dependencies.sessions,
          credentialVerifier: dependencies.credentialVerifier,
          authenticator: dependencies.authenticator,
          clock: dependencies.clock,
        }),
        reoffer: new ReofferIntegrationPowerControls({
          repository: dependencies.repository,
          sessions: dependencies.sessions,
          manifests: dependencies.manifests,
          signer: dependencies.signer,
          clock: dependencies.clock,
          enabled: true,
        }),
        publishOffers: new PublishIntegrationControlOffers({
          repository: dependencies.repository,
          sessions: dependencies.sessions,
          manifests: dependencies.manifests,
          publisher,
          clock: dependencies.clock,
          enabled: true,
        }),
      });
    },
  });
}
