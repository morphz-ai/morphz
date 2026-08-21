# Yao 核心语言规范 v0.1

> 状态：草案
>
> 维护者：新变元
>
> 规范原文：[English](../yao_core_language_specification_v0_1.md)
>
> 最后更新：2026-08-21

## 1. 目的

Yao 是模型与 Runtime 共享的认知求值语言。它让两类求值器使用同一种带类型的表示来
交换数据、判断、程序与 Effect，同时维持严格的权威边界：模型可以提出语义与程序，
只有 Runtime 可以校验、授权、持久化并执行 Effect。

Yao Core 定义与实现无关的语法、值、类型、词法作用域、纯表达式、结构化控制、结构化
并发、Program Value 与 Effect 类型。[Yao 求值语义](yao_evaluation_semantics_v0_1.md)
定义两类求值模式及持久执行规则；[Yao Morphz Runtime Profile](yao_morphz_runtime_profile_v0_1.md)
定义 Runtime 对象与 Effect。

本文中的“必须”“不得”“应当”“不应”和“可以”均为规范性要求。

## 2. 设计性质

符合 Yao Core 的实现必须保持：

1. **求值所有权显式。** 程序根只能是 `eval` 或 `infer`。
2. **非确定性边界带类型。** 每个嵌套推理都声明返回类型。
3. **Effect 可见。** Effect 是可静态发现的上界，不隐藏在纯表达式中。
4. **权威分离。** 声明只能请求或收窄权威，不能授予权威。
5. **结构化并发。** 并行工作具有词法生命周期、稳定分支身份和确定性的 join 值。
6. **程序是经校验的值。** 模型生成的代码只有经过解析、类型/Effect 检查、能力结算、
   规范化与持久化后才能执行。
7. **Core 有界。** Core 不包含无界循环、递归、脱离父级的 spawn、共享可变变量或动态
   算子查找。

## 3. 源码与诊断

Yao 源码使用 UTF-8 和 S 表达式具体语法。实现必须为每个 token 与语法节点保留源码
Span，包含字节偏移以及可读的行列位置。拒绝程序时必须指出主 Span，并应包含稳定诊断
代码和相关 Span。

空白分隔 token；`;` 开始行注释；字符串以双引号包裹，并支持 `\\`、`\"`、`\n`、
`\r`、`\t`。`true`、`false`、`nil` 是保留字面量。整数为十进制；浮点数必须包含小数点
或指数；其他未加引号的原子为符号。

实现必须在语义分析前拒绝无效 UTF-8、未结束字符串、未知转义、括号不匹配、超深嵌套
和多个顶层 Artifact。

## 4. 程序信封

程序恰好包含一个顶层 Artifact：

```lisp
(eval DECLARATION... BODY)
(infer DECLARATION... INFER-ARGUMENT...)
```

`eval` 表示 Runtime 持有 Evaluation Loop；`infer` 表示模型持有 Evaluation Loop，但
Runtime Control Loop 始终由 Runtime 掌握。

声明必须出现在正文前，并可以按顺序包含：

```lisp
(version "0.1")
(requires
  (tools TOOL...)
  (effects EFFECT...)
  (objects OBJECT-KIND...))
(types TYPE-DECLARATION...)
```

Typed v0.1 源码必须以 `(version "0.1")` 作为第一个声明。Morphz 中省略该声明的源码进入
Legacy Compatibility Profile；历史 Tool/Inference 的 Argument Name 可能与新 Core Operator
重名，依据嵌套名称猜测版本会改变已有合法程序的含义。每种声明最多出现一次，未知声明
必须被拒绝。为兼容现有程序，可单独使用 `(requires (tools ...))`。声明的 Tool 是静态
`call` 与嵌套 `infer` 证据工具的闭合上界。

## 5. 类型

### 5.1 内置类型

```text
Nil Bool Int Float String Bytes Json
List<T> Map<T> Record{field: T, ...} Option<T> Result<T, E>
Ref<K> Program<T, E>
```

`Json` 是显式的动态结构边界，而不是绕过静态类型的逃生口。需要更窄类型时必须显式
检查或解码。

`Ref<K>` 是 Host Object 的不透明引用；Core 定义其身份与不可伪造性，Profile 定义具体
对象类型与操作。

`Program<T, E>` 是不可变、已校验的 Program Value：终值可赋给 `T`，静态 Effect 集是
`E` 的子集。

`Record{...}` 是编译器产生的结构化 Record Type，用于 `par` 这类字段名由表达式产生的
结果；用户声明的 Record 仍采用名义类型。

### 5.2 类型语法

```lisp
(List Finding)
(Map String)
(Option (Ref Objective))
(Result Decision Error)
(Program Decision (effects infer (tool read)))
```

### 5.3 命名 Record 与 Union

```lisp
(types
  (record Finding
    (title String)
    (confidence Float))
  (union Decision
    (accept (reason String) (confidence Float))
    (reject (reason String))))
```

类型名、字段名和 Union Variant 名在各自声明中必须唯一。v0.1 不支持递归类型，直接或
间接递归均须拒绝。

匿名集合类型采用结构规则，命名 Record 与 Union 采用名义规则。`Int` 可以赋给
`Float`，不做其他隐式数值扩宽。任何类型都可赋给 `Json`；从 `Json` 到其他类型必须
显式解码。分支表达式必须具有公共结果类型，不能静默退化为 `Json`。

## 6. 值与纯表达式

词法绑定使用 `$name`，字段选择使用 `$name.field`。绑定不可变，同一词法作用域不能覆盖。

值构造器：

```lisp
(list EXPR...)
(dict (KEY EXPR)...)
(record TYPE (FIELD EXPR)...)
(variant TYPE.VARIANT (FIELD EXPR)...)
(some EXPR)
(none TYPE)
(ok EXPR ERROR-TYPE)
(err EXPR OK-TYPE)
```

`none` 显式标注缺席值的元素类型。v0.1 不采用上下文式或双向类型推断，因此 `ok` 还要标注
未取用的错误类型，`err` 则标注未取用的成功类型。这样每个构造器都能独立完成类型判定，
序列化 HIR 也不会产生歧义。

纯算子：

```lisp
(get EXPR FIELD)       (decode TYPE JSON-EXPR)  (is TYPE EXPR)
(eq LEFT RIGHT)        (ne LEFT RIGHT)
(lt LEFT RIGHT)        (le LEFT RIGHT)
(gt LEFT RIGHT)        (ge LEFT RIGHT)
(and EXPR...)           (or EXPR...)             (not EXPR)
(add EXPR...)           (sub LEFT RIGHT)
(mul EXPR...)           (div LEFT RIGHT)
```

`and`、`or` 从左到右短路。数值溢出、除零、解码失败、字段缺失、非法比较均是带 Span 的
分类失败，不能静默强制转换。

Core v0.1 采用 Effect Normal Form：值构造器与纯算子的 Operand、`if` Condition、`match`
Value、`map` Collection、Tool/Host/Inference Argument 以及 `run` Operand 必须是纯表达式。
Effectful Result 需要先通过 `bind` 命名，再以引用使用。这样每个持久 Suspension 都位于
显式控制边界，重启位置不会含糊。

## 7. 绑定与结构化控制

```lisp
(seq STEP...)
(bind NAME EXPR)
(if CONDITION WHEN-TRUE WHEN-FALSE)
(match VALUE CASE...)
(fallback PRIMARY BACKUP)
(map COLLECTION ELEMENT BODY)
```

`seq` 从左到右并返回最后一个值。`bind` 完整求值后加入一个不可变绑定并返回 `nil`。
`if`、`match`、`fallback`、`map` 和 `par` 分支内产生的绑定不会逃逸。`if` 条件必须是
`Bool`；typed v0.1 不提供 truthiness 强制转换。

Union match：

```lisp
(match $decision
  ((case Decision.accept (reason why) (confidence score)) EXPR)
  ((case Decision.reject (reason why)) EXPR))
```

命名 Union 的 match 必须穷尽且不能重复 Variant。Pattern 字段名必须与声明一致，本地绑定
名仅在 Case 正文生效。

`map` 遍历已经物化的有限 List 并保持输入顺序；Profile 必须定义有限元素上限。v0.1 的
`map` 为串行。`fallback` 只在 PRIMARY 产生分类失败后求值 BACKUP，不捕获取消、权威
丢失、准入失败或 Runtime 完整性故障。

## 8. Effect

每个表达式都有结果类型与 Effect 集。Core Effect 原子为：

```lisp
infer
(tool TOOL)
(host OPERATION)
(program EFFECT...)
```

Profile 可以定义额外命名空间 Effect。复合表达式的 Effect 是所有可能执行 Effect 的
并集；即使 `if` 或 `match` 某分支未执行，它仍属于静态上界。

执行前，Runtime 必须确认推导出的 Effect 集包含于部署策略、Principal 权威、Execution
Target 策略、Package 声明、Program 声明及单次操作收窄结果的交集。静态检查通过并不
等于已经授权；每个可能发生策略变化的 Effect 边界必须重新校验。

## 9. Tool 与 inference

```lisp
(call TOOL (ARG EXPR...)...)
```

Tool 名必须静态可知。参数纯求值完成后才持久化 Tool 请求；参数与返回值必须符合 Tool
Schema；Effect 为 `(tool TOOL)`。

```lisp
(infer
  (task EXPR)
  (tools TOOL...)
  (returns TYPE)
  (ARG EXPR...)...)
```

嵌套 typed inference 必须提供 `task` 与 `returns`；`tools` 可选且只能收窄证据工具。
Runtime 必须先解码、校验终值，再允许其进入确定性数据流。失败解码属于 inference 分类
失败。兼容语法 `(returns text)` 等价于 `String`，`(returns json)` 等价于 `Json`。

## 10. 结构化并行

```lisp
(par
  (branch NAME EXPR)
  (branch NAME EXPR)
  ...)
```

`par` 至少包含两个名称唯一的分支。每个分支获得同一个不可变词法环境快照；绑定与中间
值互相隔离。分支名是在 Program Value 内稳定的因果身份，必须贯穿 lowering、持久化、
重启、Trace 与结果构造。

所有分支都必须 join。成功结果是按源码顺序排列字段的 Record。若存在失败，已准入分支
仍须全部终止后，`par` 才成为分类失败；失败记录必须保留所有分支状态和可用成功结果。

Runtime 可以限制物理并发度，但不能在仍有容量时因为早先分支正在等待而人为串行化。
v0.1 不包含 detached execution、race、quorum 或隐式共享状态。

## 11. Program Value

```lisp
(infer
  (task "construct a bounded evaluation plan")
  (returns (Program Decision (effects infer (tool read))))
  (input $request))
```

Program Value 的传输形态是候选 Yao 源码，但候选源码不是普通 `String`，也不得交给字符串
eval。Runtime 构造 `Program<T,E>` 前必须进行带 Span 解析、名字与类型检查、Effect 子集
检查、资源检查、规范化、Hash/Provenance 生成及先持久化后执行。

Program Value 对普通词法绑定必须闭合，不能引用调用方局部值。Runtime Profile 可以向父子
程序注入一个显式类型、不可变的 Host Environment（例如 Morphz `$runtime`）；它属于继承
权威而不是词法捕获。执行只能通过 `(run PROGRAM-EXPR)`：`run` 重新校验当前权威、创建
因果相连的持久 SubPlan、等待终态并返回声明类型。不得在进程内递归执行源码字符串。
Profile 必须限制嵌套深度与聚合 Budget。

## 12. 规范表示与身份

实现必须为已校验的 Typed Representation 提供规范编码；编码不受无意义空白、注释、
Map 插入顺序、源码路径和诊断元数据影响，但必须保留分支顺序、命名类型身份、字面值
身份和所有 Effect 相关区别。

Program Value 身份为规范 UTF-8 编码 SHA-256 的 `sha256:<小写十六进制>`。原始源码与
Span 是 Provenance，不参与身份计算。

## 13. 资源限制

Runtime Profile 必须公布 Source Byte、语法深度、Typed IR 节点、Record 字段、Collection
元素、Tool/Inference Effect、并行分支、Program Value 嵌套和总子工作量的有限上限。
静态超限在准入时拒绝，动态超限产生分类 Resource Failure。

## 14. 兼容性

Morphz 参考实现必须继续接受原 v0 子集：`seq`、`bind`、值引用、`if`、`fallback`、有限
串行 `map`、`call` 及返回 `text/json` 的 `infer`。兼容语法在准入时获得 typed v0.1
语义。历史 truthiness 只存在于显式 legacy profile。

## 15. 一致性要求

Core v0.1 实现必须发布测试，覆盖解析与 Span、规范编码、所有内置类型与算子、名字解析、
不可变性、作用域、穷尽性、类型拒绝、Effect 推导、能力越界、typed inference、`par`
隔离与恢复、Program Value 校验与安全、资源边界及历史 Harness Corpus。每个规范样例在
序列化/重启前后必须得到观察等价结果。
