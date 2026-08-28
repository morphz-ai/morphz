# Morphz Context-Owned Session Service v1

> 状态：v1 已实现；本文记录最初的 Session Service 边界。后续 Runtime 已增加 Frame 级 MVCC、Scheduler Kernel v2，以及 SQLite/PostgreSQL SharedLeases 多 Runtime 协调；生产级多节点故障切换仍不属于已验证能力。

> 当前实现索引：[Morphz Runtime 核心实现状态总览](./morphz_runtime_core_implementation_status_v1.md)

## 1. 已确定的对象层级

Morphz 当前采用以下所有权关系：

```text
Agent
└── Cognitive Context（认知上下文）
    ├── Mind（唯一、共享、持久化）
    ├── Session Directory（多个输入输出连接）
    └── Event History（所有 Session 的完整事件历史）
```

- `agent_id`：持续存在的 Agent 逻辑身份；
- `context_id`：认知状态的身份，拥有一个共享 Mind；
- `session_id`：Context 内的一条输入输出连接，负责消息进展与回复路由，不拥有 Mind；
- `active_session_id`：只属于一次模型求值，表示这次输入来源和输出目标，不是 Context 的全局唯一活动状态。

因此，同一个 Context 可以同时有多个活跃 Session。每条 Session 的消息分别触发一次求值，各自回复到原 Session；这些求值读取同一 Context Encoding，并共享其中的 Mind 与 Event History。

## 2. Context Encoding 与 Context Evaluation

Runtime 的职责是确定性地把当前认知状态物化为一个完整 SExpr，称为 **Context Encoding（上下文编码）**。它包含：

- 稳定的 Runtime/DSL 契约；
- 一个共享 `mind`；
- `session-directory`；
- 本次求值的 `kernel.active-session`、版本、压力、唤醒原因和预算；
- 来自本轮有界 Session Working Set、且带 `session` 来源标记的 `inbox` observation。

LLM 不是被动读取传统聊天历史，而是对该符号状态执行 **Context Evaluation（上下文求值）**：理解当前请求、利用或重组 Mind、调用物理工具，并把回复发往 active Session。

编码顺序专门考虑了模型服务的 prefix cache：

```text
protocol → shared mind → session directory → per-evaluation kernel → inbox
```

稳定契约与共享 Mind 位于高频变化字段之前。同一 Context 的多个 Session 在读取相同 Mind 版本时，可以复用更长的共同前缀。

## 3. 持久化结构与迁移

SQLite 包含：

- `cognitive_contexts`：Context 身份、所属 Agent、标题与生命周期；
- `sessions`：Session 身份、父 Session、所属 Context、标题和活动时间；
- `events.context_id` + `events.session_id`：同时保存认知归属和 IO 路由；
- `session_message_requests`：以 `(session_id, client_message_id)` 保护消息幂等。

旧数据库启动时会：

1. 为旧 Event 回填 `context_id=session_id`；
2. 从 Event 回填 Session Registry；
3. 从 Session 回填 Cognitive Context Registry。

迁移保留原有隔离语义，不会擅自把历史上独立的 Session 合并成一个共享 Mind。新建 Session 时必须显式挂载到一个已存在 Context。

## 4. 并发与事务边界

当前单进程并发边界如下：

- 同一 Session：用户消息属于一条有序 Dialogue Lane，每次输入形成独立 DialogueTurn Thread；首次模型决策串行，但旧回合一旦派生 Execution Thread，后续对话可与其工具执行并发；
- 不同 Session：可以并发调用模型，即使它们属于同一 Context；
- 读取 Context：多个求值可以并发读取同一个已提交版本；
- 修改 Mind：`context_tx` 使用 Context 级互斥锁串行提交；
- 并发事务：本文 v1 初始实现只检查全局 `base-version`；当前 Runtime 已升级为对象级 MVCC。先提交者仍确定全局物理顺序，后提交者仅在实际触碰的语义边界已变化时冲突，否则由 Runtime 安全自动 rebase，不会覆盖新状态。

Dialogue Lane 锁只覆盖同一 Session 用户消息的首次模型决策，并在执行物理工具前释放；工具执行和等待不持有该锁。每个 Thread 固定 `root_turn_id` 和根事件的 Event sequence：同根后续工具事件可见，更晚到达的其他用户回合不会倒灌进旧 Activation；终态以 `activation_id` 唯一提交。共享 Mind 的修改仍只在事务提交临界区加 Context 锁。完整模型见 [`morphz_session_thread_model_v1.md`](./morphz_session_thread_model_v1.md)。

每个模型请求只编译一个 active Session。多个 Session 即使共享同一个 Context，也各自发起独立且可并行的模型请求；它们共享已提交 Mind，但不会要求模型在一个响应里拆分多个回复。普通无工具文本投递给 active Session；`send_message` 向另一个 Session 写入可见 Assistant 消息但不激活它；`session_signal` 向已经存在的同 Agent Session 写入独立内部协调事件并激活其 DialogueTurn。Signal 跨 Context 时只桥接显式正文和来源标识，不隐式共享来源 Context 的 Inbox、Frame 或 Mind。

Session 仍由 Human/API/Dashboard 拥有创建、消息顺序与回复路由边界，Agent 不获得普通 `create_session` 工具。Dashboard 可用 `@Session` 为已有 Session 生成结构化稳定引用；引用只提供经过权限校验的 `session_id` 与目录元数据，不复制目标消息流，也不产生激活。Agent 的自主工作分解继续使用 Objective/Thread。

## 5. HTTP API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/contexts` | 列出 Cognitive Context |
| `POST` | `/api/contexts` | 创建 Cognitive Context |
| `GET` | `/api/contexts/:id/working-set` | 查看当前 Full/metadata-only Session 投影与排除原因 |
| `GET` | `/api/contexts/:id/scheduler` | 读取 Context 的权威 Scheduler Snapshot（Thread、Activation、Signal、Job、Schedule、Objective） |
| `GET` | `/api/sessions` | 列出 Session |
| `POST` | `/api/sessions` | 在指定 `context_id` 下创建 Session |
| `GET/PATCH` | `/api/sessions/:id` | 查询、改名、归档或恢复 Session |
| `POST` | `/api/sessions/:id/messages` | 向指定 Session 发送消息 |
| `GET` | `/api/sessions/:id/events` | 读取该 Session 的路由事件 |
| `GET` | `/api/sessions/:id/context` | 以该 Session 为 active route 获取完整共享 Context Encoding |
| `POST` | `/api/sessions/:id/cancel` | 取消该 Session 的当前执行 |
| `GET` | `/ws?session_id=:id` | 订阅指定 Session 的实时事件 |

消息事件、工具事件、进度、回复和 Context Inspect 均同时携带 `context_id` 与 `session_id`。前者用于认知归属，后者用于连接路由。

## 6. Dashboard

Dashboard 先选择 Cognitive Context，再选择其中的 Session。用户可以：

- 创建 Context；
- 在当前 Context 中创建、切换、改名、归档和恢复 Session；
- 查看当前 Session 的对话事件；
- 以该 Session 为 active route 查看共享 Mind、跨 Session Inbox、Pressure 和执行预算；
- 发送消息或取消该 Session 的当前执行。

## 7. 已验证性质

自动回归已经覆盖：

- 两个 Session 在同一 Context 内并发模型求值，最大并发数达到 2；
- 同一 Session 的新消息可在旧前台工具结束前完成独立求值和回复；
- 旧 Activation 的 Context Encoding 不包含后来并发到达的同 Session 用户消息；
- Tool Result 与后台 Task completion 始终继承原始 `root_turn_id`；
- 两条最终回复分别路由到各自 Session；
- 两条回复 Event 保持同一个 `context_id`；
- Session A 提交的 Mind Frame，Session B 的下一次 Context Encoding 可见；
- Session B 的 Encoding 同时包含来自 A、B 且有来源标记的 observation；
- 初版全局版本门禁中，两个 Session 基于相同版本并发提交 Context transaction 时，恰好一个成功、一个版本冲突；当前对象级 MVCC 回归进一步覆盖不同对象全部收敛、同一语义边界保持冲突；
- 父子 Session 的 parent 路由只按当前 Session 解析，不会形成自唤醒循环。

2026-07-12 另使用 `gemini-3-flash-agent` 对实际 Runtime HTTP 链路做了单样本探针：

1. 在 `context-real-shared` 下创建 `session-real-a` 与 `session-real-b`；
2. 两边分别收到只允许纯文本回复的路由请求，结果为 `A-ACK` 与 `B-ACK`，回复 Event 的 `context_id` 相同、`session_id` 各自正确；
3. A 通过一次 `context_tx` 创建 `verification_code` Frame，Mind 从 v0 提交到 v1；
4. B 在禁止调用任何工具的条件下，直接从共享 Mind 返回 A 写入的 `ORBIT-731`；
5. B 的 Context Encoding 显示 `active_session_id=session-real-b`，Session Directory 同时包含 A、B，Inbox 的 observation 来源同时包含 A、B。

该单样本证明 Gemini 能理解当前“共享认知、分路回复”的编码语义。它不替代更大规模的多模型、冲突事务和长期并发评测；真实并发重叠仍由上述确定性集成测试持续守护。

2026-07-15 又完成同 Session 真实重叠测试：A 的 `exec` 前台运行 25 秒，期间 B 到达并先回复 `B_FINAL_OK`；随后 A 工具结果写入并回复 `A_FINAL_OK`。Event History 顺序为 `call A < message B < reply B < result A < reply A`，两个 Reply 的 `root_turn_id` 各自正确。

## 8. 初版未实现项与当前进展

- Context Copy-on-Write、分支、合并和重置；
- 同一 Mind 的对象级 MVCC 与安全自动 rebase 已实现；同一对象上的语义合并仍由 Agent 基于最新状态决定；
- SQLite 多进程与 PostgreSQL 多 Runtime 的 CAS/lease 协调已实现；跨主机生产故障注入仍待验证；
- Context/Session 的权限与跨会话信息披露策略；
- 多个算力节点协同求值同一个 Session。

这些能力可以建立在当前 `Context → shared Mind + Sessions` 的层级之上，而不需要再次颠倒对象所有权。
