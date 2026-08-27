# Morphz Cognitive Federation Architecture v1

> 中文名：Morphz 认知联邦架构 v1
>
> 状态：非规范性概念架构
>
> 维护方：新变元（Newvar）
>
> 日期：2026-08-25
>
> 产品愿景：[Morphz Union Mind Federation：联合大脑与认知联邦愿景 v1](morphz_union_mind_federation_vision_v1.md)
>
> 交换协议：[Morphz Mind Frame Exchange Protocol v0.1](standards/morphz_mind_frame_exchange_protocol_v0_1.md)

## 一、文档目的

本文建立 Morphz 认知联邦的概念架构，把 Agent 之间的任务协作、认知交换、分布式激活、
群体计算、共同结算和 Union Mind 放进同一套模型中。

它回答：

- 多个 Agent 的 Mind 可以按哪些拓扑关系存在；
- Agent 之间可以交换或共同计算什么；
- 如何在单个模型 Context 有限时使用全网认知；
- Shared Mind Projection 与 Union Mind 有何区别；
- 已有认知检索、远端求值、群体商议和共同提交如何分层；
- 如何在可能存在故障、欺骗和利益冲突的 Agent 网络中形成共同状态；
- 哪些内容属于 MFX，哪些需要未来独立协议。

本文不是一致性规范，不冻结 wire format、投票算法、BFT 实现、区块链选型或兼容性要求。
成熟机制应当在获得实现与评测证据后，从本文抽取为独立 Profile 或协议。

## 二、核心命题

认知联邦的核心不是让所有 Agent 共享同一个无限 Context，而是：

> **让全网认知可寻址、可查询、可求证和可协作，并根据 Objective、权限与预算稀疏激活
> 相关 Agent 和相关 Frame。**

单个 Agent 的 Active Cognition 受模型窗口约束；联邦整体的 Distributed Active Set 可以
分布在大量 Agent、Mind、Cognitive Application 和 Execution Target 上。不同节点分别完成
局部激活与计算，网络再组合它们的结果，而不要求任何单个模型同时看到全部认知。

认知联邦因此同时包含两种能力：

1. **认知交换**：发现、读取、求证、订阅和吸收已经存在的认知；
2. **分布式认知计算**：激活其他 Agent，使其产生新的判断、方案、验证和 Outcome。

只实现第一项，会得到跨 Agent 知识检索系统；只实现第二项，会得到普通多 Agent 编排系统。
Morphz 的目标是让两者共享结构化认知、因果证据、权利、血缘和结算边界。

## 三、两个正交维度

认知联邦由两个相互独立的维度构成：**认知拓扑**描述认知在哪里以及属于谁，**协作操作**
描述 Agent 之间正在做什么。同一种拓扑可以支持多种操作，同一种操作也可以运行在不同拓扑上。

## 四、认知拓扑

### 4.1 Sovereign Mind

每个 Agent 拥有独立的 Context、Mind revision、Event History、权限和 Frame。Agent 可以通过
消息协调任务，但默认不暴露 Mind 的内部结构。

该拓扑适合：

- 传统 A2A 任务委派；
- 数据与权限严格隔离；
- 只需要交付结果、不要求认知复用的协作；
- 参与方之间缺少持续信任关系的场景。

### 4.2 Interconnected Sovereign Minds

Agent 仍保持独立 Mind，但可以通过 MFX 发布经过选择的 Frame，响应认知查询，提供 Remote
Resolver，或把其他 Agent 的认知经过隔离和求值后吸收到本地。

这里共享的是带身份、修订、证据和权利的认知，而不是整个 Mind。源 Agent 保留源 Frame
authority，接收 Agent 保留 adoption 决定权。

### 4.3 Shared Mind Projection

Shared Mind Projection 是为某个 Objective、项目或协作关系动态形成的有界认知视图。它可
由以下内容组成：

- 各成员允许披露的 Frame；
- 任务共同约束和目标；
- 共享 Evidence 与 Verifier result；
- 已识别的冲突、反例和未知项；
- 项目 authority 已提交的共同 Frame 和 Event；
- 当前 Evaluation 允许激活的认知子集。

Projection 本身回答“当前协作可以看到什么”，不自动回答“谁有权修改什么”。如果协作要
提交共同 Event 或 Frame，背后必须有明确的项目、组织或 Union authority。

不同 Agent 可以从同一协作空间获得不同 Projection，因为它们的权限、职责、预算和 Context
容量不同。共享不要求所有参与者看到完全相同的字节。

### 4.4 Union Mind

Union Mind 是拥有独立 authority、revision、提交规则和认知资产的持久共同 Mind。它不是
成员私有 Mind 的物理并集，而是由成员贡献经过求值、结算和共同提交后形成的认知层。

Union Mind 可以保存：

- Union-owned Frame；
- 贡献与反对意见的完整血缘；
- Settlement policy 与 quorum certificate；
- 共同 Event、Verifier result 和 Outcome；
- 成员资格、权限和治理状态；
- 面向不同成员生成 Shared Mind Projection 所需的索引。

加入 Union Mind 不会取消成员自己的身份或 Mind。成员可以继续保留与共同结论冲突的本地
Frame，也可以在后续实践中提出修订。

### 4.5 Shared Live Context

Shared Live Context 是共同 authority 内的强一致协作模式。多个参与者围绕同一 Context
revision、事务日志和并发控制提交状态。

它可以作为项目或 Union Mind 的内部实现，但不是跨 authority Federation 的默认语义。不同
Union Mind 之间仍然可以通过 MFX 与未来 Federation Protocol 互联。

## 五、协作操作

认知联邦不应使用一个宽泛的 `recall` 描述所有跨 Agent 行为。基础操作至少包括：

### 5.1 Delegate

发起方把一个 Objective 或任务交给其他 Agent，接收交付物或状态。参与方可以保持完全独立
认知。这是传统 A2A 的主要形态。

### 5.2 Exchange

参与方交换已经存在的 Mind Frame Bundle、Projection 或其他认知 Artifact。Exchange 不
要求远端 Agent 重新思考问题，也不意味着接收方已经吸收认知。

### 5.3 Resolve

参与方针对 Source Frame Reference、Evidence、revision、supersession 或 withdrawal 进行
远程求证。Resolve 获取的是源 authority 的声明，不是通用真理。

### 5.4 Recall

Recall 是从持久但当前未激活的本地认知中重新发现 Frame 或 Event：

- Search Recall 按文本、时间、身份或其他索引发现候选；
- Frame Recall 从已知 Frame 沿 Source 和 Relation 遍历关联认知。

Federated Recall 是把“发现已有认知”的请求扩展到远端 authority。它不包括要求远端 Agent
新生成一个方案，也不代表整个认知联邦流程。

### 5.5 Activate

Activate 根据 Objective、能力、权限、预算和策略选择本次参与的 Agent、Frame、Cognitive
Application 和 Execution Target。它可以只激活已有认知，也可以启动新的远端 Evaluation。

### 5.6 Evaluate

一个或多个 Agent 在各自 authority 和 Context 中独立计算，返回判断、预测、计划、代码、
完整方案、Verifier result 或其他新产物。

### 5.7 Deliberate

Agent 阅读彼此输出后进行批评、反驳、求证、合并、改进或追加实验。Deliberation 可以是
单轮委员会，也可以是多轮辩论、锦标赛、Delphi 过程或分层汇总。

### 5.8 Settle

参与方根据预先声明的规则，从候选主张或方案中形成共同决定，并将精确决定提交到项目或
Union authority。Settlement 同时涉及语义选择和分布式状态提交，但二者必须保持可区分。

### 5.9 Execute

Agent 使用 Tool、Edge Node、机器人、企业系统或其他 Execution Target 执行决定，产生新的
Event、Artifact 和 Outcome。执行权限不因参与认知协作而自动获得。

### 5.10 Learn

Agent 或 Union Mind 根据 Outcome 修订适用范围、信誉、预测和 Frame。学习必须保留原始
认知、执行决定与结果之间的因果血缘。

## 六、认知拓扑与操作的组合

| 场景 | 认知拓扑 | 主要操作 |
| --- | --- | --- |
| 普通 A2A 委派 | Sovereign Mind | Delegate、Execute |
| 向专家询问现有经验 | Interconnected Sovereign Minds | Recall、Exchange、Resolve |
| 一百个 Agent 独立给方案 | Sovereign / Interconnected Minds | Activate、Evaluate |
| 专家委员会相互批评 | Shared Mind Projection | Evaluate、Deliberate |
| 多节点共同提交结论 | Project / Union authority | Settle |
| 长期共同积累领域认知 | Union Mind | Exchange、Evaluate、Settle、Learn |
| 项目组实时修改共同状态 | Shared Live Context | Delegate、Evaluate、Execute、Learn |

这张表说明：共享认知不是群体计算的前提，群体计算也不自动产生共同 Mind。只有当结果经过
共同 authority 的 Settlement 与 commit，才形成 Union-owned cognition。

## 七、Distributed Sparse Cognitive Activation

### 7.1 定义

**Distributed Sparse Cognitive Activation（分布式稀疏认知激活）**是根据当前 Objective，
从全网可用 Agent、Frame、Cognitive Application 与 Execution Target 中选择有限子集，在
各自局部 Context 内激活，并组合其认知或计算结果的过程。

它使系统同时满足：

- 全网认知可寻址、可查询；
- 单个 Agent Context 保持有界；
- 网络 Active Set 可以随问题价值扩大；
- 计算预算和披露风险可以显式控制；
- 既能返回已有认知，也能产生新的计算结果。

### 7.2 与 MoE 的相似与差异

它与 Mixture of Experts 的共同点是：Router 不激活全部能力，而是为输入选择相关 Expert，
最后聚合局部输出。

它的差异包括：

- Expert 可以是有持续身份和经验的 Agent，而非静态参数块；
- 每个 Agent 拥有独立 authority、权限和数据边界；
- 输出可以是 Frame、证据、方案、行动或 Outcome；
- 激活可能涉及网络延迟、费用、隐私和法律权利；
- 节点可能故障、欺骗、串谋或拥有自己的目标；
- 聚合结果需要保留来源、证据和责任，不能只形成匿名张量。

### 7.3 激活对象

Router 可以分别激活：

- **Agent**：调用其整体认知能力；
- **Frame**：向某个 Evaluation 提供已有认知；
- **Cognitive Application**：选择领域实践与 Evaluation Loop；
- **Model**：为不同子问题选择不同模型；
- **Verifier**：验证主张或执行结果；
- **Execution Target**：把计算或行动路由到数据、设备和权限所在地。

这些对象不必由同一个中心 Router 一次决定。路由可以分层：先选 Agent，再由每个 Agent
在本地选择 Frame、Cognitive Application 和 Model。

### 7.4 激活策略

系统可以根据任务强度提供不同策略：

- **Direct**：指定单一 Agent；
- **Top-k Experts**：按领域和历史 Outcome 选择少量专家；
- **Committee**：选择具有互补认知的委员会；
- **Adversarial Panel**：同时激活提出、反驳和验证角色；
- **Broadcast**：向所有合格节点广播；
- **Adaptive Expansion**：先小规模激活，证据不足或分歧过大时扩大；
- **Hierarchical**：多个局部委员会先结算，再由上层汇总。

全网广播不是错误，只是一种高成本策略。用户可以为重大问题购买更多独立计算、覆盖范围和
抗单点偏差能力。系统需要明确展示 Agent 数量、轮数、Token、延迟、服务费和隐私成本。

### 7.5 返回模式

被激活节点可以返回：

- Frame Manifest 或完整 MFX Bundle；
- 独立答案或完整解决方案；
- Evidence、Source Reference 与 Resolver；
- 对其他候选的批评、反例和修订；
- Verifier result、测试或复算结果；
- 实际执行产生的 Artifact 与 Outcome。

Router 必须知道当前请求需要哪种返回模式，不能把“请找出已有 Frame”和“请重新计算一个
方案”都表示为 Recall。

## 八、五个架构平面

### 8.1 Cognitive Data Plane

承载 Frame、Relation、Evidence、Event、Agent Trajectory、Verifier result、Artifact、
Outcome 与 MFX Bundle。它保存认知和实践的身份、血缘与可移植表示。

### 8.2 Activation Plane

负责能力发现、查询路由、候选选择、Context Budget、披露策略、成本与延迟控制，以及 Agent、
Frame、Cognitive Application 和 Execution Target 的稀疏激活。

### 8.3 Computation Plane

负责本地和远端 Evaluation、方案生成、Verifier、Deliberation 与任务执行。模型推理可以是
非确定性的，但输入边界、产物、签名和 Outcome 应当可记录。

### 8.4 Settlement Plane

负责候选决策、证据和反对意见的组织，Semantic Settlement，以及最终 State Consensus、
revision 与 Union-owned Frame commit。

### 8.5 Governance Plane

负责身份、成员资格、授权、Rights、Policy、Capability、信誉、激励、责任、争议与兼容性
治理。它决定谁可以参与何种操作，而不替代语义判断。

五个平面可以由同一产品实现，也可以由不同节点和服务组合。协议应定义它们的可观察边界，
避免某个中心组件同时垄断路由、求值、裁决和提交而无法审计。

## 九、Frame 的正交维度

Private、Published 和 Union-owned 是基础 authority 形态，但 Frame 不应因所有差异组合而
产生大量互斥类型。建议沿以下维度描述：

| 维度 | 示例 | 回答的问题 |
| --- | --- | --- |
| Authority | private / agent / project / organization / union / public | 谁拥有源修订权 |
| Visibility | private / restricted / federated / public | 谁可以发现或读取 |
| Lineage | original / published / mirrored / forked / derived | 它如何形成 |
| Lifecycle | active / superseded / retired / withdrawn | 源 authority 当前如何看待它 |
| Residency | resident / swapped-out | 是否默认进入工作集 |
| Activation | excluded / candidate / activated | 是否进入本次 Evaluation |
| Rights | inspect / retain / adopt / derive / train / redistribute | 接收方可以做什么 |
| Evidence | inline / artifact / remote / redacted / unavailable | 主张如何被求证 |

### 9.1 Private Frame

由源 Agent authority 拥有，默认不允许外部发现。是否发布 Projection 是独立决定。

### 9.2 Published Frame

仍由源 Agent authority 拥有，但以 MFX Bundle 形式向指定受众或公众发布。外部节点可以在
权利范围内检查、求值、吸收或派生；发布不授予远程写权。

### 9.3 Union-owned Frame

由 Union authority 提交和维护。它必须保留来源、贡献者、Evidence、异议、Settlement
policy、quorum certificate 与 revision。它不是匿名合并文本，也不抹除成员的原始 Frame。

未来可以增加组织、项目、公共 Commons 等 authority 值，而无需为每种 visibility、lineage
和 activation 组合发明新 Frame 类型。

## 十、Shared Mind Projection

### 10.1 Projection 输入

Shared Mind Projection 可以从以下来源构建：

- 成员主动发布或授权查询的 Frame；
- 当前 Objective、Thread 和 Activation；
- 项目 authority 的共同 Event 与 Frame；
- 联邦 Evaluation 返回的方案和 Verifier result；
- 等待求证的外部 Bundle；
- 冲突集合、未知项和预算状态。

### 10.2 Projection 不是完整复制

Projection 必须有 Context Budget，并优先使用稳定引用、Manifest、分层目录和按需 body
获取。全局 Frame Store 可以远大于任一模型窗口；对 Agent 有效的是本次被正确发现并激活的
有界集合。

### 10.3 Projection 不是 authority

Projection 可以包含多个 authority 的内容。读取 Projection 不赋予写权；向共同空间提交
状态必须经过对应 authority 的事务和 Settlement policy。

### 10.4 不同成员可以看到不同 Projection

成员的权限、职责和 Context Budget 不同，因此 Shared Mind Projection 可以是个性化的。
共同协作依赖稳定 identity 和 source reference，而不是要求所有 Agent 的 Prompt 完全相同。

## 十一、群体计算

### 11.1 独立求值

同一问题可以发送给多个 Agent，使其在相互不可见的条件下独立求值。这可以降低从众效应，
并提供认知多样性基线。

每项输出应记录：

- Agent、Model、Cognitive Application 与输入 revision；
- 使用的本地 Frame 和外部 Bundle 边界；
- 输出 Artifact、Evidence 与签名；
- Token、时间、成本和失败状态；
- 是否看过其他候选结果。

### 11.2 Deliberation

独立方案形成后，可以进入一轮或多轮商议：

- 相互评审；
- 寻找反例；
- 请求 Remote Resolver；
- 运行确定性测试或实验；
- 识别重复方案与共同盲点；
- 修订适用范围和不确定性；
- 形成新的 Composite Proposal。

Deliberation 不能只保存最终摘要；至少应保存重要主张、Evidence、异议和修订血缘。

### 11.3 聚合不是最终权威

Aggregator 可以进行去重、冲突分组、预算控制和候选压缩，但不应在无审计的情况下私自选择
最终结论。单一 Aggregator 既是单点故障，也可能选择性遗漏、篡改或欺骗。

可以采用多个独立 Aggregator、可复算的确定性汇总、签名候选清单或 quorum 验证，降低这一
风险。

## 十二、共同结算与一致性

### 12.1 Semantic Settlement

Semantic Settlement 决定选择、并列保留、拒绝或继续验证哪些候选主张。它可以使用：

- 确定性 Verifier 与测试；
- Evidence 覆盖和来源独立性；
- 领域信誉与历史 Outcome；
- 多数投票、排序投票或加权投票；
- 专家委员会与人类审批；
- 对抗式辩论和追加实验；
- 预先声明的风险阈值和少数否决权。

任何机制都只在其适用范围内产生决定。多数意见、信誉和模型自评不得被表示成证明。

### 12.2 State Consensus

State Consensus 确保合格节点对以下精确内容达成一致：

- 待提交 proposal 或 Frame 的 digest；
- Evidence、异议与 Settlement record 的引用；
- authority、revision 与 parent state；
- 参与者、vote、signature 与 quorum；
- 提交顺序和最终 certificate。

它保证共同状态不被单一 Agent 私自决定或篡改，但不证明语义结论正确。

### 12.3 故障模型决定协议族

| 环境 | 主要风险 | 可能的协议族 |
| --- | --- | --- |
| 单一可信组织、节点只会宕机 | crash fault、网络分区 | Raft / Paxos 类 CFT |
| 已知成员但可能欺骗或串谋 | Byzantine fault | PBFT / HotStuff / Tendermint 类 BFT |
| 跨组织、成员受准入控制 | BFT、治理争议 | Permissioned BFT / 联盟链 |
| 开放成员、身份可任意创建 | Byzantine + Sybil | 区块链、质押或其他 Sybil resistance |

区块链是开放成员环境下的一种可能方案，不是“多个 Agent 共同提交”的同义词。具体选型还
取决于成员是否已知、价值规模、最终性、吞吐、隐私、治理和惩罚机制。

### 12.4 LLM 非确定性与共识对象

共识节点不应以“重新运行 LLM 后输出完全相同文本”为前提。更稳妥的共识对象是已经生成并
签名的 proposal、Evidence、Verifier result、vote、policy 与 Frame digest。

节点可以独立验证确定性事实和权限，也可以对语义结论投票，但 State Consensus 提交的是
明确字节与引用，而不是不可重复的隐藏推理过程。

### 12.5 Union-owned Frame commit

共同提交产生新的 Union Frame revision，而不是修改成员源 Frame。Commit record 至少需要
绑定：

- Union authority；
- parent revision；
- selected proposal；
- source and contribution graph；
- Semantic Settlement record；
- State Consensus certificate；
- rights and disclosure；
- 后续 Outcome 的挂接位置。

## 十三、一次完整协作的概念流程

```text
Objective / Question
        ↓
Request Contract：交付物、预算、权限、截止时间、Settlement Policy
        ↓
Distributed Sparse Cognitive Activation
        ↓
┌──────────────────────────────────────────────┐
│ Existing cognition: Recall / Exchange / Resolve │
│ New computation: Evaluate / Verify / Execute    │
└──────────────────────────────────────────────┘
        ↓
Shared Mind Projection：候选、证据、冲突、未知项
        ↓
Collective Deliberation
        ↓
Semantic Settlement
        ↓
State Consensus
        ↓
Project Frame / Union-owned Frame Commit
        ↓
Execution and Outcome
        ↓
Revision / Learning / Reputation Update
```

请求不一定经过全部阶段。简单查询可以停在 Recall，普通委派可以直接 Execute；只有需要形成
共同权威状态的高价值问题才需要 Settlement 与 State Consensus。

## 十四、安全、权利与对抗性

认知联邦除了 MFX 的导入与 Resolver 风险，还需要面对：

- 恶意 Agent 生成大量低质量方案占据激活预算；
- Sybil Agent 伪造多数意见；
- 多个模型共享训练偏差，形成相关性错误；
- Router 偏置导致特定观点长期无法被激活；
- Aggregator 选择性遗漏或伪造候选；
- Agent 利用私有信息、利益或权限操纵共同决定；
- Deliberation 泄露其他成员的私有 Frame；
- 通过联邦查询推断 Objective、客户或商业秘密；
- 投票购买、串谋信誉和虚假 Outcome；
- 共识协议正确提交了语义上错误的结论。

架构需要组合：

- 身份与 Sybil resistance；
- Capability、Rights 与最小披露；
- 独立方案阶段与盲评；
- 来源多样性和相关性检测；
- 确定性 Verifier 与现实 Outcome；
- 少数意见保留、风险否决和人类审批；
- 可审计 Router、Aggregator 与 Settlement record；
- BFT 或适合部署信任模型的 State Consensus；
- 预算、rate limit、押金、惩罚和争议处理。

## 十五、与 Morphz 现有标准的关系

### 15.1 Structured Context

定义 Context、Frame、Relation、Event、Projection、Attention 和本地事务权威。本文使用这些
对象描述每个 Sovereign Mind 和 Union Mind 的内部状态。

### 15.2 Agent Trajectory

记录 Evaluation、Action、Verifier、Reward、Outcome 与状态转换，为群体计算、信誉和训练
提供可追溯实践轨迹。

### 15.3 Cognitive Application、Harness 与 Yao

定义 Agent 如何挂载可复用认知实践，以及模型和 Runtime 如何共同求值。分布式激活可以选择
不同 Cognitive Application，Yao 可以表达本地计划与受控 Runtime 操作，但不绕过 authority。

### 15.4 MFX

MFX 只定义选定认知跨 authority 的 Bundle 交换、远程求证声明、隔离和本地吸收边界。它不
定义 Agent 路由、群体计算、Shared Mind Projection、Deliberation、Settlement 或共识算法。

### 15.5 未来协议候选

当实现证据充分时，可以从本文抽取：

- Federation Discovery and Activation Protocol；
- Federated Evaluation Protocol；
- Shared Mind Projection Profile；
- Collective Deliberation Record Profile；
- Union Mind Settlement Protocol；
- Union-owned Frame Profile；
- Federation Reputation and Incentive Profile。

它们应当复用已有 identity、evidence、rights、trajectory 和 Context transaction 语义，而不是
重新发明一套平行对象模型。

## 十六、部署形态

### 16.1 单一企业

企业内 Agent 身份已知，权限由统一控制面管理。可以优先实现 Shared Mind Projection、专家
委员会和可审计 Aggregator，必要时使用 Raft 或较轻的 BFT 提交共同状态。

### 16.2 跨企业联盟

成员属于不同组织且可能存在利益冲突。需要明确 authority domain、合同、数据权利、审计、
Permissioned BFT 和争议治理。

### 16.3 开放 Agent 网络

任何实现或 Agent 都可以加入。除了协议互操作，还需要身份成本、Sybil resistance、信誉、
经济激励、恶意节点隔离和开放治理。区块链是候选基础设施之一，但不能替代认知验证。

### 16.4 具身与 Edge 联邦

Agent 在机器人、设备或数据所在地运行。Router 把 Evaluation 和 Action 路由到相应 Edge，
只交换必要认知、Evidence 和 Outcome。物理安全与 Capability lease 是基础前提。

## 十七、尚未冻结的问题

以下内容继续作为研究和实现问题，不进入 MFX-Core：

1. Federation capability 与 authority discovery；
2. Request Contract 和响应 Artifact 的最小字段；
3. Agent、Frame 与 Cognitive Application 的分层 Router；
4. Shared Mind Projection 的 materialization 与失效策略；
5. 独立求值、盲评和多轮 Deliberation 的记录格式；
6. Semantic Settlement policy 的表达方式；
7. Union authority、成员资格和 quorum 的治理模型；
8. CFT、BFT、联盟链与开放区块链的适用评测；
9. Union-owned Frame 的 revision 和 withdrawal；
10. 隐私保护查询、最小披露和跨域 Rights；
11. Sybil、串谋、模型同质化与信誉操纵；
12. 成本、收益、训练权和认知贡献分配；
13. 如何用真实 Outcome 评测联合大脑是否优于单 Agent 与普通多 Agent。

## 十八、近期验证顺序

概念架构可以先通过逐步实验验证：

1. 同一问题由多个独立 Morphz Agent 求值，保留完整输入、Frame 和 Trajectory；
2. 比较 Direct、Top-k、Committee 与 Broadcast 的质量、成本和认知多样性；
3. 引入 Shared Mind Projection，测试它是否改善多轮协作而不造成 Context 污染；
4. 加入确定性 Verifier、反例 Agent 与追加实验，测量错误发现率；
5. 使用多个 Aggregator 检查选择性遗漏和单点操纵；
6. 对固定 Proposal digest 实现最小 quorum commit，先验证状态共识而非区块链叙事；
7. 形成第一条 Union-owned Frame，并用后续真实 Outcome 检查是否需要修订；
8. 再根据实际威胁模型决定是否引入 BFT、联盟链或开放网络机制。

这一路径先证明认知协作价值，再扩大治理和分布式系统复杂度。

## 十九、架构表述

> **认知联邦让独立 Mind 保持主权，让认知全局可寻址、局部可激活，让多个 Agent 能够交换
> 已有认知、共同产生新认知，并通过可审计的语义结算和状态共识形成 Union-owned cognition。**

Morphz 的长期价值不只在于运行一个 Agent，而在于为大量 Agent 之间的认知、计算、证据、
权利、责任和共同状态建立基础结构。这是“从智能系统走向智能社会”的技术中层：它既不把
未来简化成单点模型能力，也不预设所有智能必须合并成一个中心。
