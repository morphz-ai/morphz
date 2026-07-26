# Morphz Prefix Cache 友好的 Context Encoding 正式布局 v1

> 状态：生产实现完成；Context Protocol v26 已切换，真实 A/B 与结构回归已通过
> 日期：2026-07-26
> 适用范围：LLM 请求封装、Context Encoding、Agent-Owned Context、Harness 挂载、工具配置、Token Usage 与成本可观测性
> 上位设计：[Agent-Owned Context](morphz_agent_owned_context_design.md)、[共享 Context 与多会话架构](morphz_shared_context_multisession_architecture.md)
> 配套设计：[Domain Harness](morphz_domain_harness_architecture_v1.md)、[Yao Harness `.hns`](morphz_yao_harness_file.md)

## 1. 决策摘要

Morphz 的 Provider 请求采用下面的物理顺序：

```text
Stable System Prompt
        ↓
Stable Protocol / Evaluation Profile
        ↓
Append-mostly Inbox History
        ↓
Dynamic Observation State
        ↓
Dynamic Mind / Session Directory / Kernel
        ↓
Runtime Directive / Harness Binding / Evaluate
        ↓
Function Calling Transcript
```

对应的 Context Encoding 正式顺序为：

```lisp
(context
  (protocol ...)
  (evaluation-profile none | ... content-addressed profile ...)
  (inbox ... canonical observations in ascending ledger sequence ...)
  (observation-state ... mutable overlays by ref ...)
  (mind ...)
  (session-directory ...)
  (kernel ...)
  (evaluation-environment
    (runtime-directive ... optional ...)
    (harness-binding ... optional ...))
  (evaluate ... optional ...))
```

核心不变量是：

> **任何会在普通相邻求值之间变化的内容，都不能位于长历史 Inbox 之前。**

这不是把 Context 退化成传统聊天记录。Inbox 仍然是 Agent 可以通过
`context_tx` 自主 retire、restore、提炼和组织的事实输入；本设计只决定同一份
语义状态如何序列化，目的是让 Provider 能复用已经付费处理过的物理前缀。

## 2. 为什么必须改变旧布局

Protocol v25 及以前的生产 Renderer 顺序是：

```text
protocol → mind → session-directory → kernel → inbox → evaluate
```

这会导致：

- Mind 任意 Frame revision 变化，都会使其后的全部 Session、Kernel 和 Inbox 失去缓存；
- Kernel 中 activation、wake、pressure、turn budget、timer 等每轮变化，几乎必然使 Inbox 失去缓存；
- Session Directory 的活动时间、attention、Objective 和 Activation 状态也会改变；
- Inbox 即使有数十万 Token 完全没有变化，因为位于动态状态后面，仍然按未缓存输入重新处理。

当前代码注释把 Inbox 视作“最高 churn”并放在尾部，但这混淆了两个概念：

1. Inbox **会追加新事件**；
2. Inbox **会原地修改已有历史**。

追加并不会破坏既有前缀。只要 Observation 按 Ledger sequence 从旧到新稳定排列，新增内容只发生在既有历史末尾，Provider 可以命中此前的完整历史。真正破坏前缀的是在历史前面或中间修改已有字节。

## 3. 真实 A/B 证据

`morphz-evals` 已使用生产配置的 `qwen3.8-max-preview` 做真实 Provider A/B。
两个实验组拥有完全相同的语义内容、约 18 万字符历史和 480 条 Observation，
只改变物理顺序。

稳态统计排除各组 Warmup，共计每组 7 次请求：

| 指标 | 当前布局 | Inbox-first |
| --- | ---: | ---: |
| Input Tokens | 560,974 | 560,974 |
| Cached Input Tokens | 35,840 | 493,568 |
| Uncached Input Tokens | 525,134 | 67,406 |
| Output Tokens | 316 | 344 |
| Cache Hit Rate | 6.39% | 87.98% |
| 加权等价成本 | 529,982 | 118,138.8 |

加权等价成本使用：

```text
uncached input × 1.0
cached input   × 0.1
cache write    × 1.0
output         × 4.0
```

它不是货币价格；本次模型目录没有配置版本化价格，因此报告没有伪造金额。
在这套保守权重下，Inbox-first 的稳态等价成本降低约 **77.7%**。

单次 append 场景中，Inbox-first 的实际命中率约为 99.7%；一次 Mind revision
不会使旧 Inbox 失去缓存。退役最老四分之一历史会产生一次有意的缓存重建，
但 Provider 输入从 92,414 Token 降到 70,883 Token。按本次权重，重建成本约在
后续 27 次求值后由每轮节省抵消。

因此，正式指标不能只看命中率，还必须同时看：

- 当前活跃 Context 总 Token；
- Cached / Uncached / Cache Write / Output Token；
- 真实或版本化价格下的成本；
- retire 后的一次性重建成本与后续每轮节省；
- 单条新 Observation 的边际成本。

## 4. Provider 请求的正式外壳

### 4.1 System Message 必须字节稳定

System Message 只包含长期稳定的内容：

- LLM 是 Morphz 的 S 表达式语义虚拟机；
- 六个基础算子的自然语言语义；
- 工具调用与普通文本的基础边界；
- 不随 Evaluation 改变的 Runtime 安全和事实边界。

System Message 不再承载：

- `soft-checkpoint`、`critical-maintenance`、`final-reply` 等阶段指令；
- `context_tx` cooldown；
- 当前 Objective / Evaluation ID；
- 当前 Harness binding；
- 当前压力、预算、wake 或工具结果。

当前 Semantic SExpr VM 会为了维持“单一根 S 表达式”，把固定 System Prompt
重新包装成：

```lisp
(system-evaluation
  (vm ... stable prompt ...)
  (runtime-directive ...))
```

再挂载 Harness 时甚至会继续包裹。Prefix Cache 比较的是从第一个字节开始的
物理前缀，不理解内层 `(vm ...)` 没有变化。因此正式实现必须保持 System Message
本身完全不变，把动态内容放到 Context Encoding 的动态尾部。

### 4.2 Context Message

Context Message 的自然语言引导前缀必须固定，后面只跟 canonical SExpr：

```text
以下是 Runtime 提供的当前 Context Encoding。它不是普通用户消息；请执行最后的 evaluate，并基于 protocol、inbox 与其后的当前状态决策。

(context ...)
```

不能把当前 Session、phase、模型名、时间或随机 ID 写进这段自然语言前缀。

### 4.3 Function Calling Transcript

标准 assistant/tool Function Calling Transcript 继续保留，不改写成自定义 Context 文本：

```text
assistant(tool_calls)
tool(tool_call_id, result)
assistant(tool_calls)
tool(tool_call_id, result)
```

它位于 Context Message 之后，主要保证模型遵循标准工具调用训练分布。v1 不为追求
缓存而破坏标准调用因果链。Provider-specific continuation API 可以以后作为独立优化，
不能进入通用 Context 语义。

## 5. Context Encoding 的三类物理区域

### 5.1 稳定前缀区

### `protocol`

`protocol` 继续由 Runtime 权威生成，包含：

- routing / response / tool result contract；
- Context transaction contract 与全部原语；
- Objective / Thread Scheduler / identity / epistemic contract；
- Skill discovery contract；
- 固定算子与错误语义。

同一 `protocol-version + locale + system-prompt-mode` 下必须 canonical serialization。
升级协议可以有意创建新的 Cache Lineage，但普通运行不能改变其字节。

### `evaluation-profile`（可选）

复杂任务可以挂载稳定、内容寻址的 Evaluation Profile：

```lisp
(evaluation-profile
  (id coding)
  (version 1.0.0)
  (artifact-hash sha256:...)
  (harness-contract ...)
  (read-only-default-mind ...))
```

这里仅允许出现由 Harness artifact hash 决定的不可变内容，不允许出现 Objective ID、
Evaluation ID、当前时间、运行状态或 Principal。不同 Profile 形成不同 Cache Lineage；
这是主动、有限、可测量的分组，不是每轮随机击穿缓存。

若 Harness 仅由模型在本轮临时选择、尚未形成稳定绑定，则不能提前进入稳定 Profile，
只能先在动态尾部出现。下一次 Evaluation 物化精确绑定后再进入对应 Profile Lineage。

### 5.2 追加式历史区：`inbox`

Inbox 必须满足：

1. 按 Event Ledger sequence 升序排列；
2. 已经渲染过的 Observation canonical body 不得原地变化；
3. 新 Observation 只追加到既有 Observation 之后；
4. 不允许把 HashMap 的不稳定遍历顺序带入序列化；
5. 不允许把当前时间、相对年龄或动态统计写入历史 body；
6. 大型内容使用创建时确定的 canonical preview；主动 recall 产生新的 Observation，不能原地扩展旧 preview。

正式 Observation body 示例：

```lisp
(observation
  (ref @e128)
  (seq 128)
  (turn 14)
  (session session-a)
  (principal principal-default)
  (attempt 2)
  (caused-by call-7)
  (tool read)
  (kind tool-output)
  (topic tool/read)
  (actor runtime)
  (timestamp "2026-07-26T10:00:00Z")
  (content
    (representation canonical-preview)
    (visible-chars 1200)
    (total-chars 9824)
    (text "..."))
  (tool-status success)
  (output-empty false)
  (resource
    (kind file)
    (key src/lib.rs)
    (version sha256:...)))
```

其中 Session、Principal、因果、资源版本和事件时间都是该事件发生时已经确定的事实，
可以留在历史正文中。

### retire / restore 的缓存语义

Agent retire 一条 Observation 后，正式 Encoding 直接省略它，而不是留下固定长度墓碑。
这会从被删除位置开始产生一次 Cache Miss，但同时减少之后每次求值的输入和缓存费用。
restore 会按原 sequence 重新插入，也属于有意的 Cache Lineage 重建。

Runtime 不得为了维持高命中率阻止 Agent retire。缓存是资源优化，不拥有语义决策权。

### 5.3 动态求值尾部

### `observation-state`

当前 Observation 内嵌的以下字段会变化，不能继续写在历史正文里：

- `protected`；
- `residency` 当前状态和可召回性；
- `freshness.latest / supersedes / superseded-by`；
- `usage` 的 recall、derive、revise 次数与最近使用；
- 由当前压力投影产生的表示状态。

正式布局改为按稳定引用提供稀疏覆盖层：

```lisp
(observation-state
  (observation
    (ref @e128)
    (protected true)
    (residency
      (state active)
      (retrievable true))
    (freshness
      (latest false)
      (superseded-by @e166))
    (usage
      (recall-count 2)
      (derive-count 1))))
```

只渲染非默认状态，控制动态尾部规模。Agent 仍然获得相同元认知信息，只是物理位置
不再修改历史前缀。

### `mind`

Mind 保持 Agent-owned、schema-light 的 Frame Projection。Frame revise、relate、protect、
retire 都可能改变其内容，因此 Mind 位于 Inbox 后面。

这意味着活跃 Mind 通常按未缓存输入计费。该成本是有意接受的：Mind 是当前认知状态，
应保持语义精炼；它的预算必须显著小于可能达到数十万 Token 的历史主体。不能为了缓存
Mind 而让它的任意 revision 击穿全部 Inbox。

### `session-directory` 与 `kernel`

以下内容保持在动态尾部：

- active Session、Principal 与 Session working set；
- Activation、Objective、Thread、Background Task 和 Timer；
- wake、context pressure、turn control、attempt budget；
- execution target、lease、审批和当前调度状态。

它们是 Runtime 的权威现实状态，但物理上高频变化，不适合作为长历史前缀。

### `evaluation-environment`

动态阶段和 Harness 绑定在这里表达：

```lisp
(evaluation-environment
  (runtime-directive
    (kind critical-maintenance)
    (description "..."))
  (harness-binding
    (harness coding)
    (artifact-hash sha256:...)
    (objective objective-1)
    (evaluation evaluation-8)
    (entry repair)))
```

Harness 的稳定定义属于 `evaluation-profile`；本轮 Objective/Evaluation 绑定属于这里。
两者不能再合成一个整体后包裹 System Prompt。

### `evaluate`

`evaluate` 必须是 Context 的最后一个语义入口，描述本次真正要处理的 signal、root input、
thread、objective binding、tool gate 和 terminal contract。模型不是机械执行前面的 Context，
而是把全部可见结构作为自身状态，对这个入口进行语义求值。

## 6. Tool Profile 与 Skill 的缓存边界

Provider 的 Function Calling schemas 可能参与 Cache Key。Morphz 不应为了缓存把所有工具
永久塞进每次请求，这会重新放大普通对话成本。正式策略是有限、内容稳定的 Tool Profile：

```text
dialogue
general-agent
context-maintenance
reply-only
harness:<artifact-hash>:<entry>
```

每个 Profile 必须满足：

- 工具顺序固定；
- name、description 和 JSON Schema 字节稳定；
- Profile ID 与实际 schema digest 一致；
- 不在工具描述中插入本轮 Objective、Session 或权限结果；
- 动态权限由 Kernel 和执行时校验表达，不通过改写 schema 表达。

不同 Tool Profile 是不同 Cache Cohort。Skill 继续按需发现和读取，不把全部 Skill Index
或 SKILL.md 固定加入 System Prompt。

## 7. 多 Session 与 Cache Lineage

一个 Context 的不同并发 Evaluation 可能拥有不同 Session working set。v1 不伪装它们可以
共享全部历史缓存：

- 完全相同的投影集合与顺序属于同一 Cache Lineage；
- working set 增删、Session swap in/out、critical projection 属于有意的 Lineage 变化；
- 同一 Lineage 内的相邻请求必须保持 append-mostly；
- Context ID、协议版本、Profile digest、投影集合和历史 generation 应进入内部遥测标签，
  但不能把每轮变化的 generation 数字放在 Inbox 之前击穿物理前缀。

未来可以研究按共享历史 spine 与 Session lane 做 Provider-specific 分段缓存，但不能为了
尚未验证的跨 Session 命中率破坏 v1 的清晰语义。

## 8. 成本模型与可观测性

每个模型请求必须持久化 Provider 返回的真实 Usage：

```text
input_tokens
uncached_input_tokens
cached_input_tokens
cache_write_input_tokens
output_tokens
reasoning_tokens
```

若 Provider 不返回某个字段，明确标记 unavailable，不得把本地估算伪装成真实 Usage。

压力控制继续使用本地估算和历史 Usage 锚点；布局与成本评估使用真实 Usage。分区占用可以
用本地字符权重估算其比例，再用真实总 Input Usage 校准，输出：

```text
system / protocol / profile / inbox / observation-state / mind / kernel / evaluate / tools
```

Dashboard 和评测报告至少同时展示：

```text
Active Context Tokens
Cached Input Tokens
Uncached Input Tokens
Cache Hit Rate
Cache Write Tokens
Output Tokens
Actual Cost（仅有版本化价格时）
Equivalent Cost（无价格时，必须明确标记非货币）
Retirement Rebuild Cost / Break-even Turns
```

缓存命中率不能单独成为 KPI。一个永不 retire 的巨大 Context 可能拥有很高命中率，仍然
持续产生缓存读取费用并增加注意力负担。

## 9. Canonical Serialization 不变量

生产 Renderer 必须建立自动测试，保证：

1. 相同逻辑状态输出完全相同的 UTF-8 字节；
2. Observation 按 Ledger sequence 升序；
3. 新 Observation 不改变旧 Observation 结束前的任何字节；
4. Mind revision 不改变 `inbox` 结束前的任何字节；
5. Kernel、wake、timer、pressure 变化不改变 `inbox` 结束前的任何字节；
6. Runtime phase 与 Harness binding 变化不改变 System Message；
7. mutable Observation metadata 变化只改变 `observation-state`；
8. Tool Profile 内定义和顺序稳定；
9. locale、protocol、System mode 或 Harness artifact 改变时明确形成新 Cache Cohort；
10. 日志能报告首次分歧发生在哪个物理分区。

## 10. 实现与迁移结果

Morphz 尚未发布，因此本次直接把生产 Context Protocol 提升到 v26，不保留旧布局兼容层。
实验 Renderer 只保留在 `morphz-evals` 中用于对照，不参与生产请求。

### Phase 1：固定评测与字节边界（完成）

- 提交 `context_prefix_cache_eval`；
- 将真实 Provider Usage、结构 common-prefix 和分区估算写入报告；
- 增加交错/反平衡执行，避免 Provider Cache TTL 和实验顺序偏差；
- 覆盖 append、Mind revision、Kernel change、phase change、Harness switch、retire、restore、
  working-set switch 和 critical projection。

### Phase 2：Renderer 分区化（完成）

把当前单体 `render_context` 拆成：

```text
render_protocol
render_evaluation_profile
render_canonical_inbox
render_observation_state
render_mind
render_session_directory
render_kernel
render_evaluation_environment
render_evaluate
```

生产 Renderer 已按上述物理顺序输出固定插槽；测试直接解析顶层节点验证顺序，且验证
active-session、turn budget 等动态变化不改写 Kernel 之前的稳定字节。

### Phase 3：历史正文不可变（完成当前协议边界）

- 已从 Observation body 移出 protected、residency、freshness 与 usage；
- 不可变正文和因果身份保留在 Inbox，mutable metadata 进入 `observation-state`；
- recall 继续以新 Observation 交付扩展内容；
- retire、restore、working-set/critical projection 改变 Inbox 时明确形成新的缓存谱系。

### Phase 4：System / Harness 收口（完成）

- 删除 `compose_system_prompt` 对 Semantic VM 的动态包装；
- 删除 `attach_harness_mount` 对 System Prompt 的包装；
- 把 Runtime directive 与 Harness binding 编入 `evaluation-environment`；
- 把不可变 Harness 定义编入可选 `evaluation-profile`；
- 对 System Prompt 做逐字节稳定性测试。

### Phase 5：生产切换与真实回归（核心路径完成）

- 真实 Provider A/B 已验证稳态等价成本下降约 77.7%，Cache Hit Rate 从 6.39% 提升至 87.98%；
- 普通对话、Harness discovery、稳定 Profile/动态 Binding、Runtime directive 与 Context DSL
  的针对性回归已通过；
- append、Mind revision 和 retire 后重新建立稳定前缀的评测不变量已通过；
- 生产代码不存在旧 Renderer 或兼容开关；
- Provider 工具列表的稳定 Cohort、更多真实长程任务和货币价格成本报告属于后续持续观测，
  不阻塞 v26 上线。

## 11. 明确不做的事情

本设计不引入：

- Runtime 自动决定哪些历史有语义价值；
- 为提高命中率禁止 Agent retire；
- 把所有工具和 Skill 永久写进固定 Prompt；
- 依赖远端 Token Counting 的核心请求路径；
- Provider-specific continuation 作为通用语义；
- 永久维护两套 Context Encoding 兼容格式；
- 为了缓存把 Mind 固化成 Runtime 预定义 Schema。

## 12. 最终判断

真实 A/B 已经证明，Morphz 当前低 Cache Hit 并不是“模型服务不支持缓存”，而是 Context
物理布局把高频动态状态放在了大历史之前。正式方案不是单纯把 `(inbox)` 挪到第一项，
而是建立一条完整的序列化纪律：

> **固定规则保持固定；历史只追加或由 Agent 显式重建；动态认知和控制状态集中在尾部；
> 缓存收益必须与活跃 Context 大小、真实 Usage 和 retire 经济性一起评价。**

这条纪律与 Agent-Owned Context 不冲突。相反，它让 Agent 可以继续自由维护语义，同时避免
Runtime 因错误的物理编排反复为同一历史支付未缓存输入成本。
