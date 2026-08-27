# ME-03 受约束开放求值与 Context 干预协议 p1

> 状态：`pilot-complete`（p1.1）
> 日期：2026-08-25  
> 关联研究问题：RQ3  
> 证据目标：Pilot（P）

## 1. 研究问题

开放语义符号能否在确定的类型与约束边界内产生不唯一但合法的结构化结果，并在 Context
发生相关变化时产生可解释的结果变化，而不是输出任意文本？与之相对，闭合算子是否仍保持
唯一、可重复的结果，不被只与开放判断相关的偏好 Frame 改写？

本实验中的“非确定性”不等于随机采样，也不要求同一输入每次得到不同答案。它指求值关系
允许多个满足同一契约的候选值，由模型结合当前 Context 选择其中一个；Runtime 只承认满足
声明类型和约束的候选值。

## 2. 假设

- H1：`bounded_open` 的候选值能够保持高契约有效率；
- H2：Base 与 Intervention Context 的合法结果集合均至少包含两个值，且干预后实际结果落入
  新 Context 的合法集合；
- H3：开放求值结果对 Context 干预敏感，但变化可以由 Frame 和候选属性解释；
- H4：`closed` 对照按显式数值规则产生唯一结果，并在同一 Context 干预前后保持不变；
- H5：重复运行中观察到的合法多样性只作描述，不把强制随机性当作机制成立的必要条件。

## 3. 因果变量与四个条件

每个任务包含同一组候选对象、Base Context、Intervention Context 和一个唯一闭合规则。

| 条件 | 求值关系 | Context |
| --- | --- | --- |
| `bounded_open_base` | 选择任一满足契约的两个候选对象 | Base |
| `bounded_open_intervention` | 选择任一满足契约的两个候选对象 | Intervention |
| `closed_base` | 选择 `closed_score` 唯一最大值 | Base |
| `closed_intervention` | 选择 `closed_score` 唯一最大值 | Intervention |

开放条件不设置隐藏最优答案。每个 Context 的硬约束由必需属性组和禁止属性构成；多个候选
组合均可通过同一确定性 scorer。闭合条件明确忽略开放偏好，只执行唯一数值规则。

## 4. Pilot 任务族

1. `incident_response`：服务连续性与公开透明 Context 之间的干预；
2. `release_strategy`：渐进稳健与紧急交付 Context 之间的干预；
3. `research_strategy`：广度扫描与因果验证 Context 之间的干预。

No-model Gate 必须证明：每个开放 Context 至少有两个合法组合；Base 与 Intervention 的合法
组合不相交；闭合最大值唯一；正例全部通过且任意文本、未知候选、错误数量、错误 Context
依据和错误闭合答案均被拒绝。

## 5. 模型与运行

- `gpt-5.6-sol`，reasoning `max`，单候选，`fallback=false`；
- CLIProxyAPI 的 OpenAI Responses 路由；
- 每个 episode 为全新消息列表，不共享 continuation 或认知状态；
- 单次模型请求、无修复轮；无效 JSON 或契约失败直接计失败；
- Pilot：3 tasks × 4 conditions × 2 repetitions = 24 episodes；
- task 内 condition 顺序轮换，避免某一条件总是先运行；
- temperature 不作为实验操纵变量；保存 Provider 实际接受的参数。

## 6. 指标

主要指标：

- 开放契约有效率；
- Context 干预敏感度：同一 repetition 中 Base 与 Intervention 均合法且结果不同；
- 闭合正确率与干预前后不变率。

描述性指标：

- 同一 Context 重复求值的合法唯一结果数；
- 输入/输出/cached Token、reasoning Token 和延迟；
- 选择分布和失败分类。

不得把更高多样性等同于更好，也不得因没有观察到多样性而否定非唯一求值关系；合法结果
集合的多值性由独立确定性枚举 Gate 证明。

## 7. 结论边界

本实验只验证受约束开放求值、Context 干预和闭合对照。它不验证：

- S-expression 相对 JSON 的优越性（ME-02）；
- 结构化 Context 相对消息历史的长期优势（ME-01/ME-06）；
- Runtime 权限、版本、因果与副作用安全（ME-04）；
- 跨模型泛化（ME-05）。

Pilot 可支持机制可行性和失败模式判断，不能直接形成跨模型或统计显著性结论。

## 8. Gate

- [x] 每个开放 Context 的合法组合数不少于 2；
- [x] Base/Intervention 合法集合不相交；
- [x] 每个闭合任务有且仅有一个最大值；
- [x] scorer 正负控制通过；
- [x] Prompt bundle 与 scorer 版本落盘；
- [x] 精确物理模型、Provider、reasoning 和 fallback 绑定通过；
- [x] 24 个 Pilot episode 完整落盘并可重评分；23/24 严格通过，唯一失败为闭合条件的 JSON 字段类型错误。

## 9. 冻结产物

- No-model Gate：`artifacts/me03_no_model_gate_p11_20260825/`
- 模型绑定预检：`artifacts/me03_binding_preflight_p1_20260825/`
- Runner：`morphz-evals/src/me03_bounded_open_eval.rs`
- CLI：`morphz-evals/src/bin/me03_bounded_open_eval.rs`

## 10. 版本记录

| 版本 | 日期 | 修改 | 真实模型调用 |
| --- | --- | --- | ---: |
| p1 candidate | 2026-08-25 | 首版四条件与三个任务；Gate 后发现数量措辞冲突及开放 Prompt 暴露闭合分数 | 0 |
| p1.1 frozen | 2026-08-25 | 中性化任务数量；开放 Prompt 移除 `closed_score`；落盘完整合法集合；重新通过测试、Clippy、No-model 与绑定 Gate | 0 |
| p1.1 Pilot complete | 2026-08-25 | 开放 12/12、Context shift 6/6、闭合严格 11/12；失败不补跑 | 24 |
