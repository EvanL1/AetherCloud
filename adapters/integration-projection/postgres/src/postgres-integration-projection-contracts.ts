export interface PostgresIntegrationProjectionQueryResult<
  Row extends Record<string, unknown>,
> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface PostgresIntegrationProjectionClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresIntegrationProjectionQueryResult<Row>>;
  release(): void;
}

export interface PostgresIntegrationProjectionPool {
  connect(): Promise<PostgresIntegrationProjectionClient>;
}

export type PostgresIntegrationProjectionPersistenceStep =
  | "audit-written"
  | "cursor-written"
  | "delivery-written"
  | "delivery-attempt-written"
  | "durable-ack-written"
  | "identity-written"
  | "inbox-written"
  | "outbox-written"
  | "projection-written"
  | "stream-binding-written";

export interface PostgresIntegrationProjectionFaultInjector {
  afterStep?(
    step: PostgresIntegrationProjectionPersistenceStep,
  ): Promise<void> | void;
  beforeCommit?(): Promise<void> | void;
  afterCommit?(): Promise<void> | void;
}
