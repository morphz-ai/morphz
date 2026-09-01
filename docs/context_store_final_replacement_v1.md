# Morphz ContextStore 最终替换与开源门禁 v1

> 状态：实施约束，完成前不得切换开源发布基线
>
> 目标：让 ContextDB 成为 Morphz 唯一、默认、完整的认知存储实现，而不是实验特性
>
> 适用后端：SQLite、PostgreSQL

## 1. 最终决定

Morphz 开源版以 Context AST 作为 Agent 当前认知状态的唯一权威。最终 Runtime：

1. 默认启用 ContextDB，不要求 Cargo feature、Runtime permit 或隐藏配置；
2. 不在请求热路径读写 `mind_projections` / `context_heads`；
3. 不在 ContextDB 失败时静默回退到旧 Mind Projection；
4. 不以双写作为长期兼容方案；
5. 保留显式、可重复、可校验的旧数据迁移器；
6. 保留冻结的旧实现测试构建，仅用于 A/B 正确性与性能比较，不进入发布产物；
7. SQLite 与 PostgreSQL 实现同一协议，通过同一套 Conformance Suite。

开发分支允许分阶段落地，但合并为开源基线前必须删除上述运行时双轨。任何尚未完成的
后端、迁移或语义门禁都必须使构建或启动明确失败，不能用隐式降级掩盖。

## 2. 权威边界

### 2.1 ContextDB 权威内容

- 当前可见的结构化 Mind；
- Frame、Relation、retire/restore 状态、Checkpoint 和认知 mutation clock；
- Context revision、稳定 Node identity、Node revision 与完整性 hash；
- 生成模型输入所需的规范 Context View。

### 2.2 独立但需原子协调的 Runtime 数据

- Agent Trajectory 事实；
- Session Projection 与 attention；
- Recall outbox；
- 一次认知事务直接影响的其他 Runtime 控制状态。

这些数据可以继续使用规范化表。一次认知提交必须在同一个数据库事务中同时提交 Context
Mutation 和上述直接副作用，不能出现“模型看见了新认知，但 Trajectory/Session 尚未提交”
或相反的中间状态。

Thread、Activation、Execution Job、Lease 等调度状态继续由专门表维护。它们不应为了
“统一”而机械塞入 Context AST；Context View 可通过显式只读映射选择性呈现它们。

## 3. Recall 语义

Recall eligibility 由三个彼此独立的维度决定：

1. **Lifecycle**：内容是 active 还是 retired；
2. **Residency**：内容是否已经实际进入本轮模型 Context View；
3. **Visibility**：本轮 View Policy 是否允许 Agent 看见来源 Session / Principal / Tenant。

默认 Recall 搜索 `visible AND non_resident`，而不是简单搜索 `retired_only`：

- 当前完整挂载 Session 中已经编码的 active Observation 不可再次 Recall；
- 当前 Mind 中已经编码的 active Frame 不可再次 Recall；
- 仍然 active、但因 24 小时时窗、Full Session 数量上限或其他显式 Selector 而被 swap out
  的 Session，本轮并不 resident；在 Visibility 允许且相关性足够时，它的内容可以 Recall；
- retired Observation / Frame 天然不 resident，可以进入默认 Recall 候选；
- metadata-only Session 不等于内容 resident；只有实际进入模型输入的 Observation/Frame
  才进入排除集合；
- `retire` 在同一提交边界更新 lifecycle 与 Recall mutation；
- `restore` 把内容恢复为 active，但只有当它实际进入本轮 Context View 后才从默认候选排除；
- 诊断或历史浏览可以显式使用 `archive_only` / `include_resident` 等非默认 Scope。

Context build 必须生成一个确定性的 `ContextViewManifest`，至少描述完整挂载的 Session、
实际 resident 的 Event/Frame identity、View Selector 与 Visibility Scope。Recall 查询接收该
Manifest（或等价的数据库可执行谓词），在候选生成阶段排除 resident 内容，而不是检索后靠
Prompt 去重。

当前 Runtime 把产生物理模型请求的精确 Manifest 持久化到 `chat/assistant_call`，并在并行
Tool task 与崩溃恢复时重新建立同一 task-local View 边界。Manifest 损坏必须 fail closed，
不能被解释成“没有限制”；旧版本 Event 缺少该字段与字段存在但不可解析是两个不同状态。
SQLite 与 PostgreSQL 都必须在 SQL `LIMIT` 之前执行 resident identity 排除，避免已驻留的
高相关前缀耗尽候选窗口。显式按 Event/Frame ID 读取仍是精确历史操作，不受默认搜索去重
规则影响。

Manifest 同时冻结两套不能混用的物理可见性时钟：Event 使用不可变 `sequence`，Frame 使用
Mind `version`。Event sequence 只是追加身份，并不表达因果顺序。PostgreSQL 还必须冻结事务
可见性快照，因为 `BIGSERIAL` 在提交前分配：低 sequence
事务可能晚于高 sequence 事务提交，单独使用 `MAX(sequence)` 会把物理 View 之后才提交的
Event 倒灌进 Recall。SQLite 的单写者 rowid 顺序不需要额外快照令牌。模型默认搜索同时应用
数字边界、后端快照与 resident 排除；物理请求中已经明确 resident 的精确 ID 可以继续读取，
但不得因此扩大普通搜索边界。

这条规则允许被 swap out 的活跃 Session 继续参与跨会话认知，同时防止同一内容在模型输入
中出现两份。Recall 返回的是带来源和 lifecycle 的临时证据，不会因此自动把整个 Session
restore 或重新挂载。

Recall 是 Archive/Search 扩展，不是当前 Context 的事实源。关闭或重建 Recall 索引不能
改变 Agent 当前认知。

## 4. 原生 Context Mutation 协议

### 4.1 设计原则

Context Engine 在执行 `derive`、`revise`、`retire`、`restore`、`relate` 等领域操作时，
必须同时产生确定性的存储 Mutation。Store 不再接收完整 `next MindState` 后自行比较两棵
树，也不能由 SQLite/PostgreSQL 各自重新推断变化。

协议至少包含以下概念：

```text
ContextMutationPlan
  context_id
  expected_context_revision
  expected_root_hash
  next_context_revision
  operations[]

ContextNodeMutation
  InsertNode
  ReplaceNode
  DeleteSubtree
  MoveSubtree

ContextCommitCommand
  mutation_plan
  trajectory_event
  attention_updates[]
  session_projection_mutation
  recall_mutations[]
  snapshot_policy

ContextCommitReceipt
  before_revision
  after_revision
  root_hash
  changed_node_ids[]
  committed_at
```

每个操作携带足够的稳定 Node ID、authority、顺序、内容和 precondition。Context head CAS
保证整次事务的线性化；Node revision / subtree hash 允许未来实现更精细的冲突判定，但不得
弱化当前 Context revision 语义。

### 4.2 生成边界

最终路径由 Context 领域代码在应用解析后的事务时直接记录 Mutation。允许在迁移期间保留
一个后端无关的 `current -> next` Mutation compiler 作为正确性 oracle，但它只能存在一份，
不能进入两个 Store 的独立实现，也不能成为最终热路径。

现有 `ContextChange` 只描述审计摘要，不包含完整 Node body、provenance、relation identity
和 precondition，不能冒充持久化协议。

### 4.3 读取协议

`ContextStore` 至少提供：

- 一致读取当前 Context Snapshot / Head；
- 读取或生成规范模型 Context View；
- 原子提交 `ContextCommitCommand`；
- 显式 Seed；
- 完整性审计；
- 显式导入/导出。

Runtime 不依赖 SQLite 表名、PostgreSQL JSONB 形态或未来的复制实现。

## 5. 物理实现约束

### 5.1 SQLite

- 单次 Context commit 使用一个连接和一个短事务；
- Node mutation 使用批量、预编译或有界语句，不扫描/重写未触碰子树；
- WAL、busy timeout 和事务模式必须有并发/崩溃测试；
- 规范编码缓存是可重建派生数据，必须以 root hash fencing；
- 进程崩溃后只依赖持久权威状态恢复，不能依赖进程内缓存。

### 5.2 PostgreSQL

- 与 SQLite 使用同一 Rust 协议和 Conformance Suite；
- 一次 Context commit 只 acquire 一个连接；
- Mutation、Context head CAS、Trajectory Event、Session/attention 与 Recall outbox 在一个
  原子事务中提交；
- canonical commit 不允许按 Node 逐条网络往返，使用 data-modifying CTE、`UNNEST`、
  `jsonb_to_recordset` 或等价的一次批量服务端执行；
- 当前 Context 读取最多一个数据库往返，不按 Node N+1；
- 任何 SQLite-only 语义都视为协议缺陷，而不是 PostgreSQL 的例外。

### 5.3 编码缓存

模型最终需要完整 Context 字节，因此冷编码成本不能消失。性能目标通过以下方式实现：

- Node/子树规范编码可按 content/subtree hash 复用；
- 完整规范编码可作为 `(context_id, root_hash, view_selector_hash)` 的派生缓存；
- Mutation 只失效受影响祖先和相关 View；
- 缓存缺失、损坏或删除后可以完全从权威 AST 重建；
- 缓存绝不成为第二份权威 Mind。

## 6. 迁移与删除旧路径

迁移是显式运维步骤，不是永久双写：

1. 冻结目标 Context 的旧写入；
2. 读取旧 Mind Projection，规范化并导入 ContextDB；
3. 校验 state hash、规范编码、Frame/Relation/retirement 集合和 Context head；
4. 记录迁移结果与源版本；
5. 重复执行必须幂等；
6. 校验失败时保持旧数据不变并明确失败；
7. 切换后 Runtime 只读取 ContextDB；
8. 开源发布前删除运行时兼容双写和静默旧读；
9. 旧表可由独立清理命令在备份后删除，迁移器本身保留版本化输入支持。

## 7. 正确性门禁

以下门禁全部通过，才允许 ContextDB 成为开源默认：

### 7.1 Reference / Conformance

- 内存 Reference Model 与 SQLite、PostgreSQL 对同一命令序列产生完全等价的 Snapshot、
  Receipt、错误优先级与 hash；
- derive、revise、retire、restore、relate、checkpoint、seed、空事务、幂等重放、陈旧
  revision、越权、无效 Node、损坏数据全部覆盖；
- property/model-based tests 生成随机合法/非法事务序列，至少覆盖不同 Context 尺寸、Node
  顺序和 Relation 密度；
- SQLite/PostgreSQL 共用测试定义，禁止复制两套“近似相同”断言。

### 7.2 原子性与恢复

在 Context Node、head CAS、Trajectory Event、Session Projection、attention、Recall outbox
各关键写点注入失败：

- 事务必须全部可见或全部不可见；
- commit response 丢失后的同 idempotency key 重试必须收敛；
- kill/restart、SQLite WAL 恢复、PostgreSQL 连接中断后状态与 Reference Model 一致；
- 缓存清空、索引重建、Recall worker 重放不得改变当前 Context；
- 数据损坏必须 fail closed，并由 audit 精确定位，不得退回旧表掩盖。

### 7.3 并发

- 同 Context 并发提交只有符合 revision/precondition 的事务成功；
- 不同 Context 不共享逻辑锁；
- 同 Context 50 Session、共享人格大量 Session、多 Runtime 进程均保持因果和 Session
  Projection 语义；
- Principal 只是可选 View predicate，默认 Context 仍可同时看见不同 Principal 的 Session；
- Session 选择条件在数据库查询中完成，禁止全量加载后过滤。

### 7.4 全量 Runtime 回归

- 默认 SQLite 全量测试；
- PostgreSQL 全量 Store conformance 与集成测试；
- 真实 Provider 对话、Tool continuation、restart、Interrupt、Follow-up、Parallel、Schedule、
  multi-session shared Context；
- 格式、Clippy `-D warnings`、all-targets、all-features 和跨平台构建；
- 用户真实工作 Context 作为长期 Canary，发现的问题必须先固化成自动回归测试再修复。

### 7.5 历史故障回归墓碑

重构开始前维护一份可执行映射。下列不是抽样建议，而是首批必须保留的历史语义：

| 曾出现或已专门修复的风险 | 当前守卫示例 | 最终要求 |
| --- | --- | --- |
| stale transaction 覆盖并发认知 | `stale_*_rebases_*`、`stale_*_is_a_semantic_conflict` | Reference/SQLite/PostgreSQL 同错误优先级 |
| disjoint Frame/lifecycle/relation 被错误串行或丢失 | `context_engine_auto_rebases_disjoint_frame_commits`、`eight_concurrent_lifecycle_transactions_*` | 多进程后端测试仍收敛 |
| 相同请求重试重复提交 | `strict_context_commit_is_exactly_versioned_and_idempotent` | receipt 丢失与重启后也 exact replay |
| 伪造 transaction Event / 篡改 state-after 被信任 | `forged_context_transaction_event_is_not_trusted`、`tampered_state_after_*` | ContextDB authority 不以客户端 Event payload 覆盖状态 |
| Mind、Session retirement、Trajectory 分步可见 | `mind_update_and_session_retirement_commit_atomically_*`、`context_db_is_authoritative_while_trajectory_and_control_commit_atomically` | 每个写点故障注入均全有或全无 |
| restart 后 Mind、Observation retirement 或回复丢失 | `committed_mind_survives_engine_restart_*`、Runtime restart 系列 | SQLite/PostgreSQL kill/restart 都覆盖 |
| retire/restore 导致 Session Projection 重复或遗漏 | `session_projection_tracks_append_retire_restore_atomically` | active residency 与 lifecycle 分离验证 |
| Recall payload 被二次 preview、当前内容重复注入 | `event_recall_payload_is_not_previewed_a_second_time`、`model_recall_search_excludes_resident_content_without_principal_isolation` | 模型默认搜索排除精确 resident identity；显式 ID 读取仍可用 |
| active 但未进入本轮 View 的 Session 被误当成不可 Recall | `session_outside_the_fifty_session_view_remains_recallable_across_principals`、`retired_observation_is_non_resident_and_remains_recallable` | 默认语义固定为 `visible AND non_resident`，lifecycle 不冒充 residency |
| resident 排除在 SQL `LIMIT` 后执行导致空页 | `recall_indexes_long_event_suffix_and_pages_an_authoritative_time_range`、共享 RuntimeStore conformance | SQLite/PostgreSQL 均在候选生成阶段排除 |
| Tool spawn/restart 丢失生成调用时的 View 边界 | `persisted_context_view_manifest_round_trips_and_malformed_data_fails_closed` | Manifest 随 `assistant_call` 持久化；损坏明确失败，不静默扩大 Recall |
| 在线模型工具调用漏传 Manifest 后退化为无界当前查询 | `model_recall_requires_runtime_context_view_manifest` | 模型 `recall` 必须由 Runtime 注入精确 View；task-local 缺失或显式为空均 fail closed |
| 旧 `assistant_call` 恢复 Recall 时无 Manifest 而退化成当前全量搜索 | `persisted_context_view_manifest_round_trips_and_malformed_data_fails_closed` | 旧非 Recall 工具可兼容恢复；旧 Recall 计划必须从新 Evaluation 开始 |
| Event sequence 与 Frame Mind version 被当成同一时钟 | 共享 RuntimeStore Recall conformance | Event 与 Frame 在 SQL 候选阶段分别使用各自物理可见性上界 |
| PostgreSQL 低 sequence 事务晚提交后倒灌进旧 View | `postgres_context_db_is_atomic_fenced_restartable_and_directory_consistent_when_configured` | `MAX(sequence)` 与 `pg_snapshot` 同时冻结，Event/Recall 两条读取链路都验证 |
| ContextDB 目录读取正确但模型编码仍读取旧 Mind Projection | `postgres_context_db_is_atomic_fenced_restartable_and_directory_consistent_when_configured` | 冲突旧表作为 decoy，目录、直接读和模型编码都必须以 ContextDB 为准 |
| PostgreSQL 有序 ingress 拿到新 Session 行却读取旧 Thread/Event 快照 | 共享 RuntimeStore 并发 Follow-up/Interrupt conformance | 混合时间 View 无副作用回退；无竞争路径仍保持单 SQL 预算 |
| 新 schema 初始化用未限定函数名误删另一 schema 的 Runtime 快速路径 | `postgres_schema_bootstrap_never_removes_a_peer_runtime_fast_path` | 所有可执行迁移对象都绑定 `current_schema()`；修复迁移恢复已受影响数据库；临时 schema 删除不影响常驻 Runtime |
| Recall 重建改变当前 Mind | `long_stateful_context_converges_across_projection_snapshot_replay_and_recall_rebuild` | 删除整个 Recall index 后 Context hash 不变 |
| 大 Session Registry 被全量拉入内存 | `working_set_max_one_and_large_registry_do_not_expand_projection`、双后端 statement budget | SQL 内完成窗口、数量与可选谓词筛选 |
| `max_sessions=1` 错误改变共享认知能力 | 当前默认 50、ME-09 冻结配置 | 默认值、生成配置和远端 artifact 三处断言为 50 |
| Principal 被误当成默认 Context 隔离边界 | `working_set_excludes_isolated_session_unless_it_is_current` 及 directory predicate tests | Principal filter 只在调用方显式传入时生效 |
| 无 Context 身份的 Provider 运维调用伪造 `operator` Context，因 Agent 账户隔离而失败或诱发越权绕行 | `local_provider_setup_discovery_enablement_switch_probe_capacity_and_restart`、`durable_agent_binding_filters_accounts_by_context_owner` | 普通 Evaluation 只走持久 Context→Agent 授权；无身份运维调用显式走控制面；已绑定健康探测固定原授权账户 |
| 并发 Evaluation 看到不属于其因果前沿的 Observation | `activation_frontier_is_context_wide_but_preserves_causal_and_broadcast_routes` | ContextDB View Manifest 保留 activation frontier |
| active Context 损坏后静默读取旧 Projection | ContextDB corrupt/fail-closed tests | 最终无旧表可回退，损坏必须明确失败 |
| 迁移重复执行覆盖新状态 | `context_db_constructor_imports_an_existing_legacy_mind_exactly_once` | 独立迁移器在 SQLite/PostgreSQL 都幂等 |
| SQLite writer contention 造成偶发失败 | contention / independent-store CAS tests | busy、锁等待和冲突分别分类，不误报成功 |
| Seed 带入父 Session/Observation 或丢失 provenance | `mind_seed_inherits_cognition_without_parent_sessions_or_observations`、`delegation_seed_*` | Seed 使用同一 ContextStore 协议 |

表中的现有测试名称只是定位线索。最终 Conformance Suite 必须把底层存储相关断言抽为同一
测试定义，并为每个历史故障记录：复现输入、期望状态、期望错误、后端、故障注入点和性能
预算。删除或改写一个墓碑测试需要 ADR，不能因新实现“看起来不再相关”而直接移除。

## 8. 性能门禁

性能结论必须使用 release build、冻结数据集、固定硬件/区域和原始结果文件。每组至少报告
p50/p95/p99、吞吐、CPU、内存、数据库连接、语句/往返、读写字节和冲突率。

### 8.1 本机隔离基准

负载覆盖 1 MiB、2 MiB、10 MiB Context，以及 1/256/4096+ Nodes：

- 插入短 Observation；
- derive、revise、retire、restore、relate；
- 修改叶子和内部节点；
- 冷读取/编码、热读取/编码、缓存失效与重建；
- 单热 Context 50 Session；
- 大量独立 Context 并发。

硬门禁：

1. Node-local commit 的数据库读写量只与 changed Nodes 及祖先深度相关；
2. 1 MiB 到 10 MiB 的同一叶子 mutation，p95 增长不得随 Context 总字节近似线性；
3. 1 MiB canonical workload 的 commit、Context read/encode p95/p99 不得劣于冻结旧实现；
4. 10 MiB 局部 mutation 必须显著优于旧完整 JSON 重写；
5. 热编码缓存命中结果必须逐字节等于冷编码；
6. 不同 Context 增加并发时不得出现全局 Context 锁或全表扫描形成的平台期；
7. SQLite 与 PostgreSQL 均不得出现 Node N+1。

第 3 项若出现不超过 5% 且小于 1 ms 的测量噪声，只能在重复实验、置信区间和端到端
无回归同时成立时记录为等价；不能用“数据库实现更优雅”豁免性能回归。

### 8.2 云端同区基准

- Runtime 与 PostgreSQL 必须同区域部署；
- 使用 mock Provider 隔离模型延迟，再使用真实 Provider 验证用户体验；
- commit 一个连接、一个原子批量服务端执行；Context read 一个往返；
- 与旧实现做同负载 A/B，消息接收至模型调度的 p50/p95/p99 不得回归；
- 连接池饱和、数据库限流、Runtime 横向扩容、单热 Context 与多 Context 分别测试；
- 至少运行一个长时间 Canary，期间执行重启、网络中断和数据库恢复演练。

## 9. Terminal Benchmark 门禁

Terminal Benchmark 使用冻结任务清单和两套可追溯构建：

- A：冻结旧实现，只作为对照；
- B：最终 ContextDB 默认实现。

执行顺序：本地 preflight → 远端小样本 → 曾失败/高压力任务 → 完整冻结任务集。必须保存
commit、构建参数、Runtime 配置、任务清单、逐任务轨迹、评分和资源指标。

验收要求：

1. B 的总体正确率不得低于 A；
2. 所有 A-pass/B-fail 都必须重放、归因并修复，不能用总体均值掩盖确定性回归；
3. shared Context、50 Session、restart、Tool continuation 等 Morphz 核心能力单独报告；
4. 远端服务器只在本地双后端和冻结构建准备完成后开启，避免验证即将被删除的中间适配层。

## 10. 完成定义

只有同时满足以下条件，目标才算完成：

- ContextDB 是默认且唯一的 Runtime Mind Store；
- `experimental-context-db` 和 `context-db` permit 从正常使用路径移除；
- SQLite、PostgreSQL 实现相同协议并通过同一 Conformance Suite；
- 旧 Mind Projection 热路径和隐式双写已删除；
- 显式迁移器可校验、幂等、失败安全；
- 默认 Recall 为 visibility-aware、non-resident-only，并覆盖 retired archive 与被 swap out
  的 active Session；
- 全量语义、恢复、并发、性能、Terminal Benchmark、云端 A/B 和 Canary 门禁通过；
- 文档只陈述已经由可复现实验证明的能力；
- 开源用户无需知道旧架构存在，也不会因兼容层承担其复杂度和成本。
