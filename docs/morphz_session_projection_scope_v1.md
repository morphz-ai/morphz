# Session Projection Scope v1（需求草案）

> 状态：需求草案；由官网项目（`~/Codes/morphz-ai-site`）发起，待主仓库评审后进入设计
> 更新时间：2026-07-20
> 适用范围：Session 级投影可见性属性、Working Set 编译过滤、公开 Agent 部署
> 相关文档：[`morphz_concurrent_session_working_set_v1.md`](morphz_concurrent_session_working_set_v1.md)（工作集机制）、
> [`morphz_session_service_v1.md`](morphz_session_service_v1.md)（Session Registry）、
> 网站侧依据：`morphz-ai-site/docs/public_agent_safety_wallet_and_scaling_v1.md` §3.1/§7.3

## 1. 背景与动机

公开 Agent 部署（官网）中，同一 Root Context 上会挂载大量分属不同真实用户的
Session。跨会话投影（当前 Working Set 会把窗口内其他 Session 的 Observation
投影进 Encoding）既是核心能力展示——同一个体同时与多人交谈并保持清醒——
也是隐私与 prompt injection 的直接传播路径（绕过 Mind 事务的来源、候选期与
回滚保护，当轮生效）。

网站产品决定把这个权衡交给用户：**每位用户可选择是否分享自己的会话投影**，
对等语义（分享才能看见）。这需要 Runtime 提供 Session 级投影可见性属性；
仅靠网关无法实现（投影发生在 Context Encoding 编译时）。

## 2. 需求语义

### 2.1 属性

Session 增加持久化属性：

```text
projection_scope: shared | private    （默认 shared，可随时变更）
```

- 属性属于 Runtime Reality（Registry 元数据），不依赖模型在 Frame 中自觉记录；
- 变更应产生可审计事件（建议记入 Ledger，标注操作来源为网关/所有者）。

### 2.2 Working Set 编译过滤

过滤规则取决于**本次求值 active session** 的属性：

```text
active = private  →  working set 候选 = { active }
active = shared   →  working set 候选 = { active } ∪ { s | s.projection_scope = shared }
```

- 现有时间窗（`MORPHZ_SESSION_ACTIVE_WINDOW`）、数量上限
  （`MORPHZ_SESSION_WORKING_SET_MAX`）与 Token Budget 在候选集之上继续生效；
- Shared Mind 与 Session Directory 不受影响：private 会话的求值仍然看到
  共享 Mind 和全部会话的目录条目（知道有多少连接存在），只是读不到其他
  会话的 Observation 原文；
- `retire-session/restore-session` 语义不变，作用于过滤后的候选集。

### 2.3 生效时机

- 属性按**每轮求值时的当前值**计算 → 切换即时生效且对历史回溯：
  用户关闭分享后，其历史 Observation 立即退出他人投影；
- 已由 Agent 派生进 Shared Mind 的 Frame 不受影响（这是「关闭 ≠ 私密」
  的诚实边界，网站协议文案负责如实表述）。

### 2.4 API 面

- `create_session` 支持指定初始 `projection_scope`；
- 提供属性变更接口（HTTP + CLI），仅 Session 所有者/网关凭证可调用；
- Session Registry 查询返回该属性；
- 工作集调试接口（`/api/contexts/:id/working-set`）标注每个候选被
  纳入/排除的原因（现有诊断的自然扩展）。

## 3. 不变量

1. 投影过滤是 Runtime 物理边界，不是模型行为约定；
2. private 只收窄「模型投影」层：Ledger 持久化、Shared Mind 共享、
   Agent 语义提炼均不受影响；
3. 对等性由过滤规则保证：不分享者也看不到他人（无搭便车）；
4. 属性变更可审计、可回放；
5. 与 Frame 级披露范围（safety v1 §7.3 的 `private | shared` 候选设计）
   正交：Session 层先行落地（只过滤投影、语义更简单），Frame 层后续。

## 4. 开放问题（评审时定）

1. 属性放 Session Registry 列，还是通用 Session 元数据机制的首个用例；
2. scope 变更事件的 Ledger event 类型与脱敏（公开流不得泄露谁切换了什么）；
3. `send_message`（Agent 主动跨会话发消息）是否受 scope 约束——倾向不约束
   （那是披露决策，属 Frame/披露边界层），但需明确写入设计；
4. Prefix cache 影响：candidates 因 scope 过滤差异导致不同用户的 inbox 段
   分叉——本来就在高频变化段，预计影响有限，需实测确认；
5. 回归用例：见 [`morphz_concurrent_session_cognition_eval_v1.md`](morphz_concurrent_session_cognition_eval_v1.md)
   的 scope 混合 arm。
