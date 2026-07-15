# Morphz Frame VM：模型、认知与算力解耦

> 状态：长期方向与训练假设 v1；记录已达成的设计共识，不代表当前实现已经支持专用小模型
> 日期：2026-07-15
> 适用范围：Frame VM、外置认知、模型后训练、Frame Conformance、异构模型路由与 Agent 身份连续性
> 相关文档：[`morphz_layered_cognitive_vm_identity_architecture.md`](morphz_layered_cognitive_vm_identity_architecture.md)、[`morphz_agent_owned_context_design.md`](morphz_agent_owned_context_design.md)、[`morphz_single_identity_distributed_cognition_architecture.md`](morphz_single_identity_distributed_cognition_architecture.md)

## 1. 核心命题

Morphz 不必要求一个模型同时把以下所有能力和内容固化在参数中：

- 通用语言理解与推理；
- 海量世界知识和长尾事实；
- 特定领域经验；
- 某个 Agent 的人格、关系和经历；
- 工具使用流程；
- Context 自主维护策略；
- 当前任务状态。

更可扩展的划分是：

```text
Model Weights
  = 通用语义基础
  + 推理与约束满足能力
  + SExpr / Frame 求值能力
  + 少量稳定先验

Persistent Mind / Frame
  = 外置知识
  + 后天经验
  + 人格与关系
  + 领域流程
  + 可修订认知

Runtime
  = 因果、时序、事务、权限、资源、路由与现实 Observation
```

因此，Morphz 的长期目标不是把一个越来越大的模型永久绑定为 Agent 的大脑，而是把模型训练成能够稳定求值 Frame 的智能处理器：

> **Agent 的持续认知存在于 Mind；模型是运行 Mind 的可替换 Frame VM；Runtime 是连接认知与现实的物理控制层。**

一旦这条边界成立，大量长尾知识不必占用模型参数，而可以在运行期作为 Frame 被加载、交换、修订和换入换出。模型有机会显著缩小，Agent 仍然可以拥有远超单次上下文和单一模型权重容量的认知。

## 2. Frame 不只有自主学习这一种来源

Frame 是认知单元，不等同于模型自动生成的记忆。它至少可以来自三条路径。

### 2.1 内生 Frame

Agent 从真实 Session、工具结果、任务成败和长期观察中自主形成：

- 对某类任务的经验；
- 对某个对象的关系认识；
- 对失败原因的总结；
- 新的工作方法；
- 对已有 Frame 的修订或取代。

内生 Frame 的主要未知是抽象、纠错和长期迁移质量。

### 2.2 外生 Frame

Frame 可以由人类专家、组织、程序、另一个 Agent 或经过验证的生成流程精心构造，再植入或挂载到 Mind：

- 医疗、法律、工程等专业知识；
- 企业流程和操作纪律；
- 工具与系统的使用经验；
- 人格、价值原则和沟通方式；
- 某个领域的判断框架；
- 已通过评测的复杂认知过程。

这意味着 Morphz 的成立不必先押注“模型能否凭少量经历自动涌现高质量认知”。即使自主学习尚不理想，外部仍然可以提供高质量 Frame，先验证模型能否正确理解、激活和执行。

### 2.3 派生 Frame

Agent 可以在外生 Frame 基础上结合自己的现实经历继续派生和修订：

```text
专家构造的通用 Frame
          +
Agent 自己的环境、关系和任务证据
          ↓
具有个体经验的派生 Frame
```

因此，外生知识和自主学习不是互斥路线。外生 Frame 提供可靠起点，内生演化让它逐渐适应具体 Agent。

## 3. “外置认知”比“后验知识”更准确

日常表达中，可以把 Frame 称为模型在部署后获得的“后天知识”。更严格地说，不是每个 Frame 都是贝叶斯意义上的后验知识，因此本文优先使用：

- **非参数化知识**：没有固化在模型权重中的知识；
- **外置认知**：存在于可持久化 Mind 中、可被模型求值的认知；
- **后天认知**：Agent 在部署后学习、接收或修订的内容。

Frame 可以同时包含事实、过程、适用条件、证据、关系和修订逻辑，所以它比传统检索文档更接近一段可被语义求值的认知程序。

## 4. 为什么专用 Frame VM 有机会比通用模型小

大模型的一部分参数用于覆盖开放世界中的事实、概念、语言现象和长尾场景。另一部分能力更接近可压缩的推理核心，例如：

- 多步推理；
- 约束满足；
- 状态追踪；
- 自我纠错；
- 结构化输出；
- 对可验证反馈的利用。

微博团队的 VibeThinker 提供了重要旁证。[VibeThinker-1.5B](https://arxiv.org/abs/2511.06221) 和 [VibeThinker-3B](https://arxiv.org/abs/2606.16140) 表明，在数学、竞赛编程和 STEM 等结构明确、结果可验证的任务上，经过专门 SFT、强化学习和自蒸馏的小模型可以达到远大模型的部分推理表现。

VibeThinker-3B 进一步提出 Parametric Compression-Coverage Hypothesis：可验证推理可能是高度可压缩、参数密集的能力，而开放领域知识和长尾场景需要更广泛的参数覆盖。

这不能直接证明 3B 模型已经能成为 Morphz VM。它的[官方模型卡](https://huggingface.co/WeiboAI/VibeThinker-3B)明确说明，该模型没有经过 Tool Calling 或自主 Agent 训练，不建议直接用于 API 编排和 Agent Coding。它证明的是更基础的可能性：

> 当任务结构明确、训练轨迹充分、反馈可以验证时，强能力不必必然依赖超大参数量。

Morphz 可以沿用同一个原则，把小模型训练目标从“竞赛题推理”换成“可验证 Frame 求值”。

## 5. Frame VM 不是普通 Lisp 解释器

专用 Frame VM 即使变小，也不能退化成机械语法解释器。SExpr 表达的是需要模型进行语义求值的认知过程，而不是确定性字节码。

一个合格的 Frame VM 仍需具备：

1. 理解用户和环境中的自然语言；
2. 把模糊现实问题映射到适用 Frame；
3. 理解 Frame 中的自然语言语义叶子；
4. 正确执行 `seq/call/fallback/bind/choose/reply` 等基础算子；
5. 组合多个 Frame、Observation 和工具；
6. 处理 Frame 没有穷举的新情况；
7. 区分事实、推断、目标、偏好和不确定性；
8. 通过 Context Transaction 修改自己的 Mind；
9. 针对正确 Session 和对象生成合适回复；
10. 在现实结果与预期不符时修正判断。

因此，真正目标不是追求参数量的绝对最小值，而是寻找：

> **足以承载通用语义和推理、但不再负责记忆海量长尾认知的最小有效智能处理器。**

它可能比当前通用前沿模型小很多，但其下界必须由评测决定，不能从架构图直接推导。

## 6. 训练的是 VM 能力，不是每个 Agent 的具体认知

Frame VM 后训练应让模型掌握稳定的求值协议，而不是把所有未来 Frame 蒸馏回权重。

### 6.1 可训练的公共能力

- SExpr 结构理解与合法生成；
- 基础算子语义；
- 变量绑定、精确引用和作用域；
- 条件分支、顺序、回退和终止；
- Frame 查找、读取、组合和适用性判断；
- Tool Calling 与 Observation 处理；
- `context_tx` 的创建、派生、修订、关系和生命周期操作；
- 普通文本终态、显式 `no_reply` 与跨 Session `send_message`；
- 冲突、版本变化和错误反馈后的重新求值；
- Session 路由、披露边界和目标连续性。

### 6.2 不应固化进公共 VM 的内容

- 某个用户的私有经历；
- 某个 Agent 的长期人格演化；
- 可快速变化的产品和组织事实；
- 可通过 Frame 持续更新的领域流程；
- 具体 Session 的任务状态；
- 某一部署环境的临时工具结果。

这样，同一个 VM 模型可以运行许多不同的 Agent；同一个 Agent 也可以在多个兼容 VM 模型之间迁移，而不丢失自己的 Mind。

## 7. Frame VM 的奖励可以大量自动验证

相比开放式人格和百科知识，Frame 求值具有较强的可验证性。训练和评测可以分成三层。

### 7.1 语法与协议奖励

Runtime 可以确定性验证：

- SExpr 是否可解析；
- Function Calling 参数是否合法；
- `bind` 引用是否存在；
- 单分支算子是否只执行正确分支；
- 是否调用不存在的工具或 Frame；
- Context Transaction 是否满足版本与结构约束；
- 是否以合法的 `reply` 或明确错误结束。

### 7.2 过程语义奖励

测试环境可以验证：

- `seq` 是否保持真实依赖顺序；
- `fallback` 是否只在主路径明确失败时进入；
- 新 Observation 是否被正确用于后续判断；
- Frame 适用条件、前置条件和冲突条件是否被遵守；
- 多轮求值后数据引用和 Session 归属是否仍然正确。

### 7.3 现实任务奖励

任务执行方负责验证最终结果：

- 代码是否编译、测试是否通过；
- 查询是否命中正确事实；
- 操作后现实状态是否符合目标；
- 用户或领域验证器是否接受结果。

不能只奖励“形式上生成了漂亮的 SExpr”，否则模型可能学会语法正确但语义敷衍。有效训练信号应同时覆盖：

```text
协议正确性 + 求值过程正确性 + 真实任务结果
```

## 8. Frame Conformance 是模型与 Mind 之间的 ABI

为了让 Mind 跨模型保持可用，Morphz 需要定义的不是某个模型专属 Prompt，而是一套可测试的 Frame Conformance Profile：

- 支持哪些基础算子；
- 各算子的语义和错误行为；
- Frame 引用、作用域和组合方式；
- Context Transaction 协议版本；
- Tool Calling 与 Observation Transcript 规则；
- Reply 和无外部回复的终止语义；
- 最大可靠嵌套、引用长度和上下文压力边界；
- 必须通过的标准评测用例。

它类似模型和 Mind 之间的语义 ABI。一个模型只有通过相应 Conformance Suite，才能被声明为兼容某个 Morphz VM Profile。

这也意味着 Frame 不应依赖某个模型偶然的 Prompt 技巧。若 Frame 只能被单一模型理解，它就不是可移植认知，而是模型特化提示词。

## 9. 分层算力：小 VM 常驻，大模型按需成为协处理器

认知和计算节点分离后，Morphz 不必把所有请求都发送给同一种模型。

```text
                         Persistent Agent
                  Identity / Mind / Frame / Ledger
                                  │
                                  ▼
                       Lightweight Frame VM
                 常规对话 / 路由 / Frame 求值 / 工具
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
          Local Tools        Specialist VM       Frontier Model
          现实执行节点        领域专用处理器        困难推理协处理器
```

轻量 Frame VM 可以承担：

- 大多数常规 Session；
- Frame 激活和工作集维护；
- 稳定流程与工具编排；
- 明确可验证的领域任务；
- 后台事件和 Objective 监督。

只有当它判断当前问题超出能力边界时，才将经过授权的 Context Snapshot 和任务交给更大模型或专业模型。大模型返回的是计算结果、候选 Frame 或事务提案，而不是接管 Agent 身份。

因此，大模型更像按需使用的认知协处理器：

- 可以更换；
- 可以并行；
- 可以按成本和质量路由；
- 可以只接收任务所需的认知投影；
- 不拥有 Agent 的长期身份和完整 Mind。

## 10. Agent 连续性不再绑定模型权重

传统 Agent 往往把“Agent 是谁”隐含绑定在系统提示词、某个会话和某个模型上。Morphz 的目标是把身份连续性移到可持久化认知层：

```text
Agent identity continuity
    = stable Agent ID
    + Persistent Mind
    + Session / Relationship history
    + Ledger provenance
    + Runtime governance

    ≠ one fixed model process
```

只要新的 Frame VM 通过兼容性评测，并能够读取相同 Mind：

- 模型升级不会创建另一个 Agent；
- 计算节点迁移不会丢失人格和经历；
- 大小模型可以在不同任务间协作；
- Agent 可以在本地、边缘和云端之间移动；
- 同一 Mind 可以在授权范围内由多个 Worker 并发求值。

这不是说模型差异没有影响。不同模型仍会表现出不同的判断、语言风格和执行可靠性，但这种差异类似更换认知处理器，而不是把长期记忆和身份全部重置。

## 11. 这条路线仍然存在的边界

### 11.1 不能外置所有先验

模型必须先拥有足够的语言、常识、概念基础和抽象能力，才能理解 Frame。一个完全不理解医学概念的模型，仅靠一段高度压缩的医疗 Frame 未必能够正确应用。

外置认知减少的是参数对长尾事实和具体经验的覆盖压力，不是取消基础预训练。

### 11.2 Frame 越好，不代表一定执行得越好

外部专家可以控制 Frame 内容质量，但模型仍可能：

- 误解适用条件；
- 忽略限定语；
- 错误组合多个 Frame；
- 在长链引用中丢失变量；
- 用已有偏见覆盖 Frame 中的新知识。

因此需要 Conformance、真实任务验证和失败样本，而不能只审查 Frame 文本本身。

### 11.3 激活仍是核心难题

外部可以构造数百万高质量 Frame，但若当前任务找不到正确候选，它们仍然是功能性失忆。Frame 可以自描述适用条件、触发信号、依赖和关系，Runtime 也可以维护分层索引；最终的语义选择仍需由 Agent 完成。

### 11.4 更小不自动等于更便宜

若小模型需要大量重复尝试、超长推理或频繁升级到大模型，总体成本可能反而更高。评估必须计算端到端任务成功率、延迟、Token、工具开销和升级比例。

### 11.5 多模型兼容不是逐 Token 等价

Frame ABI 要求的是任务和语义行为达到约定下限，不要求不同模型逐字、逐步骤一致。Morphz 是非确定性语义 VM，兼容性应以可观测行为和结果定义。

## 12. 必须建立的验证体系

### 12.1 VM 规模曲线

使用相同 Frame、Runtime 和任务集，对不同参数规模、量化等级和模型家族测试：

- SExpr 合法率；
- 算子语义正确率；
- Tool Calling 成功率；
- Frame 激活准确率；
- Context Transaction 正确率；
- 长链引用保持率；
- 任务成功率；
- 成本、延迟和大模型升级比例。

目标不是预设“3B 足够”，而是找到不同 VM Profile 的最小可靠模型。

### 12.2 参数知识与外置认知对照

对同一领域构造三组：

1. 只依赖模型参数；
2. 通用模型 + 原始检索文档；
3. Frame VM + 精心构造的认知 Frame。

比较准确率、可修订性、知识更新时间、来源可追踪性和 Token 成本。

### 12.3 Frame 植入与迁移

测试 Fresh Agent 在加载 Frame Bundle 前后，是否能够：

- 正确理解 Frame；
- 在未见任务中迁移；
- 遵守适用范围；
- 拒绝不适用或冲突 Frame；
- 在不同兼容模型上维持效果。

### 12.4 分层模型路由

比较：

- 全部由大模型求值；
- 全部由小 Frame VM 求值；
- 小 VM 常驻、困难任务升级；
- 专业 VM 与大模型协作。

衡量最终质量而不是只比较单次推理价格。

## 13. 分阶段路线

### Phase A：保持现有通用模型，冻结 Frame VM 语义

- 完成基础算子和 System Prompt Profile；
- 建立 Frame Conformance Suite；
- 用多个现有模型验证跨模型行为边界。

### Phase B：构造外生 Frame 基准

- 精心编写一组知识、流程、认识纪律和人格 Frame；
- 验证植入、修订、取代和跨任务迁移；
- 将 Frame 内容质量与 VM 求值质量分开评分。

首个外生 Coding Frame 已完成两组真实 Gemini 配对验证：模型能够正确激活和执行 Frame，公开与隐藏测试均通过，但在 Fresh 已达过程满分的任务上没有观察到质量增益，候选反而增加了工作轮次。这证明“可求值”，尚未证明“有收益”；详见 [外生 Coding Frame A/B v1](./morphz_coding_frame_ab_v1.md)。

### Phase C：训练首个专用 Frame VM

- 从通用小模型开始；
- 使用标准轨迹做 SFT；
- 使用协议验证器和真实任务验证器进行强化学习；
- 明确其可靠能力边界，不追求一次覆盖全部 Agent 场景。

### Phase D：引入异构算力路由

- 小 VM 处理常规 Evaluation；
- 困难任务升级到大模型；
- 结果以 Observation、Frame 或事务提案返回；
- Agent 身份和 Mind 始终留在持久化 Context。

### Phase E：与 Frame Virtual Memory 合流

- 外置认知不受单次 Context Window 限制；
- Frame 分层驻留、按需激活和 swap in/out；
- 专用 VM 学会在预算内构造最相关的认知工作集；
- 验证百万级冷 Frame 下的召回、负迁移和端到端成本。

## 14. 最终判断

Frame VM 路线带来的关键变化不是单纯“把模型做小”，而是重新划分智能系统中参数、认知和现实的职责：

```text
模型提供可复用的智能执行能力；
Frame 承载可变化、可交换、可学习的认知；
Runtime 保证所有行为发生在真实、可审计的物理秩序中。
```

这样，即使自主形成高维认知仍需长期研究，Morphz 也可以先成为一个可编程的外置认知系统；即使小模型无法覆盖所有困难任务，它也可以成为常驻 VM，并把少数高难度求值委托给大模型。

最重要的架构结论是：

> **一个 Morphz Agent 不是某个大模型的包装。它是持续存在的 Mind；模型只是可以被训练、替换、扩展和按需调度的认知处理器。**
