# HNS 包格式规范 v0.1

> 状态：规范候选草案
>
> 标准维护者：新变元（Newvar）
>
> 参考实现：Morphz Runtime `.hns` Loader
>
> 规范文本语言：英文
>
> 源码基线：截至 2026-09-03 的 Morphz Runtime
>
> 日期：2026-09-03
>
> 规范文本：[English](../hns_package_format_specification_v0_1.md)
>
> 语义依赖：[《Morphz Harness 规范 v0.1》](morphz_harness_specification_v0_1.md)
>
> 翻译说明：本文件是英文规范的中文翻译；如含义冲突，以相同版本的英文文本为准。

## 1. 范围

本规范定义可移植 Morphz Harness Package 的 `.hns` 分发 Profile，包括物理形态、逻辑
Artifact、基数、Manifest 字段、入口控制权、归一化、内容身份、路径安全和加载行为。

`.hns` 后缀标识 Harness Package，并在原子 HNS Profile 中标识最小 Cognitive Application
Package；`.yao` 后缀标识目录 Package 内的 Yao 源文件。`.hns` 不是源语言、Evaluation
Loop 或 SDK 的名称。

每个 HNS Package 都是打包一个 Primary Harness 的最小认知应用。HNS Core v0.1 不定义
复合 Application Manifest、多个 Harness、用户界面、Marketplace 元数据、商业策略或
外部服务 Bundle。Cognitive Application 与 Harness 不是同义词：前者是提供给 Agent 的
可识别程序，后者是它的有边界执行语义核心；HNS Package 是同时承载这两个角色的原子
分发形态。

本 Draft 规范当前已经实现的最小 Package，并将保留的未来 Artifact 与现行要求明确分开。

## 2. 规范用语

本文中以全大写形式出现的 **MUST**、**MUST NOT**、**REQUIRED**、**SHALL**、**SHALL
NOT**、**SHOULD**、**SHOULD NOT**、**RECOMMENDED**、**NOT RECOMMENDED**、**MAY** 和
**OPTIONAL**，应按照 BCP 14、[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119.html) 与
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174.html) 解释，且仅在它们以全大写形式
出现时具有该含义。

除非明确标记为规范要求，示例和实现注释均不具有规范性。

## 3. Package 模型

HNS Package 具有以下归一化逻辑形态：

```text
HarnessPackage
|- Manifest              恰好一个
|- Contract              恰好一个
|- Default Mind          零或一个
`- Entry Program         恰好一个
```

每个有效 Package 必须产生：

- Harness ID；
- 声明的 Package 版本；
- 人类可读标题；
- 一个逻辑 Entry Program ID；
- 显式 Runtime-owned 或 model-owned 入口语义；
- 归一化逻辑表示；
- 从该表示派生的内容身份。

除非带版本扩展明确定义，否则 Skill、Verifier、依赖、迁移、签名和任意资源保留给后续
Profile。Core v0.1 Manifest 中的 Skill 名称仅是可发现引用，不会把 Skill 内容嵌入归一化
Package。

## 4. 物理形态

### 4.1 单文件 Package

紧凑 Package 可以是一个文件名以 `.hns` 结尾的 UTF-8 Yao 源文件：

```text
coding.hns
```

文件必须恰好包含：

- 一个 `(manifest ...)` 顶层 Artifact；
- 一个 `(contract ...)` 顶层 Artifact；
- 零或一个 `(mind ...)` 顶层 Artifact；
- 一个 `(eval ...)` 或一个 `(infer ...)` 顶层 Artifact。

未知或重复顶层 Artifact 必须导致加载失败。源码中的 Artifact 顺序可以变化；归一化使用
第 10 节定义的逻辑顺序。

### 4.2 目录 Package

资源型 Package 可以是名称以 `.hns` 结尾的目录：

```text
coding.hns/
|- manifest.yao
|- contract.yao
|- mind.yao             可选
`- programs/
   `- main.yao          示例入口路径
```

对于 HNS Core v0.1：

- `manifest.yao` 必须存在，并恰好包含一个 `(manifest ...)` Artifact；
- `contract.yao` 必须存在，并恰好包含一个 `(contract ...)` Artifact；
- `mind.yao` 存在时，必须恰好包含一个 `(mind ...)` Artifact；
- Manifest 必须指定一个相对 Entry Program 路径；
- 被选择的 Entry Program 文件必须恰好包含一个 `(eval ...)` 或 `(infer ...)` Artifact。

未被引用的文件在 Core v0.1 中不具有权威性。Runtime 不得仅仅因为它们存在就执行它们。
它们如何纳入未来内容身份、签名或资源 Profile 仍是保留事项。

### 4.3 等价语义

单文件与目录 Package 是同一逻辑 Package 的两种物理编码。加载后，执行和绑定必须只面向
归一化 Package，不得依赖原始物理形态。

## 5. Yao 源码要求

HNS Core v0.1 Artifact 使用 UTF-8 文本编码的 Yao S-Expression。

每个顶层 Artifact 必须是一个 S-Expression List，其第一个 Atom 标识 Artifact 类型。
Loader 必须拒绝格式错误源码、顶层本应是 List 却出现 Atom 的情况，以及根名称与职责不符
的必要 Artifact。

本规范定义 Package 结构，不定义完整 Yao 语言。Entry Program 语法和 lowering 由 Runtime
声明或隐含支持的 Yao Language Profile 管理。HNS 在进入 Candidate 状态前必须定义显式
源语言兼容字段，而不是依赖 Runtime 特有推断。

## 6. Manifest

### 6.1 Core 语法

现行 Core v0.1 Manifest 形态是：

```lisp
(manifest
  (id coding)
  (version "1.0.0")
  (title "Coding Harness")
  (entry "programs/main.yao")
  (capabilities
    (tools read search edit exec)
    (skills rust testing)))
```

`id`、`version` 和 `title` 是必填标量字段。目录 Package 还要求 `entry`。单文件 Package
可以省略 `entry`，此时归一化逻辑 Entry Program ID 是 `main`。

每个标量字段最多出现一次，并且恰好包含一个 Atom 或带引号字符串值。`capabilities` 最多
出现一次。

### 6.2 Harness ID

`id` 是由发布者选择的稳定 Harness 名称，不得为空。Core v0.1 尚未冻结全局命名空间语法。
在治理流程定义 Registry 命名空间前，发布者应为公开 Package 使用抗冲突、带命名空间的 ID。

### 6.3 Version

`version` 是发布者声明的 Package 版本，不得为空。它不是内容身份。Runtime 必须拒绝在已经
安装的 `(id, version)` 对下安装不同内容。

Core v0.1 不强制语义化版本，但在其含义符合发布者兼容性 Policy 时，发布者应使用它。

### 6.4 Title

`title` 是人类可读展示文本。它不得用于身份、授权或依赖解析。

### 6.5 Entry

对于目录 Package，`entry` 是指向主 Yao Entry Program 的 Package 相对路径。它不得是绝对
路径，不得包含父级遍历组件，不得通过链接解析到 Package Root 外部，也不得以其他方式逃逸
已准入的 Package 边界。

对于单文件 Package，`entry` 可以指定逻辑 Entry Program 名称；物理路径解析不适用。

### 6.6 Capabilities

`capabilities` 声明需求与可发现引用，不授予权限。

- `(tools ...)` 包含零个或多个 Tool 名称；
- `(skills ...)` 包含零个或多个 Skill 名称。

名称必须是 Atom。重复名称应被归一化为一个逻辑项。未来扩展可以保留未知能力类别，但
Core v0.1 Loader 不得根据未知类别授予权限或执行行为。

## 7. Contract Artifact

Contract Artifact 必须以 `(contract ...)` 为根，用于提供稳定、模型可见的领域语义和实践
约束。

Contract：

- 对一个精确 Package 身份必须不可变；
- 必须从精确绑定 Package 挂载；
- 不得授予能力；
- 不得仅仅通过声明就断言外部副作用或验证已经发生；
- 应足够紧凑，避免为了挂载 Contract 而在每次 Evaluation 中强制注入全部详细 Skill。

Contract 子表单在 v0.1 中保持开放。在后续 Profile 标准化领域对象、Evidence 声明或
Verifier 接口前，可移植扩展应使用带命名空间的根。

## 8. Default Mind Artifact

可选 Default Mind Artifact 必须以 `(mind ...)` 为根，包含发布者为已绑定 Evaluation 提供的
认知材料。

Default Mind 必须以只读方式挂载。加载、安装或绑定 Package，不得自动把它写入持久 Agent
Mind。显式导入在获得支持时是一项独立、经过授权的操作，并应保留 Package 来源关系。

Default Mind 的内部 Frame 语法尚未由 HNS Core v0.1 冻结。Loader 可以在挂载前施加更严格
的 Runtime 特有校验。

## 9. Entry Program

### 9.1 基数与根

Package 必须包含恰好一个被选中的主 Entry Program，其根必须恰好是以下之一：

```lisp
(eval ...)
(infer ...)
```

`eval` 声明 Runtime-owned Evaluation 执行；`infer` 声明 model-owned Evaluation 执行。
Loader 必须拒绝未知入口根，不得从任何其他语法推断控制权。

### 9.2 Program 能力声明

Entry Program 声明 Tool 子集：

```lisp
(eval
  (requires (tools read search))
  ...)
```

Entry Program 声明的每个 Tool 都必须出现在 Manifest Tool 集合中。程序声明收窄 Package
需求，不授予权限。Model-owned `(infer ...)` Entry Program 必须包含显式的
`(requires (tools ...))`；`(requires (tools))` 表示纯推理，不向模型暴露可调用 Tool。
Loader 必须拒绝 Model-owned 入口省略该声明。Runtime-owned `(eval ...)` 入口只有在当前
Language Profile 能够确定有效子集时才可以省略；省略不得表示不受限制的 Tool 访问。
对于 Model-owned 入口，实际提供给模型的 Tool 集合，是该上界、完整正文中静态命名的
`(call TOOL ...)` 与当前权限三者的交集。

### 9.3 执行边界

Entry Program 必须依照 Morphz Harness 规范执行。特别是，`call` 或等价副作用请求必须由
Runtime 授权和执行中介；嵌套 `infer` 或等价操作必须保留显式因果身份和有界有效能力范围。

## 10. 归一化与内容身份

### 10.1 逻辑归一化

Loader 必须把两种物理形态归一化为以下逻辑顺序：

1. 包含归一化 `id`、`version`、`title`、逻辑 `entry` 和已识别能力列表的 Manifest；
2. Contract；
3. 存在时的 Default Mind；
4. 被选择的 Entry Program。

当文件系统位置、源码空白、注释和单文件或目录形态解析出相同归一化 Artifact 时，它们不得
影响逻辑 Package 身份。

当前参考实现将归一化 Artifact 序列化为规范 Yao 表单，以单个换行符连接，对所得 UTF-8
字节计算 SHA-256，并把结果表示成 `sha256:<lowercase-hex>`。

### 10.2 Draft 可移植性限制

精确的跨实现规范 Yao 转义、Atom 引号、Unicode 归一化和未知字段排序规则尚未冻结。因此，
v0.1 要求内容身份在一个符合规范的实现内部稳定，并要求该实现自己的单文件与目录编码得到
等价身份，但尚不允许声明独立实现之间一定得到逐字节相同的哈希。

在进入 Candidate 状态前，本规范必须发布规范字节 Fixture。Draft 阶段，独立工具应同时
保留原始源码和实现产生的归一化表示。

### 10.3 不可变性

一旦 `(id, version, content identity)` 被 Evaluation Binding 使用，该身份必须在 Evaluation
生命周期和审计保留期内可恢复。Registry 不得静默替换其内容。

## 11. 加载与校验

Core v0.1 Loader 必须在激活 Package 前完成：

1. 要求文件或目录 Package 使用 `.hns` 后缀；
2. 解析所有必要 Yao Artifact；
3. 强制执行 Artifact 基数和根名称；
4. 校验必要 Manifest 字段；
5. 在不发生 Package 逃逸的前提下解析目录 Entry；
6. 确定显式 Entry 控制权；
7. 验证 Entry Program Tool 声明是 Manifest Tool 声明的子集；
8. 归一化逻辑 Package；
9. 计算并保留内容身份；
10. 拒绝已安装 `(id, version)` 对下的冲突内容。

所有无需外部副作用即可完成的校验，都应在任何 Entry Program 节点执行前完成。

## 12. 注册、持久化与绑定

Runtime Catalog 应持久化足够的归一化 Package 材料，以便在重启后重新加载并验证精确已安装
身份。

当 ID、版本和内容身份全部一致时，注册可以是幂等的。冲突必须可观察，不得通过后写覆盖解决。

Evaluation Binding 必须使用精确 ID、版本与内容身份。Binding 选中的 Package 必须能在恢复
期间获得。Registry Discovery 可以向人工选择公开版本范围或 latest 视图，但这种浮动引用必须
在持久绑定前解析。

## 13. 保留扩展

以下 Package 能力被有意保留，不由 Core v0.1 隐含支持：

- 多个命名 Entry Program；
- Package 内部 `process` 定义与导出 Process 接口；
- 嵌入式 Skill 资源；
- Verifier 声明与可执行 Validator 资源；
- Package 依赖与 Lockfile；
- 发布者身份、签名、透明日志与撤销；
- 状态 Schema 与迁移；
- 展示元数据；
- 环境或 Execution Target 需求；
- Policy Overlay 与 Package 组合；
- 任意二进制 Asset。

实验实现可以通过带命名空间扩展支持这些特性，但不得把它们表示为 HNS Core v0.1 行为。

### 13.1 保留的复合 Cognitive Application 包层

**COA** 与 `.coa` 被保留为原子 HNS 之上的未来复合 Cognitive Application Package 层候选
名称与后缀。未来 Profile 可以定义：

- Application Manifest 与应用身份；
- 对一个或多个精确 HNS Package 身份的引用；
- 应用层 Skill、Verifier、交互界面、评测资产、领域资源与外部集成；
- 依赖、升级、签名、来源与权利元数据；
- 为每次 Evaluation 选择一个精确 Primary Harness Binding 的解析规则。

HNS Core v0.1 不得把 `.coa` 识别为 HNS Package，不得从该后缀推断应用语义，也不得把
`.coa` 支持表示为 Core 兼容性声明。保留名称与后缀并不定义未来格式。

## 14. 错误要求

Loader 至少必须针对以下情况显式失败且不得激活 Package：

- 必要 Artifact 缺失、重复、格式错误或未知；
- 必要 Manifest 字段缺失；
- 目录 Entry 路径无效或逃逸；
- Entry Program 根既不是 `eval` 也不是 `infer`；
- Program Tool 需求超出 Manifest Tool 集合；
- 同一已安装 ID 和版本下出现冲突内容；
- 必要 Language 或 Harness 兼容能力不可用；
- 解析或归一化期间超过资源限制。

错误应标识 Package、Artifact 和被违反的规则，同时避免泄露 Secret。

## 15. 安全考虑

HNS Package 是不受信任输入。Loader 和 Runtime 必须防御格式错误或恶意源码、路径遍历、
Symlink 逃逸、超大 Artifact、过深表达式、能力混淆、哈希替换和相同版本替换。

内容身份和未来签名用于建立来源与完整性，不授予 Tool 使用权。入口执行继续受 Runtime、
Principal、Target、Sandbox 和 Evaluation Policy 约束。

目录 Package 需要特别谨慎，因为 Core v0.1 不把任意未引用资源纳入归一化身份。Runtime
不得执行或信任这些文件。在签名资源清单 Profile 定义前，发布者应只分发有效 Core Artifact。

## 16. 进入 Candidate 状态前的开放决策

HNS v0.1 在解决以下问题前不能进入 Candidate 状态：

1. 规范 Yao 字节、转义、Unicode 和跨实现哈希 Fixture；
2. 显式 Harness、HNS、Yao 与 Runtime 兼容字段；
3. 全局或发布者命名空间化的 Harness ID 语法；
4. 目录 Package 的签名资源清单；
5. 源码大小、嵌套深度、节点数与规范输出限制；
6. 未知 Manifest 字段与顶层 Artifact 的扩展处理；
7. Package 签名、撤销、依赖与 Lockfile Profile；
8. 独立 Loader 一致性测试套件。

每项决策都需要 MEP 或明确记录的格式评审。

## 17. 参考实现状态

Morphz Runtime 参考 Loader 当前接受两种物理形态，强制执行 Core Artifact 基数，解析现行
Manifest 字段，校验安全目录 Entry 路径，检查 Program Tool 收窄，归一化 Package，计算
SHA-256 内容身份，持久化规范源码，并拒绝相同版本的内容替换。

它尚未实现保留的资源、签名、依赖、迁移或通用多入口 Profile。本节不具有规范性，也不是
一致性声明。

## 18. 知识产权状态

本 Draft 依照并受现行[知识产权状态说明](IPR_STATUS.md)约束。Apache-2.0 提供其明示的著作权
和专利授权；商标、兼容性标识和认证权仍单独管理。

## 19. 勘误与解释

疑似错误或歧义必须通过 [MEP-0001](../../meps/zh-CN/MEP-0001-specification-governance.md)
所述公开 Issue 和 MEP 流程记录。任何改变必要 Package 结构、内容身份、加载行为或兼容性
结果的解释，都需要 Standards Track MEP 和带版本格式更新。
