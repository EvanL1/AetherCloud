export interface PostgresTelemetryQueryResult<
  Row extends Record<string, unknown>,
> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface PostgresTelemetryClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresTelemetryQueryResult<Row>>;
  release(): void;
}

export interface PostgresTelemetryPool {
  connect(): Promise<PostgresTelemetryClient>;
}

export interface PostgresTelemetryFaultInjector {
  beforeCommit?(): Promise<void> | void;
  afterCommit?(): Promise<void> | void;
}
