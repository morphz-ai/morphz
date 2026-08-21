# Morphz Context Encoding 结构审计与验证计划 v1

> 状态：审计完成；首批两项低风险优化已进入工作树并通过 Context 回归。
>
> 日期：2026-08-19
>
> 基线源码：`270d50caf2f06136f30c8081c9c9364f43e6163c`

## 1. 目的

本文复核一份外部 AI 对 Morphz Context Encoding 的结构诊断。审计只回答三类问题：

1. 诊断描述的源码事实是否成立；
2. 建议是否保持现有语义、恢复能力和 Prefix Cache 血缘；
3. 哪些改动可以直接实施，哪些必须先做真实模型对照实验。

本文不依据某一份 Context 的业务内容判断 Frame 是否“应该存在”，也不把缩短 Prompt 作为唯一目标。
Morphz 的正确性、因果可恢复性和主体归属优先于 Token 数字。

## 2. 已确认的优秀结构

以下判断成立，后续重构必须保留：

- Observation 内容和因果身份是不可变 Event 投影；可变 protection、freshness、usage 等位于
  append-mostly Inbox 之后，普通状态变化不会击穿更早的缓存前缀；
- `freshness`、`usage` 已经按非默认值条件发射；
- `@eN` 是由 Event sequence 派生的稳定短引用，不与物理 Event ID 混为一体；
- `session-working-set.absence-semantics` 明确声明“未投影不等于不存在”；
- Context Attribution 已经能把完整候选 Prompt 的估算 Token 按 Frame、Observation、Session、
  history、tools 和 wrapper 分摊，且不冒充 Provider 精确计费数据。

## 3. 逐项复核

### 3.1 Context 事务规则重复：成立，但不能直接替换成不可解释指针

当前普通 Frame retirement 和 `revise` 的完整替换语义，确实同时出现在：

- `CONTEXT_OPERATIONS[*].meaning`；
- `protocol.context-tx-contract`；
- `kernel.frame-retirement-policy`；
- `context_tx` 工具 description/parameter description。

问题不只是 Token，而是多份手写文本可能漂移。外部建议的“每条规则只写一次”方向正确，
但简单让工具描述写成“见 protocol”需要先验证：Provider 可能强化工具 schema 的局部注意力，
删除局部约束后不一定仍能稳定生成合法事务。

建议：

1. 先让 protocol 和工具 schema 从同一组结构化规范生成，立即消除源码漂移；
2. 再做 A/B：完整工具说明 vs. 精简工具说明；
3. 只有合法事务率、一次提交成功率和维护收敛率不下降，才删除 Prompt 重复文本；
4. `kernel.frame-retirement-policy` 最终只保留本轮动态参数和状态，不再重述规范 prose。

结论：**值得吸收，但必须先统一生成源，再实验删除文本。**

### 3.2 Agent 看不到成本：部分成立

诊断说“没有任何 Frame 或 Observation 带体积信息”并不准确：Observation 已携带
`visible-chars` 与 `total-chars`，Kernel 也有整体 `context-pressure.estimated-tokens`；
Dashboard/inspect 还能看到 Context Attribution。真正缺少的是：

- Frame 没有局部成本信号；
- Agent 看不到跨 Frame/Observation 可比较的统一成本；
- Agent 看不到“哪些组件是当前主要成本来源”的紧凑摘要。

给每个 Frame 和 Observation 永久增加 `(weight N)` 并不一定最优：它会给每个条目增加固定税，
Observation 已经有字符数，而且权重是本地启发式，不是 Provider Token。

优先验证更紧凑的方案：只在 notice/critical pressure 时，在可变 Kernel 尾部显示 Top-K：

```lisp
(maintenance-cost
  (unit local-weight)
  (largest
    (component frame:foo 18240)
    (component @e162392 12110)))
```

这既给 Agent 可执行的相对成本信息，又不让数百个普通条目永久背负 metadata。

结论：**问题成立一半；先实验 pressure-only Top-K，不直接全量加 weight。**

### 3.3 SExpr 中存在 JSON 字符串飞地：成立，属于协议演进

工具结果进入 Event 的 `text` 后，Context 当前把它作为 SExpr atom 渲染。对于 JSON 结果会出现
双重转义，模型也不能按 Context SExpr 节点直接寻址其中字段。

但不能机械地把任意 JSON 改成 SExpr：

- JSON number、boolean、null、数组和重复/顺序语义必须确定性映射；
- 原始 stdout/stderr 仍必须是不可解释字符串；
- 已签名、哈希或由外部协议定义的 JSON 不能在转换后冒充原文；
- Recall 和旧 Event 重放必须继续工作。

推荐的长期信封：

```lisp
(tool-result
  (tool exec)
  (status succeeded)
  (data (exit-code 0) (artifact "..."))
  (output "raw stdout remains a string"))
```

`effective_boundary` 也不能简单提升为“当前 Target 常量”。它可能随请求权限、Secret、Sandbox
和授权状态变化。正确方向是内容寻址的不可变 boundary snapshot：Observation 引用 snapshot ID，
Context 在同一请求中只定义一次该 snapshot。

结论：**值得吸收，但必须作为版本化工具结果协议单独设计，不是局部字符串替换。**

### 3.4 `mind.relations` 全量渲染：成立；“只保留两端活跃”不成立

当前 renderer 对 `state.relations` 不做投影过滤。`supersedes` 同时会进入 Frame freshness，确有
重复；关系规模也可能随长期运行增长。

但将关系过滤为“主客体都在当前活跃投影”会损坏现有能力：退役 Frame 仍可通过 relation chain
召回，活跃 Frame 指向退役证据的边界关系也可能是必要导航信息。

推荐验证三层投影：

1. 活跃—活跃关系完整显示；
2. 跨越活跃边界的关系只显示一跳 frontier；
3. 退役—退役关系不进入普通 Prompt，只保留在 Recall 图中；
4. `supersedes` 只在 freshness 或 relations 中编码一次；
5. Kernel 提示完整关系图仍可 Recall，避免把投影误解成物理删除。

结论：**存在真实的无界增长问题，但外部给出的 active-only 过滤过度。**

### 3.5 终态 Thread `result_text` 无条件渲染：成立

`render_thread_scheduler` 当前只要 `result_text` 存在，就附带最多 640 字预览，不检查 lifecycle
或 delivery。已 `delivered` 的终态 Thread 通常已经有不可变交付 Event/Observation，因此再次显示
结果容易重复。

安全删除需要联合不变量，而不是只看 lifecycle：

- `delivery in {pending, deferred}`：必须保留；
- 非终态 Thread：按执行状态决定是否保留；
- `delivery = delivered`：只有存在 `delivery_event_id` 且该 Event 可恢复时才可省略；
- `delivery = none` 的失败/取消 Thread：错误摘要可能仍是唯一诊断，不应一律删除。

结论：**高置信低风险候选，但必须以交付 Event 不变量覆盖 SQLite/PostgreSQL 回归。**

### 3.6 Observation 默认状态重复：成立，是最接近纯削减的候选

当前每条 Observation 都发射：

- `protected false|true`；
- `residency.state active`；
- `residency.retrievable true|false`。

而 `to_observation` 当前对进入投影的 Observation 固定设置 `retrievable = true`，`active` 也由
“它出现在 Inbox”这一事实蕴含。默认 `protected=false` 同样可由 absence 表示。

可改为真正 overlay：

- 默认 Observation 不产生 `observation-state` 条目；
- 仅 protected、非默认 freshness/usage 或未来非默认 residency 时发射；
- protocol 明确 absence 等于默认值；
- 保持 observation-state 位于 Inbox 后的缓存顺序。

结论：**最适合第一批实现和精确渲染回归。**

### 3.7 Frame provenance 在单用户样本中重复：事实可能成立，删除建议不成立

某份单用户 Context 里所有 Frame 都是 `principal-default`，不能推出 production 中 provenance
是常量。Morphz 已支持多 Principal、跨 Session、跨 Context 明示协调；`formed_principal`、
`source_principals` 和 Session 来源正是防止主体串线的关键事实。

可以研究更紧凑的编码或局部默认继承，但不能以单用户样本为依据删除。任何压缩都必须覆盖：

- 多 Principal 同一 Session；
- 同 Principal 多 Session；
- 多来源 Frame；
- 未归属 legacy Frame；
- Trusted Gateway 与 SDK assertion。

结论：**不采纳直接删除。**

### 3.8 Execution Target 能力重复与 `online` 误导：部分成立

多个 Target 可能共享能力集合，可以用 capability-set 引用去重；但能力并非系统范围内必然相同。
Managed SSH 的持久 Target 是按需拨号，注册状态也不等于实时可达性。若 UI/Prompt 使用 `online`
让模型理解为健康探测成功，语义确实过强。

建议把概念拆开：

- `registry-state`: configured / disabled；
- `reachability`: unknown / recently-succeeded / recently-failed；
- `capability-set`: 内容寻址或稳定短 ID；
- 不因没有持续连接就声称 offline，也不因已配置就声称 online。

结论：**值得单独修订 Execution Target 语义，不混入首轮 Context 纯削减。**

## 4. 实施分期

### Phase A：先建立测量基线，不改变生产语义

对相同 Context snapshot 记录：

- 完整 Prompt Provider Token；
- 各顶层 SExpr section 的字节、local-weight、估算 Token 和占比；
- 最长公共 Prefix 位置与预计缓存失效边界；
- Frame、Observation、Relation、Thread、Target 数量；
- Context maintenance 的事务成功率、回合数和最终压缩率。

至少保存小型、长程、多 Principal、并发 Thread、交付恢复五类 fixture。

### Phase B：纯默认值与已交付重复项

1. Observation state overlay；
2. 已确认交付 Thread 的重复 result suppression；
3. protocol/tool 文本改为同一结构化规范生成，但暂不删除 Provider 可见信息。

### Phase C：需要真实模型 A/B 的投影策略

1. pressure-only Top-K 成本提示 vs. per-item weight vs. 无成本提示；
2. relation active + frontier 投影；
3. 精简 tool description；
4. capability-set 引用和 Target 可达性语义。

### Phase D：版本化工具结果协议

设计 JSON → SExpr canonical mapping、raw payload 保留、boundary snapshot、旧 Event 重放与
Provider 协议适配。单独迁移，不与前面的小型优化合并。

## 5. 验证门槛

每一阶段都必须同时满足：

| 维度 | 门槛 |
|---|---|
| 语义 | Context 事务合法率、一次提交成功率、Objective/Thread 收敛率不下降 |
| 恢复 | 重启后 pending/deferred delivery、Recall relation chain、旧 Event 重放不丢失 |
| 身份 | 多 Principal attribution 与称呼/偏好串用率不恶化 |
| 性能 | Prompt Token、序列化耗时、Context SQL 数量和 Prefix Cache 命中不恶化 |
| 可解释性 | Dashboard/inspect 仍能还原完整事实来源，估算不得伪装为 Provider 精确 Token |

## 6. 当前决策

这份外部诊断最值得吸收的不是“立刻删掉 8–10%”，而是三条更稳定的设计原则：

1. **规范应有单一生成源，Prompt 是否重复由实验决定；**
2. **默认值用 overlay，历史事实用不可变 Event，二者不要混写；**
3. **Agent 维护 Context 时需要成本信号，但应以最少的动态摘要提供，而不是给每项永久加税。**

首批建议实现 Observation overlay 和已交付 Thread result suppression；其余进入 Context
结构实验。工具输出 SExpr 化属于协议演进，不能伪装成普通 Token 优化。

## 7. 首批落地与验证结果

已实现：

1. 默认 Observation 不再发射恒定的 `protected=false`、`residency.active` 和
   `retrievable=true`；非默认状态继续以 overlay 显示；
2. `delivery=delivered` 且存在 `delivery_event_id` 的 Thread 不再在 scheduler 重复显示
   `result_text`；缺少 durable delivery Event 的 legacy 记录仍保留结果。

结构量化：旧默认 Observation state 的最小样例为 81 个 ASCII 字符；100 条完全默认的
Observation 至少减少约 8,100 字符。该数字是确定性的序列化字符数，不冒充 Provider Token。
每个已交付 Thread 另可减少最多 640 字的重复 result preview 及字段开销。

验证：

- `cargo test -p morphz orchestrator::context::tests::`：69/69 通过；
- `cargo test -p morphz`：完整测试通过（lib 877 passed / 6 ignored，另含 main 与 integration suites 全通过）；
- 新增默认 overlay 与 durable delivery replacement 回归；
- `cargo clippy -p morphz --lib --tests -- -D warnings`：通过；
- `cargo fmt --all` 与 `git diff --check`：通过。

尚未实施：关系投影、成本 Top-K、协议文本去重、工具结果 SExpr 化、Target 状态语义。它们继续
受 Phase C/D 的实验或协议设计门槛约束。
