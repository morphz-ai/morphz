# Morphz Context 事务、Mind Projection 与分布式扩展设计 v1

> 状态：Phase 1–3 已完成首个单机可用版本与容量基线；Phase 4 服务型 Store 正在实施
>
> 日期：2026-07-18
>
> 适用范围：共享 Mind、Context Transaction、Frame 生命周期、Session 海量并发、Event Ledger、在线状态恢复与多 Runtime Worker
>
> 上位架构：[统一人格、多路会话与分布式认知架构](./morphz_single_identity_distributed_cognition_architecture.md)
>
> 相关实现：[并发 Session 事件循环与认知工作集](./morphz_concurrent_session_working_set_v1.md)、[Scheduler Kernel 与领域命名模型](./morphz_scheduler_kernel_and_domain_model_v1.md)

## 0. 实施进度（2026-07-18）

已经落地：

- SQLite `context_heads`、`mind_projections` 与周期/检查点 `mind_snapshots`；
- Context transaction 通过数据库 revision CAS 提交，不再只依赖进程内 Mutex；
- Ledger Event、Mind Projection、Context Head 与 Session attention 在同一 SQLite transaction 中原子提交；
- Context Encoding、Frame 查询与 Mind version 读取在线 Projection；旧数据库仅在首次访问时完整重放并懒迁移；
- Context Encoding 先计算有界 Session Working Set，再只查询这些 Session 与 Context-wide Event；
- `context_tx` 只按 SExpr 实际涉及的标识查询、验证 Observation，不再扫描全 Context 来解析少量 `@eN`；
- 新事务默认记录规范化 SExpr、Diff、`before_hash` 与 `after_hash`，Projection Profile 不再复制完整 `state_after`；
- Projection 缺失时优先从最近可信 Snapshot + 后续 Mind Transactions 增量重建；Snapshot、事务 hash chain 与 Ledger 游标任一不一致都会显式失败；
- `morphz context audit [CONTEXT_ID]` 同时执行 Genesis 全量重放、Snapshot 增量重放并比对在线 Projection；
- 两个独立 ContextEngine 对同一 Context 的并发同版本写入，已由 SQLite CAS 验证为仅一个成功；
- Runtime durable Event 已进入有界 Event Writer；并发发布者在可配置微窗口内 group commit，Signal Outbox 与 Event 同事务提交；
- Event Writer 的 queue depth、累计 Event/Batch、失败 Batch 与最大 Batch 已进入统一 Scheduler Snapshot，CLI、HTTP API 与 Rust SDK 共享同一读模型。
- 已增加可复现的 `context_scalability_benchmark`，首份 release 基线见 [Context Scalability Baseline — 2026-07-18](./benchmarks/context_scalability_baseline_2026-07-18.md)。
- 完整 Activation 准入与模型 Provider 配额已经解耦：默认最多运行 16 个 Activation、同时占用 4 个模型请求槽位；等待工具、定时器或审批不会错误占用 Provider 槽位。
- Provider 的 queued、in-flight、max-in-flight 与累计取得槽位次数已进入统一 Scheduler Snapshot；CLI、HTTP API、Rust SDK 与 Dashboard 使用同一事实源。
- Runtime 持久层已从具体 `Arc<SqliteStore>` 解耦为一份完整的 `RuntimeStore` capability composition；SDK 可以显式注入后端，所有原子能力必须由同一个 Store 提供，禁止把一次因果提交拆到互不相关的数据库。
- 已建立数据库无关的 Context transaction conformance suite；SQLite 已通过并发 revision CAS、Projection/Event/Session attention 原子一致和失败 Batch 全回滚测试。未来 PostgreSQL 必须通过同一套契约后才允许进入产品配置。
- PostgreSQL Context Authority 已实现 Event Ledger/query、原子 Batch/outbox、Mind Projection/head revision CAS、Snapshot、seed provenance 和 Session attention 同事务更新；已在临时 PostgreSQL 15 实例上与 SQLite 运行同一套 Context transaction conformance suite 并通过。
- PostgreSQL 物理 Timer Store 已实现 generation fence、leased claim、retry/complete/cancel；到期领取使用 `FOR UPDATE SKIP LOCKED`，两个并发 Worker 已通过同一套无重复 claim 测试。
- PostgreSQL Objective Store 已实现生命周期 revision CAS、等待条件、求值 lease、用量记账，以及“求值 lease + continuation Event/outbox”原子提交；SQLite/PostgreSQL 已通过同版本双写只允许一个胜者和 Event 冲突整笔回滚测试。
- PostgreSQL Execution Job Store 已实现因果路由验证、revision/claim-token 双重 fence、heartbeat、requeue/cancel、不可逆终态，以及“物理终态 + tool-output Event”原子且幂等提交；并发 Worker claim 与陈旧 claim 拒绝已通过跨后端契约测试。
- PostgreSQL Approval Authority 已实现稳定请求身份、决策/取消 revision fence、不可逆审计 Event、一次性 Grant，以及“消费 Grant + claim Execution Job”跨聚合原子提交；并发消费只有一个 Worker 获胜。相同测试还发现并修复了 SQLite 在 Grant 竞争中由 deferred snapshot 升级引发的 `SQLITE_BUSY`。
- 原先过大的 `SessionStore` 已按因果职责拆分为 `SessionDirectoryStore`、`ActivationStore`、`ThreadStore`、`ScheduleStore`、`DeliveryIngressStore` 和 `DelegationStore` 六项 capability；`SessionStore` 只作为完整组合边界。这样可以逐项实现和验证 PostgreSQL 能力，但 Runtime 仍只接受完整组合，避免半套后端进入生产路径。
- PostgreSQL `SessionDirectoryStore` 已实现 Agent/Context/Session 创建与查询、原子 Agent bundle、Mind seed provenance、生命周期、activity 和 attention revision fence；SQLite/PostgreSQL 已通过同一套并发 Session 创建、路由约束、归档过滤和 attention CAS 契约测试。

仍待实施：

- 面向真实公网负载的容量持续采样，以及按 Provider/Agent/Context 的进一步分层配额；
- PostgreSQL Store 和跨进程 Worker 部署验证；
- 只有真实冲突数据证明有必要时，才评估 Frame 级 MVCC。

## 1. 本文结论

Morphz 已经具备一套成立的 Context 并发语义：

- Context transaction 显式携带 `base-version`；
- Runtime 从在线 Mind Projection 读取最新状态并拒绝陈旧版本；
- Context 内的事务由进程内互斥锁串行提交；
- 每次事务形成不可变 Ledger Event，并记录事务、Diff 与前后 hash；
- Mind 可以通过 Ledger 确定性重放，退役内容仍可恢复；
- `session_working_set.max_sessions = 1` 时，每次模型求值只完整投影当前 Session，同时继续读取共享 Mind。

因此，当前实现作为单进程、单 SQLite 数据库的本地 Agent Runtime 是足够的。数据库级 CAS 也已经消除了同一 SQLite 上多个 Runtime 实例发生 lost update 的可能，但尚未宣称完成跨主机部署能力。

但它还不是高性能分布式服务实现。主要缺口不是 DSL 表达能力，而是：

1. SQLite WAL 仍然是单物理写者；
2. Event Writer 已能 group commit 并有首份目标硬件吞吐基线，但尚缺真实公网负载的持续尾延迟数据；
3. 多 Runtime Worker 尚未在 PostgreSQL 等服务型数据库上完成部署验证；
4. 容量指标和基准数据尚不足以决定是否需要 Frame 级 MVCC。

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
| Frame 级独立冲突检测 | 未支持 |

Phase 0 的 Context Mutex 只存在于一个 Runtime 进程，因而无法防止两个 Worker 同时基于版本 18 提交。Phase 1 已增加持久 `context_heads` 和 SQLite transaction 内的 revision CAS：第二个提交会在数据库边界被拒绝。跨主机部署仍需要把相同 Store 契约落到 PostgreSQL 等服务型数据库，并完成 lease、故障恢复和容量验证。

### 2.3 Frame revision 与 Context version

两种版本不能混为一谈：

- `MindState.version`：一次成功 Context transaction 增加 1，保护整个事务读取的 Context Snapshot；
- `ContextFrame.revision`：对某个 Frame 执行 `revise` 时增加 1，描述该 Frame 自身的修订历史。

当前事务冲突依据是全局 `MindState.version`，不是 Frame revision。两个事务即使修改完全不同的 Frame，只要基于同一个旧 Context version，也不能依次无冲突提交。这是正确但保守的首版语义。

## 3. 当前 Mind 重放到底做什么

### 3.1 事件选择范围

重放不是读取数据库里的一张 Frame 表，也不是扫描所有 Agent 的全部数据库记录。当前实现按 `context_id` 查询：

- `chat/*`，但排除 `chat/context_inspect`；
- `runtime/context_seeded`；
- `context/projected_observation`。

这些事件按 Ledger sequence 排序后交给 `load_mind_from_events`。

需要特别注意：当前查询按 Context 过滤，但没有先按 Session Working Set 过滤。因此，一个 Context 下挂载大量 Session 时，即使本次 `max_sessions = 1`，Mind 重建路径仍可能遍历该 Context 下其他 Session 的历史 Observation。

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

## 5. 当前实现的扩展性瓶颈

### 5.1 在线全历史扫描

当前正常求值和事务提交可能需要读取 Context 的大量相关事件。复杂度更接近：

```text
O(当前 Context 历史事件总数)
```

而不是：

```text
O(当前活跃 Frame 数 + 当前 Session 事件数)
```

当同一 Agent 与大量用户对话时，这是最先需要消除的读放大。

### 5.2 Context 锁内重建完整 Mind

当前 Context Mutex 覆盖了事件读取、引用解析、Mind 重建和事务应用。即使最终 SQLite 写入很短，锁的持有时间也会随历史增长。

单 Context 串行提交能力近似：

```text
mind_commit_capacity ≈ 1 / average_context_commit_latency
```

如果完整重放耗时从 10ms 增长到 500ms，理论提交能力会从约 100 次/秒下降到约 2 次/秒。

### 5.3 `state_after` 存储写放大

当前每条 Context transaction Event 都记录完整 `state_after`。如果 Mind 逐渐增长，而事务数量也增长，存储量可能近似：

```text
O(transaction_count × average_mind_size)
```

它有利于逐事件完整性校验，但不适合作为海量长期运行时唯一表示。

### 5.4 Observation 引用全量准备

当前为了支持 `@eN` 短引用、来源校验和 retire/restore，会从已加载事件构建引用表与 Observation ID 集。海量 Session 下，应改为只验证本事务实际引用的 ID，而不是预先遍历整个 Context 的所有 Observation。

### 5.5 SQLite 单物理写者

WAL 支持并发读和单写，但 Session Event、Signal、Activation、Execution Job 和 Context transaction 最终仍竞争一个 SQLite 写者。低并发下足够；数百到数千并发时需要批量追加、缩短事务并最终支持可替换数据库后端。

## 6. 目标在线状态模型

目标持久模型分为四层：

```text
Session Event Ledger
  每个 Session 的消息、回复、工具与局部因果事实

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

### 6.2 正常 Context Encoding

目标读取路径：

```text
读取 Stable VM / Agent Identity Prefix
  + 读取当前 Mind Projection
  + 查询当前 Session 的 Working Set 事件
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
  context_id, revision, projection_hash, snapshot_id, updated_at

context_transactions
  id, context_id, base_revision, result_revision,
  sexpr, changes, before_hash, after_hash, actor, created_at

mind_frames
  context_id, frame_id, frame_revision, lifecycle,
  body, sources, created_context_revision, updated_context_revision

mind_relations
  context_id, subject, relation, object, created_context_revision

mind_snapshots
  id, context_id, revision, state_blob, state_hash, created_at
```

这只是物理投影结构，不是对 Agent Mind body 的固定 schema。

## 7. 从 Context 级 CAS 演进到 Frame 级 MVCC

### 7.1 Context 级 CAS 应当先实现

优点：

- 与当前 `base-version` DSL 完全一致；
- 容易验证；
- 不改变模型使用方式；
- 直接支持多个 Runtime Worker；
- 避免 lost update 和分叉的相同 result version。

缺点：不同 Frame 的并发修改也会冲突。

在真实冲突率不足以构成瓶颈前，不应提前引入复杂的自动合并。

### 7.2 Frame 级 MVCC 的候选语义

当真实数据证明 Context 全局版本导致高冲突时，再让 Runtime 从 SExpr 确定性提取 read/write set：

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

Frame revision 和 read/write set 应由 Runtime 自动维护。模型仍然提交高层 SExpr，不需要手工书写数据库锁、分区或复杂版本向量。

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
- Context Encoding 只读取当前有界 Session Working Set（隔离模式下即当前 Session）；
- `@eN` 只验证事务实际引用的 Observation；
- 增加 Snapshot、hash chain 和 Snapshot + 后续事务增量恢复；
- 明确 v1 非破坏性历史保留策略，冷归档待真实容量数据驱动；
- 取消每事务完整 `state_after` 的生产默认写入。

### Phase 3：单机高并发（首个可用版本已完成）

- Session Event 有界 Event Writer 与 group commit（已完成）；
- 分层 Activation admission 与独立 Provider 配额（已完成）；
- Event Writer 与 Provider 的有界背压和排队可观察性（已完成）；
- 依据基准测试分别调整 Runtime 执行容量和模型并发，不再共用一个全局数字（已完成首个默认值，后续按部署负载调优）。

### Phase 4：数据库级 CAS 与多 Worker（Context Authority 已落地，完整控制平面待实施）

- Runtime 依赖完整 `RuntimeStore` 而非具体 SQLite 类型（已完成）；
- 建立可由多个后端复用的 Context transaction conformance suite（已完成首组核心契约）；
- PostgreSQL Event/Mind/Context transaction authority（已完成并通过 PostgreSQL 15 实测）；
- PostgreSQL Timer lease 与跨 Worker `SKIP LOCKED` claim（已完成并通过 PostgreSQL 15 实测）；
- PostgreSQL Objective lifecycle/evaluation lease（已完成并通过 PostgreSQL 15 实测）；
- PostgreSQL Execution Job claim/heartbeat/recovery/terminal authority（已完成并通过 PostgreSQL 15 实测）；
- PostgreSQL Approval decision/one-use grant authority（已完成并通过 PostgreSQL 15 实测）；
- PostgreSQL Session/Scheduler 六项 capability 与完整 `RuntimeStore`（接口拆分和 Session Directory 已完成，其余五项进行中）；
- Activation lease、Worker recovery 与幂等 Outcome；
- Runtime 横向扩展；
- SQLite 继续作为默认单机后端。

后端选择必须是显式配置：SQLite 永远不会因为检测到 URL、环境变量或运行规模而自动切换到 PostgreSQL。产品配置最终提供 `sqlite | postgres`；默认仍为 SQLite。PostgreSQL 连接凭证只通过命名凭证源/环境变量取得，不把含密码的连接 URL 写入普通配置或 `storage_label`。在 PostgreSQL 实现尚未通过 conformance suite 前，不暴露一个表面可选、实际不完整的配置值。

### Phase 5：按数据决定是否引入 Frame 级 MVCC

只有当以下数据证明 Context 全局版本成为真实瓶颈时才实施：

- Context transaction 冲突率持续较高；
- 大部分冲突涉及不相干 Frame；
- 模型重试成本显著；
- Context Head commit 延迟无法通过 Projection 解决。

## 12. 必须观测的容量指标

```text
dialogue_turns_total
context_transactions_total
context_tx_per_turn_ratio
context_tx_conflicts_total
context_tx_conflict_rate
context_commit_latency
mind_projection_load_latency
full_replay_latency
events_scanned_per_encoding
session_event_append_latency
sqlite_busy_total
ledger_bytes_by_event_type
snapshot_age_transactions
provider_in_flight / queued
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

> 保留 Agent-Owned Context 与可审计多版本 Ledger，把完整重放从在线热路径移到恢复和审计路径；用可重建 Projection 支撑读取，用数据库级 CAS 支撑提交，再依据真实冲突数据决定是否演进到 Frame 级 MVCC。
