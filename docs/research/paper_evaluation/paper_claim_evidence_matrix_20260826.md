# Morphz 论文主张—证据矩阵（2026-08-26）

> 用途：作为中英文论文改稿的唯一数字与主张入口。最终论文可以压缩表达，但不得越过本表
> 记录的证据边界。ME-08 完整 89 题结果与统计已经闭合；失败和无效启动不从审计记录删除。

## 1. 论文中心主张

Morphz 将结构化 Context 作为 Agent 持久认知状态，并让语言模型在递归程序—数据统一表示上
承担**非确定性认知符号求值**；确定性 Runtime 负责类型、引用、版本、权限、事务、现实副作用
和持久恢复。本文首先证明这套机制可实现、可跨模型运行并带来消息列表本身不直接提供的能力；
其次检验在公平基线和外部任务上是否观察到通用任务能力退化。本文不要求证明 S-expression
括号语法普遍优于 JSON/Markdown，也不把尚未实现的一等 Program-valued `infer` 作为当前贡献。

论文术语统一使用“非确定性认知求值 / nondeterministic cognitive evaluation”。实验内部
`bounded_open_*` 等历史 ID 只作为可复现标识，不在论文叙事中称为“开放求值”。

## 2. 已冻结证据

| 实验 | 关键结果 | 可以支持 | 不可以支持 |
| --- | --- | --- | --- |
| ME-01 结构化 Context 与结果回流 | 5 任务族 × 3 arms = 15/15 严格成功；生产 Morphz 真实执行 SQLite、Context 投影、`context_tx`、跨 Session、进程重启和 Context 隔离 | 在无容量压力的简单任务上，结构化 Context 与 Mind Frame 未观察到最终行动退化；额外的持久事务、跨 Session 共享和隔离机制真实执行 | Morphz 优于完整消息历史；统计非劣效；Token 或速度优势 |
| ME-02 等信息递归表示 | S-expression AST、JSON AST、Markdown Program 各 6/6，共 18/18；96 次模型请求、78 次工具调用 | S-expression 能作为程序—数据递归表示被读取和求值；相对同一 Canonical IR 的两种替代表示未退化 | S-expression 在准确率、Token 或综合能力上优于替代语法 |
| ME-03 非确定性认知求值 | 非确定性条件 12/12 严格；Base/Intervention 6/6 随 Context 改变且仍落在合法集合；确定性控制 11/12 严格、12/12 语义值正确 | 同一认知符号可以具有多个合同允许值；求值受当前 Context 约束；非确定性不要求重复采样出现随机变化 | 模型输出高熵或随机；长期 Context 优势；S-expression 优势 |
| ME-04 Runtime 权威边界 | 8/8 故障/权限 cells 通过；完整 lib 989 passed；恶意 Observation 无法扩大工具权限；并发版本、重放、副作用和恢复边界通过确定性 Gate | 模型生成的候选值与权威现实提交可以被确定性分离；安全主张来自 Runtime Gate，而不是模型自觉 | 识别全部 Prompt Injection；形式化证明整个系统安全；所有外部副作用均可恢复 |
| ME-05 九模型普适性 | 144/144 完整；冻结严格 98/144；程序最终值 32/36；4 个未交付均为 Claude Provider refusal；非确定性求值事后语义诊断 104/108，且 104/104 可解析结果满足可见 Context 合同 | 机制不依赖单一模型家族；语义正确与 schema/轨迹合规必须分开；确定性校验层具有现实必要性 | 九模型同等可靠；68.1% 是公开榜分；某模型综合智力更高；忽略 Provider 失败后的选择性高分 |
| ME-08 Terminal-Bench 2.1 完整 89 题 | 同环境、同 GPT-5.6 Sol/max、每题一次：Morphz 70/89（78.65%），official Codex 73/89（82.02%）；配对差 −3.37pp，95% paired bootstrap CI [−13.48pp,+6.74pp]，双侧精确 `p=0.678` | Morphz 完整 Agent 在完整公开任务集上与 Codex 处于同一表现量级；额外状态/事务机制没有伴随灾难性通用能力损失；完整任务集优于选择局部子集 | 官方榜单成绩；形式化非劣、等价或优越；估计同题采样方差；结构化 Context 导致 Token 优势 |
| ME-06 长期 Structured Context 与受控 Compaction | 3 paired fixtures；两臂均 3/3 fixture、24/24 最终状态字段、3/3 唯一行动；Morphz 真实执行 40 次 Context transaction、跨 Session、版本冲突重读、重启恢复、隔离与因果审计；Morphz 5,093,621 total tokens，受控基线 310,336（约 16.4×） | 在三个长程任务上未观察到相对一次现代受控 compaction 的最终能力退化；Frame 事务、持久恢复和因果审计为额外系统能力；当前实现存在显著 token 成本 | Morphz 准确率或 token 优于 compaction；三个样本具有统计显著性；该结果是公开记忆榜分 |

## 3. 正在完成的证据

### ME-07：真实学习产物 Gate 已完成，尚无效果证据

旧 ME-07 LongMemEval-V2 Small 运行使用了未经用户授权的替代 reader/judge 模型，已终止并
保留审计记录；任何局部数量、分数或延迟均不进入本文证据。替代方案已选择 STATE-Bench
Agent Learning，在同一 reasoning model、相同 train trajectories 与相同只读检索合同下比较
生产 Morphz、A-MEM 和 Mem0；no-memory 不作为正式实验臂。三臂 adapter、真实学习、冻结、
关闭后重载与检索 Gate 已全部通过。锁定的 GPT-5.4 Azure evaluation client 和完整 9 份领域
学习产物尚未完成，因此 ME-07 仍不提供任何效果结论。

## 4. 论文结果组织

1. **机制可执行且不退化：** ME-01、ME-02；
2. **非确定性认知求值及其边界：** ME-03、ME-05；
3. **确定性权威与额外系统能力：** ME-04、ME-06；
4. **长期状态与额外状态语义：** ME-06；
5. **完整 Agent 外部系统效度：** ME-08 的 89 题同环境配对结果；
6. **共同结论：** Morphz 改变状态与求值机制并获得持久、可寻址、可事务、跨 Session、恢复
   和审计能力；已有简单和外部任务证据未显示灾难性通用能力代价，但 ME-08 的宽区间不足以
   证明形式化非劣。ME-06 未观察到准确率优于 compaction，且暴露出当前实现的显著 token
   开销；本文不报告公开长期记忆榜分。

## 5. 必须保留的有效性威胁

- ME-01/02/03 是 Pilot，部分 cell 存在天花板效应；
- ME-05 的严格合同分与语义诊断分回答不同问题，二者都必须报告；
- ME-06 只有 3 个 paired fixtures，不作统计显著性宣称；
- ME-07 旧 LongMemEval 运行已取消；STATE-Bench 仅完成真实学习产物 Gate、尚无官方效果
  结果；任何中止运行的局部结果都不作为论文效果证据；
- ME-08 每题只运行一次，能够进行同环境 paired 描述和检验，但不能估计同题采样方差；
- Provider refusal、timeout、Runtime 和 harness failure 必须分层，不按对某组有利的方向删除；
- Program-valued `infer`、任意动态交替和“无限寿命 Agent”仍是未来能力。
