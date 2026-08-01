---
title: "A0 设计：Home Assistant 只读投影楔子"
description: 以只读 Home Assistant 投影作为 AetherCloud 的第一个产品楔子，接通 CloudLink 生产组合根与只读公开面，控制路径完全不参与
updated: 2026-07-31
status: planned
---

# A0 设计：Home Assistant 只读投影楔子

## 决策背景

### 否决的方案：自建 MQTT Broker

把 AetherCloud 的入口做成"最基础的 MQTT Broker"被否决，理由有三：

1. 与已生效的 [ADR-0014](../../adr/0014-cloudlink-mqtt-transport-binding.md) 第 2 条直接冲突。
   该条决策原文为 "An AetherCloud-managed broker is optional, not required"，
   理由是多数客户已运营 broker，自带 broker 只增加成本与迁移摩擦。
2. 现有实现建立在"broker 在外部"这一前提上。
   `adapters/cloudlink/mqtt` 依赖 `mqtt` 5.15.2 客户端库，
   `apps/cloudlink/src/cloudlink-mqtt-ingress.ts` 是订阅者。
   改为自建 broker 等于更换组合根地基。
3. 差异化不在 broker 层。ADR-0014 第 4 条
   "MQTT PUBACK never advances a CloudLink durable cursor" 正是产品价值所在：
   传输层送达不等于应用层持久化受理。broker 不提供 session epoch fencing、
   durable cursor resume、gateway 身份或 governed job。

### 选定的方案：A0 只读投影

在三条候选楔子路径（HA/homelab、存量工业客户、MCP 开发者）之外，
选择"只读先行"作为最小楔子。

选择理由：控制路径的全部发布门槛
（见 [governed control](../../concepts/home-assistant-governed-control.md)
的 "Required before user availability" 六条）都不适用于只读路径，
而只读路径的内层完成度更高。剩余缺口只有公开面与生产组合。

**推荐序列：A0（只读楔子）→ A（治理化控制）→ B（工业客户变现）。**
MCP 作为 A 的接口层顺带存在，不单独立项。

## 交付的用户价值

一个 Home Assistant 用户接上 AetherEdge 后，能在 AetherCloud 控制台看到
自家的设备拓扑与观测历史；这份数据被明确标注为边缘上报的副本而非实时真相；
云端全程拿不到 Home Assistant 的地址与 token。

## 现状盘点

### 已具备（无需重建）

| 层         | 证据                                                                                              | 状态                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 应用层写入 | `packages/application/src/integration-projection.ts`（2423 行）                                   | topology/observation 上报命令、生成代际围栏、类型化取值校验完整                   |
| 应用层查询 | `packages/application/src/list-integration-projections.ts`（465 行）                              | catalog + by-ID 查询，含 tenant/project 作用域、权限、游标分页                    |
| 权威性标注 | 同上 `IntegrationProjectionCatalogView`                                                           | `authority: "edge-reported-copy"` 与 `liveStateAuthoritative: false` 是类型层常量 |
| PostgreSQL | `adapters/integration-projection/postgres/src/postgres-integration-projection-repository.ts:2335` | 同时实现 `IntegrationProjectionRepository` 与 `IntegrationProjectionCatalog`      |
| 迁移       | `adapters/integration-projection/postgres/migrations/0003_integration_projection.sql`             | 已存在，含 forced RLS                                                             |
| MQTT 桥接  | `apps/cloudlink/src/cloudlink-mqtt-application-bridge.ts`（2410 行）                              | 严格解码、会话校验、Runtime Manifest 恢复                                         |
| 端到端证据 | `scripts/run-home-assistant-e2e-harness.ts`（1177 行）                                            | 全链路 harness，可跑                                                              |
| 部署基线   | `apps/api` 已部署 Railway，Supabase JWT 认证、CORS 白名单、verify-full TLS                        | 可复用的认证与错误翻译模式                                                        |

### 缺口（A0 要补的）

1. **没有 CloudLink 进程。** `apps/cloudlink/src/index.ts` 仅 26 行，是纯 re-export 的库。
   其 `package.json` 中全部 memory adapter 位于 `devDependencies`，说明仅测试消费。
   `railway.json` 的 `startCommand` 只拉起 `@aether-cloud/api`。
2. **没有只读投影的 HTTP 路由。** `apps/api/src/app.ts` 现有 fleet 与 audit 路由，无 integration。
3. **控制台无投影视图。** `apps/web/src` 目前只有 dashboard 相关模块。
4. **契约未发布。** `aether-contracts.lock.json` 仍 pin `0.1.0-alpha.3`，
   而 Home Assistant 拓扑/观测契约是 alpha.4 候选。

## 范围

### 做

- CloudLink ingress 的生产组合根，注入 PostgreSQL 投影仓储，作为独立进程部署
- `apps/api` 上两条只读路由：投影 catalog（分页）与 by-ID 详情
- `apps/web` 上可查看拓扑与观测的视图

### 不做

- **任何控制路径。** `CreateIntegrationPowerControl`、offer/receipt 流转、
  `integration.device.control` 权限、Ed25519 offer 签名一行不动，保持 default-off。
- 生产签名密钥的置备、轮转、吊销（只读路径不需要）
- 公开 MCP wire service。`apps/mcp` 保持 transport-neutral，不开公网端口。
- 告警持久化、telemetry 公开 API、membership 生命周期
- 自建 MQTT broker（见上文决策背景）

## 前置条件

AetherContracts 仓库发布 `v0.1.0-alpha.4`。此前置不在本仓库，卡住则 A0 全部阻塞。

依据 [Home Assistant integration](../../concepts/home-assistant-integration.md)：
"It must not claim alpha.4 conformance until alpha.4 is published, imported with
exact digests, and executed through the consumer tests."

## 实施：三步

### 第 1 步 · 把 alpha.4 从候选转为已发布消费

**改动**

- `contracts/aether-contracts/v0.1.0-alpha.4-candidate/` 更名为 `v0.1.0-alpha.4/`，
  按发布产物的精确 digest 重新导入
- `aether-contracts.lock.json` 的 `release`、`bundle`、`manifest` 指向 alpha.4；
  `status` 保持 `complete-consumer`
- 翻转 `adapters/integration-projection/aether-contracts/test/candidate-artifacts.test.ts`
  的绊线断言。该测试当前硬断言 `publication_status === "candidate-unpublished"`
  并钉死 manifest 的 sha256，因此发布后必然变红——这是刻意设计，
  用于阻止契约状态悄悄漂移。断言需改为"已发布 + digest 校验通过"。

**验证**

`pnpm check`。本步不新增运行时行为，测试变红即导入有误。

### 第 2 步 · 给 CloudLink ingress 接上生产组合根

**改动**

- 新建 `apps/cloudlink/src/runtime.ts` 与 `apps/cloudlink/src/server.ts`，
  形状照 `apps/api/src/runtime.ts` 的 `composeApiRuntime`
- 环境变量门控 `AETHER_CLOUD_INTEGRATION_PROJECTION_STORE=memory|postgres`，
  **默认 memory**，以满足 `AGENTS.md` 的"默认验证路径不得依赖 PostgreSQL"
- `apps/cloudlink/package.json`：memory adapter 由 `devDependencies` 提升至
  `dependencies`；新增 `@aether-cloud/integration-projection-postgres-adapter`
- **控制路径显式不接线。** 不注入 integration-control 依赖，
  不调用 `createCloudLinkIntegrationControlFactory`。
  组合根在类型层面即无法取得控制能力，而非依赖运行期开关关闭。
- 新增一个独立的 Railway service 部署该进程，
  `startCommand: pnpm --filter @aether-cloud/cloudlink start`。
  现有 `railway.json` 是单 service 配置（当前只拉起 `@aether-cloud/api`），
  因此 CloudLink 进程需要自己的配置文件，而不是在 `railway.json` 内追加。

**验证**

- 新增组合根行为测试：证明控制依赖缺席时进程正常启动，且只读路径正常工作
- `pnpm test:mqtt-integration`（真实 Mosquitto）跑通
- `pnpm check`

### 第 3 步 · 开只读的洞：HTTP 路由与控制台视图

**改动**

- `GET /api/v1/integrations`：catalog，接受 `cursor` 与 `limit`，
  校验模式照 `apps/api/src/app.ts:610` 的 fleet 列表路由
- `GET /api/v1/integrations/:gatewayId/:integrationId`：详情
- 复用现有 `authenticator`（Supabase JWT）、`sendError`、`errorResponseSchema`
- 响应 schema 将 `authority: "edge-reported-copy"` 与
  `liveStateAuthoritative: false` 固化为常量，使其无法被后续改动悄悄移除
- `apps/web` 增加列表与详情视图，显式呈现 `receivedAt` 新鲜度
  与"非实时真相"标注
- **针对性重构：** `apps/api/src/app.ts` 现 1170 行，再加两条路由约达 1400 行。
  按仓库 <800 行目标，本步将 fleet 路由组与 audit 路由组各抽为独立模块，
  新增的 integration 路由直接落在新模块中。
  此重构限于正在改动的文件，不涉及无关代码。

**验证**

`apps/api/test/app.test.ts` 补充路由行为测试，覆盖：

- 未认证返回 401
- 缺少权限返回 403
- 跨租户查询被拒绝
- 游标分页稳定且有界
- 未知 ID 返回 404
- 响应体确实携带 `edge-reported-copy` 与 `liveStateAuthoritative: false`

## 数据流

```text
Home Assistant
  -> AetherEdge connector（持有 URL 与 token，不外传）
  -> 供应商中立的拓扑与观测消息（alpha.4）
  -> CloudLink over MQTT（QoS 1，retain=false，客户自有 broker）
  -> apps/cloudlink 生产组合根
  -> PostgreSQL 投影事务（fact + inbox + receipt + history + audit + outbox + ACK）
  -> apps/api 只读路由
  -> apps/web 控制台
```

## 错误处理

沿用仓库既有约定，不新增机制：

- 应用层返回类型化失败，组合根翻译为传输响应
- 严格解码所有外部输入；未知字段、类型不符、代际过期一律 fail closed
- 投影查询失败翻译为 503，输入非法翻译为 400，跨租户翻译为 403
- 观测时间戳的未来时钟偏移已在应用层有界拒绝，本设计不改动

## 风险

1. **AetherEdge 的 HA connector 需手工编译配置。** A0 的 quickstart 因此偏长。
   打包为 Home Assistant add-on 是 A0 之后的独立一步，不并入本设计。
2. **前置发布阻塞。** alpha.4 未发布则三步全部无法开始。
3. **只读的付费意愿低于控制。** 且"云端历史"存在 InfluxDB/Grafana 等免费替代。
   差异化必须压在审计与不夺权上，不能压在存储本身。

## 成功判据

- `pnpm check` 通过，且默认验证路径仍不需要 PostgreSQL、边缘设备或 broker
- `pnpm test:mqtt-integration` 对真实 Mosquitto 通过
- 一个具备 Home Assistant 与 AetherEdge 的用户，
  能在控制台看到自己的设备拓扑与观测历史
- 控制路径在 A0 交付物中不可达，且该不可达性由类型与测试共同保证
