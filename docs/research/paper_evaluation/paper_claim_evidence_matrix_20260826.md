# Morphz 论文主张—证据矩阵（更新于 2026-08-27）

> 用途：作为中英文论文改稿的唯一数字与主张入口。最终论文可以压缩表达，但不得越过本表
> 记录的证据边界。ME-07 三系统正式结果与 Mind Frame 迁移审计已经闭合；ME-08 历史完整
> 89 题结果与统计已经闭合；`ad60e` Runtime 的 Morphz-only
> 89 题刷新已闭合，包含后续通用修复的 `4bbc3d63` 刷新也以 72/89 闭合。失败和无效启动不从审计记录删除，不把不同 Runtime 或并发条件的运行
> 拼接成新的同期 paired 结果。

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
| ME-07 STATE-Bench-derived learned-agent 对照 | 150 paired held-out tasks、每 arm 150 次：Morphz 122/150（81.33%）、Letta 93/150（62.00%）、Mem0 96/150（64.00%）；配对差 +19.33pp 与 +17.33pp，task-clustered 95% CI 均不跨零，Holm `p=0.000060`；150/150 Morphz trace Gate 通过，三个 revision-100 训练 Context 共含 144 个活跃 Mind Frame、395 条 Relation | 在固定训练轨迹、任务、模型、领域工具与评测器条件下，完整 Morphz 系统的经验迁移优于两个公开对照；训练经验实际成为 held-out 求值的结构化状态，而非仅存于外部数据库 | Mind Frame 单独造成全部分差；官方历史 STATE-Bench 排行榜成绩；题内采样方差；普遍记忆优势；Token 效率优势 |
| ME-08 Terminal-Bench 2.1 历史完整 89 题 | 同环境、同 GPT-5.6 Sol/max、每题一次、两臂并发 1：pre-fix Morphz 70/89（78.65%），official Codex 73/89（82.02%）；配对差 −3.37pp，95% paired bootstrap CI [−13.48pp,+6.74pp]，双侧精确 `p=0.678`；Morphz 报告总逻辑 Token 少 27.4%、墙钟长 18.3% | 该历史版本 Morphz 完整 Agent 在完整公开任务集上与 Codex 处于同一表现量级；Token/耗时作为 pre-fix 工程画像，cache 命中不作效率评分；完整任务集优于选择局部子集 | 当前 post-fix Runtime 的分数或效率；官方榜单成绩；形式化非劣、等价或优越；估计同题采样方差；结构化 Context 导致 Token 优势；把新 Runtime 刷新与历史 Codex 冒充同期 paired 结果 |
| ME-08 `4bbc3d63` 当前 Runtime Morphz-only 刷新 | 完整 89 题、并发 8、每题一次、零重试：72/89（80.90%，Wilson 95% CI [71.52%,87.72%]）；89 个官方 reward 与 strict Gate 通过；3 个 AgentTimeout 均保留为零；总逻辑 Token 58,787,962 | 当前修复版 Morphz 的完整公开任务工程测量；失败保留、资源负载与当前 Token 画像；相对历史 70/89 没有灾难性回退 | 与历史 Codex 的同期配对、显著性或效率结论；把 72/73 单次差解释为修复的因果效果；估计题内采样方差 |
| ME-06 长期 Structured Context 与受控 Compaction | 3 paired fixtures；两臂均 3/3 fixture、24/24 最终状态字段、3/3 唯一行动；Morphz 真实执行 40 次 Context transaction、跨 Session、版本冲突重读、重启恢复、隔离与因果审计；完整 Morphz 5,093,621 total tokens，精简受控参照 310,336（约 16.4×） | 在三个长程任务上未观察到相对一次受控 compaction 的最终能力退化；Frame 事务、持久恢复和因果审计为额外系统能力；原始成本差异提供工程优化线索 | Morphz 相对完整 Agent 的准确率或 Token 优劣；把非同构 scaffold 的 16.4× 当作 Structured Context 固有成本或产品效率排名；三个样本具有统计显著性；该结果是公开记忆榜分 |

## 3. 已闭合的外部扩展证据

### ME-07：v2 公开 Agent 系统对照与 Mind Frame 迁移审计已闭合

旧 ME-07 LongMemEval-V2 Small 运行使用了未经用户授权的替代 reader/judge 模型，已终止并
保留审计记录；任何局部数量、分数或延迟均不进入本文证据。替代方案已选择 STATE-Bench
Agent Learning。v2 比较生产 Morphz、完整开源 Agent Runtime Letta 与 Mem0-backed frozen
reference agent；no-memory 不作为正式实验臂。A-MEM v1 的 adapter/产物 Gate 已归档，不能
冒充 Letta Gate。v2 固定相同训练轨迹、基础模型、领域工具、任务、外部评分器和预算，内部
Prompt、状态表示与调度作为端到端系统差异保留。评测器改为盲化的 GPT-5.6 Sol/max 更新版
协议；结果不会与历史 GPT-5.4 官方榜直接比较。

三臂 adapter、持久化重载、精确物理模型绑定、九份训练快照 assembly 和同题 scored smoke
均通过。成本修订在查看任何正式效果量之前冻结：保留三个领域全部 150 个 held-out task，
每题运行一次，即每 arm 150、合计 450 个 trial；原五次队列已完成的前 31 个 cell 恰好是该
单次队列的前缀并原样保留。正式 Runtime 使用组合 commit
`2249878536ce5f7a8d7449add2f5c8743395b69b`，其中包含 durable request—reply fence 与
terminal commit—delivery/SQLite cancellation-safe 修复；Linux 二进制已通过无模型交付 Gate。

450 个 trial 已全部终态闭合，失败原样计零。Morphz 122/150（81.33%）、Letta 93/150
（62.00%）、Mem0 96/150（64.00%）。Morphz−Letta 为 +19.33pp，95% CI
`[+10.67,+28.00]`；Morphz−Mem0 为 +17.33pp，CI `[+10.00,+24.67]`；两项 Holm 校正
`p=0.000060`。只读审计确认三个领域分别执行 100 次训练 Context transaction 并冻结于
revision 100，共有 144 个活跃 Mind Frame、395 条 Relation、795 个 retired object；150 个
held-out task 全部从对应训练 Context 开始，3 个 task 又执行 6 次 Context transaction。

原始 Morphz Token 计数因克隆数据库重复累计训练历史而虚增到 3,555,918,978；固定扣除每个
有效 clone 的不可变领域训练基线后，held-out 总量为 138,942,200，Letta 为 40,143,631，
Mem0 为 7,364,662。三组均不计训练成本。修正不改变任何任务分数或统计量，原始计数保留供
审计。盲化 30 条人工评测器校准仍是发布质量后续项，但不再阻止自动正式效果的有边界报告。

### ME-08：最新通用修复基线的 Morphz-only 89 题刷新已闭合

历史 70/89 对 73/89 仍是唯一同期 paired 证据；`ad60e` 的 Morphz-only 89 题刷新已得 73/89，
但不替代历史 paired 结果。当前正式刷新使用组合 commit
`4bbc3d63f4bda09947dc79dc5656edc71f8c02fa` 及固定 release binary
`31f6cdd3de8ddf4a76e190eb4c0863ff9de7c9159c7acbf7ac2765b474ec0575`，纳入随后确认的通用
终态交付、SQLite 取消安全、永久安全拒绝分类及视觉 Context 计量/投影修复；并发 8、每题
一次、零重试，只刷新 Morphz，不重跑 Codex。官方 verifier 得到 72/89（80.90%，Wilson 95%
CI `[71.52%,87.72%]`）；89 个 reward、身份、唯一性、哈希和失败保留 Gate 全部通过。它仍
只作为独立的 Morphz-only 系统能力测量；历史 Codex 是不同时间、不同并发的非同期参考。
相对 `ad60e` 单臂 73/89，本轮 4 题转对、5 题转错，不能从一分波动推导修复的单调因果效果。

论文放置规则已经冻结：历史 Morphz↔Codex 同期、同并发 89 题对照保留为主外部效度结果；
`ad60e` 与 `4bbc3d63` Morphz-only 刷新只进入 ME-08 小节的系统迭代补充或附录，不替换
paired 主结果，也不重新计算 paired 显著性。

## 4. 论文结果组织

1. **机制可执行且不退化：** ME-01、ME-02；
2. **非确定性认知求值及其边界：** ME-03、ME-05；
3. **确定性权威与额外系统能力：** ME-04、ME-06；
4. **长期状态与额外状态语义：** ME-06；
5. **经验迁移外部效度：** ME-07 的三系统 150 题对照与 Mind Frame 迁移 trace Gate；
6. **完整 Agent 外部系统效度：** ME-08 的历史 89 题同环境配对结果，以及单独报告的 `ad60e` 与
   `4bbc3d63` Morphz-only 刷新；
7. **共同结论：** Morphz 改变状态与求值机制并获得持久、可寻址、可事务、跨 Session、恢复
   和审计能力；已有简单和外部任务证据未显示灾难性通用能力代价，但 ME-08 的宽区间不足以
   证明形式化非劣。ME-07 在受测 learned-transfer 协议下高于两个公开系统，但不能把系统级
   分差全部归因于 Mind Frame。ME-06 未观察到准确率优于 compaction；Token 结果随任务与
   系统边界改变方向，只作工程画像，不作普遍效率排名。

## 5. 必须保留的有效性威胁

- ME-01/02/03 是 Pilot，部分 cell 存在天花板效应；
- ME-05 的严格合同分与语义诊断分回答不同问题，二者都必须报告；
- ME-06 只有 3 个 paired fixtures，不作统计显著性宣称；
- ME-07 旧 LongMemEval 运行已取消；STATE-Bench v1 A-MEM Gate 也只作为历史；v2 只报告完整
  单次正式批次。它是更新评测器下的本地系统级比较，不是官方榜分；每题一次不能估计题内
  方差，盲化人工评测器校准尚待完成，Mind Frame trace 也不能把全部系统级分差变成单机制因果；
- ME-08 每题只运行一次，能够进行同环境 paired 描述和检验，但不能估计同题采样方差；
- ME-08 `ad60e` 与 `4bbc3d63` Runtime 都只刷新 Morphz；不能据此重算与历史 Codex 的同期
  paired 显著性，也不能用不同运行中的单题成败改写任一原始总分；
- Provider refusal、timeout、Runtime 和 harness failure 必须分层，不按对某组有利的方向删除；
- Program-valued `infer`、任意动态交替和“无限寿命 Agent”仍是未来能力。
