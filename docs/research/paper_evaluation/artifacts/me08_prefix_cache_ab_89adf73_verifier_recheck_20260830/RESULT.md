# ME-08 Prefix Cache A/B verifier timeout 事后复评

## 结论

正式 A/B 的五个缺失 reward 不是同一种失败：

| Arm | Task | 正式主异常 | 复评结果 | 归因 |
| --- | --- | --- | --- | --- |
| Control | `pytorch-model-recovery` | `VerifierTimeoutError` | 4/5 tests，reward 0 | verifier 确实超时，但解答本身也不正确 |
| Control | `torch-pipeline-parallelism` | `VerifierTimeoutError` | 4/4 tests，reward 1 | 纯 verifier timeout 误伤 |
| Control | `torch-tensor-parallelism` | `VerifierTimeoutError` | 13/13 tests，reward 1 | 纯 verifier timeout 误伤 |
| Treatment | `torch-tensor-parallelism` | `VerifierTimeoutError` | 13/13 tests，reward 1 | 纯 verifier timeout 误伤 |
| Treatment | `torch-pipeline-parallelism` | `AgentTimeoutError`；随后 verifier 也跑满 900 秒 | 最终文件 4/4 tests，reward 1 | 混合 Agent+Verifier timeout；交付物有效，但不是纯 verifier-only 恢复 |

纯 verifier timeout 口径下，事后诊断分为 Control **74/89**、Treatment **72/89**。若按超时前已经形成且可独立验证的最终交付物计，诊断分为 Control **74/89**、Treatment **73/89**。

冻结正式分仍是 Control **72/89**、Treatment **71/89**。本目录不修改正式 run root、正式 `reward.txt`、正式摘要或先前冻结的审计目录；两个诊断分也不冒充原始官方 raw reward。

## 根因

这批 verifier 的 900 秒包括测试环境冷启动。三个正式 verifier-timeout 输出都在运行时下载 `uv`、Python、GPU 版 PyTorch/CUDA wheel 及相关依赖，单个 trial 涉及数 GB 网络和磁盘写入；Treatment tensor 则在截止时已经跑到 13 项测试中的最后一项附近。正式 A/B 同时允许 8+8 个 trial，依赖下载在 16 路并发下争用网络与存储。

复评保持原 task digest 与原官方测试脚本，只做三件事：

1. 从每个只读 Morphz SQLite 中读取成功的 `write/edit` 请求，逐字重建最终文件；
2. 在上传前后核对源 DB 与最终文件 SHA-256，不运行模型；
3. 把 verifier 上限从 900 秒单独放宽到 3600 秒，并顺序运行。

五个 verifier 实际均在 252.44–297.69 秒内完成。这说明正式超时主要是 16 路并发下的评审依赖冷安装/资源争用，而不是 Provider、Morphz Runtime 或四份并行实现同时失效。

## 分数边界

| 口径 | Control | Treatment | both pass | both fail | Control-only | Treatment-only | 双侧精确 McNemar |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 冻结正式 raw reward | 72/89 | 71/89 | 66 | 12 | 6 | 5 | 1.0 |
| 只恢复纯 verifier timeout | 74/89 | 72/89 | 67 | 10 | 7 | 5 | 0.7744140625 |
| 按最终可验证交付物诊断 | 74/89 | 73/89 | 68 | 10 | 6 | 5 | 1.0 |

三个口径都没有证据表明 Structured Delta 导致明确正确率回退。最后一行包含 Treatment pipeline 的混合超时，因此只能称作最终状态诊断，不能改写成“纯评审器错误”。

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

后续 Terminal-Bench 并发批次应把 verifier 环境准备与测试执行分开计时，或预构建/共享只读依赖缓存，并单独限制 verifier 并发。不能仅把 agent 并发设为 8+8 后假设 verifier 的数 GB 冷安装也能安全承受 16 路并发。
