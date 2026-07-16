# Morphz Scheduler Kernel 与领域命名模型 v1

> 状态：设计与实现基线；Phase 0–2 已完成，Phase 3–5 为后续路线
>
> 日期：2026-07-17
>
> 适用范围：Runtime 调度、Session 并发、工具执行、Objective、Delegation、定时任务与结果交付
>
> 相关文档：[Session Thread Model v1](./morphz_session_thread_model_v1.md)、[First-Class Objective Supervisor v1](./morphz_first_class_objective_supervisor_v1.md)、[共享 Context 多 Session 架构](./morphz_shared_context_multisession_architecture.md)

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

当前的 `BackgroundTask` 应逐步收敛为 Execution Job。前台和后台不需要两套 Job 类型，区别只在于当前 Activation 是否同步等待，以及 Job 完成后如何生成 Signal。

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

Job 终态会原子地产生对应的 `ThreadSignal`，但不能直接伪造 Thread 已经完成。

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

Outcome 与“结果是否已经发送给用户”是两个维度。后台 Execution Thread 完成时，应先写入 Completion Inbox，再由 Delivery Thread 决定：

- 立即回复当前 Session；
- 合并多个完成结果后回复；
- 向另一个 Session 发送消息；
- 暂时 `deferred`；
- 明确不发送用户可见文本。

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
→ Delivery Thread decides how to notify Session
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
17. Runtime 状态转换和由此产生的 Signal 必须原子提交。
18. 重启恢复不得重复执行已确认的外部副作用。
19. `lifecycle=open` 且长期没有 Signal、Job、Schedule、Wait Condition 或 active Activation 的 Thread 是孤儿状态，必须被检测。
20. UI 展示状态必须来自权威控制记录，不能来自陈旧日志文案或未经验证的 phase 缓存。

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
schedules
schedule_occurrences           phase 2
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
+ create thread signal
```

必须在同一事务完成。

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

## 11. 公平性、优先级与背压

模型可以建议并发关系，但 Runtime 必须拥有物理资源控制权。

建议的调度维度：

- Provider 并发限制；
- Agent 并发限制；
- Context 并发限制；
- Session Dialogue 公平性；
- 每 Thread 最大并发 Job；
- 每 Activation 最大并行 Action；
- Delivery 延迟上限；
- Objective 配额和预算；
- 全局队列背压。

推荐的默认优先级方向：

```text
interactive dialogue
delivery of completed work
approval/user-visible control
active objective continuation
scheduled/background work
maintenance
```

这只是 Runtime 资源策略，不决定业务重要性。模型可以通过受限字段表达优先级建议，但不能绕过系统配额和安全限制。

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

当前代码已经形成了 Scheduler Kernel 的主要骨架，但命名和状态仍处于过渡阶段。

| 当前实现 | 目标领域对象 | 说明 |
|---|---|---|
| Session Dialogue Gate | `DialogueLane` | 已提供同 Session 首次求值顺序，但尚无独立持久 Lane 记录 |
| 每条 User Message 的 `WorkThreadRecord(kind=dialogue)` | `DialogueTurn Thread` | 当前按 `root_turn_id` 创建有限因果边界，方向与新决策一致 |
| `WorkThreadRecord` | `ThreadRecord` | 已具备稳定 `root_turn_id`、权威 lifecycle、derived phase 和 Delivery 信息；类型与物理表名尚待迁移 |
| `ThreadActivationRecord` | `ThreadActivationRecord` | 领域类型与状态已经收口，SQLite 物理表已迁移为 `thread_activations` |
| `ThreadSignalRecord` + Event | `ThreadSignal` | Event 保存不可变事实，Signal 保存 mailbox 消费状态 |
| `signal_outbox` | Durable Signal Outbox | Event 与投递意图同事务提交；dispatcher 幂等物化 Signal |
| `ScheduledIntentRecord` | `ScheduleRecord` | 当前将 rule、intent 和 occurrence 混在一起 |
| `BackgroundTask` | `ExecutionJob` | 当前主要驻留进程内，需持久化 |
| Tool Call | `Action` | 已有标准 Function Calling 表达 |
| ObjectiveRecord | `Objective` | 保留，Supervisor 应改为 Signal 生产策略 |
| DelegationRecord | `Delegation` | 保留，逐步改为 Executor 关系 |
| `work_thread_outcomes` | `ThreadOutcome` | 已具备唯一终态事务边界 |
| Completion Inbox + Delivery Thread | `Delivery` | 方向正确，继续保留 |

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
- Work completion 与用户 Delivery 分离；
- 不同 Session、Dialogue 和 Execution 工作并发。

Phase 3 以后需要继续收口的部分：

- Thread、Objective、Delegation、Schedule、BackgroundTask 仍存在部分重复状态投影；
- 后台 Job 主要是进程内状态；
- 缺少 Schedule cancel/reschedule/pause/resume；
- 缺少父子 Thread、Wait Reason、Priority 等明确关系；
- 调度公平性主要只有全局模型并发限制；
- 多进程 Worker 仍受进程内 EventBus、Gate 和缓存限制。

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
| `BackgroundTask` | `ExecutionJob` | 执行作业 |
| `BackgroundTaskStatus` | `JobStatus` | 作业状态 |
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

- 将后台进程、工具执行和审批等待统一为 Job；
- 持久化 Job 生命周期、执行边界、结果引用和 heartbeat；
- Runtime 启动时统一 reconcile Job 与 Thread；
- 加入取消传播和 lost worker 处理。

### Phase 4：调度管理和公平性

- 为 `schedule_tx` 增加 cancel、reschedule、pause、resume、inspect；
- 增加 Provider/Agent/Context/Session/Thread 多级并发配额；
- 增加优先级、公平队列和背压；
- Delivery 使用小窗口合并同 Session 的并发完成结果。

### Phase 5：多 Worker 与分布式执行

- 使用稳定 worker identity、lease、heartbeat 和 fencing token；
- 把进程内路由缓存降级为加速层；
- 允许多个 Runtime Worker claim Signal、Activation 和 Job；
- 根据部署规模选择 PostgreSQL 或专门的分布式存储；
- 只有在真正需要复制一致性时再考虑 Raft/Paxos，不把共识协议提前引入单机内核。

## 16. 暂不确定的设计点

以下问题应通过实现和测试继续验证，不应过早固定：

1. `WaitCondition` v1 是否只支持单一条件，还是直接支持 `any/all`；
2. Execution Thread 是否需要显式 `parent_thread_id`，还是通过 causal relation 表表达；
3. Delivery Thread 的合并窗口和最大等待时间；
4. 模型能够在多大程度上可靠选择优先级、串行和并行；
5. Objective 与 Objective Thread 是一对一，还是允许一次 Objective 同时拥有多个推进 Thread；
6. 周期 Schedule 的每次 occurrence 应创建新 Thread，还是向长期 Thread 投递新 Signal；
7. Context pressure 下，哪些 dormant Thread 和 Signal 摘要应进入 Context Encoding。

这些属于策略和可扩展性问题，不影响统一内核的基本成立。

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
- `work_threads`、`evaluation_outcomes` 等少量 SQLite 物理名称仍待后续迁移为最终领域名称；
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

Phase 1 至此完成。仍然保留的独立 timer/sleep、依赖轮询和进程内 BackgroundTask 状态，分别属于 Phase 2 的统一 Wait/Timer Engine 与 Phase 3 的持久 Execution Job，不再被误认为 Event → Signal 可靠性缺口。

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

- `BackgroundTaskScheduler` 注册 `BackgroundWake` handler；`exec` 的默认检查点、`wait_task` 的用户指定检查点以及任务终态取消都通过持久 `runtime_timers` 表达，不再为每次等待创建独立 sleep；
- Background wake 使用 task `wake_generation` 做 fencing。重排等待会生成更高 generation，旧 claim 不能覆盖新检查点；到期 Event 先以 Event + Signal Outbox 原子提交，再执行进程内投递；
- 当前 `BackgroundTask` 的物理进程所有权仍属于 Phase 3 的进程内 `ExecutionJob`。因此 Runtime 重启后如果 owner 已不存在，遗留 Timer 会被审计为已消费，但不会伪造“任务已完成”或虚假的工具输出；
- `ThreadActivation` 每次进入 `running` 都注册 `activation-lease:<activation-id>`，以 Activation revision 为 generation；snapshot 推进会续约新 generation，唯一终态提交会取消未 claim 的 lease；
- Activation lease 到期时 handler 重新读取权威 Activation 状态和 revision。陈旧代立即结束；有效过期 lease 重新投递已持久化的原始 trigger，由 Activation claim CAS 保证只恢复一次；
- Runtime 启动恢复会为仍由活跃 claimant 持有的 Activation 补齐/重挂 lease Timer；过期 lease 立即进入统一 Timer Engine，而不是创建进程内延时任务。

验证边界：

- 测试直接断言 Background wait 的持久 kind、generation、payload、重复重排与到期唤醒；
- orphan Background timer 的重启测试证明 Runtime 不会在物理进程已经丢失时编造结果；
- Activation 测试覆盖 claim 时持久化、正常终态取消、过期 lease 重启恢复和“只产生一次终态回复”。

### 2026-07-17：Phase 2.4 Schedule dependency 反向索引与 Phase 2 收口

已经实现：

- 新增 `scheduled_intent_dependencies(scheduled_intent_id, dependency_thread_id)` 持久反向索引；Schedule 创建与更新会在同一数据库事务内维护索引，旧数据在数据库启动时幂等回填；
- Thread 进入终态后，Orchestrator 通过 `dependency_completed(thread_id)` 一次定位所有仍为 queued 的依赖 Schedule。SQLite 使用单条 `UPDATE … RETURNING` 原子推进各 owner revision，避免并发通知时的 deferred-transaction upgrade 竞争；
- 每个被唤醒的 Schedule 使用新 revision 注册新 Timer generation。此前因依赖未满足而触发的旧 generation 直接进入 `fired`，不再在两秒后或其他固定间隔重新检查；
- Runtime 启动时会把 queued Schedule 引用的已终态 dependency 重新通过反向索引回放，关闭“依赖终态已经提交、进程内通知尚未发送便崩溃”的窗口；
- Schedule 到期仍重新读取所有 dependency 的权威 Thread lifecycle。反向索引只负责精准唤醒，不替代最终条件判断。

验证边界：

- 未满足依赖的 Timer 明确进入 `fired` 且不产生 Event，证明固定轮询已消失；
- 依赖终态通知会推进 owner revision 并投递一次；
- 两个并发终态通知即使分别产生新 generation，最终也只能提交一个 Schedule occurrence；
- 故障注入覆盖“依赖终态提交后、通知前崩溃”，重启 recovery 能补偿唤醒并保持单次投递。

Phase 2 至此完成。统一的物理时钟、lease、generation fencing、事件条件唤醒和启动恢复已经形成 Scheduler Kernel 的共同机制。仍然进程内的后台执行主体属于 Phase 3 `ExecutionJob` 持久化，不再被误判为 Timer Engine 的缺口。
