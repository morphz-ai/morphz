# Morphz 当前评测状态总览

> 更新时间：2026-07-12  
> 主测模型：`gemini-3-flash-agent`；`glm-5.2`、`deepseek-v4-pro`、`gpt-5.6-sol` 作为对照模型。

## 1. 一页结论

当前不能表述为“所有测试都已经完整通过”。更准确的状态是：

- Runtime 的确定性单元、CLI 和 Attempt Loop 集成测试已全部通过；
- Coding Agent 的最小工具链和多文件修复能力已有真实通过记录；
- Agent 自主压缩 Context、保留稳定事实、重启恢复、正迁移和反例修正均已有至少一次真实成功证据；
- 最新 Gemini 元认知测试的语义正确性为 5/5，但严格效率成功率只有 2/5；
- 两项 Gemini 长程测试都完成 6/6 阶段、严格通过 5/6，但重复工具和 Context transaction 仍然偏多；
- 跨 session/project/agent 的长期记忆作用域、传统 Context 对照策略，以及长程场景的 5 次配对发布实验尚未完成。

因此，当前最合理的判断是：**核心设计的可行性已经通过初步验证；语义正确性较好，Runtime 收敛效率和统计充分性仍未达发布级。**

## 2. 当前版本结果

| 测试 | 主测模型 | 样本量 | 当前结果 | 判断 |
| --- | --- | ---: | --- | --- |
| Rust/Runtime 自动测试 | 不使用模型 | 108 库测试 + 4 CLI + 25 集成 | 全部通过；Clippy 无警告 | 已通过 |
| Metacognition v1 | Gemini 3 Flash Agent | 5 | 平均 89；95/95/85/85/85；语义准则全部 5/5；严格成功 2/5 | 语义通过，效率未稳定 |
| Operations Continuity v1 | Gemini 3 Flash Agent | 1 | 6/6 执行，5/6 严格通过；最终状态、约束、重启恢复、拒绝陈旧证据均通过 | 初验通过，未达统计门槛 |
| Autonomous Transfer v1 | Gemini 3 Flash Agent | 1 | 6/6 执行，5/6 严格通过；正迁移、反例修正、策略修订、重启恢复均通过 | 初验通过，未达统计门槛 |

### 2.1 Gemini 元认知 5 次结果

- 当前事实、持续约束、主动 recall、选择性遗忘、`supersedes` 和摘要保真：全部 5/5；
- Runtime chronology/freshness/residency/usage：全部 5/5；
- 执行效率：2/5；
- 平均 Context commit：2.4；
- 平均 recall：6.0；
- 平均模型请求：7.8。

三条 85 分轨迹都完成了正确的语义任务，但因重复 recall、事务或无关动作超过效率门槛而不算严格成功。当前主要问题不是“Gemini 不会维护 Context”，而是“会维护，但有时维护过度”。

### 2.2 Gemini Operations Continuity

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

### 2.3 Gemini Autonomous Transfer

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

1. Operations Continuity 的 Gemini 5 次配对样本；
2. Autonomous Transfer 的 Gemini 5 次配对样本；
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

下一轮主测试顺序是：Gemini 长程场景各补足 5 次 → Gemini 当前协议 gradual long-run → Gemini 复杂 Coding Evolution → 四模型对照。
