# Morphz 结构化上下文标准

> 状态：标准草案工作区
>
> 标准维护者：新变元（Newvar）
>
> 最后更新：2026-08-21
>
> 规范文本：[English](../README.md)

本目录包含 Morphz 用来定义、实现和验证结构化上下文系统的公开技术基础。

## 交付物

1. [《结构化上下文宪法 v1》](structured_context_constitution_v1.md)
   定义这一技术类别保持其身份所需的稳定原则。
2. [《Morphz 结构化上下文规范 v1》](morphz_structured_context_specification_v1.md)
   定义规范性的对象模型、权责边界、事务与可观察语义。
3. [《Morphz 一致性测试套件 v1》](morphz_conformance_suite_v1.md)
   定义独立实现如何证明自身兼容性。
4. [项目治理](../../../GOVERNANCE.zh-CN.md)与
   [MEP-0001](../../meps/zh-CN/MEP-0001-specification-governance.md)定义标准和官方实现如何演进。

## 权威顺序

首个公开规范定稿后，如果不同材料之间存在冲突，依照以下顺序解决：

1. 宪法；
2. 当前处于 Final 状态的结构化上下文规范；
3. 与规范版本对应的一致性测试套件；测试套件可以验证规范，但不能重新定义规范；
4. Morphz 官方参考实现；
5. 处于 Final 状态的 Morphz 增强提案、解释性设计文档与示例。

MEP 用于记录和批准变更，但只有当变更写入带版本的宪法或规范版本后，才成为规范性要求。

在这些文档退出 Draft 状态之前，源码、数据库契约测试和
[Runtime 实现状态总览](../../morphz_runtime_core_implementation_status_v1.md)仍然是判断 Morphz 当前已实现能力的权威依据。草案中的要求不能证明实现已经满足该要求。

## 语言与发布

英文草案计划发展为面向全球的规范性文本，本目录是与其同步维护的中文翻译。如果中英文含义发生冲突，以对应版本的英文规范为准。每次发布必须声明唯一的规范语言；翻译不得静默改变规范含义。
