# Morphz 主流榜单与市场热度 Watchlist

> 未来 Pilot 默认 Runtime 基线：`paper-eval-runtime-v3` / `f875b93869282a14b738edec2f3a4069fd003600`；本文件中的既有调研证据日期不因基线迁移而改变

> 调研日期：2026-08-17
>
> 状态：推广导向调研与路线建议；未安装大型环境、未下载数据、未运行模型、未修改 Morphz Runtime
>
> 约束：2026-08-27 路演优先。路演前只做协议、提交资格、版本和适配就绪审计

## 0. 结论先行

当前最值得 Morphz 投入的不是“所有新模型都报过的榜”，而是同时满足以下三点的榜：前沿模型发布反复引用、允许比较完整 Agent/system harness、Morphz Runtime 有合理增益空间。

推荐顺序分为两条目的不同的队列：

1. **推广快线：Terminal-Bench 2.1。** 2026 年 Kimi K3、GLM-5.3、Grok 4.5、GPT-5.6、Claude 5、Gemini 3.6 的官方材料均直接报告或讨论它；官方仓库已开放 custom Agent 的 Harbor job 提交和排行榜 PR。Morphz 可直接复用现有 Harbor adapter，是路演后形成官方可比成绩的最短路径。
2. **机制与推广交集：Agents' Last Exam（ALE），先做 CLI/Linux track。** 它测长程、跨工具、经济价值较高的真实工作，并明确允许 out-of-sandbox custom harness 保留自己的 memory、subagent 和 context management。它同时出现在 GPT-5.6、Kimi K3、GLM-5.3 发布材料中，比纯记忆榜更有市场传播力，但环境、成本与正式提交协调显著更重。
3. **论文机制线：STATE-Bench Agent Learning。** 它仍是 ME-07 最清晰的官方机制证据，但在本轮前沿模型发布中的曝光明显低于 Terminal-Bench、DeepSWE、ALE，因此 `mechanism fit` 高、`promotion heat` 中低，不能因学术匹配高就自动排在推广快线前。
4. **高热度、先联系再适配：SWE-Marathon、Toolathlon Verified、PostTrainBench、MCP-Atlas。** 这些榜与 Morphz 的长程、工具、恢复、状态能力有交集，但 custom system 的公开提交边界、基础设施成本或可比协议尚不如 Terminal-Bench 2.1 明确。
5. **只作为市场信号，不作为 Morphz 首批冲榜：DeepSWE、SWE-Bench Pro、AutomationBench、Artificial Analysis Coding Agent Index、GDPval-AA、BrowseComp。** 它们很热，但其中多项固定 scaffold、由维护者统一运行、只接模型 endpoint，或没有 custom Runtime 的公开提交通道。Morphz 私下适配得到的数字不得包装成官方成绩。

本轮官方材料也纠正两项型号假设：截至 2026-08-17，未找到 xAI 的 **Grok 4.6** 官方发布，最新可核验发布为 **Grok 4.5**；未找到 Google 的 **Gemini 3.7** 官方发布或模型卡，最新可核验对应产品为 **Gemini 3.6 Flash**。后续 watchlist 以官方可核验型号为准。

## 1. 两套评分与资格闸门

两项分数都采用 1–5 分，但用途不同，禁止相加后机械排序。

### 1.1 `mechanism fit`

衡量在**模型、预算和任务协议不变**时，Morphz 的持久 Context、跨 Session 状态、经验迁移、长程 Objective、工具恢复和审计能力能否合理改变结果。

| 分数 | 判定 |
| --- | --- |
| 5 | 直接允许 custom Agent/harness；任务依赖长期状态、经验、恢复或持续行动 |
| 4 | 完整 system 能影响结果，但跨 Session/记忆不是评分核心 |
| 3 | 主要测 coding/tool model；Runtime 只能通过常规 scaffold 带来部分增益 |
| 2 | 大部分由固定 scaffold 或单轮模型能力决定 |
| 1 | 静态知识、数学 QA 或封闭模型评测，Morphz 无合理机制增益 |

### 1.2 `promotion heat`

热度不是社交平台单点点赞数，而是以下证据的组合：

- 50%：2026 前沿模型官方发布、技术报告或模型卡的重复引用；
- 25%：独立公开榜是否活跃、近期更新、是否展示 agent/model/cost；
- 25%：X/开发者社区是否出现可核验的重复讨论或平台 trend 页面。

| 分数 | 判定 |
| --- | --- |
| 5 | 多家前沿实验室在当前发布材料中反复采用，并有活跃榜或持续社区讨论 |
| 4 | 至少三组当前发布采用，或新榜增长快且叙事清晰 |
| 3 | 社区/学术圈稳定可见，但不是当前模型发布的共同语言 |
| 2 | 领域内新榜，尚未形成跨实验室传播 |
| 1 | 缺乏当前发布与社区采用证据 |

X 的直接检索本轮受认证限制，热度分以官方发布材料和公开榜活跃度为主；只有可公开索引的 X 页面作为辅助。因此 X 证据不足不会被伪装成“没有讨论”，相应条目标注中等置信度。

### 1.3 官方资格是独立硬门槛

| 标签 | 含义 |
| --- | --- |
| `O` | custom Agent/system 被允许，按公开流程提交并经主办方接受后可称官方榜成绩 |
| `P` | 可按官方数据/评分器运行，但 custom Runtime 榜单资格或接受流程仍需确认 |
| `I` | 适配改变了协议，或没有官方 custom system 路径；只能称内部结果 |
| `S` | 仅作为市场/基座模型选择信号；不建议投入 Morphz 冲榜 |

高热度不能绕过资格闸门。特别是“官方 scorer 可运行”不等于“官方 leaderboard 可提交 custom Runtime”。

## 2. 前沿模型发布材料核验

| 模型 | 官方状态与材料 | 当前发布反复采用的 Agent/coding 榜 | 对 Morphz 选榜的含义 |
| --- | --- | --- | --- |
| Kimi K3 | [官方模型卡](https://huggingface.co/moonshotai/Kimi-K3)、[官方博客](https://www.kimi.com/blog/kimi-k3)；1M context、长程 Agent 取向 | Terminal-Bench 2.1、DeepSWE、ProgramBench、FrontierSWE、SWE-Marathon、PostTrainBench、MCP-Atlas、AutomationBench、ALE | 是当前榜单扩展最广的发布之一；但表格混用 Kimi Code、Codex、Claude Code 等 harness，不能把所有数字当纯模型横比 |
| GLM-5.3 | [Z.ai 官方发布](https://z.ai/blog/glm-5.3)，2026-08-14；重点是 post-training 后的 coding/agent 增益 | Terminal-Bench 2.1/3.0、DeepSWE 1.1、NL2Repo、ProgramBench、FrontierSWE、SWE-Marathon、PostTrainBench、Toolathlon Verified、AutomationBench、ALE-CLI | 对“上周社区在看什么”最有价值；脚注显示多项采用 Claude Code 2.1.207、不同小时/turn 限制，harness/version 必须随成绩披露 |
| Grok 4.5 | [xAI 官方发布](https://x.ai/news/grok-4-5)，2026-07-16；官方定位 coding、agentic tasks、knowledge work | DeepSWE、SWE-Marathon、Terminal-Bench 2.1、SWE-Bench Pro | 进一步确认 Terminal-Bench 2.1 和长程 SWE 是发布叙事主线；截至本次调研未核验到 Grok 4.6 官方发布 |
| DeepSeek V4 Pro / Flash | [Preview 官方说明](https://api-docs.deepseek.com/news/news260424/)、[GA 官方说明](https://api-docs.deepseek.com/news/news260813/)、[官方技术报告](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/blob/main/DeepSeek_V4.pdf) | 官方 Preview 报告包含 Terminal-Bench 2.0、SWE-bench Verified、MCP-Atlas、Toolathlon；GA 强调 Claude Code/OpenClaw/OpenCode/Codex 接入 | 官方叙事明确偏 agentic coding；GLM-5.3 表中的 V4 Pro-0813 数字属于 Z.ai 复测，不能改写成 DeepSeek 官方自报成绩 |
| GPT-5.6 | [OpenAI 官方发布](https://openai.com/index/gpt-5-6/) | ALE、Artificial Analysis Coding Agent Index、SWE-Bench Pro、DeepSWE、Terminal-Bench 2.1、BrowseComp、OSWorld 2.0、AutomationBench、Toolathlon、PostTrainBench Lite、GDPval | ALE 与 TB2.1 同时覆盖“完整工作流”与“终端工程”；Ultra/多 Agent 设置必须按 system 结果披露，不能只写模型名 |
| Claude 5 | [Fable 5 / Mythos 5 官方发布](https://www.anthropic.com/news/claude-fable-5-mythos-5)、[Sonnet 5 官方发布](https://www.anthropic.com/news/claude-sonnet-5)、[Sonnet 5 System Card](https://www-cdn.anthropic.com/73ad94ca3c0502e75e46637cc62c8bd9532a7f2c/Claude%20Sonnet%205%20System%20Card.pdf) | Terminal-Bench 2.1、OSWorld-Verified、SWE-bench 系列、BrowseComp；发布叙事强调长时间自主任务 | Claude Code 本身常是其他模型的 harness；Morphz 对比必须拆开“模型”与“Agent scaffold”两个变量 |
| Gemini 3.6 Flash | [Google 官方发布](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-6-flash-3-5-flash-lite-3-5-flash-cyber/)、[官方模型卡](https://deepmind.google/models/model-cards/gemini-3-6-flash/) | Terminal-Bench 2.1、DeepSWE、SWE-Bench Pro、MLE-Bench、GDPval-AA、OSWorld Verified | 再次确认 TB2.1/DeepSWE/OSWorld 的发布共同语言；[模型卡目录](https://deepmind.google/models/model-cards/)截至本次调研未列 Gemini 3.7 |

### 2.1 共同信号

按“由模型方自己的官方材料采用”统计，而不是从竞争对手表格倒推：

- **Terminal-Bench 2.1：约 6/7 组可核验发布采用，最强共同信号。** DeepSeek 自身当前公开技术报告仍主要报告 TB2.0；不能用 Z.ai 的 V4 TB2.1 复测补成 7/7。
- **DeepSWE / SWE-Bench Pro：约 5/7 组，热度极高。** 但它们更常比较模型或固定 coding scaffold，不天然等于开放的完整 Runtime 榜。
- **ALE、AutomationBench、Toolathlon、PostTrainBench、SWE-Marathon、MCP-Atlas：约 3–4/7 组。** 这些是下一层快速上升的 Agent 榜，值得优先做提交资格审计。
- **OSWorld：多家发布持续采用。** 传播热度高，但 GUI/CUA 环境噪声和现有 Morphz 适配成本更高，暂列长期储备。

## 3. 当前热度 Watchlist

| 排位 | Benchmark | 机制适配 | 推广热度 | 资格 | System/harness 边界 | 适配与正式成本 | 当前动作 |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| 1 | [Terminal-Bench 2.1](https://github.com/harbor-framework/terminal-bench-2-1) | 4.0 | **5.0** | `O` | 明确允许 custom Harbor Agent；榜单展示 agent+model，公开 job/trajectory | **低到中**：现有 Harbor adapter 高复用；补 ATIF、Linux、公开 job 合规；正式 89×5 成本高 | 路演后第一跑；路演前只冻结版本/命令/ATIF gap |
| 2 | [Agents' Last Exam](https://agents-last-exam.org/leaderboard) | **5.0** | **5.0** | `O`，正式接收细节需预确认 | out-of-sandbox harness 可保留 memory、subagents、context management；CLI/GUI 分轨 | **高**：VM、软件许可、长运行；先 CLI/Linux/unlicensed pilot | 路演后第二个新 adapter；先向主办方确认 custom harness 上榜流程 |
| 3 | [STATE-Bench Agent Learning](https://github.com/microsoft/STATE-Bench/blob/main/docs/AGENT_LEARNING_TRACK.md) | **5.0** | 2.5 | `O` | 明确 custom Agent/learning retrieval；锁定 simulator/judge 和 `top_k=3` | **中高**：6–10 人日，750 episodes，Azure GPT-5.4 eval 凭据 | ME-07 论文快线；与推广快线并行但不抢先 |
| 4 | [SWE-Marathon](https://www.swe-marathon.org/) | 4.5 | 4.5 | `P` | Harbor 支持 custom model/harness；新版榜提交仍需维护者确认 | **极高运行费**：20 个超长任务，公开报告均值约 31M tokens/trial；reward hacking 风险高 | 先联系；预算和 v1.1 榜开放后再排期 |
| 5 | [Toolathlon Verified](https://toolathlon.xyz/introduction) | 4.5 | 4.5 | `P` | 官方服务可测 endpoint，默认 Agents SDK；欢迎其他 scaffold，但正式 custom scaffold 入榜未写清 | **高**：32 apps、账号/secret、长工具链，约 12–20 人日 | 先取得书面提交资格；不预部署 |
| 6 | [PostTrainBench](https://posttrainbench.com/) | 4.0 | 4.0 | `P` | Agent 自主完成 post-training；CLI scaffold 会影响结果 | **极高**：GPU、4 base models、长时间；污染/API/模型身份审计严格 | 长期论文/推广联合实验；先索取提交协议 |
| 7 | [MCP-Atlas](https://github.com/scaleapi/mcp-atlas) | 4.5 | 4.5 | `P`/`S` | public tasks 可接 endpoint；公开榜未明确接受外部 custom Runtime | **中高**：多 MCP server、最多 100 tool calls、LLM judge | 联系 Scale；只有 custom harness 被单列后才冲榜 |
| 8 | [Terminal-Bench 3.0 / Frontier-Bench](https://github.com/harbor-framework/frontier-bench) | 4.5 | 4.0 | `P`/watch | GLM-5.3 已发布结果；官方仍处任务贡献/早期协议阶段 | 未知，预计高于 TB2.1 | 只跟踪，不跑；等待公开 dataset、榜和 submission contract |
| 9 | [AutomationBench](https://github.com/zapier/AutomationBench) | 4.0 | **5.0** | `S` | 600 tasks/47 模拟 SaaS；官方私榜主要面向模型提供方、内置 completion agent | 中；但 Morphz custom run 官方性不足 | 用作工具模型选择信号；向 Zapier询问 custom system track |
| 10 | [OSWorld](https://os-world.github.io/) | 3.5 | **5.0** | `O`/需重审最新规则 | 完整 CUA system 可影响结果；GUI 状态和环境版本噪声大 | **很高**：桌面 VM、视觉链路、重试与环境维护 | 长期储备，不抢 Terminal/STATE/ALE |
| 11 | [Open Agent Leaderboard](https://huggingface.co/blog/ibm-research/open-agent-leaderboard) | 4.5 | 3.5 | `O` | Exgentic 直接比较完整 Agent 和 cost | **很高**：多 benchmark 套件，15–30 人日且正式费高 | 单榜 adapter 稳定后进入；不另起一次性实现 |
| 12 | [π-Bench](https://github.com/Simplified-Reasoning/Pi-Bench) | **5.0** | 3.0 | `P` | persistent runtime 叙事高度匹配；custom runtime 外部提交未公开 | AppWorld MCP 后约 2–4 人日，否则 7–12 人日 | 保留产品叙事线；等待作者确认 |
| 13 | [τ³-bench](https://github.com/sierra-research/tau2-bench) | 4.0 | 3.5 | `O` | 明确区分 standard/custom scaffold | 中高，5–9 人日，user simulator 与多领域正式费高 | 第二批；作为工具/策略通用能力补充 |

### 3.1 高热度但不建议冲榜的信号榜

| Benchmark | 热度 | 不作为首批 Morphz 榜的原因 |
| --- | ---: | --- |
| [DeepSWE 1.1](https://deepswe.datacurve.ai/) | 5.0 | [官方仓库](https://github.com/datacurve-ai/deep-swe)的榜分数采用 Pier + mini-swe-agent/Modal 固定路径，主要比较模型；自换 Morphz harness 不属于同一官方可比轨道，除非维护者新增 custom system track |
| SWE-Bench Pro | 5.0 | 多家模型发布采用，但常由固定 scaffold 或第三方统一评测；当前不应把 Morphz 私跑包装成模型榜官方成绩 |
| [Artificial Analysis Coding Agent Index](https://artificialanalysis.ai/) / GDPval-AA | 5.0 | 高传播、维护者统一运行，但不是开放的 Morphz custom Runtime 提交流程；适合做模型/成本市场定位 |
| BrowseComp | 5.0 | 主要测试检索与模型能力；公开发布常使用厂商专用工具/harness，跨系统可比风险高 |

## 4. 推荐打榜顺序

### 4.1 2026-08-27 前：零模型调用的低风险工作包

1. **Terminal-Bench 2.1 readiness delta。** 在现有 TB2.0 readiness 审计后追加 2.1 dataset slug、open submission 命令、公开 Harbor Hub job、leaderboard CLI/PR、ATIF validator 与 89×5 协议差异；不安装、不跑 task。
2. **冻结市场证据快照。** 每周只更新一次七组模型官方材料、榜单版本、submission URL 和热度分；避免每天追逐社交噪声。
3. **发出三组资格确认草稿，不代发。** ALE custom out-of-sandbox harness、Toolathlon custom scaffold、SWE-Marathon v1.1 custom harness 的榜单接收/披露要求。
4. **ME-00 增加通用 `agent_system_manifest` 设计。** 字段包括模型、provider、agent/harness、subagents、工具、context limit、turn/time budget、硬件、并发、网络、重复数、成本、benchmark/scorer commit、trajectory 可见性和官方状态。
5. **不新增 Runtime 功能。** 不为某榜改 Context/Session 行为，不下载大型镜像，不跑模型，不建设 GUI 环境。

### 4.2 路演后第一批

#### 1. Terminal-Bench 2.1：最快官方成绩

官方仓库给出的新提交流程是：

```bash
harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  -a <agent> \
  -m <provider/model> \
  -k 5 \
  --upload \
  --public

cd leaderboard
uv run lb submit https://hub.harborframework.com/jobs/<job-uuid>
```

这两条命令只是**路演后的操作模板**；执行前必须冻结 Harbor/benchmark commit、确认 Morphz ATIF/public trajectory 不泄露 secret、在 Linux 上通过 1-task smoke，并以官方仓库当时的 README 为准。只有 leaderboard PR 经 CI 和维护者合并后才是 `O`。

#### 2. ALE-CLI：机制与市场兼顾

先做 Linux/CLI/unlicensed 小样，不做 Windows GUI 和付费软件。第一阶段只验证：deploy harness、任务状态持久化、tool bridge、trajectory/cost ledger、超时恢复与隐藏评分边界。确认主办方接受 Morphz custom harness 名称和提交材料后，才批准正式预算。

#### 3. STATE-Bench Agent Learning：ME-07 官方机制证据

保持原 readiness 路线：一个领域的小规模 `no-learning` 对照 Morphz learning pilot，通过 adapter failure、成本和可解释差异闸门后再跑 3 domains × 50 held-out × 5。它不因 promotion heat 较低而取消，但传播文案应定位为“机制证据”，不是当前最热综合 Agent 榜。

### 4.3 第二批与长期

1. **SWE-Marathon v1.1**：主办方确认 custom harness + token/cost 预算通过后，作为“超长程自治”传播项目。
2. **Toolathlon Verified**：主办方确认 custom scaffold 官方分组后进入；否则只做 `P` 级协议试验。
3. **AppWorld/π-Bench/τ³-bench**：复用工具基础设施，补产品与策略遵循证据。
4. **PostTrainBench**：GPU/污染审计独立立项，不与普通 agent eval 共用预算。
5. **Open Agent Leaderboard**：等两个以上单榜 adapter 和统一成本账本成熟后再参加。
6. **Terminal-Bench 3.0**：保持 watch，不以 GLM-5.3 已报告数字推断为当前开放榜。

## 5. 可比性与作弊风险

### 5.1 必须按 system 结果披露

当前发布材料大量混用不同 harness：Kimi Code、Claude Code、Codex、mini-swe-agent、OpenAI Agents SDK、厂商内部 Ultra/多 Agent 设置。Morphz 的公开结果至少要写成：

```text
Morphz <commit> + <exact model/provider> + <benchmark commit>
<agent/harness version>, <turn/time/token/resource budget>, <repeats>
official status: local / submitted / verified
```

不得只写“模型 X 在榜 Y 得分 Z”，也不得拿不同 scaffold 的厂商自报表直接证明 Morphz 超过某模型。

### 5.2 主要风险

- **基础设施噪声：** [Anthropic 对 Agent benchmark 基础设施噪声的分析](https://www.anthropic.com/engineering/infrastructure-noise)指出，仅环境差异就可明显摆动 coding-agent 成绩；Docker、网络、CPU、缓存和 timeout 都要冻结。
- **trajectory/污染：** Terminal-Bench、PostTrainBench、SWE-Marathon 均存在答案抓取、test lookup、reward hacking 或 hidden verifier 攻击风险。Morphz 的网络、工具和 artifacts 必须可审计。
- **非同一 harness：** DeepSWE、AutomationBench、MCP-Atlas 等榜若固定 completion agent，Morphz 自换 harness 的结果只能是新实验，不能混入原榜排序。
- **维护者复测：** 对主办方统一复测的榜，provider、模型精确版本、价格和可用性可能在排队期变化；提交日与验证日必须分别记录。
- **LLM judge：** ALE、MCP-Atlas、π-Bench 等涉及 judge；要冻结 judge model/version、重复次数和人工复核规则。

## 6. X / 社区热度证据与限制

### 6.1 可核验信号

- X 的公开 trend 页面分别为 [Kimi K3 发布与 Terminal-Bench 讨论](https://x.com/i/trending/2081601621075890638)、[DeepSWE 社区讨论](https://x.com/i/trending/2059364881648988225?lang=en)、[Grok 4.5 coding/TB2.1 讨论](https://x.com/i/trending/2074755136052953441?lang=cs)和 [GPT-5.6/TB2.1 讨论](https://x.com/i/trending/2075730219835507005)生成了主题页。这些只证明讨论聚集，不作为成绩或规格的事实来源。
- GLM-5.3 发布后，公开社区讨论集中复述 Terminal-Bench 2.1/3.0、DeepSWE、SWE-Marathon、Toolathlon、AutomationBench 与 ALE 这组 coding/agent 榜；事实数字仍以 [Z.ai 官方博客](https://z.ai/blog/glm-5.3)及脚注为准。
- `Terminal-Bench 2.1 + DeepSWE + SWE-Bench Pro` 是当前 X/发布材料最容易传播的三联叙事，但只有 Terminal-Bench 2.1 对 Morphz 同时满足高热度、custom Agent 和公开提交。

### 6.2 检索限制

本轮直接 X 检索没有可用登录态：`twitter-cli` 对 Terminal-Bench、DeepSWE、GLM-5.3 等关键词共 4 次查询均因认证失败；按 fallback 规则改用 OpenCLI 后，2 次聚合搜索均未返回可用帖子，随后停止重试。公开搜索引擎只索引到少量 trend/topic 页和转帖，无法可靠统计官方账号互动量、转推或开发者重复发帖数。

因此：

- 不报告伪精确的 X 点赞/转发总数；
- 不把“未搜到”解释成“没有热度”；
- promotion heat 主要由官方发布的跨实验室重复采用和榜单活跃度决定；
- 若后续取得可用 X 登录态，再补官方账号、榜单维护者和开发者样本，并保留查询时间与 URL。

## 7. 排除项

以下类别即使在模型发布中成绩醒目，也不进入 Morphz 打榜路线：

- 纯静态知识、数学与短答案 QA；
- 只比较预训练知识或单次推理、Morphz Runtime 无合理增益的榜；
- 不允许 system/harness 参赛且无维护者复测路径的模型榜；
- 需要改题、改 verifier、泄露测试集或扩大网络权限才能取得优势的榜；
- 多语言/文言 Context 对比：已降级为 Deferred Proposal，不进入本 watchlist、ME-07 或 ME-08 当前计划。

## 8. 决策摘要

```text
路演前：只做 TB2.1 delta 审计 + 提交资格确认 + 双评分周更

路演后正式顺序：
  1. Terminal-Bench 2.1       promotion fast lane
  2. Agents' Last Exam CLI    mechanism × promotion
  3. STATE Agent Learning     ME-07 mechanism lane
  4. SWE-Marathon / Toolathlon（主办方确认后）
  5. AppWorld / π / τ³ / Open Agent Leaderboard（复用设施成熟后）

市场信号，不冲榜：
  DeepSWE / SWE-Bench Pro / AutomationBench /
  Artificial Analysis Coding Agent Index / GDPval-AA / BrowseComp
```

下次更新触发条件：任一榜发布新 submission contract；Terminal-Bench 3.0 正式开放；ALE/Toolathlon/SWE-Marathon 回复 custom harness 资格；或七组模型出现经官方渠道确认的新版本。未经官方来源确认的型号名不进入表格。
