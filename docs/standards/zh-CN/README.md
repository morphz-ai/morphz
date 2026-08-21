# Morphz 技术标准

> 状态：标准草案工作区
>
> 标准维护者：新变元（Newvar）
>
> 规范文本语言：英文
>
> 最后更新：2026-08-21
>
> 规范文本：[English](../README.md)

本目录包含 Morphz 用来定义、实现和验证 Structured Context、Agent Trajectory、
Cognitive Application、可移植 Harness 执行与 Yao 的公开技术基础。

## 命名角色

- **结构化上下文（Structured Context）**是与具体实现无关的技术类别；
- **Morphz 结构化上下文**是由新变元维护的标准族；
- **Agent Trajectory（Agent 执行轨迹）**是 Agent 经验的可移植因果状态转换记录，不是
  Event History、可观测性 Trace 或聊天记录的同义词；
- **Cognitive Application（认知应用）**是面向产品与生态的单元，把可复用的认知实践
  提供给既有 Agent；挂载认知应用不会创建或替换 Agent 身份；
- **Harness** 是《Morphz Harness 规范》定义的可移植 Evaluation Loop 与实践契约抽象；
- **HNS** 是 `.hns` Harness Package 分发 Profile；**Yao** 是其当前源语言；
- **Morphz Runtime** 是新变元的官方参考实现，不是标准本身；
- **Morphz SC Compatible** 是保留的未来兼容性标识，只有在商标政策发布且取得符合要求
  的一致性证据后才能使用。

独立实现无需复制 Morphz Runtime 内部结构，只需满足标准规定的可观察语义。本 Draft
有意在标准族名称中保留 Morphz，同时保持技术类别与一致性语义不依赖具体实现。

## 结构化上下文交付物

1. [《结构化上下文宪法 v1》](structured_context_constitution_v1.md)
   定义这一技术类别保持其身份所需的稳定原则。
2. [《Morphz 结构化上下文规范 v1》](morphz_structured_context_specification_v1.md)
   定义规范性的对象模型、权责边界、事务与可观察语义。
3. [《Morphz 一致性测试套件 v1》](morphz_conformance_suite_v1.md)
   定义独立实现如何证明自身兼容性。

## Agent Trajectory 交付物

1. [《Morphz Agent Trajectory 规范 v0.1》](morphz_agent_trajectory_specification_v0_1.md)
   定义 Agent 经验的可移植状态转换、因果、权威、Outcome、Verifier、Reward、数据权利、
   评测与训练语义。

## Harness 交付物

1. [《Morphz Harness 规范 v0.1》](morphz_harness_specification_v0_1.md)
   定义 Harness 的可移植执行语义、控制边界、精确 Binding 与生命周期。
2. [《HNS 包格式规范 v0.1》](hns_package_format_specification_v0_1.md)
   定义 `.hns` 的物理形态、逻辑 Artifact、归一化、身份和 Loader 行为。

## Yao 语言交付物

1. [《Yao 核心语言规范 v0.1》](yao_core_language_specification_v0_1.md)
   定义与实现无关的类型语言、Effect、结构化并发和 Program Value。
2. [《Yao 求值语义 v0.1》](yao_evaluation_semantics_v0_1.md)
   定义模型与 Runtime 所有的求值、持久 Lowering、恢复和失败语义。
3. [《Yao Morphz Runtime Profile v0.1》](yao_morphz_runtime_profile_v0_1.md)
   定义 Morphz Host Object、Effect、Capability Settlement、Lowering Target 与资源限制。
4. [《Yao 参考实现验证记录 v0.1》](yao_reference_implementation_verification_v0_1.md)
   把 Draft 要求映射到可执行证据，并记录仍待补齐的实现缺口。

[项目治理](../../../GOVERNANCE.zh-CN.md)与
[MEP-0001](../../meps/zh-CN/MEP-0001-specification-governance.md)定义全部标准与官方实现如何演进。
[知识产权状态说明](IPR_STATUS.md)记录 Draft 阶段临时的著作权、专利、贡献和商标边界。

## 权威顺序

结构化上下文的规范权威顺序由宪法第 4 节定义。以下仅作非规范性的索引摘要：

1. 宪法；
2. 当前处于 Final 状态的结构化上下文规范；
3. 与规范版本对应的一致性测试套件；测试套件可以验证规范，但不能重新定义规范；
4. 已接受的 Standards Track MEP，但仅限已纳入带版本规范发布的部分；
5. 官方参考实现 Morphz Runtime；
6. 解释性设计文档与示例。

在 Harness 宪法或等价治理文件被采纳前，Harness 标准族中的冲突按以下顺序解决：

1. 当前处于 Final 状态的 Morphz Harness 规范；
2. 对于 `.hns` Package 主张，与其匹配且处于 Final 状态的 HNS 包格式规范；
3. 与规范版本对应的 Harness 一致性测试套件；测试套件可以验证规范，但不能重新定义规范；
4. 已接受的 Standards Track MEP，但仅限已纳入带版本规范发布的部分；
5. 官方参考实现 Morphz Runtime；
6. 解释性架构文档与示例。

在专门的 Agent Trajectory 宪法或等价治理文件被采纳前，其标准族中的冲突按以下顺序
解决：

1. 当前处于 Final 状态的 Morphz Agent Trajectory 规范；
2. 与其匹配的 Agent Trajectory 一致性套件与 Profile 文档；它们可以验证规范，但不能
   重新定义规范；
3. 已接受的 Standards Track MEP，但仅限已纳入带版本规范发布的部分；
4. Morphz Runtime 及其官方 Exporter，作为参考实现；
5. 解释性架构文档、Dataset 与示例。

MEP 用于记录和批准变更，但只有当变更写入带版本的宪法或规范版本后，才成为规范性要求。

在这些文档退出 Draft 状态之前，源码、数据库契约测试和
[Runtime 实现状态总览](../../morphz_runtime_core_implementation_status_v1.md)仍然是判断 Morphz Runtime 当前已实现能力的权威依据。它们不会覆盖 Draft 的评审目标，也不会让实现细节自动成为规范要求。草案中的要求不能证明实现已经满足该要求。

## 语言与发布

英文是这些 Draft 标准的规范文本语言，本目录是与其同步维护的中文翻译。如果中英文含义发生冲突，以对应版本的英文规范为准。翻译不得静默改变规范含义。

## 非规范性路线图

[《Morphz 标准与互操作路线图 v1》](../../roadmap/morphz_standards_and_interoperability_roadmap_v1.md)
说明项目计划如何逐步建设 Agent Trajectory、Outcome / Verifier、参考环境、独立实现和扩展接口。
路线图不创建一致性义务，也不覆盖本目录中的规范权威顺序。
