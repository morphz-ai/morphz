# Morphz Context 事务、Mind Projection 与分布式扩展设计 v1

> 状态：Phase 1–5 核心实现完成；SQLite 与 PostgreSQL 共享同一 Projection/CAS/Lease 契约，Frame 级 MVCC 已落地，生产级跨主机容量验证仍待真实部署
>
> 日期：2026-08-01
>
> 适用范围：共享 Mind、Context Transaction、Frame 生命周期、Session 海量并发、Event Ledger、在线状态恢复与多 Runtime Worker
>
> 上位架构：[统一人格、多路会话与分布式认知架构](./morphz_single_identity_distributed_cognition_architecture.md)
>
> 相关实现：[并发 Session 事件循环与认知工作集](./morphz_concurrent_session_working_set_v1.md)、[Scheduler Kernel v2 稳定化重构](./morphz_scheduler_kernel_stabilization_v2.md)、[当前核心实现状态总览](./morphz_runtime_core_implementation_status_v1.md)

## 0. 实施进度（更新于 2026-08-01）

本节保留了 PostgreSQL 能力逐项落地的时间顺序。其中提到的内部 Signal Outbox 是当时的实现里程碑；Scheduler Kernel v2 已把 Runtime 内部调度迁移为 Kernel 事务中的持久 Direct Signal，并删除正常路径的内部 Outbox 与 barrier repair。外部系统交付所需的 Outbox 仍然保留。

已经落地：

- SQLite `context_heads`、`mind_projections` 与周期/检查点 `mind_snapshots`；
- Context transaction 通过数据库 revision CAS 提交，不再只依赖进程内 Mutex；
- Ledger Event、Mind Projection、Context Head 与 Session attention 在同一 SQLite transaction 中原子提交；
- Context Encoding、Frame 查询与 Mind version 读取在线 Projection；旧数据库仅在首次访问时完整重放并懒迁移；
- 已增加 `session_projections`：每条 Agent 可见 Observation 在 Ledger append 的同一数据库事务中进入当前态投影；`retire` 删除投影行、`restore` 从不可变 Ledger 恢复投影行；
- Session Projection 不引入 projection head、watermark 或 Session Snapshot。Ledger append 与 Projection 更新原子提交，因此查询出的行集本身就是当前完整状态；
- Context Encoding 先计算有界 Session Working Set，再只读取这些 Session 与 Context-wide Observation 的 Session Projection，不再扫描所选 Session 的完整 Ledger；
- `context_tx` 只按 SExpr 实际涉及的标识查询、验证 Observation，不再扫描全 Context 来解析少量 `@eN`；
- 新事务默认记录规范化 SExpr、Diff、`before_hash` 与 `after_hash`，Projection Profile 不再复制完整 `state_after`；
- Projection 缺失时优先从最近可信 Snapshot + 后续 Mind Transactions 增量重建；Snapshot、事务 hash chain 与 Ledger 游标任一不一致都会显式失败；
- Context Head 与 Mind Projection 的在线一致性由同一条数据库语句读取；不会因另一 Runtime 恰好在两次查询之间完成原子初始化而把健康状态误报为单边损坏；
- `morphz context audit [CONTEXT_ID]` 同时执行 Genesis 全量重放、Snapshot 增量重放并比对在线 Projection；
- 两个独立 ContextEngine 对同一 Context 的并发同版本写入，已由 SQLite CAS 验证为仅一个成功；
- Runtime durable Event 已进入有界 Event Writer；并发发布者在可配置微窗口内 group commit，Signal Outbox 与 Event 同事务提交；
- Event Writer 的 queue depth、累计 Event/Batch、失败 Batch 与最大 Batch 已进入统一 Scheduler Snapshot，CLI、HTTP API 与 Rust SDK 共享同一读模型。
- 已增加可复现的 `context_scalability_benchmark`，首份 release 基线见 [Context Scalability Baseline — 2026-07-18](./benchmarks/context_scalability_baseline_2026-07-18.md)。
- 完整 Activation 准入与模型 Provider 配额已经解耦：默认最多运行 16 个 Activation、同时占用 4 个模型请求槽位；等待工具、定时器或审批不会错误占用 Provider 槽位。
- Provider 的 queued、in-flight、max-in-flight 与累计取得槽位次数已进入统一 Scheduler Snapshot；CLI、HTTP API、Rust SDK 与 Dashboard 使用同一事实源。
- Runtime 持久层已从具体 `Arc<SqliteStore>` 解耦为一份完整的 `RuntimeStore` capability composition；SDK 可以显式注入后端，所有原子能力必须由同一个 Store 提供，禁止把一次因果提交拆到互不相关的数据库。
- 已建立数据库无关的完整 RuntimeStore conformance suite；SQLite/PostgreSQL 均已通过 Context revision CAS、Projection/Event/Session attention 原子一致、Scheduler authority 和失败 Batch 全回滚测试。
- PostgreSQL Context Authority 已实现 Event Ledger/query、原子 Batch/outbox、Mind Projection/head revision CAS、Snapshot、seed provenance 和 Session attention 同事务更新；已在临时 PostgreSQL 15 实例上与 SQLite 运行同一套 Context transaction conformance suite 并通过。
- PostgreSQL 物理 Timer Store 已实现 generation fence、leased claim、retry/complete/cancel；到期领取使用 `FOR UPDATE SKIP LOCKED`，两个并发 Worker 已通过同一套无重复 claim 测试。
- PostgreSQL Objective Store 已实现生命周期 revision CAS、等待条件、求值 lease、用量记账，以及“求值 lease + continuation Event/outbox”原子提交；SQLite/PostgreSQL 已通过同版本双写只允许一个胜者和 Event 冲突整笔回滚测试。
- PostgreSQL Execution Job Store 已实现因果路由验证、revision/claim-token 双重 fence、heartbeat、requeue/cancel、不可逆终态，以及“物理终态 + tool-output Event”原子且幂等提交；并发 Worker claim 与陈旧 claim 拒绝已通过跨后端契约测试。
- PostgreSQL Approval Authority 已实现稳定请求身份、决策/取消 revision fence、不可逆审计 Event、一次性 Grant，以及“消费 Grant + claim Execution Job”跨聚合原子提交；并发消费只有一个 Worker 获胜。相同测试还发现并修复了 SQLite 在 Grant 竞争中由 deferred snapshot 升级引发的 `SQLITE_BUSY`。
- 原先过大的 `SessionStore` 已按因果职责拆分为 `SessionDirectoryStore`、`ActivationStore`、`ThreadStore`、`ScheduleStore`、`DeliveryIngressStore` 和 `DelegationStore` 六项 capability；`SessionStore` 只作为完整组合边界。这样可以逐项实现和验证 PostgreSQL 能力，但 Runtime 仍只接受完整组合，避免半套后端进入生产路径。
- PostgreSQL `SessionDirectoryStore` 已实现 Agent/Context/Session 创建与查询、原子 Agent bundle、Mind seed provenance、生命周期、activity 和 attention revision fence；SQLite/PostgreSQL 已通过同一套并发 Session 创建、路由约束、归档过滤和 attention CAS 契约测试。
- PostgreSQL `ThreadStore` 已实现稳定 Thread identity、revision CAS、Context/Session 查询、pending delivery 投影、聚合 Delivery Flush Timer，以及 Fast Path/Event/outbox 原子交付；SQLite/PostgreSQL 已通过同一套并发 ensure、Thread CAS 与交付定时器契约测试。
- PostgreSQL `ActivationStore` 已实现 Signal Outbox 物化、按 Thread 跨 Worker single-flight、Signal batch 归并、Activation admission、revision/lease fence，以及“Activation outcome + Thread 终态 + Delivery Event”原子且幂等提交；SQLite/PostgreSQL 已通过同一套并发 claim、陈旧 revision 冲突和精确一次 outcome 契约测试。
- PostgreSQL `ScheduleStore` 已实现 Schedule revision fence、暂停/恢复/重排/取消、反向依赖唤醒，以及“到期 occurrence + Event + Signal Outbox”原子提交；批量 `schedule_tx` 在任一目标 Thread 无效时整笔回滚，SQLite/PostgreSQL 已通过同一套并发控制和精确一次派发契约测试。
- PostgreSQL `DeliveryIngressStore` 已实现 Client Message 幂等 claim、消息 Event/Signal Outbox/Session activity/attention 自动恢复的原子入口，以及多个已完成 Thread 的单次可见交付；并发重复消息和重复交付均只有一个提交者获胜，SQLite/PostgreSQL 已通过同一套契约测试。
- PostgreSQL `DelegationStore` 已实现 Parent/Child 路由验证、子 Session 唯一委派、状态查询，以及“Delegation completed + Parent Result Event + Signal Outbox”原子提交；错误父路由会整笔回滚，并发重复结果只有一个 Worker 获胜。至此 PostgreSQL 已在类型层满足完整 `RuntimeStore` capability composition，并通过与 SQLite 相同的全部 Store 契约测试。
- `RuntimeStore` 现在显式声明 `ExclusiveProcess | SharedLeases` Worker 协调模式；SQLite 与 PostgreSQL 生产 Store 均使用 `SharedLeases`。任何新 Worker 都不得把其他 Worker 的有效 lease 误判成崩溃，只在 lease 到期后执行 revision-fenced requeue/lost reconciliation；`ExclusiveProcess` 仅保留给明确独占的内存/测试环境。
- 已在临时 PostgreSQL 15 上以两个独立 `PostgresStore` 连接池竞争同一 Context、Activation、Execution Job、Objective 和 Timer；Context CAS、所有权 claim 与 lease 均只有一个胜者，过期 Execution lease 可由另一实例恢复。
- 已在同一 PostgreSQL schema 中启动两个完整 Morphz Runtime，并向共享 Context/Session 提交一条消息；实测只发生一次模型求值、只持久化一条 `chat/reply`，证明调度 single-flight 不依赖单个 Runtime 对象的进程内状态。
- PostgreSQL schema migration 使用数据库级 advisory lock 串行化；两个 Runtime 进程可同时首次启动同一新 schema，不再因并发 DDL 产生 `tuple concurrently updated`。
- PostgreSQL schema migration 已增加持久版本表；各能力迁移在 advisory lock 内按版本执行，失败不写完成标记，重启可幂等重试；CI 已增加 PostgreSQL 16 conformance job，测试每次使用独立 schema，可在同一个测试数据库中重复或并行执行。
- SQLite 已切换为 `SharedLeases` 协调模式，并增加两个真实 OS 子进程共享同一 WAL 数据库的 Context CAS 测试；同版本写入严格只有一个成功。
- SharedLeases 启动恢复只接管已过期的 Running Activation，不再把另一进程的 queued Activation 或有效 lease 误判为本机遗留任务。
- Scheduler Snapshot 新增 Context 容量计数：事务/提交/冲突、提交延迟、Mind Projection 加载延迟、Encoding 次数及每次物化 Observation 数；Rust SDK、CLI 与 HTTP API 使用同一读模型。
- 已增加可复现的 `postgres_multi_process_probe`：父进程启动两个真实子 Runtime 进程竞争同一条消息，并额外强制终止一个持有短 Execution lease 的进程。实测 `ready_workers=2`、`model_calls=1`、`replies=1`，且到期 Job 被另一新进程安全重排。首份结果见 [PostgreSQL Multi-Process Probe — 2026-07-18](./benchmarks/postgres_multi_process_probe_2026-07-18.md)。
- Frame 级 MVCC 已实现：Runtime 从 `context_tx` 的 SExpr 操作确定性提取受影响 Frame/Relation/Observation；不同 Frame 的并发修改可在验证来源与 revision 后安全自动 rebase，同一 Frame、相同创建 ID、已变化来源或大范围生命周期操作继续冲突。
- Scheduler Kernel v2 已统一 Context 之外的调度写入边界；Objective readiness 来自结构化 Dependency，内部 Signal 与权威状态原子提交，Reconciler 不再通过历史 Event 或旧 wait 字段创造业务语义。

仍待实施：

- 面向真实公网负载的容量持续采样，以及按 Provider/Agent/Context 的进一步分层配额；
- 跨主机和生产编排环境的故障注入与容量验证；
- Frame MVCC 在复杂 Relation、Checkpoint/Rollback 与长期高冲突负载下的进一步验证。

## 1. 本文结论

Morphz 已经具备一套成立的 Context 并发语义：

- Context transaction 显式携带 `base-version`；
- Runtime 从在线 Mind Projection 读取最新状态并拒绝陈旧版本；
- Context 内的事务由进程内互斥锁串行提交；
- 每次事务形成不可变 Ledger Event，并记录事务、Diff 与前后 hash；
- Mind 可以通过 Ledger 确定性重放，退役内容仍可恢复；
- `session_working_set.max_sessions = 1` 时，每次模型求值只完整投影当前 Session，同时继续读取共享 Mind。

因此，当前实现作为单机 SQLite Agent Runtime 已经足够，并且允许同一主机上的多个 Runtime 进程共享数据库：Context CAS 防止 lost update，Activation/Job/Timer 等通过持久 lease 仲裁。SQLite WAL 仍只有一个物理写者，因此这是一种正确的多进程协调能力，不等于高吞吐分布式数据库。PostgreSQL 已完成双 Runtime、双 OS 进程和进程终止后的 lease 恢复验证；在跨主机、数据库故障切换和生产编排环境验证完成前，仍不宣称完整生产级横向扩展。

但它还不是高性能分布式服务实现。主要缺口不是 DSL 表达能力，而是：

1. SQLite WAL 仍然是单物理写者；
2. Event Writer 已能 group commit 并有首份目标硬件吞吐基线，但尚缺真实公网负载的持续尾延迟数据；
3. 多 Runtime Worker 已通过独立连接池、双完整 Runtime、双 OS 进程和进程崩溃恢复验证，尚缺跨主机与生产编排故障注入；
4. Frame 级 MVCC 已消除不相干 Frame 写入的保守冲突，但尚缺生产负载下的冲突率、自动 rebase 收益和复杂事务分布数据。

目标架构不是取消 Event Ledger，也不是让 Runtime 接管 Frame 语义，而是增加一个可验证、可重建的在线 `Mind Projection`，把高频服务路径与完整历史审计路径分开。

## 2. Phase 0 原基线的准确语义

### 2.1 原基线 Context Transaction 是什么

模型提交：

```lisp
(context-tx
  (base-version 18)
  (reason "从新证据修订当前认识")
  (revise current-plan ...)
  (derive learned-constraint (from @e42) ...)
  (retire @e17))
```

Phase 0 Runtime 执行：

```text
解析 SExpr
  ↓
取得 context_id 对应的进程内 Mutex
  ↓
读取该 Context 的相关 Ledger Events
  ↓
确定性重建当前 MindState
  ↓
比较 current.version 与 transaction.base-version
  ├─ 不相等：拒绝陈旧事务
  └─ 相等：顺序应用全部 operation
  ↓
生成 next MindState、changes 和 after_version
  ↓
在 SQLite transaction 中提交 Context Event 与 Session attention 更新
```

锁不会覆盖模型请求或工具等待，只覆盖确定性的状态提交过程。这保证了单机并发 Evaluation 不会以最后写入覆盖的方式破坏 Shared Mind。

### 2.2 它是否属于 MVCC

当前实现已经包含 MVCC/OCC 的核心要素：

- Ledger 保留多个历史版本；
- Evaluation 基于一个 Context version 读取和思考；
- 事务声明自己的 `base-version`；
- 提交时执行陈旧版本检查；
- 冲突后必须基于新版本重新决策。

因此，在 Morphz 语义层把它称为“Context 级多版本乐观并发控制”是准确的。

需要进一步区分：

| 能力 | 当前状态 |
| --- | --- |
| 单进程并发 Evaluation 读取旧快照 | 已支持 |
| 陈旧 `base-version` 拒绝 | 已支持 |
| Context 历史版本保留 | 已支持 |
| 单进程 Context 提交串行化 | 已支持 |
| 数据库行级原子 `revision CAS` | SQLite 已支持 |
| 多 Runtime Worker 共享同一 SQLite Context 提交 | 已防止 lost update；跨主机部署未验证 |
| Frame 级独立冲突检测 | 已支持：不相干 Frame 可自动 rebase；同一 Frame 与全局操作保持 fence |

Phase 0 的 Context Mutex 只存在于一个 Runtime 进程，因而无法防止两个 Worker 同时基于版本 18 提交。Phase 1 已增加持久 `context_heads` 和 SQLite transaction 内的 revision CAS：第二个提交会在数据库边界被拒绝。跨主机部署仍需要把相同 Store 契约落到 PostgreSQL 等服务型数据库，并完成 lease、故障恢复和容量验证。

### 2.3 Frame revision 与 Context version

两种版本不能混为一谈：

- `MindState.version`：一次成功 Context transaction 增加 1，保护整个事务读取的 Context Snapshot；
- `ContextFrame.revision`：对某个 Frame 执行 `revise` 时增加 1，描述该 Frame 自身的修订历史。

当前实现同时使用两层版本：全局 `MindState.version` 保留 Ledger 物理提交顺序与事务审计，`ContextFrame.revision` 则是认知修改的 MVCC 边界。事务即使携带旧 Context version，只要 Runtime 能证明它涉及的 Frame、Relation 与来源在 base-version 后没有变化，就可以安全 rebase 到当前 head；修改不同 Frame 的事务不再无条件互相冲突。

以下情况仍会拒绝并要求基于最新状态重新求值：同一 Frame 被并发 revise/retire、创建相同 Frame ID、derive/revise 所依赖的来源已变化，以及 checkpoint/rollback 等大范围状态操作。模型仍只提交高层 SExpr，不需要显式维护 read/write set 或数据库版本向量。

## 3. 当前 Mind 重放到底做什么

### 3.1 历史恢复的事件选择范围

完整重放不是读取数据库里的一张 Frame 表，也不是扫描所有 Agent 的全部数据库记录。它只在 Projection 首次迁移、损坏恢复、显式审计和 Seed 导出时按 `context_id` 查询：

- `chat/*`，但排除 `chat/context_inspect`；
- `runtime/context_seeded`；
- `context/projected_observation`。

这些事件按 Ledger sequence 排序后交给 `load_mind_from_events`。

这条路径刻意不受 Session Working Set 限制，因为它是在验证共享 Mind 的完整因果历史；它不再位于普通模型求值热路径。正常 Context Encoding 从 `mind_projections` 和 `session_projections` 读取当前态。

### 3.2 确定性恢复过程

重放从空 `MindState` 或唯一 Context Seed 开始：

```text
MindState::default()
  ↓
Context Seed（如果存在）
  ↓
transaction v0 → v1
  ↓
transaction v1 → v2
  ↓
...
  ↓
当前 MindState
```

处理 Observation 时，Runtime 当前主要记录其稳定 Event ID，用于校验 `from`、`retire`、`restore` 等引用存在；Observation 不会自动变成 Frame。

处理 Context transaction 时，Runtime会：

1. 重新解析已提交的 SExpr；
2. 在重放状态上再次执行全部 operation；
3. 检查事务 `base-version` 是否连续；
4. 比较重新计算的状态与事件记录的 `state_after`；
5. 比较重新计算的 changes 与记录的 changes；
6. 任意不一致都视为 Ledger 损坏或实现不确定。

所以重放同时承担状态恢复与完整性审计。

### 3.3 revise、retire 与 supersede 的重放结果

假设历史为：

```text
v0 create frame-a        → frame-a revision 1
v1 revise frame-a        → frame-a revision 2，body 完整替换
v2 retire frame-a        → retired 集合加入 frame-a
```

重放后的状态是：

```text
version: 3
frames:
  frame-a revision=2 body=<最新 body>
retired:
  frame-a
```

含义：

- `revise` 后，在线状态只保留最新 body，旧 body 仍存在于旧事务事件中；
- `retire` 不删除 Frame，只把 ID 放入 `retired` 集合；
- 生成 Context Encoding 时才过滤 retired Frame；
- `restore` 从 `retired` 集合移除 ID，Frame 再次进入活跃视图；
- `supersedes` 是显式关系，不自动删除、退役旧 Frame；
- 当前没有按时间自动判定 Frame “过期”的 Runtime 语义。

因此，退役减少模型可见 Context，却不会减少 Ledger 存储量和完整历史重放成本。

## 4. 海量 Session 下哪些路径可以扩展

### 4.1 语义上天然独立的路径

以下状态天然可以按 Session、Thread 或实体 ID 分区：

- 用户消息与 Agent Reply；
- Dialogue Turn；
- Thread Signal 与 Thread Activation；
- 工具调用和 Execution Job；
- Objective、Schedule、Approval；
- Session lifecycle 与所有权；
- 单 Session 的因果 Transcript。

不同 Session 的消息追加没有共享认知冲突。只要保持每个 Session 的局部顺序和稳定因果引用，就不要求全局串行求值。

### 4.2 `max_sessions = 1` 的准确效果

它保证模型的单次 Context Encoding 主要包含：

```text
Stable VM Prefix
+ Shared Mind
+ 当前 Session
+ 当前 Thread / Activation
+ 当前输入与必要工具 Transcript
```

它不会：

- 创建独立 Mind；
- 阻止不同 Session 并发读取同一 Mind；
- 删除其他 Session；
- 自动减少当前 Mind 重建时扫描的 Context Ledger 历史；
- 消除 SQLite 的单物理写者限制。

因此它解决 Prompt 认知负担和 Session 隔离，但不是持久层查询优化。

### 4.3 仍然存在的共享路径

同一个 Cognitive Context 的以下内容仍然共享：

- Mind Projection；
- Context transaction version；
- Frame/Relation lifecycle；
- Context Seed 与 Checkpoint；
- Context 级披露、保护和认知压力状态；
- 对 Observation 引用的合法性验证。

只要 Context transaction 相对 Session 对话数量足够少，共享提交可以保持低频。但系统不能只依赖这一行为假设，必须观测真实 `context_tx / dialogue_turn` 比例和冲突率。

## 5. 已消除的热路径读放大与剩余扩展瓶颈

### 5.1 在线全历史扫描（已消除）

早期实现中，正常求值和事务提交可能读取 Context 的大量相关事件，复杂度接近：

```text
O(当前 Context 历史事件总数)
```

而不是：

```text
O(当前活跃 Frame 数 + 当前 Session 事件数)
```

当前普通求值先读取一行 `mind_projections`，再按有界 Working Set 查询 `session_projections`。复杂度现在取决于活跃 Mind 和被选中 Session 的当前有效 Observation，而不取决于整个 Context 的历史事件数。完整 Ledger 扫描只保留在迁移、恢复、审计和显式历史操作中。

### 5.2 Context 锁内重建完整 Mind（已消除）

早期 Context Mutex 覆盖事件读取、引用解析、Mind 重建和事务应用。当前锁内从在线 Mind Projection 读取状态；Context transaction 只按实际引用的 Event ID 查询 Observation，并通过数据库 revision CAS 提交。锁的成本不再随完整 Ledger 线性增长。

单 Context 串行提交能力近似：

```text
mind_commit_capacity ≈ 1 / average_context_commit_latency
```

完整重放耗时已经与在线提交能力解耦。剩余吞吐上限主要来自单 Context 的保守全局 CAS 冲突率和数据库物理写能力。

### 5.3 `state_after` 存储写放大（已消除生产默认）

早期每条 Context transaction Event 都记录完整 `state_after`。如果 Mind 逐渐增长，而事务数量也增长，存储量近似：

```text
O(transaction_count × average_mind_size)
```

当前 Projection-backed 写入只记录规范化 SExpr、Diff 与前后 hash，完整状态进入当前 Mind Projection 和周期性 Snapshot；无 Projection 的测试/旧式 Store 才保留兼容性回执。

### 5.4 Observation 引用全量准备（已消除）

当前只提取事务实际出现的引用，按稳定 Event ID 或短引用查询对应 Observation，并校验其 Ledger sequence 严格早于 transaction Event。不会为一次小事务预先遍历整个 Context。

### 5.5 SQLite 单物理写者

WAL 支持并发读和单写，但 Session Event、Signal、Activation、Execution Job 和 Context transaction 最终仍竞争一个 SQLite 写者。低并发下足够；数百到数千并发时需要批量追加、缩短事务并最终支持可替换数据库后端。

## 6. 目标在线状态模型

目标持久模型分为五层：

```text
Session Event Ledger
  每个 Session 的消息、回复、工具与局部因果事实

Session Projection
  每个 Session 当前仍激活的 Observation 行集；支持 swap in / swap out

Mind Transaction Ledger
  真正修改共享认知的 context_tx 与 Context Seed

Mind Projection
  可直接读取的当前 Frames、Relations、Lifecycle 与 Head Revision

Mind Snapshot / Audit Checkpoint
  用于快速恢复、历史验证与离线完整重放
```

### 6.1 Ledger 与 Projection 的权威关系

- Ledger 仍是不可变事实源；
- Projection 是可重建的在线物化视图；
- 正常请求读取 Projection，不重放全部 Ledger；
- Projection 更新必须与事务 Ledger 追加处于同一原子提交；
- Projection 损坏时可从 Snapshot + 后续事务重建；
- 完整历史重放转为后台审计和恢复工具，不再位于高频请求路径。

Projection 不解释 Frame body 的业务语义。Frame body 继续是 Agent 自主维护的开放 SExpr；Runtime 只物化 ID、来源、版本、生命周期、关系和原始 body。

Session Projection 同样不是第二事实源。它的物理结构是一行一个有效 Observation：

```text
session_projections
  event_id      PRIMARY KEY → events.id
  context_id
  session_id    可空，仅显式 Context-wide Observation 使用 NULL
```

它没有 `session_projection_heads`，也没有 Session Snapshot：

- 新 Observation 与 Ledger Event 在同一数据库事务中插入 Projection；
- `retire @event` 与 Mind revision CAS 在同一事务中删除该 Projection 行；
- `restore @event` 按 Ledger 中不可变 Event 恢复该 Projection 行；
- 同一个 Event 的幂等 append 不会把已经 retire 的行意外复活；
- 并发 retire/restore 的最终顺序由 Context transaction revision CAS 和 Ledger sequence 决定。

因此，即使某个 Session 的所有 Observation 都被 retire，空查询结果也明确表示其当前 Projection 为空，而不是“尚未投影”。原子提交保证不存在 Ledger 已成功但 Projection 尚未处理的合法中间状态。

### 6.2 正常 Context Encoding

目标读取路径：

```text
读取 Stable VM / Agent Identity Prefix
  + 读取当前 Mind Projection
  + 查询当前 Working Set 的 Session Projection 行
  + 查询当前 Thread、Objective、Tool Transcript
  + 编译 Context Encoding
```

其他 Session 的原始事件既不进入 Prompt，也不因为共享 Context 而被扫描。

### 6.3 目标 Context 提交协议

第一阶段使用 Context Head CAS：

```text
BEGIN

读取 context_head revision = N
校验 transaction.base-version = N
应用 SExpr 到 Mind Projection
追加 context_transaction(base=N, result=N+1)
更新 context_head WHERE revision = N
更新 frame/relation/lifecycle projection

COMMIT
```

如果 `UPDATE ... WHERE revision = N` 影响 0 行，本次提交发生冲突，必须重新读取最新 Projection 后重新决策，不能盲目替换版本号重放原事务。

概念数据结构：

```text
context_heads
  context_id, revision, projection_hash, head_event_id, updated_at

events（Mind Transaction Ledger 也是 Event 的一种）
  id, sequence, context_id, session_id, type, topic, payload

mind_projections
  context_id, revision, state_json, state_hash, updated_at

session_projections
  event_id, context_id, session_id

mind_snapshots
  id, context_id, revision, state_blob, state_hash, created_at
```

`mind_projections.state_json` 保存完整、开放的 MindState；当前实现没有把 Frame body 拆成 Runtime 固定的 `mind_frames` 业务表。这样既提供 O(当前状态) 的在线读取，也保留 Agent 自主形成 SExpr 结构的自由。这些都是可由 Ledger 重建的物理投影，不是对 Agent Mind body 的固定业务 schema。

## 7. Context revision 与 Frame 级 MVCC（已实现）

### 7.1 Context 级 CAS 是基础而不是最终冲突粒度

优点：

- 与当前 `base-version` DSL 完全一致；
- 容易验证；
- 不改变模型使用方式；
- 直接支持多个 Runtime Worker；
- 避免 lost update 和分叉的相同 result version。

缺点是不同 Frame 的并发修改也会冲突。Morphz 的多 Objective/多 Thread 实际运行已经证明这种保守冲突会产生明显的模型重求值成本，因此在保留 Context revision 作为审计顺序的同时，引入了 Frame 级冲突判定。

### 7.2 当前 Frame 级 MVCC 语义

Runtime 从 SExpr 确定性提取 read/write set：

```text
create new-frame              写 new-frame
derive new-frame from @e42    读 @e42，写 new-frame
revise frame-a                读/写 frame-a
retire frame-a                写 frame-a lifecycle
relate a supersedes b         读 a/b，写 relation(a, supersedes, b)
```

基本冲突规则：

| 并发操作 | 是否可自动共存 |
| --- | --- |
| 创建不同 Frame ID | 可以 |
| 修改不同 Frame | 可以 |
| revise 同一 Frame | 冲突 |
| revise 与 retire 同一 Frame | 冲突 |
| 创建相同 Frame ID | 冲突 |
| 添加不同 Relation | 通常可以 |
| rollback / checkpoint 大范围恢复 | 需要 Context 级排他提交 |

Frame revision 和 read/write set 由 Runtime 自动维护。模型仍然提交高层 SExpr，不需要手工书写数据库锁、分区或复杂版本向量。

全局 Context revision 仍可作为 Ledger 审计顺序存在，但不必让所有不相干 Frame 写入互相冲突。

## 8. Snapshot、重放与完整性

### 8.1 正常路径

正常在线请求只读取已经验证的 Projection 和当前 Session/Thread 数据。

### 8.2 增量恢复

Runtime 重启时：

```text
加载最近可信 Snapshot@N
  ↓
重放 N 之后的 Mind Transactions
  ↓
验证最终 hash 与 context_head
  ↓
恢复在线 Projection
```

当前实现把“Projection 与 Context Head 同时缺失”视为可重建状态：优先选择最新 Snapshot，验证 Snapshot state/revision/hash 与其 head Event，再仅查询该 Ledger sequence 之后的 `chat/context_tx_committed`，逐个验证 `before_hash`、`after_hash`、Diff 与 SExpr 确定性，最后通过数据库初始化边界安装 Projection。并发初始化者会收敛到同一已提交行。

如果只有 Projection 或 Context Head 单边缺失，或者二者 revision/hash 不一致，则视为损坏并显式报错，不会自动覆盖。显式审计同时比较：

- Genesis 全量重放结果；
- Snapshot 增量重放结果；
- 当前在线 Projection。

### 8.3 完整审计

完整 Genesis 重放保留为显式命令或后台低优先级任务，用于：

- 验证 SExpr 确定性；
- 检查 Projection 漂移；
- 发现损坏或被篡改的历史；
- 重建任意历史版本；
- 验证新 Runtime 版本与旧 Ledger 的兼容性。

### 8.4 事务记录优化

长期可将“每次保存完整 `state_after`”调整为：

```text
规范化 transaction SExpr
+ changes
+ before_hash / after_hash
+ 周期性完整 Snapshot
```

如果保留 `state_after`，应设置只在 Checkpoint、审计模式或小型单机 Profile 中启用，而不是所有生产事务默认复制完整 Mind。

### 8.5 v1 历史保留策略

v1 采取“语义 Ledger 永久保留、在线读取有界、诊断大对象先压缩”的保守策略：

- Context Seed、Mind Transaction、用户/Agent 消息、工具事实及其稳定 Event ID/sequence 不做自动删除；
- Snapshot 是加速恢复的派生物，不构成删除其之前 Ledger 的授权；
- Context Encoding 与 Snapshot 增量恢复都使用有界 SQL 查询，历史增长不再等价于每轮 Prompt 或热路径扫描增长；
- `context_inspect` 等可重建诊断对象默认只持久化 hash/尺寸等紧凑事实，避免再次出现大 Prompt 副本撑大数据库；
- 将来引入冷存储时必须保持 Event ID、原始 sequence、context/session 路由和 `find_event` 语义，并先由完整审计证明冷热两层联合重放一致。

在尚无冷存储实现和真实容量数据前，Runtime 不进行“按时间删除旧消息”或“Snapshot 后截断 Ledger”。这是一项明确的安全策略，而不是遗漏的 GC。

### 8.6 后续候选：独立 Diagnostic Store

> 2026-07-21 记录，本节是后续设计候选，不代表当前已经实现或决定立即实施。

`context_inspect` 的用途是回答“某一次物理模型请求实际看见了什么”，本质上属于诊断与可观测数据，而不是 Agent 的因果事实或认识内容。当前实现仍然为每次物理模型请求向 Ledger 写入一条 `chat/context_inspect`，但默认只持久化路由、压力、预算、Wake 和各大组件的 hash/bytes/chars/items；完整 Context Encoding、Messages、Tools、Mind 与 Inbox 只通过实时 WebSocket 提供。当前 compact 记录没有 TTL、数量上限或自动清除策略，会随 Ledger 永久保留。

需要特别区分：compact 记录不是指向其他数据库内容的可重建索引。它不能还原当时的完整 Prompt；Dashboard 断线或重启后只能展示当前 Context Encoding 作为回退，不能把它标成历史 Attempt 的精确重建。

如果长期容量和运维数据证明仍有必要治理，应优先评估独立的 `DiagnosticStore`，而不是给语义 Ledger 增加按时间删除：

- 语义 Ledger 继续保持不可变、可重放，不因诊断保留策略而截断；
- Diagnostic Store 保存精确 Inspect 或 compact Inspect，并以 Event ID、Attempt ID、Context/Session/Activation 路由和内容 hash 关联 Ledger；
- 允许配置 TTL、每 Session/Activation 最大记录数、失败与超时记录的延长保留、手动导出与清理；
- 诊断数据的缺失不得改变 Context Encoding、Projection、调度恢复或模型行为；
- Dashboard 必须明确区分“实时精确 Inspect”“历史精确 Inspect”“compact 元数据”和“当前 Context 回退”；
- 旧版完整 `context_inspect` 的删除与 SQLite `VACUUM` 只能作为显式维护操作，不自动执行。

是否引入 Diagnostic Store、默认保留期限以及是否保存历史完整 Prompt，留待真实部署容量、安全边界和诊断需求共同决定。

## 9. Session Event 高并发写入

Session Event 不存在共享认知语义冲突，但仍需要物理写入策略。

单机高并发阶段可以增加 Runtime Event Writer：

```text
大量 Session Producers
        ↓
有界 Append Queue
        ↓
1–10ms Group Commit / Batch Insert
        ↓
SQLite WAL
```

当前实现已经提供：

- `orchestrator.event_writer.queue_capacity`：有界进程内等待队列，默认 1024；
- `orchestrator.event_writer.max_batch_size`：单事务最大 Event 数，默认 64；
- `orchestrator.event_writer.flush_interval_ms`：首条写入后的聚合窗口，默认 2ms；
- 每个发布者等待自己的 durable commit 回执，队列满时等待形成背压；
- 一个 Batch 内任一 Event 冲突或 Outbox 写入失败时整批回滚；
- 普通 `subscribe_durable` 仍保持串行契约，只有声明自身拥有顺序/背压的 Runtime Event Writer 可并发进入聚合窗口。

执行资源分成两个独立池：

- `orchestrator.event_bus.max_in_flight`：进入 Activation 前的异步业务 handler 窗口，默认 10；同一订阅者对同一 Event 的在途重派会先去重；
- `orchestrator.activation_admission.max_in_flight`：完整 Activation 的运行上限，默认 16；
- `orchestrator.model_provider_max_in_flight`：模型 Provider 的物理请求上限，默认 4。

Activation 可以在工具、定时器或审批期间继续占有自己的执行身份，但只在实际请求模型时短暂取得 Provider 槽位。Scheduler Snapshot 直接报告 Provider 的排队和占用状态，界面不得再用 Activation 数量推断模型负载。

可复现基准命令：

```bash
cargo run --release -p morphz-evals \
  --bin context_scalability_benchmark -- 5000 257 64
```

2026-07-18 的 Apple M4 Pro release 基线中，5000 条 512B Event 从逐条 commit 的约 11.3k events/s 提升至 batch(64) 的约 76.8k events/s（约 6.8 倍）。该数据仅证明本地存储优化有效，不等于模型请求吞吐或公网用户容量。

必须保持：

- 每个 Session 的局部顺序；
- Event ID 幂等；
- Signal 与 Event 的原子 outbox 关系；
- 队列满时可观察的背压，不能静默丢事件；
- 模型请求期间不得持有数据库连接或写锁。

当单 SQLite Writer 的实测容量不足时，通过既有 Store trait 增加 PostgreSQL 等后端。应用层不应自行实现 Raft/Paxos；首选由成熟数据库提供事务、复制和故障恢复。

## 10. 多 Runtime Worker

多 Worker 不改变 Agent、Context、Session 和 Thread 的语义，只改变执行位置。

目标流程：

```text
Durable ThreadActivation queued
  ↓
Worker 原子 claim + lease
  ↓
读取 Context Head / Mind Projection / Session Projection
  ↓
执行 ModelAttempt 或 ExecutionJob
  ↓
提交 Outcome、Signal 或 Context Transaction
  ↓
acknowledge Activation
```

必须具备：

- Activation claim CAS 与 lease；
- Worker crash 后可恢复；
- Context transaction 数据库级 CAS；
- Outcome 幂等；
- Delivery 只发生一次；
- Provider、Agent、Context、Session 和工具维度的分层准入；
- 任何 Worker 都不拥有 Agent 身份或 Mind。

## 11. 分阶段实施路径

### Phase 0：当前单机基线

- 保留现有 Context Mutex、`base-version` 与完整重放；
- 适用于本地 Agent 和受控小规模公开测试；
- 增加指标，不急于更换数据库。

### Phase 1：SQLite Mind Projection（已完成）

- 增加 `context_heads` 与 Mind Projection；
- Context Encoding 直接读取 Projection；
- Context transaction 在同一 SQLite transaction 中更新 Ledger 与 Projection；
- 正常路径不再完整重放；
- 保留显式完整审计命令。

### Phase 2：Ledger 分流、增量恢复与按需引用验证（已完成）

- 区分 Session Events 与 Mind Transactions 的查询路径；
- 增加与 Ledger 原子维护的 `session_projections`；不引入 Projection Head、watermark 或 Session Snapshot；
- Context Encoding 只读取当前有界 Session Working Set 的有效 Projection（隔离模式下即当前 Session）；
- `@eN` 只验证事务实际引用的 Observation；
- 增加 Snapshot、hash chain 和 Snapshot + 后续事务增量恢复；
- 明确 v1 非破坏性历史保留策略，冷归档待真实容量数据驱动；
- 取消每事务完整 `state_after` 的生产默认写入。

### Phase 3：单机高并发（首个可用版本已完成）

- Session Event 有界 Event Writer 与 group commit（已完成）；
- 分层 Activation admission 与独立 Provider 配额（已完成）；
- Event Writer 与 Provider 的有界背压和排队可观察性（已完成）；
- 依据基准测试分别调整 Runtime 执行容量和模型并发，不再共用一个全局数字（已完成首个默认值，后续按部署负载调优）。

### Phase 4：数据库级 CAS 与多 Worker（首个可部署版本已完成）

- Runtime 依赖完整 `RuntimeStore` 而非具体 SQLite 类型（已完成）；
- 建立可由多个后端复用的 Context transaction conformance suite（已完成首组核心契约）；
- PostgreSQL Event/Mind/Context transaction authority（已完成并通过 PostgreSQL 15 实测）；
- PostgreSQL Timer lease 与跨 Worker `SKIP LOCKED` claim（已完成并通过 PostgreSQL 15 实测）；
- PostgreSQL Objective lifecycle/evaluation lease（已完成并通过 PostgreSQL 15 实测）；
- PostgreSQL Execution Job claim/heartbeat/recovery/terminal authority（已完成并通过 PostgreSQL 15 实测）；
- PostgreSQL Approval decision/one-use grant authority（已完成并通过 PostgreSQL 15 实测）；
- PostgreSQL Session/Scheduler 六项 capability 与完整 `RuntimeStore`（已完成）；
- 显式 `sqlite | postgres` 后端配置，SQLite 默认且绝不自动切换（已完成）；
- 独立 Store/连接池的 Context、Activation、Execution、Objective、Timer 仲裁（已完成）；
- 两个完整 Runtime 共享 PostgreSQL 的 single-flight 求值与精确一次回复（已完成）；
- Shared lease 启动恢复不抢占存活 Worker、到期后允许接管（已完成）；
- PostgreSQL migration 跨进程互斥（已完成）；
- PostgreSQL migration 持久版本记录与 CI PostgreSQL 16 conformance job（已完成代码收口）；
- 双 OS 进程 single-flight 与 Worker crash/lease 到期恢复（已完成）；
- SQLite `SharedLeases`、双 OS 进程 Context CAS 与存活 Activation lease 保护（已完成）；
- 跨主机、数据库故障切换和生产编排环境验证；
- 生产级 Runtime 横向扩展与容量调优；
- SQLite 继续作为默认单机后端。

后端选择必须是显式配置：SQLite 永远不会因为检测到 URL、环境变量或运行规模而自动切换到 PostgreSQL。默认配置等价于：

```toml
[storage]
backend = "sqlite"

[storage.sqlite]
path = "morphz.db"
max_connections = 8
```

只有明确选择 PostgreSQL 才连接服务数据库：

```toml
[storage]
backend = "postgres"

[storage.postgres]
url_env = "MORPHZ_POSTGRES_URL"
max_connections = 16
```

连接 URL 只从 `url_env` 指定的环境变量读取；不把含密码的 URL 写入普通配置、错误日志或 `storage_label`。项目级 `.morphz/morphz.toml` 不能改变 `storage.*`，避免工作区代码静默改变宿主持久层。

### Phase 5：Frame 级 MVCC（已完成）

- 从规范化 SExpr 提取受影响对象与来源依赖；
- 对不相干 Frame 修改执行 revision-fenced 自动 rebase；
- 对同一 Frame、来源变化和全局生命周期操作保持冲突拒绝；
- 增加不同 Frame 自动 rebase、同 Frame 冲突与来源变化冲突的回归测试；
- 保留 Context Head revision 作为不可变 Ledger 的全局提交顺序。

后续工作不再是“是否实现”，而是基于生产数据扩展复杂 Relation/Checkpoint 场景，并观测自动 rebase 的真实收益。

## 12. 必须观测的容量指标

当前 `SchedulerSnapshot.context_capacity` 已提供：

```text
context_transactions_total
context_commits_total
context_tx_conflicts_total
context_commit_latency_micros_total / max
mind_projection_loads_total
mind_projection_load_latency_micros_total / max
context_encodings_total
events_scanned_total
events_scanned_per_encoding_max
```

`SchedulerSnapshot` 已有的相邻容量事实还包括：

```text
provider queued / in_flight / max_in_flight / acquired_total
event_writer queue_depth / committed_events / committed_batches
event_writer failed_batches / largest_batch
activation admission queued / running / deferred
```

平均延迟、每次 Encoding 平均物化数和冲突率可以由同一个 Snapshot 中的 total/count 无歧义计算，Runtime 不重复持久化派生比率。以下指标仍应在生产遥测层补齐，而不是为了本地 Runtime 强行引入新的长期指标数据库：

```text
dialogue_turns_total 与 context_tx_per_turn_ratio
full_replay_latency
session_event_append_latency 分位数
sqlite_busy_total
ledger_bytes_by_event_type
snapshot_age_transactions
按 Provider / Agent / Context 分组的时序与分位数
```

扩容决策必须依据这些指标，而不是依据注册用户数。一个拥有十万注册用户、但每秒只有一条消息的 Agent 与一百个同时运行长任务的用户，负载完全不同。

## 13. 安全不变量

1. Session Working Set 的裁剪不能删除 Ledger；
2. retired Frame 不进入活跃 Context Encoding，但可被审计和恢复；
3. Projection 不能成为无法由 Ledger 重建的第二事实源；
4. Context transaction 必须原子应用全部 operation；
5. 冲突事务不得只替换 `base-version` 后盲目重放，必须重新基于最新状态决策；
6. 多 Worker 下不能依赖进程内 Mutex 保证共享 Context 一致性；
7. Runtime 只维护 Frame 的物理结构、来源、版本和生命周期，不解释或固定 body 业务 schema；
8. 对话和工具等待不能持有 Context 写锁；
9. 其他 Session 的原始内容不能因为共享 Context 而自动进入当前 Session 的模型投影；
10. 完整历史重放失败必须显式暴露，不得静默采用损坏 Projection。
11. Observation Ledger append 与 Session Projection 插入必须原子；retire/restore 与对应 Mind revision CAS 必须原子。
12. Session Projection 为空是一个完整当前态，不得依赖 Projection Head 才能区分“空”与“未处理”。
13. Session Projection 的 retire/restore 必须同时按 `context_id` 约束；任何 Context transaction 都不能修改另一 Context 的投影行。

## 14. 非目标

本文不要求当前阶段：

- 为单机应用立即更换 SQLite；
- 为 Context 自行实现分布式共识协议；
- 把 Frame body 结构化成 Runtime 固定业务 schema；
- 让 Runtime 判断哪些认知在语义上正确；
- 为每个 Session 复制一份 Shared Mind；
- 取消 Agent 通过 SExpr 自主维护 Context；
- 为尚未发生的海量流量提前实现全部 Phase。

本文的核心方向是：

> 保留 Agent-Owned Context 与可审计多版本 Ledger，把完整重放从在线热路径移到恢复和审计路径；用可重建 Projection 支撑读取，用数据库级 CAS 保证全局提交顺序，并以 Frame revision/read-write set 降低不相干认知修改之间的冲突。
