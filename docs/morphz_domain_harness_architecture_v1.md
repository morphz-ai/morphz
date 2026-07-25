# Morphz Domain Harness：Runtime 之上的可加载领域运行层 v1

> 状态：架构边界已稳定；`.hns` v1 Loader、显式双求值与最小 Typed Plan IR 已实现，Scheduler 持久执行尚未实现
> 日期：2026-07-25
> 适用范围：Runtime、Context Encoding、Objective / Evaluation、Skill、工具、领域认知 Frame 与未来 Harness 包
> 配套设计：[Yao Harness `.hns` 包、显式双求值与 Typed Plan IR v1](morphz_yao_harness_file.md)

## 1. 核心结论

Morphz 不应为 Coding、知识工作、研究、视频编辑等领域分别复制一套 Agent Runtime。它们共享同一个通用 Runtime，但可以在 Runtime 之上挂载不同的 **Domain Harness（领域运行套件）**。

Harness 的职责是把通用 Agent 接入一个具体领域的对象、工具、证据和工作方法，使模型知道：

- 这个领域中有哪些对象和能力；
- 哪些现实状态可以被观察；
- 工作如何拆分、协调和验收；
- 哪些经验值得保留为可演化的认知 Frame；
- 何时按需发现并加载更具体的 Skill。

可以把它类比为操作系统上的“领域用户空间”：

```text
Runtime Kernel  提供调度、事务、权限、因果和恢复等系统能力
Domain Harness  把这些能力组织成某个领域的工作环境
Skill           在该环境中按需加载具体知识或过程
LLM             依据当前认知和现实证据作出语义决策
```

因此：

> Runtime 构造可信的现实边界；Harness 提供领域语义和工作方法；模型在两者之上形成判断并行动。

Harness 不只是一组 Prompt 或默认 Frame。它还可以提供由 Runtime 确定性推进、在 `infer` 节点交给 LLM 的 Yao 程序。Yao 程序先进入 Typed Plan IR，再复用统一 Scheduler Kernel 执行；Harness 不能借此形成第二套调度器。

当前已经明确最小 `.hns` 包边界和显式 `eval/infer` 求值语义，但这只是目标设计，不代表现有原型已经具备副作用安全、持久恢复和生产可用的包加载器。

## 2. 为什么需要 Harness 层

近期并发编码评测已经显示：Runtime 能够负责并发 Evaluation、重启恢复、过期写入拒绝和真实工具执行，但它不应该替模型决定：

- 哪个 Objective 应负责某个源文件；
- 是否可以复用兄弟线程已经得到的编译或测试证据；
- 哪些验证应当局部执行，哪些必须进行集成验证；
- 两个并发修改是否在语义上可能冲突；
- 某次重复读取或重复测试是否仍有信息价值。

这些并不是 Runtime 的物理不变量，而是 Coding 领域的认识纪律。如果把它们硬编码进 Runtime，Runtime 会逐渐成为只适用于编码任务的特化 Agent；如果完全不提供，又会让每个模型从零猜测领域工作方式。

Harness 正好位于两者之间：Runtime 提供通用机制，Harness 赋予机制领域含义，模型保留最终决策权。

## 3. Harness 在整体架构中的位置

Harness 不是简单地位于“人格之上”或“人格之下”。Agent 的持续身份与 Mind 是主体，Harness 是主体在求值某个 Objective 时挂载的领域工作环境。

```text
                   Agent Identity + Shared Mind
                              │
                 Objective / Evaluation Activation
                              │ mounts
                      Domain Harness
                    ┌─────────┴─────────┐
               Domain Frames       Lazy Skills
                    │                     │
                    └─────────┬───────────┘
                              │ uses
                       Runtime Kernel
       Ledger · Context Tx · Scheduler · Sandbox · Permission
       Causality · Identity · Tool I/O · Recovery · Fencing
                              │
                         Real World
```

这意味着同一个 Agent 可以：

- 在一个 Objective 中挂载 Coding Harness；
- 在另一个 Objective 中挂载 Research Harness；
- 在第三个 Objective 中挂载 Video Editing Harness；
- 继续共享它自身的身份、Mind 和跨领域经验。

Harness 最适合绑定在 Objective / Evaluation，而不是永久绑定在 Agent，也不等同于 Session。Session 负责对话关系和消息路由；Harness 负责当前求值所处的领域运行环境。

## 4. 四类职责的边界

| 层次 | 应负责的内容 | 不应负责的内容 |
| --- | --- | --- |
| Runtime | 事件顺序、事务一致性、资源租约、权限、沙箱、工具结果、并发、恢复、fencing | 判断某文件应归哪个功能模块、规定某领域的最佳工作流程 |
| Harness | 领域对象、工具适配、证据语义、默认认知纪律、Skill 路由、验证入口 | 绕过 Runtime 权限、伪造执行结果、替代外部真实校验器 |
| LLM / Agent | 理解任务、选择 Harness 与 Skill、拆分工作、调度、权衡、学习和回复 | 改写已经发生的现实、把叙述当作工具成功 |
| 外部校验器 | 编译、测试、业务规则、渲染检查、审批结果等现实判断 | 替 Agent 形成完整认知和任务策略 |

一个通用机制可以被 Runtime 提供，但其使用策略不应被 Runtime 决定。例如：

- Runtime 提供 `resource claim / lease`；Coding Harness 将资源解释为文件、模块或测试环境；
- Runtime 保存带来源和版本的 Evidence；Coding Harness 决定何时可复用编译证据；
- Runtime 保证 workspace revision 精确；模型判断某个旧测试结果是否已因新修改而失效；
- Runtime 提供依赖与等待关系；Harness 给出领域中的常见依赖表达，模型决定串行还是并行。

## 5. Harness 不是什么

### 5.1 Harness 不是 Skill

Harness 是持续存在的领域工作环境，Skill 是在这个环境中按需加载的具体知识或过程。

```text
Coding Harness
├── Rust Skill
├── PostgreSQL Skill
├── GitHub PR Skill
├── Debugging Skill
└── Release Skill
```

Harness 告诉 Agent 如何在代码世界里工作；Rust Skill 告诉它如何处理一个具体的 Rust 问题。把所有 Skill 全量放进 Context 会浪费 Token；Harness 应只提供紧凑的能力索引和发现路径，详细 Skill 延迟加载。

### 5.2 Harness 不是 Agent 身份

“我是怎样的主体”属于 Identity；“我现在用哪套领域环境工作”属于 Harness。一个具有稳定人格和共享 Mind 的 Agent 可以切换 Harness，而不需要复制成多个 Agent。

### 5.3 Harness 不是 Role

Role 是当前关系中的职责，例如项目维护者、审阅者或某人的助理。Harness 可以支持 Role 的执行，但不会替代关系语义。

### 5.4 Harness 不是 Sub-agent

Sub-agent 是一个独立求值主体或算力节点；Harness 是它所挂载的运行环境。多个 Agent 可以使用同一种 Harness，一个 Agent 也可以在不同 Evaluation 中使用不同 Harness。

### 5.5 Harness 不是第二套调度器

Harness 可以给出领域调度建议和默认策略，但 Objective、Evaluation、Activation、Thread、依赖、定时和恢复仍由统一 Scheduler Kernel 承载。否则不同 Harness 会各自制造不一致的并发模型。

## 6. 一个 Harness 的概念组成

以下能力通过 `.hns` 包组织；`.hns` 可以是包含多个顶层 artifact 的
单文件，也可以是承载更多资源的目录。v1 的职责已经确定，但各 artifact
的完整字段仍应随实现和真实评测收敛：

1. **Manifest（清单）**：名称、版本、领域、兼容的 Runtime 契约、依赖和入口。
2. **Harness Contract（领域契约）**：稳定的对象、算子、能力与现实语义，并用自然语言说明每项含义。
3. **Context Encoder（上下文编码器）**：把领域状态紧凑地编码进当前求值视图。
4. **Projection Adapter（投影适配器）**：将 Ledger 中相关事实投影为可查询的领域状态，但不改变 Ledger 的权威性。
5. **Tool Bundle（工具集合）**：领域工具、参数规范、结果结构和错误语义；仍受 Runtime 权限与沙箱控制。
6. **Default Frames（默认认知 Frame）**：由人精心构造的领域认识纪律和可复用经验。
7. **Skill Index（技能索引）**：紧凑描述可发现的 Skill，具体内容按需加载。
8. **Evidence / Validator Adapter（证据与校验适配）**：把测试、编译、渲染或业务验证结果转换为具有来源的 Observation。
9. **Presentation Metadata（可选展示元数据）**：帮助 Dashboard 或 CLI 展示领域对象，但不能成为 Runtime 正确性的依赖。
10. **Migration（迁移规则）**：Harness 契约升级时处理其命名空间内的 Projection 和默认 Frame。

Harness 可以拥有命名空间化的 Projection 和 Event 类型，但不应为了每个领域不断扩大 Kernel 的核心数据库模型。

紧凑或内置 Harness：

```text
coding.hns
  (manifest ...)
  (contract ...)
  (mind ...)
  (eval ...)
```

资源较多时：

```text
coding.hns/
├── manifest.yao
├── contract.yao
├── mind.yao
├── programs/
├── skills/
├── validators/
└── migrations/
```

`.hns` 是 Harness package 后缀；`.yao` 是目录包内结构化源文件后缀。
两种形态必须由 Loader 归一化成相同的 `HarnessPackage`。Manifest 面向
Runtime 加载，Contract 面向模型的稳定领域理解，Mind 提供挂载期默认
认知，Program 提供显式 `eval/infer` 求值结构。

## 7. 稳定契约与可进化认知必须分开

Harness 内部有两种性质完全不同的内容。

### 7.1 稳定、版本化的领域契约

包括：

- 工具和算子的准确含义；
- 证据来源、版本与有效性表达；
- Runtime 能保证的资源租约、权限和事务语义；
- 领域对象如何进入 Context Encoding；
- 失败、等待和校验结果如何被观察。

这些内容不能由模型在运行中随意改写，只能通过明确版本升级演化。

### 7.2 Agent 可维护的认知纪律

包括：

- 如何拆分这一类问题；
- 什么风险值得优先验证；
- 如何减少重复工作；
- 哪些证据通常可以复用；
- 如何协调并发 Objective；
- 从长期实践中总结出的领域经验。

这些内容可以作为 Frame 被 Agent `derive`、`revise`、`retire`、交换或从外部植入。它们不是物理真理，也不应伪装为 Runtime 契约。Harness 自带的默认 Frame 首先以只读、Objective / Evaluation-scoped 方式挂载；只有 Agent 或用户通过显式 Context 事务/import 选择保留时，才进入共享 Mind。

这一分离避免两个极端：既不把易变经验硬编码进 Runtime，也不允许模型把工具和现实规则重新解释成自己希望的样子。

## 8. 与 Yao、SExpr VM 和 Runtime 求值的关系

Harness 契约可以使用 SExpr 提供结构，同时在基础算子和领域能力节点内用自然语言准确说明语义。SExpr 表达的是需要模型实际遵循的过程与关系，而不是要求模型模拟传统 CPU 逐字符解释。

包内 Contract 可以表达为：

```lisp
(contract
  (version "1.0.0")

  (identity
    "这是面向软件仓库求值的领域运行环境。")

  (resource
    (kind file module workspace-revision)
    (description
      "资源声明用于让并发 Evaluation 看见彼此正在修改的范围；
       声明不自动证明所有权合理，也不取代模型的协调判断。"))

  (evidence
    (kind read-result test-result compile-result diff)
    (description
      "证据必须保留来源、产生它的 workspace revision 和时间；
       是否仍可复用由当前求值根据后续变更判断。"))

  (skills
    (discover rust postgres github-pr debugging release)))
```

可执行程序则显式声明求值权：

```lisp
(eval
  (requires
    (tools read edit exec))

  (seq
    (bind repository
      (call inspect-repository))

    (bind plan
      (infer
        (task "根据仓库证据制定修改方案")
        (input repository)))

    (call apply-plan
      (plan plan))

    (call run-tests)))
```

最外层 `eval` 表示 Runtime 主导；内层 `infer` 表示在该节点创建子 Evaluation，由 LLM 完成非确定性求值。模型主导型 Harness 使用显式顶层 `(infer ...)`。未知根节点不能默认为某个求值器。

Runtime 不直接解释字符串并调用物理工具。Yao 程序必须先解析、校验并 lowering 为 Typed Plan IR；`call` 物化为 Execution Job / Action Group，`infer` 物化为 Evaluation，等待结果后再从持久化程序位置恢复。

完整边界见 [Yao Harness `.hns` 包、显式双求值与 Typed Plan IR v1](morphz_yao_harness_file.md)。

知识工作 Harness 可以定义人员、组织、日历、消息、审批、委派和截止时间；视频编辑 Harness 可以定义素材、时间线、轨道、时间码、渲染、预览和转码。它们复用同一组 Runtime 事务与调度机制，但不会把不同领域强行压成相同的数据对象。

## 9. 挂载、切换与生命周期

第一阶段最稳妥的语义是：

- 一次 Objective / Evaluation 最多挂载一个 Primary Harness；
- Agent 可以根据用户指定、Objective 元数据或自身判断选择 Harness；
- Harness 只改变当前领域求值环境，不清空 Agent 的 Mind、人格或 Session；
- Harness 的动态领域状态使用独立命名空间，可随工作集 swap in / swap out；
- 卸载 Harness 不删除 Agent 从实践中形成的 Frame，但 Frame 应保留来源、适用领域和版本信息；
- 同一个 Context 中的不同 Evaluation 可以并发挂载不同 Harness。

未来可以探索 Primary Harness 加 Auxiliary Harness 的组合，例如 Coding + Security Review，但第一版不应直接支持任意多 Harness 叠加。组合会带来工具同名、上下文优先级、纪律冲突、Projection 归属和 Token 预算等问题，必须有显式冲突规则后再开放。

## 10. 优先级与安全边界

Harness 永远不能覆盖 Runtime 的物理事实和安全边界。建议优先级为：

```text
Runtime invariants and permissions
  > Harness stable contract
  > Agent identity and relationship constraints
  > Harness cognitive Frames
  > Objective / Session instructions
```

这不代表 Runtime 判断任务内容是否正确。代码能否编译、视频能否渲染、业务规则能否通过，仍由实际任务的执行方和校验器判断。Runtime 只保证观察到的结果没有被 Agent 的叙述替代。

Harness 提供的工具必须继续经过统一沙箱、权限审批、Principal 校验和审计。Harness 可以缩小能力范围，不能扩大 Runtime 未授权的能力。

## 11. Context Encoding 与 Prefix Cache

Harness 不能以牺牲上下文效率为代价。它进入 Context Encoding 时应分层：

1. 稳定、短小的 Harness 身份和契约放在稳定 Prefix 中，以利用 Prefix Cache；
2. 紧凑 Skill Index 只说明有哪些能力以及如何发现；
3. 详细 Skill 在被选择后延迟加载；
4. 当前资源、证据、依赖和领域 Projection 属于动态区；
5. Agent 自己形成的领域 Frame 按相关性、工作集和 Context pressure 激活；
6. 不活跃的领域状态和 Frame 可以 swap out，并保留在持久 Projection / Ledger 中。

因此 Harness 不是一份每轮重复注入的巨大 Prompt，而是一套可编码、可投影、可延迟发现的领域环境。

## 12. 对最新并发评测的解释

并发 Objective 评测中出现的重复读取、重复验证和源文件修改重叠，不应直接归因于 Scheduler Kernel 失败。更准确的分层判断是：

- Runtime 已提供并发、因果、恢复、过期写入保护和共享 Context；
- 模型可以看见兄弟 Evaluation 的一部分状态；
- 但当前没有正式 Coding Harness 告诉它如何声明领域资源、解释证据版本、复用兄弟结果和安排集成验证；
- 因而协调效果主要依赖模型自身能力和临时推理，效率不稳定。

这正是 Harness 的验证场景：保持 Runtime 和任务完全一致，只改变是否挂载 Coding Harness，比较正确性、重复工具调用、冲突率、证据复用率、Token、时长和最终交付质量。

## 13. 未来的分发形态

Harness 以 `.hns` 单文件或目录包成为可版本化、可分享、可交换的分发
单元。一个组织可以发布自己的 Coding Harness，一个创作者可以发布视频
生产 Harness，一个 Agent 也可以把长期实践形成的高质量领域 Frame 导出给
另一个 Agent。

但需要保持三类资产的边界：

- Runtime 契约由 Morphz Kernel 维护；
- Harness 稳定契约由 Harness 发布者维护；
- Agent 学习得到的 Frame 属于具体 Agent / Context，只有经过选择才交换。

安装 Harness 不等于盲目导入另一个 Agent 的认知，也不自动授予任何工具权限。

## 14. 暂不实现的内容

本设计当前不承诺：

- 冻结 `.hns` 中所有可选字段或完整 Yao 算子集合；
- 在 Scheduler Kernel 中加入 Coding 专用字段；
- 支持任意多个 Harness 组合；
- 自动相信 Harness 提供的校验结果；
- 把所有领域 Skill 一次性放入 Context；
- 为不同 Harness 复制 Agent、Session、Ledger 或 Runtime；
- 仅凭一两个任务就证明 Agent 已形成可泛化的领域认知。

这些边界可以避免在证据不足时把一个正确的架构方向过早固化成错误接口。

## 15. 后续验证路径

实现和验证应按以下顺序推进，而不是直接建设完整生态：

1. 收敛显式 `eval/infer` 与 canonical operator schema，把现有 AST 变成可序列化 Typed Plan IR；
2. 让 `call/infer` 分别物化为正式 Execution Job / Evaluation，并实现 Plan suspend/resume；
3. 实现最小 `.hns` loader、Manifest、Contract、默认 Frame 挂载与 HarnessBinding；
4. 用外部 Coding Harness 对现有编码任务做严格 A/B；
5. 增加崩溃恢复、审批、Edge Target、并发 Objective 和 Context pressure 场景；
6. 用较弱模型和非 Coding 任务复测，判断增益与领域污染；
7. 稳定增益出现后，再扩展 migration、签名、组合规则和发布生态。

## 16. 仍需回答的问题

- Harness 应由用户显式选择，还是允许 Agent 自动选择并说明理由？
- Agent 从 Harness 默认 Frame 派生的持久 Frame 默认属于 Agent、Context、Harness 实例还是 Objective？
- 一个 Frame 从 Coding 迁移到 Research 时，适用范围如何表达？
- Harness 升级时，旧 Frame 与新契约冲突如何检测？
- 多 Harness 组合时，工具同名、纪律冲突和 Token 预算如何裁决？
- 哪些领域 Projection 值得持久化，哪些只应作为可重建缓存？
- Harness 的质量应以任务正确率、执行成本、学习迁移还是长期稳定性为主？

这些问题需要实验回答，不应仅凭接口美感提前决定。

## 17. 与现有设计的关系

- [分层认知 VM 与可加载身份架构](./morphz_layered_cognitive_vm_identity_architecture.md)：定义底层 VM、认知架构和高层身份；Harness 是一次领域求值所挂载的运行环境。
- [外生 Coding Frame A/B](./morphz_coding_frame_ab_v1.md)：证明外部领域 Frame 可以被加载和求值，也说明僵硬串行流程可能成为负优化。
- [Frame VM：模型、认知与算力解耦](./morphz_frame_vm_model_cognition_decoupling.md)：讨论领域知识与模型权重解耦后，小型专用 Frame VM 的可能性。
- [Scheduler Kernel 与领域模型](./morphz_scheduler_kernel_and_domain_model_v1.md)：定义统一的 Objective、Evaluation、Activation、Thread 与调度内核；Harness 必须复用而不能复制该模型。

Harness 将这些设计连接成一个更完整的方向：Morphz 的核心不是制造一个固定用途的 Agent，而是提供一个通用的认知 Runtime，让同一个持续存在的 Agent 可以加载不同领域的运行套件、按需调用 Skill，并在真实工作中形成可迁移和可交换的经验。
