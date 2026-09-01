# ContextDB：面向认知 Runtime 的分布式 AST 数据库架构 v1

> 状态：Architecture Baseline / 独立项目目标架构
>
> 日期：2026-09-01
>
> 适用范围：ContextDB、Morphz Runtime、Morphz Cloud 的长期存储边界
>
> 本文是目标架构，不表示当前 Morphz Runtime 已经切换到该实现。2026-09-01 已增加默认关闭的 `experimental-context-db` SQLite 单机实验，验证 Node 级事务、OCC、authority、幂等、一致快照、局部 Merkle 更新与持久恢复；Edge、Watch、Selector、Reference Model、PostgreSQL 后端以及 Runtime 迁移仍需通过后续门禁。当前 Runtime 的 Event History、Mind Projection、Session Projection 与控制表保持不变。

## 1. 核心决策

ContextDB 是一个面向认知 Runtime 的持久化、事务化、可复制、可分片的 AST 数据库。它把一个 Agent 当前可见、可推理、可修改的结构化 Context 作为一等数据库对象。

本架构确立以下本体关系：

```text
Context AST 是当前权威状态。
Context Transaction 是修改权威状态的原生事务语言。
Context ID 是默认的一致性、隔离、路由和分片边界。
规范化 S 表达式是 Context AST 的模型可读表示。
Event Log、Recall、审计和历史版本是可选扩展，不是核心语义的前提。
```

这与 Morphz 当前实现的主要区别是：

| 维度 | 当前实现 | ContextDB 目标架构 |
| --- | --- | --- |
| 权威事实 | Event History 与多类 Runtime 关系状态 | 当前 Context AST |
| 模型 Context | 从多表和 Projection 临时组装 | ContextDB 当前状态的规范化视图 |
| Mind 修改 | Event + Mind Projection 原子提交 | AST Transaction 直接修改 Context |
| Thread | 独立权威关系表，再编码进 Context | Context AST 中的 Runtime-owned 节点 |
| Retire | 修改 Projection，原内容仍可 Recall | 从 Active Context 移除；是否归档由可选扩展决定 |
| Event Log | 核心持久化事实源 | 可选审计或历史能力 |
| 分布式复制 | 依赖外部关系数据库 | ContextDB 自身的 Shard / Raft 能力 |

ContextDB 不要求 Morphz 立即重写。首先固定语义和接口，再让独立存储实现逐步成熟，最后通过兼容层和双写验证迁移。

## 2. 目标与非目标

### 2.1 目标

ContextDB 必须支持：

1. 把完整 Context 作为可持久化、可寻址、可事务修改的一等对象；
2. 使用稳定 Node ID 表示开放、可演化的 AST；
3. 通过局部 AST 操作修改节点，而不是要求调用方读写完整文档；
4. 为长时间 LLM Evaluation 提供稳定快照、revision 与语义冲突检测；
5. 让消息、Mind Frame、Thread、Objective、Session 等对象处于同一个逻辑 Context；
6. 通过 `context_id` 实现默认数据隔离、路由、分片和横向扩展；
7. 通过复制协议和多数派提交避免单点故障；
8. 为规范化 S 表达式、子树缓存和模型 Prefix Cache 提供稳定编码；
9. 允许 Recall、Archive、Audit、Search、历史快照作为可插拔扩展；
10. 同时支持开源本地运行和云端托管部署。

### 2.2 非目标

ContextDB v1 不以以下事项为目标：

- 替代通用关系数据库的全部能力；
- 支持任意跨 Context 的强一致分布式事务；
- 把模型 Provider、文件、二进制 Artifact 或 Secret 全部塞进 Context；
- 自动决定 Frame 的业务结构和认知含义；
- 把 Recall、向量检索或长期历史设为运行 Context 的必需条件；
- 在语义尚未稳定前立即从零实现生产级 Raft、成员变更和在线 Shard 迁移；
- 要求所有物理后端采用相同的数据布局。

## 3. 设计公理

### 3.1 Context 是状态，不是历史的临时投影

给定 Context `C`，模型当前读取的认知状态由 `C` 决定。系统不应为了得到当前 Context，默认扫描全部历史消息并重新 Fold。

历史可以解释 Context 如何形成，但不决定 Context 必须通过历史重放才能在线读取。

### 3.2 AST 是语义，S 表达式是规范表示

Context 在逻辑上是一棵带稳定身份和引用边的 AST。S 表达式是它面向模型、协议和调试的规范序列化形式。物理后端可以使用 Node Arena、KV、关系行、不可变 Chunk 或其他布局，但不得改变 AST 语义。

由于 Frame source、Relation、Thread causality 等会形成跨节点引用，Context 的骨架是树，引用层允许形成有向图。物理实现不能假设所有关系都能仅靠父子嵌套表达。

### 3.3 Context Transaction 是唯一状态修改边界

所有持久 Context 修改必须通过原子事务完成。模型、Runtime、Scheduler 和管理端可以拥有不同操作权限，但不能绕过同一事务和版本边界直接修改状态。

### 3.4 Context 是默认一致性域

同一个 Context 内的成功事务具有一个可观察的提交顺序。不同 Context 默认独立，不要求共享全局 revision，也不因彼此写入而冲突。

### 3.5 历史能力与当前状态解耦

关闭 Recall、Audit 和 Historical Snapshot 后，ContextDB 仍能完整实现 Morphz 的结构化上下文核心语义。

### 3.6 Runtime 事实可以进入 Context，但写权限必须受保护

Thread、Objective、Session、Pending Input 等属于 Agent 当前认知和执行世界，可以存在于 Context AST 中。它们进入 Context 不代表模型可以伪造其全部字段。ContextDB 必须支持节点、字段或操作级 authority。

## 4. 领域模型

### 4.1 Context

Context 是一个具有稳定 ID、当前 revision、根节点和策略元数据的逻辑数据库实例：

```text
ContextMeta
  context_id
  tenant_id
  agent_id
  revision
  root_node_id
  schema_version
  canonical_hash
  created_at
  updated_at
```

`revision` 表示该 Context 的物理提交顺序。它不是所有 Node 的唯一冲突边界，Node 和语义对象还可以维护更细粒度的 mutation clock。

### 4.2 Node

每个 AST Node 至少具有：

```text
ContextNode
  context_id
  node_id
  node_kind
  owner_domain
  node_revision
  payload
  parent_id / logical_path
  order_key
  content_hash
```

要求：

- `node_id` 在 Context 生命周期内稳定；
- `revise` 不改变 Node ID；
- Node 排序必须确定，保证规范化编码和 Prefix Cache 稳定；
- Node body 保持开放，不把 Agent Mind 固化成 Runtime 业务表；
- Runtime 可以对已知控制节点建立类型化约束；
- 未知扩展节点必须可以被保留和往返编码。

### 4.3 Reference Edge

跨节点语义关系单独表示：

```text
ContextEdge
  context_id
  source_node_id
  predicate
  target_node_id
  edge_revision
```

例如：

- `derived-from`；
- `supersedes`；
- `depends-on`；
- `caused-by`；
- `parent-thread`；
- `supervised-by`。

删除或 retire 一个 Node 时，事务必须明确其引用策略：拒绝、级联删除特定边、保留不可解引用的 provenance ID，或由 Archive 扩展接管。不得由存储引擎静默猜测业务语义。

### 4.4 建议的逻辑 Context 结构

以下结构是协议示例，不是要求所有后端按嵌套文档存储：

```lisp
(context
  (protocol ...)

  (inbox
    (observation
      (id observation-42)
      (session session-a)
      (principal principal-a)
      (content ...)))

  (mind
    (frame
      (id current-plan)
      (revision 3)
      (body ...))
    (relation current-plan supersedes old-plan))

  (threads
    (thread
      (id dialogue-42)
      (kind dialogue-turn)
      (status pending)
      (root-input observation-42)))

  (objectives ...)
  (sessions ...)
  (execution-resources ...)
  (kernel ...)

  (evaluate
    (thread dialogue-42)
    (root-input observation-42)))
```

ContextDB 的持久状态、虚拟只读节点和本轮 Evaluation 节点可以共同形成一个逻辑 Context View。Provider 凭证、数据库 Lease Token、进程 PID 等不属于模型认知世界的基础设施 Secret 不得进入该视图。

### 4.5 Authority Domain

建议至少区分：

| Domain | 典型内容 | 默认写入者 |
| --- | --- | --- |
| `runtime_input` | Message、Tool Result、File Change | Runtime |
| `agent_mind` | Frame、Relation、Lifecycle | Agent 通过 Context Transaction |
| `runtime_control` | Thread status、Signal claim、Delivery state | Runtime / Scheduler |
| `agent_control` | Objective 意图、模型选择的调度请求 | Agent 通过受限操作 |
| `system_policy` | Protocol、能力边界、权限策略 | Runtime 管理面 |
| `virtual_environment` | 本轮时间、模型绑定、临时执行信息 | Runtime 只读投影 |

一个 Context 可以同时包含不同 Domain。数据库以操作权限保证边界，而不是要求每个 Domain 必须位于不同数据库。

## 5. Context 状态机

### 5.1 最小循环

```text
外部输入
  ↓ Runtime Transaction
Context C(n)
  ↓ Read Snapshot
LLM Evaluation
  ↓ Context Operations
Context C(n+1)
```

形式化表示：

```text
C(n+1) = Apply(C(n), runtime_input, model_operations)
```

如果 Evaluation 期间其他事务已经提交，模型操作通过语义冲突检测决定自动 rebase 或拒绝，不在模型请求期间持有数据库锁。

### 5.2 消息进入

消息进入不是追加应用层 Event Log，而是一次 Context Transaction：

```lisp
(context-tx
  (idempotency-key gateway-message-123)
  (insert
    (path inbox)
    (observation
      (id observation-42)
      (session session-a)
      (principal principal-a)
      (content "你好")))
  (insert
    (path threads)
    (thread
      (id dialogue-42)
      (kind dialogue-turn)
      (status pending)
      (root-input observation-42))))
```

事务成功以后，派生的 Ready Index 或 Watch 通知 Runtime 存在待求值 Thread。Runtime 崩溃重启后仍可从当前 Context 状态发现未完成工作，不依赖永久 Event Replay。

### 5.3 模型修改

模型继续使用高层语义操作：

```lisp
(context-tx
  (base-version 18)
  (reason "根据新证据修订当前计划")
  (derive learned-constraint
    (from observation-42)
    (constraint ...))
  (revise current-plan ...)
  (retire old-plan))
```

在 ContextDB 中：

- `derive` 插入具有稳定 ID 和来源边的新 Node；
- `revise` 替换目标 Node body 并增加 Node revision；
- `retire` 从 Active Context 移除 Node；
- `relate` / `unrelate` 修改 Reference Edge；
- `protect` / `unprotect` 修改受保护生命周期属性；
- Thread、Objective 与 Session 操作通过其受限 Domain 操作执行。

若未启用 Archive，retired Node 的正文可以被物理回收。若启用 Archive，扩展必须在 Active Context 移除与归档之间提供清晰的原子性或可恢复协议。

### 5.4 工具与外部副作用

外部副作用无法与远端世界形成真正的单数据库事务。ContextDB 通过 Context 内的持久 Intent 表达工作：

```lisp
(execution-intent
  (id tool-call-7)
  (thread execution-4)
  (status pending)
  (idempotency-key ...)
  (request ...))
```

Worker claim Intent，执行外部动作，再提交结果和状态。崩溃恢复允许重试；是否能避免远端动作重复依赖目标系统的 idempotency contract。ContextDB 不虚假承诺无法实现的通用 exactly-once 外部副作用。

## 6. 事务协议

### 6.1 基础接口

独立项目应首先定义后端无关协议：

```text
CreateContext(request) -> ContextReceipt
GetContext(context_id, selector?, revision?) -> ContextSnapshot
ApplyTransaction(context_id, transaction) -> TransactionReceipt
WatchContext(context_id, after_revision) -> ChangeStream
QueryIndex(index, predicate, cursor) -> QueryPage
ExportContext(context_id) -> CanonicalContext
DeleteContext(context_id, precondition) -> ContextReceipt
```

`GetContext` 默认返回当前完整 Resident Context。显式 `selector` 可以选择 Session、Thread、Principal 或 Node 范围，但不得把 Principal 过滤硬编码成所有 Context 的默认语义。同一个 Agent 可以在一个共享 Context 中观察多个 Principal 的 Session。

### 6.2 Transaction Envelope

```text
ContextTransaction
  transaction_id
  idempotency_key
  context_id
  base_revision
  actor
  authority_domain
  preconditions[]
  operations[]
  requested_at
```

每次事务返回：

```text
TransactionReceipt
  transaction_id
  context_id
  before_revision
  after_revision
  applied_operations[]
  rebased
  changed_node_ids[]
  canonical_hash
  committed_at
```

相同 `idempotency_key` 与等价请求必须返回相同逻辑结果，不能重复插入 Message、Thread 或 Tool Result。

### 6.3 操作集合

第一阶段操作应保持小而完整：

```text
InsertNode(parent, position, node)
ReplaceNode(node_id, expected_node_revision, payload)
DeleteNode(node_id, policy)
MoveNode(node_id, parent, position)
AddEdge(source, predicate, target)
RemoveEdge(source, predicate, target)
SetAttribute(node_id, field, value)
CompareAndSet(path, expected, value)
```

Morphz 的 `derive`、`revise`、`retire`、`relate` 等属于其上的领域事务语言。ContextDB 可以原生理解这些稳定语义，也可以由 Morphz Adapter 确定性编译为基础 AST 操作；两层协议必须版本化，不能依赖自由文本解释。

### 6.4 长时间 Evaluation 与 OCC

模型请求可能持续数秒甚至数分钟，不能持有 Context 锁或数据库事务。正确流程是：

```text
读取 revision N 的稳定 Snapshot
  ↓
离线执行模型和工具决策
  ↓
提交 base_revision=N 的 Context Transaction
  ↓
校验语义 read/write boundary
  ├─ 无相关变化：自动 rebase 并原子提交
  └─ 存在相关变化：精确冲突，要求重新读取或重新求值
```

保留 Morphz 当前已经验证的细粒度冲突语义：

- 不同 Frame ID 的创建或修改可以共存；
- 同一 Frame body 的并发 revise 冲突；
- 同一 lifecycle target 的变化冲突；
- 不同 Relation Edge 可以共存；
- 同一 Relation Edge 的相反操作冲突；
- 依赖来源发生变化时 derive / revise 冲突；
- Runtime-owned Thread 字段只能由获得对应 authority 的事务修改；
- rollback 等全局恢复操作要求精确 Context revision。

全局 Context revision 提供提交顺序，Node revision 与 mutation clock 提供语义冲突粒度。

### 6.5 Read Snapshot

一次 Evaluation 必须读取一个逻辑一致的 Context Snapshot。Snapshot 包含：

- Context revision；
- 选中的 AST Node 与 Edge；
- 规范化顺序；
- Snapshot hash；
- 使用的 selector / residency policy；
- 虚拟只读节点的生成版本。

Snapshot 不要求复制一份完整物理数据；它可以是 MVCC 版本、Root Pointer 或不可变 Chunk 集合。

## 7. 物理存储模型

### 7.1 Context 不是一个不可分割的大字符串

Context 可以在模型侧表现为 1 MB、2 MB 或 10 MB 的完整 S 表达式，但物理存储应支持 Node 级局部更新。推荐的概念布局：

```text
context_meta
  context_id -> revision, root_node_id, canonical_hash, shard_id

context_nodes
  (context_id, node_id) -> kind, owner, node_revision, payload, hash

context_children
  (context_id, parent_id, order_key) -> child_id

context_edges
  (context_id, source_id, predicate, target_id) -> edge_revision

derived_indexes
  rebuildable query accelerators
```

一次 `revise frame-a` 只需修改 `frame-a` 和必要的父路径 hash / 元数据，不要求客户端读取或覆盖完整 Context。

### 7.2 两种可演进实现

#### Node Arena

- Node 以稳定 ID 独立存储；
- 父子顺序单独维护；
- 实现简单，适合第一阶段；
- 局部更新成本清晰；
- 完整编码需要遍历当前树，但可以缓存子树序列化。

#### Persistent / Merkle AST

- Node 或 Chunk 不可变；
- 修改时只复制变化路径；
- Root Hash 唯一标识 Snapshot；
- 天然支持结构共享、Snapshot 和完整性校验；
- 需要垃圾回收、引用计数和更复杂的 compaction。

第一版不应为了追求理论完美立即实现完整 Merkle Store。协议必须允许后端从 Node Arena 演进，而不改变 Context Transaction 语义。

### 7.3 规范化编码

ContextDB 必须定义唯一规范编码：

- 相同 AST 与相同 View Policy 必须产生字节一致的 S 表达式；
- Node 顺序、Attribute 顺序、转义和空值规则必须版本化；
- 编码结果携带 schema / protocol version；
- 未变化子树可以复用已缓存的编码 Chunk；
- 输出可以流式传给模型 Provider，不要求先构造第二份完整字符串；
- Root / Subtree Hash 可用于完整性、缓存和差异传输。

这一能力直接服务于模型 Prefix Cache：稳定子树保持稳定字节，高频变化分支尽量位于规范布局尾部。

### 7.4 Snapshot 与内部日志

ContextDB 可以周期性生成物理 Snapshot，用于：

- 节点布局压缩；
- 副本快速恢复；
- Raft Log compaction；
- 热 Context eviction 后快速激活；
- 完整性校验。

该 Snapshot 是数据库内部恢复机制，不等同于 Agent 历史产品能力。

ContextDB 的 Raft Log 同样只是复制和恢复机制。它记录 AST Mutation Command，可以在 Snapshot 后压缩；它不等同于 Morphz 当前永久、模型可 Recall 的应用层 Event History。

## 8. 分布式复制与分片

### 8.1 Context 是逻辑分片键

默认路由函数：

```text
context_id
  ↓ hash / directory lookup
virtual_shard
  ↓ placement table
raft_group leader
```

同一 Context 的所有强一致操作路由到同一一致性域。不同 Context 可以分布在不同 Shard 和节点上并行处理。

### 8.2 不为每个 Context 创建一个 Raft Group

百万 Context 不能对应百万组 Raft 心跳和 Leader。合理实现是 Multi-Raft：

- 预先定义或动态创建 Virtual Shard；
- 一个 Raft Group 承载一组 Shard 或一个 Region；
- 每个 Shard 包含许多 Context；
- 扩容时移动 Shard / Region，而不是逐 Context 建立共识组；
- Placement Directory 维护 `context_id → shard → raft_group` 路由。

具体 Shard 数量、Region 大小和 split policy 必须通过真实负载验证，不在 v1 文档中写死。

### 8.3 复制协议

生产目标默认使用奇数副本，典型为三个副本：

```text
Client / Runtime
  ↓
Shard Leader
  ↓ append mutation command
Raft Quorum
  ↓ committed
Apply AST mutation
  ↓
Return TransactionReceipt
```

要求：

- Leader 故障后能够选举和继续服务；
- 已确认提交不得在合法故障模型下丢失；
- Follower Snapshot 安装不阻塞整个集群；
- Membership Change、Replica Placement 和 Shard Migration 有明确状态机；
- 读一致性必须显式选择：Leader linearizable、quorum read 或允许陈旧的 follower read；
- 模型 Evaluation 默认读取能够与后续 OCC 提交对应的稳定 revision。

### 8.4 单个超级热 Context

按 Context 分片能扩展大量独立 Agent，但不能自动扩展一个极热共享 Context。独立人格产品可能出现一个 Context 同时服务大量 Session，此时所有写入会集中在一个 Shard Leader。

第一阶段先测量一个 Raft Leader 对小型 AST Mutation 的真实容量。若单 Context 热点成为实际瓶颈，再引入 Context 内部一致性子域：

```text
context/{id}/shared-mind
context/{id}/sessions/{session_id}
context/{id}/threads/{thread_id}
context/{id}/objectives/{objective_id}
```

可能的语义：

- Session Inbox 可以按 Session 独立追加；
- 不同 Thread 可以独立推进；
- Shared Mind 修改保持单一语义提交顺序；
- Evaluation 通过 revision watermark / version vector 取得明确的组合 Snapshot；
- 只有真正触碰相同 Node 或语义边界的事务冲突。

Context 内部分片会显著增加 Snapshot 和冲突模型复杂度。没有基准证明单 Context 已成为瓶颈前，不作为 v1 必需能力。

### 8.5 跨 Context 协作

ContextDB 默认不提供任意跨 Context ACID。Agent 之间的协作使用显式消息、Intent、Saga 或 Federation Protocol：

```text
Context A 提交 outbound intent
  ↓ durable delivery
Context B 提交 inbound node
  ↓ acknowledgement
Context A 更新 delivery state
```

每一步可重试、可观察，并携带 idempotency key。不能用隐含分布式事务掩盖真实的跨主体协作语义。

## 9. Watch、调度与派生索引

### 9.1 Change Watch

Runtime 可以订阅：

```text
WatchContext(context_id, after_revision)
```

Watch 只承诺从某个保留窗口继续推送 Change Summary。若消费者落后于内部 Log compaction 点，服务返回 `snapshot_required`，消费者重新读取当前 Snapshot。Watch 不是永久历史 API。

### 9.2 Ready Index

Thread 是 Context AST 中的权威节点，但 Scheduler 不应扫描所有 Context。ContextDB 维护可重建索引：

```text
ready_work
  tenant_id
  context_id
  thread_id
  status
  not_before
  priority
  target_capability
```

Context Transaction 修改 Thread 时，同一数据库提交同步更新 Index 或写入可恢复的 Index Mutation。索引丢失后必须能从 Context 当前状态重建。

### 9.3 其他派生索引

可以按实际需求增加：

- Active Session Index；
- Due Timer Index；
- Objective Status Index；
- Principal / ACL Index；
- Execution Target Routing Index；
- Context Capacity / Residency Index。

这些索引是查询加速器，不得演化成与 Context AST 竞争的第二权威状态。

## 10. Active Context、冷状态与可选 Recall

### 10.1 生命周期与驻留是两个维度

ContextDB 必须区分：

- 语义生命周期：active / retired；
- 物理驻留：resident / non-resident / preview；
- 存储位置：hot / snapshot / archive。

建议行为：

| 状态 | 当前模型 View | Keyword Recall |
| --- | --- | --- |
| Active + 完整 Resident | 直接可见 | 不应返回重复内容 |
| Active + Preview | 可见 Preview | 允许按稳定 ID 分页读取正文 |
| Active + Non-resident | 不可见 | 可由可选冷索引检索 |
| Retired | 不可见 | 仅在启用 Archive / Recall 时可检索 |

Recall 查询必须排除本轮已经完整可见的 Node ID。Recall 结果引用原始 Node / Archive ID，不能把相同证据伪装成第二份独立事实。

### 10.2 不启用 Recall

最小 ContextDB 可以完全不实现 Recall：

- `retire` 将 Node 从 Active Context 删除；
- 已无引用且超过内部安全点后，正文可以物理回收；
- 当前 Context Snapshot 足以支持重启和继续运行；
- 系统不承诺恢复已删除历史。

### 10.3 启用 Recall / Archive

Archive 是独立扩展：

```text
Context retire / evict
  ↓ Archive Policy
Cold Object / Document Store
  ↓
Search Index
```

扩展必须定义：

- Active Context 移除与 Archive 写入的失败语义；
- Archive watermark；
- 搜索结果与当前可见 Node 的去重；
- restore 时的权限和 ID 规则；
- 内容保留、删除和合规策略。

### 10.4 Audit 与历史版本

Audit Log 可以记录 Transaction Envelope、Receipt、Actor 和 Diff，但不成为在线 Context 的事实源。Historical Snapshot 可以提供时间旅行或问题诊断，但关闭它们不能破坏 ContextDB 核心运行。

## 11. 内存、缓存与激活

### 11.1 热 Context

活跃 Context 可以由节点本地 Context Actor / Cache 持有：

```text
Shard Leader
  ├── Context A resident AST
  ├── Context B resident AST
  └── Context C cold root / snapshot pointer
```

消息写入流程可接近：

```text
Raft 提交局部 Mutation
  ↓
在内存 AST 应用 Delta
  ↓
更新受影响子树编码缓存
```

### 11.2 Eviction

Context 大小由模型能力和产品策略共同决定。1 MB、2 MB 或更大的 Context 均应被视为正常数据库对象。集群不能假设所有 Context 永久驻留内存，因此需要：

- 活跃度与内存预算驱动的 LRU / LFU / policy eviction；
- Snapshot / Root Pointer 恢复；
- 激活时只加载需要的 Chunk；
- 独立统计 AST 数据、编码缓存、索引和 Runtime 临时状态；
- 防止单租户或单 Context 驱逐整个节点工作集。

### 11.3 完整模型读取

LLM 最终需要消费完整 Context View，因此完整编码的字节输出成本不可消失。ContextDB 的优化目标是：

- 不为每次读取执行多表 Join 和重复业务重建；
- 不为局部更新覆盖完整 Context；
- 复用未变化子树编码；
- 流式传输规范编码；
- 让数据库成本相对于模型请求成本稳定且可预测。

## 12. 多租户、安全与权限

### 12.1 身份层次

建议身份键：

```text
tenant_id / account_id
agent_id
context_id
principal_id
session_id
thread_id
```

`principal_id` 是 Agent 交互主体，不等于云租户。Principal 过滤是显式 Context View Policy，不得作为所有 Context 的默认隔离边界。

### 12.2 隔离

- Tenant 是计费、安全和管理边界；
- Agent 是人格、策略和模型能力边界；
- Context 是默认认知状态和存储分片边界；
- Session 是 I/O、进度和回复路由边界；
- Thread 是因果执行边界。

### 12.3 权限

每次 Transaction 必须携带可认证 Actor。服务验证：

- Actor 是否可访问该 Tenant / Agent / Context；
- Operation 是否允许修改目标 Domain；
- Node / Field 是否受保护；
- Cross-Context Reference 是否符合策略；
- 管理操作是否需要额外审批；
- Export、Archive、Delete 是否满足数据治理要求。

Secret 只通过 Secret Store 和短期能力令牌引用，不将明文写入模型可见 AST。

## 13. Morphz 接入边界

### 13.1 Morphz 依赖 ContextStore 协议

Morphz 不应依赖 ContextDB 的 Raft、Node Layout 或具体 KV。它只依赖：

- 读取一致 Context Snapshot；
- 提交 Context Transaction；
- 订阅 Ready / Change；
- 查询显式 View；
- 导入、导出和完整性验证。

### 13.2 目标 Runtime 流程

```text
Gateway message
  ↓ Apply runtime_input transaction
ContextDB
  ↓ Ready Watch / Index
Runtime claims Thread
  ↓ Get Context Snapshot
Model evaluates canonical SExpr
  ↓ Apply agent/runtime transaction
ContextDB
  ↓ outbound intent
Gateway / Tool / Delivery Worker
```

### 13.3 当前实现到目标模型的映射

| 当前对象 | ContextDB 目标 |
| --- | --- |
| `events` 中的 active Observation | `inbox` Node |
| `mind_projections.state_json` | `mind` AST Subtree |
| `session_projections` | Active Context 中 Observation 的存在性 / residency |
| `threads` | `threads` AST Subtree |
| `thread_activations` / signals | Thread mailbox / activation control Node 或派生 Ready Index |
| `objectives` | `objectives` AST Subtree |
| `schedules` | Schedule Node + Due Index |
| `recall_documents` | 可选 Archive / Search Extension |
| `mind_snapshots` | ContextDB 内部 Snapshot 或可选 Historical Snapshot |
| `context_heads` | Context Meta revision / root |

映射不表示把现有每一行机械复制成 Node。迁移前必须重新判断哪些字段属于模型认知状态，哪些属于基础设施内部状态，哪些只是现有 Projection 的偶然产物。

## 14. 后端演进路线

### 14.1 Reference Model

首先实现确定性的内存 Reference Model：

- 解析规范 AST；
- 应用完整 Operation Set；
- 校验 authority 和 precondition；
- 生成规范编码、Diff、Receipt；
- 作为所有后端的 conformance oracle。

Reference Model 的正确性优先于性能。

### 14.2 单节点持久化

第二阶段实现单节点持久后端，用于验证：

- 崩溃恢复；
- Node 级局部更新；
- Snapshot；
- Watch；
- 派生索引重建；
- Hot Context 激活和 eviction。

底层可以选择成熟的嵌入式 KV / LSM / B-Tree；选择应由基准和运维约束决定，而不是在语义文档中预设。

### 14.3 Redis 语义原型

Redis 可以作为早期远程 ContextStore 原型：

```text
ctx:{context_id}:meta
ctx:{context_id}:nodes
ctx:{context_id}:children
ctx:{context_id}:edges
```

同一 Context 的 Key 使用相同路由标签，事务脚本完成：

1. 校验 base revision；
2. 应用 Node / Edge Patch；
3. 增加 Context revision；
4. 更新 Ready / Due Index；
5. 发布 Change Notification；
6. 返回 Receipt。

该阶段用于验证 API、语义和远程性能，不把普通 Redis 主从能力等同于最终 Raft 多数派提交保证。

### 14.4 分布式 ContextDB

只有在 Reference Model、单机后端和真实 Morphz 负载均稳定以后，才进入：

- Multi-Raft；
- Shard Directory；
- Replica Placement；
- Online Split / Merge / Migration；
- Snapshot Install；
- Rolling Upgrade；
- Backup / Restore；
- 多可用区故障注入。

可以先在成熟分布式 KV 上实现 Context AST 层，再决定是否自研完整 Storage Engine。ContextDB 的核心差异化首先是 Context / AST / Transaction 语义，而不是重复实现已有共识算法。

## 15. 性能模型与 Benchmark

### 15.1 架构性能目标

ContextDB 的性能约束以增长阶数和固定操作预算表达：

- 局部 Mutation 成本与变化 Node / Edge 数量相关，不与完整 Context 字节数线性绑定；
- 相同 Context 的冲突只由实际触碰的语义边界决定；
- 不同 Context 默认无数据争用；
- 完整读取成本主要是实际输出字节和选中 Node，不扫描无关历史；
- Ready Thread 查询不扫描全部 Context；
- Snapshot、Archive 和索引维护不进入模型请求同步热路径，除非明确要求强一致；
- 模型请求期间不持有存储事务或 Raft 写锁。

### 15.2 必须覆盖的基准维度

#### Context 尺寸

- 1 MB；
- 2 MB；
- 10 MB；
- 不同 Node 数量、平均 Node 尺寸和 Relation 密度。

#### Mutation

- 插入一条短 Message；
- 插入大型 Tool Result Preview；
- revise 单 Frame；
- derive + 多 Source Edge；
- retire / restore；
- 同事务修改多个不相干 Node；
- 大 Context 中修改叶子、内部节点和顺序。

#### 并发形态

- 单 Context 单 Session；
- 单 Context 50 个 Session；
- 单共享 Context 大量 Session / Thread；
- 大量 Context 各自低频写；
- 同一 Node 高冲突；
- 不同 Node 低冲突；
- 多 Runtime Worker；
- Leader failover 期间持续写入。

#### 读取

- 完整规范 S 表达式；
- Session / Thread Selector；
- 子树读取；
- 冷 Context 激活；
- Snapshot + Log Tail 恢复；
- 编码缓存命中与失效。

#### 指标

- p50 / p95 / p99 commit latency；
- transaction throughput；
- conflict / rebase rate；
- full Context encode latency；
- bytes read / written / replicated；
- changed bytes / Context bytes；
- resident memory / logical Context byte；
- failover unavailable interval；
- Snapshot install 和 recovery latency；
- Prefix Cache 稳定字节比例。

### 15.3 与当前 Morphz 对照

原型必须与当前 SQLite / PostgreSQL 路径做相同语义 A/B：

- 模型看到的规范 Context 是否等价；
- Thread、Session、Objective 并发行为是否等价；
- derive / revise / retire 结果是否等价；
- Restart、Tool continuation 和 Delivery 是否等价；
- 单消息 SQL / KV 操作数与字节数；
- Context 构建延迟；
- 同 Context 与跨 Context 吞吐；
- 故障注入后是否出现丢消息、重复交付或状态分叉。

性能提升不能以削弱语义换取。语义差异必须被显式定义为新协议，而不能藏在优化实现中。

## 16. 正确性不变量

1. 一个成功 Transaction 对 Context 只产生一个 after revision；
2. 相同 idempotency key 不产生重复逻辑写入；
3. Context Snapshot 中的所有 Node / Edge 属于同一个明确版本边界；
4. 不相关 Node 的并发修改不应因整 Context revision 而永久互斥；
5. 相关语义边界变化必须被检测，不能 blind last-write-wins；
6. 模型不能修改 Runtime-owned 字段；
7. Runtime 不能解释或改写开放 Frame body 的业务语义；
8. Retire 后 Node 不再出现在 Active Context；
9. 未启用 Archive 时，系统不承诺恢复已物理回收内容；
10. 启用 Recall 时，本轮已经完整可见的 Node 不得作为重复 Recall Evidence 返回；
11. Thread 的权威状态位于 Context，Ready Index 必须可重建；
12. Watch 丢失保留窗口时必须要求重读 Snapshot，不能假装连续；
13. 已确认的 Raft commit 在声明的故障模型内不得丢失；
14. ContextDB 内部 Log 不得被误当成 Agent 永久记忆；
15. Cross-Context 协作必须显式、幂等、可恢复；
16. Secret 不进入模型可见 Context AST；
17. 相同 AST、版本和 View Policy 必须产生确定的规范编码。

## 17. 实施阶段与门禁

### Phase 0：冻结语义

- 完成本文 Review；
- 定义 AST、Node ID、Edge、Authority、Transaction、Receipt；
- 建立协议版本策略；
- 列出当前 Morphz 行为兼容矩阵；
- 不改生产存储权威关系。

门禁：所有核心术语不存在 Event / Projection 本体歧义。

### Phase 1：Reference Model

- 内存 AST；
- 完整 Transaction Interpreter；
- 规范编码；
- OCC / semantic rebase；
- property test 和状态机 fuzz；
- Morphz 当前 `context_tx` conformance suite。

门禁：任意后端可以用同一测试向量验证。

### Phase 2：单机持久 ContextDB

- Node 级存储；
- Crash recovery；
- Snapshot；
- Watch；
- Ready Index；
- Morphz Adapter；
- 与当前后端影子读取 / 双写验证。

门禁：语义等价、性能不回退、可关闭回滚。

### Phase 3：远程原型

- Redis 或其他成熟服务后端；
- 多 Runtime Worker；
- 网络故障和重试；
- Hot Context；
- 云端独立人格作为 Customer 0 / Canary。

门禁：真实流量下无状态分叉和不可解释重复交付。

### Phase 4：分布式存储

- Shard Directory；
- Multi-Raft / 成熟分布式 KV Adapter；
- Replica、Snapshot、Failover；
- 多节点 Benchmark；
- 在线扩容和恢复演练。

门禁：达到生产可用的故障、备份、升级和可观测标准。

### Phase 5：托管 ContextDB

- Tenant / Billing / Quota；
- Managed Backup；
- Archive / Recall / Audit 产品能力；
- SLA 与容量模型；
- Morphz Cloud 默认接入。

## 18. 风险与取舍

### 18.1 自研数据库范围膨胀

共识、存储、迁移、备份、在线升级和运维均可能成为多年工程。必须优先验证 Context 原生语义是否产生实际性能和产品优势，再决定自研到底层的深度。

### 18.2 单 Context 热点

Context 级分片不能自动解决超级热共享 Context。先测量，再决定是否承担 Context 内部分片和组合 Snapshot 的复杂度。

### 18.3 派生索引再次变成权威状态

Ready、Timer、ACL、Search 等索引容易因工程便利变成第二份事实源。每个索引必须具备重建协议和一致性审计。

### 18.4 模型 View 与物理 Context 混淆

ContextDB 是模型认知状态数据库，但不是每个内部字节都必须暴露给模型。必须明确 Persistent Node、Virtual Node、Secret Reference 和 View Selector，避免既泄露基础设施状态，又重新退化成不可解释的 Prompt 拼装。

### 18.5 过早迁移 Morphz

ContextDB 在事务、恢复、并发和工具 continuation 未通过现有回归矩阵前，不能替换当前生产存储。独立演进不是允许语义真空。

## 19. 与现有文档的关系

- [Morphz Context 事务、Mind Projection 与分布式扩展设计 v1](./morphz_context_transaction_scalability_and_mind_projection_v1.md) 描述当前已实现的 Event History + Projection 架构，继续作为迁移前实现事实；本文改变的是长期目标本体。
- [Morphz Session Thread Model v1](./morphz_session_thread_model_v1.md) 与 Scheduler Kernel 文档中的 Thread 语义继续成立；本文改变其物理权威位置，不降低因果、交付和恢复要求。
- [Frame 归纳、整理期退役与可追溯召回实现设计 v1](./morphz_frame_consolidation_retirement_and_recall_v1.md) 描述当前 Recall 产品能力；在 ContextDB 中它被重新定义为可选 Archive / Recall 扩展。
- [Runtime 存储热路径开源前审计](./audits/runtime_storage_hot_path_pre_open_source_audit_2026_08_31.md) 描述当前热路径预算；ContextDB 原型必须使用相同负载进行对照。
- [ContextDB SQLite 单机实验与基准 v1](./benchmarks/contextdb_sqlite_experiment_v1.md) 记录默认关闭原型的实现边界、正确性证据与 0/1/2/10 MiB release 基准。
- [Morphz Agent-Owned Context Design](./morphz_agent_owned_context_design.md) 中 Agent 自主管理 Mind 的原则继续成立，并成为 ContextDB `agent_mind` authority 的上层语义来源。

## 20. 待决策问题

以下问题不阻塞 v1 架构成立，但必须在对应实施阶段形成 ADR：

1. ContextDB 项目的正式名称、仓库与许可证；
2. AST Wire Protocol 使用 S 表达式、二进制编码还是双格式；
3. Persistent Node 的最小固定字段；
4. Morphz 领域操作由 ContextDB 原生执行还是 Adapter 编译；
5. 单机后端选择；
6. Redis 原型的物理布局和事务脚本边界；
7. Raft 自研还是基于成熟分布式 KV；
8. Ready Index 与 Context commit 的一致性等级；
9. Archive 扩展的原子切换协议；
10. 超级热 Context 何时触发内部分片；
11. Context View Selector 是否进入数据库协议核心；
12. Open Source Runtime 与托管 ContextDB 的产品边界；
13. 现有 Event History 数据如何导入初始 Context AST；
14. 双写期间哪一侧作为迁移仲裁源；
15. ContextDB 是否独立对外成为通用认知基础设施产品。

## 21. 最终定义

ContextDB 的长期定义是：

> 一个以 Context 为默认一致性和分片边界、以稳定身份 AST 为当前权威状态、以结构化事务为原生修改方式、能够为认知 Runtime 提供规范模型视图的分布式数据库。

它与 Morphz 的关系是：

> Morphz 定义并执行认知语义；ContextDB 持久化、复制、分片并事务性维护认知状态。Morphz 是 ContextDB 的首个 Runtime 和最严格的 Conformance Workload，ContextDB 则可以成为 Morphz Cloud 的可扩展状态基础设施。
