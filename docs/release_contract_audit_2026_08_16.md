# Morphz 发布契约审计与修复

日期：2026-08-16  
状态：发布阻断项已修复；SQLite 与真实 PostgreSQL 一致性回归已通过

## 1. 结论

本轮把数据库 Schema、嵌入式 SDK、HTTP/WebSocket 和 CLI/HTTP 跨入口行为作为一份统一的“发布契约”审计，而不是分别检查几段实现。

结论如下：

- 数据库的核心领域覆盖完整。SQLite 有 50 个物理表，PostgreSQL 有 49 个；唯一的表级差异是 SQLite 使用 `session_mounts` 保存当前挂载与注意力状态，而 PostgreSQL 将同一逻辑状态折叠在 `sessions` 中。这是物理表示差异，不是领域能力缺失。
- 两个存储后端通过同一组 `RuntimeStore` conformance。此次使用本机真实 PostgreSQL 重新执行完整 conformance，而不是只通过编译或环境门控。
- SDK 的 principal/session 授权大体成立，但审计发现 `subscribe_session` 在授权后返回了进程级通配事件流，构成跨 Session 数据泄露；现已修复。
- CLI 与 HTTP 创建 Objective 时曾先单独写来源 Event，再调用 SDK 创建 Objective。第二步失败会留下孤儿事件；现已改为来源 Event、Objective 与可选 Harness 绑定同事务提交。
- HTTP 错误原先存在字符串和对象两种格式，部分 500 响应会直接返回数据库或内部错误；现已统一格式并屏蔽内部细节。
- Trusted Gateway 曾可省略 `session_id` 订阅全局 WebSocket；现仅 Operator 可以全局订阅，其他身份必须绑定已授权 Session。
- tokenless localhost 仍然保留，但不再向任意互联网网页开放 CORS。嵌入式 Dashboard、同源访问以及 localhost/127.0.0.1/::1 前端调试不受影响。

本轮范围内没有遗留 P0/P1 发布阻断项。第 8 节列出的项目属于下一阶段的边界收紧，不影响当前 0.1 发布契约。

## 2. 契约分层

发布后的权威边界定义为：

1. `MorphzSdk` 是嵌入式应用的支持契约。
2. HTTP/WS 是 SDK 与 Runtime operator projection 的传输适配层，不自行创造领域事实。
3. CLI 与 HTTP 对同一领域命令必须调用同一 SDK 命令。
4. `RuntimeStore` trait 是 SQLite/PostgreSQL 的行为契约；物理 Schema 可以不同，但 CAS、事务、状态机、分页与恢复语义必须一致。
5. `events` 是不可变事实账本；current-state 表、outbox、lease 和 projection 各自承担明确职责，不互相替代。

`morphz/src/lib.rs` 现在明确声明：`sdk` 是支持的嵌入式契约；其他公开模块目前为了 Morphz 二进制、评测工作区和集成测试而可见，仍属于不稳定实现面。

SDK 契约版本为 `1`。HTTP `/api/status` 同时返回：

```json
{
  "api_contract_version": "1",
  "sdk_contract_version": "1"
}
```

## 3. 数据库 Schema 审计

### 3.1 表的职责分类

| 类别 | 权威数据 |
|---|---|
| 身份与目录 | `agents`、`cognitive_contexts`、`sessions`、`principals`、`session_principal_bindings`；SQLite 另有 `session_mounts` |
| 不可变事实与认知状态 | `events`、`context_heads`、`mind_projections`、`mind_snapshots`、`context_cognitive_clocks` |
| 对话与检索投影 | `session_projections`、`recall_documents`、`recall_projection_outbox`、`event_causal_projection_backfills`、`attention_acknowledgements` |
| Objective 与调度 | `objectives`、`runtime_timers`、`scheduler_dependencies`、`schedules`、`schedule_dependencies`、`delegations` |
| 并发执行 | `threads`、`thread_activations`、`thread_signals`、`activation_signals`、`signal_outbox`、`thread_outcomes`、`evaluation_outcomes`、`thread_groups`、`thread_group_members`、`action_groups`、`action_group_members`、`plan_executions` |
| 工具、审批与能力 | `execution_jobs`、`approval_requests`、`capability_leases`、`execution_targets`、`execution_target_authorizations` |
| Edge Node | `execution_nodes`、`execution_node_pairing_codes`、`execution_node_challenges`、`edge_execution_commands`、`edge_command_output_chunks` |
| Provider 状态 | `provider_account_states`、`provider_account_affinities`、`provider_refresh_leases`、`provider_model_catalog` |
| 迁移控制 | `schema_migrations` |

这组 Schema 没有发现“装饰性表”：每个表都能对应当前 Store trait、恢复流程、投影或控制面实现。

### 3.2 SQLite 与 PostgreSQL 差异

SQLite 的 `session_mounts` 支持带 generation 的挂载历史；PostgreSQL 当前产品语义是 Session 的 Context 不可变，因此把 `mount_kind`、attention state/revision 直接放在 `sessions`。

本轮没有为了表名一致而强行重写这两个表示。判断标准是领域行为是否一致，而不是 DDL 是否逐字符相同。真实双后端 conformance 覆盖了 Session directory、attention CAS、Event、Context transaction/projection、Recall、Thread/Activation/Signal、Objective、Schedule、Delivery、Target、Approval、Edge 与 Execution Job。

### 3.3 本轮补齐的不变量

SQLite：

- 新增 `idx_session_mounts_one_active` partial unique index，保证一个 Session 最多只有一个 `unmounted_at IS NULL` 的挂载。
- 对旧数据库先做幂等收敛：保留最高 generation 为活动挂载，较低 generation 在下一代挂载时间结束，然后建立唯一索引。

PostgreSQL：

- 为 Agent、Context、Session 的 status 增加 `active|archived` 领域约束。
- 为 Session attention state 增加 `active|retired` 约束。
- 为 Session mount kind 增加四种合法值约束。
- 为 attention revision 与 Context token-budget revision 增加非负约束。
- 新迁移 `20260816_03_directory_domain_constraints` 对存量数据库使用 `NOT VALID` + `VALIDATE CONSTRAINT`，先缩短元数据锁，再验证历史数据。

### 3.4 迁移策略

SQLite 使用“当前完整 Schema + 幂等兼容迁移”；PostgreSQL 在 advisory lock 下按代码中的固定顺序运行 34 个版本化迁移。迁移名是稳定标识，不是排序依据，因此代码顺序是唯一执行顺序。

PostgreSQL 的迁移标记在迁移成功后写入。大型 backfill 有意采用可重入、分页式执行，而不是把长时间扫描包进一个巨大事务；进程中断后会从未写 marker 的迁移重新进入。这是恢复性与锁时间之间的明确取舍。

当前 `schema_migrations` 不保存源码 checksum。发布后不得修改已发布 migration 的语义；任何变化必须新增 migration ID。未来如果出现多发行分支并行维护，再增加 manifest/checksum，而不是现在为代码闭包伪造不可靠的 SQL hash。

## 4. SDK 契约审计

### 4.1 身份边界

SDK 的 principal-scoped 命令会先验证 Session 参与关系。跨 Principal 读取、父 Session 继承与 Objective coordinator/delivery 均由 SDK 统一授权。

发现并修复的问题：

- 旧 `subscribe_session` 只在订阅前授权一次，随后返回 `runtime.subscribe("*")`。
- 新 `SessionEventStream` 在 SDK 边界只返回 payload 中 `session_id` 精确匹配的 Event；`recv` 与 `try_recv` 都执行相同过滤。

### 4.2 Objective 创建契约

`CreateObjectiveCommand` 不再接收包含 `agent_id`、`context_id`、`initiating_principal_id` 的底层 `NewObjective`。这些字段由 SDK 根据已授权的 coordinator/delivery Session 推导，调用方不能伪造。来源 Event 的 actor 同样由已验证 Principal 派生；调用方只能选择受限的 `embedded|cli|http` 来源枚举，不能写入任意审计身份。

SDK 现在统一构造 `objective/requested` 来源 Event，并通过以下原子路径提交：

```text
CreateObjectiveCommand
  -> authorize coordinator + delivery
  -> derive Agent / Context / Principal
  -> build source Event + Objective
  -> optional exact Harness binding Event
  -> one Store transaction
  -> Supervisor admission
```

CLI 与 HTTP 都走这条路径。重复 Objective ID 返回冲突时，不会留下第二条来源 Event。

### 4.3 SDK 稳定面

- `SDK_CONTRACT_VERSION = "1"`。
- `MorphzSdk`、SDK command/result/error 类型是支持面。
- `MorphzSdk::runtime()` 仍为 `#[doc(hidden)]` 的第一方适配器逃生口，不属于外部稳定契约。
- Runtime、memory、provider 等模块尚未物理私有化，因为 `morphz-evals` 与现有集成测试依赖它们；现在已在 crate 文档中明确其不稳定属性，后续可通过拆分 `morphz-core`/`morphz-sdk` 收紧，而不是在发布前制造大面积破坏。

## 5. HTTP API 契约审计

当前注册 100 个 `/api` 路径模式，覆盖 runtime/operator、identity/session、context/recall、objective/scheduler、approval/capability、execution/edge/provider 等控制面，另有 `/ws`。

### 5.1 身份与授权

| 调用面 | 授权规则 |
|---|---|
| `/health`、Dashboard 静态资源 | 无认证，不返回认知或身份数据 |
| tokenless localhost | 保持免令牌；仅同源或 loopback Origin 可以通过浏览器 CORS |
| Operator API | Dashboard/operator token；可读取跨 Principal 的管理投影 |
| Trusted Gateway principal API | service token + provider asserted principal；Session 访问仍校验参与关系 |
| Edge API | device token + command claim token + generation/revision fencing |
| OAuth browser callback | live opaque state，而不是普通 operator token |
| WebSocket 全局订阅 | 只允许 Operator |
| WebSocket Session 订阅 | 非 Operator 必须指定并授权 `session_id` |

### 5.2 错误格式

所有普通 JSON API 错误统一为：

```json
{
  "error": {
    "code": "invalid_argument | unauthorized | forbidden | not_found | conflict | resource_exhausted | unavailable | deadline_exceeded | internal",
    "message": "public message"
  }
}
```

Artifact offset conflict 仍在顶层保留机器可读的 `expected_offset`，同时使用同一 error object。

500/Internal 的具体数据库、文件系统或实现错误只写结构化日志，客户端固定收到 `internal` 与通用消息。未知 `/api/*` 路径也返回同一 envelope。

JSON、Query、Body limit 与 method routing 等发生在 handler 之前的 Axum rejection 也由 API 边界中间件归一化；非 `/api` 的 Dashboard 静态资源响应不受影响。这样客户端不需要为框架错误再维护一套纯文本解析分支。

### 5.3 分页、幂等与并发

- Ledger、Recall、Event、Model Usage、Execution Job、Edge output 与目录查询均有默认值和上限；底层 Store 对最终 SQL limit 再做 clamp。
- 消息入口使用 `client_message_id` 去重。
- Objective/Session 等创建支持调用方 ID；同 ID 冲突不会部分写入。
- 修改类 API 使用 expected revision/CAS；Edge 命令另有 claim token 和 generation fencing。
- WebSocket lag 时连接关闭并要求客户端用快照重建，而不是继续展示缺段流。

### 5.4 URI 版本策略

当前保留 `/api/...` 路径，不机械复制一套 `/api/v1/...`。原因是嵌入式 Dashboard 与 Runtime 同版本发布，重复注册 100 个路径会制造两套可能漂移的路由表。

契约版本由 `/api/status` 明确声明为 `1`。如果未来把 HTTP 作为独立远程产品并需要同时服务多个主版本，应把路由定义提取为一份相对路径 Router，再同时 mount `/api` compatibility alias 与 `/api/v2`；不能复制 handler 注册代码。

## 6. WebSocket 契约

- WS 数据单位仍是 `Event`，不会引入与 Ledger 不同的第二种领域格式。
- Session 过滤使用顶层 payload `session_id` 精确匹配。
- 重连先订阅 live broadcast，再读取 durable Model Attempt snapshot，避免 snapshot 与 live 之间丢转换。
- `runtime/model_stream` 是可丢弃草稿；terminal reply/progress 是可靠事实。
- lag 会主动关闭连接，客户端必须重新取 durable snapshot。

## 7. 修复与验证矩阵

| 编号 | 严重度 | 问题 | 状态 | 回归证据 |
|---|---:|---|---|---|
| SDK-01 | P1 | Session 授权后泄露全局 Event stream | 已修复 | `session_subscription_never_exposes_another_session` |
| SDK-02 | P1 | Objective 来源 Event 与 Objective 分事务 | 已修复 | `objective_http_creation_atomically_binds_exact_harness`，含重复 ID 不留孤儿 Event |
| HTTP-01 | P1 | HTTP 错误 schema 不一致、500 泄露内部细节 | 已修复 | `api_errors_have_one_stable_envelope_and_hide_internal_details` |
| HTTP-02 | P1 | Trusted Gateway 可订阅全局 WS | 已修复 | gateway scope assertions + 既有 trusted gateway identity suite |
| HTTP-03 | P1 | tokenless localhost 接受任意跨域网页 | 已修复 | `tokenless_loopback_cors_accepts_only_loopback_web_origins` |
| DB-01 | P1 | SQLite 未物理保证单一活动挂载 | 已修复 | `schema_enforces_one_active_mount_per_session` |
| DB-02 | P1 | PostgreSQL 目录领域约束弱于 SQLite | 已修复 | 真实 PostgreSQL conformance + constraint introspection |
| API-01 | P2 | 客户端无法发现契约版本 | 已修复 | `status_declares_http_and_sdk_contract_versions` |

验证包括：

- `cargo check -p morphz --all-targets`
- 上表全部定向行为测试
- SQLite Schema constraint test
- 真实本机 PostgreSQL `runtime_store_conformance`
- `RUSTDOCFLAGS='-D warnings' cargo doc -p morphz --no-deps`
- 最终全 workspace format、clippy 与 test gate（见提交交付记录）

全量测试曾暴露 `same_session_dialogue_turns_are_serialized` 的测试夹具竞态：测试通过两个并发 Event Bus subscriber 分别创建 Session 和消费首条消息，满载时消费者可能先看到尚不存在的测试 Session。生产入口本来就先创建 Session；测试现也在发布消息前显式建立 Agent/Context/Session，因此验证的是实际发布契约，不再把夹具调度顺序误当成产品语义。

## 8. 明确保留的非阻断项

### 8.1 内部模块仍是 Rust `pub`

这是代码组织债务，不是当前运行时越权。0.1 的支持承诺只覆盖 `morphz::sdk`；下一次 crate 拆分再从类型系统物理封闭 internals。

### 8.2 SQLite/PostgreSQL 不追求逐表同形

`session_mounts` 的表示差异被接受，前提是 conformance 持续通过。若未来真的支持 Session remount，需要先升级统一领域契约，再同时迁移两个后端；不能只根据 SQLite 已有 generation 字段推断功能已经存在。

### 8.3 Migration 无 checksum

当前采用“发布后 migration ID 与语义不可变”的流程约束。多分支长期演化时应加入显式 migration manifest/checksum；本轮没有把 Rust closure 的编译结果伪装成可审计 SQL checksum。

### 8.4 HTTP operator projection 仍可直接调用 Runtime

principal-scoped 业务命令必须经过 SDK；与该 Runtime 二进制同版本的 operator diagnostics、模型控制与 ephemeral observation 可以调用隐藏 Runtime 面。将来若这些 API 要作为独立 SDK 发布，再逐项提升为 SDK v2 命令。

## 9. 性能影响

- SDK Session 事件过滤为每个收到的 Event 做一次 `session_id` 字段比较，不增加数据库访问。
- Objective 创建从两次独立持久化缩为一次事务，失败清理和写放大都更少。
- HTTP error envelope 与 CORS Origin 判断仅发生在请求边界，成本可忽略。
- SQLite active-mount 收敛和 unique index 只在启动迁移执行一次；正常读写由索引维护。
- PostgreSQL `VALIDATE CONSTRAINT` 在首次升级扫描 Agent/Context/Session 目录表一次；不是每次启动重复扫描，也不进入请求热路径。
- 未引入全表轮询、双写、兼容 shadow table 或后台补偿线程。

## 10. 发布门槛

当前发布契约的最低门槛是：

1. format、clippy、workspace tests 全绿；
2. SQLite conformance 全绿；
3. 发布候选版本至少一次连接真实 PostgreSQL 执行 conformance；
4. 新 HTTP 错误必须使用统一 envelope；
5. 新 principal-scoped stream 必须有跨身份负向测试；
6. 新跨入口命令必须先进入 SDK，再接 CLI/HTTP；
7. Schema 改动必须同时说明 SQLite、PostgreSQL、迁移、回滚/重入与性能影响。
8. 支持的 SDK crate 文档必须在 rustdoc warnings-as-errors 下生成。
