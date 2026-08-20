# MEP-0001：规范治理与 MEP 流程

- 状态：Draft
- 类型：Process
- 作者：新变元（Newvar）
- 创建日期：2026-08-21
- 自举文档集：宪法 v1 Draft、Governance Draft、规范 v1 Draft、测试套件 v1 Draft
- 规范文本语言：英文
- 规范文本：[English](../MEP-0001-specification-governance.md)

> 翻译说明：本文件是英文 MEP 的中文翻译；如含义冲突，以相同版本的英文文本为准。

## 1. 摘要

本提案确立 Morphz Enhancement Proposal（MEP）作为变更结构化上下文标准、兼容性规则、
核心架构与项目治理的持久流程。

MEP 允许社区成员参与塑造 Morphz，同时避免核心语义演进沦为没有记录的公司内部决策，
也避免项目变成没有边界的仓库投票。

## 2. 初始自举

首版宪法、Governance 文档、MEP-0001、Draft 规范和 Draft 一致性测试套件，由新变元作为
创始维护者同时通过。这样解决“流程必须先存在，才能通过流程自身”的循环依赖。

自举通过不会让 Draft 规范进入 Final，不会建立兼容性声明，也不会授予知识产权。
自举文档集通过后，后续所有变更都必须遵守它建立的流程与权威规则。

## 3. 何时需要 MEP

以下变更需要 MEP：

- 宪法修正；
- 新增或修改规范性结构化上下文行为；
- 破坏兼容性的公共 API、线协议、持久化或兼容性变更；
- 新的一致性 Profile 或兼容性声明规则；
- 稳定的跨模块扩展点；
- 对治理、Maintainer 权力或 MEP 流程本身的变更；
- Project Lead 指定为影响整个生态的决策。

以下变更通常不需要 MEP：

- 恢复规范既有行为的 Bug Fix；
- 不影响可观察语义的实现重构；
- 在稳定扩展边界内增加单个 Provider、Target、Harness、UI 或文档；
- 具有显式命名空间且不参与兼容性声明的实验。

## 4. MEP 类型

- **Constitutional**：修改宪法原则。
- **Standards Track**：修改规范性行为、兼容性或一致性 Profile。
- **Architecture**：建立稳定的跨模块设计或扩展边界。
- **Process**：修改治理、贡献、发布或 MEP 流程。
- **Informational**：记录指导或理由，不创设规范要求。

## 5. 文档必备章节

每份非 Informational MEP 必须包含：

1. 摘要与动机；
2. 当前行为与问题定义；
3. 提议语义；
4. 权责与安全影响；
5. 知识产权与专利影响；
6. 兼容性和迁移方案；
7. 参考实现计划；
8. 一致性测试与评测计划；
9. 被拒绝的替代方案；
10. 尚未解决的问题；
11. 上线和回滚条件。

Standards Track MEP 在规范变更、Morphz Runtime 变更和必需的一致性用例合入之前，不能
进入 Final；除非 MEP 明确定义了分阶段激活版本。影响必要专利权利要求、许可、兼容性
标识或贡献者承诺的变更，在进入 Final 前还必须发布相应政策更新。

## 6. 生命周期

```text
Idea → Draft → Discussion → Accepted → Final
                  ├────────→ Rejected
                  └────────→ Withdrawn
Final ──────────────────────→ Superseded
```

- **Idea**：非正式 Issue 或 Discussion；无需 MEP 编号。
- **Draft**：内容足以开始架构评审，并已分配 MEP 编号。
- **Discussion**：责任 Maintainer 已启动正式评审。
- **Accepted**：语义方向获得批准；实现仍可能尚未完成。
- **Final**：全部激活要求均已满足。
- **Rejected**：经过评审后被拒绝，并记录理由。
- **Withdrawn**：作者在最终决策前撤回。
- **Superseded**：被更新的 Final MEP 取代。

Draft 或 Accepted 文本即使已经合入，也不会自动成为规范要求。只有最终形成的带版本
宪法或规范发布才能确立规范行为。

## 7. 提交与评审

1. 作者首先创建 Issue 或 Discussion，验证提案范围并寻找 Sponsor Maintainer。
2. Sponsor Maintainer 分配下一个 MEP 编号。
3. 作者在 `docs/meps/` 下提交文档。
4. Core Maintainer 对提案分类，并确定受影响的规范和一致性章节。
5. 正式 Discussion 保持一段合理评审时间。Standards Track 提案默认评审十四个自然日；
   在第一个稳定版本发布前，Project Lead 可以缩短评审期，但必须记录理由。
6. 责任 Maintainer 汇总反对意见、替代方案和必要变更。
7. 对应批准主体更新状态并记录决定。

评审依据技术价值、宪法一致性、兼容成本、证据、安全、知识产权影响和生态影响，不由
评论数量或简单多数票决定。

## 8. 批准权力

| MEP 类型 | 所需批准 |
| --- | --- |
| Informational | Sponsor Maintainer |
| Architecture | 责任 Module Maintainer 加一名 Core Maintainer |
| Standards Track | Core Maintainer 评审加 Project Lead 批准 |
| Process | Core Maintainer 评审加 Project Lead 批准 |
| Constitutional | Core Maintainer 评审加 Project Lead 显式批准 |

Project Lead 可以委托常规 Architecture 决策，但不能静默委托宪法、官方兼容标识或官方
发布身份的所有权。

## 9. 勘误与权威解释

疑似错误和歧义必须记录在公开 Issue 或勘误注册表中，并链接到受影响的文档版本。

- Maintainer 可以合并不会改变一致实现行为的编辑性修正。该变更必须记录为勘误，并
  纳入下一个 Patch 发布。
- 可能改变实现行为或一致性结果的歧义需要公开解释。Project Lead 可以在 Core
  Maintainer 评审后发布有记录的临时解释。
- 增加或改变规范要求、Profile 归属、线协议行为或兼容性结果的解释，需要 Standards
  Track MEP 和带版本的规范发布。临时解释不得静默重新定义已经发布的版本。

## 10. 社区作者身份与维护

MEP 的作者身份属于文档中记录的作者，而不是 Sponsor Maintainer。后续修订必须保留有
实质贡献的共同作者。已接受 MEP 应当标识其实现和一致性覆盖的维护者。

作者不会永久单方面控制由提案形成的标准。他们获得可被识别的作者身份，并可以通过
持续工作获得范围明确的 Maintainer 权力。

## 11. 实验性扩展

如果满足以下条件，实验可以在 MEP 被接受前进行：

- 使用显式实验命名空间或 Feature Gate；
- 不声明稳定兼容性；
- 默认不改变既有规范行为；
- 公开移除或迁移预期。

成功的实验在成为稳定标准一部分之前必须完成 MEP 流程。

## 12. 紧急变更

为控制正在发生的安全、数据丢失或生态完整性事件，Project Lead 和 Security Team 可以
暂时修改或禁用行为。变更必须限制在必要范围内。

当公开披露变得安全后，项目必须发布受影响的规范要求、决策理由、兼容性影响，以及
回顾性 MEP 或回滚方案。

## 13. 理由

Morphz 同时需要一致性与参与。完全私有的控制会让公开标准失去可信度；不受限制的
投票则会让早期核心语义受短期多数和不兼容实现影响。

因此，MEP 流程为贡献者提供可见的作者、评审和范围化权力路径，同时让新变元继续对
官方结构化上下文标准与 Morphz Runtime 的一致性承担责任。
