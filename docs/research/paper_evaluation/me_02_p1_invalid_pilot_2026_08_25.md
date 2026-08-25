# ME-02 p1 首次真实 Pilot 无效记录

> 运行时间：2026-08-25 18:36–18:43 CST
>
> Run ID：`ME-02-pilot-p1-20260825T103600.540Z-81858`
>
> 状态：`invalid`，不得与 p1.1 结果合并，不得进入论文定量结论

## 1. 原始观察

首次运行完成 18/18 episode，无 Provider 错误。表面分数为：

| Arm | 表面严格通过 |
| --- | ---: |
| `sexpr_ast` | 6/6 |
| `markdown_program` | 6/6 |
| `json_ast` | 5/6 |

唯一失败发生在 `alternating_branches/json_ast`。模型对 C1 和 C3 错误调用
`route_false`，随后因缺少两个有效 receipt 而拒绝编造参数，未调用 `verify_routes`。

这些数字只能用于审计实验装置，不能解释为 S-expression 或 Markdown 优于 JSON。

## 2. 无效原因一：布尔常量被错误建模为字符串

Canonical Program IR 的 `Operand::Literal` 在 p1 只有字符串类型。条件右侧原本想表达布尔
`true`，但 JSON renderer 忠实输出：

```json
{"kind":"literal","value":"true"}
```

工具 Observation 返回的是原生 JSON 布尔值：

```json
{"enabled":true}
```

JSON arm 因而面对的是“布尔 `true` 是否等于字符串 `"true"`”，并正确地按严格类型判断为
false。S-expression 和 Markdown 的 `true` 表面形式更容易被模型解释为布尔值，三个 arm 的
实际语义不再等价。

这不是 JSON 能力失败，而是 fixture 的类型错误。`alternating_branches` 整个 paired cell
作废，不能只删除失败的 JSON episode。

## 3. 无效原因二：未回传 Provider-native reasoning continuation

p1 runner 采集了 OpenAI Responses 返回的 `ProviderContinuation`，但没有在下一轮工具结果
请求中用 Morphz 的协议 marker 回传。服务仍接受了完整消息历史，因此没有产生 API 错误，
但这不等价于生产 Runtime 的 Responses 续接路径，并可能影响长链推理行为和 Token。

该偏差影响全部 episode，因此首次 p1 运行整体标记为无效，而不是保留其中 15 个看似通过的
episode 作为正式 Pilot。

## 4. p1.1 修复

1. Canonical IR 新增原生 `Boolean { value: bool }`；
2. 三个 renderer 分别输出 `(boolean true)`、JSON boolean `true`、`BOOLEAN true`；
3. No-model Gate 新增 typed-literal Gate，禁止再次退化为字符串；
4. 每次工具调用后，将 `ModelStreamEvent::ProviderContinuation` 转换为
   `provider_continuation_message`，并在 assistant tool-call message 前回传；
5. p1 的 18 个 episode 全部保留，p1.1 从零重跑完整 6×3 Pilot。

## 5. 审计价值

本次无效运行仍有两点价值：

- 机械 scorer 正确拒绝了错误分支和未完成交付，没有把模型的合理停止误记为成功；
- 单纯比较 Canonical digest 不足以证明等信息，类型系统和 Provider 协议状态也必须进入 Gate。

因此它是一次实验装置校准结果，不是产品性能结果。

## 6. 原始产物

原始 report 保存在：

`docs/research/paper_evaluation/artifacts/me02_real_pilot_p1_20260825/ME-02-pilot-p1-20260825T103600.540Z-81858/report.json`

该 report 含 18 个完整 episode、请求、响应、工具轨迹、Provider usage 和失败 scorer 证据。

SHA-256：`c9ca3716020681669a646470383947226e8f11eb86b8181e81bb700b5915a3ec`
