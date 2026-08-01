# A0 只读 Home Assistant 投影楔子 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一个装有 Home Assistant 与 AetherEdge 的用户，能在 AetherCloud 控制台看到自家设备的拓扑与观测历史，且该数据被明确标注为边缘上报的副本。

**Architecture:** 投影的写入、持久化、查询三层已在 `packages/application` 与 `adapters/integration-projection/postgres` 中实现。本计划只做三件事：把契约从候选转为已发布消费；为 CloudLink ingress 建立一个可部署的生产组合根（控制路径在类型层面不接线）；在 `apps/api` 上开两条只读路由并在 `apps/web` 呈现。

**Tech Stack:** Node.js 24、TypeScript 5.9（ESM，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`）、Fastify 5、Vitest 4、PostgreSQL（forced RLS）、MQTT.js 5、React 19 + Vite。

**设计依据：** [A0 设计文档](../specs/2026-07-31-home-assistant-readonly-projection-wedge-design.md)

---

## 阅读顺序（动手前必读）

1. `AGENTS.md` — 架构边界、TypeScript 约定、验证要求。**默认验证路径不得依赖 PostgreSQL、边缘设备或 broker。**
2. `docs/adr/0014-cloudlink-mqtt-transport-binding.md` — broker 是运营方配置，不是 AetherCloud 自建组件。
3. `docs/concepts/home-assistant-integration.md` — 只读路径的权威与密钥边界。
4. `scripts/run-home-assistant-e2e-harness.ts:673-834` — **ingress 完整接线的参考实现**。Task 3 基本是把这段接线搬进组合根并去掉控制部分。

## 贯穿全程的硬约束

- **禁止碰控制路径。** 不得引入 `createCloudLinkIntegrationControlFactory`、`CreateIntegrationPowerControl`、`@aether-cloud/integration-control-*` 中的任何东西。若某个测试需要它们才能通过，说明接线错了，回头改接线而不是加依赖。
- **禁止 `any`。** 外部输入一律运行时解码。
- **不得把 Home Assistant 的地址或 token 写进任何日志、审计、响应或测试夹具。**
- 每个 Task 结束都要提交。提交信息格式 `<type>: <description>`（有 hook 校验）。

## A0 的已知限制（不要顺手修）

`adapters/runtime` 下只有 `memory`，没有 PostgreSQL 适配器。因此 A0 的
Runtime Manifest 只存在于进程内存中：CloudLink 进程重启后，
`RestoreGatewayRuntimeProtocols` 会查不到声明，直到 Gateway 重新上报 manifest。
在此期间投影上报会因协议未声明而 fail closed——**这是正确的失败方向**，
不要为了让它"看起来能用"而放宽校验。

实现 PostgreSQL Runtime Manifest 仓储是独立的一块工作，不属于本计划。
交付 A0 时要把这条限制写进 `docs/concepts/current-state-audit.md`。

## 实施偏差记录（Task 2 已执行，本节为事后修正）

**本计划最初写的 Task 2 spec 有一处安全缺陷，执行后由代码审查发现。**
后续任务如果要照 Task 2 的写法扩展，请以本节为准，不要照抄下方 Task 2 的原始
spec 正文。

1. **原 spec 漏掉了 PostgreSQL 角色检查。** `apps/api/src/runtime.ts` 的两个同类
   校验器都强制连接串使用专用非所有者角色（`aethercloud_app`、
   `aethercloud_cloudlink_health_worker`），而原 spec 只抄了格式校验部分。
   投影表虽有 `FORCE ROW LEVEL SECURITY`，但它挡不住 `BYPASSRLS`/superuser 角色
   ——角色名检查正是挡这个的。两道防线是串联而非冗余。
2. **三份重复的连接串校验器已合并**到
   `adapters/fleet/postgres/src/postgres-connection-string.ts`，
   导出 `assertPostgresConnectionString(input, { variable, roleName, requiredWhen })`。
   env 读取仍留在各自组合根，只有字符串校验被共享。
   `apps/api/src/runtime.ts` 的两个校验器与 CloudLink 的一起改写为委托调用。
3. **CloudLink ingress 使用独立角色 `aethercloud_cloudlink_ingress`**（非
   `aethercloud_app`），迁移在
   `supabase/migrations/20260728000900_cloudlink_ingress_role.sql`。
   理由：ingress 是消费不受信外部输入的写入路径，授权应比只读的 API 进程更窄。
4. **环境变量是 `AETHER_CLOUD_CLOUDLINK_INGRESS_POSTGRES_URL`**，不是
   `AETHER_CLOUD_POSTGRES_URL`。后者继续专指 `aethercloud_app`。
   一个角色一个变量，与 health worker 的先例一致；共用变量名会让 Railway 的
   项目级共享变量静默打断其中一个 service。

**教训一（对 Task 3-8 有效）：** `tests/supabase-config.test.mjs` 只做迁移文本的
模式匹配，从不执行 SQL；`pnpm test:postgres-integration` 默认跳过。因此
**授权范围的错误不会被 `pnpm check` 发现**。凡是新增或修改 `GRANT` 的改动，
必须另起一个真实 PostgreSQL 实例，把仓储实际发出的每一条 SQL 都以该角色跑一遍。
`42501 permission denied` 表示授权仍缺；外键或检查约束错误（23503 等）表示权限
检查已通过。只测"有代表性的一张表"不够——本次缺陷恰好落在唯一两张被收紧的表上。

**教训二：源码正确不等于数据库正确。** Supabase 按版本号前缀在
`supabase_migrations.schema_migrations` 里记录已应用的迁移，所以**原地编辑一个
已经跑过的迁移文件，对该库是空操作**。修既有迁移必须同时补一条前向迁移
（`GRANT` 幂等，对没跑过旧版本的库也安全）。本次 health worker 的
`GRANT SELECT` 修复就踩了这个坑：所有测试和审查都显示"已修复"，
但已部署的库不受影响。

## Task 3 开始前要重新审视的事

Task 2 的角色授权是按**当时** `apps/cloudlink` 的依赖范围定的，而当时
`@aether-cloud/cloudlink-postgres-adapter` 还不是它的依赖——那五条
`cloudlink_session*` 授权属于预置，仓库里没有任何东西真正跑到它们。

Task 3 会把会话仓储接成 postgres 可选，届时这些授权才第一次被实际执行。
另外 harness 用内存适配器承载 Runtime Manifest、用加密校验器（而非仓储）承载
Gateway 凭据，这正是 `gateway_identities` 可以完全不授的原因；一旦 Task 3
让其中任何一个变成持久化的，授权集合必须重新推导并重新用真库验证。

新环境变量 `AETHER_CLOUD_CLOUDLINK_INGRESS_POSTGRES_URL` 目前只记录在本计划里。
Task 4 建 `railway.cloudlink.json` 时要给它在 `docs/reference/` 下安个正式的家。

## File Structure

| 文件                                                                                | 动作 | 职责                                                              |
| ----------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------- |
| `contracts/aether-contracts/v0.1.0-alpha.4/`                                        | 新建 | 已发布 alpha.4 契约产物（由 `v0.1.0-alpha.4-candidate/` 更名）    |
| `aether-contracts.lock.json`                                                        | 修改 | 消费锁指向 alpha.4                                                |
| `adapters/integration-projection/aether-contracts/test/candidate-artifacts.test.ts` | 修改 | 绊线断言从"未发布候选"翻转为"已发布 + digest 校验"                |
| `apps/cloudlink/src/integration-projection-store.ts`                                | 新建 | 按环境变量选择 memory 或 postgres 投影仓储                        |
| `apps/cloudlink/src/runtime.ts`                                                     | 新建 | CloudLink 生产组合根，控制路径不接线                              |
| `apps/cloudlink/src/server.ts`                                                      | 新建 | 进程入口与优雅关闭                                                |
| `apps/cloudlink/package.json`                                                       | 修改 | 提升 memory adapter 至 dependencies，新增 postgres adapter 与脚本 |
| `railway.cloudlink.json`                                                            | 新建 | CloudLink 进程的 Railway service 配置                             |
| `apps/api/src/http-responses.ts`                                                    | 新建 | `sendError`、`isRecord`、`errorResponseSchema` 等路由组共用件     |
| `apps/api/src/fleet-routes.ts`                                                      | 新建 | 由 `app.ts` 抽出的 fleet 路由组（行为不变）                       |
| `apps/api/src/audit-routes.ts`                                                      | 新建 | 由 `app.ts` 抽出的 audit 路由组（行为不变）                       |
| `apps/api/src/integration-routes.ts`                                                | 新建 | 只读投影 catalog 与 by-ID 路由                                    |
| `apps/api/src/app.ts`                                                               | 修改 | 收缩为组装器，注册各路由模块                                      |
| `apps/api/src/runtime.ts`                                                           | 修改 | 组合投影查询用例并注入 `buildApp`                                 |
| `apps/api/test/integration-routes.test.ts`                                          | 新建 | 只读路由的行为测试                                                |
| `apps/web/src/integrations.tsx`                                                     | 新建 | 投影列表与详情视图                                                |
| `apps/web/src/api-client.ts`                                                        | 修改 | 新增两个只读端点的调用                                            |
| `apps/web/src/app.tsx`                                                              | 修改 | 挂载投影视图                                                      |

---

# 步骤一：契约转正

## Task 1: 把 alpha.4 从候选转为已发布消费

**前置：** AetherContracts 仓库已发布 `v0.1.0-alpha.4`，且发布页提供 `AetherContracts-0.1.0-alpha.4.tar.gz` 及其 sha256。**此前置未满足则整个计划无法开始**——不要用候选产物伪造发布态。

**Files:**

- Create: `contracts/aether-contracts/v0.1.0-alpha.4/`（由候选目录更名）
- Modify: `aether-contracts.lock.json`
- Modify: `adapters/integration-projection/aether-contracts/test/candidate-artifacts.test.ts`
- Modify: `adapters/integration-projection/aether-contracts/src/index.ts`（若其中出现候选路径常量）

- [ ] **Step 1: 先跑一次基线，确认当前是绿的**

Run: `pnpm check`
Expected: PASS。若此时已红，先停下来查清原因，不要在红的基线上叠加改动。

- [ ] **Step 2: 下载发布产物并核对 digest**

```bash
cd /tmp
curl -fsSL -O https://github.com/EvanL1/AetherContracts/releases/download/v0.1.0-alpha.4/AetherContracts-0.1.0-alpha.4.tar.gz
shasum -a 256 AetherContracts-0.1.0-alpha.4.tar.gz
```

把输出的 sha256 与发布页公布值逐字符比对。**不一致就停止**，这意味着产物不可信。
记下这个值，Step 4 要用；同时记下 `git ls-remote --tags` 中 `v0.1.0-alpha.4` 的 tag object 与 commit。

- [ ] **Step 3: 目录更名并按发布产物覆盖**

```bash
cd /Users/lyf/dev/AetherCloud
git mv contracts/aether-contracts/v0.1.0-alpha.4-candidate contracts/aether-contracts/v0.1.0-alpha.4
git rm contracts/aether-contracts/v0.1.0-alpha.4/candidate-lock.json
tar -xzf /tmp/AetherContracts-0.1.0-alpha.4.tar.gz -C /tmp
rsync -a --delete /tmp/AetherContracts-0.1.0-alpha.4/ contracts/aether-contracts/v0.1.0-alpha.4/
shasum -a 256 contracts/aether-contracts/v0.1.0-alpha.4/contract-manifest.json
```

记下 manifest 的 sha256，Step 4 要用。

- [ ] **Step 4: 更新消费锁**

编辑 `aether-contracts.lock.json`，把 `release` 与 `manifest` 两块改为 alpha.4。
其余字段（`schema`、`status`、`repository`、`policy`）保持不变。

```json
  "release": {
    "version": "0.1.0-alpha.4",
    "tag": "v0.1.0-alpha.4",
    "tag_object": "<Step 2 记下的 tag object>",
    "commit": "<Step 2 记下的 commit>",
    "bundle": {
      "name": "AetherContracts-0.1.0-alpha.4.tar.gz",
      "url": "https://github.com/EvanL1/AetherContracts/releases/download/v0.1.0-alpha.4/AetherContracts-0.1.0-alpha.4.tar.gz",
      "root": "AetherContracts-0.1.0-alpha.4",
      "size": <tar.gz 的字节数，用 `wc -c` 取>,
      "sha256": "<Step 2 记下的 bundle sha256>",
      "limits": {
        "maximum_path_bytes": 512,
        "maximum_file_bytes": 8388608,
        "maximum_total_file_bytes": 67108864,
        "maximum_entries": 4096
      }
    }
  },
  "manifest": {
    "release_path": "contract-manifest.json",
    "local_path": "contracts/aether-contracts/v0.1.0-alpha.4/contract-manifest.json",
    "sha256": "<Step 3 记下的 manifest sha256>"
  },
```

上面尖括号里的值来自 Step 2/3 的实际输出，不是待填占位——照抄命令输出即可。

- [ ] **Step 5: 跑测试确认绊线被触发**

Run: `pnpm vitest run adapters/integration-projection/aether-contracts/test/candidate-artifacts.test.ts`
Expected: FAIL。该测试在 `candidate-artifacts.test.ts:28-35` 硬断言
`source_version === "0.1.0-alpha.4"`、`publication_status === "candidate-unpublished"`
以及一个固定的 `source_contract_manifest_sha256`，并读取已被删除的 `candidate-lock.json`。
**这次失败是预期的**，它证明契约状态无法被悄悄漂移。

- [ ] **Step 6: 把绊线翻转为已发布断言**

把 `adapters/integration-projection/aether-contracts/test/candidate-artifacts.test.ts` 整体替换为：

```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface ConsumerLock {
  readonly status: string;
  readonly release: Readonly<{ version: string; tag: string }>;
  readonly manifest: Readonly<{ local_path: string; sha256: string }>;
}

function isConsumerLock(input: unknown): input is ConsumerLock {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  const release = record.release as Record<string, unknown> | undefined;
  const manifest = record.manifest as Record<string, unknown> | undefined;
  return (
    record.status === "complete-consumer" &&
    typeof release?.version === "string" &&
    typeof release.tag === "string" &&
    typeof manifest?.local_path === "string" &&
    typeof manifest.sha256 === "string"
  );
}

describe("AetherContracts alpha.4 published consumption", () => {
  it("pins the published alpha.4 release rather than an unpublished candidate", async () => {
    const raw = await readFile(
      new URL("../../../../aether-contracts.lock.json", import.meta.url),
    );
    const decoded = JSON.parse(raw.toString("utf8")) as unknown;

    expect(isConsumerLock(decoded)).toBe(true);
    if (!isConsumerLock(decoded))
      throw new TypeError("consumer lock is invalid");
    expect(decoded.release.version).toBe("0.1.0-alpha.4");
    expect(decoded.release.tag).toBe("v0.1.0-alpha.4");
  });

  it("verifies the imported manifest against the locked digest", async () => {
    const raw = await readFile(
      new URL("../../../../aether-contracts.lock.json", import.meta.url),
    );
    const decoded = JSON.parse(raw.toString("utf8")) as unknown;
    if (!isConsumerLock(decoded))
      throw new TypeError("consumer lock is invalid");

    const manifest = await readFile(
      new URL(`../../../../${decoded.manifest.local_path}`, import.meta.url),
    );
    const digest = createHash("sha256").update(manifest).digest("hex");

    expect(digest).toBe(decoded.manifest.sha256);
  });

  it("no longer carries an unpublished candidate lock", async () => {
    await expect(
      readFile(
        new URL(
          "../../../../contracts/aether-contracts/v0.1.0-alpha.4/candidate-lock.json",
          import.meta.url,
        ),
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 7: 修掉所有指向候选目录的路径引用**

```bash
grep -rn "alpha.4-candidate" --include="*.ts" --include="*.json" --include="*.md" . | grep -v node_modules
```

逐条改成 `v0.1.0-alpha.4`。按仓库规则，发现同类问题要一次改完，不要一处一提交。
`docs/concepts/home-assistant-integration.md` 与 `docs/concepts/current-state-audit.md` 中
描述"候选未发布"的措辞也要同步更新为已发布事实。

- [ ] **Step 8: 全量验证**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "chore: consume published AetherContracts 0.1.0-alpha.4"
```

---

# 步骤二：CloudLink 生产组合根

## Task 2: 按环境变量选择投影仓储

**Files:**

- Create: `apps/cloudlink/src/integration-projection-store.ts`
- Create: `apps/cloudlink/test/integration-projection-store.test.ts`
- Modify: `apps/cloudlink/package.json`

- [ ] **Step 1: 先加依赖，否则测试连编译都过不了**

编辑 `apps/cloudlink/package.json`。把 `@aether-cloud/integration-projection-memory-adapter`
从 `devDependencies` **移到** `dependencies`，并在 `dependencies` 中新增两项。
改完后 `dependencies` 应为：

```json
  "dependencies": {
    "@aether-cloud/application": "workspace:*",
    "@aether-cloud/cloudlink-mqtt-adapter": "workspace:*",
    "@aether-cloud/domain": "workspace:*",
    "@aether-cloud/fleet-postgres-adapter": "workspace:*",
    "@aether-cloud/integration-aether-contracts-adapter": "workspace:*",
    "@aether-cloud/integration-projection-memory-adapter": "workspace:*",
    "@aether-cloud/integration-projection-postgres-adapter": "workspace:*"
  },
```

`@aether-cloud/fleet-postgres-adapter` 是为了取 `NodePostgresPool`——它是仓库里已有的
连接池实现，`apps/api/src/runtime.ts:19` 就是从这里取的。

Run: `pnpm install`
Expected: 无错误。

- [ ] **Step 2: 写失败测试**

创建 `apps/cloudlink/test/integration-projection-store.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { composeIntegrationProjectionStore } from "../src/integration-projection-store.js";

describe("composeIntegrationProjectionStore", () => {
  it("defaults to the memory repository so the default test path needs no database", () => {
    const store = composeIntegrationProjectionStore({});

    expect(store.repository).toBeDefined();
    expect(store.pool).toBeUndefined();
  });

  it("accepts an explicit memory selection", () => {
    const store = composeIntegrationProjectionStore({
      AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "memory",
    });

    expect(store.pool).toBeUndefined();
  });

  it("rejects an unknown store selection", () => {
    expect(() =>
      composeIntegrationProjectionStore({
        AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "sqlite",
      }),
    ).toThrow(
      "AETHER_CLOUD_INTEGRATION_PROJECTION_STORE must be memory or postgres",
    );
  });

  it("requires a verify-full TLS PostgreSQL URL when postgres is selected", () => {
    expect(() =>
      composeIntegrationProjectionStore({
        AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "postgresql://user:secret@db.example:5432/aether",
      }),
    ).toThrow("AETHER_CLOUD_POSTGRES_URL must use verify-full TLS");
  });

  it("builds a PostgreSQL repository through the injected pool factory", () => {
    let seenMax: number | undefined;
    const store = composeIntegrationProjectionStore(
      {
        AETHER_CLOUD_INTEGRATION_PROJECTION_STORE: "postgres",
        AETHER_CLOUD_POSTGRES_URL:
          "postgresql://user:secret@db.example:5432/aether?sslmode=verify-full",
      },
      {
        postgresPoolFactory(configuration) {
          seenMax = configuration.max;
          return {
            query: () => Promise.reject(new Error("unused")),
            connect: () => Promise.reject(new Error("unused")),
            end: () => Promise.resolve(),
          };
        },
      },
    );

    expect(seenMax).toBe(5);
    expect(store.pool).toBeDefined();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run apps/cloudlink/test/integration-projection-store.test.ts`
Expected: FAIL，报 `Failed to resolve import "../src/integration-projection-store.js"`。

- [ ] **Step 4: 写最小实现**

创建 `apps/cloudlink/src/integration-projection-store.ts`：

```ts
import { NodePostgresPool } from "@aether-cloud/fleet-postgres-adapter";
import { InMemoryIntegrationProjectionRepository } from "@aether-cloud/integration-projection-memory-adapter";
import {
  PostgresIntegrationProjectionRepository,
  type PostgresIntegrationProjectionPool,
} from "@aether-cloud/integration-projection-postgres-adapter";
import { URL } from "node:url";

import type {
  IntegrationProjectionCatalog,
  IntegrationProjectionRepository,
} from "@aether-cloud/application";

export interface IntegrationProjectionPoolConfiguration {
  readonly connectionString: string;
  readonly max: number;
  readonly connectionTimeoutMillis: number;
  readonly idleTimeoutMillis: number;
  readonly statement_timeout: number;
}

interface ClosableProjectionPool extends PostgresIntegrationProjectionPool {
  end(): Promise<void>;
}

export interface IntegrationProjectionStoreFactories {
  readonly postgresPoolFactory?: (
    configuration: IntegrationProjectionPoolConfiguration,
  ) => ClosableProjectionPool;
}

export interface IntegrationProjectionStore {
  readonly repository: IntegrationProjectionRepository &
    IntegrationProjectionCatalog;
  readonly pool?: ClosableProjectionPool;
}

function connectionString(environment: NodeJS.ProcessEnv): string {
  const input = environment.AETHER_CLOUD_POSTGRES_URL;
  if (input === undefined || input.length === 0) {
    throw new Error(
      "AETHER_CLOUD_POSTGRES_URL is required when the projection store is postgres",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("AETHER_CLOUD_POSTGRES_URL must be a PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("AETHER_CLOUD_POSTGRES_URL must be a PostgreSQL URL");
  }
  if (parsed.password.length === 0) {
    throw new Error("AETHER_CLOUD_POSTGRES_URL must include a password");
  }
  if (parsed.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("AETHER_CLOUD_POSTGRES_URL must use verify-full TLS");
  }
  return input;
}

export function composeIntegrationProjectionStore(
  environment: NodeJS.ProcessEnv,
  factories: IntegrationProjectionStoreFactories = {},
): IntegrationProjectionStore {
  const mode =
    environment.AETHER_CLOUD_INTEGRATION_PROJECTION_STORE ?? "memory";
  if (mode === "memory") {
    return { repository: new InMemoryIntegrationProjectionRepository() };
  }
  if (mode !== "postgres") {
    throw new Error(
      "AETHER_CLOUD_INTEGRATION_PROJECTION_STORE must be memory or postgres",
    );
  }
  const configuration: IntegrationProjectionPoolConfiguration = {
    connectionString: connectionString(environment),
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5_000,
  };
  const pool =
    factories.postgresPoolFactory?.(configuration) ??
    (NodePostgresPool.fromConfig(configuration) as ClosableProjectionPool);
  return {
    repository: new PostgresIntegrationProjectionRepository(pool),
    pool,
  };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run apps/cloudlink/test/integration-projection-store.test.ts`
Expected: PASS（5 个用例全绿）

若 `InMemoryIntegrationProjectionRepository` 的类型不满足
`IntegrationProjectionRepository & IntegrationProjectionCatalog`，
说明 memory adapter 未实现 catalog 端口。此时不要放宽类型——
去 `adapters/integration-projection/memory/src/in-memory-integration-projection-repository.ts`
补上 `list()`，并在该 adapter 的测试里覆盖它。

- [ ] **Step 6: 提交**

```bash
git add apps/cloudlink/package.json apps/cloudlink/src/integration-projection-store.ts apps/cloudlink/test/integration-projection-store.test.ts pnpm-lock.yaml
git commit -m "feat: select the CloudLink integration projection store by environment"
```

---

## Task 3: CloudLink 生产组合根

> **本 Task 的 spec 已于 2026-08-01 重写。** 下方 Step 3 与 Step 5 的原始代码走的是
> Gateway 逐条签名路径，而该路径**在本仓库没有生产实现**——见下方"凭据路径"。
> 以本节开头的说明为准，原始 Step 3/Step 5 正文仅作历史保留。

### 凭据路径：走 trusted connector，不走 Gateway 签名

派发前的核查发现三件事，指向同一个结论：

- `resolvePublicKey` 的**每一个**实现都在测试或 harness 脚本里，无生产适配器；
- `GatewayCredentialVerifier` 只有 `InMemoryGatewayCredentialVerifier` 一个实现，
  没有 PostgreSQL 版本；
- `PostgresGatewayIdentityRepository` 只存 `credential_request_fingerprint`
  （入网申领指纹），不是可用于签名的活跃凭据。

这与 `docs/concepts/current-state-audit.md` 一致：Gateway 的注册、Claim 签发、
指纹绑定消费已实现，而 **active credential issuance、trust-key lifecycle、
CA/KMS 仍是 planned**。因此 Gateway 逐条签名路径无法在 A0 落地。

`apps/cloudlink/src/cloudlink-mqtt-application-bridge.ts` 的 `#openSession`
按 `message.credential_binding.origin_model` 分叉：值为 `"gateway-signed"` 时走
签名路径，**其他值走 trusted connector 路径**，只需要
`resolveTrustedConnectorCredential` 返回 `{ credentialId, proof }`
（见同文件 `trustedConnectorCredential()`，第 136 行；`proof` 上限 4096 字节）。

这条路径是 ADR-0014 第 5 条明确留下的合法替代方案，不是绕过它。

**因此 A0 的组合根：**

- **不接** `requestSessionChallenge`、`acceptGatewaySignedSession`、
  `authenticateGatewaySignedUplink` 三个依赖（它们都是可选的）；
- **接** `resolveTrustedConnectorCredential`，凭据由运营方通过环境配置提供；
- `OpenCloudLinkSession` 需要的 `credentialVerifier` 用
  `InMemoryGatewayCredentialVerifier` 从同一份配置播种——这里的"内存"指
  凭据的真源是运营方配置而非云端数据库，这是刻意的：**云端不存长期凭据**；
- 其余只读投影接线不变。

**诚实性要求（必须落到文档）：** 这是受限模式，只适用于运营方能带外确认发布者
身份的小规模部署（A0 的 homelab 目标场景）。不得宣称支持多租户多 Gateway 规模，
也不得暗示 Gateway 逐条签名认证已可用。交付时更新
`docs/concepts/current-state-audit.md` 与 `docs/concepts/cloudlink-and-core-state-machines.md`
说明这一点。

**安全：** 凭据 `proof` 是机密，来自环境变量。它不得进入日志、错误信息、审计负载、
测试夹具或任何输出。

---

以下为原始 spec 正文（Step 3、Step 5 的 Gateway 签名接线已作废，其余仍适用）。
参考实现是 `scripts/run-home-assistant-e2e-harness.ts:673-834`。
本 Task 把那段接线搬进组合根，并做三处删改：去掉 `integrationControlFactory`、
去掉 `INTEGRATION_CONTROL_PROTOCOL` 扩展、去掉 harness 专用的 `Observed*` 包装。

**Files:**

- Create: `apps/cloudlink/src/runtime.ts`
- Create: `apps/cloudlink/test/runtime.test.ts`

- [ ] **Step 1: 写失败测试——先证明控制路径不可达**

创建 `apps/cloudlink/test/runtime.test.ts`：

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { composeCloudLinkRuntime } from "../src/runtime.js";

const baseEnvironment = {
  AETHER_CLOUD_CLOUDLINK_MQTT_URL: "mqtt://127.0.0.1:1883",
  AETHER_CLOUD_CLOUDLINK_TOPIC_PREFIX: "aether-cloud",
  AETHER_CLOUD_TENANT_ID: "tenant-a0",
  AETHER_CLOUD_PROJECT_ID: "project-a0",
} as const;

describe("composeCloudLinkRuntime", () => {
  it("never wires the governed control path", async () => {
    const source = await readFile(
      new URL("../src/runtime.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("integrationControlFactory");
    expect(source).not.toContain("integration-control");
    expect(source).not.toContain("INTEGRATION_CONTROL_PROTOCOL");
  });

  it("enables only the read-only integration extension", () => {
    const runtime = composeCloudLinkRuntime(baseEnvironment);

    expect(runtime.enabledExtensions).toEqual([
      "aether.cloudlink.integration.v1alpha1",
    ]);
  });

  it("defaults to the memory projection store", () => {
    const runtime = composeCloudLinkRuntime(baseEnvironment);

    expect(runtime.projectionStoreMode).toBe("memory");
  });

  it("requires an MQTT broker URL", () => {
    expect(() =>
      composeCloudLinkRuntime({
        AETHER_CLOUD_CLOUDLINK_TOPIC_PREFIX: "aether-cloud",
        AETHER_CLOUD_TENANT_ID: "tenant-a0",
        AETHER_CLOUD_PROJECT_ID: "project-a0",
      }),
    ).toThrow("AETHER_CLOUD_CLOUDLINK_MQTT_URL is required");
  });

  it("rejects a topic prefix that could collide across tenants", () => {
    expect(() =>
      composeCloudLinkRuntime({
        ...baseEnvironment,
        AETHER_CLOUD_CLOUDLINK_TOPIC_PREFIX: "",
      }),
    ).toThrow("AETHER_CLOUD_CLOUDLINK_TOPIC_PREFIX is required");
  });

  it("does not connect to the broker until start is called", () => {
    const runtime = composeCloudLinkRuntime(baseEnvironment);

    expect(runtime.running).toBe(false);
  });
});
```

第一个用例是**源码断言**而不是行为断言。这是刻意的：控制路径的"不可达"必须是结构性的，
任何人把控制依赖加回来都会立刻变红，而不是等到运行时才发现。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/cloudlink/test/runtime.test.ts`
Expected: FAIL，报 `Failed to resolve import "../src/runtime.js"`。

- [ ] **Step 3: 写组合根**

创建 `apps/cloudlink/src/runtime.ts`：

```ts
import {
  AcceptGatewaySignedCloudLinkSession,
  AuthenticateGatewaySignedCloudLinkUplink,
  OpenCloudLinkSession,
  RecordCloudLinkDurableCursor,
  RecordCloudLinkHeartbeat,
  ReportGatewayRuntimeManifest,
  ReportIntegrationObservations,
  ReportIntegrationTopology,
  RequestCloudLinkSessionChallenge,
  RestoreGatewayRuntimeProtocols,
} from "@aether-cloud/application";
import { parseUtcInstant } from "@aether-cloud/domain";
import { NodeIntegrationPayloadDigestor } from "@aether-cloud/integration-projection-memory-adapter";
import { randomUUID } from "node:crypto";

import { composeIntegrationProjectionStore } from "./integration-projection-store.js";
import {
  startCloudLinkMqttIngress,
  type RunningCloudLinkMqttIngress,
} from "./cloudlink-mqtt-ingress.js";

const integrationExtension = "aether.cloudlink.integration.v1alpha1" as const;

export interface CloudLinkRuntime {
  readonly enabledExtensions: readonly [typeof integrationExtension];
  readonly projectionStoreMode: "memory" | "postgres";
  readonly running: boolean;
  start(): Promise<void>;
  close(): Promise<void>;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function composeCloudLinkRuntime(
  environment: NodeJS.ProcessEnv,
): CloudLinkRuntime {
  const brokerUrl = required(environment, "AETHER_CLOUD_CLOUDLINK_MQTT_URL");
  const topicPrefix = required(
    environment,
    "AETHER_CLOUD_CLOUDLINK_TOPIC_PREFIX",
  );
  const tenantId = required(environment, "AETHER_CLOUD_TENANT_ID");
  const projectId = required(environment, "AETHER_CLOUD_PROJECT_ID");
  const store = composeIntegrationProjectionStore(environment);
  const clock = { now: () => parseUtcInstant(new Date().toISOString()) };
  const digestor = new NodeIntegrationPayloadDigestor();

  let ingress: RunningCloudLinkMqttIngress | undefined;

  return {
    enabledExtensions: [integrationExtension],
    projectionStoreMode: store.pool === undefined ? "memory" : "postgres",
    get running() {
      return ingress !== undefined;
    },
    async start() {
      ingress = await startCloudLinkMqttIngress({
        connection: {
          url: brokerUrl,
          clientId: `aether-cloud-cloudlink-${randomUUID()}`,
          protocolVersion: 4,
          connectTimeoutMs: 5_000,
        },
        topicPrefix,
        gatewaySignedScope: { tenantId, projectId },
        reportIntegrationTopology: new ReportIntegrationTopology({
          repository: store.repository,
          digestor,
          clock,
        }),
        reportIntegrationObservations: new ReportIntegrationObservations({
          repository: store.repository,
          digestor,
          clock,
        }),
        enabledExtensions: [integrationExtension],
        clock,
      });
    },
    async close() {
      await ingress?.close();
      ingress = undefined;
      await store.pool?.end();
    },
  };
}
```

**注意：** 上面的 `startCloudLinkMqttIngress` 调用是**骨架**，只接了只读投影两条命令。
`CloudLinkMqttIngressDependencies`（见 `apps/cloudlink/src/cloudlink-mqtt-ingress.ts:38-65`）
还要求 `openSession`、`heartbeat`、`reportManifest`、`ingestTelemetry` 四个必填项，
以及会话认证相关的可选项。Step 4 会因为类型不全而失败——这是预期的推进节奏。

- [ ] **Step 4: 跑类型检查，让编译器列出缺的依赖**

Run: `pnpm typecheck`
Expected: FAIL，报 `startCloudLinkMqttIngress` 的参数缺少
`openSession`、`heartbeat`、`reportManifest`、`ingestTelemetry`。

- [ ] **Step 5: 补齐必填依赖**

**先读这条约束：`adapters/runtime` 下只有 `memory`，没有 PostgreSQL 适配器。**
Runtime Manifest 因此只能落在内存里，进程重启后声明丢失，
`RestoreGatewayRuntimeProtocols` 会查不到记录，直到 Gateway 重新上报 manifest。
这是 A0 的已知限制，不要试图在本计划里顺手实现 PostgreSQL manifest 仓储——
那是独立的一块工作。把这条限制写进 Step 7 的提交信息里。

会话仓储有 memory 与 postgres 两种（`adapters/cloudlink/memory`、`adapters/cloudlink/postgres`），
与投影仓储共用 `AETHER_CLOUD_INTEGRATION_PROJECTION_STORE` 的选择结果，
避免出现"投影落库但会话在内存"的半持久化组合。

在 `composeCloudLinkRuntime` 的顶部补上依赖构造：

```ts
import {
  InMemoryCloudLinkSessionRepository,
  InMemoryGatewayCredentialVerifier,
} from "@aether-cloud/cloudlink-memory-adapter";
import { PostgresCloudLinkSessionRepository } from "@aether-cloud/cloudlink-postgres-adapter";
import {
  NodeCloudLinkBusinessPayloadDigestor,
  NodeCloudLinkSessionChallengeMaterialGenerator,
  NodeEd25519CloudLinkGatewayHelloAuthenticator,
  NodeEd25519CloudLinkSessionChallengeSigner,
  NodeEd25519CloudLinkUplinkVerifier,
} from "@aether-cloud/cloudlink-node-crypto-adapter";
import {
  InMemoryRuntimeManifestRepository,
  NodeRuntimeManifestIntegrityVerifier,
} from "@aether-cloud/runtime-memory-adapter";
```

把这四个包加进 `apps/cloudlink/package.json` 的 `dependencies`，然后 `pnpm install`。

在 `composeCloudLinkRuntime` 函数体内、`return` 之前构造：

```ts
const sessions =
  store.pool === undefined
    ? new InMemoryCloudLinkSessionRepository()
    : new PostgresCloudLinkSessionRepository(store.pool);
const verifier = new InMemoryGatewayCredentialVerifier();
const manifests = new InMemoryRuntimeManifestRepository();
const businessPayloadDigestor = new NodeCloudLinkBusinessPayloadDigestor();
const reportManifest = new ReportGatewayRuntimeManifest({
  repository: manifests,
  credentialVerifier: verifier,
  integrityVerifier: new NodeRuntimeManifestIntegrityVerifier(),
  clock,
});
```

然后把 `start()` 里的 `startCloudLinkMqttIngress` 参数补全为：

```ts
ingress = await startCloudLinkMqttIngress({
  connection: {
    url: brokerUrl,
    clientId: `aether-cloud-cloudlink-${randomUUID()}`,
    protocolVersion: 4,
    connectTimeoutMs: 5_000,
  },
  topicPrefix,
  gatewaySignedScope: { tenantId, projectId },
  requestSessionChallenge: new RequestCloudLinkSessionChallenge({
    repository: sessions,
    credentials: verifier,
    signer: new NodeEd25519CloudLinkSessionChallengeSigner({
      keyReference: required(
        environment,
        "AETHER_CLOUD_CLOUDLINK_SESSION_KEY_REFERENCE",
      ),
      privateKey: sessionSigningKey(environment),
    }),
    materials: new NodeCloudLinkSessionChallengeMaterialGenerator(),
    clock,
    supportedProtocolVersions: ["1.0"],
    enabled: true,
  }),
  acceptGatewaySignedSession: new AcceptGatewaySignedCloudLinkSession({
    repository: sessions,
    credentials: verifier,
    authenticator: new NodeEd25519CloudLinkGatewayHelloAuthenticator({
      resolvePublicKey: (input) => verifier.resolveSessionPublicKey(input),
    }),
    clock,
    sessionIds: { next: randomUUID },
    supportedProtocolVersions: ["1.0"],
    enabled: true,
  }),
  authenticateGatewaySignedUplink: new AuthenticateGatewaySignedCloudLinkUplink(
    {
      sessions,
      repository: sessions,
      verifier: new NodeEd25519CloudLinkUplinkVerifier({
        resolvePublicKey: (input) => verifier.resolveUplinkPublicKey(input),
      }),
      clock,
      enabled: true,
    },
  ),
  openSession: new OpenCloudLinkSession({
    repository: sessions,
    credentialVerifier: verifier,
    clock,
    sessionIds: { next: randomUUID },
    supportedProtocolVersions: ["1.0"],
  }),
  heartbeat: new RecordCloudLinkHeartbeat({
    repository: sessions,
    credentialVerifier: verifier,
    clock,
  }),
  reportManifest,
  restoreRuntimeProtocols: new RestoreGatewayRuntimeProtocols({
    repository: manifests,
    credentialVerifier: verifier,
  }),
  ingestTelemetry: rejectedTelemetryCommand,
  reportIntegrationTopology: new ReportIntegrationTopology({
    repository: store.repository,
    verifier,
    digestor,
    businessPayloadDigestor,
    clock,
  }),
  reportIntegrationObservations: new ReportIntegrationObservations({
    repository: store.repository,
    verifier,
    digestor,
    businessPayloadDigestor,
    clock,
  }),
  recordDurableCursor: new RecordCloudLinkDurableCursor({
    repository: sessions,
    credentialVerifier: verifier,
    businessPayloadDigestor,
    clock,
  }),
  enabledExtensions: [integrationExtension],
  clock,
});
```

A0 不消费遥测，但 `ingestTelemetry` 是必填项。定义一个显式拒绝的实现放在文件顶部，
**不要传一个静默接受的空实现**——那会让遥测看起来被受理了：

```ts
const rejectedTelemetryCommand = {
  execute: () =>
    Promise.resolve({
      ok: false as const,
      failure: {
        code: "invalid-input" as const,
        message:
          "telemetry ingestion is not part of the read-only A0 composition",
      },
    }),
};
```

`sessionSigningKey(environment)` 需要你按仓库既有做法从环境读取私钥引用并构造
`KeyObject`。**私钥材料不得出现在日志、错误信息或测试夹具里。**

`verifier.resolveSessionPublicKey` / `resolveUplinkPublicKey` 若在
`InMemoryGatewayCredentialVerifier` 上不存在，就照它已有的凭据查询方法改写这两个箭头函数——
以该适配器的实际导出为准，不要新增方法来迁就这段代码。

**不要**补 `integrationControlFactory`。

在 `runtime.test.ts` 里补一条用例，断言遥测被拒绝而非静默接受：

```ts
it("rejects telemetry instead of silently accepting it", async () => {
  const runtime = composeCloudLinkRuntime(baseEnvironment);
  const source = await readFile(
    new URL("../src/runtime.ts", import.meta.url),
    "utf8",
  );

  expect(source).toContain(
    "telemetry ingestion is not part of the read-only A0 composition",
  );
  expect(runtime.projectionStoreMode).toBe("memory");
});
```

- [ ] **Step 6: 跑测试确认全绿**

Run: `pnpm vitest run apps/cloudlink/test/ && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add apps/cloudlink/src/runtime.ts apps/cloudlink/test/runtime.test.ts
git commit -m "feat: compose a read-only CloudLink runtime without the control path"
```

---

## Task 4: 进程入口与部署配置

**部署前置（仓库外，必须先完成）：** Task 2 创建的
`aethercloud_cloudlink_ingress` 角色是 `NOLOGIN` 的，迁移里不含密码。
部署前需要在目标数据库上执行 `ALTER ROLE ... LOGIN PASSWORD ...` 完成置备，
与 `aethercloud_cloudlink_health_worker` 的做法一致
（仓库内只有 `aethercloud_app` 有 `apps/api/src/postgres-role-activation.ts`
这条自动激活路径，其余角色靠运维流程）。置备完成后把连接串放进
`AETHER_CLOUD_CLOUDLINK_INGRESS_POSTGRES_URL`。

注意：角色迁移里的 `rolcanlogin` 守卫意味着**对已正确置备的数据库重跑该迁移会
报错**。这对三个角色迁移都成立，是预期行为，不是缺陷。

### Task 3 交接给本 Task 的部署面（写 `server.ts` 前先读完）

**必须落到 `docs/reference/` 的环境变量**（Task 3 刻意把它们排除在概念文档之外，
留给本 Task 建立正式条目）。以 `apps/cloudlink/src/runtime.ts` 与
`apps/cloudlink/src/trusted-connector-credentials.ts` 的实际实现为准，
不要照抄本节——本计划已经出过两次"照抄未验证内容"的错。

| 变量                                                 | 必填              | 说明                                                                                         |
| ---------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------- |
| `AETHER_CLOUD_CLOUDLINK_MQTT_URL`                    | 是                | Broker 地址                                                                                  |
| `AETHER_CLOUD_CLOUDLINK_TOPIC_PREFIX`                | 是                | 主题前缀                                                                                     |
| `AETHER_CLOUD_TENANT_ID` / `AETHER_CLOUD_PROJECT_ID` | 是                | 规范小写 UUID                                                                                |
| `AETHER_CLOUD_CLOUDLINK_TRUSTED_GATEWAY_CREDENTIALS` | 是                | JSON 数组，1–64 项，每项 `gatewayId`/`credentialId`/`generation`/`proof`。**`proof` 是机密** |
| `AETHER_CLOUD_INTEGRATION_PROJECTION_STORE`          | 否                | `memory`（默认）或 `postgres`                                                                |
| `AETHER_CLOUD_CLOUDLINK_INGRESS_POSTGRES_URL`        | postgres 模式必填 | 必须使用 `aethercloud_cloudlink_ingress` 角色与 `verify-full` TLS                            |
| `AETHER_CLOUD_CLOUDLINK_MQTT_USERNAME` / `_PASSWORD` | 否                | **ingress 自己**登录 broker 的凭据，不是 per-Gateway ACL                                     |
| MQTT client ID 覆盖变量                              | 否                | 默认 `aether-cloud-cloudlink-ingress`；**以实现为准取变量名**                                |

**单实例约束（必须写进文档）：** clientId 是稳定的，这是让传输层的
`clean: false` 持久会话真正生效所必需的。代价是**两个使用相同 clientId 的
ingress 实例会互相把对方踢下线**，因此 A0 只支持一个 ingress 实例。这与仓库
既有立场一致（multi-instance ownership 列为 planned），但它现在是一条部署约束。

**安全姿态（必须写进文档，不得软化）：** 本模式的认证**完全依赖 broker 端的
per-Gateway ACL**，未配置则等同于无认证。凭据校验在构造上是同义反复的——
以报文自称的身份去查一张由自称索引的配置表。`proof` 从不上线（云端不接收机密），
但任何人只要能向 `<prefix>/v1/gateways/<uuid>/up/...` 发布、并知道三个非机密
字符串，就能开启会话。ADR-0014 第 5 条要求 trusted connector 为**每次发布**提供
带外验证的发布者证明，本组合根不消费任何此类证明，也无法检测其缺失。
概念文档已写明这一点，`docs/reference/` 的部署页必须同样写明。

**TLS 信任面：** `adapters/cloudlink/mqtt/src/node-mqtt-transport.ts` 已支持
`caPath`/`clientCertificatePath`/`clientPrivateKeyPath`，而 ADR-0014 第 2 条把
TLS 信任与 URL、主题前缀并列为运营方配置。Task 3 未暴露这个面并在代码注释里
标注为本 Task 的工作。**决定要不要在 A0 暴露它**：暴露则加环境变量并记录；
不暴露则在文档里明说 A0 只支持 broker 提供的默认信任，并说明后果。

**可观测性：** Task 3 接了一个 stderr observer（只输出错误码，不含消息与负载）。
它在 `deferred` 结果上也会输出，而 `deferred` 是正常背压，因此一个存在持续
数据缺口的 Gateway 会产生稳定的 stderr 输出。部署后若过噪，这是第一个要调的
地方——但不要为了安静而默认关掉它，A0 目前没有别的可观测手段。

**Files:**

- Create: `apps/cloudlink/src/server.ts`
- Create: `railway.cloudlink.json`
- Modify: `apps/cloudlink/package.json`
- Create/Modify: `docs/reference/` 下的部署与环境变量条目（连同 frontmatter、
  `ai/docs-manifest.json`、`llms.txt` 一并更新）

- [ ] **Step 1: 写进程入口**

创建 `apps/cloudlink/src/server.ts`，形状对照 `apps/api/src/server.ts`：

```ts
import { composeCloudLinkRuntime } from "./runtime.js";

const runtime = composeCloudLinkRuntime(process.env);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  process.stderr.write(`cloudlink shutting down on ${signal}\n`);
  await runtime.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await runtime.start();
  process.stderr.write(
    `cloudlink ingress started with ${runtime.projectionStoreMode} projection store\n`,
  );
} catch (error: unknown) {
  process.stderr.write(`cloudlink failed to start: ${String(error)}\n`);
  await runtime.close();
  process.exitCode = 1;
}
```

- [ ] **Step 2: 加启动脚本**

在 `apps/cloudlink/package.json` 顶层加入（与 `dependencies` 平级）：

```json
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts"
  },
```

并把 `tsx` 加进 `dependencies`：`"tsx": "4.23.1"`。

Run: `pnpm install`
Expected: 无错误。

- [ ] **Step 3: 验证进程能起也能停**

```bash
AETHER_CLOUD_CLOUDLINK_MQTT_URL=mqtt://127.0.0.1:1883 \
AETHER_CLOUD_CLOUDLINK_TOPIC_PREFIX=aether-cloud \
AETHER_CLOUD_TENANT_ID=tenant-a0 \
AETHER_CLOUD_PROJECT_ID=project-a0 \
timeout 10 pnpm --filter @aether-cloud/cloudlink start
```

Expected: 若本机无 broker，进程应打印 `cloudlink failed to start:` 并以非零码退出——
**这就是正确行为**，说明它不会假装连上了。若本机有 Mosquitto，应打印
`cloudlink ingress started with memory projection store`。

- [ ] **Step 4: 写 Railway service 配置**

创建 `railway.cloudlink.json`。注意 CloudLink 是常驻的 MQTT 订阅进程，没有 HTTP 端口，
因此**不能**配 `healthcheckPath`：

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "RAILPACK"
  },
  "deploy": {
    "drainingSeconds": 30,
    "restartPolicyMaxRetries": 10,
    "restartPolicyType": "ON_FAILURE",
    "runtime": "V2",
    "sleepApplication": false,
    "startCommand": "pnpm --filter @aether-cloud/cloudlink start"
  }
}
```

在 Railway 控制台新建一个 service，把它的 Config-as-code 路径指向 `railway.cloudlink.json`。
现有 `railway.json` 保持不动，继续服务 API 进程。

- [ ] **Step 5: 全量验证**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 6: 真实 broker 验证**

Run: `pnpm test:mqtt-integration`
Expected: PASS。若本机没有 Mosquitto，用
`brew install mosquitto && brew services start mosquitto` 装一个。
**这一步不能跳过**——它是 A0 唯一一个证明真实传输路径可用的关卡。

- [ ] **Step 7: 提交**

```bash
git add apps/cloudlink/src/server.ts apps/cloudlink/package.json railway.cloudlink.json pnpm-lock.yaml
git commit -m "feat: run the read-only CloudLink ingress as a deployable process"
```

---

# 步骤三：只读公开面

## Task 5: 把 fleet 路由抽成模块（纯重构，行为不变）

`apps/api/src/app.ts` 现有 1170 行。加两条新路由前先减负，否则新代码会落进一个已经过大的文件。

**Files:**

- Create: `apps/api/src/fleet-routes.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: 记录基线，作为"行为不变"的证据**

Run: `pnpm vitest run apps/api/test/app.test.ts`
Expected: PASS。**记下通过的用例数**，重构后必须一致。

- [ ] **Step 2: 抽出模块**

把 `apps/api/src/app.ts` 中 fleet 相关的全部内容移入新建的 `apps/api/src/fleet-routes.ts`：
`fleetListSchema`、`fleetGatewaySchema`、`registeredGatewaySchema`、`fleetFailureStatus`、
`gatewayCommandFailureStatus`，以及从 `app.ts:610` 起到 enrollment 路由结束的全部
`app.get` / `app.post` 注册。

导出一个注册函数：

```ts
export function registerFleetRoutes(
  app: FastifyInstance,
  fleet: FleetHttpDependencies,
): void {
  // 这里是从 app.ts 原样搬过来的路由注册，逻辑一行不改
}
```

`sendError`、`isRecord`、`errorResponseSchema` 被多个路由组共用，
把它们移入新建的 `apps/api/src/http-responses.ts` 并从两处导入。

- [ ] **Step 3: 在 app.ts 中改为调用**

`app.ts` 中原来的整段 fleet 代码替换为：

```ts
const fleet = options.fleet;
if (fleet !== undefined) {
  registerFleetRoutes(app, fleet);
}
```

- [ ] **Step 4: 确认行为不变**

Run: `pnpm vitest run apps/api/test/app.test.ts`
Expected: PASS，且通过用例数与 Step 1 完全一致。数量不一致说明搬漏了东西。

Run: `wc -l apps/api/src/app.ts`
Expected: 明显低于 1170。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/app.ts apps/api/src/fleet-routes.ts apps/api/src/http-responses.ts
git commit -m "refactor: extract fleet routes from the API app module"
```

---

## Task 6: 把 audit 路由抽成模块（纯重构，行为不变）

**Files:**

- Create: `apps/api/src/audit-routes.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: 记录基线**

Run: `pnpm vitest run apps/api/test/app.test.ts`
Expected: PASS，记下用例数。

- [ ] **Step 2: 抽出模块**

把 `auditEventResponseSchema`、`auditFailureStatus`、`encodeAuditSse`，
以及 `app.ts:1049` 与 `app.ts:1106` 两条 audit 路由移入 `apps/api/src/audit-routes.ts`，
导出：

```ts
export function registerAuditRoutes(
  app: FastifyInstance,
  audit: AuditHttpDependencies,
): void {
  // 从 app.ts 原样搬过来
}
```

- [ ] **Step 3: 在 app.ts 中改为调用**

```ts
const audit = options.audit;
if (audit !== undefined) {
  registerAuditRoutes(app, audit);
}
```

- [ ] **Step 4: 确认行为不变**

Run: `pnpm vitest run apps/api/test/app.test.ts`
Expected: PASS，用例数与 Step 1 一致。

Run: `wc -l apps/api/src/app.ts`
Expected: 低于 800。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/app.ts apps/api/src/audit-routes.ts
git commit -m "refactor: extract audit routes from the API app module"
```

---

## Task 7: 只读投影路由

应用层已备好两个查询，本 Task 只做传输层翻译：

- `ListIntegrationProjections`（`packages/application/src/list-integration-projections.ts:347`），
  失败码 `integration-storage-unavailable` / `invalid-input` /
  `invalid-integration-repository-result` / `permission-denied`
- `GetIntegrationProjection`（`packages/application/src/integration-projection.ts:2340`），
  失败码额外含 `integration-projection-not-found`
- 两者权限同为 `integration.projection.read`

**Files:**

- Create: `apps/api/src/integration-routes.ts`
- Create: `apps/api/test/integration-routes.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/runtime.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/integration-routes.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const subject = {
  tenantId: "tenant-a0",
  projectId: "project-a0",
  subjectId: "user-1",
  permissions: ["integration.projection.read"],
};

const authenticator = {
  authenticate(input: Readonly<{ authorization: string | undefined }>) {
    return Promise.resolve(
      input.authorization === "Bearer valid"
        ? ({ ok: true, value: subject } as const)
        : ({ ok: false, failure: { code: "unauthenticated" } } as const),
    );
  },
};

const catalogView = {
  authority: "edge-reported-copy" as const,
  liveStateAuthoritative: false as const,
  items: [
    {
      gatewayId: "gateway-1",
      integrationId: "home-assistant-1",
      integrationKind: "home-assistant",
      snapshotGeneration: "7",
      entityCount: 12,
      latestObservationCount: 12,
      receivedAt: "2026-07-31T00:00:00.000Z",
      revision: 3,
    },
  ],
};

function appWithIntegrations(
  overrides: Partial<{
    list: { execute: (context: unknown, input: unknown) => Promise<unknown> };
    get: { execute: (context: unknown, input: unknown) => Promise<unknown> };
  }> = {},
) {
  return buildApp({
    version: "test",
    integrations: {
      authenticator,
      list: overrides.list ?? {
        execute: () => Promise.resolve({ ok: true, value: catalogView }),
      },
      get: overrides.get ?? {
        execute: () =>
          Promise.resolve({
            ok: false,
            failure: {
              code: "integration-projection-not-found",
              message: "integration projection was not found",
            },
          }),
      },
    },
  });
}

describe("GET /api/v1/integrations", () => {
  it("rejects an unauthenticated request", async () => {
    const app = appWithIntegrations();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "unauthenticated" },
    });
    await app.close();
  });

  it("returns the catalog with its edge-reported authority intact", async () => {
    const app = appWithIntegrations();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations",
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      authority: "edge-reported-copy",
      liveStateAuthoritative: false,
    });
    await app.close();
  });

  it("rejects an unsupported query field", async () => {
    const app = appWithIntegrations();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations?unexpected=1",
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("translates permission-denied to 403", async () => {
    const app = appWithIntegrations({
      list: {
        execute: () =>
          Promise.resolve({
            ok: false,
            failure: {
              code: "permission-denied",
              message: "permission integration.projection.read is required",
            },
          }),
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations",
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("translates storage unavailability to 503", async () => {
    const app = appWithIntegrations({
      list: {
        execute: () =>
          Promise.resolve({
            ok: false,
            failure: {
              code: "integration-storage-unavailable",
              message: "integration projection catalog is unavailable",
            },
          }),
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations",
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it("forwards only the authenticated tenant and project scope", async () => {
    let seenContext: unknown;
    const app = appWithIntegrations({
      list: {
        execute: (context) => {
          seenContext = context;
          return Promise.resolve({ ok: true, value: catalogView });
        },
      },
    });
    await app.inject({
      method: "GET",
      url: "/api/v1/integrations",
      headers: { authorization: "Bearer valid" },
    });

    expect(seenContext).toMatchObject({
      tenantId: "tenant-a0",
      projectId: "project-a0",
    });
    await app.close();
  });
});

describe("GET /api/v1/integrations/:gatewayId/:integrationId", () => {
  it("translates a missing projection to 404", async () => {
    const app = appWithIntegrations();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/gateway-1/home-assistant-1",
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns the detail view with its authority labels", async () => {
    const app = appWithIntegrations({
      get: {
        execute: () =>
          Promise.resolve({
            ok: true,
            value: {
              authority: "edge-reported-copy",
              liveStateAuthoritative: false,
              tenantId: "tenant-a0",
              projectId: "project-a0",
              gatewayId: "gateway-1",
              integrationId: "home-assistant-1",
              topology: { areas: [], devices: [], entities: [] },
              topologyDigest: "sha256:abc",
              latestObservations: [],
              receivedAt: "2026-07-31T00:00:00.000Z",
              revision: 3,
            },
          }),
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/gateway-1/home-assistant-1",
      headers: { authorization: "Bearer valid" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      authority: "edge-reported-copy",
      liveStateAuthoritative: false,
    });
    await app.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/api/test/integration-routes.test.ts`
Expected: FAIL，报 `buildApp` 的参数不存在 `integrations` 属性。

- [ ] **Step 3: 写路由模块**

创建 `apps/api/src/integration-routes.ts`：

```ts
import { isRecord, sendError, errorResponseSchema } from "./http-responses.js";

import type {
  GetIntegrationProjection,
  IntegrationProjectionCatalogFailure,
  IntegrationProjectionFailure,
  ListIntegrationProjections,
} from "@aether-cloud/application";
import type { FastifyInstance } from "fastify";
import type { HttpAuthenticator } from "./app.js";

export interface IntegrationHttpDependencies {
  readonly authenticator: HttpAuthenticator;
  readonly list: Pick<ListIntegrationProjections, "execute">;
  readonly get: Pick<GetIntegrationProjection, "execute">;
}

const catalogItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "gatewayId",
    "integrationId",
    "integrationKind",
    "snapshotGeneration",
    "entityCount",
    "latestObservationCount",
    "receivedAt",
    "revision",
  ],
  properties: {
    gatewayId: { type: "string", minLength: 1 },
    integrationId: { type: "string", minLength: 1 },
    integrationKind: { type: "string", minLength: 1 },
    snapshotGeneration: { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" },
    entityCount: { type: "integer", minimum: 0 },
    latestObservationCount: { type: "integer", minimum: 0 },
    receivedAt: { type: "string", format: "date-time" },
    revision: { type: "integer", minimum: 1 },
  },
} as const;

const catalogSchema = {
  type: "object",
  additionalProperties: false,
  required: ["authority", "liveStateAuthoritative", "items"],
  properties: {
    authority: { const: "edge-reported-copy", type: "string" },
    liveStateAuthoritative: { const: false, type: "boolean" },
    items: { type: "array", items: catalogItemSchema },
    nextCursor: { type: "string", minLength: 1 },
  },
} as const;

const detailSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "authority",
    "liveStateAuthoritative",
    "tenantId",
    "projectId",
    "gatewayId",
    "integrationId",
    "topology",
    "topologyDigest",
    "latestObservations",
    "receivedAt",
    "revision",
  ],
  properties: {
    authority: { const: "edge-reported-copy", type: "string" },
    liveStateAuthoritative: { const: false, type: "boolean" },
    tenantId: { type: "string", minLength: 1 },
    projectId: { type: "string", minLength: 1 },
    gatewayId: { type: "string", minLength: 1 },
    integrationId: { type: "string", minLength: 1 },
    topology: { type: "object", additionalProperties: true },
    topologyDigest: { type: "string", minLength: 1 },
    latestObservations: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    receivedAt: { type: "string", format: "date-time" },
    revision: { type: "integer", minimum: 1 },
  },
} as const;

function catalogFailureStatus(
  code: IntegrationProjectionCatalogFailure["code"],
): 400 | 403 | 503 {
  if (code === "permission-denied") return 403;
  if (
    code === "integration-storage-unavailable" ||
    code === "invalid-integration-repository-result"
  ) {
    return 503;
  }
  return 400;
}

function detailFailureStatus(
  code: IntegrationProjectionFailure["code"],
): 400 | 403 | 404 | 503 {
  if (code === "permission-denied") return 403;
  if (code === "integration-projection-not-found") return 404;
  if (
    code === "integration-storage-unavailable" ||
    code === "invalid-integration-repository-result"
  ) {
    return 503;
  }
  return 400;
}

export function registerIntegrationRoutes(
  app: FastifyInstance,
  integrations: IntegrationHttpDependencies,
): void {
  app.get(
    "/api/v1/integrations",
    {
      schema: {
        response: {
          200: catalogSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const correlationId = request.id;
      reply.header("x-correlation-id", correlationId);
      const authentication = await integrations.authenticator.authenticate({
        authorization: request.headers.authorization,
      });
      if (!authentication.ok) {
        return sendError(
          reply,
          401,
          "unauthenticated",
          "authentication is required",
          correlationId,
        );
      }
      if (!isRecord(request.query)) {
        return sendError(
          reply,
          400,
          "invalid-input",
          "query must be an object",
          correlationId,
        );
      }
      const allowed = new Set(["cursor", "gatewayId", "limit"]);
      if (Object.keys(request.query).some((key) => !allowed.has(key))) {
        return sendError(
          reply,
          400,
          "invalid-input",
          "query contains an unsupported field",
          correlationId,
        );
      }
      const rawLimit = request.query.limit ?? "50";
      if (
        typeof rawLimit !== "string" ||
        !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit) ||
        (request.query.cursor !== undefined &&
          typeof request.query.cursor !== "string") ||
        (request.query.gatewayId !== undefined &&
          typeof request.query.gatewayId !== "string")
      ) {
        return sendError(
          reply,
          400,
          "invalid-input",
          "Integration projection query is invalid",
          correlationId,
        );
      }
      const result = await integrations.list.execute(authentication.value, {
        limit: Number.parseInt(rawLimit, 10),
        ...(request.query.cursor === undefined
          ? {}
          : { cursor: request.query.cursor }),
        ...(request.query.gatewayId === undefined
          ? {}
          : { gatewayId: request.query.gatewayId }),
      });
      if (!result.ok) {
        return sendError(
          reply,
          catalogFailureStatus(result.failure.code),
          result.failure.code,
          result.failure.message,
          correlationId,
        );
      }
      return reply.status(200).send(result.value);
    },
  );

  app.get(
    "/api/v1/integrations/:gatewayId/:integrationId",
    {
      schema: {
        response: {
          200: detailSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const correlationId = request.id;
      reply.header("x-correlation-id", correlationId);
      const authentication = await integrations.authenticator.authenticate({
        authorization: request.headers.authorization,
      });
      if (!authentication.ok) {
        return sendError(
          reply,
          401,
          "unauthenticated",
          "authentication is required",
          correlationId,
        );
      }
      const result = await integrations.get.execute(
        authentication.value,
        request.params,
      );
      if (!result.ok) {
        return sendError(
          reply,
          detailFailureStatus(result.failure.code),
          result.failure.code,
          result.failure.message,
          correlationId,
        );
      }
      return reply.status(200).send(result.value);
    },
  );
}
```

- [ ] **Step 4: 在 app.ts 里接上**

在 `BuildAppOptions` 中加一项：

```ts
  readonly integrations?: IntegrationHttpDependencies;
```

并在 `buildApp` 内加入注册：

```ts
const integrations = options.integrations;
if (integrations !== undefined) {
  registerIntegrationRoutes(app, integrations);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run apps/api/test/integration-routes.test.ts`
Expected: PASS（8 个用例全绿）

- [ ] **Step 6: 在生产组合根里注入查询**

编辑 `apps/api/src/runtime.ts`。用与 `auditRepository()` 相同的模式组合投影查询，
复用 Task 2 的 `composeIntegrationProjectionStore` 思路（这里需要在 `apps/api` 侧
再做一次同样的 memory/postgres 门控，或把 Task 2 的模块提升为共享包——
两种都可以，选后者时把文件移到 `adapters/integration-projection/` 下的新包并更新两处 import）。

组合出的对象注入 `buildApp`：

```ts
    integrations: {
      authenticator: httpAuthenticator,
      list: new ListIntegrationProjections({ catalog, clock }),
      get: new GetIntegrationProjection({
        repository,
        digestor: new NodeIntegrationPayloadDigestor(),
        clock,
      }),
    },
```

- [ ] **Step 7: 全量验证**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add apps/api/src/integration-routes.ts apps/api/src/app.ts apps/api/src/runtime.ts apps/api/test/integration-routes.test.ts
git commit -m "feat: expose read-only integration projection routes"
```

---

## Task 8: 控制台投影视图

**Files:**

- Create: `apps/web/src/integrations.tsx`
- Modify: `apps/web/src/api-client.ts`
- Modify: `apps/web/src/app.tsx`

- [ ] **Step 1: 先读现有客户端，照它的模式加**

```bash
cat apps/web/src/api-client.ts
```

按其既有的请求与错误处理形状，新增两个函数：`fetchIntegrationCatalog(cursor?)`
与 `fetchIntegrationDetail(gatewayId, integrationId)`，分别打
`/api/v1/integrations` 与 `/api/v1/integrations/:gatewayId/:integrationId`。
认证头沿用现有 Supabase session 的取法，不要新造一套。

- [ ] **Step 2: 写视图**

创建 `apps/web/src/integrations.tsx`。它必须满足三条：

1. 列表展示 `integrationKind`、`entityCount`、`receivedAt`；
2. **每个视图都显式呈现"边缘上报副本、非实时真相"**，并把 `receivedAt`
   渲染成相对新鲜度（例如「3 分钟前上报」），而不是裸时间戳——
   裸时间戳会被误读成"当前状态"；
3. 详情页展示拓扑中的实体与最近观测，且不渲染任何 provider 地址或凭据字段
   （应用层不会返回它们，视图也不得为它们预留位置）。

- [ ] **Step 3: 挂载到 app.tsx**

按 `apps/web/src/app.tsx` 现有的视图切换方式加入投影视图入口。

- [ ] **Step 4: 本地跑起来看**

```bash
pnpm dev:api
```

另开一个终端：

```bash
pnpm dev:web
```

打开浏览器访问 Vite 输出的地址，确认投影列表可加载、详情可打开、
新鲜度与"非实时"标注可见。

- [ ] **Step 5: 全量验证**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/integrations.tsx apps/web/src/api-client.ts apps/web/src/app.tsx
git commit -m "feat: show read-only integration projections in the console"
```

---

# 收尾验证

全部 Task 完成后逐条确认，任何一条不过都不算 A0 交付：

- [ ] `pnpm check` 通过
- [ ] `pnpm test:mqtt-integration` 对真实 Mosquitto 通过
- [ ] `pnpm test:home-assistant-e2e` 通过（证明既有全链路未被破坏）
- [ ] `grep -rn "integration-control\|IntegrationControl" apps/cloudlink/src/runtime.ts apps/api/src/integration-routes.ts` **无输出**——控制路径确实未接线
- [ ] `wc -l apps/api/src/app.ts` 低于 800
- [ ] 更新 `docs/concepts/current-state-audit.md`：把 Integration projection 一行的
      "public API remain gated" 改为已实现的事实，说明控制路径仍 gated，
      并记录"Runtime Manifest 仅内存持久化、进程重启后需 Gateway 重新上报"这条限制
- [ ] 更新 `docs/reference/http-api.md` 收录两条新路由
- [ ] 按 `AGENTS.md` 要求，文档 frontmatter、`ai/docs-manifest.json` 条目、
      `llms.txt` 描述三处同步更新
