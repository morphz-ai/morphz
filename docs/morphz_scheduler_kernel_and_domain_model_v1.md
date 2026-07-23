# Morphz Scheduler Kernel 与领域命名模型 v1

> 状态：设计与实现基线；Phase 0–4 的单机实现已经收口，Phase 5 分布式执行明确不在当前范围
>
> 日期：2026-07-17
>
> 适用范围：Runtime 调度、Session 并发、工具执行、Objective、Delegation、定时任务与结果交付
>
> 相关文档：[Session Thread Model v1](./morphz_session_thread_model_v1.md)、[First-Class Objective Supervisor v1](./morphz_first_class_objective_supervisor_v1.md)、[共享 Context 多 Session 架构](./morphz_shared_context_multisession_architecture.md)、[单 Session 求值与响应路由协议 v1](./morphz_response_routing_protocol_v1.md)

## 1. 背景

Morphz 最初并不是以“通用任务调度系统”为名进行设计的。它从几个直接的 Agent 产品需求逐步演化而来：

- Agent 调用长时间工具时，用户仍然能够继续与它对话；
- 同一个 Cognitive Context 可以挂载多个 Session，并发处理不同对象的消息；
- 同一 Session 中可以同时存在对话、工具工作、长期 Objective 和完成结果交付；
- 模型能够决定后续工作应当串行、并行、等待依赖或者定时执行；
- Runtime 重启后，已经形成物理执行计划的工作能够恢复，而陈旧对话不会突然复活；
- 所有并发执行仍然共享同一个 Agent 的 Mind，同时保持因果关系和回复路由清晰。

实践表明，这些需求不能通过扩大传统的顺序 Agent Loop 来稳定解决。它们共同指向一个更统一的系统：

> Morphz Runtime 是一个以 LLM 为语义决策器、以持久 Thread 为执行身份、以事件和 Signal 为驱动的认知型多任务调度系统。

它和传统工作流引擎的区别在于，计划、依赖、任务拆分、结果解释和回复决策主要由模型完成；它和传统 Agent Loop 的区别在于，Runtime 不再只有一条顺序消息链，而是显式管理多个可并发、可等待、可恢复的因果执行流。

本文的目标不是引入更多概念，而是整理已经从实践中形成的调度模型，统一领域语言，并给出当前实现向 Scheduler Kernel 收口的方向。

## 2. 顶层设计结论

Morphz 应当明确区分四个平面。

### 2.1 认知平面（Cognitive Plane）

认知平面回答“Agent 知道什么、相信什么、如何理解当前世界”。

核心对象：

- `CognitiveContext`：Agent 的共享认知环境；
- `Mind`：由模型维护的当前心智结构；
- `Frame`：Mind 中可创建、修订、取代、交换和换入换出的认知单元；
- `Ledger`：不可变的物理事件事实；
- `ContextEncoding`：Runtime 向模型呈现的可求值视图。

认知平面不负责判断一个进程是否仍在运行，也不负责确保一个定时器必定唤醒。模型可以理解和维护任务语义，但物理执行状态必须由 Runtime 掌握。

### 2.2 交互平面（Interaction Plane）

交互平面回答“消息来自哪里，结果应发送给谁”。

核心对象：

- `Session`：一个外部对象与 Agent 之间的消息路由或连接；
- `DialogueLane`：一个 Session 内长期存在的对话排序通道；
- `Identity`：Session 的所有者或访问主体；
- `Delivery`：把完成结果投递给一个或多个目标 Session。

Session 不是 Context，也不是任务。大量 Session 可以挂载在同一个 Context 上，共享认知但保持消息路由独立。

### 2.3 调度平面（Scheduling Plane）

调度平面回答“哪条逻辑执行流现在可以运行，为什么运行，何时再次运行”。

核心对象：

- `Thread`：持久、稳定的因果执行流；
- `ThreadSignal`：进入 Thread mailbox 的物理事实；
- `ThreadActivation`：Thread 因 Signal 而产生的一次可调度求值运行；
- `Schedule`：在未来满足条件时生成 Signal 的规则；
- `Objective`：要求 Runtime 持续保证推进机会的长期控制意图。

### 2.4 执行平面（Execution Plane）

执行平面回答“模型决定的动作如何在现实世界中被执行”。

核心对象：

- `ModelAttempt`：一次真实的模型 Provider 请求；
- `Action`：模型请求 Runtime 执行的结构化动作；
- `ExecutionJob`：Runtime 对 Action 的物理执行实例；
- `Executor`：执行 Job 或 Thread 的主体，例如 self、Sub Agent、远程 Worker 或人；
- `Outcome`：有限 Thread 的唯一终态结果。

四个平面可以共享事件和 ID，但不能互相替代。特别需要保持两个边界：

1. Mind 中的语义 Frame 不等于 Runtime 的调度记录；
2. 模型提出的 Action 不等于已经发生的物理结果。

## 3. 统一领域模型

### 3.1 Agent

`Agent` 是持续存在的认知与行为主体。

一个 Agent 拥有一个或多个 Cognitive Context，也可以通过同一 Context 同时服务大量 Session。Agent 的身份不由某次模型请求决定，模型只是它在某次 Activation 中使用的认知处理器。

### 3.2 Cognitive Context

推荐正式名称：`CognitiveContext`，对外可简称 `Context`。

中文：认知上下文。

Context 表示 Agent 共享认知所属的环境。它可以包含多个 Session、一个共享 Mind、长期 Frame 和 Event Ledger，但它不是“某一次发送给模型的完整 Prompt”。

发送给模型的是 Context 在某个时刻、面向某个 Session 和 Thread 求值出来的 `ContextEncoding`。

### 3.3 Session

推荐名称：`Session`。

中文：会话、交互连接。

Session 表示外部消息的来源和回复目的地。它负责：

- 绑定身份与权限范围；
- 保持该对象的局部对话记录；
- 为回复、进度和交付提供路由；
- 在 Context Encoding 中提供当前交互视角。

Session 不拥有 Agent 的全部认知；Session 挂载到 Context 后，才获得在该认知环境中与 Agent 交互的能力。

### 3.4 Dialogue Lane

推荐名称：`DialogueLane`。

中文：对话通道、对话执行通道。

每个 Session 拥有一条长期存在的 Dialogue Lane。它负责保证连续用户消息的摄取顺序、对话并发策略和当前 Turn 的路由，但它不是一项有限任务，也不拥有 Thread Outcome。

每一条用户输入在 Dialogue Lane 中创建一个有限的 `DialogueTurn` Thread：

```text
Session
└── DialogueLane                  长期存在，无任务终态
    ├── DialogueTurn Thread A     有一次明确回复或 no_reply 终态
    ├── DialogueTurn Thread B
    └── DialogueTurn Thread C
        └── Execution Thread W    从 Turn C 派生的物理工作
```

这项区分解决两个容易混淆的语义：

- 用户与 Agent 的对话通道可以长期存在，不应在每次回复后进入 completed；
- 每次用户输入仍然需要有限因果边界、唯一处理结果和幂等恢复身份。

Dialogue Lane 可以允许用户在旧 Execution Thread 工作期间继续创建新的 Dialogue Turn，但同一 Lane 中多个普通 Dialogue Turn 的首次求值必须服从明确的顺序策略。当前 Runtime 的 Session Dialogue Gate 是 Dialogue Lane 的早期物理实现。

### 3.5 Thread / Causal Thread

推荐公开名称：`Thread`。

推荐内部全称：`CausalThread`。

中文：执行线程、因果线程。

Thread 是一条具有稳定身份和因果边界的逻辑执行流。它可以跨越多次模型请求、工具调用、等待、Runtime 重启和结果交付。

不再建议把总称叫 `WorkThread`，原因是 Dialogue Turn、Delivery 和 Objective 推进同样属于 Thread；`Work Thread` 还容易与操作系统 Worker Thread 混淆。

推荐的 Thread 类型：

```text
Thread
├── DialogueTurn   一次有限的对话轮次
├── Execution      执行线程
├── Objective      目标推进线程
└── Delivery       交付线程
```

其中：

- `DialogueTurn Thread`：处理 Dialogue Lane 中一次用户输入，终态是一次明确回复或 `no_reply`；
- `Execution Thread`：承载需要物理工具、依赖或长时间运行的工作；
- `Objective Thread`：承载一次 Objective 的实际推进求值，Objective 本身仍是独立的长期控制对象；
- `Delivery Thread`：汇总已经完成但尚未交付的结果，决定回复或延迟交付。

Delegation 不必成为独立 Thread 类型。它更适合表达“某条 Thread 由另一个 Executor 执行”的关系。

### 3.6 Thread Signal

推荐名称：`ThreadSignal`。

数据库物理名称可使用：`thread_mailbox_entries`。

中文：线程信号、线程邮箱条目。

Signal 是已经发生、能够使 Thread 变为可运行状态的物理事实。例如：

```text
user_message
tool_result
job_output
job_exit
timer_due
dependency_completed
approval_result
delegation_result
objective_continue
external_event
resource_available
```

上一阶段使用过 `WakeRecord` 作为候选名称，但 `wake` 更像 Signal 产生的动作和效果。Signal 是持久对象；Wake 是 Scheduler 看到 Signal 后把 Thread 变为 runnable 的行为。

一个 Signal 至少应包含：

```text
ThreadSignal
├── id
├── thread_id
├── kind
├── event_id / payload_ref
├── caused_by
├── available_at
├── status
├── claimed_by
├── lease_expires_at
├── created_at
└── acknowledged_at
```

推荐状态：

```text
pending | claimed | acknowledged | cancelled
```

Signal 必须是持久的、幂等的，并且只能被投递给正确的 Thread。

### 3.7 Thread Activation

推荐名称：`ThreadActivation`。

中文：线程激活、执行流激活。

`ThreadActivation` 用来替代当前的 `EvaluationWorkItem`。

它表示：

> Scheduler 消费一个或一组可用 Signal 后，对某个 Thread 发起的一次可 claim、可审计、可恢复的求值运行。

为什么不继续使用 `EvaluationWorkItem`：

- `Work Item` 太泛，像普通任务队列中的一条记录；
- 它没有表达这次求值为什么产生；
- 它容易与用户任务、后台 Job 和 Thread 混淆。

为什么 `Evaluation Unit` 仍不是首选：

- `Unit` 能表达原子性，但不能表达调度生命周期；
- 它可能被理解为测试单元、算力单元或一次 HTTP 请求；
- 当前对象最重要的语义不是“它是一个单元”，而是“Thread 被新的事实激活了”。

候选名称的优先级：

1. `ThreadActivation`：最符合调度语义；
2. `EvaluationRun`：更通俗，但容易被误解为一次 Provider 请求；
3. `EvaluationCycle`：符合 VM 思想，但容易被理解为循环；
4. `EvaluationUnit`：可接受，但语义较泛；
5. `EvaluationWorkItem`：不再推荐。

推荐 Activation 状态：

```text
queued | running | succeeded | failed | cancelled
```

等待状态不应长期属于 Activation。Activation 可以以“使 Thread 进入等待”的结果结束，但进入 Waiting 的主体是 Thread。

#### 3.7.1 Signal 批量领取语义

v1 固定采用“一个 Activation 原子领取同一 Thread 当前可见的一批 Signal”，而不是一个 Signal 必然产生一次模型调用。

具体规则：

1. Scheduler 按 `available_at`、Ledger sequence 和 Signal ID 形成确定性顺序；
2. 在一个事务中领取当前已经 pending 的 Signal，创建一个 Activation，并写入 `activation_signals` 关联；
3. 单次领取有明确上限，超过上限的 Signal 保留给后续 Activation；
4. 事务提交之后新到达的 Signal 不加入正在运行的 Activation，而是留在 mailbox 中等待下一次激活；
5. 同一 Thread 同时只能存在一个 running Activation；
6. Signal ID 在 `activation_signals` 中唯一，保证一个 Signal 不能被两个 Activation 成功消费；
7. Activation 成功提交处理结果后，所领取 Signal 才进入 acknowledged；Activation 租约失效时应恢复或重新 claim 同一个 Activation，并保留原有 `activation_signals` 关系，不能另建 Activation 静默重复消费 Signal。

推荐关联表：

```text
activation_signals
├── activation_id
├── signal_id              UNIQUE
├── ordinal
├── claimed_at
└── acknowledged_at
```

批量领取能够让并行工具几乎同时返回时只产生一次后续模型求值，同时保留运行期间新事实进入下一次 Activation 的清晰边界。

### 3.8 Model Attempt

推荐名称：`ModelAttempt`。

中文：模型调用尝试。

Model Attempt 是一次真实的 Provider API 请求。一次 Thread Activation 可能包含多次 Model Attempt，例如：

- Provider 网络重试；
- malformed function call 修正；
- 响应协议缺失后的纠错；
- Context maintenance 后重新请求；
- 可恢复的 Provider fallback。

因此必须保持：

```text
ThreadActivation 1 ── N ModelAttempt
```

不能使用一次 HTTP 请求的 ID 作为 Thread 的稳定身份。

### 3.9 Action

推荐名称：`Action`。

中文：动作请求。

Action 是模型在一次求值中表达的结构化行为意图，例如：

- 调用物理工具；
- 执行 `context_tx`；
- 提交 `schedule_tx`；
- 发送跨 Session 消息；
- 明确 `no_reply`；
- 更新 Objective 控制状态。

Action 只表示“模型要求 Runtime 做什么”，不表示该动作已经成功发生。Runtime 必须验证它的参数、权限、状态转换和因果路由。

### 3.10 Execution Job

推荐名称：`ExecutionJob`。

中文：执行作业、物理执行实例。

Execution Job 是 Runtime 将一个需要现实执行的 Action 物化后的记录，例如：

- 一次 shell 进程；
- 一次文件读写；
- 一次网络调用；
- 一个浏览器操作；
- 一次需要审批的命令；
- 一次 Sub Agent 或远程 Worker 执行。

当前物理工具 Action 和脱离当前 Activation 继续运行的后台进程都已经物化为持久 `ExecutionJob`。前台和后台不需要两套权威 Job 类型；进程内 `BackgroundTask` 只保留 live process group、增量输出等不可持久化的执行句柄和缓存，Job 生命周期以数据库记录为准。两者的区别只在于当前 Activation 是否同步等待，以及 Job 完成后如何生成 Signal。

推荐状态：

```text
queued
waiting_approval
running
succeeded
failed
cancelled
lost
```

Job 终态必须与对应的不可变结果 Event 原子提交。脱离当前 Activation 的后台 Job 可以同时写入 Signal Outbox；同一 Activation 中的一批并行工具则先各自提交 Job/Event，待全部 sibling 终态后只写入一个 batch-complete barrier Event/Outbox，避免一个工具结果启动一条重复模型链。无论哪种路径，Job 终态都不能直接伪造 Thread 已经完成。

单机重启恢复遵循保守的现实边界：尚未越过副作用边界且声明为幂等的 Job 可以通过 revision/claim fencing 重新排队；外部结果无法证明的运行中 Job 必须标记为 `lost`，不得自动重放一个可能已经发生的非幂等副作用。

取消也必须遵循物理事实而不是控制愿望：`cancel_requested` 只是持久意图。未启动或仍在等待审批且未越过副作用边界的 Job 可以直接以确定性 cancelled Event 关闭；运行中的本机 exec 必须先记录意图，再终止对应进程组，并由 executor/watcher 观察退出后提交 `cancelled`。如果跨重启后无法证明实际结果，则提交 `lost`，不能用“曾经请求取消”伪造物理终止。

### 3.10.1 Durable Approval

推荐名称：`Approval` 或 `ExecutionApproval`。

中文：持久审批、执行授权。

审批不是进程内回调，也不是模型对安全性的随口判断。它是一个绑定到**确切 Execution Job、规范化 Action、请求能力集合和权限策略版本**的持久授权对象。

推荐状态：

```text
pending_auto | pending_human | allowed | denied | cancelled
```

关键边界：

1. 需要审批的 Job 在物理执行 claim 之前进入 `waiting_approval`；
2. Approval request、Job 与不可变审计 Event 采用稳定身份，精确重放幂等，不同请求不能复用同一个授权；
3. `allowed` 产生的 grant 只能使用一次，并与 Job claim 在同一事务消费；
4. 人工审批可以跨 Runtime 重启等待，不应被普通工具执行超时误判为工具失败；
5. `denied/cancelled` 会形成明确的工具结果和 Job 终态，而不是静默丢弃调用；
6. 人或自动 reviewer 是 Approval authority 的决策适配器，持久 Approval 记录才是 Runtime 的权威事实。

### 3.11 Executor 与 Delegation

推荐名称：`Executor` 与 `Delegation`。

中文：执行者、委托关系。

Executor 表示实际承担执行职责的主体：

```text
self
sub_agent
remote_worker
human
external_service
```

Delegation 表示把一条 Thread、一个子 Objective 或一个 Job 的执行职责交给另一个 Executor。

Delegation 应当保留自己的委托关系、上下文范围、深度限制和结果路由，但不应成为与 Scheduler 平行的另一套任务系统。它最终仍通过 Job、Signal、Activation 和 Outcome 接入统一内核。

### 3.12 Schedule

推荐顶层名称：`Schedule`。

中文：调度计划。

当前 `ScheduledIntent` 同时包含了语义意图、定时规则、依赖和执行 occurrence。短期内可以直接重命名为 `ScheduleRecord`；规模扩大后建议拆分为：

```text
ScheduleRule
├── target_thread_id
├── intent
├── trigger
├── dependencies
├── recurrence
└── lifecycle

ScheduleOccurrence
├── rule_id
├── due_at
├── revision
└── delivery_state
```

Schedule 到期时只产生 `ThreadSignal`。它不直接调用模型、不执行工具，也不声称任务已经完成。

推荐 Schedule 生命周期：

```text
active | paused | completed | cancelled
```

推荐支持的操作：

```text
create | reschedule | pause | resume | cancel | inspect
```

### 3.13 Objective

推荐名称：`Objective`。

中文：持久目标、执行目标。

Objective 是 Runtime 承诺持续提供推进机会的长期控制对象。它不是普通 Todo，也不是模型自由格式 Mind Frame 的替代品。

建议明确区分：

- `Goal`：Mind 中由模型理解、拆分和维护的语义目标；
- `Objective`：Runtime 持久化并监督生命周期的执行承诺。

Objective 不应拥有另一套独立 Scheduler。Objective Supervisor 是一种调度策略：它根据 Objective 状态和 Wait Condition，向对应 Thread 生成 Signal。

### 3.14 Outcome 与 Delivery

推荐名称：`ThreadOutcome` 与 `Delivery`。

中文：线程终态结果、结果交付。

同一个有限 Thread 只能产生一个权威 Outcome。长期存在的 Dialogue Lane 不属于 Thread，因此不受这个终态约束：

```text
completed | failed | cancelled
```

Outcome 与“结果是否已经发送给用户”是两个维度。后台 Execution Thread 完成时，应先写入 Completion Inbox，再由 Runtime Delivery Router 决定：

- 立即回复当前 Session；
- 合并多个完成结果后回复；
- 向另一个 Session 发送消息；
- 暂时 `deferred`；
- 明确不发送用户可见文本。

Router 与 Delivery Composer 是两层：Router 是始终存在的确定性控制面；Composer 只是批次确实需要语义合成时才创建的模型 Activation。单条完成结果由 Router 原文透传，受配置限制的小型、短文本、同质 Execution 批次由 Router 生成确定性编号列表；超过数量/字符阈值、包含 Objective/外部 Executor，或结果 Event 显式设置 `delivery_requires_composition=true` 时，才启动 Composer。用户消息直接派生、未 detach 且没有 Schedule 的交互式 Execution 终态更早直接成为 `chat/reply`，不进入合并窗口。

当前单机 Runtime 已为同一 Session 的相邻后台完成结果提供持久 Delivery merge window。第一个 pending 结果启动最大等待边界；后续结果只在该边界内重排短合并窗口。到期后，generation-fenced Timer 冻结本次完成快照。Router 能确定性渲染时，在同一事务写入 `chat/reply` 并把快照中的 `pending/deferred` 标记为 `delivered`；需要 Composer 时才原子写入 `chat/thread_completion_ready` Event 与 Signal Outbox，创建 Delivery Activation。这个窗口只合并完成通知，不改变各 Execution Thread/Job 的物理完成时刻。

每次交付的范围由其**不可变 Timer 快照**决定：Timer generation 中的 `completed_thread_ids/result_event_ids` 在调度时冻结。Router fast path 的 `chat/reply.covers` 与 Composer Activation 最终产生的 `chat/reply.covers` / `chat/no_reply.defer_covers` 都只能确认这批 ID；处理开始后新完成的 Thread 保持待交付，并进入下一次 Delivery。Runtime 不能在终态提交时重新扫描 Session 的“当前全部 pending”，否则一次旧处理可能误确认它从未看见的新结果。

## 4. 统一执行链

完整的调度和执行关系如下：

```text
Session / Tool / Timer / External World
                 │
                 ▼
           ThreadSignal
                 │ claim
                 ▼
         ThreadActivation
                 │
                 ├── ModelAttempt 1
                 ├── ModelAttempt 2 (retry / correction)
                 └── ModelAttempt N
                          │
                          ▼
                        Action
                          │
          ┌───────────────┼────────────────┐
          ▼               ▼                ▼
       Reply          Schedule        ExecutionJob
          │               │                │
          ▼               ▼                ▼
      Delivery       future Signal    result Signal
                                           │
                                           └──► next ThreadActivation
```

在它之上：

- Context 为所有 Thread Activation 提供共享认知；
- Objective 决定哪些 Thread 需要继续拥有推进机会；
- Delegation 决定某条工作由哪个 Executor 执行；
- Runtime 保证 Signal、Activation、Job、Outcome 和 Delivery 的物理一致性。

## 5. 典型场景

### 5.1 普通对话

```text
User Message
→ Session Dialogue Lane
→ create DialogueTurn Thread + user_message Signal
→ DialogueTurn Activation
→ Model Attempt
→ ordinary assistant text
→ DialogueTurn Outcome delivered
```

没有工具调用时，不创建 Execution Thread，也不创建 Execution Job。

### 5.2 工具运行期间继续对话

```text
DialogueTurn Activation A
→ model requests physical action
→ create/fork Execution Thread W
→ create Execution Job J
→ Dialogue Lane becomes available

User Message B
→ create DialogueTurn B
→ DialogueTurn Activation B
→ reply B without waiting for J

Job J exits
→ result Signal to Thread W
→ Activation W2
→ Thread Outcome
→ Delivery Router pass-through/batches, or invokes Composer when needed
```

这正是 Morphz 区别于传统顺序 Agent Loop 的关键能力：物理执行与持续对话具有不同的因果线程。

### 5.3 同一 Thread 串行执行

模型决定后续动作属于当前工作时，不创建新的 Thread，只把动作留在当前 Thread 的执行链中。多个 Tool Result 都回到同一 mailbox，由同一 Thread 顺序吸收。

### 5.4 创建并行工作

模型明确提交 `schedule_tx.spawn` 时，Runtime 创建新的 Execution Thread。新 Thread 与当前 Thread 共享 Context，但具有独立 Signal、Activation、Job、Outcome 和 Delivery 状态。

### 5.5 依赖工作

```text
Thread B waits for Thread A
→ dependency relation persisted
→ A reaches terminal Outcome
→ Runtime emits dependency_completed Signal to B
→ B becomes runnable
```

依赖应由终态事件直接触发，不应长期依靠固定间隔轮询。

### 5.6 定时和周期工作

一次性 Schedule 在 `due_at` 到达时产生 Signal。周期 Schedule Rule 为每次 occurrence 产生独立 Signal 或 Thread，不应复用上一次 occurrence 的终态身份。

### 5.7 Objective 推进

Objective Supervisor 不直接运行任务。它读取 Objective 的 Runtime 控制状态：

- `active + no wait`：产生 continue Signal；
- `active + wait condition`：登记等待，不忙轮询；
- `paused/blocked`：等待明确的控制事件；
- `completed/cancelled/failed`：停止产生新的 Signal。

## 6. 状态所有权

统一调度设计必须明确“谁拥有哪种状态”。

### 6.1 Dialogue Lane 状态

Dialogue Lane 是长期路由和顺序控制对象，推荐只保留：

```text
active | paused | archived
```

它没有任务 Outcome。某次用户消息是否已经处理完成，由对应 DialogueTurn Thread 的 Outcome 表达。

### 6.2 Thread 生命周期与调度阶段

Thread 必须把长期生命周期和瞬时调度阶段分成两个维度。

权威生命周期 `lifecycle`：

```text
open | completed | failed | cancelled
```

- `open`：Thread 仍然可以接收 Signal 并继续推进；
- `completed/failed/cancelled`：有限 Thread 的唯一终态。

调度阶段 `phase`：

```text
idle | runnable | running | waiting
```

- `idle`：Thread 为 open，但当前没有可运行 Signal、active Activation 或明确等待；正常实现中应短暂存在，长期 idle 需要检查是否为孤儿；
- `runnable`：存在尚未消费的 Signal；
- `running`：存在活跃 Activation；
- `waiting`：没有可运行 Signal，但存在明确 Wait Condition、Job、依赖或 Schedule；

`lifecycle` 是持久化权威事实。`phase` 应由 Signal、Activation、Job、Schedule 和 Wait Condition 推导，或者只保存为可以重建和校验的缓存投影，不能成为第二个独立事实源。

因此，UI 中的“正在执行”不能只读取 Thread 最近一次写入的 phase；它必须至少能由 active Activation 或 running Job 证明。Thread lifecycle 和 phase 的分离与 Objective lifecycle、wait condition 的分离遵循同一控制论原则。

### 6.3 Activation 状态

```text
queued | running | succeeded | failed | cancelled
```

Activation 只描述一次求值运行。它不拥有长期等待状态。

Activation 完成时可以产生以下结果：

```text
reply
actions
schedule
suspend
thread_outcome
no_reply
```

### 6.4 Job 状态

Execution Job 是现实执行状态的权威来源。进程是否退出、网络调用是否完成、审批是否通过，都不能由 Thread 或 Mind 猜测。

### 6.5 Objective 状态

Objective 拥有长期控制生命周期和资源预算，但不重复拥有 Execution Job 状态。

### 6.6 UI 投影原则

Dashboard 不应通过最近一次 Event 文本猜测“正在执行”。状态必须从权威对象派生：

```text
Objective
└── Thread
    ├── lifecycle / derived phase
    ├── active Activation
    ├── active/waiting Job
    ├── pending Signal
    ├── Wait Condition
    └── Outcome / Delivery
```

如果多个投影不一致，Runtime 应记录 invariant violation，而不是在 UI 中任选一个状态显示。缓存 phase 与权威实体不一致时，优先重新推导 phase。

## 7. Wait Condition

等待条件是 Thread `phase=waiting` 的权威依据之一。推荐统一建模：

```text
WaitCondition
├── job(job_id)
├── thread(thread_id)
├── timer(deadline)
├── approval(request_id)
├── delegation(delegation_id)
├── user_input(session_id)
├── external_event(topic, correlation_id)
└── resource(resource_id)
```

未来可以支持组合等待：

```lisp
(any
  (job job-1)
  (timer 2026-07-17T00:00:00Z))

(all
  (thread thread-a)
  (thread thread-b))
```

内部应使用类型安全的持久结构；S-Expression 是向模型呈现和供模型表达的编码形式，不要求数据库直接保存自由格式 Lisp 文本。

## 8. Scheduler Kernel 的职责边界

### 8.1 模型负责

- 理解用户意图和 Context；
- 判断工作应当串行还是并行；
- 决定是否创建新 Thread；
- 表达依赖、定时和后续意图；
- 选择工具和 Executor；
- 解释 Job 结果；
- 判断语义任务是否真正完成；
- 决定如何向 Session 交付结果；
- 维护 Mind 和 Frame。

### 8.2 Runtime 负责

- 验证模型调度请求是否合法；
- 原子持久化 Thread、Signal、Activation、Job、Schedule 和 Outcome；
- 保证同一 Thread 的 Activation single-flight；
- 保证一个有限 Thread 只有一个权威终态；
- 保证 Job Result 只投递给正确 Thread；
- 执行定时、依赖、审批、取消和恢复；
- 提供并发限制、公平性、优先级和背压；
- 保证安全边界和权限控制；
- 在崩溃和重启后恢复可恢复工作；
- 向 UI/API 提供权威调度状态。

### 8.3 Runtime 不负责

- 从任意自然语言中猜测任务已经完成；
- 解析自由格式 Frame 来验证业务事实；
- 为具体任务硬编码验证契约；
- 替模型生成业务计划；
- 因为工具退出码为零就宣称 Objective 已经完成；
- 把 Context 中的认知描述当成现实执行状态。

## 9. 正确性不变量

Scheduler Kernel 至少应维护以下不变量：

1. 每个 Model Attempt 只属于一个 Thread Activation。
2. 每个 Activation 只属于一个 Thread。
3. 同一个 Thread 同一时刻最多有一个运行中的 Activation。
4. 一个 Activation 原子领取一个有界、确定顺序的 Signal 批次。
5. 一个 Signal 最多关联到一个成功领取它的 Activation；重复投递必须幂等。
6. Activation 领取事务之后到达的 Signal 必须留给下一次 Activation。
7. Tool/Job Result 只能进入其因果 Thread 的 mailbox。
8. 新用户消息不得继承旧 Execution Thread 的 Function Calling transcript。
9. 每个 Session 拥有一条长期 Dialogue Lane；每条用户输入创建独立的有限 DialogueTurn Thread。
10. 同一 Dialogue Lane 的普通用户消息按明确的顺序策略首次求值。
11. 不同 Session 可以并行；DialogueTurn 与 Execution Thread 也可以并行。
12. 每个有限 Thread 只能提交一个权威 Outcome；Dialogue Lane 不拥有任务 Outcome。
13. Thread lifecycle 是权威事实；phase 必须可以从 Signal、Activation、Job 和 Wait Condition 重新推导。
14. Thread Outcome 与用户 Delivery 必须分离。
15. Schedule 到期只产生 Signal，不直接宣称任务成功。
16. Objective 的等待、暂停和阻塞必须能够区分。
17. 凡是一次控制事务已经决定“应唤醒 Thread”，其 Event 与 Signal Outbox 必须原子提交；Job terminal 与后续 batch/background wake 可以是两个语义事务，但中间状态必须持久、幂等且具备启动恢复桥接。
18. 重启恢复不得重复执行已确认的外部副作用。
19. `lifecycle=open` 且长期没有 Signal、Job、Schedule、Wait Condition 或 active Activation 的 Thread 是孤儿状态，必须被检测。
20. UI 展示状态必须来自权威控制记录，不能来自陈旧日志文案或未经验证的 phase 缓存。
21. 需要审批的 Execution Job 在授权 grant 与 Job claim 原子提交之前不得跨越物理副作用边界。
22. 一个 Approval grant 只能被与其 Job、Action、能力集合和策略摘要完全匹配的一次 claim 消费。
23. Activation admission 窗口满只能造成持久 `queued` 延迟，不能把合法工作伪造成失败或丢弃。
24. 只要执行资源持续释放，固定低优先级工作必须通过 aging 获得最终推进机会；模型不能提供任意数字绕过 Runtime 的 class 和容量策略。
25. Objective 的 pause/cancel 只能取消与该 Objective Evaluation 精确绑定的 Activation/Job，不得扩大成 Session 级取消并影响普通对话或兄弟 Objective。
26. Delivery 合并不得越过第一个 pending 结果的最大等待边界；同一 Timer generation 的重试最多产生一个确定性 Event/Outbox。
27. Delivery 终态只能确认其不可变 Trigger Snapshot 中的 Thread；求值开始后新完成的结果必须留给下一次 Delivery。
28. 瞬时模型流是可丢弃的 UI 草稿，不能反向阻塞 Model Attempt、Execution Job 或持久事实提交；最终界面必须由持久终态纠正。Provider 返回的 reasoning summary 必须与公开正文分通道展示，不得混入 Session 回复或 Context observation；一次 Attempt 只能在终态聚合后写入一条独立 Ledger 可观测事实。

## 10. 持久化调度内核

目标持久模型建议至少包含：

```text
dialogue_lanes
threads
thread_signals
thread_activations
activation_signals
thread_wait_conditions
model_attempts                 optional audit projection
execution_jobs
approvals
schedules
schedule_occurrences           phase 2
runtime_timers
signal_outbox
thread_outcomes
deliveries
objectives
delegations
events                         immutable ledger
```

核心事务边界：

### 10.1 Signal Claim

```text
claim pending signals
+ create activation
+ insert activation_signals in deterministic order
+ derive thread phase runnable → running
```

必须在同一事务完成。

### 10.2 Activation Suspend

```text
activation → succeeded
+ thread lifecycle remains open
+ create job / wait condition / schedule
+ derive thread phase → waiting
```

必须在同一事务完成。

### 10.3 Job Completion

```text
job → succeeded/failed
+ append physical result event
```

Job terminal 与 physical result Event 必须在同一事务完成。其后的 wake 边界取决于 Action 形态：同一 Activation 的并行工具必须等待所有 sibling Job/Event 终态后再追加**一个** batch barrier Event/Outbox；脱离 Activation 的后台 Job 则追加自己的 Signal Outbox。当前后台路径的 Outbox 是紧随 terminal transaction 的幂等第二步，并在启动时扫描 terminal background Job 修复崩溃窗口；这是已覆盖的单机恢复边界，不应被误写成一次 SQLite 原子提交。

### 10.4 Thread Terminal

```text
activation → succeeded
+ thread lifecycle → completed/failed/cancelled
+ insert unique thread outcome
+ create delivery inbox entry
+ trigger dependent signals
```

必须在同一事务完成。

### 10.5 Durable Dispatcher

进程内 EventBus 只负责低延迟通知。可靠调度以数据库中的 pending Signal 为准：

```text
commit state + signal
        ↓
dispatcher claims pending signal
        ↓
atomically materialize activation + activation_signals
        ↓
in-process fast path dispatch
        ↓
acknowledge signals after activation outcome commits
```

这样，进程在“数据库提交成功、内存派发尚未发生”之间崩溃时，不需要每个模块分别实现特殊恢复扫描。

### 10.6 Approval 与 Job Claim

```text
ensure waiting_approval job
+ ensure pending approval
+ append approval request event

approval authority decides
+ persist allow/deny authority state
+ append idempotent audit projection

consume exact one-use grant
+ claim execution job
```

waiting Job、pending Approval 与 request Event 在一个事务中创建。Approval 的每次 Decision/Cancel 状态迁移与对应 immutable decision Event 也在同一个事务中提交；事件身份绑定 `approval_id + decision status`，因此先允许、后在 grant 消费前取消是两个合法且可重放的审计事实，同时 grant 消费造成的普通 revision 推进不会伪造新的 decision。精确重放可以补齐旧 Runtime 留下的缺失事件，不同内容则冲突并整体回滚。Decision record 必须先于进程内 waiter 唤醒持久化；decision Event 是幂等审计投影，不是第二个 authority。grant 消费与 Job claim 在另一个事务中原子完成，并通过 revision、request/policy digest 和 claim token fencing。Approval 等待发生在工具物理执行超时开始之前；拒绝则以显式 Job/Tool terminal fact 结束。

### 10.7 Delivery Flush

```text
thread outcome becomes pending delivery
+ arm/bump session delivery timer generation

timer generation fires
+ append deterministic completion-ready event
+ append signal outbox
```

`due_at = min(latest_pending + merge_window, first_pending + max_wait)`。Timer 重排、Runtime 重启和旧 generation 迟到都不能延长第一条结果的最大等待时间，也不能生成第二条相同 Delivery wake。Timer generation 触发时写入的 `completed_thread_ids/result_event_ids` 是不可变 Trigger Snapshot；Context Encoding、`covers` 和 `defer_covers` 都必须使用这组 ID，而不是在 Delivery 结束时重新扫描 live pending 集合。

## 11. 公平性、优先级与背压

模型可以建议串行、并行、依赖和定时关系，但 Runtime 必须拥有物理资源控制权。当前单机实现已经把 Activation admission 从“只有一个全局 Semaphore”推进为以下组合：

### 11.1 固定 Admission Class

```text
interactive/control
delivery
objective
scheduled/background
maintenance
```

class 由 Runtime 根据持久 Trigger Event 推导，不接受模型提供任意数字优先级。它表达延迟敏感性和系统生存性，不判断用户业务的重要程度。

### 11.2 分层公平与 Aging

同一有效 class 内按 `Agent → Context → Session` 分层轮转，再选取该 Session 中持久 `(created_at, id)` 最早的 Activation。等待达到配置间隔后，低 class 逐级提升，直到获得执行机会，避免后台或维护工作永久饥饿。

公平游标目前属于单机进程内加速状态；重启后可以从持久 queued rows 确定性重建。重启可能重置轮转相位，但不会改变 FIFO、aging 或是否最终可运行。

### 11.3 保留通道与有界背压

完整 Activation 的总运行槽位由 Runtime `activation_admission.max_in_flight` 控制，并为 Dialogue/Delivery 保留可配置容量。模型 Provider 的物理请求额度由独立的 `model_provider_max_in_flight` 控制；等待工具、定时器或审批的 Activation 不会占用模型请求槽位。内存调度窗口也为延迟敏感工作保留位置；普通队列溢出仍留在 SQLite 的 `queued` Activation 中，通过无丢失 Notify 驱动的 refill 再进入窗口，不生成假失败回复，也不扫描整个 Event Ledger。

当前配置项包括：

```text
orchestrator.event_bus.max_in_flight
orchestrator.model_provider_max_in_flight
orchestrator.activation_admission.max_in_flight
orchestrator.activation_admission.max_queued
orchestrator.activation_admission.dialogue_delivery_reserved_slots
orchestrator.activation_admission.dialogue_delivery_reserved_queue_slots
orchestrator.activation_admission.aging_promotion_interval
```

### 11.4 已实现与尚未实现的边界

已经实现的是单机 Activation 层的固定 class、分层公平、aging、保留容量和持久 overflow backpressure，以及与 Activation 解耦的全局 Provider 请求池及其 queued/in-flight 指标。尚未实现的是每 Provider/Agent/Context/Session/Thread 的独立**数字并发配额**、每 Objective 的吞吐预算，以及跨进程的全局公平游标。Execution Job/Action 的更细粒度资源池仍应作为后续单机策略扩展，而不是在本文中误报为已经完成。

### 11.5 瞬时展示流的背压边界

`runtime/model_stream` 只承载 Provider 原生文本、推理摘要和工具参数增量，不是 Scheduler 的持久事实。Runtime 对这类事件采用 best-effort、非阻塞投递：某个 TUI、Dashboard 或 SDK 订阅者的有界队列已满时可以丢弃 draft chunk，不能让同步 EventBus 反向阻塞 Provider 流。`chat/reply`、`chat/no_reply`、工具结果和其他持久事件仍走可靠等待路径，并在终态原子替换不完整草稿。Dashboard WebSocket 一旦检测到广播 gap，会断开并从持久快照重同步，而不是把缺少中段的 draft 继续显示为完整响应。

推理摘要在此有一条额外的单次终态路径：Runtime 在 Model Attempt 结束后聚合全部 `ReasoningSummaryDelta`，只写入一条 `runtime/model_reasoning_summary`。该事件是可恢复的调试/观察数据，但不是 Reply、Session 消息或 Context observation；因此 Runtime 重启后 Dashboard 仍可查询，而 Agent 后续求值不会看到它。持久路由 `attempt_id` 幂等定位，并携带 `complete` 区分完整流与可能的中断摘要。

## 12. Context Encoding 中的表达

模型每次只应看到本轮 active Thread、Activation、可见 Signal 和相关背景，而不是把所有并发 Thread 混成一条消息流。

建议的 S-Expression 结构：

```lisp
(evaluate
  (context context-default)
  (session session-main)
  (thread
    (id thread-42)
    (kind execution)
    (lifecycle open)
    (phase running)
    (origin-turn message-17))
  (activation
    (id activation-9)
    (caused-by
      (signal-batch tool-result-8 tool-result-9)))
  (signals
    (signal
      (kind tool-result)
      (job job-3)
      (status succeeded)))
  (objective-binding none)
  (root-input "...")
  (instruction "解释本轮 Signal，并决定回复、动作、等待、调度或终结 Thread。"))
```

普通 DialogueTurn Activation 可以看到其他 Thread 和 Objective 的只读摘要，用于诚实回答状态问题，但不得因此接管或推进未绑定的 Thread。

## 13. 当前实现映射

当前代码已经形成 Scheduler Kernel 的主要骨架，并完成公开领域命名收口。

| 当前实现 | 目标领域对象 | 说明 |
|---|---|---|
| Session Dialogue Gate | `DialogueLane` | 已提供同 Session 首次求值顺序，但尚无独立持久 Lane 记录 |
| 每条 User Message 的 `ThreadRecord(kind=dialogue_turn)` | `DialogueTurn Thread` | 按 `root_turn_id` 创建有限因果边界 |
| `ThreadRecord` | `Thread` | 稳定 `root_turn_id`、权威 lifecycle、derived phase 和 Delivery 信息均已收口 |
| `ThreadActivationRecord` | `ThreadActivationRecord` | 领域类型与状态已经收口，SQLite 物理表已迁移为 `thread_activations` |
| `ThreadSignalRecord` + Event | `ThreadSignal` | Event 保存不可变事实，Signal 保存 mailbox 消费状态 |
| `signal_outbox` | Durable Signal Outbox | Event 与投递意图同事务提交；dispatcher 幂等物化 Signal |
| `ScheduleRecord` | `Schedule` | 已有 inspect/pause/resume/reschedule/cancel CAS 控制；rule、intent 和 occurrence 仍在同一记录 |
| `ExecutionJobRecord` | `ExecutionJob` | 已持久化普通物理 Action 与后台进程生命周期；进程内 BackgroundTask 只保留 live 句柄/输出缓存 |
| `ApprovalRecord` + `ExecutionApprovalStore` | `ExecutionApproval` | exact request/policy binding、单次 grant 与 Job claim 原子消费 |
| Tool Call | `Action` | 已有标准 Function Calling 表达 |
| ObjectiveRecord | `Objective` | 保留；Supervisor 已通过 continuation Event/Outbox 生产 Signal |
| DelegationRecord | `Delegation` | 保留，逐步改为 Executor 关系 |
| `thread_outcomes` | `ThreadOutcome` | 已具备唯一终态事务边界 |
| Completion Inbox + Delivery Router + optional Composer | `Delivery` | Router 负责一致性与确定性 fast path，模型只负责必要的语义合成 |
| `runtime_timers(kind=delivery_flush)` + Trigger Snapshot | Delivery merge window | 同 Session 合并、first-result max wait、generation fencing、不可变交付范围与重启恢复 |
| `ActivationAdmissionController` | Activation admission | 单机固定 class、分层公平、aging、保留容量与 bounded refill |

当前已经正确的部分：

- Session Dialogue Gate 已具备 Dialogue Lane 的顺序语义；
- Work/Execution Thread mailbox single-flight；
- Activation claim、lease 和恢复；
- Signal batch 的有界、确定顺序原子领取与 acknowledge；
- Event + Signal Outbox 原子提交、后台重试与启动恢复；
- User Message、Schedule occurrence、Objective continuation、Delegation result 和工具唤醒已接入统一 Outbox producer 边界；
- Thread lifecycle 与 derived phase 分离；
- 有限 Thread 的唯一终态 Outcome；
- `schedule_tx` 的原子提交；
- Schedule、Objective、Background wake 与 Activation lease 共用持久 Timer Engine；
- Schedule dependency 由持久反向索引事件驱动唤醒，不再固定间隔轮询；
- Work completion 与用户 Delivery 分离；交互式 attached Execution 可以在同一终态事务中直接标记 delivered；
- 同 Session 后台并发完成结果通过持久 Delivery Flush Timer 合并，并受 first-result max wait 约束；singleton 原文透传，小型同质批次确定性合并，复杂批次才调用 Composer；
- Delivery Activation 的 Context Encoding 与终态 `covers/defer_covers` 使用 Trigger Event 中冻结的完成 Thread ID；求值期间的新结果不会被旧 Delivery 误确认；
- Schedule inspect/pause/resume/reschedule/cancel 已使用 expected revision CAS，并通过 Timer generation fencing 阻止旧计划复活；
- 普通工具 Action 与脱离 Activation 的后台 exec 已物化为持久 Execution Job；空输出也以明确终态表达；
- Job 终态与不可变结果 Event 原子提交，后台 Job 的终态 Event→Outbox 崩溃窗口可在启动时幂等修复；
- 同一 Activation 的并行物理 Action 只在所有 sibling Job/Event 终态后产生一个 batch barrier wake，避免每条工具结果各自启动重复求值；
- 审批请求、决策和一次性 grant 已持久化；grant 与 Job claim 原子消费，拒绝形成明确工具结果；
- Runtime 启动时对 running Job 进行保守 reconcile：只有尚未越过副作用边界的幂等工作可重新排队，其余不确定事实进入 `lost`；
- Objective/Activation cancellation 先持久化精确 Job 取消意图；未启动或等待审批的 Job 原子关闭为 cancelled，运行中的本机 exec 终止其进程组并由 watcher 提交真实终态；
- Activation admission 已提供固定 class、Agent→Context→Session 分层公平、aging、Dialogue/Delivery 保留通道和 SQLite durable overflow；
- Objective pause/cancel 已按 Objective Evaluation/Activation 精确路由，不再通过 Session 级取消抑制普通对话或兄弟 Objective；
- 不同 Session、Dialogue 和 Execution 工作并发。

当前单机收口仍保留的边界：

- Thread、Objective、Delegation 和 Schedule 仍存在部分 UI/审计缓存投影；BackgroundTask live handle/cache 必须继续保持非权威；
- SQLite 物理表已收口为 `threads`、`thread_activations`、`thread_outcomes`、`schedules` 与 `schedule_dependencies`；启动迁移只负责保存开发期数据库事实，旧名称不进入公开接口；
- 缺少通用的父子 Thread/Action Group、组合 Wait Reason 和每 Agent/Context/Session/Thread 数字配额；
- 取消不能回滚已经提交到外部系统的副作用；对无法证明结果的跨重启 Job 仍必须进入 `lost`，具体工具若需要更强语义，应提供幂等键、reconcile 或专用 cancel hook；
- Approval 的 durable authority 已建立，但人工交互 UI/adapter 的产品体验仍可继续完善；
- 多进程 Worker 明确属于 Phase 5，当前仍受进程内 EventBus、Gate、admission permit、公平游标和 live process cache 限制。

## 14. 命名迁移表

由于 Morphz 尚未正式发布，不需要为了历史 API 保留不合适的命名。建议在语义实现收口时一次性迁移。

| 旧名称 | 推荐名称 | 中文 |
|---|---|---|
| Session Dialogue Gate | `DialogueLane` 的执行约束 | 对话通道 |
| `WorkThreadRecord` | `ThreadRecord` | 线程记录 |
| `WorkThreadKind` | `ThreadKind` | 线程类型 |
| `WorkThreadKind::Dialogue` | `ThreadKind::DialogueTurn` | 有限对话轮次 |
| `WorkThreadKind::Work` | `ThreadKind::Execution` | 执行线程 |
| `WorkThreadStatus` | `ThreadLifecycle` + derived `ThreadPhase` | 生命周期与调度阶段 |
| `EvaluationWorkItemRecord` | `ThreadActivationRecord` | 线程激活记录 |
| `EvaluationWorkItemStatus` | `ThreadActivationStatus` | 激活状态 |
| `EvaluationOutcomeCommit` | `ActivationOutcomeCommit` 或直接并入 Thread Outcome 事务 | 激活结果提交 |
| `ScheduledIntentRecord` | `ScheduleRecord` | 调度记录 |
| 持久 `BackgroundTask` 领域状态 | `ExecutionJob` | 执行作业；进程内 live handle/cache 可保留实现名 |
| 持久 `BackgroundTaskStatus` | `ExecutionJobStatus` | 作业状态 |
| 触发用 Event | `ThreadSignal` | 线程信号 |
| `wake` | 保留为 Scheduler 动作 | 唤醒动作 |
| `Model Attempt` | 保留 | 模型尝试 |
| `Objective` | 保留 | 持久目标 |
| `Delegation` | 保留 | 委托关系 |
| `Delivery Thread` | 保留 | 交付线程 |

## 15. 分阶段实现路线

### Phase 0：文档和不变量

- 本文成为 Scheduler Kernel 的领域语言基线；
- 固定 Dialogue Lane、Thread lifecycle/phase 和 Signal batch 三项 v1 语义；
- 为现有实体补充状态所有权和跨实体不变量测试；
- Dashboard 明确区分 Objective、Thread、Activation、Job 和 Signal；
- 不再增加新的平行“Task”状态机。

### Phase 1：Thread Signal 与统一事务边界

- 新增持久 `thread_signals`；
- 新增 `activation_signals`，原子记录每次 Activation 领取的有界 Signal 批次；
- 把 Event 事实与 mailbox 消费状态分离；
- 状态变更和 Signal 创建使用同一事务；
- 把 Thread lifecycle 与可推导 phase 分离；
- 统一 crash recovery 和 durable dispatch；
- `EvaluationWorkItem` 语义收口并重命名为 `ThreadActivation`。

### Phase 2：统一 Wait 与 Timer Engine

- **已完成。** Wait 的物理语义统一为“持久条件/owner 状态 + Timer 或精确 Event”，不强迫不同领域共享一个会混淆所有权的巨大枚举；
- Objective Timer、Schedule Timer、Background Wait 与 Activation lease 共用 dispatcher；
- 依赖完成使用持久事件驱动反向索引；
- 已移除这些生产者各自的 Tokio sleep 和固定间隔依赖轮询。

### Phase 3：Execution Job 持久化

单机持久控制面已经实现：

- 将普通物理工具 Action、后台进程和审批等待统一物化为 Execution Job；
- 持久化 Job 生命周期、claim/lease、heartbeat、副作用边界、取消意图、结果引用和终态 Event；
- Runtime 启动时统一 reconcile Job：安全的幂等前副作用 Job 可重新排队，不确定执行进入 `lost`；
- 后台 exec 的 live process group 与输出仍是进程内执行句柄，但 list/status/wait/kill 以持久 Job 为权威；
- Approval request/decision/grant 持久化，grant 与 Job claim 原子消费，拒绝形成显式终态；
- 同一 Activation 中的并行 Action 各自拥有确定性 Job 身份和终态 Event，全部 sibling 结束后才产生一个 batch-complete wake；
- 后台 Job 完成、强杀和终态 Event→Outbox 恢复已经进入同一控制面。

Phase 3 的单机物理取消链路已经收口：Activation caller 被取消时，已 spawn 的 executor 继续持有 Job 直至提交终态；尚未启动或等待审批且未越过副作用边界的 Job 会同时取消 Approval、写入确定性 Tool Event 并进入 `cancelled`；运行中的本机 exec 先持久化取消意图，再按 causal route 终止进程组，由 watcher 根据真实退出提交 `cancelled`。Runtime 不把 `cancel_requested` 本身当成终态，也不声称能回滚已提交的外部副作用；重启后无法证明结果的工作仍保守进入 `lost`。

### Phase 4：调度管理和公平性

当前单机范围已经完成：

- `schedule_tx` 的 inspect/pause/resume/reschedule/cancel，全部使用 expected revision CAS 和 Timer generation fencing；
- Runtime 固定 Admission Class、Agent→Context→Session 分层公平、aging 与有界背压；
- Dialogue/Delivery 的运行槽和内存窗口保留容量，使后台饱和时仍能对话和交付；
- overflow Activation 保留在 SQLite `queued`，由 notification-driven refill 恢复，不转换为失败；
- Delivery 使用持久小窗口合并同 Session 并发完成结果，并用 first-result max wait、generation fencing、确定性 Event/Outbox、不可变 Trigger Snapshot 和启动恢复保证边界；
- Objective pause/cancel 使用精确 Objective Evaluation/Activation 路由，Session 与兄弟 Objective 继续运行。

Phase 4 的单机调度管理闭环至此完成。每 Agent/Context/Session/Thread 的独立数字配额、每 Objective 资源预算和跨进程全局公平游标未纳入本阶段完成标准；它们是后续单机策略扩展或 Phase 5 的分布式资源治理问题，不影响当前统一任务调度内核可用。

### Phase 5：多 Worker 与分布式执行

**明确排除在当前实现目标之外。** Morphz 当前首先完成单机可证明的调度语义；不能因为数据结构带有 lease/fencing 字段，就宣称已经支持多个进程或多节点共同执行。

- 使用稳定 worker identity、lease、heartbeat 和 fencing token；
- 把进程内路由缓存降级为加速层；
- 允许多个 Runtime Worker claim Signal、Activation 和 Job；
- 根据部署规模选择 PostgreSQL 或专门的分布式存储；
- 只有在真正需要复制一致性时再考虑 Raft/Paxos，不把共识协议提前引入单机内核。

## 16. 暂不确定的设计点

以下问题应通过实现和测试继续验证，不应过早固定：

1. `WaitCondition` v1 是否只支持单一条件，还是直接支持 `any/all`；
2. Execution Thread 是否需要显式 `parent_thread_id`，还是通过 causal relation 表表达；
3. Delivery merge window 与最大等待时间的默认配置如何针对交互延迟和批量效率调优；
4. 模型能够在多大程度上可靠选择优先级、串行和并行；
5. Objective 与 Objective Thread 是一对一，还是允许一次 Objective 同时拥有多个推进 Thread；
6. 周期 Schedule 的每次 occurrence 应创建新 Thread，还是向长期 Thread 投递新 Signal；
7. Context pressure 下，哪些 dormant Thread 和 Signal 摘要应进入 Context Encoding。

这些属于策略和可扩展性问题，不影响统一内核的基本成立。

### 16.1 当前单机边界

当前 Runtime 的可靠性声明限定在**一个进程拥有一个 SQLite 调度数据库和本机 executor**的部署模型：

- EventBus、Dialogue/Work gate、Activation admission permit、公平 cursor 和 live process group cache 都是进程内对象；数据库是恢复权威，但这些对象还不是跨 Worker 协调协议；
- SQLite queued rows、lease 和 generation fencing 解决单机崩溃恢复与迟到写覆盖，不自动等价于多节点共识；
- 对已经越过外部副作用边界但结果未知的 Job，Runtime 选择 `lost` 而不是自动重放；exactly-once 外部副作用仍需要具体工具/服务提供幂等键或 reconcile 能力；
- Approval 可以持久等待和恢复，但自动 reviewer、人类 UI、密钥系统和 OS sandbox 是可替换 adapter，不应与 Scheduler Kernel 绑定为一种部署方式；
- Activation fairness 已跨 Agent/Context/Session 分层轮转，但容量上限当前仍以单机全局并发和保留槽为主，不是租户级资源治理系统；
- Objective scoped cancellation 已覆盖 executor cancellation resistance、未启动 Job/Approval 原子关闭和本机 exec 进程组终止；它保证可观测终态，不承诺撤销已经发生的外部副作用；
- `runtime/model_stream` 是进程内、best-effort 的 UI 草稿通道；丢失 delta 不影响持久回复正确性。Model Attempt 的机器状态以不可变 `runtime/model_attempt_state` 转换事件持久化，WebSocket 重连时由 Runtime 折叠为 `runtime/model_attempt_snapshot`；reasoning summary 在 Attempt 终态另行聚合为 `runtime/model_reasoning_summary`。这三者都属于可观测轨道，不进入 Agent 可见 Context。

## 17. 设计总结

Morphz 的核心不再是一个不断重复“模型响应—工具调用—模型响应”的顺序循环。它的统一结构是：

```text
Context 是认知环境
Session 是交互连接
Dialogue Lane 是 Session 中长期存在的对话排序通道
DialogueTurn Thread 是一次有限用户输入的因果边界
Thread 是有限、可等待、可恢复的持久因果执行流
Signal 是可消费的现实事实
Activation 是一次 Thread 求值运行
Model Attempt 是一次模型请求
Action 是模型提出的行为
Execution Job 是物理执行实例
Schedule 是未来 Signal 的生成规则
Objective 是长期推进承诺
Outcome 是唯一终态
Delivery 是结果路由
```

最重要的统一原则是：

> 所有“为什么继续执行”都归一为 Thread Signal；每个 Activation 原子领取一个确定、有界的 Signal 批次；所有“模型开始处理”都归一为 Thread Activation；所有“现实世界动作”都归一为 Execution Job；所有长期语义认知仍由 Agent 在 Context Mind 中自主维护。

在这一结构下，模型负责理解、计划、调度选择和语义判断，Runtime 负责因果、时序、并发、持久化、安全和恢复。两者共同构成 Morphz 的 Cognitive Scheduler。

## 18. 实现进度

### 2026-07-17：统一 Scheduler 领域接口

已经实现：

- Rust SDK、CLI、HTTP API 与 Dashboard 统一消费 `SchedulerQuery -> SchedulerSnapshot`；任何界面都不得从 Event 数量或进程内缓存猜测 Runtime 状态；
- `WorkThread*` 完整迁移为 `Thread*`，Thread kind 固定为 `dialogue_turn | execution | objective | delivery`；Delegation 保留为 Executor 关系，不再伪装成独立 Thread kind；
- `work_item_id` 迁移为 `activation_id`，`ScheduledIntent*` 迁移为 `Schedule*`；Context Encoding 与模型事件使用相同领域词汇；
- HTTP `GET /api/contexts/:context_id/scheduler` 与 CLI `morphz scheduler show` 返回同一 `SchedulerSnapshot`；`--format=json` 是 SDK/HTTP 契约的直接 JSON 表达；
- Dashboard 的 Scheduler Causality 视图按 Thread kind 显示“对话轮次 / 执行线程 / 目标线程 / 交付线程”，不再拼接原始存储值；
- SQLite 在启动时一次性迁移开发期的 `work_threads`、`work_thread_outcomes`、`scheduled_intents`、`scheduled_intent_dependencies` 与旧 activation 列名；Thread 的持久 discriminator/lifecycle 同时规范为 `dialogue_turn | execution | objective | delivery` 与 `open | completed | failed | cancelled`，保留历史事实但不保留双语存储或旧产品 API。

### 2026-07-22：Thread 活动语义与 Attention 处置闭环

- Thread lifecycle 与 Scheduler phase 正式解耦：`open + idle` 是可在未来恢复的非终态线程，不是当前执行；Dashboard 当前执行、分组和默认展开状态一律服从 `phase`；
- 失败/异常 Attention 使用源类型、源 ID、源 revision 与状态构造精确 fingerprint；确认只对该版本有效；
- Rust Runtime/SDK 与 HTTP 共同提供 Context 范围的 Attention acknowledgement 读取/写入接口；写入形成不可变 `runtime/attention_acknowledged` Event，不新增只属于 Dashboard 的旁路状态；
- Dashboard 对审批保留决策动作，对 Job/Delivery/invariant 异常提供因果链检查和持久“确认已知”；已处理项从当前关注列表自动消解，但继续留在 Ledger 和历史中。

### 2026-07-16：Phase 1 第一条完整纵切

已经实现：

- 新增持久 `thread_signals` 与 `activation_signals`；
- 同一 Thread 的 pending Signal 按 sequence、ID 确定性排序，并在一个 SQLite 事务中有界批量领取；
- queued/running Activation 对同一 Thread 实行 single-flight；并发 claim 只能产生一个 Activation；
- Activation 终态提交会在同一事务中 acknowledge 本批 Signal；之后到达或超出批次上限的 Signal 留给下一次 Activation；
- Runtime 启动时重新派发已经持久化但尚未领取的 pending Signal；
- `EvaluationWorkItem` 的 Rust 领域类型、Store API、Context Encoding 与 Dashboard API 已收口为 `ThreadActivation`；SQLite 旧表会原位迁移为 `thread_activations`；
- Activation 状态已收口为 `queued | running | succeeded | failed | cancelled`；旧 `waiting_tool / waiting_external` 数据迁移为已结束的 Activation；
- Thread 的权威 `lifecycle` 与派生 `phase` 已分离；Dashboard 与 Context Encoding 从 Signal、Activation、Schedule 和后台执行事实推导 phase；
- Context protocol v20 明确暴露 `current-activation`、确定性的 `signal-batch` 与 `concurrent-activations`。

第一条纵切当时尚未完成：

- 当前 Event 先跨过 Ledger 持久化边界，Orchestrator 随后才物化 Thread Signal；“状态变更 + Signal”尚未对所有生产者统一为一个数据库事务。已持久化 Signal 可以恢复，但 Event 已提交而 Signal 尚未生成的极窄崩溃窗口仍需由 durable outbox/dispatcher 收口；
- Schedule、Objective、Delegation 和后台任务仍各自拥有部分唤醒路径，尚未全部改为统一 Signal producer；
- 当时遗留的 SQLite 物理名称已在 2026-07-17 的统一领域接口迁移中完成收口；
- 通用 Wait Condition、统一 Timer Engine 和持久 Execution Job 属于 Phase 2/3，不在本次纵切范围内。

因此，本阶段证明了 Signal → Activation → Context Encoding → 终态 acknowledge 的内核闭环，但不把尚未统一的生产者事务边界误报为完成。

### 2026-07-16：Phase 1 durable outbox 收口

已经实现：

- 新增持久 `signal_outbox`。所有需要触发 Scheduler 的 Event 都把 Ledger 事实与 Outbox 投递意图放在同一个 SQLite 事务提交；
- Outbox 明确区分 `pending | materialized | discarded`。`pending` Event 在成功创建对应 `ThreadSignal` 之前不会消失；取消 Session 的迟到信号会显式进入 `discarded`，不会形成永久重试；
- `claim_thread_signal_batch` 在创建 Signal/Activation 的同一事务中把 Outbox 标记为 `materialized` 并绑定唯一 `signal_id`；重复 dispatch、并发 worker 和重复 Event append 都不能重新打开或重复消费这次投递；
- Runtime 启动时扫描 pending Outbox，运行期间也由弱引用后台 dispatcher 周期重试。进程在“Event 已提交、EventBus 尚未派发”窗口崩溃后，重启仍能恢复；
- User Message 的幂等 claim 事务现在同时写入 Outbox。客户端在提交后、publish 前断线或 Runtime 崩溃，不再丢失求值；
- Schedule occurrence 的状态推进、due Event 和 Outbox 在同一事务提交；
- Objective 的 evaluation lease、continuation Event 和 Outbox 在同一事务提交；过期 revision 不会留下孤立 Event；
- Delegation 的完成状态、result Event 和父 Thread Outbox 在同一事务提交；并发完成只能有一个提交者；
- EventBus 的可靠订阅边界只为真正会进入 `chat/*` 求值的 User/Tool Event 创建 Outbox；同一批工具中明确不唤醒模型的中间结果仍只进入 Ledger，不会制造额外 Activation；
- 对旧版已经落盘、后来才被选为 wake 的 Event，会先幂等补齐 Outbox，再执行 `dispatch_persisted`。

验证边界：

- 故障注入测试模拟了 User Event 与 Outbox 已提交、EventBus 尚未调用便进程退出；重新打开数据库后能够恢复为唯一 Signal/Activation；
- 原子回滚测试证明缺少路由的 Outbox Event 不会留下半条 Ledger 记录；
- Objective CAS 冲突不会留下 continuation Event/Outbox；Delegation 重复完成不会产生第二个 result Event；
- Signal batch、Activation single-flight、Schedule restart、Objective restart 与普通 Runtime 回归继续通过。

Phase 1 至此完成。当时仍然保留的独立 timer/sleep、依赖轮询和进程内 BackgroundTask 权威状态，分别被归入后续 Phase 2 的统一 Wait/Timer Engine 与 Phase 3 的持久 Execution Job，不再被误认为 Event → Signal 可靠性缺口；这些后续阶段现已完成单机收口。

### 2026-07-16：Phase 2.1 持久 Timer Engine 与 Schedule 纵切

已经实现：

- 新增持久 `runtime_timers`，统一表达物理时钟队列。Timer 只负责“何时重新检查 owner”，不拥有 Schedule、Objective 或 Job 的业务终态；
- Timer 使用 `pending | claimed | fired | cancelled` 状态、有限 claim lease 和稳定 generation。多个 Runtime worker 不能在租约有效期内同时领取同一代 Timer；worker 崩溃后，租约到期可由新 worker 恢复；
- Timer 的完成、重试和取消都校验 `id + generation + claim token`。handler 在处理旧 Timer 时即使推进了 owner 并写入新 generation，旧 worker 也不能把新 Timer 错误标为完成；
- Runtime 只启动一个动态 Timer dispatcher，根据数据库中最早到期时间休眠，并由新 Timer 的 Notify 提前唤醒，不再为每个 Schedule 创建独立 Tokio task/sleep；
- `Schedule` 已迁移为 Timer Engine 的首个语义 handler。一次性、周期性、依赖等待和重启恢复仍由 Schedule 解释，但到期排序、claim、重试和 crash recovery 已归一到 Timer Engine；
- Schedule occurrence 仍通过 Phase 1 建立的 Event + Signal Outbox 原子边界投递，因此 Timer 触发不会绕过 Thread Signal 内核；
- 增加 generation fencing、重复领取、过期租约恢复、Engine 单次触发、Schedule 依赖等待和重启恢复测试。

当时边界（已由 Phase 2.3/2.4 收口）：

- 这是 Phase 2 的第一条纵切，不代表 Phase 2 已完成；
- Schedule 的 Thread dependency 暂时仍以 Timer Engine 中的延迟重检表达，已经移除“每个依赖一个 Tokio sleep”，但尚未改为 `dependency_completed` 反向索引驱动；
- Background wake 和 Activation lease 尚未注册为 Timer Engine handler，仍保留现有唤醒实现；
- 通用 `WaitCondition` 领域结构将在上述生产者进入同一引擎时一起收口，避免先造一个没有真实消费者的抽象层。

### 2026-07-16：Phase 2.2 Objective wait/lease 纵切

已经实现：

- `ObjectiveWaitCondition::Timer` 不再创建进程内 `DashMap + tokio::spawn + sleep`；它以 `objective-wait:<objective-id>` 持久 Timer 表达，并以 Objective revision 作为 generation fencing；
- Objective evaluation lease 不再创建独立 sleep；每次真实 evaluation claim 会同步注册 `objective-lease:<objective-id>`，payload 绑定 evaluation ID，防止旧 lease 唤醒新的求值；
- Objective Supervisor 注册 `ObjectiveWait` 与 `ObjectiveLease` 两类语义 handler。handler 每次触发都重新读取 Objective 的权威 status、revision、wait condition、evaluation ID 与 deadline，Timer payload 不被当作当前事实；
- Runtime 重启时，Objective recovery/reconcile 会为数据库中只有 Objective 状态、尚无 Timer 的旧数据补齐持久 Timer，因此状态提交与 Timer 注册之间发生崩溃也不会永久丢失唤醒；
- Objective 进入终态、非 Timer 等待或完成 evaluation 时，会取消尚未 claim 的无效 Timer；已经 claim 的 Timer 不能被旁路覆盖为 `cancelled`，必须通过带 claim token 的 handler 结束，使审计状态准确反映物理触发；
- Timer wait 到期仍发布 `objective/wait_satisfied` 审计事实，随后由 Supervisor 创建新的 Objective 推进机会；evaluation lease 到期仍通过 Objective CAS 释放陈旧本地绑定并只恢复一次；
- 既有计时等待重启、过期 lease 重启、事件等待、并发 Session 路由和 Supervisor 连续推进测试继续通过；测试新增对持久 wait/lease Timer generation、状态及取消语义的直接断言。

当时边界（已由 Phase 2.3/2.4 收口）：

- Objective 的 Timer 型等待和 evaluation lease 已进入统一物理时钟队列；ToolTask、Delegation、Permission、UserInput、ExternalEvent 与 ResourceAvailable 等等待本来就是事件驱动，继续由精确 Event 匹配处理；
- Background wake、Activation lease 和 Schedule dependency 反向索引仍是 Phase 2 的剩余纵切；
- `WaitCondition` 的公共领域接口将在 Background/Activation 接入后统一命名，当前不改变已经稳定的 Objective 公共协议。

### 2026-07-17：Phase 2.3 Background wake 与 Activation lease 纵切

已经实现：

- `BackgroundTaskScheduler` 注册 `BackgroundWake` handler；后台任务默认只由完成事件唤醒。可选 Runtime watchdog 与 `check_task_after` 的显式检查点、任务终态取消都通过持久 `runtime_timers` 表达，不再为每次等待创建独立 sleep；旧 `wait_task(wait_secs)` 只保留为不向新模型展示的执行兼容别名；
- Background wake 使用 task `wake_generation` 做 fencing。重排等待会生成更高 generation，旧 claim 不能覆盖新检查点；到期 Event 先以 Event + Signal Outbox 原子提交，再执行进程内投递；
- 该纵切实现时，`BackgroundTask` 的物理进程所有权尚待 Phase 3 持久化。因此 Runtime 重启后如果 owner 已不存在，遗留 Timer 只会被审计为已消费，不会伪造“任务已完成”或虚假的工具输出；Phase 3 现已将其持久控制面迁移到 `ExecutionJob`；
- `ThreadActivation` 每次进入 `running` 都注册 `activation-lease:<activation-id>`，以 Activation revision 为 generation；snapshot 推进会续约新 generation，唯一终态提交会取消未 claim 的 lease；
- Activation lease 到期时 handler 重新读取权威 Activation 状态和 revision。陈旧代立即结束；有效过期 lease 重新投递已持久化的原始 trigger，由 Activation claim CAS 保证只恢复一次；
- Runtime 启动恢复会为仍由活跃 claimant 持有的 Activation 补齐/重挂 lease Timer；过期 lease 立即进入统一 Timer Engine，而不是创建进程内延时任务。

验证边界：

- 测试直接断言 Background wait 的持久 kind、generation、payload、重复重排与到期唤醒；
- orphan Background timer 的重启测试证明 Runtime 不会在物理进程已经丢失时编造结果；
- Activation 测试覆盖 claim 时持久化、正常终态取消、过期 lease 重启恢复和“只产生一次终态回复”。

### 2026-07-17：Phase 2.4 Schedule dependency 反向索引与 Phase 2 收口

已经实现：

- 新增 `schedule_dependencies(schedule_id, dependency_thread_id)` 持久反向索引；Schedule 创建与更新会在同一数据库事务内维护索引，旧数据在数据库启动时幂等回填；
- Thread 进入终态后，Orchestrator 通过 `dependency_completed(thread_id)` 一次定位所有仍为 queued 的依赖 Schedule。SQLite 使用单条 `UPDATE … RETURNING` 原子推进各 owner revision，避免并发通知时的 deferred-transaction upgrade 竞争；
- 每个被唤醒的 Schedule 使用新 revision 注册新 Timer generation。此前因依赖未满足而触发的旧 generation 直接进入 `fired`，不再在两秒后或其他固定间隔重新检查；
- Runtime 启动时会把 queued Schedule 引用的已终态 dependency 重新通过反向索引回放，关闭“依赖终态已经提交、进程内通知尚未发送便崩溃”的窗口；
- Schedule 到期仍重新读取所有 dependency 的权威 Thread lifecycle。反向索引只负责精准唤醒，不替代最终条件判断。

验证边界：

- 未满足依赖的 Timer 明确进入 `fired` 且不产生 Event，证明固定轮询已消失；
- 依赖终态通知会推进 owner revision 并投递一次；
- 两个并发终态通知即使分别产生新 generation，最终也只能提交一个 Schedule occurrence；
- 故障注入覆盖“依赖终态提交后、通知前崩溃”，重启 recovery 能补偿唤醒并保持单次投递。

Phase 2 至此完成。统一的物理时钟、lease、generation fencing、事件条件唤醒和启动恢复已经形成 Scheduler Kernel 的共同机制。该阶段尚为进程内权威的后台执行状态被明确留给 Phase 3，而不是误判为 Timer Engine 的缺口；Phase 3 现已完成 `ExecutionJob` 持久化。

### 2026-07-17：Phase 3.1 持久 Execution Job 控制面

已经实现：

- 新增持久 `execution_jobs`，用 `(activation_id, tool_call_id)` 的规范化摘要形成确定性 Job ID；同一 causal Action 精确重放返回既有记录，不能用相同身份替换请求或路由；
- Job 状态收口为 `queued | waiting_approval | running | succeeded | failed | cancelled | lost`，并持久保存 revision、worker/claim token、lease、heartbeat、副作用边界、取消意图、结果 Event/ref、exit code 和错误；
- Job claim、heartbeat、cancel request 和 terminal commit 全部使用 revision + claim-token fencing。Running Job 收到取消请求时不会立即伪造成 `cancelled`；只有 executor 的真实退出观察或恢复器的保守判断能够提交终态；
- 普通物理工具 Action 在执行前物化并 claim Job；工具输出为空时也提交明确的成功/失败事实，不再通过“没有输出”暗示调用尚未发生；
- 同一 Activation 中并行的物理 Action 各自提交 Job + 不可变结果 Event；所有 sibling 终态之后只产生一个 batch barrier Signal，保留 Function Calling transcript 的批次边界；
- 后台 exec 派生独立 child Job。`list/status/wait/kill` 从持久 Job 读取权威状态，进程内映射只保留当前 Runtime 的 PGID、输出和 watcher；kill 先持久化取消意图，再向进程组发送信号，watcher 根据真实退出提交 `cancelled`；
- Runtime 启动统一 reconcile 非终态 Job：`queued/waiting_approval` 保留；尚未持久化副作用边界且声明幂等的 running Job 可以 fenced requeue；其余结果不确定的 running Job 以 `lost` + 结果 Event 关闭，绝不自动重放非幂等 Action；
- 启动恢复会幂等修复已经 terminal 的后台 Job 在“Job/Event 已提交、Signal Outbox 尚未写入”窗口中的 delivery intent。

物理取消收口：

- Activation 的工具 executor 运行在独立 task 中；拥有 Activation 的 caller 被取消后，executor 仍负责把观测结果提交为 Job/Event 终态，不会把一个已物化 Action 留成无主 running；
- queued/waiting_approval Job 在未跨越副作用边界时会取消持久 Approval、唤醒进程内 waiter，并原子提交确定性的 cancelled Tool Event/Job 终态；
- Objective/Activation scoped cancellation 精确锁定其 Job；当前活跃 exec 通过 causal route 找到 PGID，先持久化取消意图，再 kill process group，最后由 watcher 提交真实退出终态；
- 取消、并发自然完成与重启恢复均通过 revision/claim fencing 收敛。`cancel_requested` 始终只是意图；如果 Runtime 重启后无法证明物理结果，则进入 `lost`，不会伪造 `cancelled` 或自动重放外部副作用。

Phase 3 的单机 Execution Job、Durable Approval 与物理取消控制面至此完成。

### 2026-07-17：Phase 3.2 Durable Approval Authority

已经实现：

- 新增持久 `approvals` 与 ExecutionJob/Approval 跨 authority 事务；需要能力扩张的 Job 在任何物理 claim 之前进入 `waiting_approval`；
- Approval identity 绑定 Job ID、规范化 Action、请求能力集合和 policy digest。数组型能力按集合规范化，字段顺序不能制造第二个授权；请求或策略变化必然产生不同身份；
- approval request Event 与 waiting Job/Approval 原子创建；精确重放返回同一 authority，不重复创建第二个请求；
- Allow/Deny/Cancel 的 authority 状态与 `runtime/approval_decision` 审计 Event 在同一 SQLite 事务提交。Event 由关联 Execution Job 补齐 `context_id/session_id/correlation_id/activation_id/thread_id/tool_call_id` 路由；精确重放可以修复旧数据中“状态已提交、审计 Event 缺失”的窗口，但不可覆盖冲突的不可变 Event；
- 自动 reviewer 和人工审批共用相同的 durable decision 状态。人工等待没有 Runtime 截止时间，普通 tool timeout 只从真正取得 grant 并开始物理执行后计算；
- Allow 生成稳定、一次性的 grant；grant 消费与 Job claim 在同一事务完成，并绑定 claim token。错误 Job、错误 request/policy、pending/denied 或已经消费的 grant 都不能启动执行；
- Deny/Cancel 形成明确工具输出与 `cancelled` Job terminal fact，并继续服从同一物理工具 batch barrier。取消与允许并发时，Pending 或 `Allowed + grant 尚未消费` 都可通过 revision fencing 收敛为 Cancelled；已经消费的授权不能被事后伪装为未执行；
- Runtime 重启后 pending Approval 仍可重新呈现给审批 adapter，allowed/denied/consumed 状态按持久记录恢复，不依赖旧进程中的 oneshot 才能解释 authority；
- Objective Supervisor 启动时会按 `context_id + objective.updated_at + 精确 topic` 检查 Permission、ExternalEvent 与 ResourceAvailable 的持久 Ledger 事实。因此进程即使在“审批/外部事件已提交、EventBus 尚未派发”的窗口退出，重启后也会复用 `wake_non_routed_event → reconcile` 清除等待并继续推进，而不会永久漏唤醒或制造第二套状态迁移。

### 2026-07-17：Phase 4.1 Schedule 控制面

已经实现：

- `schedule_tx` 新增 `inspect | pause | resume | reschedule | cancel`，控制操作一次只修改一个 Schedule；
- 所有写操作都要求最新 `expected_revision`。陈旧写返回当前记录供模型重新 inspect，不能盲目覆盖并发控制变化；
- pause/cancel 会使尚未领取的 Timer 失效；resume/reschedule 推进 Schedule revision 并创建新 Timer generation；
- 已被旧 worker claim 的 generation 即使迟到，也必须重新读取 Schedule 权威状态，不能把已经暂停、取消或重排的计划重新投递；
- reschedule 同时维护 dependency 反向索引，控制事务不会留下旧依赖路由或半更新 Timer 语义。

### 2026-07-17：Phase 4.2 Activation Admission、公平与背压

已经实现：

- Activation 只有取得 admission permit 后才能从 durable `queued` 进入 `running`；permit 跨越完整 Activation 直到 terminal persistence，而不是只包住一次 Provider 请求；
- Runtime 根据 Trigger Event 固定分类为 Interactive/Control、Delivery、Objective、Scheduled/Background、Maintenance，模型不能自行注入数字优先级；
- 同一有效 class 中按 Agent→Context→Session 分层 round-robin，并在 Session 内按持久 `(created_at, id)` FIFO；
- aging 按固定间隔逐级提升有效 class，避免低 class 在持续交互流量下永久饥饿；
- Runtime 为 Dialogue/Delivery 保留运行槽和内存排队位置。一般工作不能占满全部保留容量；一槽 Runtime 会自动归一化，避免保留规则使一般工作永远不能运行；
- in-memory window 满时 Activation 留在 SQLite `queued`，不失败、不丢弃。Store 使用有界 reserved/general candidate union，旧的一般工作 aging 后也不能把声明为 Dialogue/Delivery 的所有候选挤出查询窗口；
- permit/window 变化通过可保留通知触发 refill，Runtime 不轮询整张 Event Ledger；重启从 durable queued Activation 重建确定顺序。

当前边界：fairness cursor 是进程内加速状态，重启会重置轮转相位；容量控制仍是单机全局上限 + Dialogue/Delivery 保留槽，不等于每 Agent/Context/Session/Thread 独立数字配额。

### 2026-07-17：Phase 4.3 Objective Scoped Cancellation 与 Delivery Merge

已经实现：

- Objective evaluation registry 以 Objective ID、evaluation ID 和 Activation ID 建立精确绑定；pause/cancel 只通知这一 Evaluation 的 Activation，并持久请求取消它物化的非终态 Job；
- Objective 控制不再调用 Session-wide cancel/resume，因此同一 Session 的普通 Dialogue 和兄弟 Objective 不会因为一个 Objective 暂停而被抑制；
- 迟到的 Objective 结果仍需通过 Objective revision/status fence，不能在 pause/cancel 已生效后提交为新的权威进展；
- 后台 Execution Thread 完成不再立即为每条结果唤醒 Composer。Runtime 为 Session 持久维护一个 `delivery_flush` Timer：`due_at = min(latest + merge_window, first + max_wait)`；交互式 attached Execution 直接交付；
- 新结果推进 generation 并刷新短窗口，但不能越过第一条 pending 结果的最大等待边界；旧 generation、重复 claim 和 Runtime 重启均不能产生第二条 completion-ready wake；
- Timer handler 冻结本 generation 的 `completed_thread_ids/result_event_ids`，使用 Timer ID + generation 生成稳定 Event ID；Router fast path 在一个事务内追加 `chat/reply` 并标记 covered Thread，复杂批次则原子追加 `chat/thread_completion_ready` Event + Signal Outbox；
- Router 与可选 Composer 都只处理 Timer Snapshot 内仍为 pending/deferred 的结果；`chat/reply.covers` 与 `chat/no_reply.defer_covers` 只能确认同一组 ID，处理期间新完成的 Thread 留给下一次 Delivery；
- Runtime 启动扫描仍有 pending/deferred completion 的 Session 并补齐 Delivery Flush Timer，关闭结果已持久化但内存定时器尚未启动的崩溃窗口。

Delivery 验证已经覆盖：singleton 零模型透传、小型批次确定性合并、数量/字符/语义提示进入 Composer、第一条结果最大等待边界、Runtime 重启恢复、旧 generation 迟到 fencing、Fast Path 原子提交、Event/Outbox 幂等提交、旧 SQLite Timer CHECK 约束的无损迁移，以及“Trigger 之后到达的新结果不能被旧回复覆盖”的快照竞态。

Phase 4 已经形成单机调度管理闭环。每租户数字配额、跨进程公平、多 Worker claim 与分布式存储仍属于明确排除的 Phase 5 或后续单机策略增强，不属于本阶段完成标准。

### 2026-07-19：ActionGroup、Objective fencing 与 Model Attempt 生命周期收口

本轮把一次模型响应内的并发 Action 与一次模型请求本身分别收口为两个明确领域边界。

#### Action 与 ActionGroup

- `objective_create` 是控制面 prelude，不是普通 ActionGroup member。Runtime 先执行它、建立或收编 Objective Evaluation route，再允许同一响应中的物理 Action 越过副作用边界；
- prelude 结束之前不会持久化兄弟 Action 的结果，因此每个结果 Event 在第一次写入前就携带最终 `objective_id / objective_evaluation_id / objective_revision` route。Event 一旦写入即不可变，Runtime 不再用相同 ID 补字段重写；
- prelude 之后只有一个普通 Action 时不创建 Group，直接等待该 Action 的标准 tool result；有两个或更多普通 Action 时创建一个持久 `ActionGroup`；
- 每个 member 仍拥有独立 Execution Job、独立不可变结果 Event，并在完成时立即进入 Ledger 和前端可观测流；Group 不阻塞单项结果展示；
- 最后一个 member 以数据库事务推进 Group 到 `settled`，并原子写入唯一、确定 ID 的 `runtime/action_group_settled` Event 与 Signal Outbox。只有该 barrier 唤醒一次后继 Activation；并发完成、重放和 Runtime 重启不能制造第二次批次唤醒；
- attached delegation 的 `queued` 回执是持久可观测事实，但明确不产生父 Thread successor Activation；真正的 delegation result 才是唯一唤醒事实。

#### Objective Evaluation fencing

- Objective evaluation lease 的续约校验 Objective ID、evaluation ID、revision 和当前状态；旧 Evaluation 被取代后，heartbeat 会失去 fence 并取消其仍存活的 Activation；
- 每个物理 Action 在副作用边界之前重新校验所属 Objective Evaluation 是否仍然权威。失去 fence 时提交明确 cancelled 结果，而不是继续执行或静默丢失；
- Supervisor 创建后继 Evaluation 前释放并撤销旧绑定；重启恢复、lease 到期与在线推进使用同一 revision authority，不能同时复活两套 Evaluation。

#### Model Attempt 状态与流式超时

一次物理 Model Attempt 的状态机为：

```text
queued → streaming → waiting_final_output → settling → terminal
```

- `queued` 表示等待 Provider admission；`streaming` 表示请求已经进入 Provider；
- Provider 发出 reasoning summary 的 done 事件只推进到 `waiting_final_output`，其含义是“推理摘要已结束，等待工具调用、正文或 Provider 最终完成”，绝不等价于请求完成；
- `settling` 表示 Provider 流已经完成、Runtime 正在校验并提交结果；`completed / continued / protocol_invalid / failed` 为终态；
- 状态转换使用不可变 `runtime/model_attempt_state` Event，delta 仍走非持久 `runtime/model_stream`。WebSocket 先订阅 live stream，再查询并发送 active-attempt snapshot，关闭重连时遗漏 `started` 的竞态；
- Provider queue timeout、connect timeout、可重置 stream idle timeout 和可选 hard deadline 是四个不同概念。只要收到任何 SSE chunk，idle timer 就重新计时；默认不设置 hard deadline，不用墙钟上限打断仍持续输出的长 reasoning；
- reasoning-only 截断可以继续求值。`reasoning_continuation_safety_limit` 默认 `64`，设为 `None` 可关闭次数熔断；正常有进展的 continuation 不做指数退避。连续相同摘要达到 `max_stalled_reasoning_continuations`（默认 `3`）才按停滞空转提前熔断。该限制是事故保险，不是正常任务预算。

#### 已验证边界

- SQLite 与 PostgreSQL 运行同一 RuntimeStore conformance：ActionGroup 并发 member 提交只产生一个 settled transition 和一个 durable continuation；
- PostgreSQL conformance 同时覆盖独立 Store authority、Objective/Execution fencing 与两个 Runtime 的单次对话交付；
- attempt-loop 回归覆盖三 Action Function Calling transcript、reasoning continuation 正常完成/可配置安全熔断、stream idle reset、可选 hard deadline、attached delegation 唯一结果唤醒；
- Dashboard reducer 覆盖 reasoning done 与 response completed 的区分、断线 snapshot 恢复和终态清理。
