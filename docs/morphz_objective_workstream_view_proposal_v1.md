# Morphz Objective Workstream View Proposal v1

> 状态：Proposal，仅记录概念与产品方向，暂不实现
>
> 日期：2026-08-17
>
> 关联能力：First-Class Objective、Session Service、Thread/Activation、`session_signal`、Dashboard Objective/Thread Filter

## 1. 结论摘要

Morphz 不应为了获得清晰的并发工作界面，让 Agent 自主创建大量 Session。当前更符合领域模型的方向是：

1. Session 继续表示持久的 IO、消息顺序和回复路由；
2. Objective 继续表示跨 Evaluation 持续存在的工作承诺；
3. Thread 继续表示实际执行链；
4. Dashboard 将现有 Objective Filter 提升为可交互的 **Objective Workstream View**；
5. Agent 的自主工作分解使用 Objective，而不是创建 Session；
6. `create_session` 暂不开放为普通 Agent 工具，Session 仍由 Human 或上层接入系统创建；
7. `session_signal` 仍然必要，但只负责真正的跨 Session 协调，不承担 Objective 内部工作分解；
8. 本 Proposal 只冻结概念边界，不授权当前迭代立即实现 Objective 定向输入或 Objective View Composer。

## 2. 问题背景

Morphz 已经支持：

- 一个 Context 下多个 Session 共享 Mind；
- 不同 Session 并发求值并分别路由回复；
- 同一 Session 下多个 Objective 通过独立 Activation 并发推进；
- Dashboard 按 Objective 和 Thread 过滤运行事件。

但当前用户可见的主消息流仍可能同时出现多个 Objective 的进度、工具结果、询问和交付。若直接模仿“一个任务一个聊天”的产品模型，让 Agent 为每个内部目标创建一个 Session，会产生两个问题：

1. Session 从 IO 边界退化为任务文件夹，与 Objective 的职责重叠；
2. 同一 Agent 创建 Session、再向新 Session 发送消息，容易呈现为 Agent 与自己对话，模糊主体边界。

Morphz 已经把认知主体、工作承诺、执行链和 IO 路由拆成不同对象，因此更合适的方向不是重新合并它们，而是把既有执行结构投影成清晰的工作视图。

## 3. Objective 与 Session 的正交边界

| 对象 | 核心问题 | 生命周期 | 是否拥有认知 | 是否拥有 IO 路由 |
| --- | --- | --- | --- | --- |
| Agent | 谁在认知和行动 | 长期 | 是 | 否 |
| Context | 共享什么认知状态 | 长期、版本化 | 拥有 Mind | 否 |
| Session | 从哪里输入、向哪里输出 | 开放式 | 否 | 是 |
| Objective | 当前承诺完成什么 | 有明确终态 | 否，语义认识仍在 Mind | 绑定 coordinator/delivery Session |
| Thread | 哪条因果执行链正在运行 | 有界 | 否 | 继承 Session/Objective 路由 |
| View | 用户当前观察哪部分事实 | 临时或用户偏好 | 否 | 否 |

因此：

- 多 Objective、单 Session，表示一个沟通渠道中并行存在多个工作承诺；
- 多 Session、单 Context，表示同一认知主体具有多个独立 IO 渠道；
- 二者都能并发，但并发的产品含义不同；
- 如果需求只是把并行工作显示清楚，应优先增加 Objective View，而不是增加 Session。

## 4. `session_signal` 为什么仍然必要

不开放 Agent 自主 `create_session`，并不意味着不同 Session 不需要协调。Session 可以由 Human、外部 Channel Adapter 或上层系统提前创建，并长期存在。

`session_signal` 的必要场景包括：

1. 用户在统筹 Session 中要求把一项信息发送给已经存在的开发 Session；
2. Web、CLI、移动端或外部连接分别映射为不同 Session，需要把工作结果路由到指定入口；
3. 同一 Agent 的不同 Human-owned 工作区需要显式传递约束、事实或交付结果；
4. Objective 的 `coordinator_session_id` 与 `delivery_session_id` 不同时，需要准确激活或通知目标 Session；
5. 通过 Dashboard 的 `@Session` 稳定引用选择目标，而不是依赖易变标题。

`session_signal` 应保持以下语义：

- 目标必须是已经存在且有权访问的 Session；
- 不隐式创建 Session；
- 信号属于同一 Agent 内部的因果协调事件，不伪装为 User Message 或 Assistant Reply；
- 信号进入目标 Session 自己的 Dialogue/Activation 路由并触发求值；
- 源 Session 与目标 Session、因果父项和实际 Principal 必须可审计；
- 它不等价于向目标 Session 注入完整源消息历史。

Objective 之间的协调不应默认借道 `session_signal`。它们共享同一 Session 时，优先通过 Objective、Dependency、Mind 和 Runtime Scheduler 表达；未来若确需主动唤醒兄弟 Objective，应单独定义 Objective 定向信号语义。

## 5. Objective Workstream View

### 5.1 核心定义

Objective Workstream View 不是新的 Runtime 所有权对象，也不复制 Event。它是依据现有稳定因果标识生成的投影视图，主要依据包括：

- `objective_id`；
- Objective 的 main Execution Thread；
- `root_turn_id`、`thread_id` 和 `activation_id`；
- Objective 产生或等待的 Tool、Schedule、Approval、Delegation 与 Delivery Event；
- 明确归属于该 Objective 的进度与最终交付。

Dashboard 可以形成如下层级：

```text
Context
└── Session：主工作台
    ├── 总览
    ├── Objective：论文实验
    ├── Objective：路演准备
    └── Objective：Benchmark 打榜
```

“总览”展示当前 Session 的完整因果消息流；Objective View 只展示与选定 Objective 有明确归属关系的事实。过滤不允许通过标题、文本相似度或模型猜测完成。

### 5.2 与当前 Filter 的区别

当前 Objective Filter 主要是诊断和观察能力。Workstream View 若未来实现，还需要增加：

- 稳定 URL 与可恢复的选中状态；
- Objective 标题、状态、预算、等待原因与最近活动摘要；
- 独立的未读、完成、阻塞和需要关注提示；
- 清晰标识当前 Composer 是普通 Session 输入还是 Objective 定向输入；
- 对 Objective 完成、取消、恢复后的视图行为作出确定定义。

它仍然是对同一 Event History 的投影，不创建第二份对话记录。

## 6. Objective View 中的输入语义

这是本 Proposal 最重要、也最需要谨慎验证的新增语义。

用户在 Objective View 中输入的内容，不应仅仅是一个带前端过滤条件的普通 User Message。否则消息仍会进入 Session Dialogue Lane，模型可能把它当作新的独立任务，也可能错误接管正在运行的 Objective。

未来可以引入一种明确的 **Objective-directed input**：

```text
Human input
  target_session_id = 当前 Session
  target_objective_id = 当前 Objective
  content = 补充、纠偏、询问或新的约束
```

Runtime 应：

1. 验证 Objective 属于当前 Agent、Context 和允许访问的 Session 路由；
2. 持久化稳定的 Objective 定向输入事件；
3. 不把输入附着到已经终结的旧 Activation；
4. 由 ObjectiveSupervisor 根据当前状态创建或唤醒合法的后继 Activation；
5. 将回复、进度和工具结果继续绑定到该 Objective；
6. 在 Session 总览中仍保留可审计事实，在 Objective View 中形成清晰工作流。

### 6.1 尚未冻结的调度问题

以下问题不能由前端自行决定，正式实现前必须形成 Runtime 协议：

- Objective 正在求值时，新输入是 steer、queue、parallel 还是要求用户选择；
- Objective 处于 waiting 时，输入是否解除等待，还是作为补充证据等待原事件；
- Objective 已 completed 时，输入是普通追问、创建新 Objective，还是显式 resume 新 generation；
- “询问状态”是否应该唤醒并占用 Objective 的执行租约；
- 同一 Objective 的多个 Human 输入如何排序、去重和回放；
- Objective 定向输入与 `objective_complete`、取消、审批和物理副作用的竞态如何收敛。

在这些问题冻结之前，不应把 Composer 简单接到现有 Objective API 上。

## 7. `@` 引用模型

Dashboard 的结构化引用未来可以同时支持：

```text
@SessionTitle   -> stable session_id
@ObjectiveTitle -> stable objective_id
```

两种引用必须保持不同语义：

- `@Session` 选择一个 IO 目标，可用于 `session_signal`；
- `@Objective` 选择一个工作承诺，可用于查询、补充事实、建立依赖或未来的 Objective-directed input；
- 引用只携带稳定身份与必要元数据，不自动注入完整消息历史；
- 重命名只改变展示标题，不改变引用身份；
- 重名对象必须显示 Context、Session、状态或短 ID 以便区分。

不建议当前就把两者折叠为一个没有类型的字符串 `@mention`。展示可以统一，Runtime payload 必须保留目标类型。

## 8. 与 Agent 自主性的关系

推荐的自主性边界为：

- Agent 可以根据长期、可恢复工作的需要创建 Objective；
- Agent 可以在既有权限内并行推进多个 Objective；
- Human 可以从 Objective Workstream View 观察、纠偏和终止工作；
- Agent 不因内部任务分解而自主创建 Session；
- Session 由 Human 或上层接入系统创建，表达真实 IO 拓扑；
- `session_signal` 只协调已经存在的 IO 路由。

该边界避免把 Session 误当作 Sub Agent 或 Objective，同时保留 Morphz 多 Session 共享认知的独特能力。

## 9. 非目标

本 Proposal 当前不要求：

- 实现 Agent 可调用的 `create_session`；
- 把每个 Objective 自动转换为 Session；
- 为 Objective 复制独立 Context 或消息历史；
- 允许 Objective View 绕过 ObjectiveSupervisor 直接驱动旧 Thread；
- 用自然语言标题推断 Event 归属；
- 立即统一 `session_signal` 与未来的 Objective 定向信号；
- 当前迭代实现 Objective View Composer。

## 10. 后续验证顺序

正式设计或实现前建议依次完成：

1. 使用当前 Objective/Thread Filter 验证“单 Session、多 Objective、分视图”是否已能解决消息混杂问题；
2. 用论文、路演和 Benchmark 三个并发 Objective 制作真实 Dashboard 交互原型；
3. 检查每类 Event 是否都有足够稳定的 Objective 因果归属，列出无法准确过滤的缺口；
4. 单独设计 Objective-directed input 的 Event、调度和竞态协议；
5. 再决定是否需要 `@Objective`、Objective 未读状态和独立 Composer；
6. 只有真实 IO 隔离仍然不足时，才重新评估 Agent-mediated `create_session`。

## 11. Proposal 验收标准

进入实现阶段之前，设计至少应能回答：

1. 为什么某条 Event 属于一个 Objective，且重放后结论不变；
2. 用户在 Objective View 输入消息时，Runtime 唤醒哪条控制链；
3. 活跃、等待、阻塞、完成和取消 Objective 分别如何处理新输入；
4. Objective View 与 Session 总览如何保持同一事实来源；
5. `@Session` 与 `@Objective` 如何在 API 和 Event 中保持稳定类型；
6. 哪些行为属于 Human IO 管理，哪些行为属于 Agent 自主工作分解；
7. 为什么该方案不会把 Objective 重新退化成一条隐式聊天记录。

只有以上边界被冻结并通过真实交互原型验证，Objective Workstream View 才适合进入实现计划。
