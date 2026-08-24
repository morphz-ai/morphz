# Terminal-Bench 2.1 Harness v0.4 `raman-fitting` 回归结果

> 状态：`completed-failed / closed`
>
> 日期：2026-08-24
>
> 证据边界：已观察题的单次、事后产品回归；不得计入未见题成绩、公开榜单或论文确认性结果

## 1. 结论

`terminal-task@0.4.0` 的通用 best-valid-checkpoint / proof-to-final 文本协议没有在本次
回归中改善 GPT-5.6 Sol 的任务收敛。唯一允许的 `raman-fitting` 运行得到 raw/strict
reward `0.0`。Agent 没有写出任务要求的 `/app/results.json`，最后返回的是一条未来时态
的进度说明：

> I’m generating a visual diagnostic of the peak regions to resolve the remaining baseline/peak separation before writing the final JSON.

该文本被 Morphz CLI 和 Harbor adapter 视作本次 Evaluation 的终端回复，因此 Harbor
记录为正常结束、无 `AgentTimeoutError`；但它不是完成答复，也没有对应的任务产物。
本次 v0.4 回归失败，结果原样保留，不重试。

## 2. 冻结身份与运行门禁

- 任务：`terminal-bench/raman-fitting`；task checksum
  `73157911d2f6196d30097f9b7e3388771a0a843500ad23ea31b66ca9ae5b5118`；
- 模型：精确物理模型 `gpt-5.6-sol`；reasoning effort `max`；
- 权限：`full_access`；并发 `1`；attempts `1`；Harbor retries `0`；
- Runtime：`paper-eval-runtime-v4@5e4b0ffcd89245f19d84ec3569605ae27a44e02b`；
- Linux Runtime SHA-256：
  `f98c17bcc3204216aa39b3833994ad01da45c3015e02216eeb12a9290dd99e67`；
- watcher SHA-256：
  `9bfaa4b2eb87f65274ac09409bf6d46700175acb4870f5522a8f96e458e4bd06`；
- Harness：`terminal-task@0.4.0`；source SHA-256
  `1c150f5ec72ee1e66d722b17ad418aaf87e7ece4514d98497d6fddf982da88a6`；
  normalized artifact hash
  `sha256:b6063a4a970362888f6194fdfa498421b417bb032f4b58bf96e0bf5a0571aae2`；
- 本地冻结 commit：`4284d69`；云端 selective commit：
  `06cfecdd56625223bcf54796d6c068c5c1d16c34`；
- Harbor：`0.21.0`；容器平台：`linux/amd64`；
- 无模型 one-task install-only：通过；云端 adapter/selection 测试 `24 passed`；
- 运行前 preflight：通过；运行后 integrity Gate 与 public Run Gate：通过。

ATIF 同时记录了 Harness ID、版本、artifact hash、唯一 Evaluation binding 与精确
Runtime/模型身份；没有发生 Harness 漏绑或错绑。

## 3. 本次结果

| 指标 | v0.4 结果 |
| --- | ---: |
| raw reward | 0.0 |
| strict reward | 0.0 |
| Harbor exception | 无 |
| Agent execution | 891.43 秒 |
| ATIF steps | 24 |
| 有 usage 的模型求值 | 24 |
| input tokens | 1,004,381 |
| cached input tokens | 33,280 |
| output tokens | 32,894 |
| `/app/results.json` | 未创建 |
| 最终回复 | 进度说明，不是任务结果 |

任务从 `2026-08-24T09:51:20.523674Z` 执行到
`2026-08-24T10:06:11.958008Z`。模型在约第 869 秒返回上述进度说明，CLI 随后正常
退出，所以它避开了 Harbor 900 秒异常分类，但没有完成任务。

## 4. 与 v0.3 同题轨迹的描述性对照

| 指标 | v0.3 `gTfsgXW` | v0.4 `gUEqpYb` | 变化 |
| --- | ---: | ---: | ---: |
| reward | 0.0 | 0.0 | 无改善 |
| 结束方式 | `AgentTimeoutError` | 正常退出但未交付 | 只改变外层分类 |
| Agent execution | 905.23 秒 | 891.43 秒 | -13.80 秒 |
| ATIF steps | 18 | 24 | +33.3% |
| input tokens | 612,131 | 1,004,381 | +64.1% |
| cached input tokens | 19,968 | 33,280 | +66.7% |
| output tokens | 32,056 | 32,894 | +2.6% |
| 最后行为 | 继续拟合工具调用 | 声称还要继续生成诊断 | 均未交付 |

这只是两个随机单次轨迹的描述性对照，不能把差异归因于 Harness；但它足以否定
“v0.4 已经证明能推动 Sol 收口”的产品判断，也不支持扩大 v0.4 批次。

## 5. 轨迹归因

本次没有证据指向 Provider 或 Runtime 执行故障：模型流持续完成，Activation lease
持续续约，工具调用正常返回，Harbor 没有异常，Integrity finding 为零。失败发生在
Agent 的任务策略与终态表达层：

1. Agent 没有先创建最小可用的 `results.json` 再逐步改进，而是一直把产物写入推迟到
   “完成更多分析之后”；
2. 在已有多轮拟合结果后，仍不断新增窗口、基线、峰型和可视化假设；
3. Harness 的 acceptance ledger、best checkpoint 和 decision checkpoint 只是模型可见
   的语义约束，没有可观察、可校验的 Runtime 状态；
4. Agent 最后输出一条进度消息，现有 Evaluation I/O 边界无法区分它与真正终端答复。

因此，v0.4 的问题不是措辞还不够强，而是文本建议缺少可执行的终态协议。

## 6. 后续设计边界

若继续迭代，应建立任务无关的显式完成协议，而不是增加 Raman 规则、工具次数、固定
时间检查或 verifier 细节：

- 区分 progress delivery 与 terminal delivery；Evaluation 只在显式终态提交后结束；
- 终态提交携带 `terminal_state`、关键 acceptance condition 状态、要求的 effect/artifact
  引用与限制说明；
- 对用户明确指定的产物路径或持久效果，Runtime 在接受成功终态前验证其存在；
- 未满足终态合同的普通文本不得伪装成 completed，但也不能通过语言启发式无限续跑；
- 最小可用产物与后续优化分离，优化失败时仍能提交已保存的 checkpoint。

该方向需要单独设计和确定性测试。v0.4 已关闭，未经新的冻结协议和用户授权，不再调用
模型复跑。

## 7. 证据与哈希

归档目录：
[`artifacts/terminal_task_harness_v0_4_raman_regression`](./artifacts/terminal_task_harness_v0_4_raman_regression)

- job `result.json`：
  `7a3a8fc1c4f1a399e49c5a143145e6ada694d1c84cd1e5a5b7109cb9f9159752`；
- `strict_result.json`：
  `5b21989b3faad168fe81462a433d4c6f60c04f402e8815279d65706ff65bd36b`；
- `public_run_gate.json`：
  `e44d7674fef3410e5d0325346db742367d349e7106a7e7767c4c1359d767981c`；
- trial `result.json`：
  `ebc6bec0d9fdb9a7fa9202c0508c3c5864eac1dd9e9ae560c8fb7a930abc7035`；
- ATIF `trajectory.json`：
  `a11000799e9c050ed4e16eee886eb594622511149f0fd0784e165d4bad76f879`。

归档只包含公开 job/trial 结果、ATIF、Harness 安装证据、Morphz 自有日志与工具产物；
没有复制或使用 verifier 私有测试、输出或参考答案。
