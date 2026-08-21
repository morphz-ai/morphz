# Morphz Agent-Native Company Operating Model

> 中文名：Morphz Agent 原生公司运行模型
> 状态：Vision / Reference Architecture / Living Design Note
> 日期：2026-08-15
> 设计层级：基于 Morphz 通用能力提出的上层公司运行模型
> 适用范围：Morphz 上层公司运营产品、Company OS、OPC 与早期创业团队
> 非适用范围：本文不是 Morphz Runtime 已实现能力清单，也不直接冻结 Runtime 领域模型或公开产品承诺
> 与具体公司的关系：本文不描述任何一家公司的实施方案；采用方的组织、流程、人员与验证记录应另行成文
> 相关文档：[`morphz_single_identity_distributed_cognition_architecture.md`](morphz_single_identity_distributed_cognition_architecture.md)、[`morphz_execution_target_and_edge_node_architecture_v1.md`](morphz_execution_target_and_edge_node_architecture_v1.md)、[`morphz_principal_identity_and_frame_provenance_v1.md`](morphz_principal_identity_and_frame_provenance_v1.md)、[`morphz_secret_store_architecture_v2.md`](morphz_secret_store_architecture_v2.md)、[`morphz_scheduler_kernel_and_domain_model_v1.md`](morphz_scheduler_kernel_and_domain_model_v1.md)

## 1. 文档定位

本文描述一种建立在 Morphz 之上的 **Agent-Native Company Operating Model**：让一个持续存在的统一 Agent 成为公司的认知与协调中枢，通过多 Session、多 Thread、工具、外部服务商和人类完成真实公司事务。

本文是一份上层运行模型和参考架构：

- 当前内容包含产品愿景、架构原则、业务对象和安全边界；
- 本文出现的 `CompanyMatter`、`Mandate`、`ServiceProvider` 等对象均为上层概念设计，除非另有说明，不代表 Morphz Runtime 已经实现。
- 任何具体公司的采用策略、初始权限、工作清单和验证结果都属于独立的实施文档，不属于本文。

本文希望回答：

1. 一家公司是否可以只拥有一个长期 AI Agent，而不复制传统部门式 Multi-Agent 结构；
2. 统一人格、统一认知与并发公司事务如何共存；
3. 一个 Agent 如何在不永久持有全部权限的情况下运营公司；
4. AI 如何协调软件工具、机构、服务商和人类完成线下工作；
5. 哪些能力属于 Company OS，哪些能力才应沉入 Morphz Runtime；
6. 如何在不影响公司核心业务的前提下，让系统从真实运营中自然生长。

## 2. 核心原则

本运行模型的核心原则是：

> **全局认知，局部行动；统一人格，按事授权。**

四部分分别表示：

- **全局认知**：公司的目标、关系、决策、经验和允许共享的事实最终汇入同一个 Shared Mind；
- **局部行动**：每次 Evaluation、Thread 和外部动作只处理当前相关事务，不隐式获得全部公司资料和能力；
- **统一人格**：公司只使用一个长期存在的公司 Agent，不为模拟传统部门而创建彼此割裂的永久角色 Agent；下文以 `Morphz 001` 作为该 Agent 的示意标识；
- **按事授权**：权限绑定具体 Matter、Action、资源、金额、相对方、资料范围和有效期，而不是仅仅绑定“财务”“法务”等角色名称。

进一步概括为：

> **一个心智，多个会话，并发思考，无数双手。**

上述原则强调统一认知和广泛的执行能力，但不意味着系统永远正确或永久持有全部权限：

- 全局认知要求公司知识由同一认知主体组织，并明确区分已知、未知、推断与证据；
- 广泛执行要求系统能够在授权边界内寻找完成任务的路径：AI 能做则调用工具，线上无法完成则协调机构或人类。

## 3. 为什么不优先采用部门式 Multi-Agent

传统 Multi-Agent 公司往往映射为：

```text
CEO Agent <-> 法务 Agent <-> 财务 Agent <-> 市场 Agent
```

这种结构复制了传统组织的分工方式，却也复制了传统组织的认知代价：

- 同一公司事实在不同 Agent 中出现多个版本；
- 跨部门事务需要反复转述和协调；
- 不同长期记忆形成认知孤岛；
- 用户必须先判断“这件事应该找谁”；
- 多个 Agent 如果共享同一模型、凭证和所有者，并不会自然形成真正的权限隔离；
- 角色人格容易沦为组织表演，而不是有效的安全或责任边界。

人类组织通过分工解决单个人无法并发思考、无法掌握全部信息的问题。Morphz 的目标则是在不割裂人格和公司认知的前提下，获得并发、专业化和广泛执行能力。

因此，本模型不为财务、法务、行政或市场职能预设永久角色 Agent。专业工作由长期公司 Agent 委派给临时 Evaluator、Sub Agent、确定性工具或外部专业人士完成，结果回到同一个公司 Shared Mind。

## 4. 推荐的公司认知结构

本模型推荐采用：

```text
Authorized Principal
  最终责任、法律行为与高风险授权；可以参与多个 Session

Morphz 001
└── 一个 Company Context / Shared Mind
    ├── Session A：与负责人、客户、服务商或系统建立连接
    │   ├── Dialogue Thread
    │   ├── Execution Thread
    │   └── Delivery Thread
    ├── Session B：另一条对话或系统连接
    ├── Session C：内部系统或连接器
    └── ...

CompanyMatter
├── 作为上层权威业务对象，记录目标、期限、状态、授权与证据
├── 关联参与该事务的一个或多个 Session
└── 关联推进该事务的 Objective、Execution Thread 与交付结果
```

`Principal` 与 `Session` 不是固定的一对一关系：同一个 Principal 可以进入多个 Session，一个 Session 也可以容纳多个 Principal。每条 Event 和每次 Evaluation 仍必须保留当前可信 Principal 与 active Session。

对象职责如下：

| 对象 | 职责 |
|---|---|
| Agent | 长期存在的认知主体、人格、关系和组织记忆 |
| Context / Shared Mind | 采用方唯一的权威公司认知状态 |
| Principal | Runtime 认证的对话或请求主体，不由模型从消息文字猜测 |
| Session | Agent 与某个主体或系统之间的连接、局部连续性和消息路由 |
| CompanyMatter | 一项具体公司事务的上层权威业务对象，可关联相关 Session、Objective、Thread 与证据 |
| Thread | Session 内部的 Dialogue、Execution 与 Delivery 因果执行链；可以推进 Matter，但不等于 Matter 本身 |
| Evaluation | 围绕当前事件读取有限投影的一次短暂计算 |
| Temporary Evaluator / Sub Agent | 专业研究、起草、验证或对抗复核的临时计算工作者 |
| Tool / Execution Target | 软件或物理能力，以及动作实际发生的执行环境 |
| Mandate | Company OS 对某项事务授予的业务授权 |
| Approval | 对具体高风险 Action 的明确授权事实 |

### 4.1 一个 Context 不等于一个无限 Prompt

一个 Company Context 表示一个权威 Shared Mind，不要求每次模型调用读取全部公司历史和敏感资料。

每次 Evaluation 仍应只接收：

```text
Stable Agent Identity
+ 当前 Matter 相关的 Shared Mind 投影
+ 当前 Session 与 Principal 关系
+ 当前 Thread 状态
+ 当前输入事件
+ 当前有效 Mandate 与 Capability 摘要
```

不同 Evaluation Projection 是同一个 Mind 的不同查询视图，不是新的 Agent，也不是新的长期 Context。

### 4.2 跨事务认知是核心价值

统一 Context 应当支持长期公司 Agent 形成跨事务判断，例如：

- 路演时间影响专利提交和技术披露边界；
- 注册地址和入驻状态影响园区政策；
- 银行开户影响税务、社保和资金管理；
- 商标、域名、公司名称和产品品牌需要统一规划；
- 合同中的服务范围影响后续行政成本和风险。

如果这些事务被拆入互相隔离的永久 Agent 或长期 Context，系统将重新承担传统公司的信息协调成本。

## 5. 公司事务是上层权威对象

Company OS 应当定义结构化的 `CompanyMatter`。Shared Mind 用于理解、关联和决策，但合同、付款、期限和状态不能只存在于自然语言记忆中。

概念结构：

```text
CompanyMatter
  matter_id
  company_id
  type
  title
  goal
  completion_criteria
  requester_principal_id
  status
  priority
  deadline
  constraints
  budget
  participants
  evidence_refs
  artifact_refs
  active_mandates
  pending_decisions
  next_actions
  created_at
  updated_at
  completed_at
```

CompanyMatter 是公司运营的结构化事实来源；Morphz Context 和 Ledger 保存其认知、因果和审计投影。二者不能相互替代。

### 5.1 建议生命周期

```text
Captured
  -> Clarifying
  -> Planned
  -> Executing
  -> WaitingExternal
  -> WaitingApproval
  -> WaitingAcceptance
  -> Completed

任意阶段还可以进入：
Blocked / Cancelled / Disputed / Failed
```

状态变化必须携带原因、事件来源、责任主体和必要证据，不能只由模型修改一段总结文字。

## 6. 授权面向事务，不面向人格角色

单一长期公司 Agent 不意味着它永久拥有公司全部权限。Agent 身份与业务权限必须正交。

Company OS 可以定义上层 `Mandate`：

```text
Mandate
  mandate_id
  company_id
  matter_id
  authorizer_principal_id
  agent_id
  permitted_actions
  prohibited_actions
  resource_scope
  disclosure_scope
  counterparty_scope
  budget_limit
  valid_from
  expires_at
  approval_ref
  status
```

示例：

```text
matter: bank-account-opening
permitted_actions:
  - 搜索银行和网点
  - 联系指定代理询价与预约
  - 披露营业执照中的公开字段
prohibited_actions:
  - 对外付款
  - 修改公司登记信息
budget_limit: 500 CNY
expires_at: 2026-08-31
```

角色可以作为生成默认策略的模板，例如“财务事项通常需要付款审批”，但角色名称本身不能成为最终权限来源。

### 6.1 四级初始行动策略

| 等级 | 典型动作 | 建议默认策略 |
|---|---|---|
| L0 | 内部整理、公开检索、提醒、起草 | 可自动执行 |
| L1 | 询价、预约、起草对外消息 | 由公司 Agent 起草，授权主体确认发送 |
| L2 | 披露内部资料、确定供应商、设定谈判边界 | Matter 级 Mandate 与明确审批 |
| L3 | 签约、付款、盖章、正式申报、公开发布 | 精确 Action Approval；默认由法定或授权主体最终执行 |

### 6.2 Approval 必须绑定不可变 Action

高风险审批不能只是“允许 Morphz 继续”，而应绑定：

```text
ActionApproval
  matter_id
  action_kind
  counterparty
  amount
  contract_or_payload_digest
  disclosure_scope
  execution_target
  approved_by
  approved_at
  expires_at
```

金额、合同内容、收款账户、相对方、披露范围或执行目标发生变化时，原审批自动失效。

授权不是阻碍单一 Agent 的理由，而是公司运营必须具备的控制平面。现有 Morphz 已经具有 Principal 所有权以及 Agent / Context / Thread scoped Execution Target authorization；Company OS 需要在此之上增加业务语义，而不是通过创建多个角色 Agent 伪造隔离。

## 7. 专业分工使用临时计算工作者

单一长期 Agent 不排斥专业化和独立复核。

```text
长期公司 Agent 识别专业任务
  -> 形成有限输入快照
  -> 调用专业模型、Harness、临时 Sub Agent 或确定性工具
  -> 获取结果、证据与不确定项
  -> 结果返回长期公司 Agent
  -> 临时计算结束
```

临时工作者：

- 不拥有独立的公司人格；
- 不建立另一套长期组织记忆；
- 不自动继承 001 的全部 Secret、Target 或 Mandate；
- 只读取完成当前任务所需的有限投影；
- 输出提案、证据或复核结论，由 001 统一吸收和协调。

只有出现真正独立的身份、所有者、法律责任、客户数据边界或长期关系时，才考虑创建新的永久 Agent。

## 8. 人类和服务商属于现实执行层

Morphz 的价值不要求所有事情都由软件完成。大量公司事务包含线下、机构和例外流程；如果系统能够可靠协调人类完成工作，这恰好构成对外产品价值。

但 `Human` 不应被直接等同为一个 Runtime Tool。更合理的上层概念是：

```text
WorkItem / CompanyMatter
├── MachineExecution
│   ├── Tool
│   ├── ExecutionTarget
│   └── ExecutionJob
└── ServiceExecution
    ├── ServiceProvider
    ├── CommunicationRoute
    ├── WorkOrder
    ├── HumanWorker
    └── Deliverable
```

例如：

```text
会计、法务或园区服务机构 = ServiceProvider
微信、电话、邮件         = CommunicationRoute
具体对接工作人员         = HumanWorker
公司注册或银行开户协助    = WorkOrder
营业执照、印章、开户资料  = Deliverable
```

这些首先是 Company OS 领域对象，不应仅为一个上层产品而扩张 Morphz Runtime。

### 8.1 现实事务闭环

```text
发现公司需求
  -> AI 尝试线上完成
  -> 识别必须由机构或人类处理的部分
  -> 搜索和验证服务商
  -> 询价、沟通和比较
  -> 提交选择与风险建议
  -> 授权主体审批
  -> 创建合同与 WorkOrder
  -> 跟踪、催办和异常升级
  -> 收集交付证据
  -> 验收、付款和归档
```

对外沟通时，Morphz 不应冒充人类。推荐披露：

> 我是[公司名称]授权的 AI 助理，负责需求沟通和流程协调；合同承诺和付款需经公司授权负责人确认。

## 9. 敏感资料与 Secret

公司运营会涉及多种不同敏感对象：

| 类型 | 推荐权威存储 |
|---|---|
| Token、密码、私钥 | Morphz Secret Store 或同等秘密管理系统 |
| 身份证、营业执照、合同、专利原文 | Encrypted Document Vault |
| 银行账户和支付凭证 | 财务系统或银行信任域，仅向任务提供最小引用 |
| 物理印章 | 实体保管登记、使用审批和盖章日志 |
| 公司知识摘要和关系 | Company Context / Shared Mind |

原则：

- Prompt、普通 Ledger Event 和 CompanyMatter 不保存秘密值；
- Agent 获得 Secret reference，而不是长期持有原始凭证；
- 资料访问按 Matter、用途、Principal 和有效期授权；
- 可以脱敏时只提供脱敏版本；
- 读取、发送、导出和撤销形成审计事件；
- Matter 完成后撤销临时访问；
- Shared Mind 可以知道“资料存在及其意义”，不必保存资料全文。

## 10. 幻觉、证据与现实约束

公司运行中最大的系统性风险不是模型不够聪明，而是它能够生成流畅、合理、但事实错误的判断。

Company OS 必须区分：

```text
Fact       有外部证据支持的事实
Inference  基于事实形成的推断
Proposal   建议采取的方案
Decision   经授权主体作出的决定
Commitment 已经对外产生责任的承诺
```

不可逆动作至少应满足：

```text
证据充分
+ 关键信息结构化校验
+ 必要时独立复核
+ 明确未知项与不确定性
+ 人工或权威 Principal 审批
+ 执行后对账与验收
```

验证优先级：

1. 权威外部数据或确定性 API；
2. 文件解析、摘要校验、签名或内容哈希；
3. 独立工具和规则校验；
4. 隔离的 Reviewer Evaluation；
5. 模型自我复核只能作为补充，不能单独构成事实证明。

Approval 也不能只展示 AI 的流畅总结。审批界面应优先展示原始证据、差异、未知事项、风险、金额和不可逆后果。

## 11. 外部 Principal 与直接会话边界

长期目标是让一个公司 Agent 同时与负责人、员工、客户、供应商和系统保持不同 Session，并通过 Principal 可靠识别对话主体。

采用方应根据自身风险承受能力渐进开放：

1. 授权负责人是 Company Context 的初始主要直接操作者；
2. 公司 Agent 起草对外消息，授权负责人初期负责确认和发送；
3. 外部回复作为带来源的 Matter Event、Artifact 或 Observation 导入；
4. 低风险询价和预约验证稳定后，逐步开放受限的直接外部 Session；
5. 客户、服务商等不可信输入不得自动获得读取内部 Mind、调用 Secret 或触发高风险 Tool 的能力；
6. 在跨 Session 披露策略、信息流控制和多租户审计产品化之前，不向外部 Principal 暴露完整 Company Context。

统一 Agent 可以知道来自不同主体的信息，但“知道”不等于“允许披露”，也不等于“允许行动”。

## 12. 与 Morphz Runtime 的边界

### 12.1 应保留在 Company OS 的概念

- Company、Member、Role；
- CompanyMatter；
- Vendor / ServiceProvider；
- Contract、Quote、Invoice；
- WorkOrder、Deliverable、Acceptance；
- Matter Mandate 和公司审批策略；
- 公司注册、开户、财税、专利、路演等具体流程；
- 面向企业运营的 Dashboard、模板和服务市场。

### 12.2 由 Morphz Runtime 提供的通用原语

- Agent、Context、Mind、Session；
- Principal、身份保证与消息来源；
- Objective、Thread、Activation、Schedule；
- Tool、ExecutionJob、ExecutionTarget；
- Approval 和 Capability Lease；
- Ledger、Artifact、Signal 与可恢复执行；
- Shared Mind 与 per-Evaluation projection；
- Secret reference 和所属信任域。

### 12.3 何时考虑沉入 Runtime

只有某项能力同时满足以下条件，才考虑从 Company OS 下沉：

1. 不只适用于公司运营，在其他领域也反复出现；
2. 需要 Runtime 提供持久性、幂等、并发、取消或安全不变量；
3. 仅靠 Harness、Tool 或应用数据库无法可靠实现；
4. 已经通过多个真实工作流证明语义稳定；
5. 下沉不会把供应商、合同等业务语言污染为 Runtime 核心概念。

未来可能满足条件的通用能力包括：

- 持久等待外部人类或机构回复；
- 将邮件、Webhook、人工回填映射为权威 Signal；
- 带截止时间、升级和取消语义的 External Task；
- 对现实承诺提供不可绕过的结构化审批；
- 对外部副作用提供幂等、对账和 side-effect uncertainty。

在真实重复模式出现前，不预先扩张 Runtime。

## 13. 从真实运营中自然生长

Company OS 应从采用方的真实运营中自然生长，避免为了建设运营系统而中断公司的核心工作。

建议采用：

```text
第一次：授权负责人和公司 Agent 协作完成，完整记录
第二次：复用清单、模板、证据和审批规则
第三次：形成稳定流程与半自动化
跨公司重复：抽象成对外产品模块
```

每件真实事务至少记录：

- Matter ID、目标和完成标准；
- 起止时间与关键截止日期；
- 参与 Principal、服务商和机构；
- 每一步由授权负责人、公司 Agent、工具还是人类完成；
- 使用了哪些资料、授权和审批；
- 发生过哪些异常、等待和人工接管；
- 最终交付物与证据；
- 实际成本和时间；
- 完成后的简短复盘与可复用流程。

## 14. 真实运营验证方法

该模型必须通过真实公司事务验证，而不能只用模拟对话证明。采用方可以选择合同、供应商协作、财税、知识产权、招聘、产品发布或客户交付等具有外部约束的事务，完整观察从需求进入到交付验收的闭环。

建议衡量标准：

| 维度 | 目标 |
|---|---|
| 完整性 | 重要事项、材料和截止时间无遗漏 |
| 时间 | 降低负责人和团队用于检索、整理、追踪和重复沟通的时间 |
| 正确性 | 关键事实有来源，不将推断伪装为事实 |
| 安全 | 无未经批准的披露、承诺、付款或正式提交 |
| 可恢复 | Agent 或连接器不可用时，公司仍可查看台账并人工继续 |
| 可复用 | 重复事务能够复用模板、步骤、验证和审批规则 |
| 可审计 | 能解释谁在何时基于什么证据作出了什么决定 |

系统必须满足一条运营底线：

> 即使 Morphz 暂时不可用，公司也必须能够继续运行。

合同、财务凭证、银行资料、法定期限和权威状态需要保存在独立、标准、可导出的系统中，不能只存在于 Agent 认知中。

## 15. 何时创建新的永久 Agent

不因出现一类职能工作就创建永久 Agent。只有出现以下真实边界时才考虑：

- 对外需要一个长期独立的身份和人格；
- 不同客户或公司之间存在强数据隔离要求；
- Agent 由不同所有者或 Principal 控制；
- 存在不同法律责任或授权链；
- 需要长期独立的目标、关系和组织记忆；
- 需要真正独立的监督主体，而不是同一权限下的角色扮演；
- 单一 Shared Mind 经过真实验证后出现无法通过投影、索引和权限控制解决的质量问题。

在此之前，采用：

```text
一个长期 Agent
+ 一个长期 Company Context
+ 多个 CompanyMatter
+ 多条对话或系统 Session
+ Session 内并发推进 Matter 的 Thread
+ 临时专业 Evaluator
+ Matter-scoped Mandate
+ Action-scoped Approval
```

## 16. 当前架构决策

截至本文日期，形成以下决策：

1. 一家公司使用一个长期 Morphz Agent 承载统一身份与人格；
2. 该 Agent 使用一个主要的长期 Company Context 承载统一组织认知；
3. 公司事务由上层 CompanyMatter 描述；Session 承担对话或系统连接与局部连续性；Thread 在 Session 内承担推进事务的因果执行链，三者不强制一一映射；
4. Session 和 Principal 用于区分关系、对话主体与消息来源；
5. 专业工作优先使用临时 Evaluator、Sub Agent、Harness 或确定性工具；
6. 授权面向事务与具体 Action，不面向人格角色；
7. Tool 和 Execution Target 保持 Runtime 原有语义，人类服务协调首先在 Company OS 建模；
8. 敏感资料通过 Secret Store、Document Vault 和引用式访问管理；
9. 关键事实必须带证据，关键承诺必须经过明确审批；
10. 外部 Principal 直接接入 Company Context 采用渐进开放；
11. Company OS 从采用方真实运营中自然生长，不应成为其核心业务的前置条件；
12. 该模型是否能够成为对外产品，应由跨公司、跨事务的真实结果决定。

## 17. 开放问题

以下问题保留给真实运营验证：

1. CompanyMatter 应由独立服务持久化，还是作为 Morphz 上层 App projection；
2. Matter 与 Objective、Thread、Session 的稳定映射关系；
3. Mandate 与现有 Approval、Capability Lease 的组合方式；
4. 同一 Company Context 面向外部 Principal 时的信息流强制策略；
5. 外部消息、电话和人工回填如何形成可信 Event；
6. AI 对外谈判时的身份披露、承诺边界和记录方式；
7. 电子签约、付款、盖章和正式申报的最小安全闭环；
8. 如何让 Reviewer 真正独立，而不是重复同一模型偏差；
9. Shared Mind 长期增长后的索引、退役、召回和组织知识质量；
10. 哪些 Company OS 能力经过多领域验证后值得沉入 Runtime；
11. 对外商业化时按公司、用量、事务还是托管服务订阅计费；
12. 如何形成可公开且不泄露采用方敏感信息的真实案例研究。

## 18. 核心愿景

本模型最终追求的不是一个“由许多 AI 员工模拟传统部门”的公司，而是：

> 一家公司拥有一个持续存在的人工认知主体。它通过多个会话理解不同关系，通过并发事务处理复杂工作，通过软件和人类执行现实动作；它拥有全局认知，但只在当前事务中获得有限权力。

因此，Morphz Agent-Native Company Operating Model 的核心原则仍然是：

> **全局认知，局部行动；统一人格，按事授权。**
