# Yao Morphz Runtime Profile v0.1

> 状态：草案
>
> 维护者：新变元
>
> 规范原文：[English](../yao_morphz_runtime_profile_v0_1.md)
>
> 最后更新：2026-08-21

## 1. 目的

本 Profile 在不把 Scheduler 暴露为语言控制面的前提下，将 Yao Core 绑定到 Morphz Runtime，
定义稳定 Host Object、不可变 View、Host Effect、Capability Settlement、Lowering Target 与
Resource Limit。

## 2. 边界规则

当一个操作的正确性依赖 Yao 类型、因果身份、事务、恢复或 Runtime 权威结算时，它属于
本 Profile；可替换的领域能力属于 Tool Schema。Yao 可以观察并请求改变 Runtime 语义对象，
但不能直接修改数据库行、Lease、Revision、Queue、Worker、Scheduler Job、Thread Activation
或 Provider Client。

## 3. Host Object

```text
Agent Objective Evaluation Context Evidence Outcome
HarnessBinding CapabilitySet Principal ExecutionTarget Program
```

`Thread` 可以作为只读因果/诊断引用。`Activation`、`ExecutionJob`、`PlanExecution`、Queue、
Lease、Fence 与数据库 Record 不是语言对象。Ref 不可伪造，按 Kind 与稳定 Identity 比较；
源码不能从 String 构造 Ref。

## 4. Evaluation Environment

Morphz 在准入时提供 typed immutable `runtime` Record：

```text
runtime.agent              Ref<Agent>
runtime.evaluation         Ref<Evaluation>
runtime.context            Ref<Context>
runtime.objective          Option<Ref<Objective>>
runtime.harness            Option<Ref<HarnessBinding>>
runtime.capabilities       Ref<CapabilitySet>
runtime.principal          Option<Ref<Principal>>
runtime.execution_target   Option<Ref<ExecutionTarget>>
```

例如 `$runtime.context`。快照身份绑定 Evaluation，读取为纯操作；获取更新或扩张的 Host View
是显式 Host Effect。

## 5. 不可变 View

```lisp
(host.view REF (returns TYPE))
```

Effect 为 `(host view.KIND)`。Runtime 校验 Type 是否为该 Ref Kind 允许的投影，以及 Principal
是否可见。初始投影包括 Objective、Evaluation、Context、Evidence、Outcome、HarnessBinding、
CapabilitySet、Principal 与 ExecutionTarget 的语义摘要，不包含存储、Secret 与 Scheduler
内部状态。

## 6. Evidence 与 Outcome

纯构造候选值：

```lisp
(evidence (kind "test-result") (value EXPR) (refs REF...))
(outcome (status succeeded) (value EXPR) (evidence REF...))
```

显式持久化：

```lisp
(evidence.commit CANDIDATE)
(outcome.commit CANDIDATE)
```

Effect 分别为 `(host evidence.commit)` 与 `(host outcome.commit)`。Runtime 校验 Route、Authority、
Evidence Identity、Completion Contract 与不可变 Event，返回 `Ref<Evidence>`/`Ref<Outcome>`。

Candidate Type 是封闭的 Runtime Value。源码只能通过 `evidence`/`outcome` 构造，不能用
`decode`、Raw JSON 或伪造 Tag 得到。提交前 Morphz 会重新验证完整 Transport Shape，并确认
每一个 Evidence 引用都来自同一 Context 内由 Runtime 提交的 Event。

## 7. Objective Effect

```lisp
(objective.report (objective REF) (progress EXPR) (evidence REF...))
(objective.propose-wait (objective REF) (condition EXPR) (reason String))
(objective.propose-completion (objective REF) (outcome REF))
```

这些操作提交带类型、Revision-aware 的 Proposal，由 Objective Authority 决定是否 Commit。
程序不能直接设置 Objective Status 或 Revision。

## 8. Context Effect

```lisp
(context.propose TRANSACTION)
```

Effect 为 `(host context.propose)`。当前草案实现接收 `Json`，返回不可变 Proposal Receipt，
不会直接修改 Context/Mind。后续 Structured Context Profile 才会定义 Typed Transaction、
Protected Frame、Conflict Rule、Transaction Budget 与更窄的结果类型。

## 9. Lowering

| Yao | Morphz Authority |
| --- | --- |
| `call` | `ExecutionJob` 或等价的受控 Tool Completion |
| nested `infer` | Child `Evaluation` / `ThreadActivation` |
| `par` | Plan Branch Group 与 Child `PlanExecution` |
| `run` | 绑定 Validated Program Value 的 Child `PlanExecution` |
| `host.*` | Typed Runtime Command 与 Immutable Event/Transaction |
| terminal value | Plan Outcome |

公开 Yao 因果 Schema 使用 Program、Effect、Branch、Outcome、Evidence；内部表名与调度策略
不构成规范。

## 10. Capability

Profile Capability 包括 Tool、`infer`、各类 `host` Effect 及 `(program EFFECT...)`。
创建 `Program<T,E>` 需要接收该 `E` 上界程序的权限；`run` 还要当前拥有每个实际 Child
Effect。CapabilitySetView 不得包含 Secret 或 Provider Credential。

## 11. Resource Profile

| 资源 | 默认硬上限 |
| --- | ---: |
| Source Byte | 256 KiB |
| Syntax Nesting | 128 |
| Semantic Expression Depth | 32 |
| Typed HIR Node | 4,096 |
| Record/Map Field | 256 |
| 串行 `map` Element | 64 |
| Root Program Tool Effect | 128 |
| Nested Inference | 8 |
| 每个 `par` 分支 | 32 |
| 同时调度分支 | 部署配置，至多 32 |
| Program Value Nesting | 4 |

部署可以降低但不能提供无界上限。

## 12. 源码与存储迁移 Profile

Morphz `.hns` Entry、`eval` Function Call 和 Program Value Candidate 必须使用唯一的 Typed
Yao 源码语言，且不得包含 `(version ...)`。Plan IR v1 可保持可解码，直到正式迁移移除；
该 Decoder 仅服务于存储迁移，不得形成 Legacy 源码准入路径。

## 13. 安全要求

Morphz 必须测试 Ref 不可伪造及 Context/Agent 隔离、无法通过 `requires`/`infer`/`par`/
Program Value 扩权、Host View/Diagnostic/Canonical/Provenance 不泄露 Secret、Effect Identity
Fence 与精确父级恢复、Objective/Context Revision、取消传播、旧 Program Authority 拒绝、
执行前 Hash 校验及恶意模型输出的有界解码。

## 14. 实现状态

截至 2026-08-21，参考实现已经包含带 Span Parser、Type/Effect Checked HIR、Pure Evaluator、
精确 Typed Inference Decode、Named Record/Union 与穷尽 `match`、结构化 `par`、带持久 Child
Plan 的 Program Value，以及注入的 `$runtime` Snapshot。生成的 Program Child 不继承调用方
局部绑定，剩余 Program Budget 只转移、不补充。

Morphz 还实现了可安全重放的 Host Receipt、受权 Immutable View、Evidence/Outcome Commit
及 Objective/Context Proposal Record。Host 边界会重新验证 Candidate Transport；Evidence
引用必须是同一 Context 中的 Runtime Commit；Objective Operation 必须携带当前 Objective Ref。
这些 Proposal 目前只记录意图，真正应用 Objective Transition/Context Transaction 仍归既有
Authority 所有，Yao 不会直接执行。ExecutionTarget View 注入、跨全部 Child Plan 的取消传播、
以及更窄的 Typed Context Transaction Profile 仍是草案工作，因此当前实现尚不声明完整
v0.1 Conformance。
