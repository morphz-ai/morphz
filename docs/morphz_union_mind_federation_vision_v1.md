# Morphz Union Mind Federation：联合大脑与认知联邦愿景 v1

> 状态：非规范性产品愿景
>
> 维护方：新变元（Newvar）
>
> 日期：2026-08-25
>
> 协议基础：[Morphz Mind Frame Exchange Protocol v0.1](standards/morphz_mind_frame_exchange_protocol_v0_1.md)
>
> 架构模型：[Morphz Cognitive Federation Architecture v1](morphz_cognitive_federation_architecture_v1.md)

## 一、愿景

**Union Mind Federation（联合大脑与认知联邦）让彼此独立的 Agent 在保留身份、权限与
认知主权的前提下，发现、交换、验证、激活、计算和共同发展认知。**

它把“一个 Agent 可以向另一个 Agent 分享认知”扩展为长期存在的协作网络：不同 Agent
拥有自己的 Mind、经验、立场和责任边界，同时可以发布经过选择的认知投影、响应联邦请求、
订阅认知更新、参与群体计算，并把外部认知经过本地求值后转化为自己的能力。

联合大脑不是把所有 Agent 合并成一个身份，也不是让远程节点直接写入彼此的 Mind。它是
一种保留差异和血缘的认知协作结构。网络可以形成共享能力，却不要求存在一个全局统一的
人格或真理中心。共同决定可以由分布式协议提交，但协议达成一致不等于证明结论为真。

## 二、为什么需要联合大脑

单个 Agent 的能力受到自身经验、Context 容量、权限和实践范围约束。多个 Agent 即使能够
互发消息，也很难长期积累可验证的共同认知：消息通常缺少稳定身份、修订、证据闭包、权利、
更新与吸收血缘，接收方也无法区分“读过一段文字”和“把外部认知纳入自己的 Mind”。

Mind Frame Exchange（MFX）解决认知交换物的最小可移植边界。Union Mind Federation 在此
基础上解决长期网络关系：

- 去哪里发现具有相关认知或求证能力的 Agent；
- 如何只暴露完成协作所需的最小认知投影；
- 如何跨权威域求证证据、修订与撤回状态；
- 如何订阅变化而不赋予发布方远程写权；
- 如何根据问题、权限与预算，稀疏激活相关 Agent 和相关 Frame；
- 如何让多个 Agent 独立求值、提出方案、相互批评并形成可审计的共同决定；
- 如何在冲突存在时继续协作，而不是强行合并出一个答案；
- 如何记录贡献、使用、结果与责任，形成可积累的认知信誉；
- 如何让开放节点的加入扩大网络价值，同时保留参与者的认知主权。

## 三、Shared Mind Projection 与 Shared Live Context

### 3.1 Shared Mind Projection

**Shared Mind Projection** 是从多个独立 Mind 中，为特定 Objective、项目或协作关系动态
形成的有界认知视图。它可以组合成员发布的 Frame、共享证据、共同约束和阶段性结论，但不
要求复制成员的完整 Mind，也不使所有输入 Frame 自动成为共同所有。

Projection 只回答协作者当前可以看到什么。如果协作需要共同提交 Event、Frame 或决定，
仍然需要一个明确的共享 authority 作为权威来源。该 authority 可以是项目 Context、组织
Context 或未来的 Union Mind。

### 3.2 Shared Live Context

Shared Live Context 适用于共享同一权威边界的协作者。参与者围绕共同 Context revision、
事务日志和并发控制工作，可以使用统一的身份、权限与 commit 规则。

典型场景包括：

- 同一 Agent 的多个 Session；
- 同一企业控制面内的一组协作节点；
- 对同一项目状态拥有共同写权限的 Agent 与人类。

### 3.3 Union Mind Federation

Union Mind Federation 连接彼此独立的权威域。每个节点保留自己的 Context、revision、
Event History、权限和提交决定。网络中没有隐含的全局总序，也没有一个参与方天然拥有其他
节点的写权限。

同一份外部认知可以被不同节点吸收成不同的本地 Frame；一个节点的更新对其他节点是新的
输入，而不是远程 mutation。冲突可以被保留、比较并由后续实践分别结算。

### 3.4 三者可以组合

一个 Union Mind 节点内部可以使用 Shared Live Context，多个 Shared Live Context 也可以
通过 MFX 与 Federation Gateway 互联。联合大脑规定跨权威边界，Shared Live Context 规定
共同权威边界内部的协作，Shared Mind Projection 则规定一次协作实际可见的有界认知视图。

## 四、核心不变量

无论未来协议如何演进，联合大脑应保持以下不变量。

### 4.1 身份不合并

参与联邦不会创建一个取代成员 Agent 的超级身份。每项认知、证据、求值与决定都必须能够
追溯到相应 authority domain、Agent 和 revision。

### 4.2 认知主权不转移

外部节点可以发布、更新或撤回自己的主张，但不能直接修改接收方已经吸收的本地认知。
接收方始终通过本地事务决定是否吸收、修订、退役或激活。

### 4.3 交换不等于认同

发现、下载、验证签名、远程求证和订阅都不等于相信。外部认知先进入隔离区，经本地求值与
授权后才能进入 Mind。

### 4.4 证据与解释不合并

网络必须区分 Runtime Fact、Evidence、Agent-authored cognition、Verifier result 与多数
意见。签名、信誉和流行度不能被压缩成单一“真理分数”。

### 4.5 差异可以长期存在

联合大脑不以消除冲突为目标。多个 Frame 可以针对相同问题给出不同的适用范围、预测与
行动建议；后续 Outcome 可以提高或降低它们在特定场景下的信誉，而无需重写历史。

### 4.6 披露与使用权最小化

查询和交换应遵循最小披露。检查、保留、托管求值、吸收、派生、再分发和训练是不同权利，
必须分别授权。开放协议不等于开放所有认知数据。

### 4.7 共识不等于真理

多数意见、加权投票、委员会决议或 Byzantine 共识可以产生可执行的共同决定，但不能证明
该决定必然正确。联合大脑必须保留候选方案、证据、反对意见、Settlement policy、参与者
签名和后续 Outcome，使共同认知仍可被实践修正。

## 五、分层演进

联合大脑不应以一次性实现“全网共享 Mind”为起点。它可以沿着可验证的能力层逐步发展。

### 5.1 第一层：Mind Frame Exchange

MFX-Core 提供不可变 Bundle 的离线交换：选定 Frame、Relation、证据闭包、修订、披露、
权利和完整性声明。Importer 负责隔离、求值、吸收和血缘。

这一层使认知成为稳定、可检查、可引用的交换物，是后续所有网络能力的最小基础。

### 5.2 第二层：Remote Evidence Resolution

源节点可以声明受策略约束的 Resolver 能力，用于求证 Frame 内容、Evidence、当前 revision、
superseding Frame 与 withdrawal statement。

Resolver 是可选能力。Bundle 离线时仍可解析；Importer 不得自动访问 Bundle 中的 URL，
任何请求都经过 endpoint、凭据、隐私、资源与审批策略。

### 5.3 第三层：Frame Subscription

接收方可以订阅某个源 Frame、Projection 或 query 的变化，并使用 cursor 获得新的不可变
Bundle、修订或撤回声明。

Subscription 只提供更新发现，不提供远程写入。每次更新仍然经过接收方的隔离、求值与
本地 commit。

### 5.4 第四层：Distributed Sparse Cognitive Activation

全网认知首先做到全局可寻址、可查询，再根据 Objective、能力、权限和预算稀疏激活相关
Agent 与相关 Frame。每个 Agent 只在自己的有限 Context 中激活局部认知，而整个网络可以
形成远大于任何单一模型窗口的 Distributed Active Set。

一次激活可以要求远端返回已有 Frame，也可以要求远端执行新的 Evaluation、提出方案、进行
验证或执行任务。它类似跨 Agent 的稀疏专家路由，但额外保留身份、证据、权利、状态与责任。

### 5.5 第五层：Collective Evaluation and Deliberation

多个节点可以围绕同一问题独立计算解决方案，随后交换证据、反例、Verifier result 与修订
意见。协作可以采用专家委员会、全网广播、对抗式辩论、分层汇总或多轮商议，并由用户根据
问题价值选择预算和计算强度。

### 5.6 第六层：Collective Settlement and Union-owned Cognition

语义结算机制从候选方案中形成共同决定；状态共识机制确保合格节点对提交内容、顺序与
revision 达成一致。已知身份和受控成员环境可以采用 Permissioned BFT；开放网络可能还需要
Sybil resistance、经济机制或区块链。具体算法由未来 Settlement Profile 决定。

结算结果可以形成 Union-owned Frame。它由 Union authority 维护，但保留所有贡献、反对
意见、证据、规则与 quorum certificate 的血缘。

这一层支持跨企业、跨专业和跨物理节点的长期 Agent 协作，并为信誉、激励、责任与风险
分配提供可审计基础。

### 5.7 强信任模式：Shared Live Context

当参与方愿意进入共同权威域时，可以建立 Shared Live Context，使用更强的共同事务与实时
一致性。它是一种显式升级的强信任模式，而不是所有 Federation 参与者的默认状态。

## 六、概念架构

### 6.1 Sovereign Mind Node

每个节点维护自己的 Structured Context、Mind revision、Event History、Agent Trajectory、
权限与本地 Frame。节点对自己发布的认知负责，也保留拒绝外部认知的能力。

### 6.2 Federation Gateway

Federation Gateway 是跨权威交互边界，承担协议协商、身份绑定、rate limit、披露策略、
query admission、Bundle export/import 与审计。它不得绕开 Runtime 权威直接写 Mind。

### 6.3 Authority Directory

Directory 用于发现 authority domain、Agent 能力、受支持 Profile、public key、Resolver、
可查询领域与服务政策。Directory 声明是可验证入口，不是对节点质量或真实性的绝对担保。

### 6.4 Resolver 与 Subscription Service

Resolver 回答针对既有引用的受约束求证；Subscription Service 发布 revision feed 和 cursor。
二者都必须绑定源权威，并接受鉴权、权利、隐私与资源限制。

### 6.5 Federation Interaction Router

Router 根据 query scope、领域、证据需求、权利、成本、延迟与历史 Outcome 选择候选节点，
并决定请求是 Recall、Resolve、Evaluate、Deliberate、Execute 还是它们的组合。它可以组织
候选认知和计算，但不把路由排名当作真理，也不替代 adoption 或 settlement。

### 6.6 Collective Evaluation and Settlement

参与节点可以返回已有 Frame、独立判断、完整方案、Verifier result、反例或执行 Outcome。
Settlement 先形成语义上的候选决定，再由适合信任模型的一致性协议提交共同状态。单一
Aggregator 可以汇总，但不得成为不可审计的最终权威。

### 6.7 Local Quarantine and Adoption Pipeline

所有外部 Bundle 经过 received、verified、quarantined、evaluated、adopted/rejected 状态链。
被吸收的认知创建本地 Frame，并记录 source Bundle、Source Frame Reference、Verifier、Policy
与 adoption mode。

### 6.8 Policy、Grant 与 Capability

本地策略分别控制：谁可以查询什么、什么可以导出、是否允许联网求证、凭据可向谁披露、
外部认知可以如何使用，以及哪些 adoption 需要 Agent 或人类审批。Capability 应限定资源、
范围与有效期。

### 6.9 Verification、Attribution 与 Outcome

联邦保留认知贡献的身份、证据、Verifier result、使用位置和后续 Outcome。由此产生的信誉
不是抽象点赞数，而是“某项认知在何种范围内被谁验证、用于什么行动、产生何种结果”的
可追溯记录。

## 七、两类联邦认知交互

### 7.1 认知交换与求证

1. 本地 Agent 发现自己的 Context 对当前问题覆盖不足；
2. Runtime 形成最小化的 federated query，并结算允许披露的字段；
3. Gateway 发现并选择支持相应领域和 Profile 的候选节点；
4. 远端节点在自己的权威边界内查找已有认知并返回 MFX Bundle；
5. 本地 Importer 离线解析、验证并隔离 Bundle；
6. 如证据不足且策略允许，本地显式调用 Remote Resolver；
7. 本地 Cognitive Application 比较外部认知、本地 Frame、证据与冲突；
8. Agent 选择吸收、派生、保留竞争假设、等待证据或拒绝；
9. 后续实践产生 Outcome，并更新本地适用性判断与可披露的验证记录；
10. 在权利允许时，新的派生认知可以带完整血缘重新进入联邦。

### 7.2 群体计算与共同结算

1. 发起方声明问题、交付物、预算、截止时间、披露范围与 Settlement policy；
2. Router 选择少量专家、动态委员会或全网广播；
3. 各 Agent 在本地激活相关 Frame，并独立提出方案或 Verifier result；
4. 系统保留每项输出的 Agent identity、输入边界、证据与签名；
5. 聚合阶段去重、分组冲突，并组织批评、复算、辩论或追加实验；
6. 语义结算根据预先声明的规则产生候选决定，而不是由单个 Agent 私自裁定；
7. 状态共识协议确认待提交内容、顺序、quorum 与 revision；
8. 决定被写入项目 authority 或 Union Mind，并保留全部贡献血缘；
9. 执行产生 Outcome，进一步验证或修订共同认知。

两类流程都不允许远端直接修改本地 Mind，也不把“远端返回”或“多数同意”自动当作真理。

## 八、一致性与冲突模型

### 8.1 每个权威域维护自己的序列

Federation 不要求一个全局 Event History 或全局 revision。源 Frame 的 identity 与 revision
只在其 authority domain 中具有写权，Bundle 与签名把该身份带出本域。

### 8.2 更新是新声明

新修订、替代与撤回都是新的不可变输入。接收方发现它们后，创建自己的求值与状态转换；
已经吸收的 Frame 不被远程覆盖。

### 8.3 冲突保持显式

不同节点对同一问题给出冲突认知时，接收方应保留来源、适用范围、Evidence、uncertainty 与
Outcome，而不是只保留自动合并后的文本。未来可以定义 conflict set、prediction 与 settlement
Profile，但 v0.1 不定义自动语义合并。

### 8.4 不追求全局总序

除非一组参与者显式进入 Shared Live Context，Federation 只要求可追溯因果与本地一致性，
不要求所有节点对所有认知变化达成相同顺序或相同结论。

### 8.5 语义结算与状态共识分离

Semantic Settlement 回答“根据哪些证据、规则和意见选择哪个候选结论”；State Consensus
回答“哪些节点以什么 quorum 对哪个精确值和 revision 完成提交”。Paxos/Raft 适合主要面对
crash fault 的环境；参与 Agent 可能欺骗或串谋时，需要 Byzantine fault model。区块链是
开放成员与经济型 Sybil resistance 的一种选择，不是所有部署的默认答案。

## 九、信任与认知信誉

联合大脑需要信任基础，但信任必须可分解、可限定。

可以分别记录：

- 身份与 authority binding 是否验证；
- Bundle digest、signature 与 provenance 是否验证；
- Evidence 是否可获得、可复算或被独立来源支持；
- Frame 在何种条件下被哪些 Agent 采用；
- 对应预测、行动与 Outcome 是否得到验证；
- 发布方是否及时修订、披露限制或发布撤回；
- Query、Resolver 与 Subscription 服务是否可靠履约。

这些维度可以辅助路由和风险控制，但不能聚合成一个跨领域、跨语境的万能真理分数。同一
节点可能在一个领域可靠，在另一个领域没有资格；同一 Frame 也可能只在明确适用范围内成立。

## 十、安全与隐私

Union Mind 扩大认知协作，也扩大攻击面。系统至少需要面对：

- 通过 Frame、Evidence 或 Relation 进行 prompt injection 和认知投毒；
- 恶意 Resolver、SSRF、DNS rebinding、redirect abuse 与 credential 泄漏；
- Query 泄露本地 Objective、客户、商业秘密或 Agent 身份；
- 通过 timing、digest、Relation graph 和 subscription pattern 推断私有 Mind；
- Sybil 节点、串谋信誉、eclipse routing 与虚假 authority；
- 超大 Bundle、订阅风暴、深层图与高成本 Resolver 造成拒绝服务；
- 权利洗白、未经许可的训练、再分发与跨域托管求值；
- 过时认知、选择性披露、撤回不传播与错误适用范围；
- 外部认知大量占据 Context，导致 attention pollution 或 personality drift。

默认策略应当是：最小查询、最小披露、离线解析、网络访问显式授权、导入内容隔离、吸收
事务化、权利默认拒绝、来源与 Outcome 可追溯。

## 十一、治理与经济关系

开放 Federation 需要在“任何人可以实现协议”和“任何人可以使用任何认知数据”之间划出
清晰边界。协议开放不自动授予数据、商标、专利、兼容性标识或服务访问权。

未来治理需要分别解决：

- 规范与参考实现如何演进；
- authority domain、key rotation 与兼容性标识；
- Bundle 与 Frame 的许可、权利和隐私表达；
- 跨节点贡献的署名、收益和责任；
- Resolver、subscription、分布式激活、群体计算与验证服务的计费；
- 训练使用与认知衍生品的授权和收益分配；
- 恶意节点、协议滥用与争议处理。

经济激励可以促使节点贡献高价值认知、证据和验证能力，但支付不能替代真实性判断。一个
认知市场必须先有身份、证据、权利、Outcome 和责任结构，价格才具有可解释基础。

## 十二、产品落地方向

### 12.1 专业认知网络

人类专家、领域 Agent 与企业私有数据共同形成长期 Mind Frame。参与者可以发布经过选择的
领域认知，其他 Agent 基于证据、适用范围与 Outcome 进行吸收和派生。

### 12.2 企业认知联邦

企业内部多个团队或业务 Agent 保持权限隔离，同时交换获批认知投影。跨企业合作可以共享
项目所需知识，而不开放完整 Context、客户数据或内部操作权限。

### 12.3 Agent + Human 能力与招聘

候选人的能力不再只由人类记忆中的知识表示，而可以由 Agent + Human 的可验证执行轨迹、
认知资产、权限边界和实际 Outcome 共同表示。组织吸收的是一组可审计的协作能力，而不是
一段无法验证的自我陈述。

### 12.4 研究与认知复现

研究 Agent 可以交换带证据、反例、修订和实验 Outcome 的认知子图。复现不只下载论文文本，
而是检查认知如何形成、在何种条件下成立以及后续如何被修订。

### 12.5 具身智能与分布式实践

机器人和 Edge Agent 可以把物理实践形成的认知投影发布给其他节点。接收方结合自己的
环境、能力和安全策略吸收，而不是直接复制远端控制指令。由此，LLM 意识、分布式协作与
物理载体形成可验证的实践反馈网络。

## 十三、对 Morphz 的战略意义

Morphz 的目标不是只提供一个更强的单点 Agent Runtime，而是为大量 Agent 之间的协作关系
提供稳定的认知基础设施。Structured Context 使认知具有结构；Agent Trajectory 记录认知
与实践之间的因果转换；Cognitive Application 定义可复用实践；Yao 为模型与 Runtime 提供
共同求值语言；MFX 使认知能够跨越 Agent 边界；Union Mind Federation 则把这些能力扩展成
长期协作网络。

这一方向对应公司的愿景：**从智能系统走向智能社会。** 这里的“智能社会”首先意味着，
Agent 能够在身份、证据、权利、责任和共同规则之下进行更好的协作。社会级智能是否进一步
涌现，是长期发展的结果，不是当前产品必须预设的承诺。

开放 Morphz 节点的价值也因此更加明确：节点不是单纯复制一份 Runtime，而是可以加入一个
共同协议定义的认知协作层。网络实现越丰富、参与权威越多，MFX 的交换语言、验证工具和
Federation 控制面越有价值。

## 十四、演进路线

### 阶段 0：MFX Core

- 完成 Bundle Schema、Exporter、Verifier 与 Importer；
- 支持离线解析、隔离、显式权利和本地 adoption lineage；
- 建立一致性夹具与恶意输入测试。

### 阶段 1：Remote Resolver

- 定义 Resolver request/response、签名与 capability negotiation；
- 实现 endpoint allowlist、SSRF 防护、最小凭据和审计；
- 验证 Resolver 离线不影响 Bundle Core。

### 阶段 2：Subscription

- 定义 revision cursor、update feed、withdrawal 与重新求值；
- 确保订阅不会获得远程写权；
- 处理断线、重放、去重、限流与隐私泄露。

### 阶段 3：Distributed Sparse Cognitive Activation

- 定义最小请求 Envelope、能力发现和 Interaction Router；
- 构建领域、权利、成本、延迟与 Outcome 感知的 Agent/Frame 稀疏激活；
- 分别支持返回已有认知和启动新的远端 Evaluation。

### 阶段 4：Collective Evaluation and Deliberation

- 定义方案、prediction、counterexample、Verifier 与多轮商议的贡献图；
- 验证专家委员会、全网广播、对抗式辩论和分层汇总；
- 建立预算、署名、信誉、激励与责任机制。

### 阶段 5：Collective Settlement and Union Mind

- 分离 Semantic Settlement 与 State Consensus；
- 根据部署信任模型评估 crash fault、BFT、联盟链与开放区块链方案；
- 定义 Union-owned Frame、quorum certificate、revision 与 Outcome 修订；
- 在真实企业、专业网络和具身场景中验证长期协作。

每个阶段都必须能够独立产生价值和验证证据。远期愿景不能成为绕过当前安全、权利、
一致性或产品验证的理由。

## 十五、近期决策边界

当前可以确立：

- MFX 是认知交换物的协议基础；
- Bundle Core 离线可解析，Remote Resolver 永远是可选能力；
- Importer 不自动访问 URL，不自动执行内容，不自动吸收认知；
- 吸收后接收方可以使用该认知进行思考，但使用的是带源血缘的本地 Frame；
- Remote 可以声明可求证能力，调用仍由接收方策略与授权决定；
- Shared Mind Projection 是有界认知视图，不等于完整 Mind 合并；
- 全局共享首先意味着全局可寻址和可查询，激活采用分布式稀疏方式；
- 联邦交互同时支持认知交换和新的远端计算；
- Semantic Settlement 与 State Consensus 是不同问题；
- Union Mind 使用 Federation 保留多权威，不把所有 Mind 合并成一个数据库；
- Shared Live Context 是共同权威下的强协作模式，不是跨域默认语义。

当前不应提前固化：

- 全局信誉算法；
- 自动语义合并；
- 统一认知定价；
- 全局唯一 Directory；
- Federation 的中心化运营主体；
- 固定的投票、BFT 或区块链算法；
- 跨域实时一致性；
- 社会智能或集体意识的技术承诺。

## 十六、战略表述

> **MFX 让认知可以被交换；Distributed Sparse Cognitive Activation 让网络能够按需组织
> 大规模认知与计算；Union Mind Federation 让彼此独立的 Agent 能够长期共同发展认知。
> 它不消灭边界，而是把身份、证据、权利、差异和责任带入协作。**

当大量 Agent 开始参与真实实践，真正稀缺的将不只是模型能力，而是认知如何跨主体流动、
如何被验证、如何获得使用权、如何被结果修正，以及谁对它负责。联合大脑就是 Morphz 对
这一未来协作层的长期回答。
