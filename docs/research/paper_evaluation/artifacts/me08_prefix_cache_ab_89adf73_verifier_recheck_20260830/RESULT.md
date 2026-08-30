# ME-08 Prefix Cache A/B verifier timeout 事后复评

## 结论

正式 A/B 的五个缺失 reward 不是同一种失败：

| Arm | Task | 正式主异常 | 复评结果 | 归因 |
| --- | --- | --- | --- | --- |
| Control | `pytorch-model-recovery` | `VerifierTimeoutError` | 4/5 tests，reward 0 | verifier 确实超时，但解答本身也不正确 |
| Control | `torch-pipeline-parallelism` | `VerifierTimeoutError` | 4/4 tests，reward 1 | 纯 verifier timeout 误伤 |
| Control | `torch-tensor-parallelism` | `VerifierTimeoutError` | 13/13 tests，reward 1 | 纯 verifier timeout 误伤 |
| Treatment | `torch-tensor-parallelism` | `VerifierTimeoutError` | 13/13 tests，reward 1 | 纯 verifier timeout 误伤 |
| Treatment | `torch-pipeline-parallelism` | `AgentTimeoutError`；随后 verifier 也跑满 900 秒 | 截止前环境 4/4 tests，reward 1 | AgentTimeout 工程异常保留；按 Harbor verifier-reward 语义恢复正确性 |

按冻结协议的官方 verifier raw reward 主指标复评后，事后诊断分为 Control **74/89**、Treatment **73/89**。Treatment pipeline 的正确文件在 Agent 名义截止前已经形成，正式 verifier 启动时看到的也是该状态；`thread_outcomes.delivered_at` 晚不覆盖 verifier reward。

冻结正式分仍是 Control **72/89**、Treatment **71/89**。本目录不修改正式 run root、正式 `reward.txt`、正式摘要或先前冻结的审计目录；事后诊断分也不冒充原始官方 raw reward。

## 根因

这批 verifier 的 900 秒包括测试环境冷启动。三个正式 verifier-timeout 输出都在运行时下载 `uv`、Python、GPU 版 PyTorch/CUDA wheel 及相关依赖，单个 trial 涉及数 GB 网络和磁盘写入；Treatment tensor 则在截止时已经跑到 13 项测试中的最后一项附近。正式 A/B 同时允许 8+8 个 trial，依赖下载在 16 路并发下争用网络与存储。

复评保持原 task digest 与原官方测试脚本，只做三件事：

1. 从每个只读 Morphz SQLite 中读取成功的 `write/edit` 请求，逐字重建最终文件；
2. 在上传前后核对源 DB 与最终文件 SHA-256，不运行模型；
3. 把 verifier 上限从 900 秒单独放宽到 3600 秒，并顺序运行。

五个 verifier 实际均在 252.44–297.69 秒内完成。这说明正式超时主要是 16 路并发下的评审依赖冷安装/资源争用，而不是 Provider、Morphz Runtime 或四份并行实现同时失效。

## Agent 时间线与评分语义

下表保留原始 Morphz SQLite 的 `thread_outcomes.delivered_at` 作为工程诊断。耗时从该 Session
的原始 `user_message` 事件算起，但它不是 Terminal-Bench/Harbor 的 reward 判定字段。

| Arm | Task | 主异常 | Morphz `deliver` 耗时 | 900 秒内 `deliver` |
| --- | --- | --- | ---: | --- |
| Control | `pytorch-model-recovery` | VerifierTimeout | 183.383 s | 是 |
| Control | `torch-pipeline-parallelism` | VerifierTimeout | 371.785 s | 是 |
| Control | `torch-tensor-parallelism` | VerifierTimeout | 246.844 s | 是 |
| Treatment | `torch-pipeline-parallelism` | AgentTimeout | 1204.589 s | **否** |
| Treatment | `torch-tensor-parallelism` | VerifierTimeout | 232.174 s | 是 |

Treatment pipeline 的最后一次正确文件修改发生于 `23:15:05.655571Z`，比 Harbor 报 Agent
timeout 早 62.157 秒。更精确地按 Harbor `agent_execution.started_at=23:01:02.691147Z`
计算，名义 900 秒截止为 `23:16:02.691147Z`，正确文件提前 **57.036 秒**形成；verifier 于
`23:16:08.033714Z` 启动，距该文件写入已有 62.378 秒。此后 SQLite 没有新的 `file_change`，
只有 read/search，因此 verifier 看到的正是零模型复评时 SHA-256 完全一致、4/4 通过的状态。

Harbor 0.21.0 `SingleStepTrial._run_agent` 在捕获 `AgentTimeoutError` 后只记录异常，随后仍调用
`_sync_agent_output`、收集产物并进入 `_run_verifier`；reward 由 `verifier_result` 决定，异常不会
自动覆盖 reward。仓库已有正式先例 `terminal_task_harness_v0_3_unseen_20/train-fasttext__MMVEVMM`：
`exception_info=AgentTimeoutError` 同时 `verifier_result.rewards.reward=1.0`。冻结 A/B 协议也只有
“官方 verifier raw reward 主指标”，没有“必须在截止前 chat/reply deliver 才允许 verifier reward”
的条款。因此用晚到的 Morphz terminal outcome 把 1 分改回 0，没有协议依据。

论文所用同期 Codex 完整 89 题也提供了对称证据：三个 `AgentTimeoutError` 都继续进入官方
verifier；`make-doom-for-mips` 为 2/3、`password-recovery` 为 0/2，故各保留 0 分；
`query-optimize` 为 6/6，故官方计 1 分。三者均无 `VerifierTimeoutError`，Codex 总分保持
74/89。详见只读复核
[`../me08_codex_full89_timeout_recheck_20260830/RESULT.md`](../me08_codex_full89_timeout_recheck_20260830/RESULT.md)。
这说明本文对 Morphz 与 Codex 使用的是同一条规则：已有 verifier 结果就尊重它；只有 verifier
超时或缺失时，才对冻结环境做零模型复评。

工程缺陷仍然成立：取消外层 `docker compose exec` 没有终止容器内 Agent，Morphz 在
`23:18:08Z` 又完成三个只读工具调用，并在 `23:21:08Z` 才产生 terminal outcome，而 Harbor
已经启动 verifier，造成生命周期重叠。应修复取消与隔离，但这不改变 verifier 对截止前稳定环境的
正确性判定。

## 分数边界

| 口径 | Control | Treatment | both pass | both fail | Control-only | Treatment-only | 双侧精确 McNemar |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 冻结正式 raw reward | 72/89 | 71/89 | 66 | 12 | 6 | 5 | 1.0 |
| 按官方 verifier 主指标事后复评 | 74/89 | 73/89 | 68 | 10 | 6 | 5 | 1.0 |

两个可采用口径都没有证据表明 Structured Delta 导致明确正确率回退。74/72 仅是把 Morphz
`deliver` 误当作额外评分 Gate 的反事实口径，冻结协议与 Harbor 0.21.0 均不支持，现已撤回。

## 证据

- 机器可读总账：[`POSTHOC_VERIFIER_RECHECK.json`](./POSTHOC_VERIFIER_RECHECK.json)
- 正式超时原始异常与 verifier 尾迹：`formal_timeouts/<arm-task>/`
- 每个复评 trial：`trials/<trial>/result.json`
- 恢复来源、DB hash 与文件 hash：`trials/<trial>/agent/replay_manifest.json`
- 官方测试明细：`trials/<trial>/verifier/ctrf.json` 与 `test-stdout.txt`
- 零模型恢复器：[`tools/replay_agent.py`](./tools/replay_agent.py)
- 全目录校验：[`SHA256SUMS`](./SHA256SUMS)

服务端复评根为 `/opt/morphz-benchmark/verifier-rechecks/me08-prefix-cache-ab-89adf73-20260830`。正式运行根 `/opt/morphz-benchmark/repeat-runs/me08-prefix-cache-ab-89adf73-r1-20260830` 保持不变。

## 工程建议

后续 Terminal-Bench 并发批次应把 verifier 环境准备与测试执行分开计时，或预构建/共享只读依赖缓存，并单独限制 verifier 并发。不能仅把 agent 并发设为 8+8 后假设 verifier 的数 GB 冷安装也能安全承受 16 路并发。Agent timeout 路径还应冻结 workspace 快照，或显式终止并等待容器内进程退出后再启动 verifier；否则 Agent 与 verifier 可能并发修改同一环境。这个生命周期修复不得改变 Harbor 已有的“AgentTimeout 可保留异常、reward 仍由 verifier 决定”的评分语义。
