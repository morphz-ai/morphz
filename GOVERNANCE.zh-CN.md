# Morphz 项目治理

> 状态：在公开开源前等待采纳的草案
>
> 项目维护者：新变元（Newvar）
>
> 规范文本语言：英文
>
> 日期：2026-08-21
>
> 规范文本：[English](GOVERNANCE.md)
>
> 翻译说明：本文件是英文治理文件的中文翻译；如含义冲突，以相同版本的英文文本为准。

## 1. 治理模式

在项目形成阶段，Morphz 采用创始团队主导的开放治理（founder-led open governance）。讨论、提案、决策理由和兼容性影响保持公开；新变元和 Project Lead 对结构化上下文核心标准与官方发布承担最终责任。

代码依据正式采用的开源许可证发布后，该许可证决定使用、研究、修改和 Fork 代码的
权利。开源发布不意味着所有技术决策都通过投票产生，不转让 Morphz 商标，不产生正式
专利政策以外的承诺，也不会让某个 Fork 自动成为 Morphz 官方发布。

这一模式旨在保持核心语义一致，同时为持续贡献者提供真实、明确的权力路径。

## 2. 项目权力主体

### 新变元

新变元是项目创始维护者，负责：

- Morphz 名称、标识、域名和官方项目身份；
- 官方代码仓库、文档网站、注册表和发布基础设施；
- 发布签名密钥与兼容标识；
- 发布和维护源代码、规范文本、专利、贡献与商标政策；
- 任命 Project Lead 和初始 Core Maintainer；
- 最终维护结构化上下文宪法和公开规范。

### Project Lead

Project Lead 对以下事项拥有最终决策权：

- Constitutional MEP 和 Core Specification MEP；
- 官方版本的范围和发布时间；
- 责任 Maintainer 无法解决的争议；
- 紧急安全与兼容性决策；
- 任命或移除 Core Maintainer，并公开记录理由。

Project Lead 应当寻求粗略共识（rough consensus）。如果最终决定推翻了 Maintainer 中明显占优的共识，则必须记录决策理由。

## 3. 贡献者角色

### Contributor

任何通过 Issue、讨论、文档、测试、设计、代码或社区支持参与项目的人。

### Reviewer

获得信任、可以评审特定领域的 Contributor，但仍需责任 Maintainer 批准才能合并变更。

### Module Maintainer

对明确模块或扩展面拥有合并权限的 Contributor，例如 Provider、Execution Target、Harness、存储 Adapter、SDK、UI、Eval 或文档领域。

### Core Maintainer

被信任评审结构化上下文语义、Runtime 权威、事务、Event/Projection 行为、兼容性和发布关键基础设施的 Maintainer。

### Project Lead

承担上一节所定义架构和发布责任的最终权力主体。

角色通过持续展现判断力、评审质量、可靠性和对公开宪法的遵守而获得。受雇于新变元既不会自动满足要求，也并非所有角色的必要条件；但新变元继续保留第二节所列的项目维护权。

## 4. 按变更类型划分的权力

| 变更 | 通常所需批准 |
| --- | --- |
| 拼写、示例或不影响语义的文档 | 对应领域 Maintainer |
| 不影响协议的独立 Bug Fix | Module Maintainer |
| Provider、Target、Harness、UI、SDK 或 Adapter 扩展 | 相应 Module Maintainer |
| 新的公开扩展点 | Core Maintainer；影响全生态时需要 MEP |
| 结构化上下文规范行为 | 已接受 MEP 加 Core Maintainer 评审 |
| 宪法或治理 | 专项 MEP 加 Project Lead 批准 |
| 官方发布与兼容标识 | Project Lead 或获得委托的 Release Maintainer |
| 处于保密期的安全响应 | Security Team 依据紧急流程处理 |

实现 Pull Request 不能静默改变规范要求。核心行为变更必须同时更新规范、一致性覆盖和迁移声明。

## 5. Morphz 增强提案

影响以下内容的变更需要 MEP：

- 宪法原则；
- 公开的结构化上下文语义；
- 兼容性或版本协商；
- 跨模块架构和稳定扩展边界；
- 一致性 Profile 或官方声明规则；
- 项目治理。

普通实现工作不需要 MEP。完整流程见
[MEP-0001](docs/meps/zh-CN/MEP-0001-specification-governance.md)。

## 6. 解释与勘误

宪法定义规范权威顺序。疑似错误和歧义遵循
[MEP-0001](docs/meps/zh-CN/MEP-0001-specification-governance.md) 中的公开流程。

只有在不改变一致实现行为时，责任 Maintainer 才可以批准编辑性修正。可能影响行为或
兼容性的解释，需要 Core Maintainer 评审和持久的公开记录。规范变更需要 Standards
Track MEP，以及带版本的规范或测试套件更新。

## 7. 贡献者获得权力的路径

Morphz 希望让参与上游协作比维护一个分裂的 Fork 更有价值。因此，项目应该提供：

- 及时的公开评审，以及待处理工作的明确责任人；
- 在 MEP、版本发布和重要文档中保留作者署名；
- 向经过验证的 Module Maintainer 提供范围明确的合并权限；
- 官方扩展注册表和兼容性矩阵；
- 清晰的晋升和不活跃规则；
- 从扩展维护进入 Core Maintainer 评审职责的路径。

权力按照范围授予，而不是非此即彼。优秀的 Provider Maintainer 不必控制核心 Context 语义；Core Maintainer 也不会自动控制每个社区模块。

## 8. 核心与扩展边界

核心包括宪法、规范性的结构化上下文语义、Context Transaction、Event/Projection 权威、因果路由、兼容性，以及验证这些内容所需的最小参考 Runtime。

Provider、Execution Target、Harness、领域包、存储 Adapter、SDK、UI、部署和 Eval 属于扩展面，除非一份处于 Final 状态的 MEP 将其中某项具体语义要求纳入核心。

扩展可以快速演进。核心应当缓慢变化，并且只有在具备规范证据、一致性用例和迁移分析时才改变。

## 9. 发布与官方身份

官方发布必须：

- 来自新变元控制的官方仓库；
- 标识源码 revision 和所适用的规范版本；
- 通过官方发布流程签名；
- 发布兼容性说明和迁移说明；
- 通过对应版本要求的测试和一致性门槛。

Fork 可以依据正式采用的开源许可证条款使用代码，但不得把自己描述为 Morphz Runtime
官方发布，也不能在商标政策规定的范围之外使用兼容标识。

## 10. 透明度与利益冲突

如果某项提案会使 Maintainer 自己的商业服务、雇主或实现获得特殊利益，Maintainer 必须披露重大利益冲突。发生冲突并不自动取消其评审资格，但决策和额外评审者必须保持可见。

对于仍在保密期的安全报告、个人行为问题、法律义务和未发布凭证，可以进行私下讨论。在保密需求结束后，语义和兼容性决策必须回到公开的持久记录。

## 11. 不活跃与移除

Maintainer 身份代表当前承担的责任，而不是永久所有权。持续不活跃的 Maintainer 可以转为 Emeritus 状态。因安全、行为或反复违反项目责任而移除 Maintainer，需要 Project Lead 作出有记录的决定；敏感个人细节无需公开。

## 12. 未来治理

项目不宣称创始团队主导的治理模式永久不变。当生态采用使中立性比早期集中一致性更有价值时，未来 MEP 可以引入技术指导委员会、独立标准组织或基金会。

贡献者数量、融资或经过的时间都不会自动触发治理转型。转型需要显式提案，明确商标、发布、规范和基础设施权力如何安排。
