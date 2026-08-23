# Terminal-Bench 2.1 前 20 题单次诊断结果（2026-08-24）

> 状态：`diagnostic-complete / non-public / non-reportable-as-leaderboard-score`
>
> 本批次用于控制成本、检查执行路径和定位失败原因，不是 89 题公开榜成绩；不得与
> 其他批次、定向补跑或历史运行拼接计算分数。

## 1. 结论

按 Terminal-Bench 2.1 官方固定顺序运行前 20 道题，每题 1 次，并发数 5，不重试：

- 完成：20/20；
- 官方 verifier 通过：15/20，原始通过率 **75%**；
- Runtime/Harness error：0；
- Provider 429/503：0；
- 输入 Token：9,181,663；缓存 Token：862,208；输出 Token：269,405；
- 运行时长约 55 分 46 秒；
- 该结果只说明当前前缀样本的一次诊断表现，不能外推为完整 89 题得分。

即使只跑 20×1，也已经消耗约 918 万输入 Token。因此在完成失败轨迹分析和定向验证
之前，不再自动扩展到 89×1，更不会启动 89×5。

## 2. 冻结身份与运行形状

- Runtime tag：`paper-eval-runtime-v4`；
- Runtime commit：`5e4b0ffcd89245f19d84ec3569605ae27a44e02b`；
- Runtime binary SHA-256：
  `f98c17bcc3204216aa39b3833994ad01da45c3015e02216eeb12a9290dd99e67`；
- 实验基础设施 commit：`7c00454e85bf78f437672c8b8b28a16d3ffd994a`；
- 实验 tag：`terminal-bench-2.1-diagnostic-20x1-cloud-r1`；
- 模型：精确物理模型 `gpt-5.6-sol`，reasoning `max`，fallback `false`；
- Provider：CLIProxyAPI / Codex subscription route；
- Harbor：`0.21.0`；
- Dataset digest：
  `sha256:7d7bd...0699a`（完整值保存在 Run manifest）；
- 参数：`n_attempts=1`、`n_concurrent=5`、`max_retries=0`、`n_tasks=20`；
- Job：
  `/opt/morphz-benchmark/diagnostic-jobs/20x1-20260823T203952Z/2026-08-24__04-40-16`。

## 3. 逐题结果

### 通过（15）

1. `caffe-cifar-10`
2. `circuit-fibsqrt`
3. `kv-store-grpc`
4. `llm-inference-batching-scheduler`
5. `log-summary-date-ranges`
6. `merge-diff-arc-agi-task`
7. `model-extraction-relu-logits`
8. `openssl-selfsigned-cert`
9. `path-tracing`
10. `qemu-alpine-ssh`
11. `regex-chess`
12. `regex-log`
13. `schemelike-metacircular-eval`
14. `torch-tensor-parallelism`
15. `write-compressor`

### 失败（5）

| 任务 | 当前归因 | 证据与下一步 |
| --- | --- | --- |
| `dna-assembly` | 模型方案/采样波动 | 本次选择 4-base flank 并依靠自建校验；此前同题另一试次通过，说明不是稳定 Runtime 故障。当前不补跑。 |
| `mteb-leaderboard` | 公开资料理解与快照判断错误 | Agent 正常访问任务指定的公开 MTEB 资料，但选出的模型不符合隐藏 verifier 的目标答案。属于研究/推理错误。 |
| `pypi-server` | **Morphz Harbor 适配层生命周期错误** | Agent 已成功建包、启动本地 PEP 503 服务并在任务内验证安装；正常退出 Runtime 时，`ProcessGroupGuard` 把 `keep_running` 服务一并终止，导致之后的 Harbor verifier 无法访问。已作最小修复，须单题定向复测。 |
| `pytorch-model-recovery` | 模型结构推断错误 | state dict 无法直接给出 attention head 数量，Agent 选择了未经充分证明的 `nhead=8` 并用自建检查闭环；无 Runtime 异常。 |
| `torch-pipeline-parallelism` | 未验证的复杂实现 | 任务环境缺少 Python，Agent 提交了未实际执行验证的实现；同题此前也失败，属于稳定的解题/验证策略短板。 |

## 4. 严格审计更正

原始严格审计把 `mteb-leaderboard` 访问
`https://huggingface.co/spaces/mteb/leaderboard/...` 判为
`task_specific_external_material`。该 URL 是任务要求查询的公开上游资源，不是答案、私有
测试或 Benchmark 仓库，因此属于审计规则的误报。

审计规则已收窄为只拦截以下高置信行为：

1. 用精确任务名进行外部搜索；
2. 访问 Benchmark/任务仓库；
3. 访问带有 solution、answer、writeup、walkthrough、hint 等答案形态的地址。

实际 MTEB 轨迹用修正规则只读重放后 finding 为 0。原始审计结果必须保留；修正版作为
带审计器新 commit 的独立派生产物，不静默覆盖原记录。本更正不改变该题 verifier 0 分，
因此原始与修正后的批次分数均为 15/20（75%）。

## 5. 已完成的最小修复

`run_morphz_harbor.sh` 的正常完成路径不再向 Runtime 发送普通 `exit`，而是在返回 Harbor
verifier 前使用与取消路径相同的 quiesce 边界：

1. 冻结 Runtime；
2. 保留显式 `keep_running=true` 的后台服务；
3. 终止未完成的临时命令；
4. 仅终止 Runtime；
5. 让 Harbor verifier 在同一容器内继续访问所需服务。

该修改已通过 shell 语法检查、diff check 和相关审计单元测试；仍须在 Linux/Harbor
环境定向重跑一次 `pypi-server`，证明服务确实跨过 Agent 返回边界。该定向结果只验证
修复，不计入本批次 15/20。

## 6. 停止条件与后续顺序

当前只允许：

1. 保存原始严格审计与 public gate，生成显式标注审计器版本的修正派生产物；
2. 在新基础设施 commit 上定向运行 `pypi-server` 1 题 × 1 次；
3. 若通过，确认适配层修复；若失败，只分析该题，不扩大样本；
4. 汇总 20 题轨迹中可泛化的 Runtime/认知策略改进，再由用户决定是否启动 89×1。

未经用户再次明确确认，禁止启动剩余 69 题、89×1 或 89×5。
