# Morphz Provider 可移植 Prompt Cache 边界设计 v1

> 状态：第一阶段生产实现与真实烟测完成；Inbox 增量分块及其他 Provider 映射待后续验证
> 日期：2026-08-28
> 适用范围：Context Encoding、模型请求封装、Provider Adapter、缓存用量与成本观测
> 前置设计：[Prefix Cache 友好的 Context Encoding 正式布局 v1](morphz_prefix_cache_context_encoding_layout_v1.md)

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

但当前生产请求还有一层没有表达出来的物理边界：Runtime 先通过
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

## 2. 已完成的真实验证

2026-08-28 使用现有 `mini-m4.local` CLIProxyAPI 路线，对 GPT-5.6 Sol 做了单条
User Message 内多内容块的真实 A/B。请求仍然只有一条逻辑 User Message，但
`content` 被划分为两个 `input_text` 块，第一块末尾设置显式缓存断点：

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

物理响应模型为 `gpt-5.6-sol`。这组验证说明：

1. 缓存断点可以位于同一条 User Message 的内容块之间；
2. 断点之后的动态内容不会破坏断点之前的缓存；
3. 断点之前发生变化时，缓存会按预期失效；
4. 缓存元数据不需要写入 S 表达式，也不需要成为模型可见文本。

本次 A/B 直接验证的是 `prompt_cache_breakpoint`。`prompt_cache_key` 是官方接口提供的
另一项缓存分组提示，但不是本次 96.6% 命中的前提。

该线路没有报告 `cache_write_tokens`，但后续请求报告了 23,296 个 cached input tokens，
足以证明稳定前缀被实际复用。不同 Provider 对写入用量的报告字段并不统一，不能把
`cache_write_tokens = 0` 解读为没有写入缓存。

这只是实现可行性验证，不作为论文实验结果。

### 2.1 生产路径验证

第一阶段实现完成后，又使用 Morphz 正常请求路径进行了隔离烟测。实际链路为：

```text
Morphz → CLIProxyAPI（mini-m4.local）→ OpenAI Responses 协议 → GPT-5.6 Sol
```

在同一个持续运行的 Runtime 进程、同一 Context 和同一 Session 中连续发送两轮对话请求，
第一轮为 20,853 个输入词元、缓存命中 0；第二轮为 21,202 个输入词元，其中 11,776 个为
缓存输入词元，命中率为 55.5%。这证明缓存字段不仅存在于独立探针中，也已经进入 Morphz
生产请求封装，并能经 CLIProxyAPI 形成实际缓存命中。

另一个紧接着完成的同激活工具回合没有观察到缓存命中。两次观测说明“字段已经生效”与
“每一次连续调用都会立即命中”不是同一结论；缓存建立时机、请求前缀变化和工具回合间隔
仍需由正式 A/B 分开测量。本文不把这组烟测当作最终成本结论。

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

### 3.4 第一阶段采用精确协议和模型门控

第一阶段只在请求协议明确为 OpenAI Responses、物理模型精确属于 GPT-5.6 家族时发送显式
断点；Provider 可以是官方端点，也可以是已经通过探针的 CLIProxyAPI。实现不依赖
`openai-codex` Adapter，也不从 `gpt`、`claude`、`deepseek` 或 `qwen` 等模糊名称推断
Provider 身份。未来扩展到其他物理模型或协议时，应先增加显式能力配置和端点探测。

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

每个封闭 Inbox 块使用以下信息形成稳定身份：

```text
Context ID
Context Protocol Version
first Event Sequence
last Event Sequence
canonical block hash
```

这些信息保存在请求准备阶段的本地元数据中，不进入 Context。下一轮新增 Observation 时，
旧块的 Sequence 范围和内容哈希保持不变，Planner 就能选择旧块末端作为读取断点，同时选择
新 Inbox 末端作为写入断点。如果旧 Observation 被 Retire 或 Restore，内容哈希和连续范围
发生变化，旧边界自然不再被选择。

第一版不需要让 Runtime 判断某段文本在语义上“重要不重要”。它只依据 Context 已有的
稳定性规则和 Event Sequence 进行确定性分块。

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

### 4.3 Context 的建议内容块

当前第一阶段采用三个内容块：

1. **固定协议块**：固定引导、`context` 根开头、`protocol` 和稳定的
   `evaluation-profile`；
2. **完整 Inbox 块**：覆盖本轮完整的活跃 Inbox，并在末端设置断点；
3. **动态尾部块**：`observation-state`、`mind`、`session-directory`、`kernel`、
   `evaluation-environment`、`evaluate` 和 Context 根的结束括号。

这些块拼起来仍是一段合法且与当前完全相同的 S 表达式文本。Provider Content Block
边界可以出现在 S 表达式的两个字符之间，但不会向文本插入任何标记，因此不会破坏语法。

## 5. Inbox 的增量边界

当前实现已经为完整 Inbox 末端设置断点；新增 Observation 会改变该块，因此仍可能失去
上一轮 Inbox 末端的缓存。下一阶段再按确定性规则把 Inbox 分成不可变的连续块，例如：

- 按连续 Event Sequence 范围分块；
- 同时设置目标词元上限，避免单块无限增长；
- 一个块封闭后不再追加内容；
- 新 Observation 进入新的活动块；
- 每个封闭块记录内容指纹，但指纹不进入模型文本。

每次请求最多选择少量战略边界：

1. 固定协议块末端；
2. 上一轮已经封闭的 Inbox 末端；
3. 本轮最新 Inbox 末端，用于下一轮；
4. 保留一个边界给特定 Provider 或长任务策略。

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

当前实现以 **Context** 为 Cache Cohort，而不是以 Session 为主体。多个 Session 挂载同一
Context 时使用同一个稳定键；第一阶段的键为 Context ID 的非秘密哈希。物理模型、账户和
端点仍由 Provider 侧自然隔离，模型可见字节发生变化时也不会错误命中。后续如需跨 Context
复用公共 System / Tool 前缀，再评估由以下信息形成更细的分层键：

```text
Provider Instance
Physical Model
Adapter / Protocol Revision
System Prompt Hash
Tool Schema Hash
Context ID
Context Protocol Version
Evaluation Profile Artifact Hash（如存在）
```

不能把 Turn ID、Activation ID、随机请求 ID 或当前时间放进 Cohort Key。任何会改变模型可见
固定前缀的配置都必须形成新的 Cohort。

`prompt_cache_key` 不是权限边界；Context 的访问控制仍由 Morphz 的 Principal、Session、
Context 投影和 Provider 账户隔离负责。

## 7. Provider 能力模型

当前第一阶段使用“OpenAI Responses 协议 + GPT-5.6 物理模型家族”的精确门控。后续扩展时，
应在 `ProviderModelConfig` 增加可选 Prompt Cache 能力配置，而不是复用模型路由的业务能力
列表：

```text
prompt_cache.strategy:
  disabled
  implicit-prefix
  explicit-content-boundaries
  explicit-cache-resource

prompt_cache.max_boundaries_per_request
prompt_cache.retention
prompt_cache.usage_reporting
```

这里的配置描述物理端点能力，不要求上层任务必须具备缓存。在能力配置实现以前，其他协议
和模型默认不发送任何 Provider-specific 字段，只保留稳定的字节布局。

建议的 Provider 映射如下：

| Provider / 协议 | 第一阶段行为 | 说明 |
| --- | --- | --- |
| OpenAI Responses | 内容块上的 `prompt_cache_breakpoint`，并发送支持的 cache options / key | 已在 GPT-5.6 Sol 路线完成真实可行性验证 |
| OpenAI Chat Compatible | 默认不启用；只有精确端点声明且探测通过后才映射 | 不能因“OpenAI compatible”就假定支持 Responses 字段 |
| Anthropic Messages | 把内部边界映射为内容块 `cache_control` | 字段、TTL 和计费方式与 OpenAI 不同 |
| DeepSeek / Qwen 自动缓存端点 | 不发送显式断点，继续保持稳定字节前缀 | DeepSeek 官方说明为自动前缀缓存；实际兼容端点仍以配置和 Usage 为准 |
| Gemini implicit caching | 不发送显式断点，保留稳定前缀并读取 Usage | 新模型支持隐式缓存，但不等于支持 OpenAI 字段 |
| Gemini explicit caching | 后续映射为独立 Cached Content 资源 | 涉及资源创建、TTL 和生命周期，不纳入第一阶段 |
| 未知 Provider | 忽略缓存提示，发送语义等价的普通文本 | 正确性不受影响 |

官方接口参考：

- [OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
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

Inbox 增量分块、Retire / Restore 谱系和首次分歧定位属于下一阶段测试。

### 9.2 Adapter 合同测试

每种协议验证完整 JSON：

- OpenAI Responses：`input_text` 数组、断点、cache options 和 key 的准确位置；
- Anthropic：第一阶段拼接为原普通文本，不发送 OpenAI 字段；
- DeepSeek / Qwen / Gemini implicit：不出现未知字段；
- 未知兼容端点：退化为普通文本且内容完全相同；
- `openai-codex` 兼容 Adapter 与普通 Responses Adapter 都保留标准缓存字段。

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

### Phase 2：OpenAI Responses 显式边界（第一轮已完成）

- 在精确配置的 GPT-5.6 Sol 物理路线启用；
- 增加 `prompt_cache_key` / Cohort；
- 已完成独立字段 A/B 和 Morphz 正常生产路径烟测；
- 正式多场景成本 A/B 留到下一次 Benchmark 前执行并冻结。

### Phase 3：Inbox 增量分块

- 冻结块大小与边界选择规则；
- 验证 append、Mind revision、Session switch 和 retire；
- 记录首次分歧位于哪个 Context region 和哪个内容块。

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

## 13. 需要评审的决策

实现前需要明确以下选择：

1. 是否确认缓存边界只属于临时传输表示，不进入 Yao 和 Event Store；
2. 是否采用 Context 级而非 Session 级 Cache Cohort；
3. Inbox 按 Observation 数量、估算词元还是两者共同约束分块；
4. OpenAI 每轮四个边界的具体分配；
5. 生产环境是否允许一次无缓存降级重试；
6. 第一阶段是否只实现 OpenAI Responses，其他 Provider 在 A/B 通过后再接入；
7. 达到怎样的成本下降和正确率门槛后默认开启。

当前建议答案是：

- 采用只存在于请求封装层的临时分块；
- Cache Cohort 绑定 Context，使共享 Context 的多个 Session 可以复用稳定前缀；
- Inbox 在 Observation 边界上分块，并同时设置目标词元上限；
- OpenAI 每轮使用“固定协议、上一稳定 Inbox 末端、当前 Inbox 末端”三个边界，保留第四个；
- 生产模式允许一次有记录的无缓存降级，Benchmark 模式禁止静默降级；
- 第一阶段只实现并验证 OpenAI Responses，再扩展其他 Provider；
- 默认开启前要求任务结果不退化，并在代表性长 Context 上观察到可重复的真实 API 成本下降。

## 14. 建议结论

建议采用本方案，但分两步决策：

1. 先批准“传输层分块、语义文本不变”的总体架构；
2. 再通过 GPT-5.6 Sol 多场景 A/B 决定具体分块大小、断点分配和默认启用范围。

这样既保留 v26 已经验证过的稳定布局，也补上 Provider 看不到单个字符串内部稳定边界的
缺口。修复不需要改变 Structured Context、Yao 程序或 Mind Frame 的语义。
