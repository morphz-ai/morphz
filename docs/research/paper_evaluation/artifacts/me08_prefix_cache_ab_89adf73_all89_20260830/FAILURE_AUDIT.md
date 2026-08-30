# ME-08 Prefix Cache A/B 失败与超时审计

## 官方口径

官方 raw reward 是唯一主要分数。Control 为 72/89、17 个零分；Treatment 为 71/89、18 个
零分。异常诊断不会补分、重跑、删除或替换官方零分。

## 缺失 `reward.txt` 的官方零分

| Arm | 任务 | 主异常 | 官方处理 |
| --- | --- | --- | --- |
| Control | `pytorch-model-recovery` | `VerifierTimeoutError`，900 s | 0 |
| Control | `torch-pipeline-parallelism` | `VerifierTimeoutError`，900 s | 0 |
| Control | `torch-tensor-parallelism` | `VerifierTimeoutError`，900 s | 0 |
| Treatment | `torch-pipeline-parallelism` | `AgentTimeoutError`，900 s | 0 |
| Treatment | `torch-tensor-parallelism` | `VerifierTimeoutError`，900 s | 0 |

因此 Control 的三个缺失 reward 都是 verifier 执行超时，不是模型 Agent 超时；Treatment 有
一例独有 AgentTimeout 和一例 verifier 超时。`torch-tensor-parallelism` 两臂均为 verifier
超时；`torch-pipeline-parallelism` 两臂都为官方零分，但主异常阶段不同。

## Provider 与安全路径

- Control 在 `qemu-alpine-ssh`、`regex-chess` 各出现一次 `server_unavailable`；
- Treatment 在 `circuit-fibsqrt`、`extract-elf` 各出现一次 `server_unavailable`；
- 四次都进入独立探针，四次 probe 均成功，四次应用请求均恢复；
- 无 quota、无 request/stream retry、无 circuit-open、无 probe-fail；
- 两臂均在 `break-filter-js-from-html`、`vulnerable-secret` 出现终止性 safety refusal，并按
  官方零分保留；
- safety recovery projection 事件数量为 Control 19、Treatment 6，但终止性 turn failure
  都是每臂 2 个任务；projection 次数不等于独立失败任务数。

这些记录不支持“16 并发压垮 Provider”的解释。短暂 `server_unavailable` 在两臂对称出现并完全
恢复，没有形成 quota 或共享熔断。

## Runtime、Harness 与主机

- Runtime boundary failure：0；
- Harness binding：0；
- 非空 Agent stderr：0；
- 178/178 SQLite `quick_check=ok`；
- 资源样本没有持续 CPU 或内存饱和证据。

没有证据把 Treatment 的一分差归因于 Runtime bug、Harness 污染或 Provider 容量故障。

## 同期不一致任务

Control-only 6 题：

- `financial-document-processor`
- `gcode-to-text`
- `kv-store-grpc`
- `model-extraction-relu-logits`
- `overfull-hbox`
- `video-processing`

Treatment-only 5 题：

- `chess-best-move`
- `feal-linear-cryptanalysis`
- `mteb-leaderboard`
- `raman-fitting`
- `train-fasttext`

最终不一致计数为 6:5，双侧精确 McNemar `p=1.0`。这说明早期部分分母中 Treatment“完成更少、
错得更多”的现象主要受任务完成顺序影响；终局只剩一题净差。单次 A/B 仍不能证明序列化对行为
绝对零影响，但当前没有系统性正确率退化信号。

## 归因边界

- VerifierTimeout 是评测执行异常，不是 Agent 能力失败，但按冻结协议仍计 0；
- Treatment 的 `torch-pipeline-parallelism` 是真实 AgentTimeout，不能归入 verifier 异常；
- 有 `reward.txt=0` 的普通任务失败保持普通官方失败，不用日志诊断重新评分；
- 缓存改善、正确率、输出长度和墙钟分别报告，不用任何次要指标“挽救”主要分数。

机器可读的全部失败任务、普通零分任务、Provider 恢复任务和异常计数见 `FAILURE_AUDIT.json`。
