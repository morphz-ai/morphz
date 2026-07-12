# Morphz 元认知 Context 评测框架

> 状态：v1 已实现；目标是判断 Context 机制和 Agent 维护策略是否真实进步，而不是只验证 DSL 能否调用。

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
| 持续约束 | 15 | 安全约束进入受保护 Frame，并出现在回复中 |
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
