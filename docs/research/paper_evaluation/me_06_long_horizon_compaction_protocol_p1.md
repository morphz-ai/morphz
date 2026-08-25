# ME-06 长程 Structured Context 与受控 Compaction 对照协议 p1

> 状态：`candidate-phase-a-gate-passed`。本文只冻结候选研究设计，不授权真实模型运行。
>
> 日期：2026-08-26（Asia/Shanghai）
>
> 关联研究问题：RQ6
>
> 当前门槛：两臂设计和 120-event 事件流的第一阶段无模型 Gate 已通过；在两套真实模型
> adapter、精确 Token 预算和产物重放 Gate 完成前，不得运行真实 smoke。

## 1. 实验要回答什么

ME-06 回答两个彼此关联但不能混为一个分数的问题：

1. 在长期任务、周期性信息压缩、来源冲突、状态修订、跨 Session 和进程重启条件下，
   Morphz 的增量式 Structured Context 是否至少不降低最终语义正确性；
2. 在不依赖完整消息列表持续驻留的条件下，Morphz 是否真实提供传统 compaction 状态不直接
   具备的稳定对象、来源关系、跨 Session 共享、细粒度并发提交、恢复和审计能力。

论文的最低可接受结论不是“Morphz 在所有指标上胜过 compaction”，而是：

> Morphz 把消息历史改造成可寻址、可修订和可事务提交的 Structured Context，并获得跨
> Session、并发、恢复和审计能力；在公平的现代 compaction 基线下，未观察到长期语义能力
> 退化。

如果最终语义正确率、陈旧事实拒绝或恢复正确率进一步优于 compaction，则作为更强结果报告，
但不预设实验必然得到该结果。

## 2. 本实验不做什么

- 不把“直接丢弃最早消息”的固定窗口作为主要基线；现代 Agent 通常会做 compaction；
- 不证明 S-expression 的括号语法优于 JSON 或 Markdown；表示形式已由 ME-02 处理；
- 不要求 Morphz 必须更省 Token 或更快；维护调用、Token 和延迟是机制成本指标；
- 不以精确 JSON 字段形状代替语义正确性。输出格式错误和语义选择错误必须分开统计；
- 不使用 Terminal-Bench、Harbor 或任务容器；公开 Benchmark 属于 ME-07；
- 不在一个 Pilot 中同时比较九个模型。p1 固定一个模型，模型切换另列扩展，避免混淆
  Runtime 效果与模型差异。

## 3. 两个 Arms

### 3.1 `controlled_compaction`

这是本项目实现、代码和提示词全部公开的受控现代 Agent 基线，不是已有第三方产品，也不是
Morphz 当前生产组件。它只用于机制对照：

- 原始消息和外部事件完整、不可变、持久化；
- 活动输入由“最近一次有效 compaction 状态 + 其后的完整消息/事件”组成；
- 达到统一 Token Gate 后，使用同一个被测模型生成新的有界 compaction 状态；
- compaction 状态必须保留当前目标、稳定约束、当前事实、来源、明确取代关系、未完成工作和
  不确定性；允许自由 Markdown，不以复杂 JSON schema 增加额外失败面；
- compaction 状态与原始事件在进程重启后恢复，并可被另一个 Session 使用；
- 提供与 Morphz 等价预算的只读 `recall_event_history`，允许模型按 ID、关键词和时间范围召回
  原始历史；召回调用、输入 Token 和延迟全部计入成本；
- compaction 不获得 Morphz 的 Frame、Relation、逐对象 revision 或 `context_tx`；它只有一个
  带全局 revision 的持久摘要快照。

并发提交时，摘要快照使用 compare-and-swap 防止静默丢更新。两个从同一 revision 出发的提交
即使修改不同事实，后提交也必须重新读取并重新 compaction。这样基线不会因 runner 粗糙而
丢数据，同时保留“全局摘要”与“逐对象事务状态”的真实架构差异。

### 3.2 `full_morphz`

- 使用冻结 commit 构建的生产 Morphz 二进制；
- 使用真实 SQLite、Event History、ContextEngine、Session mount、Frame、Relation、revision、
  source refs 和 `context_tx`；
- 原始 Observation 不由 Runtime 自动总结或转换为事实；模型负责在实际任务过程中维护 Mind；
- 活动 Context 按生产投影和压力机制生成；原始历史可通过同预算的 recall 接口召回；
- 进程重启必须重新打开原数据库恢复，禁止把上一阶段状态复制进新 prompt；
- 不允许 fixture、runner 或 scorer 伪造 Frame、提交 receipt 或恢复结果。

### 3.3 为什么不加入 Codex

Codex 同时改变 System Prompt、工具编排、会话实现、内部 compaction 和 Runtime，而且其内部
状态与维护调用不可审计。把它加入本实验会把“状态机制对照”变成“两个完整 Agent 产品对照”，
无法把差异归因于 Structured Context。因此 Codex 不进入 ME-06 的 arm、预算和统计；完整
Morphz 与官方 Codex 的同环境产品比较归入 ME-07 公开 Benchmark。现有 Terminal-Bench 前
40 题结果已经承担这一角色，未来长期记忆公开 Benchmark 也应沿用同一边界。

## 4. 公平性与信息等价

两个 Arms 固定相同：

- 主模型、reasoning effort、Provider route、fallback、输出验收上限；
- 原始事件的正文、稳定 ID、来源、时间、Session、Context、版本和到达顺序；
- 任务指令、工具、文件、活动输入 Token 上限、召回预算和 wall-clock 上限；
- 进程重启位置、Session 切换位置、并发调度顺序和隐藏评分器；
- 每个 paired fixture 的唯一正确当前状态和最终行动。

允许不同的只有状态机制及其必然产生的表示：controlled compaction state 是模型生成的持久
摘要；Morphz state 是模型在生产 Runtime 中提交的 Structured Context。

## 5. 固定长程事件流

一个 paired fixture 候选包含 `120` 条原始事件，但不等于 120 次模型调用。事件按 12 个
业务检查点分批注入，每个检查点只在需要决策、维护或行动时唤醒模型。

| 阶段 | 事件性质 | 主要验证 |
| --- | --- | --- |
| S1 建立 | 项目、长期目标、持续安全约束、初始权威状态 | 初始状态形成 |
| S2 过程波次 A | 已完成实验、临时日志、候选参数和一次性路径 | 短期过程不污染长期状态 |
| S3 合法修订 | 新的已批准证据明确取代旧端口/策略/期限 | supersession 与当前值 |
| S4 晚到冲突 | 时间更新但未批准或已归档的旧材料 | 权威性优先于单纯新近性 |
| S5 Session B | 新 Session 在同一 Context 中继续任务 | 跨 Session 连续性 |
| S6 正迁移 | 从多个已完成案例形成有边界的可复用规则 | 主动认知学习与后续行为改变 |
| S7 过程波次 B | 大量可退休记录，推动首次或再次维护 | compaction/Context 压力 |
| S8 并发非冲突 | Session A/B 从同一基础版本更新不同对象 | 无不必要丢失与提交开销 |
| S9 并发冲突 | 两个 Session 修改同一对象，其中一个证据更权威 | 冲突发现、重读和语义合并 |
| S10 进程重启 | 关闭并重新启动 runner/Runtime，不复制 prompt | 持久恢复 |
| S11 负迁移隔离 | 相邻 Context 中出现同名对象和不同值 | Context 污染必须为 0 |
| S12 最终行动 | 根据当前权威状态执行唯一行动并形成简洁报告 | 端到端语义结果 |

120 条事件的候选构成：

- 18 条稳定事实、目标与长期约束；
- 18 条合法修订、来源冲突和取代关系；
- 72 条已完成过程、临时候选和诊断噪声；
- 12 条 Session、并发、重启和隔离控制事件。

具体文本、顺序和 hidden expected answer 必须在真实 smoke 前冻结并分别保存。模型可见文件中
不得出现 hidden answer；hidden scorer 只保存从可见证据确定性推出的预期结果。

## 6. 为什么不是每条事件调用一次模型

长期性的核心是状态经过大量事件、维护周期、Session 切换和重启后能否继续驱动正确行动，
不是机械消耗 120 次推理。runner 可以确定性追加外部事件，然后仅在 12 个业务检查点唤醒
模型。这既保留 Context 压力和信息演化，也把单 fixture 的正常业务调用控制在约 12 次。

维护调用另行计数：

- `controlled_compaction`：仅在冻结 Token Gate 触发；
- `full_morphz`：由生产 Runtime 的 notice/warning/critical 机制和模型实际选择触发；
- 两组的维护输入、输出、repair、召回、Token 和时间均不得隐藏在业务调用之外。

## 7. 活动输入与维护预算候选

以下数值只是 p1 候选，用户确认后才冻结：

| 字段 | Candidate |
| --- | ---: |
| 共同活动输入验收上限 | 12,000 tokens |
| 维护保留预算 | 2,000 tokens |
| compaction 触发点 | 预计下一业务输入超过 10,000 tokens |
| compaction state 验收上限 | 3,000 tokens |
| 单次业务输出验收上限 | 4,096 tokens |
| 单次维护输出验收上限 | 4,096 tokens |
| 每检查点物理请求上限 | 4 |
| 单 fixture wall-clock | 60 分钟，仅用于防止失控 |

冻结 tokenizer 对完整实际请求重算 `uncached_equivalent_input_tokens`，同时保存 Provider 原始
usage、cached tokens 和实际计费信息。缓存折扣不得被用于夸大架构 Token 优势。

## 8. 主要结果与分层评分

### 8.1 主要语义指标

1. `final_state_field_accuracy`：最终当前状态字段逐项正确数/总数；
2. `unique_final_action_success`：最终唯一行动及参数是否满足 hidden contract；
3. `checkpoint_semantic_accuracy`：12 个检查点中依据当时可见证据得出的状态/行动正确率；
4. `obsolete_fact_reuse_rate`：明确失效的事实被当作当前值使用的次数/机会数；
5. `authority_resolution_accuracy`：来源权威、批准状态和取代关系判断正确率。

模型只要表达或提交了语义等价的正确值，就计入语义成功。JSON/S-expression 的字段形状、
数组/字符串差异、附加解释字段等单独进入协议指标，不能把语义正确结果直接判成认知失败。

### 8.2 架构能力指标

- `cross_session_continuity_success`；
- `restart_recovery_success`；
- `context_isolation_success` 与污染率；
- 并发非冲突更新保留率；
- 并发冲突发现率、静默丢更新次数和成功恢复率；
- Morphz Frame/source/revision/transaction 因果链完整率；
- controlled compaction state revision、维护来源和恢复链完整率；

传统 compaction 不具备 Frame 级事务时，对应项目报告为“机制不提供/不适用”，不能伪造为
0 分后混入语义平均值。能够共同比较的最终状态和行动指标仍按相同标准评分。

### 8.3 成本与诊断指标

- 业务、维护、repair、recall 和总物理模型请求数；
- 输入、输出、cache、wall-clock 和可得时的计费成本；
- compaction 停顿次数和累计时间；
- Context/summary 峰值与最终 Token；
- Frame/summary 增长、retire/recall、Context commit/reject/conflict；
- Provider、模型、Runtime、runner 和 scorer 失败分类。

## 9. Pilot 与确认性阶段

### p1：设计与成本 Pilot

- `2 arms × 1 fixture = 2 episodes` 的真实 smoke；
- smoke 通过且协议不修改时，再运行 `2 arms × 3 paired fixtures = 6 episodes`；
- 每个 fixture 使用不同事实和值，但共享同一事件结构和评分维度；
- paired queue 交错运行，不先跑完某一组；
- p1 用于校准区分度、失败分类、Token 和真实耗时，不宣称统计显著性。

按 12 次业务调用和候选维护调用估算，p1 正常路径暂估约 126 次物理模型调用，而不是
`120 events × arms × fixtures`；真实调用上界由无模型 planner 在用户批准前给出。

### p2：确认性实验

p2 样本量只能在 p1 结果、paired 差异和成本已知后冻结。优先增加不同 fixture，而不是把同一
fixture 重复五遍。若 p1 出现所有组 100% 的天花板，应增加长期冲突和维护难度，不机械扩样。

## 10. 模型和运行环境

p1 候选固定：

- requested model：`gpt-5.6-sol`；
- reasoning：`max`；
- Provider：本机 `mini-m4.local` 的 CLIProxyAPI；
- fallback：`false`；
- 权限：`full-access`，但实验不依赖网络和外部破坏性工具；
- 每个 arm/fixture 使用独立 SQLite、Context、Session 集合、workspace 和 artifact root；
- 不挂载产品 Context、历史 Session 或开发数据库。

本实验不需要 Docker，也不需要云服务器。CPU/内存不是瓶颈；本机常开即可。若未来确认性
批次需要长时间无人值守，云服务器只作为运行稳定性选择，不改变协议或得分。

模型切换是 ME-06-X 扩展：主 p1 完成后，在完全相同的冻结状态快照上，将后半段求值器切换为
另一已通过 ME-05 Gate 的模型，检查状态表示是否可迁移。它不混入 p1 的 Sol-only 主比较。

## 11. 失败、排除和补跑

| 情况 | 分类 | 计入语义结果 | 处理 |
| --- | --- | --- | --- |
| 模型选择错误、遗漏状态、复活旧事实 | model outcome | 是，失败 | 不补跑 |
| 输出形状错误但语义可确定 | protocol outcome | 语义照常评分 | 单列格式合规率 |
| Context/summary 合法提交被模型错误使用 | model outcome | 是 | 不补跑 |
| 生产 Runtime 自身崩溃或恢复错误 | runtime outcome | 是 | 保留并报告，不静默排除 |
| Provider safety refusal、空响应或模型超时 | provider/model outcome | 是 | 不补跑 |
| 请求前 5xx、连接中断且未收到模型输出 | service failure | 否 | 同 cell 队尾 replacement 1 次，保留 receipt |
| 数据库未隔离、模型绑定错误、hidden 泄漏 | harness failure | 否 | 整批 invalid，修复后升版本 |
| scorer bug 且原始产物足够 | scorer failure | 原始结果不丢 | 修复后重评分并保留两个版本 |

不得在看到某组成绩后修改 compaction prompt、Context 阈值、事件文本或评分规则。所有失败轨迹
永久保留；结论同时报告分子和分母。

## 12. 无模型 Gate

真实模型 smoke 前必须完成并通过：

- [ ] 冻结 120-event fixture 生成器、3 个独立 fixture 和 hidden expected hash；
- [ ] 两组看到相同原始事件、来源、Session、顺序和任务指令；
- [ ] compaction baseline 真正持久化 summary revision，并能重启及跨 Session 读取；
- [ ] compaction baseline 的 recall 与 Morphz recall 具有相同查询和预算边界；
- [ ] full Morphz 使用生产二进制、真实 SQLite 和真实 Context 事务链；
- [ ] 独立进程重启 Gate，禁止 prompt 状态复制；
- [ ] 并发调度、CAS 冲突、Frame 级重放和静默丢更新负例通过；
- [ ] scorer 能区分语义正确、格式错误、陈旧值、来源错误、污染和缺失输出；
- [ ] 从不可变原始产物重评分逐字节一致；
- [ ] planner 给出每 fixture/arm 的请求数和 Token 上界；
- [ ] 精确模型、reasoning、fallback、数据库隔离和本地节点预检通过；
- [ ] Cargo 目标测试、Clippy `-D warnings` 和 `git diff --check` 通过。

## 13. 用户确认项

在实现 runner 前需要确认：

1. 接受 `controlled_compaction` 与 `full_morphz` 作为仅有的两组机制对照；Codex 只进入
   ME-07 公开 Benchmark；
2. 接受 120 条事件、12 个业务检查点，而不是 120 次模型调用；
3. 接受 compaction 基线拥有持久摘要、跨 Session、重启和同预算历史召回；
4. 接受语义结果为主，格式合规率单列；
5. 接受 p1 先做 1 个两臂 paired smoke，再做 3 个两臂 paired fixtures；
6. 接受 Sol-only 主比较，模型切换作为后续扩展；
7. 确认 12,000/10,000/3,000 Token 候选预算，或在无模型 planner 后再调整。
