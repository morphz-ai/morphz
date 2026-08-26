# ME-08 Terminal-Bench 2.1 完整 89 题同环境配对结果

> 日期：2026-08-26
> 状态：`complete`
> 主口径：Terminal-Bench 官方 verifier `raw_reward`
> Morphz Runtime：`5e4b0ffcd89245f19d84ec3569605ae27a44e02b`（历史 pre-fix 基线）

## 结论

在同一 Linux/amd64 节点、同一 Terminal-Bench 2.1 数据集、同一 `gpt-5.6-sol`/max、
同一 CLIProxyAPI 订阅线路、full-access、每题一次且零重试的条件下：

| Arm | 通过 | 得分 | Wilson 95% CI |
| --- | ---: | ---: | ---: |
| Morphz native | 70/89 | 78.65% | [69.05%, 85.89%] |
| Official Codex CLI 0.149.1 | 73/89 | 82.02% | [72.77%, 88.62%] |

配对差值 Morphz−Codex 为 −3.37 个百分点；89 个同题配对中，Morphz-only 通过 10 题、
Codex-only 通过 13 题、两者都通过 60 题、两者都失败 6 题。discordant pairs 双侧精确检验
`p=0.677639`；按 task 固定种子重采样的配对差 95% 区间为
`[-13.48%, +6.74%]`。

因此，本轮没有检测到两者的统计显著差异。描述性结果是 Morphz 低 3 题；区间仍较宽，不能
据此宣称 Morphz 严格非劣、等价或优于 Codex。可以支持的克制结论是：Morphz 在获得
Structured Context、持久事务、跨 Session 与恢复等额外机制后，在这次同环境完整公开任务
对照中表现与 Codex 处于同一量级，未观察到灾难性通用能力退化。该 Morphz commit 早于
后续确认的 terminal-handoff、永久 safety-refusal、视觉输入计量等修复，因而本报告是有效冻结的
历史对照，不代表当前 post-fix Runtime 的分数或效率。

## 冻结子集

| 子集 | Morphz | Codex |
| --- | ---: | ---: |
| 前 40 题 | 30/40 | 28/40 |
| 后 49 题 | 40/49 | 45/49 |
| 合计 | 70/89 | 73/89 |

前 40 与后 49 的任务集合无重叠，并集恰为官方 89 题；两批均使用相同 Runtime commit、
Morphz 二进制、Codex 版本、数据集 digest、模型、权限、并发和零重试口径。

## Token、耗时与异常

| 指标（两批合计） | Morphz | Codex |
| --- | ---: | ---: |
| Provider-reported input tokens | 51,876,233 | 72,086,336 |
| Provider-reported cache tokens | 4,196,352 | 66,423,296 |
| Provider-reported output tokens | 1,329,856 | 1,160,938 |
| Provider-reported input + output | 53,206,089 | 73,247,274 |
| 每已尝试任务 input + output | 597,821 | 823,003 |
| 两个子集各自墙钟之和 | 58,191.9 s | 49,177.8 s |
| Harbor errored trials | 13 | 9 |

在这次历史 pre-fix 运行中，Morphz 的报告总逻辑 Token 少 `27.4%`，累计墙钟长 `18.3%`。
这只是该冻结运行的端到端工程画像，不估计当前 post-fix Runtime，也不能把任一差异因果归于
Structured Context。缓存命中率不是架构效率评分：被任务投影省略的 Token 成本为零，而 cached Token
仍会被传输、计量并按折扣价格收费。因此同任务下先报告总逻辑 Token，cache 只作为传输/计费分解，
墙钟另列。Harbor 给 Codex 计算的
72.44 美元是名义 API 价格估计；实际运行使用订阅/OAuth 路线，不是开发者 API 账单。
部分被 Harbor 标记 errored 的 trial 仍留下 verifier 通过产物，因此异常数也不等于失败数。

## 云节点资源（后 49 题）

资源监控覆盖两个 arms 并行运行的整个后 49 题阶段，共 942 个 30 秒样本：

- 16 个逻辑 CPU；1 分钟 load 平均 0.727、P95 1.886、瞬时最大 21.459；
- 61.52 GiB 物理内存；已用内存平均 1.88 GiB、P95 2.32 GiB、最大 4.95 GiB；
- 同时运行的 Docker 容器平均 1.76、最大 2。

该配置下 64 GiB 明显过量。后续保持每 arm 并发 1、双臂并行时，8 GiB 可能勉强覆盖已见峰值，
16 GiB 更稳妥；CPU 核数主要影响耗时而非能否运行，瞬时 Docker 启动负载仍需留余量。资源
样本是整机级，不能拆成 Morphz 与 Codex 各自占用。

## 本地完整性扫描器边界

后 49 题各 arm 都有一条 `private_local_evaluation_path` finding。两条命令实际上都把
`/tests` 写在 `find ... -path /tests -prune` 中，语义是明确排除该目录，而不是读取测试答案。
因此这是静态字符串扫描的误报：Codex 对应题官方 reward 本来就是 0；Morphz 的 `fix-git`
官方 reward 为 1，不应被本地规则改写为 0。本报告遵循预注册协议，以官方 verifier
`raw_reward` 为唯一主分，本地扫描仅作附加审计。

## 解释边界

- 这是一次同环境、每题每 arm 一次的配对系统比较，不是官方 leaderboard submission；
- 单次运行不能估计同题采样方差，也不能解释所有 discordant task 的稳定归因；
- `p>0.05` 不等于证明两者相同；
- 不删除安全拒绝、timeout、Provider、Runtime 或普通任务失败，不报告“剔除外因后”的主分；
- 前 40 的阶段性正差与后 49 的阶段性负差说明，冻结完整任务集比选择局部子集更可靠。
