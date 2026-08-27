# Yao 参考实现验证记录 v0.1

> 状态：Draft 实现证据
>
> 维护者：新变元（Newvar）
>
> 最后更新：2026-08-28
>
> 规范文本：[English](../yao_reference_implementation_verification_v0_1.md)

## 1. 目的

本文档把 Yao v0.1 Draft 规范映射到 Morphz 参考实现中的自动化证据。它是实现验证记录，
不是一致性证书，也不能替代规范文本。

测试边界不只覆盖成功示例，还覆盖无效和对抗性源码、静态权限拒绝、确定性身份、序列化与
恢复、部分并行完成、失败聚合、伪造 Host 值、数据库迁移和 Legacy 源码拒绝。

## 2. 自动化证据

| 要求范围 | 主要自动化证据 | 状态 |
| --- | --- | --- |
| UTF-8 语法、精确 Span、转义、注释、畸形输入、源码和嵌套限制 | `yao::syntax::tests` | 通过 |
| Parser 稳健性 | `arbitrary_short_inputs_never_panic` 中 4,096 个确定性生成的短输入 | 通过 |
| 规范化源码与类型化身份 | `yao::canonical::tests` | 通过 |
| 命名 Record/Union、穷尽 `match`、集合、`Option`、`Result`、`Ref`、`Program` | `yao::sema::tests`、`yao::eval::tests` | 通过 |
| 静态 Effect 推导、Effect 上界、Tool 范围、Host Effect、Effect Normal Form | `yao::sema::tests`、`sexpr_eval::tests` | 通过 |
| 纯求值、受检 Decode、溢出/失败路径、分支作用域和确定性 `par` 顺序 | `yao::eval::tests`、`sexpr_eval::tests` | 通过 |
| 唯一无版本 Typed 源码语言并拒绝 `(version ...)` | `typed_source_is_the_only_public_source_language_and_rejects_version_forms` 与仅用于迁移的 Legacy Fixture | 通过 |
| 精确类型名，以及拒绝历史小写 `text` / `json` 别名 | `rejects_historical_lowercase_type_aliases`、`rejects_unknown_and_recursive_named_types` | 通过 |
| 唯一共享的模型可见 Yao Language Card 及大小预算 | `language_card_is_parseable_bounded_and_unversioned`、Context Protocol 与 `eval` Tool 契约测试 | 通过 |
| 类型化 Infer 请求/响应、Continuation 序列化与精确恢复 | `sexpr_eval::tests`、`plan_execution::tests` | 通过 |
| 同一个完整有类型正文可以由 `eval` 或 `infer` 求值，不降级为 task/evidence 请求 | `eval_and_infer_share_one_complete_typed_body`、`complete_yao_body_is_handed_to_the_model_without_task_request_lowering`、`eval_runs_a_submitted_program_and_hands_infer_back_to_the_model` | 通过 |
| 在两种求值器根上都拒绝已经移除的 `task`、`evidence`、`tools` 和 `model` 固定字段形式 | `fixed_infer_request_syntax_is_rejected_at_every_root` | 通过 |
| 源码授权的词法披露：只有 `(captures ...)` 列出的绑定可以跨越模型服务商边界；隐式 Runtime 与未列出局部绑定均不能跨越 | `nested_model_body_captures_only_explicit_parent_bindings`、`complete_yao_body_sends_only_source_authorized_lexical_captures`、`infer_discloses_only_source_authorized_parent_bindings_to_the_model` | 通过 |
| 持久 Infer 的 Tool 范围由正文中静态可见的调用推导，且绝不暴露 `eval` | `plan_infer_tool_scope_never_inherits_parent_tools_implicitly`、`infer_may_gather_evidence_but_is_never_offered_eval`、`plan_infer_handoff` | 通过 |
| 持久 `par` 子计划、分支隔离、全终态 Barrier、有序 Join、聚合失败与重启 | `sexpr_eval` 和 `plan_execution` 中的 `typed_par_*` 测试 | 通过 |
| Program Value 原始 Yao Transport、以 `eval` 或 `infer` 为根的程序准入与所有者分派、规范 Hash、有效 Effect/输出上界、调用者局部变量隔离、持久子执行与共享深度预算 | `program_admission_requires_raw_yao_*`、`infer_root_program_value_*`、`program_*`、`generated_program_*`、`nested_program_*` 测试 | 通过 |
| Typed Harness 入口、保留引号的规范化、模型入口显式 Tool 上界与真实 Function Calling 裁剪 | `typed_program_string_identity_survives_package_normalization`、`model_owned_entry_requires_an_explicit_tool_upper_bound`、Harness 与 Orchestrator 测试 | 通过 |
| Runtime 环境注入与类型化可选字段投影 | `runtime_context_is_injected_*`、`host_view_normalizes_*` | 通过 |
| Host Receipt 重放、Candidate 封闭性、引用不可伪造、同 Context Evidence 与 Objective 权限 | `plan_execution::tests` 中的 Host 测试和 `yao::eval::tests` 中的 Candidate 测试 | 通过 |
| 封闭的类型化 `ContextTransaction`、Context Authority 提交、确定性身份与崩溃窗口重放 | `context_transaction_is_sealed_canonical_and_host_typed`、`evaluates_and_revalidates_sealed_context_transactions`、`typed_context_proposal_commits_once_and_recovers_the_commit_window` | 通过 |
| 经 Objective Authority 实际应用 Progress、Wait 与 Completion Operation | `objective_wait_proposal_uses_authority_and_replays_without_a_second_transition`、`objective_completion_proposal_consumes_committed_outcome_and_replays_intent` | 通过 |
| SQLite Plan Wait 迁移、索引、终态 Fence Trigger 与重启生命周期 | SQLite 迁移测试及 `memory::sqlite::plan_execution::tests` | 通过 |
| 生产 Runtime、CLI、持久 Handoff、Store 一致性、评测包与向量扩展回归 | 下列 Package 与集成门禁 | 通过 |

## 3. 可复现门禁

2026-08-21 的验证运行使用了：

```text
cargo test -p yao-lang --offline
cargo test -p morphz --lib --offline -- --test-threads=1
cargo test -p morphz --bin morphz --offline -- --test-threads=1
cargo test -p morphz --test attempt_loop --offline -- --test-threads=1
cargo test -p morphz --test cli_contract --offline -- --test-threads=1
cargo test -p morphz --test objective_group_handoff --offline -- --test-threads=1
cargo test -p morphz --test plan_infer_handoff --offline -- --test-threads=1
cargo test -p morphz --test runtime_stability --offline -- --test-threads=1
cargo test -p morphz --test runtime_store_conformance --offline -- --test-threads=1
cargo test -p morphz --test terminal_handoff --offline -- --test-threads=1
cargo test -p morphz-evals --lib --offline -- --test-threads=1
cargo test -p morphz-memory-vector --offline -- --test-threads=1
cargo clippy --workspace --all-targets --offline -- -D warnings
```

语言 crate 完成 38 项测试；上述门禁共完成 1,160 项测试、无失败。另有 6 项测试因明确要求
真实外部登录或人工终端检查，保持其原有 `ignored` 声明。共享 Yao Language Card 同时通过
4,800 字符的硬性产物上限和 Context Encoding 中 1,200 估算 Token 的门禁。

### 3.1 完整正文 `infer` 与捕获边界增量验证（2026-08-28）

本次增量使 `eval` 与 `infer` 共享同一个完整有类型正文，并加入源码级 `(captures ...)`
披露边界。验证命令如下：

```text
cargo test -p yao-lang
cargo test -p morphz --lib -- --test-threads=1
cargo test -p morphz --test attempt_loop
cargo test -p morphz --test plan_infer_handoff
cargo clippy -p yao-lang --all-targets -- -D warnings
cargo clippy -p morphz --all-targets -- -D warnings
cargo fmt --all -- --check
git diff --check
```

本轮通过 47 项 Yao 测试、1,028 项 Morphz 库测试、74 项生产 Attempt Loop 测试和 4 项持久
Infer Handoff 测试；6 项库测试保持原有 `ignored` 声明。两项 Clippy 门禁、格式检查和 Diff
检查均通过。此外，还通过 GPT-5.6 Sol 对完整纯正文和包含普通 Tool 调用的完整正文各完成
一次真实模型 Smoke；非敏感证据记录于
[`yao_infer_complete_body_live_verification_2026_08_28.md`](../yao_infer_complete_body_live_verification_2026_08_28.md)。

绑定本地 Mock Server 或验证 Morphz 自身 macOS Sandbox 的测试必须在受限父 Sandbox 之外
运行。在嵌套 Sandbox 内执行时，操作系统会在测试对象运行前以 `Operation not permitted`
拒绝环境初始化。

## 4. Draft 缺口

以下规范目标尚未获得完整实现证据，因此继续保持 Draft：

- 父计划取消向所有未终止 `par` 和 Program 子计划的传播；
- `ExecutionTargetView` 的注入与授权行为；
- 每一种新增 Yao Wait Boundary 的 PostgreSQL 真实崩溃窗口测试；
- 在确定性 Parser 稳健性输入集之外，对语义 Decode、Canonicalization 和 Program 准入进行
  持续 Fuzz；
- 与独立 Yao 实现的互操作验证。

在这些缺口补齐之前，或尚未发布独立的一致性测试套件与版本化证据包时，任何发布都不得
宣称完整符合 Yao v0.1。
