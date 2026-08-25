# Terminal-Bench 2.1 前 40 题对照停止决策

> 状态：`external-development-complete / stopped-by-design`
>
> 日期：2026-08-25
>
> 适用协议：`terminal-bench-four-arm-prior-40-v1`
>
> 实验基础设施提交：`e7268eaf3aa8c9a3febc6e4e47b3c223e6ee1209`

## 1. 决策

当前 Terminal-Bench 2.1 轨道停在此前已观察的前 40 题，不补跑剩余 49 题，不再重复
89×5。已有结果、失败 trial、轨迹、官方 reward、本地附加审计及资源异常全部保留；论文
实验资源转入 ME-01“结构化 Context 与结果回流”核心对照。

若未来为了完整的对外 Benchmark 报告需要覆盖 89 题，可从冻结 tag
`terminal-bench-four-arm-prior-40-v1` 恢复相同环境，对剩余 49 题运行原生 Morphz 与
官方 Codex 的 `49×1×2 arms` 配对补充。该补充不得与改变 Runtime、模型、权限、预算或
评分器后的结果直接拼接。

## 2. 当前可复核结果

Harbor/Terminal-Bench 官方评分器是对外主口径：

| Arm | 官方通过 | 官方得分 |
| --- | ---: | ---: |
| 原生 Morphz，无 Harness | 30/40 | **75.0%** |
| 官方 Codex CLI 0.149.1 | 28/40 | **70.0%** |
| Morphz + `terminal-task@0.5.0` | 23/40 | 57.5% |
| Morphz + 辩证实践 Mind Frame | 24/40 | 60.0% |

四臂均使用 `gpt-5.6-sol`、`reasoning_effort=max`、同一 Provider 协议、同一任务容器、
一次尝试和零自动重试。官方 Codex 与 Morphz 都使用放开的实验权限；三个 Morphz Arm
均通过 40 个独立 Context、Session 和数据库的隔离 Gate。任务运行时没有继承历史题目
答案或其他 trial 的持久 Context。

本地 `terminal-bench-integrity-v2` 曾把 Codex 的
`find / -path /tests -prune ...` 误判为访问私有测试路径，将其附加 strict 值降为 67.5%。
该扫描器是自定义辅助审计，不是官方评分器；本次命令语义是跳过目录，因此 67.5% 只保留
为历史审计产物，不用于外部成绩或主要比较。

完整报告和非敏感机器可读证据位于：

- [`artifacts/terminal_bench_four_arm_prior_40_20260825/RESULT.md`](./artifacts/terminal_bench_four_arm_prior_40_20260825/RESULT.md)
- [`artifacts/terminal_bench_four_arm_prior_40_20260825/`](./artifacts/terminal_bench_four_arm_prior_40_20260825/)

结果归档提交为 `7a732be0e8dd55ad4a1cac67ca952b782cab085d`；官方评分主口径修订提交为
`c6155df`。

## 3. 结论边界

本轮能够支持：

> 在相同模型、任务、Provider、权限和基础设施条件下，原生 Morphz 在这 40 个开发任务
> 上取得 75.0% 官方通过率，官方 Codex 为 70.0%。

本轮不能支持：

- Morphz 已在 Terminal-Bench 2.1 完整 89 题上达到 75%；
- Morphz 已形成可提交公开榜单的 pass@1 或 pass@5；
- Morphz 在总体上统计显著优于 Codex；
- 结构化 Context 导致了这 5 个百分点差异；
- v0.5 Harness 或哲学 Mind Frame 能稳定提高任务能力。

这 40 题此前参与过 Runtime/Harness 的工程诊断，因此是开发集而不是未见测试集。每题
从零持久 Context 开始能够排除运行时答案记忆，但不能排除开发者根据既有轨迹修复通用
Runtime 后形成的开发集适配。

## 4. 为什么停止扩展

Terminal-Bench 主要测量单任务终端执行能力，并不直接隔离论文的中心机制：结构化 Context、
稳定对象引用、结果回流、冲突修订、跨 Session 认知连续性和确定性提交边界。当前 40 题
已经完成“自研 Runtime 相对成熟 Codex Agent 不发生明显能力退化”的外部能力佐证。

按本轮输入量线性估算，补跑剩余 49 题的 Morphz/Codex 两臂约需 8,500 万输入 Token，
但主要只增加通用任务覆盖率。相同资源投入 ME-01/02/03 能产生更直接的论文因果证据，
科学信息增益更高。

## 5. 资源监控记录

本轮运行前没有启用 `sysstat` 或 `atop`，因此无法事后恢复完整的宿主机 CPU、内存、磁盘
和网络曲线。日志确认 2026-08-25 06:32 出现一次 Docker memcg OOM：它由任务容器自身
内存限额触发，不是 64 GiB 宿主机内存耗尽，不能据此证明宿主机容量不足。

2026-08-25 已启用 `sysstat` 的 CPU、内存、Load、磁盘和网络采样，默认每 10 分钟记录、
保留 28 天。后续真实 Benchmark 启动时还应增加容器级 `docker stats` 采样，以区分宿主机
余量与单任务容器限额。

## 6. 后续实验纪律

1. 公开 Benchmark 以官方评分器为主，自定义扫描器只作附加审计；
2. Morphz 与外部 Agent 的比较优先使用同模型、同任务、同环境的配对运行；
3. Terminal-Bench 不再机械重复五次；重复采样只用于明确研究模型方差或 pass@k 的协议；
4. 下一项模型实验是 ME-01 Pilot，先完成无模型协议、fixture、runner、scorer 和隔离门禁；
5. 每项实验都永久登记协议、原始产物、失败、结论边界和 Git 身份，不覆盖历史结果。
