# RRSI 源码审计与 Morphz 启示

日期：2026-09-29

审计对象：[google-research/rrsi](https://github.com/google-research/rrsi)，公开主分支提交 `be50316`；论文版本为 [arXiv:2609.24972v2](https://arxiv.org/abs/2609.24972v2)。

本文不是对 README 的转述。结论来自论文、项目网站、公开源码、测试、GitHub Issue／PR 和有限社区讨论的交叉检查，并区分作者实验、源码事实与架构判断。

## 一、结论先行

RRSI 最准确的定义不是“一个会自我进化的 Agent”，而是：

> **一个针对 Agent Harness 源码的、带正则化约束的离线搜索与版本晋升系统。**

它把现有 Harness 当作待优化程序：运行固定任务集，分析失败轨迹，让 LLM 修改 Harness 源码，在隔离 Git worktree 中跑完整评测，再决定是否把候选 commit 晋升为下一代 Harness。

它真正解决的问题也不是“怎样让 Agent 拥有记忆、并发或结构化 Context”，而是：

> 当我们不断使用同一组 benchmark 反馈修改 Harness 时，怎样减少对 benchmark 的自适应过拟合、评测噪声追逐和无节制复杂度增长？

我的总体判断是：

1. **问题成立，而且很重要。** Harness 自动优化本质上是在一个极高维程序空间里反复使用同一个验证集做自适应模型选择；即使不训练模型权重，也会过拟合。
2. **RRSI 的主贡献是“晋升纪律”，不是新的 Agent Runtime。** Edit ledger、泄漏审查、噪声带、成本门槛、候选隔离和 OOD 验证都很有价值。
3. **“Recursive Self-Improvement”有一定包装成分。** 当前 Harness 并不是在线运行时自主改造自身；一个外层实验控制器调用 Analyst、Proposer 和 Critic 修改代码，再用 benchmark 晋升版本。它是 agent-system-level 的递归优化，而不是持续认知主体的自我演化。
4. **它没有触及 Morphz 的核心范式。** RRSI 不定义模型如何求值 Context，也没有结构化认知状态、共享 Session、多 Thread／多 Objective 或事务化非确定性求值。它优化的是任意 Harness；被优化对象仍主要是传统线性 transcript Agent。
5. **它与 Morphz 是上下层关系，不是互斥路线。** RRSI 类方法未来完全可以优化 Morphz 的 hns、Mind Frame 模板、Skill、Tool policy 或 Context 策略；Morphz 则能为这种进化提供更明确的语义单元、并发执行和持久证据。
6. **论文结果值得关注，但不能直接当作已经独立复现的定论。** 公开仓库很新，只有四个公开提交、八项核心单元测试、没有 CI、没有完整实验运行目录；社区目前主要在复述论文，还没有可信的独立大规模复现。
7. **源码暴露了几处会影响论文核心叙事的边界。** 最重要的是退火预算实际从未到达论文所称的单 edit；结构剪枝只是交给 Proposer 的软性建议；组件收益并不等于组件真实边际贡献。

从 Morphz 的角度看，RRSI 是一个利好信号：业界开始明确承认 Agent 的 Harness 本身是可持续优化的程序对象，而不仅是固定 Prompt。但它也说明，**开放修改一切并不会自动产生可靠自进化；越开放的 Harness，越需要稳定的状态、评测、权限和晋升内核。**

## 二、它究竟是什么

### 2.1 被优化对象

论文把 Agent 表示为：

```text
Agent A = frozen policy π + harness H
```

其中 Harness 包含：

- System／task prompts；
- Agent control flow；
- Tools 及其描述；
- Memory 与 Skill 文件；
- Context management；
- Output plumbing；
- Sub-agent 调用；
- 各种配置与终止机制。

模型权重始终冻结，搜索变量是 Harness 源码 `H`。

RRSI 为编辑记录定义了九种粗粒度标签：

```text
prompt
control_flow
config
output_plumbing
context_mgmt
client_tool
skill
memory
subagent
```

这些标签只是搜索历史、探索和新颖度统计使用的分类词汇，并不限制实际源代码编辑空间。Proposer 仍可以修改 Harness 目录中的任意允许文件。

### 2.2 它不是这些东西

RRSI 不是：

- 一个可以直接服务用户的 Agent；
- 一个在线 Agent Runtime；
- 一套新的 Context 表示协议；
- 一个模型训练框架；
- 一个长期运行的认知系统；
- 一个插件系统；
- 一个通用安全沙箱；
- 一种能证明无限递归自我提升的机制。

它是一个外层优化循环：给定初始 Harness、任务集、评分器和预算，寻找一个更好的 Harness commit。

### 2.3 为什么可以叫“递归”

它的递归性来自如下闭环：

```text
H_t 运行任务
  -> 产生轨迹与成绩
  -> Analyst 总结 H_t 的失败
  -> Proposer 基于这些证据修改 H_t
  -> 候选 H' 被评测与筛选
  -> H_{t+1} 成为下一轮的运行系统
```

后一个 Harness 的产生依赖前一个 Harness 的行为，因此在 agent-system 层面确实构成递归改进。

但要保持精确：

- 执行用户任务的 Policy 不负责独立完成整个自改造闭环；
- Analyst、Proposer、Critic 和实验控制器是外层角色；
- 改进发生在离线源码、Git branch 和 benchmark 中；
- 生产中的某个持续 Agent 并没有一边服务用户一边无缝替换自己的内核。

因此，“自动化 Harness 工程”比“自主 Agent 自我进化”更准确。

## 三、完整运行过程

### 3.1 基线和状态

每个 Domain 从 `H_0` 开始：

1. 建立 `evolve/<domain>` 分支；
2. 在完整 evolve set 上运行基线；
3. 保存每项任务的轨迹、得分与 Policy token；
4. 建立 `frontier.json`、`history.jsonl` 和初始 `S*`；
5. 用未修改 Harness 的重复评测或 bootstrap 估计噪声容忍度 `δ`。

持久状态主要是普通文件和 Git：

- `frontier.json`：当前 incumbent、历史最好分和轨迹；
- `history.jsonl`：每个声明 edit 的假设、标签、diff、分数、成本和结果；
- `attribution.jsonl`：预测会改善哪些任务，以及实际命中情况；
- 每轮的 analysis、proposal、critic、diff、smoke、eval 和 decision；
- 候选 Git branch 与接受后的 `evolve/<domain>` commit。

### 3.2 每轮搜索

一轮的真实流程是：

```text
Incumbent H_t
    │
    ├─ 选取最差任务轨迹 + 少量最好轨迹
    │
    ├─ Digester / Analyst 提炼失败模式和成功习惯
    │
    ├─ 计算 edit budget、stall、未尝试组件、prune suggestions
    │
    ├─ 为两个候选分别建立 Git worktree
    │    └─ Proposer 直接编辑 Harness 源码
    │
    ├─ deterministic denylist + LLM Critic 泄漏审查
    │    └─ 最多五轮修订
    │
    ├─ smoke test
    │
    ├─ 在完整 evolve set 上重新评测每个候选
    │
    ├─ performance floor + token cost + novelty + domain guards
    │
    └─ 选择最高分的 admissible candidate，fast-forward incumbent
```

这不是小样本快速试探。每一个通过前置筛选的候选都重新运行完整 evolve set。

### 3.3 三个实例

| 实例 | 初始 Harness | Evolve set | 每轮候选 | 轮数 | 每候选完整试验数 |
| --- | --- | ---: | ---: | ---: | ---: |
| Coding | Terminus-2 | Terminal-Bench 2.1，89 题 × 2 | 2 | 20 | 178 |
| Workspace | Archipelago ReAct toolbelt | Harvey LAB，120 题 × 2 | 2 | 20 | 240 |
| Engineering | Archipelago ReAct toolbelt | EngDesign，61 题 × 4 | 2 | 40 | 244 |

如果每个候选都进入完整评测，仅三次主搜索就包含：

- Coding：`20 × 2 × 178 = 7,120` 条 Policy 任务轨迹；
- Workspace：`20 × 2 × 240 = 9,600` 条；
- Engineering：`40 × 2 × 244 = 19,520` 条；
- 合计 `36,240` 条候选评测轨迹。

这还不包括基线、重复校准、smoke、失败重试、OOD、四种 baseline、消融实验、Analyst／Digester／Proposer／Critic 调用和 LLM Judge。

因此，这个项目虽然代码不大，却是一个计算和评测资源密集型研究系统，不是普通开发者点击一下就能廉价复现的产品功能。

## 四、它怎样把信息提供给 Agent

RRSI 没有发明新的模型接口。它仍然通过 System Prompt、普通文本、JSON 和交互 transcript 把信息交给模型。

### 4.1 Proposer 的 System Prompt

Proposer 被定义成一个 Harness engineer，并获得：

- 当前职责和不可改变的边界；
- 严格 JSON action protocol；
- `list_files`、`read_file`、`list_traces`、`read_trace`、`edit_file`、`write_file`、`done` 等动作；
- edit 的必填声明：组件、假设、触发条件、影响任务、反事实验证和回归风险；
- 禁止任务特化、泄漏、无界循环和未声明 bundling 的规则。

模型每轮只输出一个 JSON action，Python 外层执行动作，并把结果继续追加进 transcript。

### 4.2 稳定前缀

`SKILL.md` 和 `PATTERNS.md` 被作为相对稳定的 cache prefix：

- `SKILL.md` 是该 Domain 的提案宪法；
- `PATTERNS.md` 是已知设计模式与反模式库。

它们不是 Runtime 可求值程序，只是长期说明文本。

### 4.3 每轮动态 Context

每次调用 Proposer 时，Runtime 拼装：

1. 当前候选身份与同轮竞争说明；
2. 最近 edit history；
3. 过去预测是否命中的 attribution scoreboard；
4. stall 与未尝试组件；
5. 组件删除建议；
6. 三视角 failure analysis；
7. per-task digests；
8. 当前 Harness 全部源码文本；
9. 本轮 edit budget；
10. 当前任务或 Critic 修订意见；
11. 当前 JSON action transcript。

原始轨迹不会一次全部注入。Proposer 先看到列表和摘要，需要时用 `read_trace` 分段读取，单次读取有字符上限。

### 4.4 Critic 和 Analyst

- Critic 看到 Domain 审查规则、候选摘要、声明 edit 和完整 diff，返回普通 JSON verdict；
- Analyst 读取 incumbent 的失败与成功轨迹，输出失败模式和成功习惯；
- Digester 可以在轨迹目录中执行受限只读查询，为 Analyst 生成结构化摘要。

### 4.5 与 Morphz 的本质区别

RRSI 的 JSON 很多，但它仍然是：

> **Runtime 把结构化数据渲染成线性模型输入，模型把它理解为任务材料。**

它不是：

> **模型对一个具有持续身份、引用、事务与求值语义的 Structured Context 直接进行非确定性求值。**

RRSI 中的真实状态权威是 Python 对象、JSONL、文件系统和 Git；模型看到的是它们的序列化投影。模型输出的 JSON action 也只是控制协议，不是模型正在求值一门共享语言。

这一点和此前研究的 DSH、Codex Harness 以及多数传统 Agent 一致：消息表面可以结构化，但底层仍是线性 Prompt + 外部状态机。

## 五、所谓“正则化”具体是什么

### 5.1 提案侧

#### 退火 edit budget

理论上，早期候选允许组合多个独立修改，后期逐渐缩小到一个 edit，让收益更容易归因。

它限制的是一次 proposal 声明的独立机制数，而不是代码 diff 行数，也不是整个 Harness 最终复杂度。

#### 全历史信用记录

每个 edit 记录：

- component；
- hypothesis；
- source diff；
- score delta；
- token-cost delta；
- 是否成为当轮 winner。

后续 Proposer 会看到近期记录，以避免原样重复已经失败的假设。

#### 停滞时探索未尝试组件

如果最近 `w` 轮总进步没有超过噪声带，部分候选名额被指定去尝试从未测量过的组件类型。例如搜索一直只改 Prompt，就迫使一个候选尝试 Memory、Tool 或 Sub-agent。

### 5.2 选择侧

#### 泄漏审查

候选评测前先经过：

- 确定性正则 denylist；
- LLM Critic 对 benchmark 特化、grader gaming、跨 trial Memory 泄漏、未声明 bundling 和无界循环的审查。

被拒绝的候选不会获得 evolve-set 分数，避免高分泄漏方案进入后续搜索历史。

#### Noise-adjusted floor

维护历史最高成绩 `S*`，候选至少满足：

```text
S(candidate) >= S* - δ
```

这允许在估计噪声范围内探索，但不允许多轮小幅退化持续向下漂移。

#### 成本门槛

当候选增益超过噪声带时，额外 Policy token 必须被分数增益“购买”：

```text
ΔC <= β0 + β1 × ΔS
```

当增益处于噪声带内，则使用：

```text
w_s × ΔS - w_c × ΔC + w_n × structural_novelty > 0
```

这使得一个分数几乎不变但更便宜的候选，或一个首次落地新结构组件的候选，仍可能进入 incumbent。

#### Domain guard

Engineering 额外限制 valid-output rate 和 no-submission rate，防止主分数掩盖基本执行质量退化。Coding 和 Workspace 没有额外非补偿 guard。

### 5.3 这套机制真正代表什么

论文借用了 `L0`、`L1` 和 `L2` 的语言，但作者也承认这是功能类比，而不是数学上真的优化相应范数目标。

更准确的描述是：

- edit budget：程序搜索的候选复杂度约束；
- history：自适应实验 ledger；
- critic：静态／语义合规 gate；
- floor：带噪 model selection 的保守晋升线；
- cost rule：性能—推理成本的手工约束；
- prune suggestion：由历史标签触发的删除提案提示。

这仍然很有价值，但不应因为使用了 Lasso／Ridge 名称，就误以为它获得了连续优化中的理论保证。

## 六、论文结果应该怎样理解

### 6.1 作者报告的主结果

| Domain | Benchmark | H0 | RRSI | 变化 |
| --- | --- | ---: | ---: | ---: |
| Coding | Terminal-Bench 2.1 evolve | 74.2 | 80.2 | +6.0 |
| Coding | SWE-bench Verified OOD | 82.0 | 83.8 | +1.8 |
| Workspace | Harvey LAB evolve | 89.4 | 90.5 | +1.1 |
| Workspace | Harvey LAB ID held-out | 86.9 | 89.2 | +2.3 |
| Workspace | JobBench OOD | 36.0 | 40.7 | +4.7 |
| Workspace | GDPval OOD | 48.8 | 52.3 | +3.5 |
| Workspace | APEX-Agents OOD | 34.2 | 37.9 | +3.7 |
| Engineering | EngDesign evolve | 50.0 | 54.9 | +4.9 |
| Engineering | Frontier-Eng OOD | 17.7 | 22.0 | +4.3 |

作者还报告：

- Gemini 3.5 Flash 搜索时，Terminal-Bench 从 64.6 到 78.7，SWE-bench 从 76.8 到 79.0；
- 用 Gemini 3.5 Flash 演化出的 Harness 换到未参与搜索的 Gemini 3.1 Flash Lite，Terminal-Bench 从 11.2 到 14.6；
- Workspace 的 RRSI 最终 Harness 为每条 trial 约 242 万 Policy token，无正则演化约 380 万，原始 H0 约 156 万。

### 6.2 正确的积极判断

这组实验至少提供了四项有意义的证据：

1. 不改模型权重，仅修改 Harness，确实可以获得可测量提升；
2. 只看 evolve-set 分数会高估 Harness evolution；
3. OOD benchmark 是这类研究不可缺少的门槛；
4. 选择规则若只追逐最高分，很容易增长 Context 和 token 消耗而不形成可迁移机制。

### 6.3 不能过度解读的部分

- 结果来自作者的一组完整搜索轨迹，没有看到多 search-seed 的均值、方差或置信区间；每项任务虽有 `k=2/4` trials，但不等于整条 Harness 搜索重复多次。
- Harvey、JobBench、GDPval、APEX 中存在 LLM Judge；Engineering 的确定性 verifier 是重要补强，但仍只覆盖一个架构族和有限搜索长度。
- RRSI 仍反复访问 evolve set，正则化只是降低自适应过拟合的经验策略，不会从逻辑上消除过拟合。
- OOD 结果没有进入选择，这是正确做法；但论文 hyperparameters 仍由 evolve 环境和人工 operational considerations 选择。
- “30% fewer tokens”是相对无正则演化，不是相对原始 Harness。RRSI 最终 Harness 仍比 H0 多约 55% Policy token（242 万对 156 万）。
- 论文只统计被优化 Policy 在任务执行时的 token，不包含整个搜索期间 Analyst、Digester、Proposer、Critic、Judge、工具执行、Docker 和人工维护的总成本。

## 七、源码质量与真实边界

### 7.1 代码规模和成熟度

截至审计日：

- 仓库创建于 2026-09-16；
- 公开历史只有四个 commit；
- Apache-2.0；
- 约 3,000 行核心 `rrsi/` Python；
- 约 7,500 行 Domain adapter、runner 和脚本；
- 另有约 11,600 行 vendored 第三方 Harness；
- 核心测试只有八项直接单元测试；
- 没有公开 GitHub Actions CI；
- 没有随仓库提交完整 `runs/` 实验记录；项目网站展示了部分可交互候选和 diff。

直接运行 `python3 tests/test_core.py`，八项测试全部通过；核心与 Domain Python `compileall` 通过。没有配置 pytest 的环境时，README 推荐的 `pytest` 命令需要先安装 dev extra。

它是一份相当整洁、可阅读的研究代码，但还不是成熟的通用 Harness evolution 产品。

### 7.2 实现得好的地方

- 候选使用独立 worktree 和 branch，避免同轮污染；
- winner 通过 fast-forward 进入 incumbent，版本链清楚；
- 缺失 trial 以零分进入完整分母，避免靠破坏难题获得虚高均值；
- 候选评测、smoke、critique 和 re-adjudication 都有持久文件；
- 失败运行可恢复，已有 eval 可以复用；
- Domain interface 把 benchmark runner、评分、轨迹渲染和 guard 与核心搜索器分离；
- 公开 prompt、constitution 和 pattern library，便于审计它到底告诉了模型什么；
- 明确区分 evolve、ID held-out 和 OOD benchmark。

### 7.3 已确认的退火实现错误

论文和 README 都强调后期 edit budget 退火到 `b_min = 1`，使测量归因到单一 edit。

但代码使用：

```python
ceil(b_min + (b_max - b_min) * 0.5 * (1 + cos(pi * t / T)))
```

而实际轮次是 `t = 0 ... T-1`。因此它只在不存在的 `t = T` 才到 1。

当前配置真实序列为：

- Coding：最终值 2，最小值 2；
- Workspace：最终值 2，最小值 2；
- Engineering：最终值 2，最小值 2。

[GitHub Issue #2](https://github.com/google-research/rrsi/issues/2) 中作者已明确确认：论文报告的所有运行，最后一轮 budget 都是 2，而不是 1。社区已有未合并的 [PR #3](https://github.com/google-research/rrsi/pull/3) 提供 endpoint-anchored 选项。

这不会推翻全部结果，但确实削弱论文关于“后期测量自然成为单 edit 可归因证据”的核心论述。

### 7.4 Edit-level credit 实际仍是 candidate-level credit

即使预算修正为 1，当前多数历史记录仍有以下近似：

- 一个候选含多个 edit 时，每个 edit 继承完全相同的 `ΔS`、`ΔC` 和 winner 结果；
- 每个 edit 保存的是整个候选 diff，而不是属于该 edit 的独立 patch；
- component tag 的验证同样对整个候选 diff 做正则匹配；
- “独立 edit 数”主要依赖 Proposer 自报和 Critic 判断，不是由源码语义确定性分解。

所以这是一种可用的实验 ledger，但不是严格的因果归因系统。它知道“这个 bundle 赢了”，并不真正知道 bundle 中哪一个机制贡献了多少。

### 7.5 “Structural pruning”比论文措辞弱

源码并不会自动删除组件。它只计算一个 `prune_set`，然后把建议放进 Proposer prompt，由 Proposer 决定是否提交删除候选；删除之后仍需完整评测和晋升。

更重要的是，所谓“不再有贡献”并不是通过对当前组件做 ablation 得到的。`g_t(component)` 是最近窗口内所有同标签 edit 的最大候选分数变化：

- 一次成功 Prompt edit 会保护整个 `prompt` 类型；
- 一个失败 Tool edit 可能让整个 `client_tool` 类型被标记；
- 一个早期已接受且持续有价值的机制，只要最近几轮没有再次被编辑，`g_t` 就会变成负无穷并进入 prune set；
- 历史中的 `accepted_edits` 只累加 winner 记录，没有完整建模后续删除使哪些旧机制退出 incumbent。

因此，它测量的是“最近对某类组件的修改是否涨分”，而不是“当前 Harness 中这个组件是否仍有边际价值”。

把它叫作 **prune proposal heuristic** 更准确，不能理解成可靠的结构稀疏化算法。

### 7.6 Cost gate 的边界

成本只使用平均 Policy token：

- 不统计工具 CPU／GPU、Docker、网络、延迟、金钱、人工或搜索角色 token；
- 如果 candidate 或 incumbent 缺少 token 统计，`relative_cost_change` 直接返回 0，成本门槛会静默失效；
- 平均 token 只来自存在 token 记录的 trial；部分缺失 trial 虽会在分数上计零，但也可能让成本均值偏低；
- Coding 的参数允许一个额外 pass 购买约 25% token，再加 10% 基础额度，实际并不严格追求轻量。

所以它证明的是“控制了一项可测代理指标”，不是控制了 Agent 系统的完整资源成本。

### 7.7 Critic 不是安全证明

Critic 很有用，但仍然是同一家族 LLM 对另一个 LLM 的 diff 做语义审查：

- 确定性 denylist 只能抓明显名称和路径；
- 间接编码、统计特化或更隐蔽的 grader adaptation 仍可能通过；
- Proposer、Analyst、Critic 和主 Policy 在主实验中都使用 Claude Opus 4.8，可能共享偏见；
- Critic 看 diff 而不是完整运行时数据流，无法证明新 Memory／Tool 在所有路径都不泄漏；
- OOD 结果是最重要的实际防线，而不是 Critic 自身。

### 7.8 消融暂不可由公开配置直接复现

Issue #2 同时指出，论文 Table 2 的 proposal regularizers／acceptance regularizers 开关没有出现在当前 release。作者答复会在后续提交增加准确 arm 定义和每行运行次数。

因此，当前代码可以运行 RRSI 主流程，但不能仅通过一个公开配置直接复现论文全部消融表。

## 八、RRSI 与 Morphz 的三层比较

### 8.1 它们不在同一层

| 层次 | RRSI | Morphz |
| --- | --- | --- |
| 核心身份 | Harness 搜索与晋升系统 | 持久 Agent Runtime／S 表达式认知机 |
| 被求值对象 | Benchmark 中的任务轨迹与候选源码 | 结构化 Context 与 Yao 程序 |
| 模型输入 | 拼装后的文本、JSON、源码和 transcript | 具有稳定语义的 Structured Context／程序体投影 |
| 状态权威 | JSON、JSONL、文件、Git branch | Event、Context、Mind、Session、Thread、Objective、Plan、事务 |
| 并发 | 候选 benchmark 试验可并行 | 持久 Thread／Objective／Branch Group 因果并发 |
| 持久改进 | 接受一个 Harness commit | Agent 自主管理 Context；hns／Program Value 可持久运行 |
| 安全边界 | 文件路径、Critic、smoke、benchmark sandbox | Principal、capability、admission、typed effect、receipt、Target |
| 主要目标 | 找到更可迁移、更省 token 的 Harness | 让模型直接求值并维护持久结构化认知状态 |

所以不能说 RRSI“实现了 Morphz”，也不能说 Morphz 已经“包含了 RRSI”。

更准确的关系是：

```text
RRSI-like outer optimization
        ↓ proposes / evaluates / promotes
Morphz hns + Mind Frame policy + Skill + Tool policy
        ↓ runs on
Morphz stable Runtime kernel
```

### 8.2 RRSI 更接近 DSH 的哪一面

RRSI 和 DSH 都接受“Harness 的很多部分可以改变”。区别在于：

- DSH 关注运行时组件可组合和插件化；
- RRSI 关注如何从实验反馈自动修改整个 Harness 源码；
- RRSI 甚至不要求被修改系统拥有正式插件边界，直接改源代码即可。

这使 RRSI 比 DSH 更开放，也更危险。它随后不得不用 Critic、smoke、完整 benchmark、成本 gate 和 OOD 验证把开放空间重新约束起来。

这反而印证了 Morphz 的设计选择：**稳定内核不是灵活性的敌人，而是让可演化部分能够被可信评测和晋升的前提。**

### 8.3 它没有进入“结构化 Context vs 线性 Context”的较量

RRSI 可以修改 `context_mgmt`，但它没有提出新的 Context 本体。当前两个主要 Harness 仍然采用：

- 消息 transcript；
- Prompt；
- ReSum／summary；
- tool results；
- Memory／Skill 文本；
- 外部 Python control flow。

它可以搜索更好的 compaction、提示方式或工具包装，但模型仍然面对线性化后的输入。

原则上 RRSI 的开放 edit space 可以提出 Structured Context。但从一个传统 ReAct Harness 出发，在 20～40 轮、每轮 2 个候选、强 smoke 和完整 benchmark 约束下，搜索更擅长发现局部改进，不擅长凭空完成一次新的 Runtime 范式迁移。

因此它不会自动越过 Morphz 那层“窗户纸”。反过来，一旦把 Morphz 作为初始 Harness，它可能成为优化 Morphz 上层策略的有效工具。

## 九、对 Morphz 真正值得吸收的部分

### 9.1 Evolution Ledger

最值得吸收的不是允许 Agent 改内核，而是为每次改进保存：

- 假设；
- 作用组件；
- 触发条件；
- 预期影响；
- 候选版本；
- evolve／held-out／OOD 证据；
- 资源变化；
- 晋升或拒绝原因；
- 回滚身份。

Morphz 可以把这些表示成真正的结构化 Frame 和 Artifact，而不是重新渲染成 JSONL 后再让模型从文本理解。

### 9.2 Proposal 与 Promotion 分权

模型可以大胆提出候选，但没有权力直接把候选变成生产状态。

在 Morphz 中可以对应为：

- `infer` 提出 hns／Program Value／Mind policy candidate；
- Runtime admission 验证语法、类型、effect 和 capability；
- Eval Objective 在隔离 Execution Target 中运行；
- Promotion gate 检查真实证据；
- Principal 对高风险晋升做人工审批；
- 生产指针原子切换并保留 rollback receipt。

这与 Morphz 已有的“两种求值者、一个语言”和 Program Value admission 非常契合。

### 9.3 噪声、成本和 OOD 纪律

Morphz 论文实验和未来生态都应吸收：

- 不以单次最好结果晋升；
- 每个候选固定模型、Runtime commit、hns version 和 budget；
- 使用同一 evolve set 时必须记录适应次数；
- 保留永不参与选择的 held-out／OOD suite；
- 同时报告正确性、严格通过率、token、模型请求、工具调用、延迟和失败；
- 改进必须能回溯到具体候选和证据，不能只留下最终 Prompt。

这与 Morphz 当前评测文档提出的五次配对样本、多模型矩阵和真实性边界一致，RRSI 提供了一个可参考的自动化组织形式。

### 9.4 候选隔离与版本化

Git worktree 是传统源码的合理载体。Morphz 还可以进一步利用：

- Context fork；
- 独立 Objective／Thread；
- immutable Program Value；
- hns package version；
- Execution Target sandbox；
- 精确因果 receipt。

每个候选可以是一条持久 Thread，多个候选和 benchmark trial 可以并发执行，但共享同一个 Evolution Objective 的预算和选择语义。

### 9.5 不应直接吸收的部分

Morphz 不应：

- 让线上 Agent 任意修改 Runtime 源码后自动加载；
- 把粗粒度 `component` 标签当作因果归因；
- 用同一个 evolve score 决定 Mind Frame 真伪；
- 把最近没编辑过误判为组件不再有价值；
- 用 LLM Critic 代替 capability、type、effect 和 sandbox；
- 把 Policy token 当作全部成本；
- 允许候选直接污染生产 Agent 的共享 Mind；
- 把不断换 Prompt 宣称为认知自进化。

## 十、如果 Morphz 将来实现这一层，应怎样设计

建议把它定义成一个 **Evolution hns / Evaluation Application**，而不是 Runtime 自修改功能。

### 10.1 可演化边界

首批只允许：

- hns 应用包；
- Mind Frame 模板与认知程序；
- Yao Program；
- Skill 内容与选择策略；
- Tool exposure policy；
- Context projection／maintenance policy；
- 应用级 prompt 和输出 contract。

Runtime kernel、事务协议、权限语义、Session／Thread／Objective 身份和 Store 一致性不进入在线开放搜索空间。

### 10.2 候选结构

每个 candidate 应具有：

```text
Candidate ID
Base Runtime / hns / model / protocol versions
Typed edit set
Hypotheses and expected observables
Capability ceiling
Evolve evidence
Held-out evidence
OOD evidence
Cost vector
Safety and integrity verdicts
Promotion decision
Rollback target
```

Edit 不应只是一个自然语言标签；它最好对应可独立启用／禁用的结构化 Program／Frame／policy delta，使真实 ablation 成为可能。

### 10.3 并发映射

- 一个 Evolution campaign 是一个 Objective；
- 每轮候选是并行 Thread；
- 每个 benchmark trial 是子 Objective／Branch；
- 每个候选绑定独立 Context fork 和 Target；
- 所有结果汇合到确定性的 selection `eval`；
- 生产晋升是独立 effect，需要 capability 与 receipt。

这会比 RRSI 用 Python 线程、JSONL 和 worktree 手工拼装状态更自然，也能恢复长达数天的实验。

### 10.4 选择规则

不要照抄一个总分。至少使用非补偿门槛：

- 语义正确性；
- 来源完整性；
- 状态污染；
- 权限和副作用；
- 并发一致性；
- restart equivalence；
- token／请求／工具／延迟／金钱；
- held-out 与跨模型迁移；
- 人工审批要求。

Morphz 的优势正是可以把这些作为结构化、带来源和因果关系的证据，而不是让 Critic 从一个巨大 diff 中猜。

## 十一、对 Morphz 的机会与压力

### 11.1 利好

RRSI 强烈验证了 Morphz 长期坚持的一点：

> Agent 能力并不只存在于模型权重；模型周围的 Context、控制流、工具、记忆和执行协议本身是核心计算系统。

它还让“Harness 需要被持续优化”成为一个越来越主流的研究问题。Morphz 的结构化 Context 和 Yao 不是偏离主流，而是比传统 Prompt／ReAct Harness 更明确地把可优化机制变成语言与状态。

### 11.2 压力

压力不在于 RRSI 已经拥有 Morphz 的能力，而在于：

- 大厂开始把 Harness 视为可研究、可搜索、可自动改进的正式对象；
- 自动 Harness engineering 会快速提高传统 Agent 的局部性能；
- OOD、成本和可审计演化可能形成新的论文与产品标准；
- 如果 Morphz 只谈架构潜力、没有同等严谨的基准和可观察产品体验，外界不会自动理解其更深抽象。

### 11.3 威胁程度

短期：**低到中。** RRSI 是重型离线研究管线，不是 Morphz Runtime 竞争品，也没有结构化认知或多 Session／多 Objective 能力。

中期：**中。** 它可能成为各种 Agent Harness 的自动优化层，使传统架构在 benchmark 和具体产品任务上迅速变强。

长期：**取决于初始架构。** RRSI 类优化器可以优化任何系统。若大厂把它用于一个更结构化的 Runtime，它会加速那个 Runtime；若 Morphz 先建立协议、应用和可信评测，它也能反过来成为 Morphz 的放大器。

## 十二、最终判断

RRSI 不是另一套 Morphz，也没有越过 Structured Context Evaluation 这条范式边界。

它的重要性在另一个方向：它把 Harness engineering 从“人凭经验改 Prompt”推进为一种可记录、可实验、可筛选、可回滚的自动化搜索过程，并明确指出这种过程本身也会过拟合。

对 Morphz 最有价值的认识是：

> **未来的竞争不仅是哪个 Runtime 的抽象更强，还包括哪个 Runtime 能把自己的可编程认知机制转化成可重复实验、可安全晋升、可跨任务迁移的改进循环。**

Morphz 不应学习 RRSI 的任意源码自修改，而应学习它的证据纪律；不应把 Runtime 变成动态插件泥团，而应让稳定内核承载可隔离、可比较、可晋升的 hns 和认知程序。

如果说 RRSI 给传统 Harness 增加了一套“自然选择”，那么 Morphz 有机会提供更适合进化的“遗传表示”：结构化 Context、Yao、Mind Frame、Objective、Thread 和可持久恢复的因果执行。

这才是两者结合后真正有潜力的地方。

## 证据与来源

### 官方来源

- [RRSI GitHub 仓库](https://github.com/google-research/rrsi)
- [论文 arXiv 页面](https://arxiv.org/abs/2609.24972v2)
- [项目网站与 Evolution Explorer](https://regularized-rsi.com/)
- [公开提交 `be50316`](https://github.com/google-research/rrsi/tree/be50316e1db05914068a973f322770ef08ed7ba1)
- [Issue #2：消融开关缺失与退火终点错误](https://github.com/google-research/rrsi/issues/2)
- [PR #3：endpoint-anchored anneal 修复提案](https://github.com/google-research/rrsi/pull/3)

### 源码重点

- `rrsi/loop.py`：轮次控制、worktree、候选评测和晋升；
- `rrsi/propose.py`：Proposer prompt、动态 Context 和 JSON action loop；
- `rrsi/critic.py`：泄漏检查与 Critic；
- `rrsi/history.py`：edit ledger、stall、exploration 和 prune set；
- `rrsi/selection.py`：floor、cost、novelty 和选择；
- `rrsi/schedule.py`：edit-budget schedule；
- `rrsi/components.py`：组件标签与 diff 分类；
- `rrsi/evaluate.py`：完整分母、分数和 Policy-token 成本；
- `rrsi/calibrate.py`：噪声带估计；
- `domains/*/adapter.py`：三个 benchmark Domain 的运行和评分边界；
- `domains/*/SKILL.md`、`PATTERNS.md`：实际交给 Proposer 的稳定指令。

### 社区状态

截至 2026-09-29，公开讨论主要是作者发布和对论文结论的摘要，尚未看到可信的独立完整复现。社区已经出现一个 [Agent Zero 集成](https://github.com/TerminallyLazy/agent-zero-rrsi)，说明这种外层优化器很容易被接到现有 Agent 之上；但该项目没有公开基准结果，不能当作 RRSI 效果的独立验证。
