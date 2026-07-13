# Morphz Context Pressure Eval

Context Pressure Eval 验证 Agent 是否会在接近物理 Context 上限时，自主选择重要信息形成 Mind frame，并退休不再有价值的原始 observation。Runtime 只提供压力、DSL 和可执行边界，不替模型决定摘要内容。

当前夹具会创建不同的 `context_id` 与 `session_id`，把合成 Observation 写入前者，并通过
`MORPHZ_CONTEXT_ID` 将测试 Session 挂载到同一 Context，避免退回旧的“一 Session 一 Context”假设。

## 测试设计

v1 使用缩小阈值模拟超长生命周期，避免为了验证行为真的发送百万 Token：

| 参数 | 值 |
| --- | ---: |
| Soft limit | 6,000 |
| Hard limit | 9,000 |
| Maintenance reserve | 2,500 |
| Critical threshold | 6,500 |
| 初始 observation | 38 |
| 初始 estimated tokens | 9,177 |

合成历史不包含用户数据或仓库代码，包括：

- 四项必须长期保留的稳定事实：`ORBIT-7`、正式端口 `9090`、审计日志保留 `30天`、`SQLite WAL`；
- 一个已被更正的旧端口候选 `8080`；
- 一项长期报告偏好；
- 32 条已经完成、可从 Ledger 召回、不应继续占据工作 Context 的阶段实验记录。

用户只发送中性请求“继续这个长期项目”，不直接要求摘要或压缩。`critical` 时 Runtime 暂停物理高成本工具，只暴露 `context_tx/recall`；保留哪些信息、如何组织 frame、退休哪些 observation 由模型决定。

## 使用

创建独立环境：

```bash
cargo run -p morphz-evals --bin context_pressure_eval -- create /private/tmp/morphz-eval-runs
```

使用输出的环境变量启动 Morphz，并发送 manifest 中的 `user_prompt`。运行后独立检查：

```bash
cargo run -p morphz-evals --bin context_pressure_eval -- inspect RUN_ROOT
```

成功条件：

- 最终 pressure 不再是 `critical`；
- 至少退休 75% 的 seed observations；
- 活跃 Mind frame 覆盖四项稳定事实；
- 至少一次 Context commit，且没有失败或拒绝；
- 只产生一次最终回复。

## 首次真实模型结果

2026-07-11 首次真实运行通过：

| 指标 | 初始 | 最终 |
| --- | ---: | ---: |
| Pressure | critical | normal |
| Estimated tokens | 9,177 | 2,140 |
| Active frames | 0 | 1 |
| Active observations | 38 | 6（含最终回复） |
| Active seed observations | 38 | 5 |

Agent 一次提交成功：

- 创建并保护 `core_facts`；
- 从五条稳定事实 observation 派生摘要；
- 保留这些原始关键证据；
- 退休旧的 `8080` 候选和 32 条阶段实验过程；
- 正确记录 `9090` 已取代 `8080`；
- 四个预期标记全部存在；
- Context failure 为 0；
- estimated tokens 减少 7,037，最终为初始的 23.3%。

这证明当前机制在一次受控真实运行中形成了完整闭环：`pressure → 自主 derive/protect/retire → pressure 恢复 normal → reply`。

## 结论边界

本次只能说明初步行为验证通过，不能直接证明任何模型、任意长期任务都不会溢出：

- 本文记录的合成夹具使用固定计数的测试 Client，因此 9,177/2,140 仍是可重复的局部压力模拟；生产主链现已计量完整 Prompt 并标记计量精度，但 OpenAI-compatible Client 当前仍使用估算与 completion usage 校准，旧基准绝对值不能与生产 prompt tokens 直接横向比较；
- Context hard limit 由配置提供，尚未根据模型 metadata 自动选择；
- 单次真实运行不能给出稳定成功率，需要多 seed、多压力梯度重复；
- 模型在 `critical` 时仍可能拒绝维护并直接回复；Runtime 会阻止新的物理高成本动作，但尚未实现 checkpoint/emergency recovery；
- 摘要忠实度目前用稳定标记和来源审计验证，复杂语义冲突仍需要更强的 held-out questions。

下一阶段应测试 gradual growth：从 `normal → notice → warning → critical` 持续注入 observation，验证模型是否在到达 critical 前主动维护，而不是只在 Runtime 限制工具后响应。
