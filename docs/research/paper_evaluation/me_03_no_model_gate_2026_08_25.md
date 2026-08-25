# ME-03 p1.1 No-model Gate 与绑定预检

> 日期：2026-08-25  
> 结论：`ready_for_real_pilot=true`  
> 模型 completion 调用：0

## 结果

| Gate | 结果 |
| --- | --- |
| 每个开放 Context 至少两个合法值 | 通过 |
| Base 与 Intervention 合法集合不相交 | 通过 |
| 每个闭合规则唯一最大值 | 通过 |
| scorer 全部合法正例 | 通过 |
| scorer 任意文本、未知候选、错误数量、错误依据、错误闭合值负例 | 通过 |
| Prompt 合同完整 | 通过 |
| 开放 Prompt 不暴露 `closed_score` | 通过 |
| 精确模型绑定 | 通过 |

三个任务的确定性合法集合数量：

| Task | Base | Intervention | 唯一闭合值 |
| --- | ---: | ---: | --- |
| `incident_response` | 6 | 5 | `rate_limit` |
| `release_strategy` | 3 | 3 | `canary` |
| `research_strategy` | 4 | 5 | `controlled_trial` |

所有 Base/Intervention 合法集合均不相交，因此开放条件只要两边都通过，Context 干预后的
选择就必然发生可解释变化；这个判断不依赖模型主观评分。

## 冻结前人工修正

首次 p1 候选 Gate 后、任何真实模型调用前，人工审计发现两处装置问题：任务文字固定写
“选择两个”，与闭合条件的单选合同冲突；开放 Prompt 暴露只供闭合算子使用的
`closed_score`。p1.1 将任务数量措辞改为中性，并从开放 Prompt 移除闭合分数，随后重新
运行全部测试和 Gate。p1 候选产物保留，但不得作为冻结 Prompt。

## 精确绑定

- requested/physical model：`gpt-5.6-sol`
- Provider：`custom`
- protocol：`openai-responses`
- endpoint：`http://mini-m4.local:8317/v1`
- reasoning：`max`
- 单候选，`fallback=false`
- completion calls：0

## 校验值

- p1.1 `gate_report.json`：`0df754837fc6e408c2a4f98296490d8783906105f5194bee3b5a8db2b10ea05f`
- p1.1 `prompt_bundle.json`：`5c5847f23e9c7c1cb38fb11e17b04026e0c4874cf6c7c6e5b6eb292fee34ccb1`
- `binding_preflight.json`：`a873e18924e8102ebc3d8f0b47050eb0aaa797415cba971762462cd3f8d2f6cd`

