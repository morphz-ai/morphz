# Morphz Context Long-Run Eval

Context Long-Run Eval 从低压力开始，逐批向同一个 session 注入合成长任务历史，并在每批后唤醒真实模型。它验证的不是一次 `critical` 紧急压缩，而是 Agent 能否在长期运行中持续做到：

这里的 Session 是 IO 路由，不拥有 Mind。当前夹具显式创建独立 `context_id`，所有合成历史写入该
Context，并用 `MORPHZ_CONTEXT_ID` 挂载测试 Session；文中的“同一个 session”只表示连续输入来自同一连接。

1. 在 hard limit 之前主动释放 Context；
2. 在多轮摘要后保持稳定事实和修订关系；
3. 用尽量少的事务和工具调用完成维护；
4. 避免把已完成的过程记录线性积累为长期 Mind。

## 测试协议

| 参数 | 值 |
| --- | ---: |
| Soft limit | 5,200 |
| Hard limit | 8,000 |
| Maintenance reserve | 1,700 |
| Critical threshold | 6,300 |
| 渐进批次 | 6 |
| 合成 observation | 56 |

六轮数据包含：

- 必须长期保持的 `HELIOS-9`、端口 `9090`、审计保留 `45天`、`SQLite WAL` 和 `Asia/Shanghai`；
- `/v1/ingest` 先作为候选出现，随后被 `/v2/events` 正式取代；
- 大量明确标注为一次性、可从 Ledger 召回、不应形成长期事实的批次诊断记录。

每轮提示只要求根据已有 Context 汇报状态，明确禁止 workspace 检查、Ledger recall 和其他物理工具；是否调用 `context_tx`、如何组织事务仍由模型决定。最后使用此前未提供的核验问题检查六项稳定事实和旧入口的作废状态。

评分拆成三个相互独立的轴：

- **Capacity**：未达到 hard limit、至少两次有效压缩、最终脱离 critical、至少退休三分之二的原始历史；
- **Fidelity**：Mind 和隐藏回答都保留六项事实、正确保存 `/v1/ingest` 的作废语义、没有无证据的项目阶段完成声明；
- **Efficiency**：没有 Context 事务失败、没有被提示禁止的工具输出、没有回合耗尽 Attempt、单轮最多两次 commit。

只有三轴同时通过才算整体通过。

## 使用

创建独立环境：

```bash
cargo run -p morphz-evals --bin context_long_run_eval -- create /private/tmp/morphz-eval-runs
```

每轮先注入下一批：

```bash
cargo run -p morphz-evals --bin context_long_run_eval -- advance RUN_ROOT
```

将输出的 `user_prompt` 发送给使用 manifest 环境变量启动的 Morphz。回复前后记录快照：

```bash
cargo run -p morphz-evals --bin context_long_run_eval -- snapshot RUN_ROOT round-1-injected
cargo run -p morphz-evals --bin context_long_run_eval -- snapshot RUN_ROOT round-1-after
```

六轮结束后发送 manifest 中的 `probe_prompt`，记录 `probe-after`，再独立评分：

```bash
cargo run -p morphz-evals --bin context_long_run_eval -- inspect RUN_ROOT
```

## 2026-07-11 真实模型结果

第一次运行发现原提示中的“判断是否可以进入下一阶段”诱导模型检查空 workspace，并把“阶段过程记录”误读成项目 Stage。该轨迹暴露了真实风险，但混入了测试措辞干扰。v1 随后把记录改称批次，明确它们不是项目阶段完成证据，并明确禁止所有外部工具；以下为修正后的第二次完整结果。

| 轮次 | 注入后 Token / Pressure | 维护后 Token | 新增 commit |
| --- | ---: | ---: | ---: |
| 1 | 2,986 / normal | 1,418 | 4 |
| 2 | 3,399 / normal | 1,849 | 5 |
| 3 | 3,021 / normal | 1,953 | 3 |
| 4 | 4,091 / notice | 2,103 | 4 |
| 5 | 4,243 / notice | 2,349 | 1 |
| 6 | 4,491 / notice | 2,544 | 1 |
| 隐藏核验后 | — | 2,971 / normal | 0 |

最终指标：

| 指标 | 结果 |
| --- | ---: |
| 最大 estimated tokens | 4,491 |
| Hard limit | 8,000 |
| 压缩周期 | 6 |
| notice/warning 主动压缩 | 3 |
| 退休 seed observations | 56 / 56 |
| Context commits / failures | 18 / 0 |
| 单事务收敛周期 | 2 / 6 |
| 最大单周期 commits | 5 |
| 最终活跃 / 受保护 frames | 8 / 8 |
| 被禁止的工具输出 | 46（35 recall、11 list_files） |
| Assistant calls | 54 |
| 耗尽 Attempt 的回合 | 3 |

独立评分：

- **Capacity：通过。** Context 始终低于 hard limit，三次在 notice 阶段主动维护，全部 56 条原始历史被退休；
- **Fidelity：通过。** Mind 和隐藏回答均保留六项稳定事实，`/v1/ingest` 被明确记为已废弃，未再虚构 Stage 2 完成；
- **Efficiency：未通过。** 前四轮发生多事务元认知循环，模型违背明确限制执行 recall/list_files，且把每个批次诊断结论都创建并保护为独立 Frame；
- **Overall：未通过。**

## 结论

本次比一次性 critical 测试更强地验证了容量闭环：模型不需要等 Runtime 封锁工具，在 normal/notice 就会持续执行 `derive/revise/protect/retire`，并能把物理 Context 保持在 hard limit 以下。第一项核心思想——Agent 自主避免工作 Context 溢出——已经得到第二种真实场景支持。

但当前还不能称为理想的长期 Context：模型把“压缩原始 observation”误当成“所有完成过程都应升格为长期 Frame”，并在 Context transaction 回执后继续 housekeeping。结果是 Inbox 很干净，Mind frame 数却随批次线性增长；若运行足够久，压力会从 observation 转移到受保护 frame。

以下 protocol v2 记录是当时的历史实验。其中“`reply + context_tx` 同响应终止”的 sidecar 快速路径先被 protocol v6 取代，随后 protocol v11 又把 single 模式终态统一为显式 `reply(deliver/suppress)` Function Calling。当前 Runtime 不再把无工具纯文本或空响应静默视为合法终态。

本次结果之后，protocol v2 当时实现了前三项收敛措施：

1. **附着式维护**：`reply + context_tx` 执行后直接交付同一正文，不再用成功回执唤醒模型；`act` 也可携带不依赖新工具结果的 sidecar。
2. **事务回执冷却**：独立 Context transaction 成功且脱离 critical 后，下一次响应不再暴露 `context_tx`；新 user/tool observation 到达后恢复。失败事务和仍处于 critical 的状态保留修复机会。
3. **价值选择政策**：normal/notice 不因容量压缩；已完成、可召回且没有改变长期状态的过程应直接 retire，不得创建或保护批次 Frame。
4. **Mind consolidation**：对活跃 frame 本身设置增长观察，验证模型能否合并、解除保护并退休低价值 frame，而不只是清理 Inbox。

上述 Runtime 改造仍需使用同条件长运行复测；在复测通过前，长期 Context 的经济性和可持续性仍保持未通过判定。

### Protocol v2 最小真实复测

同日使用相同第一批 10 条合成 observation 做最小复测：旧循环在这一批产生 12 次模型调用、6 次成功事务，并穿插大量 recall/list_files；protocol v2 下模型前两次尝试 standalone `context_tx`，均被 Runtime 以 `CONTEXT_TX_ATTACHMENT_REQUIRED` 拒绝，第三次改为 `reply + context_tx sidecar`。

最终结果为 3 次模型调用、1 次成功事务、0 次物理工具；10/10 条过程 observation 被退休，核心事实形成一个受保护 frame，estimated tokens 从 2,986 降至 1,424。sidecar 提交后正文直接交付，没有第四次模型唤醒。该结果验证循环约束已经生效，但完整六轮效率分仍需重新运行后更新。

### Sidecar 提示强化实验：未改善并回退

随后曾尝试进一步强化自描述：增加动态 `standalone-allowed` 字段、正反响应范例，拆分 `context-policy-rejection`，并把政策拒绝移出 Inbox。两个完全相同的重复样本均连续产生 6 次空正文 standalone 调用，直到事务预算耗尽后才回复；两次都是 0 commit，明显差于此前“2 次纠正后形成 sidecar”的结果。

该实验说明当前模型强烈遵循标准 Function Calling 的“调用工具时正文为空”模式，不能把用户响应可靠性建立在模型同时生成 content 与 tool_calls 上。强化版本已经回退：sidecar 继续作为可选快速路径；standalone `context_tx` 恢复执行，但其成功回执必须重新调用模型，下一响应冷却 `context_tx`，保证维护不会成为用户回合终点。

同时修正评估提示：旧提示曾明确说“如果需要维护可以使用 context_tx”，会主动诱导维护；新提示只要求根据已有 Context 报告状态，不再提及任何 Context 工具，以便观察模型是否真正自主选择维护。

### Protocol v2 Context-only 六轮复测

为避免把 Context 生命周期和 coding tools 的指令遵循混为一谈，评估环境新增
`MORPHZ_CONTEXT_EVAL_MODE=true`。该模式只向模型暴露 `context_tx`；它只用于评估，生产环境的工具集合不变。

使用中性提示完成六轮注入后，再追加一轮“没有新增事实、不要修改 Context”的对照。结果如下：

| 指标 | 结果 |
| --- | ---: |
| 注入批次 / seed observations | 6 / 56 |
| Context commits / failures | 6 / 0 |
| 用户回复 | 7 / 7 |
| `chat/assistant_call` / `chat/reply` | 6 / 7 |
| 物理工具输出 | 0 |
| 退休 seed observations | 56 / 56 |
| 最终活跃 / 受保护 frames | 2 / 2 |
| 最终 estimated tokens | 2,533 / 8,000 |
| 无变化对照新增 commit | 0 |

六个发生语义变化的回合均采用同一轨迹：模型先以空正文提交一个 standalone
`context_tx`，Runtime 成功执行后重新调用，并在冷却轮隐藏 `context_tx`，随后产生用户正文。没有连续 housekeeping、事务重试或用户无响应。无变化对照则只发生一次 `chat/reply`，commit 数保持为 6，说明模型没有形成“每回合必维护”的机械习惯。

这一结果不证明模型会偏好 sidecar；相反，它再次确认当前模型强烈偏好标准 Function Calling 的“空正文工具调用 → 等待结果 → 最终正文”。Runtime 已把该偏好吸收为安全的中间态：Context 维护永远不是用户回合终点，成功后进入冷却响应。protocol v6 已取消零额外唤醒的终止型 sidecar，不再让正确性依赖模型额外的布尔判断。

本轮 `inspect` 的旧 Capacity 总分仍为 false，因为当前评分器要求观测到至少两个离散压缩周期，而本次只记录了每轮维护后的快照，连续 commit 被合并为一个周期；该分数不用于判断此次响应收敛实验。后续容量测试应同时记录每轮注入前后快照，响应协议则使用上述事件计数独立验收。
