# ME-01 p1 fixture 与评分器无模型 Gate

> 日期：2026-08-25（Asia/Shanghai）
>
> 协议：`me01-context-reentry-p1-candidate`
>
> 证据级别：工程 Gate；不是 Pilot 结果，不进入论文定量结论

## 1. 目的

在调用真实模型前，先验证 ME-01 的任务族、hidden answer 隔离、严格行动评分、三组实现
真实性合同和负例拒绝路径。该 Gate 的核心作用是防止再次把本地 JSON 状态机误称为生产
Morphz，也防止在评分器或 fixture 尚未闭环时消耗订阅额度。

## 2. 已形成的材料

- 候选协议：
  [`me_01_structured_context_reentry_pilot_protocol_p1.md`](./me_01_structured_context_reentry_pilot_protocol_p1.md)；
- 5 个可见 fixture 与分离的 hidden expected answer：
  `morphz-evals/tests/fixtures/me01_context_reentry_p1/{visible,hidden}`；
- fixture 审计、三组实现证据合同、严格评分器和 fake Gate：
  `morphz-evals/src/me01_context_reentry_eval.rs`；
- 命令入口：`morphz-evals/src/bin/me01_context_reentry_eval.rs`；
- 生产 Runtime 只读 Context 开关：
  `MORPHZ_CONTEXT_TRANSACTIONS_ENABLED=false`。该配置会从生产工具注册表移除
  `context_tx`，并使 Context turn budget 报告 `context_tx_available=false`。默认值为
  `true`，正常产品路径不改变。

## 3. 实际结果

执行：

```text
cargo test -p morphz-evals --lib me01_context_reentry_eval
cargo clippy -p morphz-evals --lib -- -D warnings
cargo run -q -p morphz-evals --bin me01_context_reentry_eval -- \
  fake-gate /private/tmp/morphz-me01-20260825
cargo run -q -p morphz-evals --bin me01_context_reentry_eval -- \
  embedded-runtime-gate /private/tmp/morphz-me01-20260825
cargo run -q -p morphz-evals --bin me01_context_reentry_eval -- \
  standalone-process-gate /private/tmp/morphz-me01-standalone-20260825-r2
cargo test -p morphz --lib \
  disabled_context_transactions_are_unavailable_even_with_unused_budget
cargo test -p morphz --lib \
  read_only_context_configuration_omits_context_tx_from_production_registry
cargo clippy -p morphz --lib -- -D warnings
```

结果：

| Gate | 结果 |
| --- | ---: |
| 可见 fixture | 5/5 通过结构与引用审计 |
| 三组正例 | 15/15 strict pass |
| 故意负例 | 5/5 被拒绝 |
| ME-01 单元测试 | 6 passed |
| 生产 Runtime 内嵌因果链测试 | 1 passed |
| 三臂独立进程接线正例 | 15/15 strict pass |
| 两个 Morphz arms 的进程重启恢复 | 10/10 通过 |
| 两个 Morphz arms 的独立 SQLite | 10/10 通过 |
| 原始产物重评分 | 15/15 逐字节一致 |
| 跨 Session 同 Context 挂载 | 通过 |
| 不同 Context 隔离 | 通过 |
| Runtime 只读 Context 定向测试 | 2 passed |
| `morphz-evals` Clippy | 通过 |
| `morphz` Clippy | 通过 |

本次 fake Gate 输出：

```text
/private/tmp/morphz-me01-20260825/
  ME-01-fake-gate-20260825T032011.702Z-50872/
```

其 `summary.json` 记录：

```json
{
  "fixture_count": 5,
  "positive_episode_count": 15,
  "positive_strict_passes": 15,
  "negative_case_count": 5,
  "negative_cases_rejected": 5,
  "ready_for_runtime_adapter_implementation": true,
  "ready_for_real_model_smoke": false
}
```

生产 Runtime 内嵌 Gate 输出：

```text
/private/tmp/morphz-me01-20260825/
  ME-01-embedded-runtime-gate-20260825T032957.382Z-51675/
```

该 Gate 使用 deterministic fake Provider，但其余路径为实际 `MorphzRuntime`、实际生产
工具 Registry、实际 SQLite、实际 EventBus/Orchestrator、实际 ContextEngine 和实际
Context 投影：

| Arm | Fake Provider 调用 | Provider 看到 `context_tx` | tx attempts | tx commits | 提交 Frame 出现在 act 请求/最终 Context |
| --- | ---: | --- | ---: | ---: | --- |
| `full_morphz` | 4 | 是 | 1 | 1 | 是 / 是 |
| `structured_no_direct_reentry` | 3 | 否 | 0 | 0 | 否 / 否 |

两组最终都按 fake Provider 的固定响应返回正确 JSON。该结果不衡量模型能力，只证明三组
实验所要求的 capability 差异已经落在生产 Runtime 路径上，而不是落在 fixture 声明中。

独立进程 Gate 输出：

```text
/private/tmp/morphz-me01-standalone-20260825-r2/
  ME-01-standalone-process-gate-20260825T034133.078Z-52861/
```

该 Gate 对 5 个 fixture 分别运行三组。`append_only` 保存完整消息 transcript；两个
Morphz arms 的 `establish/revise` 与 `act` 由两个不同 OS 进程执行，并在中间只保留同一
episode 的 SQLite，不把状态复制进 act prompt。10 个 Morphz episode 使用 10 个不同
数据库路径；跨 Session fixture 的 A/B Session 实际挂载同一 Context；隔离 fixture 的
foreign/primary Session 实际挂载不同 Context，primary act 投影不含 foreign 值。

15 个 `observed_episode.json` 均重新读取并由同一确定性 scorer 重放，重建的
`score.json` 与初次评分逐字节一致。仓库内脱敏归档与临时数据库位置见
[`artifacts/ME01_NO_MODEL_GATES_20260825.md`](./artifacts/ME01_NO_MODEL_GATES_20260825.md)。

这里的子进程运行的是链接实际 `MorphzRuntime`、Registry、SQLite、EventBus、
Orchestrator 和 ContextEngine 的评测探针。它已经证明 OS 进程边界与恢复链，但真实模型
smoke 仍必须换成冻结 commit 构建的正式 `morphz` 二进制和真实 Provider；因此本 Gate
仍不把 `ready_for_real_model_smoke` 置为 true。

## 4. 负例覆盖

评分器已确认会拒绝：

1. 非法 JSON；
2. 错误 evidence ID；
3. `full_morphz` 声称正确行动但没有真实 Context 提交；
4. 只读结构化组出现任何 Context 事务；
5. arm 可见语义输入 hash 与共同 fixture 不一致。

严格 Action 类型使用 `deny_unknown_fields`，因此额外解释字段也不能混进主要结果。
陈旧值、外部 Context 值、对象、行动与证据分别记录，后续可以做失败归因，而不只输出
一个总分。

## 5. 对既有实现的审计结论

旧路演 `roadshow_demo_001_adapter.rs` 和 `roadshow_demo_001_smoke.rs` 可用于验证产物合同，
但其 Morphz arm 的状态维护是本地 `DurableArmState`/JSON validation，并未经过生产
ContextEngine 的 Context 事务和持久投影。因此它们不得被复用为 ME-01 的 Morphz
证据。

可以复用的是 `long_horizon_agent_eval.rs`、`context_metacognition_eval.rs` 和
`concurrent_objective_eval.rs` 中已经存在的生产二进制启动、独立 SQLite、Session 挂载、
Event History、重启和 Context inspection 模式。

## 6. 当前 Gate 判定

- `fixture_and_scorer_gate=true`；
- `read_only_runtime_capability_gate=true`；
- `embedded_production_runtime_causal_gate=true`；
- `standalone_process_arm_adapters_complete=true`（无模型评测探针）；
- `cross_session_mount_gate=true`；
- `context_isolation_gate=true`；
- `process_restart_recovery_gate=true`；
- `raw_artifact_rescore_gate=true`；
- `ready_for_real_model_smoke=false`；
- `model_calls_this_gate=0`。

下一步只补真实调用层：冻结正式 `morphz` 二进制与精确 Provider/model/reasoning/
fallback/full-access 预检，实现 append-only 的同 Provider 直连 adapter，并让两个 Morphz
arms 记录真实请求、响应和 usage。完成一次无模型预检后，才允许三组各 1 个真实 smoke；
不得从本报告直接跳到 15 episode Pilot。
