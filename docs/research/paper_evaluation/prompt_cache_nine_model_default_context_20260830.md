# 九模型前缀缓存能力探针与真实任务校正（2026-08-30）

> 状态：九模型 synthetic capability probe 与 GPT/K3 真实 Terminal-Bench 复核完成。能力探针
> 只能回答端点是否可能复用前缀；产品命中率结论以完整 Morphz 请求为准。

## 结论

论文 ME-05 使用 **9 个模型**。在实际 CLIProxyAPI 路线、单条 User message、单个文本块、
无显式 cache breakpoint、无 ContextDelta、无 tools 的 synthetic 装置下：

- 8 个模型明确能够在一个会变化的文本块内部自动找到并复用稳定 token 前缀：
  GPT-5.6、Qwen、DeepSeek Pro、DeepSeek Flash、K3、GLM、Gemini、Grok；
- Claude Opus 5 的 `anthropic-messages` 隐式路线连续五次均为零，本次没有观察到隐式缓存；
- 6 个模型的排除 warmup 后聚合命中率超过 96%；DeepSeek Flash 因一次整段 miss 降至
  76.39%，Grok 因缓存建立延迟降至 25.87%，但二者都出现过超过 86% 的深层 Context 命中；
- GPT-5.6 的 synthetic v26 布局稳态命中率为 **98.79%**，动态字段前置对照为 **5.67%**。

这证明多个端点具备长前缀缓存能力，但不能证明真实 Morphz 请求也有相同命中率。同一道
`terminal-bench/cancel-async-tasks` 真实题给出了最终校正：

- GPT-5.6 旧工具合同：预热后 **23.81%**，与论文约 26% 的低命中一致；
- GPT-5.6 固定普通工作轨迹 tools：预热后 **50.68%**；
- GPT-5.6 固定 tools + 实验 Structured ContextDelta：预热后 **92.93%**；
- K3 默认真实请求：预热后 **62.97%**，后两轮单次命中约 84.8% 和 84.4%。

因此论文的真实低命中结果没有被 synthetic 98.79% 推翻；被推翻的只是“端点完全不具备单
block 前缀缓存能力”这一机制判断。产品修复需要同时稳定 tools 合同并提供可复用的结构化
block 边界。

ME-08 在 `d5a5fb806183f44fb5b47df65bf4def8ff8ab093` 上启动的正式批次没有包含稳定 tools
合同修复。该批次的任务正确性记录仍可作为历史样本，但 cache hit rate、cached-token 成本和
由此推导的模型成本比较不能作为修复后的正式结论，应停止继续扩充该批次并在新版本上重跑。

## 为什么上一轮三请求判定无效

上一轮让模型读取两个小文件，只产生两到三次真实模型调用，然后把最后一次 cached tokens 与
另一个时段的 scaffold-only 最大值相减。这不能定位缓存边界：

1. Qwen scaffold 控制本身出现 `15,360 → 15,360 → 0` 的非单调波动，说明单点 usage 不能
   当成稳定 ceiling；
2. 默认请求与控制请求不在同一交错 cohort，长度、时刻和缓存建立阶段都不同；
3. 小任务的稳定 Inbox 很短，三次调用不足以区分“端点不支持”和“缓存尚未建立”；
4. 该方法与已经存在的 Qwen v26 配对 A/B（87.98%）直接冲突，却错误地优先相信了小样本。

因此，那组 usage 仍是真实返回值，但由它推导出的“2 个明确、1 个边缘、6 个未观察到”分类
已作废。

## 可信装置

新实验复用历史 Qwen A/B 的核心结构：

这是结构忠实的 synthetic capability probe，而不是 Runtime 生成的完整真实任务请求：它保留
v26 顶层节点、物理顺序、闭合形式和 Observation 追加行为，但简化了各字段正文，专门隔离
Provider 的前缀缓存能力。真实 Agent 成本与执行效果仍需另行评测。

- 固定生产 System Prompt；
- 不发送工具定义，消除 tools 缓存归因混淆；
- 一条 User message 中只有一个文本块；
- 文本块是一份闭合 Structured Context，包含约 12 万字符、320 条 Observation；
- 不使用显式 breakpoint，不使用实验 ContextDelta；
- 顺序执行 `warm → append-one → append-two → mind-revision → append-after-revision`；
- 统计排除第一次 warmup 的后四次请求；模型输出最多 32 tokens。

`inbox-first` 是当前 v26 的物理原则：稳定 Inbox 位于 mind、session、kernel、evaluate 等动态状态
之前。新增 Observation 插入 Inbox 尾部，仍保留此前全部 Observation 作为同一文本块内部的稳定
token 前缀。`dynamic-first` 对照拥有相同语义成分，但把每轮变化的状态放在长 Inbox 前面。

GPT、Qwen、DeepSeek Pro、DeepSeek Flash 使用交错的完整 `inbox-first / dynamic-first` A/B；
其余模型只运行 `inbox-first` 能力探针。后者一旦报告五六万 cached tokens，已经必然越过固定
System 进入 User/Structured Context；若只报告很小值或零，则不能据此声称支持。

## 结果

“后四次命中率”按调用顺序列出；“聚合”是排除 warmup 后的 `Σcached / Σinput`。

| 模型路由 | 后四次 `inbox-first` 命中率 | 聚合 | `dynamic-first` 聚合 | 判定 |
| --- | --- | ---: | ---: | --- |
| `gpt-5.6-sol` | `98.82%, 98.79%, 98.79%, 98.75%` | **98.79%** | 5.67% | 稳定、明确进入单 block Context |
| `qwen3.8-max-preview` | `94.02%, 99.25%, 99.25%, 99.19%` | **97.93%** | 6.51% | 稳定；复核历史 87.98% |
| `deepseek-v4-pro` | `86.66%, 99.64%, 99.64%, 99.58%` | **96.38%** | 8.06% | 稳定、明确支持 |
| `bai-deepseek-v4-flash` | `99.29%, 99.23%, 7.86%, 99.18%` | **76.39%** | 7.24% | 明确支持，但出现一次整段 miss |
| `k3-256k` | `99.42%, 99.37%, 99.78%, 99.31%` | **99.47%** | — | 稳定、明确支持 |
| `glm-5.3` | `99.36%, 99.30%, 99.72%, 99.66%` | **99.51%** | — | 稳定、明确支持 |
| `gemini-3.7-flash-high` | `96.46%, 96.40%, 96.40%, 96.34%` | **96.40%** | — | 稳定、明确支持 |
| `grok-4.6` | `0.20%, 8.20%, 8.20%, 86.84%` | **25.87%** | — | 能深命中，但建立延迟明显 |
| `claude-opus-5` | `0%, 0%, 0%, 0%` | **0%** | — | 本次隐式路线未观察到缓存 |

请求路由 `bai-deepseek-v4-flash` 的响应模型标识为 `deepseek-v4-flash`；`grok-4.6` 的响应标识
为 `grok-4.6-build`。结果严格归属于这些 Proxy 路由，不能仅凭名称扩张到其他上游 revision。

## 真实 Terminal-Bench 校正

任务统一为 `terminal-bench/cancel-async-tasks`，使用生产 System Prompt、完整 v26 Context、
生产工具 schema、`reasoning_effort=max`，只启用 `MORPHZ_CODING_EVAL_MODE=true`。命中率均按
Provider `cached_input_tokens / input_tokens` 计算；“预热后”排除第一请求。

| 运行 | 完整请求 `(input, cached)` | 预热后聚合 | 说明 |
| --- | --- | ---: | --- |
| GPT 旧普通 transport | `(21467,0) (21501,0) (24673,11776) (26168,11776) (26595,0)` | **23.81%** | tools 从 27 变 26，首两轮及末轮出现整段 miss |
| K3 旧普通 transport | `(22466,0) (22430,3584) (23853,20224) (24859,20992)` | **62.97%** | 后两轮约 84.8%/84.4%，但同样经历 tools 变化 |
| GPT 固定 tools、单 block | `(22054,0) (22265,12800) (26181,12800) (25396,12800) (27179,12800)` | **50.68%** | 28 tools、schema hash、cache key 全程稳定；受控地在第 5 次 usage 后停止 |
| GPT 固定 tools、Structured ContextDelta | `(22051,0) (22344,20992) (23126,22016) (24498,22016)` | **92.93%** | 一条 User message；`input_text` blocks 为 `1→2→3→4`；任务完成并通过 smoke tests |

固定 tools 的普通请求中，相邻 canonical Context 的文本 LCP 从 33,188 增长到 40,842 字符，
但 cached tokens 一直停在 12,800。它说明“tools 不稳定”是一个真实原因，却不是唯一原因；
完整生产请求没有复现无 tools synthetic probe 的 98.79%。启用 Structured ContextDelta 后，
canonical Context seed 保持第一个完整结构化 block，随后每个工具 Observation 作为有序、闭合
的结构化 delta block 追加，最终跨过 85% 成本目标线。

## 对 GPT-5.6 修复方向的影响

最终实现边界如下：

1. 普通 `work` / `soft-checkpoint` 轨迹的 Provider-visible tools 集合、schema 与顺序固定；
   Objective 权限和普通 `context_tx` cooldown 只改变 Runtime admission，越权调用返回拒绝；
2. `critical-maintenance`、`final-reply`、`objective-finalization` 仍物理裁剪 tools，因为这些是
   有意改变求值语义、并已使 Context 前缀重建或终止的协议边界；
3. tools 在 Runtime 装配时按名称确定性排序，避免进程重启随机改变请求合同；
4. Structured ContextDelta 继续默认关闭，只在编译 feature 存在且 Dashboard 对具体
   Provider/模型设置 `experimental-structured-deltas` 时启用。

这组结果同时解释了论文低命中和 96%/98.79% 受控探针：前者是真实产品合同，后者证明端点
具备能力；二者测量对象不同，不能相互替代。

## 边界

- 九模型表是 Provider 缓存能力和布局探针，不是回答质量或完整 Agent 任务评测；真实任务表
  只覆盖 GPT 与 K3，其中 Structured ContextDelta 完整做完同一道题；
- 上下文故意做长，以度量稳态能力；短任务的冷启动命中率可以远低于这里的结果；
- DeepSeek Flash 和 Grok 证明“支持”不等于每次稳定命中，成本预算还需要多次重复和真实任务；
- Claude 的零结果只表示当前 Proxy/Anthropic Messages 隐式路线未观察到；不排除显式
  `cache_control` 或其他官方端点可用；
- 除 Qwen 历史实验外，本轮每个模型只有一个 synthetic cohort，尚未估计方差；真实 GPT
  对照也各只有一个 cohort，92.93% 应视为已验证收益而非精确总体均值。

## 装置与产物

- 历史 ME-08 / ContextDelta feature commit：`d5a5fb806183f44fb5b47df65bf4def8ff8ab093`
- 本次稳定 tools 验证的工作区基线：`9ba02417fd1c6c3fef757928fe97f6b71657146f`；
  稳定 schema、确定性排序和本文证据随本报告所在提交一起交付
- 端点：`http://mini-m4.local:8317/v1`
- CLIProxyAPI：`7.2.140 HEAD-4c78e40`
- OpenAI-compatible 八模型协议：`openai-responses`
- Claude 协议：`anthropic-messages`
- 有效汇总：
  `docs/research/paper_evaluation/artifacts/prompt_cache_nine_model_default_context_20260830.json`
- 原始逐请求 JSON 与失败的短探针记录：
  `/private/tmp/morphz-nine-model-cache-20260830/results`
- 能力探针脚本：
  `/private/tmp/morphz-nine-model-cache-20260830/run_layout_ab.py`
- 真实 GPT 旧实现 DB：
  `/private/tmp/morphz-tbench-cache-real-20260830-002/morphz.db`
- 真实 K3 默认 transport DB：
  `/private/tmp/morphz-tbench-cache-real-20260830-004/morphz.db`
- 固定 tools、默认单 block GPT DB/抓包：
  `/private/tmp/morphz-tbench-cache-real-20260830-006`
- 固定 tools、Structured ContextDelta GPT DB/抓包：
  `/private/tmp/morphz-tbench-cache-real-20260830-007`

第一次无效 Qwen 小任务 pilot 还曾因误用 `MORPHZ_DB_PATH` 写入仓库默认 `morphz.db`：Session
`cache-probe-qwen-pilot-20260830`、31 个事件。它不计入任何结果；本次仍未擅自删除用户数据。
