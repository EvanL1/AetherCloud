export const DASHBOARD_BLOCK_IDS = [
  "fleet-health",
  "cloudlink-health",
  "enrollment-state",
  "telemetry-activity",
  "audit-activity",
  "api-status",
] as const;

export type DashboardBlockId = (typeof DASHBOARD_BLOCK_IDS)[number];
export type DashboardBlockSize = "full" | "half";

export interface DashboardBlockLayout {
  readonly id: DashboardBlockId;
  readonly size: DashboardBlockSize;
}

const defaultSizes = Object.freeze({
  "fleet-health": "half",
  "cloudlink-health": "half",
  "enrollment-state": "half",
  "telemetry-activity": "half",
  "audit-activity": "full",
  "api-status": "half",
} satisfies Readonly<Record<DashboardBlockId, DashboardBlockSize>>);

export const DEFAULT_DASHBOARD_LAYOUT: readonly DashboardBlockLayout[] =
  Object.freeze(
    DASHBOARD_BLOCK_IDS.filter((id) => id !== "api-status").map((id) =>
      Object.freeze({ id, size: defaultSizes[id] }),
    ),
  );

const dashboardBlockIds = new Set<string>(DASHBOARD_BLOCK_IDS);

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isDashboardBlockId(input: unknown): input is DashboardBlockId {
  return typeof input === "string" && dashboardBlockIds.has(input);
}

function isDashboardBlockSize(input: unknown): input is DashboardBlockSize {
  return input === "full" || input === "half";
}

export function decodeDashboardLayout(
  serialized: string | null,
): readonly DashboardBlockLayout[] {
  if (serialized === null) return DEFAULT_DASHBOARD_LAYOUT;
  try {
    const document: unknown = JSON.parse(serialized);
    if (
      !isRecord(document) ||
      document.schema !== "aether.cloud.console-dashboard.v1"
    ) {
      return DEFAULT_DASHBOARD_LAYOUT;
    }
    if (!Array.isArray(document.blocks)) return DEFAULT_DASHBOARD_LAYOUT;
    const seen = new Set<DashboardBlockId>();
    const blocks: DashboardBlockLayout[] = [];
    for (const input of document.blocks) {
      if (
        !isRecord(input) ||
        !isDashboardBlockId(input.id) ||
        !isDashboardBlockSize(input.size)
      ) {
        return DEFAULT_DASHBOARD_LAYOUT;
      }
      if (seen.has(input.id)) return DEFAULT_DASHBOARD_LAYOUT;
      seen.add(input.id);
      blocks.push(Object.freeze({ id: input.id, size: input.size }));
    }
    return Object.freeze(blocks);
  } catch {
    return DEFAULT_DASHBOARD_LAYOUT;
  }
}

export function encodeDashboardLayout(
  blocks: readonly DashboardBlockLayout[],
): string {
  return JSON.stringify({
    schema: "aether.cloud.console-dashboard.v1",
    blocks,
  });
}

export function dashboardStorageKey(
  tenantId: string,
  projectId: string,
): string {
  return `aethercloud.dashboard.v1:${tenantId}:${projectId}`;
}

export function reorderDashboardBlocks(
  blocks: readonly DashboardBlockLayout[],
  sourceId: DashboardBlockId,
  targetId: DashboardBlockId,
): readonly DashboardBlockLayout[] {
  const sourceIndex = blocks.findIndex((block) => block.id === sourceId);
  const targetIndex = blocks.findIndex((block) => block.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return blocks;
  }
  const next = [...blocks];
  const [source] = next.splice(sourceIndex, 1);
  if (source === undefined) return blocks;
  next.splice(targetIndex, 0, source);
  return Object.freeze(next);
}

export function resizeDashboardBlock(
  blocks: readonly DashboardBlockLayout[],
  blockId: DashboardBlockId,
  size: DashboardBlockSize,
): readonly DashboardBlockLayout[] {
  return Object.freeze(
    blocks.map((block) =>
      block.id === blockId ? Object.freeze({ ...block, size }) : block,
    ),
  );
}

export function removeDashboardBlock(
  blocks: readonly DashboardBlockLayout[],
  blockId: DashboardBlockId,
): readonly DashboardBlockLayout[] {
  return Object.freeze(blocks.filter((block) => block.id !== blockId));
}

export function addDashboardBlock(
  blocks: readonly DashboardBlockLayout[],
  blockId: DashboardBlockId,
): readonly DashboardBlockLayout[] {
  if (blocks.some((block) => block.id === blockId)) return blocks;
  return Object.freeze([
    ...blocks,
    Object.freeze({ id: blockId, size: defaultSizes[blockId] }),
  ]);
}
