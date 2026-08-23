# Terminal-Bench 2.1 Harness 历史错题试跑结果（2026-08-24）

## 1. 结论

本轮仅运行上一轮失败的 5 道题，每题 1 次、5 题并发，没有扩展到 89 题或 445 个 trial。最终严格得分为 **2/5（40%）**：

- `pypi-server`：1.0；
- `pytorch-model-recovery`：1.0；
- `dna-assembly`：0.0；
- `mteb-leaderboard`：0.0；
- `torch-pipeline-parallelism`：0.0。

这 5 道题在此前基线中均失败，因此本轮至少说明“当前 Runtime + Linux 环境 + terminal-task Harness”能够恢复其中 2 道。但是本轮不是只改变 Harness 的严格 A/B：Runtime 基线、执行环境和 watcher 也已经更新，不能把两道题的恢复全部归因于 Harness。

## 2. 冻结配置

- 数据集：`terminal-bench/terminal-bench-2-1`；
- 模型：`gpt-5.6-sol`；
- reasoning effort：`max`；
- permission mode：`full_access`；
- fallback：`false`；
- attempts：1；
- concurrency：5；
- max retries：0；
- Runtime tag：`paper-eval-runtime-v4`；
- Runtime commit：`5e4b0ffcd89245f19d84ec3569605ae27a44e02b`；
- Runtime binary SHA-256：`f98c17bcc3204216aa39b3833994ad01da45c3015e02216eeb12a9290dd99e67`；
- static watcher SHA-256：`9bfaa4b2eb87f65274ac09409bf6d46700175acb4870f5522a8f96e458e4bd06`；
- Harness：`terminal-task@0.1.0`；
- Harness artifact SHA-256：`1d996a61459b7ffe3567f0d33fb5f8bf4a24d8d3c3fb8bd881a62ddb35a92741`；
- 有效 job：`/opt/morphz-benchmark/source/jobs/2026-08-24__06-41-46`。

在有效批次开始前，曾发现旧 watcher 动态链接 `libsqlite3.so.0`，无法进入部分最小化题目镜像。该批次在模型产生有效结果前即被停止，不计入本结果。有效批次使用静态 SQLite watcher。

## 3. 逐题结果

| 题目 | Reward | Input tokens | Cached tokens | Output tokens | 用时（约） | Trajectory SHA-256 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `pypi-server` | 1.0 | 220,728 | 19,968 | 7,394 | 3m27s | `181dd811fea35fa158e86c928d61789e2d0b837f80e6109af72fba17a349c08a` |
| `pytorch-model-recovery` | 1.0 | 212,866 | 0 | 13,985 | 10m59s | `5d079a02c3c10830c0432c18db4b91902b741d7f705746730a090df965283ef6` |
| `dna-assembly` | 0.0 | 951,559 | 19,968 | 35,140 | 15m45s | `6ea75aebddc61d5e728edb003a65b59f715662a04549d68b489eba59b00eb4d6` |
| `mteb-leaderboard` | 0.0 | 2,539,971 | 59,904 | 15,688 | 20m27s | `a1c0f183caa985046cbd4ecb9d6255f98855ab0e1e17bac172f74ca16ed813bb` |
| `torch-pipeline-parallelism` | 0.0 | 167,476 | 6,656 | 20,177 | 14m40s | `f10c7bd998dc25407610d6c3a08b234161b05c5de88685d2525e83894a26779c` |

总计：4,092,600 input tokens、106,496 cached tokens、92,384 output tokens。五题并发后的批次墙钟时间约 20 分 28 秒。

## 4. 失败 trajectory 诊断

以下诊断只使用公开任务说明和 Agent trajectory，不读取隐藏 verifier/private tests。

### 4.1 `dna-assembly`

Agent 构造了自己的校验脚本，并据此确认 4 对引物、Tm、拼接结果、BsaI 位点和输出格式均正确，但官方 reward 仍为 0。问题不在于没有验证，而在于验证逻辑与实现共享同一组未经独立确认的生物学和序列边界假设，形成了“自洽但不独立”的证据闭环。

该题暴露出 Harness `verification-discipline/independence` 仍然太软：模型能复述“独立验证”，却仍可能编写一个重复自身假设的验证器。后续应要求为高风险领域假设保留来源或交叉实现证据，并在无法独立确认时明确降低结论强度。

### 4.2 `mteb-leaderboard`

Agent 最终只对 4 个预选模型加载并聚合本地结果，然后得出 `intfloat/multilingual-e5-base`。公开任务要求的是截至 2025 年 8 月、覆盖全部 Scandinavian MTEB 任务的完整排行榜最优模型；trajectory 没有证明候选全集完整，也没有充分证明时间截面和排行榜权威来源一致。该题共消耗约 254 万 input tokens，存在明显的长程搜索与收敛效率问题。

该题说明 Harness 的 research guard 虽然提出“来源、时间、缺失数据”，却没有把“候选全集完整性”变成最终返回前的硬门槛。后续需要一个可检查的 enumeration completeness 证据，而不是仅对已经选择的候选做精细聚合。

### 4.3 `torch-pipeline-parallelism`

Agent 在题目容器没有 Python 解释器的情况下，直接依据通用 Hugging Face LLaMA 接口写入约 173 行实现，并只做了文件读回和源格式检查，没有执行 forward/backward、world size 1/2、激活或梯度对照。公开任务明确会比较 forward/backward activations，因此当前证据明显不足以支撑完成声明。

这题说明 Harness 对“无法运行关键验证”的约束仍然不够强。后续应要求：代码题缺少执行环境时，优先建立可运行的最小验证环境或获得等价的调用者侧证据；若做不到，不得把文件存在和静态检查表述成已完成的行为验证。

## 5. 审计

- strict integrity gate：通过；
- trial count：5/5；
- 5 个 trial 均完成，0 error，0 retry，0 disqualification；
- Context/Session 隔离：通过；
- Provider errors：0（429、503、usage limit、auth、provider request failed 均为 0）；
- credential scan：完成，未发现凭据落盘；
- public run gate：通过。

最初 post-run gate 曾因 launcher 使用系统 Python、无法导入固定 Harbor 环境中的模块而产生假失败。已修复为使用 `$harbor_root/bin/python`，本地提交 `2269d97`，云端对应提交 `399b16640a07a322362720165dff7dc633acb235`；使用相同原始 job 重新执行只读审计后 gate 全部通过，未修改任何 reward 或 trajectory。

## 6. 下一步建议

1. 不立即重跑全部 5 题；先把 Harness 升级为候选 `0.2.0`，只针对本轮暴露的三个通用缺口：独立证据、研究候选全集、关键行为可执行验证。
2. 增加收敛预算：周期性检查剩余 acceptance conditions，避免 `mteb-leaderboard` 这类高 token 轨迹在没有补齐候选全集证据时持续扩张。
3. 先重跑 token 成本较低的 `torch-pipeline-parallelism`；确认 Harness 真能改变执行路径后，再决定是否重跑 `dna-assembly` 和高成本的 `mteb-leaderboard`。
4. 若要严格量化 Harness 的因果收益，应在同一 Runtime commit、同一 Linux 节点、同一模型和相同题目上做有/无 Harness 的配对实验。本轮结果只能作为开发回归与方向证据，不能作为公开榜单成绩或论文因果结论。
