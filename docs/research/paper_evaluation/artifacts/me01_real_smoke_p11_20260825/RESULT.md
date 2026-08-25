# ME-01 p1.1 三组真实模型 Smoke 结果

> 日期：2026-08-25  
> 证据等级：`F`（Pilot 前真实模型可行性 Smoke）  
> 协议：`me01-context-reentry-p1.1-candidate`  
> Suite：`ME-01-real-smoke-20260825T042440.916Z-56277`

## 结论

在 `delayed_reference` 这一项不施加 Context 容量压力的简单任务上，三组均返回完全相同且
严格正确的行动：

```json
{
  "action": "apply_deployment_channel",
  "object_id": "service-orion",
  "value": "blue-17",
  "evidence_id": "ev-dr-001"
}
```

这次 Smoke 支持以下有限结论：

1. Structured Context 与 Mind Frame 路径没有使简单状态延迟引用任务退化；
2. `full_morphz` 不是模拟状态机，而是通过正式 Morphz Runtime、真实 SQLite 和真实
   `context_tx` 完成两次事务提交；
3. 两个已提交 Frame 在最终行动前已经进入结构化 Context 投影；
4. Morphz 进程重启后仍能从持久状态恢复并给出正确行动；
5. 本题没有制造消息历史溢出，不能证明 Morphz 优于完整消息历史，也不用于 Token 效率
   主张。更复杂任务才承担区分三组能力的责任。

## 三组结果

| Arm | 严格成功 | Provider 调用 | 进程重启 | `context_tx` 机制轨迹 |
| --- | ---: | ---: | ---: | --- |
| `append_only` | 1/1 | 3 | 不适用 | 不适用：该组没有此能力 |
| `structured_no_direct_reentry` | 1/1 | 3 | 已证明 | 不适用：实验设计关闭该能力 |
| `full_morphz` | 1/1 | 5 | 已证明 | 补充证据：2 次提交、2 个行动前 Frame |

三组的 JSON 合同、action、object、value 和 evidence 五项评分均通过；没有陈旧值、跨对象值
或完整性违规。三组的主要比较结果只有最终行动正确性；`context_tx` 对前两组不适用，
不能把原始遥测中的零计数当作零分或失败。`full_morphz` 多出的两次 Provider 调用及两次
事务提交只证明该 arm 的真实机制确实被执行，不是本项实验的优胜指标，也不应解释为效率
优势或劣势。

## 真实回流证据

`full_morphz` 在 establish 和 revise 阶段各提交一次 Context 事务。行动前投影满足：

- `mind_version = 2`；
- `me01-service-orion-deployment-state`：revision 2，保留 `blue-17`、`ev-dr-001`，并明确
  后续诊断事件不改变决策；
- `me01-deferred-action-contract`：revision 2，保留四字段合同和
  `apply_deployment_channel` 动作词；
- 两个 Frame 均带来源 Event，且出现在进程重启后的 act projection 中；
- Event History 含 2 个 `chat/context_tx_committed` 和对应工具输出。

只读组运行相同生产 Morphz 路径，但 `MORPHZ_CONTEXT_TRANSACTIONS_ENABLED=false`，模型不可
见 `context_tx`，因此事务提交对该组属于“不适用”，而不是得分为零。它仍可从持久化的
完整对话/Observation 中完成这个简单任务，因此本项出现三组天花板结果符合预期。

## 模型与运行身份

- requested / physical model：`gpt-5.6-sol`；
- reasoning：`max`；
- Provider：`custom` CLIProxyAPI 兼容 OpenAI Responses；
- fallback：`false`；
- Morphz 权限：`full_access`，网络执行关闭；
- 每个 Morphz arm 使用独立 SQLite、workspace、artifact root 和 Context；
- 实际实验/runner 源码 commit：
  `74cf1273b878309aa5ac93c4851abd23066d5ca4`；
- Runtime v4 基线祖先：`5e4b0ffcd89245f19d84ec3569605ae27a44e02b`；
- 实验所用 `target/debug/morphz` 构建时间：`2026-08-25T12:15:57+0800`；
- 二进制 SHA-256：
  `0e24c92ee797d72d6b79725284dd181de76de4f6f6bd9bec771ed151d6535db4`。

工作区当时存在与本实验无关的文档改动；Morphz Runtime、runner、fixture 和 scorer 的相关
源码在真实运行前已提交。归档校验和稳定性修复位于
`09f221ad1a8cd26c163abad9f94a6e246d0ee1b8`，只处理 SQLite WAL/SHM 的归档竞态，不改变
已经完成的模型运行、状态或评分。

## Token 与成本边界

- `structured_no_direct_reentry`：3 次调用，共 54,315 Provider-reported tokens；
- `full_morphz`：5 次调用，共 99,615 Provider-reported tokens；
- `append_only` 的兼容 Provider 响应没有返回 usage，故不伪造或估算与另两组可比的 Token
  总量；只保留三次请求、响应哈希和墙钟时间。

本 Smoke 的行动前 Context 估算仅 3,403 tokens，远低于 98,304 soft limit 和 131,072
hard limit。因此本轮的研究问题是机制真实性与非退化，不是溢出条件下的效能比较。

## 无效 p1 运行

第一次 p1 请求没有向模型公开评分器要求的精确 action 词。`append_only` 返回了语义正确的
`"action":"deploy"`，object/value/evidence 均正确，却被隐藏字符串
`apply_deployment_channel` 判错。这是协议/评分器构造缺陷，不是模型或 Morphz 失败。

该运行已原样保存在 `invalid_p1_scorer_defect/`，明确排除，不与 p1.1 结果混算。p1.1 将
动作词表移入三组完全相同的可见 fixture 后才重新运行。

## 产物与完整性

- `summary.json`：三组汇总和 Gate 结论；
- 每个 arm 的 `observed_episode.json`、`score.json`、`arm_report.json`；
- Morphz arms 的完整 Event History、重启前 Event、模型 usage、行动前/最终 Context 投影、
  进程 PID 与日志；
- append-only 的完整消息 transcript、调用 receipt 与请求/响应哈希；
- `checksums.sha256`：本归档全部文件的最终校验值。

包含可变 SQLite 主库和 Provider 控制数据库的原始工作目录未提交 Git；其原始位置为：

```text
/private/tmp/morphz-me01-real-smoke-p11-20260825/
  ME-01-real-smoke-20260825T042440.916Z-56277/
```

Git 归档包含复核结论和因果链所需的全部非敏感机器可读 JSON/日志。仓库内归档重新生成
校验和并逐项验证通过。

## 下一步

本次只完成一项真实 Smoke，不能替代五个预注册任务族的 Pilot。下一步若继续 ME-01，应
按同一 p1.1 协议运行其余 paired cells，并把更复杂的 supersession、source authority、
跨 Session 与 Context isolation 任务用于检验三组是否出现差异；在 Pilot 之前不宣称
Morphz 胜出。
