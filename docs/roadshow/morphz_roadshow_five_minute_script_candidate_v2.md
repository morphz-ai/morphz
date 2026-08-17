# Morphz 五分钟路演脚本候选版 v2

> 状态：`candidate-review`
>
> 日期：2026-08-17（Asia/Shanghai）
>
> 硬时长：5 分钟
>
> Runtime 源码基线：`paper-eval-runtime-v2` / `03a32f864a3c38026672b4076855137e0bbb5627`
>
> 证据协议：[DEMO-001 路演证据协议候选版 v2](demo_001_protocol_candidate_v2.md)
>
> 核心问题：为什么要发明 Morphz，而不是直接使用 Codex、OpenClaw 等现有 Agent 产品？

封面两层口径：

```text
让 Agent 具备自我学习与自我改进能力
Structured Context：主动认知学习与并发工作的基础
```

现场第一次出现“自我学习/自我改进”时必须解释：自我学习是吸收 Observation 并修订结构化认知；自我改进是让经验改变后续认知判断和 Runtime 行为，不是模型权重自动训练。

## 1. 一句话答案

推荐主句：

> 现有 Agent 已经很会完成一次任务；Morphz 要解决的是另一个问题：当 Agent 持续存在、同时经营多项事务并真正采取行动时，如何让它拥有可寻址、可修订、可恢复的认知状态，而不是每次从一串 messages 里重新推断自己现在知道什么。

技术定位只在下一句出现：

> Morphz 是面向大语言模型的认知符号求值虚拟机：模型负责开放世界中的语义求值，Runtime 负责状态、调度、权限和现实副作用的确定性求值。

面向非技术评委可以先说：

> Morphz 让 Agent 不只是记住更多内容，而是主动把新的 Observation 学成可修订的认知，并让积累的经验真正改变下一次判断和行动。这是这里所说的自我学习与自我改进，不是后台偷偷训练模型权重。

不要把 Morphz 定义成“更长记忆的 Agent”“多 Agent 编排工具”或“更强的 Codex”。

## 2. 五分钟结构

| 时间 | 目的 | 形式 |
| --- | --- | --- |
| 00:00–00:25 | 提出为什么不用现有 Agent | 一问一答，静态 |
| 00:25–01:30 | messages list vs Structured Context | 架构对照图 |
| 01:30–02:25 | 多 Session + Principal + 工作线程 | 一张能力图 |
| 02:25–03:10 | Cloud Native Agent | 分层图，恢复作佐证 |
| 03:10–03:45 | ORBIT-42 Hero Proof | 30–35 秒冻结视频/trace |
| 03:45–04:20 | 诚实的小规模效能证据 | 冻结结果表 |
| 04:20–05:00 | Morphz 001 愿景与收口 | 公司运营画面/产品愿景 |

所有切换点按 5 分钟硬截止设计，不安排现场等待模型响应。

## 3. Slide 1：为什么不是直接用现有 Agent（00:00–00:25）

屏幕只放一句问题：

```text
Codex、OpenClaw 已经能写代码、用工具、完成任务。
为什么还需要 Morphz？
```

讲稿：

> Codex、OpenClaw 这样的产品已经证明，模型可以很好地完成一次任务。Morphz 不是为了再做一个工具更多的助手。它针对的是 Agent 从“完成一次任务”走向“持续承担责任”以后出现的状态问题：它跨会话、跨工作线程、跨机器运行时，什么仍然是当前事实，谁提交了它，它取代了什么，以及哪些认知可以进入真实行动。

随后指向封面副标题：

> 所以我们的技术路线是 Structured Context：让 Observation 不只沉入聊天记录，而是成为 Agent 可以主动学习、修订并在多个工作线程中安全使用的认知状态。

表达纪律：

- 不评价外部产品“没有记忆”或“不能并发”；
- 不比较模型能力；
- 把差异限定为 Morphz 选择解决的系统层问题。

## 4. Slide 2：messages list 与 Structured Context（00:25–01:30）

视觉结构：

```text
典型消息连续性                         Morphz

[m1][m2][m3]...[mn]                  Messages / Observations
        ↓ 找回/摘要                            ↓ 认知求值
  模型重新推断当前状态                 Structured Context
                                      ├─ 可寻址对象
                                      ├─ 当前值 / 历史值
                                      ├─ 来源 / Principal
                                      └─ revision / supersedes
                                               ↓
                                      Runtime 验证后的行动
```

讲稿：

> 消息列表很适合对话，也可以持久化、检索和摘要。但当 Agent 长期运行，消息既是事件记录，又被迫承担当前状态、来源、版本和任务边界。模型每次都要从文本里重新回答“现在到底是什么”。Morphz 把 Structured Context 提升为第一等认知状态：对象可以被寻址、修订，保留来源和取代关系，并持续参与下一轮求值。
>
> 这不意味着结构化一定更省 Token 或一定更快——那要用数据回答。它首先改变的是状态语义：历史仍然是历史，当前状态有明确身份，认知结果可以被 Runtime 验证后进入行动。

必须避免：

- “Context 就是 JSON/数据库”；
- “有结构化格式所以天然支持并发”；
- 未出结果前说“成本降低 X%”或“速度提升 X 倍”。

## 5. Slide 3：同一个 Agent 的多入口与多工作线程（01:30–02:25）

视觉结构：

```text
Principal A ─ Session A ─┐
                         ├─ 一个 Agent Context / Shared Mind
Principal B ─ Session B ─┘          │
                              Runtime / Scheduler
                              ├─ Thread: release
                              ├─ Thread: compliance
                              └─ Thread: customer
```

讲稿：

> Session 是 Agent 与人或系统建立连接的边界，不是 Agent 的大脑；Principal 标识当前参与主体。多个 Session 可以挂载同一个长期 Context，因此负责人、员工、客户和系统不需要各自养一份彼此割裂的公司记忆。
>
> 但 Shared Mind 不等于无差别数据共享。Runtime 可以依据 Principal、Session、权限和当前任务，只投影需要的 Context 子集，并限制每个主体可以提交或修订哪些对象；共享的是同一个权威认知域，不是让所有人看到整份公司认知。
>
> 与此同时，发布、合规和客户事务不能混成一条思维链。Structured Context 提供共享且可修订的认知状态，Runtime 和 Scheduler 负责工作线程的因果隔离、调度和结果路由。这是系统协作，不是某种数据格式单独带来的并发能力。

术语纪律：

- 使用“多个 Session 挂载/访问同一个 Context”；
- 禁止说“共享 Session”；
- 使用“按 Principal/Session 投影 Context 子集”，禁止把 Shared Mind 表述成所有主体共享全部数据和修改权；
- 不把 Thread、Session、Principal 合并成同一个概念；
- 不把每个 Thread 包装成一个新的永久 Agent。

## 6. Slide 4：Cloud Native Agent（02:25–03:10）

视觉结构：

```text
Agent identity + Structured Context + durable storage
                         │
             replaceable stateless Runtime Worker
                         │
                 Execution Target
          local / SSH / edge / cloud / future device
```

讲稿：

> 在 Morphz 里，Agent 的身份、认知和持久存储不属于某一个进程，也不属于某一台电脑。Runtime Worker 可以替换和恢复；Execution Target 决定动作在哪个现实环境中发生。这样，一个 Agent 可以在云端继续认知，在用户授权的本地或边缘节点执行动作，而不是把“我是谁、我知道什么、我在哪运行”绑成一个进程。
>
> 重启恢复在这里不是一级创新标题，而是最直接的工程证据：Worker 消失以后，Agent 的认知和已经完成的工作不能一起消失。

公开边界：只讲分层与能力，不展开租约、fencing、身份锚定算法、内部数据库 schema 或未公开的 Edge 实现。

## 7. Slide 5：ORBIT-42 Hero Proof（03:10–03:45）

屏幕播放 30–35 秒冻结视频或 trace 动画：

```text
00–06s  release thread      approved v3 / 9443 / /v3/events
06–12s  compliance thread   45 days / Asia/Shanghai
12–18s  Runtime Worker      replaced → Agent state restored
18–25s  late archived v1    rejected as current
25–33s  commit_release      PASS · 7/7 exact parameters
```

旁白：

> 这是 AI 运营公司的一次发布。发布负责人和合规负责人从两个 Session 提交更新，中间 Worker 被替换，随后又到了一份时间更新、内容却已经作废的 v1。Morphz 没有选择“最后一句话”，而是让同一个长期 Context 中的当前状态进入发布动作。评分器不看它解释得像不像，只看真正提交的七个参数。

现场纪律：

- 不实时运行模型；
- 不逐阶段解释 fixture；
- 不展开 Message/Summary 的失败故事；
- 片尾显示 Run ID、`purpose=roadshow_demo`、协议版本和机械评分；
- 如果没有可审计冻结视频，使用静态 trace 动画，不用临时成功录屏冒充批次结果。

## 8. Slide 6：小规模效能证据（03:45–04:20）

结果表模板：

| Arm（同模型/工具/事件/预算） | 唯一正确最终行动 | 陈旧事实错误率 | 输入 Token / 正确完成 | 最终活动上下文 | 墙钟 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Persistent messages | `x/5` | `x/5` | `待填` | `待填` | `待填` |
| Summary/JSON memory | `x/5` | `x/5` | `待填` | `待填` | `待填` |
| Morphz structured Context | `x/5` | `x/5` | `待填` | `待填` | `待填` |

页脚固定：

```text
DEMO-001 · purpose=roadshow_demo · n=5/Arm
同条件演示批次；全部状态维护调用计费计时；非论文确认性实验
```

有数据时讲稿：

> 这不是论文结论，只是一组同条件的小规模产品探针。三组保留相同历史，使用同一个模型、工具、事件流和预算；摘要与 Context 维护都计入 Token 和时间。主指标只有一个：是否完成唯一正确的最终动作。Token、活动上下文和时间用来回答这种架构是否具备商业可行性，而不是预先宣称谁一定更省。

没有冻结数据时：删除整张结果页的数字，不展示 `0/5`、预测值或占位符；改成 15 秒实验设计卡片，并把节省的 20 秒留给 Morphz 001。

## 9. Slide 7：Morphz 001（04:20–05:00）

视觉结构：

```text
Morphz 001
一个长期存在的公司 Agent
一个 Company Context / Shared Mind
多个 Session · 多个 Company Matter · 多条工作线程
人、软件、服务商与现实执行目标
```

讲稿：

> 最终我想展示的不是一个多 Agent 团队，而是 Morphz 001：一个长期存在、能力完整的 Agent，拥有一个持续演化的 Company Context，通过不同 Session 与负责人、员工、客户、服务商和系统协作，并同时推进真实公司事务。
>
> 今天的 Morphz 已经完成核心 Runtime，并在用同一个 Agent 开发产品、组织长期写作和推进公司工作。它从 Observation 中修订认知，让过去形成的经验改变后续判断和 Runtime 行为。下一步不是让它多扮演几个角色，而是让一个 Agent 真正能够持续承担一家公司的认知与协调责任。

最后一句：

> 现有 Agent 让模型能够行动；Morphz 想让行动背后出现一个持续存在、可计算、可恢复的认知主体。

如果需要给入驻评审一个明确落点，可追加但不超过一句：

> 我希望在这里完成产品化、首批用户验证和算力/场景合作，让 Morphz 001 从内部运行模型走向真实企业服务。

## 10. 演示资产与兜底

### A. 主版本

- 七页或更少的静态 Deck；
- 一段 30–35 秒冻结 Hero Proof；
- 一张已冻结的小样本结果表；
- 全程不依赖现场网络、Provider 或 Runtime 健康。

### B. 现场备用

- Hero Proof 同版本本地 MP4；
- 每一关键帧的静态截图；
- 离线 HTML/PNG trace；
- 完整 DEMO-001 Run manifest、score 和 checksums，仅在问答时出示；
- 可启动的 Live 环境只用于会后交流，不进入五分钟主流程。

### C. 删除顺序

若排练超时，按以下顺序删减：

1. Slide 6 次指标解释；
2. Slide 4 Execution Target 示例枚举；
3. Slide 5 对恢复的口头解释；
4. Slide 7 入驻诉求。

不得删除开场问题、messages/Context 对照、系统协作边界或 Morphz 001 收口。

## 11. 问答预案

### Q1：这不就是 RAG 或 Memory 吗？

> RAG 解决从外部资料中找什么，摘要 Memory 解决保留一段压缩文本。Morphz 关心的是 Agent 当前认知状态如何拥有对象身份、来源、修订和取代关系，并在 Runtime 验证后进入调度和行动。它可以使用 RAG，但不把 RAG 当成认知状态本身。

### Q2：为什么 Codex/OpenClaw 不能做？

> 它们可以成为非常强的任务执行产品，也可能继续扩展类似能力。Morphz 的产品选择是把长期 Agent 的认知状态和 Runtime 语义作为系统中心，而不是把它附着在某一次对话或任务上。路演对比的是三种状态机制，不是贬低某个产品。

### Q3：Structured Context 为什么会更好？

> 先验上，它让当前状态、历史、来源和修订成为显式对象；是否因此更准确、更省 Token 或更快，需要在同模型、同工具、同预算下测量。DEMO-001 只给出小规模产品探针，不替代论文。

### Q3a：你说的自我学习，是不是自动训练模型？

> 不是。这里的学习发生在 Agent 的认知与行为层：主动吸收 Observation、修订 Structured Context，并让经验影响后续判断和 Runtime 行为。模型权重是否训练是另一条独立技术路线，当前路演不作此声明。

### Q4：这是不是多 Agent？

> 不是。多个 Session、Thread 或临时执行单元服务于同一个长期 Agent 和同一个 Shared Mind；只有出现真正独立的身份、所有者、责任或长期关系时，才需要新的永久 Agent。

### Q5：Agent 重启后怎么还在？

> Agent 身份、Context 和持久存储与可替换 Runtime Worker 分离。路演只展示恢复结果；具体租约、恢复和存储实现不在公开范围内。

## 12. 禁用表述

- “两个 Session 共享 Session”；
- “Structured Context 天然支持并发”；
- “Morphz 必然更省 Token/更快”；
- “Message Agent 没有持久历史”；
- “Morphz 是多个 Agent 组成的公司”；
- “这组 n=5 是论文结论”；
- “Codex/OpenClaw 没有记忆、不能并发或不能长期运行”；
- “重启恢复是 Morphz 的核心理论创新”。

## 13. 版本记录

| 版本 | 日期 | 状态 | 说明 |
| --- | --- | --- | --- |
| candidate-v1 | 2026-08-17 | superseded | 7 分钟、以完整五阶段实验演示为主体 |
| candidate-v2 | 2026-08-17 | candidate-review | 5 分钟、以架构回答为主体，DEMO-001 压缩为 Hero Proof，Morphz 001 收口 |
