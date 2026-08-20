# Morphz 结构化上下文标准

> 状态：标准草案工作区
>
> 标准维护者：新变元（Newvar）
>
> 规范文本语言：英文
>
> 最后更新：2026-08-21
>
> 规范文本：[English](../README.md)

本目录包含 Morphz 用来定义、实现和验证结构化上下文系统的公开技术基础。

## 命名角色

- **结构化上下文（Structured Context）**是与具体实现无关的技术类别；
- **Morphz 结构化上下文**是由新变元维护的标准族；
- **Morphz Runtime** 是新变元的官方参考实现，不是标准本身；
- **Morphz SC Compatible** 是保留的未来兼容性标识，只有在商标政策发布且取得符合要求
  的一致性证据后才能使用。

独立实现无需复制 Morphz Runtime 内部结构，只需满足标准规定的可观察语义。本 Draft
有意在标准族名称中保留 Morphz，同时保持技术类别与一致性语义不依赖具体实现。

## 交付物

1. [《结构化上下文宪法 v1》](structured_context_constitution_v1.md)
   定义这一技术类别保持其身份所需的稳定原则。
2. [《Morphz 结构化上下文规范 v1》](morphz_structured_context_specification_v1.md)
   定义规范性的对象模型、权责边界、事务与可观察语义。
3. [《Morphz 一致性测试套件 v1》](morphz_conformance_suite_v1.md)
   定义独立实现如何证明自身兼容性。
4. [项目治理](../../../GOVERNANCE.zh-CN.md)与
   [MEP-0001](../../meps/zh-CN/MEP-0001-specification-governance.md)定义标准和官方实现如何演进。
5. [知识产权状态说明](IPR_STATUS.md)记录 Draft 阶段临时的著作权、专利、贡献和商标边界。

## 权威顺序

规范权威顺序由宪法第 4 节定义。以下仅作非规范性的索引摘要：

1. 宪法；
2. 当前处于 Final 状态的结构化上下文规范；
3. 与规范版本对应的一致性测试套件；测试套件可以验证规范，但不能重新定义规范；
4. 已接受的 Standards Track MEP，但仅限已纳入带版本规范发布的部分；
5. 官方参考实现 Morphz Runtime；
6. 解释性设计文档与示例。

MEP 用于记录和批准变更，但只有当变更写入带版本的宪法或规范版本后，才成为规范性要求。

在这些文档退出 Draft 状态之前，源码、数据库契约测试和
[Runtime 实现状态总览](../../morphz_runtime_core_implementation_status_v1.md)仍然是判断 Morphz Runtime 当前已实现能力的权威依据。它们不会覆盖 Draft 的评审目标，也不会让实现细节自动成为规范要求。草案中的要求不能证明实现已经满足该要求。

## 语言与发布

英文是这些 Draft 标准的规范文本语言，本目录是与其同步维护的中文翻译。如果中英文含义发生冲突，以对应版本的英文规范为准。翻译不得静默改变规范含义。
