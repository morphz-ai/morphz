# Morphz 双求值器符号机：认知语义求值与确定性现实求值

> 状态：基础理论与研究假设 v1
> 日期：2026-07-26
> 适用范围：S-Expression VM、Yao、`infer/eval`、Context、Mind、Harness、Typed Plan IR、Scheduler Kernel 与未来模型训练
> 相关文档：[`morphz_layered_cognitive_vm_identity_architecture.md`](morphz_layered_cognitive_vm_identity_architecture.md)、[`morphz_yao_representation_layers.md`](morphz_yao_representation_layers.md)、[`morphz_frame_vm_model_cognition_decoupling.md`](morphz_frame_vm_model_cognition_decoupling.md)、[`morphz_reality_constrained_epistemic_context.md`](morphz_reality_constrained_epistemic_context.md)

## 1. 文档目的

本文记录 Morphz 最基础的计算观：

> **LLM 不是传统程序的 CPU，而是开放符号的认知语义求值器；Runtime 是确定性现实求值器；S-Expression / Yao 是二者共同操作的项语言。**

Morphz 探索的不是“复活 Lisp”，也不是“用 Lisp 写一个 Agent”。它要回答的问题是：

> 当一个具备世界先验、模糊推理和抽象能力的模型参与符号求值，再与一个具备事务、时序、权限、调度和现实副作用的确定性 Runtime 交错执行时，能否形成一种新的通用计算架构？

本文进一步澄清：

1. 为什么传统 CPU 无法为开放知识和认知结构提供足够弹性的求值；
2. 为什么 LLM 的出现改变了符号求值的物理条件；
3. 为什么 S-Expression 可能适合作为模型和 Runtime 之间的语义中间语言；
4. `infer` 与 `eval` 各自拥有什么求值权；
5. 哪些结论已有实验支持，哪些能力应通过建设和训练获得；
6. 为什么对话只是 Agent 的一种 I/O，而不是 Agent 的计算本体。

## 2. 不是复活 Lisp，而是继续符号求值的未竟探索

### 2.1 历史动机

McCarthy 在 1960 年的 Lisp 原始论文中说明，Lisp 最初服务于 Advice Taker：机器需要处理陈述性和命令性句子，通过操作这些形式化表达式进行推理，并在执行指令时表现出某种常识。

这意味着早期目标并不只是提供一种方便编写普通程序的语法，而是在寻找可以统一承载以下内容的结构：

- 知识和世界描述；
- 陈述与命令；
- 推理规则；
- 函数与程序；
- 可被机器操作的符号数据。

McCarthy 后来在 Lisp 历史回顾中仍然认为，用列表结构表示句子和符号知识是合适的。前缀树首先暴露主连接词，求值器可以先判断表达式的主要关系，再决定如何处理子表达式。

历史材料：

- [Recursive Functions of Symbolic Expressions and Their Computation by Machine, Part I](https://www-formal.stanford.edu/jmc/recursive/node1.html)
- [History of Lisp: LISP prehistory](https://www-formal.stanford.edu/jmc/history/lisp/node2.html)
- [History of Lisp: The implementation of LISP](https://www-formal.stanford.edu/jmc/history/lisp/node3.html)

### 2.2 历史边界

不能把今天的 Morphz 直接倒推成早期研究者已经预见了 LLM。历史上需要区分两件事：

- 用统一树结构表示符号、知识、程序与数据，是有意的核心选择；
- S-Expression 最终直接成为 Lisp 程序的表面语法，则带有实现演进的偶然性。

最初设想中，S-Expression 主要表示数据，程序可以使用更接近传统数学书写的 M-Expression，再转换为 S-Expression。后来 `eval` 被实现为解释器，函数的列表表示逐渐成为实际编程语言，M-Expression 没有完成。

因此 Morphz 延续的不是括号形式本身，而是一个更深的思想：

> **知识、程序、认知和推理是否可以共享一种可递归、可组合、可求值的符号结构。**

## 3. 为什么传统 CPU 没有产生足够弹性的符号求值

传统 CPU 可以可靠求值：

```lisp
(+ 1 2)
```

因为 `+` 的语义已经被完全定义。

但传统 CPU 无法直接求值：

```lisp
(resolve-conflict
  (experience old)
  (evidence new)
  (preference user))
```

除非程序员事先穷尽定义：

- 什么构成冲突；
- 哪类证据更可信；
- 新旧经验如何比较；
- 用户偏好如何影响判断；
- 信息不完整时如何处理；
- 何时保留并行结论，何时修订或取代；
- 何时停止自动判断并向人询问。

传统 CPU 擅长的是**封闭语义求值**：算子、类型、输入域和状态转换已经被程序完整规定。早期符号系统因此必须由人类提前形式化大量世界知识、常识、例外和规则；系统的弹性受限于知识获取、语义落地、规则维护和组合爆炸。

这不是符号结构表达能力不足，而是当时缺少能够为开放符号赋予情境语义的求值器。

## 4. LLM 改变了符号求值的物理条件

LLM 可以结合以下信息，对未被完全形式化的表达式进行语义求值：

- 算子名称和结构位置；
- 自然语言描述；
- 当前 Context 和 Observation；
- 模型参数中的世界先验；
- 示例和历史经验；
- 相邻表达式对语义的重复确认；
- 当前角色、目标、能力和现实约束。

因此，算子的语义可以只被**约束和指向**，而不必被传统程序完全穷举。

```lisp
(fallback
  (call smart-search subject)
  (call browser-research subject))
```

模型能够理解这里包含主路径、失败条件和备用路径，即使 `smart-search` 的领域语义主要由自然语言 Skill、Context 和工具描述提供。

但 LLM 也缺少传统机器的关键能力：

- 稳定、可重复的状态转换；
- 精确的数据引用和类型约束；
- 事务、幂等、版本和并发一致性；
- 权限、资源和副作用边界；
- 可靠的时间、因果、调度和恢复；
- 对现实结果的权威确认。

所以 Morphz 不用 LLM 取代 Runtime，也不用 Runtime 取代模型，而是让二者拥有不同的求值权。

## 5. 双求值器符号机

### 5.1 两类求值器

Morphz 的逻辑机器由两个可以交错调用的求值器组成。

#### 认知语义求值器 `infer`

由 LLM 主导，处理：

- 意图理解；
- 不完备信息；
- 语义抽象；
- 类比和经验归纳；
- 开放式计划与选择；
- Frame 的生成、组合和修订；
- 新符号结构和候选程序的产生；
- 对现实 Observation 的解释。

#### 确定性现实求值器 `eval`

由 Runtime 主导，处理：

- 已定义算子的确定性部分；
- 类型、引用、作用域和结构校验；
- Context Transaction 与 Frame MVCC；
- Event Ledger 与 Projection；
- Scheduler、Thread、Objective、Signal 和 Activation；
- Function Calling、Execution Job 和 Tool Result；
- 权限、沙箱、预算、Execution Target；
- 时序、因果、持久化、恢复和回滚；
- Delivery 和 Session 路由。

### 5.2 交错求值

两个求值器不是一次性的前后处理关系，而是可以互相递归地交还控制权：

```lisp
(seq
  (infer understand-task)
  (eval inspect-state)
  (infer choose-plan)
  (eval execute-plan)
  (infer interpret-observation)
  (eval commit-and-deliver))
```

典型执行链为：

```text
语义求值
  → 产生结构化候选值或表达式
  → 确定性校验、lowering 与执行
  → 现实产生 Observation
  → 再次进行语义解释
  → 修改认知或产生下一步结构
  → Runtime 提交状态与副作用
```

### 5.3 形式化草图

定义：

- `E`：Yao / S-Expression 项；
- `C`：当前 Context Encoding；
- `M`：持久 Mind / Frame 状态；
- `R`：Runtime 权威状态，包括 Ledger、Projection、Scheduler 和权限；
- `O`：来自工具、用户、Timer 和外部环境的 Observation；
- `V`：语义值，可以是回答、判断、Frame、计划、候选表达式或调度意图；
- `P`：经过校验和 lowering 的 Typed Plan IR。

认知语义求值器是条件分布：

```text
inferθ : (E, C, O) → Distribution(V | E, C, O)
```

它不保证相同输入得到同一个值，也不拥有直接修改权威现实状态的能力。

确定性现实求值器是受约束的状态转换：

```text
eval : (P, R) → (R', O, K)
```

其中 `K` 表示完成、等待、失败或需要重新进入 `infer` 的 continuation。

完整的一步可以表示为：

```text
(Eₜ, Cₜ, Rₜ)
   ── inferθ ──▶ Vₜ / E'ₜ
   ── validate + lower ──▶ Pₜ
   ── eval ──▶ (Rₜ₊₁, Oₜ, Kₜ)
   ── project ──▶ Cₜ₊₁
```

该形式不是要求每次求值严格经过全部阶段。纯确定性子树可以直接 `eval`；纯语义问题可以多次 `infer`；关键边界是任何现实副作用都必须经过 Runtime 权威机制。

## 6. “值”不再局限于数字和文本

在双求值器符号机中，一个表达式的值可以是：

- 一个事实或经验 Frame；
- 一个修订、取代或冲突关系；
- 一个执行计划；
- 一个 Objective 或 Schedule；
- 一组并发或串行 Thread；
- 一个工具调用；
- 一次澄清请求；
- 一个等待条件；
- 一个面向特定 Session 的 Delivery；
- 一个可继续求值的新表达式。

例如：

```lisp
(infer
  (intent "看看知乎有什么热门消息")
  (context current)
  (capabilities available))
```

可能产生：

```lisp
(eval
  (seq
    (bind skills
      (call list-skills))
    (bind selected
      (infer choose-suitable-skill
        (input skills)))
    (call read
      (path selected))
    (call execute-search
      (site zhihu)
      (kind trending))))
```

Runtime 对已知节点进行验证和执行。认证失败产生新的 Observation：

```lisp
(observation
  (call execute-search)
  (error authentication-required))
```

模型再次求值后可以产生：

```lisp
(fallback
  (call browser-session)
  (reply "需要使用已有登录状态。"))
```

这里没有任何一方独立完成全部任务。智能来自语义求值与现实求值的闭环。

## 7. S-Expression / Yao 的角色

### 7.1 共同项语言，而非万能格式

S-Expression 的核心价值不是括号，而是它提供了统一、递归、可组合、自描述的树结构：

- 主算子位置明确；
- 子表达式边界明确；
- 数据、程序、认知和元数据可以同形表达；
- 模型可以读取、生成、修订和组合；
- Runtime 可以解析、校验和 lowering；
- 自然语言可以作为开放语义叶子保留；
- 新表达式可以再次成为后续求值的输入。

但 S-Expression 不应被迫承担所有层次的职责。Morphz 使用分层表征：

```text
自然语言
  → 开放意图、领域知识和语义描述

Yao / S-Expression
  → 可组合的语义程序、Frame、Contract 与 Harness

Typed Plan IR
  → Runtime 可验证、持久化、暂停和恢复的执行表示

标准 Function Calling / Provider Envelope
  → 对接经过工具调用训练的模型接口
```

因此更精确的假设是：

> **S-Expression 未必是所有 LLM 输出的最佳外部传输格式，但可能是 LLM 与确定性 Runtime 之间非常合适的语义汇编语言。**

### 7.2 结构与自然语言的平衡

结构负责：

- 顺序；
- 分支；
- 回退；
- 作用域；
- 引用；
- 能力声明；
- 组合和关系。

自然语言负责：

- 模糊概念；
- 领域判断；
- 经验与例外；
- 角色和交互风格；
- 很难穷举的适用条件。

```lisp
(skill smart-search
  (description
    "当本地信息不足或用户请求实时资料时，发现并使用适当的网络能力。")
  (fallback
    (call list-skills)
    (reply "当前没有适合的网络能力。")))
```

Morphz 不追求把所有自然语言继续形式化，也不接受只有自然语言而没有结构边界。二者共同形成可训练、可解释、可验证的语义程序。

## 8. 与普通“LLM as CPU”类比的区别

普通类比通常只是重新映射传统计算机：

```text
Prompt = 指令
LLM = CPU
Context = 内存
Tools = 外设
Agent Runtime = 操作系统
```

Morphz 的区别是：

| 维度 | LLM 作为传统 CPU 类比 | LLM 作为认知符号求值器 |
| --- | --- | --- |
| 输入 | 自然语言指令 | 可组合的开放符号表达式 |
| 算子 | 期待直接遵守 | 结合结构、描述和 Context 求值 |
| 未定义部分 | 错误或提示词缺陷 | 可以推断、澄清、补全或生成候选定义 |
| 输出 | 文本或 Tool Call | 语义值、认知、计划、新表达式或作用意图 |
| Runtime | 调用和管理模型 | 作为第二求值器参与同一计算过程 |
| 学习目标 | 指令遵循 | 符号理解、组合、激活、抽象和现实反馈利用 |

这里的模型更接近“认知语义归约机”，不是传统指令集处理器。

## 9. 对话不是计算本体

当前主流 Agent 往往沿着历史路径把多个概念绑定到 Session：

```text
一段聊天历史
  = 模型 Context
  = 一个 Agent 工作过程
  = 记忆边界
  = 工具调用链
  = 用户界面单位
```

这主要来自聊天产品、Messages API 和 Function Calling 的连续演进，并不证明 Conversation 是 Agent 的最佳计算本体。

Morphz 把基本路径改为：

```text
Event
  → Context Projection
  → Evaluation
  → Schedule / Effect
  → Observation
  → Delivery
```

于是：

- 对话是 Event 的一种来源；
- 回复是 Delivery 的一种目标；
- Tool Result 是 Observation；
- Session 是身份相关的 I/O 关系；
- Thread 是因果执行链；
- Context 是共享的认知求值环境；
- Mind 是持久的后天认知；
- Objective 是跨 Evaluation 持续存在的意图。

Morphz 不否定对话的用户价值，而是把它从 Agent 本体降低为一种 I/O 协议。这使多个 Session、Objective、Thread、工具执行、Timer 和 Edge Node 可以在同一认知主体下并行存在。

## 10. 能力建设，而非等待当前模型自行证明

当前通用模型没有针对 Morphz 的 Yao、Frame 和双求值器协议进行专门训练。因此以下问题不应被当成方向成立之前必须由现有模型一次性证明的先验条件：

- 很深的 S-Expression 是否能稳定遵守；
- 大量 Frame 下是否能激活最合适的经验；
- 长期经验是否能形成高层抽象和跨领域迁移；
- 模型是否能生成更复杂、可复用的符号程序。

在最初的可行性门槛通过后，它们属于能力建设和训练问题。

### 10.1 Runtime 提供可学习环境

Runtime 应提供：

- canonical operator schema；
- 可观察的变量、作用域和引用；
- Frame 身份、来源、适用范围、新旧和取代关系；
- 真实 Tool Result 和环境反馈；
- 明确的协议错误和结构错误；
- 事务、版本、权限和副作用结果；
- 可持久化的完整求值轨迹；
- 任务验证器和奖励信号。

### 10.2 模型训练目标

模型可以逐步学习：

- S-Expression 合法生成与稳定遵循；
- 基础算子和命名模块组合；
- 精确引用、分支、失败和 continuation；
- Frame 检索、激活、组合、抽象、修订和退役；
- 从多条轨迹中提炼共同规律；
- 用反例限定规律适用范围；
- 在未见任务中迁移已学结构；
- 根据 Runtime 反馈重新求值，而不是重复旧动作。

这些任务具有大量可自动验证的信号：语法、引用、分支、调用、事务、任务结果和恢复路径都可以由 Runtime 或环境判断。

### 10.3 训练阶梯示例

```text
单算子理解
  → 浅层组合
  → 精确引用和分支
  → 工具反馈闭环
  → Frame 生成与激活
  → 多 Frame 组合
  → 跨轨迹抽象
  → 反例修订
  → 未见任务迁移
  → 自主生成可验证 Harness
```

## 11. 当前证据、研究假设与工程责任

### 11.1 当前已有证据

Morphz 的实验已经初步支持：

1. 通用 LLM 可以把 S-Expression 理解为执行语义，而不只是解释文本；
2. `seq/call/fallback/bind/choose/reply` 可以指导顺序、分支、引用和终止；
3. VM 身份和结构化求值没有导致普通对话能力明显退化；
4. 在部分对照测试中，S-Expression 的执行路径比纯自然语言更干净；
5. 模型可以理解并主动使用 Context Transaction、Frame、Objective 和 Thread；
6. 结构化求值没有阻止用户对话与后台执行并发存在。

这些证据支持的是最初可行性：

> **LLM 可以成为 S-Expression 的认知语义求值器，双求值器结构可以真实运行。**

### 11.2 待建设能力

- 更强的算子组合和模块复用；
- 专门的 Yao / Frame 后训练；
- 大规模 Frame 激活策略；
- 跨轨迹抽象与迁移；
- Harness 的自主生成、验证和发布；
- 更小的专用 Frame VM；
- 训练、评测、回滚和在线演化闭环。

### 11.3 Runtime 不得推给模型的责任

即使未来模型显著增强，以下边界仍不能只依赖模型自觉：

- Event 不可变性；
- 事务原子性和版本冲突；
- Tool Call / Tool Result 因果配对；
- 权限、身份和执行目标；
- 调度、lease、fencing 与重启恢复；
- 真实副作用验证；
- 资源预算与安全边界。

模型能力进步可以减少 Harness 中的纠正逻辑，但不能消除现实世界的权威状态。

## 12. 核心设计纪律

1. **S-Expression 表达语义结构，不模拟传统 CPU 指令。**
2. **`infer` 与 `eval` 显式保留，不能用隐式规则猜测求值权。**
3. **开放语义交给模型，确定性状态转换交给 Runtime。**
4. **模型可以提出副作用，不能绕过 Runtime 直接提交副作用。**
5. **Yao 是语义源层，Typed Plan IR 是 Runtime 内部执行层。**
6. **自然语言保留为语义叶子，不追求无意义的完全形式化。**
7. **优先使用浅层、命名、可复用组合，复杂能力通过建设和训练扩展。**
8. **对话是 I/O，不是 Context、记忆、任务和执行的共同本体。**
9. **Frame 是可求值的外置认知，不只是被拼接进 Prompt 的检索文档。**
10. **训练增强认知求值能力，Runtime 保持现实约束和可验证反馈。**

## 13. Morphz 的基础研究命题

本文最终把 Morphz 的方向概括为：

> **S-Expression 不仅是一种程序语法，也可能是一种连接语言模型语义推理、持久认知结构与确定性机器执行的中间语言。LLM 与 Runtime 的交错求值，则可能成为这种语言发挥完整潜力所缺失的计算环境。**

由此形成三个递进命题：

1. **可行性命题**：通用 LLM 可以对结构化开放符号进行认知语义求值，且不必牺牲普通语言能力；
2. **能力建设命题**：通过 Runtime 反馈、结构化轨迹和专项训练，可以不断提高符号组合、Frame 激活、抽象和迁移能力；
3. **架构命题**：非确定性认知求值与确定性现实求值的交错执行，可能比纯 Conversation-first Agent 更适合构建长期、并发、可演化的智能系统。

Morphz 的目标不是把 LLM 塞进旧计算机的 CPU 位置，而是探索一种不同于传统程序执行的计算方式：

```text
符号承载认知与程序
LLM 求值开放语义
Runtime 求值现实约束
环境返回真实 Observation
Mind 保存可演化的后天认知
```

这就是“双求值器符号机”的基本定义。
