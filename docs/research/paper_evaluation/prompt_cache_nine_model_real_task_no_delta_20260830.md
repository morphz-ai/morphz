# 九模型同题默认 Structured Context Prefix Cache 实验（无 ContextDelta）

> 日期：2026-08-30
>
> 任务：`terminal-bench/cancel-async-tasks`
>
> Runtime：`89adf739454da52bce2b35b00fb9e8fa050c5557`
>
> 结论范围：同一道真实任务、单次轨迹的 prefix-cache 与执行行为对照；不是九模型总体均值

## 结论

“单条 User message、单个完整 Structured Context text block 不会缓存”是错误结论。同一套
默认结构在九个模型上都真实运行后，排除各自第一次冷请求的聚合结果如下：

| 排名 | 模型 | 请求数 | 排除首轮命中率 | 第 3 轮以后 | 末轮 | 整段 miss（不含首轮） |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | `glm-5.3` | 8 | **86.46%** | 86.03% | 87.44% | 0 |
| 2 | `k3-256k` | 7 | **85.67%** | 85.13% | 89.20% | 0 |
| 3 | `grok-4.6` | 4 | **77.63%** | 84.03% | 83.77% | 0 |
| 4 | `deepseek-v4-pro` | 6 | **75.25%** | 78.76% | 85.57% | 0 |
| 5 | `qwen3.8-max-preview` | 5 | **61.87%** | 55.66% | 79.71% | 1 |
| 6 | `gpt-5.6-sol` | 4 | **54.18%** | 52.67% | 51.81% | 0 |
| 7 | `bai-deepseek-v4-flash` | 7 | **53.96%** | 63.63% | 89.65% | 2 |
| 8 | `claude-opus-5` | 5 | **39.39%** | 38.23% | 37.40% | 0 |
| 9 | `gemini-3.7-flash-high` | 4 | **0%** | 0% | 0% | 3 |

因此，默认单 block 结构并非天然失效：GLM 和 K3 在这道题上不使用 ContextDelta 也超过了
85% 参考线。GPT 的稳定 tools 修复让缓存真实生效，但它只复用了约 12,800 tokens，整题聚合
为 54.18%，所以 GPT 仍然需要 Structured ContextDelta 才能达到此前实测的 92.93%。

不能只看末轮：DeepSeek Flash 末轮为 89.65%，但第 2、4 次请求整段 miss，排除首轮后的整题
聚合只有 53.96%；Qwen 也有一次整段 miss。Grok 与 DeepSeek Pro 会逐轮建立更深缓存，但本题
聚合仍未到 85%。Gemini 的长文本 synthetic probe 曾能深命中，但在携带生产 tools 的这条真实
任务轨迹中四次均报告零缓存，说明 synthetic capability 不能替代完整请求实验。

## 受控条件

- 九个模型顺序执行同一份任务 instruction，每个模型使用独立空 workspace、SQLite 和 Context；
- 使用提交 `89adf73` 的默认构建，Cargo feature
  `experimental-structured-context-delta-cache` 未编译；
- 所有模型配置 `prompt_cache_strategy = "implicit-prefix"`，未使用显式 breakpoint；
- 一条 User message、一个完整 canonical Structured Context text block；没有 ContextDelta blocks；
- 生产 System Prompt、生产 tools、`MORPHZ_CODING_EVAL_MODE=true`、reasoning effort `low`；
- 普通工作轨迹的 Provider-visible tools 由 `89adf73` 固定；每个运行的 calibration shape/key
  均只有一个 distinct value；
- Morphz 向 Proxy 发送八个模型的 `openai-responses` 请求和 Claude 的
  `anthropic-messages` 请求，均通过 `http://mini-m4.local:8317/v1`；这些名称只记录
  Morphz→Proxy 的外层协议，Proxy→上游可能发生协议转换，本轮没有观测该边界；
- 命中率使用 Provider 返回的 `cached_input_tokens / input_tokens`，不是本地估算。

二进制 SHA-256 为
`e07e4d675baa1d33605bcb2ff125ffcc800b7561a2535e3e36ab3a56bd0458c2`；配置 SHA-256 为
`a495e564a4549335ff4cf713daa37a1dae6a1abf6cbf150e9911bc5e6182357e`；任务 instruction
SHA-256 为 `bed4cb65251eb3e0cf833fc80f67d623ea4b5b98abba998a09b4fdbc81ff4a57`。

## 原始 usage

以下均按请求顺序记录 `(input_tokens, cached_input_tokens)`：

- GPT：`(22072,0) (22280,12800) (23892,12800) (24708,12800)`
- Qwen：`(25230,0) (28091,22528) (26834,0) (27696,23552) (28264,22528)`
- DeepSeek Pro：`(25464,0) (25763,15104) (34211,23168) (28943,23296) (28967,24064) (29769,25472)`
- DeepSeek Flash：`(25481,0) (28059,0) (29133,22528) (30936,0) (31846,23552) (32323,24576) (32267,28928)`
- K3：`(23141,0) (23344,20736) (24910,20992) (26594,21760) (26979,23296) (28741,24064) (28701,25600)`
- GLM：`(24465,0) (24624,22016) (26374,22272) (26767,23040) (27732,23808) (28174,24320) (29531,25344) (30449,26624)`
- Gemini：`(24073,0) (24285,0) (26652,0) (28132,0)`
- Grok：`(25230,0) (25601,16384) (27179,22912) (27352,22912)`
- Claude：`(39897,0) (40051,17348) (43592,17348) (46152,17348) (46391,17348)`；Claude
  还分别报告 cache write `39895, 22701, 26242, 28802, 29041`。

## 执行正确性边界

九个 CLI 运行都正常退出并生成 `run.py`；统一离线 smoke verifier 中，九个实现都通过普通并发
上限测试。加入“`finally` 内还有一次 await，外层取消后必须等待该异步 cleanup 完成”的严格
取消测试后，只有 K3 和 Grok 通过，其余七个实现都启动了 cleanup、但二次 cancel 中断了
cleanup 内的 await。因此本报告的缓存比较全部保留，但不能把“CLI 正常退出”误写成九个模型
都正确完成了任务的全部取消语义。

## 产物

- 机器可读汇总：
  `docs/research/paper_evaluation/artifacts/prompt_cache_nine_model_real_task_no_delta_20260830.json`
- 每模型 SQLite、workspace 与统一 verifier：
  `/private/tmp/morphz-nine-model-real-task-no-delta-20260830`
