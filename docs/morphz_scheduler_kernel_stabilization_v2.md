# Morphz Scheduler Kernel v2 稳定化重构设计

> 状态：核心实现完成，进入运行期观察
>
> 日期：2026-08-01
>
> 适用范围：Thread、Activation、Objective、Thread Group、Signal、Execution Job、Delivery、Timer、Plan/Harness 与 Runtime 恢复
>
> 相关文档：[Scheduler Kernel 与领域命名模型 v1](./morphz_scheduler_kernel_and_domain_model_v1.md)、[受监督并发模型与实现设计 v1](./morphz_supervised_concurrency_model_v1.md)、[First-Class Objective Supervisor v1](./morphz_first_class_objective_supervisor_v1.md)、[Session Thread Model v1](./morphz_session_thread_model_v1.md)
>
> 全局实现状态索引：[Morphz Runtime 核心实现状态总览 v1](./morphz_runtime_core_implementation_status_v1.md)

## 1. 背景与问题定义

Morphz 已经验证了一组区别于传统顺序 Agent Loop 的核心能力：

- 用户对话与工具执行可以并发；
- 同一 Context 下的多个 Session 可以并发求值；
- 同一 Session 可以拥有多个 Objective 和 Execution Thread；
- 模型可以选择串行、并行、等待依赖、定时唤醒或创建子代理；
- Thread、Execution Job 和 Objective 可以跨 Runtime 重启恢复；
- 所有执行仍然共享 Agent 的 Mind，并保持 Session 路由和因果关系。

这些能力已经成立，当前问题不是领域方向错误，而是实现随着功能演进形成了过多互相重叠的状态写入路径。同一个因果事实可能同时被以下对象维护：

```text
Thread / Activation
Thread Group
Objective wait_condition
Event Ledger
Signal Outbox
Dispatcher 生成的 ThreadSignal
Supervisor / Reconciler 修复逻辑
Dashboard 的启发式状态推断
```

当其中任一写入失败、延迟或由旧版本生成了略有不同的数据，系统就可能出现：

- Group 已满足，但 Objective 仍等待该 Group；
- Thread 已完成，但 Activation 仍为 `running`；
- Objective 已有工作线程，Supervisor 又启动重复推进；
- barrier Event 已存在，但恢复器试图以相同 ID 写入不同内容；
- Signal Outbox 已生成，而真正需要执行的 Signal 被内部事件阻塞；
- Runtime 重启后恢复出重复线程；
- Dashboard 只能显示“等待某个信号”，却无法解释权威原因。

这些不是独立偶发 Bug，而是同一个架构问题的不同表现：

> 调度状态的权威来源不唯一，业务状态迁移没有统一原子提交边界，恢复器承担了过多语义重建职责。

Scheduler Kernel v2 的目标不是增加一套新调度器，而是把已经存在的调度语义收束为一个确定性的内核。

## 2. 设计目标

### 2.1 必须实现

1. **单一权威状态**：每一种运行时事实只能有一个权威来源。
2. **原子因果提交**：一次业务迁移涉及的状态、事件和内部 Signal 必须在同一数据库事务中提交。
3. **统一写入口**：所有控制面、模型工具、Harness、Timer 和 HTTP API 都通过 Kernel Command 修改调度状态。
4. **持久依赖关系**：Objective 和 Thread 的等待必须表示为可查询、可满足、可审计的依赖，而不是文本或单个枚举值。
5. **故障安全恢复**：进程被取消、数据库繁忙、Provider 失败或 Runtime 重启后，不得丢失推进机会，也不得重复产生语义事实。
6. **后端一致性**：SQLite 与 PostgreSQL 必须通过同一套 Kernel Conformance Suite。
7. **可解释快照**：Dashboard、CLI、SDK 和 HTTP API 从统一 `SchedulerSnapshot` 读取状态，不再各自猜测。

### 2.2 不在本轮范围

- 不重写已经成立的 Thread、Activation、Objective 和 Job 领域概念；
- 不实现多机 Worker 调度算法；
- 不把模型决策改造成完全确定性的工作流；
- 不要求 Event Ledger 成为高频运行状态查询表；
- 不为未发布的旧 API 保留永久兼容层。

当前数据库中已经存在持久任务，因此迁移阶段需要有限的**数据兼容桥**。兼容桥只用于把旧持久状态迁移到新不变量，不构成长期产品 API。

## 3. 核心架构

Scheduler v2 分为三个层次：

```text
┌───────────────────────────────────────────────────────────┐
│ Policy / Controllers                                      │
│ Dialogue · Objective · Delivery · Timer · Plan/Harness    │
│ LLM decision · HTTP/SDK/CLI control                       │
└────────────────────────────┬──────────────────────────────┘
                             │ KernelCommand
┌────────────────────────────▼──────────────────────────────┐
│ Scheduler Kernel                                           │
│ validate → fence → transition → event → signal → commit   │
└────────────────────────────┬──────────────────────────────┘
                             │ KernelStore transaction
┌────────────────────────────▼──────────────────────────────┐
│ Persistence                                                │
│ SQLite / PostgreSQL · authoritative projections · Ledger  │
└───────────────────────────────────────────────────────────┘
```

### 3.1 Policy / Controllers

Controller 决定“想做什么”：

- Dialogue Controller 决定如何摄取和合并用户消息；
- Objective Controller 决定是否推进、等待、阻塞或完成目标；
- Delivery Controller 决定何时以及向哪个 Session 交付；
- Timer Controller 把到期事实转换为调度命令；
- Plan/Harness 把领域程序 lowering 为调度命令；
- LLM 通过工具表达调度决策；
- HTTP、SDK、CLI 和 Dashboard 提交控制命令。

Controller 不得直接同时写 Thread、Objective、Event 和 Signal 表。

### 3.2 Scheduler Kernel

Kernel 决定“这项迁移是否合法，以及如何原子发生”。它只执行确定性操作：

1. 读取权威行；
2. 校验 revision、generation、lease 和 fencing token；
3. 校验状态机允许的迁移；
4. 写入新的权威状态；
5. 追加不可变 Event；
6. 直接写入内部 ThreadSignal；
7. 更新必要的派生 Projection；
8. 提交事务并返回结构化结果。

Kernel 不调用模型，不执行物理工具，也不根据自然语言猜测业务意图。

### 3.3 Persistence

SQLite 与 PostgreSQL 只实现 Kernel 需要的事务原语。两种后端的行为必须一致：

- 相同 Command 输入产生相同状态迁移；
- 相同幂等键产生相同结果；
- 相同陈旧 revision 或 fencing token 被拒绝；
- 相同终态不能被二次提交；
- 相同故障注入点具有等价的回滚结果。

## 4. 权威状态表

Scheduler v2 冻结以下权威边界：

| 事实 | 唯一权威来源 | 非权威表示 |
|---|---|---|
| Objective 生命周期 | `objectives.status` + revision | Event、Frame、Dashboard 文本 |
| Objective 是否可推进 | 生命周期、依赖、Evaluation lease 的派生结果 | `wait_condition` 文本 |
| Thread 生命周期 | `threads.lifecycle` + generation | Event、消息卡片状态 |
| 当前物理求值 | 非终态 `thread_activations` | Thread phase 文本 |
| 物理工具执行 | `execution_jobs` | Tool output Event |
| Thread 唯一终态 | `thread_outcomes` 唯一约束 | Delivery 文本、Event |
| Group 成员与终态 | `thread_group_members`、`thread_groups` | barrier Event |
| 待处理工作 | `thread_signals` | Signal Outbox、Event topic |
| 等待关系 | `scheduler_dependencies` | Objective wait 展示字段 |
| 对外投递 | `deliveries` / external outbox | `chat/reply` Event |
| 历史事实 | Event Ledger | 所有实时 Projection |

原则：

> Event Ledger 记录“发生过什么”，Projection 回答“现在是什么”。不能通过反复扫描和解释 Ledger 来猜测实时调度状态。

## 5. Kernel Command

所有调度写操作使用显式 Command。初始命令集合如下：

```text
SpawnSupervisedGroup
SpawnThread
RegisterDependency
SatisfyDependency
ClaimActivation
RenewActivationLease
CommitActivationDecision
CommitExecutionJobOutcome
CommitThreadOutcome
ControlThread
ControlObjective
CreateSchedule
FireSchedule
RecoverExpiredLease
CommitDeliveryOutcome
```

每个 Command 必须携带：

```text
command_id          幂等身份
causation_id        直接原因
correlation_id      完整业务链路
actor               调用主体
expected_revision   乐观并发控制
generation          生命周期 fencing
issued_at            审计时间
payload              命令参数
```

模型的 `schedule_tx`、Harness 的 Typed Plan IR、Objective Supervisor、Timer Dispatcher、HTTP API 和 Dashboard 控制动作都必须 lowering 为这些命令，不能各自实现一套状态写逻辑。

## 6. 原子因果提交

### 6.1 Thread 终态提交

`CommitThreadOutcome` 是最关键的原子事务：

```text
validate Activation fence
  → terminalize Activation
  → terminalize Thread
  → insert unique ThreadOutcome
  → append immutable terminal Event
  → update ThreadGroup member
  → recompute ThreadGroup
  → if Group terminal:
       terminalize Group
       satisfy dependencies
       append barrier Event
       enqueue supervisor ThreadSignal directly
  → create/update Delivery entry
  → COMMIT
```

如果事务任一步失败，以上变化全部不可见。不存在“Thread 已结束，但 Group 未更新”或“Group 已满足，但 Objective wait 未清除”的中间状态。

### 6.2 Execution Job 终态提交

`CommitExecutionJobOutcome` 原子完成：

```text
validate Job claim / execution fence
  → terminalize Job
  → append Job outcome Event
  → enqueue owning ThreadSignal
  → COMMIT
```

Job 输出流可以增量持久化，但 terminal outcome 只有一次。

### 6.3 Objective 推进提交

当 Objective Evaluation 创建 required durable Thread 时，必须在同一事务中：

```text
create/reuse ThreadGroup
  → create Group members
  → create Threads
  → register Objective → ThreadGroup dependency
  → enqueue initial ThreadSignals
  → release/terminalize current Evaluation as appropriate
  → COMMIT
```

这样 Objective 不可能在 required Thread 仍运行时进入 `active + no wait`。

## 7. 持久依赖模型

当前 `ObjectiveWaitCondition` 只能表达一个被覆盖的等待值，无法可靠表示多个并发依赖，也容易在完成后遗留陈旧状态。v2 使用结构化依赖：

```text
scheduler_dependencies
├── id
├── owner_kind              objective | thread | delivery | plan
├── owner_id
├── owner_generation
├── dependency_kind         thread_group | thread | timer | approval | resource
├── dependency_id
├── dependency_generation
├── required
├── status                  pending | satisfied | cancelled | invalidated
├── satisfied_by_event_id
├── created_at
└── satisfied_at
```

### 7.1 就绪判定

Objective 可推进由查询派生：

```text
status == active
AND no active Evaluation lease
AND no required pending dependency
AND no explicit operator pause
```

Thread 可激活由查询派生：

```text
lifecycle == open
AND no live Activation
AND exists pending ThreadSignal
AND all required dependencies satisfied
```

### 7.2 展示层 wait condition

Dashboard 仍可以展示“等待 timer”“等待 Thread Group”“等待用户输入”，但这些是由 `scheduler_dependencies` 和 Signal 状态生成的 View，不再作为业务权威写回 Objective。

## 8. 内部 Signal 与 Outbox 边界

### 8.1 内部调度 Signal

同一 Runtime 数据库内的调度不再经过：

```text
Event → heuristic → signal_outbox → dispatcher → ThreadSignal
```

而是在 Kernel 事务内直接写：

```text
State transition + Event + ThreadSignal
```

因此应移除内部事件的 `event_needs_signal_outbox()` 启发式判断。是否唤醒、唤醒哪条 Thread，必须由正在执行的 Kernel Command 明确给出。

### 8.2 保留 Outbox 的场景

Outbox 只用于真实外部边界：

- Webhook、邮件、微信等外部消息投递；
- 远程 Execution Node 命令；
- 跨数据库或跨服务事件；
- 无法与本地状态共享事务的 Provider。

Outbox 解决的是“双写外部系统”的可靠性，不应用来连接同一数据库中的两张调度表。

## 9. Generation 与 Fencing

所有可被恢复、替换或取消后重启的执行实体都必须有 generation：

```text
Objective revision
Thread generation
Activation generation + lease token
ThreadGroup generation
ExecutionJob attempt/generation
Schedule generation
```

任何异步结果提交时必须验证自己仍属于当前 generation。旧 Activation、旧恢复探针、旧 Job 或旧 Timer 即使最终返回，也只能被记录为 stale outcome，不能修改当前权威状态。

暂停和恢复不只是 UI 状态切换：

- `pause` 使当前 generation 不再接受新 Activation；
- `resume` 明确创建或开放下一 generation；
- `cancel` 终结当前 generation；
- 恢复器只能领取 lease 过期但 generation 仍有效的实体。

## 10. Reconciler 的职责边界

Reconciler 只允许执行三类动作。

### 10.1 Lease recovery

- 回收租约过期且无活跃 owner 的 Activation；
- 回收租约过期的 Execution Job、Timer claim 和外部 Outbox claim；
- 使用 fencing token 重新入队或标记 lost；
- 不重写已经存在的业务终态。

### 10.2 External outbox retry

- 重试真正跨边界的投递；
- 按错误类别退避；
- 保留人工处置入口；
- 不从 Event 文本猜测应投递给谁。

### 10.3 Invariant audit and quarantine

- 检测不变量破坏；
- 记录诊断；
- 将单个坏实体隔离；
- 继续扫描其他实体。

Reconciler **不得**：

- 重新生成正常业务 Event；
- 猜测 Objective 应等待什么；
- 因为“看起来完成”而完成 Objective；
- 重新解释历史 Ledger 来创建新 Thread；
- 让一条坏数据终止整个周期恢复任务。

正常路径需要 Reconciler 补业务事实，意味着 Kernel 原子事务仍有缺口。

## 11. 不变量

Scheduler Kernel v2 至少持续验证以下不变量：

### 11.1 Thread / Activation

1. 一个 Thread generation 最多存在一个 live Activation。
2. terminal Thread 不得拥有 live Activation。
3. 一个有限 Thread 最多存在一个权威 ThreadOutcome。
4. Activation 提交必须匹配 Thread generation 和 lease fencing token。
5. paused/cancelled Thread 不得领取新 Signal。

### 11.2 Thread Group

1. Group 终态完全由成员权威状态和 Policy 决定。
2. Group terminal、barrier Event、依赖满足和 supervisor Signal 原子提交。
3. 同一 Group generation 最多一个 barrier Event。
4. 已存在的 immutable Event 不得被“修正”为新内容。
5. Group terminal 后不得新增当前 generation 的 required member。

### 11.3 Objective

1. 一个 Objective 最多有一个 live Evaluation lease。
2. 存在 required pending dependency 时不得调度 continuation Evaluation。
3. required durable Thread 必须在创建时原子绑定依赖。
4. Objective complete/blocked 必须有显式控制事实，不得由 UI 或 Reconciler 猜测。
5. Objective 结束时不得遗留可推进的 required dependency。

### 11.4 Signal

1. Signal 具有稳定幂等身份。
2. Signal 只能投递给声明的 Thread generation。
3. acknowledged Signal 不得再次激活同一 generation。
4. 内部 Signal 必须与引发它的权威状态迁移同事务。

## 12. Scheduler Snapshot 与可观测性

Dashboard、TUI、CLI、SDK 和 HTTP API 使用统一 Snapshot：

```text
SchedulerSnapshot
├── contexts
├── sessions
├── objectives
│   ├── lifecycle
│   ├── readiness
│   ├── dependencies
│   └── active_evaluation
├── threads
│   ├── lifecycle
│   ├── generation
│   ├── active_activation
│   ├── pending_signals
│   └── outcome
├── thread_groups
├── execution_jobs
├── deliveries
├── external_outboxes
└── invariant_violations
```

Snapshot 必须区分：

- 权威生命周期；
- 派生就绪状态；
- 等待原因；
- 最近业务进度；
- 需要用户操作的问题；
- Runtime 正在自动恢复的问题。

“需要关注”只展示必须由用户决策或无法自动恢复的事项。普通工具失败、SQLite BUSY 后自动重试、可恢复 Provider 错误不应污染用户注意力面板。

## 13. 故障分类与恢复策略

| 故障 | Kernel/Runtime 行为 | Objective 行为 |
|---|---|---|
| SQLite/PostgreSQL transient busy | 整个 Command 回滚并有界退避重试 | 不改变生命周期 |
| Provider first-byte timeout | 结束当前 Attempt，保留 Thread，按请求级策略重试 | 不自动 blocked |
| Provider stream stalled | 保留已持久内容，续接或重试 Attempt | 不自动 blocked |
| Execution Job 可重试失败 | Job 新 attempt/generation | 等待新结果 |
| Activation lease 过期 | fencing 后恢复或重新激活 | 不启动重复 required Thread |
| Runtime crash | 依据 lease 和 generation 恢复 | 依赖保持不变 |
| 非法终态/不变量破坏 | 隔离实体并报告诊断 | 仅明确无法推进时请求人工处理 |
| 用户 pause/cancel | Kernel 原子控制命令 | 遵守显式用户意图 |

Runtime 的内部基础设施错误不得直接把 Objective 标记为业务 `blocked`。`blocked` 表示 Objective 在当前事实和权限下无法继续，需要新的外部条件或用户决策。

## 14. 数据迁移

迁移遵循“先建立新权威，再停止旧写入”的顺序。

### 14.1 引入新表与字段

- `scheduler_dependencies`；
- 必要的 generation/fence 字段；
- 唯一终态和 live Activation 约束；
- Snapshot 查询需要的索引。

### 14.2 回填依赖

从现有权威对象回填：

- Objective 的有效 ThreadGroup wait；
- Objective-supervised durable Group；
- Timer、Approval 和 resource wait；
- 只回填能够由结构化 ID 证明的关系，不从自然语言文本猜测。

无法证明的旧状态进入诊断队列，由一次性迁移工具处理，不让周期 Reconciler 永久承担兼容逻辑。

### 14.3 双读与单写

迁移短期允许新 Snapshot 同时读取新依赖和可验证的旧 wait，但所有新写入只使用 Kernel Command 和 `scheduler_dependencies`。

### 14.4 删除兼容桥

数据验证完成后删除：

- 内部 `event_needs_signal_outbox()`；
- 正常路径 barrier repair；
- Objective wait 的业务写入；
- Controller 对多张调度表的直接写入；
- 根据 Event topic 推断 live 状态的 Dashboard 逻辑。

## 15. 实施阶段

截至 2026-08-01，Phase 0—5 的核心实现已经完成，Phase 6 的自动化故障与并发验证已完成本轮范围；长期 soak 属于持续运行验证，不再作为架构迁移的阻塞条件。

### Phase 0：行为冻结与故障基线（已完成）

- 整理现有状态机和所有写入点；
- 建立 Scheduler Conformance Suite；
- 为最近出现的恢复、barrier、旧 wait、重复 Objective Thread 等故障建立 fixture；
- 增加 invariant diagnostics，不改变主路径；
- 提交当前兼容性修复，确保已有数据库可启动。

完成标准：所有已知故障都有可重复测试，SQLite/PostgreSQL 行为差异可见。

### Phase 1：SchedulerKernel Facade（已完成）

- 定义 `KernelCommand`、`KernelResult` 和 `KernelError`；
- 建立统一事务接口；
- 先迁移 Objective + ThreadGroup 热路径；
- Controller 不再直接拼接 barrier Event 和 Signal。

完成标准：required durable Thread 创建和终态收口只经过 Kernel。

### Phase 2：持久依赖与 Readiness（已完成）

- 引入 `scheduler_dependencies`；
- Objective continuation 改为 readiness 查询；
- wait condition 降为展示 Projection；
- 防止 satisfied Group 残留等待与 open Group 触发重复 Evaluation。

完成标准：Objective 的调度不依赖单个可陈旧 wait 字段。

### Phase 3：内部 Direct Signal（已完成）

- Kernel 事务直接写 ThreadSignal；
- 移除内部 Signal Outbox；
- Outbox 只保留外部边界；
- EventBus 不再负责把业务 Event 翻译为内部调度事实。

完成标准：内部唤醒没有 Event→Outbox→Signal 循环等待路径。

### Phase 4：统一终态事务（已完成）

- Thread、Activation、Group、Dependency、Delivery 原子收口；
- Job outcome 与 owning Thread Signal 原子提交；
- 删除正常路径 barrier repair；
- Reconciler 只处理租约、外部 Outbox 和不变量。

完成标准：故障注入到任意事务步骤都不会产生部分终态。

### Phase 5：拆分 Orchestrator（核心边界已完成）

将当前大型 Orchestrator 拆为：

```text
scheduler/kernel
scheduler/commands
scheduler/store
scheduler/snapshot
controllers/dialogue
controllers/objective
controllers/delivery
controllers/timer
controllers/plan
recovery/reconciler
```

完成标准：Controller 只表达策略，Kernel 独占调度写权限。

### Phase 6：故障与并发验证（自动化范围已完成，持续 soak 中）

覆盖：

- Command 提交前、中、后进程崩溃；
- lease 过期与旧 owner 晚到结果；
- pause/cancel 与结果同时发生；
- Group 多成员同时终态；
- Runtime 重启与 Supervisor 同时推进；
- SQLite BUSY 与 PostgreSQL 多进程竞争；
- Event 重放、重复 Signal、陈旧 generation；
- Provider 超时、熔断探针取消和恢复；
- Dashboard 重连期间的 Snapshot 一致性。

完成标准：长期压力测试中不存在重复 required Thread、永久陈旧 wait、部分终态和无法解释的 live 状态。

## 16. 测试策略

### 16.1 Model-based state machine testing

使用简化状态机生成随机 Command 序列，并比较内存参考模型与 SQLite/PostgreSQL 最终状态。

### 16.2 Property testing

持续验证：

- 幂等 Command 不改变第二次结果；
- 任意失败点回滚后不变量仍成立；
- 任意合法并发交错至多产生一个权威终态；
- 依赖只有从 pending 到 satisfied/cancelled/invalidated 的单向迁移；
- terminal generation 不会重新变为 live。

### 16.3 Crash-point testing

在 Kernel 事务的每个逻辑步骤注入崩溃，重新打开数据库后检查：

- 要么事务完全发生；
- 要么完全没有发生；
- 不需要 Reconciler 创建缺失的业务事实。

### 16.4 Backend conformance

同一 fixture 同时运行 SQLite 和 PostgreSQL，包括唯一约束、事务隔离、claim、lease、revision conflict 和恢复行为。

## 17. 实装结果

### 17.1 Kernel Command 的实际 lowering

设计中的命令名称表达领域意图；源码不为每个近义动作保留一个重复枚举，而是 lowering 到以下可组合命令：

| 领域意图 | 实际 Kernel Command / 事务 |
|---|---|
| SpawnThread、CreateSchedule、创建 required Group | `SpawnSupervisedGroup` |
| ClaimActivation、RenewActivationLease | `TransitionActivation` |
| CommitActivationDecision、CommitThreadOutcome | `CommitThreadOutcome` / `commit_activation_outcome` |
| Objective claim、renew、finish、control | 对应的 fenced Objective Command |
| Dialogue Turn 失败后重启 | `RestartDialogueTurn` |
| Execution Job 终态、结果 Event、Thread 唤醒 | `CommitExecutionJobOutcome` |
| Delivery Timer、回复 Event、Delivery Thread | `CommitDeliveryOutcome` |
| RegisterDependency、SatisfyDependency | 同名结构化依赖 Command |
| FireSchedule | 持久 Timer claim 后提交精确 Signal / dependency satisfaction |
| RecoverExpiredLease | 仅由 Reconciler 执行物理资格恢复，不进入正常业务 Controller |

这样既保留设计语义，也避免为了名字对称创建多套能表达同一物理事务的写入口。

### 17.2 生产写入口审计

组装完成的 `MorphzRuntime` 创建一个共享 `SchedulerKernel`，并注入：

- Objective Supervisor；
- Orchestrator 的 Dialogue、Delivery 与模型求值路径；
- 模型可调用的调度工具；
- Execution Job Manager；
- HTTP、SDK、CLI 和 Dashboard 所复用的 Runtime 控制接口。

源码仍允许少数隔离单测在没有完整 Runtime assembly 时直接构造 Controller；这些 fallback 不是生产兼容路径。生产环境剩余的 Store 直写只属于两类：

1. Kernel 内部调用的后端原子事务原语；
2. Reconciler 对过期 lease、丢失 worker 和可重放物理 Job 的资格恢复。

Reconciler 不再创建 barrier、猜测 Objective wait 或补造 Thread 业务终态。

### 17.3 依赖、Signal 与迁移

- SQLite 与 PostgreSQL 均实现 `scheduler_dependencies`、owner/dependency generation fencing 及 Snapshot 查询索引；
- Objective readiness 从结构化依赖派生，旧 `wait_condition` 只在可验证的旧数据迁移中作为展示桥；
- 同库内部 Signal 与引发它的 Event/状态迁移同事务提交；
- 正常路径停止写入内部 Signal Outbox；旧 pending internal rows 只做一次性消费/清理；
- barrier Event 使用稳定不可变内容，正常路径不再依靠周期 repair 改写同一 Event ID；
- Thread terminal 会原子关闭 live Activation、清理 lease、更新 Group、满足依赖并产生精确唤醒。

### 17.4 已执行的验证矩阵

同一套 `runtime_store_conformance` 已在 SQLite 和真实 PostgreSQL 上通过，覆盖：

- Context revision/CAS 并发；
- Activation outcome 与 pause/cancel 控制竞争；
- Group 多成员并发终态与唯一 barrier；
- dependency owner generation 与 dependency generation fencing；
- Objective Evaluation claim、续租、完成和旧 owner 拒绝；
- Dialogue Turn retry 的精确重放；
- Execution Job + result Event + Thread Signal 原子终态；
- Delivery Timer + reply Event / Delivery Thread 原子终态；
- Thread terminal 对 live Activation 与 lease 的原子清理；
- SQLite/PostgreSQL 对相同 fixture 的语义一致性。

同时通过 Scheduler Kernel 单元测试、库编译检查与格式检查。尚未声称完成无限时长压力测试或数据库每条语句级别的穷尽式 crash injection；这些属于持续验证，而非再保留旧双写架构的理由。

## 18. 关键决策

本设计冻结三条不可退让的纪律：

1. **同库内部调度使用直接、持久、原子 Signal，不使用 Outbox 启发式转发。**
2. **等待是结构化持久依赖关系，不是一个容易陈旧的状态文本。**
3. **Reconciler 只能恢复物理执行资格，不能创造或猜测业务语义事实。**

由此得到 Scheduler Kernel v2 的最终定义：

> Scheduler Kernel 是 Morphz Runtime 中唯一能够修改调度权威状态的确定性事务内核。模型和各类 Controller 决定意图，Kernel 以 revision、generation、fencing、不变量和原子因果提交把意图变成可恢复的物理事实；Event Ledger 保留历史，Signal 驱动执行，Projection 呈现当前状态。

这不是削弱模型自主性，而是为模型自主调度提供一个不会因并发、取消、重启和部分失败而失真的物理基础。
