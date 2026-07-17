# Morphz Session Thread Model v1

> 历史文档：其中长期 Dialogue Thread、Work Thread 与 Delegation Thread 的分类已经被
> [Scheduler Kernel and Domain Model v1](./morphz_scheduler_kernel_and_domain_model_v1.md)
> 取代。当前实现使用 Dialogue Lane，以及有限的 DialogueTurn / Execution /
> Objective / Delivery Thread；Delegation 是 Executor 关系。本文只保留为设计演进记录。

> 状态：Protocol v19 已实现
>
> 目标：让连续对话、工具工作和持久目标在同一个 Session 内并发而不混淆

## 1. 为什么 Session 还不够

Session 能解决不同连接之间的路由和隔离，但不能完整描述同一个 Session 内同时发生的两类活动：

- 人仍在与 Agent 连续对话；
- Agent 已经从较早的某句话派生出一条需要持续调用工具的工作链。

如果二者只有时间顺序而没有结构边界，模型会把较早工作的工具结果、当前用户消息和共享 Objective 混成一个“现在要做的事情”，表现为重复回答旧问题、催问触发旧工具、或为简单问候继续编码。

## 2. 五种 Runtime Thread

### 2.1 Dialogue Thread（对话线程）

每个 Session 有一条长期存在的 Dialogue Thread。用户消息是这条线程中的 Turn，而不是彼此独立的长期任务。

同一 Session 的初始用户 Turn 按顺序求值，避免模型同时解释多条连续消息；不同 Session 的 Dialogue Thread 仍可并行。

### 2.2 Work Thread（工作线程）

当某个 Dialogue Turn 需要物理工具时，它派生一条 Work Thread。Work Thread 以该 Turn 的 `root_turn_id` 作为稳定因果根，后续 assistant tool call、tool output 和 continuation 都沿用这个根。

Dialogue Thread 在普通文本终态产生前保持顺序。只有产生实际物理工具调用时，Runtime 才把该因果链分叉为 Work Thread 并释放 Dialogue Thread；因此物理工具运行期间，用户仍可继续对话。

`context_tx` 是 Dialogue 的伴随认知维护，而不是物理工作。单独调用 `context_tx` 时，后续 Tool Result 求值仍属于原 Dialogue Turn，必须等它产生文本或 `no_reply` 终态后，下一条普通消息才能求值。

### 2.3 Objective Thread（目标线程）

Objective 是跨多个 Evaluation、等待和 Work Thread 的持久控制结构。它只有在 Runtime 显式路由时才绑定当前求值。

普通 Dialogue Turn 可以看到 Objective 的状态，用于回答“还在执行吗”“为什么受阻”等问题，但这不等于它可以推进 Objective。`objective-binding=none` 时 Objective 是只读背景。

### 2.4 Delegation Thread（委托线程）

Delegation Thread 由 Sub Agent 执行。它拥有独立的执行路由和深度限制，完成结果返回父 Thread；是否把结果写入共享 Mind，仍由父级求值决定。

### 2.5 Delivery Thread（交付线程）

Work、Objective 或 Delegation Thread 的终态文本不会直接伪装成当前对话回复。Runtime 先把它原子写入 Completion Inbox，标记为 `delivery=pending`，再启动只负责结果编排的 Delivery Thread。

Delivery Thread 能同时看到当前 Session 中全部 `pending/deferred` 结果和并发 Thread 的最新物理状态。它只能：

- 返回普通文本，并原子覆盖本次可见的完成结果；
- 独占调用 `no_reply`，把当前 `pending` 结果明确推迟为 `deferred`。

它不能调用物理工具。这样，多个几乎同时完成的工作可以合并成一条清晰回复，也不会让同一个完成结果被两个并发求值重复交付。

## 3. Context Encoding

Context 最后追加一个 `evaluate` 表达式，作为 S-Expression VM 本轮唯一执行入口。它位于大型 Inbox 之后，避免当前责任被较长历史削弱。

Dialogue Turn：

```lisp
(evaluate
  (work-item work-42)
  (thread
    (kind dialogue)
    (id session-a)
    (turn message-42))
  (objective-binding none)
  (root-input "人呢？")
  ...)
```

物理工具 continuation：

```lisp
(evaluate
  (work-item work-43)
  (thread
    (kind work)
    (id message-31)
    (parent-dialogue session-a)
    (origin-turn message-31))
  (root-input "[tool result delivered through function transcript]")
  ...)
```

当前 Session 的 Objective 状态随 `objective-context` 一并提供：

```lisp
(objective-context
  (objective
    (id objective-7)
    (status active)
    (role background-read-only)
    (goal "完成后台任务")))
```

## 4. Runtime 持久模型

| 逻辑概念 | 当前物理表示 |
|---|---|
| Session 对话入口 | `SessionRecord` + 每 Session Dialogue Gate |
| Dialogue Turn | User Message Event ID |
| Runtime Thread | `WorkThreadRecord`，以 `root_turn_id` 保持稳定因果根 |
| Work step | `EvaluationWorkItemRecord`，以 `trigger_event_id` 唤醒对应 Thread mailbox |
| 调度意图 | `ScheduledIntentRecord` |
| 唯一终态 | `work_thread_outcomes` 唯一约束 + 同一 SQLite 事务中的 Thread 状态更新 |
| 完成结果交付 | `WorkThreadRecord.result_*` + `delivery_status` |
| Objective Thread | `ObjectiveRecord.id` |

Runtime 使用每 Session 的 Dialogue Gate 保证普通用户消息首次求值有序；物理工具调用释放 Gate 后，工具结果只回到匹配 `root_turn_id` 的 Work Thread mailbox。每个 Thread 同一时刻最多有一个模型求值在飞行，重复 wakeup 可以合并，但不能产生第二个终态。

Thread 终态与 outcome Event 在一个 SQLite 事务中提交。对于普通 Dialogue Reply，交付立即完成；对于后台工作结果，先进入 Completion Inbox，再由 Delivery Thread 决定如何通知 Session。

Runtime 重启时也按 Thread 语义恢复：

- 尚未形成物理工具计划的 Dialogue Turn 标记为 `interrupted`，不会在数小时后突然重新请求模型；
- 已经形成持久物理工具计划的 Work Thread 继续按 exactly-once 边界恢复；
- `queued` 的 Scheduled Intent 会重新装载；已原子提交但尚未进程内 dispatch 的 `chat/schedule_due` Event 会安全重投；
- Objective Thread 继续按其持久目标状态恢复。

## 5. 模型负责决策，Runtime 负责调度事实

模型通过一个结构化 Function Calling 工具 `schedule_tx` 表达调度决策：

- `enqueue`：把后续意图串行加入当前或指定 Thread；
- `spawn`：创建能与当前工作并行的独立 Work Thread；
- `after`：声明依赖，依赖 Thread 进入终态后才允许唤醒；
- `not_before` / `delay_seconds`：一次性定时；
- `every_seconds`：为 `spawn` 创建周期性调度。

一次响应只能调用一个 `schedule_tx`，不能与物理工具或 `context_tx` 混用。同一事务内可以用 `$client_id` 引用刚创建的 Thread，整个计划要么全部持久化，要么全部失败。定时器和依赖满足只产生 mailbox observation，不绕过模型直接声称任务已经完成。

## 6. 正确性不变量

1. 每个模型请求只有一个 active Thread。
2. 同一 Session 的 Dialogue Turn 首次求值保持顺序。
3. 不同 Session 的 Dialogue Thread 可以并行。
4. Work Thread 与其父 Dialogue Thread 可以并行。
5. Tool Result 只能唤醒匹配 `root_turn_id` 的 Work Thread。
6. 新用户消息不得继承旧 Work Thread 的 Function Calling transcript。
7. 未绑定 Objective 可以被观察和报告，但不得被当前 Dialogue Turn 推进。
8. 简单对话能从当前 Encoding 回答时，不得调用物理工具。
9. 未形成物理工作的 Dialogue Turn 不跨 Runtime 重启自动复活。
10. 后台 Work/Objective 输出不得结束另一条 Dialogue Turn 的等待状态。
11. 同一个 `root_turn_id` 只能提交一个终态 outcome。
12. Work Thread 的完成结果在交付前必须处于 `pending/deferred`，同一结果只能被一次 Delivery 原子覆盖。
13. `schedule_tx` 必须原子提交；依赖未终结或时间未到时不得提前投递。
14. Runtime 重启后，持久调度可以恢复，但已经 claim 的一次性 occurrence 不得重复产生。

## 7. 已有回归验证

- 同一 Session 两条快速用户消息：首次模型求值最大并发为 1；
- 同一 Session 的旧工具运行时，新消息先得到回复，工具完成后旧 Work Thread 再继续；
- 工具 continuation 的 Context 标记为 `kind work`，新用户消息标记为 `kind dialogue`；
- 不同 Session 继续共享 Context 并行求值；
- 普通 Dialogue Turn 能看到 active Objective，但编码为 `background-read-only`；
- 当前 `evaluate` 位于 Inbox 之后，且携带精确 `root-input`。
- `context_tx` 维护期间提交第二条普通消息，仍先得到第一条消息的最终回复；
- Runtime 重启会中断未完成普通对话，但继续恢复已经持久化的物理工具计划；
- Dialogue Reply 标记为 `thread_kind=dialogue`，物理工具完成标记为 `thread_kind=work`。
- 同一 Work Thread 的并发 Tool wakeup 保持单飞，并且只提交一个终态；
- 旧 Work Thread 尚在运行时，同 Session 新消息可以独立得到回复；
- Work 完成先进入 Completion Inbox，再由 Delivery Thread 产生一次面向 Session 的回复；
- Delivery Thread 普通文本可原子覆盖多个结果，`no_reply` 不会形成自唤醒循环；
- `schedule_tx` 的定时 spawn 只投递一次；依赖未完成时不投递，完成后自动唤醒；
- 模拟 Runtime 重启后，SQLite 中的 queued 定时计划能够重新装载并投递；
- Rust 全量测试、Provider 契约测试、Dashboard 内嵌资源测试和 `clippy -D warnings` 均通过。
