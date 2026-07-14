import type { InfrastructureResourceChange } from "@aether-cloud/application";

export interface ParsedOpenTofuPlan {
  readonly formatVersion: string;
  readonly resourceChanges: readonly InfrastructureResourceChange[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const supportedActions = new Set([
  "create",
  "delete",
  "no-op",
  "read",
  "update",
]);

function parseActions(
  value: unknown,
): InfrastructureResourceChange["actions"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions: string[] = [];
  for (const action of value) {
    if (typeof action !== "string") return undefined;
    actions.push(action === "noop" ? "no-op" : action);
  }
  if (
    (actions.length === 1 && supportedActions.has(actions[0] ?? "")) ||
    (actions.length === 2 &&
      ((actions[0] === "delete" && actions[1] === "create") ||
        (actions[0] === "create" && actions[1] === "delete")))
  ) {
    return Object.freeze(actions as InfrastructureResourceChange["actions"]);
  }
  return undefined;
}

export function parseOpenTofuPlan(
  content: Uint8Array,
): ParsedOpenTofuPlan | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(content),
    );
  } catch {
    return undefined;
  }
  const plan = record(parsed);
  if (
    plan === undefined ||
    typeof plan.format_version !== "string" ||
    !/^1\.[0-9]+$/.test(plan.format_version)
  ) {
    return undefined;
  }
  const rawChanges = plan.resource_changes ?? [];
  if (!Array.isArray(rawChanges)) return undefined;

  const resourceChanges: InfrastructureResourceChange[] = [];
  for (const rawChange of rawChanges) {
    const change = record(rawChange);
    const details = record(change?.change);
    const actions = parseActions(details?.actions);
    if (
      change === undefined ||
      typeof change.address !== "string" ||
      change.address.length === 0 ||
      typeof change.type !== "string" ||
      change.type.length === 0 ||
      actions === undefined
    ) {
      return undefined;
    }
    resourceChanges.push(
      Object.freeze({
        address: change.address,
        providerResourceType: change.type,
        actions,
      }),
    );
  }
  return Object.freeze({
    formatVersion: plan.format_version,
    resourceChanges: Object.freeze(resourceChanges),
  });
}
