# Yao 的表征分层与归属判据

> 状态：目标设计已达成共识
> 日期：2026-07-25
> 适用范围：Yao artifact、`eval/infer`、Typed Plan IR、Function Calling、Context Encoding、`.hns` Harness 包
> 详细包与执行设计：[Yao Harness `.hns` 包、显式双求值与 Typed Plan IR v1](morphz_yao_harness_file.md)

## 1. 为什么需要分层

Morphz 同时面对四类不同问题：

1. 人和模型用什么结构表达认知、契约与过程；
2. Runtime 如何在执行前消除歧义并保存执行位置；
3. 模型请求如何通过 Provider 接口送达；
4. 谁负责权限、事务、调度、恢复与现实副作用。

如果把四类问题都塞进 S-Expression，语言会膨胀成 Runtime 配置文件；如果全部塞进 JSON Function Calling，模型可读的过程和认知结构会被传输格式支配。

## 2. 四层表征

| 层 | 定义 | 典型实例 |
| --- | --- | --- |
| **Yao 语义源层** | 人与模型可读写的 S-Expression artifact | `manifest.yao`、`contract.yao`、`mind.yao`、`(eval ...)`、`(infer ...)`、`context_tx` |
| **Typed IR 层** | Runtime 解析、校验后使用的强类型内部表示 | `PlanNode::Call`、`PlanNode::Infer`、程序计数器、bindings |
| **传输信封层** | 一次请求或工具调用如何经过 Provider/API 送达 | Function Calling JSON、HTTP、SSE、Tool Result |
| **Runtime 机制层** | 不依赖模型解释的物理保证 | Ledger、Scheduler、Execution Job、权限、沙箱、预算、MVCC、fencing |

核心路径：

```text
Yao source
  → parse / validate / lower
Typed Plan IR
  → materialize / suspend / resume
Scheduler Kernel
  → Function Calling / Tool I/O / Durable Events
```

Typed IR 不是新的用户语言，也不进入模型 Prompt。它是 Yao 可执行 artifact 的 Runtime 内部形态。

## 3. 归属判据

> 模型需要理解、创作或遵循的领域语义进入 Yao；执行前可以确定的结构进入 Typed IR；这次调用如何送达进入传输信封；不能依赖模型自觉的边界进入 Runtime 机制。

进一步判断：

- 改变一段表达式的任务含义：属于 Yao；
- 改变 Runtime 如何保存和恢复执行位置，但不改变任务含义：属于 IR；
- 改变 OpenAI/Anthropic/Gemini 请求形状：属于传输信封；
- 改变是否获准、是否原子、是否幂等：属于机制。

## 4. Yao artifact 的显式根类型

`.yao` 表示语言，不表示 artifact 的用途。用途由根节点自描述：

```lisp
(manifest ...)
(contract ...)
(mind ...)
(eval ...)
(infer ...)
```

这些根节点分为两类：

### 4.1 声明型 artifact

```text
manifest
contract
mind
```

它们由各自 loader 校验，不进入 Plan Executor。

### 4.2 可求值 artifact

```text
eval
infer
```

它们显式声明求值权：

- `(eval ...)`：Runtime 主导，编译为 Typed Plan IR；
- `(infer ...)`：LLM 主导，创建或进入正式 Evaluation / attempt loop。

未知根节点必须在加载期拒绝，不能采用“不是 `infer` 就默认由 Runtime 执行”的规则。

## 5. 为什么保留 `eval / infer`，但不需要 `(yao ...)`

```lisp
(yao ...)
```

只是在语法内部重复文件语言名称，没有增加任务语义。

而：

```lisp
(eval ...)
(infer ...)
```

定义了：

- 谁持有主控制权；
- 使用哪一种预算包络；
- 在何处建立 Evaluation 或 Plan Execution；
- 如何解释失败、等待和最终结果；
- Runtime 重启时恢复哪一种状态。

因此 `eval/infer` 是必要语义，不能当作可省略包装。

## 6. Program 的能力声明

Harness Manifest 声明包级最大能力；每个程序在显式根内部进一步收窄：

```lisp
(eval
  (requires
    (tools read search))

  (seq
    (bind hits
      (call search
        (query "铜印")))

    (infer
      (task "根据证据判断铜印当前形态")
      (input hits))))
```

Program 声明属于 Yao 语义源层，因为它影响程序允许产生哪些效应，也使独立 artifact 可审计。真正的授权和强制属于 Runtime 机制层。

两条规则：

1. Program requires 必须是 Harness Manifest 能力的子集；
2. 最终能力还要与部署授权、Principal、Execution Target 和当前 Capability Lease 取交集。

程序不能通过声明扩权。

## 7. `context_tx` 与 Yao Program 的关系

二者都采用 S-Expression，但生命周期不同：

- `context_tx` 是一次版本化 Mind 事务的 canonical DSL；
- Yao Program 是可以编译为 Plan IR、暂停并恢复的求值 artifact；
- `context_tx` 通过标准 Function Calling 信封提交；
- Plan 中如需修改 Mind，仍调用受 Runtime 管理的 `context_tx` 能力，不能直接改内存状态。

共享 S-Expression 让模型只需学习一套结构先验，但不能因此把所有 DSL 强行合并为同一组算子。

## 8. `.hns` 与 `.yao`

```text
coding.hns                       单文件 Harness package
  (manifest ...)                 ┐
  (contract ...)                 ├─ 多个顶层 Yao artifact
  (mind ...)                     │
  (eval ...)                     ┘

coding.hns/                      目录 Harness package
├── manifest.yao                (manifest ...)
├── contract.yao                (contract ...)
├── mind.yao                    (mind ...)
└── programs/main.yao           (eval ...)
```

- `.hns` 始终是包边界，可以是单文件或目录；
- `.yao` 是目录包内部的源文件后缀；
- 两种物理形态必须归一化为相同的 `HarnessPackage`；
- 包元数据不需要通过一个通用 `(yao ...)` 根表达；
- 每类 artifact 使用自己的语义根和 loader。

## 9. 实现的一致性要求

同一个 canonical operator schema 应生成或约束：

- Parser 接受的算子与参数形状；
- Validator 的类型、作用域和 capability 规则；
- Typed Plan IR lowering；
- Context Encoding 中给模型的自然语言算子说明；
- 测试夹具和错误消息。

不能只比较 `seq/call/bind` 等表面拼写，就宣称 Runtime 与 LLM 使用同一语言。如果参数、引用、失败或结果语义不同，它们仍然是两个方言。

## 10. Python 等实现语言的归属

Python、Rust、JavaScript 适合实现：

- 物理工具；
- Validator；
- Projection Adapter；
- 数据处理；
- 外部系统适配。

它们通过 Execution Job 受 Runtime 管理。第一版不把 Python 作为核心求值语言，因为任意 Python：

- 能力面过大；
- 难以静态收窄效应；
- 调用栈难以持久化；
- 恢复时容易重复副作用；
- 不适合同时承担 Contract、Mind 和 Plan 的统一语义表征。

如果未来支持 Python authoring frontend，也应先解析其受限子集，再 lowering 到相同 Typed Plan IR，而不是直接 `exec` Python 控制 Agent。

## 11. 可推翻与可演化部分

以下内容可以由真实评测推动演化：

- 具体算子集合；
- 类型系统严格程度；
- Program `requires` 的书写方式；
- Harness 自动选择策略；
- 是否提供 Python/图形化 authoring frontend。

以下边界不应因语法便利而取消：

- 显式 `eval/infer` 求值权；
- 可执行源在产生副作用前进入强类型 IR；
- 物理工具必须经过 Scheduler Kernel；
- Harness 只能收窄权限；
- 默认领域认知与 Agent 持久 Mind 分离；
- 可恢复执行不能依赖整轮重跑。
