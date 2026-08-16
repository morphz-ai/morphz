# Morphz Experience Transfer Benchmark v1

> 状态：v1 已实现并完成 Gemini 5 次真实重复实验  
> 主问题：拥有既往 Mind 的 Agent，面对同一组新任务时，是否比全新 Agent 更正确、更高效，并形成可迁移的自主认知结构？

> **评分修正（2026-07-12）**：初版 `mind_passed` 在完整 Context SExpr 上搜索标记，Inbox 中的事实可以替已经丢失的 Mind Frame 通过。下文第 5 节的首次正式结果保留为历史执行记录，但其中 Mind/semantic 数值不能继续作为严格 Mind 保持结论。修正后的同任务五次基线为：related 14/15、unrelated 7/15、fresh 5/15；新评分只检查活动 Mind Frame/Relation。修正原因、Agent Prompt 基线与 Cognitive SExpr VM 对照见 [Cognitive S-Expression VM Prompt A/B](morphz_cognitive_sexpr_vm_prompt_ab.md)。

## 1. 评测边界

这个基准评价 Agent 自己维护的 Mind，不在 Runtime 中加入任务答案、业务规则或专用验证器。Runtime 只提供相同的 Context、工具、事务、持久化和重启能力；任务正确性由场景的外部状态、Mind 必需事实、回复和工具约束共同评分。

一次 suite 同时运行三个隔离 arm：

| Arm | 中文含义 | 目标阶段前的经历 |
| --- | --- | --- |
| `related_experience` | 相关经验组 | 三个“证据权威、状态与取代关系”案例，以及一次重启恢复 |
| `unrelated_experience` | 无关经验组 | 算术、单位换算和目录统计，以及一次重启恢复 |
| `fresh` | 全新组 | 无训练历史，直接进入目标任务 |

三个 arm 使用同一模型、Runtime、Context 预算和目标阶段，但各自拥有独立的 Session、SQLite、Workspace 和 Artifact 目录。三个 arm 并发运行，降低服务状态和时间漂移造成的偏差。

## 2. 目标任务

训练结束后，三个 arm 收到完全相同且不提示“使用经验”的三个阶段：

1. 比较正式批准的负责人记录与晚到但未批准的个人草案，选择 `OWNER-LIN-17`，拒绝 `OWNER-LIN-99`；
2. 比较已被取代的供应方记录与当前批准修正案，选择 `GAMMA-2`，拒绝 `GAMMA-1`；
3. 重启 Morphz，禁止读取 Workspace、召回 Event History 或调用物理工具，只根据恢复后的 Mind 报告案例 D、E 和判断边界。

目标提示、隐藏注入、预期状态和预算在三个 arm 中逐字段相同。目标提示不出现训练案例 `ALPHA/BETA/CHARLIE`，也不出现“已有策略”或“使用经验”等迁移暗示。

## 3. 公开指标

每个 arm 的报告只聚合 `target-*` 阶段，训练分数不会混入目标分数：

- State、Mind、Behavior、Reply 和 Strict 通过数；
- 重启后无工具恢复；
- 模型尝试、物理工具、Context commit；
- 空正文 standalone `context_tx`；
- 重复物理调用、同路径重读和 Read guard；
- 最终 Mind 的活动/退休 frame、保护状态、版本、来源和关系。

Suite 同时输出相关经验、无关经验相对全新组的正确率与成本方向差。这个方向差是观测值，不自动声明因果成功。

## 4. 夹具校准与排除记录

真实测试先后发现两项评测夹具问题，相关运行均不进入正式结论：

1. 初版把目标目录命名为 `target/`，与默认工具安全规则 `target/**` 冲突。使用 `read/list_files` 的 Agent 被拒绝，而改用 `exec` 的 Agent 可以继续，造成由工具选择引起的伪组间差异。目录已改为 `challenge/`，并增加回归测试证明标准 Read 路径可访问、旧路径会被拒绝。
2. 第一批 5 次校准运行中，案例 E 的提示只要求报告“旧值”，评分器却强制机器键名为 `rejected_value`。模型写成语义正确的 `old_value` 或 `superseded_value` 时被扣分。正式提示现明确要求 `state/target.env` 且仅包含 `case_id/selected_value/rejected_value` 三行。

这两次修正只消除评测歧义，没有改变 Runtime、Context 自描述或 Agent 的业务推理规则。

## 5. Gemini 正式结果

测试时间为 2026-07-12，模型为 `gemini-3-flash-agent`，Context Protocol v9，soft/hard/reserve 分别为 32K/48K/8K。运行基于 commit `052541b` 的 dirty 工作树，因为本基准本身尚未提交；每次 manifest 均保存了这一状态。

### 5.1 五次逐组结果

表中每格为“目标语义通过阶段 / 模型尝试 / 物理工具”：

| Suite | 相关经验 | 无关经验 | 全新 |
| --- | ---: | ---: | ---: |
| 1 | 3/3 / 7 / 6 | 3/3 / 8 / 7 | 1/3 / 10 / 7 |
| 2 | 1/3 / 5 / 3 | 3/3 / 8 / 7 | 3/3 / 7 / 6 |
| 3 | 3/3 / 7 / 6 | 3/3 / 7 / 6 | 3/3 / 10 / 8 |
| 4 | 3/3 / 7 / 7 | 3/3 / 9 / 7 | 3/3 / 11 / 8 |
| 5 | 3/3 / 8 / 7 | 3/3 / 8 / 7 | 3/3 / 7 / 6 |

### 5.2 聚合

| 指标 | 相关经验 | 无关经验 | 全新 |
| --- | ---: | ---: | ---: |
| State/Mind/Behavior 语义通过 | 13/15 | 15/15 | 13/15 |
| 严格通过 | 13/15 | 13/15 | 13/15 |
| 平均模型尝试 | 6.8 | 8.0 | 9.0 |
| 平均物理工具 | 5.8 | 6.8 | 7.0 |
| 目标 Context commit 总数 | 9 | 13 | 17 |
| 空正文 standalone transaction | 1 | 4 | 6 |
| 最终平均活动 frame | 2.8 | 2.4 | 1.2 |
| 最终关系数 | 0 | 0 | 0 |

五次正式运行没有路径安全拒绝、Runtime panic、模型重试耗尽或回复等待超时。完全重复物理调用、同路径重复读取和 Read guard 拒绝也均为 0。

## 6. 如何解释结果

### 6.1 已出现的正向信号

相关经验组与全新组的语义和严格正确率相同，但平均模型尝试减少 24.4%，平均物理工具减少 17.1%，目标 Context commit 也更少。5 次中有 4 次相关经验组完成全部目标；其中 3 次比同组全新 Agent 少 3—4 次模型尝试。

这说明已有 Mind 至少没有必然拖慢新任务，并与更短的执行路径存在稳定信号。第一组中，相关经验组完整保留 D/E，而全新组在更新 E 后丢失 D，也展示了经验结构可能帮助多案例保留的具体样本。

### 6.2 尚不能声称自主进化成功

相关经验没有超过全新组的总体正确率；无关经验组反而取得 15/15 的最高语义分，同时也比全新组成本低。因此，当前成本收益不能归因于“相关业务知识”本身，还可能来自：

- 较早形成了稳定的工具使用节奏；
- 已熟悉 `state/*.env` 和 `context_tx` 的工作模式；
- 更长历史对模型产生了通用的任务预热；
- 模型采样方差。

相关经验组唯一失败运行在案例 E 阶段把标准工具调用写成了纯文本 JSON。按照该历史运行当时的 Agent 循环语义，无工具纯文本会结束回合，因此外部状态和 Mind 都没有更新；重启后 Agent 如实报告 E 未知。这是模型的工具协议遵循失败，不是 Runtime 丢失已提交的 Mind。Protocol v11 已改为要求显式 `reply`，同类普通文本现在会进入有限纠错而不是直接结束。

### 6.3 Agent 自发形成了什么 Mind

相关经验组形成了两类结构：

1. **案例分立结构**：A、B、C、D、E 各自成为一个 decision frame；
2. **案例聚合结构**：一个 `task` 或 `decision` frame 内包含多个 case 子结构。

这两类结构均由模型自己选择，Runtime 没有预设 schema。5 次正式运行中没有任何关系边，也没有稳定出现独立的 `rule/strategy/principle` 通用原则 frame。模型能够保存案例和理由，但尚未自发完成从案例到显式抽象经验、再用抽象经验指导新任务的完整闭环。

因此目前最准确的结论是：

> Morphz 已经证明“经验 Mind 可被带入后续任务，并可能降低执行成本”；尚未证明“相关经验被稳定抽象成可迁移知识，并提高正确性”。方向仍成立，但下一阶段验证对象已经从持久化可行性转向抽象、迁移与负迁移控制。

## 7. 运行方式

```bash
# 单独创建某个 arm
cargo run -p morphz-evals --bin long_horizon_agent_eval -- \
  create-experience related_experience [BASE_DIR]

# 使用恰好包含一个模型的 profiles 文件并发运行三 arm suite
cargo run -p morphz-evals --bin long_horizon_agent_eval -- \
  run-experience PROFILES.toml BASE_DIR
```

`run-experience` 当前默认使用 `semantic_sexpr_vm`。历史的
`run-experience-prompt-ab` 仍固定比较 `agent_owned_context` 与
`cognitive_sexpr_vm`，用于复现原两组报告，不代表当前默认 Profile。

每个 suite 在根目录写入 `suite_report.json`；每个 arm 仍保留 manifest、trace、run report、日志、SQLite 和 Workspace，便于逐事件审计。

## 8. 下一步

1. 增加至少两个不同任务族，避免把证据选择模式当作通用经验学习；
2. 增加训练顺序交换和相关/无关经验混合，测量负迁移与 frame 污染；
3. 设计无需提示“总结规则”的抽象探针，观察模型是否主动形成原则 frame；
4. 将同一套目标扩展到跨 Session、共享 Mind 与 COW 分支，验证长期经验作用域；
5. 在可复现采样能力可用时做真正的 paired seed 比较；当前 N=5 只支持方向性判断；
6. 保持 Runtime 通用，不把本场景的 authority/status/selected_value 写入 Context 自描述或控制逻辑。
