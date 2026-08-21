# Morphz Agent Trajectory 参考实现验证记录 v0.1

> 状态：Draft 实现证据
>
> 维护者：新变元（Newvar）
>
> 最后更新：2026-08-21
>
> 规范文本：[English](../morphz_agent_trajectory_reference_implementation_verification_v0_1.md)

## 1. 目的

本文档记录 Morphz 参考实现针对
[《Agent Trajectory 规范 v0.1》](morphz_agent_trajectory_specification_v0_1.md)的可执行证据。
它不是一致性证书。Event Store 始终是权威来源；导出、校验、Reward 解释与 Episode 派生
都不会改写源执行事实。

当前实现形成一个可实际运行的闭环：

```text
权威 Event History
  -> 有界 Agent Trajectory 导出
  -> 结构与完整性校验
  -> 不可变 Verifier Result
  -> 独立的不可变 Reward Record
  -> 经过权限校验的 Training Episode
```

## 2. 已实现 Surface

| Surface | 参考实现行为 | 证据 |
| --- | --- | --- |
| 确定性导出 | 通过索引 Event Query 选择有界 Context/Objective/Activation 范围；按 Sequence、时间与身份排序；生成稳定 Bundle Identity | `exporter_preserves_causality_redacts_secrets_and_seals_integrity` |
| 因果投影 | 为声明的 Parent Field 生成类型化 Edge，保留范围外 Parent，并派生有序 Plan Effect Edge | `trajectory::tests` 中的 Exporter 与 Verifier 测试 |
| 状态边界 | 把 Context Before/After/Snapshot Revision 投影为稳定 State Ref，并校验每个 Node-State 引用 | Exporter 与结构校验测试 |
| 披露与权利 | 递归脱敏 Credential 形态字段，默认脱敏用户内容，记录省略项，且默认禁止训练 | Exporter 与权限测试 |
| 完整性与不可信输入 | 使用声明的 SHA-256 序列化 Digest 封装 Bundle；在不执行 Payload 的前提下校验身份唯一性、交叉引用、因果无环、Scope 一致性与 Digest | `verifier_rejects_tampering_and_causal_cycles` 及交叉引用测试 |
| Verifier Result | 只有在同一 Context 中找到全部 Evidence Ref 后，才提交确定性的不可变 Event；精确重放保持幂等 | `trajectory_verifier_and_reward_facts_are_durable_idempotent_and_exportable` |
| Reward Record | 单独提交确定性的解释记录；其 Source 必须是同一 Context 中既有 Outcome、Verifier Result 或 Reward Record | Runtime 集成测试与训练闭环测试 |
| Training Episode | 同时要求 `AT-Training` Profile 与显式 `rights.training=true`；输出明确的 Model Input、Supervised Target、Environment Output 与 Loss Mask 角色 | `verifier_reward_and_training_episode_form_a_permissioned_loop` |
| 管理 API | Rust SDK 提供 Bundle 导出/校验、Fact Commit、Episode 派生与纯 Episode 校验 | SDK 编译与 Library 测试 |
| 操作界面 | CLI 提供 `trajectory export`、`trajectory verify` 与 `trajectory episode` | `trajectory_commands_preserve_scope_rights_and_input_file` |

当前参考 JSON 形态由以下文件描述：

- [Agent Trajectory Bundle Schema](../schema/morphz_agent_trajectory_bundle_v0_1.schema.json)；
- [Training Episode Schema](../schema/morphz_training_episode_v0_1.schema.json)。

## 3. 恢复与权威性质

- Verifier 与 Reward Identity 由内容确定性派生；重复提交相同内容会返回既有 Event，身份已被
  不同内容占用时会拒绝；
- Verifier Evidence 与 Reward Source 在持久化前，都通过 Context-scoped Event Query 解析；
- Reward Record 不修改 Outcome 或 Verifier Fact，也不能静默成为源事实；
- Bundle 校验是纯操作，不会执行嵌入 Payload、访问外部引用、恢复 Capability 或写入 Runtime；
- Bundle 缺少 Training Profile 或显式训练许可时，Episode 派生会被拒绝。

## 4. 可复现门禁

聚焦证据可以通过以下命令复现：

```text
cargo test -p morphz trajectory --lib --offline -- --nocapture
cargo test -p morphz typed_context_proposal_commits_once_and_recovers_the_commit_window --lib --offline
cargo test -p morphz objective_wait_proposal_uses_authority_and_replays_without_a_second_transition --lib --offline
cargo test -p morphz objective_completion_proposal_consumes_committed_outcome_and_replays_intent --lib --offline
cargo test -p morphz trajectory_verifier_and_reward_facts_are_durable_idempotent_and_exportable --lib --offline
```

仓库 Release Gate 还会运行完整 Yao/Morphz 单元与集成测试、格式检查、Clippy、参考 Schema
JSON 解析及 `git diff --check`。

## 5. 当前边界

- Exporter 会保留 External Parent 声明，但不会无界递归获取请求 Selection 之外的完整因果闭包；
- Context State 当前主要按精确 Version Ref 和可选 Delta 导出，不会自动披露完整 Context Snapshot；
- AT-Evaluation 的 Environment 与 Model Binding 是对已表示事实的尽力投影；部署必须声明不可得
  Binding，不能夸大可复现性；
- 当前 Integrity Profile 是声明的确定性 Digest，不是 Canonical Signature，也不能证明所表示
  Outcome 为真；
- Dataset 分片、Consent 撤销流程、Trainer Adapter、独立实现互操作与规范性 Conformance Suite
  仍属于后续工作。

因此当前声明保持克制：Morphz 提供经过测试的可移植结构化经验与受权 Episode 派生参考管线，
不声明已经完整符合 Agent Trajectory v0.1。
