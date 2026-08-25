# Terminal-Bench 2.1 既有前 40 题四臂对照结果

> 协议：`terminal-bench-four-arm-prior-40-v1`
>
> 运行提交：`e7268eaf3aa8c9a3febc6e4e47b3c223e6ee1209`
>
> 标签：`terminal-bench-four-arm-prior-40-v1`
>
> 运行时间：2026-08-25 00:01–08:20（Asia/Shanghai）
>
> 解释范围：40 个此前已观察的开发任务、每题每臂一次；不是 unseen 估计或公开榜单成绩

## 1. 结论

本轮最好的 Arm 是**原生 Morphz，无 Harness，严格得分 75.0%（30/40）**。它高于官方
Codex 的保守严格得分 67.5%（27/40），也明显高于 v0.5 极简 Harness 的 57.5%（23/40）
和《实践论》《矛盾论》原文派生 Mind Frame 的 60.0%（24/40）。

本轮不支持“给 Morphz 增加通用 Harness 就会提高 Terminal-Bench 完成率”：v0.5 相对原生
Morphz 下降 17.5 个百分点；配对不一致题中 v0.5 赢 3 题、原生赢 10 题，双侧 exact
binomial p=0.0923。差异未达到 0.05 显著性阈值，但方向和幅度足以阻止把 v0.5 升为默认
配置。

哲学 Mind Frame 相对 v0.5 只提高 2.5 个百分点；配对赢 5、输 4，p=1.0。本轮没有证据
证明它稳定改善任务能力，也没有证据证明抽象哲学框架完全无效。它只是在相同 Harness
注入范式下略微恢复了一题，仍显著落后于原生 Morphz。

## 2. 四臂严格结果

| Arm | Raw | Strict | 严格通过 | 完整性 Gate |
| --- | ---: | ---: | ---: | --- |
| A 原生 Morphz | 75.0% | **75.0%** | **30/40** | 通过 |
| B Morphz + `terminal-task@0.5.0` | 57.5% | 57.5% | 23/40 | 通过 |
| D Morphz + 辩证实践 Mind Frame | 60.0% | 60.0% | 24/40 | 通过 |
| C 官方 Codex CLI 0.149.1 | 70.0% | 67.5% | 27/40 | 未通过：1 个 trial 被保守取消资格 |

官方 Codex 的 `dna-insert` 实际 verifier reward 为 1，但完整性扫描器看到命令文本中出现
`/tests` 后取消资格。该命令实际使用的是 `find / -path /tests -prune ...`，即明确剪枝、
不进入该目录。这很像静态扫描器的保守误报，但它是冻结评分政策产生的结果，因此本报告
不在看到成绩后修改规则或恢复该分数：正式比较使用 67.5%，同时透明报告 raw 70.0%。

## 3. 预注册配对比较

“第一 Arm 胜/第二 Arm 胜”只统计同一任务结果不一致的配对。

| 比较 | 第一胜 | 第二胜 | 同过 | 同败 | Strict 差值 | 双侧 exact p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| B v0.5 − A 原生 | 3 | 10 | 20 | 7 | −17.5pp | 0.0923 |
| D 哲学 − B v0.5 | 5 | 4 | 19 | 12 | +2.5pp | 1.0000 |
| C Codex − A 原生 | 4 | 7 | 23 | 6 | −7.5pp | 0.5488 |

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

三个 Morphz Arm 的 public run Gate 均通过，包括严格审计、40 个独立 Context、Session、
SQLite 数据库、凭据未落盘以及 Harness 身份绑定。官方 Codex 的 launcher 返回 3、最终
systemd 单元为 failed，原因是上述 1 个完整性取消资格，而不是 trial 缺失：四个 Arm 都有
40/40 个结果。

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

1. 原生 Morphz 已有很强的 Agent 基线，本轮甚至高于同模型官方 Codex；这个结果值得继续
   在真正未见任务上验证。
2. v0.5 虽然比 v0.4 克制，仍可能通过额外认知对象和任务投影干扰模型原有策略。当前不应
   作为默认 Harness。
3. 《实践论》《矛盾论》Mind Frame 没有形成可宣传的增益。若继续研究，应把它视为认知
   表示实验，而不是性能优化；需要未见任务、多次采样和更明确的机制假设。
4. 下一轮公开 Benchmark 应优先使用原生 Morphz，冻结新任务或完整 89 题单次运行，再决定
   是否做多次采样；本轮 75% 不能当作 Terminal-Bench 公开榜单分数。

## 7. 证据

原始严格结果、Harbor job 汇总、三个 Morphz public Gate、smoke 汇总、launcher 结果及
Codex 取消资格记录均保存在本目录。逐题四臂矩阵在四份 `*_strict_result.json` 中，未做
人工改写。
