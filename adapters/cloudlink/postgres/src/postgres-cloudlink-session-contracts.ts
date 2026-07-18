export interface PostgresCloudLinkSessionQueryResult<
  Row extends Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface PostgresCloudLinkSessionClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresCloudLinkSessionQueryResult<Row>>;
  release(): void;
}

export interface PostgresCloudLinkSessionPool {
  connect(): Promise<PostgresCloudLinkSessionClient>;
}

export class CloudLinkPostgresStorageError extends Error {
  constructor() {
    super("CloudLink PostgreSQL operation failed");
    this.name = "CloudLinkPostgresStorageError";
  }
}
