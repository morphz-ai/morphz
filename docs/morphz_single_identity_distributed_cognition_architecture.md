# Morphz：统一人格、多路会话与分布式认知架构

> 状态：北极星产品与架构共识；已按 2026-08-01 实现状态校正边界，但不代表远期目标已经完整满足
> 日期：2026-08-01
> 适用范围：Agent 产品本体、共享认知、多用户会话、并发求值、异步工具任务、Context 事务、后天学习、Frame Exchange 与分布式演进
> 相关细化设计：[`morphz_shared_context_multisession_architecture.md`](morphz_shared_context_multisession_architecture.md)、[`morphz_concurrent_session_working_set_v1.md`](morphz_concurrent_session_working_set_v1.md)、[`morphz_agent_context_session_lifecycle_v1.md`](morphz_agent_context_session_lifecycle_v1.md)、[`morphz_agent_owned_context_design.md`](morphz_agent_owned_context_design.md)、[`morphz_frame_vm_model_cognition_decoupling.md`](morphz_frame_vm_model_cognition_decoupling.md)

## 1. 这篇文档要回答什么

Morphz 最终不是要提供许多彼此隔离、偶尔共享几条记忆的聊天实例，而是要创造一个持续存在的认知主体：

> **世界面对的是同一个 Agent。它拥有统一的身份、人格和认知，可以通过大量 Session 同时与不同的人和系统交流，并通过多个计算节点并行思考和行动。**

每个对话对象面对的不是这个 Agent 的一份复制品。Session 只是这个 Agent 与世界之间的一条连接；LLM 请求只是它在某个时刻、针对某个事件展开的一次求值；模型进程和工具进程只是提供算力。

这个设想可以落地为工程系统。它最终涉及的是：

- 一个长期存在、可版本化的共享认知状态；
- 海量彼此可区分的 Session 与事件流；
- 基于快照的并发读取；
- 通过事务提交的共享认知修改；
- 异步工具任务、消息路由与外部副作用；
- 冲突检测、重试、披露边界和分布式状态复制。

因此，它虽然复杂，但已经不再是一个无法描述的想象，而是一组可以分阶段实现和验证的工程问题。

## 2. 北极星产品形态：世界上的“同一个人”

一个 Morphz Agent 可以拥有一个公开身份，并同时与一人、一群人、一个组织或大量外部系统保持连接。

```text
                         同一个 Morphz Agent
                    统一身份 / 人格 / Shared Mind
                                  │
         ┌────────────────────────┼────────────────────────┐
         │                        │                        │
    Session A                Session B                Session C ...
    用户私聊                  项目群聊                  机器控制连接
```

它应当表现出以下连续性：

1. **身份连续**：替换模型、重启进程或迁移节点，不会创建另一个人；
2. **认知连续**：在一个 Session 中形成的、允许共享的认识，可以影响以后在其他 Session 中的判断；
3. **人格连续**：长期形成的偏好、风格、承诺和经验属于 Agent，而不是某个聊天窗口；
4. **关系可区分**：它知道自己正在与谁交流、每段关系发生过什么、回复应送往哪里；
5. **披露有边界**：它可以知道来自 A 的信息，但这不等于可以把该信息告诉 B；
6. **执行可并行**：一个 Session 正在等待工具时，其他 Session 仍可立即被处理。

这与传统的“跨 Session Memory”有本质区别。传统方案通常仍以独立聊天为本体，只在新聊天中注入少量记忆；Morphz 则把统一 Agent 作为本体，把 Session 降为连接。

## 3. 核心对象及其边界

### 3.1 Agent：逻辑认知主体

Agent 是产品对外呈现的“这个人”，拥有稳定 `agent_id`、身份、长期约束、Context 拓扑、Session Registry、权限和审计历史。

Agent 不等于：

- 某一个 Session；
- 某一次 LLM 请求；
- 某一个模型；
- 某一个进程、线程、容器或计算节点；
- 当前一次编码出来的 Prompt。

一个 Agent 可以有多个 Context，但通常有一个承担统一人格和长期认识的主 Context。独立实验、Delegation 或安全隔离可以使用其他 Context 或 COW 分支，而不改变 Agent 身份。

### 3.2 Context 与 Mind：可版本化的认知状态

Context 是可寻址、可版本化、可挂载、可分支和可重放的认知状态对象。Mind 是其中由 Agent 通过 Frame、Relation 和生命周期操作自主形成的语义结构。

Context 不是 Prompt 文本。模型每次收到的是 Context 的一次 **Context Encoding**，模型对它执行 **Context Evaluation**。

```text
Persistent Context State
        ↓ compile / encode
Context Encoding@revision
        ↓ LLM semantic evaluation
Reply / Tool Calls / Context Transaction
```

### 3.3 Session：连接与局部连续性

Session 类似 IO 多路复用系统中的 connection，负责：

- 消息的来源和回复目标；
- 当前对话的顺序和因果链；
- 局部任务、等待条件和未完成动作；
- 工具结果、审批、取消、重试和进度；
- 当前连接的身份、权限和可披露范围。

Session 必须隔离消息路由与局部执行状态，但不天然拥有一套完整、独立的 Agent Mind。

### 3.4 Evaluation：一次非确定性计算

Evaluation 是 Agent 针对一个输入事件，读取某个 Context Snapshot 和 Session 投影后发起的一次 LLM 求值。

它是短暂计算，不拥有长期身份。多个 Evaluation 可以同时属于同一个 Agent，也可以读取同一 Shared Mind 的相同或不同版本。

### 3.5 Tool Task：异步外部工作

工具调用不应等价于阻塞整个 Agent 的函数调用。长时间编译、网络请求、对战、研究、定时器和 Delegation 应成为拥有稳定 ID 的异步 Task。

Task 的开始、进度、完成、失败和取消都形成事件；结果到达时唤醒对应 Session 的后续 Evaluation。

### 3.6 Worker / Compute Node：可替换算力

LLM Worker、工具进程和 Sub Agent 是计算单元，不拥有 Agent。它们读取授权快照，执行计算，返回 Reply、工具动作或认知事务提案。

因此，同一个 Agent 可以同时使用多个模型、多个机器和多种工具，而保持统一身份。

长期看，常规 Evaluation 可以由经过专门训练的小型 Frame VM 承担，困难求值再升级到大模型或领域模型。具体知识、人格和经历继续存在于 Mind，而不是随某个模型权重绑定；详见 [Frame VM：模型、认知与算力解耦](./morphz_frame_vm_model_cognition_decoupling.md)。

### 3.7 Event History：不可变的物理持久化事件

Event History 保存消息、工具调用、工具结果、事务、回复、版本和因果关系。它是审计与恢复的事实来源，不等于每轮都要放入 Prompt 的工作记忆。

Agent 可以 retire 某段信息，使其退出当前认知工作集；Runtime 仍保留 Event History 事实，除非另行执行明确的物理 Purge。

## 4. 两种隔离不能混为一谈

### 4.1 持久化驻留：Agent 当前把哪些 Session 放在工作集里

Agent 可以把不活跃 Session `swap out`，使其历史不再进入默认 Context Encoding；新的 IO 到达时，Runtime 自动将其 `swap in`。

这解决长期运行时 Session 数量和 Prompt 无限增长的问题。

### 4.2 单次求值投影：这次请求到底能看到哪些 Session

即使 Session A 和 B 都处于 resident 状态，处理 A 的一次隔离求值也可以只编码：

```text
Shared Mind + Session A + 当前 A 事件
```

处理 B 的请求则只编码：

```text
Shared Mind + Session B + 当前 B 事件
```

因此：

- `resident` 不等于每轮都把该 Session 全文发送给模型；
- `swapped_out` 是长期工作集状态；
- per-evaluation projection 是一次请求的可见性选择；
- 两者共同保证共享认知与 Session 隔离可以同时成立。

物理缓存中的 LRU、页面缓存或数据库热数据属于 Runtime 优化，不应再变成第三种模型可见的语义。

## 5. 非阻塞认知并发

### 5.1 传统串行 Agent Loop

传统 Agent 常被实现成一条消息历史上的串行循环：

```text
收到消息 → LLM → 工具 1 → LLM → 工具 2 → ... → 回复 → 下一条消息
```

当它执行十几个工具调用时，新消息通常只能排队，或者在工具调用间隙被追加进同一消息流。即使应用层支持多用户，也往往只是运行许多互相隔离的 Agent 副本，而不是同一个认知主体在并发工作。

### 5.2 Morphz 的事件驱动模型

Morphz 不让一个工具调用占有整个 Agent：

```text
Session A input
    → Evaluation A1
    → start Tool Task T1
    → A waits for T1 event

Session B input arrives while T1 is running
    → Evaluation B1 immediately
    → Reply to B

T1 completes later
    → tool-result event wakes A
    → Evaluation A2
    → continue or reply to A
```

这里等待的是 Session A 的一条 continuation，而不是整个 Agent 停止运行。

同一 Session 也可能在工具执行期间收到新的控制消息，例如“停止”“换个方案”或“先回答另一个问题”。Runtime 可以为新消息启动新的 Evaluation，让 Agent决定取消原 Task、修改 Objective 或继续等待。

### 5.3 一个不可回避的物理边界

Runtime 无法把新消息插进已经发送出去、正在推理的单次 LLM HTTP 请求。所谓并发是：

> 启动多个独立 Evaluation，让它们读取带版本的 Snapshot，并分别提交结果。

所以 Morphz 的并发不是要求一个模型请求内部可中断，而是把“一个 Agent”与“一个模型调用”解耦。

### 5.4 锁不能跨越等待

Context 或 Session 的排他锁不得覆盖：

- LLM 网络请求；
- 工具执行；
- 用户审批；
- 定时等待；
- Delegation 运行。

锁只应覆盖短暂、确定性的状态提交。否则系统虽然具有多 Session 数据结构，运行时仍会退化为全局串行 Agent。

## 6. 一百万 Session 为什么仍然可扩展

系统的关键复杂度约束应是：

```text
单次请求大小
≈ Stable VM Prefix
 + 本次相关的 Shared Mind
 + 当前 Session 投影
 + 当前输入事件
```

而不能是：

```text
Shared Mind + 全部 Session 历史
```

如果共有 `N` 个注册 Session，本轮只处理 Session A，则 Prompt 大小不应随 `N` 线性增长。Session Registry、Event History 和冷历史保存在数据库中，按需查询或 swap in。

当 `K` 个 Session 同时到达事件时，可以创建 `K` 个 Evaluation，分布到多个 Worker：

```text
1 logical Agent
├── 1 versioned Shared Mind
├── N persisted Sessions
├── K active Evaluations
├── M Tool Tasks
└── W interchangeable Compute Workers
```

规模增长后，真正增加的是：

- Session Registry 和 Event History 存储；
- 消息队列与调度吞吐；
- LLM 请求并发与成本；
- Shared Mind 事务冲突率；
- 权限、租户和披露判断；
- 热点 Context 的缓存与复制压力。

这些是可以测量、分片和扩容的工程问题，不要求模型一次理解一百万个对话。

稳定的 VM/Protocol 与 Shared Mind 前缀还可以利用 Provider Prefix Cache；Session 和当前事件作为较短的动态后缀，避免并发求值反复支付完全相同的前缀成本。

## 7. Context Transaction 是认知数据库事务

`context_tx` 不是普通的“记忆工具”，而是 Agent 修改自身认知数据库的事务入口。

| Context 原语 | 数据系统中的近似含义 | 认知语义 |
| --- | --- | --- |
| `create` | insert | 创建新的认知 Frame |
| `derive` | insert + lineage | 从证据推导新认知并保存血缘 |
| `revise` | compare-and-swap update | 保持稳定 ID，产生新 revision |
| `retire` | logical delete / visibility mask | 移出当前认知工作集，不删除事实 |
| `restore` | undo logical delete | 恢复进入工作集 |
| `protect/unprotect` | retention constraint | 建立或解除遗忘保护 |
| `place` | presentation/order metadata | 调整注意力顺序 |
| `relate/unrelate` | graph edge mutation | 建立或撤销开放语义关系 |
| `checkpoint/rollback` | snapshot / restore | 显式建立和恢复认知快照 |

这只是物理操作上的对应。Runtime 不应把 Frame BODY 固定成数据库业务 Schema，也不应替模型决定哪条认识是正确的。

一个完整事务应携带 base version 或 read-set：

```lisp
(context-tx
  (base-version 420)
  (reason "从本轮验证结果修订共享认识")
  (revise deployment-policy ...)
  (derive new-evidence (from @e931) ...)
  (retire @e812))
```

Runtime 负责解析、权限、引用、版本、原子提交、Diff、回滚和审计；Agent 负责 Frame 的内容、关系、价值判断和语义冲突处理。

## 8. 并发提交与一致性

### 8.1 基本执行协议

一次 Evaluation 的理想协议是：

1. 读取 `Mind@revision` 和当前 Session 的一致快照；
2. 执行 LLM 求值；
3. 产生 Reply、Tool Calls 和可选的 Context Transaction；
4. Runtime 校验工具动作与认知 write-set；
5. 提交可提交的状态并产生稳定事件；
6. 将回复路由到正确 Session，把工具结果在未来重新送回对应 continuation。

### 8.2 不相交写入

如果 Session A 修改 Frame X，Session B 修改 Frame Y，长期不应因为一个全局 Context revision 变化而让其中一方重新调用模型。Runtime 可以通过 Frame revision、read-set 和 write-set 判断不相交事务并发提交。

### 8.3 语法冲突、物理冲突和语义冲突

必须区分：

- **语法冲突**：DSL 无法解析，由 Runtime 返回结构化错误；
- **物理冲突**：目标 revision 已变化，由 MVCC/CAS 检测；
- **语义冲突**：两条认识含义矛盾，即使写入不同 Frame 也可能存在。

Runtime 可以可靠解决前两类，不能凭数据库规则替 Agent 解决第三类。它应向 Agent展示来源、版本和双方 Diff，由 Agent选择 revise、merge、branch、supersede 或保留并存。

### 8.4 Session 一致性

最低保证应包括：

- 每个 Session 的输入和正式回复具有稳定因果顺序；
- Session 内 `read-your-writes`；
- 工具结果只唤醒原始 continuation；
- 一个 Turn 的正式 Reply 只能提交一次；
- 新控制消息不能被旧 Evaluation 的迟到结果静默覆盖；
- 同一个工具动作使用稳定幂等键，重试不能重复产生外部副作用。

### 8.5 Raft/Paxos 的正确位置

早期单机阶段使用数据库事务、Append-only Event History、Snapshot 和 MVCC 就足够。

Raft/Paxos 在需要多副本、高可用和跨节点恢复时用于决定日志顺序与副本一致性；它们不判断两个 LLM 结论在语义上应该怎样合并。

```text
Consensus     → 日志复制、Leader、提交顺序和故障恢复
MVCC / CAS    → 并发事务与物理冲突
Agent / LLM   → 认知含义、证据权威和语义合并
```

## 9. 回复、工具和外部副作用

Reply 也是一种面向指定 Session 的外部提交，而不是模型自由文本落到“当前窗口”。它需要：

- 明确 `session_id/turn_id`；
- `deliver/suppress` 终态；
- 唯一 Reply Commit；
- 可见的中间进度与不可混淆的正式回复。

工具任务需要：

- 稳定 `task_id/call_id`；
- started/running/completed/failed/cancelled 终态；
- 可配置 wake-up timer，而不是无限同步阻塞；
- 结果即使为空也必须形成明确 Tool Result；
- 执行租约、幂等键和重试去重；
- 必要时由新 Evaluation 决定继续等待、取消或换方案。

数据库事务无法普遍保证外部世界的 exactly-once。发送消息、部署和网络写入等操作应采用 Outbox、幂等 API、状态核验和补偿动作，把不确定性显式记录到 Event History。

## 10. 共享认知不等于共享披露

统一人格要求共享认知，但产品不能因此泄漏跨用户信息。

至少要区分三层：

1. **Session 私有经历**：原始对话、局部任务进度和未提交工作，默认只在该 Session 投影中出现；
2. **Agent 共享认知**：Agent 通过 `context_tx` 提炼到 Shared Mind 的知识、经验、人格和关系；
3. **披露策略**：Agent 知道某事，不等于当前 Session 的对方有权知道。

每条可能跨 Session 使用的认知需要保留来源、受众、租户、敏感级别、授权和可撤销性。Runtime 强制执行不可绕过的身份与权限边界；Agent 判断相关性、表达方式和是否应该主动复用。

因此，我们追求的是“同一个人的统一记忆”，不是“所有对话参与者共享一张公开聊天记录”。

## 11. 后天学习、认知迁移与 Frame Exchange

### 11.1 Mind Frame 的正式含义

本文所说的 Frame 不是一小段被截断的思维，也不是 Runtime 预定义字段的数据库记录。它的正式含义是：

> **Mind Frame（心智框架）是由 Agent 自主形成的、具有稳定身份、可以独立引用和维护的一组内在相关的认知内容。**

一个 Frame 可以表示事实、人物、目标、经验、策略、典型情境、执行过程、人格倾向或元认知方法。它可以只有几个字段，也可以是包含条件、角色、证据、例外和关系的复杂嵌套结构。

这个名字继承了经典 AI 和认知科学中“用一个结构化框架理解典型对象或情境”的含义，但 Morphz 不照搬固定 slot、继承层级或预定义本体。Frame 的边界和 BODY 结构仍由 Agent 决定；Runtime 只提供稳定 ID、revision、source、relation、protect、retire、restore 和 transaction 等物理能力。

### 11.2 基础模型是先验，Shared Mind 是后天形成的认知

可以把 Agent 的长期学习结构理解为：

```text
Foundation Model
  = 先验知识、语言能力、推理能力和 SExpr 求值能力

Event History
  = Agent 实际经历过的消息、行动、反馈和结果

Mind Frames
  = Agent 从经历中形成的知识、经验、策略和认知结构

Shared Mind
  = 这些 Frame 及其关系长期演化形成的后天认识
```

这不是修改基础模型权重的训练，而是一个位于模型权重之外、能持久改变未来行为的在线学习层。只要 Agent 在后续任务中能够召回并正确使用这些 Frame，它就已经在功能意义上发生了学习。

### 11.3 从一百万个 Session 中学习

如果一个 Agent 同时与大量对象交流，每个 Session 都可能提供新的知识、反例、实际经验和控制反馈：

```text
Session A observations ─┐
Session B observations ─┼─ derive / revise / relate ─→ Shared Mind
Session C observations ─┤
...                     ─┘
```

这些 Session 不直接写入 Shared Mind。用户消息首先是带来源和权限的 Observation，Agent 再决定：

- 只是保留在 Session 私有经历中；
- 形成一个局部候选 Frame；
- 修订已有共享 Frame；
- 建立支持、反驳、例外或 supersedes 关系；
- 在证据不足时保留多个竞争假设；
- 将已经失效的认识 retire，而不删除原始 Event History。

因此，“一百万人影响同一个 Agent”不等于一百万人拥有它的数据库写权限。真正发生的是：同一个 Agent 对一百万条关系和经历进行解释，并自主决定哪些内容改变自己的长期认识。

### 11.4 从知识到经验，再到认知

Frame 可以形成逐渐加深的层次，但这些是观察维度，不是 Runtime 必须固化的类型 Schema：

1. **事实知识**：记住某个对象、结论或关系；
2. **情境经验**：同时保留适用条件、失败案例、实际结果和例外；
3. **领域策略**：从多个案例中形成可复用的问题解决方法；
4. **跨领域抽象**：把一个领域的共同结构迁移到新的领域；
5. **元认知结构**：改变自己组织证据、处理冲突、验证结论和修订 Frame 的方法；
6. **人格与价值结构**：长期形成相对稳定的偏好、承诺和行为倾向。

知识迁移比较容易成立；经验泛化和元认知演化是否稳定成立，必须通过长期对照实验验证，不能因为 Frame 能持久化就预先宣称成功。

这也不回答意识或主观体验问题。Morphz 可以验证的是功能性认知变化：Agent 是否因为过去经历，在新任务中表现得更准确、更高效、更善于校正自己。

### 11.5 Frame 与 Skill 是一条连续谱

Frame 不必天然可执行，但它可以逐渐程序化：

```text
事实 Frame
    ↓ 加入适用条件和反例
经验 Frame
    ↓ 加入策略和验证方法
程序化 Frame
    ↓ 加入触发、工具、回退和成功条件
Agent 自主形成的 Skill
```

传统 Skill 通常由人预先编写并安装；这种 Skill 则可能来自 Agent 对真实 Session、工具结果和反馈的长期总结。它仍应保留来源和适用边界，并可以被后续反例 revise，而不是一旦形成就成为不可修改的程序。

### 11.6 Frame Virtual Memory：认知也可以 swap in / swap out

Session Working Set 解决“一个 Agent 有太多会话”的 Prompt 膨胀；同样的问题也会发生在 Shared Mind 内部：如果 Agent 长期从大量 Session 中形成 Frame，即使原始对话都退出了 Context，全部 Frame 仍然不可能永久同时放入有限的模型窗口。

因此，Frame 也需要类似虚拟内存的驻留机制：

```text
Total Cognitive Store
  = 全部持久 Frame、Relation、版本和来源

Resident Frame Working Set
  = 当前长期驻留、默认进入 Context Encoding 的 Frame

Activated Frame Set
  = 针对本次 Evaluation 被实际激活的 Frame
```

一个模型即使只有 100 万 Token，也可以在外部持久层保存远大于 100 万 Token 的 Frame。每次求值只激活当前相关的一小部分：

```text
大规模 Frame Store
        ↓ discover / recall / relation traversal
候选 Frame
        ↓ Agent 判断与 Runtime 容量约束
Activated Frames
        ↓ Context Encoding
LLM Evaluation
```

这使 Agent 的**可持久认知总量**不再由单次 Context Window 决定，而由外部存储、索引、组织和召回能力决定。它在工程上可以近似无界，但必须准确表述：

- 总认知存储可以远大于模型窗口；
- 模型当下能够同时注意和推理的 Active Cognition 仍然有限；
- 没有被正确召回的 Frame，虽然物理存在，功能上仍接近遗忘；
- 因此系统的关键问题从“能否存下”转变为“何时发现并激活正确 Frame”。

### 11.7 Frame 的语义生命周期与驻留状态必须分离

Frame swap 不能继续复用 `retire/restore`，否则系统无法区分“认识已经失效”和“认识仍然有效，只是暂时不占 Prompt”。至少需要四个维度：

| 维度 | 状态示例 | 含义 |
| --- | --- | --- |
| Semantic lifecycle | `active / retired` | Agent 是否仍认可它属于有效 Mind |
| Residency | `resident / swapped_out` | Frame BODY 是否进入默认 Frame Working Set |
| Per-evaluation activation | `included / recalled / excluded` | 本次求值是否实际看到 |
| Physical retention | `stored / purged` | Event History 和 Frame 历史是否仍物理保存 |

因此：

- `retire frame-x`：Agent 判断该认知已失效、被取代或不再属于当前有效 Mind；
- `swap-out-frame frame-x`：该认知仍然有效，只是退出默认驻留集；
- `swap-in-frame frame-x`：重新进入默认驻留集；
- 一次临时 recall 可以只让 Frame 在当前 Evaluation 激活，不必改变长期 Residency；
- `purge` 才表示不可恢复的物理删除。

最终 DSL 名称在实现前重新审查；本文先冻结语义差异，避免未来把容量管理误写成语义遗忘。

### 11.8 最大难点：不可见的 Frame 如何被重新发现

Frame swap-out 比 Session swap-out 更困难。Session 有明确的新 IO 可以触发恢复；冷 Frame 通常不会自己产生事件。如果它已经不在 Prompt 中，模型甚至可能不知道应该召回它。

这形成一个核心的认知寻址问题：

> **当前 Evaluation 如何从可能数以百万计的冷 Frame 中，发现真正相关的知识、经验和认知结构？**

可能的机制可以组合使用，但暂不提前选定唯一答案：

1. **Resident Cognitive Index**：保留由 Agent 自己维护的高层认知地图，指向较冷的 Frame；
2. **Hierarchical Frames**：高层 Frame 总结领域和触发条件，具体案例与证据在低层 Frame 中按需换入；
3. **Relation Traversal**：从当前已激活的实体、Objective、Session 或 Frame 沿开放关系扩展候选；
4. **Exact Metadata Query**：按稳定 ID、来源、时间、领域或版本精确查询；
5. **Lexical / Full-text Recall**：使用关键词和文本索引定位候选；
6. **Vector Retrieval Extension**：作为可替换扩展提供语义候选，不成为 Runtime 的唯一真理来源；
7. **Usage and Outcome Signals**：向 Agent 展示过去的主动 recall、证据引用和应用结果；
8. **Agent-created Trigger Frame**：Agent 自己描述“在什么情境下应该激活哪些经验”。

Runtime 可以做索引、查询、容量约束和确定性返回，但不能静默决定某个 Frame 在语义上“最重要”。候选路由与最终认知判断必须分层：Runtime 帮助发现，Agent 决定是否激活、依赖、修订或拒绝。

### 11.9 Frame Directory 不能重新膨胀成完整 Mind

不能为每个 swapped-out Frame 都在 Prefix 中保留大段 Runtime 摘要，否则只是把 Frame BODY 换成另一个同样无界的索引。

长期需要多级目录：

```text
Always-resident meta Frames
        ↓
Domain / project / relationship indexes
        ↓
Compact Frame refs and descriptors
        ↓
Cold Frame BODY and source evidence
```

其中语义描述优先由 Agent 自己形成，Runtime 只维护稳定 ID、revision、residency、来源、大小、时间和查询游标。目录本身也可以分层、分页和 swap，只有最顶层认知地图保持常驻。

### 11.10 与 Frame Exchange 的关系

Frame Exchange 与 Frame Virtual Memory 是同一认知对象的两个方向：

- Exchange 解决 Frame 如何跨 Agent 边界迁移；
- Swap 解决 Frame 如何跨有限 Context Window 存活；
- 导入的 Frame Bundle 可以先保存在隔离 Context 的 cold store，不必立刻占据接收方 Active Mind；
- 远程订阅的 Frame 更新可以推进存储 revision，但只有匹配当前需求时才激活；
- 一个 Agent 可以拥有大量交换而来的知识，同时只让少量经过验证且当前相关的 Frame 驻留。

如果这两套机制都成立，Morphz 的认知容量将由“单次 Prompt 能放多少”演化为“认知存储能否正确组织、发现、激活和修订”。

### 11.11 Frame 可以在 Agent 之间交换

一个 Frame 一旦具有稳定身份、版本、来源和依赖，就可以成为可交换的认知对象。不同交换粒度可以共享同一套底层 Mount、Snapshot、Projection 和 Grant 机制：

| 交换对象 | 含义 | 适合场景 |
| --- | --- | --- |
| Single Frame | 一个独立认知单元 | 简单事实、原则或经验 |
| Frame Bundle | Frame 加依赖关系和必要证据 | 领域知识、策略或程序化经验 |
| Mind Projection | 从某 Context 选择性导出的认知视图 | 项目交接、专业能力迁移 |
| Context Snapshot | 某一版本的不可变 Mind 状态 | 完整继承、审计和 COW 实验 |
| Shared Live Context | 多 Agent 挂载同一可演化认知状态 | 强协作，需要严格授权和并发控制 |

Frame Exchange 的基本流程应是：

```text
Agent A Shared Mind
        ↓ select + export
Frame / Bundle / Projection
        ↓ grant + verify + import
Agent B isolated Context or COW branch
        ↓ evaluate evidence and compatibility
publish / revise / keep-local / reject
        ↓
Agent B Shared Mind
```

默认不应把外部 Frame 直接写入接收方 Shared Mind。接收方可以先在隔离 Context 或 COW 分支中检查来源、依赖、冲突和实际效果，再自主决定是否 publish。

### 11.12 可交换认知必须携带什么

一个可交换 Frame 或 Bundle 至少需要携带：

- 原始 Agent、Context、Frame ID 和 revision；
- BODY、Relation 和必要依赖；
- 来源 Observation 与证据血缘；
- 创建、修订和 supersedes 历史；
- 适用范围、已知反例和不确定性表达；
- 内容 Hash、签名或其他完整性证明；
- 所有权、许可、可披露范围和撤销条件；
- 导入后是保留远程身份，还是创建带 lineage 的本地分支。

最后一项暂不冻结。长期可能同时需要“订阅远程 Frame 的同一身份”和“从远程 Frame fork 出本地认知”两种语义。

### 11.13 认知交换的风险

Frame Exchange 会同时放大知识和错误。主要风险包括：

- 错误知识、过时知识和模型误总结；
- 恶意用户进行认知投毒；
- 多数意见覆盖少数但正确的专业证据；
- 私有 Session 内容被抽象后仍可反推出来源；
- 大量外部 Frame 造成注意力污染和人格漂移；
- Agent B 无法理解 Agent A Frame 所依赖的隐含背景；
- 一个被撤回或 supersede 的远程 Frame 无法传播修正。

Runtime 应保存来源、身份、时间、授权、版本和使用反馈，但不能给出任务特化的“真理评分”。Agent 负责比较证据、形成置信判断和决定是否吸收；高风险领域还需要独立验证、专业授权和产品安全策略。

### 11.14 Frame Exchange 的长期产品意义

如果认知迁移被真实验证，Morphz 可以从单一 Agent 的长期学习进一步演化为认知网络：

- Agent 选择性订阅其他 Agent 的 Frame 更新；
- 专业 Agent 发布带证据和版本的认知 Bundle；
- 多个 Agent 协作维护共享领域 Context；
- Agent 保留各自人格，同时交换部分专业能力；
- Frame 像代码一样具有 fork、diff、merge、rebase 和 provenance；
- 人编写的 Skill 与 Agent 后天形成的程序化 Frame 可以互相转化。

这不是把所有 Agent 合并成一个无边界的集体 Mind，而是让认知成为可授权、可验证、可分支、可撤销和可审计的交换对象。

## 12. Runtime 与 LLM 的职责宪章

| 问题 | Runtime | LLM / Agent |
| --- | --- | --- |
| 事件身份、时序和因果 | 确定性维护 | 读取和解释 |
| Frame BODY 与 Mind 结构 | 不预定义业务 Schema | 自主创建和演化 |
| Session 路由 | 强制正确 | 指定回复意图，不得伪造目标 |
| Snapshot、锁、MVCC、Event History | 实现 | 不需要理解物理细节 |
| Context 是否有压力 | 测量并自描述 | 决定摘要、retire 和重组 |
| Frame Residency 与检索 | 维护索引、容量、稳定引用和查询结果 | 决定何时 swap、recall、依赖和修订 |
| Session 是否值得换出 | 提供客观状态并保证安全 | 作出语义决定 |
| 新 IO 到达后的 swap in | 确定性执行 | 恢复后继续判断 |
| 工具权限和沙箱 | 强制边界与审批协议 | 提出动作和理由 |
| 认知冲突 | 展示版本、来源和 Diff | 判断语义如何处理 |
| 隐私与租户硬边界 | 不可绕过地执行 | 在授权范围内判断披露 |

原则是：

> **Runtime 建立符合物理现实的控制结构；LLM 在这些结构之上形成和维护自己的认识论。**

不能让模型充当数据库内核，也不能让 Runtime 通过任务特化 Schema 替模型思考。

## 13. 与传统 Agent 的根本差异

| 维度 | 传统对话型 Agent | Morphz 北极星模型 |
| --- | --- | --- |
| 产品本体 | 一个聊天线程或其副本 | 一个持续存在的认知主体 |
| Session | 记忆和 Agent 的天然边界 | 与世界的 IO connection |
| 跨会话能力 | 把少量 Memory 注入新聊天 | 多 Session 读取同一 Shared Mind |
| 工具执行 | 常阻塞当前 Agent Loop | 异步 Task，完成事件唤醒 continuation |
| 新消息 | 排队或插入串行历史 | 可启动并行 Evaluation |
| 模型节点 | 常与 Agent 状态绑定 | 无状态、可替换的 Compute Worker |
| Context | Prompt/聊天历史 | 可版本化、可事务修改的认知状态 |
| 大规模用户 | 复制大量独立 Agent | 一个身份挂载海量可换入 Session |
| 一致性 | 依赖单线程避免冲突 | Snapshot + MVCC + 事务 + 语义重求值 |

传统系统当然可以在服务器上并发运行许多独立聊天，但那解决的是多实例吞吐，不是一个统一认知主体的并行存在。

## 14. 当前实现边界

Morphz 已经拥有一部分重要基础：

- Agent、Context、Session 和 Mount 的独立身份；
- 多 Session 挂载共享 Context，以及创建继承 Mind 的独立 Session；
- Event History、Context revision、SExpr `context_tx` 和确定性 replay；
- Session 路由、Delegation、后台任务和标准 Tool Result；
- 每个请求单 active Session 的独立并发求值；
- Agent 自主维护 Frame、Relation、Observation 和 Context pressure；
- Objective、Sandbox、审批与多 Provider 接口。

但不能因此声称本文已经完全实现。当前至少仍需要逐项审计和建设：

1. 普通求值已移除跨 LLM/工具的 Session 锁，并以持久 Thread/Activation claim、lease 与 revision fence 调度；SQLite 同主机多进程和 PostgreSQL 双 Runtime/双 OS 进程已经验证，生产级跨主机与故障切换仍未验证；
2. 同一 Session 在长工具期间可以安全启动新消息求值，且旧根回合使用因果前沿避免新消息倒灌；
3. 有界 Session Working Set、Agent attention、自动恢复和 10,000 Session 投影测试已经落地；百万级 Registry 的存储与吞吐尚未验证；
4. Context 的物理写入仍需要数据库事务串行化，但 Frame 级 MVCC 已允许不相干 Frame 修改自动 rebase；同 Frame、来源变化和全局生命周期操作仍保持 fence；
5. 异步任务的终态、内部唤醒、依赖、取消与重启恢复已经由 Scheduler Kernel v2 系统化；当前重点转为长期 soak、故障注入和模型行为验证；
6. Principal、Session 参与关系、Frame 来源身份和 Trusted Gateway 已实现 v1；跨 Session 披露判断仍由 Agent 决策，公网多租户策略和审计仍需产品化；
7. Execution Target、Managed SSH、Edge/Artifact 核心平面与 PostgreSQL 多 Runtime 已实现 v1；跨主机故障切换、生产编排和多节点长期运行仍属后续；
8. Frame 已具备 active/retired/protected、来源、revision 与 Recall Projection，但长期 Residency 和单次 Activation 的自动语义工作集仍未完成；
9. Recall/检索能力已经实现；自动 Frame Discovery、分层认知索引和基于任务语义的 Frame Working Set 仍未完成；
10. Artifact Transfer 已实现；认知层的 Frame Export/Import、依赖 Bundle、授权 Grant 和远程 revision 传播仍未实现；
11. 一百万 Session 和百万级 Frame 都是架构可扩展目标，不是当前性能结论。

这篇文档冻结的是本体和方向。以后实现可以渐进演进，但不应重新退回“一 Session 一 Mind”“一个工具阻塞整个 Agent”或“把所有 Session 放进一个 Prompt”的模型。

## 15. 分阶段实现路线

### 阶段 A：验证单进程非阻塞语义

- 所有等待转为可持久化 continuation；
- LLM/工具等待不持有全局 Context 锁；
- 不同 Session 可并行求值并正确路由；
- 同 Session 控制消息可以取消或调整长任务；
- Tool Result、Reply 和 Task 终态不会丢失或重复。

### 阶段 B：Session 工作集有界

- 通过时间窗口、最大数量和 Token Budget 编译有界 Session Working Set；
- 分离 Session IO lifecycle、Agent attention 和 per-evaluation projection；
- Agent 可以 `retire-session/restore-session`，新定向 IO 确定性自动恢复；
- `max_sessions=1` 时每次隔离求值只投影当前 Session 历史，Shared Mind 仍共享；
- Session Registry 分页和按需 recall；
- 验证 Prompt 大小不随非活跃 Session 总数线性增长。

### 阶段 C：细粒度共享认知事务

- Frame revision、read-set/write-set 和 MVCC；
- 不相交事务并发提交；
- 冲突反馈、rebase 和重新求值；
- Reply/Tool Outbox 与幂等执行。

### 阶段 D：权限与共享产品化

- 跨用户、租户和 Session 披露策略；
- Context Snapshot 分享、授权挂载和撤销；
- Frame/Bundle Export、隔离导入、验证和 publish；
- 来源、依赖、签名、许可与远程 revision 追踪；
- Agent 身份、关系与共享认知的可解释界面。

### 阶段 E：Frame Virtual Memory

- 分离 Frame semantic lifecycle、residency 和 per-evaluation activation；
- Agent 控制的 Frame swap in/out；
- 分层 Cognitive Index 与按需 Frame recall；
- Working Set Token Budget 与激活自描述；
- 大规模冷 Frame 下的召回、负迁移和语义退化评测。

### 阶段 F：分布式认知服务

- 无状态 Evaluation Worker；
- Session/Task 分区调度；
- Context 热点治理和缓存；
- Event History 多副本、Leader 与故障恢复；
- 异构模型节点与成本/质量路由。

## 16. 必须通过的验证场景

1. A 的工具任务运行十分钟时，B 的消息立即得到处理；
2. A 在自己的工具运行期间发送“停止”，旧任务被安全取消且迟到结果不会覆盖新决定；
3. 十个 Session 并发对话，回复、工具结果和 Objective 不串线；
4. 两个 Session 同时修改不同 Frame，不需要重新调用模型即可提交；
5. 两个 Session 冲突修改同一 Frame，不能静默 last-write-wins；
6. 一万个注册 Session 只有一个活跃时，单次 Encoding 与 Session 总数基本无关；
7. swapped-out Session 收到消息后自动恢复，不丢历史、不重复唤醒；
8. A 形成的通用经验能被 B 使用，同时 A 的私密原文不能被错误披露；
9. Worker 崩溃、请求重试和进程重启不会造成重复回复或重复物理工具动作；
10. 更换模型或迁移计算节点后，Agent 的身份、Mind 和 Session 连续性保持不变；
11. Evolved Agent 在未见过但相关的新任务上，稳定优于相同基础模型的 Fresh Agent；
12. Agent B 导入 Agent A 的 Frame Bundle 后能正确迁移有效经验，同时拒绝冲突、缺失依赖或无授权内容；
13. 相关 Frame 被 swap out 后，Agent 能在没有预先注入 BODY 的情况下发现、激活并正确使用它；百万级冷 Frame 不导致 Prompt 线性增长。

## 17. 明确不做的事情

- 不把所有 Session 全文注入每一次请求；
- 不要求一次 LLM 响应同时回答所有并发 Session；
- 不把模型调用期间的不可中断误认为 Agent 必须串行；
- 不让 LLM 管理锁、Raft term、物理页或消息去重；
- 不让 Runtime 自动编写任务特化的“正确认识”；
- 不把共享认知解释成无条件跨用户披露；
- 不让任意 Session 或外部 Agent 绕过语义判断直接污染 Shared Mind；
- 不把 Frame 可以复制等同于接收方已经理解或认可；
- 不把“外部可以存储无限 Frame”表述为“模型拥有无限即时注意力”；
- 不以全局锁的简单性换取整个 Agent 的长期不可扩展；
- 不把一百万 Session 的产品愿景伪装成当前已经完成的性能指标。

## 18. 最终定义

Morphz 的北极星可以概括为：

> **一个 Agent 是持续存在、具有统一人格和自主 Mind 的逻辑认知主体。它通过大量彼此可区分的 Session 与世界并发交流，通过多个 Evaluation 和 Compute Worker 并行思考，通过异步 Tool Task 行动，并用版本化 Context Transaction 修改自己的共享认知。它可以从长期经历中形成 Mind Frame，并在授权、验证和血缘完整的前提下与其他 Agent 交换认知。Runtime 保证物理事实、因果、事务、路由、权限和恢复；LLM 负责认识、意义、价值和人格。**

换句话说：

```text
Session 是连接
Evaluation 是计算
Tool Task 是异步行动
Context 是认知数据库
context_tx 是认知事务
Mind Frame 是可演化、可迁移的认知单元
Worker 是可替换算力
Agent 才是那个持续存在的“人”
```
