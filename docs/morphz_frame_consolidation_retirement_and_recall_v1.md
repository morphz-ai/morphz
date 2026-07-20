# Frame 归纳、整理期退役与可追溯召回实现设计 v1

> 状态：v1 工程实现与本地回归已经完成。SQLite 路径已通过完整测试；PostgreSQL 使用同一领域接口与存储契约，并在配置 `MORPHZ_TEST_POSTGRES_URL` 时执行真实后端一致性测试。长期真实模型行为仍属于后续评测，而不是 Runtime 功能缺口。
>
> 本文以 [Agent-Owned Context](./morphz_agent_owned_context_design.md)、[现实约束下的认识论 Context](./morphz_reality_constrained_epistemic_context.md) 和 [Frame VM 与模型认知解耦](./morphz_frame_vm_model_cognition_decoupling.md) 为上位设计，描述 Frame 从形成、归纳、延迟退役到链式召回的完整生命周期。

## 1. 背景

Morphz 允许模型通过 `context_tx` 自己维护 Mind：

- observation 是尚未完全消化的外部观察与执行证据；
- Frame 是模型主动形成的认知单元；
- relation 与 sources 表达 Frame 之间以及 Frame 与原始证据之间的血缘；
- `retire` 只把内容移出当前 Context Encoding，不删除 Ledger 中的事实；
- `restore` 可以把已经退役的内容重新换入当前 Context。

真实长任务暴露了一个问题：当前 `(retire ID...)` 对 observation 和 Frame 采用相同的立即生效语义。模型在 Context pressure 下可能直接退休刚形成不久的 Frame。这样虽然可以快速释放 Token，却会产生三个负面结果：

1. 用户刚刚教给 Agent、或者 Agent 刚刚总结出的认知很快消失；
2. 模型更倾向把 Frame 当作可丢弃的事实记录，而不是继续整理成更高级的概念；
3. 原始 Inbox 与已经付出认知成本形成的 Frame 没有生命周期差异。

与此同时，安全退休依赖可靠召回。当前 `recall(frame_id)` 可以读取活跃或已退役 Frame，但 `recall(query)` 只对 Ledger Event 的 JSON payload 和 topic 执行 `%LIKE% / %ILIKE%`：

- 中文连续字符串可以命中，但没有中文分词或 Unicode 子串索引；
- SQLite 和 PostgreSQL 都可能全表扫描；
- 没有 BM25、相似度或稳定相关性排序；
- Frame 不是一等查询结果，只能间接命中包含它的 Context transaction Event；
- SQL 没有提前应用 query limit，Runtime 可能读取全部匹配结果后再截取；
- 无法从一个高阶 Frame 有界、可分页地遍历完整来源链。

如果没有先解决召回，鼓励模型更积极地归纳和退休 Frame 会放大“内容还在，但模型找不到”的风险。

## 2. 核心目标

本设计要建立以下闭环：

```text
Inbox observation
        │ 消化、引用
        ▼
事实 Frame
        │ revise / derive / merge
        ▼
归纳 Frame
        │ 再次抽象
        ▼
高阶概念 Frame / 极小语义根
        │ relation + sources
        ▼
退休的底层 Frame 与 Ledger 证据
        │ recall(query / frame_id / depth)
        └──────────────────────────────► 按需换入
```

具体目标：

1. Context pressure 下优先退休已经消化、已被取代或可重新召回的 observation；
2. Frame 的普通退休不立即生效，而是进入一个可继续整理的窗口；
3. 模型在整理期内可以把 Frame 精简、合并或提升为 successor；
4. successor 已经承接旧认知时，旧 Frame 可以立即退休；
5. 空闲、Runtime 在线但没有认知活动、以及 Runtime 关闭期间都不推进整理期；
6. 已退休 Frame 的正文不进入活动 Context，但关系、血缘和 Ledger 永久可追溯；
7. 关键词搜索必须对中文可用，并且使用真正的索引而不是 `%LIKE%` 全表扫描；
8. `recall(frame_id, depth)` 可以从高阶概念沿关系与 sources 逐层找到底层 Frame 和原始证据；
9. Runtime 只提供物理状态、索引、时间顺序、版本和容量约束，不替模型生成总结或判断语义价值。

## 3. 非目标与不可破坏的原则

### 3.1 不做不可逆删除

本设计不引入 `purge`。任何退休操作都不得删除：

- Event Ledger；
- Frame 历史版本；
- relation；
- sources 血缘；
- restore 所需的持久状态。

`retired` 的含义始终是“移出当前注意力”，不是“物理删除”。

### 3.2 不让 Runtime 自动总结

Runtime 不生成 Frame body，不根据任务类型制作摘要，也不判断某段知识是否正确。模型仍然通过自由格式 SExpr body 决定：

- 哪些事实需要归纳；
- Frame 应该具有怎样的结构；
- 哪些 Frame 可以合并；
- successor 是否已经充分承接来源；
- 什么时候应该 restore。

### 3.3 不让所有活跃 Frame 自动衰减

活跃 Frame 不因为创建时间、墙钟时间或 Agent 空闲而自动退休。只有模型显式提交 `retire` 后，目标 Frame 才进入整理期。

### 3.4 不用墙钟时间驱动 Frame 退役

普通定时任务使用现实时间；Frame 整理期使用 Cognitive Context 的认知活动时钟。Runtime 关闭一周后重启，这一周不会让 Frame 更接近退休。

### 3.5 向量检索不是 v1 前置条件

v1 先建设可靠的关键词全文索引和关系遍历。向量检索可以作为未来 Extension，不进入本轮核心实现。

## 4. 领域概念

### 4.1 Observation

外部世界、用户、工具、调度器或其他 Agent 产生的客观事件在当前 Context 中的可见表示。Observation 原文保存在 Ledger，Context Encoding 中可能只显示 preview。

### 4.2 Frame

模型主动形成的认知单元。Frame body 保持自由格式；Runtime 只维护 ID、sources、revision、版本和生命周期。

### 4.3 Successor

一个仍然活跃、并由模型明确声明已经取代旧 Frame 的新 Frame。v1 中，能够触发旧 Frame 立即退休的 successor 必须同时满足：

1. successor 在事务最终状态中仍然 active；
2. 存在 `(relate SUCCESSOR supersedes TARGET)`；
3. successor 的 sources 包含 TARGET，或者 successor 是在同一事务中基于 TARGET derive 出来的。

Runtime 只校验这三个结构事实，不判断 successor 的语义是否真的充分。

### 4.4 Retiring / 整理期

模型已经表达退休意图，但 Frame 正文仍然留在当前 Context 中的状态。它不是等待删除，而是模型进一步完成以下动作的机会：

- revise 为更精简、更一般化的 Frame；
- 与其他 Frame 合并；
- derive 出更高级的 successor；
- 发现仍然有价值后恢复为普通 active；
- 什么也不做，等待认知活动窗口结束后退休。

### 4.5 Retired

Frame 正文不再进入活动 Context Encoding，但完整内容、sources、relation 和历史版本仍然存在，可以被搜索、recall 和 restore。

### 4.6 Cognitive Activity Clock / 认知活动时钟

每个 Cognitive Context 拥有一个持久、单调递增的逻辑计数器 `cognitive_tick`。它衡量该 Mind 接收了多少新的认知输入，而不是现实经过了多少秒。

选择 Context 级而不是进程级或 Worker 级时钟，原因是 Frame 属于 Cognitive Context：

- 同一 Context 下不同 Session 的新经验会共同影响共享 Mind；
- 另一个隔离 Context 的工作不应让当前 Context 的 Frame 衰减；
- 多 Worker 并发时不能重复累计同一认知事件；
- Runtime 离线或在线空闲都不会产生 tick。

## 5. 认知活动时钟语义

### 5.1 哪些输入推进 tick

一个新的、去重后的 Signal batch 被原子认领并建立 Activation 时，如果至少包含一种新的外部认知事实，则把当前 Context 的 `cognitive_tick` 增加一次：

- 用户消息；
- 工具执行结果；
- Schedule 到期 observation；
- Delegation 完成结果；
- 审批结果；
- 外部系统事件；
- 其他 Agent 发来的新消息或交付结果。

一次 Activation 即使原子认领多个同批 Signal，也只增加一个 tick，因为模型会在一次 Context 求值中共同处理它们。

### 5.2 哪些情况不推进 tick

- Runtime 在线但没有工作；
- Runtime 关闭；
- 相同 Signal 的重复投递；
- Provider 请求重试；
- reasoning-only continuation；
- Context transaction 成功或失败回执；
- Objective Supervisor 没有新事实的内部续推；
- Dashboard、CLI 或 SDK 的只读 inspect；
- Prefix Cache 命中或 Token 重新估算。

### 5.3 原子性

tick 增加必须与 Signal batch 的唯一认领使用同一持久化边界，或者使用稳定 Signal batch ID 做幂等去重。进程崩溃和多 Worker 竞争都不能让同一个认知输入增加多次 tick。

Context Encoding 应展示：

```lisp
(cognitive-clock
  (tick 142)
  (source signal-batch)
  (last-advanced-by activation-...))
```

## 6. Frame 生命周期状态机

```text
                         revise / restore / protect
                    ┌────────────────────────────────┐
                    │                                │
                    ▼                                │
                 active                              │
                    │                                │
                    │ retire，且没有安全 successor   │
                    ▼                                │
                 retiring ───────────────────────────┘
                    │
                    ├── successor 完成承接 ─────────► retired（立即）
                    │
                    └── cooling ticks 耗尽 ─────────► retired

                 retired ───── restore ─────────────► active
```

### 6.1 Observation retire

Observation 不进入整理期：

```text
active observation --retire--> retired observation
```

提交成功后立即退出 Inbox，并立即释放它在下一次 Context Encoding 中占用的 Token。

### 6.2 普通 Frame retire

没有 successor 的活跃 Frame：

```text
active frame --retire--> retiring frame
```

Runtime 记录退休意图，但本次 transaction 不把 Frame ID加入 `retired` 集合，因此不能声称已经释放容量。

### 6.3 Successor 立即收口

以下模式必须在一个 Context transaction 内原子生效：

```lisp
(context-tx
  (base-version 42)
  (reason "把重复的工具执行经验归纳为通用调试模型")

  (derive sandbox-debugging-model
    (from debug-case-a debug-case-b @e71 @e93)
    (knowledge
      "先区分沙箱拒绝、审批拒绝、能力缺失和外部服务失败。"))

  (relate sandbox-debugging-model supersedes debug-case-a)
  (relate sandbox-debugging-model supersedes debug-case-b)

  (retire @e71 @e93 debug-case-a debug-case-b))
```

事务最终状态满足 successor 约束后：

- observation 立即退休；
- 旧 Frame 立即退休；
- 新的高阶 Frame 保持 active；
- relation、sources 和完整 Ledger 历史保留。

这条快速路径是 Context critical 时整理 Mind 的主要手段，也是从机制上鼓励模型形成更高阶概念的关键。

### 6.4 整理期内 revise

如果模型直接 revise 一个 retiring Frame：

```lisp
(revise detailed-debug-case
  (knowledge "精简后的通用结论"))
```

则认为模型决定保留这个 ID，并把它自身提升为更精简的认知：

```text
retiring -> active
```

旧退休意图失效；Frame body 缩小带来的 Token 差额立即生效。

### 6.5 整理期内产生 successor

如果模型 derive 新 Frame 并声明其 supersedes retiring Frame，则在 transaction 最终校验阶段立即完成旧 Frame 退休，不再等待剩余 tick。模型不需要重复提交第二次 `retire`，因为原退休意图仍然存在。

### 6.6 Restore 与 Protect

- `restore` 对 retiring Frame：取消退休意图并恢复普通 active；
- `restore` 对 retired Frame：重新加入 active Context；
- `protect` 对 retiring Frame：取消退休意图并加入强保护；
- protected Frame 仍然拒绝 `retire`；
- `unprotect` 只解除保护，不自动进入 retiring。

### 6.7 重复 retire

对同一 retiring Frame 重复调用 `retire` 应返回已有状态，不重置或延长冷却窗口。这样可以避免模型因重复维护而让退休永远不生效。

## 7. 生命周期数据模型

在 Mind Projection 中增加：

```rust
pub struct FrameRetirement {
    pub frame_id: String,
    pub requested_frame_revision: u64,
    pub requested_mind_version: u64,
    pub requested_at_tick: u64,
    pub eligible_at_tick: u64,
    pub generation: u64,
    pub reason: String,
}

pub struct MindState {
    pub version: u64,
    pub frames: Vec<ContextFrame>,
    pub relations: Vec<ContextRelation>,
    pub retired: BTreeSet<String>,
    pub retiring: BTreeMap<String, FrameRetirement>,
    pub protected: BTreeSet<String>,
    pub checkpoints: Vec<MindCheckpoint>,
}
```

Context 元数据增加：

```rust
pub struct ContextCognitiveClock {
    pub context_id: String,
    pub tick: u64,
    pub last_signal_batch_id: Option<String>,
    pub revision: u64,
}
```

### 7.1 Fencing

整理期到期时，Runtime 必须在 Context 串行写边界内验证：

- `requested_frame_revision` 仍等于当前 Frame revision；
- `generation` 仍然是当前退休意图；
- Frame 没有被 protect；
- Frame 没有被 restore 或 revise；
- Context 的当前状态仍包含这个 retiring 记录。

任一条件不满足，旧到期动作成为 no-op，不能误退休新版本 Frame。

### 7.2 到期批处理

当新的认知输入推进 tick 时，Runtime 检查 `eligible_at_tick <= current_tick` 的退休意图。所有到期且 fencing 有效的 Frame 可以在同一个原子事务中退休。

无需人为限制同一 tick 退休多少 Frame。只要它们都经过显式退休、整理窗口和 revision 校验，同时退出 Context 没有语义问题。

因为离线和空闲不会推进 tick，本设计不需要为 Frame 退役创建墙钟 Timer；普通 `schedule_tx` 与 Frame 退役保持不同的时钟域。

## 8. 配置

建议增加：

```toml
[orchestrator.frame_retirement]
cooling_ticks = 8
```

`8` 只是第一轮实验起点，不是固定认知常数。最终默认值应通过长程测试确定。

第一版使用 Context 级统一 cooling ticks，避免模型为每个 Frame 任意设置 TTL 后绕过整理窗口。未来若有充分证据，可以增加更长的 Frame 级 retention hint；不能允许低于 Runtime 安全下限。

## 9. Context Encoding 与自描述契约

### 9.1 Frame 生命周期展示

```lisp
(frame
  (id debug-case-a)
  (revision 3)
  (lifecycle
    (state retiring)
    (requested-at-tick 138)
    (eligible-at-tick 146)
    (remaining-ticks 4)
    (reason "已有重复经验，等待进一步归纳"))
  (body ...))
```

### 9.2 压力维护候选

只在 warning / critical 或模型显式 inspect 时展示紧凑候选，避免持续增加 Prompt 和破坏稳定 Prefix：

```lisp
(maintenance-candidates
  (observation
    (ref @e42)
    (active-token-cost 1840)
    (retire-disposition immediate)
    (immediate-token-relief 1840)
    (absorbed-by project-state))

  (frame
    (id recent-debug-case)
    (active-token-cost 680)
    (retire-disposition organizing-window)
    (immediate-token-relief 0)
    (relief-when-retired 680)
    (remaining-ticks 6)))
```

这里的 `active-token-cost` 只计算目标 Frame 在活动 Context 中可移除的渲染块，不把仍会保留的关系索引成本混入其中。

### 9.3 自描述政策

协议必须明确告诉模型：

1. Observation retire 立即释放容量；
2. 普通 Frame retire 只进入整理期，当前释放量为 0；
3. 整理期的主要用途是 revise、merge、derive 和形成 successor；
4. successor 完整承接后，来源 Frame 可以立即退休；
5. Frame 数量本身不是退休理由，重复、失效、被取代和已经形成更高抽象才是整理理由；
6. critical 时如果 Inbox 清理不足，应精简 Frame 或建立 successor，而不是批量提交不能立即生效的普通 Frame retire；
7. 被退休的内容没有删除，可以通过关键词、Frame ID 和关系链召回。

## 10. Token 成本估算

### 10.1 目标

逐项 Token 估算用于比较操作的容量收益，不要求与 Provider 的隐藏 tokenizer 完全一致，但必须比字符数除常量更可靠，并且与整轮 pressure 计量采用同一口径。

### 10.2 计算顺序

1. 如果 Profile 配置了可用的本地 tokenizer，使用对应 tokenizer；
2. 否则使用一个统一的本地 tokenizer；
3. 对实际序列化后的 SExpr Frame / observation 块计数，而不是只计算 body；
4. 使用 Provider 返回的实际 prompt usage 对整轮估算比例做校准；
5. 核心路径不调用远程 countTokens 接口；
6. 所有数值明确标记为 estimate。

### 10.3 操作收益

```text
retire observation:
  immediate relief = observation active-token-cost

retire ordinary frame:
  immediate relief = 0
  eventual relief = frame active-token-cost

revise frame:
  committed relief = old rendered cost - new rendered cost

successor + retire source frames:
  committed relief = removed source blocks - added successor block
```

Context transaction 回执应返回提交后的实际估算差额，防止模型把“已申请退休”误认为“已经释放容量”。

## 11. Relation 与认知寻址

### 11.1 关系不能因退休而删除

relation 和 sources 是长期认知的寻址结构。Frame 正文退休后：

- relation 保留；
- sources 保留；
- successor 链保留；
- Ledger 证据保留；
- restore 能够恢复完整 Frame。

### 11.2 高阶语义根

模型可以把大量底层 Frame 逐步归纳为极小根节点：

```lisp
(frame
  (id memory/sandbox-permission))
```

只要 ID 具有最低限度的语义路由能力，并且关系图可以按需遍历，活动 Context 不需要携带全部底层知识。

如果 ID 完全不透明，例如 `frame_1784023412`，模型很难知道什么时候应该召回。Runtime 不强制业务命名，但协议应建议使用稳定、紧凑、具有语义的 Frame ID。

### 11.3 大规模关系图

当前阶段可以继续直接展示关系。未来关系达到很大规模时，不能删除关系，而应区分：

- 活跃 Frame 附近的关系：进入 Context Encoding；
- 其他关系：保存在可查询 Relation Projection；
- 完整历史：保存在 Ledger。

Agent 应继续通过 successor 归纳关系结构，Runtime 则保证任何未展开边都可被查询。

## 12. Recall 工具扩展

### 12.1 目标接口

保持 `event_id / frame_id / query` 三选一，扩展 Frame 遍历参数：

```json
{
  "frame_id": "memory/sandbox-permission",
  "depth": 2,
  "direction": "ancestors",
  "include_bodies": true,
  "include_events": false,
  "max_nodes": 64,
  "cursor": null
}
```

参数语义：

- `depth=0`：只读取目标 Frame；
- `depth=1`：目标 Frame 加直接 sources 和一跳 relation 邻居；
- `depth=N`：对 Frame sources 与 relation 做 N 跳有界遍历；
- `direction=ancestors`：沿 sources、derived-from、supersedes 的历史方向；
- `direction=descendants`：查找引用、派生或取代当前 Frame 的新节点；
- `direction=both`：双向遍历；
- `include_bodies`：是否返回 Frame body；
- `include_events`：是否展开 Event source 原文；默认只返回 Event ref 和 preview；
- `max_nodes`：防止高分支图一次撑爆 Context；
- `cursor`：继续读取尚未返回的稳定遍历结果。

第一版建议：

```text
max depth = 4
default max_nodes = 32
hard max_nodes = 128
```

例如：

```text
A ─┐
   ├─► C ─┐
B ─┘      ├─► E
D ────────┘
```

`recall(frame_id=E, depth=2, direction=ancestors)` 必须能够找到 A、B、C、D 和相关边。

### 12.2 遍历算法

- 使用 BFS 保证浅层关系优先；
- 每个节点只访问一次，必须检测环；
- 同深度按稳定 ID 或 relation created_version 排序；
- 先返回 Frame，再返回 Event 叶子；
- 到达 `max_nodes` 或字符预算后生成 cursor；
- cursor 包含稳定 frontier、访问集合摘要和查询参数签名，不能由模型猜测；
- 所有节点必须属于当前 Cognitive Context；
- 被 retire 不影响遍历资格。

### 12.3 Frame recall 返回值

即使 `depth=0`，也应返回：

```json
{
  "frame": { "id": "...", "body": "...", "sources": [] },
  "lifecycle": "retired",
  "inbound_relations": [],
  "outbound_relations": [],
  "truncated": false,
  "next_cursor": null
}
```

这使 Agent 能从任一命中节点继续链式寻找，而不依赖完整关系图始终常驻 Context。

## 13. 中文关键词全文检索

### 13.1 当前问题

当前实现：

```sql
-- SQLite
payload LIKE '%关键词%' OR topic LIKE '%关键词%'

-- PostgreSQL
payload::text ILIKE '%关键词%' OR topic ILIKE '%关键词%'
```

这只能称为连续子串扫描，不能称为工业可用的全文检索。

### 13.2 一等检索文档投影

增加统一的 Lexical Recall Projection：

```text
recall_documents
  context_id
  document_kind        event | frame
  document_id
  revision
  searchable_text
  retired
  updated_sequence
  state_hash
```

`searchable_text` 由 Runtime 确定性生成，包括：

- Frame ID；
- Frame body；
- Frame sources；
- inbound / outbound relation 类型与关联 ID；
- Event topic、actor 和可读正文；
- 用户消息；
- 工具输出；
- Context transaction 中产生的认知文本。

不能只索引原始 JSON，因为 JSON 键、转义和内部元数据会污染结果。

### 13.3 SQLite

首选 SQLite FTS5 trigram tokenizer：

- 支持中文连续文本和 Unicode 子串查找；
- 支持索引而不是 `%LIKE%` 全表扫描；
- 可以使用 BM25 及稳定次级排序；
- 小于 trigram 最小长度的查询回退到受限 `LIKE`，并强制 limit。

启动时应做能力检查；如果运行时 SQLite 不支持所需 FTS5 tokenizer，必须明确报告 degraded lexical search，不能静默声称已经启用全文索引。

### 13.4 PostgreSQL

首选 `pg_trgm` + GIN/GiST 索引：

- 不依赖英文词法分析；
- 对中文和混合语言子串更可靠；
- 支持相似度排序与索引扫描。

如果部署环境不能启用 `pg_trgm`，可以回退到受限 `ILIKE`，但 Runtime 和 Dashboard 必须展示当前检索能力为 degraded。

### 13.5 查询语义

`recall(query)` 应同时返回 Frame 和 Event：

```json
{
  "query": "沙箱权限审批",
  "matches": [
    {
      "kind": "frame",
      "frame_id": "memory/sandbox-permission",
      "retired": true,
      "score": 0.92,
      "preview": "权限失败应先区分沙箱拒绝、审批拒绝……"
    },
    {
      "kind": "event",
      "event_id": "@e381",
      "score": 0.76,
      "preview": "……"
    }
  ]
}
```

排序规则：

1. lexical relevance 降序；
2. exact ID / exact phrase 优先；
3. updated sequence 降序；
4. document ID 稳定排序。

SQL 必须在数据库内应用 limit，不得读取全部命中结果后再截取。

### 13.6 Unicode 规范化

索引与查询使用相同的确定性规范化：

- Unicode NFKC；
- 拉丁字母统一大小写；
- 标准化常见全角/半角差异；
- 保留中文原文；
- 不在 v1 引入业务同义词或模型生成关键词。

## 14. Projection、一致性与重建

### 14.1 Recall Projection 不是事实源

Ledger 和 Mind Projection 仍然是真值。`recall_documents` 是可重建索引：

- Event append 后更新对应 Event document；
- create / derive / revise 后 upsert 当前 Frame document；
- retire 只更新 `retired=true`，不删除索引文档；
- restore 更新 `retired=false`；
- relation 变化后刷新受影响 Frame 的关系检索文本。

### 14.2 原子写入

在同一数据库后端中，Ledger/Mind 事务与 Recall Projection 更新应尽量使用同一数据库事务。若实现阶段必须采用异步投影，则需要：

- `indexed_through_sequence` 游标；
- 幂等重放；
- Lag 可观测性；
- 查询结果标注 index revision；
- 启动恢复不扫描无界历史，而是从游标继续。

v1 优先采用同事务更新，避免刚退休的 Frame 暂时无法通过关键词找到。

### 14.3 重建命令

提供显式维护入口：

```text
morphz context recall-index inspect CONTEXT_ID
morphz context recall-index rebuild CONTEXT_ID
```

重建只更新派生索引，不修改 Ledger、Mind 或 Frame 生命周期。

## 15. Runtime API、SDK、CLI 与 Dashboard

### 15.1 统一 Runtime 接口

CLI、HTTP API、Dashboard 和未来 SDK 必须复用同一领域接口：

```rust
trait ContextRecallService {
    async fn search(&self, request: RecallSearchRequest) -> Result<RecallSearchPage>;
    async fn recall_frame(&self, request: FrameRecallRequest) -> Result<FrameRecallPage>;
    async fn rebuild_index(&self, context_id: &str) -> Result<RecallIndexAudit>;
}
```

不能让 Dashboard 直接读取 SQLite 表，也不能为 CLI 单独实现另一套关系遍历。

### 15.2 Dashboard Mind 视图

需要展示：

- active / retiring / retired 数量；
- retiring Frame 的剩余 cognitive ticks；
- 退休原因；
- active-token-cost；
- immediate / eventual relief；
- successor 状态；
- 恢复或保护操作；
- 关键词搜索和 Frame lineage 展开。

### 15.3 定时任务入口是独立问题

现有 `schedule_tx` 已经支持现实时间、依赖和周期调度；Dashboard 目前只在 Thread 卡片中嵌套展示已有 Schedule，没有独立创建和管理入口。

Schedule 使用墙钟时间，Frame 整理期使用认知活动时钟。两者在 UI 上应明确分开，不能把 Frame lifecycle 伪装成定时任务。

## 16. 事务回执

Context transaction 回执需要让模型看到真实效果：

```lisp
(context-tx-result
  (status committed)
  (before-version 42)
  (after-version 43)
  (token-effect
    (estimated-before 92240)
    (estimated-after 90380)
    (estimated-immediate-relief 1860))
  (changes
    (retire-observation
      (target @e42)
      (state retired)
      (immediate-token-relief 1840))
    (retire-frame
      (target recent-debug-case)
      (state retiring)
      (immediate-token-relief 0)
      (eligible-at-tick 150))
    (retire-frame
      (target old-debug-case)
      (state retired)
      (successor sandbox-debugging-model)
      (immediate-token-relief 620))))
```

这比只在提示词中要求“优先清理 Inbox”更可靠：操作的结构化结果直接说明哪些动作真正释放了容量。

## 17. 可观测性

日志和 Scheduler Snapshot 至少记录：

- cognitive tick advance 与对应 Signal batch；
- Frame retirement requested；
- retirement cancelled；
- successor finalized retirement；
- retirement became effective；
- fencing conflict / stale generation；
- lexical search backend 与 capability；
- search latency、candidate count、returned count；
- recall traversal depth、visited nodes、truncated 和 cursor；
- recall index revision 与 projection lag；
- 每次维护的估算 Token 前后差额。

不能把一次普通关键词查询产生的全部匹配正文写入高频审计日志。

## 18. 安全与权限边界

- Recall 只能读取当前 Activation 有权访问的 Cognitive Context；
- Session 身份系统接入后，搜索结果仍需服从 Context/Session 可见性政策；
- 深度遍历不能跨越未授权 Context；
- Dashboard 的 restore/protect 操作属于 Context 控制面，需要 revision CAS；
- 搜索 query 必须参数化绑定，不能拼接 SQL/FTS 查询表达式；
- cursor 必须签名或由 Runtime 持久化，不能接受模型伪造任意遍历状态；
- FTS preview 需要限制字符数，防止一次召回重新塞满 Context。

## 19. 实现顺序

### 阶段一：可靠召回基础设施

1. 增加 Recall Projection 与统一领域接口；
2. Frame 成为一等检索文档；
3. SQLite FTS5 trigram；
4. PostgreSQL pg_trgm；
5. degraded fallback 与能力报告；
6. `recall(frame_id, depth)` 关系遍历；
7. 中文、混合语言和分页测试。

只有阶段一通过后，才应该鼓励模型更积极地退休底层 Frame。

### 阶段二：认知活动时钟

1. Context cognitive clock Projection；
2. Signal batch 幂等推进；
3. 排除 retry/continuation/internal receipt；
4. SQLite/PostgreSQL 并发一致性测试；
5. 重启与离线不推进验证。

### 阶段三：Frame 整理期

1. `MindState.retiring`；
2. retire/restore/protect/revise 状态机；
3. 到期批处理与 revision fencing；
4. successor transaction 最终状态校验；
5. Mind Projection、Snapshot 与 checkpoint/rollback 支持；
6. 旧数据库迁移。

### 阶段四：Token 成本与自描述

1. 每项 SExpr 渲染块本地 Token 估算；
2. immediate/eventual relief；
3. transaction commit 后的实际估算差额；
4. warning/critical maintenance candidates；
5. SExpr VM 自描述政策更新。

### 阶段五：Dashboard 与真实模型验证

1. Mind 生命周期 UI；
2. Recall 搜索与 lineage explorer；
3. 恢复、保护和取消整理；
4. Gemini 主测，其他模型作为对照；
5. 长程任务和经验迁移回归。

## 20. 测试计划

### 20.1 生命周期单元测试

1. retire observation 立即生效；
2. retire Frame 进入 retiring，Token relief 为 0；
3. Runtime 空闲不推进 tick；
4. Runtime 关闭再重启不推进 tick；
5. 新用户消息推进一次 tick；
6. 相同 Signal 重放不重复推进；
7. Provider retry 和 reasoning continuation 不推进；
8. revise retiring Frame 取消退休；
9. protect retiring Frame 取消退休；
10. restore retiring Frame 取消退休；
11. 到期批次原子退休；
12. revision 变化使旧到期动作失效；
13. 重复 retire 不重置冷却窗口；
14. successor 立即收口；
15. protected Frame 仍拒绝 retire。

### 20.2 Recall 图遍历测试

构造：

```text
A ─┐
   ├─► C ─┐
B ─┘      ├─► E
D ────────┘
```

验证：

- depth=0 只返回 E；
- depth=1 返回 C、D、E；
- depth=2 返回 A、B、C、D、E；
- retired A/B 仍可返回；
- 构造环后不会死循环；
- max_nodes 生效并返回 cursor；
- cursor 继续后不重复、不漏节点；
- descendants 和 both 方向正确；
- Event source 默认只返回 preview，显式请求才分段读取正文。

### 20.3 中文全文检索测试

至少覆盖：

- `阳光电源`；
- `沙箱权限审批`；
- 中英文混合 `Rust 沙箱`；
- 全角/半角；
- 三字符以上 trigram；
- 一到两个字符 fallback；
- active / retired Frame；
- Frame body 与 Frame ID；
- relation 名称与 sources；
- exact phrase 优先；
- 数据库内 limit；
- SQLite/PostgreSQL 结果集合一致性。

### 20.4 长程行为评测

场景一：大量 Inbox + 近期唯一 Frame。

- 预期先退休 observation；
- 近期 Frame 进入整理期而不是立即消失；
- pressure 明确报告即时释放量。

场景二：多批相关事实 Frame。

- 预期形成归纳 Frame；
- 归纳 Frame 再形成高阶 Frame；
- successor 链完整；
- 底层 Frame 退休；
- 使用高阶 ID + depth recall 能恢复全部来源。

场景三：Agent 空闲和重启。

- 一周墙钟时间不改变 cognitive tick；
- 普通 active Frame 不丢失；
- retiring Frame 剩余 ticks 不变化。

场景四：经验迁移。

- 有高阶 Frame 的 Agent 处理相似任务时调用更少工具；
- 需要底层细节时可以关键词搜索并沿链恢复；
- 不因退休造成事实缺失或编造。

## 21. 验收指标

### 容量

- observation-first retirement ratio；
- immediate token relief；
- retiring Frame token debt；
- successor consolidation net relief；
- warning/critical 恢复成功率。

### 认知结构

- successor 创建率；
- 平均归纳深度；
- 事实 Frame 到高阶 Frame 的压缩比；
- active Frame 数是否随任务数线性增长；
- 无 successor 的近期直接退休次数应为 0。

### 召回

- 中文关键词 Recall@K；
- exact Frame ID 命中率；
- lineage 完整率；
- depth traversal 节点正确率；
- 退休内容恢复成功率；
- SQLite/PostgreSQL P50/P95 查询延迟；
- 索引 Lag 和重建一致性。

### 安全

- 重复 Signal 不重复推进 tick；
- stale retirement generation 不误退休；
- 未授权 Context 召回为 0；
- Ledger 和关系无不可逆删除；
- restart 后状态与 Projection 一致。

## 22. v1 实现结果

| 能力 | v1 实现状态 |
|---|---|
| Observation retire | 保持立即退休，并在逐项事务回执中报告即时 Token 释放估算 |
| Frame retire | 默认进入 `retiring` 整理期；重复请求不重置窗口 |
| Successor 收口 | `sources + supersedes` 在同一 Context transaction 中原子退休来源 Frame |
| Cognitive clock | Context 级持久逻辑 tick；Signal batch 原子认领时幂等推进一次 |
| Retiring Projection | `MindState.retiring`、Snapshot、Checkpoint、重放与 Seed 边界已统一 |
| 逐项 Token cost | 按实际 SExpr 活动块执行统一本地估算；Context View、维护候选及事务逐项回执均可见 |
| Recall by Frame ID | 返回 lifecycle、正文、sources 与有向关系边 |
| Recall depth | 有界 BFS、稳定排序、防环、签名 cursor、节点与字符预算 |
| Keyword recall | SQLite FTS5 trigram；PostgreSQL `pg_trgm`；能力不可用时显式 degraded 并有界回退 |
| 中文 | 索引和查询统一 NFKC + lowercase，覆盖中文、混合语言与全角/半角 |
| Frame 搜索结果 | Event 与 Frame 都是一等 `recall_documents` 文档，retired 文档不删除 |
| 相关性排序 | exact ID、lexical relevance、updated sequence、stable ID |
| SQL limit | SQLite/PostgreSQL 均在数据库查询内应用 limit |
| 统一接口 | 模型 Tool、Rust Runtime、CLI、HTTP API 与 Dashboard 复用 `ContextRecallService` |
| Dashboard | 展示 active/retiring/retired、认知 tick、Token cost、索引能力、关键词 Recall、lineage 与恢复/保护控制 |
| 可观测性 | 记录 clock advance、退休请求/取消/收口/fencing、检索后端/延迟/结果数、图遍历规模和事务 Token 差额 |

本轮验证结果：

- Rust 完整测试：385 个库测试、18 个主程序测试、45 个 Attempt Loop 测试、4 个 CLI 契约测试、3 个存储契约测试通过；3 个既有人工 PTY/视觉 smoke 测试按原设计忽略；
- Dashboard：19 个前端状态测试、ESLint、TypeScript 与生产构建通过；
- CLI smoke：`context recall search/frame` 与 `context recall-index inspect/rebuild` 的分层帮助可在不初始化 Provider 的情况下使用；
- PostgreSQL 真机测试由 `MORPHZ_TEST_POSTGRES_URL` 显式启用；未配置时只执行编译与环境门控，不宣称已经连接外部数据库。

## 23. 最终结论

Morphz 不应把 Context 压缩实现成“旧消息到阈值后由框架统一摘要”，也不应让模型在压力下把刚形成的 Frame 当作普通缓存直接丢弃。

正确的实现方向是：

1. observation 是优先退出活动注意力的原始工作材料；
2. Frame retire 首先表达整理意图，并进入以新认知活动计数的整理窗口；
3. revise 让原 Frame 自身变得更精简；
4. derive + supersedes 让多个事实 Frame 提升为更高阶概念，并使来源立即退休；
5. 退休只移出正文，不删除关系、血缘和 Ledger；
6. 高阶 Frame 可以压缩到极小语义根；
7. 关键词全文索引负责发现候选，关系深度遍历负责沿认知链逐层恢复；
8. Runtime 管理物理约束，模型拥有认知结构。

当这套闭环成立后，有限 Context 不再等于有限认知：Context 只承载当前活跃的高阶结构，历史 Frame 和原始经验通过可追溯关系图构成可换入的长期认知空间。
