# Morphz 多 Session 自适应合并求值 v1

> 状态：已实现；确定性回归通过，Gemini 轻任务通过、重量任务未达到默认启用门槛
> Context Protocol：v10
> 范围：单进程、同一 Cognitive Context、近同时到达的用户消息或工具结果

## 1. 功能目标

同一个 Context 中的多个 Session 不仅共享 Mind，也可以在一个模型认知周期中被同时处理：

```text
Session A message ─┐
                   ├→ one Context Encoding → one LLM request → routed outputs/actions
Session B message ─┘
```

合并求值不是强制策略。显式开启后，Runtime 优先合并同时就绪的 Session；模型漏答、格式错误或路由含糊时，只把未处理项降级为原有的单 Session 求值。用户消息和工具结果都可成为 ready event；标准 Function Calling transcript 会按 Session 合并并保留原始 `session_id` 路由字段。

## 2. `session_output` 与 `context_tx` 的边界

给用户发送消息是一种外部 IO Function Calling：

```json
{
  "deliveries": [
    {"session_id": "A", "kind": "progress", "text": "正在查询"},
    {"session_id": "B", "kind": "final", "text": "任务已完成"}
  ]
}
```

- `session_output`：向 Session 发送 `progress` 或 `final`；不修改 Mind；
- `context_tx`：原子修改共享 Mind；不能向用户发送消息；
- 物理工具：继续使用模型熟悉的标准 Function Calling；batch 模式只增加必需的 `session_id` 路由字段，Runtime 校验后在调用真实工具前删除；
- 同一 Session 不能既 `final` 又调用工具；可以让 B 立即 final，同时让 A 调用工具或维护 Mind。

单 Session 模式不增加额外心智负担：仍以无工具纯文本作为 final reply，不暴露 `session_output` 工具。

## 3. Batch Context Encoding

Protocol v10 在 kernel 中区分：

```lisp
(evaluation-mode single)
(active-session A)
```

以及：

```lisp
(evaluation-mode batch)
(ready-sessions
  (session
    (id A)
    (work-item @e101)
    (input-preview "...")
    (wake ...)
    (turn-budget ...))
  (session
    (id B)
    (work-item @e102)
    (input-preview "...")
    (wake ...)
    (turn-budget ...)))
```

`work-item` 是本次待处理 Event 的稳定短引用。`input-preview` 是受 Context preview 上限约束的当前输入副本，用来避免模型只注意到 Inbox 中最后一条消息；完整 observation 仍只在共享 Inbox/Ledger 中维护。

## 4. 调度与精确降级

每个 Context 拥有一个消息 mailbox：

1. 第一条用户消息到达后开启短暂 coalescing window；
2. 窗口结束时，从不同 Session 各取一个最早 work item；
3. 达到两个以上 Session 时执行一次 batch evaluation；
4. 同一 Session 的后续消息保留在队列中，维持原有顺序；
5. 已 final 或已提交工具动作的 Session 标记为 handled；
6. 没有输出或动作的 Session 进入 fallback；
7. fallback 只重算遗漏项，已经交付的 Session 不重放。

同一 batch 中各 Session lane 在完成模型求值后并发执行：A 的长物理工具不会阻塞 B 的立即 final。Session 锁仍保证每条连接内部有序，Context 锁仍只串行化共享 Mind 的事务提交。

当前配置：

```toml
merged_evaluation_enabled = false
session_batch_coalesce_ms = 25
max_sessions_per_evaluation = 8
```

对应环境覆盖为：

- `MORPHZ_MERGED_EVALUATION_ENABLED`
- `MORPHZ_SESSION_BATCH_COALESCE_MS`
- `MORPHZ_MAX_SESSIONS_PER_EVALUATION`

工具结果唤醒与用户消息使用同一个 Context mailbox。两个以上 Session 的工具结果近同时就绪时，会合并标准 assistant/tool transcript 再次求值；只有一个 Session 就绪时仍直接走 single。Runtime 执行物理工具时会剥离 `session_id`，但在后续 transcript 中保留模型原始的带路由调用，避免示例反过来诱导模型漏写路由字段。

## 5. Runtime 审计

每次合并请求持久化两类控制事件，不进入 Agent Inbox：

- `runtime/batch_assistant_call`：模型原始正文、Function Calls、ready Sessions；
- `runtime/batch_evaluation`：handled Sessions、fallback Sessions、工具调用数和统一 attempt ID。

同一个 batch 交付的所有 Session 回复共享一个 `attempt_id`，因此可以区分“一次模型请求产生多条回复”和“多个独立模型请求”。

## 6. 确定性回归

自动测试覆盖：

1. A、B 一次模型请求分别得到 final；
2. batch 只回答 A 时，A 不重放，只独立重算 B；
3. B 立即 final，A 通过一次 `context_tx` 更新共享 Mind并在事务回执后 final；
4. A 调物理工具时，`session_id` 在执行前被剥离，工具结果只唤醒 A；
5. batch 执行期间取消 A，不影响 B 的 final；
6. 显式关闭 merged evaluation 后，A、B 恢复两个并发模型请求。
7. 两条工具结果再次合并到一个 follow-up 请求，transcript 保留各自 `session_id`；
8. follow-up batch 漏掉一条工具结果 lane 时，该 lane 强制进入 single fallback，不会被“已经提交给模型”误判为“已经处理”。

## 7. Gemini 实机结果

模型：`gemini-3-flash-agent`。

第一版只在 `ready-sessions` 中提供 wake 引用时，首个双 Session 样本只处理 B：

- handled：B；
- fallback：A；
- 最终 A、B 都得到正确回复，但共使用两次模型请求。

这验证了降级正确，也暴露出模型会偏向最后一条活跃 observation。

加入显式 `work-item + input-preview` 和逐项覆盖指令后：

- 4/4 个同条件双 Session batch 均一次覆盖 A、B；
- 8/8 条回复内容和 Session 路由正确；
- 4/4 个 batch 的 fallback 为空；
- 一组混合样本中，B 在 batch 内立即回复 `B-INSTANT`，A 同批提交一次共享 `context_tx`，事务成功后独立收口为 `A-STORED`；batch 对 A、B 均标记 handled，fallback 为空。

### 7.1 十 Session 轻量对话

在同一个 Context 下建立 10 个 Session，连续三轮近同时发送带唯一标记的轻量消息：

- 3/3 轮均各使用一次 batch request；
- 每轮 ready=10、handled=10、fallback=0；
- 30/30 回复内容和 Session 路由完全正确；
- 没有重复回复或跨 Session 串线。

轻量多路回复达到可用标准。

### 7.2 双 Session 重量编码

在同一个 Context 下同时运行两个彼此隔离的编码任务：Rust 路由规划器与 Python Feed Pipeline。模型需要反复读取、编辑、执行测试并收口。

Runtime 侧结果：

- 7 次 batch request 中，3 次完整处理两个 Session，4 次遗漏一个 Session；完整批次覆盖率 42.9%，lane 覆盖率 10/14（71.4%）；
- 4 次遗漏均只对缺失 Session 执行 single fallback，已处理 lane 没有重放；
- 总计 12 次模型请求，合并没有表现出相对分别求值的明确请求优势；
- Rust 只修改 `task_a_route_planner/src/lib.rs`，Python 只修改自身 `normalize.py` 与 `pipeline.py`，没有跨目录写入或回复串线；
- Rust 4/4 测试通过；Python 在 Agent 实际使用的 Python 3.14 环境中 4/4 通过；
- Python 正常交付 final，Rust 最后把伪 `context_tx` 调用文本作为普通 final，用户输出质量不合格。

测试期间还发现并修复了两个通用 Runtime 缺陷：一是 batch 已提交但未被模型处理的工具结果曾被 dedupe 错误跳过；二是执行工具时剥离的 `session_id` 曾同时从后续 transcript 丢失，诱导模型继续省略路由字段。两者均已有确定性回归。

结论：协议和降级安全性成立，轻对话有效，但当前 Gemini 在长工具链中无法稳定同时规划两条 lane。按照“重量场景不可用则恢复分别求值”的验收条件，`merged_evaluation_enabled` 默认设为 `false`；实现和 `MORPHZ_MERGED_EVALUATION_ENABLED=true` 保留，供后续模型与协议实验使用。
