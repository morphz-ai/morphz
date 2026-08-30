# 九模型同题 Structured ContextDelta Prefix Cache A/B

> 日期：2026-08-30
>
> 任务：`terminal-bench/cancel-async-tasks`
>
> Runtime 基线：`89adf739454da52bce2b35b00fb9e8fa050c5557`
>
> 结论范围：同一道真实任务、每个模型各一个默认轨迹和一个 delta 轨迹；不是模型总体均值

## 结论

Structured ContextDelta 应当实现成 **Provider 中立、按物理模型显式启用** 的实验优化，而不能
成为全局默认。相同任务、System Prompt、生产 tools 和 reasoning effort 下，排除各轨迹第一次
请求后的加权命中率如下：

| 模型 | 默认完整 Context | 开启 ContextDelta | 变化 | 85% 参考线 | 当前建议 |
| --- | ---: | ---: | ---: | --- | --- |
| `glm-5.3` | 86.46% | **95.96%** | +9.51 pp | 两组均超过 | 开启可进一步降本 |
| `k3-256k` | 85.67% | **95.58%** | +9.91 pp | 两组均超过 | 开启可进一步降本 |
| `deepseek-v4-pro` | 75.25% | **95.83%** | +20.58 pp | delta 超过 | 建议开启 |
| `qwen3.8-max-preview` | 61.87% | **94.20%** | +32.33 pp | delta 超过 | 建议开启 |
| `gpt-5.6-sol` | 54.18% | **93.37%** | +39.20 pp | delta 超过 | 建议开启 |
| `bai-deepseek-v4-flash` | 53.96% | **76.02%** | +22.07 pp | 均未超过 | 有收益但仍有整段 miss，复测后启用 |
| `claude-opus-5` | 39.39% | **74.35%** | +34.97 pp | 均未超过 | 有收益；还应对照原生显式缓存 |
| `gemini-3.7-flash-high` | 0% | **0%** | 0 pp | 均未超过 | 当前真实任务链路待隔离，暂不启用 |
| `grok-4.6` | **77.63%** | 44.11% | **-33.53 pp** | 均未超过 | 当前单 User 多 block transport 不要开启 |

这说明 delta 不是 GPT-5.6 的专用 workaround：五个物理模型在本题上进入 93%--96% 的稳态
区间，其中 Qwen、DeepSeek Pro 和 GPT 的改善超过 20 个百分点。但它也不是普遍单调优化：
Grok 明显退化，Gemini 完全没有收益。因此产品形态应当是通用机制、默认关闭、按 Provider 的
物理模型配置，而不是按 Adapter 名字或模型品牌自动猜测。

Gemini 的物理模型名和 Morphz 侧 Adapter 都不能单独确定 Proxy→Google 的最终协议。已知事实
仅为 Morphz 用 `openai-responses` 向 Proxy 发请求；本轮没有抓取或审计 Proxy 的最终上游包，
而 Proxy 完全可能把请求转换为 Google 原生协议。因此不能把零值归因于 Google 的 OpenAI
兼容接口，也不能反向断言原生接口有问题。结合相同 Proxy 路线的长文本能力探针曾达到
96.40%，本轮零值应严格标记为“真实任务请求形状、上游缓存、Proxy 转换或 usage 映射待隔离”，
不能写成 Gemini 不支持缓存。

Grok 的退化则有更具体的协议证据。默认轨迹的 cached tokens 为
`0 → 16,384 → 22,912 → 22,912`，delta 轨迹为
`128 → 128 → 16,000 → 16,000 → 16,000`；它能缓存，但深度稳定停在约 16K。当前 delta
transport 是一条 User message 内追加 `input_text` blocks，并不是追加顶层 messages。xAI 官方
缓存契约要求保持既有 messages 完全不变、只在末尾追加新 message，并建议 Responses 使用稳定
`prompt_cache_key`；官方没有承诺同一 message 内追加 content blocks 是缓存边界。Morphz 已生成
稳定 key，但本轮没有保存 Proxy 最终转发给 xAI 的包，因而最强结论是：当前 Proxy/xAI 路线
没有复用后续 blocks，疑似只复用了前部固定区域。若继续优化 Grok，应单独对照单 string、
单 User 多 blocks、顶层 append messages 三种完全固定输入，而不是把 Grok 的负结果归因于
Structured ContextDelta 求值语义。

## 实验控制

- 两组运行同一份任务 instruction，每个模型使用独立空 workspace、SQLite 和 Context；
- 两组都使用生产 System Prompt、提交 `89adf73` 固定后的生产 tools、
  `MORPHZ_CODING_EVAL_MODE=true` 和 reasoning effort `low`；
- 默认组使用一条 User message、一个完整 canonical Structured Context text block，策略为
  `implicit-prefix`；
- delta 组使用一条 User message：block 0 是完整闭合 Context seed，后续 blocks 是有序、闭合、
  使用 canonical Observation schema 的 Structured ContextDelta；策略为
  `experimental-structured-deltas`；
- Morphz 向 Proxy 发送八个模型的 `openai-responses` 请求和 Claude 的
  `anthropic-messages` 请求，端点均为 `http://mini-m4.local:8317/v1`；这些标签只描述
  Morphz→Proxy 的可观测边界，不描述 Proxy→各上游的最终协议；
- 命中率使用 Provider 返回的 `cached_input_tokens / input_tokens`，不是本地估算；
- 汇总排除每条独立轨迹的第一次请求。delta 紧接默认组运行，部分 delta 首请求可能复用了上一组
  的 canonical 初始前缀，因此首请求不能作为独立冷启动证据。

delta 实验二进制 SHA-256 为
`600773bd1b28f13a1534e65626bfbad94b431a9cf844a5c38c54c50ec90c1a85`；配置 SHA-256 为
`c46934dbe6093442ebd61d8fd83567f40d15a2d8bede224dfe2fcb8374074699`；任务 instruction
SHA-256 为 `bed4cb65251eb3e0cf833fc80f67d623ea4b5b98abba998a09b4fdbc81ff4a57`。

## delta 原始 usage

以下均按请求顺序记录 `(input_tokens, cached_input_tokens)`：

- GPT：`(22070,0) (22391,20992) (23207,22016) (24040,22016)`
- Qwen：`(25208,21504) (25983,24576) (26703,25344) (27239,25600) (28760,26624) (30188,28672)`
- DeepSeek Pro：`(25432,14720) (25766,25344) (28206,25728) (28712,28160)`
- DeepSeek Flash：`(25474,22528) (25811,24576) (26793,0) (27401,24576) (28769,27136) (29291,28672)`
- K3：`(23134,20480) (23465,23040) (24507,23296) (25946,24320) (26810,25856) (28678,26624) (29149,28416)`
- GLM：`(24458,21504) (24764,24320) (25411,24576) (26361,25344) (27749,26112) (28588,27648) (30702,28416) (31166,30464)`
- Gemini：`(24059,0) (24424,0) (25557,0) (26301,0) (27065,0)`
- Grok：`(25211,128) (25646,128) (26606,16000) (28457,16000) (28408,16000)`
- Claude：`(39883,17348) (40332,31828) (42061,31828) (44040,31828) (44792,31828)`；Claude
  还分别报告 cache write `22533, 8502, 10231, 12210, 12962`。

DeepSeek Flash 的 delta 轨迹在预热后仍有一次整段 miss；Grok 的前两次读取仅为 128 tokens，
之后固定在 16,000 tokens，导致 delta 反而比默认结构差。Gemini 五次均报告零缓存。不能用末轮
或单次峰值替代整条轨迹的加权统计。

## 执行正确性边界

九个 delta CLI 运行都正常退出并生成 `run.py`；按模型隔离进程的统一离线 verifier 中，九个
实现都通过普通并发上限和完整执行检查。更严格的“外层取消后等待 `finally` 内异步 cleanup
完成”检查中，delta 组的 GPT、K3、Gemini 通过；默认组的 K3、Grok 通过。该差异来自两组各自
一次模型生成的候选程序，不能用来证明缓存布局改善或损害答案质量。若要比较任务质量，需要
独立的多 seed 重复实验；本报告只据 Provider usage 给出缓存建议。

## 实现边界

通用编译特性名为 `experimental-structured-context-delta-cache`；旧名称
`experimental-openai-chatgpt-structured-cache` 保留为向后兼容别名。编译特性只把能力加入
Runtime，Dashboard 仍要求用户在具体 Provider/物理模型上选择
`experimental-structured-deltas`。OpenAI Responses、OpenAI Chat、Anthropic Messages 和
Gemini Content Adapter 都保留原生多 text block 形状；本次真实 A/B 覆盖 Morphz→Proxy 的
Responses 和 Anthropic 两种请求编码，但没有审计 Proxy→物理 Provider 的最终编码。其余
Morphz Adapter 目前只有确定性序列化测试，不能写成真实 Provider 结论。

## 产物

- 机器可读 A/B：
  `docs/research/paper_evaluation/artifacts/prompt_cache_nine_model_real_task_delta_ab_20260830.json`
- Token、cache-write 与官方 API 等价成本汇总：
  `docs/research/paper_evaluation/prompt_cache_nine_model_real_task_token_usage_20260830.md`
- 默认组报告：
  `docs/research/paper_evaluation/prompt_cache_nine_model_real_task_no_delta_20260830.md`
- delta 每模型 SQLite、workspace 和日志：
  `/private/tmp/morphz-nine-model-real-task-delta-20260830`
- 默认组原始运行：
  `/private/tmp/morphz-nine-model-real-task-no-delta-20260830`
