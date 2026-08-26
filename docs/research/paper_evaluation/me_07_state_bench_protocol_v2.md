# ME-07 STATE-Bench 公开 Agent 系统对照协议 v2

> 状态：`three-arm-scored-smoke-passed / single-run-cost-amendment-frozen / post-hoc-mind-frame-trace-audit-specified / evaluator-human-validation-pending`
>
> 协议 ID：`ME-07-STATE-Bench-public-agent-systems-v2`
>
> 选择日期：2026-08-26

## 1. 研究问题

在公开的 STATE-Bench Agent Learning 任务、相同训练轨迹、相同 held-out 任务、相同领域
工具、相同基础推理模型、相同外部评分器和预注册预算下，生产 Morphz、Letta 与 Mem0-backed
reference agent 三种公开 Agent 系统，哪一种能更可靠地把历史经验转化为后续企业工具行动？

本实验刻意不设置无记忆组。无记忆与有记忆对照只能再次证明历史经验有用，不能区分三种
强记忆/长期 Agent 系统，因而不值得消耗一个完整正式 arm。

## 2. 三个正式 arms

| arm | 系统边界 | 学习与持久化 | held-out 运行 |
| --- | --- | --- | --- |
| `morphz` | 生产 Morphz Agent Runtime | Observation、Structured Context、带来源与关系的 Mind Frames、Context transaction、Recall index | 每个 task 从冻结领域 Context 创建隔离克隆，由生产 Morphz 执行完整工具循环 |
| `letta` | Letta 0.16.8 完整开源 Agent Runtime | 同一领域 Agent 顺序读取训练轨迹，使用 Letta 原生 core/recall/archival memory 与 Agent 自管理记忆能力 | 每个 task 从冻结 Letta Agent/数据库快照创建隔离克隆，由 Letta 执行完整工具循环 |
| `mem0` | 冻结 reference Agent + Mem0 OSS 记忆层 | Mem0 add-time 抽取、更新/冲突处理与持久化向量索引 | reference Agent 通过 Mem0 `search(top_k=3)` 取得学习内容并执行相同领域工具 |

本轮 Mem0 配置固定为本地 Qdrant、`nomic-embed-text:latest`（768 维；Ollama blob digest
`0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`）和向量检索；未安装
可选的 spaCy lemma/full model 与 fastembed BM25 扩展，启动时的 optional-feature warning 原样
保留。因此对外必须称为 **Mem0-backed vector reference agent**，不能解释为覆盖 Mem0 的全部
可选混合检索能力。该边界对三个领域一致，运行中不再补装扩展或改变已有快照。

A-MEM 不再是正式 arm。其 v1 实现与 Gate 只保留为历史记录，不进入 v2 的 smoke、正式批次、
统计或论文效果结论。

## 3. 为什么选择 Letta

Letta（原 MemGPT）不是一个临时记忆检索模块，而是具有主动记忆管理、持久 Agent 状态和
完整工具循环的公开 Agent Runtime，因而与 Morphz 构成更直接、更有现实意义的系统对照。
截至 2026-08-26，官方仓库采用 Apache-2.0，社区规模超过两万 Star，并持续维护。与仅替换
相同 Agent 内部 memory backend 的消融不同，Morphz–Letta 比较回答的是公开 Agent Runtime
在相同外部任务条件下的端到端表现。

该选择也改变了因果边界：Morphz 与 Letta 的差异包含 Context/Memory 表示、Agent Prompt、
工具循环、状态更新和调度策略，不能被解释为某一个记忆算法的纯因果效应。Mem0 arm 继续
提供一个主流独立记忆层参照；ME-01～ME-06 承担细粒度机制拆解。

## 4. 冻结候选版本

- STATE-Bench：commit `5644b1838d96bc4483da29642d058ecaa6f80f7f`，v0.8.1，MIT；
- Letta：tag `0.16.8`，commit `1131535716e8a31c9a437f8695e25ac98f203a24`，
  Apache-2.0；
- Mem0：tag `v2.0.19`，commit `dc82354e143c2581d505d581a00286d6ef8c3605`，
  Apache-2.0；
- Morphz Runtime 基线：commit
  `ad60e300f115fe84e03a8cd3ab70940deb06ae68`，包含 Harbor workspace/exec drain 修复和
  Objective 通用收敛契约；生产 STATE-Bench Runtime adapter commit 为
  `2e502056f52fc355e29f01df69d3b434607c257e`，其中包含按 Session 与 root turn 等待
  durable reply 的完成协议修复；Linux 正式执行 commit 为
  `2249878536ce5f7a8d7449add2f5c8743395b69b`，在前述 adapter 上合入 terminal
  commit—delivery handoff 与 SQLite cancellation-safe transaction 修复；三臂 adapter 及 Morphz/Mem0 训练 runner
  commit 为 `ac75c05bf30725d7e3791ed7fce9ca36b16fbafa`；Letta 原子 checkpoint 与 episodic
  context reset 训练 runner commit 为 `c6d80048d99b2a38c49944398be2a49adc08283b`；正式配对
  runner、统计器与人工盲评包生成器
  commit 为 `4dcaf15bf9e36c004d0034b0df7654cc408a9125`。后续替换任一身份都必须生成新 lock
  和回归证据，不得隐式跟随 `main`。

版本、容器镜像 digest、Python/Node 依赖锁、数据库版本和配置哈希必须在真实 smoke 前写入
机器可读 lock；`latest` 镜像不得进入正式运行。

训练输入、训练脚本、模型绑定和每个领域的 100 条轨迹固定不变；训练 receipt 与最终 assembly
manifest 共同记录每份快照的生产环境和最终哈希。为避免移动工作站成为长任务的单点故障，已经在本机开始的 `travel`
快照继续使用 Apple Silicon 冻结二进制
`0666fd3c0e49b2365d923d9589229ed6e37d6d47bbabc6bfcf0e0a45d53fa31a` 完成，尚未开始的
Morphz 领域则迁移到 Linux x86-64 云节点。训练二进制均包含 adapter commit `2e502056` 并由
Rust 1.97.1 构建；Linux 训练二进制 SHA-256 为
`98a7ed2458d7dd3d086b9f5ddfbe682902f96dcb879c5719054afb70f57c2691`。训练完成后发现的
terminal delivery 修复不改变模型请求、Context transaction 或已成功 episode 的快照内容；
因此通过 receipt 与重载 Gate 的训练快照不重跑，而全部正式 trial 改用 commit `2249878` 的
新 Linux 二进制，SHA-256 为
`7b0c63cd685f4b4420f362bea1f986fa4546ad27482802aec5af3c9cbdbb356e`。Letta 和 Mem0 同样只在
领域边界迁移，不续接半成品快照；每个领域都由单一进程从第 1 条训练轨迹完整运行至第 100 条，
并在正式评分前冻结、重载验证和汇总到统一 snapshot manifest。

全部 450 个正式 trial 只在 Linux 云节点运行。formal runner 按 `(操作系统, 架构)` 校验
唯一允许的 Morphz 二进制哈希并把平台写入 manifest。平台迁移不改变训练数据、快照内容、
Runtime 源码、模型、任务、评分器或配对队列；Linux 正式启动前仍须通过无模型 Runtime Gate
和一组不计分的三臂接线 smoke。

## 5. 公平性合同

三组必须共同固定：

1. STATE-Bench 数据版本、三个领域的 300 条训练轨迹及 held-out split；
2. 基础推理模型 `gpt-5.6-sol`、reasoning `max`、CLIProxyAPI Responses、
   `fallback=false`；
3. 可调用的 STATE-Bench 领域工具、工具参数 schema、sandbox、网络条件和 task wall clock；
4. 每个领域的训练输入顺序、每个 held-out task 的运行次数与交错队列；
5. 输入/输出 Token、模型调用、embedding、离线学习成本、墙钟和失败完整计入；
6. 每个 held-out trial 从冻结学习快照的独立克隆启动，禁止跨 held-out task 学习污染；
7. user simulator 与 judge 看不到 arm 名称、内部实现名称或预期方向。

内部 Prompt、Context/Memory schema、工具调度和维护策略属于被测 Agent 系统本身，不强制
做成相同。强行统一这些内部机制会抹掉 Runtime 对照的真实差异。论文必须把本实验表述为
**端到端公开 Agent 系统比较**，而不是“只改变记忆算法”的实验室消融。

## 6. 训练轨迹进入方式

三个 arm 都只读取同一 canonical serializer 生成的训练轨迹，不得访问 held-out task、oracle
或答案。

- Morphz：把轨迹作为带来源的 Observation 输入领域 Context，由生产 Agent 形成/修订
  Mind Frames；
- Letta：把每条轨迹作为一个明确边界的历史任务 episode 顺序交给同一领域 Agent，并允许
  Letta 通过公开 API 使用其原生记忆工具更新 core/recall/archival memory；每条 episode 后
  记录状态摘要与持久化 digest。Agent 精确确认且 memory tool 已完成后，调用 Letta 公开
  `reset-messages` 清除该 episode 的短期活动消息并用最新 memory blocks 重建 system context；
  原始消息仍保留在 Letta 数据库审计记录中，不把 100 条原始轨迹累积成一个模型输入；
- Mem0：把同一 canonical episode 交给 Mem0 的 add-time 学习路径，使用领域 agent namespace。

训练过程中的全部模型和 embedding 调用都计费计时。不得用人工整理的“正确经验摘要”替
任何 arm 写入记忆。

## 7. 更新版评测器

v2 不再把 STATE-Bench 历史协议中的 Azure GPT-5.4 当作不可替换的科学真值。它只用于复现
历史官方榜口径；在 2026 年的当前方法比较中，明显落后的评测模型可能成为 user simulator
和 judge 的能力瓶颈。

本项目采用 **STATE-Bench-derived updated-evaluator protocol**：

- user simulator、task-requirements judge 与 UX judge 统一使用
  `gpt-5.6-sol`/`max`/CLIProxyAPI Responses；
- 保持上游任务、评分维度、确定性评分代码与 judge Prompt 不变；只替换物理评测模型与
  client adapter；
- 所有 arm 共用同一冻结评测器和请求参数；
- 在正式批次前，从三个领域分层抽样至少 30 条评分，由两名不了解 arm 身份的人工评审复核
  judge 的要求满足与 UX 判断；报告一致率和分歧类型；
- 结果必须称为“基于 STATE-Bench 的更新协议本地结果”，不得称为官方 leaderboard score，
  也不得与历史 GPT-5.4 榜单数字直接比较。

## 8. 正式规模、指标与统计

正式规模保持上游完整 held-out 任务，但基于 2026-08-27 的成本修订，每题只运行一次：
3 domains × 50 held-out tasks × 1 run = 150 trials/arm，三组共 450 trials。150 个不同
held-out task 已提供配对统计单位；本轮不再用每题重复五次来估计模型采样方差。该修订由
预算与工期触发，不以已完成 cell 的成败选择样本。原五次队列已经运行的前 31 个 cell
全部属于 `run_idx=1`，并已确认与单次队列的前缀逐项一致；这些 terminal receipt 原样复用，
不删题、不补跑失败项。修订后的汇总仅使用完整的 150 个 `run_idx=1` cell。真实 smoke
只用于 Gate，不得混入正式分数。

正式队列以 `20260826` 为固定随机种子，将同一 `(domain, task, run)` 定义为一个配对单元；
每批最多并发四个配对单元，每个单元内三个 arm 并行运行，即最多同时运行 12 个 job。
每个 job 使用独立快照克隆和独立产物目录，不允许跨 held-out task 学习污染。每个任务只允许
一次正式尝试。terminal 失败保留并计零，不自动重试；进程
中断恢复时只运行尚未形成 terminal receipt 的缺失任务。每个 terminal receipt 在进入下一个
配对单元前原子写入。若上游 trajectory 已落盘但进程在原子 receipt 前中断，则保留该孤立
trajectory，不重跑，并因模型绑定与评分调用收据不完整而按 terminal failure 计零。

- 主指标：更新评测协议下的 pass@1；
- 主要配对差：Morphz−Letta、Morphz−Mem0；
- 次指标：task-requirements、UX、cost/task、Token、任务用时、训练成本与失败分类；
- 统计单位：held-out task；置信区间和置换/Bootstrap 以 task 聚类；
- 两个主要比较使用预注册 Holm 校正；
- 官方/上游 scorer 输出仍是分数真值，事后 Runtime 诊断只能解释失败，不能覆盖分数。

### 8.1 Morphz Mind Frame 迁移轨迹审计（事后诊断）

正式批次启动后另行增加一项**只读、无模型调用、不重新评分**的机制轨迹审计。它不改变
任何 arm 的冻结任务分数，也不冒充预注册因果消融。审计逐个遍历 150 个 Morphz held-out
task 的隔离 Runtime 数据库，并要求：

1. 对应领域训练 Session 已通过 100 次 `chat/context_tx_committed` 把全部训练 episode 写入
   Structured Context；
2. 冻结 Mind projection 的最终 revision 为 100，并存在由训练 Session 形成且带来源的活跃
   Mind Frame、显式 Relation 及被淘汰对象记录；
3. held-out task 使用独立 Session，但其中每次 `chat/assistant_call` 的
   `context_snapshot_version` 都等于该最终 revision；
4. 审计结果只证明“训练经验被整合为结构化认知状态，并由后续求值实际使用”，不能把
   Morphz 与 Letta/Mem0 的全部端到端分差单独归因于 Mind Frame。

可复现审计器为
[`audit_morphz_mind_frame_transfer.py`](../../../benchmarks/state_bench/v2/audit_morphz_mind_frame_transfer.py)。
增加该诊断是为了检验论文的核心机制链，而不是对已经看到的失败做补分或筛选样本。

## 9. 进入真实运行前的 Gate

1. 冻结 v2 machine-readable lock、Letta 容器/依赖/数据库和全部代码 digest；
2. 实现 STATE-Bench 到 Letta 的公开 Agent/Tool adapter，不通过共同 `retrieve_learnings`
   surrogate 假装 Letta；
3. 证明 Letta 真实调用 `gpt-5.6-sol`/max/no-fallback，并真实执行 STATE-Bench domain tools；
4. 三个 arm 对同一训练 episode 完成原生学习、进程关闭、快照重载和持久状态审计；
5. 每个 held-out task 的快照克隆隔离与 test 泄漏负例通过；
6. 更新版 simulator/judge 的精确模型绑定、schema、确定性评分与人工复核 Pilot 通过；
7. 三臂在同一 held-out task 各完成一次 scored smoke；
8. 冻结 runner/Runtime/adapter commit、交错队列、产物合同和总预算后才能运行正式批次。

任何 Gate 失败都保留原始产物；不得换模型、删题、静默重试或只挑成功 arm。当前 v1 的
A-MEM artifact Gate **不能**替代 v2 Letta Gate。

截至 2026-08-26，三臂已使用同一条 canonical travel 训练 episode 完成原生学习、进程退出、
快照重载和持久化审计；Morphz、Letta、Mem0 的任务克隆均不修改冻结源快照。随后在同一个
held-out travel task 上完成了三臂 scored smoke：三个 Agent 执行与评分链均正常闭合，且
simulator/judge 的全部成功调用都物理绑定 `gpt-5.6-sol`/max/no-fallback。第一次 smoke 暴露
CLIProxyAPI `json_object` 模式所需的显式 JSON 格式词缺失，三臂任务轨迹全部保留且未补分；
适配器只增加“返回有效 JSON 对象”的传输格式约束后，从全新目录重跑三臂并通过 Gate。

上述 smoke 只证明装置闭合，单题得分不进入论文效果统计。正式训练快照、完整交错队列、
30 条盲化人工 evaluator 复核和正式批次仍未完成，因此目前仍没有 ME-07 v2 可报告效果结论。

第一次 Morphz travel 正式训练在第 23 条 episode 后暴露了 adapter 回复等待缺陷：回复和
Context transaction 已写入 durable Event Store，但旧 adapter 将异步 business subscription
误作请求—回复完成权威并最终超时。失败快照完整保留；修复 commit `2e502056` 已通过全套
Runtime/evals Gate。协议身份因此推进到 machine-readable lock revision 2，并要求从空数据库
重新训练；旧快照不得续跑或进入效果统计。证据与边界见
[`me_07_morphz_training_reply_failure_and_recovery_20260826.md`](./me_07_morphz_training_reply_failure_and_recovery_20260826.md)。

ME-08 随后的 89 题刷新又暴露 terminal commit—delivery handoff 竞态：Activation 将自身终态
提交为 succeeded 后，旧 revocation watcher 会取消仍在执行的 EventBus/Delivery 交接；被取消的
手工 `BEGIN IMMEDIATE` 还可能把开放写事务归还连接池。通用修复 commit `ac3344e` 与
STATE-Bench adapter 合并为正式 commit `2249878`，完整 Runtime/Evals Gate 和 Linux 无模型
Gate 均通过；后者直接验证 durable reply 唯一、Thread outcome 已交付、进程退出后 SQLite 可
立即重新取得写事务且模型调用为 0。协议 lock 因此推进到 revision 3。正在计分的 ME-08 原始
trial 不追改；ME-07 已成功训练 episode 的 Context 状态也不改写，只有尚未启动的正式评测使用
新二进制。

## 10. 公开来源

- [STATE-Bench Agent Learning Track](https://github.com/microsoft/STATE-Bench/blob/main/docs/AGENT_LEARNING_TRACK.md)
- [Letta official repository](https://github.com/letta-ai/letta)
- [Letta documentation](https://docs.letta.com/)
- [Mem0 official repository](https://github.com/mem0ai/mem0)
- [Vectorize 2026 memory-system comparison](https://vectorize.io/articles/best-ai-agent-memory-systems)

最后一项是厂商文章，只用于发现候选与了解市场分类；版本、许可证、架构和接入方式以各项目
官方仓库与文档为准。
