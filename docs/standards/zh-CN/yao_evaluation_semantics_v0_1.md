# Yao 求值语义 v0.1

> 状态：草案
>
> 维护者：新变元
>
> 规范原文：[English](../yao_evaluation_semantics_v0_1.md)
>
> 最后更新：2026-08-21

## 1. 范围

本规范定义同一种 Yao 语言如何由模型与 Runtime 求值，同时不混淆双方权威，并定义
lowering、悬挂、持久化、恢复、失败、并行 join 与 Program Value 执行语义。

## 2. 两个求值器，一种语言

| 根 | Evaluation Loop 所有者 | 语义角色 |
| --- | --- | --- |
| `eval` | Runtime | 确定性控制、持久 Effect、带类型数据流 |
| `infer` | 模型 | Runtime 权威约束下的开放语义判断 |

两者消费和产生相同 Yao Value。所有权只决定谁选择下一语义步骤，不改变 Value、Effect、
Capability、因果身份和终态 Outcome 的含义。Runtime Control Loop 始终负责准入、能力
结算、物理执行、持久化、恢复、审批、取消、Budget 和交付。

## 3. 编译流水线

```text
UTF-8 source
  -> 带 Span 的具体语法
  -> 已解析名字的 AST
  -> 带类型与推导 Effect 的 HIR
  -> Validated Program
  -> 纯求值器和/或 Runtime Plan IR
```

Effect 恢复边界不得重新解析源码。持久状态记录已校验表示、Machine Continuation、词法
环境、Budget、Pending Causal Identity 和终态。纯表达式只有在保持 Failure、Diagnostic、
Canonical Identity 和 Effect Order 时才能常量折叠。

## 4. 确定性求值顺序

除 `par` 外均从左到右；参数在 Effect 请求前完整求值。确定性 Machine 无 I/O 推进，
直到产生终值、分类失败、Typed Effect Request 或 Structured Branch Group Request。
Machine 不得自行执行 Tool、调用模型、修改 Host Object 或启动未追踪任务。

## 5. Effect 交接

Effect Request 的稳定身份由父 Plan 与单调 Effect Sequence 派生。Runtime 必须原子持久化
父级等待状态与子级权威，或提供崩溃/重放下观察等价的行为。重放等待 Machine 必须产生
相同身份；只有完全匹配的 Pending Identity 与 Effect Kind 才能恢复父级。完全重复的结果
幂等，过期或外来结果必须拒绝。授权在准入与交接时都检查，以后者为准。

## 6. 嵌套 inference

`eval` 内的 `infer` 创建因果相连的模型 Evaluation。请求包含已求值参数、结果契约、证据
工具上界、父 Program 身份与源码 Span。只有终态 Child Outcome 能恢复父级；Runtime
必须将其解码为声明类型。Provider 推理文本、部分输出或未经验证的自我声明不得成为终值。

## 7. 结构化并行

### 7.1 建立分支

Lowering `par` 产生一个持久 Branch Group，以及每个源码分支对应的 Child Continuation。
Group 身份由父 Plan 与 `par` Sequence 派生；分支身份还包括规范化名称。父级等待、Group
与 Child Authority 必须原子创建，或能从单个 Durable Intent 幂等恢复。崩溃不能留下
已经准入却不被 Join 看见的分支。

### 7.2 调度与隔离

分支各自拥有不可变词法快照、Continuation Stack、Budget、Pending Effect 和终态。Runtime
可用任意物理顺序调度并限制并发度。源码顺序只决定结果构造与规范身份，不建立分支间
happens-before。

### 7.3 Join

父级等待全部分支终态；成功结果按源码顺序组装。任一分支失败时，父级收到包含所有分支
名称、状态、失败分类和成功结果引用的 Parallel Failure。父级取消向未终止分支传播；某
分支失败不会抹除已准入同级，也不能假装其外部 Effect 已回滚。

### 7.4 重启等价

任何持久边界后，其他 Worker 必须能重建 Group 并产生相同结果或失败。测试必须在建组前、
部分建组后、Child 等待时、部分 Child 完成后、全部完成但尚未 Join、父级恢复后注入重启。

## 8. Program Value 准入与执行

模型生成的候选 Program 先进入隔离状态，没有执行权威。准入记录规范表示与 Hash、原始
源码与 Span、生成 Evaluation/Attempt/Model Route/Terminal Event、声明与推导的 Output/
Effect Contract、创建时 Capability Ceiling、Validator Version 与诊断。

`run` 创建绑定 Program Value Hash 的持久 Child Plan，重新计算当前 Capability 并与历史
Ceiling 取交集。已经撤销的权威不能由旧 Program Value 恢复。父级等待 Child Plan 终态；
Child 不得访问调用方局部绑定、修改父 Machine 或扩张聚合 Budget，只能继承 Runtime Profile
明确允许的不可变 Host Environment。Morphz v0.1 把剩余聚合 Budget 转移给 Child，Join 后
不返还未使用额度；该保守规则在重启前后保持一致。

## 9. Host Effect 收据

Host Effect 是持久权威边界。Runtime 将结果交回确定性求值前，必须以父 Plan 身份与 Effect
Sequence 为键提交不可变收据，绑定准确 Operation、已求值 Argument、规范化 Typed Result、
Route 与因果身份。若 Worker 在 Host Commit 后、父级 Checkpoint 前崩溃，重放必须返回已存
Result；相同收据身份携带不同 Operation/Argument 属于 Integrity Failure。Proposal 或不可变
对象不得在这种重放中重复提交。

## 10. 失败分类

| 分类 | 示例 | `fallback` 可捕获 |
| --- | --- | --- |
| `value` | 解码失败、除零、字段缺失 | 是 |
| `inference` | typed 结果非法、Provider 终态失败 | 是 |
| `tool` | Tool 声明失败 | 是，受 Tool 策略约束 |
| `parallel` | join 分支失败 | 是 |
| `resource` | 动态集合或子工作超限 | 是，除非威胁完整性 |
| `cancelled` | Principal 或 Supervisor 取消 | 否 |
| `authority` | Capability 撤销、Lease 无效 | 否 |
| `integrity` | Hash 不符、外来 Completion、状态损坏 | 否 |
| `admission` | 执行前语法、类型、Effect、Capability 拒绝 | 不适用 |

Failure 应保留因果身份和可用 Source Span；Runtime 不得把 Integrity 或 Authority Failure
转成普通程序数据。

## 11. Budget

Budget 具有层级。父 Program 为嵌套 inference、并行分支与 Program Value 提供上限；即使
物理并发，Child 工作也消耗父级聚合 Budget。重启恢复最近持久化余额，不能重新充值。
至少计量 Tool、Inference、Branch、Typed IR Step、Program Value Nesting 与 Deadline。

## 12. 可观测性

每个 Effect、Branch、Program Value 准入、SubPlan、恢复、失败与终态 Outcome 必须可追溯
到 Agent/Context、父 Evaluation/Plan、可选 Objective、Source Artifact/Program Hash、
Source Span/Generated Provenance、Principal/Capability Decision 以及稳定因果父级与 Sequence。

## 13. 持久化 IR 迁移

所有新准入源码统一使用 Typed Yao 语义。Runtime 可在有界迁移期内读取已持久化 Legacy
Plan IR，但不得重新解析 Legacy 源码，也不得通过 `eval`、Harness 加载、Program Value 准入
或任何模型路径暴露该读取器。迁移是存储问题，不能形成第二种源码语言。

## 14. 一致性测试矩阵

参考套件必须包含 Golden Parser/Diagnostic/Canonical Fixture、表驱动类型与 Effect 测试、
纯求值属性测试、Mock Tool/Model Failure、所有 Machine Frame 的序列化恢复、SQLite 与
PostgreSQL Crash Window、Parser/Decoder/Canonicalizer/Program Admission Fuzz、Legacy 源码拒绝
与持久化 IR 迁移 Fixture、Resource/Adversarial Output，以及 Worker 替换前后观察等价的 E2E 测试。
