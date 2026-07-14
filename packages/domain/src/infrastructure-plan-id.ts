const infrastructurePlanIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

declare const infrastructurePlanIdBrand: unique symbol;
export type InfrastructurePlanId = string & {
  readonly [infrastructurePlanIdBrand]: true;
};

export class InvalidInfrastructurePlanIdError extends Error {
  readonly code = "invalid-infrastructure-plan-id";

  constructor() {
    super("infrastructure plan id must be a canonical lowercase UUID");
    this.name = "InvalidInfrastructurePlanIdError";
  }
}

export function parseInfrastructurePlanId(
  input: unknown,
): InfrastructurePlanId {
  if (typeof input !== "string" || !infrastructurePlanIdPattern.test(input)) {
    throw new InvalidInfrastructurePlanIdError();
  }
  return input as InfrastructurePlanId;
}
