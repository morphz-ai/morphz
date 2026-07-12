# Morphz Long-Horizon General Agent Eval

> 状态：v1 评测规范与首个场景实现中
> 目标：在相同模型、工具、任务和预算下，可证伪地比较 Agent-Owned Context 与固定窗口、Runtime compaction 等对照策略。

## 1. 为什么需要新基准

已有 Context Pressure、Context Long-Run、Metacognition 和 Coding Eval 分别证明了容量管理、语义保真、Context DSL 与代码修复闭环。它们仍不能回答一个更强的问题：

> 当任务持续数十轮、目标反复变更、证据互相冲突、进程中断并重启时，Morphz 是否比传统 Context 策略获得更高的最终完成率，而不只是“成功提交了 Context transaction”。

新基准评价的对象是完整 Agent，不是单独 DSL、Prompt 或某个工具。

## 2. 设计红线

1. 不在 Runtime 中写入针对某个场景的规则。
2. 不用“调用了某工具”代替最终任务正确性。
3. 黑盒验证器不对 Agent 可见，不允许模型修改评分标准。
4. 对照组必须使用相同模型、采样参数、工具权限、工作区、用户消息和 Token 预算。
5. 评测任务可以具体，评分维度和 Runtime 改造必须通用。
6. 保留所有失败轨迹，不以最好一次代表模型能力。

## 3. 任务族

v1 定义三个互补族，每个族至少有一个可离线重放场景：

### 3.1 Coding Evolution

- 多文件实现与隐藏测试；
- 中途变更需求或推翻早期设计；
- 进程重启后继续开发；
- 最终评分正确性、修改范围、回归和维护成本。

### 3.2 Evidence Synthesis

- 本地文档包含新旧版本、不完整证据与显式冲突；
- 用户在后续轮次修订问题和约束；
- 要求最终结论有来源、有不确定性边界，不复活已作废结论。

### 3.3 Operations Continuity

- 管理配置、发布状态、安全约束和事故记录；
- 中途注入热修复、过期通知和不可信文档；
- 重启 Agent 进程后继续，检查是否保留当前状态与早期安全约束。

新闻采集系统可作为 Coding Evolution 中的一个场景，但不是唯一基准，也不定义 Runtime 心智结构。

## 4. 对照 Context 策略

| 策略 ID | 含义 | 状态 |
| --- | --- | --- |
| `agent_owned_v6` | LLM 通过 `context_tx` 自主维护 Mind，Runtime 只管机制 | 当前候选基线 |
| `fixed_window` | 仅保留固定近期事件，不自主摘要和召回 | 待实现对照适配器 |
| `runtime_compaction` | Runtime 在阈值处生成统一摘要 | 待实现对照适配器 |
| `retrieval_only` | 原始 Ledger + 被动检索，没有 Agent-Owned Mind | 可选扩展对照 |

对照适配器只能改变 Context 编译策略，不能改变任务、工具或验证器。

## 5. 场景合同

每个场景由一份可持久 manifest 定义：

- `family` 和 `scenario`；
- 工作区初始快照与允许修改边界；
- 有序 `stages`，每阶段包含用户任务、外部变化、是否重启 Agent 和隐藏验收；
- 固定模型、Context 策略、输出上限、Context 软/硬限制与 Attempt 预算；
- 每阶段的 reply、Mind、workspace、Ledger 和资源快照；
- 运行时 commit hash，保证后续可重放。

场景验证器必须区分：

1. **Outcome**：产物和隐藏测试是否正确；
2. **Behavior**：是否无界扩张、重复工具、越权修改；
3. **Context**：约束、当前目标、取代关系与未完成事项是否正确；
4. **Cost**：模型请求、Token、工具调用、Context 事务、延迟与 Ledger 增长；
5. **Recovery**：重启、失败事务、错误遗忘后能否恢复。

## 6. v1 公开指标

- `Stage Completion Rate`；
- `Hidden Outcome Pass Rate`；
- `Constraint Retention`；
- `Goal Revision Accuracy`；
- `Obsolete Fact Reuse Rate`；
- `Restart Recovery`；
- `Final Reply Fidelity`；
- `Context Commit/Failure/Repair`；
- `Self-Amnesia Rate`；
- `Model Attempts` 与 `Maintenance Overhead`；
- `Peak Context Tokens` 和 `Ledger Growth`；
- `Workspace Scope Violations`。

所有率类指标报告分子和分母，不只报百分比。

## 7. 首个场景：Operations Continuity v1

首个可执行场景是一个离线发布连续性任务，用于先跑出当前 Runtime 的不动实现基线。

阶段事件：

1. 根据 v1/v2 配置和持续安全约束建立当前发布状态；
2. 用户修订保留期与默认时区，旧值必须失效；
3. 注入 v3 热修复，要求更新端口和事件入口；
4. 关闭并重启 Morphz 进程，核验 Mind 与工作区恢复；
5. 注入写入时间更晚但明确标记为 archived/untrusted 的旧通知，检查 Agent 不会因物理时间更新就复活旧值；
6. 生成最终运行报告，并对照 Mind、文件和 Ledger 三份证据。

首轮只运行 `agent_owned_v6`，不在看到失败前修改 Runtime。随后实现对照适配器并进行配对比较。

## 8. 发布门槛

一个 Runtime 候选改动只有在以下条件同时成立时才能称为长程改进：

- 至少 5 个配对随机样本；
- Outcome 不退化；
- Constraint Retention 和 Goal Revision 不退化；
- 没有新的越权修改或自我失忆；
- 质量收益大于 Context 维护额外成本；
- 改动能够用通用 Agent 语义解释，不依赖某个场景的关键词。

## 9. 首次不改 Runtime 基线

2026-07-12 在 Runtime commit `5b25904` 上使用 GLM-5.2、128K 最大输出和 `agent_owned_v6` 跑完 Operations Continuity v1。六个阶段全部执行，5/6 严格通过；最终文件、最终回复、安全约束和过期信息拒绝均正确。

| 指标 | 结果 |
| --- | ---: |
| 阶段完成 | 6 / 6 |
| 严格阶段通过 | 5 / 6 |
| 最终状态文件 | 通过 |
| 最终回复保真 | 通过 |
| 持续安全约束 | 保留 |
| 过期事实复活 | 0 |
| 模型请求 | 21 |
| 物理工具调用 | 17 |
| Context commit / failure | 6 / 0 |
| 峰值 / 最终 estimated tokens | 4,760 / 2,823 |
| Ledger events / SQLite bytes | 114 / 77,824 |

唯一失败发生在进程重启后的无工具恢复核验：端口 `9443`、入口 `/v3/events`、保留期、时区、安全约束和完整取代链均能恢复，但稳定项目代号 `ORBIT-42` 已从 Mind 中消失。工作区文件仍正确，后续重新读取证据后最终报告恢复了代号。

事务链证明这不是 SQLite 重放或进程恢复错误。第 2 阶段模型执行：

```lisp
(revise project-state
  (retention-days 45)
  (timezone Asia/Shanghai))
```

`revise` 的实际语义是“用新 BODY 完整取代旧 BODY”，但当前自描述只说“修订”。模型将它理解为局部字段更新，因此在 revision 2 中同时丢掉了 project、version、port 和 endpoint。其他 frame 仍保留端口与版本历史，所以只有项目代号在重启核验中暴露为不可恢复。

该失败定位出三个通用改进方向：

1. 自描述必须明确 `revise` 是完整替换，不是隐式 merge；
2. Agent-Owned Mind 需要 Agent 可控、可审计的 Checkpoint/rollback，而不是 Runtime 静默修补语义；
3. 长期经验需要 session/project/agent 作用域，否则无法测试跨任务迁移和负迁移。

## 10. protocol v7 单次诊断回归

protocol v7 在不修改场景、模型和预算的条件下重跑一次。该样本只用于检查失败机理，不满足 5 次发布门槛。

v7 的三层契约明确说明 `revise` 是完整替换。GLM 在保留期/时区修订时一次重述了 project、version、port、endpoint、retention 和 timezone；进程重启后 Mind 与回复均保留 `ORBIT-42`。因此 v6 基线暴露的主要语义丢失已在该样本中消失，且并非 Runtime 静默补全。

但单次 v7 轨迹也暴露了两个独立问题：

- 回复字面保真波动：安全含义正确但未逐字输出 `NEVER-LOG-SECRETS`，最终回复也没有重述 8080/9090；导致严格阶段分为 2/6，但 Mind 和状态文件六阶段均正确。
- 证据定位循环：热修复阶段已有 read 输出进入 Inbox，模型仍反复 read/recall，产生 15 次模型请求、18 次物理工具调用和 3 次 Context commit。整轨迹为 32 次请求、33 次物理工具和 8 次 commit，明显高于 v6 样本的 21/17/6。

v7 新增的 checkpoint 在该轨迹中调用 0 次，因此效率差异不能归因于快照存储，也不能从单个随机样本归因于 protocol v7。下一个通用 Runtime 改进候选应针对“重复读取被拒绝时，如何精确指回已有证据”，并必须用配对多样本验证。
