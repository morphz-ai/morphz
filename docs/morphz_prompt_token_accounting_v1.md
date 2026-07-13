# Morphz Prompt Token Accounting v1

## 1. 目标

Context pressure 是 Runtime 对模型物理窗口的控制信号。它应尽量接近模型真正收到的 Prompt，但 Runtime 不能把启发式字符估算、本地 tokenizer 切分或跨协议请求伪装成精确值。

旧局部估算只覆盖活动 Frame 与 Observation，会漏掉 System Prompt、Context Protocol、工具 JSON Schema 和标准工具回合。v1 的目标是：

- 在 completion 前计量候选的完整工作请求；
- 由协议 Client 和显式本地能力声明决定如何计数；
- 支持本地 tokenizer、completion usage 校准与启发式回退；
- 对每个值明确标记来源、范围和可信度；
- Token 计量只控制物理压力，不替 Agent 决定摘要或退役哪些语义内容。

## 2. 核心边界：主链路只做本地计量

Morphz 不根据 Provider 名、模型名或 Base URL 猜测 Token 计数方式，也不跨协议计数。更重要的是，核心模型求值路径不允许 Token 计数产生任何额外远程请求。

- 各协议 Client 只能使用 completion 本身的 usage 回执、显式配置的本地 tokenizer 和本地估算；
- Anthropic token-count 与 Gemini `countTokens` 即使可用，也不接入自动 Context pressure 主链；
- 将来如果需要核验 Provider 计数，只由用户显式执行的诊断命令访问，不由 Agent loop 自动调用。

例如，请求通过 `/v1/chat/completions` 发出时，即使模型名中包含 `gemini`，OpenAI-compatible Client 也不得改走 Gemini `countTokens`。两个协议的消息编码、工具表示和隐藏 Chat 模板可能不同，因此跨协议数值不具有精确性。

## 3. 能力层，而不是 Provider 分支树

Runtime 使用可插拔、同步且不许访问网络的 `LocalPromptTokenCounter`。请求 Client 显式提供：

- `protocol`：实际请求协议；
- `model`：Provider 中的模型标识；
- `messages`：完整消息；
- `tools`：完整工具定义；
- 协议特有的生成配置。

Local Counter 实现可以是：

1. **本地 tokenizer + chat template**：Provider profile 显式给出 tokenizer 资产和模板；
2. **usage 校准估算**：用正常 completion 回执的真实输入 Token 校准后续请求；
3. **启发式回退**：没有更好能力时，只用于安全压力预估。

因此，即使未来有上百个 Provider，也不应在 Runtime 中实现上百个 `if provider == ...`。多数 Provider 复用少数协议 adapter 和通用 Counter；只有真正特殊的协议才增加新 adapter。

## 4. 成熟 tokenizer 库的位置

现成库是必要的，但它们不能在缺少模型声明时自动变成通用精确计数器。

- [`tiktoken`](https://github.com/openai/tiktoken) / [`tiktoken-rs`](https://docs.rs/tiktoken-rs/)：适用于明确使用 OpenAI tiktoken encoding 的模型；
- [Hugging Face Tokenizers](https://github.com/huggingface/tokenizers)：Rust 原生，可加载 `tokenizer.json`，覆盖 BPE、WordPiece、Unigram 等大量开源模型；
- [SentencePiece](https://github.com/google/sentencepiece)：适用于显式提供 SentencePiece 模型资产的模型。

tokenizer 只能决定“一段已渲染文本如何切分”。对 Chat 请求而言，Provider 还会把 role、System、Tool Schema 和 Tool Result 通过 chat template 编码成模型输入。[Hugging Face 文档](https://huggingface.co/docs/transformers/chat_templating) 明确指出，即使来自同一基础模型，不同 Chat 模型也可以使用不同模板和控制 Token。[OpenAI Cookbook](https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb) 也将 Chat/Tools 的本地计数定义为估算，而非永久精确保证。

所以，只有同时掌握正确 tokenizer、chat template、工具渲染规则和特殊 Token 时，本地计数才可能标记为 `exact`。

## 5. 公开 Coding Agent 参考：Codex

OpenAI Codex 的公开源码并不在每轮前请求 Token 计数端点，也不要求核心路径拥有精确 tokenizer。

- [`ContextManager`](https://github.com/openai/codex/blob/main/codex-rs/core/src/context_manager/history.rs) 保存最近一次 API 返回的 `TokenUsage`；
- 当前活动用量为“最近服务端 usage + 最近模型输出后新增本地 Item 的估算”；
- 本地估算将 model-visible Item 序列化后用字节公式近似，源码注释明确称之为“粗略下界，不是 tokenizer 精确计数”；
- [`context_window_token_status`](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/context_window.rs) 使用这个活动用量判断是否达到压缩阈值；
- `BodyAfterPrefix` 模式还可以用服务端 usage 确定稳定 Prefix 的基线，仅计算后续 Body 增长。

这个实现证明，对长程 Coding Agent 更实用的是“服务端真值锚点 + 本地尾部增量估算”，而不是在每次求值前重复计算或上传整个 Context。Morphz 的差异在于，该压力信号用于要求 Agent 自主维护 Mind，而不是由 Runtime 自动决定删除哪些语义内容。

## 6. 可信度标记

`PromptTokenCount.accuracy` 目前支持四档：

| 标记 | 含义 |
| --- | --- |
| `exact` | Client 能证明计数与实际模型输入一致 |
| `local-tokenizer-estimate` | tokenizer 正确，但 chat/tool 封装仍可能有误差 |
| `usage-calibrated-estimate` | 启发式或 tokenizer 估算已用真实 completion usage 校准 |
| `heuristic-estimate` | 无可验证 tokenizer 时的最后回退 |

Context Encoding 会把来源与可信度同时呈现给 Agent：

```lisp
(context-pressure
  (level normal)
  (estimated-tokens 9959)
  (token-source openai-compatible-request-estimate+usage-calibration)
  (token-accuracy usage-calibrated-estimate)
  (token-scope full-work-prompt)
  (token-model gemini-3-flash-agent)
  ...)
```

`token-model` 只是实际请求中的模型标识，不用于推断计数协议。

## 7. 当前 OpenAI-compatible 实现

当前产品主链只实现了 OpenAI Chat Completions-compatible Client。该协议没有被 Morphz 依赖的通用预请求 Token 端点，因此：

1. completion 前对实际要发送的完整 OpenAI-compatible JSON 请求做启发式估算；
2. 估算覆盖 System、Context Encoding、工具历史和完整 Tool Schema；
3. completion 返回 `usage.prompt_tokens` 后，按“Context + Session 求值链路 + 模型标识 + 工具定义”保存真值锚点；
4. 下一次请求以该真值为基线，只叠加本地估算得到的请求大小增减量，因此上下文增长和缩小都能被反映；
5. 整个过程不发起额外计数请求，不识别 Provider，不检查模型名关键词。

measurement 随对应 completion 调用直接传递，不能按请求内容哈希放进共享暂存表。否则两个 Session 在并发发送相同请求时会互相覆盖。usage 锚点也按 Context/Session 求值链路隔离；共享 Mind 不等于共享会话的计量状态。

两个常见来源是：

- `openai-compatible-request-estimate`：未校准的完整请求启发式估算；
- `openai-compatible-request-estimate+usage-calibration`：已经 completion usage 校准的估算。

这条路径的作用是在未知 Provider 上提供可用的压力信号，不是替代可验证的 tokenizer。

## 8. Provider Profile 的目标形态

后续 Provider profile 应把“交通方式”与“Token 能力”分开声明，概念形式如下：

```toml
[llm]
protocol = "openai-chat-completions"
base_url = "https://provider.example/v1"
model = "some-model"

[llm.token_counter]
strategy = "local-tokenizer"
kind = "huggingface"
tokenizer_asset = "./tokenizers/some-model/tokenizer.json"
chat_template = "./tokenizers/some-model/chat_template.jinja"
```

如果 profile 没有提供足够的本地资产，Runtime 不猜测。Anthropic/Gemini 的远程计数能力不属于这个 profile 主链，将来只属于显式诊断命令。

## 9. 与自动压缩的关系

Orchestrator 在模型求值前完成计量，重新计算 `normal / notice / warning / critical`，并重新渲染 Context Encoding。模型在当轮就能看到新压力：

- `warning`：由 Agent 选择何时、如何维护 Mind；
- `critical`：Runtime 暂停外部高成本工具，保留 Context 维护、Recall 与 Reply 边界；
- Context transaction 完成后，下一轮重新对缩小后的完整 Prompt 计量。

“什么时候必须释放物理预算”由 Runtime 的计量与安全余量控制，“保留、摘要、修订或退役什么”仍由 Agent 决定。

## 10. 当前边界

- OpenAI-compatible 主链目前只有完整请求估算与 usage 校准，没有精确预请求计数；
- `tiktoken-rs`、Hugging Face Tokenizers 和 SentencePiece 尚未连到 profile 配置；
- Anthropic-compatible 与 Gemini-compatible Client 尚未实现；实现后也不会在核心求值路径调用远程 Token 计数；
- usage 校准当前保存在进程内，Runtime 重启后需要重新学习；
- 模型 Context Window 的 soft/hard limit 仍由 Morphz 配置提供，尚未从 Provider metadata 中发现；
- 历史 Context Pressure Eval 的合成 Client 使用固定计数，用于验证压力状态机，不代表生产 tokenizer 精度。
