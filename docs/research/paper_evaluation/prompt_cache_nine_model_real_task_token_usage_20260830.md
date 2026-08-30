# 九模型同题 Prefix Cache A/B Token 与成本统计

> 日期：2026-08-30
>
> 来源：两组运行各模型 SQLite 中唯一的 `runtime/model_usage` 事件
>
> 任务：`terminal-bench/cancel-async-tasks`

## Token 总计

`总 token = input token + output token`；`cached input` 是 input 的子集，不应再加进总 token。
`cache write` 同样是 input 的计费分类，不额外计入总 token。

| 口径 | 请求 | input | output | 总 token | cached input | cache write | cached/input |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 默认 Context，全程 | 50 | 1,437,342 | 33,607 | **1,470,949** | **753,168** | 146,681 | 52.40% |
| ContextDelta，全程 | 50 | 1,401,174 | 54,019 | **1,455,193** | **1,012,116** | 66,438 | 72.23% |
| 默认 Context，排除各模型首请求 | 41 | 1,202,289 | 27,823 | **1,230,112** | **753,168** | 106,786 | 62.64% |
| ContextDelta，排除各模型首请求 | 41 | 1,166,245 | 37,380 | **1,203,625** | **893,904** | 43,905 | 76.65% |

全程实际消耗中，delta 比默认结构少 36,168 input tokens、多 20,412 output tokens，总 token
少 15,756；cached input 多 258,948。更公平的稳态口径中，总 token 少 26,487，cached input
多 140,736，未缓存 input 从 449,121 降到 272,341，下降 39.36%。

delta 组的部分首请求紧接默认组运行，可能复用了上一组 initial canonical prefix，所以 72.23%
是实际发生的全程统计，但不能当成独立冷启动 A/B。产品命中率比较应优先使用排除首请求的
76.65%，以及主报告中的逐模型稳态命中率。

## 九个模型逐项结果

这里的命中率统一使用“排除该模型第一次请求后的 cached input / input”；总 token 和 cached
则是该模型整条实际轨迹的全程总量。两种口径在列名中明确区分，不能相互除算。

| 模型 | 默认请求 | 默认总 token | 默认 cached | 默认稳态命中 | delta 请求 | delta 总 token | delta cached | delta 稳态命中 | 总 token 变化 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `gpt-5.6-sol` | 4 | 93,877 | 38,400 | 54.18% | 4 | 92,963 | 65,024 | **93.37%** | -0.97% |
| `qwen3.8-max-preview` | 5 | 141,373 | 68,608 | 61.87% | 6 | 174,694 | 152,320 | **94.20%** | +23.57% |
| `deepseek-v4-pro` | 6 | 182,001 | 111,104 | 75.25% | 4 | 128,336 | 93,952 | **95.83%** | -29.49% |
| `bai-deepseek-v4-flash` | 7 | 215,294 | 99,584 | 53.96% | 6 | 171,112 | 127,488 | **76.02%** | -20.52% |
| `k3-256k` | 7 | 188,857 | 136,448 | 85.67% | 7 | 188,681 | 172,032 | **95.58%** | -0.09% |
| `glm-5.3` | 8 | 220,702 | 167,424 | 86.46% | 8 | 221,651 | 208,384 | **95.96%** | +0.43% |
| `gemini-3.7-flash-high` | 4 | 104,306 | 0 | 0% | 5 | 128,324 | 0 | **0%** | +23.03% |
| `grok-4.6` | 4 | 106,708 | 62,208 | 77.63% | 5 | 135,917 | 48,256 | **44.11%** | +27.37% |
| `claude-opus-5` | 5 | 217,831 | 69,392 | 39.39% | 5 | 213,515 | 144,660 | **74.35%** | -1.98% |

Claude 默认组还报告 146,681 cache-write tokens；delta 降到 66,438，减少 80,243。其他路线
没有返回 cache-write usage，不能把 0 解释成服务端从未写缓存，只能解释成响应没有单独报告。

## 为什么 delta 组的总 token 反而略少

这不是“命中缓存后 usage 少算了 token”。Provider 的 `input_tokens` 已经包含
`cached_input_tokens`；例如一次请求报告 20,000 input、18,000 cached，总输入仍是 20,000，
缓存只改变计算复用和计价，不改变 usage token 总数。

两组虽然运行同一道题，但不是固定轨迹 replay：模型看到等价但布局不同的 Context 后，会生成
不同回复、工具调用和循环长度。DeepSeek Pro 的请求数从 6 次变成 4 次，DeepSeek Flash 从 7
次变成 6 次；Qwen、Gemini、Grok 则各增加 1 次。九模型两组恰好都合计 50 次只是抵消后的巧合。
总 token 的 -1.07% 主要是这些轨迹长度变化的净结果。

请求数相同的 GPT、K3、GLM、Claude，其总 token 变化分别只有 -0.97%、-0.09%、+0.43%、
-1.98%，也不支持“delta 本身会系统性减少 token”的结论。因此本实验可以证明 delta 改善或
损害了各物理模型的缓存命中，但不能从一次生成轨迹证明 delta 会减少语义工作量。要单独估计
编码开销，需要把同一条已冻结 Context 状态序列分别序列化/replay；要估计 Agent 端到端 token
期望，则需要每个模型多 seed 重复运行。

## 官方 API 等价成本估算

这些调用实际经过 `http://mini-m4.local:8317/v1`，可能使用订阅、代理额度或不同结算规则，
所以下表不是账单，只是把本次 usage 套入当前官方公开单价后的参考值。公式为：

`(uncached input × input price + cached input × cache price + output × output price) / 1,000,000`

| 物理模型 | 单价依据（USD/MTok：input / cached / output） | 默认全程 | delta 全程 | 观察变化 | 稳态变化 |
| --- | --- | ---: | ---: | ---: | ---: |
| `gpt-5.6-sol` | 4 / 0.4 / 20 | $0.2521 | $0.1578 | **-37.38%** | **-57.83%** |
| `deepseek-v4-flash` | 0.22 / 0.007 / 0.66，实验时段为 off-peak | $0.0285 | $0.0138 | **-51.44%** | **-51.10%** |
| `deepseek-v4-pro` | 0.66 / 0.022 / 1.98，实验时段为 off-peak | $0.0610 | $0.0515 | **-15.60%** | **-42.04%** |
| `gemini-3.7-flash` | 0.75 / 0.075 / 3.75，2026 推广价 | $0.0817 | $0.0990 | **+21.14%** | **+27.17%** |
| `grok-4.6` | 2 / 0.5 / 6 | $0.1255 | $0.2058 | **+64.00%** | **+108.26%** |
| `qwen3.8-max-preview` | 参考 qwen3.8-max Global：1.65 / 0.206 / 4.951 | $0.1516 | $0.1033 | **-31.82%** | **-18.58%** |
| `k3-256k` | 参考 kimi-k3：3 / 0.3 / 15 | $0.2755 | $0.1855 | **-32.69%** | **-14.99%** |

这七个可映射模型的本次观察成本合计由 $0.9758 降至 $0.8167（-16.30%）；排除各模型首请求
后由 $0.6556 降至 $0.5831（-11.06%）。不能把这个七模型合计外推成真实代理账单，也不能
用于模型间性价比排名或 delta 的无偏因果收益，因为两组各自生成的输出 token 数、工具步数和
请求数并不完全相同。

`claude-opus-5` 与 `glm-5.3` 没有找到和本次物理名称精确对应的官方公开 SKU，因此不使用旧
Opus 或 GLM-5.2 的价格替代。GPT-5.6 官方还说明 cache write 可能按 1.25 倍 input 计费，而本次
usage 未单列其写入量，所以 GPT 数字按普通 uncached input 计算，是近似值。

官方价格来源：

- OpenAI GPT-5.6 Sol：<https://developers.openai.com/api/docs/models/gpt-5.6-sol>
- DeepSeek V4：<https://api-docs.deepseek.com/quick_start/pricing/>
- Gemini 3.7 Flash：<https://ai.google.dev/gemini-api/docs/pricing>
- xAI Grok 4.6：<https://docs.x.ai/developers/models/grok-4.6>
- Alibaba Cloud Qwen3.8 Max：<https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max>
- Kimi K3 官方公告：<https://forum.moonshot.ai/t/kimi-k3-is-here-our-most-capable-model/480>

## 原始数据位置

- 默认组：`/private/tmp/morphz-nine-model-real-task-no-delta-20260830`
- delta 组：`/private/tmp/morphz-nine-model-real-task-delta-20260830`
- 机器可读汇总：
  `docs/research/paper_evaluation/artifacts/prompt_cache_nine_model_real_task_token_usage_20260830.json`
