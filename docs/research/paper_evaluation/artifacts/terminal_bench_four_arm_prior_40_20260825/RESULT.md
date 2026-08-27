# Terminal-Bench 2.1 既有前 40 题四臂对照结果

> 协议：`terminal-bench-four-arm-prior-40-v1`
>
> 运行提交：`e7268eaf3aa8c9a3febc6e4e47b3c223e6ee1209`
>
> 标签：`terminal-bench-four-arm-prior-40-v1`
>
> 运行时间：2026-08-25 00:01–08:20（Asia/Shanghai）
>
> 解释范围：40 个曾进入项目开发观察范围的任务、每题每臂一次；每个 Agent trial 均从
> 独立的空 Context、Session 和 SQLite 启动，不携带跨题或历史解题记忆；由于任务选择已受
> 项目观察影响，本轮仍不是预注册 unseen 估计或公开榜单成绩

## 1. 结论

以 Harbor/Terminal-Bench 官方评分器为准，本轮最好的 Arm 是**原生 Morphz，无 Harness，
75.0%（30/40）**。它高于官方 Codex 的 70.0%（28/40），也明显高于 v0.5 极简 Harness
的 57.5%（23/40）和《实践论》《矛盾论》原文派生 Mind Frame 的 60.0%（24/40）。

本轮不支持“给 Morphz 增加通用 Harness 就会提高 Terminal-Bench 完成率”：v0.5 相对原生
Morphz 下降 17.5 个百分点；配对不一致题中 v0.5 赢 3 题、原生赢 10 题，双侧 exact
binomial p=0.0923。差异未达到 0.05 显著性阈值，但方向和幅度足以阻止把 v0.5 升为默认
配置。

哲学 Mind Frame 相对 v0.5 只提高 2.5 个百分点；配对赢 5、输 4，p=1.0。本轮没有证据
证明它稳定改善任务能力，也没有证据证明抽象哲学框架完全无效。它只是在相同 Harness
注入范式下略微恢复了一题，仍显著落后于原生 Morphz。

## 2. 官方评分器结果与附加审计

| Arm | 官方得分 | 官方通过 | 本地严格审计 | 本地完整性 Gate |
| --- | ---: | ---: | ---: | --- |
| A 原生 Morphz | **75.0%** | **30/40** | 75.0% | 通过 |
| B Morphz + `terminal-task@0.5.0` | 57.5% | 23/40 | 57.5% | 通过 |
| D Morphz + 辩证实践 Mind Frame | 60.0% | 24/40 | 60.0% | 通过 |
| C 官方 Codex CLI 0.149.1 | 70.0% | 28/40 | 67.5% | 未通过：1 个 trial 被本地扫描器取消资格 |

官方 Codex 的 `dna-insert` 获得 verifier reward 1，计入官方成绩。我们自行增加的完整性
扫描器因为命令文本出现 `/tests` 而取消了该题资格；但原命令是
`find / -path /tests -prune ...`，语义是明确跳过而非读取该目录，因此属于本地静态规则的
保守误报。对外成绩和主要比较一律采用官方评分器的 70.0%；本地 67.5% 只作为冻结审计
历史保留，不取代官方结果，也不在看到结果后改写原始审计文件。

## 3. 预注册配对比较

“第一 Arm 胜/第二 Arm 胜”只统计同一任务结果不一致的配对。

| 比较 | 第一胜 | 第二胜 | 同过 | 同败 | 官方得分差值 | 双侧 exact p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| B v0.5 − A 原生 | 3 | 10 | 20 | 7 | −17.5pp | 0.0923 |
| D 哲学 − B v0.5 | 5 | 4 | 19 | 12 | +2.5pp | 1.0000 |
| C Codex − A 原生 | 5 | 7 | 23 | 5 | −5.0pp | 0.7744 |

每题只有一次，统计功效有限。尤其 C−A 的结果只能说本轮没有发现官方 Codex 优于原生
Morphz；不能据此声称原生 Morphz 已在总体上显著胜过 Codex。

## 4. 失败与异常

所有 160 个正式 trial 均被保留，无选择性补跑、换模型或删题。

| Arm | Harbor 异常 |
| --- | --- |
| 原生 Morphz | 5 × `AgentTimeoutError` |
| v0.5 | 4 × `AgentTimeoutError`；1 × `VerifierTimeoutError` |
| 哲学 Mind Frame | 4 × `AgentTimeoutError`；1 × `VerifierTimeoutError` |
| 官方 Codex | 1 × `AgentTimeoutError`；1 × `VerifierTimeoutError`；1 × `ApiRateLimitError`；1 × `AgentSafetyRefusalError` |

官方 Codex 的 `vulnerable-secret` 在任何任务行动前被 OpenAI cybersecurity policy 拒绝；
`mcmc-sampling-stan` 在已完成大量工作后遭遇连续 429 并达到重试上限。两者都按预注册
协议计为该路线的实际失败，不剔除。

三个 Morphz Arm 的 public run Gate 均通过，包括附加完整性审计、40 个独立 Context、
Session、SQLite 数据库、凭据未落盘以及 Harness 身份绑定。官方 Codex 的 launcher 返回
3、最终 systemd 单元为 failed，仅源于上述本地扫描器取消资格，不影响 Harbor 官方成绩；
四个 Arm 都完整产生了 40/40 个官方评分结果。

## 5. Token 与时间

以下是 Harbor/Provider 原样记录值。Codex 与 Morphz 的缓存命中方式差异很大，不能把
`total input - cached input` 简单解释成架构优劣。

| Arm | 总耗时 | Input Token | Cached Input | Output Token |
| --- | ---: | ---: | ---: | ---: |
| 原生 Morphz | 8h19m | 28,920,857 | 2,260,480 | 664,135 |
| v0.5 | 7h15m | 23,051,730 | 1,865,216 | 559,838 |
| 哲学 Mind Frame | 7h42m | 22,500,316 | 1,744,896 | 659,626 |
| 官方 Codex | 7h26m | 40,676,923 | 37,872,000 | 602,180 |

这些 Token 数据说明 Harness 确实改变了执行轨迹和总工作量，但较低 Token 没有转化为更高
完成率。对 Morphz 当前产品决策而言，**保留原生 Agent 自由度比继续堆叠通用认知指令更
重要**。

## 6. 产品与研究判断

1. 原生 Morphz 已有很强的 Agent 基线，本轮甚至高于同模型官方 Codex；各 trial 的 Agent
   状态是干净的，但任务集合已被项目用于开发观察，因此该结果仍值得在预先冻结、未受开发
   选择影响的任务集合上验证。
2. v0.5 虽然比 v0.4 克制，仍可能通过额外认知对象和任务投影干扰模型原有策略。当前不应
   作为默认 Harness。
3. 《实践论》《矛盾论》Mind Frame 没有形成可宣传的增益。若继续研究，应把它视为认知
   表示实验，而不是性能优化；需要未见任务、多次采样和更明确的机制假设。
4. 下一轮公开 Benchmark 应优先使用原生 Morphz，冻结新任务或完整 89 题单次运行，再决定
   是否做多次采样；本轮 75% 不能当作 Terminal-Bench 公开榜单分数。

## 7. 证据

Harbor 官方 reward、本地附加审计结果、三个 Morphz public Gate、smoke 汇总、launcher
结果及 Codex 误报记录均保存在本目录。逐题四臂矩阵在四份 `*_strict_result.json` 中；其中
`raw_reward` 是官方评分依据，`strict_reward` 是本地附加审计值，均未人工改写。
