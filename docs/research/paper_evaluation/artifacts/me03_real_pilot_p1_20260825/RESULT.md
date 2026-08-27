# ME-03 p1.1 受约束开放求值与 Context 干预真实 Pilot

> 日期：2026-08-25  
> 状态：`pilot-complete`  
> Run：`ME-03-pilot-p1-20260825T115637.429Z-90120`  
> 冻结实验 commit：`1aef93ade23923e2fab76013b2c5ab29129ef546`

## 结论

24 个预注册 episode 中 23 个严格通过，无 Provider 错误：

| 条件 | 严格通过 |
| --- | ---: |
| `bounded_open_base` | 6/6 |
| `bounded_open_intervention` | 6/6 |
| `closed_base` | 5/6 |
| `closed_intervention` | 6/6 |

开放求值共 12/12 满足精确 JSON 类型、候选集合、数量、当前 Context 依据和语义约束。
同一 task/repetition 的 Base 与 Intervention 结果 6/6 发生变化，并全部落入干预后的合法
集合。由于 No-model Gate 已独立枚举每个 Context 的多个合法值，且干预前后集合不相交，
这构成“受 Context 约束的非唯一求值”证据，而不是任意文本生成。

闭合条件严格通过 11/12。唯一失败的
`release_strategy / repetition 1 / closed_base` 选择值本身是正确的 `canary`，但把声明为
数组的 `basis` 输出成字符串。冻结 scorer 将其作为类型契约失败保留，不补跑、不改分。
因此闭合选择的原始语义值为 12/12 正确，但正式严格结果仍是 11/12；前者只作失败诊断，
不替代预注册得分。严格闭合干预不变配对为 5/6。

## 非确定性的准确解释

每个开放 Context 的合法结果集合包含 3–6 个值。两次独立重复中，模型在同一个
task/Context 下选择了相同组合，没有观察到重复间多样性。这不应被描述成“模型随机变化”，
也不否定非唯一求值关系：本实验中的非确定性是契约允许多个值、模型负责选择一个，随机性
不是必要条件。当前结果证明合法多值边界和 Context 敏感性，不证明输出分布具有高熵。

## 任务级结果

| Task | Base 合法值 | Intervention 合法值 | 开放 Context shift | 闭合严格不变 |
| --- | ---: | ---: | ---: | ---: |
| `incident_response` | 6 | 5 | 2/2 | 2/2 |
| `release_strategy` | 3 | 3 | 2/2 | 1/2 |
| `research_strategy` | 4 | 5 | 2/2 | 2/2 |

## 运行条件与成本

- 模型：`gpt-5.6-sol`
- Provider：`custom` / OpenAI Responses
- reasoning：`max`
- 单候选，`fallback=false`
- 单 episode 一次请求，无修复轮
- Provider errors：0
- Input Token：21,054（全部 uncached）
- Output Token：3,531
- Reasoning Token：2,552
- Total Token：24,585

## 证据边界

本 Pilot 支持：

1. 开放符号可以返回多个契约允许值中的一个；
2. 候选值受当前 Context 约束，并在相关 Frame 变化后产生可解释变化；
3. 输出仍受精确类型和集合合同约束，类型正确性不能被“语义上答对”替代；
4. 闭合规则与开放判断是不同求值关系。

本 Pilot不支持：随机性、高多样性、跨模型泛化、S-expression 优越性、长期 Context 优势或
Runtime 权威安全。Runtime 的准入与副作用边界由 ME-04 的确定性 Gate 提供证据。

## 后续判断

ME-03 对当前论文机制主张已经达到 Pilot 证据目标，可以进入 ME-05 跨模型核心子集。若后续
需要更强确认性结果，可预注册带重叠合法集合的软偏好干预，测量方向性分布变化；不得为了
观察随机多样性临时提高 temperature 或在看到结果后补跑。

## 原始证据

- `report.json` SHA-256：`8931a0d2682bd58f97f94cddda2b60ecc507b20609d74dbaa64d3ab128031e81`
- `prompt_bundle.json` SHA-256：`5c5847f23e9c7c1cb38fb11e17b04026e0c4874cf6c7c6e5b6eb292fee34ccb1`
- 原始目录：`ME-03-pilot-p1-20260825T115637.429Z-90120/`

