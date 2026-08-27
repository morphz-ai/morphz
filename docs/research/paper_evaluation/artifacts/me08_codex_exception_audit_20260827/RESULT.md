# ME-08 Codex 异常分类复核

本复核只对已经冻结的 Codex 89 题运行做诊断分类，不重新评分，也不从官方分母中剔除任何
失败。官方结果仍为 `73/89`。

## 结论

Codex 的 89 个 trial 中共有 9 个带结构化 `exception_info`：

- 3 个 `AgentTimeoutError`：`make-doom-for-mips`、`password-recovery`、
  `query-optimize`；
- 1 个 `VerifierTimeoutError`：`torch-tensor-parallelism`；
- 2 个 `ApiRateLimitError`：`mcmc-sampling-stan`、`fix-git`；
- 3 个 `AgentSafetyRefusalError`：`vulnerable-secret`、
  `break-filter-js-from-html`、`feal-differential-cryptanalysis`。

三个安全拒绝的异常消息均包含 Provider 返回的 cybersecurity-risk 标记。其任务集合与
Morphz `4bbc3d6` 运行中确认的三个 `cyber_policy` 拒绝完全一致。这是同一模型服务端政策
边界的对称证据，不是 Morphz Runtime 特有失败。

Codex 确实存在 Agent 超时，因此不能把“是否出现超时”本身当作区分两种 Agent Runtime
的证据。后续应比较超时任务集合、终止前执行轨迹及可归因边界；官方 verifier 超时也必须
与 Agent 超时分开。

## 证据与方法

异常类型直接读取云端保留 trial 的 `result.json -> exception_info.exception_type`。安全拒绝
另检查 `exception_message` 中 Provider 的 cybersecurity-risk 标记。任务结果仍以官方
verifier `raw_reward` 为准；本分类不覆盖、重算或修正官方得分。

冻结归档输入：

- 前 40 题 Codex job result SHA-256：
  `eb6e762ab98ee5d2a84684439141a222f9f71bb3d39e1358ed88307717b7e7e9`；
- 前 40 题 Codex strict result SHA-256：
  `d3a67e93dfdabefbc07fe1abb785f9313286818e421728a5fd209198817f69ec`；
- 后 49 题 Codex job result SHA-256：
  `53db62940cbed00f02e125cdbdf1fe88ca26c7ed27f139d4ed28f1fa31b5ffc6`；
- 后 49 题 Codex strict result SHA-256：
  `141ad3e46b9f4e3e300e6b9b374cb251aaf4d9a354797f1b493432352e5835ac`。

机器可读分类见 `codex_exception_summary.json`。
