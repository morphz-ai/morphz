# Morphz Cognitive S-Expression VM Prompt A/B

> 状态：5 次正式配对实验已完成  
> 日期：2026-07-12  
> 目的：验证“把 LLM 定义为 SExpr 认知虚拟机的语义处理器”是否比传统 AI Agent 身份获得更好的正确性、效率和自主抽象。

## 1. 实验假设

当前基线把 Morphz 定义为“能够管理自身工作 Context 的 AI Agent”。候选 Prompt 把一次模型调用定义为持续运行的 Cognitive S-Expression Machine 的非确定性执行周期：`kernel` 是特权机器状态，`mind` 是持久化符号程序与认知状态，`inbox` 是外部输入；LLM 提出语义迁移，Runtime 确定性提交。

候选 Prompt 只改变机器身份和认知执行模型，不新增 Experience Transfer 场景中的 `approved-current`、A–E、具体值或答案。现有契约中本来就有“时序或使用频率不等于 authority”的通用认识纪律，它在 A/B 中字节级相同；Reality/Epistemic Contract、Context DSL、工具规则、任务、模型和预算均保持不变。

## 2. A/B 组

| 组 | `MORPHZ_SYSTEM_PROMPT_MODE` | 含义 |
| --- | --- | --- |
| A | `agent_owned_context` | 当前已提交的原始 System Prompt，字节级保持不变 |
| B | `cognitive_sexpr_vm` | 新的认知 SExpr VM 身份前言，加完全相同的公共执行规则与契约 |

每次 paired run 同时启动 A/B 两个 Experience Transfer suite；每个 suite 内又并发运行相关经验、无关经验和全新三个隔离 arm。因此一次 paired run 共六条 Agent 轨迹。

正式结论至少使用 5 次 paired run，不以 pilot 或最好一次代表结果。

## 3. 冻结判据

### 3.1 主要判据

1. **语义正确性不退化**：B 的 State/Mind/Behavior 语义通过总数不得低于 A；
2. **严格正确性不显著退化**：B 的严格通过总数不得出现系统性下降；
3. **执行效率**：在正确性不退化前提下比较模型尝试、物理工具和 Context commit；
4. **相关经验迁移**：单独报告 related arm，不能用 unrelated/fresh 的收益掩盖相关经验退化。

### 3.2 结构判据

最终 Mind 原样保留并报告：

- case-bound frame 数；
- 包含多个 case 的聚合 frame 数；
- relation 数；
- 具有 `principle/rule/policy/strategy/procedure/pattern/heuristic/abstraction` 或对应中文结构头的候选抽象 frame；
- 所有 Frame BODY、来源、版本和保护状态。

词法候选只用于定位，不能自动证明真正抽象。正式结论必须人工审查全部相关经验轨迹，判断它是否：

1. 表达了跨案例可复用的判断或执行结构；
2. 保留适用范围、来源、反例或不确定性；
3. 不是把案例换一个名字重新罗列；
4. 没有把未经来源支持的归纳写成确定事实。

### 3.3 负面判据

以下现象必须单独报告：

- 过度抽象或错误泛化；
- 只维护 Mind 而没有完成外部任务；
- 把标准 Function Calling 写成普通文本；
- standalone Context transaction、重复工具或维护成本增加；
- 用户回复完整性下降；
- 路径安全拒绝、模型服务失败或测试夹具污染。

## 4. 结论等级

- **强支持**：B 正确率更高或不变、成本更低，并显著增加真实可复用抽象；
- **部分支持**：B 正确率不变，成本或认知结构至少一项稳定改善，但另一项没有证据；
- **不支持**：B 没有可靠改善，或收益被方差/通用预热解释；
- **反证**：B 系统性降低正确率、增加成本或造成错误泛化。

不使用主观期待调整上述标准。

## 5. 已知限制

- 模型服务当前不能提供受控随机 seed，属于同条件并发配对，不是逐 token 可复现实验；
- Experience Transfer 目前只有一个证据判断任务族；
- 重启轮禁止新工具和 Ledger recall，但 Context 中仍可能存在未 retire 的 Inbox Observation，因此“回复仅来自 Mind”不是完全隔离；正式实验的 `mind_passed` 已修正为只检查活动 Mind Frame/Relation，不再允许 Inbox 文本替 Mind 通过；
- 候选 Prompt 本身提到了跨任务抽象，因此“是否形成抽象”证明的是机器身份与元认知指导整体有效，而不是模型在完全无提示下自然发现抽象目标。

## 6. 运行入口

```bash
cargo run -p morphz --bin long_horizon_agent_eval -- \
  run-experience-prompt-ab PROFILES.toml BASE_DIR
```

每次运行生成 `prompt_ab_report.json`，其中包含 A/B 两个完整 suite、六个最终 Mind 快照和三个 arm 的候选减基线方向差。

## 7. 评测修正与无效 pilot

第一次 pilot 发现旧评测器的 `mind_passed` 在整个 Context SExpr 上搜索标记。案例 D 即使已从 Mind 消失，只要仍出现在 Inbox，也会被误判为 Mind 通过。该 pilot 不进入结果。

正式实验前已把评分修正为仅检查活动 Mind Frame 与 Relation，并增加“退休 Frame 和 Inbox 文本不能替 Mind 通过”的回归测试。这个修正使 fresh/unrelated 组的真实 Mind 保留率明显低于旧报告，但不偏向 A 或 B。

## 8. 五次正式结果

主测模型为 `gemini-3-flash-agent`。每次 A/B 同时启动，5 次正式运行均没有路径安全拒绝、Runtime panic、模型重试耗尽或回复等待超时。Run 5 的后端墙钟延迟明显增加，但两侧均持续返回有效结果；墙钟时间不进入比较。

### 8.1 Related arm 逐次结果

每格依次为“语义通过 / 模型尝试 / 物理工具 / Context commit / 最终活动 Frame”。

| Run | A：Agent Prompt | B：Cognitive SExpr VM |
| --- | ---: | ---: |
| 1 | 3/3 / 7 / 6 / 2 / 6 | 3/3 / 7 / 7 / 2 / 2 |
| 2 | 2/3 / 8 / 7 / 3 / 3 | 3/3 / 7 / 7 / 2 / 5 |
| 3 | 3/3 / 8 / 7 / 2 / 5 | 3/3 / 9 / 8 / 2 / 3 |
| 4 | 3/3 / 8 / 7 / 2 / 5 | 3/3 / 7 / 7 / 2 / 3 |
| 5 | 3/3 / 9 / 7 / 2 / 2 | 3/3 / 8 / 7 / 2 / 1 |

### 8.2 五次聚合

| Arm / 指标 | A：Agent Prompt | B：Cognitive SExpr VM | B-A |
| --- | ---: | ---: | ---: |
| Related 语义/严格 | 14/15 | 15/15 | +1 / +1 |
| Related 模型尝试 | 40 | 38 | -2 |
| Related 物理工具 | 34 | 36 | +2 |
| Related Context commit | 11 | 10 | -1 |
| Related standalone transaction | 3 | 0 | -3 |
| Related 重启恢复 | 5/5 | 5/5 | 0 |
| Unrelated 语义/严格 | 7/15 / 6/15 | 11/15 / 10/15 | +4 / +4 |
| Fresh 语义/严格 | 5/15 / 5/15 | 5/15 / 5/15 | 0 / 0 |
| 三 arm 总语义/严格 | 26/45 / 25/45 | 31/45 / 30/45 | +5 / +5 |
| 三 arm 总模型尝试 | 124 | 122 | -2 |
| 三 arm 总物理工具 | 102 | 110 | +8 |
| 三 arm 总 Context commit | 38 | 34 | -4 |
| 三 arm 总 standalone transaction | 11 | 8 | -3 |

VM Prompt 原始稳定前缀为 6,124 字符，基线为 5,657 字符，增加 467 字符。两者都位于动态 Context 之前并保持确定性，可参与 Prefix Cache；本实验未持久化真实 cache 命中指标。

## 9. Mind 人工审计

10 条 related Mind 全部人工检查，结论如下：

1. A/B 都没有出现显式跨案例 `principle/rule/policy/strategy/procedure/pattern` Frame；词法候选也是 0；
2. VM 组没有产生错误的通用规则、未来事实或未经来源支持的跨案例关系；
3. VM 组平均活动 Frame 为 2.8，基线为 4.2。VM 更常把多个案例合并进一个 `decision` 或 `task` Frame，而不是每案例一个 Frame；
4. 这种合并保留了案例值和理由，但仍是案例聚合，不是抽象规律；
5. VM related 的 15/15 表明合并没有损害目标 D/E 和重启恢复；
6. fresh/unrelated 的主要失败是处理 E 时覆盖丢失 D，严格 Mind-only 评分正确捕获了该问题。部分回复明确借助 Inbox 回答 D，但不再被计为 Mind 通过；
7. 没有发现候选把标准 Function Calling 系统性写成普通文本，也没有重复物理调用或路径安全污染。

## 10. 结论

按照本轮最主要的“非退化”目标，Cognitive SExpr VM Prompt **通过**：

- related 正确性没有退化，反而从 14/15 提升到 15/15；
- related 模型尝试略降，Context commit 和 standalone transaction 下降；
- 三 arm 总语义/严格均增加 5 个阶段；
- 没有错误泛化或工具协议系统性退化。

效率不是全面胜利：related 物理工具增加 2 次，三 arm 总工具增加 8 次；模型尝试只下降 2 次。这说明新身份可以安全进入后续研究，但还不能声称它已经使执行普遍更高效。

本轮没有验证“短训练即可产生抽象规律”，这也不是合理的强制门槛。当前证据支持：

> 把 Morphz 定义为 Cognitive S-Expression Machine 的语义处理器，在当前任务族中没有造成退化，并改善了 Mind 保持与聚合倾向；如何从长期经历形成真正可复用的规律，仍需要更长训练、反思触发条件和抽象质量评测。

按预注册等级属于“部分支持”：机器身份迁移可接受，抽象能力尚未得到证据。基于本轮主要目标是确认非退化，`cognitive_sexpr_vm` 已提升为 Runtime 和普通 Experience Transfer 的默认模式；`agent_owned_context` 保留为显式回归基线。后续仍需用不同任务族验证默认值的泛化性，若出现系统性退化可直接切回基线。
