# Morphz 显式 Reply 决策双组回归结果 v1

日期：2026-07-13
模型：`gemini-3-flash-agent`
正式重复：每组每任务 5 次
正式报告：`/private/tmp/morphz-sexpr-explicit-reply-formal/sexpr-explicit-reply-ab-v1-20260713T073816.868Z-96303/report.json`

> 历史状态：本文验证了“静默也必须显式表达”的价值。Protocol v16 保留这一结论，但以更小的 `no_reply` 工具表达静默；当前 Session 的普通回复恢复为无工具文本。见 [单 Session 求值与响应路由协议 v1](./morphz_response_routing_protocol_v1.md)。本文后续实验结果保留了 v11 当时的指标和术语，用于解释设计如何演进，不代表当前接口。

## 1. 结论摘要

显式 Reply 决策通过了本轮验证：

- 旧实验中最容易在完整工具链后返回空响应的 `module-reuse`，本轮两组共 10 次全部干净成功，10/10 都明确调用 `reply(deliver)`，协议纠错为 0；
- 新增的“确实不需要向 Session 发送消息”场景共 10 次全部在第一次响应调用 `reply(suppress)`，没有空响应，也没有错误投递；
- 50 个正式 episode 全部得到正确最终结果，没有熔断；
- SExpr 内算子描述组 25/25 干净成功；外部自然语言 VM 组 23/25 干净成功、25/25 结果成功，其中两次非干净行为都发生在 `fallback` 过程，而不是最终 Reply 阶段。

这说明“模型无论是否需要对外发送文本，都必须作出显式 Reply 决策”比把空响应解释为结束更稳定。在当前样本中，旧的最终回复缺失已经收敛；这仍是单模型、小样本结论，尚不能证明任意模型和长任务都不会违反协议。

## 2. 被比较的两组

两组使用同一个模型、相同 SExpr 任务、相同标准 Function Calling 工具、相同确定性工具结果和相同终止状态机：

| 组别 | System Prompt 表达 |
|---|---|
| `annotated_kernel` | System Prompt 从第一个字符开始就是 SExpr；六个基础算子的自然语言语义写在各自 SExpr 节点内部 |
| `external_nl_vm` | System Prompt 使用一段外部自然语言说明 VM、算子和 Reply 契约；任务仍是相同 SExpr |

本轮没有加入纯自然语言、裸 SExpr 或纯符号 Kernel，因为目标不是重新做五组消融，而是直接比较此前最强的两个候选，并验证新的 Reply 状态机。

## 3. Reply 协议

语义层只保留两个终态：

```lisp
(reply content)
(reply no-reply)
```

物理执行使用一个标准 Function Calling 工具：

```json
{"disposition":"deliver","content":"..."}
{"disposition":"suppress"}
```

- `deliver` 必须带非空 `content`，Runtime 将它投递给当前 Session；
- `suppress` 明确表示本次求值完成，但不向 Session 投递消息；
- `reply` 必须独占终止响应，不能和其他工具调用混在同一响应；
- 普通文本和空响应都不是本评测的合法终态；
- 非法终态会收到一条紧凑协议错误并继续求值，最多允许两次纠错，第三次仍非法则熔断。

这里的 `no-reply` 不是“什么都没返回”，而是模型通过标准工具调用作出的显式、可观测、可审计决定。

## 4. 任务与评分

正式实验包含原来的四个回归任务，并新增一个 `no-reply` 任务：

1. `linear-discovery`：顺序发现 Skill、执行、验证并回复不透明 token；
2. `conditional-fallback`：主路径返回 `AUTH_REQUIRED` 后执行备用路径；
3. `module-reuse`：按完整局部过程先处理 Alpha，再处理 Beta，最后回复两个不透明 token；
4. `guard-no-action`：条件不成立时不调用业务工具，直接交付固定结果；
5. `explicit-no-reply`：后台事件明确不需要 Session 消息，调用 `reply(suppress)`。

交付值改为 `D-7Q4M-9182` 一类不可从任务名猜出的值，防止模型跳过真实工具链后猜答案。

`clean_success` 要求工具调用精确、因果顺序正确、分支正确、Reply 决策正确，并且没有协议纠错。`outcome_success` 允许错误调用后自行修正，或经 Runtime 协议提示后恢复，但最终过程和 Reply 必须正确。

## 5. 正式结果

| 组别 | 干净成功 | 结果成功 | 恢复成功 | 平均模型请求 | 平均工具调用 | 平均协议错误 |
|---|---:|---:|---:|---:|---:|---:|
| `annotated_kernel` | 25/25（100%） | 25/25（100%） | 0/25 | 4.20 | 4.20 | 0.00 |
| `external_nl_vm` | 23/25（92%） | 25/25（100%） | 2/25 | 4.28 | 4.24 | 0.04 |

逐任务结果：

| 任务 | 算子描述组：干净 / 结果 | 外部自然语言组：干净 / 结果 |
|---|---:|---:|
| 线性发现 | 5/5 · 5/5 | 5/5 · 5/5 |
| 失败回退 | 5/5 · 5/5 | 3/5 · 5/5 |
| 过程复用 | 5/5 · 5/5 | 5/5 · 5/5 |
| 无动作分支 | 5/5 · 5/5 | 5/5 · 5/5 |
| 显式不回复 | 5/5 · 5/5 | 5/5 · 5/5 |

外部自然语言组的两次恢复是：

1. 主搜索返回 `AUTH_REQUIRED` 后，模型产生一次无有效动作的响应；Runtime 报协议错误后，模型继续备用路径并正确 `reply(deliver)`。这是正式实验唯一一次 Reply 协议纠错；它发生在中间状态，不是工具链完成后的最终 Reply 缺失。
2. 模型把 `browser-research` 的工具参数生成错误，收到确定性工具错误后自行修正并完成 Reply。它没有触发 Reply 协议纠错，但因为多了一次错误工具调用，不算干净成功。

两组都没有熔断、没有缺失最终决定，也没有把 `suppress` 错误地投递给 Session。

## 6. 旧失败场景的直接回归

上一轮五组对照中，`module-reuse` 最容易暴露终止边界问题：

- `annotated_kernel` 的 5 次中有 2 次完成全部六个业务工具调用后返回空正文；完整成功为 3/5；
- `external_nl_vm` 的 5 次中同样有 2 次完成工具链后返回空正文，另有 1 次多余调用后恢复；干净成功为 2/5，语义结果成功为 3/5。

本轮保留相同的 Alpha→Beta 局部过程和真实因果轮次，只把可猜交付值换成不透明 token，并将最终语义改为标准 `reply` 工具决策：

| 组别 | 旧：干净成功 | 旧：工具链后空响应 | 新：干净成功 | 新：协议纠错 | 新：熔断 |
|---|---:|---:|---:|---:|---:|
| `annotated_kernel` | 3/5 | 2/5 | 5/5 | 0/5 | 0/5 |
| `external_nl_vm` | 2/5 | 2/5 | 5/5 | 0/5 | 0/5 |

因此，用户特别要求回归的“两次没有 reply”已经在两个候选组中分别以 5 次重复验证通过。由于本轮有意同时改变了 Reply 表达、Function Calling 终态和错误恢复状态机，这个前后比较用于验证整体方案是否收敛，不用于把收益严格归因给某一句提示词。

## 7. 如何看待两种提示方式

本轮结果支持继续把 `annotated_kernel` 作为当前候选：它不仅没有退化，而且 25 个样本全部干净；外部自然语言 VM 的两个噪声样本都出现在较复杂的 fallback 边界。

不过，25 对 25 的单模型实验不足以证明长期稳定优势。更稳妥的判断是：

- SExpr 内自然语言算子描述已经达到可用，并在本轮表现更干净；
- 外部自然语言前言并非正确执行所必需；
- 显式 Reply 决策是这轮最明确的收益，不应把普通空响应继续当作合法终态；
- 在正式接入主 Runtime 前，还需要把同一状态机放进真实 Session 路由，验证 `deliver` 只投递给目标 Session、`suppress` 不产生外部消息，并观察长任务中的纠错率。

固定 System Prompt 字符数分别为 1371 和 735。这里仍然只是字符数，不是服务端实际 token；本轮没有获得 cached-token 指标，不能据此评价真实 prefix cache 成本。

## 8. 复现与实现位置

```shell
cargo run -q -p morphz --bin sexpr_reply_eval -- \
  /private/tmp/morphz-sexpr-explicit-reply-formal 5
```

- Reply 版 Kernel：`morphz/src/sexpr_vm_contract.rs`
- 双组评测、协议纠错和评分：`morphz-evals/src/sexpr_reply_eval.rs`
- 评测入口：`morphz-evals/src/bin/sexpr_reply_eval.rs`

Pilot 的 10 个 episode 只用于检查夹具，不进入上述正式统计。
