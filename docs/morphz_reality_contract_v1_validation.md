# Morphz Reality Contract v1 实现与验证报告

> 状态：v1 已实现并完成 Gemini 五次正式回归
> 日期：2026-07-12
> 主模型：`gemini-3-flash-agent`
> Context Protocol：v9
> 设计基线：[`morphz_reality_constrained_epistemic_context.md`](morphz_reality_constrained_epistemic_context.md)

## 1. 本次实现

Reality Contract v1 没有给 Mind 增加固定事实/假设 Schema，仍由模型自由创造 Frame BODY。Runtime 本次新增的是通用现实坐标与认识纪律：

- `context_contract.rs` 成为 Reality/Epistemic Contract 的单一事实源；
- System Prompt、Context SExpr protocol 与 `context_tx` 工具说明由同一组 clause 生成；
- Protocol 从 v8 升级为 v9，并自描述 `reality-contract-v1` 与 `epistemic-contract-v1`；
- 明确 observation 不等于真理、不得使用未来证据、结论不得强于来源、部分属性变化不得无证据连带改变身份/版本/角色/阶段/状态、recency/usage 不等于权威；
- Context 保持 `protocol → kernel → mind → inbox`，稳定协议位于所有高频动态字段之前；
- System Prompt 与 Context 稳定前缀使用确定性渲染和进程内缓存；phase 指令只追加在稳定 System Prompt 之后；
- OpenAI-compatible usage 新增 `prompt_tokens_details.cached_tokens` 解析和日志字段；
- 新增长程 `epistemic_reality_v1` 套件及 `create-epistemic` / `run-epistemic` CLI；
- Evidence Gate 改为守卫“事实断言形态”，不再因目标或假设只提到某个实体就误报。

## 2. Prefix Cache 结论

自动测试已经锁定两项 provider-independent 不变量：

1. 不同 Session、Attempt 与压力状态生成的 Context，其首个动态 `(kernel ...)` 之前具有完全相同的字节前缀；
2. System Prompt 的基础规则与生成契约确定不变，临时 phase 指令只出现在稳定前缀之后。

本轮模型代理产物没有保留下可审计的 `cached_tokens` 数值，因此只能确认“请求编排具备前缀缓存条件”，不能声称已测得真实缓存命中率。后续应把 LLM usage 持久化进 Event History 或评测报告，而不只写日志。

## 3. 新跨领域隐藏套件

`epistemic_reality_v1` 在同一个六阶段 Session 中测试两个表面无关的领域，并包含一次进程重启：

1. 人员档案：地点、轮值、审批权限与职责范围变化，不能在正式任命证据出现前升级角色；证据出现后必须修订；
2. 事件处置：负责人、SLA 与修复部署变化，不能在正式关闭证据出现前把事件标为 resolved；证据出现后必须修订。

两个未来证据文件在对应阶段之前物理上不存在。正式更新必须来自 `read` 工具 Observation，并要求首次确定性 Mind 结论通过 `(from @eN)` 保留来源。

### 3.1 五次结果

| 指标 | 结果 |
| --- | ---: |
| 阶段数 | 30 |
| State 正确 | 30/30 |
| Mind 正确 | 30/30 |
| Behavior 正确 | 28/30 |
| Semantic 正确 | 28/30 |
| Reply 完整 | 24/30 |
| Strict 通过 | 22/30 |
| 证据前提前事实 | 0 次，两个领域均 5/5 |
| 来源 Gate 通过 | 两个领域均 4/5 |
| 来源违规 | 2 次，集中在同一次运行 |
| 模型尝试 | 122，平均 24.4/次运行 |
| 物理工具调用 | 89，平均 17.8/次运行 |
| Context commit | 38，平均 7.6/次运行 |
| 空正文 standalone transaction | 13，占 Attempt 10.7% |
| 精确重复物理调用 | 0 |
| 同路径重复物理调用 | 0 |
| Read Guard 拒绝 | 0 |

核心结论：两个领域都没有出现证据前事实升级；失败集中在一条轨迹两次漏写 `from`，以及最终回复漏报被要求的 ID/字段。Runtime 契约显著改善了认识时序，但来源纪律和回复完整性尚未达到确定性。

## 4. Operations v8 → v9 配对回归

五次修正 Gate 的 v9 正式回归位于 `/private/tmp/morphz-reality-v9-corrected/operations-*`。此前一组使用裸 `v3` Gate 的轨迹仍保留在 `/private/tmp/morphz-reality-v9-formal/operations-*`，用于审计“待核验 v3 目标被误判为当前事实”的评测器缺陷，不纳入下表。

| 指标 | v8 五次 | v9 五次 | 变化 |
| --- | ---: | ---: | ---: |
| 证据前提前 v3 的运行 | 4/5 | 1/5 | 明显改善，达到 ≤1/5 目标 |
| 时序违规事件 | 9 | 1 | -88.9% |
| 来源违规 | 0 | 0 | 持平 |
| State 正确 | 30/30 | 24/30 | 一次运行的初始机器字段错误贯穿六阶段 |
| Mind 正确 | 30/30 | 30/30 | 无回归 |
| Semantic 正确 | 26/30 | 23/30 | 受同一文件状态错误连带影响 |
| Reply 完整 | 29/30 | 29/30 | 持平 |
| 模型尝试 | 100 | 100 | 0% |
| 物理工具调用 | 76 | 73 | -3.9% |
| Context commit | 32 | 34 | +6.3% |
| 精确/同路径重复调用 | 0 | 0 | 持平 |

v9 唯一的真实提前事实发生在“只更新保留期与时区”阶段：模型无证据创建了 `(version v3)`。另一次旧 Gate 命中只是模型保存“核验 hotfix-v3”的工作目标并同时发起 `read`，不是事实断言；因此 Gate 已改为匹配 `(version v3)`、`version-v3` 等断言形态，不再匹配孤立 `v3`。

State 回归来自一条轨迹把明确要求的 `current_port/current_endpoint/security_rule` 写成 `port/endpoint` 并漏掉安全字段。该轨迹的 Mind 六阶段均正确，但外部机器契约不正确。这个问题不应通过 Operations 专用字段补丁修复；它属于下一阶段的通用“机器格式与字面契约遵循”问题。

## 5. 自动验证

- `cargo test --workspace --all-targets`：114 个库测试、4 个 CLI 测试、27 个集成测试全部通过；
- `cargo clippy --workspace --all-targets -- -D warnings`：通过；
- 新增测试覆盖契约三端一致性、稳定前缀、cached token usage 兼容解析、两个隐藏证据源、断言形态 Gate 与来源违规。

## 6. 阶段判断

Reality Contract v1 支持以下判断：

- **方向通过**：自由 Mind 与 Runtime 现实约束可以协同，且不是依赖 v3 业务特化；
- **认识时序通过第一阶段门槛**：旧问题由 4/5 降到 1/5，新领域达到 5/5；
- **来源纪律接近但未完全收敛**：两个新 Gate 均为 4/5；
- **效率无显著回归**：旧场景 Attempt 持平，工具下降，transaction 增幅低于 10%；
- **产品可靠性尚未收口**：回复漏字段和机器字段字面不遵循仍可能让严格任务失败；
- **前缀缓存结构已就绪，但真实命中率尚未完成可观测闭环**。

下一优先级不是继续增加业务事实规则，而是让 Runtime 支持通用的机器契约声明与校验、持久化 LLM usage/cache 指标，并继续用跨领域任务评估来源引用和最终交付完整性。
