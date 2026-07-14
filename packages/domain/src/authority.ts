export type Authority = "aether-cloud" | "edge" | "provider";

const authorityByConcern = {
  "actual-infrastructure-state": "provider",
  "desired-revision": "aether-cloud",
  "deterministic-automation": "edge",
  "fleet-membership": "aether-cloud",
  "live-point-state": "edge",
  "placement-policy": "aether-cloud",
  "physical-control": "edge",
  "tenant-identity": "aether-cloud",
} as const satisfies Readonly<Record<string, Authority>>;

export type AuthorityConcern = keyof typeof authorityByConcern;

export function authorityFor<Concern extends AuthorityConcern>(
  concern: Concern,
): (typeof authorityByConcern)[Concern] {
  return authorityByConcern[concern];
}
