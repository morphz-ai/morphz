# Morphz Agent / Context / Session Lifecycle 与 Delegation v1

> 状态：设计冻结，v1 已实现并完成确定性回归
> 日期：2026-07-13
> 目标：用统一 Context Mount 底层模型，提供可读的高层 Agent、Session 与 Sub Agent 操作

## 1. 设计结论

Morphz 的产品对象不是传统的 `Agent → 独立聊天记录`。它采用：

```text
Agent
├── Context（版本化认知状态）
├── Session（IO 与任务连续性）
├── Session Mount（Session 到可写 Context Head 的挂载）
└── Delegation / SubAgentRun（受托执行）
```

模型看到的是 Context Encoding；Session 和 Sub Agent 只决定本次求值挂载到哪个 Context、允许看到哪些来源以及结果返回哪里。

底层统一使用 Mount、Seed 和 Projection，但高层 API 保持人类可读：

| 高层操作 | 产品语义 |
| --- | --- |
| `create_session` | 在当前 Context 创建共享会话 |
| `create_independent_session` | 继承当前 Mind，创建隔离 Context 与初始 Session |
| `delegate` | 把任务和选择性认知交给 Sub Agent，结果返回父 Session |
| `create_agent` | 创建全新 Agent、空白 Root Context 与初始 Session |

`fork_session`、`clone_session` 和 `spawn_worker` 不作为高层术语。`fork` 容易暗示复制完整 Context 与已有 Session；`worker` 只描述算力，不能表达委派、认知继承和父 Session 的整合责任。

## 2. 三种 Session 创建语义

### 2.1 共享 Session

```text
Context Main
├── Session A
├── Session B
└── create_session → Session C
```

底层 Mount：

```json
{
  "type": "existing_context",
  "context_id": "context-main"
}
```

A、B、C 读取同一个 Mind 与 Context Ledger，分别维护消息顺序和回复路由。

### 2.2 独立 Session

```text
Context Main@42
├── Session A
└── Session B

Mind Seed from Main@42
          ↓
Context Independent@0
└── Session C
```

底层 Mount：

```json
{
  "type": "new_context",
  "seed": {
    "type": "mind_snapshot",
    "source_context_id": "context-main",
    "source_version": 42
  }
}
```

继承：

- Mind Frames 与自由格式 BODY；
- Frame Relations、顺序、revision；
- Frame 级 retired/protected 状态；
- 来源 Context、版本、Snapshot Hash 的审计血缘。

不继承：

- A、B 的 Session Directory 与原始消息；
- Inbox、Wake、Turn Budget；
- pending 工具、后台任务、取消和回复状态；
- Observation 级 retired/protected；
- 父 Context checkpoint 和可写执行现场。

新 Context Ledger 只从一个可重放的 `runtime/context_seeded` Genesis Event 开始。继承 Frame 的父 Observation 来源保存在 Seed 审计载荷中，不伪装成子 Context 的本地证据。

### 2.3 空白 Agent

```text
create_agent
  ├── Agent Record
  ├── blank Root Context@0
  └── initial Session
```

新 Agent 不继承旧 Agent 的 Mind、Context、Session、Ledger 或 Context 拓扑。模板、默认模型、工具权限和 Workspace 属于后续 Agent Profile 扩展，不应通过复制旧 Context 暗中获得。

## 3. Context Mount

Session 创建请求接受统一 `mount`：

```text
existing_context
new_blank_context
new_context_from_mind_snapshot
new_context_from_projection
shared_snapshot       (reserved)
shared_live_context   (reserved)
```

v1 实现前三项；Projection 先用于 `delegate` 的当前 Session 证据导入；外部共享只冻结类型与权限边界，不在 v1 开放无认证实时挂载。

Context Snapshot 是不可变状态，不能直接成为写入目标。Snapshot Mount 必须先物化一个新可写 Context Head。内部可以使用 COW，但 COW 是存储优化，不是用户原语。

Session v1 创建后 Mount 不可变。未来若需要把已有 Session 切换到另一个 Context，应增加带版本的 `SessionBindingGeneration`，不能静默改写历史 `context_id`。

## 4. Mind Seed 的确定性语义

Mind Seed 不是 LLM 生成的 `context_tx`，而是 Runtime 物理操作：

```text
source Context events
        ↓ deterministic replay
source MindState
        ↓ mind-only projection
seeded MindState@0
        ↓ append genesis event
target Context Ledger
```

投影规则：

1. Frame ID、BODY、revision 和顺序保留；
2. Frame `created_version/updated_version` 重置为子 Context v0；
3. 指向继承 Frame 的 source 保留；指向父 Observation 的 source 移入 Seed 审计血缘，不成为子 Context 可伪造的本地来源；
4. Relation 只保留两端都属于继承 Frame 的项，并把 created_version 重置为 0；
5. retired/protected 只保留 Frame ID；
6. checkpoint 不继承，因为它属于父 Context 的回滚历史；
7. Genesis Event 同时保存 source state、projected state、source/target hash，并在每次重放时重新验证投影。

Seed 之后首个 Agent `context_tx` 必须基于 `base-version 0`。

## 5. Delegation 与 SubAgentRun

高层工具名称为 `delegate`：

```json
{
  "task": "完成复杂编码任务",
  "success_when": "测试通过并返回报告"
}
```

默认值：

```json
{
  "context_scope": "current_session",
  "inherit_mind": true,
  "return_to": "current_session",
  "parent_write_access": false,
  "execution_mode": "isolated",
  "lifetime": "task"
}
```

假设 Main 有 A、B、C，C 调用 `delegate`：

```text
Context Main@42
├── Session A
├── Session B
└── Session C
       │
       │ delegate
       ▼
SubAgent Context@0
├── seeded shared Mind
├── imported evidence from Session C
└── SubAgentRun
       │
       │ delegation_completed
       ▼
Session C
       │
       │ parent evaluates result and optionally context_tx
       ▼
Context Main@43 → visible to A / B / C
```

Sub Agent 默认没有父 Context 写权限。它在独立 Context 中执行完整模型/工具循环；完成结果作为 `delegation_result` Tool Observation 返回 C。C 对结果负责，可以验证、拒绝、回复用户或提交 Main `context_tx`。

### 5.1 持久化实体

```text
Delegation
├── delegation_id
├── parent_agent_id
├── parent_context_id
├── parent_session_id
├── child_context_id
├── child_session_id
├── task / success_when
├── context_scope
├── status: queued | running | completed | failed | cancelled
├── result_event_id
└── timestamps
```

`SubAgentRun` 在 v1 中由持久化 child Session 承载执行连续性，但不暴露为普通用户聊天。后续可以拆成独立 Compute Run 表，而不改变 Delegation API。

### 5.2 回传契约

子 Session 的 final reply 不直接路由给用户。Runtime 把它转换为父 Session 的标准 Tool Result：

```json
{
  "delegation_id": "...",
  "status": "completed",
  "subagent_session_id": "...",
  "result": "...",
  "result_event_id": "..."
}
```

父 Session 被正常 Tool Output 唤醒。回传使用 `parent_context_id`，绝不能沿用 child Context，也不能把父 Session 的路由映射改写为 child Context。

## 6. 外部 Context 分享预留

分享必须通过可撤销 Grant，而不是知道 `context_id` 就能挂载：

```text
ContextShareGrant
├── owner_agent_id
├── grantee_agent_id
├── object: snapshot | live_context
├── permission: read | evaluate | write
├── visibility: mind_only | selected_sessions | full_context
├── expires_at
└── revoked_at
```

默认安全模式是 `snapshot + mind_only + recipient-owned Context`。实时共享 Context 和跨 Agent 写入必须显式授权，并在实现权限系统后再开放。

## 7. API v1

```text
POST /api/agents
POST /api/sessions
POST /api/sessions/independent
GET  /api/delegations
GET  /api/delegations/:id
POST /api/delegations/:id/cancel
```

`POST /api/sessions` 保持旧 `context_id` 兼容，同时接受 `mount`。`POST /api/sessions/independent` 是高层原子封装，不要求调用方理解 Seed Context ID。

Agent 创建响应返回：

```json
{
  "agent": {},
  "root_context": {},
  "initial_session": {}
}
```

独立 Session 创建响应返回：

```json
{
  "context": {},
  "session": {},
  "seed": {
    "source_context_id": "...",
    "source_version": 42,
    "snapshot_hash": "..."
  }
}
```

## 8. Runtime 不变量

1. 一个 Session 在一个 Binding Generation 内只挂载一个可写 Context Head；
2. 同 Context Session 共享 Mind/Ledger，回复仍按 Session 路由；
3. Mind Seed 不复制父 Session Directory、Inbox 或执行现场；
4. Seed/Projection 由 Runtime 确定性产生，LLM 不能伪造；
5. Delegate 默认只读父 Context，不能直接提交父 Context `context_tx`；
6. Delegation Result 必须返回父 Context/Session，并成为标准 Tool Observation；
7. 父 Session 决定是否把 Sub Agent 结果写入共享 Mind；
8. Agent、Context、Session、Delegation 的身份与生命周期由 Runtime 维护；
9. 外部共享必须经 Grant；
10. 所有操作可审计、可重启恢复；失败必须显式呈现，不能把未完成挂载伪装成成功。v1 通过创建前版本/ID 校验与 Agent Bootstrap 数据库事务消除可预见的半挂载；跨 Event Ledger 与 Registry 的完全原子提交留给统一 Unit-of-Work。

## 9. v1 验收

### create_session

- 新 Session 与 A/B 读取同一 Mind；
- A 写入 Frame 后新 Session 可见；
- 回复严格路由。

### create_independent_session

- Mind Frame/Relation/Frame 生命周期继承；
- A/B Session Directory 与 observation 不出现；
- 子 Context 修改不改变父 Context；
- 重启后 Seed 可确定性重放。

### create_agent

- Agent、Root Context、Initial Session 一次创建；
- Root Mind v0 为空；
- 不包含旧 Agent 来源；
- ID 冲突不产生第二套半成品。

### delegate

- C 委派后子 Context 只包含共享 Mind 与 C evidence；
- A/B evidence 不进入子 Context；
- 子 Agent 可执行多轮工具任务；
- final 转换为 C 的 delegation_result；
- C 被唤醒并可提交 Main `context_tx`；
- A/B 随后可见 Main 的新认知；
- 子 Context ID 永不覆盖父 Session 的路由映射。

## 10. 非 v1 范围

- 完整 Context Fork（包含已有 Session 与执行现场）；
- Context merge/rebase/publish 自动语义合并；
- 已有 Session 的在线 remount；
- 多节点 Delegation 调度；
- 外部实时共享与权限管理；
- Sub Agent 直接并发写父 Mind；
- Runtime 替模型判断 Sub Agent 结论是否正确。

## 11. v1 实现对应

### 11.1 持久化

- `agents`：Agent 身份、状态与 Root Context；
- `cognitive_contexts.seed_*`：Mind Seed 的来源 Context、版本、Hash 与投影类型；
- `session_mounts`：不可变 Binding Generation 与 `existing_context / new_blank_context / new_context_from_mind / delegation_projection` 挂载类型；
- `delegations`：父子路由、任务、上下文范围、状态与结果事件；
- `runtime/context_seeded`：可确定性重放并验证 Hash 的 Mind Genesis Event；
- `context/projected_observation`：委派时选定 Session 的证据副本。副本的物理路由属于 child Session，编码时显示原 `source_session_id`，因此不会污染父 Session 的事件查询。

### 11.2 高层入口

- Dashboard 可创建和选择 Agent；
- “+”在当前 Context 创建共享 Session；
- “独立会话”从当前 Context 的 Mind 生成隔离 Context；
- 模型使用标准 Function Calling 工具 `delegate(task, success_when?, context_scope?)`；
- Dashboard 显示当前 Session 的 Delegation 总数和运行数；REST API 可列出、读取和取消 Delegation。

旧 `spawn` 实现只保留为历史测试兼容面，默认工具注册表和 System Prompt 均不再暴露；新功能只使用 `delegate`。

### 11.3 已验证不变量

1. Mind Seed 继承 Frame、Relation 与 Frame 生命周期，不继承父 Session Directory/Observation，子 Context 修改不影响父 Context，重启可重放；
2. Agent Bootstrap 在 ID 冲突时整笔回滚，不产生孤立 Context 或 Session；
3. Session Mount 类型可从数据库审计，Delegation 状态与结果可跨重启读取；
4. C 委派的 child Context 能看到共享 Mind 与 C 的 evidence，看不到 A/B evidence；
5. child final 只唤醒 C 一次，C 可把验证后结论提交回 Main Mind，随后 A/B/C 均可见；
6. 投影事件不会出现在源 Session 的普通事件查询中；
7. REST 高层操作验证 Agent/Context 归属，显式跨 Agent 挂载会被拒绝。
