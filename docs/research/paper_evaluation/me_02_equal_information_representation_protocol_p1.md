# ME-02 等信息递归表示对照协议 p1

> 状态：`pilot-complete`（Pilot p1.1）
>
> 冻结时间：p1 2026-08-25 18:33 CST；p1.1 2026-08-25 18:59 CST
>
> 关联研究问题：RQ1
>
> 证据目标：Pilot（P），通过 Pilot Gate 后另行冻结确认性样本量

## 1. 研究问题与结论边界

### 1.1 主要研究问题

当抽象程序、操作语义、可见事实、工具、模型、Provider、预算与评分器都相同时，
模型能否从不同的表面表示中可靠读取并求值同一个递归程序？

### 1.2 主要假设

`sexpr_ast` 的端到端严格成功率不低于 `json_ast` 和
`markdown_program`。该假设允许三组全部接近；本实验不预设 S-expression 必须全面胜出。

### 1.3 次要假设

- H2：三组在跨 Observation 精确引用、局部绑定、条件分支和失败回退上不存在系统性退化；
- H3：如果两种结构化 AST 组接近而 Markdown 组退化，证据支持“递归结构比具体括号语法更重要”；
- H4：如果三组接近，证据只支持 S-expression 是一种可行且不退化的实现选择，不能支持其性能优势；
- H5：如果 S-expression 在嵌套、复用或作用域任务上更稳定，Pilot 将用于估计确认性实验所需样本量，而不直接形成显著性主张。

### 1.4 本实验不回答

- 不比较 Structured Context 与 messages list；该问题由 ME-01 和 ME-06 回答；
- 不比较直接结果回流、`context_tx`、长期维护、跨 Session、并发或恢复；
- 不证明括号语法本身是 Morphz 的全部创新；
- 不证明 Token 更少、延迟更低或公开 Benchmark 更强；
- 不测试未来的 Program-valued `infer` 或任意双向交替求值；
- 不把旧 `annotated_kernel` 与 `bare_readable` 的探索性结果升级为正式证据。

## 2. 因果变量与等信息原则

### 2.1 唯一自变量

唯一预定自变量是同一 Canonical Program IR 的序列化表示：

1. `sexpr_ast`：递归 S-expression；
2. `json_ast`：递归 JSON AST；
3. `markdown_program`：带显式节点类型、层级、绑定和引用的 Markdown 程序。

三组不是三套人工分别编写的任务。Runner 先构造唯一 Canonical Program IR，再由三个纯
renderer 生成可见程序。每个 arm 的 prompt artifact 都记录同一个 `semantic_digest`。

### 2.2 保持不变

- 完全相同的中性 System Contract；
- 完全相同的算子语义：`seq`、`bind`、`call`、`if`、`fallback`、`reply`；
- 完全相同的标准 Function Calling 工具定义和确定性工具实现；
- 完全相同的任务常量、变量名、字段引用和控制流；
- 完全相同的隐藏工具结果、终止条件、最大请求数和评分器；
- 同一 paired cell 使用相同物理模型、Provider、reasoning effort 和运行环境；
- 不向任一 arm 添加格式专属的任务解题建议或答案线索。

### 2.3 “等信息”不等于“等 Token”

三种表示的字符数和 Token 数天然不同。不得通过无语义 padding 强行等长。正式报告同时保留：

- Canonical Program IR 的稳定 digest；
- 每个 renderer 的字符数、字节数和本地 tokenizer 估计；
- Provider 返回的实际 input/output/cached usage（若协议提供）；
- 完整 prompt artifact，供人工审计是否存在遗漏、增加或措辞偏置。

## 3. Arms

| Arm | 可见程序 | 唯一变化 | 不允许的额外帮助 |
| --- | --- | --- | --- |
| `sexpr_ast` | Canonical IR 的 S-expression renderer | 括号式递归序列化 | 不额外解释 S-expression，不加载专属 VM Kernel |
| `json_ast` | Canonical IR 的 JSON AST renderer | JSON 对象/数组递归序列化 | 不使用更详细字段说明，不依赖 JSON mode |
| `markdown_program` | Canonical IR 的 Markdown renderer | 显式层级的自然语言程序 | 不改写为更丰富的操作教程，不重复工具说明 |

所有组共享一个格式中立的 System Contract。Contract 定义抽象算子语义，但不评价任何表示优劣。

## 4. Pilot 任务族

Pilot 使用 6 个确定性任务，每个任务的关键交付值只出现在工具 Observation 中，不出现在
任务程序、System Contract 或工具 schema 中。

| Task | 主要压力点 |
| --- | --- |
| `binding_chain` | 四级跨轮绑定和精确字段引用 |
| `alternating_branches` | 真/假交替，只执行被选分支 |
| `nested_fallback` | 两级明确失败后进入第三候选，不提前执行 |
| `shared_reference` | 同一个 Observation 字段被两个后续节点复用 |
| `merge_after_observations` | 两个独立 Observation 完成后再合并和验证 |
| `guard_no_action` | 条件不成立时禁止现实工具调用，直接回复固定公开值 |

Pilot 不引入 Context 压力、长期历史或 compaction。这一项只隔离递归表示的读取和求值能力。

## 5. 运行单元与顺序

- paired cell：同一 task、同一 repetition 下的三个 arm；
- Pilot：6 tasks × 3 arms × 1 repetition = 18 episodes；
- arm 顺序按 task 轮换，不能固定让某一格式总是先运行；
- 每个 episode 使用全新消息列表和全新工具状态，不共享模型 continuation；
- Pilot 只决定任务区分度、失败模式和确认性样本量，不进入最终显著性结论。

若 18/18 全部严格通过，判定存在天花板效应：该 Pilot 仍可支持“表示可行且未观察到退化”的
工程结论，但不能据此宣称某一表示更优。确认性设计必须增加更长依赖、嵌套或组合压力，而不是
简单重复同类容易任务。

## 6. 指标

### 6.1 主要指标

端到端严格成功（binary）：同时满足

1. 实际工具轨迹与预注册轨迹完全一致；
2. 每个依赖工具调用发生在产生其输入的 Observation 之后；
3. 条件和回退只执行合法分支；
4. 没有额外探索、重复调用或错误参数后修复；
5. 最终回复包含由真实工具结果产生的独立交付 token。

### 6.2 次要指标

- 语义成功率：允许额外恢复调用，但仍要求最终结果、因果顺序和分支正确；
- 引用与分支准确率；
- 可完成率、修复率、模型请求数和工具调用数；
- 输入、输出、cached Token，延迟与 Provider 失败。

### 6.3 诊断而非胜负指标

- prompt 字符数/字节数/本地 tokenizer 估计；
- 首次正确动作延迟；
- 空回复、纯解释、提前猜测、错误分支、变量串扰和未收口分类。

## 7. Scorer 与负例 Gate

Scorer 必须机械拒绝：

- 提前猜测尚未返回的隐藏 token；
- 同一请求并行发出存在数据依赖的工具调用；
- 未选分支工具调用；
- 预期轨迹外的额外工具调用；
- 最终 token 只作为更长幻觉字符串的子串出现；
- 工具链完成但最终回复缺失；
- 非法工具参数、达到请求上限或空响应。

No-model Gate 还必须验证：

- 三个 renderer 源自同一 Canonical Program IR；
- paired arm 的 `semantic_digest` 完全一致；
- System Contract 与工具 schema 完全一致；
- 隐藏工具输出不出现在任何可见 prompt；
- 正例和上述负例均能被 scorer 正确判定。

## 8. 失败、排除与补跑

| 情况 | 分类 | 计入模型结果 | 补跑 |
| --- | --- | --- | --- |
| Provider 明确 429/5xx 且无模型输出 | service failure | 否 | paired cell 不完整；恢复后整 cell 补跑 |
| Provider `cyber_policy` 拒绝 | provider refusal | 是，单列 | 否 |
| 模型空响应、解释程序或未收口 | model outcome | 是 | 否 |
| 非法参数、错误工具或达到请求上限 | model outcome | 是 | 否 |
| Runner/工具实现崩溃 | harness failure | 否 | 修复后提升 runner 版本并重跑受影响 cell |
| 人工中断 | interrupted | 否 | 不与原批次拼接 |

## 9. 模型与运行配置

Pilot 当前预定：

| 字段 | 值 |
| --- | --- |
| 逻辑/物理模型 | `gpt-5.6-sol`，运行前必须验证无 fallback |
| Provider | 现有 CLIProxyAPI / OpenAI Responses 路径 |
| reasoning effort | `max` |
| 权限 | 本实验只有确定性模拟工具，不涉及宿主 full-access；三个 arm 权限完全相同 |
| 最大模型请求数 | 16/episode |
| 并发 | Pilot 串行，避免 Provider 配额和缓存差异污染配对顺序 |
| Context | 每个 episode 新消息列表，不共享历史 |

## 10. 产物

每次运行至少保存：

```text
manifest.json
prompt_bundle.json
episodes.jsonl
requests/
traces/
scores.json
summary.json
checksums.sha256
RESULT.md
```

Runner：`morphz-evals/src/me02_representation_eval.rs`

CLI：`morphz-evals/src/bin/me02_representation_eval.rs`

No-model Gate：
`docs/research/paper_evaluation/artifacts/me02_no_model_gate_p11_20260825/`

模型绑定预检：
`docs/research/paper_evaluation/artifacts/me02_binding_preflight_p11_20260825/`

真实 Pilot artifact root：
`docs/research/paper_evaluation/artifacts/me02_real_pilot_p11_20260825/`

原始模型输出必须追加保存，不覆盖失败轨迹。

## 11. Pilot Gate 与后续解释

- [x] 三种 renderer 等信息审计通过；
- [x] 隐藏答案泄漏扫描通过；
- [x] scorer 正负例通过；
- [x] 精确模型和 reasoning effort 绑定通过；
- [x] 18 个 Pilot episode 均有完整、可重评分的原始产物；
- [x] 三组均为 6/6，确认存在天花板效应；未观察到表示导致的失败模式；
- [ ] 在不重复容易样本的前提下，另行冻结更长组合压力任务及确认性样本量。

可能结论严格限定为：

- 三组接近：具体 S-expression 表面语法不是优势来源，但它作为程序/数据统一表示未造成可见退化；
- 两种 AST 接近、Markdown 退化：递归结构是主要因素，具体括号语法不是必要条件；
- S-expression 更好：只形成需扩大配对样本验证的 Pilot 信号；
- S-expression 更差：论文和产品主张必须缩小，并检查 renderer 或模型熟悉度偏差；
- 所有组天花板：保留不退化证据，进入更长组合压力，不用重复容易样本制造虚假统计量。

## 12. 版本记录

| 版本 | 日期 | 修改 | 是否使旧结果失效 |
| --- | --- | --- | --- |
| p1 draft | 2026-08-25 | 首次将表示、Kernel 说明强度和任务措辞解耦；规定 Canonical IR 三 renderer | — |
| p1 frozen | 2026-08-25 | 6×3 No-model Gate 和零 completion 精确物理绑定预检通过；冻结 Pilot | 否 |
| p1 invalid | 2026-08-25 | 首次真实运行暴露布尔字符串类型错误和缺失 Provider continuation；18 episodes 整体无效并保留 | — |
| p1.1 frozen | 2026-08-25 | 新增原生 Boolean IR、typed-literal Gate 和 Responses continuation 回传；No-model 与绑定 Gate 重过 | 是：p1 真实 Pilot 不得并入 p1.1 |
| p1.1 Pilot complete | 2026-08-25 | 6 tasks × 3 arms 共 18/18 严格通过；三组均 6/6，记录天花板和不退化证据 | 否 |
