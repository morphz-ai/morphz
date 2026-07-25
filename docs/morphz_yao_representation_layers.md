# 爻语言的表征分层与归属判据

> 状态：已定；用于裁决"某个信息该放在哪一层"这一类问题
> 适用范围：爻程序、eval/infer、context_tx、未来的 define/reads/writes/harness 文件

## 1. 三层表征

Morphz 自 Agent-Owned Context 起就存在三层表征，爻语言只是给第一层定名：

| 层 | 是什么 | 实例 |
| --- | --- | --- |
| **语义介质** | S 表达式，两个求值器（LLM 非确定性 / Runtime 确定性）共享的唯一语言 | Context 视图、`context_tx` 事务、System Prompt（代码强制其为合法 SExpr）、爻程序 |
| **传输信封** | Function Calling / JSON，模型被训练过的送达通道 | `context_tx(transaction: string)`、`eval(program: string)`、`reply(disposition, content)` |
| **强制机制** | Runtime 的边界与保证，不解释语义 | 闸门、审批、版本、预算、Ledger |

## 2. 归属判据

> **凡是程序或心智的语义组成部分，进介质；凡是"这次调用怎么送达"，进信封；凡是边界与强制，进机制。**

## 3. 已决案例

| 决定 | 归属 | 依据 |
| --- | --- | --- |
| `context_tx` 事务装在字符串参数里，不改结构化 JSON | 介质 | v1 设计原文："外层遵循标准工具调用接口，内部参数保留 canonical SExpr" |
| `reply` 的 `disposition` 是 JSON 参数 | 信封 | "这次响应交不交付"是传输语义，不是认知语义 |
| `(yao ...)` 外壳被否决 | — | 名字不是语义，是制品元数据，归文件层（`.yao` 后缀） |
| `(tools NAME...)` 声明在程序文本顶层 | 介质 | 它是效应边界（§reads/writes）的第一个实例，是程序语义的组成部分；且 `.yao` 文件被 Runtime 直接加载时没有旁路通道，制品必须自足 |
| `infer` 的入参即其 reads 视野 | 介质 | 视野由程序声明，Runtime 不替 Agent 投影 |
| 部署级 `eval_callable_tools` 白名单 | 机制 | 边界；程序声明只能收窄它，不能放宽 |

## 4. 程序格式（当前）

一个爻程序 = 可选的顶层 `(tools NAME...)` 声明 + 恰好一个程序体表达式：

```lisp
(tools read search)
(seq
  (bind hits (call search :query "铜印"))
  (bind form (infer :task "铜印现在是什么形态" :evidence $hits))
  $form)
```

关键性质：**`eval` 工具的 `program` 参数与 `.yao` 文件内容是同一种制品**。模型提交的程序可原样存盘，Runtime 加载的文件可原样进 `eval`。

两条准入规则：

1. 声明 ⊆ 部署闸门——程序不能靠"多要"扩权，越权声明在验证期拒绝；
2. 程序体内声明即闸门——未声明的 `call` 被拒（即使部署允许），`infer` 取证时也只被提供声明过的工具。第 2 条是声明存在的核心理由：`call` 可静态收集，但 `infer` 运行期用什么工具静态分析够不着，只有程序自己的声明能约束它。

## 5. 判据对排队问题的预答

| 待决问题 | 答案 |
| --- | --- |
| `define` 过程库 | 介质；`.yao` 文件即过程的持久形态 |
| reads/writes 投影 | 声明进介质、enforce 进机制；`tools` 是其粗粒度起点 |
| validator 挂接 | 机制（`DomainHarness`）；程序引用哪个 validator 可进介质 |
| 第 3 级高阶（模型固化流程） | 模型用 `write` 写 `.yao` 文件，降级为数据、重验证后求值。制品自足是该生长循环闭合的前提——一个依赖旁路 JSON 才完整的制品，模型无法独立创作与播种 |

## 6. 何种证据可推翻

若真实模型评测显示模型频繁写错或遗漏 `(tools ...)` 形式、且验证器的修复反馈无法引导其纠正，可增加 JSON 参数作为便利别名，规则定死为：程序文本内已有声明时拒绝 JSON 参数。在拿到该证据之前不加。
