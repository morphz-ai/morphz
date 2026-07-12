# Morphz 当前评测状态总览

> 更新时间：2026-07-12  
> 主测模型：`gemini-3-flash-agent`；`glm-5.2`、`deepseek-v4-pro`、`gpt-5.6-sol` 作为对照模型。

## 1. 一页结论

当前不能表述为“所有测试都已经完整通过”。更准确的状态是：

- Runtime 的确定性单元、CLI 和 Attempt Loop 集成测试已全部通过；
- Coding Agent 的最小工具链和多文件修复能力已有真实通过记录；
- Agent 自主压缩 Context、保留稳定事实、重启恢复、正迁移和反例修正均已有至少一次真实成功证据；
- protocol v8 的一次 Gemini 元认知探针为 95/95；升级前 5 次基线的语义正确性为 5/5，但严格效率成功率只有 2/5；
- protocol v8 的两项 Gemini 长程测试已各完成 5 个样本；10 条轨迹均保持状态和 Mind 正确，同轮完全重复物理工具调用、同路径重复读取和 Read guard 拦截均为 0；
- 仍有 24 次空正文 standalone `context_tx`；新证据时序评分确认 Operations 有 4/5 样本在证据到达前提前引入 v3，回复完整性和语义时序尚未完全收敛；
- 跨 session/project/agent 的长期记忆作用域、传统 Context 对照策略，以及长程场景的 5 次配对发布实验尚未完成。

因此，当前最合理的判断是：**核心设计的可行性已经通过初步验证；protocol v8 的工具结果回传已经稳定消除这批样本中的物理重复调用，但 Context 维护开销、回复完整性、语义时序和对照实验仍未达发布级。**

## 2. protocol v8 单次诊断与升级前基线

protocol v8 已完成标准工具结果回传改造，并通过一次 Gemini 元认知真实探针：95/95，1 次 Context commit、2 次 recall、3 次模型请求、0 次失败。两项长程场景各完成 5 个同模型样本；这满足候选版本自身的重复样本要求，但升级前只有一个同条件样本，仍不是完整的 5 对 5 配对实验。

下表把升级前基线和 v8 单次诊断分开列出：

| 测试 | 主测模型 | 样本量 | 当前结果 | 判断 |
| --- | --- | ---: | --- | --- |
| Rust/Runtime 自动测试 | 不使用模型 | 110 库测试 + 4 CLI + 27 集成 | 全部通过；Clippy 无警告 | 已通过 |
| Metacognition v1 | Gemini 3 Flash Agent | 5 | 平均 89；95/95/85/85/85；语义准则全部 5/5；严格成功 2/5 | 语义通过，效率未稳定 |
| Operations Continuity v1，升级前 | Gemini 3 Flash Agent | 1 | 6/6 执行，5/6 严格；30 次请求、31 次物理工具 | 升级前基线 |
| Operations Continuity v1，v8 | Gemini 3 Flash Agent | 5 | 状态/Mind 30/30 阶段；语义时序 26/30；回复完整 29/30；新严格运行 0/5 | 物理重复已收敛，语义时序未收敛 |
| Autonomous Transfer v1，升级前 | Gemini 3 Flash Agent | 1 | 6/6 执行，5/6 严格；33 次请求、35 次物理工具 | 升级前基线 |
| Autonomous Transfer v1，v8 | Gemini 3 Flash Agent | 5 | 语义 30/30 阶段；回复完整 27/30；严格运行 2/5；平均 19 次请求、14.6 次物理工具 | 迁移正确，回复完整性未稳定 |

### 2.1 protocol v8 长程诊断

| 场景 | 请求：升级前单次 → v8 平均 | 物理工具：升级前单次 → v8 平均 | v8 完全重复 / 同路径重读 / Read guard | v8 语义阶段 / 回复阶段 |
| --- | ---: | ---: | ---: | ---: |
| Operations Continuity | 30 → 20.0 | 31 → 15.2 | 0 / 0 / 0 | 26/30 / 29/30 |
| Autonomous Transfer | 33 → 19.0 | 35 → 14.6 | 0 / 0 / 0 | 30/30 / 27/30 |

“完全重复”按同一用户轮次内函数名和完整参数相同计算。10 条 v8 轨迹共有 195 次模型请求和 149 次物理工具调用，完全重复物理工具、同一轮同路径重读和 Read guard 均为 0。

但 Context 维护仍有额外开销：Operations 有 11 次、Transfer 有 13 次空正文 standalone `context_tx`，合计占模型请求的 12.3%；Operations 另有 2 次事务因维护预算耗尽被拒绝。新评测器按 Ledger 顺序回放后确认，Operations 的策略修订阶段有 4/5 样本在热修复 read 证据出现前引入 `v3`；先前人工 SQL 只匹配 `service_v3/service-v3`，漏掉了 `release-v3`。真正读取 v3 证据后的首次 Mind 写入均引用了对应 read Event，来源完整性违规为 0。

长程报告现在把 `semantic_stage_pass_rate`（状态、Mind、工具约束、证据时序与来源）和 `reply_stage_pass_rate`（用户回复必需标记）分开，同时保留两者都通过才成立的 `strict_stage_pass_rate`。因此 Operations 在新标准下是语义 26/30、回复 29/30、严格完整运行 0/5；这比旧报告的 4/5 更严格，也更准确。

### 2.2 Gemini 元认知 5 次升级前结果

- 当前事实、持续约束、主动 recall、选择性遗忘、`supersedes` 和摘要保真：全部 5/5；
- Runtime chronology/freshness/residency/usage：全部 5/5；
- 执行效率：2/5；
- 平均 Context commit：2.4；
- 平均 recall：6.0；
- 平均模型请求：7.8。

三条 85 分轨迹都完成了正确的语义任务，但因重复 recall、事务或无关动作超过效率门槛而不算严格成功。当前主要问题不是“Gemini 不会维护 Context”，而是“会维护，但有时维护过度”。

### 2.3 Gemini Operations Continuity 升级前基线

| 指标 | 结果 |
| --- | ---: |
| 执行阶段 | 6 / 6 |
| 严格通过 | 5 / 6 |
| 模型请求 / 物理工具 | 30 / 31 |
| Context commit / failure | 8 / 0 |
| 重启后无工具恢复 | 通过 |
| 最终状态 / 回复 / 安全约束 | 通过 / 通过 / 通过 |
| 陈旧事实复活 | 0 |

唯一严格失败：第 1 阶段的 Mind 保留了 v1 被 v2 取代的含义，但没有保留旧端口字面值 `8080`。后续最终报告重新从证据中恢复并明确报告了 8080/9090 的取代状态。

### 2.4 Gemini Autonomous Transfer 升级前基线

| 指标 | 结果 |
| --- | ---: |
| 执行阶段 | 6 / 6 |
| 严格通过 | 5 / 6 |
| 模型请求 / 物理工具 | 33 / 35 |
| Context commit / failure | 10 / 0 |
| 正迁移 / 反例修正 | 通过 / 通过 |
| 重启后无工具恢复 | 通过 |
| 最终状态 / Mind / 回复 | 通过 / 通过 / 通过 |

唯一严格失败：策略提炼阶段已在 Mind 中正确保留策略和案例 A，但用户回复没有重述 `ALPHA-17`。这属于回复完整性扣分，不是学习或迁移失败。

## 3. 历史测试与模型身份

| 测试 | 当时模型 | 结果 | 限制 |
| --- | --- | --- | --- |
| Coding Eval v1 | `gemini-3.5-flash-low` | 100/100，固定测试 3/3 | 任务较简单；不是当前主模型 |
| Coding Eval v2 | 历史报告未固定记录模型身份 | 公开 5/5、隐藏 6/6；收口优化后 95/100 | 不能用于当前模型排名 |
| Critical Context Pressure | 历史报告未固定记录模型身份 | 9,177 → 2,140 tokens，关键事实完整 | 单样本 |
| Gradual Context Long Run | 历史报告未固定记录模型身份 | Capacity、Fidelity 通过；旧版 Efficiency 未通过；后续六轮 Context-only 收敛改善 | 尚未用当前协议和 Gemini 完整复跑 |
| Metacognition 早期四模型校准 | Gemini/GLM/DeepSeek/GPT | 已区分模型能力、4K 输出上限、长 Event ID 和 DSL BODY 问题 | 使用较早协议，不能替代当前版本结果 |
| Operations / Transfer 首样本 | `glm-5.2` | 两项均为 6/6 执行、5/6 严格通过或语义初验通过 | 单样本；主要用于定位 Runtime 问题 |

历史文档没有记录模型身份的运行，今后不再用于模型间定量对比，只保留为 Runtime 发现过程证据。

## 4. 尚未完成的测试

以下项目不能称为已测试通过：

1. Operations Continuity 的升级前 5 样本对照，形成完整 5 对 5 配对；
2. Autonomous Transfer 的升级前 5 样本对照，形成完整 5 对 5 配对；
3. 当前 protocol 下的 Gemini gradual pressure/long-run 完整复测；
4. 当前主模型的 Coding Evolution 复杂任务复测；
5. `fixed_window`、`runtime_compaction`、`retrieval_only` Context 对照实现与同条件比较；
6. session/project/agent Memory Scope 的真实跨会话正迁移、负迁移和污染隔离；
7. 不同领域、不同措辞、不同随机 seed 的泛化测试；
8. 百万 Token/百万事件级容量和长期数据库增长测试。

## 5. 后续模型使用纪律

从当前版本开始采用以下约定：

1. `gemini-3-flash-agent` 是日常开发和回归的主测 Agent；
2. Runtime 候选先用 Gemini 做至少 5 次配对样本，不以单次最好结果判断改进；
3. `glm-5.2`、`deepseek-v4-pro`、`gpt-5.6-sol` 用作模型能力对照和兼容性探针；
4. 发布前再对关键场景做四模型矩阵，而不是每次开发都消耗所有模型；
5. 每份报告必须记录模型、Runtime commit、protocol version、输出预算、Context 预算和是否 dirty；
6. 主报告同时展示语义正确性、严格通过率和效率，不能只给一个总分。

下一轮主测试顺序是：补充语义时序评分与 standalone transaction 指标 → Gemini 当前协议 gradual long-run → Gemini 复杂 Coding Evolution → 四模型对照。
