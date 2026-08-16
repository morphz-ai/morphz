# Morphz Dashboard / Runtime Console 全面审计（2026-07-26）

> 状态：第一批高置信度修正已完成；其余项目按优先级继续演进
>
> 审计基线：[Dashboard / Runtime Console 设计 v1](./morphz_dashboard_runtime_console_design_v1.md)、[产品界面与交付架构 v1](./morphz_product_surfaces_and_delivery_architecture_v1.md)、[Scheduler Kernel 与领域模型 v1](./morphz_scheduler_kernel_and_domain_model_v1.md)

## 1. 结论

Dashboard 的信息架构仍然成立：它是 Runtime 的可操作投影，不是传统聊天产品。但 Runtime 在此后新增或重构了 Thread、Activation、Schedule、Delivery、Identity、Execution Target、Recall、Context Encoding 和用量统计，Dashboard 的部分实现没有同步收口，形成了三类系统性偏差：

1. **把历史存在误判为当前活动**：`open` lifecycle、已消费 Signal、终态 Schedule 和历史 Execution Job 被部分组件当成正在运行或等待处理；
2. **同一事实被多个页面重新推导**：有的组件使用 Scheduler Projection，有的从 Event History、WebSocket 或数组长度猜状态；
3. **接口与展示层继续漂移**：部分请求绕过统一客户端，TypeScript DTO 手工复制 Rust 结构，错误、鉴权、空响应和 revision conflict 的行为不一致。

因此，本轮审计冻结以下原则：

```text
当前物理状态  ← Runtime 权威 Projection / Scheduler phase
历史因果事实  ← Event History + bounded causal history
低延迟增量    ← WebSocket（只做更新与失效通知）
用户操作      ← 统一领域命令接口（revision fenced）
```

历史事实不能删除，但也不能因为仍在事件历史中就显示成“当前待处理”。

## 2. 状态语义审计

### 2.1 Thread

`Thread.lifecycle = open` 表示线程仍可接受后续 Signal，不表示它此刻正在执行。

Dashboard 的当前活动必须只使用：

```text
phase = runnable | running | waiting
```

`phase = idle` 的 open Thread 属于可恢复的因果对象，只出现在因果历史或明确的 idle 分组中，不能进入“正在执行”。

### 2.2 Signal

“待处理信号”只能统计 `status = pending` 的 Signal。

旧实现同时展开：

```text
Thread.pending_signals
+ Activation.signals
```

这会把已经 claimed/acknowledged 的历史 Signal 再次计入待处理。更隐蔽的问题是 Scheduler Snapshot 对 Activation history 有界分页；页外 Activation 的已消费 Signal 会失去前端父节点，随后被错误放入 standalone pending bucket。于是没有任务运行时仍可能显示数百个“待处理信号”。

修正后：

- Runtime 构建 Snapshot 时只读取 pending Signal；
- summary 只统计 pending 状态；
- Activation 内部的已消费 Signal 仍作为相应 Activation 的历史因果事实展示；
- Dashboard 直接显示 `summary.pending_signals`，不再自行拼数组。

### 2.3 Activation 与 Model Attempt

Activation 是一次 Runtime 求值激活；Model Attempt 是其中一次物理 Provider 请求。Dashboard 不再把两者统称为模糊的 `Evaluation` 数量：

- Runtime 平面显示 Activation；
- Attempt 只在 Activation 因果链、streaming 或诊断区展示；
- reasoning 完成不等于 Attempt 完成，Attempt 完成也不必然等于 Thread Delivery 完成。

### 2.4 Schedule

任务板只展示当前可控制的 Schedule：

```text
queued | paused
```

`completed | cancelled` 留在所属 Thread 的因果历史中。这样既保留审计能力，又不会把历史定时规则显示成当前等待任务。

### 2.5 Objective、Job、Approval 与 Delivery

- Objective 是长期承诺，不等同于 Thread；
- Execution Job 的当前状态来自 Execution Projection；
- Approval 只有 `pending_human` 且因果 owner 仍能接收结果时才是用户可操作审批；
- failed/lost Job、失败 Delivery 和 invariant anomaly 进入“需要关注”，但必须提供合法动作或“确认已知”；
- revision-fenced 控制命令冲突后必须刷新权威 Projection，避免用户连续提交旧 revision。

## 3. 第一批已完成修正

### Runtime / HTTP Projection

- Scheduler Snapshot 只读取 pending Thread Signal；
- 修正 bounded Activation history 导致已消费 Signal 回流 pending bucket 的问题；
- summary 的 `pending_signals` 再次按状态防御性过滤；
- Thread detail 的 standalone Signal 同样只显示 pending；
- 增加回归测试，覆盖“Activation 被分页省略，但 acknowledged Signal 不能重新变 pending”。

### Dashboard 状态与展示

- “待处理信号”直接使用 Runtime summary，不再统计 Activation 历史；
- “等待”以 Thread `phase = waiting` 为准；
- Overview 的 Live Activity 排除 open+idle Thread，并按更新时间排序；
- 当前 Schedule 板排除 terminal history；
- Objective filter 在目标消失或切换 Context 后安全失效，不再产生 render/effect 状态竞争；
- Runtime Job、Lease 与 Thread Delivery 状态通过统一本地化映射展示；
- 用户可见术语从旧的“工作线程”统一为“执行线程 / Execution Thread”；
- Frame 生命周期计数移除浏览器原生延迟 tooltip，保留即时悬停说明和无障碍标签。

### API 传输层

- App 中的查询和命令统一走 `DashboardApiClient`；
- Bearer 身份、JSON 错误信封和 Safari/WebKit host fetch 行为只有一份实现；
- 命令接口允许成功的空响应；
- Schedule revision conflict 后刷新权威 Session/Scheduler Projection。

## 4. 仍需继续处理的问题

### P1：权威查询和性能

1. **Scheduler Snapshot N+1**：当前按 Activation 分别读取 Signal；长因果历史应改为批量查询或专用 Projection。
2. **全量轮询过重**：Session 页面 15 秒周期会重新加载较大 Event 页面、Overview、Scheduler 和 Usage；应改为 cursor/delta + 投影级失效。
3. **实时与轮询重复**：WebSocket 已经提供持久事件失效通知，轮询只应承担断线兜底，不应持续重复完整读取。
4. **Live/History 查询未完全拆分**：Runtime 页的 Execution Job、Lease 等仍可能使用包含终态历史的同一集合，应由 API 明确提供 live 与 paged history。

### P1：接口契约

1. **DTO 漂移**：Scheduler/Runtime TypeScript 类型仍手工复制 Rust 领域类型；应从稳定 SDK schema/OpenAPI 生成，或共享版本化 schema。
2. **部分面板错误被吞掉**：可选 `tryGet` 当前会让 Recall/lineage 等面板在失败时静默消失；需要局部错误态，并对 401/403 做全局鉴权处理。
3. **状态字段语义需显式化**：`open_threads`、`active_schedules` 等名称容易把 non-terminal 与 physically active 混淆；后续 API 应提供语义明确的分项计数。

### P2：前端结构与体验

1. `App.tsx` 仍是超大控制器，混合 Catalog、Session、Scheduler、streaming、Mind 和命令处理；应按领域 Surface 拆分 controller/hooks。
2. 生产 bundle 约 680 KB，需按 Overview/Dialogue/Scheduler/Cognition/Event History/Runtime 路由懒加载。
3. Objective 染色槽目前在 render 中同步修正 state，虽然可运行但不是稳健 React 模式；应改为 reducer 或事件驱动分配。
4. 因果卡片仍有 `A/J` 等内部缩写，需在不牺牲紧凑度的前提下提供清晰标签。
5. 空态、加载态、部分失败和 stale Projection 尚未形成统一视觉语言。

## 5. 后续实施顺序

```text
阶段 A  状态正确性（本轮已完成第一批）
  Signal / Thread / Schedule / Objective / Approval 边界

阶段 B  权威接口
  live/history 分离 + generated schema + typed partial errors

阶段 C  增量数据流
  event cursor + projection invalidation + reconnect snapshot

阶段 D  前端组件化与分包
  per-surface controller + lazy route + shared Runtime components

阶段 E  全页面体验复审
  loading / stale / empty / error / mobile / accessibility
```

第一批修正之后，用户再逐项挑选视觉和交互问题是合理的；此时页面至少建立在一致的 Runtime 事实之上，不会继续因为底层状态误判而反复修同一种表象。
