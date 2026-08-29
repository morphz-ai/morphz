# Morphz Provider 可移植 Prompt Cache 边界设计 v1

> 状态：GPT-5.6 增量 Inbox 显式边界实现完成；ChatGPT Codex OAuth 端点不兼容已确认；Platform API 真实 A/B 待凭据验证
> 日期：2026-08-29
> 适用范围：Context Encoding、模型请求封装、Provider Adapter、缓存用量与成本观测
> 前置设计：[Prefix Cache 友好的 Context Encoding 正式布局 v1](morphz_prefix_cache_context_encoding_layout_v1.md)

## 0. 2026-08-29 实现更新

ME-08 的后续分析确认：第一阶段只把“完整 Inbox 末端”设为显式断点，下一轮追加
Observation 后该断点会移动，因此实际命中长期停留在固定 System/协议前缀。当前实现已经
补齐这一缺口：

1. Renderer 在每条 canonical Observation 末端标记候选边界，模型可见文本逐字节不变；
2. 请求规划器保留与当前 Inbox 仍匹配的最近历史末端，并始终选择当前 Inbox 末端；
3. OpenAI 每次请求最多发四个显式断点：固定协议边界、最多两个最近历史 Inbox 边界和
   当前 Inbox 边界；
4. Cache Cohort 不再由 `context_id` 派生，而由物理模型、实际缓存 wire mode、有效推理档位、
   工具合同、System Message 和稳定 Context 前缀共同哈希，因此同一策略下跨 Context 的相同
   稳定前缀可以复用，同时配对实验的 implicit/explicit 两臂不会共享缓存命名空间；
5. Retire、Restore 或较早 Observation 变化时，内容哈希不再匹配，规划器自动退回固定协议
   与当前 Inbox 两个边界并重建缓存；
6. 进程内只保存最近 256 个 Cohort、每个 Cohort 最近 50 个边界；状态丢失只造成冷启动，
   不改变 Context 语义。

确定性请求合同和完整 `morphz` 库回归已通过。这里证明的是“请求形态已修复”，不是新的
Provider 命中率；修复后的命中率和成本仍必须由第 9.3 节的真实配对 A/B 给出。

## 1. 要解决的问题

Morphz 已经把 Context Encoding 调整为下面的稳定顺序：

```text
protocol / evaluation-profile
        ↓
append-mostly inbox
        ↓
observation-state / mind / session-directory / kernel
        ↓
evaluation-environment / evaluate
```

这个顺序保证动态状态不会改写其前面的稳定字节。在支持自动前缀识别的 Provider 上，
真实 A/B 已经证明这种布局能够显著提高缓存命中率。

缺陷修复前的生产请求还有一层没有表达出来的物理边界：Runtime 先通过
`compose_context_message()` 把自然语言引导和完整 Context Encoding 合并为一个
`String`，OpenAI Responses Adapter 再把它序列化为单个 `content`：

```json
{
  "role": "user",
  "content": "固定引导文本\n(context ...完整内容...)"
}
```

S 表达式内部虽然存在稳定前缀，Provider 请求里却没有对应的内容块和缓存断点。只要
Context 尾部发生变化，某些 Provider 或代理线路就无法复用这个字符串内部已经处理过的
稳定部分。ME-08 中 GPT-5.6 Sol 路线的缓存命中率约为 16.3%，与此前自动前缀缓存 A/B
达到的约 88% 存在明显差异。

本设计要解决的是：

> 在不改变 Context 语义、不改变 Yao 语法的前提下，把 Context 已有的稳定分区映射成
> Provider 能识别的请求内容块和缓存边界。

这是请求封装层的缺口，不是 Structured Context（结构化上下文）机制本身的缺陷。

## 2. 已完成的真实验证与证据更正

2026-08-28 使用现有 `mini-m4.local` CLIProxyAPI 路线，对 GPT-5.6 Sol 做了单条
User Message 内多内容块的真实 A/B。Morphz 侧请求把 `content` 划分为两个
`input_text` 块，并在第一块末尾设置显式缓存断点：

```json
{
  "role": "user",
  "content": [
    {
      "type": "input_text",
      "text": "稳定前缀",
      "prompt_cache_breakpoint": { "mode": "explicit" }
    },
    {
      "type": "input_text",
      "text": "本轮变化的尾部"
    }
  ]
}
```

稳定块为 77,721 个 UTF-8 字节。验证结果如下：

| 请求 | 输入词元 | 缓存输入词元 | 命中率 |
| --- | ---: | ---: | ---: |
| 普通短请求对照 | 311 | 0 | 0% |
| 首次写入稳定块 | 24,115 | 0 | 0% |
| 稳定块不变，只修改第二块 | 24,115 | 23,296 | 96.6% |
| 修改缓存断点之前的内容 | 24,115 | 0 | 0% |
| 恢复原稳定块，再修改第二块 | 24,115 | 23,296 | 96.6% |

物理响应模型为 `gpt-5.6-sol`。后续请求捕获、CLIProxyAPI 翻译器审计和绕过 Proxy 的
直连对照确认：该 Proxy 在转发 ChatGPT Codex OAuth 请求前删除
`prompt_cache_options` 和 `prompt_cache_breakpoint`。因此这组 96.6% 结果只能证明稳定前缀
布局能够被**隐式缓存**复用，不能证明显式断点被上游执行。此前把它写成“显式断点真实
验证”是证据归因错误，现更正为：

1. 相同的长前缀和变化尾部可以在该线路获得 96% 以上的隐式缓存命中；
2. 修改长前缀会让缓存失效，恢复原前缀后可以再次命中；
3. 本实验没有隔离出显式断点字段的因果效应；
4. 显式断点的接口可行性必须在真正支持该字段的 Platform `/v1/responses` 端点另测。

`prompt_cache_key` 仍然是上游接受的缓存分组提示，但它不等于内容边界，也不能让变化字节
之前的任意位置自动成为可复用断点。

该线路没有报告 `cache_write_tokens`，但后续请求报告了 23,296 个 cached input tokens，
足以证明稳定前缀被实际复用。不同 Provider 对写入用量的报告字段并不统一，不能把
`cache_write_tokens = 0` 解读为没有写入缓存。

这只是实现可行性验证，不作为论文实验结果。

### 2.1 生产路径验证的正确解释

第一阶段实现完成后，又使用 Morphz 正常请求路径进行了隔离烟测。实际链路为：

```text
Morphz → CLIProxyAPI（mini-m4.local）→ OpenAI Responses 协议 → GPT-5.6 Sol
```

在同一个持续运行的 Runtime 进程、同一 Context 和同一 Session 中连续发送两轮对话请求，
第一轮为 20,853 个输入词元、缓存命中 0；第二轮为 21,202 个输入词元，其中 11,776 个为
缓存输入词元，命中率为 55.5%。这证明 Morphz 生产请求能够形成缓存命中，但由于 Proxy
删除显式字段，不能证明 `prompt_cache_breakpoint` 已被上游执行。

另一个紧接着完成的同激活工具回合没有观察到缓存命中。两次观测说明“字段已经生效”与
“每一次连续调用都会立即命中”不是同一结论；缓存建立时机、请求前缀变化和工具回合间隔
仍需由正式 A/B 分开测量。本文不把这组烟测当作最终成本结论。

### 2.2 ChatGPT Codex OAuth 与 Platform API 是两个能力边界

2026-08-29 对当前登录账户绕过 CLIProxyAPI，直接请求
`https://chatgpt.com/backend-api/codex/responses`：

- 不带显式字段的相同请求可以成功，并在 exact repeat 上达到约 95%–98% 命中；
- 带顶层 `prompt_cache_options` 的请求稳定返回 HTTP 400：
  `Unsupported parameter: prompt_cache_options`；
- 只带内容块 `prompt_cache_breakpoint` 的请求也返回 HTTP 400，表明该 Codex 后端没有执行
  Platform 文档描述的显式断点契约。

为排除“Proxy 原样透传、错误其实来自上游”的歧义，又对 CLIProxyAPI `v7.2.140` 做了相同
请求的三组配对探针：只带顶层 options、只带内容块 breakpoint、两者都带。三组请求经 Proxy
均为 HTTP 200；相同 payload 直连 Codex 依次返回对应的 HTTP 400。该版本的官方 tag 源码也
在 `ConvertOpenAIResponsesRequestToCodex` 中先删除 `prompt_cache_options` /
`prompt_cache_retention`，再遍历删除内容块 `prompt_cache_breakpoint`。因此“7.2.140 会剥离”
是当前端点/版本的实证结论，但不能外推为所有 Proxy 或未知兼容端点的默认行为。

OpenAI 官方 Platform 文档同时明确规定：GPT-5.6 及后续模型的 `/v1/responses` 支持
`prompt_cache_options.mode = explicit` 和内容块级 `prompt_cache_breakpoint`。因此能力必须
由“物理端点 + Adapter revision + 物理模型”共同决定，不能只由 `gpt-5.6-sol` 模型名决定。

同日完成的真实 Morphz 单任务 transport-only 试验，把 canonical Context 的 Inbox 末端拆成
一个 User Message，并把变化尾部放入后续 Developer Message；模型可见字符拼接保持相同，
但请求角色结构发生变化。四次调用合计 94,934 个输入词元、23,552 个缓存词元，命中率仅
24.81%，与未分割基线没有改善，因此该试验已经回滚。

请求级证据解释了为什么合成长前缀 exact repeat 很高、真实多步 Agent 却很低：Morphz 在
Context 之后还要发送当前 Activation 的 reasoning/function-call/tool-result continuation；
GPT-5.6 隐式模式把断点放在最新 eligible user/tool message 末端，而这个一次性 Tool Result
每轮都会变化。能稳定复用的只剩更早的 System/工具合同前缀，实测通常为 11,776 词元。
在不删除原生 Function Calling 握手、不重复累积历史、不改变 Structured Context 语义的
约束下，Codex OAuth 隐式模式无法表达 Inbox 内部历史边界；这正是显式断点需要解决的问题。

## 3. 设计原则

### 3.1 Context 语义与传输优化分离

Context 的权威表示仍然是一棵 canonical S 表达式。缓存断点属于发送请求时的传输元数据，
不得写入：

- Yao 源码；
- Context Event Store；
- Observation 或 Mind Frame；
- 模型可见的自然语言文本；
- Context Protocol 的语义定义。

删除全部缓存元数据后，各内容块按顺序拼接所得文本必须与当前 canonical Context Message
逐字节相同。这个等价性是实现的第一项硬性测试。

### 3.2 不把某一家 Provider 的字段当作通用协议

`prompt_cache_breakpoint` 是 OpenAI Responses API 的请求字段，不是跨 Provider 标准。
Anthropic、DeepSeek、Qwen 和 Gemini 的缓存接口不同。Morphz 内部只表达“这里是一个
适合复用的稳定前缀边界”，具体字段由 Provider Adapter 映射。

### 3.3 缓存不能影响正确性

Provider 不支持缓存、缓存过期、缓存未命中或命中率为零时，模型看到的语义内容必须完全
相同。缓存只能影响成本和延迟，不能成为任务正确执行的前置条件。

### 3.4 按协议字段与模型能力分别处理

`prompt_cache_key` 是 OpenAI Responses 的通用请求字段，因此所有 Responses 路线都会发送
稳定的 Cache Cohort；GPT-5.5 等使用自动前缀缓存的模型也能利用该字段。内容块上的
`prompt_cache_breakpoint` 和 `prompt_cache_options` 则是 GPT-5.6 及后续模型新增的显式缓存
能力，只有物理端点和模型都满足这一能力边界时才发送。公开 Platform `/v1/responses` 与
ChatGPT Codex OAuth Responses 不能视为同一端点；当前 `openai-codex` Adapter 保持普通
canonical 文本并禁用显式字段，避免确定性的 HTTP 400。其他协议不会收到 OpenAI 字段。

## 4. 建议的内部结构

### 4.1 保留现有持久化 Message

当前 `llm::Message` 使用单个 `content: String`。不建议直接把它改成 Provider 内容块数组，
因为该类型同时承担对话、工具结果、Continuation 和测试夹具等职责。把 Provider 优化写入
这个通用类型，会让持久语义和传输格式互相污染。

实现已经在模型请求构造前增加临时、不可持久化的分段文本表示。它沿用 `Message` 的传输
通道，但使用 Runtime 私有的瞬时 envelope；该 envelope 只在请求准备阶段存在，不进入
Event Store、Yao、Observation 或 Mind Frame。核心类型为：

```rust
struct SegmentedModelText {
    parts: Vec<ModelTextPart>,
    prompt_cache_key: Option<String>,
}

struct ModelTextPart {
    text: String,
    cache_boundary_after: bool,
    cache_boundary_candidate_after: bool,
}
```

不支持显式断点的 Adapter 会先拼接全部 `text`，再按原有普通文本协议发送；模型看到的
字节与改动前相同。

### 4.2 Renderer 同时给出完整文本和稳定分区

第一阶段在 `compose_context_sexpr()` 得到完整 AST 后，按顶层节点生成三个连续文本片段，
并把拼接结果同原 canonical 字符串逐字节核对。长期形态仍可以收敛成下面的显式结果类型：

```rust
struct RenderedContextEncoding {
    canonical_text: String,
    parts: Vec<RenderedContextPart>,
}

struct RenderedContextPart {
    region: ContextRegion,
    text: String,
    fingerprint: String,
}
```

`canonical_text` 用于日志、Context Inspect、调试和现有接口；`parts` 只用于模型请求封装。
无论采用当前实现还是长期类型，都必须满足：

```text
concat(parts.text) == canonical_text
```

分区必须由 canonical Renderer 直接产生，不能在最终字符串上用正则表达式寻找括号位置。

### 4.2.1 Renderer 到底如何标记边界

Renderer 不在 Context 文本中写入 `(breakpoint ...)`，也不在渲染结束后搜索字符串。它在
遍历已经解析好的 Context AST 时，把输出写入若干连续缓冲区，并在旁路元数据中记录
“这个缓冲区之后是一个候选稳定边界”。

当前 Renderer 已经在构造 AST 时明确知道 `protocol`、`evaluation-profile`、`inbox`、
`observation-state`、`mind`、`session-directory`、`kernel` 和动态尾部各是哪一个节点；
每条 Observation 也带有 Event Sequence。因此边界来自结构本身，不需要从文本反推。

可以把现有的：

```rust
SExpr::List(context).to_string()
```

改造成语义等价的分段 Writer：

```text
写入 "(context"
写入 " " + protocol
写入 " " + evaluation-profile
flush(candidate = StableProtocolEnd)

写入 " (inbox"
for observation in observations ordered by Event Sequence:
    写入 " " + canonical(observation)
    if 当前 Observation 结束了一个确定性 Inbox 块:
        flush(candidate = InboxChunkEnd(first_seq, last_seq, hash))
写入 ")"
flush(candidate = CurrentInboxEnd)

依次写入 observation-state / mind / session-directory / kernel / ...
写入 Context 的结束括号
flush(candidate = None)
```

假设 canonical Context 是：

```lisp
(context (protocol ...) (evaluation-profile none)
  (inbox (observation A) (observation B) (observation C))
  (mind ...) (evaluate ...))
```

内存中的结果可以是：

```text
part[0].text = "(context (protocol ...) (evaluation-profile none)"
part[0].candidate_boundary_after = StableProtocolEnd

part[1].text = " (inbox (observation A) (observation B)"
part[1].candidate_boundary_after = InboxChunkEnd(A..B)

part[2].text = " (observation C))"
part[2].candidate_boundary_after = CurrentInboxEnd

part[3].text = " (mind ...) (evaluate ...))"
part[3].candidate_boundary_after = None
```

其中 `part[0] + part[1] + part[2] + part[3]` 必须等于当前 Renderer 生成的完整字符串。
Content Block 在 `(observation B)` 和 `(observation C)` 之间断开并不改变文本，也不会改变
括号结构；这和网络分包不会改变文件内容是同一层面的事情。

这里还要区分三项职责：

1. **Context Renderer** 只标出所有候选结构边界；
2. **Cache Boundary Planner** 根据 Provider 上限、上一轮边界和本轮变化，从候选边界中选择
   最多四个实际断点；
3. **Provider Adapter** 把选中的断点编码成该 Provider 的 JSON 字段。

例如 OpenAI Adapter 最终把 `part[1]` 写成：

```json
{
  "type": "input_text",
  "text": " (inbox (observation A) (observation B)",
  "prompt_cache_breakpoint": { "mode": "explicit" }
}
```

`candidate_boundary_after` 和 `InboxChunkEnd` 都不会发给模型；模型只看到 `text`。

### 4.2.2 如何知道“上一轮 Inbox 末端”

每个候选 Inbox 前缀使用以下信息形成稳定身份：

```text
stable Provider Request Cohort
visible prefix byte length
canonical prefix SHA-256
```

这些信息保存在请求准备阶段的进程内元数据中，不进入 Context。下一轮新增 Observation
时，旧前缀的长度和内容哈希保持不变，Planner 就能选择旧 Inbox 末端作为读取断点，同时
选择新 Inbox 末端作为写入断点。如果旧 Observation 被 Retire、Restore 或重写，前缀哈希
发生变化，旧边界自然不再被选择。

Runtime 不判断某段文本在语义上“重要不重要”。它只依据 Context AST 的 Observation
边界、canonical 字节和前缀哈希进行确定性选择。

### 4.2.3 对当前代码的具体改动位置

第一版可以沿用当前 `compose_context_encoding()` 已经执行的 S 表达式解析，不需要重写
Context Store。具体数据流如下：

```text
context.rs
  继续生成 canonical Context S-expression
        ↓
orchestrator.rs / compose_context_encoding()
  解析为 SExpr，并挂载 evaluation-profile / runtime-directive / harness-binding
        ↓
segmented_context_writer()
  按 AST 节点输出 canonical_text + candidate parts
        ↓
cache_boundary_planner()
  按精确 Provider 能力选择实际断点
        ↓
PreparedModelInput
  形成临时 TextParts，不写入 Event Store
        ↓
provider.rs / build_openai_responses_request()
  TextParts -> input_text[] + prompt_cache_breakpoint
```

需要修改的代码边界是：

1. `compose_context_encoding()` 的底层先返回 AST，再由分段 Writer 生成请求片段；
2. 固定自然语言引导进入第一个文本片段，并与 Context parts 一起返回；
3. 新增 transient `SegmentedModelText`，不改变 Event Store 中的消息格式；
4. `build_openai_responses_request()` 遇到 `TextParts` 时输出 `input_text` 数组；
5. 其他 Adapter 在没有对应能力时只拼接 `part.text`，得到与旧实现完全相同的字符串。

为了避免“完整文本”和“分块文本”出现两套序列化逻辑，`canonical_text` 本身也必须由
`segmented_context_writer()` 的所有输出缓冲区拼接得到，不能再单独调用另一份 Formatter。
测试再将拼接结果与现有 `SExpr::to_string()` 对照；迁移完成并证明等价后，前者成为唯一的
请求序列化路径。

### 4.3 Context 的当前内容块

当前生产 Renderer 先产生以下候选片段：

1. **固定协议块**：固定引导、`context` 根开头、`protocol` 和稳定的
   `evaluation-profile`，固定设置断点；
2. **Inbox 开头**：只包含 ` (inbox`；
3. **Observation 候选块**：每条 canonical Observation 单独成为传输候选片段；
4. **动态尾部块**：从 Inbox 的结束括号开始，包含 `observation-state`、`mind`、
   `session-directory`、`kernel`、`evaluation-environment`、`evaluate` 和 Context 根的
   结束括号。

Provider Planner 只选择最多四个实际断点，Adapter 再把未选中的相邻候选片段合并，因此
不会把数百条 Observation 原样膨胀成数百个 `input_text` 块。

这些块拼起来仍是一段合法且与当前完全相同的 S 表达式文本。Provider Content Block
边界可以出现在 S 表达式的两个字符之间，但不会向文本插入任何标记，因此不会破坏语法。

## 5. Inbox 的增量边界

当前实现以 Observation 末端作为候选边界，并为候选前缀计算增量 SHA-256 身份。每次请求
最多选择四个战略边界：

1. 固定协议块末端；
2. 与当前 Inbox 仍完全匹配的最长最近历史末端；
3. 如容量允许，再选择一个次近的匹配历史末端；
4. 本轮最新 Inbox 末端，用于下一轮。

这样，一条新 Observation 到达时，请求既可以命中上一轮的稳定 Inbox 前缀，又可以为包含
新 Observation 的前缀建立下一轮缓存。具体块大小不在本设计中凭经验固定，应通过 A/B
选择，并受 Provider 每次请求允许的最大断点数约束。

Retire、Restore 或修改较早的活跃历史会从首次变化处产生一次缓存重建。这是语义状态真实
变化的结果，不能也不应通过保留已经失效的文本来掩盖。

## 6. Cache Cohort 与 `prompt_cache_key`

`prompt_cache_key` 和缓存断点解决的是两个问题：

- **缓存断点**声明一条请求内部哪些前缀可以形成复用边界；
- **`prompt_cache_key`**为相似请求提供稳定的缓存分组提示，提高命中机会。

`prompt_cache_key` 不能替代内容块，也不能让已经变化的字节继续命中。

当前实现以稳定的 **Provider Request Cohort** 为缓存分组，而不是以 Context 或 Session
身份分组。键由以下信息形成：

```text
Physical Model
Effective Reasoning Effort
Ordered Tool Name / Description / JSON Schema
System and preceding Message bytes
Stable Context protocol / evaluation-profile prefix
```

因此相同请求合同下的不同 Context 可以共享公共前缀；模型、实际缓存 wire mode、推理档位、
工具顺序或 schema、System Prompt、Context Protocol 或 Evaluation Profile 任一变化都会进入
新 Cohort。Provider 账户和端点仍由独立的 `ProtocolClient` 实例自然隔离。

不能把 Turn ID、Activation ID、随机请求 ID 或当前时间放进 Cohort Key。任何会改变模型可见
固定前缀的配置都必须形成新的 Cohort。

`prompt_cache_key` 不是权限边界；Context 的访问控制仍由 Morphz 的 Principal、Session、
Context 投影和 Provider 账户隔离负责。

## 7. Provider 能力模型

当前实现把 Responses 通用字段与物理端点能力分开：`prompt_cache_key` 按协议发送，显式
断点同时受模型版本、Adapter 和 `ProviderModelConfig.prompt_cache_strategy` 控制。该字段
描述精确 Provider/model 组合，不复用模型路由的业务能力列表：

```toml
[providers.openai.models."gpt-5.6-sol"]
prompt_cache_strategy = "explicit-content-boundaries"

[providers.codex-proxy.models."gpt-5.6-sol"]
prompt_cache_strategy = "implicit-prefix"
```

可选值为 `auto`、`disabled`、`implicit-prefix` 和 `explicit-content-boundaries`。`auto`
保留现有 OpenAI 模型版本判断；确认性实验必须对精确端点/模型/revision 显式冻结策略。
`openai-codex` Adapter 即使被误配为 explicit 也会拒绝输出显式字段，因为该后端已直接
验证为 HTTP 400。其他协议不会收到 OpenAI Provider-specific 字段。

建议的 Provider 映射如下：

| Provider / 协议 | 第一阶段行为 | 说明 |
| --- | --- | --- |
| OpenAI Platform Responses | 所有模型发送 `prompt_cache_key`；GPT-5.6 及后续模型再发送内容块断点和 cache options | 官方契约明确支持；Morphz 真实 A/B 待独立 Platform API key |
| ChatGPT Codex OAuth Responses | 发送 `prompt_cache_key`，保持 canonical Context 单消息，不发送显式字段 | 直连已确认 `prompt_cache_options` 返回 HTTP 400；Proxy 不是根因 |
| CLIProxyAPI 7.2.140 → Codex OAuth | 可显式冻结为 `implicit-prefix` | 三组配对探针均由 Proxy 200、直连 400；官方 tag 源码明确剥离字段 |
| OpenAI Chat Compatible | 默认不启用；只有精确端点声明且探测通过后才映射 | 不能因“OpenAI compatible”就假定支持 Responses 字段 |
| Anthropic Messages | 把内部边界映射为内容块 `cache_control` | 字段、TTL 和计费方式与 OpenAI 不同 |
| DeepSeek / Qwen 自动缓存端点 | 不发送显式断点，继续保持稳定字节前缀 | DeepSeek 官方说明为自动前缀缓存；实际兼容端点仍以配置和 Usage 为准 |
| Gemini implicit caching | 不发送显式断点，保留稳定前缀并读取 Usage | 新模型支持隐式缓存，但不等于支持 OpenAI 字段 |
| Gemini explicit caching | 后续映射为独立 Cached Content 资源 | 涉及资源创建、TTL 和生命周期，不纳入第一阶段 |
| 未知 Responses Provider | `auto` 保留兼容行为；正式实验前必须探测并冻结 | 不从“它是 Proxy”推断支持或不支持 |

官方接口参考：

- [OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [CLIProxyAPI v7.2.140](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.2.140)
- [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)
- [Gemini Context Caching](https://ai.google.dev/gemini-api/docs/caching)

## 8. 不支持字段时的处理

以下降级策略尚未进入第一阶段代码，是正式扩展到更多端点前的后续要求：

### 8.1 生产模式

若一个已经声明支持显式缓存的端点明确返回“字段不支持”类 4xx：

1. 记录一次结构化 capability downgrade；
2. 仅移除缓存元数据，以完全相同的模型可见文本重试一次；
3. 在当前 Provider Instance、Physical Model 和 Adapter Revision 组合上停止继续发送该字段；
4. 不把普通 5xx、模型拒绝或内容错误误判为缓存能力问题。

这样可以保证服务可用，但会产生一次额外请求。正式上线前应通过预检避免频繁触发该路径。

### 8.2 Benchmark 与论文实验

确认性实验不允许运行中静默降级。实验开始前必须完成端点探测并冻结实际能力；如果运行中
发现配置不成立，该 Trial 应标记为环境或协议失败，不能把降级后的请求混入同一统计口径。

## 9. 测试方案

### 9.1 纯确定性测试

第一阶段已经覆盖：

1. 分块文本拼接后与当前 Context Message 逐字节相同；
2. Provider 缓存字段不会进入模型可见文本；
3. 同一 Context 状态重复渲染得到相同分块和顺序；
4. Measurement Request、正式 Request 和 Context Pressure 重建使用同一分块规则；
5. Attachment、Continuation、Tool Result 和其他 Provider 协议不泄露内部 envelope；
6. Provider Usage 分开保存缓存读取、缓存写入和普通未缓存输入，避免重复计费。

Inbox 增量边界、历史谱系匹配、四断点上限、早期历史变化后的重建，以及跨 Context Cohort
复用都已有确定性合同测试。首次分歧的持久化观测仍属于后续 Benchmark 工具工作。

### 9.2 Adapter 合同测试

每种协议验证完整 JSON：

- OpenAI Responses：`input_text` 数组、断点、cache options 和 key 的准确位置；
- Anthropic：第一阶段拼接为原普通文本，不发送 OpenAI 字段；
- DeepSeek / Qwen / Gemini implicit：不出现未知字段；
- 未知兼容端点：退化为普通文本且内容完全相同；
- `openai-codex` Adapter 只保留 `prompt_cache_key` 和 canonical 文本；普通 Platform
  Responses Adapter 在 GPT-5.6+ 输出显式断点字段。

不支持字段的 4xx 受控降级尚未实现。

### 9.3 真实 Provider A/B

第一轮只验证 GPT-5.6 Sol 当前物理路线，固定模型、账户、System Prompt、工具 Schema 和
Context 数据，比较：

1. 当前单字符串请求；
2. 内容相同、仅增加分块和缓存边界的请求。

场景至少包括：

- 动态 Evaluate 尾部变化；
- 追加一个 Observation；
- Mind Frame revision；
- Session 切换但共享同一 Context；
- Harness binding 变化；
- Retire 后的缓存重建；
- 工具 Schema 变化并进入新 Cohort。

观测字段包括：

- Provider reported input tokens；
- cached input tokens；
- cache write tokens（Provider 提供时）；
- output tokens；
- 首字节与端到端延迟；
- 当前价格快照下的 API 成本；
- 任务结果是否一致；
- 请求的 Provider、物理模型、Adapter、协议和 Cache Cohort。

不能只用 Cache Hit Rate 判断效率。最终成本必须分别按各 Provider 的普通输入、缓存读取、
缓存写入和输出价格计算。

以 2026-08-28 的 OpenAI 官方价格为例，GPT-5.6 Sol 普通输入为每百万词元 4 美元，缓存
输入为 0.4 美元，而缓存写入按普通输入价格的 1.25 倍计费。因此显式模式不应把每个动态
尾部都写入缓存；只有后续请求预计会复用的边界才值得写入。正式报告必须保存价格快照，
不能把这一价格永久写成算法常数。

## 10. 实施阶段

### Phase 1：传输表示与等价性测试（已完成）

- 引入不可持久化的 `SegmentedModelText`；
- Renderer 返回 canonical text 与结构化 parts；
- 保证现有字符串请求仍是无缓存能力时的默认路径；
- 完成逐字节等价、Context Inspect 和所有 Provider 的结构回归。

### Phase 2：OpenAI Platform Responses 缓存字段（实现完成，真实 A/B 待凭据）

- 所有 Responses 模型使用 `prompt_cache_key` / Cohort；
- GPT-5.6 及后续物理模型在支持该字段的 Platform 端点启用显式内容块断点；
- ChatGPT Codex OAuth 端点禁用显式字段，避免确定性的 400；
- 此前经 CLIProxyAPI 得到的 96.6% 已更正为隐式缓存证据；
- Platform 真实同题 A/B 需要独立 API key，不能复用 Codex OAuth token。

### Phase 3：Inbox 增量边界（生产实现已完成）

- 每条 Observation 末端作为结构候选，不改变 canonical 文本；
- 规划器按完整前缀哈希保留最近可复用边界，并遵守四断点上限；
- 较早历史变化时自动停止选择失效边界并重建；
- 已完成 append、跨 Context Cohort、模型/推理/工具隔离和回退的合同测试；
- Codex OAuth transport-only 试验无改善并已回滚；
- Platform 显式模式的真实多场景 A/B 与首次分歧观测仍待执行。

### Phase 4：其他 Provider

- Anthropic 显式内容块映射；
- DeepSeek、Qwen 和 Gemini implicit 的 Usage 归一化；
- Gemini Cached Content 作为独立设计评估，不和内容块断点混为一谈。

## 11. 上线门槛

第一阶段已经只对经过验证的 GPT-5.6 Responses 路线启用。扩展到其他模型或把它作为通用
Provider 能力前，仍须同时满足：

1. 语义文本逐字节等价；
2. 全部 Runtime 与 Provider Adapter 回归通过；
3. 不支持缓存的端点仍能正常工作；
4. GPT-5.6 Sol 的真实多轮 A/B 可重复观察到稳定缓存收益；
5. 正确率无下降；
6. 真实 API 成本低于或不高于当前请求布局；
7. Usage、Cohort、能力降级和首次分歧均可审计；
8. Benchmark 模式能够冻结能力，不发生静默降级。

## 12. 对现有论文数据的处理

ME-08 已报告的 Token 和缓存数据是当时完整系统与当时请求封装下的真实测量，应保留原始
产物，不能事后改写。但它只能描述该版本系统的工程表现，不能据此断言 Structured Context
天然具有较低缓存率或较高 API 成本。

在本设计实现并验证后，如需对外提出成本优势或成本相当的主张，应使用同环境的 Morphz 与
参考智能体重新进行配对测量。论文正文不需要记录此次排查过程；只需要报告最终采用的系统
配置、实验方法、测量结果和适用范围。

## 13. 已冻结的实现决策与待决项

已经冻结：

- 缓存边界只属于请求封装层的临时表示，不进入 Yao、Event Store 或模型可见文本；
- Cache Cohort 绑定稳定 Provider 请求合同，不绑定 Context 或 Session 身份；
- 每条 Observation 末端是候选边界，Adapter 只输出 Planner 选中的少量内容块；
- OpenAI 每轮选择固定协议、最长可复用历史 Inbox、可选的次近历史 Inbox 和当前 Inbox，
  总数不超过四个；
- 当前只对支持显式字段的 OpenAI Platform Responses GPT-5.6+ 能力边界启用显式断点；
- ChatGPT Codex OAuth 与 Platform API 是独立能力边界，不能只按模型名合并判断。

仍待决定：

- 生产端点明确拒绝缓存字段时，是否允许一次有记录的无缓存降级重试；
- 修复后的真实成本下降和正确率门槛；
- Anthropic、DeepSeek、Qwen、Gemini 与其他兼容端点的逐模型能力映射。

## 14. 建议结论

建议采用本方案，但分两步决策：

1. 先批准“传输层分块、语义文本不变”的总体架构；
2. 再通过 GPT-5.6 Sol 多场景 A/B 决定具体分块大小、断点分配和默认启用范围。

这样既保留 v26 已经验证过的稳定布局，也补上 Provider 看不到单个字符串内部稳定边界的
缺口。修复不需要改变 Structured Context、Yao 程序或 Mind Frame 的语义。
