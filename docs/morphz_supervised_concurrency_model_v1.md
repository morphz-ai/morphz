# Morphz 受监督并发模型与实现设计 v1

> 状态：v1 已实现（SQLite/PostgreSQL、Runtime、SDK、CLI、HTTP API、TUI 与 Dashboard）
>
> 日期：2026-07-30
>
> 适用范围：Objective、Objective Evaluation、Execution Thread、Thread Activation、`schedule_tx`、结果检查、唤醒与恢复
>
> 相关文档：[Scheduler Kernel 与领域命名模型 v1](./morphz_scheduler_kernel_and_domain_model_v1.md)、[First-Class Objective Supervisor v1](./morphz_first_class_objective_supervisor_v1.md)、[Domain Harness Architecture v1](./morphz_domain_harness_architecture_v1.md)

> 当前实现说明（2026-08-01）：本文定义的监督语义仍然有效，但底层 lowering 已迁移到 Scheduler Kernel v2。Objective 依赖由 `scheduler_dependencies` 表达，内部唤醒使用 Kernel 事务中的持久 Direct Signal；下文的内部 Signal Outbox 和单字段 wait barrier 是 v1 的历史实现。最新写入与恢复边界见 [Scheduler Kernel v2 稳定化重构](./morphz_scheduler_kernel_stabilization_v2.md)。

## 1. 背景

Morphz 已经同时提供两种并发能力：

- **并发 Thread**：模型通过 `schedule_tx.spawn` 创建独立 Execution Thread；
- **并发 Objective**：模型创建多个 First-Class Objective，由 Objective Supervisor 持续推进。

两者都能产生并发，却不是同一层概念：

- Thread 是一次具体工作的持久因果执行流；
- Objective 是 Runtime 承诺持续提供推进机会、检查结果和处理恢复的长期控制对象。

当前模型通常倾向直接创建 Thread。这个偏好并不完全是模型判断错误，而是由当前接口形状造成的：

1. `schedule_tx.spawn` 只需要意图、时间、依赖和 Target，调用成本很低；
2. `objective_create` 需要声明长期目标、持久化原因和可选 Harness，语义成本更高；
3. 当前 `schedule_tx.spawn` 创建的 Thread 虽然是持久、可恢复的，却没有显式声明由谁监督；
4. Thread 的唯一终态可以证明“这条执行流结束了”，却没有统一回答“结果是否满足上层意图、失败后是否重试、应唤醒谁继续判断”。

于是出现一个结构性缺口：

```text
模型创建并发 Thread
        ↓
Thread 执行并提前完成、失败或误判
        ↓
没有持久监督者检查结果
        ↓
上层任务看似仍在进行，实际已经失去推进机会
```

本文不为 Thread 再复制一套 Objective 生命周期，而是在已有 Scheduler Kernel 上补全**监督关系**。

## 2. 核心结论

Morphz 的并发模型采用以下层级：

```text
Objective                         持久推进承诺，可选
└── Objective Evaluation          一次有界的目标推进与判断周期
    ├── Thread                    一条具体因果执行流
    │   └── Thread Activation     Thread 的一次实际运行
    │       ├── Model Attempt     一次 Provider 请求
    │       └── Execution Job     一次现实动作
    └── Thread Group              一组具有共同等待语义的 Thread
```

普通对话不必先创建 Objective，但仍存在一次有界 Evaluation：

```text
Dialogue Turn Evaluation
├── 当前 DialogueTurn Thread
└── attached Execution Thread(s)
```

最重要的不变量是：

> 任何在创建它的 Evaluation 结束后仍要继续运行、恢复或交付的 Thread，都必须绑定一个 Objective。

因此 Thread 的运行寿命只能属于三类之一：

```text
attached       由当前 Evaluation 监督；Evaluation 必须检查其结果
durable        由一个 Objective 监督；可跨 Evaluation 和 Runtime 重启
disposable     明确允许无人监督、丢失或不交付的尽力执行
```

`durable` 是模型在调度接口中表达的生命周期意图；Runtime 内部将它物化为 `ObjectiveBound` 监督关系。

## 3. 领域边界

### 3.1 Objective

Objective 是长期控制承诺，回答：

- 这项工作是否仍有义务继续推进；
- 当前在等待什么；
- 哪些结果足以证明完成；
- 失败后是重试、改道、阻塞还是结束；
- Runtime 重启后是否必须恢复。

一个 Objective 可以在不同 Evaluation 中创建和监督多条 Thread。Objective 不等于一条 Thread，也不要求每一个并行分支都创建子 Objective。

### 3.2 Evaluation

Evaluation 是一次有界的语义判断周期，回答：

- 根据当前事实，下一步应该做什么；
- 是否需要创建并行 Thread；
- 是否应等待某些 Thread；
- 已返回的结果是否满足本轮预期；
- Objective 是否需要继续、调整、阻塞或完成。

Evaluation 不是一次 HTTP 请求。一次 Evaluation 可以包含多个 Model Attempt、工具结果 continuation 和 Thread 唤醒。

Evaluation 也不是长期 Objective。它必须在有限边界内：

- 完成并提交判断；
- 挂起并登记精确等待；
- 被取消；
- 或因不可恢复错误失败。

### 3.3 Thread

Thread 是具体工作的持久因果执行流，回答：

- 哪些 Signal、模型请求、工具调用和结果属于同一项工作；
- 这项工作当前处于什么阶段；
- 它最终以什么物理事实结束。

Thread 不负责决定 Objective 是否完成。Thread 只提交自己的权威 `ThreadOutcome`。

DialogueTurn 与 Execution 还具有不同的并发边界：

- DialogueTurn 占用持久化的 Session Dialogue Lane，连续未读的用户消息会按 Event History
  顺序合并为下一轮，而不是各自并发求值；
- 一旦本轮已经产生用户回复或持久化的物理执行计划，DialogueTurn 可以释放
  Dialogue Lane，让下一轮对话开始；
- 已释放 Dialogue Lane 的旧执行工作仍在自己的 Execution 因果链中继续，不会阻塞
  新对话，也不会被新对话吞并。

监督关系一经创建即不可被运行时启发式重写。为了兼容旧数据，v1 只允许一种受
revision fencing 保护的类型收窄：当且仅当已经持久化真实物理执行计划时，旧
`DialogueTurn` 可以转为 `Execution`；Context maintenance、reasoning continuation
或仅仅持有 Dialogue Lane 都不能触发这种转换。

### 3.4 Thread Activation

Activation 是 Scheduler 对某条 Thread 的一次实际运行：

- 领取一个确定、有界的 Signal 批次；
- 持有可续租 lease；
- 发起零到多个 Model Attempt；
- 创建 Execution Job 或新的调度计划；
- 最终提交本次 Activation 结果。

Activation 失败不必让 Thread 或 Objective 进入终态。Runtime 可以根据故障类型恢复同一 Activation、重新激活 Thread，或把失败事实交给监督者判断。

### 3.5 Execution Job

Job 是现实动作的权威状态，例如：

- 执行命令；
- 读取或修改文件；
- 传输 Artifact；
- 调用外部服务；
- 等待审批；
- 运行远程 Target 上的动作。

Job 成功不等于 Thread 成功；Thread 成功也不等于 Objective 完成。

## 4. Objective 与 Thread 不是二选一

模型进行并发决策时，应按工作生命周期选择，而不是在“Thread 或 Objective”之间任意二选一。

### 4.1 当前 Evaluation 内的并发：attached

适用条件：

- 工作边界明确；
- 结果将在当前问题的本轮判断中被使用；
- 父 Evaluation 能等待并检查所有必需结果；
- 不需要在父 Evaluation 结束后独立存活。

示例：

- 并行读取三个模块并汇总；
- 同时运行单元测试、类型检查和格式检查；
- 并行调研两个实现方案，本轮选择其一；
- 并行生成几个候选素材，本轮完成筛选。

语义：

```text
Evaluation
├── attached Thread A
├── attached Thread B
└── attached Thread C
        ↓
Runtime 等待必需 Thread 的 Outcome
        ↓
重新唤醒父 Evaluation
        ↓
父 Evaluation 检查、汇总并作出终态判断
```

父 Evaluation 可以向用户交付进度文本，但在必需 attached Thread 尚未终态前，不能把本轮工作误报为已经完成。

### 4.2 同一个持久目标中的并发：durable + existing Objective

适用条件：

- 多条工作共同服务于一个长期 Objective；
- 每条工作可能跨越多个 Evaluation、等待或 Runtime 重启；
- 某一分支失败后，Objective 仍应调整计划并继续；
- 并行分支没有独立的用户级生命周期。

示例：

- 一本长篇小说的多个分卷检查共同服务于“全书完成”；
- 同一产品发布目标下并行开发后端、前端和迁移脚本；
- 同一审计目标下并行检查安全、性能和兼容性。

这些分支应绑定同一个 Objective，而不是机械创建多个子 Objective：

```text
Objective O
├── durable Thread A
├── durable Thread B
└── durable Thread C
```

Objective Supervisor 根据这些 Thread 的 Outcome 和完成契约决定下一次 Evaluation。

### 4.3 独立持久工作：durable + new Objective

只有当工作拥有独立生命周期时，才创建新的 Objective：

- 可以独立暂停、恢复或取消；
- 有自己的完成标准和资源预算；
- 即使父级工作结束，它仍应继续；
- 需要独立向用户呈现目标状态。

示例：

- 在修复产品问题的同时，独立建设一套长期性能基准；
- 同时推进两个互不依赖、各自可验收的项目；
- 创建一个长期定时监测目标。

### 4.4 尽力执行：disposable

`disposable` 只适用于调用方明确接受以下事实的工作：

- Runtime 不保证跨重启恢复；
- 不保证结果交付；
- 不保证失败后继续；
- 不允许它成为 Objective 完成所必需的证据。

典型用途是遥测、预取、缓存预热等 Runtime 内部优化。模型默认不应把用户要求的工作标成 `disposable`。

## 5. 监督关系

每条非 DialogueTurn Thread 都必须拥有明确监督关系：

```text
ThreadSupervision
├── EvaluationAttached
│   ├── owner_evaluation_id
│   ├── owner_thread_id
│   └── owner_generation
├── ObjectiveBound
│   ├── objective_id
│   ├── origin_evaluation_id
│   └── objective_revision_at_bind
└── Disposable
    └── origin_evaluation_id
```

约束：

1. 一个 Thread 同一时刻最多只有一个权威监督者；
2. `attached` Thread 必须拥有可恢复的父 Evaluation 路由；
3. `durable` Thread 必须绑定 Objective；
4. `disposable` Thread 不得成为强依赖；
5. 监督绑定必须在 Thread 创建事务中完成，不能先创建孤立 Thread 再补写；
6. attached Thread 可以原子提升为 Objective-bound Thread；
7. Objective-bound Thread 不能静默降级为 disposable；
8. 迟到的旧监督信号必须受 generation/revision fencing 约束。

### 5.1 attached 到 durable 的提升

父 Evaluation 发现 attached 工作需要超出本轮生命周期时，可以显式提升：

```text
attached Thread
    + existing/new Objective binding
    + supervision generation increment
    + parent Evaluation wait update
    = ObjectiveBound Thread
```

提升必须原子完成。父 Evaluation 随后不再以“必须等待 attached 结果”的身份持有它，而是把后续监督权交给 Objective。

## 6. Thread Group

一批并发 Thread 经常具有共同等待语义。Runtime 应提供 `ThreadGroup`，而不是要求模型通过多条松散 wait condition 自己拼接 barrier。

```text
ThreadGroup
├── id
├── owner_kind
├── owner_id
├── policy             all | any | quorum
├── required_count
├── member_thread_ids
├── generation
├── status
└── terminal_summary
```

v1 只需要可靠支持：

```text
all     所有必需成员终态后唤醒
any     第一个满足条件的成员终态后唤醒
```

`quorum` 可以保留在领域模型中，后续再实现。

Group 不吞并成员 Outcome。每条 Thread 仍独立提交结果；Group 只负责：

- 判断等待条件是否满足；
- 生成一次幂等 barrier Signal；
- 向父 Evaluation 或 Objective 提供成员结果索引。

如果同一次模型响应并发创建多个物理工具，它们仍使用已有 Action Group/batch barrier；Thread Group 用于多条独立 Thread，不能替代 Action Group。

## 7. ThreadOutcome

### 7.1 目标结构

当前 `thread_outcomes` 主要保存终态 Event 和交付 disposition。受监督并发需要把它扩展为可供上层检查的结构化结果：

```text
ThreadOutcome
├── outcome_id
├── thread_id
├── thread_generation
├── terminal_kind          completed | failed | cancelled
├── summary
├── result_event_id
├── artifact_refs[]
├── evidence_refs[]
├── check_results[]
├── unresolved_failures[]
├── terminal_event_sequence
├── created_at
└── delivered_at           optional
```

其中：

- `summary` 是结果摘要，不是唯一证据；
- `artifact_refs` 指向生成或修改的 Artifact；
- `evidence_refs` 指向 persisted Event、Job Result、测试报告等事实；
- `check_results` 保存确定性完成契约的验证结果；
- `unresolved_failures` 表示上层必须继续处理的问题；
- `terminal_event_sequence` 固定因果顺序；
- 用户交付状态与 Thread 终态仍然分离。

### 7.2 `lost` 的边界

`lost` 是 Execution Job 对外部副作用结果未知的物理状态，不直接增加为 Thread 的常规成功终态：

```text
Job lost
  → 唤醒 Thread 或监督者尝试 reconcile
  → 可以恢复：Thread 继续
  → 无法恢复：Thread failed，failure_kind=external_outcome_unknown
```

这样避免把“某个 Job 结果未知”和“整条 Thread 已经永久丢失”混为一谈。

### 7.3 唯一终态

Thread 终态事务必须同时完成：

```text
finish active Activation
+ update Thread lifecycle
+ insert unique ThreadOutcome
+ append immutable terminal Event
+ update Thread Group member state
+ append supervisor Signal Outbox when condition becomes satisfied
+ create Delivery entry when required
```

如果受数据库物理限制不能在一个事务内完成全部派生投影，最少必须把权威终态与幂等 Outbox 原子提交，后续由 Reconciler 修复投影。

## 8. 三层结果检查

受监督并发不能只检查“Thread 是否结束”。完成判断分为三层。

### 8.1 Runtime 结构检查

Runtime 可以确定性验证：

- 所有 required attached Thread 是否进入终态；
- 是否还有 pending Signal、running Activation 或 running Job；
- 是否存在 `lost` Job 或未确认外部副作用；
- required Artifact 是否存在并与摘要匹配；
- Thread Group barrier 是否满足；
- Outcome 是否引用了真实 Event；
- 同一 generation 是否只产生一次终态和一次 wake。

Runtime 只判断控制结构是否完整，不判断文学质量、产品体验或业务含义。

### 8.2 Harness 确定性检查

当 Evaluation 绑定 Harness 时，可以执行领域检查：

- 测试是否通过；
- 文件、接口或 Schema 是否存在；
- 构建、渲染或导出是否成功；
- 章节数量、字数或连续性检查是否满足；
- 视频时长、分辨率、音轨等是否符合契约。

Harness 输出进入 `check_results` 和 `evidence_refs`，而不是直接宣布 Objective completed。

### 8.3 Supervisor 语义判断

Objective Supervisor 唤醒模型，结合：

- 用户原始目标；
- 当前 Objective Mind Frame；
- Thread Outcome；
- Runtime 结构检查；
- Harness 检查；
- 最新用户补充；
- 兄弟 Thread 和 Objective 状态；

决定：

```text
continue
retry
reschedule
spawn replacement
wait
blocked
completed
failed
```

语义完成只能由绑定 Objective 的 Evaluation 明确提交，不能由某条 Thread 的成功自动推断。

## 9. 唤醒协议

### 9.1 attached Thread

attached Thread 终态后：

```text
ThreadOutcome committed
    ↓
update ThreadGroup
    ↓
group policy satisfied
    ↓
evaluation/thread_group_terminal Signal
    ↓
resume owner Evaluation
```

父 Evaluation 被唤醒时应一次看到完整 Group 快照，不能为每个 sibling Outcome 各启动一条重复模型链。

### 9.2 Objective-bound Thread

Objective-bound Thread 终态后：

```text
ThreadOutcome committed
    ↓
objective/thread_terminal Signal
    ↓
Objective wait condition satisfied or evidence updated
    ↓
Objective Supervisor creates next Evaluation
```

Objective 可以选择等待一组 Thread、立即检查单条失败，或继续推进其他分支。

### 9.3 disposable Thread

disposable Thread 的终态可以记录审计 Event，但默认不生成监督唤醒和用户 Delivery。

### 9.4 幂等与 fencing

每个监督 Signal 的幂等身份至少包含：

```text
supervisor kind
supervisor id
supervision generation
thread/group id
terminal outcome id
```

旧 Evaluation、旧 Objective revision 或旧 Group generation 的迟到 Signal 可以进入 Event History 审计，但不得创建新的有效 Activation。

## 10. `schedule_tx` 目标接口

### 10.1 设计原则

Runtime 继续提供统一 `schedule_tx`，不增加第二套并发工具。模型必须同时表达：

- 并行还是串行；
- 工作寿命；
- 监督者；
- 等待与完成条件；
- 依赖和 Target。

概念形式：

```lisp
(schedule
  (mode parallel)
  (lifetime attached)
  (completion (all threads))
  (spawn ...))
```

### 10.2 JSON 目标形状

attached 并发：

```json
{
  "operations": [
    {
      "op": "spawn",
      "lifetime": "attached",
      "client_id": "tests",
      "intent": "运行测试并返回失败摘要",
      "completion": {
        "required": true
      }
    }
  ],
  "group": {
    "policy": "all"
  }
}
```

绑定当前 Objective：

```json
{
  "operations": [
    {
      "op": "spawn",
      "lifetime": "durable",
      "objective": {
        "mode": "current"
      },
      "intent": "继续完成前端模块"
    }
  ]
}
```

原子创建独立 Objective 和首批 Thread：

```json
{
  "operations": [
    {
      "op": "spawn",
      "lifetime": "durable",
      "objective": {
        "mode": "create",
        "stated_objective": "持续建设性能基准并生成报告",
        "completion_criteria": "基准可重复运行且报告包含稳定性结论"
      },
      "intent": "建立首个基准方案"
    }
  ]
}
```

`objective.mode` 支持：

```text
current
existing(objective_id)
create(...)
```

不支持 `durable + none`。Runtime 必须拒绝无人监督的持久 Thread。

### 10.3 lowering 规则

```text
attached
  → 绑定当前 Evaluation
  → 加入本轮 Thread Group
  → 父 Evaluation suspend 并等待 barrier

durable + current/existing
  → 绑定 Objective
  → 写入 Objective wait/evidence route

durable + create
  → 原子创建 Objective、初始 Evaluation/监督绑定与 Thread

disposable
  → 显式 best-effort
  → 禁止作为 required dependency
```

### 10.4 模型提示与默认值

不能只靠提示词纠正模型偏好，接口本身必须消除模糊性：

1. `spawn` 必须显式填写 `lifetime`，不静默默认 durable；
2. 普通短任务优先建议 `attached`；
3. 当前存在 active Objective 且新工作属于同一目标时，建议 `durable + current`；
4. 只有独立生命周期才建议 `objective.mode=create`；
5. 模型对用户工作选择 `disposable` 时必须给出理由；
6. Runtime 对不合法组合在物理执行前拒绝，并返回可修正的结构化错误。

## 11. Evaluation 终态规则

Evaluation 只有满足以下条件之一才可收口：

```text
1. 没有 required attached Thread，且已提交本轮判断；
2. required attached Thread 全部终态，且结果已被本轮检查；
3. attached Thread 已原子提升为 Objective-bound；
4. Evaluation 被明确取消，并已处理其 attached children；
5. Evaluation 失败，Runtime 已把 children 取消或转交监督者。
```

不允许：

- 返回一句进度文本后遗留无人监督的 attached Thread；
- attached Thread 失败后不唤醒父 Evaluation；
- 父 Evaluation 被取消后 children 继续冒充受监督工作；
- 把 Thread `completed` 直接解释为 Objective `completed`；
- 依靠进程内 Future 或 EventBus 保持监督关系。

Evaluation 等待 attached Thread 时应释放模型 Provider 槽位和进程内执行栈。等待是持久控制状态，不是持有一个长时间 Future。

## 12. 故障与恢复

### 12.1 周期 Reconciler

Runtime 需要周期验证以下不变量：

1. Thread 已终态，但 attached 父 Evaluation 仍等待它：
   - 重新物化幂等 terminal/group Signal；
2. Thread 已终态，但 Objective wait/evidence 未更新：
   - 补发 Objective terminal Signal；
3. Activation lease 过期且没有 Outcome：
   - 恢复可安全恢复的 Activation，或记录失败事实并唤醒监督者；
4. attached Thread 仍 open，但 owner Evaluation 已终态：
   - 若存在合法 promotion 则重绑定；
   - 否则取消并记录 invariant violation；
5. durable Thread 没有 Objective：
   - 禁止继续派发，进入需要 Runtime 修复的孤儿状态；
6. Objective active、无 wait、无 Evaluation、无 runnable Signal：
   - 生成唯一 continuation Signal；
7. Group 已满足但没有 barrier Signal：
   - 按 generation 补发一次；
8. 旧 generation 的迟到 Signal：
   - 标记 acknowledged/discarded，不推进新监督者。

### 12.2 错误分类

错误必须先分类，再决定监督动作：

```text
transient provider/network/db busy
  → 保持 Objective/Thread open
  → 有界退避
  → 同一监督者继续

tool/input/precondition error
  → 提交失败 Outcome 或失败 Job 事实
  → 唤醒监督者修改计划

unknown external side effect
  → Job lost
  → 先 reconcile
  → 无法证明时由监督者/用户决定

cancel/pause
  → 精确作用于绑定的 Evaluation、Thread、Activation 和 Job
  → 不扩大到兄弟工作
```

一次偶发错误不得让 active Objective 静默失去推进机会。

### 12.3 Runtime 重启

重启恢复顺序：

```text
重建 admission 与核对监督关系
→ 恢复 Plan、Delegation、Job 与外部副作用边界
→ 修复孤儿 Thread、ThreadOutcome / Group 投影
→ 补齐 Supervisor Signal Outbox
→ 恢复 Objective Evaluation
→ 最后重新派发模型 Activation 并开放新的调度 admission
```

权威 Reconciler 必须先于 Activation redispatch 执行。在恢复完成前，不应同时创建
替代 Evaluation，从而避免旧、新两套执行并存，也避免恢复事务与新模型请求争抢同一
数据库写入边界。

## 13. v1 实现状态

本文定义的 v1 监督协议已经落到统一 Scheduler Kernel，而不是形成第二套并发系统：

1. `ThreadRecord` 持久保存 `lifetime`、监督者、监督 generation、父 Evaluation/Thread、Group 与完成契约；
2. `schedule_tx.spawn` 显式接受 `attached`、`durable`、`disposable`，并在物理执行前拒绝非法组合；
3. `durable` Thread 必须绑定当前、既有或原子新建的 Objective；
4. attached Thread 可以通过 revision-fenced 事务提升为 Objective-bound Thread；
5. SQLite 与 PostgreSQL 都持久化 Thread Group、成员、结构化 Outcome 和唯一 generation barrier；
6. Thread 的 completed、failed、cancelled 都在同一终态事务中更新 Outcome、Group 与监督唤醒；
7. required Group 未终态时，父 Evaluation 不会错误成功收口；
8. Objective wait condition 可以直接等待 Thread Group 或监督事件；
9. 启动恢复和周期 Supervision Reconciler 会修复缺失 barrier、终态未唤醒和失去监督者的 Group；
10. Context Encoding 会向模型呈现监督者、Group、完成契约、成员 Outcome 与下一步等待；
11. Runtime、SDK、CLI 与 HTTP API 共用同一个 revision-checked Thread 读取和控制契约；
12. TUI 与 Dashboard 均展示监督链、Thread Group、结构化 Outcome 与下一次唤醒原因。

迁移前创建的 Thread 不会被猜测成 attached 或 Objective-bound，而是明确标记为
`legacy` 监督关系。它们仍可读取和控制，但只有新协议创建或显式提升后的 Thread 才受
本文强不变量约束。

v1 的边界是单 Runtime 内核与现有多存储后端的一致监督语义。跨多个 Runtime Worker
的分布式执行仍需要数据库级 claim、全局 fencing 与故障注入验证；这属于分布式扩展，
不改变本文的领域对象和控制契约。

## 14. 持久化设计

建议在现有表上增加最小监督字段，而不是另建平行 Scheduler。

### 14.1 `threads`

新增：

```text
lifetime                       attached | durable | disposable
supervisor_kind                evaluation | objective | none
supervisor_id
supervision_generation
origin_evaluation_id
parent_thread_id
thread_group_id
completion_contract_json
```

约束：

```text
lifetime=attached  → supervisor_kind=evaluation
lifetime=durable   → supervisor_kind=objective
lifetime=disposable→ supervisor_kind=none
```

### 14.2 `thread_groups`

新增：

```text
id
revision
owner_kind
owner_id
policy
required_count
generation
status
created_at
updated_at
```

以及成员表：

```text
thread_group_members
├── group_id
├── thread_id
├── required
├── ordinal
└── outcome_id
```

### 14.3 `thread_outcomes`

保留当前唯一终态约束，增加：

```text
terminal_kind
summary
artifact_refs_json
evidence_refs_json
check_results_json
unresolved_failures_json
terminal_event_sequence
```

大体积报告和 Artifact 不直接内嵌在数据库 JSON 中，只保存有界摘要与 Artifact/Event 引用。

### 14.4 索引

至少需要：

```text
threads(supervisor_kind, supervisor_id, lifecycle)
threads(thread_group_id, lifecycle)
thread_groups(owner_kind, owner_id, status)
thread_group_members(group_id, required)
thread_outcomes(thread_id, thread_generation)
```

## 15. 实施记录

### Phase 0：契约冻结与现状审计（完成）

- 固定本文术语和三种 lifetime；
- 列出所有 Thread 创建入口；
- 列出所有 Thread terminal 入口；
- 列出 Objective、Delegation、Schedule 和 Delivery 的 wake 路径；
- 增加只读 invariant audit，先观测孤儿数量，不改变运行行为。

完成标准：

- 任意 Thread 都能追溯创建入口、父 Evaluation、Objective 和终态路径；
- Dashboard/诊断接口能显示“当前监督者未知”的旧数据。

### Phase 1：监督绑定（完成）

- 为 Thread 增加 lifetime 和 supervisor 字段；
- 扩展 `schedule_tx.spawn`；
- 新 Thread 创建时原子写入监督绑定；
- `durable + none` 预检拒绝；
- attached → ObjectiveBound 原子提升；
- Context Encoding 向模型呈现当前 Evaluation、Objective 和可用选择。

完成标准：

- 新创建的非 Dialogue Thread 不再出现监督者未知；
- 模型无法创建无人监督的 durable Thread。

### Phase 2：结构化 Outcome 与 Thread Group（完成）

- 扩展 ThreadOutcome；
- 实现 `all/any` Thread Group；
- terminal 事务更新 Group；
- Group 只产生一次 generation-fenced barrier Signal；
- Action Group 与 Thread Group 保持不同层级。

完成标准：

- 三条并发 attached Thread 只唤醒父 Evaluation 一次；
- 父 Evaluation 能读取全部成员 Outcome。

### Phase 3：Evaluation 与 Objective 唤醒（完成）

- attached terminal 路由到父 Evaluation；
- durable terminal 路由到 Objective Supervisor；
- Evaluation 不能在 required attached Thread 未处理时成功收口；
- Objective Supervisor 读取结构检查结果；
- 失败 Thread 也必须产生监督 wake。

完成标准：

- Thread 提前失败不会让上层静默停止；
- Objective 在任一分支失败后仍能调整计划或明确阻塞。

### Phase 4：结果检查（完成）

- Runtime Structural Validator；
- Harness check result 接入 Outcome；
- Objective completion 前校验 completion contract；
- Dashboard 展示 required、passed、failed、unresolved。

完成标准：

- “Thread 结束”“检查通过”“Objective 完成”在数据和 UI 中严格分离。

### Phase 5：恢复与一致性收口（完成）

- 周期 Supervision Reconciler；
- 启动恢复顺序调整；
- stale wait、terminal-without-wake、orphan durable Thread 修复；
- Objective Evaluation、Thread 和 Group 的 generation fencing；
- 故障注入覆盖数据库提交与 Signal 派发之间的崩溃窗口。

完成标准：

- 任意一次终态提交后崩溃，重启最多补发一次有效监督 wake；
- 不出现 Thread 已结束但 Objective 永久不推进；
- 不出现父 Evaluation 已结束但 attached Thread 仍无人监督运行。

### Phase 6：产品与可观测性（完成）

- Dashboard 显示监督链：

```text
Objective → Evaluation → Thread Group → Thread → Activation → Job
```

- Thread 卡片显示：
  - lifetime；
  - supervisor；
  - completion contract；
  - Outcome 检查；
  - 下一次唤醒原因；
- 支持按 Objective/Evaluation/Group 筛选；
- SDK、CLI、HTTP API 使用同一控制接口。

## 16. 验收场景

### 16.1 attached 并发成功

一个 Dialogue Evaluation 并发创建三条 attached Thread。三条全部成功后只产生一个 barrier Signal，父 Evaluation 检查三项结果并回复一次。

### 16.2 attached 分支失败

三条中一条失败。父 Evaluation仍被唤醒，能够选择修复、替换、降级或向用户报告；不能静默结束。

### 16.3 durable 无 Objective

模型提交 `lifetime=durable` 但没有 Objective。Runtime 在创建 Thread 前结构化拒绝，不留下孤儿记录。

### 16.4 同一 Objective 多 Thread

同一 Objective 并发运行前端、后端和迁移三条 Thread。单条成功不自动完成 Objective；Supervisor 汇总证据后再判断。

### 16.5 独立 Objective

模型原子创建一个新 Objective 和首条 Thread。父工作取消不影响新 Objective；新 Objective 可以独立暂停、恢复和完成。

### 16.6 attached 提升

父 Evaluation 发现工作需要长期等待，把 Thread 原子提升到当前或新 Objective。重启后由 Objective 恢复，父 Evaluation 不再持有陈旧 wait。

### 16.7 terminal wake 崩溃

ThreadOutcome 与 Outbox 已提交、进程在 Signal materialize 前崩溃。重启后只产生一次有效 barrier/supervisor Signal。

### 16.8 stale generation

旧 Evaluation 取消后，其 attached Thread 的迟到结果到达。结果保留审计，但不能唤醒新 generation 或覆盖新 Objective 状态。

### 16.9 lost Job

外部副作用结果未知。Runtime 不伪造 Thread 成功；先尝试 reconcile，无法证明时提交带证据的失败并唤醒监督者。

### 16.10 普通对话不受阻

Objective 和 durable Thread 并发工作期间，当前 Session 仍可创建 Dialogue Turn。普通对话能只读观察状态，但不会因看见 Objective 就接管它。

## 17. 设计纪律

本模型固定以下纪律：

1. Thread 是执行，不是承诺；
2. Objective 是承诺，不是执行；
3. Evaluation 是判断周期，不是 Provider 请求；
4. Activation 是运行实例，不是长期等待对象；
5. 每条非对话 Thread 都必须声明寿命和监督者；
6. durable 工作必须由 Objective 监督；
7. attached 工作必须回到父 Evaluation 检查；
8. disposable 工作不能成为必需证据；
9. Thread 终态、结果检查和用户交付是三个不同维度；
10. 失败也是必须唤醒监督者的终态事实；
11. Runtime 保证推进机会和结构完整，模型负责语义判断；
12. 不建立第二套 Scheduler，所有能力 lowering 到既有 Thread、Signal、Activation、Job、Outcome 和 Objective 内核。

## 18. 总结

Morphz 的目标不是限制模型使用 Thread，而是让每条并发 Thread 都处于正确的监督关系中。

最终模型不是：

```text
Thread 并发
vs
Objective 并发
```

而是：

```text
Objective 提供长期监督
Evaluation 提供一次有界判断
Thread 提供具体并发执行
Activation 提供实际运行
Outcome 提供权威终态事实
Harness 提供确定性检查
Supervisor 提供语义续推
```

这样既保留模型自主决定串行、并行和任务拆分的弹性，也避免“线程结束了，但没有任何人检查结果或继续推进”的失控状态。
