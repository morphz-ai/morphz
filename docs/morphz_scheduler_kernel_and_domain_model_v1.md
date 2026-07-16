# Morphz Scheduler Kernel 与领域命名模型 v1

> 状态：设计共识，待分阶段收口实现
>
> 日期：2026-07-16
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
- `Outcome`：Thread 的唯一终态结果。

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

### 3.4 Thread / Causal Thread

推荐公开名称：`Thread`。

推荐内部全称：`CausalThread`。

中文：执行线程、因果线程。

Thread 是一条具有稳定身份和因果边界的逻辑执行流。它可以跨越多次模型请求、工具调用、等待、Runtime 重启和结果交付。

不再建议把总称叫 `WorkThread`，原因是 Dialogue、Delivery 和 Objective 推进同样属于 Thread；`Work Thread` 还容易与操作系统 Worker Thread 混淆。

推荐的 Thread 类型：

```text
Thread
├── Dialogue       对话线程
├── Execution      执行线程
├── Objective      目标推进线程
└── Delivery       交付线程
```

其中：

- `Dialogue Thread`：处理一个 Session 的连续用户对话；
- `Execution Thread`：承载需要物理工具、依赖或长时间运行的工作；
- `Objective Thread`：承载一次 Objective 的实际推进求值，Objective 本身仍是独立的长期控制对象；
- `Delivery Thread`：汇总已经完成但尚未交付的结果，决定回复或延迟交付。

Delegation 不必成为独立 Thread 类型。它更适合表达“某条 Thread 由另一个 Executor 执行”的关系。

### 3.5 Thread Signal

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

### 3.6 Thread Activation

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

### 3.7 Model Attempt

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

### 3.8 Action

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

### 3.9 Execution Job

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

### 3.10 Executor 与 Delegation

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

### 3.11 Schedule

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

### 3.12 Objective

推荐名称：`Objective`。

中文：持久目标、执行目标。

Objective 是 Runtime 承诺持续提供推进机会的长期控制对象。它不是普通 Todo，也不是模型自由格式 Mind Frame 的替代品。

建议明确区分：

- `Goal`：Mind 中由模型理解、拆分和维护的语义目标；
- `Objective`：Runtime 持久化并监督生命周期的执行承诺。

Objective 不应拥有另一套独立 Scheduler。Objective Supervisor 是一种调度策略：它根据 Objective 状态和 Wait Condition，向对应 Thread 生成 Signal。

### 3.13 Outcome 与 Delivery

推荐名称：`ThreadOutcome` 与 `Delivery`。

中文：线程终态结果、结果交付。

同一个 Thread 只能产生一个权威 Outcome：

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
→ Dialogue Thread Signal
→ Dialogue Activation
→ Model Attempt
→ ordinary assistant text
→ Dialogue Turn delivered
```

没有工具调用时，不创建 Execution Thread，也不创建 Execution Job。

### 5.2 工具运行期间继续对话

```text
Dialogue Activation A
→ model requests physical action
→ create/fork Execution Thread W
→ create Execution Job J
→ Dialogue lane becomes available

User Message B
→ Dialogue Activation B
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

### 6.1 Thread 状态

推荐状态：

```text
runnable | running | waiting | completed | failed | cancelled
```

- `runnable`：存在尚未消费的 Signal；
- `running`：存在活跃 Activation；
- `waiting`：没有可运行 Signal，但存在明确 Wait Condition、Job、依赖或 Schedule；
- `completed/failed/cancelled`：终态，不再接受普通执行 Signal。

Thread 是“当前是否仍有工作生命”的权威状态所有者。

### 6.2 Activation 状态

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

### 6.3 Job 状态

Execution Job 是现实执行状态的权威来源。进程是否退出、网络调用是否完成、审批是否通过，都不能由 Thread 或 Mind 猜测。

### 6.4 Objective 状态

Objective 拥有长期控制生命周期和资源预算，但不重复拥有 Execution Job 状态。

### 6.5 UI 投影原则

Dashboard 不应通过最近一次 Event 文本猜测“正在执行”。状态必须从权威对象派生：

```text
Objective
└── Thread
    ├── active Activation
    ├── active/waiting Job
    ├── pending Signal
    ├── Wait Condition
    └── Outcome / Delivery
```

如果多个投影不一致，Runtime 应记录 invariant violation，而不是在 UI 中任选一个状态显示。

## 7. Wait Condition

等待是 Thread 的控制状态。推荐统一建模：

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
- 保证一个 Thread 只有一个权威终态；
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
4. 一个 Signal 最多被成功消费一次；重复投递必须幂等。
5. Tool/Job Result 只能进入其因果 Thread 的 mailbox。
6. 新用户消息不得继承旧 Execution Thread 的 Function Calling transcript。
7. 同一 Session 的 Dialogue 消息按明确的顺序策略求值。
8. 不同 Session 可以并行；Dialogue 与 Execution Thread 也可以并行。
9. 一个 Thread 只能提交一个权威 Outcome。
10. Thread Outcome 与用户 Delivery 必须分离。
11. Schedule 到期只产生 Signal，不直接宣称任务成功。
12. Objective 的等待、暂停和阻塞必须能够区分。
13. Runtime 状态转换和由此产生的 Signal 必须原子提交。
14. 重启恢复不得重复执行已确认的外部副作用。
15. 没有 Signal、Job、Schedule、Wait Condition 或 active Activation 的非终态 Thread 是孤儿状态，必须被检测。
16. UI 展示状态必须来自权威控制记录，不能来自陈旧日志文案。

## 10. 持久化调度内核

目标持久模型建议至少包含：

```text
threads
thread_signals
thread_activations
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
+ thread runnable → running
```

必须在同一事务完成。

### 10.2 Activation Suspend

```text
activation → succeeded
+ thread → waiting
+ create job / wait condition / schedule
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
+ thread → completed/failed/cancelled
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
in-process fast path dispatch
        ↓
acknowledge after activation materialized
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
    (status running)
    (origin-turn message-17))
  (activation
    (id activation-9)
    (caused-by
      (signal tool-result-8)))
  (signals
    (signal
      (kind tool-result)
      (job job-3)
      (status succeeded)))
  (objective-binding none)
  (root-input "...")
  (instruction "解释本轮 Signal，并决定回复、动作、等待、调度或终结 Thread。"))
```

普通 Dialogue Activation 可以看到其他 Thread 和 Objective 的只读摘要，用于诚实回答状态问题，但不得因此接管或推进未绑定的 Thread。

## 13. 当前实现映射

当前代码已经形成了 Scheduler Kernel 的主要骨架，但命名和状态仍处于过渡阶段。

| 当前实现 | 目标领域对象 | 说明 |
|---|---|---|
| `WorkThreadRecord` | `ThreadRecord` | 已具备稳定 `root_turn_id`、状态和 Delivery 信息 |
| `EvaluationWorkItemRecord` | `ThreadActivationRecord` | 当前仍混有 waiting 状态，后续应收口 |
| Event + `trigger_event_id` | `ThreadSignal` | 当前以 Ledger Event 兼任 mailbox trigger |
| `ScheduledIntentRecord` | `ScheduleRecord` | 当前将 rule、intent 和 occurrence 混在一起 |
| `BackgroundTask` | `ExecutionJob` | 当前主要驻留进程内，需持久化 |
| Tool Call | `Action` | 已有标准 Function Calling 表达 |
| ObjectiveRecord | `Objective` | 保留，Supervisor 应改为 Signal 生产策略 |
| DelegationRecord | `Delegation` | 保留，逐步改为 Executor 关系 |
| `work_thread_outcomes` | `ThreadOutcome` | 已具备唯一终态事务边界 |
| Completion Inbox + Delivery Thread | `Delivery` | 方向正确，继续保留 |

当前已经正确的部分：

- Session Dialogue Gate；
- Work/Execution Thread mailbox single-flight；
- Work Item claim、lease 和恢复；
- Thread 唯一终态 Outcome；
- `schedule_tx` 的原子提交；
- Work completion 与用户 Delivery 分离；
- 不同 Session、Dialogue 和 Execution 工作并发。

当前需要收口的部分：

- ThreadScheduler、ObjectiveSupervisor、BackgroundTask timer 各自维护唤醒；
- Thread、WorkItem、Objective、Delegation、Schedule、BackgroundTask 存在重复状态投影；
- 后台 Job 主要是进程内状态；
- 依赖满足仍采用周期轮询；
- 缺少统一 durable Signal queue；
- 缺少 Schedule cancel/reschedule/pause/resume；
- 缺少父子 Thread、Wait Reason、Priority 等明确关系；
- 调度公平性主要只有全局模型并发限制；
- 多进程 Worker 仍受进程内 EventBus、Gate 和缓存限制。

## 14. 命名迁移表

由于 Morphz 尚未正式发布，不需要为了历史 API 保留不合适的命名。建议在语义实现收口时一次性迁移。

| 旧名称 | 推荐名称 | 中文 |
|---|---|---|
| `WorkThreadRecord` | `ThreadRecord` | 线程记录 |
| `WorkThreadKind` | `ThreadKind` | 线程类型 |
| `WorkThreadKind::Work` | `ThreadKind::Execution` | 执行线程 |
| `EvaluationWorkItemRecord` | `ThreadActivationRecord` | 线程激活记录 |
| `EvaluationWorkItemStatus` | `ActivationStatus` | 激活状态 |
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
- 为现有实体补充状态所有权和跨实体不变量测试；
- Dashboard 明确区分 Objective、Thread、Activation、Job 和 Signal；
- 不再增加新的平行“Task”状态机。

### Phase 1：Thread Signal 与统一事务边界

- 新增持久 `thread_signals`；
- 把 Event 事实与 mailbox 消费状态分离；
- 状态变更和 Signal 创建使用同一事务；
- 统一 crash recovery 和 durable dispatch；
- `EvaluationWorkItem` 语义收口并重命名为 `ThreadActivation`。

### Phase 2：统一 Wait 与 Timer Engine

- 引入通用 `WaitCondition`；
- Objective Timer、Schedule Timer、Background Wait 共用 dispatcher；
- 依赖完成改为事件驱动反向索引；
- 移除每个 timer 一个 Tokio sleep 和固定间隔依赖轮询。

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

1. 一次 Activation 应消费一个 Signal，还是允许原子批量消费同一 Thread 的多个 Signal；
2. `WaitCondition` v1 是否只支持单一条件，还是直接支持 `any/all`；
3. Execution Thread 是否需要显式 `parent_thread_id`，还是通过 causal relation 表表达；
4. Delivery Thread 的合并窗口和最大等待时间；
5. 模型能够在多大程度上可靠选择优先级、串行和并行；
6. Objective 与 Objective Thread 是一对一，还是允许一次 Objective 同时拥有多个推进 Thread；
7. 周期 Schedule 的每次 occurrence 应创建新 Thread，还是向长期 Thread 投递新 Signal；
8. Context pressure 下，哪些 dormant Thread 和 Signal 摘要应进入 Context Encoding。

这些属于策略和可扩展性问题，不影响统一内核的基本成立。

## 17. 设计总结

Morphz 的核心不再是一个不断重复“模型响应—工具调用—模型响应”的顺序循环。它的统一结构是：

```text
Context 是认知环境
Session 是交互连接
Thread 是持久因果执行流
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

> 所有“为什么继续执行”都归一为 Thread Signal；所有“模型开始处理”都归一为 Thread Activation；所有“现实世界动作”都归一为 Execution Job；所有长期语义认知仍由 Agent 在 Context Mind 中自主维护。

在这一结构下，模型负责理解、计划、调度选择和语义判断，Runtime 负责因果、时序、并发、持久化、安全和恢复。两者共同构成 Morphz 的 Cognitive Scheduler。
