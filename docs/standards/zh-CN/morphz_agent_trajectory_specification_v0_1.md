# Morphz Agent Trajectory 规范 v0.1

> 状态：规范候选草案
>
> 维护方：新变元
>
> 参考实现：Morphz Runtime
>
> 规范文本语言：英文
>
> 日期：2026-08-21
>
> 英文规范文本：[English](../morphz_agent_trajectory_specification_v0_1.md)

## 1. 范围

本规范定义一种与具体实现无关的模型，用来记录、交换、评测 Agent 经验并从中学习。
它的基本对象是 **Agent Trajectory（Agent 执行轨迹）**：在声明范围内，由权威执行事实
和状态转换形成的有限、带版本且具有因果结构的投影。

本规范定义：

- Agent Trajectory、Event History、Trace、Episode、Rollout 与 Dataset 之间的区别；
- Agent Trajectory Bundle 的逻辑内容；
- 因果、状态转换、权威、来源、Outcome、验证和 Reward 语义；
- 完整性、转换、脱敏、数据权利与完整性声明；
- Core、Evaluation 和 Training 一致性 Profile。

本规范不定义模型架构、优化器、通用 Reward 函数、Event Store Schema、调度器实现，也
不要求保存私有思维链。它不把采集、上传、再分发或训练许可变成隐含授权。

[《Morphz 结构化上下文规范》](morphz_structured_context_specification_v1.md)、
[《Morphz Harness 规范》](morphz_harness_specification_v0_1.md)和
[Yao 规范](yao_core_language_specification_v0_1.md)提供相关语义。只要保持所声明 Profile
要求的可观察行为，Agent Trajectory 实现可以采用不同的内部抽象。

## 2. 规范性措辞

本规范中的“必须”“不得”“应当”“不应”“建议”“不建议”“可以”和“可选”，仅在用于
规定实现义务时具有规范性含义，其解释与 BCP 14、
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119.html)及
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174.html)一致。

除非明确标记，示例、设计理由和实现说明均为非规范性内容。

## 3. 基础模型

### 3.1 基本对象是状态转换，而不是消息记录

Agent Trajectory 的规范对象是结构化状态转换，而不是消息序列。消息只是可能出现的
一种 Event 或 Observation，不能假设它包含 Agent 行动所涉及的完整状态、权威、原因、
Effect 或结果。

状态转换可以概括为：

```text
Structured State View
  -> Agent 或 Runtime 决策
  -> 提议并获准的 Action
  -> Effect 与 Observation
  -> State Delta 与结果 State
  -> Outcome、Verifier Result 和可选 Reward Record
```

表示可以省略不可获得或禁止披露的内容，但必须声明实质性缺失，不得把缺失信息静默
转换为空值或负标签。

### 3.2 事实、投影与解释

权威 Event 记录某件事情确实发生。State View、Trace、Episode、Agent Trajectory、评分
和 Dataset，都是面向特定目的对权威事实形成的投影或解释。

只要允许披露，导出的 Agent Trajectory 必须保留到权威来源的引用。导出不会让 Bundle
成为源系统的新权威，也不得改写源 Event History。

### 3.3 基本结构是因果图，而不是偶然顺序

Agent Trajectory 是有向无环因果图。它可以包含完整存储顺序或墙上时钟时间戳，用于审计和
展示；但二者都不能单独证明因果关系。

当并行分支、Join、重试、恢复、委派和外部回调会影响结果解释时，必须保留这些区别。

### 3.4 Evidence 先于 Reward

Runtime 事实、Outcome 声明、Verifier Result 与 Reward Record 具有不同权威。Reward
Record 是面向特定学习或评测目的，对已识别事实进行的带版本解释；它不得替代或修改
产生它的事实。

### 3.5 数据权利必须明确

源代码可用、本地运行或采用开放规范，不得被解释为用户同意采集、上传、再分发或使用
Agent Trajectory 训练。每个导出的 Bundle 都必须携带明确的权利与披露声明。

## 4. 术语

### 4.1 Agent Trajectory

**Agent Trajectory（Agent 执行轨迹）**是在声明边界内，对一个或多个相互关联状态转换
及其权威执行事实形成的有限、带版本且具有因果结构的投影。它是本规范定义的可移植
经验对象。

Agent Trajectory 可以覆盖一个 Agent，也可以覆盖多个协作 Agent；可以覆盖一个
Objective、一次 Attempt、一次有边界的 Evaluation，或其他被明确声明的范围。

### 4.2 Event、Event History 与 Event Store

**Event** 是某个已发生事项的不可变记录。**Event History** 是其权威域内这些 Event
形成的权威有序历史。**Event Store** 是 Event History 及相关 Projection 的存储实现。

Event Store 是实现角色，不是可移植训练数据格式。一致性 Exporter 从 Event History 和
权威状态投影 Agent Trajectory Bundle，不要求 Consumer 采用源数据库 Schema。

### 4.3 State、State View、State Reference 与 State Delta

- **State** 是某个边界上相关系统的权威状态或声明状态；
- **State View** 是指定 Actor 或 Evaluator 当时确切可见的状态投影；
- **State Reference** 在不内联复制内容的情况下标识带版本 State 或 State View；
- **State Delta** 记录两个 State 边界之间声明发生的变化。

同时表示 Agent 可见内容和 Runtime 专有权威时，State View 必须区分二者。

### 4.4 Trajectory Node 与 Causal Edge

**Trajectory Node** 是可移植因果图中的稳定单元。它可以表示输入、决策、Action、准入、
Effect、Observation、状态事务、分支、Join、验证或终态转换。

**Causal Edge** 表达两个 Node 之间的类型化关系，例如 `caused_by`、`triggered_by`、
`depends_on`、`joins`、`retries`、`resumes` 或 `verifies`。Profile 可以定义额外 Edge
类型。未知 Edge 类型不得被解释为只有时间先后关系。

### 4.5 Action、Effect、Observation 与 Effect Receipt

- **Action** 是 Agent、模型、Harness、Runtime、Principal 或确定性程序选择并提出或
  获准执行的操作；
- **Effect** 是与 Runtime 专有状态或外部环境发生的交互；
- **Observation** 是提供给 Agent 或 Evaluator 的结果或事实表示；
- **Effect Receipt** 是 Runtime 的不可变记录，把已经准入的 Effect 与其操作、参数、
  路由、因果身份、状态和结果引用绑定起来。

当提议、准入、执行与提交的区别会影响权威、安全、恢复或结果解释时，不得把这些状态
合并成一个状态。

### 4.6 Outcome、Verifier Result 与 Reward Record

- **Outcome** 是针对声明范围给出的结果声明或外部结果报告；
- **Verifier Result** 是带身份、带版本的 Verifier 针对声明 Evidence 检查特定性质后
  产生的结果；
- **Reward Record** 是把已识别事实与 Verifier Result 映射为标量、向量、顺序、偏好、
  标签或其他学习信号的带版本记录。

Verifier 通过不自动意味着完整 Objective 已经达成；Outcome 成功也不自动定义一个通用
Reward。

### 4.7 Rollout、Episode、Trace 与 Dataset

- **Rollout** 是在已声明任务、环境、策略和 Binding 条件下发生的一次执行实例。它产生
  权威事实，Exporter 可以据此生成 Agent Trajectory；
- **Episode** 是从一个或多个 Agent Trajectory 中选择的有边界投影，用于重放、评测或
  训练。它的选择与终止规则必须明确；
- **Trace** 是用来检查运行过程的可观测性投影。Trace 可以从 Agent Trajectory 派生，
  也可以与其共享源 Event，但 Trace 与 Agent Trajectory 不是同义词；
- **Dataset** 是为声明用途准备的、带版本的 Agent Trajectory、Episode、标签、转换和
  权利声明集合。

## 5. 一致性 Profile

### 5.1 AT-Core

AT-Core 定义可移植的因果和状态转换记录。一致的 AT-Core Bundle 必须提供：

- 规范版本、Profile 声明与稳定 Trajectory 身份；
- 来源、范围、边界与完整性声明；
- 稳定 Node 与类型化 Causal Edge；
- 已知且允许披露的 Actor 与权威身份；
- 足以解释所表示状态转换的 State Reference、State View，或明确的状态不可用标记；
- Outcome 引用，或者明确声明没有可用 Outcome；
- 转换、披露、权利和完整性元数据。

### 5.2 AT-Evaluation

AT-Evaluation 在 AT-Core 之上支持可复现评测。它还必须提供：

- 任务和 Environment Version 身份，或明确声明的等价条件；
- 终止原因以及相关预算或资源观测；
- Verifier 身份、版本、范围、Evidence 输入、状态与结果；
- 足够的 Binding 信息，以区分会影响比较的模型、Harness、程序、工具和环境变化；
- 未受控制或无法获得的变量声明。

### 5.3 AT-Training

AT-Training 在 AT-Core 之上支持学习和优化。它还必须提供：

- 每个被纳入训练目标的决策当时确切可见的 State View 或 State View Reference；
- 被选择的 Action、结构化输出或 Program Value，及其准入状态；
- 结果 Observation、State Delta、终态，或明确声明目标缺失；
- 标明哪些字段属于输入、目标、元数据或排除内容的训练 Mask；
- 在提供学习信号时，指向 Reward Record 或标签的引用；
- 可用的模型、策略、Harness 与相关解码身份；
- 对声明训练用途的明确许可。

AT-Training 不要求采用同一种优化器、Tokenizer、模型系列或 Reward Policy。

## 6. Agent Trajectory Bundle

### 6.1 顶层必备字段

可移植逻辑 Bundle 包含以下字段：

| 字段 | 要求 | 含义 |
| --- | --- | --- |
| `spec_version` | 必备 | Agent Trajectory 规范版本 |
| `profiles` | 必备 | 声明的一致性 Profile |
| `trajectory_id` | 必备 | 本次导出 Trajectory 的稳定身份 |
| `source` | 必备 | 源实现、Exporter 与权威元数据 |
| `scope` | 必备 | 纳入的 Agent、Context、Objective、Attempt、Evaluation 与边界 |
| `completeness` | 必备 | `complete`、`partial` 或 `open` 及限定说明 |
| `bindings` | 必备 | 已知任务、环境、Harness、程序、模型与策略身份 |
| `states` | 必备 | State Reference、可用 State View、Snapshot 与 Delta |
| `nodes` | 必备 | 稳定 Trajectory Node |
| `edges` | 必备 | 类型化 Causal Edge |
| `outcomes` | 必备 | Outcome 或明确的缺失声明 |
| `verifier_results` | 必备 | Verifier Result 或明确的缺失声明 |
| `reward_records` | 必备 | Reward Record 或明确的缺失声明 |
| `transform` | 必备 | 导出、过滤、脱敏与派生谱系 |
| `disclosure` | 必备 | 省略类别、脱敏状态与保密元数据 |
| `rights` | 必备 | 允许的采集、使用、训练与再分发范围 |
| `integrity` | 必备 | Digest、签名声明，或明确声明不存在 |
| `extensions` | 可选 | 带命名空间的扩展数据 |

必备集合为空，是明确的空集合；它不能证明源系统中不存在对应事实。

### 6.2 来源与范围

`source` 必须标识生产实现和 Exporter 版本。当 Exporter 从权威 Event History 读取时，
应当在不暴露禁止披露的基础设施细节前提下，标识权威域以及源 revision 或 cursor。

`scope` 必须声明构建 Trajectory 时使用的选择规则和边界。Bundle 不能仅仅因为导出了
全部已选择 Node 就声称 `complete`。`complete` 表示：声明 Profile 所要求的全部范围内
实质性因果事实均已表示，或者已经按照该 Profile 明确声明不可获得。

`partial` 表示声明边界已经闭合，但范围内实质性信息被省略、脱敏、无法获得或未被采集。
`open` 表示执行或选择边界尚未到达终止切点。从 `open` 变成 `complete` 或 `partial` 时，
必须产生新的 Bundle revision 或派生 Bundle，不得修改已经签名的 Artifact。

### 6.3 Binding

Binding 应当使用内容身份，而不是浮动名称。适用时包括：

- 任务和 Environment Version；
- 被选择时的精确 Cognitive Application 身份；
- Agent、Principal、Context、Session、Objective 与 Attempt；
- 精确 Harness Package 与 Evaluation Binding；
- Yao 源码或已验证 Program 身份；
- 模型 Provider、模型身份、策略 revision 与解码配置；
- Tool、Execution Target、Capability、Sandbox 与 Verifier 版本。

无法获得或有意不披露的 Binding，必须与从未存在的 Binding 相区分。

## 7. 身份、顺序与因果闭包

### 7.1 稳定身份

Trajectory、Node、State、Outcome、Verifier Result、Reward Record 与所引用 Artifact 的
身份，必须在声明权威域内保持稳定。再次导出时，不得把旧的稳定身份分配给语义不同的
内容。

标识符可以是不透明的。内容派生标识符必须声明 Digest 算法和 Canonicalization 方法。

### 7.2 顺序

Bundle 可以携带权威 sequence、逻辑时钟和时间戳。Consumer 不得只根据相邻数组位置或
时间戳推断 Causal Edge。

两个 Node 并发时，Exporter 不得为了得到线性 Transcript 而虚构顺序。展示层可以使用
确定性顺序显示，但必须在因果图中保留并发关系。

### 7.3 因果闭包与外部父节点

每个已经知道存在实质性 Causal Parent 的 Node，必须满足以下一项：

1. 纳入该 Parent；
2. 纳入类型化 External Parent Reference；
3. 纳入带原因和允许元数据的 Redacted Parent Marker；
4. 声明源系统无法确定 Parent。

过滤或脱敏不得把 Node 重新挂到一个便于展示的可见祖先上。即使 Parent 内容不可用，
Child 仍必须保留真实因果边界。

重试、Replay、Resume 与 Recovery 必须保留原始意图、Attempt 身份、Effect Receipt 和
后续完成之间的关系。如果 Runtime 把重复交付视为幂等 Replay，就不得把它表示成新的
成功 Effect。

## 8. 状态转换语义

### 8.1 转换组成

一个被表示的决策转换应当使以下组成部分可以被引用：

1. `state_before` 或其带版本引用；
2. Actor 当时实际可用的 State View 与 `read_set`；
3. 决策、提议、Action 或 Program Value；
4. 准入、授权与有效 Capability 决策；
5. Effect Request 与不可变 Effect Receipt；
6. 结果 Observation 与 Evidence；
7. `state_delta` 或 `write_set`；
8. `state_after` revision 或 Digest；
9. terminal、suspended、waiting、rejected 或 failed 状态。

Profile 可以把这些部分组织成多个 Node，但 Bundle 必须能够恢复它们之间的因果关联。

### 8.2 结构化上下文

源系统使用 Structured Context 时，State View 应当保留 Runtime 专有 Kernel、Agent 专有
Mind、Inbox 或 Observation、Session Scope、Attention 与 Context revision 之间的区别。

AT-Training Producer 必须标识目标决策当时实际可用的 State View。若使用事后重建的
State 替代，必须声明该转换。

### 8.3 引用与 Delta

每一步的完整 State Snapshot 都是可选的。当内容寻址 State Reference、`read_set`、
`write_set` 和 State Delta 能以更少重复保持声明语义时，Producer 应当优先使用它们。

Consumer 必须能够区分：

- 未变化的状态；
- 明确的空值；
- 被省略或脱敏的状态；
- 源系统中不可获得的状态；
- 内容没有包含在本 Bundle 中的 State Reference。

## 9. Action、权威与 Effect 语义

每个实质性 Action 都应当标识其 Actor 与权威类别：Agent、模型、Harness、确定性程序、
Runtime、Principal、Verifier 或外部系统。

Agent 或模型提议不得表示为已经执行的 Effect。已经准入的 Effect 必须标识批准它的
Runtime 权威或等价系统。外部副作用必须有 Effect Receipt，或明确声明不存在权威回执。

Capability Grant、审批、拒绝、Lease 过期、撤销、Sandbox 边界与 Execution Target 选择，
只要会实质性影响执行或解释，就必须表示。不能为了复现权限决策而写入 Secret 值；
应当使用稳定 Secret Alias 或 Capability Reference。

## 10. Outcome、验证与 Reward

### 10.1 Outcome

每个 Outcome 必须标识：

- 它声明描述的范围；
- Producer 与权威类别；
- 状态与终态性；
- 可用的 Evidence Reference；
- 提出该 Outcome 的 Node 或边界；
- 范围内已知的后续失效或取代关系。

Agent 自报、Runtime 完成、用户验收和外部世界成功是不同的 Outcome 权威，不得静默
合并。

### 10.2 Verifier Result

每个 Verifier Result 必须标识 Verifier、版本、被检查性质、输入 Evidence、实质性相关
的执行环境、结果状态与输出。结果状态应当至少区分 `pass`、`fail`、`indeterminate`、
`error` 和 `invalidated`。

Verifier Result 不得声明超出其已声明范围的事实。后续 Verifier 可以通过新增记录让
早期结果失效，但不得编辑旧记录。

### 10.3 Reward Record

每个 Reward Record 必须标识：

- Reward Policy 身份与版本；
- 源 Outcome、Verifier Result、成本或标签；
- 适用范围与归因目标；
- 信号类型与值；
- 已应用的聚合或归一化方法；
- Producer 与创建时间；
- 该记录是在线产生还是事后产生。

信号可以是标量、向量、顺序、分类、偏好或 Step-level 形式。本规范不定义通用标量
Reward。以后可以派生新的 Reward Record，而不改变底层 Agent Trajectory 事实。

## 11. 模型、Harness 与 Program 来源

模型参与目标决策时，Bundle 应当标识 Provider、模型、策略 revision、请求身份、相关
解码配置，以及提供给模型的确切 State View 或序列化请求 Artifact。

原始 Prompt 和模型原始输出是可选内容，并受披露权限制。如果省略，Bundle 应当保留
被允许的内容身份和结构化边界元数据，以便说明省略发生在何处。

任何 Profile 都不要求提供私有思维链。模型产生的 reasoning summary 可以作为非权威
模型输出纳入，但不得表示为 Runtime 事实。

Harness 管理的工作应当在认知应用被选择时标识其精确身份，同时标识精确 Harness
Package、Evaluation Binding、Contract 与 Entry Program。Yao Program 或 Program Value
应当使用其规范化验证身份和源码来源，而不是无版本的展示字符串。

## 12. 训练语义

### 12.1 训练单元

AT-Training 把如下结构化转换视为基本学习单元：

```text
(State View、read set、policy binding)
  -> Action 或 Program
  -> Observation、State Delta、Outcome 与学习信号
```

为特定模型把这一单元序列化为文本，不会把源语义变成聊天记录。训练 Adapter 必须保留
足够的引用，使序列化输入和目标可以重新关联到结构化转换。

### 12.2 目标与 Mask

AT-Training Episode 必须声明哪些字段属于：

- 模型输入；
- 监督目标；
- 环境输出；
- 仅元数据；
- 不参与 Loss；
- 不可获得、已脱敏或未知。

Consumer 不得只因为一个字段存在就用它训练。内容存在、模型可见、允许训练与参与 Loss
是彼此独立的声明。

### 12.3 过程信号与终态信号

Step-level 信号可以归因到 Node、Edge、分支、State Delta 或决策。终态信号可以作用于
Episode、Attempt、Objective 或 External Outcome。

除非声明的 Reward Policy 明确这样处理，Exporter 不得把单个 Terminal Reward 均匀
摊到之前所有 Node 上。失败 Trajectory 可能包含有价值 Action；成功 Trajectory 也可能
包含浪费或不安全 Action。

## 13. 转换、脱敏与权利

### 13.1 转换谱系

只要允许披露，每个派生 Bundle 都必须标识它的直接 Source Bundle 或源权威、转换实现与
版本，以及 selection、normalization、retokenization、redaction、labeling、merging、
reward derivation 等全部实质性操作。

转换不得把 `partial` 或 `open` 数据静默升级为 `complete`。

### 13.2 脱敏与省略

在允许范围内，脱敏必须保留因果形状。脱敏值必须与 absent、empty、false、failed 或
unknown 值保持可区分。

Producer 应当避免发布低熵 Secret 的 Digest，因为它可能允许离线猜测。Credential、
Private Key、原始 Secret 与非必要个人数据不得进入可移植 Bundle。

### 13.3 权利声明

权利声明必须分别说明 Bundle 是否可以：

- 被保留；
- 用于本地评测；
- 用于托管评测；
- 用于模型或策略训练；
- 以原始形式再分发；
- 以转换或聚合形式再分发。

未知权利不得解释为许可。派生 Dataset 不得扩大源数据授予的权利。

## 14. 序列化与扩展

v0.1 交换表示使用 UTF-8 JSON。Object Key 顺序没有语义；只有字段明确声明时，Array
顺序才具有语义。标识符与枚举状态使用字符串。存在时间戳时使用 RFC 3339。

每个 Bundle 必须声明 `spec_version`。与临时源程序语法不同，持久交换 Artifact 需要
明确版本协商。Consumer 必须拒绝不支持的必备 Profile，不得根据字段形状猜测其语义。

Extension 必须使用抗冲突命名空间，不得重新定义 Core 字段。Consumer 可以保留并忽略
未知的可选 Extension。如果正确解释依赖某个 Extension，Producer 必须把它声明为必备
Profile 或必备 Extension。

未来的 Canonical Signature Profile 将定义字节级 Canonicalization。在此之前，任何
Bundle Digest 或签名的 `integrity` 声明都必须标识它实际使用的 Canonicalization。

## 15. 导出与互操作

一致性 Exporter 必须从声明源状态确定性地派生 Bundle 事实；由脱敏或访问策略造成的
非确定性例外必须明确声明。它必须记录 Exporter 版本、选择边界和转换谱系。

运行遥测可以与 Trace 格式相互映射；训练 Adapter 可以把 Episode 映射到外部 Dataset
格式。此类映射必须保持以下区别：

- 运行 Span 与 Causal Node；
- 已记录 Message 与 State View；
- Tool Request 与已提交 Effect；
- 调用成功与 Objective 达成；
- Verifier Result 与 Reward Record。

有损映射必须声明哪些语义类别被丢弃或近似。

## 16. 安全与完整性

实现必须把导入的 Agent Trajectory 视为不可信数据。除非经过明确验证和策略批准，导入
不得执行嵌入 Program、访问外部引用、调用 Tool、恢复 Capability 或信任签名。

实现应当防御：

- 标识符碰撞与因果引用替换；
- 伪造的 Outcome、Verifier、Capability 或 Effect Receipt 权威；
- 把 Replay 表示成新执行；
- 恶意或超大内联 Artifact；
- 嵌入历史内容的 Prompt Injection；
- 通过派生 Dataset 洗白数据权利；
- 从元数据、Digest、时间或图形状推断脱敏信息。

签名只能证明对签名密钥的控制，不能证明 Outcome 为真，也不能证明训练用途已经获准。

## 17. 一致性声明

实现可以声明为：

- **AT Producer**：针对命名 Profile 生成 Bundle；
- **AT Consumer**：针对命名 Profile 验证并解释 Bundle；
- **AT Exporter**：把命名权威来源确定性投影为 Bundle；
- **AT Adapter**：把 Bundle 或 Episode 转换为命名外部格式。

每项声明都必须标识规范版本、Profile、实现版本、已知限制和公开的一致性证据。通过
AT-Core 不代表通过 AT-Evaluation 或 AT-Training。

本 Draft 不建立兼容性标识，也不能证明 Morphz Runtime 已经实现其中全部要求。

## 18. 非目标

本规范不：

- 定义意识、智能或 Agent 质量的通用度量；
- 要求所有 Agent 状态公开或集中托管；
- 要求每一步都保存完整 Context Snapshot；
- 把 Message 作为 Agent 经验的规范单元；
- 要求采集或披露私有推理；
- 定义唯一训练算法、Tokenizer 或标量 Reward；
- 在缺少适用法律和证据框架时，把 Agent Trajectory 直接当作法律证据；
- 要求独立实现复制 Morphz Runtime 的调度或存储内部结构。

## 附录 A：非规范性紧凑示例

```json
{
  "spec_version": "0.1",
  "profiles": ["AT-Core", "AT-Evaluation", "AT-Training"],
  "trajectory_id": "at:example:objective-42:attempt-2",
  "source": {
    "implementation": "Morphz Runtime",
    "exporter_version": "0.1.0",
    "authority_revision": "context-7@184"
  },
  "scope": {
    "objective_ids": ["objective-42"],
    "attempt_ids": ["attempt-2"],
    "selection": "attempt causal closure"
  },
  "completeness": { "status": "partial", "reason": "private user content redacted" },
  "bindings": {
    "harness": "sha256:harness-content-id",
    "program": "sha256:yao-program-id",
    "model": "provider:model:policy-revision",
    "environment": "env:repo-task:v3"
  },
  "states": [
    { "state_id": "state:17", "context_revision": 17, "availability": "referenced" },
    { "state_id": "state:18", "context_revision": 18, "availability": "referenced" }
  ],
  "nodes": [
    {
      "node_id": "node:decision-1",
      "kind": "decision",
      "actor": "agent:morphz-001",
      "state_before": "state:17",
      "read_set": ["frame:plan@4", "observation:test-failure"],
      "action": { "kind": "yao_program", "artifact": "sha256:yao-program-id" },
      "state_after": "state:18",
      "status": "committed"
    }
  ],
  "edges": [],
  "outcomes": [
    {
      "outcome_id": "outcome:1",
      "scope": "objective-42",
      "producer": "runtime:morphz",
      "authority_class": "runtime",
      "status": "succeeded",
      "terminal": true,
      "evidence_refs": ["receipt:test-run-9"]
    }
  ],
  "verifier_results": [
    {
      "verifier_result_id": "verify:1",
      "verifier": "repo-tests:v3",
      "checked_property": "declared test suite passes",
      "evidence_refs": ["receipt:test-run-9"],
      "status": "pass"
    }
  ],
  "reward_records": [
    {
      "reward_id": "reward:1",
      "policy": "tests-and-cost:v1",
      "sources": ["verify:1"],
      "scope": "objective-42",
      "attribution_target": "attempt-2",
      "signal_type": "scalar",
      "value": 0.91,
      "aggregation": "policy-defined weighted sum",
      "producer": "evaluator:newvar-baseline",
      "created_at": "2026-08-21T12:00:00Z",
      "timing": "retrospective"
    }
  ],
  "transform": {
    "exporter": "morphz-at-exporter@0.1.0",
    "operations": ["attempt_selection", "user_content_redaction"]
  },
  "disclosure": { "private_reasoning": "not_collected", "user_content": "redacted" },
  "rights": {
    "retention": true,
    "local_evaluation": true,
    "hosted_evaluation": false,
    "training": false,
    "redistribution_original": false,
    "redistribution_transformed": false
  },
  "integrity": { "status": "not_provided" },
  "extensions": {}
}
```

本示例有意不作为完整 Schema Fixture。规范性 Fixture 与机器可读 JSON Schema 应由未来
的 Agent Trajectory Conformance Suite 提供。
