# Morphz 数据库逐表职责审计

日期：2026-08-16
范围：SQLite、PostgreSQL、Store 契约、恢复路径、生命周期与容量
状态：审计及第一轮 Schema/瞬态 retention 修复完成；高风险表合并尚未执行

## 1. 结论

Morphz 当前不是“一个普通业务却随意建了 50 张表”，而是把以下系统同时嵌入一个 Runtime：

- 不可变 Event History；
- Context/Mind 的当前状态与快照；
- 可恢复的 Thread、Activation、Signal、Timer、Dependency 和 Group 调度；
- 工具执行、审批、能力租约与 Edge Node 控制面；
- Provider 账户路由与模型目录；
- Recall 全文投影。

因此，表数显著高于普通 CRUD 系统是可以解释的。但是，逐表核对后，上一份审计中“没有装饰性表”的结论过于乐观，需要修订：

- 40 张表具有独立且清晰的持久化职责，应保留；
- 6 张表职责成立，但缺少明确的终态清理或保留策略；
- 3 张表是可以收敛的物理重复或遗留专用索引；
- 1 张表只服务旧版本渐进 backfill，应有明确退役版本。

合理的近期目标不是为了好看把 50 强行压到二三十，而是先收敛到 **46 张普通应用表**，同时消除无界临时数据和双后端约束差异。若随后把 Schedule 依赖迁入统一 Dependency 模型、把 Activation 批次关系内联，两个后端可以稳定收敛到同一组核心表。

还有一个容易误解的数字：SQLite 除 50 张显式普通应用表外，还创建了一个 `recall_documents_fts` FTS5 虚表；SQLite 会为它维护若干内部 shadow table。它们属于全文索引的物理实现，不是新的 Morphz 领域对象。

## 2. 判断标准

每张表按以下问题审计：

1. 它保存的是权威事实、当前状态、投影、队列/租约、历史收据，还是迁移状态？
2. 谁写、谁读，崩溃恢复是否依赖它？
3. 是否能从 `events` 或其他权威表重建？
4. 为什么不能并入父聚合或统一机制？
5. 终态行是否仍有读取价值，何时可以删除或归档？
6. SQLite 与 PostgreSQL 是否约束同一状态域？

结论标记：

- **保留**：独立职责成立；
- **保留并治理**：表需要保留，但必须补生命周期、容量或约束；
- **收敛**：职责可由现有父表或统一机制覆盖；
- **退役**：只属于兼容迁移，不应永久成为核心 Schema。

### 2.1 主要证据锚点

- SQLite 主 Schema：`morphz/src/memory/sqlite.rs:294-1283`；
- SQLite Recall/FTS Schema：`morphz/src/memory/sqlite.rs:1900-2030`；
- PostgreSQL 目录、Event History、Timer、Objective：`morphz/src/memory/postgres.rs:450-665`；
- PostgreSQL Thread/Activation/Job：`morphz/src/memory/postgres/execution.rs:24-141`；
- Signal/Outcome：`morphz/src/memory/postgres/activation.rs` 与 SQLite `ActivationStore` 实现；
- Thread/Action Group：`morphz/src/memory/postgres/thread_group.rs`、`action_group.rs`；
- Schedule/Dependency：`morphz/src/memory/postgres/schedule.rs`、`scheduler.rs`；
- Store 行为契约：`morphz/src/memory/mod.rs` 与 `morphz/src/scheduler/store.rs`。

表数通过扫描所有 `CREATE TABLE IF NOT EXISTS` 得到；SQLite 为 50、PostgreSQL 为 49，集合差只有 `session_mounts`。另行扫描 `CREATE VIRTUAL TABLE` 得到 SQLite 的 `recall_documents_fts`。清理结论来自对生产代码全部 `DELETE FROM`、终态 UPDATE、prune/purge/retention 路径的交叉检查，而不是只看 DDL。

## 3. 逐表结论

### 3.1 Event History、Context 与 Recall（10 张普通表 + 1 个 FTS 虚表）

| 表 | 类型与职责 | 增长/重建 | 结论 |
|---|---|---|---|
| `events` | 不可变事实 Event History；所有可审计因果事实的根 | 主增长源，不应按运行队列清理 | **保留** |
| `event_causal_projection_backfills` | 记录旧 Event 因果列按 Thread/Topic 完成渐进回填 | 只为旧数据兼容；完成标记长期保留 | **退役**：确定兼容截止版本，完成全库迁移后删除表和懒回填分支 |
| `attention_acknowledgements` | `(context,key)` 当前确认投影，指向权威 Event | 可由确认 Event 重建，按 key 覆盖，天然有界 | **保留** |
| `session_projections` | 当前未 retire 的 Observation 成员集合 | 只有 Event ID 与路由，不复制 payload；可从 Event History+Mind retire 状态重建 | **保留** |
| `context_cognitive_clocks` | 每个 Context 的认知活动时钟与批次幂等围栏 | 每 Context 一行 | **保留**；与目录行分离可避免高频写放大 |
| `context_heads` | Mind CAS 头：revision/hash/head event | 每 Context 一行 | **保留**；与大 `state_json` 垂直拆分可让热头查询不加载完整 Mind |
| `mind_projections` | 当前 Mind 状态 | 每 Context 一行，可由快照+Event 恢复 | **保留** |
| `mind_snapshots` | 每 64 revision 或显式 checkpoint/rollback 的恢复快照 | 自动快照会随 Context 生命周期增长 | **保留并治理**：永久保留显式 checkpoint；自动快照保留最近 N 个或按代际压缩 |
| `recall_documents` | Event/Frame 的可搜索全文投影 | 可重建；对可召回 Event 复制 searchable text 与 preview | **保留**；这是容量大户，但不是装饰性副本 |
| `recall_projection_outbox` | Recall 异步投影的 pending/processing 工作集 | 成功后会删除，失败由 lease/retry 接管 | **保留**；现有生命周期正确 |
| `recall_documents_fts` | `recall_documents` 的 FTS5 external-content 倒排索引 | 不复制完整 content，但维护 SQLite shadow tables | 不计入普通领域表；随 `recall_documents` 重建 |

说明：上表最后一行是物理附属结构，不计入 50 张普通表。`schema_migrations` 在调度/迁移小节统一说明。

### 3.2 身份、目录与入口幂等（PostgreSQL 6 张，SQLite 7 张）

| 表 | 类型与职责 | 增长/重建 | 结论 |
|---|---|---|---|
| `agents` | Agent 目录根 | 用户/安装规模 | **保留** |
| `cognitive_contexts` | Agent 下共享认知状态的目录与 token budget 配置 | Context 规模 | **保留** |
| `principals` | 跨 Session 稳定身份主体 | 用户规模 | **保留** |
| `sessions` | IO 会话目录；不可变挂载一个 Context | 会话规模 | **保留** |
| `session_principal_bindings` | Principal 与 Session 的参与关系 | 关系规模；解绑保留历史边界 | **保留** |
| `session_message_requests` | `(session_id,client_message_id)` 入口幂等键到 Event 的映射 | 每条客户端消息一行，随 Session 生命周期级联 | **保留**；JSON payload 无法提供同等的物理唯一约束 |
| `session_mounts`（仅 SQLite） | 历史挂载 generation，同时承载 attention 状态 | 当前产品不支持 remount；每 Session 实际只需要一条活动记录 | **收敛**：像 PostgreSQL 一样并入 `sessions`，迁移后删除 |

`session_mounts` 是本轮最明确的物理遗留。PostgreSQL 已经把 `mount_kind` 和 attention 字段放在 `sessions`；当前 Store 又拒绝把既有 Session 改挂到另一个 Context。因此 SQLite 的 generation/history 没有对应产品语义，只增加 JOIN、迁移和双后端分叉。

### 3.3 Objective 与调度（7 张）

| 表 | 类型与职责 | 增长/重建 | 结论 |
|---|---|---|---|
| `objectives` | 长程目标的权威状态、generation、lease、wait 与用量 | 用户可见历史 | **保留** |
| `delegations` | 父/子 Context/Session 的委托契约与结果 | 用户可见历史 | **保留** |
| `runtime_timers` | 各调度策略共享的物理时间队列，带 claim lease | ID 通常按 owner 稳定 upsert，但已删除 owner 的 fired/cancelled 行会残留 | **保留并治理**：增加按 owner 存在性与终态年龄的清理 |
| `schedules` | 用户可编辑的时间/周期调度规则 | 用户可见历史 | **保留** |
| `schedule_dependencies` | Schedule→Thread 的反向唤醒索引 | 与 `schedules.dependency_thread_ids_json` 双写；统一依赖表已经支持 owner=`schedule` | **收敛**：迁入 `scheduler_dependencies`，删除专用表 |
| `scheduler_dependencies` | Objective/Thread/Plan/Delivery 等 owner 的 generation-fenced 等待事实 | 终态依赖是恢复与审计收据 | **保留** |
| `schema_migrations` | 已应用迁移标记 | 每迁移一行 | **保留**；发布后 migration ID/语义不可改 |

当前 Schedule 同时保存 JSON 依赖列表和 `schedule_dependencies` 反向索引；创建时用事务与 JSON equality 防止局部写，正确性目前成立，但表达了两份同一配置。更重要的是，`scheduler_dependencies.owner_kind` 已包含 `schedule`，实际 Schedule 路径却没有使用它。这是两代依赖模型并存，不是一个应该永久接受的领域差异。

建议以 `schedules.dependency_thread_ids_json` 作为规则定义，在创建时向统一 `scheduler_dependencies` 物化可查询边；恢复和 wake 都查询统一边。迁移稳定后删除 `schedule_dependencies`。若最终确认统一边本身足以完整恢复规则，再在第二阶段删除 JSON；不要一次同时删除两层回滚依据。

### 3.4 Thread、Activation 与 Signal（9 张）

| 表 | 类型与职责 | 增长/重建 | 结论 |
|---|---|---|---|
| `threads` | 逻辑工作单元的稳定生命周期、supervision 与 delivery 状态 | 每轮/子任务一行，属于运行历史 | **保留** |
| `thread_activations` | 一次物理 Evaluation/执行尝试，带 claim/lease | 每次尝试一行，属于恢复和诊断历史 | **保留** |
| `thread_signals` | 发给逻辑 Thread 的 durable mailbox，带 generation fence | 每个可调度 Event 一行 | **保留** |
| `activation_signals` | 某 Activation 实际领取的 Signal 有序批次 | `signal_id` 全局唯一，实际是 1:N 而非多对多 | **收敛**：可并入 `thread_signals.claimed_activation_id/claimed_ordinal` |
| `signal_outbox` | Event 已提交、Signal 尚未物化时的崩溃安全交接 | materialized/discarded 行当前永久保留 | **保留并治理**：表只需保存未决交接；确认 successor 后可按窗口删除终态行 |
| `evaluation_outcomes` | Activation 的一次 outcome 收据，用 `activation_id`/`event_id` 保证幂等提交 | 每 Activation 最多一行 | **保留**：它是物理尝试终态，不等同逻辑 Thread 终态 |
| `thread_outcomes` | 逻辑 Thread 的富终态、证据、产物与交付边界 | 每 Thread 最多一行；Dialogue retry 会受控替换旧 outcome | **保留** |
| `thread_groups` | independently scheduled sibling Threads 的 all/any barrier | 每次 spawn group 一行 | **保留** |
| `thread_group_members` | Thread Group 成员、required 状态与 outcome 关联 | 每个 group 成员一行 | **保留** |

Signal 四层关系的准确解释是：

```text
Event（不可变原因）
  -> Signal Outbox（跨崩溃交接）
  -> Thread Signal（逻辑邮箱）
  -> Activation Signal membership（本次领取批次）
  -> Thread Activation（物理求值）
```

前三个边界不能简单删除，否则会重新引入“Event 已提交但 scheduler 没醒”或“重启后不知道消息是否已消费”的缺口。`activation_signals` 则不同：Schema 用 `UNIQUE(signal_id)` 明确一个 Signal 同时只能属于一个 Activation，打断时也会先删除旧 link 再重领，并没有保留多对多或历史 membership。因此它可以安全地内联到 `thread_signals`；这是降低表数和 JOIN 的合理位置。

`evaluation_outcomes` 与 `thread_outcomes` 不能合并：前者回答“这次物理尝试发生了什么”，后者回答“逻辑 Thread 最终交付了什么”。Provider wait 会终结 Activation 但保持 Thread open，正是两者必须分层的例子。

### 3.5 工具、审批与 deterministic plan（8 张）

| 表 | 类型与职责 | 增长/重建 | 结论 |
|---|---|---|---|
| `execution_jobs` | 物理副作用执行权威，含 retry safety、claim token 与终态 | 工具调用历史 | **保留** |
| `plan_executions` | deterministic Yao/S-Expr 程序的状态机与 child hand-off | plan 调用历史 | **保留**；不能与物理 Job 混为一体 |
| `action_groups` | 同一模型响应中多个 sibling tool actions 的 join | 每个并行工具批次一行 | **保留** |
| `action_group_members` | tool call 成员及其 Job/result Event | 每个 action 一行 | **保留** |
| `approval_requests` | 审批请求、决策与一次性 grant 消费 | 安全审计历史 | **保留** |
| `capability_leases` | Principal/Agent/Thread 或 Session/Target 范围内的短期能力授权 | 安全审计与当前 lease | **保留** |
| `execution_targets` | 可选择的逻辑执行目标 | 设备/路由规模 | **保留** |
| `execution_target_authorizations` | Target 对 agent/context/thread 的授权范围 | 授权规模 | **保留** |

`action_groups` 与 `thread_groups` 名字相近但不是重复：Action Group 在一个 Activation 内聚合工具调用，Thread Group 聚合可以独立调度、跨多个 Activation 的逻辑 Thread。它们的成员类型、supervisor、完成条件和恢复入口均不同。

### 3.6 Edge Node（5 张）

| 表 | 类型与职责 | 增长/重建 | 结论 |
|---|---|---|---|
| `execution_nodes` | 已配对设备及公钥/token 状态 | 设备规模 | **保留** |
| `execution_node_pairing_codes` | 一次性配对码 hash | consumed/expired 行从不删除 | **保留并治理**：短 TTL 后物理删除 |
| `execution_node_challenges` | 签名认证 nonce challenge | consumed/expired 行从不删除 | **保留并治理**：短 TTL 后物理删除 |
| `edge_execution_commands` | Execution Job 在远端节点上的 claim/heartbeat/terminal 镜像 | 远端执行历史 | **保留**；与 Job 是两个故障域 |
| `edge_command_output_chunks` | 运行中 stdout/stderr 的可分页流 | 终态后仍保留；同时 command 保存最终 output | **保留并治理**：终态后按保留期归档/删除 chunk，长输出优先转 Artifact |

### 3.7 Provider（4 张）

| 表 | 类型与职责 | 增长/重建 | 结论 |
|---|---|---|---|
| `provider_account_states` | 账户健康、cooldown、错误与 revision | 每账户一行 | **保留** |
| `provider_account_affinities` | route/scope→account 的粘性路由 | 每 route/scope 一行 | **保留** |
| `provider_refresh_leases` | OAuth refresh 的跨进程 generation lease | 每账户最多一行，release 会删除 | **保留** |
| `provider_model_catalog` | 账户真实物理模型目录缓存 | 刷新按账户替换，账户删除会清理 | **保留** |

## 4. 五组疑似重复表的最终判断

| 疑似重复组 | 判断 |
|---|---|
| `thread_signals` / `activation_signals` / `signal_outbox` | 三种职责真实存在；只建议把单值 membership `activation_signals` 内联，不删除 mailbox 或 outbox 边界 |
| `scheduler_dependencies` / `schedule_dependencies` | 确有两代机制并存；Schedule 应迁入统一 Dependency Store |
| `thread_groups` / `action_groups` | 不是重复：逻辑 Thread barrier 与单次模型响应的 tool-action join |
| `thread_outcomes` / `evaluation_outcomes` | 不是重复：逻辑结果与物理尝试结果；Provider wait 证明二者生命周期不同 |
| `sessions` / `session_mounts` | 当前产品语义下是物理重复；SQLite 应与 PostgreSQL 收敛 |

## 5. 双后端 Schema 不等价

Store conformance 证明“通过正式 Store API 写入时”两端行为一致，但不等于数据库约束一致。

### 5.1 PostgreSQL 状态域弱于 SQLite

SQLite 对大量核心字段有 `CHECK`：Objective status、Timer kind/status、Thread kind/status/control/lifetime/supervisor、Activation status、Execution Job status/retry safety、Action Group/member status、Approval status 等。

PostgreSQL 的以下初始 DDL 仍把相应字段定义为普通 `TEXT NOT NULL`：

- `signal_outbox.status`；
- `runtime_timers.kind/status` 与若干非负计数；
- `objectives.status/revision/continuation_sequence/tokens_used/time_used_seconds`；
- `threads.kind/status/control_state/lifetime/supervisor_kind/delivery_status`；
- `thread_activations.status` 与 revision/generation/sequence；
- `execution_jobs.status/retry_safety`；
- `action_groups.status`、`action_group_members.status` 及 member result invariant；
- `approval_requests.status/revision`。

正式代码会在反序列化时拒绝非法值，所以这不是正常 API 可直接触发的数据错误；但迁移脚本、人工修复、旧版本缺陷或未来新写入路径一旦写入非法字符串，错误会延迟到读取/恢复时才暴露，甚至阻断 Runtime 启动。

结论：这是 **P2 Schema 契约缺口**。现已由 `20260816_04_core_domain_constraints` 迁移修复：旧 Thread/Activation 术语先规范化，随后以 `NOT VALID -> VALIDATE` 安装核心状态域、计数、成员结果关系和 Session parent FK。真实 PostgreSQL 15 conformance 会 introspect 迁移标记与约束名称，并实际运行 Store 契约。

### 5.2 SQLite 引用完整性弱于 PostgreSQL

SQLite 已启用 `PRAGMA foreign_keys=ON`，但目录与部分跨聚合引用没有声明 FK：

- `cognitive_contexts.agent_id`；
- `sessions.agent_id/context_id/parent_session_id`；
- `delegations` 的 Agent/Context/Session 路由；
- 部分 `agent_id/context_id/principal_id/result_event_id` 审计引用。

PostgreSQL 已覆盖其中一部分，例如 Context→Agent、Session→Agent/Context、Delegation→Agent/Context/Session。Store 在 SQLite 写入前会做路由检查，因此正常调用仍安全；但数据库本身允许孤儿行。

结论：这是 **P2 后端完整性差异**。现已补齐 Context→Agent、Session→Agent/Context/Parent、Session Mount→Context，以及 Delegation 的 Agent/Context/Session 路由 FK。SQLite 旧库采用一次性无损 rebuild；迁移前先统计孤儿，发现任何不一致就保持原库不变并报告具体路由数量。`agents.root_context_id` 仍由 bootstrap bundle transaction + conformance 保证，避免制造 Agent↔Context 的循环建表依赖。

## 6. 容量审计

表的数量不是数据库膨胀的主要变量。更重要的是每轮对话产生多少行、哪些列复制大文本，以及终态记录是否回收。

### 6.1 主要字节来源

1. `events.payload`：不可变历史的主副本；
2. `recall_documents.searchable_text/preview`：为了全文召回复制可搜索文本；
3. `mind_snapshots.state_json`：每 64 revision 和显式 checkpoint 的完整状态；
4. `edge_command_output_chunks.text` + `edge_execution_commands.output`：流式 chunk 与最终输出并存；
5. 富 `thread_outcomes`、工具 request/result、Plan state 等运行历史。

`session_projections`、`activation_signals`、group members 等虽然增加行数，但大多只存 ID、ordinal 和状态，主要影响索引/页开销，不是大文本容量主因。

SQLite FTS 使用 external-content 表，不保存第二份完整 `searchable_text`，但倒排索引本身仍会占空间，这是搜索能力的必要成本。

### 6.2 当前缺失的统一保留策略

第一轮已经为三类明确失去权威性的瞬态记录建立了统一双后端 retention 契约：

- resolved `signal_outbox`：默认保留 7 天诊断窗口；
- expired pairing codes 与 challenges：默认在过期 1 天后删除；
- 每次启动每表最多清理 1,000 行，可通过 `[storage.retention]` 配置或禁用。

```toml
[storage.retention]
enabled = true
resolved_signal_outbox_age = "7d"
expired_edge_credential_age = "1d"
startup_batch_limit = 1000
```

该清理是单事务、分表有界的；测试明确验证它不会删除对应的不可变 persisted Event。仍缺少产品级 retention/归档决策的是：

- orphaned/old terminal `runtime_timers`；
- 自动 `mind_snapshots`；
- terminal Edge output chunks；
- 更广泛的 terminal Activation/Job/Group 历史归档周期。

不应直接删除所有终态运行历史，因为它们服务审计、恢复诊断和论文实验。正确做法是先定义三层数据等级：

```text
永久事实：Event、显式 checkpoint、安全决策、用户可见结果
有限历史：Activation、Job、Group、Timer、自动 snapshot、Edge chunks
瞬态工作集：outbox pending、lease、pairing code、challenge
```

然后为后两层提供按时间、Context 和终态状态的 GC；删除前将需要长期统计的字段汇总为稳定 usage/metrics Event 或归档 Artifact。

## 7. 修复优先级

### P2：发布前的 Schema 契约补强

1. ~~补齐 PostgreSQL 核心状态域、计数和 result invariant 约束；~~ 已完成；
2. ~~补齐 SQLite 无环目录/路由 FK；~~ 已完成；
3. ~~增加双后端 schema introspection test，不只运行行为 conformance。~~ 已完成，并通过 SQLite 新库/旧库与真实 PostgreSQL 15 回归。

### P2：容量生命周期

4. ~~为 pairing codes、challenges 增加确定性过期删除；~~ 已完成；
5. ~~把 `signal_outbox` 改成 pending work set：保留短诊断窗口后删除 resolved 行；~~ 已完成；
6. 定义自动 Mind Snapshot、Timer、Edge chunk 的 retention/归档策略；
7. 增加按表 row count、payload bytes、index bytes 的 operator diagnostics。

### P3：结构收敛

8. SQLite `session_mounts` 并入 `sessions`；
9. `schedule_dependencies` 迁入 `scheduler_dependencies`；
10. `activation_signals` 内联到 `thread_signals`；
11. 在兼容窗口结束后删除 `event_causal_projection_backfills`。

结构收敛要分版本做，不能在一轮迁移里同时改写 Session、Signal 和 Schedule 三条恢复链。每条迁移都必须包含：旧库 backfill、双写/读切换（如确有必要）、崩溃中断重入、SQLite/真实 PostgreSQL conformance、旧字段/表最终删除。

## 8. 最终回答：为什么有这么多表

答案分两部分：

1. **大部分表不是业务实体爆炸，而是持久化 Runtime 为崩溃恢复付出的显式状态。** 一个普通 Web 业务会把队列、定时器、工作流、全文索引、OAuth/Provider 路由和远端执行交给外部系统；Morphz 把这些能力放进自身内核，所以会在同一个数据库里看到它们。
2. **当前确实混入了历史实现与未收口的生命周期。** `session_mounts`、专用 Schedule dependency、单值 Activation membership 和 causal backfill marker 不应永远留在核心 Schema；若干瞬态表也不应永久保存终态行。

所以，不能简单说“50 张都合理”，也不应以“必须降到 30 张”为目标。正确目标是：每张表只有一个权威职责、每份重复数据都有明确性能理由、每个瞬态状态都有终点、两个后端由数据库本身执行同一组不变量。
