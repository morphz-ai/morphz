# Morphz Dashboard / Runtime Console 设计 v1

> 状态：v1 已实现；后续在同一领域模型上继续做体验与组件化演进
>
> 日期：2026-07-21
>
> 定位：Morphz 底层 Runtime 的可操作投影，而不是套用了任务卡片的聊天产品
>
> 产品边界：Dashboard 保留产品名称，`Runtime Console` 是功能定位；面向最终用户的 Web App、Desktop App 与紧凑 TUI 的关系见[产品界面与交付架构 v1](./morphz_product_surfaces_and_delivery_architecture_v1.md)
>
> 最新实现审计与分阶段收口见[Dashboard / Runtime Console 全面审计（2026-07-26）](./morphz_dashboard_runtime_console_audit_2026_07_26.md)

> 实施更新（2026-08-01）：Dashboard 已在本文领域模型上继续加入双轨/合流消息视图、Objective/Thread 过滤与控制、Operator Principal 搜索、Context/Session 管理、模型/推理强度/Context hard limit 持久控制、附件与 Artifact、Secret 管理、认知阅读器和移动端任务浮层。它仍是持续产品化的 Runtime Console；这些新增功能不改变 Web App/Desktop App 尚未进入主实现阶段的产品边界。

## 1. 产品定位

Morphz Dashboard 应正式定位为 **Runtime Console（Runtime 控制台）**。产品名称仍然是 `Morphz Dashboard`，不再另造一个平行名称。

聊天只是 Runtime 的一个交互入口。控制台还必须让用户真实看见：

- Agent、Context、Session 与 Principal 的关系；
- Shared Mind、Frame、Observation、Recall 与 Context Encoding；
- Objective、Thread、Signal、Activation、Schedule 与 Delivery；
- Model Attempt、Action Group、Execution Job、Executor 与 Approval；
- Ledger、Projection、Context pressure、恢复状态与诊断信息。

这不意味着把所有数据库表平铺到页面上。Runtime 概念必须被忠实表达，但通过**稳定层级、权威状态、渐进展开和因果钻取**组织起来。

控制台的目标不是让 Morphz 看起来像传统 Agent，而是让用户在不阅读源码的情况下理解：

> 当前是谁在与 Agent 交互，Agent 正在哪个 Context 中求值，哪些因果线程正在推进，现实动作执行到了哪里，Mind 如何变化，以及所有结论来自哪些事实。

## 2. 当前实现审计

当前 Dashboard 已经具备不少真实能力：

- Context/Session 创建与切换；
- Session 对话、流式正文与 reasoning summary；
- Objective 恢复和删除；
- Thread、Activation、Signal、Schedule、Execution Job 与 Approval；
- Delegation、工具调用参数与结果；
- Mind Frame、关系、生命周期、Recall 与 Context Inspect；
- Provider reasoning depth、主题和中英文切换。

问题不是“没有功能”，而是实现仍保留早期三视图模型：

```text
conversation | work | mind
```

主要结构问题：

1. `Tasks` 被放进 `Context / Session` 身份路径，资源层级与页面导航混在一起；
2. `Work` 同级平铺 Objective、Admission、Thread、Delegation、Model Attempt 和全局 Tool Timeline，没有表达真实因果层级；
3. 全局 Tool Timeline 会把不同 Thread 的执行混在一起，无法回答“这个工具为什么被调用”；
4. `Mind` 页面同时承担稳定认知、Recall、Attention、Context Encoding 和实时诊断，概念边界过宽；
5. Principal、Session working set、swap in/out 原因和 Frame provenance 没有成为清晰的一等视图；
6. 缺少 Context 级总览，用户只能在聊天、任务和 Mind 三个局部页面之间猜测整体状态；
7. 缺少 Ledger/因果事件浏览器和 Runtime/Provider/Storage 的系统页面；
8. 约三千行的单体 `App.tsx` 同时实现请求、状态折叠、业务推断和视图，难以继续保证术语与状态一致；
9. 部分 UI 状态由 WebSocket 事件启发式推断，容易再次出现“回复已经完成但仍显示求值中”；
10. 页面没有稳定 URL，Thread、Frame、Event 和 Attempt 无法深链接、刷新恢复或分享定位。

## 3. 设计原则

### 3.1 忠实表达概念，不暴露实现噪声

公开展示 `Context`、`Session`、`Principal`、`Objective`、`Thread`、`Activation`、`Execution Job`、`Frame` 和 `Ledger`。数据库表名、内部队列字段和实现型计数只在诊断层展开。

### 3.2 Context 是主要工作空间

Agent 是长期主体，Context 是一次控制台工作空间的主范围，Session 是其中可选择的交互连接。调度、认知和 Ledger 默认按 Context 展示；对话默认按 Session 展示。

### 3.3 因果结构优先于全局流水

执行信息必须按下面的关系组织：

```text
Objective / User Message / Timer
  → Thread
    → Signal
      → Activation
        → Model Attempt
          → Action Group / Execution Job
            → Result Event
              → next Signal / Delivery
```

工具调用不再作为与 Thread 无关的全局列表存在。

### 3.4 权威 Projection 优先于前端猜测

首次加载和断线恢复必须来自 Runtime 的持久权威 Projection。WebSocket 用于低延迟增量和刷新通知，不能成为唯一状态来源。

每个主要快照应携带：

```text
scope_id + revision/sequence + generated_at
```

前端不得通过“最后看见的某个事件”自行判定 Objective、Thread、Activation 或 Job 的真实终态。

### 3.5 实时数据与持久事实必须视觉分离

- streaming/reasoning delta：实时、可丢失；
- compact Context Inspect：历史诊断元数据；
- Reply、Job Result、Mind Transaction：持久事实；
- 当前 Context Encoding：当前投影，不冒充历史 Attempt。

### 3.6 先回答用户问题，再提供底层细节

每一层先回答一个问题：

- 现在是否需要我处理？
- Agent 正在做什么？
- 为什么会做这件事？
- 做到哪一步了？
- 模型当时看见了什么？
- Mind 因此发生了什么变化？

ID、revision、lease、claim token 等细节默认折叠，但始终可查看和复制。

## 4. 全局信息架构

### 4.1 顶层导航

建议采用六个稳定入口：

```text
总览 Overview
对话 Dialogue
调度 Scheduler
认知 Cognition
账本 Ledger
Runtime
```

它们不是六个互相隔离的产品，而是同一个 Context 的六种观察方式。

### 4.2 持久 Scope Bar

顶部范围栏只表达对象层级，不放页面入口：

```text
Agent  /  Context r42  /  Session  /  Principal
```

- Agent、Context 可切换；
- Session 在 Dialogue 中必须选择，在其他页面可作为过滤器；
- Principal 显示 Runtime 权威绑定和 assurance，不允许从消息文本推断；
- Context chip 同时显示 Mind revision、pressure 和 shared/seeded 状态；
- 任务、模型和主题设置不再夹在这条路径中。

### 4.3 Global Attention

右上角提供统一的“需要关注”入口：

- 等待人类审批；
- blocked/paused Objective；
- failed/lost Job；
- Delivery 失败；
- Context pressure critical；
- orphan、恢复失败和 Projection 损坏。

它是跨页面入口，不是另一套任务系统。

“需要关注”也不是永久故障箱。进入该区域必须满足以下契约：

- 当前仍需要用户决定，并且至少存在一个合法动作；或者 Runtime 明确允许用户“确认已知”；
- `Thread.lifecycle = open` 只表示语义线程尚未终结、未来仍可接收 Signal，不表示正在执行；当前活动只由 Scheduler `phase = runnable | running | waiting` 决定；
- 审批继续提供允许/拒绝；Objective 继续提供恢复/删除；Job、Delivery 和 Runtime invariant 异常至少提供因果检查与“确认已知”；
- “确认已知”不修改 Thread、Job、Approval 或 Delivery，也不删除失败证据，而是向 Event Ledger 追加 `runtime/attention_acknowledged` 审计事件；
- Runtime 在同一 Ledger 事务维护 acknowledgement Projection；Dashboard 直接读取该 Projection，不得按刷新周期扫描和排序整个 Event Ledger；
- 确认键包含源对象 revision。源状态恢复后该项自动从派生列表消失；同一对象产生新 revision 或新失败时使用新键重新进入关注区；
- 已确认的问题仍可在 Event Ledger 与执行历史中追溯，浏览器本地隐藏状态不得成为权威。

## 5. 页面设计

### 5.1 Overview：Context 指挥台

默认首页回答“这个 Agent/Context 现在整体发生了什么”。

第一屏按四个运行平面展示权威摘要：

| 区域 | 主要信息 |
| --- | --- |
| Interaction | 活跃 Session、Principal、未处理消息、最近 Delivery |
| Cognition | Mind revision、Frame 生命周期、working set、pressure、最近 Context transaction |
| Scheduling | open Thread、active Objective、pending Signal、Schedule、等待依赖 |
| Execution | live Model Attempt、active Job、Approval、失败与恢复 |

首要区域是 `Needs Attention`，其次是按 Thread 聚合的 `Live Activity`。Overview 不展示长工具参数，也不完整展开 Frame body。

### 5.2 Dialogue：交互连接

Dialogue 继续提供友好的消息体验，但明确它只是当前 Session 的交互投影。

核心组件：

- Session/Principal header：当前连接、身份锚点、attention/residency、Context mount；
- Message Stream：只显示用户消息、Agent 回复、明确进度与 Delivery；
- Thread Capsule：某条消息派生后台工作时，在消息旁显示 Thread 状态和跳转入口；
- Composer：工具运行时仍可发送消息；清楚说明新消息会创建新的 DialogueTurn；
- Session Drawer：参与 Principal、mount history、swap 状态、最近活动和同 Principal 其他 Session。

物理工具步骤不持续冲刷消息流。用户需要时从 Thread Capsule 进入 Scheduler 查看。

### 5.3 Scheduler：因果调度

Scheduler 页面分为三层。

#### A. Control Objects

- Objective：长期推进承诺、状态、原因、预算、wait condition、当前推进 Thread；
- Schedule：定时或依赖规则、下一次唤醒、暂停/恢复/取消；
- Approval：等待人类决策的现实能力扩张。

Objective 不是 Thread。卡片必须显示它当前关联的推进 Thread，而不是把二者合并成一个“任务”。

#### B. Thread Board

按 `Runnable / Running / Waiting / Needs Attention / Recent Terminal` 分组显示 Thread。

每条 Thread 显示：

- 类型：DialogueTurn / Execution / Objective / Delivery；
- 触发来源与 initiating Principal；
- 当前 phase 和等待条件；
- 最新 Activation；
- Job/Action Group 数量；
- executor：self / delegated / external；
- result 与 delivery 状态。

#### C. Thread Detail

点击 Thread 进入纵向因果链：

```text
Trigger Event
  ↓
Signal
  ↓
Activation #1
  ├─ Model Attempt
  ├─ Action Group
  │   ├─ Execution Job: read
  │   └─ Execution Job: exec
  └─ Result / next Signal
  ↓
Activation #2
  ↓
Outcome / Delivery
```

工具参数、结果、Approval、retry safety、lease、错误和退出码都属于相应 Execution Job。Delegation 显示为 Thread 的 executor 关系，不再单独成为与 Thread 平行的流水板。

Admission、队列槽位和 orphan 放入 `Kernel Diagnostics` 抽屉；它们重要，但不是普通用户进入 Scheduler 后的第一信息。

### 5.4 Cognition：认知工作台

Cognition 采用四个子视图。

#### Mind

- Frame library；
- Frame body、revision、protect/retire/restore 状态；
- relations 与 supersedes；
- formed Principal/Session 与 source provenance；
- transaction history 和最近变更 Diff。

#### Attention

- Session Working Set：full / metadata-only / excluded；
- swap in/out、retire/restore 原因；
- token/time/max-count 约束；
- 当前 Inbox/Observation 与来源；
- Session Directory。

#### Encoding

- 当前 Context Encoding；
- 实时精确 Context Inspect；
- Messages、Tools、Mind、Inbox 和 Kernel 分量；
- pressure、token estimate、prefix-cache 稳定区；
- 清楚标注“实时精确”“compact 元数据”“当前回退”。

#### Recall

- 查询、结果和来源；
- Recall index capability/lag；
- Frame/Event 命中、retired 状态；
- 从命中项跳转 Frame 或 Ledger Event。

### 5.5 Ledger：事实与诊断

Ledger 页面回答“Runtime 认为哪些事情已经真实发生”。

提供：

- 按 Context、Session、Principal、Thread、Activation、topic、sequence 和时间过滤；
- 默认读取最新一页，通过不可变 Event sequence 游标向前翻阅历史；不使用随数据量增长而退化的 offset 分页；
- 不可变 Event 详情、payload、caused_by、route 和 Projection 归属；
- 从 Event 跳转 Thread、Job、Frame 或 Session；
- Model Attempt 生命周期和 reasoning summary；
- Context Inspect 元数据与实时精确 Inspect；
- Projection head、Snapshot 和审计状态。

未来 Diagnostic Store 独立后，Ledger 页面仍展示语义事实；诊断页签查询 Diagnostic Store，两者通过 Event/Attempt ID 关联。

### 5.6 Runtime：系统运行状态

Runtime 页面集中展示和修改系统级配置：

- Provider、协议、模型和 reasoning effort；
- Context token budget、pressure thresholds 和本地估算状态；
- Provider/Activation/Execution 并发容量和 admission；
- SQLite/PostgreSQL backend、WAL/Event Writer 和 Projection health；
- Sandbox backend、approval mode、grants；
- Identity mode/provider；
- Runtime version、Git commit、uptime、恢复统计和连接状态。

主题与语言属于全局偏好，可放在用户菜单，不占据 Runtime 对象范围栏。

## 6. 概念出现位置

| 概念 | 主页面 | 关联入口 |
| --- | --- | --- |
| Agent / Context | Scope Bar、Overview | Runtime、Cognition |
| Session / Principal | Dialogue | Attention、Ledger |
| Objective / Schedule | Scheduler Control Objects | Overview Attention |
| Thread / Signal / Activation | Scheduler | Dialogue Capsule、Ledger |
| Model Attempt | Thread Detail | Encoding、Ledger |
| Action Group / Execution Job | Thread Detail | Approval、Ledger |
| Delegation | Thread executor | Context/Session 跳转 |
| Mind / Frame / Relation | Cognition Mind | Ledger provenance |
| Working Set / Observation | Cognition Attention | Encoding |
| Context Encoding / Inspect | Cognition Encoding | Model Attempt |
| Event / Projection / Snapshot | Ledger | Runtime health |

## 7. URL 与深链接

所有重要对象都应可刷新恢复和复制链接：

```text
/
/contexts/:contextId/overview
/contexts/:contextId/dialogue/:sessionId
/contexts/:contextId/scheduler
/contexts/:contextId/threads/:threadId
/contexts/:contextId/cognition/mind
/contexts/:contextId/cognition/attention
/contexts/:contextId/cognition/encoding
/contexts/:contextId/cognition/recall
/contexts/:contextId/ledger
/runtime
```

Context ID 全局唯一，因此不必把 Agent ID 重复塞入每条 URL；Agent 仍通过 Context 元数据和 Scope Bar 清楚展示。

## 8. Runtime API 与前端状态原则

Dashboard 不应拥有一套与 SDK/CLI 不同的领域解释。建议先在 Runtime/SDK 定义查询对象，再由 HTTP 原样暴露：

```text
ContextOverview
DialogueSnapshot
SchedulerSnapshot
ThreadDetail
CognitionSnapshot
ContextEncodingInspect
LedgerQueryPage
RuntimeStatus
```

当前已有 `/contexts/:id/working-set`、`/scheduler`、Session events/context、Recall、Approval 等基础接口，可以逐步组合；缺少的 Thread detail、Ledger query 和 Runtime overview 应首先成为 SDK 查询能力，而不是只为 Dashboard 写专用 SQL。

推荐同步模型：

```text
GET authoritative snapshot
  → render revision N
  → WebSocket receives durable/ephemeral event
  → apply safe ephemeral delta or invalidate affected query
  → refetch authoritative revision N+1
```

前端只对 streaming text/reasoning 做临时增量折叠；Thread、Objective、Job、Delivery 和 Mind 终态必须回到权威 Projection。

### 8.1 Context 切换与诊断数据的加载边界

选择 Context 或 Session 是高频导航动作，不应以完整诊断数据为前置条件。Dashboard 采用渐进加载：

1. 先分别请求 Dialogue events、Context Overview 和 Delegation，任一请求完成即可更新对应区域，不使用一个全局 `Promise.all` 阻塞首屏；
2. 非 Scheduler 页面只在 Overview 表明存在非终态 Thread、Activation、Approval 或 Schedule 时请求活跃调度投影；
3. Scheduler 页面首次只加载有限数量的历史 Thread，用户再按需加载更早记录；
4. Cognition 页面才读取结构化 Context Projection；完整 S-expression Encoding 只在用户打开 Encoding 子页时生成和传输；
5. HTTP 响应启用 gzip，降低长历史、Ledger 和诊断投影的传输体积。

相关接口具有不同语义，不能互相替代：

```text
GET /api/sessions/:id/context
  完整的模型可见 Context Encoding，包含结构化 Projection 与 sexpr；用于兼容、调试和显式检查。

GET /api/sessions/:id/context/projection
  结构化 Context Projection，不生成、不返回 sexpr；用于 Cognition 的 Mind/Observation 检查。

GET /api/sessions/:id/context/encoding
  仅返回最终 S-expression Encoding；用户进入 Encoding 子页时按需读取。
```

这里的目标不是删除诊断能力，而是把昂贵信息从导航热路径移到对应的观察入口。Runtime/SDK 仍负责统一定义 Projection 和 Encoding，Dashboard 不自行重建领域状态。

## 9. 前端组件与代码结构

建议从单体 `App.tsx` 迁移为：

```text
src/
  app/              router, providers, query cache, websocket
  layout/           RuntimeShell, ScopeBar, Navigation, AttentionCenter
  pages/            overview, dialogue, scheduler, cognition, ledger, runtime
  domains/
    identity/
    session/
    scheduler/
    cognition/
    ledger/
    runtime/
  components/       Status, ObjectLink, Inspector, Timeline, Empty/Error states
  api/              typed client and authoritative query models
  i18n/
```

组件只接收领域 ViewModel，不在 JSX 中临时推断业务终态。状态颜色、中文术语和英文术语统一从领域字典产生。

## 10. 视觉与响应式原则

- 保留当前深色、单一强调色方向；状态色只表达运行语义；
- 页面不是卡片墙：一级结构用留白和分区，卡片只表达可独立选择的对象；
- 正文使用易读 UI 字体，ID、SExpr、Event 和参数使用等宽字体；
- 默认信息密度中等，支持 compact density；
- 宽屏可同时显示列表与 Inspector；窄屏变成列表 → 独立详情，不允许 Dialogue 被工作台挤没；
- 左侧导航可折叠为图标 rail；Scope Bar 保持可横向滚动；
- 图结构只在表达真实因果或 Frame relation 时使用，不为装饰制造流程图。

## 11. 实施阶段

Dashboard 不适合继续在现有约三千行 `App.tsx` 上叠加页面，也没有必要推倒全部已验证资产。采用同一前端工程内的**渐进式重写（strangler migration）**：

- 保留并提取：HTTP/WebSocket 接入、model stream folding、turn settlement、Markdown、Composer、IME 修复、i18n、主题 token、内嵌二进制构建和现有测试；
- 重新实现：Router、RuntimeShell、Scope Bar、权威 query cache、页面层级、对象链接和领域 Inspector；
- 逐页迁移：新 Overview/Scheduler/Cognition 页面与旧三视图短期并存，达到功能等价后删除旧分支；
- 不保留：`conversation | work | mind` 作为顶层架构、全局 Tool Timeline、前端事件启发式终态和单体 `App.tsx`。

它在产品结构上属于新一代 Dashboard，在工程上复用已经被真实使用验证过的基础设施。

### Phase 1：壳层与权威状态

- 引入路由和稳定 URL；
- 拆出 RuntimeShell、Scope Bar、Navigation；
- 把 Tasks 从身份路径移出；
- 建立 snapshot + WebSocket invalidation 的统一数据层；
- 保留现有 Dialogue/Work/Mind 内容作为迁移中的旧页面。

### Phase 2：Overview 与 Scheduler

- 实现 Context Overview；
- 把 Work 重构为 Control Objects、Thread Board、Thread Detail；
- 工具调用归入 Execution Job；
- Admission/orphan 移入 Kernel Diagnostics。

### Phase 3：Cognition

- 拆分 Mind、Attention、Encoding、Recall；
- 完整展示 Principal/Session provenance 和 working set；
- 明确 Inspect 的实时/compact/回退语义。

### Phase 4：Ledger 与 Runtime

- 增加领域级 Ledger query、对象链接和 Attempt inspector；
- 增加 Runtime/Provider/Storage/Sandbox/Identity 状态页；
- 为未来 Diagnostic Store 预留诊断页签，不提前实现存储。

### Phase 5：体验收口

- 响应式、键盘导航、可访问性；
- loading/empty/error/reconnect 统一状态；
- 中英文术语逐项审计；
- 真实长程、多 Session、并发 Objective 和断线恢复体验测试。

## 12. 本轮建议先确认的决策

1. 对外产品名继续叫 Dashboard，界面内部标题使用 `Morphz Runtime Console`；
2. 顶层采用 `Overview / Dialogue / Scheduler / Cognition / Ledger / Runtime`；
3. Context 是默认工作空间，Session 是 Dialogue 主范围和其他页面的可选过滤器；
4. 工具调用只在对应 Thread/Execution Job 下展示，不再保留无因果归属的全局 Tool Timeline；
5. Runtime 权威 Projection 决定终态，WebSocket 只负责实时增量和查询失效；
6. 先重构信息架构与数据源，再调整配色、动画和局部视觉。

## 13. 2026-07-21 实现进度

本设计已完成第一版实现。工程采用渐进式迁移，并已取消旧 `conversation | work | mind` 三视图的顶层语义。

已完成：

- 稳定 URL、浏览器深链接与后端 SPA fallback；
- `Overview / Dialogue / Scheduler / Cognition / Ledger / Runtime` 顶层导航；
- Context、Session、Principal 的持久 Scope Bar；
- Runtime → Rust SDK → HTTP → typed Dashboard client 的 Context Overview、Scheduler Snapshot、Thread Detail、Ledger Query 与 Runtime Status 契约；
- WebSocket 只做流式增量和权威查询失效，断线或遗漏事件后由 Projection 恢复；
- Context Overview 指挥台、分组 Thread Board、Thread 因果详情、Objective/Schedule/Approval 控制；
- Model Attempt 状态与推理摘要归入对应 Thread 的具体 Activation，不保留无因果归属的全局工具流水；缺失历史因果字段时才在 Thread 级诊断区兜底；
- Dialogue 消息的 Thread Capsule，可直接跳转到该消息派生工作的因果链；
- Cognition 的 Mind、Attention、Encoding、Recall 四个子视图，含 Principal/Session provenance、Session working set 与 Context Transaction 历史；
- Ledger 的时间、Principal、Session、Thread、Activation、Actor、Topic 和全文过滤，以及领域对象跳转；
- Runtime 的 Provider、Storage、Sandbox、Identity、Context capacity、Scheduler admission、uptime 与启动恢复统计；
- 人工触发的 Mind Projection 完整性审计。该操作会重放 Ledger，因此不会自动进入请求热路径；
- 中英文词汇、主题、Markdown、Composer、IME、流式正文与推理摘要开关继续复用；
- 初始加载、错误提示、空状态、响应式布局、键盘导航和断线后的权威状态恢复已经统一；
- Dashboard typed client、路由、查询失效规则、展示辅助函数与主要页面已从单体入口逐步提取，并由前端契约测试覆盖。

后续演进项，不阻塞 Runtime Console v1：

- 继续从单体 `App.tsx` 提取 Scope Bar、Scheduler/Cognition 页面和共享 UI primitives；这是可维护性演进，不再改变领域语义；
- 持续在更多终端宽度、屏幕阅读器和真实长程并发任务下做体验回归；
- 单文件内嵌构建目前约 600 KB；若采用动态代码分割，必须先让 Rust 静态资源嵌入支持任意构建清单，不能生成二进制未包含的异步 chunk。

本轮明确不实现面向最终用户的 Web App；它在 Principal-scoped SDK 稳定后按独立信息架构推进。
