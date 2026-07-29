export interface PostgresAuditQueryResult<Row extends Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface PostgresAuditClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresAuditQueryResult<Row>>;
  release(): void;
}

export interface PostgresAuditPool {
  connect(): Promise<PostgresAuditClient>;
}
