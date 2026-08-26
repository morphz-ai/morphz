# ME-07 公开 Benchmark 重选决策（2026-08-26）

> 决策状态：`benchmark-selected / strong-baseline-protocol-candidate / locked-eval-access-gated`
>
> 结论：以 **STATE-Bench Agent Learning Track** 取代已取消的
> LongMemEval-V2 Small 方案；在锁定评测客户端凭据通过前，不启动真实模型运行。

## 1. 为什么需要重选

已取消的 LongMemEval-V2 方案主要测量长期材料经 memory backend 投影后能否支持问答，
不能直接观察历史经验是否改变 Agent 的后续工具行动。它仍是有价值的长期记忆检索基准，
但与本文“结构化认知进入后续非确定性求值与现实行动”的核心主张不够贴合。

ME-07 的替代 Benchmark 必须同时满足：

1. 历史轨迹或长期状态实际影响 held-out 任务中的后续行动；
2. 允许接入生产 Morphz，而不是只评测一个临时 JSON/向量检索 surrogate；
3. 能在同一推理模型、同一训练轨迹与同一检索边界下比较多种强记忆系统，隔离模型能力
   与“有没有记忆”本身的差异；
4. 有公开数据、runner、scorer、协议与第三方可检查的结果链路；
5. 不与 ME-06 的自建长期 fixture 或 ME-08 的通用 Coding Agent 能力重复。

## 2. 候选比较

| 候选 | 机制匹配 | 外部权威/提交 | 生产 Morphz 接入 | 主要限制 | 决策 |
| --- | --- | --- | --- | --- | --- |
| STATE-Bench Agent Learning | 历史轨迹形成 learnings，影响 held-out 工具行动 | Microsoft 维护；公开 runner、锁定 simulator/judge、官方榜与提交规范 | 支持 custom `BaseAgent`、client 和只读 memory tool；允许不同学习方法在同一 Agent 模型上运行 | 上游只内置 no-memory agent，强基线 adapter 需由本项目实现；正式运行需要 Azure GPT-5.4 simulator/judge | **主方案** |
| MemGym | 同一 reasoner 下测 memory-isolated gain；内置 summarization、A-MEM、Mem0 等多种策略 | 公开代码与论文；当前正式验证/提交流程弱于 STATE-Bench | 可实现 Morphz `BaseMemoryManager` | τ²-bench 主要比较单次对话内 compaction；A-MEM/Mem0 主要用于 DR/CodeQA，难以同时满足“跨任务学习 + 真实工具行动” | 访问受阻时的第一备选 |
| STALE | 隐式冲突、旧状态失效及 downstream policy adaptation | 公开 400 场景/1,200 query 与代码 | 可接 Structured Context | 仍以个性化状态问答/判断为主，真实工具闭环弱 | 补充/相关工作 |
| MemoryAgentBench | 检索、test-time learning、长程理解、冲突 | ICLR 2026，代码与评测开放 | 可接 memory adapter | 多数任务以检索/问答为主；无清晰正式榜提交 | 补充/相关工作 |
| MemoryArena | 多 Session 的行动—反馈—记忆—行动链 | ICML 2026 工作，环境覆盖广 | 理论上可接完整 Morphz | preview 状态、环境重、无清晰提交规范 | 后续研究 |
| Memora/FAMA | 对过期记忆、记住/推理/推荐进行 forgetting-aware 评分 | ACL 2026，数据与评分代码开放 | 可接 memory agent | 主要是个性化问答与推荐，不直接测工具行动 | 补充/相关工作 |

## 3. 冻结的研究问题

> 在推理模型、任务、工具、预算与评分器保持相同的条件下，由历史任务轨迹形成的 Morphz
> Structured Context / Mind Frames，能否提高同一 Agent 在 held-out 企业工具任务中的成功率，
> 同时保持可审计的来源与认知投影？

ME-07 **不单独证明**：

- S-expression 语法优于 JSON 或自然语言；该问题由 ME-02 及机制论证承担；
- Morphz 的并发事务、恢复和多 Session 全部能力；该问题由 ME-04/ME-06 承担；
- Morphz 比所有记忆系统更省 Token 或更快；
- STATE-Bench 得分可以外推为所有真实任务上的总体优越性。

## 4. 拟冻结的三臂强基线设计

“无记忆 vs 有记忆”只能证明长期信息有用，无法区分 Morphz 与普通记忆系统，因而不进入
正式实验。STATE-Bench 公共 no-memory 行可以作为背景材料引用，但本项目不为它消耗一个
完整 750-trial arm。正式比较只保留三种**都具备长期记忆/学习能力**的方法。

### Arm A：Morphz Structured Learning

- 使用生产 Morphz Runtime 和冻结二进制；
- 将官方三个领域各 100 条 train trajectories 作为 Observation 输入独立领域 Context；
- 由 Morphz 形成带来源、关系和稳定标识的 Mind Frames；
- 冻结并哈希每个领域的学习 Context；
- 每个 held-out trial 使用学习 Context 的只读克隆，通过官方
  `retrieve_learnings(query, top_k=3)` 边界投影最多三个 Frame；
- 测试任务的临时状态写入独立 task-local Context，不回写共享学习 Context。

### Arm B：A-MEM strong baseline

- 使用冻结版本的 A-MEM 动态 note、链接与 memory evolution 方法；
- 输入与 Arm A 完全相同的 train trajectories，不访问 held-out tasks；
- 通过与 Arm A 相同的 `retrieve_learnings(query, top_k=3)` 工具合同返回学习内容；
- Agent reasoning model、STATE-Bench 工具、task-local conversation 和正式评分协议与 Arm A
  相同。

### Arm C：Mem0 strong baseline

- 使用冻结版本的 Mem0 add-time fact extraction、update/conflict resolution 和检索；
- 输入与 Arm A/B 完全相同的 train trajectories，不访问 held-out tasks；
- 使用同一 `retrieve_learnings(query, top_k=3)` 工具合同；
- Agent reasoning model、STATE-Bench 工具、task-local conversation 和正式评分协议与
  Arm A/B 相同。

该设计回答的是“在三种都有记忆的系统中，Morphz 的结构化认知能否更可靠地把历史经验
转化为后续工具行动”。A-MEM 是结构相邻的强基线，Mem0 是广泛采用的事实抽取与冲突更新
基线；二者均比空记忆对照有更高信息量。本文内部 ME-01/02/03 继续承担更细的表示与求值
机制拆解，ME-07 比较端到端学习系统，不把差异解释为单一数据结构的纯因果效应。

三臂的 Agent reasoning model 必须相同。各记忆系统自身的写入、更新、索引和检索操作属于
被测系统的一部分；其模型调用、embedding、Token、时间和离线构建成本必须完整记录。能共用
同一模型或 embedding 时应共用，不能共用时必须披露，不能把方法自身成本隐藏在“离线”标签
下。

## 5. 模型与官方协议边界

- 三臂 Agent：`gpt-5.6-sol`，`reasoning=max`，经 CLIProxyAPI Responses 路由；必须记录
  route、physical model、fallback、usage 与请求参数；
- user simulator 与 judge：严格使用 STATE-Bench 当前锁定协议要求的 **GPT-5.4 Azure
  evaluation client**；
- 禁止以 Qwen、Gemini、GPT-5.6 或其他可用线路替换锁定 simulator/judge；
- 若尚无 Azure endpoint/deployment，状态保持 `access-gated`，只能进行无模型 adapter Gate；
- 正式设置：3 domains × 50 held-out tasks × 5 runs = 750 trials/arm，三个 arm 共 2,250
  trials；`top_k=3`，retrieval 只读；
- 只有官方协议完整运行并通过结果完整性审计，才能称为 protocol-compliant local result；
  只有主办方验证并公开后，才能称为 official leaderboard result。

## 6. 指标与统计

- 主指标：官方 pass@1；
- 关键机制量：Morphz − A-MEM、Morphz − Mem0 的同任务配对成功率差；
- 次指标：pass^5、UX、cost/task、Token、检索调用率和任务用时；
- 重复运行属于同一 task 的簇；置信区间和显著性分析以 task 为重采样/置换单位，不能把
  750 个 trial 错当成完全独立样本；
- 两个主要 pairwise comparison 使用预先声明的 Holm 校正；不在看到 held-out 结果后挑选
  较弱基线作为唯一主结果；
- 官方 scorer 是得分真值，本地诊断只能解释失败，不能覆盖官方结果。

## 7. 进入真实运行前的 Gate

1. 冻结 upstream commit、协议文件哈希、数据 split 和许可证；
2. 实现 custom `BaseAgent`/client，以及 Morphz、A-MEM、Mem0 三个 trajectory-ingestion
   和只读 retrieval adapter；
3. fake client/no-model 验证三臂工具往返、状态隔离、top-k、快照只读与无 test 泄漏；
4. 验证学习 Context 快照不可被 held-out trial 修改；
5. 取得 Azure GPT-5.4 evaluation endpoint/deployment，并做精确绑定预检；
6. 三臂在同一任务上各做一次真实 smoke；
7. 冻结 runner/Runtime/adapter commit 后，才允许正式三臂运行。

任何 Gate 失败都保留原始产物；不得静默替换模型、跳题、选择性补跑或调整评分口径。

当前仅冻结 Benchmark 与三臂研究问题，**尚未冻结强基线软件版本**。已核对的候选来源为
STATE-Bench commit `5644b1838d96bc4483da29642d058ecaa6f80f7f` 和 MemGym commit
`50b404e6ae4e1fcd453d3e07963eb3e6312cbded`。后者的 Mem0 依赖仍写作
`mem0ai[extras]>=0.1.0`，且其复现审计明确记录 A-MEM 依赖尚未完成复现；因此二者都不能直接
当作已冻结、已验证的正式 adapter。进入第 2 项 Gate 时必须另行固定 A-MEM/Mem0 的精确
上游版本、许可证、模型/embedding 配置与安装锁文件，并通过各自的最小真实写入—检索测试。

## 8. 备选触发条件

只有在确认无法取得 STATE-Bench 锁定 GPT-5.4 evaluation client，且该阻塞会实质性影响
论文发布进度时，才重新评估 MemGym。届时必须先选择一个同时具有 Context 压力和真实行动
评分的 Track，并让 Morphz 与 `llm_summarizing`/`structured_summary` 以及可用的
A-MEM/Mem0 强基线比较；**no-memory 仍不作为主实验臂**。不得把 MemGym 快速子集包装成
STATE-Bench 等价证据，也不得同时启动两个昂贵正式批次。

## 9. 官方来源

- [STATE-Bench Agent Learning Track](https://github.com/microsoft/STATE-Bench/blob/main/docs/AGENT_LEARNING_TRACK.md)
- [STATE-Bench custom client + agent](https://github.com/microsoft/STATE-Bench/blob/main/docs/USE_CUSTOM_CLIENT.md)
- [STATE-Bench custom memory hook](https://github.com/microsoft/STATE-Bench/blob/main/docs/memory/custom-hook.md)
- [STATE-Bench locked evaluation client](https://github.com/microsoft/STATE-Bench/blob/main/docs/setup/eval-client.md)
- [STATE-Bench leaderboard](https://microsoft.github.io/STATE-Bench/leaderboard/)
- [MemGym repository](https://github.com/WujiangXu/MemGym)
- [STALE paper](https://arxiv.org/abs/2605.06527)
- [MemoryAgentBench repository](https://github.com/HUST-AI-HYZ/MemoryAgentBench)
- [MemoryArena repository](https://github.com/ZexueHe/MemoryArena)
- [Memora/FAMA repository](https://github.com/geniesinc/Memora)
