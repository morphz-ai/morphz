# Morphz 结构化上下文规范 v1

> 状态：规范候选草案
>
> 标准维护者：新变元（Newvar）
>
> 参考实现：Morphz
>
> 源码基线：Morphz Context Protocol v32 与 2026-08-15 Runtime 状态索引
>
> 日期：2026-08-21
>
> 规范文本：[English](../morphz_structured_context_specification_v1.md)
>
> 翻译说明：本文件是英文规范的中文翻译；如含义冲突，以相同版本的英文文本为准。

## 1. 范围

本规范定义 Morphz 结构化上下文的规范性数据模型、权责边界、事务行为、来源关系、注意力生命周期和恢复性质。

本规范有意将公开标准与当前序列化方式和代码结构分开。Protocol v32 是起草这一候选规范所依据的实现来源；公开规范将拥有独立的语义版本号，不得仅仅因为参考实现当前包含某个内部字段，就自动继承该字段。

## 2. 规范用语

本文中的 MUST、MUST NOT、REQUIRED、SHOULD、SHOULD NOT 和 MAY 表示规范要求。

- **MUST / MUST NOT（必须／不得）**：相应一致性 Profile 的强制要求。
- **SHOULD / SHOULD NOT（应该／不应该）**：除非实现记录了合理理由，否则应当满足。
- **MAY（可以）**：可选行为，可移植的调用者不能依赖其必然存在。

除非明确标记为规范要求，示例和实现注释均不具有规范性。

## 3. 核心实体

### 3.1 Agent

Agent 是稳定的逻辑认知行动者。它不等同于模型进程、Provider 请求、Session 或操作系统进程。

Agent 必须具有稳定标识。替换模型或重启 Runtime 不得隐式替换 Agent 身份。

### 3.2 Context

Context 是由 Agent 拥有或使用的第一等、带版本认知状态。它包含或寻址：

- 不可变的 Event History；
- Runtime 拥有的 Kernel Projection；
- Agent 拥有的 Mind Projection；
- 已交付的 Inbox 或 Observation 状态；
- Session 与注意力 Projection；
- 一组具有单调顺序的已提交 Context Transaction。

Context 必须公开稳定标识和当前 revision。

### 3.3 Session

Session 是挂载在 Context 上的稳定交互连接。它必须拥有自身身份，且不得被用作 Context 或 Agent 的同义词。

多个 Session 可以共享一个 Context。不同 Session 的请求可以并发执行，但必须遵守本规范中的因果可见性与事务规则。

### 3.4 Event

Event 是一次现实发生的不可变记录。它必须具有：

- 稳定标识；
- 权威 sequence 或等价的顺序坐标；
- topic 或 type；
- actor 或权威来源；
- 足以确定其 Context，以及在适用时确定其 Session 的路由身份；
- Runtime 已知时的直接因果引用。

实现不得原地修改已提交 Event。更正和取代事实必须通过新 Event 表达。

### 3.5 Observation 与 Inbox

Observation 是 Event 或 Runtime 事实面向 Agent 的可见表达。Inbox 是仍可供 Agent 认知处理的 Observation 交付区域。

Observation 必须保留返回其源 Event 的稳定路径。将 Observation 渲染为 preview、metadata-only 条目或 recalled chunk，不得改变原始 Event。

### 3.6 Kernel

Kernel 是 Runtime 拥有的权威运行事实 Projection，包括身份、权限、活动执行、预算、压力、版本和控制状态。除显式 Runtime Command 外，Agent 对其只有读取权。

### 3.7 Mind

Mind 是 Agent 拥有的认知 Projection，由 Frame 和 Relation 组成。Frame body 内可以包含任意领域结构。

Runtime 必须只理解验证、版本控制、排序、保护、关联、投影和恢复 Frame 所必需的结构元数据，不得要求 Frame body 遵守一种通用业务本体。

### 3.8 Frame

Frame 是稳定的认知单元，至少具有：

- Context 内唯一的标识；
- revision；
- Agent 编写的 body；
- 生命周期状态；
- 可选的保护状态；
- 可选的来源引用。

修订 Frame 时必须保留其身份并增加 revision。即使活动 Projection 只包含最新 body，历史 Frame body 仍必须能从已提交事务事实中恢复。

### 3.9 Relation

Relation 是稳定标识之间的显式边。默认情况下 Relation 名称保持开放。除非本规范或扩展 Profile 明确定义，否则实现不得自行推断某个 Relation 的标准业务含义。

### 3.10 Projection

Projection 是根据权威历史派生出的当前状态视图。Event History 回答“发生过什么”，Projection 回答“现在是什么”。

Projection 损坏时，必须能够从权威记录恢复，或者显式失败。Runtime 不得通过静默创造缺失历史来“修复” Projection。

## 4. 权责矩阵

| 状态或决策 | Agent 权力 | Runtime 权力 |
| --- | --- | --- |
| Frame body 与认知意义 | 创建和解释 | 持久化并验证结构 |
| 语义重要性与抽象 | 决定 | 不得静默赋值 |
| 证据解释 | 决定 | 保存声明的来源引用 |
| Event 身份、顺序与直接因果 | 解释 | 生成并强制执行 |
| 权限与资源限制 | 观察并遵守 | 定义并强制执行 |
| Context Transaction 意图 | 提交 | 验证、提交、拒绝和审计 |
| 活动注意力 | 请求变更 | 事务化应用并投影 |
| 物理工具结果 | 解释 | 如实记录 |
| 当前 Projection | 读取并通过允许的操作修改 | 从权威事实派生 |

## 5. Context Transaction 模型

### 5.1 事务信封

Context Transaction 必须声明基础 Context revision 或等价并发 token。事务可以包含审计 reason；在退役受保护或活动信息，或者解除保护时，必须包含 reason。

Runtime 必须：

1. 在发生修改前解析完整事务；
2. 在获得授权的 Context 中解析稳定引用；
3. 验证身份、生命周期、权限、来源和并发约束；
4. 在隔离的候选状态中计算变更；
5. 原子提交全部权威 Event 和受影响的 Projection；
6. 返回已提交 revision 和结构化结果，或者结构化拒绝；
7. 事务被拒绝时完整保留原状态。

### 5.2 核心操作

v1 候选规范定义以下语义操作：

| 操作 | 必须产生的语义效果 |
| --- | --- |
| `create` | 创建具有稳定标识的新 Frame |
| `derive` | 创建带有显式声明来源的 Frame |
| `revise` | 在保留既有 Frame 身份的同时替换其活动 body |
| `retire` | 将 Frame 或 Observation 移出活动语义注意力，但不删除历史 |
| `restore` | 让已退役 Frame 或 Observation 返回活动语义注意力 |
| `protect` / `unprotect` | 建立或移除由 Runtime 强制执行的退役保护 |
| `place` | 在不改变 Frame 意义的情况下改变注意力顺序 |
| `relate` / `unrelate` | 添加或移除显式 Relation |
| `checkpoint` | 命名一个可恢复的 Context 状态 |
| `rollback` | 从 checkpoint 派生并提交一个新状态；历史仍然保持追加式 |
| `drop-checkpoint` | 移除 checkpoint 的可用性，但不重写历史 Event |
| `retire-session` / `restore-session` | 改变 Session 的注意力成员状态，但不删除 Session 历史 |

具体线协议可以使用 Morphz `context_tx` S 表达式 DSL。独立实现可以公开另一种 API，只要它产生等价的可观察行为并通过一致性 Profile。

### 5.3 并发

当实现无法证明某项修改独立于其间已经发生的提交时，必须拒绝过期事务。

实现可以在验证读写集后，对不同 Frame 的修改执行安全 rebase。实现至少必须拒绝：

- 对同一 Frame revision 的并发不兼容修改；
- 使用相同稳定 Frame 标识创建不同内容；
- 声明的来源发生变化，从而使已提交读集失效的推导；
- 无法安全约简到独立对象的全局生命周期操作。

冲突处理必须可观察。静默采用 last-writer-wins 的实现不符合规范。

## 6. 来源与 Reality Contract

Runtime 必须区分物理事实和 Agent 结论。

- Observation 出现在 Inbox 中，不意味着它就是真理。
- 时间更新或使用次数更多，不能建立语义权威。
- 较新的物理版本不会自动证明范围更广的语义结论。
- Runtime 不得让未来证据在其物理存在且获得当前因果范围授权之前可见。
- `derive` 和带来源的 `revise` 操作必须保留声明的证据血缘。
- Agent 可以持有假设或错误认知；Runtime 仍然必须保存真实来源和事务历史。

## 7. 注意力、驻留与恢复

实现可以采用 full、preview、metadata-only、recalled、resident、swapped-out 或等价渲染状态。当这些差异影响可用内容时，每种状态必须能够被调用者区分。

实现不得：

- 把 preview 表示成完整原文；
- 把某项内容没有出现在一次模型请求中等同于语义退役；
- 把语义退役等同于物理删除；
- 在声称某项内容可恢复时，丢弃显式召回所需的稳定来源。

资源压力可以触发 Runtime Signal 或机械投影决策，但不得静默编写或改写 Agent 的语义 Frame 内容。

## 8. Session 与因果可见性

每次模型 Evaluation 必须标识其 active Session 和因果 Activation 范围。Context 范围内已提交的 Mind 状态可以在获得授权的 Session 间共享；局部 Session 证据则必须遵守自身因果边界。

迟到的工具结果必须恢复或通知创建它的因果工作。不能仅仅因为另一个 Session 当前处于活动状态，就把结果伪装成属于该 Session。

跨 Session Message 或 Signal 必须显式标识来源和目标。引用某个 Session 不得隐式导入其 transcript、激活它或复制其私有证据。

## 9. 持久化与恢复

对于 durable 一致性 Profile：

- 已提交 Context Transaction 必须在正常重启后继续存在；
- 提交前发生崩溃时，不得留下部分权威修改；
- 提交后发生崩溃时，必须能够重建相同的当前状态；
- 重建 Projection 必须产生相同的可观察 Context revision 和活动状态；
- 当协议公开稳定请求或事务身份时，重试必须具有幂等性。

## 10. 规范表示

首个公开版本将为协议夹具、哈希、调试和可复现的一致性报告定义规范 S 表达式表示。该表示必须规定字段顺序、转义方式、稳定标识、可选字段和版本协商。

当前 Morphz Renderer 是实现来源，尚不是已经冻结的公开线协议标准。仅服务于当前调度或 Provider 优化的字段，不应该进入公共规范，除非可移植调用者确实需要这些字段。

## 11. 一致性 Profile

v1 候选规范保留以下 Profile：

- **SC-Core**：对象模型、权责边界、事务语义、来源和注意力；
- **SC-Durable**：SC-Core，加上重启、重放与 Projection 恢复；
- **SC-Concurrent**：SC-Durable，加上冲突检测、因果路由和并发 Session 工作；
- **SC-Distributed**：SC-Concurrent，加上多 Runtime fencing、lease 和跨进程恢复。

具体必测用例由对应版本的一致性测试套件定义。在独立测试套件被抽取并发布签名报告之前，Morphz 不声明已经获得这些 Profile 的公开认证。

## 12. 版本与扩展

公开规范使用独立于内部 Context Protocol 编号的语义版本。

- Patch 版本澄清文字或增加测试，但不改变一致实现的行为。
- Minor 版本增加向后兼容的可选行为或 Profile。
- Major 版本可以改变强制可观察行为，并且必须提供迁移声明。

扩展必须使用带命名空间的标识，声明所需基础版本，并在所需语义不可用时显式失败。扩展不得在声称兼容原核心版本的同时，重新定义某个核心术语。

## 13. 进入 Candidate 状态前仍需决策的问题

以下问题有意保持开放：

1. 规范线表示和版本协商字段；
2. 最小可移植 Event 与 Projection Schema；
3. checkpoint 操作应属于 SC-Core 还是 SC-Durable；
4. retirement 与未来 residency/swap 语义之间的准确边界；
5. 独立实现之间 Frame 级 rebase 的兼容规则；
6. 规范性的隐私和 Principal 可见性 Profile；
7. 规范英文术语与翻译政策。

每项决策在 v1 进入 Candidate 状态前，都需要一份 MEP 或显式记录的规范评审结论。
