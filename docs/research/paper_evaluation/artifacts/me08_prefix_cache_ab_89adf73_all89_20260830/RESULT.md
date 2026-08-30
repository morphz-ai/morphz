# ME-08 Prefix Cache stable-schema A/B（89 × 2）冻结结果

> 状态：`external-complete / cache-release-gate-passed / supplemental`
>
> 本报告冻结 2026-08-30 完成的同期 A/B。它评估 Prompt Cache wire encoding，不重跑
> Codex，也不自动修改中英文论文。论文当前冻结的 Morphz 72/89 与 Codex 74/89 继续作为
> 非同期外部参考。

## 结论

实验完整闭合。Control（原始稳定 schema、`implicit-prefix`）为 **72/89（80.90%）**；
Treatment（实验性追加式 Structured ContextDelta）为 **71/89（79.78%）**。89 个同期配对任务中
共同通过 66、共同失败 12、仅 Control 通过 6、仅 Treatment 通过 5，Treatment−Control 为
**−1/89（−1.12pp）**，双侧精确 McNemar `p=1.0`。这不是明确正确率回退。

缓存改善很大且方向稳定：Control 整批输入缓存命中率为 **29.88%**，Treatment 为
**86.27%**，增加 **56.39pp**。Provider 未命中输入从 46,285,487 降至 8,669,562，减少
**81.27%**。所有 2,688 个 Provider usage 记录均通过
`input = uncached + cached` 与 `total = input + output` 恒等式。

因此，本轮满足预先声明的发布 Gate：正确率没有明确回退、完整性 Gate 全过、缓存率实质改善。
建议把 `experimental-structured-deltas` 提交给论文任务作为**新候选基线**复核；不在本报告中直接
改写论文。该建议同时保留下列边界：Treatment 总墙钟反而长 6.55%，输出与推理 Token 也更多，
并出现一例独有 AgentTimeout；缓存改善不等同于所有效率指标都改善。

## 冻结协议与执行身份

- 协议：`me08-terminal-bench-prefix-cache-stable-schema-ab-all89-v2`；
- 两臂均为完整 Terminal-Bench 2.1 89 题、每题一次、零重试、官方 raw reward、无 Harness；
- 两臂均使用 `gpt-5.6-sol`、reasoning `max`、`full_access`、`fallback=false`；
- 每臂并发 8，最大同时 trial 为 16；每题独立 trial 目录、SQLite、Context 与 Session；
- Runtime commit：`89adf739454da52bce2b35b00fb9e8fa050c5557`；两份二进制嵌入版本均与该 commit 一致；
- Control 二进制 SHA-256：`7cb92253d362a5898f10ff8d09499236d1dbfe3ebd29f3b9d0e25fbd7829ca54`，
  Build ID `a5460440f8a1e77eb07309b8cdb3d6be8ce71855`，Cargo features 为空，策略
  `implicit-prefix`；
- Treatment 二进制 SHA-256：`ce96ba70261803938bd01c2f1c665ad747bc0d603c51e8d3bd6f0575137ae92d`，
  Build ID `89458177ccb11650823f3126b70d4496330f4035`，启用
  `experimental-openai-chatgpt-structured-cache`，策略 `experimental-structured-deltas`；
- launcher SHA-256：`802321d3867211624e4e33b833d4c84c52bc9585d96715f93b5a9d7099cf370a`。

启动后复核了上述二进制 SHA-256、Build ID、嵌入 Runtime commit、launcher SHA-256 与两份干净
源码 checkout。89 + 89 份实际配置也全部匹配冻结的模型、reasoning、full-access、并发与各自策略。

## 完整性 Gate

- 每臂 89 个唯一任务、一次尝试；`launcher_result.json` 明确标记
  `complete_official_results=true`；
- 178 个 trial 目录、178 份 SQLite、178 份轨迹和 178 份 integrity record 均存在；
- 178/178 SQLite `quick_check=ok`；每库恰有一个 Agent、一个 Context、一个 Session；
- 178 个 Context ID 与 178 个 Session ID 跨两臂均唯一；
- 178/178 integrity audit 完成，0 disqualified、0 finding、0 轨迹 SHA-256 不匹配；
- `runtime/evaluation_harness_binding` 为 0；
- Control 在 89/89 数据库产生 wire audit，Structured Delta start/reuse 为 0；
- Treatment 在 89/89 数据库产生 Structured Delta start，87/89 产生 reuse 与 Provider usage；
  另外两题 `break-filter-js-from-html`、`vulnerable-secret` 在 Provider usage 前走安全拒绝终止路径；
- `STRICT_RESULT.json` 的全部 Gate 为 true。完整性诊断不覆盖任何官方失败。

## 主要结果

| 指标 | Control | Treatment | Treatment − Control |
| --- | ---: | ---: | ---: |
| 官方通过 | 72/89 | 71/89 | −1 |
| 官方正确率 | 80.90% | 79.78% | −1.12pp |
| Wilson 95% CI | [71.52%, 87.72%] | [70.28%, 86.81%] | — |
| Provider 输入 Token | 66,006,703 | 63,147,898 | −2,858,805 |
| 缓存输入 Token | 19,721,216 | 54,478,336 | +34,757,120 |
| 未缓存输入 Token | 46,285,487 | 8,669,562 | −37,615,925 |
| 输入缓存命中率 | 29.88% | 86.27% | +56.39pp |
| 输出 Token | 1,380,558 | 1,831,532 | +450,974 |
| Provider 输入 + 输出 | 67,387,261 | 64,979,430 | −2,407,831（−3.57%） |
| 墙钟 | 6,349.93 s | 6,765.76 s | +415.83 s（+6.55%） |

命中率按请求序号与任务长度的完整拆分见 `CACHE_ANALYSIS.md` 和 `CACHE_AUDIT.json`。

## 失败与超时

官方分数保留所有失败。Control 的 17 个零分中，3 个没有 `reward.txt`，主异常均为 900 秒
VerifierTimeout：`pytorch-model-recovery`、`torch-pipeline-parallelism`、
`torch-tensor-parallelism`。Treatment 的 18 个零分中，`torch-pipeline-parallelism` 为
900 秒 AgentTimeout，`torch-tensor-parallelism` 为 900 秒 VerifierTimeout。

两臂都在 `break-filter-js-from-html` 与 `vulnerable-secret` 出现终止性安全拒绝。另有每臂各
2 次 `server_unavailable`，独立探针均成功并恢复应用请求；无 quota、无重试、无 circuit-open、
无 probe-fail、无 Runtime boundary failure、无 Harness 绑定、无非空 Agent stderr。

同期配对的六个 Control-only 任务为 `financial-document-processor`、`gcode-to-text`、
`kv-store-grpc`、`model-extraction-relu-logits`、`overfull-hbox`、`video-processing`；五个
Treatment-only 任务为 `chess-best-move`、`feal-linear-cryptanalysis`、`mteb-leaderboard`、
`raman-fitting`、`train-fasttext`。最终 6:5 的不一致数不支持把中途看到的 Treatment 较多错题
解释为系统性能力退化。完整分类见 `FAILURE_AUDIT.md` 与 `FAILURE_AUDIT.json`。

## 非同期描述性参考

- 相对保存的 Morphz 72/89：Control 仍为 72/89，但逐题有 6 gain / 6 regression；Treatment
  为 71/89，有 5 gain / 6 regression；
- 相对冻结 Codex 74/89：Control 为 6 gain / 8 regression；Treatment 为 4 gain / 7 regression；
- 上述只作描述性参考，不冒充本轮同期双臂。当前 A/B 的主比较始终是 Control 对 Treatment。

## 主机资源

资源监控共 226 个样本：16 logical CPU，1m load 平均 5.439、p95 15.391、峰值 25.648；
内存使用平均 5.14 GiB、p95 7.71 GiB、峰值 9.62 GiB；Docker 运行容器平均 16.58、峰值 18。
没有持续资源饱和证据，也没有 16 并发导致 Provider 容量崩溃的信号。

## 证据入口

- `STRICT_RESULT.json`：冻结 Gate；
- `RUN_AUDIT.json`：身份、隔离、策略覆盖、资源与官方结果审计；
- `CACHE_AUDIT.json` / `CACHE_ANALYSIS.md`：逐题、请求序号和任务长度缓存统计；
- `FAILURE_AUDIT.json` / `FAILURE_AUDIT.md`：失败、超时与 Provider 异常；
- `PAIRED_COMPARISONS.json`：同期主比较和非同期参考；
- `all_89_cache_ab_summary.json`、`launcher_manifest.json`、`launcher_result.json`、
  `arm_progress.json`、`resource_samples.jsonl`：服务器冻结摘要；
- `SHA256SUMS`：本目录全部受控证据的本地校验和。

服务器原始 run root 保持不变：
`/opt/morphz-benchmark/repeat-runs/me08-prefix-cache-ab-89adf73-r1-20260830`。
