# Morphz 模型用量、Prompt 压力与 Context 归因 v1

## 1. 为什么必须拆成三套数据

Morphz 过去把若干不同问题都称为“Token 估算”，容易把近似值误当成账单事实。最终实现明确拆成三层：

| 层 | 回答的问题 | 数据性质 |
| --- | --- | --- |
| `ModelUsage` | 这次模型请求实际消耗了多少 Token、可能产生多少费用？ | Provider 返回的事实 |
| `PromptPressure` | 下一次请求大约会占模型窗口多少空间？ | 真实 usage 锚点加本地增量估算 |
| `ContextAttribution` | 当前 Prompt 的空间主要被哪些 Frame、Observation、Session 和协议组件占用？ | 按稳定本地权重分摊的估算 |

三层不能互相冒充：

- 费用只由 `ModelUsage` 和显式价格表计算；
- Context 窗口控制只使用 `PromptPressure`；
- 单个 Frame 或 Observation 的占用只属于 `ContextAttribution`，不能标成 Provider 精确 Token；
- Runtime 只提供物理压力与可观测事实，不根据体积替 Agent 决定哪些认知应被删除。

## 2. ModelUsage：真实、无条件、可审计

### 2.1 规范化模型

四种内建协议的 usage 被归一化为：

```text
input_tokens
uncached_input_tokens
cached_input_tokens
cache_write_input_tokens
output_tokens
reasoning_tokens
total_tokens
raw[]
```

不是所有 Provider 都会返回全部字段。缺失值保持为空，不猜测。唯一例外是：当 Provider 分别给出精确的输入和输出、但没有给 `total_tokens` 时，Runtime 使用二者的算术和作为精确 total。

`raw[]` 保存协议返回的原始 usage JSON。Anthropic 等流式协议会分段返回输入和输出 usage，Runtime 合并规范化字段，同时保留每一段原始对象。

### 2.2 持久化语义

只要一次 Attempt 收到了任何 Provider usage，Runtime 就独立写入一条不可变事件：

```text
topic: runtime/model_usage
id:    model_usage_{attempt_id}
```

持久化与以下结果完全解耦：

- 是否产生 reasoning summary；
- 是否产生普通回复；
- 是否调用工具；
- 是否调用 `no_reply`；
- 后续是否超时或失败。

同一 Attempt 使用稳定 Event ID，因此重复收口不会重复计费。事件同时携带 Context、Session、Attempt、Thread、Activation、Objective 因果路由，以及本轮预请求估算元数据。

SQLite 和 PostgreSQL 都通过同一 Event Ledger 接口保存该事件，不需要另建仅适用于某个数据库的用量表。

### 2.3 Provider 归一化

| 协议 | 输入 | 缓存 | 输出 / 推理 |
| --- | --- | --- | --- |
| OpenAI Chat | `prompt_tokens` | `prompt_tokens_details.cached_tokens` | `completion_tokens` / reasoning details |
| OpenAI Responses | `input_tokens` | `input_tokens_details.cached_tokens` | `output_tokens` / reasoning details |
| Anthropic Messages | input + cache creation + cache read | creation/read 分列 | 流尾 `output_tokens` |
| Gemini Content | `promptTokenCount` | `cachedContentTokenCount` | candidates / thoughts |

Morphz 只根据实际请求协议解析响应，不根据模型名称猜测协议。经 OpenAI-compatible 接口调用的 Gemini 模型，按 OpenAI-compatible usage 处理。

## 3. 费用：可选、显式、版本化

Morphz 不内置也不猜测模型价格。运维者可以提供模型价格目录：

```toml
[usage_pricing]
currency = "USD"

[usage_pricing.models."example-model"]
version = "2026-07-23"
input_per_million = 2.0
cached_input_per_million = 0.5
cache_write_input_per_million = 2.5
output_per_million = 8.0
```

规则：

1. 没有精确模型条目时，只展示真实 Token，不展示金额；
2. 价格版本或币种为空时，不计算金额；
3. 某类实际 Token 非零但缺少对应费率时，不计算该次总费用，避免用 0 猜测；
4. reasoning Token 通常是 output 的子集，不重复收费；
5. API 返回所使用的 `pricing_version`，明确金额是基于哪版目录推导的，不冒充 Provider 账单。

## 4. PromptPressure：真实锚点加本地增量

### 4.1 算法

核心路径不调用远端 `countTokens`。对当前完整协议请求先做本地稳定估算，然后使用上一条兼容的真实输入 usage 作为锚点：

```text
predicted_current
  = actual_input_at_anchor
  + local_estimate(current_request)
  - local_estimate(anchor_request)
```

增量可以为正，也可以为负，因此 Frame/Observation retire 后压力会下降。运算使用饱和减法，不会产生负 Token。

这与“只按字节估算整个请求”有本质区别：绝对基线来自 Provider 真值，本地算法只负责测量请求相对锚点增加或减少了多少。

### 4.2 锚点作用域

锚点按以下维度隔离：

```text
Context + Session + model + local counter source
```

共享 Mind 不代表不同 Session 的请求形状或工具转录完全相同，因此不能跨 Session 共用锚点。

内存缓存用于快速读取；Runtime 重启后，从当前 Context/Session 最近的 `runtime/model_usage` 事件中恢复最新兼容锚点。恢复查询有界，不重放整个 Ledger。

### 4.3 可信度

`PromptTokenCount.accuracy` 保留四档：

| 标记 | 含义 |
| --- | --- |
| `exact` | Client 能证明预请求计数与实际模型输入一致 |
| `local-tokenizer-estimate` | tokenizer 可验证，但 Provider chat/tool 封装仍可能有差异 |
| `usage-calibrated-estimate` | 使用真实 completion usage 锚定后的本地增量估算 |
| `heuristic-estimate` | 尚无真值锚点的本地完整请求估算 |

当前四个内建协议默认使用 `usage-calibrated-estimate`；不需要为了压力控制引入多个 tokenizer 库，也不需要为上百个 Provider 建分支树。未来某个 Profile 若拥有可验证 tokenizer 与 chat template，可以作为更精确的可插拔 Counter，但不是当前主链的前置条件。

## 5. ContextAttribution：用比例回答“空间花在哪里”

### 5.1 为什么比例法足够

单独计算每个 Frame 的 tokenizer 结果并不能精确还原 Provider 最终 Prompt：Provider 仍会添加 role、工具协议、chat template 与特殊 Token。相反，完整请求已有真实 usage 锚点，因此组件层只需要一个稳定、可加的相对权重。

本地固定点权重为：

```text
ASCII 字符     = 1 unit
非 ASCII 字符 = 4 units
```

它不是 Token 数，而是无需浮点舍入、可以跨组件相加的权重。

每个组件的估算占用：

```text
component_estimated_tokens
  = predicted_prompt_tokens
  × component_weight
  ÷ complete_request_weight
```

最后一个 wrapper 组件吸收整数除法余数，因此所有组件的估算 Token 之和严格等于本轮 `PromptPressure.estimated_tokens`。

### 5.2 组件范围

当前归因覆盖完整候选请求：

- System / VM contract；
- 每一个 Active / Retiring Frame；
- 每一个可见 Observation；
- 每一个进入 Context Encoding 的 Session Projection 元数据；
- Context kernel、Scheduler、Objective、Working Set 等剩余结构；
- 当前 Turn 已完成的工具调用协议转录；
- 完整工具定义；
- 请求 JSON wrapper 与尚未细分的协议开销。

Frame、Observation、Session 的权重不会在父级 Context 权重中重复计算；父级只保留扣除子组件后的剩余结构权重。

### 5.3 语义边界

归因用于：

- Dashboard 解释当前压力构成；
- 评测不同 Harness、Skill、Frame 结构和 Session Working Set 的空间效率；
- 验证 retire、revise、recall 后哪些组件实际缩小；
- 帮助开发者发现工具 Schema 或协议 wrapper 的异常膨胀。

归因不用于：

- 自动按大小淘汰 Frame；
- 将大 Frame 判定为低价值；
- 计算费用；
- 声称某个组件具有 Provider 精确 Token 数。

## 6. SDK、HTTP API 与 Dashboard

### 6.1 SDK / API

Rust SDK 提供 `model_usage(context_id, query)`；HTTP 提供：

```text
GET /api/contexts/{context_id}/model-usage
  ?session_id=...
  &before_sequence=...
  &limit=...
```

返回：

- 每个 Attempt 的真实 usage 与原始 Provider 对象；
- 本页真实 Token 汇总；
- 按币种和价格版本分组的费用汇总；
- 下一页游标。

查询默认 100 条、最大 1000 条，并按 Context/Session 有界读取，不扫描完整 Event Ledger。

`ContextOverview.attribution` 与 Context Inspect 中的 `attribution` 提供最新 Prompt 组件归因。Context Inspect 的大正文仍按 compact 策略持久化，而 attribution 本身是小型诊断结构，可直接保留。

### 6.2 Dashboard

Dashboard 必须用不同符号和文案表达两类数字：

```text
≈ 64.1k / 262.1k   Prompt 压力估算 / Context 上限
Σ 3.2m              最近查询窗口内的 Provider 真实用量汇总
```

悬浮说明展示 input、output、cached、Attempt 数量及可用的版本化费用。认知页面的“模型这一次实际看到了什么”增加“占用归因”页签，可检查 Frame、Observation、Session、工具和 wrapper 的估算份额。

## 7. Prefix Cache 与稳定前缀

本设计不要求每轮重新上传 Context 到计数服务，也不改变当前 Prompt 编排。稳定的 System / VM contract 与 Context Encoding 前缀仍应优先排列，以利用 Provider prefix cache。

`cached_input_tokens` 是 Provider 对实际缓存命中的权威反馈。归因算法可以显示稳定前缀的大致体积，但不会把“体积”误当成“已命中”；实际命中只能来自 usage。

## 8. 失败与降级语义

- Provider 不返回 usage：不写伪造的 `ModelUsage`；压力继续使用本地估算或旧兼容锚点；
- Provider 只返回部分字段：如实保存部分字段和 raw；
- 请求最终失败但此前已收到 usage：usage 仍独立持久化；
- 没有价格：Token 可统计，金额明确不可用；
- 没有历史锚点：标记 `heuristic-estimate`，完成一次带 usage 的请求后自动进入校准；
- attribution 无法解析某个子结构：剩余空间落入 `context_structure` 或 `request_wrapper`，总量仍闭合。

## 9. 验证门槛

实现至少需要证明：

1. 四种协议的流式 usage 都能归一化成相同结构；
2. Anthropic 分段 usage 能合并并得到正确 total；
3. 没有 reasoning、回复或工具调用时，usage 仍独立持久化且幂等；
4. Prompt 增长、缩小和下溢保护符合锚点公式；
5. pricing 缺失时绝不猜测，显式版本价格能正确计算；
6. usage/inspect 等可观测事件不会错误刷新 Session 活跃时间；
7. Dashboard 清楚区分 `Σ` 真实用量和 `≈` 压力估算；
8. attribution 的本地权重可加，组件估算总和与 Prompt 压力总量闭合。

## 10. 最终结论

Morphz 不需要在核心路径追求“为所有模型安装完全一致的 tokenizer”。对一个将接入大量 Provider 的长程 Agent Runtime，更稳健的统一方案是：

1. Provider usage 永远作为真实账本事实；
2. Context pressure 使用真实输入 usage 锚点加本地请求增量；
3. Context 组件使用同一套稳定权重做比例归因；
4. 费用只基于显式、版本化价格目录；
5. API 和 UI 从名称、符号到说明都不混淆真值与估算。

这套设计既保留跨 Provider 的通用性，也让 Context 自动维护、成本统计和认知结构优化拥有清晰且可审计的物理依据。
