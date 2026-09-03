# Morphz Harness 规范 v0.1

> 状态：规范候选草案
>
> 标准维护者：新变元（Newvar）
>
> 参考实现：Morphz Runtime
>
> 规范文本语言：英文
>
> 源码基线：截至 2026-08-21 的 Morphz Runtime 与 `.hns` Loader
>
> 日期：2026-08-21
>
> 规范文本：[English](../morphz_harness_specification_v0_1.md)
>
> 包格式：[《HNS 包格式规范 v0.1》](hns_package_format_specification_v0_1.md)
>
> 翻译说明：本文件是英文规范的中文翻译；如含义冲突，以相同版本的英文文本为准。

## 1. 范围

本规范定义 Morphz Harness 的可移植执行语义、权责边界、生命周期和可观察行为。

Harness 是挂载到一次 Evaluation 上的带版本认知程序与实践契约。它可以替换 Runtime
默认的 Evaluation Loop，但不替换 Runtime Control Loop。Harness 可以决定一次 Evaluation
如何推理、调用工具、收集证据、验证结果并形成 Outcome。Runtime 继续对身份、调度、
事务、权限、物理副作用、因果、持久化和恢复拥有权威控制权。

Harness 是 Cognitive Application（认知应用）管理一次 Evaluation 时使用的执行核心。
认知应用是面向产品与生态的单元，把可复用认知实践提供给既有 Agent。二者不是同义词：
Application 可以包含额外资源和集成，Harness 则始终是有边界的执行语义单元。

本规范在不绑定单一源语言或文件系统布局的前提下定义 Harness 语义。配套的 HNS 包格式
规范定义可移植 `.hns` 分发 Profile。Yao 是该 Profile 使用的源语言，不是 Harness 的
同义词。

## 2. 规范用语

本文中以全大写形式出现的 **MUST**、**MUST NOT**、**REQUIRED**、**SHALL**、**SHALL
NOT**、**SHOULD**、**SHOULD NOT**、**RECOMMENDED**、**NOT RECOMMENDED**、**MAY** 和
**OPTIONAL**，应按照 BCP 14、[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119.html) 与
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174.html) 解释，且仅在它们以全大写形式
出现时具有该含义。

除非明确标记为规范要求，示例、理由、实现注释和实现状态说明均不具有规范性。

## 3. 核心术语

### 3.1 Runtime Control Loop

Runtime Control Loop 是系统拥有的生命周期，用于认证请求、建立权限、创建和调度工作、
持久化状态、执行物理副作用、处理等待以及恢复被中断的执行。

### 3.2 Evaluation Loop

Evaluation Loop 是一次 Evaluation 内使用的有界认知过程，用于选择下一步推理或执行动作、
吸收结果、判断是否需要继续工作并形成 Outcome。

### 3.3 Harness

Harness 是提供以下内容的可移植语义单元：

- 一个显式 Evaluation 入口程序；
- 一份稳定的实践 Contract；
- 声明的能力需求；
- 可选的只读默认认知材料；
- 可选的 Evidence、Outcome、Verifier 与 Skill 语义。

Harness 可以替换默认 Evaluation Loop，但必须服从 Runtime Control Loop。

### 3.4 Harness Package

Harness Package 是不可变、可按内容寻址的分发制品，包含识别、校验、绑定和执行 Harness
所需的材料。符合本 Draft 的可安装、可移植 Harness Package 使用配套格式规范定义的
`.hns` Profile。

### 3.5 Harness Installation

Harness Installation 是将一个精确 Package 准入 Runtime Catalog 的过程。安装不得激活
Harness，也不得授予它所请求的能力。

### 3.6 Harness Binding

Harness Binding 是从一次 Evaluation 指向一个精确 Package 身份的不可变引用。它必须包含
或无歧义地寻址：

- Harness 标识；
- 声明的 Harness 版本；
- 内容或制品哈希；
- Evaluation 身份；
- 可选的 Objective 默认值来源。

### 3.7 Contract

Contract 是 Harness 提供的、模型可见的稳定描述，用于定义领域对象、能力、证据语义和
实践约束。它属于带版本 Package 内容，不属于 Agent 编写的 Mind。

### 3.8 Entry Program 与 Evaluation Owner

Entry Program 是 Harness Binding 选中的唯一主执行根，其 Evaluation Owner 必须明确：

- **Runtime-owned**：确定性 Plan 结构持有控制权，并可以把有界推理步骤委托给模型；
- **model-owned**：模型持有 Evaluation Loop 控制权，所有工具副作用仍由 Runtime 中介。

### 3.9 Default Mind

Default Mind 是 Harness 为已绑定 Evaluation 提供的可选只读认知材料。Harness 被安装或
挂载，并不会让它自动成为持久 Agent Mind。

### 3.10 Outcome 与 Verifier

Outcome 是一次 Evaluation 声明的终态结果。Verifier 是一项声明的过程或外部权威，可以
依据已识别证据检查 Outcome 的某项性质。Verifier 结果属于证据，不会静默改写 Agent 认知。

### 3.11 Cognitive Application（认知应用）

Cognitive Application 是可独立识别、带版本且面向产品与生态的单元，把可复用认知实践
提供给稳定 Agent。它通过至少一个 Harness 实现；当相应 Profile 定义这些内容时，还可以
包含 Skill、Verifier、默认认知材料、交互界面、领域资源、评测资产与外部集成。

认知应用不是 Agent、Session、Harness、HNS Package 或外部 SDK Client。安装、选择或绑定
认知应用，不得隐式创建、替换、克隆或合并 Agent 身份。仅完成安装不会授予 Runtime
Capability 或执行权威。

Harness Core v0.1 只规范每次 Evaluation 的一个 Primary Harness Binding；它尚不定义完整
Cognitive Application Manifest、多 Harness 组合、用户界面、Marketplace、商业策略或
Cognitive Application 一致性声明。一个 HNS Package 可以实现最小认知应用的执行内容，
但不会因此让两个术语等价。

**COA** 与 `.coa` 被保留为 HNS 之上的未来 Cognitive Application Package Profile 候选
名称与后缀。该 Profile 将来可以定义 Application Manifest，引用一个或多个精确 HNS
Package 身份，并打包应用层 Skill、Verifier、交互界面、评测资产、领域资源与外部集成。
这一保留不定义具体格式，不要求 Runtime 支持，也不会在 Harness Core v0.1 中建立兼容性
声明。

## 4. 控制权与权责边界

以下分离具有规范性：

| 事项 | Harness 权力 | Runtime 权力 |
| --- | --- | --- |
| Evaluation 推理与步骤选择 | 在绑定程序内定义 | 调用、暂停、恢复和限制 |
| Contract 与领域实践 | 声明 | 校验、挂载和识别 |
| 工具需求 | 请求和收窄 | 授权和执行约束 |
| 物理副作用 | 请求 | 调度、执行、记录和 fencing |
| Context 或 Mind 修改 | 通过允许的事务提出 | 校验、提交、拒绝和审计 |
| Objective 生命周期 | 通过 Outcome 提供信息 | 创建、迁移、监督和恢复 |
| Event 身份、顺序与直接原因 | 解释 | 建立和保存 |
| 恢复 | 提供可恢复的程序结构 | 持久化并避免重复副作用地恢复 |

符合规范的 Harness 不得：

1. 创建绕过 Runtime 工作模型的私有调度器；
2. 绕过 Runtime 授权和副作用记录直接执行物理 Tool；
3. 扩大 Principal、部署、Target、Sandbox 或 Evaluation 能力；
4. 绕过授权 Runtime 操作修改 Kernel 状态或持久 Mind；
5. 把已声明 Validator 当作验证已经发生的证明；
6. 在同一次 Evaluation 中用另一个 Package 替换精确绑定的 Package；
7. 把未经验证的推理转化成 Runtime 事实。

实现可以在内部优化纯节点，但该优化不得改变可观察的权限、因果、失败或恢复行为。

## 5. Harness 生命周期

可移植生命周期包括：

```text
获取 Package
  -> 解析与结构校验
  -> 计算内容身份
  -> 安装与准入
  -> 精确选择
  -> 建立 Evaluation Binding
  -> 挂载 Contract 与默认材料
  -> 执行入口
  -> 形成 Outcome 或分类失败
  -> 持久审计与可选验证
```

### 5.1 安装与注册

Runtime 必须在注册前校验 Package 结构。相同 Harness ID、版本和内容身份的重复注册可以
是幂等的。相同 Harness ID 和版本对应不同内容时，注册必须显式失败。

安装不得：

- 启动 Evaluation；
- 将 Default Mind 导入持久 Agent Mind；
- 授予 Tool、网络、文件系统、Target 或 Secret 能力；
- 静默选择该 Package 用于未来工作。

### 5.2 选择与绑定

每次由 Harness 管理的 Evaluation 都必须在 Harness 内容影响执行前，物化一个精确的
Evaluation Binding。`latest` 等浮动引用不得被保存为持久 Evaluation 的权威绑定。

Objective 可以携带精确 Package 引用作为默认值。Objective 默认值不是权威执行绑定；
每次具体 Evaluation 都必须物化自己的不可变 Binding，并在继承默认值时记录来源。

Harness Core v0.1 允许每次 Evaluation 至多具有一个 Primary Harness。Policy Overlay、
组合图和多个 Primary Harness 不属于本 Draft。

### 5.3 挂载

绑定后，Runtime 必须向 Evaluation 提供精确 Contract 和 Entry Program。可选 Default Mind
必须以只读方式挂载，并仅作用于已绑定 Evaluation。

如果实现允许把 Default Mind 显式导入持久 Agent Mind，该导入必须是一项独立、经过授权、
可审计的操作。它应保留 Harness ID、版本、内容身份和来源关系。

### 5.4 终止

终止必须产生可观察的终态、分类失败、等待状态或 Runtime 状态迁移。Harness 不得仅仅因为
程序在语法上返回就声明完成。Outcome 的含义和验证状态必须保持可区分。

## 6. Evaluation 执行模型

### 6.1 显式控制权

Entry Program 必须声明根由 Runtime 还是模型持有控制权。控制权不得从偶然语法推断，也
不得因为把同一操作包进 sequence 而发生变化。

HNS Profile 通过显式 `(eval ...)` 和 `(infer ...)` 根表达该规则。

### 6.2 Runtime-owned 入口

Runtime-owned 入口可以包含确定性顺序、绑定、分支、有界映射、fallback、Tool 请求和子
推理请求。

当执行遇到物理副作用、等待、审批或子推理边界时，Runtime 必须：

1. 校验当前权限和 fencing 状态；
2. 原子持久化子工作与父等待状态，或提供等价行为；
3. 在等待时释放执行所有权；
4. 将持久结果路由到创建它的因果范围；
5. 从已记录程序位置恢复，且不重复已完成的非幂等副作用。

### 6.3 Model-owned 入口

Model-owned 入口将步骤选择交给模型。它仍必须使用 Runtime 中介的 Tool、Context、权限、
预算与 Delivery 操作。模型持有 Evaluation Loop，并不代表它持有 Runtime Control Loop。

Model-owned Entry Program 必须显式声明 `(requires (tools ...))`。声明集合与 Package、
Principal、部署及 Runtime Policy 求交后，构成该 Evaluation 对模型可见的完整 Tool 上界。
`(requires (tools))` 表示不向模型提供可调用证据 Tool 的纯推理。省略该声明必须被拒绝，
不得解释为继承或不受限制的访问。在该上界内，一段完整 Yao 正文实际获得的 Tool 集合，
由正文中静态命名的 `(call TOOL ...)` 推导。仅在 `requires` 中声明但正文没有使用的 Tool，
不得因此自动对模型可见。

### 6.4 嵌套推理

Runtime-owned 程序可以创建有界子推理。子推理必须具有显式因果身份，其有效能力范围不得
宽于父级。只有声明的终态结果或分类失败可以满足父等待；中间推理不得被错误表示为终态结果。
只有 Yao 源码中由 `(captures NAME...)` 显式列出的父程序绑定，才可以被序列化到该子请求，
并发送给当前配置的模型服务商。未列出的绑定和完整 Runtime 环境不得隐式跨越该边界。
捕获只授权披露对应的值，不授予任何额外能力。

### 6.5 开放式工作

Harness Entry Program 描述一次 Evaluation。跨越未知次数尝试的开放式语义推进，应由
Runtime 拥有的 Objective 或等价持久监督结构表达。增加循环或递归的 Harness 扩展必须
定义资源、恢复和副作用幂等限制，且不得创建不可观察的调度器。

## 7. 能力与副作用

Harness 声明表达需求和限制，不表达权限。有效能力不得宽于以下交集：

```text
部署与 Runtime Policy
交 Principal 权限
交 Execution Target 与 Sandbox Policy
交 Package 声明
交 Entry Program 声明
交 Evaluation 或子级 Capability Lease
```

缺少必要能力时，必须产生可观察的准入或执行失败。Runtime 不得静默替换成权限更高的 Tool。

每个外部副作用必须由稳定 Runtime 工作身份，或等价的幂等与审计边界表示。重试或恢复
Evaluation 时不得重复已完成的非幂等副作用。

## 8. Context、状态与学习

Harness 拥有的临时状态必须使用命名空间，并能归因到精确 Binding。持久 Runtime 状态必须
位于 Package 制品之外。

Harness 可以通过授权操作提出 Context 或 Mind 修改。Runtime 必须保持以下内容的区别：

- 不可变 Package Contract；
- 仅作用于 Evaluation 的 Default Mind；
- Agent 编写的持久 Mind；
- Runtime 拥有的事实与执行状态。

从 Harness 使用中学习并非隐式行为。安装、绑定或完成 Harness 本身不得覆盖持久 Agent
认知。任何被保留的学习都必须通过显式事务写入，并携带与其语义主张相称的来源或证据引用。

## 9. Evidence、Outcome 与验证

Harness 可以定义领域 Evidence 类型和预期 Verifier 接口。它必须保存解释证据所需的来源、
范围和版本。

Outcome 应标识：

- 声明或交付结果；
- Evaluation 与精确 Harness Binding；
- 支持性 Evidence 引用；
- 验证发生时的验证状态与 Verifier 身份；
- 尚未解决的限制或分类失败。

声明的 Verifier 必须通过 Runtime 管理的信任边界执行。不受信任的验证代码不得作为无限制
Native Code 加载进 Runtime 进程。Verifier 结果必须记录检查了什么，以及针对哪个输入、
环境或 revision 进行检查。

本 Draft 不定义通用 Reward Function。实现可以从 Outcome 和 Verifier 结果派生训练或评测
信号，但不得把未经验证的 Harness 完成信号描述成 Ground Truth。

## 10. 失败与恢复

失败分类至少必须足以区分：

- 无效 Package 或不兼容版本；
- 能力被拒绝或缺失；
- 无效 Entry Program；
- 模型推理失败；
- Tool 或 Target 失败；
- 验证失败；
- 预算或资源耗尽；
- 过期执行或 fencing 拒绝；
- Runtime 内部失败。

对于 Durable Profile，重启必须保留精确 Binding，并从已提交状态恢复或公开终态失败。发生
部分外部副作用后，不得从 Package 根部静默重启，除非能够证明所有重复副作用都是幂等的。

## 11. 兼容性与版本

Harness 规范版本、Package 版本、Yao 规范/IR 的带外修订和 Runtime 版本相互独立。Yao 源码
本身没有内嵌版本声明。

- Package 版本标识发布者声明的 Harness 演进；
- 内容哈希标识精确 Package 内容；
- Harness 规范版本标识可移植语义；
- Yao 规范或持久化 IR 修订标识解析或 Lowering 行为，但不成为源码 Form。

实现不得仅从语义版本推断内容身份。不兼容 Package 必须在 Entry Program 产生副作用前失败。

在后续 MEP 定义强制版本方案前，Package 版本中 patch、minor 和 major 的含义属于发布者
Policy。Runtime 应向安装器和工具公开其支持的 Harness 与 HNS Profile。

## 12. 一致性 Profile

本 Draft 保留以下 Profile：

- **Harness Core**：精确 Binding、显式 Evaluation 控制权、Contract 挂载、能力收窄、
  Runtime 中介副作用与分类失败；
- **Harness Durable**：Harness Core 加持久 Binding、可恢复执行、副作用幂等与重启恢复；
- **Harness Verifiable**：Harness Durable 加可移植 Outcome、Evidence 与 Verifier 记录；
- **Harness Distributed**：Harness Durable 加跨进程租约、fencing、Target 路由和分布式恢复。

配套一致性测试套件将定义可执行要求。在独立套件和签名报告发布前，Morphz Runtime 不声明
公开认证。

## 13. 安全考虑

Harness Package、Contract、Default Mind、Entry Program、Skill、Tool 结果和 Verifier 都是
潜在的不受信任输入。

符合规范的 Runtime 必须：

- 在激活前校验 Package 结构和资源限制；
- 按精确内容身份绑定，并拒绝相同版本的内容替换；
- 独立于 Package 声明，对每个外部副作用进行授权；
- 防止 Package 路径和资源逃逸其准入边界；
- 除非明确授权，防止 Secret 进入模型可见内容；
- 记录受保护副作用对应的 Principal 和有效能力范围；
- 限制模型、Tool、存储和执行资源消耗；
- 必要验证或权限不可用时显式失败。

Package 签名和发布者信任可以改善来源证明，但不能授予执行权限。

## 14. 进入 Candidate 状态前的开放决策

以下决策仍然开放：

1. 规范性的可移植 Outcome 与 Verifier Schema；
2. 第一批公开 Harness 一致性 Fixture 与报告；
3. Package 签名、发布者身份、撤销与透明日志 Profile；
4. 受控 Harness Overlay 与组合规则；
5. 可移植状态命名空间与迁移语义；
6. 依赖解析与 Lockfile 语义；
7. 兼容性标识与商标 Policy；
8. 最终知识产权与贡献条款。

每项决策都需要 MEP 或明确记录的规范评审。

## 15. 参考实现状态

截至源码基线，Morphz Runtime 已实现核心 `.hns` Loader、归一化 Package 身份、按
ID/版本/哈希进行的不可变注册、精确 Objective 默认 Binding 与 Evaluation Binding、每次
Evaluation 一个 Primary Harness、只读 Contract 与 Default Mind 挂载、显式 `eval` 和
`infer` 控制权、持久 Plan 执行、Runtime 中介的 Tool 工作、子推理交接和重启恢复路径。

远端签名 Catalog、通用依赖、Package 迁移、可移植 Verifier 记录和独立一致性套件尚未完成。
本节不具有规范性，也不能被用作一致性声明。

## 16. 知识产权状态

本 Draft 依照并受现行[知识产权状态说明](IPR_STATUS.md)约束。Apache-2.0 提供其明示的著作权
和专利授权；商标、兼容性标识和认证权仍单独管理。

## 17. 勘误与解释

疑似错误或歧义必须通过 [MEP-0001](../../meps/zh-CN/MEP-0001-specification-governance.md)
所述公开 Issue 和 MEP 流程记录。任何改变必要可观察行为、Profile 归属或兼容性结果的解释，
都需要 Standards Track MEP 和带版本规范更新。
