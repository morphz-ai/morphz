# Morphz 并发 Session 事件循环与认知工作集 v1 实现设计

> 状态：v1 已实现并通过确定性回归与真实 Gemini 并发验证
> 日期：2026-07-15
> 当前目标：Agent 执行工具或长任务时仍能立即处理新消息；同一 Shared Mind 下的 Session 能并发求值，并通过有界 Session Working Set 控制 Context Encoding
> 上位架构：[`morphz_single_identity_distributed_cognition_architecture.md`](morphz_single_identity_distributed_cognition_architecture.md)
> 取代关系：本文取代 [`morphz_session_residency_context_swap_design.md`](morphz_session_residency_context_swap_design.md) 中“只依赖持久 `resident/swapped_out`、Runtime 不按时间窗口自动投影”的 v1 假设；旧文保留为讨论历史

## 1. 实现目标

本阶段优先解决传统 Agent 最直接的交互痛点：

> **Agent 干活时仍然可以正常对话。工具调用、长任务和某条 Session 的 Evaluation 不得占有整个 Agent。**

同时解决长期多 Session 带来的 Context 膨胀：

> **每次 Context Encoding 只自动包含时间窗口内最近活跃、且不超过数量上限的 Session；Agent 仍可主动 retire Session，新定向事件到达时 Runtime 确定性恢复。**

v1 必须同时建立以下语义：

1. 工具调用与新用户消息可以并发；
2. 不同 Session 可以并发求值；
3. 同一 Session 的新消息不必等待旧工具结果；
4. Ledger 保留真实事件顺序和因果关系；
5. Tool Result 只恢复原 continuation，不能混入其他 Turn；
6. Shared Mind 继续被所有挂载 Session 共享；
7. 本轮可见的 Session 集由时间窗口、最大数量和 Token Budget 共同约束；
8. Agent 可以在 Context 压力下原子地提炼经验并 retire Session；
9. retired Session 收到需要处理的新事件时由 Runtime 自动 restore；
10. 所有排除都只是注意力或投影变化，不删除 Session、Ledger 或 Shared Mind。

## 2. 实现前审计与解除结果

### 2.1 实现前已有基础

当前代码已经具备：

- Event Ledger 的全局稳定 sequence；
- `session_id/context_id` 路由；
- 每个 Session 独立的 Mutex 和 active counter；
- Context 级 `context_tx` 单写锁与 `base-version` 检查；
- 标准 Tool Call / Tool Result 身份；
- 后台任务、`wait_task` 定时唤醒、`kill_task` 和终态事件；
- Objective continuation；
- 多 Session 独立求值和实验性 merged evaluation；
- Shared Mind、Frame revision、Mind Seed 与 Session Projection 基础。

### 2.2 已解除的阻塞点

#### 同一 Session 被整个 Attempt 锁住（已解除）

旧实现的 `process_routed_event` 在持有 Session Mutex 时调用完整 `run_attempt`。当前普通求值已删除该跨 Attempt 锁，改为持久 Work Item claim/lease/CAS；Context 写仍只在事务提交阶段短暂串行化。

#### 因果 Transcript 仍以 Session/Turn 聚合（已解除）

Transcript 现在按 `root_turn_id`、`trigger_event_id` 与 Tool Call identity 重建；旧 Work Item 对当前 Session 还使用根事件 sequence 作为因果可见前沿，避免更晚的并发消息倒灌。

#### Context Encoding 包含整个 Context 的 Observation（已解除）

Observation 已按 Full Projection Session 集过滤；数量和时间选择后仍超出 Token Budget 时，最旧的非当前 Session 会退为 metadata-only。

#### Session Directory 无动态投影（已解除）

Session Directory 现在分别编码 Full/metadata-only 投影以及 window/count/token/retired 排除计数；archived Session 不作为自动认知候选。

#### 没有 Session 注意力状态（已解除）

`SessionStatus` 继续只表示 IO lifecycle；Mount 上新增独立的 `active/retired` attention state、revision、reason、timestamp 与 audit event。

## 3. 四个不能混淆的状态维度

Session 不能用一个枚举同时表达 IO、执行、注意力和投影。

| 维度 | 典型状态 | 所有者 | 作用 |
| --- | --- | --- | --- |
| IO lifecycle | `active / archived` | 用户或控制面 | 是否接受新的外部消息 |
| Execution state | `idle / evaluating / waiting-tool / waiting-approval / blocked` | Runtime | 当前有哪些物理工作 |
| Agent attention | `active / retired` | Agent；新定向 IO 可触发 Runtime restore | 是否进入自动 Working Set 候选 |
| Evaluation projection | `included / excluded-* / metadata-only` | Runtime 编译器 | 本次 Prompt 实际包含什么 |

关键区别：

- `archived` 会拒绝新消息；`retired` 不会；
- 超出一天窗口只是 `excluded-by-window`，不是 retired；
- 超出 50 个只是 `excluded-by-count`，不是 retired；
- 因 Token Budget 被移除只是本轮不投影，不改变长期状态；
- Agent retire 是持久语义决定，但新定向事件会把 Session 恢复为 active；
- Shared Mind 不随任何 Session 状态退出 Context。

## 4. 配置设计

在 `OrchestratorConfig` 中新增独立结构：

```toml
[orchestrator.session_working_set]
active_window = "24h"
max_sessions = 50
```

Rust 逻辑类型：

```rust
pub struct SessionWorkingSetConfig {
    pub active_window: HumanDuration,
    pub max_sessions: usize,
}
```

v1 规则：

1. `active_window` 必须大于 0；默认 `24h`；
2. `max_sessions` 必须大于等于 1；默认 `50`；
3. `max_sessions` 包含当前 Session；
4. `max_sessions=1` 表示只投影当前 Session 的历史；
5. 现有 `context_soft_token_limit/context_hard_token_limit` 继续作为最终物理容量边界；
6. merged evaluation 的 `max_sessions_per_evaluation` 是“一次请求处理几个 ready Session”，与 Working Set 的“可以看到几个近期 Session”不是同一个配置；
7. 配置重载后只影响后续 Encoding，不修改 Session 持久状态。

## 5. Session Working Set 选择算法

### 5.1 输入

每次编译单 Session Evaluation 时输入：

```text
context_id
current_session_id
evaluation_started_at
context_token_budget
Session Registry
Session Attention State
active Objective / Tool Task / pending input metadata
```

### 5.2 候选集

候选 Session 必须满足：

```text
same context
AND attention_state = active
AND last_activity_at >= evaluation_started_at - active_window
```

当前 Session 是例外：它必须先完成自动 restore，再无条件进入候选集，不受时间窗口限制。

### 5.3 确定性排序

排序键为：

```text
current session first
then last_activity_at DESC
then session_id ASC
```

`session_id` 作为稳定 tie-breaker，保证重启和重复编译得到相同结果。

### 5.4 数量限制

从排序结果截取前 `max_sessions` 个。当前 Session 永不被截掉。

### 5.5 Token Budget 限制

完成初始 Encoding 后，如果超过 Context 的物理可用预算：

1. 保留 Stable Protocol、Shared Mind、当前 Session 和当前 wake event；
2. 从最不活跃的非当前 Session 开始逐个移除完整 Observation 投影；
3. 重新计量，直到进入可工作预算或只剩当前 Session；
4. 被移除的 Session 仍可以 metadata-only 形式出现在运行目录；
5. 如果只剩当前 Session 仍超限，进入既有 Context Pressure 维护流程，由 Agent retire Observation、修订 Frame 或执行其他 Context 维护。

Runtime 只执行物理投影裁剪，不替 Agent 摘要或删除语义内容。

### 5.6 输出自描述

Context Kernel 新增：

```lisp
(session-working-set
  (active-window 24h)
  (max-sessions 50)
  (current session-b)
  (included-count 37)
  (excluded
    (retired 12)
    (outside-window 118)
    (over-count 0)
    (token-budget 4))
  (selection "current first; then last_activity desc; session_id tie-break"))
```

模型必须知道当前 Encoding 是一个有界工作集，不得把“没看到”推断成“Session 不存在”。

## 6. Session Activity 的定义

v1 继续使用 `sessions.last_activity_at`，但只由具有认知或控制意义的事件推进：

- User Message；
- Agent Reply / Reply Suppressed；
- Tool Call 开始；
- Tool Result 终态；
- Delegation Result；
- Objective 状态变化和有效 continuation；
- 审批结果；
- 外部定向事件。

高频 stdout chunk、心跳和重复状态查询不更新 `last_activity_at`，否则一个沉默但持续输出日志的任务会永久占据 Working Set。

所有更新时间必须由 Runtime 根据 Ledger Event 确定，模型不能伪造。

## 7. 紧凑运行目录与完整 Session 投影

Working Set 只限制完整 Session Observation，不应让运行中的工作从 Agent 视野中消失。

Context Encoding 区分：

### Full Projection

包含被选中 Session 的 active Observation、当前 wake、必要 Tool Transcript 和 Session 元数据。

### Metadata-only Projection

对于未进入 Full Projection、但存在以下状态的 Session，展示紧凑控制信息：

- pending input；
- running Tool Task；
- active Objective；
- waiting approval；
- running Delegation；
- 未投递终态结果。

示例：

```lisp
(session-directory
  (session
    (id session-b)
    (projection full)
    (state evaluating))

  (session
    (id session-old-task)
    (projection metadata-only)
    (state waiting-tool)
    (task task-17)))
```

metadata-only 不包含原始对话和工具输出正文。Agent 需要核验时使用明确的 Session recall。

## 8. Agent 主动 retire / restore Session

### 8.1 DSL

在 `context_tx` 增加：

```lisp
(retire-session SESSION-ID...)
(restore-session SESSION-ID...)
```

`retire-session` 必须有 transaction-level `reason`。`restore-session` 可以无 reason；如果恢复是为了高成本核验，仍建议记录。

Agent 可以在同一事务中先形成 Shared Mind Frame，再 retire 原始 Session：

```lisp
(context-tx
  (base-version 42)
  (reason "会话已经结束；保留可迁移经验并释放认知工作集")

  (derive deployment-experience
    (from @e120 @e135 @e148)
    (effective-strategy ...)
    (failed-approaches ...)
    (applicability ...))

  (retire-session session-a session-c))
```

Runtime 不强制必须先 derive。是否存在值得保留的经验由 Agent 决定。

### 8.2 持久化位置

Agent Attention 属于 `Context × Session Mount`，不属于全局 Session。扩展 `session_mounts`：

```text
attention_state        active | retired
attention_revision     u64
attention_reason       nullable text
attention_changed_at   timestamp
attention_event_id     nullable text
```

这样未来同一 Session 的不同 Binding Generation 或不同 Context Mount 可以拥有不同注意力状态。

### 8.3 原子提交

包含 Mind Frame 修改和 Session Attention 修改的 `context_tx` 必须作为一个逻辑事务提交：

```text
validate base Context version
validate Session Mount revisions and safety gates
compute new MindState
append context_tx Event
update session_mount attention rows
commit SQLite transaction
publish committed event
```

需要把 Event append 与 Session Store 更新收敛到统一 Unit-of-Work；不能先写 Mind Event、再单独更新 Mount，导致崩溃后只成功一半。

In-memory 实现使用同一 Context Lock 模拟相同原子边界。

### 8.4 Safety Gates

以下 Session 的 retire 必须拒绝或延迟：

- 当前存在未处理输入；
- 有 running Tool Task；
- 有 active Objective；
- 正在等待审批；
- 有未投递 Reply 或 Tool Result；
- 当前被某个 Evaluation 作为 full projection 使用；
- 当前 Session 尚未完成本轮 Reply。

v1 直接拒绝当前 Session retire，返回可行动错误；`retire-after-reply` 留到后续，避免把延迟提交引入首版。

## 9. Runtime 自动 restore

模型看不到 retired Session，因此新定向事件到达时由 Runtime 恢复。

触发类型包括：

- User Message；
- Tool Result；
- Delegation Result；
- Objective Timer / Continuation；
- Approval Result；
- 其他明确要求该 Session 求值的外部事件。

逻辑顺序：

```text
append directed event to Ledger
        ↓ caused-by
mark Session attention active
append runtime/session-restored audit event
        ↓
schedule Evaluation Work Item
```

事件、Mount 状态和 inbox claim 应在同一持久化 Unit-of-Work 内完成，确保没有“消息已写入但 Session 仍 retired”或“已 restore 但消息丢失”的半状态。

自动 restore 后，目标 Session 作为 current Session 强制进入本轮 Full Projection，不受时间和数量限制。

重复的 `client_message_id` 不得重复推进 attention revision，也不得产生多个 restore event。

## 10. Evaluation Work Item

### 10.1 为什么需要 Work Item 身份

当同一 Session 可以同时存在旧工具 continuation 和新用户消息时，`session_id` 已不足以唯一标识一次计算。v1 引入稳定 Work Item：

```text
EvaluationWorkItem
├── work_item_id
├── agent_id
├── context_id
├── session_id
├── trigger_event_id
├── trigger_sequence
├── trigger_kind
├── parent_work_item_id
├── root_turn_id
├── context_snapshot_version
├── status
├── claimed_by / lease_expires_at
└── created_at / updated_at
```

建议状态：

```text
queued | running | waiting-tool | waiting-external | completed | cancelled | failed
```

首版可以用 SQLite 表持久化，并为 `trigger_event_id` 建唯一索引，防止事件总线重复投递创建两个 Evaluation。

### 10.2 因果 Transcript

模型的标准 Tool Transcript 必须按 Work Item 因果链查询：

```text
root user event
  → model attempt
  → tool call
  → tool result
  → continuation attempt
```

不能再按“当前 Session 最近一个 Turn”笼统收集。每条 Tool Call / Tool Result 至少携带：

```text
work_item_id
root_turn_id
attempt_id
call_id
caused_by
session_id
context_id
```

Session B 的并发 Evaluation 不得看到属于旧 Work Item A 的 Tool Result 参数通道；它可以在 Context Kernel 中看到 A 正在运行的紧凑状态。

## 11. 非阻塞事件循环

### 11.1 目标时间线

```text
T1  Work Item A 调用 Tool A
T2  Tool A 进入 running；A 等待结果
T3  用户发送 Message B
T4  Runtime 为 B 创建 Work Item B
T5  B 立即读取最新 Context Snapshot 并求值
T6  B 回复或修改 Context
T7  Tool A 完成，写入 Result A
T8  Runtime 创建 Continuation A2
T9  A2 读取最新 Shared Mind、A 根回合及同根后续事件；B 的独立消息不会倒灌进 A 的 Session Inbox
T10 A2 继续、调整、取消旧计划或回复
```

Ledger 必须满足：

```text
sequence(ToolCall A) < sequence(Message B) < sequence(ToolResult A)
```

计算完成顺序不必等于事件进入顺序，但所有提交必须保留 `caused_by` 和所读取的版本。

### 11.2 锁与 Lease

删除“持有 Session Mutex 调用完整 `run_attempt`”的模式，改为：

1. 短锁或数据库事务 claim Work Item；
2. 无 Session/Context 排他锁地编译 Snapshot；
3. 无排他锁地执行 LLM 请求和工具等待；
4. Context 修改继续使用短 Context transaction lock；
5. Reply 使用 `(session_id, root_turn_id, disposition)` 唯一提交约束；
6. Work Item 状态使用 revision/CAS 更新；
7. 工具使用稳定 call ID 和执行租约。

同一个 Session 的两个 Work Item 可以并行计算，但不能静默覆盖相同的 Reply、Objective、Task 或 Mind revision。

### 11.3 Foreground Tool

首版不要求所有快速 Tool 都变成显式后台任务。Evaluation 可以 await 一个 Tool，但等待期间不得持有 Session/Context 全局锁，因此新 Work Item 仍可并行运行。

耗时命令继续使用现有 Background Task：调用后当前 Evaluation 应 `reply(suppress)` 或进入 waiting 状态，结果和 timer 以后主动唤醒。

### 11.4 新消息可以改变旧任务

如果 Message B 要求停止 Tool A：

1. Work Item B 调用 `kill_task(A)` 或更新 Objective；
2. Runtime 记录 cancel intent 和时间；
3. Tool A 尽力终止；
4. 迟到 Result A 仍写 Ledger，但标记 `late_after_cancel/superseded`；
5. 迟到结果不得自动恢复已被 B 取代的计划；
6. 是否需要再次求值由 Task/Objective 状态机决定。

## 12. Context Encoding 调整

### 12.1 编码顺序与 Prefix Cache

优先保持稳定内容在前、动态 Session 内容在后：

```text
Stable System Prompt / VM Protocol
Shared Mind
Session Working Set metadata
Selected Session Inbox
Turn-local Tool Transcript
```

Shared Mind 变化时 Prefix 仍会失效，但不能让每轮变化的 Session Directory 放在 Shared Mind 之前无谓破坏更长的稳定前缀。

### 12.2 Observation 过滤

`build_context_encoding_for_sessions` 的 Observation 选择改为：

```text
is_observation
AND not retired observation
AND not delivered through turn-local tool channel
AND event.session_id belongs to Full Projection set
AND, for the active WorkItem Session,
    (event.sequence <= root event sequence OR event.root_turn_id = current root_turn_id)
```

最后一条是因果可见边界：Shared Mind 始终读取最新已提交版本，但某个旧 Work Item 的局部 Session 证据不能凭空获得它开始后才到达、且属于另一根回合的输入。新回合仍可看到自己开始前的历史，因此并发不等于丢失 Session 连续性。

Context-wide Runtime Observation 若没有 Session，应按明确 topic allowlist 进入 Kernel，而不是因为 `session_id=None` 自动混入 Inbox。

### 12.3 Shared Mind 不过滤

Frame 和 Relation 继续从整个 Context MindState 编码，不按 Session 来源过滤。来源 Session 被 retire 或本轮 excluded 时，Frame 仍然存在；需要核验原始证据时通过稳定 source ref 和 recall 获取。

## 13. Runtime 自描述协议

Protocol 增加以下说明：

```lisp
(session-concurrency-contract
  (identity "Agent 可同时运行多个 Evaluation；Session 只是路由和局部连续性")
  (ordering "Ledger seq 表示物理写入顺序；caused-by 表示直接因果")
  (tool-wait "等待某个 Tool 不会阻塞其他 Session 或新用户消息")
  (late-result "迟到结果必须结合后续事件和最新 Mind 重新判断，不得恢复旧计划"))

(session-attention-contract
  (working-set "时间窗口、数量和 token budget 只控制本轮投影")
  (retire-session "Agent 主动移出自动认知候选；不删除 Session 或 Ledger")
  (restore-session "重新允许进入自动候选")
  (auto-restore "新定向事件到达时 Runtime 确定性恢复"))
```

## 14. API、CLI 与 TUI

### 14.1 Runtime API

需要提供只读状态：

```text
GET Context Working Set
GET Session Attention State
GET Active Evaluation Work Items
GET Session Tool Tasks / Objectives
```

Agent 修改 Attention 只通过 `context_tx`；用户或管理员的强制恢复可以走控制面 API，并产生审计 Event。

### 14.2 `ctx`

`ctx` 必须显示真实编译结果：

- 当前 Context / Session；
- Working Set 配置；
- Full Projection Session；
- metadata-only Session；
- retired、window、count、token-budget 排除数量；
- 当前 Session 的 active Work Item；
- Context revision 和实际 Token pressure。

### 14.3 TUI

Agent 工作期间输入框始终可用。TUI 应同时展示：

- 当前 Session 的对话；
- running Tool Task；
- 其他 Session 的活动数量；
- 新消息对应的新 Work Item；
- Tool Result 恢复的是哪条 continuation；
- 迟到或取消后的结果状态。

不能用一个全局 “Agent busy” 禁止输入。

## 15. 数据库迁移

### 15.1 `session_mounts`

新增：

```sql
attention_state TEXT NOT NULL DEFAULT 'active'
attention_revision INTEGER NOT NULL DEFAULT 0
attention_reason TEXT
attention_changed_at TEXT
attention_event_id TEXT
```

约束：`attention_state IN ('active', 'retired')`。

### 15.2 `evaluation_work_items`

新增持久 Work Item 表，并至少建立：

- `UNIQUE(trigger_event_id)`；
- `(session_id, status)` 索引；
- `(context_id, status)` 索引；
- lease 到期索引；
- `root_turn_id` 索引。

### 15.3 Event 字段

所有新 Agent Call、Tool Call、Tool Result 和 Reply Event 统一携带：

```text
work_item_id
root_turn_id
attempt_id
trigger_event_id
caused_by
context_snapshot_version
```

旧事件无需迁移，因为产品尚未发布；实现后测试数据库直接使用最新 Schema，不增加长期兼容分支。

## 16. 实现顺序

### Phase 0：冻结与基线

- 提交当前未提交代码和设计文档；
- 固化现有单 Session、十 Session、后台任务和 Context 压力回归；
- 增加会失败的并发时间线测试作为目标基线。

### Phase 1：Work Item 与因果 Transcript

- 增加 `evaluation_work_items`；
- 为 routed event 创建唯一 Work Item；
- Tool/Reply Event 补齐 work item 因果字段；
- 把 `turn_tool_transcript` 改为按因果链查询；
- 此阶段仍可保留 Session 串行，先证明行为不退化。

### Phase 2：非阻塞 Session 并发

- 缩短或移除跨完整 Attempt 的 Session Mutex；
- 用 Work Item lease/CAS 管理并发；
- 允许同 Session 新用户消息与旧 Tool wait 并行；
- 验证不同 Session 的 LLM 请求真正同时在飞；
- 加入迟到结果、取消和唯一 Reply Commit。

### Phase 3：Working Set Projection

- 增加配置与确定性选择器；
- Observation 按 Full Projection 集过滤；
- 增加 metadata-only 运行目录；
- Token Budget 超限时逐出最旧非当前 Session；
- 更新 Context 自描述和 `ctx`。

### Phase 4：Agent retire / Runtime restore

- 扩展 `session_mounts`；
- 增加 DSL 解析、校验和 Context Tx Unit-of-Work；
- 增加 Safety Gates；
- 新定向事件自动 restore；
- TUI 展示 attention 和 restore 原因。

### Phase 5：真实模型长程验证

- Gemini 作为主模型；
- 其他模型作为对照；
- 编码任务、后台命令和普通聊天混合运行；
- 记录响应延迟、串线、重复调用、冲突率和 Prompt 规模。

### 16.1 v1 实际落点

| 设计面 | 当前实现 |
| --- | --- |
| Work Item | SQLite 持久化、`trigger_event_id` 唯一、revision/CAS、claim lease、终态和启动恢复 |
| 崩溃边界 | `assistant_call` 先持久化为工具执行计划；重启后复用同一 call ID，已持久化 Tool Result 不重做 |
| 因果隔离 | Tool Transcript 按 root 重建；当前 Session Observation 受根事件 sequence 前沿约束 |
| 回复 | `(session_id, root_turn_id)` 唯一提交，重复事件不会产生第二次 Reply |
| 并发 | 普通 single evaluation 不再跨 LLM/Tool 持有 Session Mutex；同 Session 与跨 Session Work Item 均可并发 |
| Shared Mind | 读取最新 committed version；`context_tx` 继续 Context 级串行并检查 `base-version` |
| Working Set | `active_window + max_sessions + token budget` 确定性选择，当前 Session 强制 Full |
| Session attention | Mount 上持久化 `active/retired`；DSL 原子修改；定向事件自动 restore |
| 自描述 | Context Protocol v15 编码并发、Working Set、attention、投影与 wake 语义 |
| 可观测性 | `context status`、`session list`、TUI 顶栏/工具因果信息和两个 Context HTTP 状态接口 |

工具计划恢复提供的是 Runtime 级的稳定 identity 与“已有结果不重做”。对于任意外部系统的不可回滚副作用，跨进程崩溃后的严格 exactly-once 仍需要工具或目标系统支持幂等键；v1 不伪造这一保证。

## 17. 验收测试

### 17.1 并发与时序

1. Tool A 至少运行 2 秒，100ms 后同 Session 输入 B；B 的 Evaluation 在 Tool A 完成前开始并回复；
2. Tool A 运行时另一个 Session 输入 C；C 不等待 A；
3. Ledger 满足 `call A < message B < result A`；
4. Result A 的 `caused_by/work_item_id` 指向 A，不混入 B 的 Tool Transcript；
5. B 取消 A 后，迟到结果不能恢复旧 Objective 或产生重复 Reply；
6. 两个 Session 同时提交不相干 Context 修改时至少不会静默覆盖；全局 version 冲突可在 v1 显式重求值；
7. 同一个 routed event 重复投递只创建一个 Work Item；
8. Runtime 重启后 queued/waiting Work Item 可恢复，running 请求按 lease 规则安全重试。

### 17.2 Working Set

1. `max_sessions=1` 时，Inbox 只包含当前 Session，Shared Mind 仍完整；
2. 一天内 37 个活跃 Session、上限 50 时全部进入 Full Projection；
3. 一天内 70 个活跃 Session、上限 50 时只选择当前加最近 49 个；
4. 时间相同的 Session 使用 ID 稳定排序；
5. Token 超限时最旧非当前 Session 依次退出，当前 Session 不退出；
6. 一万个 Registry Session、只有一个近期活跃时，Prompt 大小不随总数线性增长；
7. running task 超出窗口时仍以 metadata-only 可见；
8. `ctx` 展示的 included/excluded 原因与真实 ContextView 一致。

### 17.3 retire / restore

1. Agent 在一个事务中 derive Frame 并 retire 三个 Session，全部成功或全部回滚；
2. retired Session 不进入自动 Working Set；
3. Shared Mind 中由它产生的 Frame 不消失；
4. Ledger 和 Session Registry 不删除；
5. 新用户消息只触发一次自动 restore 和一次 Work Item；
6. Tool Result、Delegation Result 和 Timer 也能确定性 restore；
7. running task、active Objective、pending input 和当前 Evaluation 阻止 retire；
8. 重启后 Attention State、reason、revision 与投影完全一致。

### 17.4 用户体验

1. TUI 在 Agent 工作时始终可输入；
2. 用户可看出哪条回复对应哪个输入，哪条 Tool Result 恢复哪个任务；
3. 等待后台任务不显示为整个 Agent 停止响应；
4. Context 压力维护不会吞掉已选择的 Tool Call，也不会重复调用未返回工具。

### 17.5 v1 验证结果

确定性回归覆盖了：同 Session 与跨 Session 并发、`call A < message B < result A`、跨根 Context Inspect 不吞 Tool wake、旧根 Context 不含新根消息、重复 routed event、Reply 唯一提交、排队/过期 lease 重启恢复、持久工具计划恢复、10,000 Session 有界投影、Token Budget 逐出、Attention 原子提交和单次自动 restore。

2026-07-15 的真实 `gemini-3-flash-agent` 测试使用一个 Session 上的两个并发根回合：

```text
seq 4   A assistant_call(exec sleep 25)
seq 6   B user_message
seq 10  B reply: B_FINAL_OK
seq 11  A tool_output: A_TOOL_DONE
seq 15  A reply: A_FINAL_OK
```

B 没有等待 A；A 的 continuation 保持 A 的 `root_turn_id`，其 Context Inspect 中 active observations 从 B 求值时的 2 条回到 A 因果视图的 1 条，证明 B 没有倒灌。此前真实测试正是因为缺少这条因果前沿而让 A 错答 B；该失败样本推动了当前实现，不能归因给模型。

## 18. 观测指标

真实测试至少记录：

- message-to-evaluation-start latency；
- message-to-first-visible-progress latency；
- 同时在飞的 Evaluation 数；
- Tool wait 期间成功处理的新消息数；
- Session 串线和 Tool Result 误归属次数；
- duplicate Work Item / duplicate Reply / duplicate physical action；
- Context transaction conflict 和重求值次数；
- included/metadata-only/excluded Session 数；
- Working Set 对 Prompt Token 的贡献；
- 自动 restore 次数和错误 restore 次数；
- Agent 主动 retire 的正确率与恢复后任务连续性。

## 19. v1 非目标

- 不实现 Raft/Paxos 或多副本 Ledger；
- 不实现 Frame 级 MVCC；v1 继续允许 Context 全局 version 冲突后重求值；
- 不实现所有 Session 一次合并求值；merged evaluation 继续默认关闭；
- 不实现 Session 内部 Observation 分页换入；
- 不让 Runtime 自动为旧 Session 生成业务摘要；
- 不实现 `pin-session`、`retire-after-reply` 或复杂优先级；
- 不把 retired 等同 archived；
- 不物理删除任何 Session 或 Ledger；
- 不声称已经支持一百万真实并发用户；v1 只验证请求大小与 Registry 总数解耦；
- 不解决 LLM 对并发事实的全部语义误判，只保证因果、版本和路由可见且正确。

## 20. v1 完成定义

只有同时满足以下条件，才能认为本阶段完成：

1. 同一 Session 的工具运行不再阻塞新用户消息求值；
2. 不同 Session 可以在同一个 Agent/Context 上真实并发调用模型；
3. Tool Result、Reply 和 Context Tx 在并发下不串线、不静默覆盖；
4. 单次 Context Encoding 只包含有界 Session Working Set；
5. `max_sessions=1` 能稳定提供共享 Mind 下的 Session 历史隔离；
6. Agent 能在压力下 retire Session，并保留 Shared Mind 与 Ledger；
7. 新定向事件能自动 restore 并继续原 Session；
8. 所有关键状态在重启后可恢复；
9. TUI 在 Agent 工作时仍允许并正确路由新输入；
10. 确定性测试和真实模型混合长程测试均通过。

上述 v1 条件已经完成。仍保留在后续阶段的是多节点一致性、Frame Working Set、外部副作用的端到端 exactly-once，以及百万级真实负载验证；它们不改变本版本已经确立的单进程并发和认知投影语义。
