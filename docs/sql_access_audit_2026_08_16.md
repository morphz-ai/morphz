# Morphz SQL 访问、热路径审计与第一批修复

日期：2026-08-16
范围：SQLite、PostgreSQL、Runtime/Orchestrator/Objective/Timer/Recall/Provider、HTTP SDK 与 Dashboard 调用方式
状态：全量静态盘点、热路径深读与第一批六项修复已完成；第二批问题保留为显式后续工作

## 0. 实施结果

本轮没有通过缩短历史、跳过恢复或牺牲持久化语义来换取表面性能。改造的共同原则是：

1. **权威状态仍在数据库。** 进程通知只负责降低延迟，丢通知后的 fallback 仍能遍历全部待恢复工作；
2. **汇总精确、明细有界。** Dashboard 的数量不再由截断数组推断，明细则有明确上限和 `has_more_*`；
3. **先过滤、后限制。** 多 Context 视图的 SQL 先应用租户/Context 范围，再执行 `LIMIT`；
4. **增量读取不改变 Event 语义。** 首次取最近一页，后续按 sequence 增量合并，显式操作才加载更早历史；
5. **SQLite/PostgreSQL 行为对等。** 新 Store 契约、迁移和 keyset cursor 同时实现，并进入共享 conformance suite。

| 审计问题 | 修复后的契约 | 关键验证 |
|---|---|---|
| Activation admission 全候选动态分类/排序 | Activation 创建时持久化 `admission_rank`；按类从 partial ordered index 读取与窗口成比例的 bounded head，只对小候选集检查 Dialogue 可运行性和 aging | SQLite `EXPLAIN QUERY PLAN` 断言 admission partial index，且无临时排序；admission 行为回归 |
| Action Group 30 秒全量扫描与 N+1 | dirty ID 仍精确处理；fallback 使用 128 条 keyset page 连续清空 backlog；批量读取 Group members 和 Evidence Event | SQLite/PG Action Group conformance、running partial-index plan 断言 |
| Dashboard 周期重拉完整 Event/acknowledgement/Delegation | Event 与 acknowledgement 使用 sequence 增量；Delegation 按当前 Context/Session 服务端过滤并返回 `has_more`；仅首次加载最新页 | Dashboard 128 项测试、HTTP/SDK 类型检查与生产构建 |
| Scheduler `limit` 不约束活动明细 | 所有活动根集合 limit+1；summary 由 indexed scalar count 精确计算；选中 Thread 仍走精确聚合；响应显式提供 `detail_bounds`，Dashboard 提示明细窗口 | 精确计数/有界明细规模回归、既有 Scheduler invariant 回归 |
| Runtime Overview 全局截断后内存过滤 | 先选择 Context IDs，再由 Store 在 SQL 中按这些 Context 批量过滤 open Thread、active Activation、recoverable Objective 与 Delegation | SQLite/PG scoped Store conformance、全目标编译 |
| Delegation 公共列表与启动恢复全历史读取 | 启动恢复使用 128 条 active keyset page；HTTP 默认 200、最大 500 并返回 `has_more`；Runtime 兼容列表固定 500；活动恢复走 ordered partial index | SQLite query-plan 断言、SQLite/PG Delegation cursor/filter conformance |

### 0.1 有界常量与语义

- Action Group fallback page：128。页满时立即让出执行权后读取下一页，不人为把大 backlog 拖成每 30 秒一页；查询失败才等待正常 fallback 周期，避免忙循环。
- Delegation startup page：128；HTTP 默认 200、最大 500；树取消按 500 条 keyset page 遍历全部后代，不以 UI 页大小截断控制语义。
- Scheduler detail：请求 `limit` 约束各类根明细，服务端以 limit+1 判定 `has_more_*`；summary 始终使用精确计数 SQL。
- Attention acknowledgement：单页最大 500，并用持久 Event sequence 作增量 cursor。
- Admission：每个调度类最多读取 `max(limit × 4, 32)` 个 head 候选，再在内存中做小集合 aging 与 eligibility 选择。

最后一项存在一个有意且可观测的公平性取舍：在极端情况下，如果某个 Dialogue lane 的大量早期 queued Activation 全部被其 Session 内的在途工作阻塞，更晚候选可能延迟到前缀变化后才进入 bounded head。它不会丢任务、改变状态或绕过 durable recovery，但可能增加排队延迟。相比每次 slot 释放都扫描并排序整个持久队列，这是可接受的固定成本边界；后续若规模实验观察到该模式，应增加物化 runnable lane/readiness，而不是恢复全表扫描。

### 0.2 验证边界

本轮以以下证据收口：

- SQLite 热查询 `EXPLAIN QUERY PLAN` 回归，禁止四条第一批热路径出现完整候选排序；
- SQLite 与本机真实 PostgreSQL 的同一 Store conformance suite；
- Dashboard 单元测试、lint 与 production build；
- Rust `cargo fmt --check`、Clippy `-D warnings` 与完整 `cargo test -p morphz`。

PostgreSQL 生产规模下的 `EXPLAIN (ANALYZE, BUFFERS)` 和 p95/p99 仍属于负载基准，不由本轮本地契约测试替代。本文后半部分保留审计时的基线分析，便于说明问题来源；第 8 节第一批状态以本节为准。

## 1. 结论

审计基线中的 Morphz SQL 不是整体失控。核心事务里，以下设计是成立的：

- Event、Signal、Activation、Outcome 的关键写入具有原子事务边界；
- 主键读取、revision CAS、generation fence、lease claim 普遍有对应索引；
- Plan、Objective、Pending Signal 等恢复器已经采用有界批次；
- Context Encoding 已经读取 `session_projections`，不再在每次模型请求前扫描完整 Event History；
- SQLite 对易出现 deferred read→write upgrade 的路径已经主动获取 writer slot；
- PostgreSQL 的队列 claim 普遍使用 `FOR UPDATE SKIP LOCKED`。

但“单条 SQL 有索引”不等于“访问模型可扩展”。审计确认了六个必须在云端实验前处理、且现已完成第一批修复的主要问题：

1. **Activation admission 每次补位都可能分类、排序全部 queued Activation。** 输出虽有 `LIMIT`，输入工作量并未真正有界。
2. **Action Group 每 30 秒全局读取全部 running Group，并对每个 Group、每个未决成员继续做点查和提交。** 这是周期性无界 N+1。
3. **Dashboard 每 15 秒重复读取最多 1,000 条完整会话 Event、完整 Scheduler 聚合、全部 Delegation 和全部 attention acknowledgement。** 这里的主要成本是重复的大 payload 读取、JSON 解析和网络传输，不是索引缺失。
4. **Scheduler Snapshot 的 `limit` 只限制终态历史，不限制全部活动 Objective、Thread、Signal、Job 和 Group。** 一个积压或损坏的 Context 会使每 15 秒的快照无界膨胀。
5. **Runtime Overview 先读取全局最近活动，再在 Rust 中按选中的 Context 过滤。** 在多租户下既浪费读取，也可能漏掉被其他 Context 挤出全局窗口的活动行。
6. **Delegation 的公共列表和启动恢复读取全部历史。** Dashboard 还会每 15 秒调用一次；SQLite 同时缺少按 status 的恢复索引。

另有若干次级问题：Edge Node 每 15 秒状态扫描缺少全局 stale 索引；Objective persisted-wait 会重复读取一个时间范围内的全部同 topic Event 再在内存匹配 payload；Recall/Timer 的 OR 队列索引对第二个分支只能按 status 定位；PostgreSQL Event group commit 仍逐行发 INSERT；启动恢复仍有按 Context 的 N+1。

因此，当前最准确的判断是：

> **请求级正确性事务总体稳健；主要扩展风险集中在 admission、周期性 recovery 和 Dashboard read model，而不是 50 张表本身。**

## 2. 审计覆盖与方法

### 2.1 静态覆盖

本次扫描并分类了所有生产存储模块中的 `sqlx::query*` 与 `QueryBuilder` 调用点：

- SQLite：792 个调用点；
- PostgreSQL：630 个调用点。

这个数字包含 DDL、迁移、不同分支和复合事务中的多个调用点，不代表有 1,422 条互不相同的业务 SQL。它的用途是确保没有只抽查几个文件：

- SQLite 主实现与 `sqlite/plan_execution.rs`；
- PostgreSQL root、activation、execution、plan execution、thread、thread group、action group、schedule、scheduler、session、delivery、approval、delegation、target、edge；
- Store trait 与 Runtime/Orchestrator/Objectives/Timer/Provider 的调用者；
- HTTP SDK 和 Dashboard 的轮询方式。

### 2.2 热度分类

| 等级 | 定义 | 典型路径 |
|---|---|---|
| H0 | 每次消息、模型 Attempt 或工具结果必经 | message claim、Signal claim、Context Encoding、Event append、Activation outcome |
| H1 | 活动任务期间高频或事件驱动重复 | admission refill、Job/Objective heartbeat、Timer claim、Provider routing |
| H2 | 固定周期或 Dashboard 周期读取 | Objective/Plan/Action Group/Edge reconcile、Dashboard snapshot |
| C | 启动、迁移、显式审计、重建 | schema migration、startup recovery、Recall rebuild、深历史审计 |

### 2.3 Query Plan 证据边界

对仓库根目录的 SQLite 样本库只做了只读 `EXPLAIN QUERY PLAN` 和结构统计，用来验证查询形状，不把它当作当前产品容量证据。该库仍含旧版本 `chat/context_inspect` 大 payload，不能据此推断新版本容量。

PostgreSQL 本轮完成了 SQL 与索引的逐项静态对照，但还没有在生产规模数据集上跑 `EXPLAIN (ANALYZE, BUFFERS)`。这是后续基准阶段必须补的证据，不应以 SQLite plan 代替。

## 3. 一条用户消息实际经过哪些数据库访问

### 3.1 消息入口：H0

`send_message` 的物理路径是：

1. 读取 Session 和 Principal binding；
2. `claim_message` 开事务并锁定 Session authority；
3. 检查 `(session_id, client_message_id)` 幂等键；
4. 可选中断尚未产生执行线程的旧 Dialogue Activation；
5. 插入 user Event；
6. 创建或复用 Dialogue Thread，插入 durable Thread Signal；
7. 更新 Session activity/attention；
8. 一次提交。

主要表：`sessions`、`session_principal_bindings`、`session_message_requests`、`events`、`threads`、`thread_signals`、`signal_outbox`、`thread_activations`。

评价：

- 所有身份、幂等与路由判断都在同一事务观察边界内，正确；
- SQLite 首句 no-op UPDATE 主动取得 writer，避免 snapshot upgrade `database is locked`，正确；
- 外层发送路径会先验证一次 Principal，事务内为防 TOCTOU 又验证一次，存在一个低成本重复点查，但不是当前瓶颈。

### 3.2 Signal → Activation：H0/H1

`claim_thread_signal_batch` 是最复杂的热事务之一。两个后端的实现各包含三十多个分支 SQL 调用点，实际执行数取决于：

- Signal 是否已存在；
- Thread 是否已存在、generation 是否匹配；
- 是否为可打断 Dialogue；
- 是否存在旧 Activation/Signal membership；
- 是否需要创建新 Activation、批量领取 mailbox、更新 outbox。

它的复杂并非无意义 N+1，而是把以下不变量放在一个提交里：

```text
Event 已存在
  + Signal 只被一个 Thread generation 接受
  + 一批 Signal 只属于一个 Activation
  + Dialogue lane 不产生并发旧回复
  + Activation 与 Thread/Session/Objective route 一致
```

核心谓词已有索引：

- `thread_signals(status, sequence)`；
- `thread_signals(thread_id, status, sequence)`；
- `thread_activations(root_turn_id, generation, status, updated_at)`；
- Thread/Activation 的 PK、Session/status、Context/status 索引。

主要风险不是表扫描，而是长事务中的顺序 round trip 和 SQLite writer 持有时间。应增加 Store-operation 级分阶段延迟指标，而不是贸然拆事务。

### 3.3 Activation Admission：H1，P1

当进程内 admission window 出现空位时，Runtime 会调用 `list_queued_thread_activations_for_admission`。该查询：

- JOIN queued Activation、Event、Thread；
- 从 Event type/topic/JSON payload 动态计算 admission class；
- 为 Dialogue lane 执行两个相关 `NOT EXISTS`；
- 用当前时间动态计算 aging rank；
- 对全部候选分类和排序后，才分别取 reserved/general `LIMIT`。

问题在于：**返回窗口有界，但分类输入无界。** admission slot 每释放一次都可能触发该查询；持久队列越长，每次补位越贵。

建议：

1. Activation 创建时持久化 Runtime 决定的 `admission_class`，不在热查询解析 Event JSON；
2. 建 `(status, admission_class, created_at, id)` 索引；
3. 每类只读取一个与窗口成比例的有界 head，再在小集合上计算 aging；
4. Dialogue lane 的可运行性只对最终候选检查；
5. 保留当前动态 aging 语义，但不要为了它扫描整条持久队列。

### 3.4 Context Encoding：H0

每个模型 Attempt 的 Context 读取已经是投影路径：

1. 从 `mind_projections` 读取当前 Mind；
2. 从 `session_projections` JOIN `events`，只加载当前 Session 工作集和 context-wide Observation；
3. 按 `event_sequence` 合并为一致快照。

对应索引为：

- `session_projections(context_id, session_id, event_sequence)`；
- `events(id)` 主键；
- `context_heads(context_id)` / `mind_projections(context_id)` 主键。

这条路径不会默认读取完整 Event History，设计正确。它的返回规模等于真正要发给模型的 active working set，因此无法通过 SQL 分页来“优化”而不改变模型语义。

需要持续观察的写放大是：每次 `context_tx` 会 CAS `context_heads`，并整体重写一行 `mind_projections.state_json`。如果 Frame state 将来增长到 MiB 级且 transaction 高频，SQLite WAL 与 PostgreSQL MVCC 都会放大。当前样本的 Mind 行仍很小，现阶段不应为了假设提前拆表；应先记录 `state_json_bytes`、commit latency 和 PostgreSQL dead tuples，再决定是否改为增量 projection。

### 3.5 Model Attempt 与 Provider Routing：H0

每次 Attempt 通常会：

- 按 account PK 读取健康状态；
- 按 `(route_id, scope_key)` 读取 affinity；
- 成功选路后 upsert affinity；
- Attempt 过程中 append started/state/reasoning/usage 等 Event。

账户候选数量很小，查询均为 PK 或唯一键查找。Provider model catalog 只在管理/刷新时整批替换，不在每 token 热路径。本部分没有发现全表扫描型问题。

### 3.6 Event Writer：H0/H1

Durable Event Writer 默认在 2 ms 内合并最多 64 个 append 请求，并在一个事务提交。这个 group commit 边界合理。

但两端 `append_batch` 当前仍是在事务中顺序执行一条条 INSERT：

- SQLite 是同进程调用，成本主要是索引维护，问题较小；
- PostgreSQL 若数据库跨网络，最多 64 次顺序 client/server round trip 会削弱 group commit 的收益。

后续可给 PostgreSQL 使用 `UNNEST`/multi-row INSERT 或 pipeline，同时保持每个 Event 的幂等和因果投影逻辑。该优化需要行为测试，不能只把 INSERT 字符串拼成一条。

### 3.7 Activation Outcome：H0

`commit_activation_outcome` 是另一个大型原子事务，负责：

- 校验 Activation/Thread revision、generation 与 claim；
- 写入物理 Evaluation outcome 与最终 Event；
- 更新 Thread logical outcome；
- 释放/重置 Signal；
- 收敛 Thread Group、Dependency、Objective/Delivery 等后继边。

这段代码分支很多，但没有在数据库事务中调用模型、网络或外部工具。保持原子性比减少 SQL 条数更重要。近期应做的是分阶段计时与锁等待观测；只有证据表明某个只读校验重复，才做定向合并。

## 4. 周期性与恢复路径

| 路径 | 触发方式 | 批次/范围 | 索引结论 | 审计结论 |
|---|---|---:|---|---|
| Activation admission refill | permit/queue 变化，10 ms 合并 | 返回受 window 限制，输入无界 | queued/status 有索引，但动态分类需扫候选 | **P1** |
| Plan reconciler | 通知 + 30 s fallback | 3 类各 128 | queue、pending、wait-kind 对齐 | 正常 |
| Pending Signal reconciler | DB/进程通知 + 30 s fallback | 128 | status/sequence、root generation/status 对齐 | 正常 |
| Objective reconciler | dirty context + 30 s fallback | dirty context 最多 32；全局 page 128 | partial recoverable `(created_at,id)` 对齐 | 正常，另有 persisted-wait 问题 |
| Action Group reconciler | dirty 通知；每 30 s full fallback | full fallback 无界 | 缺 global `(status,created_at,id)` | **P1** |
| Supervision audit | dirty context，每 2 s | 每个 dirty Context 的全部 live authority | Context/status 索引对齐 | 活跃集合有界假设；需批量 API |
| Timer engine | next-due + notify | claim 64 | status/due 索引部分对齐 | 正常，索引可优化 |
| Recall projector | backlog 25 ms；idle 2 s | 4 documents | pending 分支好，expired claim 分支不完整 | **P2** |
| Edge reconcile | 默认每 15 s | 全局状态 UPDATE | node stale 缺索引 | **P2** |
| Execution Job heartbeat | 每个运行后台 Job 每 30 s | 单 Job PK/CAS | 对齐 | 正常 |
| Objective Evaluation heartbeat | lease/3 | 单 Objective PK/CAS | 对齐 | 正常 |

### 4.1 Action Group：周期性无界 N+1，P1

full fallback 当前执行：

```sql
SELECT *
FROM action_groups
WHERE status = 'running'
ORDER BY created_at, id;
```

随后每个 Group 至少再读取：

- `tool_calls_selected` Event；
- Group members；
- 每个 pending member 的确定性 output Event；
- 可能的 member commit transaction。

SQLite 的只读 `EXPLAIN QUERY PLAN` 验证该形状会扫描 `action_groups` 并建立临时排序 B-tree。现有索引以 `context_id`、`session_id` 或 `activation_id` 开头，没有全局 running 顺序索引。

修复应同时做三件事，单独加索引不够：

1. 增加 bounded cursor Store 方法，例如每页 128 个 running Group；
2. 增加 partial/global `(created_at,id) WHERE status='running'`；
3. 批量读取 members 和确定性 Event，消除 per-group/per-member N+1；
4. dirty path 仍保留精确 ID 点查，30 s fallback 只负责丢通知恢复。

### 4.2 Objective persisted wait：范围读取后内存匹配，P2

对 Permission、ExternalEvent、ResourceAvailable、ThreadGroup wait，恢复器会读取：

```text
context_id + objective.updated_at 之后 + exact topic 的全部 Event
```

然后在 Rust 中检查 payload 是否匹配 wait 条件。索引 `(context_id, topic, timestamp, sequence)` 能快速进入范围，但长时间等待且 topic 高频时，返回集合仍会持续增大，并在 30 s fallback 中重复读取。

不能简单改成 `LIMIT 1`，因为第一个同 topic Event 未必匹配 payload。正确方案是：

- 为 wait 保存 last-scanned sequence；或
- 将可路由 wait key 投影为结构化列；或
- 使用 bounded keyset page 扫描并推进持久游标。

### 4.3 Recall 与 Timer 的 OR 索引，P2

两者都把 pending due 和 processing/claimed lease-expired 放在一个 OR 查询中：

- Recall：`status, available_at, claim_expires_at, updated_at`；
- Timer：`status, due_at, claim_expires_at, id`。

第一个分支可以使用 status + due 字段；第二个分支因为另一个 due 字段位于组合索引中间，通常只能按 status 定位。SQLite plan 已显示第二分支只使用 `status=?`，并为全局 ORDER BY 建临时 B-tree。

建议分别建立 partial index：

```text
Recall pending:     (available_at, updated_at, context_id, document_kind, document_id)
Recall processing:  (claim_expires_at, updated_at, context_id, document_kind, document_id)
Timer pending:      (due_at, id)
Timer claimed:      (claim_expires_at, id)
```

运行时 Timer 数通常很小，所以这是 P2；Recall rebuild backlog 较大时收益更明显。

### 4.4 Edge Node stale scan，P2

默认每 15 秒执行：

```sql
UPDATE execution_nodes
SET status = 'offline', ...
WHERE status = 'online'
  AND (last_seen_at IS NULL OR last_seen_at < ?)
```

现有 node 索引是 `(owner_principal_id,status,updated_at)`，无法服务全局 `status + last_seen_at`。单机节点数少时无感，云端节点目录增长后会固定扫描。应增加 partial/global online last-seen index。

## 5. Dashboard 与 API 是当前最热的读取者

### 5.1 选中 Session 后的 15 秒轮询

Dashboard 每 15 秒并行读取：

- conversation Events：最多 1,000 条完整 payload；
- model usage：100 条；
- Context overview；
- Scheduler snapshot；
- 全部 Delegation；
- 全部 attention acknowledgement。

它同时已有 WebSocket invalidation，因此正确方向不是继续扩大 snapshot，而是：

1. 首次加载使用 latest page；
2. 后续携带 `after_sequence` 只取增量 Event；
3. 仅“加载更早历史”时使用 `before_sequence`；
4. Scheduler 使用 revision/cursor 或 dirty aggregate 增量；
5. Delegation 按当前 Context/Session 查询并分页；
6. acknowledgement 只请求当前可见 attention keys，或分页/按 updated cursor 拉增量。

样本库中，最活跃 Session 的最近 1,000 条 presentation Event payload 约 5.14 MiB。这个数字不是新版本容量基准，但足以证明：即使查询耗时只有毫秒，每 15 秒完整重传仍是不必要的稳定成本。

### 5.2 Scheduler Snapshot 的 limit 语义，P1

当前 `SchedulerQuery.limit` 限制的是追加的终态历史。以下集合仍全部读取：

- Context 下所有 active/paused/blocked Objective；
- 所有 open Thread；
- 所有 queued/running Activation；
- 所有 pending Signal；
- 所有非终态 Execution Job；
- 所有 running Thread Group/Action Group；
- pending Approval 和相关成员。

正常情况下活动集合较小；但积压、外部 Provider 故障或生命周期 Bug 恰恰会放大这些集合，而 Dashboard 又是排查这些故障的入口。快照不能依赖“状态永远健康”来保持有界。

应把 Snapshot 改为：

- 总数永远精确；
- 活动明细也有明确上限与 `has_more_*`；
- 选中 Thread/Objective 时精确加载完整聚合；
- 默认只返回当前 Session 和 attention-required 活动；
- 诊断页通过 cursor 扩展，不把 `limit` 伪装成只管历史。

### 5.3 Runtime Overview 的全局截断后过滤，P1

Runtime Overview 虽把活动行限制在最多 4,000，但查询的是全局 newest open Threads、active Activations、recoverable Objectives 和 recent Delegations，随后才在 Rust 中过滤当前展示的 Context IDs。

多租户下存在两个问题：

- 读取了大量最终会丢弃的其他 Context 行；
- 某个选中 Context 的活动可能被其他 Context 的更新行挤出 4,000 全局窗口，导致计数/attention 漏报。

Store 应提供按 `context_ids` 批量过滤的 bounded 查询；限制必须施加在过滤之后，不能先截断全局结果。

### 5.4 Delegation 全量列表，P1

`list_delegations()` 是无过滤、无 limit 的历史全表读取：

- Runtime 启动恢复先取全部历史，再在内存筛 queued/running；
- `/api/delegations` 直接返回全部历史；
- Dashboard 对选中 Session 每 15 秒调用一次该接口。

PostgreSQL 有 `(status,updated_at,id)` 索引，SQLite 没有；但即使补索引，现有全历史 API 仍不会使用 status。

建议拆成：

- `list_recoverable_delegations_page(status IN queued/running, cursor, limit)`；
- `list_context_delegations(context_id, cursor, limit)`；
- `list_session_delegations(session_id, cursor, limit)`；
- 公共 HTTP API 强制默认/最大 limit。

### 5.5 Attention acknowledgement 全量列表，P2

acknowledgement 按 `(context,key)` 覆盖，但 key 代表具体 attention fingerprint，长期仍可能增长。当前 Dashboard 每 15 秒读取 Context 全部 acknowledgement。现有 `(context_id, acknowledged_at DESC, event_sequence DESC)` 索引能排序，却不能限制返回规模。

近期可按 Dashboard 当前 source keys 精确查询；长期提供 updated cursor 和 retention/归档语义。

## 6. 启动与冷路径

### 6.1 已经合理有界的启动/恢复

- Plan 三类 recovery：各 128；
- Objective continuous recovery：keyset page 128；
- terminal outbox retention：分表有界 batch；
- Event ID 批量读取：通常按 500 分块，避免 bind limit；
- terminal Thread/Activation 的 Dashboard 历史：按聚合和 limit 读取。

### 6.2 仍需收敛的启动 N+1

- `recover_pending_thread_signals`：先列 Context，再逐 Context 取全部 pending Signal；
- `recover_thread_activations`：先列 Context，再逐 Context 取全部 live Activation；
- `audit_active_supervision_invariants`：逐 Context 读取 Objective、Thread、Activation、Group、members、outcome、dependency；
- `recover_delegations`：全历史 Delegation，再逐 live Delegation 读取 child Context Activation 和 Event；
- `recover_action_groups`：全局 running Group，再逐 Group/member 点查。

这些不是正常请求热路径，但会让“大数据库重启”变慢。建议统一为 global live-state keyset page + bulk child reads，而不是为每个 Context 建一串查询。

### 6.3 迁移与显式重建

以下路径允许扫描历史，但必须明确属于离线/运维操作：

- Schema migration/backfill；
- `rebuild_recall_index`；
- deep historical invariant audit；
- seed/export；
- 显式全 Event History 查询。

云部署不应在每次应用启动时无条件跑大表 rewrite。需要把大型 migration 标为可观测、可恢复、可预执行，并给 PostgreSQL 使用独立 migration job/maintenance window。

## 7. 全表访问热度地图

| 领域 | 表 | 热度与主要访问 |
|---|---|---|
| Event History | `events` | H0：append、Context join、Dialogue page、Recall materialize；历史查询 C |
| Event History | `session_message_requests` | H0：消息幂等 PK insert/get |
| Context | `context_heads` | H0：Mind revision CAS/读取 |
| Context | `mind_projections` | H0：Attempt snapshot read；context_tx 全行 rewrite |
| Context | `session_projections` | H0：Attempt working-set join；context_tx membership mutation |
| Context | `context_cognitive_clocks` | H0/H1：信号批次时钟 CAS |
| Context | `mind_snapshots` | C/H2：每 64 revision 或 checkpoint/rollback |
| Recall | `recall_projection_outbox` | H1/H2：batch 4 claim/finish |
| Recall | `recall_documents`、FTS | H1 写投影；用户 recall 查询 H1 |
| Directory | `agents`、`cognitive_contexts` | 低频目录；Overview H2 |
| Directory | `sessions`、`session_mounts` | 消息入口 H0；Dashboard/Context H2 |
| Identity | `principals`、`session_principal_bindings` | 消息授权 H0；目录 H2 |
| Scheduler | `threads` | H0/H1：消息、supervision、Snapshot |
| Scheduler | `thread_activations` | H0/H1：claim、admission、heartbeat、outcome |
| Scheduler | `thread_signals`、`activation_signals` | H0/H1：durable mailbox 与领取批次 |
| Scheduler | `signal_outbox` | H0 写交接；启动恢复/retention C |
| Scheduler | `evaluation_outcomes`、`thread_outcomes` | H0 终态提交；诊断 H2 |
| Scheduler | `thread_groups`、`thread_group_members` | H1 barrier；Snapshot/恢复 H2 |
| Objective | `objectives` | H1/H2：reconcile、lease、Snapshot |
| Objective | `delegations` | 当前错误地成为 H2 全历史轮询；应按 live/scoped 分页 |
| Objective | `runtime_timers` | H1：next due/claim/complete |
| Schedule | `schedules`、`schedule_dependencies`、`scheduler_dependencies` | H1/H2：timer/wake；配置低频 |
| Execution | `execution_jobs` | H0/H1：claim、heartbeat、outcome、Snapshot |
| Execution | `plan_executions` | H1：claim、wait handoff、30 s recovery |
| Execution | `action_groups`、`action_group_members` | H1/H2：结果 join；当前 full reconcile P1 |
| Security | `approval_requests`、`capability_leases` | 工具执行 H0/H1；均按 job/lease key |
| Target | `execution_targets`、`execution_target_authorizations` | 工具路由 H0/H1；目录 H2 |
| Edge | `execution_nodes`、pairing、challenge | Node heartbeat H1；stale reconcile H2；pairing 低频 |
| Edge | `edge_execution_commands`、output chunks | 远端执行 H1；lease recovery H2 |
| Provider | account state、affinity、refresh lease | 每 Attempt 少量 PK/unique 访问 H0/H1 |
| Provider | model catalog | 管理页/刷新 H2，非 Attempt 热路径 |
| Migration | `schema_migrations`、causal backfill marker | 启动/迁移 C |
| Operator | `attention_acknowledgements` | 当前 Dashboard H2 全量；应 scoped/incremental |

## 8. 修复顺序与当前状态

### 第一批：已完成

1. Admission 候选持久化分类 + 有界按类 head：**完成**；
2. Action Group cursor/bulk recovery + running partial index：**完成**；
3. Dashboard Event 增量游标，停止每 15 秒重拉 1,000 条：**完成**；
4. Scheduler 活动明细真实有界，增加 `has_more_*` 与精确聚合加载：**完成**；
5. Runtime Overview 按 Context IDs 在 SQL 内过滤：**完成**；
6. Delegation 恢复/API scoped pagination，补 active ordered partial index：**完成**。

### 第二批：基准前完成

1. Edge stale partial index；
2. Recall/Timer 双 partial due index；
3. Objective wait sequence cursor；
4. attention acknowledgement scoped/incremental；
5. 启动 recovery 改 global live keyset + bulk children；
6. PostgreSQL append_batch 真正批量化。

### 第三批：以数据决定

1. `mind_projections.state_json` 是否需要增量化；
2. Event 多 topic latest page 是否需要独立 dialogue projection/index；
3. 自动 snapshot、terminal runtime history 和 Edge output 的归档；
4. 表合并或物理分区。

## 9. 必须补的可观测性

仅依赖 SQLx 的 “slow statement > 1s” 不足以解释 Runtime。下一步应为 Store operation 记录稳定指标：

```text
db.operation
db.backend
db.context_scope
db.rows_returned / rows_affected
db.elapsed_ms
db.writer_wait_ms
db.retry_count
db.page_limit
db.payload_bytes（只记长度，不记内容）
```

关键 operation 至少包括：

- `message.claim`；
- `signal.claim_batch`；
- `activation.admission_page`；
- `context.encoding_snapshot`；
- `event.append_batch`；
- `activation.commit_outcome`；
- `action_group.recovery_page`；
- `scheduler.snapshot`；
- `recall.project_batch`；
- `timer.claim_due`。

PostgreSQL 基准启用 `pg_stat_statements` 并记录 normalized query、calls、mean/p95、rows、shared/local/temp blocks；SQLite 使用上述 operation span、`EXPLAIN QUERY PLAN` 和受控规模基准。日志不能包含 payload、token、secret 或完整 SQL 参数。

## 10. 当前发布判断

本轮没有发现“每个正常模型 Attempt 都扫描完整 Event History”或“所有 Scheduler 查询都无索引”这类系统性灾难。核心事务继续以正确性为先，第一批六项扩展风险也已经在不削弱 durable recovery 的前提下收敛。

因此，当前代码可以进入多 Context、长历史的受控论文实验；实验必须同时记录 page 命中率、`has_more_*`、admission deferred 数量、Store operation latency 与数据库临时排序/块读取。第二批项目仍需在正式云端多租户发布前完成，尤其是 Objective wait cursor、Recall/Timer 分支索引、启动恢复 N+1 与 PostgreSQL Event 真正批量写入。这里的“可以实验”不等于已经证明云端容量，生产规模 PostgreSQL 基准仍是发布证据的一部分。
