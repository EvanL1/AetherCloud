import { createClient } from "@supabase/supabase-js";
import type { SyntheticEvent } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Session } from "@supabase/supabase-js";

import { AetherCloudApiClient } from "./api-client.js";
import type {
  AuditEventView,
  AuditSearchResponse,
  FleetGatewayView,
  FleetListResponse,
} from "./api-client.js";
import { consoleConfig } from "./config.js";
import { decodeSessionScope } from "./session-scope.js";
import type { SessionScope } from "./session-scope.js";

type ConsoleView = "fleet" | "overview" | "audit" | "account";
type BusyAction = "sign-in" | "recovery" | "update" | "sign-out";
type ApiState = "checking" | "connected" | "denied" | "unavailable";
type FormSubmitEvent = SyntheticEvent<HTMLFormElement, SubmitEvent>;
type Theme = "dark" | "light";

interface ThemeController {
  readonly theme: Theme;
  readonly toggle: () => void;
}

const ThemeContext = createContext<ThemeController>({
  theme: "dark",
  toggle: () => undefined,
});
const supabase = createClient(
  consoleConfig.supabaseUrl,
  consoleConfig.supabasePublishableKey,
  {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
      persistSession: true,
    },
  },
);
const api = new AetherCloudApiClient(consoleConfig.apiBaseUrl);

function shortId(input: string): string {
  return input.length <= 18 ? input : `${input.slice(0, 8)}…${input.slice(-6)}`;
}

function formatTime(input: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(input));
}

function outcomeLabel(outcome: string): string {
  if (outcome === "succeeded" || outcome === "success") return "成功";
  if (outcome === "failed" || outcome === "failure") return "失败";
  return outcome;
}

function Brand(): React.JSX.Element {
  return (
    <a
      className="brand"
      href="https://aetheriot.dev"
      aria-label="返回 AetherIoT 官网"
    >
      <span className="brand-mark" aria-hidden="true">
        A
      </span>
      <span>
        Aether<span>Cloud</span>
      </span>
    </a>
  );
}

function ThemeToggle(): React.JSX.Element {
  const { theme, toggle } = useContext(ThemeContext);
  const nextTheme = theme === "dark" ? "浅色" : "深色";
  return (
    <button
      aria-label={`切换到${nextTheme}主题`}
      className="theme-toggle"
      onClick={toggle}
      title={`切换到${nextTheme}主题`}
      type="button"
    >
      <span aria-hidden="true">{theme === "dark" ? "☼" : "☾"}</span>
      <span>{theme === "dark" ? "LIGHT" : "DARK"}</span>
    </button>
  );
}

export function LoginScreen(): React.JSX.Element {
  const [busy, setBusy] = useState<BusyAction>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  function clearFeedback(): void {
    setMessage(undefined);
    setError(undefined);
  }

  async function signIn(event: FormSubmitEvent): Promise<void> {
    event.preventDefault();
    clearFeedback();
    const input = new FormData(event.currentTarget);
    const email = input.get("email");
    const password = input.get("password");
    if (typeof email !== "string" || typeof password !== "string") return;
    setBusy("sign-in");
    const result = await supabase.auth.signInWithPassword({ email, password });
    setBusy(undefined);
    if (result.error !== null) setError("邮箱或密码不正确，请重新输入。");
  }

  async function recover(form: HTMLFormElement): Promise<void> {
    clearFeedback();
    const email = new FormData(form).get("email");
    if (typeof email !== "string" || email.length === 0) {
      setError("请先输入账户邮箱。");
      return;
    }
    setBusy("recovery");
    const result = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    setBusy(undefined);
    if (result.error === null) {
      setMessage(
        "如果账户存在，密码恢复邮件已经发送，请在当前浏览器打开邮件链接。",
      );
    } else setError("暂时无法发送恢复邮件，请稍后重试。");
  }

  return (
    <main className="login-page">
      <div className="login-atmosphere" aria-hidden="true" />
      <header className="login-header">
        <Brand />
        <div className="login-header-actions">
          <ThemeToggle />
          <a className="marketing-link" href="https://aetheriot.dev">
            AetherIoT 官网 <span aria-hidden="true">↗</span>
          </a>
        </div>
      </header>
      <section className="login-layout">
        <div className="login-intro">
          <p className="eyebrow">AETHERCLOUD · CONTROL PLANE</p>
          <h1>
            管理每一处边缘，
            <br />
            不接管边缘权威。
          </h1>
          <p className="login-lead">
            面向 AetherEdge 与云侧工作负载的多云 IoT
            融合控制台。云端负责期望状态、治理和可审计任务；现场控制始终留在边缘。
          </p>
          <div className="authority-strip">
            <div>
              <span>EDGE</span>
              <strong>现场状态与控制</strong>
            </div>
            <i aria-hidden="true" />
            <div>
              <span>CLOUD</span>
              <strong>期望状态与治理</strong>
            </div>
            <i aria-hidden="true" />
            <div>
              <span>PROVIDER</span>
              <strong>基础设施事实</strong>
            </div>
          </div>
        </div>
        <section className="login-card" aria-live="polite">
          <div className="login-card-head">
            <span className="live-dot" aria-hidden="true" />
            <span>生产环境</span>
          </div>
          <h2>登录控制台</h2>
          <p>使用已分配 AetherCloud 权限的账户。</p>
          <form onSubmit={(event) => void signIn(event)}>
            <label htmlFor="email">邮箱</label>
            <input
              autoComplete="email"
              id="email"
              name="email"
              placeholder="name@example.com"
              required
              type="email"
            />
            <label htmlFor="password">密码</label>
            <input
              autoComplete="current-password"
              id="password"
              name="password"
              placeholder="输入密码"
              required
              type="password"
            />
            <button
              className="primary-button"
              disabled={busy !== undefined}
              type="submit"
            >
              {busy === "sign-in" ? "正在验证…" : "进入控制台"}
            </button>
            <button
              className="text-button"
              disabled={busy !== undefined}
              onClick={(event) => {
                const form = event.currentTarget.form;
                if (form !== null) void recover(form);
              }}
              type="button"
            >
              {busy === "recovery" ? "正在发送…" : "忘记密码"}
            </button>
          </form>
          {message === undefined ? null : (
            <p className="form-message">{message}</p>
          )}
          {error === undefined ? null : <p className="form-error">{error}</p>}
          <p className="invite-note">
            账户目前由管理员邀请和分配 Tenant 权限，不开放无权限自助注册。
          </p>
        </section>
      </section>
      <footer className="login-footer">
        <span>© 2026 AetherIoT</span>
        <span>Verify first. Commission deliberately.</span>
      </footer>
    </main>
  );
}

interface NavigationProps {
  readonly current: ConsoleView;
  readonly onChange: (view: ConsoleView) => void;
  readonly open: boolean;
}

function Navigation({
  current,
  onChange,
  open,
}: NavigationProps): React.JSX.Element {
  const primaryItems: readonly Readonly<{
    view: ConsoleView;
    label: string;
  }>[] = [{ view: "fleet", label: "Fleet" }];
  const managementItems: readonly Readonly<{
    view: ConsoleView;
    label: string;
  }>[] = [
    { view: "audit", label: "审计" },
    { view: "account", label: "账户" },
  ];
  return (
    <aside className={`sidebar${open ? " sidebar-open" : ""}`}>
      <div className="sidebar-brand">
        <Brand />
      </div>
      <nav aria-label="控制台导航">
        <p>WORKSPACE</p>
        {primaryItems.map((item) => (
          <button
            className={
              current === item.view ? "nav-item nav-item-active" : "nav-item"
            }
            key={item.view}
            onClick={() => {
              onChange(item.view);
            }}
            type="button"
          >
            {item.label}
          </button>
        ))}
        <p>MANAGEMENT</p>
        {managementItems.map((item) => (
          <button
            className={
              current === item.view ? "nav-item nav-item-active" : "nav-item"
            }
            key={item.view}
            onClick={() => {
              onChange(item.view);
            }}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-boundary">
        <span>AETHEREDGE</span>
        <p>现场运行不依赖云端持续在线。</p>
      </div>
    </aside>
  );
}

interface FleetViewProps {
  readonly fleet: FleetListResponse | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly onReload: () => void;
  readonly onRegister: (
    input: Readonly<{
      gatewayId: string;
      displayName: string;
    }>,
  ) => Promise<void>;
}

function connectionLabel(
  status: FleetGatewayView["connection"]["status"],
): string {
  if (status === "online") return "在线";
  if (status === "stale") return "连接异常";
  if (status === "connecting") return "连接中";
  if (status === "offline") return "离线";
  return "从未连接";
}

export function FleetView({
  fleet,
  loading,
  error,
  onReload,
  onRegister,
}: FleetViewProps): React.JSX.Element {
  const [registering, setRegistering] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [gatewayId, setGatewayId] = useState(() => crypto.randomUUID());
  const [selected, setSelected] = useState<string>();

  async function register(event: FormSubmitEvent): Promise<void> {
    event.preventDefault();
    setFormError(undefined);
    const displayName = new FormData(event.currentTarget).get("displayName");
    if (typeof displayName !== "string" || displayName.trim().length === 0) {
      setFormError("请输入网关名称。");
      return;
    }
    setSubmitting(true);
    try {
      await onRegister({ gatewayId, displayName: displayName.trim() });
      setRegistering(false);
      setGatewayId(crypto.randomUUID());
      event.currentTarget.reset();
    } catch {
      setFormError("无法创建网关，请检查权限或稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  const gateways = fleet?.items ?? [];
  const selectedGateway = gateways.find(
    (gateway) => gateway.gatewayId === selected,
  );

  const needsAttention = gateways.filter(
    (gateway) => gateway.connection.status !== "online",
  ).length;

  return (
    <div className="view-stack">
      <section className="page-heading fleet-heading">
        <div>
          <p className="eyebrow">AETHEREDGE</p>
          <h1>Fleet</h1>
          <p>
            {gateways.length === 0
              ? "管理 AetherEdge 网关、连接状态与数据新鲜度。"
              : `${String(gateways.length)} 个网关 · ${String(needsAttention)} 个需要处理`}
          </p>
        </div>
        <div className="page-actions">
          <button
            className="outline-button"
            disabled={loading}
            onClick={onReload}
            type="button"
          >
            刷新
          </button>
          <button
            className="compact-button"
            onClick={() => {
              setRegistering((visible) => !visible);
            }}
            type="button"
          >
            {registering ? "取消" : "添加网关"}
          </button>
        </div>
      </section>

      {registering ? (
        <section className="surface register-surface">
          <div className="section-heading">
            <div>
              <p className="eyebrow">NEW GATEWAY</p>
              <h2>添加 AetherEdge 网关</h2>
            </div>
          </div>
          <form
            className="register-grid"
            onSubmit={(event) => void register(event)}
          >
            <label>
              网关名称
              <input
                autoFocus
                maxLength={128}
                name="displayName"
                placeholder="例如：上海办公室"
                required
              />
            </label>
            <button
              className="compact-button"
              disabled={submitting}
              type="submit"
            >
              {submitting ? "正在创建…" : "创建网关身份"}
            </button>
          </form>
          <p className="register-note">
            这里只创建网关身份。安全接入与凭据绑定将在后续步骤完成。
          </p>
          {formError === undefined ? null : (
            <p className="inline-error">{formError}</p>
          )}
        </section>
      ) : null}

      {error === undefined ? null : <p className="inline-error">{error}</p>}

      <section className="surface fleet-surface">
        {loading && fleet === undefined ? (
          <div className="empty-state">
            <span className="spinner" />
            <h3>正在读取 Fleet</h3>
          </div>
        ) : gateways.length === 0 ? (
          <div className="empty-state">
            <span className="empty-glyph" aria-hidden="true">
              ＋
            </span>
            <h3>添加第一个 AetherEdge 网关</h3>
            <p>创建网关身份后，它会出现在 Fleet 中。现场运行不会被云端接管。</p>
            <button
              className="compact-button"
              onClick={() => {
                setRegistering(true);
              }}
              type="button"
            >
              添加网关
            </button>
          </div>
        ) : (
          <div className="fleet-list">
            <div className="fleet-list-row fleet-list-header">
              <span>网关</span>
              <span>连接</span>
              <span>最新数据</span>
              <span>遥测记录</span>
              <span />
            </div>
            {gateways.map((gateway) => (
              <button
                className={
                  selected === gateway.gatewayId
                    ? "fleet-list-row fleet-list-item fleet-list-item-active"
                    : "fleet-list-row fleet-list-item"
                }
                key={gateway.gatewayId}
                onClick={() => {
                  setSelected((current) =>
                    current === gateway.gatewayId
                      ? undefined
                      : gateway.gatewayId,
                  );
                }}
                type="button"
              >
                <span className="fleet-gateway-name">
                  <strong>{gateway.displayName}</strong>
                  <small>{shortId(gateway.gatewayId)}</small>
                </span>
                <span className="fleet-connection">
                  <i
                    className={`fleet-status fleet-status-${gateway.connection.status}`}
                  />
                  {connectionLabel(gateway.connection.status)}
                </span>
                <span>
                  {gateway.telemetry.lastReceivedAt === undefined
                    ? "—"
                    : formatTime(gateway.telemetry.lastReceivedAt)}
                </span>
                <span>{gateway.telemetry.recordCount}</span>
                <span aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {selectedGateway === undefined ? null : (
        <section className="surface gateway-detail">
          <div className="section-heading">
            <div>
              <p className="eyebrow">GATEWAY</p>
              <h2>{selectedGateway.displayName}</h2>
              <p className="detail-subtitle">
                {connectionLabel(selectedGateway.connection.status)} · 最近数据
                {selectedGateway.telemetry.lastReceivedAt === undefined
                  ? "尚未到达"
                  : formatTime(selectedGateway.telemetry.lastReceivedAt)}
              </p>
            </div>
          </div>
          <div className="detail-grid">
            <div>
              <span>连接</span>
              <strong>
                {connectionLabel(selectedGateway.connection.status)}
              </strong>
            </div>
            <div>
              <span>数据</span>
              <strong>
                {selectedGateway.telemetry.lastReceivedAt === undefined
                  ? "尚无遥测"
                  : "已接收"}
              </strong>
            </div>
            <div>
              <span>接入状态</span>
              <strong>{selectedGateway.enrollmentState}</strong>
            </div>
            <div>
              <span>创建时间</span>
              <strong>{formatTime(selectedGateway.registeredAt)}</strong>
            </div>
          </div>
          <div className="latest-telemetry">
            <span>LATEST TELEMETRY</span>
            {selectedGateway.telemetry.latest === undefined ? (
              <p>该网关还没有遥测记录。</p>
            ) : (
              <pre>
                {JSON.stringify(selectedGateway.telemetry.latest, null, 2)}
              </pre>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

interface OverviewProps {
  readonly email: string;
  readonly scope: SessionScope | null;
  readonly apiState: ApiState;
  readonly audit: AuditSearchResponse | undefined;
  readonly onNavigate: (view: ConsoleView) => void;
}

export function Overview({
  email,
  scope,
  apiState,
  audit,
  onNavigate,
}: OverviewProps): React.JSX.Element {
  const firstName = email.split("@")[0] ?? email;
  return (
    <div className="view-stack">
      <section className="welcome-panel">
        <div>
          <p className="eyebrow">OPERATOR OVERVIEW</p>
          <h1>你好，{firstName}</h1>
          <p>
            这里仅展示已经接入生产 API
            的能力；尚未开放的模块会明确标记，不生成虚假的设备或云资源数据。
          </p>
        </div>
        <div className={`connection-badge connection-${apiState}`}>
          <span aria-hidden="true" />
          {apiState === "connected"
            ? "API 已连接"
            : apiState === "checking"
              ? "正在检查 API"
              : apiState === "denied"
                ? "权限不足"
                : "API 不可用"}
        </div>
      </section>

      <section className="metric-grid" aria-label="控制台状态">
        <article className="metric-card">
          <span>IDENTITY</span>
          <strong>
            {scope === null ? "未分配" : scope.role.toUpperCase()}
          </strong>
          <p>管理员控制的账户角色</p>
        </article>
        <article className="metric-card">
          <span>TENANT</span>
          <strong>{scope === null ? "—" : shortId(scope.tenantId)}</strong>
          <p>来自签名会话，不接受页面输入</p>
        </article>
        <article className="metric-card">
          <span>PROJECT</span>
          <strong>{scope === null ? "—" : shortId(scope.projectId)}</strong>
          <p>当前受控项目范围</p>
        </article>
        <article className="metric-card metric-card-accent">
          <span>AUDIT EVENTS</span>
          <strong>{audit?.items.length ?? "—"}</strong>
          <p>当前查询窗口中的事件</p>
        </article>
      </section>

      <section className="content-grid">
        <article className="surface service-surface">
          <div className="section-heading">
            <div>
              <p className="eyebrow">AVAILABLE NOW</p>
              <h2>生产服务</h2>
            </div>
          </div>
          <button
            className="service-row"
            onClick={() => {
              onNavigate("fleet");
            }}
            type="button"
          >
            <span className="service-icon">FL</span>
            <span>
              <strong>AetherEdge Fleet</strong>
              <small>添加网关并查询 CloudLink 状态与最新遥测</small>
            </span>
            <em>可用</em>
            <b aria-hidden="true">→</b>
          </button>
          <button
            className="service-row"
            onClick={() => {
              onNavigate("account");
            }}
            type="button"
          >
            <span className="service-icon">ID</span>
            <span>
              <strong>身份与会话</strong>
              <small>查看授权范围、权限和更新账户密码</small>
            </span>
            <em>可用</em>
            <b aria-hidden="true">→</b>
          </button>
        </article>

        <article className="surface authority-surface">
          <div className="section-heading">
            <div>
              <p className="eyebrow">AUTHORITY MODEL</p>
              <h2>权威边界</h2>
            </div>
          </div>
          <div className="authority-list">
            <div>
              <span>01</span>
              <p>
                <strong>边缘</strong>现场点位、规则、安全联锁和物理控制
              </p>
            </div>
            <div>
              <span>02</span>
              <p>
                <strong>云端</strong>期望放置、治理和基础设施任务
              </p>
            </div>
            <div>
              <span>03</span>
              <p>
                <strong>Provider</strong>资源是否存在及供应商原生状态
              </p>
            </div>
          </div>
        </article>
      </section>

      <section className="surface roadmap-surface">
        <div className="section-heading">
          <div>
            <p className="eyebrow">SERVICE DELIVERY</p>
            <h2>模块接入状态</h2>
          </div>
          <span className="truth-label">只展示真实实现</span>
        </div>
        <div className="roadmap-grid">
          {(
            [
              ["审计与身份", "生产可用", "ready"],
              ["AetherEdge Fleet", "生产可用", "ready"],
              ["遥测与告警", "持久化基础已实现", "foundation"],
              ["部署与多云", "应用契约已定义", "planned"],
            ] as const
          ).map(([name, status, kind]) => (
            <div className="roadmap-item" key={name}>
              <span className={`status-line status-${kind}`} />
              <strong>{name}</strong>
              <small>{status}</small>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

interface AuditViewProps {
  readonly audit: AuditSearchResponse | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly onSearch: (
    input: Readonly<{ action?: string; resourceId?: string }>,
  ) => void;
  readonly onNext: (cursor: string) => void;
}

function AuditView({
  audit,
  loading,
  error,
  onSearch,
  onNext,
}: AuditViewProps): React.JSX.Element {
  const nextCursor = audit?.nextCursor;

  function submit(event: FormSubmitEvent): void {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const action = values.get("action");
    const resourceId = values.get("resourceId");
    onSearch({
      ...(typeof action === "string" && action.length > 0 ? { action } : {}),
      ...(typeof resourceId === "string" && resourceId.length > 0
        ? { resourceId }
        : {}),
    });
  }
  return (
    <div className="view-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">AUDIT EXPLORER</p>
          <h1>审计事件</h1>
          <p>查询当前 Tenant 和 Project 范围内的真实生产审计数据。</p>
        </div>
        <span className="permission-chip">audit.event.read</span>
      </section>
      <section className="surface audit-surface">
        <form className="filter-bar" onSubmit={submit}>
          <label>
            动作
            <input name="action" placeholder="例如 gateway.enrolled" />
          </label>
          <label>
            资源 ID
            <input name="resourceId" placeholder="输入完整资源 ID" />
          </label>
          <button className="compact-button" disabled={loading} type="submit">
            {loading ? "查询中…" : "查询"}
          </button>
        </form>
        {error === undefined ? null : <p className="inline-error">{error}</p>}
        {audit !== undefined && audit.items.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>动作</th>
                  <th>资源</th>
                  <th>主体</th>
                  <th>结果</th>
                  <th>风险</th>
                </tr>
              </thead>
              <tbody>
                {audit.items.map((event) => (
                  <AuditRow event={event} key={event.eventId} />
                ))}
              </tbody>
            </table>
          </div>
        ) : loading ? (
          <div className="empty-state">
            <span className="spinner" />
            <h3>正在查询审计存储</h3>
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-glyph">AU</span>
            <h3>当前范围内还没有审计事件</h3>
            <p>
              这是真实的空查询结果。后续受治理命令写入后，事件会出现在这里。
            </p>
          </div>
        )}
        {nextCursor === null || nextCursor === undefined ? null : (
          <div className="pagination">
            <button
              className="compact-button"
              onClick={() => {
                onNext(nextCursor);
              }}
              type="button"
            >
              下一页
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function AuditRow({
  event,
}: Readonly<{ event: AuditEventView }>): React.JSX.Element {
  return (
    <tr>
      <td>
        <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
        <small>#{event.sequence}</small>
      </td>
      <td>
        <code>{event.action}</code>
      </td>
      <td>
        <strong>{event.resource.kind}</strong>
        <small title={event.resource.resourceId}>
          {shortId(event.resource.resourceId)}
        </small>
      </td>
      <td>
        <strong>{event.subject.kind}</strong>
        <small title={event.subject.subjectId}>
          {shortId(event.subject.subjectId)}
        </small>
      </td>
      <td>
        <span className={`outcome outcome-${event.outcome}`}>
          {outcomeLabel(event.outcome)}
        </span>
      </td>
      <td>{event.risk}</td>
    </tr>
  );
}

interface AccountViewProps {
  readonly session: Session;
  readonly scope: SessionScope | null;
  readonly recovery: boolean;
}

function AccountView({
  session,
  scope,
  recovery,
}: AccountViewProps): React.JSX.Element {
  const [busy, setBusy] = useState<BusyAction>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  async function update(event: FormSubmitEvent): Promise<void> {
    event.preventDefault();
    setMessage(undefined);
    setError(undefined);
    const values = new FormData(event.currentTarget);
    const password = values.get("new-password");
    const confirmation = values.get("confirmation");
    if (typeof password !== "string" || password.length < 8) {
      setError("密码至少需要 8 个字符。");
      return;
    }
    if (password !== confirmation) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy("update");
    const result = await supabase.auth.updateUser({ password });
    setBusy(undefined);
    if (result.error === null) {
      event.currentTarget.reset();
      setMessage("密码已经更新。");
    } else setError("暂时无法更新密码，请稍后重试。");
  }

  async function signOut(): Promise<void> {
    setBusy("sign-out");
    await supabase.auth.signOut();
    setBusy(undefined);
  }

  return (
    <div className="view-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">IDENTITY & ACCESS</p>
          <h1>身份与账户</h1>
          <p>授权范围只来自管理员控制的签名元数据。</p>
        </div>
        <button
          className="outline-button"
          disabled={busy !== undefined}
          onClick={() => void signOut()}
          type="button"
        >
          {busy === "sign-out" ? "正在退出…" : "退出登录"}
        </button>
      </section>
      <section className="account-grid">
        <article className="surface identity-card">
          <p className="eyebrow">SIGNED IDENTITY</p>
          <div className="avatar">
            {session.user.email?.slice(0, 1).toUpperCase() ?? "U"}
          </div>
          <h2>{session.user.email}</h2>
          <dl>
            <div>
              <dt>Subject</dt>
              <dd>{session.user.id}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{scope?.role ?? "未分配"}</dd>
            </div>
            <div>
              <dt>Tenant</dt>
              <dd>{scope?.tenantId ?? "未分配"}</dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd>{scope?.projectId ?? "未分配"}</dd>
            </div>
          </dl>
        </article>
        <article className="surface password-card">
          <p className="eyebrow">ACCOUNT SECURITY</p>
          <h2>{recovery ? "设置新密码" : "修改密码"}</h2>
          <p>新密码至少 8 个字符。更新后其他活动会话可能需要重新认证。</p>
          <form onSubmit={(event) => void update(event)}>
            <label htmlFor="new-password">新密码</label>
            <input
              autoComplete="new-password"
              id="new-password"
              minLength={8}
              name="new-password"
              required
              type="password"
            />
            <label htmlFor="confirmation">确认新密码</label>
            <input
              autoComplete="new-password"
              id="confirmation"
              minLength={8}
              name="confirmation"
              required
              type="password"
            />
            <button
              className="primary-button"
              disabled={busy !== undefined}
              type="submit"
            >
              {busy === "update" ? "正在更新…" : "保存新密码"}
            </button>
          </form>
          {message === undefined ? null : (
            <p className="form-message">{message}</p>
          )}
          {error === undefined ? null : <p className="form-error">{error}</p>}
        </article>
        <article className="surface permission-card">
          <p className="eyebrow">EFFECTIVE PERMISSIONS</p>
          <h2>当前权限</h2>
          {scope === null || scope.permissions.length === 0 ? (
            <p className="inline-error">账户尚未分配 AetherCloud 权限。</p>
          ) : (
            <ul>
              {scope.permissions.map((permission) => (
                <li key={permission}>{permission}</li>
              ))}
            </ul>
          )}
        </article>
      </section>
    </div>
  );
}

function Console({
  session,
  recovery,
}: Readonly<{ session: Session; recovery: boolean }>): React.JSX.Element {
  const [view, setView] = useState<ConsoleView>(recovery ? "account" : "fleet");
  const [menuOpen, setMenuOpen] = useState(false);
  const [apiState, setApiState] = useState<ApiState>("checking");
  const [fleet, setFleet] = useState<FleetListResponse>();
  const [fleetError, setFleetError] = useState<string>();
  const [fleetLoading, setFleetLoading] = useState(true);
  const [audit, setAudit] = useState<AuditSearchResponse>();
  const [auditError, setAuditError] = useState<string>();
  const [auditLoading, setAuditLoading] = useState(true);
  const scope = useMemo(
    () => decodeSessionScope({ app_metadata: session.user.app_metadata }),
    [session.user.app_metadata],
  );

  const loadAudit = useCallback(
    async (
      input: Readonly<{
        action?: string;
        resourceId?: string;
        cursor?: string;
      }> = {},
    ) => {
      setAuditLoading(true);
      setAuditError(undefined);
      try {
        const result = await api.searchAuditEvents(session.access_token, {
          limit: 25,
          ...input,
        });
        setAudit(result);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "";
        if (!message.includes("401") && !message.includes("403"))
          setApiState("unavailable");
        setAuditError("无法读取审计事件，请检查账户权限或稍后重试。");
      } finally {
        setAuditLoading(false);
      }
    },
    [session.access_token],
  );

  const loadFleet = useCallback(async () => {
    setFleetLoading(true);
    setFleetError(undefined);
    try {
      const result = await api.listFleetGateways(session.access_token);
      setFleet(result);
      setApiState("connected");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "";
      setApiState(
        message.includes("401") || message.includes("403")
          ? "denied"
          : "unavailable",
      );
      setFleetError("无法读取 Fleet，请检查账户权限或稍后重试。");
    } finally {
      setFleetLoading(false);
    }
  }, [session.access_token]);

  async function registerGateway(
    input: Readonly<{
      gatewayId: string;
      displayName: string;
    }>,
  ): Promise<void> {
    await api.registerGateway(session.access_token, input, crypto.randomUUID());
    await loadFleet();
  }

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api.health(controller.signal),
      loadFleet(),
      loadAudit(),
    ]).then(([healthy]) => {
      if (!healthy) setApiState("unavailable");
    });
    return () => {
      controller.abort();
    };
  }, [loadAudit, loadFleet]);

  function navigate(next: ConsoleView): void {
    setView(next);
    setMenuOpen(false);
  }

  return (
    <div className="console-layout">
      <Navigation current={view} onChange={navigate} open={menuOpen} />
      <main className="console-main">
        <header className="console-topbar">
          <button
            aria-label="打开导航"
            className="menu-button"
            onClick={() => {
              setMenuOpen((open) => !open);
            }}
            type="button"
          >
            ☰
          </button>
          <div className="scope-crumb">
            <span>AetherCloud</span>
            <b>/</b>
            <span>
              {view === "fleet"
                ? "Fleet"
                : view === "audit"
                  ? "审计"
                  : view === "account"
                    ? "账户"
                    : "总览"}
            </span>
          </div>
          <div className="topbar-actions">
            <ThemeToggle />
            <div className="operator-chip">
              <span>{session.user.email?.slice(0, 1).toUpperCase()}</span>
              <div>
                <strong>{session.user.email}</strong>
                <small>{scope?.role ?? "未分配"}</small>
              </div>
            </div>
          </div>
        </header>
        <div className="console-content">
          {view === "fleet" ? (
            <FleetView
              error={fleetError}
              fleet={fleet}
              loading={fleetLoading}
              onRegister={registerGateway}
              onReload={() => {
                void loadFleet();
              }}
            />
          ) : view === "overview" ? (
            <Overview
              apiState={apiState}
              audit={audit}
              email={session.user.email ?? session.user.id}
              onNavigate={navigate}
              scope={scope}
            />
          ) : view === "audit" ? (
            <AuditView
              audit={audit}
              error={auditError}
              loading={auditLoading}
              onNext={(cursor) => void loadAudit({ cursor })}
              onSearch={(input) => void loadAudit(input)}
            />
          ) : (
            <AccountView recovery={recovery} scope={scope} session={session} />
          )}
        </div>
      </main>
    </div>
  );
}

export function App(): React.JSX.Element {
  const [session, setSession] = useState<Session | null>();
  const [recovery, setRecovery] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = window.localStorage.getItem("aethercloud-theme");
    if (stored === "dark" || stored === "light") return stored;
    return typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("aethercloud-theme", theme);
    const themeColor = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    themeColor?.setAttribute(
      "content",
      theme === "dark" ? "#151514" : "#f4f4f1",
    );
  }, [theme]);

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(async ({ data }) => {
      if (data.session === null) {
        if (active) setSession(null);
        return;
      }
      const refreshed = await supabase.auth.refreshSession();
      if (active) setSession(refreshed.data.session ?? data.session);
    });
    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      setSession(nextSession);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  let content: React.JSX.Element;
  if (session === undefined) {
    content = (
      <main className="boot-screen">
        <Brand />
        <span className="spinner" />
        <p>正在建立安全会话…</p>
      </main>
    );
  } else {
    content =
      session === null ? (
        <LoginScreen />
      ) : (
        <Console recovery={recovery} session={session} />
      );
  }

  return (
    <ThemeContext.Provider
      value={{
        theme,
        toggle: () => {
          setTheme((current) => (current === "dark" ? "light" : "dark"));
        },
      }}
    >
      {content}
    </ThemeContext.Provider>
  );
}
