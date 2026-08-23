# Terminal-Bench 2.1 误启动 89×5 批次停止与审计记录

> 状态：`aborted-nonreportable`
>
> 日期：2026-08-24
>
> 结论：该批次因违反预先约定的执行顺序而由用户要求立即停止；不得作为正式 Benchmark 成绩，不得与后续 89×1 诊断批次或 89×5 正式批次拼接。

## 偏差说明

预先约定的顺序是：

1. 先运行 89 个任务、每任务 1 次；
2. 审查 89 条 trajectory，定位 Runtime、Harness 和认知策略问题；
3. 完成优化和定向复测；
4. 经用户确认后，才运行每任务 5 次的正式统计批次。

实际启动命令错误地使用了 `--attempts 5`，因此在发现偏差后立即停止。该错误来自执行编排，不是 Harbor、Morphz Runtime 或用户配置造成的。

## 冻结身份

| 字段 | 值 |
| --- | --- |
| systemd unit | `morphz-terminal-bench-formal-v2-20260823T200105Z.service` |
| 远端 Job 根目录 | `/opt/morphz-benchmark/formal-jobs/v2-20260823T200105Z/2026-08-24__04-01-27` |
| 启动时间 | `2026-08-24 04:01:26 +08:00` |
| 停止时间 | `2026-08-24 04:28:04 +08:00` |
| 基础设施 commit | `4a332677632660c581929e69f25ca2ee3f4a7282` |
| 基础设施 tag | `terminal-bench-2.1-formal-v2-cloud-r1` |
| 数据集 | `terminal-bench/terminal-bench-2-1` |
| 数据集 digest | `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a` |
| Harbor | `0.21.0` |
| Runtime commit | `5e4b0ffcd89245f19d84ec3569605ae27a44e02b` |
| Runtime SHA-256 | `f98c17bcc3204216aa39b3833994ad01da45c3015e02216eeb12a9290dd99e67` |
| Watcher SHA-256 | `d41c6c5789421d0b957d78269d886a638c1def323b8b2098763fbfadee8f9063` |
| 模型 | `gpt-5.6-sol`，`reasoning_effort=max`，`fallback=false` |
| 权限 | `full_access` |
| 错误配置 | `n_attempts=5`、`n_concurrent_trials=5`、`max_retries=0` |

远端 tracked worktree 在启动时为干净状态；唯一未跟踪目录为 `.codex-work/`。

## 停止时状态

- 已写入完整 `result.json`：14 个；
- 其中 verifier reward 1：10 个；reward 0：4 个；
- 完整结果中的异常：0；自动诚信审计取消：0；
- 已创建 trial 目录：19 个，因此另有 5 个执行中的 trial 被中止；
- 停止后活动 Benchmark 容器：0；
- 停止后活动 `run_benchmark.py` / `harbor run` 进程：0。

14 个完整结果仅可作为非确认性诊断材料。`10/14` 受完成顺序、任务耗时和人工停止点严重偏置，不能称为阶段成绩、pass@1 或正式 Benchmark 分数。5 个中断 trial 也不能选择性续跑后与这 14 个结果拼接。

## 后续纪律

下一批必须使用全新的 Run ID，从 89 个任务各 1 次完整开始：

```text
mode = full
tasks = 89
attempts = 1
concurrency = 5
max_retries = 0
upload = false
```

启动前必须同时满足：

1. 用户明确确认 `89×1`；
2. 运行清单明确显示预期 trial 数为 89，而不是 445；
3. systemd unit 描述、Jobs 目录和 manifest 均标记为 `diagnostic-89x1`，不得使用 `formal`；
4. 启动后首个状态回执再次核对 `n_attempts=1`；
5. 完成 89×1 的全轨迹分析、改进和定向复测前，不得启动 89×5。

## 原始证据保留

远端 Job 目录及 systemd journal 原样保留，不删除、不覆盖。该批次不得进入排行榜提交、路演成绩或论文定量结果；后续报告可以引用它说明协议偏差与停止处置，但必须使用 `aborted-nonreportable` 标签。
