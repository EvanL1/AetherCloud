import { useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";

import type {
  AuditSearchResponse,
  FleetGatewayView,
  FleetListResponse,
} from "./api-client.js";
import {
  DASHBOARD_BLOCK_IDS,
  addDashboardBlock,
  dashboardStorageKey,
  decodeDashboardLayout,
  encodeDashboardLayout,
  removeDashboardBlock,
  reorderDashboardBlocks,
  resizeDashboardBlock,
} from "./dashboard-layout.js";
import type {
  DashboardBlockId,
  DashboardBlockLayout,
} from "./dashboard-layout.js";

export type DashboardApiState =
  | "checking"
  | "connected"
  | "denied"
  | "unavailable";

interface CustomDashboardProps {
  readonly apiState: DashboardApiState;
  readonly audit: AuditSearchResponse | undefined;
  readonly fleet: FleetListResponse | undefined;
  readonly loading: boolean;
  readonly projectId: string;
  readonly tenantId: string;
  readonly onNavigate: (view: "audit" | "fleet") => void;
  readonly onRefresh: () => void;
}

const blockCatalog = Object.freeze({
  "fleet-health": {
    title: "Fleet health",
    description: "已加载网关的连接状态",
  },
  "cloudlink-health": {
    title: "CloudLink observation",
    description: "云端持久化的会话与心跳证据",
  },
  "enrollment-state": {
    title: "Enrollment",
    description: "注册、等待 Claim 与已配对身份",
  },
  "telemetry-activity": {
    title: "Telemetry activity",
    description: "当前 Fleet 投影中的持久化遥测",
  },
  "audit-activity": {
    title: "Recent audit events",
    description: "当前查询窗口中的最新治理事件",
  },
  "api-status": {
    title: "Control plane",
    description: "Console 到生产 API 的观测状态",
  },
} satisfies Readonly<
  Record<DashboardBlockId, Readonly<{ title: string; description: string }>>
>);

function loadStoredLayout(storageKey: string): readonly DashboardBlockLayout[] {
  if (typeof window === "undefined") return decodeDashboardLayout(null);
  try {
    return decodeDashboardLayout(window.localStorage.getItem(storageKey));
  } catch {
    return decodeDashboardLayout(null);
  }
}

function persistLayout(
  storageKey: string,
  blocks: readonly DashboardBlockLayout[],
): void {
  try {
    window.localStorage.setItem(storageKey, encodeDashboardLayout(blocks));
  } catch {
    // Browser storage is a preference optimization, never an availability boundary.
  }
}

function loadedGateways(
  fleet: FleetListResponse | undefined,
): readonly FleetGatewayView[] {
  return fleet?.items ?? [];
}

function countStatus(
  gateways: readonly FleetGatewayView[],
  status: FleetGatewayView["connection"]["status"],
): number {
  return gateways.filter((gateway) => gateway.connection.status === status)
    .length;
}

function Stat({
  label,
  value,
  tone,
}: Readonly<{
  label: string;
  value: number | string;
  tone?: "danger" | "success" | "warning";
}>): React.JSX.Element {
  return (
    <div
      className={`dashboard-stat${tone === undefined ? "" : ` stat-${tone}`}`}
    >
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EmptyBlock({ children }: React.PropsWithChildren): React.JSX.Element {
  return <p className="dashboard-empty">{children}</p>;
}

function FleetHealthBlock({
  fleet,
}: Readonly<{ fleet: FleetListResponse | undefined }>): React.JSX.Element {
  const gateways = loadedGateways(fleet);
  const online = countStatus(gateways, "online");
  const stale = countStatus(gateways, "stale");
  const offline =
    countStatus(gateways, "offline") + countStatus(gateways, "never-connected");
  return (
    <>
      <div className="dashboard-stat-grid">
        <Stat label="已加载" value={gateways.length} />
        <Stat label="在线" tone="success" value={online} />
        <Stat label="异常" tone="warning" value={stale} />
        <Stat label="离线 / 未连接" tone="danger" value={offline} />
      </div>
      {fleet?.nextCursor === null || fleet?.nextCursor === undefined ? null : (
        <small className="dashboard-evidence-note">
          还有更多 Fleet 分页；本 Block 只统计当前已加载项目。
        </small>
      )}
    </>
  );
}

function CloudLinkBlock({
  fleet,
}: Readonly<{ fleet: FleetListResponse | undefined }>): React.JSX.Element {
  const gateways = loadedGateways(fleet);
  const active = gateways.filter(
    (gateway) => gateway.connection.reason === "heartbeat-current",
  ).length;
  const overdue = gateways.filter(
    (gateway) =>
      gateway.connection.reason === "heartbeat-overdue" ||
      gateway.connection.reason === "session-suspect",
  ).length;
  const negotiating = gateways.filter(
    (gateway) =>
      gateway.connection.reason === "session-negotiating" ||
      gateway.connection.reason === "session-resuming" ||
      gateway.connection.reason === "heartbeat-pending",
  ).length;
  return gateways.length === 0 ? (
    <EmptyBlock>还没有可观测的 Gateway。</EmptyBlock>
  ) : (
    <div className="dashboard-stat-grid dashboard-stat-grid-three">
      <Stat label="心跳有效" tone="success" value={active} />
      <Stat label="协商 / 恢复" value={negotiating} />
      <Stat label="超时 / 可疑" tone="warning" value={overdue} />
    </div>
  );
}

function EnrollmentBlock({
  fleet,
}: Readonly<{ fleet: FleetListResponse | undefined }>): React.JSX.Element {
  const gateways = loadedGateways(fleet);
  const claimed = gateways.filter(
    (gateway) => gateway.enrollmentState === "claimed",
  ).length;
  const waiting = gateways.filter(
    (gateway) => gateway.enrollmentState === "awaiting-claim",
  ).length;
  const registered = gateways.filter(
    (gateway) => gateway.enrollmentState === "registered",
  ).length;
  return (
    <div className="dashboard-stat-grid dashboard-stat-grid-three">
      <Stat label="身份已配对" tone="success" value={claimed} />
      <Stat label="等待 Claim" tone="warning" value={waiting} />
      <Stat label="仅注册" value={registered} />
    </div>
  );
}

function TelemetryBlock({
  fleet,
}: Readonly<{ fleet: FleetListResponse | undefined }>): React.JSX.Element {
  const gateways = loadedGateways(fleet);
  const receiving = gateways.filter(
    (gateway) => gateway.telemetry.status === "receiving",
  );
  const records = receiving.reduce(
    (total, gateway) => total + BigInt(gateway.telemetry.recordCount),
    0n,
  );
  const newest = receiving
    .map((gateway) => gateway.telemetry.lastReceivedAt)
    .filter((value): value is string => value !== undefined)
    .sort()
    .at(-1);
  return (
    <div className="dashboard-stat-grid dashboard-stat-grid-three">
      <Stat label="正在接收" tone="success" value={receiving.length} />
      <Stat label="持久化记录" value={records.toLocaleString("zh-CN")} />
      <Stat
        label="最近到达"
        value={
          newest === undefined
            ? "—"
            : new Date(newest).toLocaleTimeString("zh-CN")
        }
      />
    </div>
  );
}

function AuditBlock({
  audit,
}: Readonly<{ audit: AuditSearchResponse | undefined }>): React.JSX.Element {
  if (audit === undefined || audit.items.length === 0) {
    return <EmptyBlock>当前查询窗口还没有审计事件。</EmptyBlock>;
  }
  return (
    <div className="dashboard-audit-list">
      {audit.items.slice(0, 5).map((event) => (
        <div key={event.eventId}>
          <span className={`audit-dot audit-dot-${event.outcome}`} />
          <strong>{event.action}</strong>
          <small>{event.resource.kind}</small>
          <time dateTime={event.occurredAt}>
            {new Date(event.occurredAt).toLocaleString("zh-CN")}
          </time>
        </div>
      ))}
    </div>
  );
}

function ApiStatusBlock({
  apiState,
}: Readonly<{ apiState: DashboardApiState }>): React.JSX.Element {
  const label =
    apiState === "connected"
      ? "API 已连接"
      : apiState === "checking"
        ? "正在检查"
        : apiState === "denied"
          ? "权限不足"
          : "API 不可用";
  return (
    <div className={`dashboard-api-state dashboard-api-${apiState}`}>
      <span aria-hidden="true" />
      <div>
        <strong>{label}</strong>
        <small>来自当前浏览器会话的实时请求结果</small>
      </div>
    </div>
  );
}

function BlockBody({
  blockId,
  apiState,
  audit,
  fleet,
}: Readonly<{
  blockId: DashboardBlockId;
  apiState: DashboardApiState;
  audit: AuditSearchResponse | undefined;
  fleet: FleetListResponse | undefined;
}>): React.JSX.Element {
  if (blockId === "fleet-health") return <FleetHealthBlock fleet={fleet} />;
  if (blockId === "cloudlink-health") return <CloudLinkBlock fleet={fleet} />;
  if (blockId === "enrollment-state") return <EnrollmentBlock fleet={fleet} />;
  if (blockId === "telemetry-activity") return <TelemetryBlock fleet={fleet} />;
  if (blockId === "audit-activity") return <AuditBlock audit={audit} />;
  return <ApiStatusBlock apiState={apiState} />;
}

export function CustomDashboard({
  apiState,
  audit,
  fleet,
  loading,
  projectId,
  tenantId,
  onNavigate,
  onRefresh,
}: CustomDashboardProps): React.JSX.Element {
  const storageKey = useMemo(
    () => dashboardStorageKey(tenantId, projectId),
    [projectId, tenantId],
  );
  const [blocks, setBlocks] = useState<readonly DashboardBlockLayout[]>(() =>
    loadStoredLayout(storageKey),
  );
  const [adding, setAdding] = useState(false);
  const available = DASHBOARD_BLOCK_IDS.filter(
    (id) => !blocks.some((block) => block.id === id),
  );

  useEffect(() => {
    persistLayout(storageKey, blocks);
  }, [blocks, storageKey]);

  function drop(
    event: DragEvent<HTMLElement>,
    targetId: DashboardBlockId,
  ): void {
    event.preventDefault();
    const source = event.dataTransfer.getData(
      "application/x-aethercloud-block",
    );
    if (!DASHBOARD_BLOCK_IDS.some((id) => id === source)) return;
    setBlocks((current) =>
      reorderDashboardBlocks(current, source as DashboardBlockId, targetId),
    );
  }

  function move(blockId: DashboardBlockId, offset: -1 | 1): void {
    const index = blocks.findIndex((block) => block.id === blockId);
    const target = blocks[index + offset];
    if (target === undefined) return;
    setBlocks((current) => reorderDashboardBlocks(current, blockId, target.id));
  }

  return (
    <div className="dashboard-view">
      <section className="dashboard-toolbar">
        <div>
          <p className="eyebrow">OPERATOR DASHBOARD</p>
          <h1>总览</h1>
          <p>组合当前项目最重要的真实云端证据。</p>
        </div>
        <div className="dashboard-actions">
          <button
            className="outline-button"
            onClick={() => {
              setAdding((current) => !current);
            }}
            type="button"
          >
            <span aria-hidden="true">＋</span> 添加 Block
          </button>
          <span className="snapshot-chip">当前快照</span>
          <button
            aria-label="刷新 Dashboard"
            className="outline-button dashboard-refresh"
            disabled={loading}
            onClick={onRefresh}
            type="button"
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </section>

      {adding ? (
        <section className="surface block-picker" aria-label="可添加的 Block">
          <div>
            <strong>添加 Block</strong>
            <small>只列出当前项目已有真实数据来源的组件。</small>
          </div>
          {available.length === 0 ? (
            <p>所有 Block 都已添加。</p>
          ) : (
            <div>
              {available.map((blockId) => (
                <button
                  className="block-option"
                  key={blockId}
                  onClick={() => {
                    setBlocks((current) => addDashboardBlock(current, blockId));
                  }}
                  type="button"
                >
                  <strong>{blockCatalog[blockId].title}</strong>
                  <small>{blockCatalog[blockId].description}</small>
                  <span aria-hidden="true">＋</span>
                </button>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {blocks.length === 0 ? (
        <section className="surface dashboard-zero-state">
          <strong>Dashboard 还是空的</strong>
          <p>添加一个 Block 来开始构建当前项目的运维视图。</p>
          <button
            className="compact-button"
            onClick={() => {
              setAdding(true);
            }}
            type="button"
          >
            添加 Block
          </button>
        </section>
      ) : (
        <section className="dashboard-grid" aria-label="可定制 Dashboard">
          {blocks.map((block, index) => (
            <article
              className={`dashboard-block dashboard-block-${block.size}`}
              draggable
              key={block.id}
              onDragOver={(event) => {
                event.preventDefault();
              }}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(
                  "application/x-aethercloud-block",
                  block.id,
                );
              }}
              onDrop={(event) => {
                drop(event, block.id);
              }}
            >
              <header>
                <div>
                  <h2>{blockCatalog[block.id].title}</h2>
                  <p>{blockCatalog[block.id].description}</p>
                </div>
                <span className="block-drag-handle" aria-hidden="true">
                  ⠿
                </span>
                <details className="block-menu">
                  <summary aria-label={`${blockCatalog[block.id].title} 设置`}>
                    ⋯
                  </summary>
                  <div>
                    <button
                      disabled={index === 0}
                      onClick={() => {
                        move(block.id, -1);
                      }}
                      type="button"
                    >
                      向前移动
                    </button>
                    <button
                      disabled={index === blocks.length - 1}
                      onClick={() => {
                        move(block.id, 1);
                      }}
                      type="button"
                    >
                      向后移动
                    </button>
                    <button
                      onClick={() => {
                        setBlocks((current) =>
                          resizeDashboardBlock(
                            current,
                            block.id,
                            block.size === "half" ? "full" : "half",
                          ),
                        );
                      }}
                      type="button"
                    >
                      {block.size === "half" ? "设为全宽" : "设为半宽"}
                    </button>
                    <button
                      className="block-remove"
                      onClick={() => {
                        setBlocks((current) =>
                          removeDashboardBlock(current, block.id),
                        );
                      }}
                      type="button"
                    >
                      移除
                    </button>
                  </div>
                </details>
              </header>
              <div className="dashboard-block-body">
                <BlockBody
                  apiState={apiState}
                  audit={audit}
                  blockId={block.id}
                  fleet={fleet}
                />
              </div>
              <footer>
                <button
                  onClick={() => {
                    onNavigate(
                      block.id === "audit-activity" ? "audit" : "fleet",
                    );
                  }}
                  type="button"
                >
                  {block.id === "audit-activity" ? "打开审计" : "查看详情"} →
                </button>
              </footer>
            </article>
          ))}
        </section>
      )}
      <p className="dashboard-truth-note">
        布局只保存在此浏览器；Block 数据来自当前签名 Tenant/Project
        范围。CloudLink 状态不代表现场物理过程健康。
      </p>
    </div>
  );
}
