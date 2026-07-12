# Morphz 元认知 Context 评测框架

> 状态：v1 已实现；目标是判断 Context 机制和 Agent 维护策略是否真实进步，而不是只验证 DSL 能否调用。
>
> 当前最终状态和主测模型口径见 [Morphz 当前评测状态总览](morphz_eval_status.md)。本文件保留评分定义、协议演进与历史模型校准。

## 1. 评测对象

评测明确拆成两个部分：

1. **Runtime Contract（运行时契约）**：Agent 是否能客观看见时序、物理版本新旧、全文/预览驻留状态，以及“仅展示不算使用”。这部分是确定性机制测试。
2. **Agent Policy（Agent 元认知策略）**：模型是否正确保留持续约束、主动召回缺失证据、区分新旧事实、声明语义取代、清理重复噪声，并在有限调用内回复用户。这部分受模型能力和 Prompt 影响。

两者必须分别报告。否则 Runtime 字段实现正确可能掩盖 Agent 不会利用它，强模型的推理能力也可能掩盖 Runtime 元数据缺失。

## 2. 首个通用黑盒场景

`context_metacognition_eval` 创建一个与 Coding Agent 无关的合成长期状态：

- 同一 `service-port` 资源的 v1=8080 与 v2=9090，测试物理 freshness 与语义 `supersedes`；
- 一条只出现一次但必须长期保留的安全约束，测试重要性不能由出现频率替代；
- 12 条重复的一次性过程记录，测试选择性遗忘；
- 一条中部隐藏验收口令的长记录，当前只驻留 preview，测试主动 recall；
- 最终要求同时维护 Mind 并回复，测试独立维护是否能收敛到用户可见结果。

评测不要求固定 Frame ID 或固定 Mind schema，只检查语义、来源行为、关系、生命周期和执行轨迹。

## 3. 评分

总分 100：

| 维度 | 分数 | 说明 |
| --- | ---: | --- |
| Runtime 时序 | 3 | 新 observation 的稳定 sequence 大于旧 observation |
| Runtime freshness | 5 | 同一资源 v2 标记 latest，v1 标记非 latest |
| Runtime residency | 4 | 长记录明确显示 preview、truncated、retrievable |
| Runtime usage | 3 | 初始展示没有伪造 recall/from 使用次数 |
| 当前事实 | 15 | Mind 和回复使用 9090，并识别 8080 已被取代 |
| 持续约束 | 15 | 安全约束进入受保护 Frame；不要求最终回复逐字重复内部 Frame 标识 |
| 主动召回 | 15 | recall 命中正确 Event，隐藏口令进入 Mind/回复 |
| 选择性遗忘 | 10 | 至少退休 70% 重复噪声 |
| 语义取代 | 10 | 建立 `v2 supersedes v1` 关系 |
| 摘要保真 | 5 | 项目、配置、约束和召回证据均完整 |
| 执行效率 | 10 | 有最终回复、无事务失败、至多 2 次事务、至多 4 次模型调用、无无关物理工具 |

通过线为 85 分，且 Runtime 四项、当前事实、持续约束、主动召回和执行效率均不得失败。关键能力采用硬门槛，避免用大量容易得分的项目抵消自我失忆、错误事实或失控循环。`supersedes` 只要曾在已提交事务中正确声明即可计入语义识别；评分器会同时报告关系是否仍驻留在当前 Mind，允许 Agent 在退休旧证据后主动撤销关系，但保留 Ledger 审计记录。

## 4. 使用方法

创建隔离环境：

```bash
cargo run -p morphz --bin context_metacognition_eval -- create /private/tmp/morphz-evals
```

命令输出 `environment`、`run_root` 和 `manifest.user_prompt`。使用输出中的环境变量启动 Morphz，把 `user_prompt` 原样作为一次用户输入。该场景会保留 `recall`，但关闭子 Agent/技能工具；评分器会拒绝无关物理工具调用。运行结束后检查：

```bash
cargo run -p morphz --bin context_metacognition_eval -- inspect RUN_ROOT
```

对两个实现生成的独立 run 做维度对比：

```bash
cargo run -p morphz --bin context_metacognition_eval -- compare BASELINE_RUN CANDIDATE_RUN
```

自动启动 Morphz、提交任务、等待回复、退出并评分：

```bash
cargo build -p morphz --bin morphz
cargo run -p morphz --bin context_metacognition_eval -- run /private/tmp/morphz-evals
cargo run -p morphz --bin context_metacognition_eval -- suite /private/tmp/morphz-evals 5
cargo run -p morphz --bin context_metacognition_eval -- compare-suites BASELINE_SUITE CANDIDATE_SUITE
```

每次 run 保存独立数据库、workspace、`agent.stdout.log`、`agent.stderr.log` 和 `run_report.json`；suite 保存各维度通过率、平均分、标准差、调用均值及所有子报告。默认从同目录寻找 `morphz` 二进制，也可通过 `MORPHZ_EVAL_AGENT_BIN` 指定。

### 多模型 profile

模型配置文件只记录地址、模型名和“保存 key 的环境变量名”，绝不记录 API key 本身：

```toml
[[profiles]]
name = "local-model-a"
base_url = "http://127.0.0.1:8000/v1"
model = "local-model-a"
api_key_env = "MORPHZ_LOCAL_MODEL_A_API_KEY"

[[profiles]]
name = "local-model-b"
base_url = "http://127.0.0.1:9000/v1"
model = "local-model-b"
api_key_env = "MORPHZ_LOCAL_MODEL_B_API_KEY"
```

运行前通过进程环境提供 key，再执行同条件模型矩阵：

```bash
export MORPHZ_LOCAL_MODEL_A_API_KEY="..."
export MORPHZ_LOCAL_MODEL_B_API_KEY="..."
cargo run -p morphz --bin context_metacognition_eval -- \
  model-matrix model-profiles.toml /private/tmp/morphz-model-evals 5
```

矩阵逐模型使用相同 Runtime、fixture、Prompt、评分和运行次数，并输出成功率、平均分、标准差、Context transaction、recall 和模型调用均值。报告只包含 `api_key_env` 名称，不包含其值。

OpenAI-compatible 响应的 `finish_reason`、token usage 和各工具参数字符数会写入诊断日志。`finish_reason=length` 表示整次 completion 不完整；Runtime 不会把其中的正文或工具参数当成有效结果。Protocol v6 不再让模型声明 `final_reply`：任何工具调用都必定续跑，同响应正文只记为可见进度；只有无工具调用且正文非空的响应才是最终回复。

## 5. 正确的实验纪律

- 基线与候选必须使用相同模型、采样参数、Context 上限、工具集和用户 Prompt。
- 随机模型至少运行 5 组配对样本；报告均值、成功率和各维度退化，不能只挑最好的一次。
- Runtime 分和 Agent 分必须分开观察；字段测试应由单元测试稳定通过，黑盒测试用于验证模型是否真正利用字段。
- 评分规则、marker 和阈值应在实验前固定，失败轨迹必须保留。
- 后续应加入多个措辞变体和领域变体，避免模型只适配一个 Prompt；当前 v1 是最小可重复基准，不是最终排行榜。
- 发布门禁建议采用“关键维度无退化 + 配对总分提高 + 维护 Token/延迟可接受”，而不是只比较总分。

## 6. 后续扩展

下一阶段应增加：目标反转、多轮摘要漂移、错误记忆恢复、跨 session 持久化、百万级累计事件、不同模型能力分层，以及与滑动窗口、Runtime 自动摘要、自动 RAG 的同条件基线。评测框架最终需要报告效果（effectiveness）、效率（efficiency）、容量（capacity）和恢复性（recoverability）四个轴。

## 7. 首轮真实轨迹

首轮黑盒运行立即发现了一个通用问题：评测把 observation preview 设为 700 字符时，`recall` 的真实单次上限只有 188 字符，但工具 Schema 仍声称最多 20,000。模型多次请求大块内容，却反复收到 offset=0 的 188 字符片段，最终 6 次直接 recall、12 次 Attempt 后仍未得到隐藏口令。框架得分 65/100；Runtime 四项通过，Agent 的新旧识别、约束保护、噪声退休和 supersedes 通过，但主动召回与效率失败。

据此完成了通用修复：

- recall 的最小有效 chunk 提升到 4,000 字符；
- Function Calling Schema 动态公开当前真实上限；
- 返回值明确给出 `next_offset` 的下一步指令；
- query 不再只返回原文开头，而是返回命中词附近片段、字符偏移和建议 recall 参数；
- Agent 协议明确禁止在 active frame 已吸收证据后无新理由重复 recall，也禁止为清理刚产生的过程记录继续 housekeeping。

修复后的两次观察均成功取得 `LANTERN-731`：一次使用 4 次直接 recall / 15 次模型调用，另一次使用 1 次直接 recall / 7 次模型调用。后者明显减少了循环，但最终回复漏写安全约束原文，且 3 次 Context transaction 仍超过效率门槛，因此仍不判定通过。不同单次轨迹在语义完整性上存在波动，进一步证明发布结论必须基于多次配对实验，而不能以一条“看起来不错”的轨迹代替统计结果。

自动 suite 的首个五次基线结果为：平均分 88、标准差 6、范围 80–95、成功率 40%。Runtime、当前事实、长期约束、主动召回、选择性遗忘和 supersedes 均为 5/5；摘要保真为 4/5；执行效率仅为 2/5。模型调用范围为 2–15 次，平均 8.8 次；Context transaction 平均 3.2 次，recall 平均 3.6 次。这说明当前模型已经具备完成元认知任务的能力，但策略收敛存在显著方差，适合用同条件多模型矩阵继续区分模型能力与 Runtime 约束。

## 8. 四模型校准结果

在同一 Runtime、fixture、Prompt、Context 预算和评分器下，每个模型运行 5 次。复核时修正了一处评分缺陷：持续约束维度只评价 Mind 中是否持久化并保护，不再要求最终回复逐字出现内部英文标识。现有轨迹重新确定性评分，无需再次调用模型：

| 模型 | 平均分 | 标准差 | 严格通过率 | 平均事务 | 平均 recall | 平均模型调用 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `gemini-3-flash-agent` | 89 | 4.90 | 40% | 2.6 | 3.4 | 5.6 |
| `deepseek-v4-pro` | 86 | 7.35 | 40% | 1.0 | 2.0 | 3.0 |
| `gpt-5.6-sol` | 83 | 24.00 | 80% | 0.8 | 2.8 | 3.8 |
| `glm-5.2` | 56 | 29.56 | 0% | 0.6 | 1.8 | 2.4 |

四个模型的 Runtime Contract 均为 15/15，差异全部来自 Agent Policy。Gemini 的语义维度最稳定，但调用偏多；DeepSeek 的调用链最稳定、最精简，失败样本主要漏报当前事实；GPT-5.6 有 4/5 完整通过，但一条 recall/事务失败轨迹拉高了方差；GLM 有 3 次响应精确停在 4096 completion token，两个运行因此未收敛。Morphz 请求没有发送 `max_tokens` 或 `max_completion_tokens`，代理也未设置该限制，因此 4096 来自模型服务默认输出预算，不是 `context_tx` 单参数上限。GLM 已成功提交 1,747 字符的事务参数，GPT-5.6 也成功提交 2,196 字符的事务参数。

随后通过通用配置 `MORPHZ_LLM_MAX_OUTPUT_TOKENS=131072`，在相同 GLM 路由、Runtime、fixture、Prompt 和评分器下重新运行 5 次。Chat Completions 请求显式发送 `max_tokens=131072`。结果由 4K 默认预算下的平均 56 分、标准差 29.56、严格通过率 0%，改善为平均 76 分、标准差 23.96、严格通过率 40%；5 次分数为 95、95、80、80、30。所有响应的 `finish_reason=length` 数量从 3 降为 0，证明输出预算是 GLM 稳定性的一个主要限制。唯一 30 分样本已经完整生成事务，但模型抄错一个很长的 recall Event ID，事务因引用不存在而原子回滚；这属于引用可用性问题，不是输出长度问题。

protocol v4 随后把模型视口中的 Event 引用统一改为由 Ledger sequence 派生的 `@eN`，并保持 Ledger transaction/state 使用完整 canonical ID。GLM 128K 的 5 次真实回归中，模型工具调用共出现 14 次短引用、0 次完整 `output_attempt_...` 引用，且没有“引用不存在”失败；成功样本落盘事务不包含 `@eN`，重启重放一致。该组分数为 80、30、30、30、15，四条失败均来自既有的 SExpr body arity 错误（`create/derive` 提供多个 BODY），不是短引用解析错误。因此短引用已解决 Event ID 抄写问题，但同时把模型对 DSL 结构遵循不稳定的问题独立暴露出来；两者必须分项评估，不能用该组总分否定引用层的有效性。

protocol v5 将 `create/derive/revise` 的内容语法改为 `BODY...`：单 BODY 保持原样，多 BODY 在解析阶段确定性规范化为 `(context-body BODY...)`；`create` 仍不接受 `from`，`derive/revise` 的来源必须紧跟 ID。Context 自描述与 `context_tx` Function Calling 描述同步公开 body arity、规范化规则、来源位置和复合示例。同条件 GLM 128K + `@eN` 的 5 次回归由 protocol v4 的平均 37 分、标准差 22.27、1/5 事务成功，改善为平均 83 分、标准差 6、5/5 事务成功；分数为 95、80、80、80、80。五条 Ledger transaction 均包含 canonical `context-body`，事务失败和 `finish_reason=length` 均为 0。持续约束、主动召回、选择性遗忘、supersedes、摘要保真和执行效率全部 5/5；剩余扣分来自最终回复的当前事实报告，不是 DSL 或 Mind 维护失败。

protocol v6 针对这一剩余失败收紧响应状态机。v5 回归中 GLM 的 Mind 和 supersedes 关系均为 5/5 正确，但 3 次把“现在提交事务，随后回复”的进度文本与 `context_tx final_reply=true` 一起返回，导致 Runtime 直接终止。v6 删除该工具参数和终止快速路径；旧客户即使仍携带该字段，Runtime 也会忽略它并继续循环。

同条件 GLM 128K 的 protocol v6 真实回归已完成 5 次：分数全部为 95/95（当前评分上限），平均 95、标准差 0、严格成功率 100%；对比 v5 的平均 83、标准差 6、严格成功率 20%。Runtime 和 Agent 的 11 项现有准则全部 5/5 通过，其中 `current_fact` 由 1/5 升至 5/5；每次均为 1 次事务提交、1 次最终回复，旧 `final_reply` 参数出现 0 次。Ledger 中真实 `runtime/model_attempt_started` 均值由 3.6 增至 4.2，即用平均 0.6 次额外模型请求换取了这次稳定性提升。

人工复核还暴露了评分器的剩余宽松点：项目代号、当前端口、安全约束和验收口令在最终正文中均为 5/5，但“新版取代旧版”只有 4/5 最终正文明确重述，旧端口数字 `8080` 只有 3/5。现有 `current_fact` 只要 Mind 有 supersedes 且最终正文包含 `9090` 就会通过，因此 v6 已证明终止状态机收敛，但 Reply Fidelity 还应继续拆分为“当前事实”、“取代关系”和“旧值报告”三项。

## 9. protocol v8 标准工具回传探针

此前 Runtime 虽然使用标准 Function Calling schema 接收调用，但工具执行后只把结果写入下一份 Context View，没有按 Chat Completions 训练约定重放原始 `assistant.tool_calls` 和匹配 `tool_call_id` 的 `role=tool` message。这会让模型看不到标准的“调用—结果”闭环，是重复 read/recall/context_tx 的潜在通用原因。

protocol v8 将当前用户回合内的工具链改为临时标准 transcript：

1. 工具结果先写入 Ledger，获得稳定 Observation ref；
2. 紧接着通过 `assistant(tool_calls) → tool(tool_call_id)` 返回；
3. 同一模型请求的 Context View 排除这批结果正文，避免重复注入；
4. 下一用户回合重新编译快照时，未 retire 的结果仍作为普通 Inbox Observation 出现；
5. 成功但无文本的工具显式返回 `status=success, output_state=empty`，而不是空字符串。

2026-07-12 使用 `gemini-3-flash-agent` 做一次真实兼容性探针：95/95，1 次 Context commit、2 次 recall、3 次模型请求、0 次事务失败。持久化 `context_inspect.messages` 确认请求包含标准 assistant/tool 配对，mini-m4 接口接受该格式。该单样本只证明协议链路可用，不用于声称效率已经改善；正式结论仍需 protocol v7/v8 的 5 次同条件配对实验。
