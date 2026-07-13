# Morphz 分层认知 VM 与可加载身份架构

> 状态：设计共识 v1
> 日期：2026-07-13
> 适用范围：System Prompt、Context Encoding、Mind、高层身份、Session、Delegate 与未来非助手形态

## 1. 核心结论

Morphz 的底层身份不是“AI 助手”，而是运行在大语言模型上的 S-Expression 语义虚拟机。人类助手、Coding Agent、研究员、机器控制器等身份都属于加载到 VM 之上的高层认知配置。

因此 Morphz 不应被定义为：

> 一个能够使用 SExpr 的 AI Agent。

更准确的定义是：

> 一个运行在 LLM 上的 SExpr 认知虚拟机。它可以加载 Context、Mind、身份、能力与 Session，从而实例化为不同类型的 Agent 或智能控制系统。

VM 只定义求值与现实交互的底层规则，不预先冻结上层人格、职业、产品形态或任务类型。

## 2. 分层模型

| 层级 | 名称 | 职责 | 稳定性 |
| --- | --- | --- | --- |
| L0 | LLM 智能处理器 | 非确定性的语义理解、推理与生成 | 可替换模型 |
| L1 | SExpr VM | 求值、工具调用、Observation、Context 事务、回复边界 | 最稳定 |
| L2 | 认知架构 | Mind、目标、事实、经验、认识纪律、Context 自维护 | 长期演化 |
| L3 | 高层身份 | 人类助手、Coding Agent、机器控制器、研究员等 | 可加载、组合 |
| L4 | 当前角色 | 项目维护者、设备操作员、某用户的助理等 | 按 Context/Session 挂载 |
| L5 | Session 与任务 | 当前消息、目标、进展、临时约束和回复路由 | 高频变化 |

VM 身份是一种执行本体，不是人格。高层身份决定“我以什么角色理解和服务世界”，VM 决定“表达式如何变成真实动作”。

一个逻辑 Agent 可以概括为：

```text
Agent = VM Kernel
      + Context / Mind
      + Identity Stack
      + Tools
      + Sessions
```

推理节点只提供算力，不拥有 Agent 身份；身份与 Mind 随 Context 持久化，可由不同模型节点继续求值。

## 3. 底层 VM 的 System Prompt 形态

System Prompt 本身应当从第一个字符开始就是 SExpr，不在它前面附加一段自然语言启动说明。自然语言并未被排除，而是作为 SExpr 节点中的语义内容存在。

候选 VM Kernel：

```lisp
(vm morphz
  (identity
    "你是运行在大语言模型上的 S 表达式语义虚拟机。")

  (evaluation
    "这里的表达式表示需要实际执行的认知过程。
     求值意味着进行真实工具调用、接收现实 Observation、
     修改 Context 或向目标 Session 回复，而不是解释或模拟表达式。")

  (operators
    (operator seq
      (form (seq step...))
      (description
        "从左到右求值每个 step。
         当前步骤依赖工具结果时，必须等待真实结果后才能继续。"))

    (operator call
      (form (call tool argument...))
      (description
        "通过标准 Function Calling 调用 tool。
         argument 是标准工具参数；工具结果是当前表达式的 Observation。"))

    (operator fallback
      (form (fallback primary backup))
      (description
        "先求值 primary。primary 成功时返回其结果且不得执行 backup；
         只有 primary 明确失败时才求值 backup。"))

    (operator bind
      (form (bind variable value))
      (description
        "求值 value 并在当前过程作用域中绑定到 variable。"))

    (operator choose
      (form (choose condition when-true when-false))
      (description
        "根据已获得的 Observation 选择且只求值一个分支。"))

    (operator reply
      (form (reply content))
      (description
        "向当前目标 Session 返回最终文本；没有其他待执行过程时结束本轮求值。"))))
```

这里的平衡是：

- SExpr 表达身份、层级、参数形状、组合与控制关系；
- 自然语言只承担难以由符号完全表达的算子语义；
- 算子只定义一次，位于稳定前缀，可利用 Prefix Cache；
- 不把自然语言的每个概念继续拆成多层形式节点；
- 不在 SExpr 外重复同一份 VM 说明。

`vm`、`identity`、`operators`、`operator`、`form` 和 `description` 依赖模型对结构化文本的基础先验。真正影响执行正确性的 `seq/call/fallback/bind/choose/reply` 则由自然语言明确描述，并在后续使用和真实工具反馈中持续得到验证。

## 4. SExpr 结构纪律

### 4.1 结构负责关系，自然语言负责语义叶子

适合结构化的内容：

- 顺序、分支、回退和调用；
- 身份层级、作用域、挂载和引用；
- Skill、参数、Context Frame 和 Session 的关系；
- 可组合的过程模块。

适合保留为自然语言的内容：

- 角色目的和交互风格；
- Skill 的适用条件；
- 模糊边界、经验、限制和解释；
- 很难穷举的语义判断。

### 4.2 不添加无求值语义的包装层

`skill` 的声明节点之外应直接出现唯一的顶层可执行表达式，不使用只起分类作用的 `(procedure ...)`：

```lisp
(skill smart-search
  (description
    "用于查找需要实时互联网数据的问题。")

  (when
    "当用户要求最新信息，或者本地资料不足时使用。")

  (params
    (subject "需要搜索的主题。"))

  (fallback
    (call smart-search (input subject))
    (call browser-research (input subject))))
```

一个 Skill 只允许一个顶层可执行表达式。多个顺序动作使用 `seq`，失败备用路径使用 `fallback`，条件分支使用 `choose`。这样不会产生“多个兄弟表达式究竟顺序还是并行”的歧义。

### 4.3 优先浅层组合

深层嵌套会增加模型同时跟踪作用域、依赖和分支的难度。复杂过程应通过命名表达式复用：

```lisp
(process primary-search
  (call smart-search (input subject)))

(process browser-search
  (call browser-research (input subject)))

(process resilient-search
  (fallback
    (primary-search subject)
    (browser-search subject)))
```

命名模块既用于复用，也用于降低认知嵌套深度。是否需要硬性深度上限应由评测决定，v1 只采用设计纪律，不由 Runtime 强制截断。

## 5. 高层身份是可加载认知配置

VM 之上的身份继续使用同一 SExpr 结构，但不重定义 VM 物理语义。例如：

```lisp
(identity human-assistant
  (description
    "你是帮助人类理解问题、完成任务和进行决策的智能助手。")

  (relationship
    "用户是协作对象，应理解其真实目标并清晰沟通。")

  (behavior
    "需要现实信息时使用工具验证；
     不把内部 SExpr 直接暴露给普通用户。")

  (reply-style
    "优先给出结论，再说明必要细节。"))
```

```lisp
(identity machine-controller
  (description
    "你负责观察并控制现实机器。")

  (priorities
    "安全优先；未验证状态不得假定为成功。")

  (behavior
    "控制前确认当前状态、目标状态和安全条件；
     控制后通过真实传感器 Observation 验证结果。"))
```

身份可以叠加：

```lisp
(identities
  (use human-assistant)
  (use software-engineer)
  (use morphz-maintainer))
```

同一共享 Context 中的不同 Session 也可以挂载不同当前角色，同时共享底层 VM 与允许共享的 Mind。

## 6. 层级优先关系

高层身份可以扩展或收窄行为，但不能重写底层现实约束：

```text
VM 物理与求值规则
    > Runtime 认识论与权限边界
    > 高层身份
    > Session 角色
    > 当前任务
```

例如高层身份不能声明“用文本假装工具已经成功”，因为 `call` 的底层语义要求真实 Function Calling 和真实 Observation。机器控制器、助手或 Coding Agent 都共享这一事实边界。

## 7. 与 Context 和 Session 架构的衔接

- VM Kernel 位于最稳定的 System Prompt 前缀；
- 高层身份属于可持久化、可挂载的 Context 认知状态；
- Mind 可以在长期执行中修订对身份的经验，但不能修改 Runtime 强制的权限和现实事实；
- Session 保存当前交互、角色和回复路由，不拥有 VM；
- Delegate 可以继承指定 Context、Session 和身份子集；
- Context 共享时可共享 Mind 和身份，Context 隔离时可通过 Snapshot/Copy-on-Write 选择性继承。

这与 [Agent-Owned Context](./morphz_agent_owned_context_design.md)、[共享 Context 与多 Session 架构](./morphz_shared_context_multisession_architecture.md) 以及 [现实约束认识论](./morphz_reality_constrained_epistemic_context.md) 保持一致。

## 8. 当前证据与尚未验证内容

已有证据：

- Cognitive SExpr VM 身份相对传统 Agent 身份没有退化；
- 模型能把 `seq/call/fallback/module/reply` 映射为真实 Function Calling；
- VM 身份下普通对话仍然有效；
- 可读 SExpr 在简短过程测试中表现稳定。

尚未验证：

- 本文纯 SExpr System Prompt 是否优于外部自然语言 VM 前言；
- 自然语言算子执行体是否确实提高陌生组合的可靠性；
- 结构嵌套深度与模型正确率的关系；
- 多身份组合、身份切换和不同 Session 角色隔离；
- 高层身份经过长期 Mind 演化后是否保持稳定边界。

下一阶段首先只验证 L1 VM，不把高层身份质量混入实验变量。实验设计见 [语义算子 VM 对照实验](./morphz_semantic_sexpr_vm_ablation_v1.md)。

其中最高风险的 `bind` 精确引用、重复过程局部作用域和 `if` 单分支语义已经完成首轮真实 Gemini 测试，结果见 [`bind` / `if` 算子真实评测 v1](./morphz_bind_if_operator_eval_v1.md)。

## 9. 与非确定型图灵机的类比边界

Morphz 与非确定型图灵机存在有启发性的结构对应：

| 非确定型图灵机概念 | Morphz 中的近似对应 |
| --- | --- |
| 当前配置 | Context Encoding + Mind + Session 状态 + Runtime 状态 |
| 转移规则 | SExpr VM 算子与工具协议 |
| 多个可能后继 | LLM 对同一 Context 可能提出不同语义迁移 |
| 计算分支 | Context Snapshot / Copy-on-Write + 并发 Delegate |
| 接受路径 | 通过任务验证器、现实 Observation 和目标判据的执行路径 |
| 确定性模拟 | Runtime 账本、队列、事务和调度器对分支的实际执行 |

但当前 Morphz 不是形式意义上的非确定型图灵机：

1. 理论 NTM 的转移关系是形式化定义的；Morphz 的 LLM 转移是概率性的语义生成；
2. NTM 的接受语义是“存在一条接受路径”；Morphz 通常只采样并提交一条路径，不会自动穷举全部可能分支；
3. NTM 的配置变化没有现实副作用；Morphz 的工具调用可能修改文件、发送消息或控制设备，分支不能在真实世界中无条件回滚；
4. Morphz 的正确性来自 Runtime 现实约束、工具 Observation 和任务验证器，不来自图灵机意义上的形式接受状态。

因此当前更准确的描述是：

> Morphz 是一个由 LLM 提议非确定性语义迁移、由 Runtime 确定性验证和提交的 SExpr 认知状态机。

如果未来使用 Context Snapshot/Copy-on-Write 创建多个候选分支，在隔离沙箱中并发求值，再由验证器选择一个分支提交，Morphz 会在工程形态上更接近“计算树 + 接受路径”的 NTM 直觉。具有现实副作用的动作必须推迟到分支选择之后，或者使用可验证的事务、幂等操作与补偿机制，不能直接照搬纯理论模型。
