export interface PostgresIntegrationControlQueryResult<
  Row extends Record<string, unknown>,
> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface PostgresIntegrationControlClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresIntegrationControlQueryResult<Row>>;
  release(): void;
}

export interface PostgresIntegrationControlPool {
  connect(): Promise<PostgresIntegrationControlClient>;
}

export type PostgresIntegrationControlPersistenceStep =
  | "ack-written"
  | "audit-written"
  | "cursor-written"
  | "delivery-written"
  | "intent-updated"
  | "intent-written"
  | "offer-published"
  | "offer-written"
  | "receipt-written"
  | "request-written"
  | "stream-binding-written"
  | "stream-written";

export interface PostgresIntegrationControlFaultInjector {
  afterStep?(
    step: PostgresIntegrationControlPersistenceStep,
  ): Promise<void> | void;
  beforeCommit?(): Promise<void> | void;
  afterCommit?(): Promise<void> | void;
}
