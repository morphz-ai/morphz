# Morphz Context 事务、Mind Projection 与分布式扩展设计 v1

> 状态：Phase 1 已完成；Phase 2 核心路径已完成，历史归档策略待实现；Phase 3–4 待基准数据驱动
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
- `morphz context audit [CONTEXT_ID]` 显式执行 Genesis 全量重放并比对 Projection；
- 两个独立 ContextEngine 对同一 Context 的并发同版本写入，已由 SQLite CAS 验证为仅一个成功。

仍待实施：

- Snapshot 增量恢复与历史归档/保留策略；
- Session Event 有界写队列与 group commit；
- 面向真实负载的容量指标、基准阈值与 provider 分层配额收口；
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
2. Session Event 尚未通过有界队列做 group commit；
3. Snapshot 已落盘，但增量恢复和历史归档尚未收口；
4. 多 Runtime Worker 尚未在 PostgreSQL 等服务型数据库上完成部署验证；
5. 容量指标和基准数据尚不足以决定是否需要 Frame 级 MVCC。

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
| 数据库行级原子 `revision CAS` | 未支持 |
| 多 Runtime Worker 共享同一 Context 提交 | 未形成一致性闭环 |
| Frame 级独立冲突检测 | 未支持 |

当前的 Context Mutex 只存在于一个 Runtime 进程。两个 Worker 可以各自读取版本 18，并各自在自己的进程内通过检查。SQLite 会串行执行两次物理追加，但不会替第二个 Worker重新执行“数据库当前 Head 仍为 18”的语义判断。因此多 Worker 需要持久 Context Head 和数据库级 CAS。

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

### Phase 2：Ledger 分流与按需引用验证（核心路径已完成）

- 区分 Session Events 与 Mind Transactions 的查询路径；
- Context Encoding 只读取当前有界 Session Working Set（隔离模式下即当前 Session）；
- `@eN` 只验证事务实际引用的 Observation；
- 增加 Snapshot、hash chain 和历史归档策略；
- 取消每事务完整 `state_after` 的生产默认写入。

### Phase 3：单机高并发（待基准驱动实施）

- Session Event group commit；
- 分层 admission 与 provider 配额；
- 有界背压和排队可观察性；
- 依据基准测试调高模型并发，而不是只修改一个全局数字。

### Phase 4：数据库级 CAS 与多 Worker（SQLite CAS 已完成，服务型 Store 待实施）

- PostgreSQL 或其他支持事务 CAS 的 Store；
- Activation lease、Worker recovery 与幂等 Outcome；
- Runtime 横向扩展；
- SQLite 继续作为默认单机后端。

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
