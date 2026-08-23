# Terminal-Bench 2.1 前 20 题单次诊断结果（2026-08-24）

> 状态：`diagnostic-complete / non-public / non-reportable-as-leaderboard-score`
>
> 本批次用于控制成本、检查执行路径和定位失败原因，不是 89 题公开榜成绩；不得与
> 其他批次、定向补跑或历史运行拼接计算分数。

## 1. 结论

按 Terminal-Bench 2.1 官方固定顺序运行前 20 道题，每题 1 次，并发数 5，不重试：

- 完成：20/20；
- 官方 verifier 通过：15/20，原始通过率 **75%**；
- Runtime/Harness exception：0；
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

## 5. 定向复测与根因收敛

第一版修复仅保留 `keep_running=true` 的进程组，并在 verifier 前终止 Runtime。随后只对
`pypi-server` 做了 1 题 × 1 次、并发 1、无重试的定向复测：Agent 再次成功完成建包、
PEP 503 索引、HTTP 服务和从该索引安装后的函数断言，但官方 verifier 仍为 0。该结果
不得拼入前 20 题分数。

复测轨迹与 Agent 自有服务日志证明，服务在 Agent 内部测试阶段正常；verifier 阶段没有
留下新的 HTTP 请求记录。进一步检查发现：HTTP 服务的 stdout/stderr 仍连接到 Runtime
持有的读取管道。第一版虽然保留了服务进程，却终止了 Runtime，服务在 verifier 首次
请求写访问日志时会遇到断开的管道。因此根因不是模型没有完成任务，而是
**Agent 返回边界没有同时保留服务及其 I/O 所有者**。

第二版边界改为：

1. 冻结 Runtime；
2. 保留显式 `keep_running=true` 的后台服务；
3. 终止未完成的临时命令；
4. 在 Harbor 销毁任务容器前不终止被冻结的 Runtime，使其继续持有服务输出管道；
5. 让 Harbor verifier 在同一容器内访问所需服务，随后由容器生命周期统一清理。

云端 Linux 集成测试会启动一个 stdout 连接到模拟 Runtime 的真实 HTTP 服务，冻结
Runtime 后再发出模拟 verifier 请求；请求成功，服务仍存活。连同取消、进程组和审计
测试共 15 项通过。新 watcher SHA-256 为
`9873d7945f8a86b583ba5ed8884bc286db51da9292d3f8569e8d8582c19785bb`。

第二版尚未再次调用模型；是否再花一次额度复测 `pypi-server`，由用户明确决定。

## 6. 停止条件与后续顺序

当前只允许：

1. 原始严格审计与 public gate 已原样恢复并保留；r2 修正派生产物的 integrity/public
   gate 均通过，分数仍为 75%；
2. 第一版 `pypi-server` 定向复测已保留为 0 分诊断结果，不拼接；
3. 第二版已通过无模型 Linux HTTP 集成测试；再次真实复测须由用户明确确认；
4. 继续汇总 20 题轨迹中可泛化的 Runtime/认知策略改进，再决定是否启动 89×1。

未经用户再次明确确认，禁止启动剩余 69 题、89×1 或 89×5。
