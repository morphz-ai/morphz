# Yao Harness `.hns` 包、显式双求值与 Typed Plan IR v1

> 状态：显式根、Typed Plan IR、`.hns` v1 Loader、持久 `PlanExecution` 与
> `call → Execution Job`、`infer → child Activation` 原子交接、终态结果
> 回填、重启扫描、正式 `eval → Orchestrator → Scheduler Kernel` 驱动，
> 版本化 Registry、持久包目录、Evaluation Scope Binding、Objective 可选
> 默认值、只读认知挂载、模型按需发现及绑定入口自动分派已实现
> 日期：2026-07-26
> 前置：[Domain Harness 架构](morphz_domain_harness_architecture_v1.md)、[Yao 表征分层](morphz_yao_representation_layers.md)、[Scheduler Kernel](morphz_scheduler_kernel_and_domain_model_v1.md)
> 适用范围：Yao 源语言、Harness 包、`eval/infer`、Typed Plan IR、Objective / Evaluation / Execution Job 的映射

## 1. 核心结论

Morphz 使用 **Yao** 作为模型与 Runtime 共享的语义源语言，语法采用 S-Expression；使用 **Typed Plan IR** 作为 Runtime 内部经过验证、可以持久化和恢复的执行表示；使用现有 **Scheduler Kernel** 承载所有实际求值、工具副作用、等待、审批和恢复。

三者不能混为一层：

```text
Yao / S-Expression
  人与模型可读写，表达领域契约、认知和求值结构
        │ parse + validate + lower
        ▼
Typed Plan IR
  Runtime 内部强类型执行计划，记录节点、引用和效应边界
        │ materialize + suspend + resume
        ▼
Scheduler Kernel
  Objective · Evaluation · Activation · Execution Job
  Permission · Sandbox · Timer · Event History · Recovery · Fencing
```

Yao 中必须显式保留两种求值入口：

```lisp
(eval ...)   ; Runtime 持有主控制权
(infer ...)  ; LLM 持有主控制权
```

不采用“根节点是 `infer` 才由 LLM 求值，其他任何根节点都默认由 Runtime 求值”的隐式规则。`eval` 和 `infer` 不是装饰性外壳，而是求值权、失败边界、预算和恢复语义的一部分。

## 2. `.hns` 是包，`.yao` 是包内源文件

Harness 的分发单元统一使用 `.hns` 后缀，但允许两种物理形态。

### 2.1 单文件包

紧凑、内置或容易分发的 Harness 可以是一个文件：

```text
coding.hns
```

文件包含多个顶层 Yao artifact：

```lisp
(manifest
  (id coding)
  (version "1.0.0")
  (title "Coding Harness")
  (capabilities
    (tools read write edit exec search)))

(contract
  (identity
    "这是面向软件仓库开发、修改和验证的领域运行环境。"))

(mind
  (frame
    (id coding/evidence-reuse)
    (body
      "复用测试证据前，应比较它绑定的工作区版本与当前相关文件变化。")))

(eval
  (requires
    (tools read edit exec))
  (seq
    (bind repository (call inspect-repository))
    (infer
      (task "根据仓库证据制定修改方案")
      (input repository))))
```

单文件 v1 的基数规则：

- 恰好一个 `(manifest ...)`；
- 恰好一个 `(contract ...)`；
- 至多一个 `(mind ...)`；
- 恰好一个 `(eval ...)` 或 `(infer ...)`；
- 未知顶层 artifact 在加载期拒绝，不能静默忽略。

后续语言版本计划允许零到多个 `(process ...)` 顶层 artifact，作为包内可复用
的有限过程；当前 Loader 尚未接受该语法，不能把下文的目标设计误认为已实现
能力。

这非常适合内置 Coding Harness：源码可以通过 `include_str!("coding.hns")`
编进单一二进制，安装与版本校验仍走同一个加载器。

### 2.2 目录包

资源较多的 Harness 使用同后缀的目录：

```text
coding.hns/
├── manifest.yao
├── contract.yao
├── mind.yao
├── programs/
│   ├── main.yao
│   └── review.yao
├── processes/          # 目标设计；当前 Loader 尚未实现
├── skills/
├── validators/
└── migrations/
```

命名含义：

- `.hns`：Harness package，表示一个可以安装、校验、挂载和版本化的领域运行套件；
- `.yao`：目录包内部采用 Yao/S-Expression 编写的结构化源文件；
- 单文件与目录只是两种封装方式，不是两种 Harness 语义。

目录包中的 `manifest.yao`、`contract.yao`、`mind.yao` 和
`programs/*.yao` 分别使用与单文件完全相同的 `(manifest ...)`、
`(contract ...)`、`(mind ...)`、`(eval ...)` / `(infer ...)` 根。

Loader 必须把两种形态归一化为同一个 `HarnessPackage`：

```text
coding.hns file ─────┐
                     ├─ parse + validate ─→ HarnessPackage
coding.hns directory ┘
```

后续 Contract 挂载、Plan lowering、能力求交和 Scheduler 执行只面向
`HarnessPackage`，不能在下游继续区分它来自文件还是目录。

## 3. 包内文件的职责

### 3.1 `manifest.yao`：Runtime 的加载清单

Manifest 面向 Runtime、包管理和部署，不作为完整 Prompt 注入模型。

```lisp
(manifest
  (id coding)
  (version "1.0.0")
  (title "Coding Harness")

  (requires
    (runtime ">=0.1")
    (protocol "morphz-harness-v1"))

  (artifacts
    (contract "contract.yao")
    (mind "mind.yao"))

  (entry "programs/main.yao")

  (capabilities
    (tools read write edit exec search)
    (skills rust debugging testing git)))
```

Manifest 声明：

- Harness 的稳定 ID、版本和标题；
- Runtime / Harness 协议兼容范围；
- Contract、Mind 和默认入口的位置；
- 包级最大工具能力和可发现 Skill；
- 后续需要的 validator、migration、签名和依赖。

Manifest 不能授予权限。有效能力始终取交集：

```text
Runtime / Deployment 已授权能力
∩ Harness Manifest 声明能力
∩ Program 本地 requires 声明
∩ 当前 Principal / Evaluation 的 Capability Lease
```

### 3.2 `contract.yao`：模型可见的稳定领域契约

Contract 描述领域中不能由模型随意重新解释的对象、证据和能力语义。

```lisp
(contract
  (version "1.0.0")

  (identity
    "这是面向软件仓库开发、修改和验证的领域运行环境。")

  (object file
    "文件是具有路径、内容摘要和工作区版本的现实资源。")

  (evidence test-result
    "测试结果只证明指定命令在指定工作区版本上的执行结果；
     后续文件变化可能使它失效。")

  (capability edit
    "修改文件内容。修改成功不等于实现正确，仍需实际验证。")

  (discipline
    "先获得与决策相称的证据；不得把计划、推断或未完成操作描述为已经发生。"))
```

Contract 的紧凑稳定部分进入 Context Encoding 的稳定前缀，以利用 Prefix Cache。详细操作过程不应全部塞进 Contract，而应放入按需加载的 Skill。

### 3.3 `mind.yao`：挂载的默认领域认知

```lisp
(mind
  (frame
    (id coding/evidence-reuse)
    (body
      "复用测试证据前，应比较它绑定的工作区版本与当前相关文件变化。"))))
```

这些 Frame 是 Harness 发布者提供的默认认识纪律，不是 Runtime 物理真理。

第一版的正确语义是 **挂载**，不是安装时直接 seed 进 Agent 的共享 Mind：

- 挂载期间作为当前 Evaluation 可见的只读默认 Frame；
- 卸载 Harness 后不再自动激活；
- 不因同名 Frame 覆盖 Agent 已有认知；
- Agent 可以在实践后通过正常 `context_tx` 派生自己的持久 Frame；
- 持久 Frame 必须记录 Harness ID、版本、来源证据和适用范围。

如果用户明确执行“导入到共享 Mind”，那是独立、可审计的 import 操作，不是安装 Harness 的隐式副作用。

### 3.4 `programs/*.yao`：可求值程序

程序必须以显式的 `eval` 或 `infer` 为唯一根节点。目录包中的程序 ID
由 Manifest entry 和相对路径确定；单文件包 v1 只有一个入口程序，其
归一化 ID 为 `main`。每个程序可以进一步收窄包级能力：

```lisp
(eval
  (requires
    (tools read edit exec))

  (seq
    (bind repository
      (call inspect-repository))

    (bind plan
      (infer
        (task "根据仓库证据制定修改方案")
        (tools)
        (returns json)
        (input repository)))

    (call apply-plan
      (plan plan))

    (fallback
      (call run-tests)
      (infer
        (task "根据失败证据诊断下一步")
        (input repository))))))
```

这里同时存在两种求值：

- 最外层 `eval` 确定 Runtime 持有程序控制权；
- `seq`、`bind`、引用解析和分支选择由 Runtime 确定性求值；
- `call` 物化为正式 Execution Job；
- 内层 `infer` 物化为子 Evaluation，交给 LLM 做非确定性求值；
- 子 Evaluation 交付结果后，Runtime 从原节点继续。

内部 `infer` 可以显式声明自己的结果和工具边界：

```lisp
(infer
  (task "根据显式证据生成编辑参数")
  (tools)
  (returns json)
  (evidence repository))
```

- 不写 `(tools ...)`：继承程序根部 `(requires (tools ...))` 的范围；
- `(tools)`：纯模型计算，只能使用传入值；
- `(tools read search)`：只允许列出的证据工具，并且仍须是外层能力的子集；
- `(returns text)`：返回普通文本值，也是默认行为；
- `(returns json)`：Runtime 严格解析一个 JSON 值，不剥离 Markdown fence、不修复
  近似 JSON；失败作为分类错误进入 Plan，而不是猜测后继续产生副作用。

这使 Coding Harness 可以让 Runtime 固定取证和验证顺序，同时把真正需要语言
理解的局部决策交给模型，而不会让 child infer 绕过程序自行编辑或执行命令。

模型主导型入口可以写成：

```lisp
(infer
  (requires
    (tools read write search))

  (task
    "自主完成当前写作目标；根据证据决定拆分、工具调用和交付方式。"))
```

它挂载 Harness Contract 和 Mind 后进入现有 Agent attempt loop。工具调用仍由 Runtime 调度，不因为 LLM 持有主控制权而绕过 Kernel。

### 3.5 `process`：计划中的包内模块复用

当前 `call` 只能指向 Runtime 已注册 Tool。前文的 `inspect-repository`、
`apply-plan` 和 `run-tests` 如果没有对应 Tool，只是概念示例，并不是当前 Yao
自动提供的函数。长期来看，所有组合逻辑都必须写成 Rust Tool 会让 Harness
退化成工具配置，因此 `.hns` 还需要包内命名过程。

目标语法采用已有的 `process` 概念，而不增加另一套 `fn/def` 方言：

```lisp
(process apply-plan
  (description
    "按照已经形成的修改计划逐项修改文件。")

  (params plan)

  (body
    (map plan.changes change
      (call edit
        (path change.path)
        (content change.content)))))
```

入口仍使用统一的 `call`：

```lisp
(eval
  (seq
    (bind repository
      (call inspect-repository))

    (bind decision
      (infer
        (task "制定本轮修改方案")
        (input repository)))

    (call apply-plan
      (plan decision))))
```

编译期必须把同一种表面语法静态解析为不同 IR，而不是到执行时猜测：

```text
call apply-plan  → package-local Process → SubPlan / 静态展开
call edit        → Runtime Tool          → Execution Job
```

第一版 Process 应冻结以下边界：

- Process 与 Runtime Tool 不得同名；每个 `call` 在加载期完成符号解析；
- 参数和局部绑定不可变，最后一个表达式是返回值；
- Process 可以组合 `seq/bind/if/fallback/map/call/infer`，但不能绕过 Tool
  的权限、沙箱、租约和 Execution Job；
- 禁止递归和循环调用，构建静态无环调用图；
- 限制调用深度、展开节点数、参数大小和静态能力集合；
- Process 只提供模块复用，不成为第二套调度器，也不引入通用循环。

单文件包未来可以直接包含多个 Process；目录包可使用 `processes/*.yao`。两种
形态仍归一化为同一个 HarnessPackage 和同一张静态调用图。

### 3.6 `skills/` 与 `validators/`

- `skills/` 保存按需发现的详细领域知识和操作说明；它们不在每轮全量注入；
- `validators/` 提供真实的外部校验入口，例如编译、测试、渲染检查或业务规则验证；
- validator 可以使用 Rust、Python、JavaScript 或任意受支持实现语言，但必须作为 Runtime 管理的能力运行；
- Harness 不能把 validator 的声明伪装成已经发生的验证结果。

## 4. 为什么显式保留 `eval / infer`

`eval` 与 `infer` 表达的是求值权，不是文件类型标签。

错误的隐式规则：

```text
根是 infer  → LLM
其他根节点 → Runtime
```

会让一次无害重构改变语义：

```lisp
(infer ...)
```

由 LLM 驱动，而：

```lisp
(seq
  (infer ...))
```

会突然变成 Runtime 驱动。读者无法只看局部结构可靠判断预算、失败和恢复边界。

显式规则只有两个：

```text
(eval BODY...)   → Runtime-owned Plan Execution
(infer BODY...)  → LLM-owned Evaluation / attempt loop
```

未知根节点在加载期拒绝，不能默认为某个求值器。

`eval` 也不同于通用 `(yao ...)` 外壳：`yao` 只重复文件语言名称，没有执行语义；`eval` 明确规定谁持有控制权以及怎样暂停、恢复和产生副作用。

## 5. Typed Plan IR 是什么

Typed Plan IR（强类型计划中间表示）是 Yao 可执行程序经过解析和校验后，供 Runtime 使用的内部结构。模型和 Harness 作者通常不直接编写它。

源程序：

```lisp
(eval
  (seq
    (bind repo (call inspect-repository))
    (infer
      (task "分析仓库")
      (input repo))))
```

概念上的 IR：

```text
Plan::Eval
└── Seq
    ├── Bind
    │   ├── name = repo
    │   └── Call(tool = inspect-repository)
    └── Infer
        ├── task = "分析仓库"
        └── input = Ref(repo)
```

Rust 实现可以采用可序列化枚举：

```rust
enum PlanNode {
    Seq(Vec<PlanNode>),
    Bind { name: Symbol, value: Box<PlanNode> },
    Call { tool: ToolId, arguments: ValueExpr },
    Infer { task: ValueExpr, input: Option<ValueExpr> },
    If { condition: ValueExpr, then_node: Box<PlanNode>, else_node: Box<PlanNode> },
    Fallback(Vec<PlanNode>),
    Value(ValueExpr),
}
```

实际 v1 的 `Infer` 还携带可选的 per-node tool scope 与
`InferResultKind::{Text, Json}`；它们进入可序列化 IR，因此进程内执行与重启恢复
使用完全相同的边界规则。

第一版不需要建设复杂编译器。“SExpr Parser → 严格校验 → Rust 枚举”已经构成 Typed Plan IR。

### 5.1 为什么不能直接解释字符串 AST

IR 在任何副作用发生前完成：

- 算子与参数形状检查；
- 引用作用域和单次绑定检查；
- 工具存在性和 capability 交集检查；
- 可序列化类型检查；
- 最大节点、深度、预算和静态资源限制；
- 程序版本与 artifact hash 固定。

Runtime 不应执行到一半才发现后续节点语法非法。

### 5.2 IR 与源文件的边界

- Yao 是稳定、可读、可交换的源语言；
- IR 是 Runtime 版本化的内部执行表示；
- 同一种 Yao 语法未来可以 lowering 到升级后的 IR；
- IR 升级不能悄悄改变已经运行中的 Plan Execution；
- Event History 应记录源 artifact hash、IR schema version 和 Harness binding，保证审计可追溯。

## 6. 持久化 Plan Execution

真正可恢复的不是源程序字符串，而是“IR + 当前执行状态”：

```text
PlanExecution
├── id
├── context_id / session_id
├── objective_id / evaluation_id / activation_id
├── harness_id / harness_version
├── source_artifact_hash / ir_schema_version
├── program_counter
├── bindings → Value 或 Observation Reference
├── pending_children → Evaluation / Action Group / Execution Job
├── completed_effects → 幂等与恢复依据
├── budget
├── revision / fencing_token
└── status
```

其中：

- `program_counter` 指向下一待求值节点；
- 大型工具结果不复制进 bindings，只保存稳定 Observation 引用；
- `pending_children` 记录当前等待的物理事实；
- `completed_effects` 防止恢复时重复产生不可逆副作用；
- `revision / fencing_token` 阻止过期执行者继续推进。

## 7. IR 到 Scheduler Kernel 的映射

Harness 不拥有第二套调度器。Plan Executor 只把 IR 节点物化到已有 Kernel：

| Yao / IR 节点 | Runtime 行为 |
| --- | --- |
| `seq` | 在当前 Plan Execution 中顺序推进纯控制节点 |
| `bind` | 保存值或 Observation 引用 |
| `if` | 根据已求值得到的值只选择一个分支 |
| `fallback` | 当前分支产生已分类失败后选择下一分支 |
| `call` | 创建 Execution Job；多个并行调用可创建 Action Group |
| `infer` | 创建子 Evaluation / Activation |
| `wait`（未来） | 注册 Runtime Timer 或精确事件条件 |
| `reply / deliver`（若进入语言） | 创建 Delivery，不直接写 UI |

每次遇到有外部效应或等待的节点：

```text
验证当前 fence
→ 原子持久化子工作与 PlanExecution 等待状态
→ 释放执行权
→ 子结果作为 Durable Event / Observation 到达
→ 重新 claim PlanExecution
→ 验证结果 route 与 fence
→ 写入 binding
→ 推进下一节点
```

因此现有 Objective、Evaluation、Action Group、Execution Job、Permission、Timer 和 Delivery 都继续生效。

## 8. `infer` 的两种预算包络

算子语义相同，都是“交给非确定性求值器”，但所处边界不同：

| 位置 | 主控制权 | 预算与结果 |
| --- | --- | --- |
| 顶层 `(infer ...)` | LLM | 完整 Objective attempt loop，可调用获准工具，最终产生 Delivery、等待或显式状态变化 |
| `(eval ...)` 内部的 `infer` | Runtime Plan | 子 Evaluation；输入由程序显式给出，结果必须作为可绑定值或分类错误返回 |

内部 `infer` 不应只是一次本地 `role=user` completion，也不能复用父 attempt ID。它需要正式的子 Evaluation 身份、因果 route、持久历史、预算和交付事件。

当前实现把这个语义映射为现有 Scheduler Kernel 的
`infer_request Event → Signal Outbox → Execution Thread → child Activation`：

- infer request Event、Signal Outbox 与父 `PlanExecution` 的
  `waiting(evaluation, activation_id)` 在同一个数据库事务提交；
- Thread / Activation 仍由通用 Scheduler 路由器物化，不建立 Harness
  私有调度队列；
- 子 Activation 的终态结果写成不可变 `plan/infer_result` Event，不进入
  用户 Delivery；
- 父 Plan 根据稳定 Activation ID、Thread executor route 与结果 Event
  回填确切的 `infer` effect；崩溃后可通过有界扫描继续。

### 8.1 开放式语义循环属于 Objective

Yao `eval` 描述一次 Evaluation 内有限、可验证、可恢复的求值结构；它不负责
表达“持续工作直到语义目标完成”的未知次数循环。长期推进由现有 Objective
Supervisor 承担：每轮 Evaluation 在 Harness 纪律下产生真实进展和新证据，
Objective 未完成时再创建后续 Evaluation。

```text
Objective：完成整部小说并通过连续性检查
  ├── Evaluation 1 + Writing Harness：规划、创作、校验
  ├── Evaluation 2 + Writing Harness：根据缺陷修订
  └── ……直到模型基于证据提交完成，或进入等待 / 受阻状态
```

因此冻结以下语言纪律：

- 不向 Yao `eval` 加入通用 `while/until` 或无限递归；
- 已知集合的有限迭代使用 `map`；
- 未知次数、需要重新理解最新状态的语义推进使用 Objective；
- 只有真实评测证明局部机械重试产生显著额外模型成本时，才考虑语义极窄且
  明确有界的 `retry`，不能借此重新引入通用循环。

未来若需要显式并行，候选规范写法是与 `seq` 对称的 `(par ...)`，并 lowering
为 Scheduler Kernel 已有 Action Group。`par` 只是确定性计划的并发表达，不
建立新的并发系统；在真实 Harness 证明需要前不加入 v1，也不同时提供
`par/parallel` 两种别名。
- 父 Plan 等待整个 infer Thread 的终态结果，而不是把某个中间 Activation 的
  reasoning 或 continuation 错当成交付；terminal result 才能解除等待。

是否限制内部 `infer` 的轮数属于 Profile / Budget 策略，不写死为一个很小的语言常量。正常推理可以持续；Runtime 只保留安全级 hard limit、停滞观测和可人工干预能力。

## 9. 安全、权限与副作用纪律

### 9.1 `call` 不能直接执行物理工具

Plan Executor 遇到 `call` 时禁止直接调用 `tool.execute()`。物理调用必须走：

```text
Tool selection
→ Execution Job / Action Group
→ Target resolution
→ Permission / approval
→ Sandbox
→ Durable result
→ Plan resume
```

否则会绕过 Edge Target、审批、重启恢复、fencing、因果审计和批次语义。

### 9.2 Capability 只能逐层收窄

Manifest 和 Program 声明的是需求及局部边界，不是授权。Harness：

- 可以隐藏不需要的工具；
- 可以要求 validator；
- 可以添加领域校验；
- 不能越过 Runtime、Principal、Execution Target 或 Sandbox 的拒绝。

### 9.3 不采用整轮重跑作为恢复

程序可能已经执行多个物理副作用。崩溃后从头重跑会重复写文件、发消息、调用外部 API 或创建资源。

正确恢复依赖：

- 每个效应节点拥有稳定 node/effect ID；
- 子 Execution Job 幂等写入；
- PlanExecution 在效应创建与等待状态之间原子提交；
- 恢复时重连已有子工作或消费已有结果；
- 只有明确声明为可重试且满足幂等条件的节点才重新执行。

## 10. 包的加载与使用流程

目标流程：

```text
发现 / 安装 coding.hns
→ 识别单文件或目录形态
→ 解析 manifest / contract / mind / programs artifact
→ 归一化为 HarnessPackage
→ 校验包结构、版本、签名和依赖
→ 校验显式 eval/infer 根节点
→ 将 eval 程序 lowering 为 Typed Plan IR
→ 注册 Harness descriptor 与 artifact hashes
→ 为 Evaluation 建立精确 HarnessBinding（Objective 只可提供默认值）
→ 挂载紧凑 Contract、默认 Frame 和 Skill Index
→ 按入口创建 PlanExecution 或 LLM Evaluation
```

上层产品语义可以是：

```text
用户显式选择 Harness
Agent 通过紧凑索引为当前 Evaluation 选择 Harness
服务端按产品策略固定 Harness
```

当前已经提供最小的原子启动入口：

```bash
morphz harness install ./coding.hns
morphz harness list
morphz harness show coding@1.0.0
morphz --harness=coding@1.0.0 "修复当前项目的测试"
morphz objective create --harness=coding@1.0.0 "修复当前项目的测试"
```

`ID@VERSION` 必须精确指定，不存在隐式 `latest`。CLI 通过正式 Rust SDK
安装、列举和精确读取 Harness。普通消息把精确选择写入不可变根 Event，并在
首次模型请求前物化为 Evaluation Binding；`objective create` 则把 Objective
可选默认值与新 Objective 原子创建。单文件与目录 `.hns` 使用同一个 Loader 和
Registry。

## 11. 挂载、卸载和学习

- Harness 的权威绑定属于 Evaluation，而不是永久绑定 Agent 或 Session；
- Objective 只保存可选默认值，具体推进前必须物化自己的 Evaluation Binding；
- 第一阶段一次 Evaluation 只允许一个 Primary Harness；
- 普通对话 Evaluation 不需要为了使用 Coding Harness 先创建 Objective；
- 用户显式选择与模型 `harness_select` 都精确固定版本，不存在隐式 `latest`；
- 同一 Context 中不同 Evaluation 可以并发挂载不同 Harness；
- 卸载不删除 Agent 在真实工作中形成的持久 Frame；
- 持久 Frame 仍由 Agent 自己通过 `context_tx` 维护；
- 从 Harness 默认 Frame 派生的内容应保留 `harness:<id>@<version>` provenance；
- Harness 升级不能自动覆盖 Agent 已经形成的认识。

未来的 Auxiliary Harness 组合必须先解决契约冲突、工具同名、Frame 优先级、Projection 归属和 Token 预算，第一版不开放任意组合。

## 12. 当前实现与目标设计的边界

`sexpr-eval-tree` 当前实现已经收敛的资产：

- SExpr 解析与多表达式读取；
- 显式 `eval/infer` 根与求值所有权；
- 可序列化的最小 Typed Plan IR；
- `.hns` 单文件 / 目录统一 Loader；
- Manifest 能力上界与 Program `requires` 收窄校验；
- `seq/call/fallback/bind/if/map/infer` 的原型语义；
- 引用作用域、单次绑定和部分静态验证；
- SExpr 到 JSON 的值转换；
- 基础算子的自描述元数据；
- 真实模型 Yao 表面评测脚手架；
- 正式 `eval` 工具在静态校验后建立稳定 `PlanExecution`；
- `call` 复用现有 Execution Job、Target、审批、沙箱与结果事件链；
- `infer` 建立正式 child Activation，终态结果回填后继续 Plan；
- 内部 `infer` 支持 `(returns text|json)` 与 per-node `(tools ...)` 收窄；空
  `(tools)` 可建立不具备任何物理工具的纯推断边界；
- 严格 JSON 解码失败在重启恢复后仍然失败关闭，后续物理 effect 不会被创建；
- Planner 失败会终结 Plan，不再遗留无法恢复的 `running` 状态；
- Runtime 集成测试已覆盖 `eval → read Execution Job → Plan 成功 → 最终回复`；
- 规范化 package hash 不受单文件/目录形态及无意义空白影响；
- Registry 以 `(harness_id, version)` 精确寻址，不存在隐式 `latest`，也不允许
  同版本内容被静默覆盖；
- `.hns` 规范源码、Objective 默认 Binding 与 Evaluation 精确 Binding 已持久化到 Event History，
  并能在 SQLite 重启后恢复；
- 绑定后的 Evaluation 在 Context Encoding 中得到只读 Contract、默认 Mind、
  capability 与精确 package hash；不会把默认 Mind 隐式写入共享认知；
- 绑定 Evaluation 内由 `eval` 创建的 Plan 会携带精确
  `harness_id/version/artifact_hash` provenance；
- Binding 中的顶层 `(eval ...)` 会由 Runtime 自动、且每个精确
  Evaluation 只分派一次；它复用正式 `EvalTool → PlanExecution → Scheduler
  Kernel` 路径，不存在第二套入口执行器；
- Binding 中的顶层 `(infer ...)` 会作为明确的 model-owned 主动入口挂载进当前
  Evaluation；Context Encoding 同时给出精确源码和自然语言求值责任；
- 自动入口使用由 Evaluation 和 package hash 派生的稳定调用身份，
  终态 Plan 不会在 continuation 或恢复后重复执行；
- Runtime 集成测试覆盖
  `Objective 默认值 → Evaluation Binding → 自动 eval → read Execution Job → Plan 结果回填
  → objective_update → 最终交付`。
- `ObjectiveStore::create_objective_with_events` 在 SQLite 与 PostgreSQL 中把
  Objective 行和不可变初始化事件放进同一个数据库事务；Harness Binding
  因而先于任何可领取 Evaluation 成为可见事实；
- SDK、HTTP `POST /api/objectives` 与 CLI
  `objective create --harness=ID@VERSION` 复用同一个 principal-aware
  创建接口；不会由各入口分别执行“先建目标、后补 Binding”。
- SDK/HTTP 普通消息和 CLI 根提示、`exec`、`resume` 支持精确 Harness；Runtime
  在首次 Provider 请求前物化 Evaluation Binding。模型侧提供紧凑
  `harness_list / harness_select`，完整 Catalog 不占据每轮 Context Encoding；
- Runtime 集成测试覆盖普通消息显式选择、模型自主选择、successor Activation
  共享同一 Evaluation Binding，以及 Runtime-owned `eval` 入口只执行一次；
- Rust SDK 已提供 `install_harness_package`、`list_harnesses`、
  `get_harness` 和 `evaluation_harness_binding`；后者读取某次 Evaluation
  实际采用的权威绑定，不会把 Objective 默认值伪装成已求值事实。CLI
  `harness install/list/show` 只负责参数与展示，不建立第二套 Registry 路径。
- model-owned 顶层 `(infer ...)` 的 `requires` 按普通 Function Calling
  工具面校验；Runtime-owned 顶层 `(eval ...)` 仍按独立
  `eval_callable_tools` 安全白名单校验。两者都只能收窄能力，不能扩大沙箱、
  审批、阶段或租约权限。
- 外部单文件 [`coding.hns`](../morphz-evals/harnesses/coding.hns) 已通过正式
  CLI 安装、Objective 绑定和真实模型执行；对应严格 A/B 评测入口为
  `coding_harness_eval`。

历史原型与当前正式路径的对应关系：

| 历史原型 | 当前正式路径 |
| --- | --- |
| `eval` 是 `LogicalInline`，内部直接 `tool.execute()` | `EvalTool` 只负责校验和进入 Plan；`call` 创建 Execution Job |
| 内部 `infer` 直接发本地 completion | 创建正式、可持久化的 child Activation |
| 根是 `infer`，其余默认 Runtime | 已改为只接受显式 `(eval ...)` 或 `(infer ...)` |
| 依靠物理文件位置猜测 artifact 职责 | 已实现单文件/目录 `.hns` 归一化为同一 HarnessPackage |
| Harness Mind 安装时 seed 共享 Mind | 默认 Frame 按 Evaluation 挂载 |
| 崩溃后整轮重跑 | 持久化 PlanExecution，从效应边界恢复 |
| 共享算子只检查表面拼写 | 同一 canonical operator schema 生成 parser、validator、Contract 和测试 |
| `eval` 由普通工具固定墙钟超时控制 | 持久 Plan 独立等待 Job / Evaluation，不被普通工具超时截断 |

当前尚未完成的不是基本调度或入口语义，而是产品化与规模验证：

- 可发现、可签名、可远端分发的 Harness catalog（本地 install/list/show
  已完成）；
- 已启动 Objective 是否允许修改默认 Harness（第一版仍禁止；具体 Evaluation
  可以在尚未绑定时自主选择）；
- package 签名、依赖、migration 与可重建的 Registry Projection；
- 无递归、静态可解析的包内命名 Process；
- Action Group 级并行 Plan 节点；
- Plan 运行时释放父 Activation admission slot 的完全异步 continuation；
- Edge Target、人工审批和进程崩溃交错下的系统级故障注入；
- 长程序与大型 Observation Reference 的压力测试；
- Harness 相对自然语言或纯 Agent loop 的多任务、多模型统计增益；当前只有
  一次严格配对，证明链路可用且不退化，不能证明能力提升。

为了保留可独立测试的解释器，`EvalTool` 在没有 Scheduler Kernel 注入时仍有
legacy in-process fallback；正常产品装配始终注入 durable Plan executor。该
fallback 不是第二套生产调度器。

## 13. 实现顺序

### Phase 1：冻结最小语义，不接物理工具

1. 定义显式 `eval/infer` 根语义；
2. 建立 canonical operator schema；
3. 将现有 AST 收敛为可序列化 Typed Plan IR；
4. 只用纯值和 Mock Job 验证引用、分支、错误与恢复位置。

### Phase 2：接入 Scheduler Kernel

1. 建立持久 `PlanExecution`；
2. `call` 物化 Execution Job / Action Group；
3. `infer` 物化子 Evaluation；
4. 实现 suspend/resume、fencing、取消和结果 route；
5. 覆盖崩溃发生在效应前、效应提交后、结果交付后的三种恢复边界。

当前状态：1～4 已完成；第 5 项已有 store/coordinator 恢复测试，仍需补真实
Runtime 进程级 fault injection。

### Phase 3：实现 `.hns` 包

1. 单文件 / 目录 Manifest、Contract、Mind、Program loader；
2. Harness registry、版本与 binding；
3. 默认 Frame 的只读挂载；
4. 能力交集、Skill Index 与 validator；
5. package hash、签名和 migration 预留。
6. 包内命名 Process、静态调用图与 ProcessCall IR。

当前状态：第 1～4 项的最小闭环已完成；第 5 项已完成规范化 package hash，
签名和 migration 尚未实现。包目录和 Binding 目前以不可变 persisted Event
持久化，后续可增加可重建 Projection，但不改变其身份语义。顶层
`eval/infer` 已按 Evaluation Binding 正式分派；Objective 可选默认值的原子
创建、普通消息显式选择、模型按需发现与精确选择均已完成。本地 package 的
install/list/show 和外部 Coding Harness 的首个真实 A/B 也已落地。第 6 项是
本轮新冻结的下一项语言能力，但在实施前仍先扩大样本与任务族，确认哪些重复
结构真正应进入 Process Library，避免凭想象扩充包格式。

### Phase 4：真实对照评测

至少包括：

- 默认 Agent loop；
- 只加 Harness Contract；
- `eval` Runtime Plan + 内部 `infer`；
- 重启、审批、并行工具、Edge Target、Context pressure；
- Coding 与非 Coding 负向场景；
- 正确率、重复调用、Token、耗时、恢复完整性和最终交付质量。

当前已完成第一项严格配对样本，结果与结论边界见
[Coding Harness 正式链路 A/B v1](morphz_coding_harness_ab_v1.md)。该样本
证明单文件包、显式 `infer`、正式工具循环和 Harness Binding 可以协同工作；
尚未覆盖 Runtime-owned Plan、故障恢复、Edge Target 与负向场景。

## 14. 本轮明确否决的设计

- 用 `.harness` 作为包后缀；统一采用 `.hns`；
- 让单文件与目录包形成两套语义或两套下游执行路径；
- 以“是否为 `infer` 根”隐式推导求值器；
- 省略显式 `eval`；
- 在 Plan Executor 内直接执行物理工具；
- 用父 attempt 模拟内部 `infer`；
- 安装 Harness 时隐式污染共享 Mind；
- 崩溃后默认整轮重跑；
- 让 Harness 自己成为第二套 Scheduler。
- 在 Yao 中复制 Objective 的开放式循环，或以通用 `while/until`、递归制造
  第二套长期生命期。

最终边界是：

> Yao 表达语义，`eval/infer` 表达求值权，Typed Plan IR 承载可恢复执行，Scheduler Kernel 保证现实副作用与因果一致性，`.hns` 将领域契约、认知、程序和扩展资源组织成可加载的包。
