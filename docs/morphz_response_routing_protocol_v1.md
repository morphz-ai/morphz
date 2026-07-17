# Morphz 单 Session 求值与响应路由协议 v1

> 状态：已实现
>
> 当前 Context Protocol：v20（本响应语义自 v16 起生效）
>
> 日期：2026-07-17

## 1. 决策

一次模型请求只求值一个 `kernel.active-session`。多个 Session 可以共享同一个 Cognitive Context 和 Mind，也可以并行调用同一个模型，但 Runtime 不再把多个 ready Session 合并进一次请求。

原因不是模型绝对无法同时回复多个 Session，而是这种批处理把性能优化变成了响应正确性的前提：模型可能遗漏某条 lane，工具结果、流式正文和最终交付也必须额外拆分路由。独立求值保留共享认知和并发能力，同时让一次模型响应天然只有一个正文目标。

## 2. 三种输出语义

### 2.1 当前 Session：普通文本

当响应没有任何工具调用且正文非空时，正文就是当前 active Session 的最终响应：

- Provider 的真实文本 delta 可以立即流式显示；
- 完整响应成功结束后，Runtime 将它提交为 `chat/reply`；
- 它只结束当前 Evaluation，不代表 First-Class Objective 已完成；
- 空正文不是终态。

SExpr VM 中的 `(reply content)` 是对这一行为的语义描述，不是名为 `reply` 的 Function Calling 工具。

### 2.2 显式静默：`no_reply`

模型确认当前 Evaluation 无需向 active Session 发送消息时，独占调用无参数工具 `no_reply`：

- 不能带普通正文；
- 不能与任何其他工具混用；
- 产生 `chat/no_reply` 审计事实；
- 立即结束当前 Evaluation，即使后台任务仍在运行；
- 不取消后台任务，也不把 Objective 标为完成。

后台任务完成或等待计时到达后，Runtime 投递新的 Thread Signal，并创建后继 Thread Activation 再次唤醒 Agent。

### 2.3 其他 Session：`send_message`

`send_message(session_id, content)` 用于向同一 Agent 的另一 Session 主动发送消息：

- 目标不能是当前 active Session；
- 目标必须存在、未归档并属于同一 Agent；
- 消息以 `chat/outbound_message` 持久化，并进入目标 Session 的 Observation；
- 工具回执返回当前 Evaluation，调用本身不是终态；
- 该消息不会伪造目标用户输入，也不会自动启动目标 Session 的模型求值。

## 3. 工具响应仍是中间状态

任何包含物理工具、`context_tx`、Objective 工具或 `send_message` 的模型响应都是中间状态。正文可以作为当前 active Session 的可见进度，但 Runtime 必须执行工具、用标准 tool result 参数把结果返回模型，然后继续求值，直到出现普通文本或独占 `no_reply`。

这保持了模型原生 Function Calling 训练所依赖的调用—回执结构，也避免工具已经执行但模型因看不到回执而重复调用。

## 4. 终态唯一性

终态唯一性以 `Thread Activation` 为边界，而不是以 `Root Turn` 为边界：

```text
evaluation_outcomes.work_item_id  PRIMARY KEY  # 物理字段保存 activation_id
```

同一个 Activation 重试或崩溃恢复时只能提交一次终态；同一个 Root Turn 后续由工具完成、Timer 或 Objective Supervisor 唤醒的新 Activation，则可以合法提交新的消息。数据库仍保留 `work_item_id` 作为迁移期物理字段名，但其领域语义已经是 `activation_id`。这修复了“等待时先静默/回复一次，后台完成后的最终通知被旧 Root Turn 唯一约束抑制”的问题。

Objective Evaluation 的终态归属同样绑定到具体 Activation，而不是只按 Session 推断。Session 级绑定只负责调度互斥；Objective 标识必须沿该 Activation 的工具结果和因果后继显式传播。同一 Session 的并发用户 Activation 即使先结束，也不能释放或冒领正在运行的 Objective Evaluation。

### 4.1 Delivery 的不可变触发快照

Delivery Activation 的可交付范围不是“它结束时 Session 中所有 pending 结果”，而是创建它的 `chat/thread_completion_ready` Event 中冻结的 `completed_thread_ids/result_event_ids`：

1. Context Encoding 只把该 Trigger Snapshot 内仍为 `pending/deferred` 的结果呈现为本轮待交付事实；
2. Activation Route 保存同一组 Thread ID；
3. 普通回复的 `covers` 与 `no_reply` 的 `defer_covers` 只能确认这组 ID；
4. 求值开始后新完成的 Thread 保持 pending，并由下一次 Delivery Activation 处理。

因此，Delivery 终态提交不能重新扫描 live pending 集合。这个边界防止一个较慢的旧模型请求误把它从未看见的新结果标记为已经交付。

## 5. 流式与持久化边界

Provider 适配器默认请求协议原生流，并把不同协议统一为 `Started/TextDelta/ReasoningSummaryDelta/ToolCallStarted/ToolArgumentsDelta/ToolCallCompleted/Usage/Completed/Failed`。`runtime/model_stream` 只是短暂展示状态；`chat/reply`、`chat/outbound_message`、工具结果和独立的模型推理摘要终态才是持久事实：

1. TUI 与 Dashboard 直接显示 Provider 实际产生的 `TextDelta`；Runtime 同时转发工具名和参数增量，TUI 可显示其详情，Dashboard 当前至少据此显示工具调用计数；
2. 分块粒度由模型服务和代理决定。如果上游只返回一个整块 delta，界面立即整块显示，不人为制造打字机效果；
3. 流中断或 Provider 报错时，未提交的 draft 不能冒充最终 Session 消息；
4. 每条瞬时流都携带 `attempt_id` 和稳定的 `work_item_id/thread_kind` 路由；协议纠错产生的新 Model Attempt 不会与同 Session 的其他并发求值混合；
5. Dashboard 按浏览器绘制帧合并增量，避免每个 token 重绘整棵 Markdown；
6. `runtime/model_stream` 不写 Ledger、不更新 Session 活跃时间；完整普通文本通过终态提交后，界面用持久事件原子替换 transient draft；
7. 瞬时流对每个 Runtime 订阅者采用非阻塞 best-effort 投递；慢订阅者队列满时可以丢弃 draft chunk，不能反向阻塞 Provider 请求。普通持久事件仍使用可靠等待投递；
8. Dashboard WebSocket 发现 broadcast gap 时必须断开并从持久快照重同步，不能继续展示缺少中段的正文。
9. `ReasoningSummaryDelta` 只承载 Provider 主动返回的可展示推理摘要，不是最终 assistant 正文，也不是 Runtime 向模型索取的隐藏思维链。Dashboard 由用户显式开关展开；它不进入 `Response.content`、Session 消息或 Context observation。
10. Runtime 在一次 Model Attempt 结束时把所有 `ReasoningSummaryDelta` 聚合为一条 `runtime/model_reasoning_summary` 事件写入 Ledger，不按 delta 频繁落盘。该事件携带 `context_id/session_id/attempt_id/work_item_id/thread_kind/text/complete`，使 Dashboard 和 SDK 在 Runtime 重启后仍可查看当时的推理摘要。这是独立的可观测轨道：既不更新 Session 活跃时间，也不会在下一轮被当成 Agent 可见上下文。

plain CLI 在等待当前求值时串行显示进度和最终持久回复，不承诺逐 delta 渲染正文；TUI 与 Dashboard 承担原生流展示。`no_reply` 结束等待后，后台 Activation 的工具活动、主动消息和最终回复仍会在输入提示符期间即时显示，不需要用户再发送一条消息来“带出”已经落账的结果。

## 6. 协议错误与熔断

以下响应不合法：空响应、`no_reply` 携带正文、多个 `no_reply`、`no_reply` 与其他工具混用。Runtime 返回明确的 Response Protocol Error，并最多纠正两次；仍失败时发布 `runtime/response_protocol_fused`，向当前 Session 提交安全失败说明，已经完成的文件修改、Mind 事务和 Ledger 事实保持不变。

## 7. 并发不变量

- 不同 Session 可并行求值，即使共享同一个 Context；
- 同一 Session 的 Dialogue Lane 对普通用户消息的首次求值保持顺序；它派生的 Execution、Objective 与 Delivery Activation 可以按调度策略并行；
- 每个请求始终只有一个 active Session；
- 共享 Mind 的 `context_tx` 仍按 Context 串行提交并检查 version；
- 响应路由不依赖 Context Working Set 中包含多少个 Session；
- `send_message` 是明确的跨 Session IO，不改变当前请求的 active Session。

由此，Morphz 同时保留“一个认知主体服务大量 Session”的共享能力、独立请求的正确性和 Provider 原生文本流。
