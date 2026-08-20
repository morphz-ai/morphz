# Morphz 标准与互操作路线图 v1

> 状态：公开路线图草案，非规范性文件
>
> 日期：2026-08-21
>
> 项目维护者：新变元（Newvar）
>
> 适用范围：Morphz 结构化上下文标准族、参考实现、参考环境与扩展接口

## 1. 目的

Morphz 希望让长期运行的 Agent 系统能够在不同模型、进程、存储、工具和执行节点之间保持稳定、可审计的认知与因果语义。

本路线图说明项目准备如何逐步建设：

- 实现无关的结构化上下文标准；
- 可移植的因果实践记录；
- 可复核的结果与验证契约；
- 可复现的 Agent 参考环境；
- Context Storage 与 Execution Target 扩展接口；
- 支持独立实现的兼容性与治理体系。

路线图表达方向和交付顺序，不创建兼容义务。规范要求只由对应版本的 Constitution、Final Specification 与 Conformance Profile 确定。

## 2. 项目角色

Morphz 采用以下命名边界：

- **结构化上下文（Structured Context）**：实现无关的技术类别；
- **Morphz 结构化上下文**：由新变元维护的标准族；
- **Morphz Runtime**：官方参考实现；
- **Morphz 参考环境**：使用版本化任务、工具、权限、fixture 和验证器运行可复现实践的环境；
- **兼容实现**：满足相应标准和公开一致性 Profile 的独立实现。

标准与参考实现相互促进，但各自承担不同职责。标准定义可观察语义，参考实现提供工程证据，独立实现帮助发现规范中的隐含假设。

## 3. 设计原则

### 3.1 上下文是第一等状态

Context 具有稳定身份、版本和独立于单次模型请求的生命周期。认知状态的变化通过显式事务发生，并保留来源、冲突和恢复路径。

### 3.2 Agent 语义与 Runtime 事实分离

Agent 决定认知内容的意义；Runtime 维护身份、权限、事件顺序、直接因果、事务结果、工具结果和资源边界。该分离使模型可以更换，同时保持运行事实可审计。

### 3.3 因果关系跨实现可表达

不同系统可以采用不同调度器和存储结构，同时使用共同模式表达一次实践的目标、尝试、求值、行动、证据、结果和验证过程。

### 3.4 兼容性由可观察行为证明

兼容实现无需复制 Morphz Runtime 内部结构。公开规范和一致性套件共同定义可验证边界，测试套件用于验证规范，不独立创造规范要求。

### 3.5 开放演进保留稳定核心

SC-Core 缓慢演进；Provider、Execution Target、Storage Adapter、Harness、SDK、UI 和 Eval 等扩展面可以更快发展。影响公共语义的变更通过 MEP 留下理由、兼容分析和迁移记录。

### 3.6 数据权利与代码许可分离

代码开源不会改变用户对 Mind、Event、业务内容和实践轨迹的权利。任何遥测、轨迹上传、评测贡献或训练用途都需要明确的范围、授权和数据处理说明。

## 4. 已有公开基础

当前标准工作区已经包含：

1. [《结构化上下文宪法 v1》](../standards/zh-CN/structured_context_constitution_v1.md)：定义技术类别的稳定原则；
2. [《Morphz 结构化上下文规范 v1》](../standards/zh-CN/morphz_structured_context_specification_v1.md)：定义对象模型、权责边界、事务和可观察语义；
3. [《Morphz 一致性测试套件 v1》](../standards/zh-CN/morphz_conformance_suite_v1.md)：定义独立实现如何证明兼容；
4. [项目治理](../../GOVERNANCE.zh-CN.md)：定义新变元、Project Lead、Maintainer 和 Contributor 的公开权责；
5. [MEP-0001](../meps/zh-CN/MEP-0001-specification-governance.md)：定义标准与参考实现如何演进。

这些文件当前仍为 Draft。Runtime 源码、数据库契约测试和实现状态文档继续负责说明“现在已经实现了什么”；标准草案负责说明“候选规范希望稳定什么”。

## 5. 工作流 A：SC-Core 与一致性

### 5.1 目标

SC-Core 为结构化上下文实现建立最小共同语义：

- 稳定的 Agent、Context、Session、Principal 和 Event 身份；
- Event History、Kernel、Mind、Inbox 与 Projection 的边界；
- Frame、Relation、来源和 Attention 生命周期；
- Context Transaction、revision、原子提交与冲突拒绝；
- 可恢复历史与可审计权威；
- 跨 Session 并发下的因果和事务约束。

### 5.2 近期交付

- 为每项规范要求建立 requirement id；
- 建立 requirement、测试用例与实现证据映射；
- 明确 SC-Core 与可选 Profile；
- 补充错误分类、版本协商和迁移语义；
- 对 Draft 中尚未实现的要求保持显式标记；
- 发布机器可读的一致性结果格式。

### 5.3 进入 Beta 的证据

- 规范要求具有对应测试或明确的非测试验证方法；
- 官方参考实现通过声明的 Core Profile；
- 至少完成一次不依赖内部表结构的兼容实现试验；
- 已知歧义和实现差异具有公开记录；
- 版本升级与不兼容变更路径可执行。

## 6. 工作流 B：Causal Trace Profile

### 6.1 目标

不同运行时可以使用不同调度策略，但仍应能够交换和审计一次实践的因果结构。Causal Trace Profile 准备定义：

- Agent、Principal、Context 与 Session；
- Objective、Attempt 与 Evaluation；
- stable id、root、causal parent 与 trigger event；
- 输入、Observation、工具调用与工具结果；
- 权限范围、Execution Target 与执行来源；
- evidence、verifier result 与 external outcome；
- 时间、逻辑顺序、资源消耗和模型声明；
- 导出版本、数据许可和脱敏状态。

### 6.2 Objective、Attempt、Evaluation 与 Episode

这些对象承担不同职责：

| 对象 | 含义 |
| --- | --- |
| Objective | 稳定的意图、约束与责任单位 |
| Attempt | 完成 Objective 的一次有边界尝试 |
| Evaluation | Runtime 针对活动 Session 进行的一次决策或执行周期 |
| Episode | 面向重放、评测或训练导出的因果片段 |

一个 Objective 可以包含多个 Attempt、子 Objective 和重启恢复过程。Episode 可以覆盖一个或多个相关 Attempt，但必须保留切分规则和跨片段因果引用。

### 6.3 内部记录与交换格式

Morphz Event Store 是参考实现的权威记录。公共 Trace Bundle 是跨实现交换格式。二者通过确定性 exporter 连接，而不要求外部实现采用 Morphz 的数据库 Schema。

公开 Bundle 预计包含：

- schema 与 Profile 版本；
- 来源实现和运行版本；
- 稳定身份与因果引用；
- 允许公开的输入、行动、结果和验证事实；
- 内容摘要、完整性信息或签名；
- 裁剪、脱敏和许可声明；
- 无法导出或无法确定的字段说明。

## 7. 工作流 C：Outcome 与 Verifier Contract

### 7.1 目标

Agent 系统需要区分“行动被执行”“验证器通过”和“现实目标达成”。Morphz 准备建立结构化契约来记录这些差异。

### 7.2 结果层次

```text
Runtime fact
  事务、权限、事件、工具和状态转换的机械事实

Verifier result
  某个带身份和版本的验证器对声明范围给出的结果

Agent judgment
  Agent 对 stated objective、约束和证据的语义审查

External outcome
  现实系统、用户或后续事件返回的结果
```

`evidence_refs` 可验证引用是否存在且时序合法；测试可以验证声明测试集；Runtime 可以验证状态转换。上述信号各自保留范围，不自动合并成跨领域通用 Reward。

### 7.3 计划交付

- Outcome Contract Schema；
- Verifier Manifest 与 Verifier Result Schema；
- deterministic、semantic、human 和 external 验证类型；
- evidence consumed 与 execution provenance；
- pass、fail、indeterminate 和 invalidated 状态；
- 成本、延迟、安全和合规等多维结果；
- 由特定 Benchmark Profile 定义的可选 Reward Policy。

Reward Policy 是对结果事实的特定用途映射。SC-Core 保存和传递事实，不替所有领域定义统一价值函数。

## 8. 工作流 D：Morphz 参考环境

### 8.1 目标

参考环境把 Runtime 能力组织成可复跑、可比较的实践单元。每个 Environment Version 预计声明：

- 适用的规范和 Profile；
- 初始状态、fixture 与依赖版本；
- 可用工具、Execution Target 和权限；
- 模型、Provider 与允许变化的参数；
- Token、时间、成本和资源预算；
- 时间、随机性和外部服务处理方式；
- 终止条件和 Verifier Bundle；
- Trace 导出、脱敏和数据许可策略。

### 8.2 可比性

可比结果需要引用完整的 Environment Version、任务版本、验证器版本和运行来源。第三方可以在不同基础设施或兼容实现中复跑相同环境，并公开说明允许的差异。

参考环境提供公共协调点，而不要求所有任务通过一个中心服务运行。

### 8.3 近期交付

- Environment Manifest Schema；
- 最小 fixture 格式；
- Verifier Bundle；
- Trace Bundle exporter；
- 官方基线与至少三类对照；
- 可机器读取、可签名的 Result Bundle；
- 复现说明、污染声明和 Benchmark gaming 政策。

## 9. 工作流 E：扩展接口

### 9.1 Context Storage

候选 Context Storage Interface 将围绕语义能力而不是数据库 API 定义：

- Event append 与 Projection 维护；
- revision、事务、冲突和 fence；
- 恢复、备份、迁移和一致性声明；
- capability discovery 与版本协商；
- 故障行为与可观察诊断；
- Storage Profile 一致性测试。

### 9.2 Execution Target

候选 Execution Target Interface 将覆盖：

- Target 身份、发现和 pairing；
- capability lease、撤销与过期；
- 输入、输出、错误和副作用声明；
- 幂等、重试、超时和恢复；
- 本地、边缘、云和物理设备实现；
- Target Provider 一致性测试。

### 9.3 其他扩展面

Provider、Harness、SDK、UI、Eval 和领域包继续作为模块化扩展发展。经过多个实现验证、影响跨模块互操作的语义，可以通过 MEP 提议进入标准 Profile。

## 10. 独立实现与互操作

Morphz 欢迎不复制官方 Runtime 内部结构的兼容实现。项目计划通过以下方式降低实现门槛：

- 将规范要求与源码位置分离；
- 提供最小 Profile 和协议示例；
- 发布机器可读测试向量；
- 提供实现者报告模板；
- 记录规范歧义、实现差异和迁移决定；
- 为 Provider、Target、Storage 和 Eval 提供模块维护路径；
- 在官方兼容矩阵中列出通过相应 Profile 的实现。

第二实现者的价值在于检验标准是否真正独立，而不是要求实现采用相同语言、部署方式或内部抽象。

## 11. 兼容声明与官方身份

官方发布和兼容实现属于不同概念：

- Morphz 官方发布由新变元控制的仓库和发布流程产生；
- 兼容实现依据公开 Profile 和一致性证据声明兼容；
- Fork 可以依据许可证存在，但不会自动成为官方发布；
- Morphz 名称、官方标识和未来兼容标识遵循单独的商标政策；
- 一致性测试能够验证规范，不评判 Agent 的通用推理质量或某项业务结果。

未来 `Morphz SC Compatible` 标识启用前，项目将公开商标使用条件、测试证据要求、版本范围、撤销条件和申诉路径。

## 12. 治理与贡献

项目形成阶段采用 founder-led open governance。新变元和 Project Lead 对核心标准及官方发布承担最终责任，同时通过公开 MEP、评审记录和角色路径支持外部参与。

贡献者可以参与：

- 规范问题、术语和示例；
- Conformance Test 与测试向量；
- Provider、Target、Storage、Harness、SDK 和 Eval；
- 独立实现报告；
- Environment、fixture 与 verifier；
- 安全、隐私、迁移和互操作分析；
- MEP 起草与公开评审。

贡献权力按范围授予。模块维护者可以负责明确扩展面；影响 SC-Core 和全生态兼容性的变更需要 Core Maintainer 评审和 MEP。

## 13. 安全、隐私与完整性

因果记录和实践 Episode 可能包含代码、凭证、客户数据、个人信息、业务决策和设备权限。公共格式与工具必须支持：

- 默认本地保留；
- 显式 opt-in 导出和上传；
- 字段级裁剪和脱敏；
- 内容摘要、来源与完整性信息；
- 数据许可、用途、保留期和删除声明；
- 第三方和客户权利检查；
- 防止验证器、fixture 和结果包携带秘密；
- 对数据投毒和 Benchmark 污染的检测与声明。

事件不可原地修改属于应用语义。需要更强篡改证据的 Profile 可以进一步定义哈希链、签名、外部时间戳或透明日志；实现不得在缺少相应机制时将普通数据库记录描述为密码学不可篡改。

## 14. 阶段与门槛

### 阶段 0：Draft 基础

- Constitution、Specification、Suite、Governance 与 MEP 完成公开评审；
- 规范、测试和当前实现状态之间建立可追踪关系；
- 许可证、贡献和商标政策在首次正式开源发布前锁定。

### 阶段 1：Causal Trace 与 Outcome

- 发布 Causal Trace Candidate Profile；
- 发布 Outcome / Verifier Candidate Schema；
- 实现可脱敏 Trace Bundle exporter；
- 用真实并发、恢复和失败记录验证表达能力。

### 阶段 2：参考环境

- 发布 Environment Manifest；
- 发布版本化 fixture、Verifier Bundle 和官方基线；
- 让第三方在独立环境中复跑并复算结果；
- 建立公开问题和差异报告。

### 阶段 3：独立实现与接口

- 至少一个不同内部结构的实现完成最小 Profile 试验；
- 发布 Context Storage 与 Execution Target Candidate Interface；
- 建立 Adapter 一致性 Profile 和兼容矩阵。

### 阶段 4：稳定发布

- 根据互操作证据修正规范；
- 公布版本与迁移策略；
- 评估 SC-Core 和成熟 Profile 的 Final 条件；
- 根据生态规模评估治理结构演进。

每一阶段以可复核证据为门槛，不以日期自动晋级。

## 15. 成功指标

这项路线图的成功体现为：

- 外部实现可以理解并实现核心可观察语义；
- 相同 Environment Version 能被第三方复跑；
- 不同实现能够交换和审计 Causal Trace Bundle；
- Verifier Result 可以由第三方复算并保留适用范围；
- Storage、Target 和其他扩展可以独立演进而不破坏 Core；
- Contributor 能够沿公开路径获得真实维护责任；
- 用户始终能够理解代码许可、项目身份、兼容声明和数据权利之间的区别。

Morphz 希望通过这些成果建立一个开放、可验证且能够长期演进的结构化上下文生态。

## 16. 反馈

在正式 Issue 与 Discussion 模板发布前，可以通过 Morphz 官方仓库提交：

- 规范歧义和互操作问题；
- Conformance Test 缺口；
- 独立实现意向；
- Environment、Verifier 或 Adapter 提案；
- 安全与隐私问题；
- MEP 草案建议。

涉及尚未公开的安全漏洞、个人数据或凭证时，应使用项目安全政策指定的私密渠道。
