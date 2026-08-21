# Morphz 主流 Benchmark / Leaderboard 候选矩阵与路线图

> 状态：调研基线 v2；已加入推广热度双评分，供论文实验统筹与打榜轨道共同决策
>
> 调研日期：2026-08-17
>
> 当前约束：2026-08-27 路演优先；本阶段只做调研、选榜、协议审计与低风险适配评估，不启动大规模模型运行
>
> 未来 Pilot 默认 Runtime 基线：`paper-eval-runtime-v3` / `f875b93869282a14b738edec2f3a4069fd003600`；已有 readiness 文档和历史运行不追改
>
> 统一运行条件：`gpt-5.6-sol` / `max` / CLIProxyAPI；隔离节点使用 `full-access`；每个 arm/run 使用独立 Morphz 节点状态、数据库与 Context，且不得绕过榜单官方 sandbox 规则

## 1. 结论先行

Morphz 不应把“论文机制最匹配”“市场最热”和“最快形成官方成绩”强行合并为一个排序。三者的最优选择不同：

1. **最快官方成绩与当前最高传播热度：Terminal-Bench 2.1。** [官方新仓库](https://github.com/harbor-framework/terminal-bench-2-1)开放 custom Agent 的 Harbor job、公开 trajectory 与 leaderboard PR 提交；Kimi K3、GLM-5.3、Grok 4.5、GPT-5.6、Claude 5、Gemini 3.6 的官方材料反复采用它。Morphz 已有 Harbor adapter，因此它取代已关闭新提交的 2.0，成为路演后首跑。
2. **机制与传播的最佳交集：Agents' Last Exam，先 CLI/Linux。** ALE 允许 out-of-sandbox custom harness 保留自己的 memory、subagents 和 context management，同时被 GPT-5.6、Kimi K3、GLM-5.3 发布材料采用。它比 Terminal-Bench 更能展示长程知识工作，但 VM、许可、时间和成本更高，排在第二。
3. **ME-07 官方机制主候选仍是 STATE-Bench Agent Learning。** 它明确允许 custom Agent、记忆、技能或提示优化，并评价历史轨迹是否改善 held-out 工具行动；`mechanism fit` 最高，但当前模型发布中的曝光低于 TB2.1/ALE，因此属于论文快线，不与推广快线抢顺序。
4. **Mem2ActBench 仍是机制上最直接的研究候选，但不是成熟打榜目标。** 官方仓库缺公开榜、提交入口和完整统一 runner；结果只能称论文协议复现或适配后内部结果。
5. **ME-08 首选 LongMemEval-V2 Small。** 它有公开 memory backend、评分器和提交流程，适合动态状态、工作流知识和延迟评估；它不直接测行动，不替代 ME-07。
6. **高热度但固定 scaffold/封闭提交的榜只作市场信号。** DeepSWE、SWE-Bench Pro、AutomationBench、Artificial Analysis Coding Agent Index、GDPval-AA 和 BrowseComp 可以辅助基座模型/传播叙事选择，但不能把 Morphz 私有适配结果包装成官方排名。
7. **AppWorld MCP 与 Open Agent Leaderboard 仍是长期复用线。** 前者同时解锁 AppWorld 与 π-Bench；后者直接比较完整 Agent 和成本，但应在两个以上单榜 adapter 稳定后进入。

完整发布材料、X/社区证据和双评分见 [`mainstream_leaderboard_promotion_heat_watchlist_2026_08_17.md`](./mainstream_leaderboard_promotion_heat_watchlist_2026_08_17.md)。

因此建议采用三条并行但错峰的路线：

```text
路演前（只审计）
  ├─ Terminal-Bench 2.1 readiness delta（不跑模型）
  ├─ ALE / Toolathlon / SWE-Marathon custom system 资格确认
  ├─ STATE-Bench / LongMemEval-V2 adapter contract 设计
  └─ AppWorld MCP + π-Bench custom-runtime 官方性确认

路演后首批
  ├─ 推广快线：Terminal-Bench 2.1 正式榜
  ├─ 交集快线：Agents' Last Exam CLI pilot
  ├─ 论文快线：STATE-Bench Agent Learning pilot → ME-07 决策
  └─ 共用设施：AppWorld MCP single-task → AppWorld / π-Bench

长期
  └─ SWE-Marathon / Toolathlon / τ³-bench / Open Agent Leaderboard / TB3.0 watch
```

## 2. 判定口径

### 2.1 成绩标签

后续所有报告必须使用以下三种标签之一：

| 标签 | 含义 | 可使用的对外表述 |
| --- | --- | --- |
| `O：官方榜单` | 有公开提交说明，Morphz 所属的 custom Agent/framework 类别被允许，且结果被维护者接受或验证 | “Morphz 在 X 官方榜的成绩为……” |
| `P：官方协议结果` | 使用官方数据和评分器，但 custom runtime 未获明确提交资格，或结果尚未被维护者接受 | “使用 X 官方开源协议和评分器得到；不是官方榜单条目” |
| `I：适配后内部结果` | 缺官方 runner/提交路径，或适配改变了任务接口、环境或评分 | “适配自 X 的内部评测；不可与官方结果直接比较” |

“官方 scorer 能读取”不等于“官方榜单成绩”；本报告把这两者严格分开。

### 2.2 优先级维度

候选项先通过“官方资格”硬门槛，再用两套独立评分判断：

- `mechanism fit（1–5）`：同模型、同预算、同任务协议下，Morphz 的持久 Context、跨 Session 状态、经验迁移、长程 Objective、工具恢复或审计能否合理改变结果；
- `promotion heat（1–5）`：2026 前沿模型官方材料的重复引用占 50%，公开榜活跃度占 25%，可核验的 X/开发者社区信号占 25%。

两项分数**不得简单相加**。高热度但只允许固定 scaffold 的榜不是 Morphz 冲榜候选；机制高度匹配但没有公开提交的榜也不能产生官方成绩。详细口径与证据置信度见[推广热度 Watchlist](./mainstream_leaderboard_promotion_heat_watchlist_2026_08_17.md#1-两套评分与资格闸门)。

其余执行因素继续定性判断：

- 官方可比：是否有维护中的公开榜、明确提交协议和 custom Agent 资格；
- 复用程度：是否复用 ME-07/ME-08、Harbor、Terminal-Bench、π-Bench 或 AppWorld MCP；
- 实施风险：环境复杂度、评分器、密钥/账号、重复次数、运行成本与上游稳定性。

文中的工作量是当前代码基础上 **1 名熟悉 Morphz 的工程师的粗略人日，误差可达 ±50%**，不含排队、上游 bug、模型调用时间和正式全量运行。

### 2.3 推广增量双评分

| 候选 | mechanism fit | promotion heat | 官方资格 | 路线角色 |
| --- | ---: | ---: | --- | --- |
| Terminal-Bench 2.1 | 4.0 | **5.0** | `O` | 路演后推广首跑 |
| Agents' Last Exam | **5.0** | **5.0** | `O`，接收细节先确认 | 路演后第二个新 adapter，先 CLI/Linux |
| STATE-Bench Agent Learning | **5.0** | 2.5 | `O` | ME-07 机制快线 |
| SWE-Marathon | 4.5 | 4.5 | `P`，新版提交待确认 | 超长程长期传播项目 |
| Toolathlon Verified | 4.5 | 4.5 | `P`，custom scaffold 待确认 | 多工具长期项目 |
| PostTrainBench | 4.0 | 4.0 | `P` | 高 GPU/审计成本储备 |
| MCP-Atlas | 4.5 | 4.5 | `P/S` | 先问 custom Runtime track |
| AutomationBench | 4.0 | **5.0** | `S` | 固定 completion agent；只作市场信号 |
| Open Agent Leaderboard | 4.5 | 3.5 | `O` | 多单榜设施成熟后的综合榜 |
| π-Bench | **5.0** | 3.0 | `P` | 产品叙事线；等 custom runtime 资格 |
| τ³-bench | 4.0 | 3.5 | `O` | 第二批工具/策略补充 |

DeepSWE 与 SWE-Bench Pro 的 `promotion heat` 均为 5.0，但 `mechanism fit` 约 3.0，且主流结果多来自固定或厂商专用 scaffold，因此只作基座模型与市场叙事信号，不进入首批 Morphz 冲榜。

## 3. 候选矩阵：官方性、提交与推广价值

| 候选 | 覆盖类别 | 官方性与关注度 | 开放提交 / custom Agent | 当前可比标签 | 推广判断 |
| --- | --- | --- | --- | --- | --- |
| [Terminal-Bench 2.1](https://github.com/harbor-framework/terminal-bench-2-1) | 软件工程、终端、长程 | 当前模型发布的共同 Agent/coding 榜；89 tasks；[修复 2.0 的 28 个问题任务](https://www.tbench.ai/news/terminal-bench-2-1) | **明确支持** custom Harbor Agent；`-k 5 --upload --public` 后用 leaderboard CLI 提交公开 job，CI + maintainer review | `O` | **最高**；最快官方成绩与当前传播热度的交集 |
| [Agents' Last Exam](https://agents-last-exam.org/leaderboard) | 长程知识工作、终端/GUI、工具、状态 | 独立公开榜；GPT-5.6、Kimi K3、GLM-5.3 发布材料采用；公开 cost/runtime | **允许** out-of-sandbox custom harness 使用 memory/subagents/context management；[开源任务与 deployer](https://github.com/rdi-berkeley/agents-last-exam)；正式接收细节先确认 | `O`（接受后） | **最高**；最能同时讲完整 Runtime 与真实工作，但正式成本高 |
| [STATE-Bench Agent Learning](https://github.com/microsoft/STATE-Bench/blob/main/docs/AGENT_LEARNING_TRACK.md) | 工具行动、经验学习、记忆、状态驱动 | Microsoft 维护；[公开验证榜](https://microsoft.github.io/STATE-Bench/leaderboard/)区分 Main/Agent Learning | **明确支持** custom `BaseAgent` 和只读 `retrieve_learnings`；通过 issue 提交 | `O` | 高；最适合把论文证据和官方成绩合并，但正式成本很高 |
| [AppWorld](https://github.com/StonyBrookNLP/appworld) | 工具调用、交互式编码、长程任务 | ACL 2024 Best Resource；长期维护的官方榜和测试集 | **明确支持**自定义 Agent、MCP、terminal agent；有 `pack/make` 提交流程 | `O` | 高；系统能力证据强，并且是 π-Bench 的底层环境 |
| [π-Bench](https://github.com/Simplified-Reasoning/Pi-Bench) | 长程、跨 Session、持久 workspace、主动性 | 2026 新榜；100 个多轮任务、5 persona，报告 PROC/COMP | 默认 runner 和三次协议公开；**custom runtime 提交未文档化** | 当前 `P`；作者确认并接受后才是 `O` | 产品叙事最高；“持久 Agent”很容易对外解释 |
| [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) | 记忆、动态状态、工作流、经验检索 | 2026 新基准；451 个手工问题、Small/Medium 两个公开 tier | **明确支持**自定义 `insert/query` memory backend；[提交表单已开放](https://github.com/xiaowu0162/LongMemEval-V2#submitting-to-leaderboard) | `O` | 中高；论文价值高，但只测 memory context，不测真实后续行动 |
| [Mem2ActBench](https://aclanthology.org/2026.acl-long.370/) | 记忆、跨 Session、工具选择与参数落地 | ACL 2026 Long Paper；机制匹配极高 | [仓库](https://github.com/Cantaloupe-M/Mem2ActBench)有数据/构建流水线和 MIT License；无公开榜、提交说明或完整评测 runner | `I`，最多称论文协议复现 | 论文价值高、传播价值中低；不能作为“上榜”主标题 |
| [MemoryArena](https://memoryarena.github.io/) | 多 Session、行动—反馈—记忆—后续行动 | ICML 2026 新工作；覆盖购物、旅行、搜索、形式推理 | [代码](https://github.com/ZexueHe/MemoryArena)标为 preview；允许替换 agent/memory，但无提交说明和榜 | `I`/研究复现 | 机制价值高；工程成熟度和官方推广路径不足 |
| [MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) | 记忆、冲突、test-time learning、长程理解 | ICLR 2026；覆盖 4 个核心能力和多种 memory 方法 | 代码和评测开放；未发现公开排行榜或官方提交流程 | `I`/研究复现 | 论文补充价值中高；行动闭环弱于 STATE-Bench / Mem2Act |
| [τ³-bench](https://github.com/sierra-research/tau2-bench) | 工具调用、用户交互、策略遵循、状态写入 | 活跃主流工具 Agent 榜；airline/retail/telecom/banking knowledge | [提交规范](https://github.com/sierra-research/tau2-bench/blob/main/docs/leaderboard-submission.md)明确区分 standard/custom scaffold，PR 提交 | `O` | 很高；custom system 可见，但跨 Session/持久记忆不是核心 |
| [Toolathlon-Verified](https://toolathlon.xyz/introduction) | 多工具、长程、故障处理、复杂环境 | ICLR 2026；2026-06 发布 Verified，108 任务、32 apps、604 tools | 支持 host-side decoupled agent framework，并欢迎新 scaffold；**正式外部提交方式未明确写入 README** | 当前 `P`；维护者确认后可转 `O` | 高；成绩好讲，但运维、账号和模型成本很高 |
| [Open Agent Leaderboard](https://huggingface.co/blog/ibm-research/open-agent-leaderboard) | 通用 Agent、工具、SWE、研究、成本 | IBM Research + Hugging Face；直接比较完整 Agent 系统与成本 | **明确开放**新 Agent：封装 [Exgentic](https://github.com/IBM/exgentic)，向结果数据集提交 PR | `O` | 长期最高；当前只有少量完整 Agent，早进入有窗口，但全套运行极重 |
| [SWE-bench-Live](https://swe-bench-live.github.io/) | 软件工程、终端、动态新题 | SWE-bench 家族高关注；自动更新、多语言、多 OS | Agent/model 组合可按说明向 submissions 仓库提交 PR | `O` | 很高；但单任务代码修复不突出 Morphz 的跨 Session 机制 |

## 4. 候选矩阵：匹配度、成本、评分器、复用与工作量

| 候选 | 与 Morphz 核心匹配 | 正式规模 / 运行成本 | 评分器与复现要求 | 当前复用关系 | 预计适配工作量 |
| --- | --- | --- | --- | --- | --- |
| Terminal-Bench 2.1 | 中高：长程执行、隐藏验证、恢复；跨 Session/记忆弱 | 89 tasks × 5 repeats = 445 trials；容器和模型成本高 | Harbor 容器、任务 verifier、公开 Hub job/trajectory、leaderboard CI 和人工 review | **直接复用现有 Harbor custom agent**；需补 ATIF/public trajectory、Linux artifact、2.1 dataset 与 submission CLI | 小到中：2–5 人日；正式跑分另计 |
| Agents' Last Exam | **极高**：长程工作、跨工具、状态持续、恢复；custom harness 可保留 Morphz memory/context/subagents | 150 public tasks；CLI/GUI、许可轨道和 VM 使正式时间/成本很高 | 任务 VM + deployer + hidden references；榜展示 harness/model/cost/runtime/tokens；正式提交材料需先确认 | 新 adapter；可复用 ME-00 manifest/cost ledger、tool bridge、Objective/Event/Context 证据链 | 高：8–15 人日；先 CLI/Linux/unlicensed |
| STATE-Bench Agent Learning | **极高**：从历史轨迹形成可复用学习，影响 held-out 工具行动 | 3 domains × 50 test tasks × 5 runs = 750 episodes；另有训练轨迹处理；锁定 GPT-5.4 simulator/judge，成本很高 | 协议锁定 user/judge、`top_k=3`、只读 retrieval；提交 metrics 和全部 scored trajectories | 新 adapter；可抽象成 Morphz `retrieve_learnings`，与 ME-01/05/06 的经验迁移直接共用 | 中高：6–10 人日 |
| AppWorld | 高：多步 API、状态变更、工具失败；默认任务彼此隔离，跨 Session 弱 | test_normal/test_challenge 批量；本地 app world + 模型，成本中高 | 数据库状态和 task-specific evaluation；测试集限制严格；官方 pack/make | **AppWorld MCP 后端可同时解锁 π-Bench**；与现有 π bridge 共用工具面 | 中高：5–8 人日 |
| π-Bench | **极高**：5 persona、跨 task Session、持久 workspace、隐藏意图、交付物 | 100 tasks × 3 runs = 300 task trials；还需 user/judge/search，成本很高 | PROC 为隐藏意图 judge，COMP 为 checklist/artifact；Docker + AppWorld + 三次重复 | **现有 Session/Principal/trace bridge 已完成**；主要缺受管 AppWorld MCP | AppWorld MCP 完成后 2–4 人日；否则 7–12 人日 |
| LongMemEval-V2 | 高：动态状态、工作流、环境陷阱、长期经验；行动闭环弱 | 451 questions；Small 可控，Medium 数据/推理更重；固定 reader、embedding 和 judge | 公开 harness、LAFS accuracy-latency frontier、submission package；query 看不到 gold metadata | 新 `insert/query` backend；可与 STATE-Bench 共用“外部轨迹→Context→预算化检索”层 | 中：3–6 人日 |
| Mem2ActBench | **极高**：记忆决定工具和参数，含冲突/跨轮聚合 | 400 tool-use tasks，原始 2,029 sessions；模型成本中等 | 数据给 target tool/schema；官方 repo 缺统一 runner、结果表与提交校验，需先冻结复现协议 | 对应当前 ME-07；不能直接复用 Harbor/π，但可复用 Principal/Session/Context 映射 | 中：4–8 人日，主要风险是评分协议而非代码 |
| MemoryArena | **极高**：前序 action/feedback 经 memory 影响后续 session | 5 个环境族；web/travel/search/formal 环境和多 API key，成本中高 | preview gym；各环境 reward/answer 不同；需固定环境版本和 memory policy | 可复用 ME-06 多 Session 与 LongMem/STATE memory facade；无现成 adapter | 高：8–15 人日 |
| MemoryAgentBench | 高：AR/TTL/LRU/conflict；动作闭环和真实工具弱 | 多数据集、多方法；部分需 GPT-4o/judge，成本中等到高 | exact/substr match、Recall@5 和 LLM judge 混合；依赖版本较多 | 对应 ME-08 候选；可复用 LongMem memory facade | 中：4–8 人日 |
| τ³-bench | 中高：多轮工具、策略、DB 状态；跨 Session 弱 | 多领域，每任务正式 4 trials，另有 user simulator；全量成本高 | DB/action/communication/NL evaluator；版本变更会影响可比性，必须 pin ≥1.0.1 | 可复用通用 tool/provider 接口；与 π/AppWorld 工具 schema 不同 | 中高：5–9 人日 |
| Toolathlon-Verified | 高：平均约 20 turns、复杂工具链、故障与长历史 | 108 tasks，单任务上限 5,400 秒，榜单报告三次统计；部署和调用成本极高 | 每任务专用执行评分器；需 Linux、Docker/Podman、账号/secret、32 app 环境 | 可借鉴 AppWorld MCP 与 Runtime 长程调度；不能直接复用 Harbor task schema | 高：12–20 人日 |
| Open Agent Leaderboard | 高但分散：完整系统、记忆、规划、工具、恢复与成本 | 6 workloads，包含 SWE、BrowseComp+、AppWorld、τ-bench；总成本极高 | Exgentic 统一 task/context/action；标准化 trajectory 和 cost report | 最终可复用 AppWorld、τ、SWE 等单榜 adapter；现阶段不应另起炉灶 | 很高：15–30 人日，且依赖前置 adapter |
| SWE-bench-Live | 中：长程代码修复、容器和测试；持久主体/跨 Session 弱 | 动态 split，全量容器和模型成本高 | 官方 repo tests、trajectory archive、结果 PR；需严格版本和有效 instance 清单 | Harbor 可提供部分容器/agent 经验，但需要新的 SWE problem adapter | 中高：6–10 人日 |

## 5. 推荐优先级

### 5.1 2026-08-27 前：只做低风险工作

这些工作不调用正式评测模型，也不占用路演 Demo 的关键实现资源：

1. **冻结候选版本、热度证据和官方性证据。** 记录 Terminal-Bench 2.1 dataset/commit、STATE-Bench、ALE、LongMemEval-V2、AppWorld、π-Bench 的版本与 submission URL；每周更新一次七组模型的官方引用，不追逐日内社交噪声。
2. **Terminal-Bench 2.1 readiness delta。** 复用已完成的 TB2.0 审计，对照当前 `MorphzAgent` 与最新 Harbor `BaseAgent`，新增 2.1 dataset slug、public Hub job、leaderboard CLI/PR、ATIF/public trajectory、Linux binary、secret、timeout/resource 和 5-repeat 差距；不跑正式 trial。
3. **定义一个只存在于设计文档中的 memory adapter contract。** 至少覆盖：
   - `insert_trajectory(principal, session, timestamp, artifact)`；
   - `query_memory(question, token_budget)`；
   - `retrieve_learnings(query, top_k=3)`；
   - 输出来源、版本、延迟、token 和 Context/Event 因果引用。
   该 contract 同时服务 LongMemEval-V2、STATE-Bench 和后续 MemoryArena，避免三个一次性 adapter。
4. **完成 AppWorld MCP 依赖清单。** 只审计 MCP server/client、工具权限、Principal 绑定、任务世界重置、secret、trace 和 exactly-once 边界，不实现全功能后端。
5. **准备但不代发六组主办方确认邮件。** 问题只包括：
   - ALE 是否接受 Morphz out-of-sandbox custom harness，CLI/Linux/unlicensed 的正式提交材料与复测方式；
   - SWE-Marathon v1.1 是否接受 custom Harbor harness，以及如何披露 tokens/reward-hacking audit；
   - Toolathlon 是否接受 decoupled custom scaffold 的正式榜单提交；
   - π-Bench 是否接受替换 NanoBot 的 custom persistent runtime，以及如何在 leaderboard 标注 agent/model；
   - MCP-Atlas 是否计划 custom Runtime/scaffold 分组；
   - Mem2ActBench 是否有未公开的固定 evaluator、baseline output schema 或提交计划。
6. **冻结披露模板。** 所有未来结果必须记录 benchmark commit、Morphz commit、模型精确版本、Provider、预算、重复次数、失败轨迹、成本和成绩标签 `O/P/I`。

路演前明确不做：Terminal-Bench 445-trial 全量、ALE VM/任务运行、STATE-Bench 750-episode 正式运行、π-Bench 300-trial 全量、Toolathlon/PostTrainBench 部署、Open Agent Leaderboard 全套适配。

### 5.2 路演后首批正式冲榜

#### 第一批 A：Terminal-Bench 2.1（推广快线）

1. 在 Linux + Docker 环境完成 1 个公开 task smoke；
2. 完成一个不进入正式统计的 3–5 task adapter pilot；
3. 固定 Morphz/model/provider/Harbor/TB2.1 commit、ATIF/public trajectory 和成本上限；
4. 执行官方 89 × 5 协议；
5. 使用 `--upload --public` 上传 Harbor Hub job，并通过官方 leaderboard CLI 创建 PR；
6. 等待 CI、trajectory 审查与维护者合并；此前只标记 `submitted-unverified`；
7. 同模型补一个 Harbor 基线 Agent 对照，用于解释 Runtime 增益，但不要混入官方分数。

它是最短官方成绩路径，但论文中只能作为系统案例或附录证据，不能替代 ME-07。TB2.0 readiness 审计保留为 adapter/ATIF 风险依据；其提交关闭状态不再阻塞 2.1 路线。

#### 第一批 B：Agents' Last Exam CLI（机制 × 推广快线）

1. 先向主办方确认 Morphz custom out-of-sandbox harness 的榜单接收、命名、公开 artifact 与复测要求；
2. 只做 Linux/CLI/unlicensed 小样，暂不建设 Windows GUI 或采购付费软件；
3. 验证 deployer、任务状态、tool bridge、长程 Objective、超时恢复、trajectory/cost ledger 和 hidden-reference 隔离；
4. 只有 adapter failure、单任务成本、VM 磁盘和正式接收资格都通过，才批准全量预算。

ALE 能比 TB2.1 更直接展示完整 Runtime；但成本和适配风险更高，所以排在 TB2.1 之后。

#### 第一批 C：STATE-Bench Agent Learning（论文快线）

1. 先用一个领域、少量 held-out task 验证 `retrieve_learnings`、Context 隔离和 scorer；
2. 做同模型 `no-learning` 与 `Morphz learning` pilot；
3. 只有在 adapter failure 接近 0、成本可控且出现可解释差异后，才运行 3 领域 × 50 × 5；
4. 将官方 metrics 与 Morphz Event/Context 因果分析同时进入 ME-07 报告。

若只允许选一个论文机制官方榜，优先选 STATE-Bench Agent Learning；若目标是当前传播和最快官方成绩，则选 Terminal-Bench 2.1。两者不再用同一个序号竞争。

#### 第一批 D：AppWorld MCP → AppWorld → π-Bench（共用设施线）

1. 实现通用受管 AppWorld MCP，不加入 π-Bench-specific 业务规则；
2. 先跑 AppWorld 单任务和小批量，验证 state-based scorer 与 tool trace；
3. 再接现有 π bridge 跑 single task、single persona；
4. 只有作者确认 custom runtime 提交资格后，才把 π-Bench 三次全量列为正式冲榜；否则保留为 `P` 级官方协议结果。

### 5.3 第二批与长期储备

| 阶段 | 候选 | 进入条件 |
| --- | --- | --- |
| 第二批 | LongMemEval-V2 Small | 通用 memory adapter contract 已稳定；固定 reader/judge；先证明 latency 不把准确率收益抵消 |
| 第二批 | τ³-bench custom submission | 通用工具桥稳定；选定最新可比版本；当前 evaluator 已知问题得到上游处理或在报告中拆分 action/DB/NL 指标 |
| 第二批 | π-Bench 三次全量 | AppWorld MCP、single persona 和 custom runtime 官方资格三者全部通过 |
| 长期 | SWE-Marathon v1.1 | 维护者确认 custom Harbor harness、榜版本和 token/reward-hacking 披露；单独批准超长程预算 |
| 长期 | Toolathlon-Verified | 有独立 Linux/Docker/账号运维资源；维护者确认 custom scaffold 排名规则 |
| 长期 | PostTrainBench | 有独立 GPU 与污染/模型身份审计预算；主办方确认 custom Agent 提交协议 |
| 长期 | Open Agent Leaderboard | AppWorld、τ/SWE 等至少两个单榜 adapter 已稳定，且有全套预算与统一 cost ledger |
| 长期 | SWE-bench-Live | 需要通用 SWE 推广证据，且不会挤占更匹配的记忆/状态榜 |
| Watch | Terminal-Bench 3.0 / Frontier-Bench | 官方公开 dataset、scorer、排行榜和 custom Agent submission contract 全部发布 |
| 市场信号 | DeepSWE / AutomationBench / MCP-Atlas | 维护者新增并明确接受 custom Agent/system 分组；否则不把 Morphz 私跑称作官方榜结果 |
| 研究储备 | MemoryArena / MemoryAgentBench | ME-07/08 仍有未覆盖的机制问题，或作者开放正式榜/提交 |

## 6. 对 ME-07 / ME-08 的建议

### 6.1 ME-07

当前 [`master_plan_v1.md`](./master_plan_v1.md) 把 Mem2ActBench 设为首选，这一判断在**机制匹配**上仍成立，但不能同时满足“官方排行榜成绩”的推广目标。

建议在不立即改写总计划的前提下增加一个决策门：

```text
Mem2ActBench evaluator / submission 审计
  ├─ 作者提供固定 evaluator + custom system 可比口径
  │    └─ 保留为 ME-07 主实验
  └─ 无官方口径
       ├─ Mem2ActBench 降为 ME-07 机制复现（I）
       └─ STATE-Bench Agent Learning 升为 ME-07 官方外部验证（O）
```

如果论文资源允许两个结果，最佳组合是：

- Mem2ActBench：回答“记忆是否真正进入工具选择与参数落地”；
- STATE-Bench Agent Learning：回答“同一 Agent 是否从过去轨迹学习，并在 held-out 真实工具任务上形成官方可比增益”。

### 6.2 ME-08

建议把 ME-08 的首选顺序调整为：

1. **LongMemEval-V2 Small**：官方提交已开放，backend contract 清晰，适合验证动态状态、工作流和环境 gotcha；
2. **MemoryArena**：行动闭环更强，但代码仍为 preview，工程和官方性风险高；
3. **MemoryAgentBench**：适合 conflict resolution/test-time learning 的能力分解，但没有成熟官方榜。

Harbor/Terminal-Bench 与 π-Bench 继续作为通用 Agent 能力和系统案例，不替代 ME-07/08 的认知机制证据。AppWorld 可以作为两者之间的基础工具环境和正式系统榜。

## 7. 现有 adapter 复用图

```text
benchmarks/harbor/morphz_agent.py
  ├─ Terminal-Bench 2.1 official custom-agent path
  │    └─ 后续可复用 Harbor dataset / artifact / verifier / public job 经验
  └─ SWE-Marathon custom harness（主办方确认后）

ALE deployer（待实现）
  └─ Morphz out-of-sandbox harness
       ├─ CLI/Linux/unlicensed 首批
       └─ GUI/licensed 长期储备

AppWorld managed MCP（待实现）
  ├─ AppWorld official agent submission
  └─ benchmarks/pi_bench/morphz_bridge.py
       └─ π-Bench persona → Principal / shared Context
          task → Session / persistent workspace / official trace

通用 memory adapter contract（待设计）
  ├─ LongMemEval-V2 insert/query
  ├─ STATE-Bench retrieve_learnings(top_k=3)
  └─ MemoryArena / MemoryAgentBench research adapters

Exgentic wrapper（长期）
  └─ Open Agent Leaderboard
       ├─ SWE-Bench
       ├─ BrowseComp+
       ├─ AppWorld（复用）
       └─ τ-bench（复用）
```

## 8. 明确降级或暂不参加的候选

| 候选 | 当前结论 |
| --- | --- |
| Terminal-Bench 2.0 新提交 | [旧榜提交已关闭](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard)；readiness 审计仅保留为 Harbor/ATIF 风险依据。正式路线已转向 2.1。 |
| DeepSWE / SWE-Bench Pro / AutomationBench | 当前市场热度高，但公开结果主要比较模型或固定 scaffold。除非维护者开放 custom system 分组，只作基座模型和传播叙事信号。 |
| Recovery-Bench | 2025 论文可查，但截至本次调研未找到成熟官方仓库、公开榜和提交协议；从 2026-07 商业策略中的 P0 降为 watchlist。未来若正式发布，可复用 Harbor。 |
| ContinuityBench | 与 Morphz 恢复机制高度匹配，但目前主要是覆盖 τ-bench/AppWorld/Terminal-Bench 的研究 overlay；未找到成熟公开提交榜。适合作为合作/论文扩展，不作为近期“官方上榜”。 |
| BFCL V4 | UC Berkeley 官方模型/function-calling 榜很有影响力，但主要比较模型原生/提示式函数调用，不适合把 Runtime 增益归因给 Morphz。只用于 Provider/tool-call contract 回归，不投入正式打榜。 |
| OSWorld | 高关注，但 GUI perception、定位和桌面环境噪声会掩盖 Morphz 的 Context/恢复优势；等 Edge GUI 稳定后再评估。 |
| AgencyBench | ACL 2026、138 tasks，平均约 90 tool calls、1M tokens 和数小时/任务；长程价值高但运行极重，且当前未确认开放 custom Agent 榜。 |
| HORIZON | 适合诊断“随 intrinsic horizon 增长何处崩溃”，但当前榜规模小、提交成熟度低；可借失败分类，不作为推广主榜。 |

## 9. 正式运行前的统一 Go / No-Go 门槛

任一候选只有同时满足下列条件，才允许从调研转入正式全量：

1. `O/P/I` 标签已冻结，custom Agent 资格没有歧义；
2. benchmark commit/version、数据 split、scorer 和排除规则已固定；
3. adapter smoke 中没有 task routing、工具映射、终态等待、trace 或身份隔离错误；
4. 同模型 baseline 与 Morphz 的工具、时间、token 和费用预算可解释；
5. 每个 run 能记录 Morphz commit、配置、Provider/model 精确 ID、原始 trajectory、Context/Event 因果和成本；
6. 能从原始产物重新评分得到相同结果；
7. 正式重复数符合官方协议，不能只选最好的一次；
8. 全量费用和机器时间得到单独批准，不默认由路演预算承担；
9. 报告模板已经准备好同时公开成功与失败轨迹；
10. 不含 benchmark-specific hardcode、测试答案、泄漏的 evaluator metadata 或对原始任务语义的静默修改。

## 10. 推荐的对外表述边界

- `O` 示例：“Morphz + 同一模型在 Terminal-Bench 2.1 官方榜取得 X；公开 Harbor job 为 Y，协议为 89 tasks × 5 repeats，leaderboard PR 已由维护者合并。”
- `P` 示例：“我们使用 π-Bench 开源数据与官方 scorer，对 custom Morphz runtime 做了三次评测；该结果尚不是 π-Bench 官方排行榜条目。”
- `I` 示例：“这是适配 Mem2ActBench 数据得到的内部结果；适配、评分规则和不可直接比较的部分已公开。”

在没有同模型 baseline、重复运行、成本和失败轨迹前，不使用“Runtime 提升”“行业领先”“榜单前列”等归因性标题。

## 11. 主要官方来源

- [Terminal-Bench 2.1 official repository and submission workflow](https://github.com/harbor-framework/terminal-bench-2-1)
- [Terminal-Bench 2.1 release notes](https://www.tbench.ai/news/terminal-bench-2-1)
- [Agents' Last Exam leaderboard](https://agents-last-exam.org/leaderboard)
- [Agents' Last Exam repository](https://github.com/rdi-berkeley/agents-last-exam)
- [Mainstream leaderboard promotion heat watchlist](./mainstream_leaderboard_promotion_heat_watchlist_2026_08_17.md)
- [STATE-Bench Agent Learning Track](https://github.com/microsoft/STATE-Bench/blob/main/docs/AGENT_LEARNING_TRACK.md)
- [STATE-Bench leaderboard](https://microsoft.github.io/STATE-Bench/leaderboard/)
- [AppWorld repository and leaderboard workflow](https://github.com/StonyBrookNLP/appworld)
- [π-Bench official repository](https://github.com/Simplified-Reasoning/Pi-Bench)
- [LongMemEval-V2 official repository and submission](https://github.com/xiaowu0162/LongMemEval-V2)
- [Mem2ActBench, ACL 2026](https://aclanthology.org/2026.acl-long.370/)
- [MemoryArena project](https://memoryarena.github.io/)
- [MemoryAgentBench repository](https://github.com/HUST-AI-HYZ/MemoryAgentBench)
- [τ³-bench repository](https://github.com/sierra-research/tau2-bench)
- [τ³-bench leaderboard submission rules](https://github.com/sierra-research/tau2-bench/blob/main/docs/leaderboard-submission.md)
- [Toolathlon-Verified](https://toolathlon.xyz/introduction)
- [Open Agent Leaderboard](https://huggingface.co/blog/ibm-research/open-agent-leaderboard)
- [SWE-bench-Live](https://swe-bench-live.github.io/)
