# Morphz 核心功能缺失分析与重构技术方案 (上下文持久化与 Skill 自演化)

> [!WARNING]
> 历史审计文档。本文基于早期固定 Context、全量重放与“Yao 编译到 WASM”的设想，其中多项事实和实现建议已经失效。当前 Context 以 [Agent-Owned Context](morphz_agent_owned_context_design.md) 及 Projection 设计为准；当前 Yao 方向是 [`.hns` Harness、显式 `eval/infer` 与 Typed Plan IR](morphz_yao_harness_file.md)，物理调用继续经过 Scheduler、权限和原生沙箱，不以 WASM 作为默认执行路径。

本报告针对智能体（Agent）开发中最核心的两个能力维度——**上下文持久化与缓存守护 (Context & Cache)**、**技能的自主学习与执行 (Skill & Sandbox)**，深度剖析 `Morphz` 相比于 `openclaw` 与 `Hermes` 在源码实现上的本质缺陷与核心功能缺失，并提供针对性的重构落地图。

---

## 1. 上下文维护与持久化机制 (Context Persistence)

### 1.1 缺陷定位：基于全量 Event 重放的临时 Fold 折叠灾难
*   **Morphz 的当前设计**：
    在 [orchestrator.rs:L197-367](file:///Users/shafreeck/Codes/Morphz/morphz/src/orchestrator/orchestrator.rs#L197-L367) 中，每次 Agent 被事件唤醒（如收到 `user_message` 或 `tool_output`）时，其当前大脑状态 `context_state` 是通过**全量重放 EventStore 中属于该 Session 的所有历史事件临时折叠出来的**。
*   **缺失与弊端**：
    *   **零状态快照持久化**：Morphz 并没有在 SQLite 或本地中对 `context_state` 本身进行序列化快照（Snapshot）保存。
    *   **计算雪崩效应**：随着会话的进行，Event 历史（包含工具调用过程、大篇幅代码文件读写和 Shell 输出）会呈线性甚至指数级增长。这意味着，在第 $N$ 轮交互时，CPU 需要在内存中重新解析、求值、执行 $N-1$ 轮产生的所有 Lisp `eval` 命令、追加和裁剪所有的 `history turns`。一旦交互超过 50 轮，不仅耗时激增（TTFT 暴涨），且极易在单次重放中由于某个中间状态解析异常导致整个 Context 状态崩塌。
*   **Hermes/OpenClaw 的做法**：
    *   **Hermes** 在内存中实时维护持久的 `ConversationState` 和 `MemoryStore`，以冷热双轨模型周期性序列化入库，重启时直接从最新状态恢复，零重复演算开销。

### 1.2 缺陷定位：全量 Lisp SExpr 注入导致的 Prefix Cache 击穿
*   **Morphz 的当前设计**：
    在 [orchestrator.rs:L612-618](file:///Users/shafreeck/Codes/Morphz/morphz/src/orchestrator/orchestrator.rs#L612-L618) 中，Morphz 将整个演算出的 S-Expression 字符串 `context_state.to_string()` 包装为单一的 User Message 提交给 LLM：
    ```rust
    let messages = vec![
        Message { role: "system".to_string(), content: system_prompt.to_string(), ... },
        Message { role: "user".to_string(), content: user_message /* 整个 context_state */, ... }
    ];
    ```
*   **缺失与弊端**：
    S-Expression 包含 `metadata`、`variables`、`history`、`todo_stack` 等高度动态的节点。只要智能体调用了一次 `eval`（例如将 `step` 递增 1，或在 `todo_stack` 中入栈一个微小任务），这会导致整个 User 消息的所有前缀字元发生改变。
    *   大模型提供商的 **Prefix Cache（前缀缓存）要求前缀字符级 100% 绝对一致**。这种全量打包在 User 消息中的做法，导致**大模型每次推理都必须重新计算整段 Prompt（包括 System Prompt）的 Prompt Token**，带来昂贵的 API 费用并严重拖慢响应速度（首字延迟居高不下）。

---

## 2. 技能的提炼与动态利用 (Skill Self-Evolution)

### 2.1 缺陷定位：Curator 的“知识图谱存入”与“技能编写执行”脱节
*   **Morphz 的当前设计**：
    目前的 [curator.rs](file:///Users/shafreeck/Codes/Morphz/morphz/src/orchestrator/curator.rs#L85-L220) 异步任务只会从最近的对话中提取实体和关系（如 `Issue` ➔ `Resolves` ➔ `Solution`）写进 `GraphStore` 的 Node/Edge 关系表中。
*   **缺失与弊端**：
    *   **只存不编**：Curator 提炼出来的只是零星的**语义事实**（如“死锁由并发引起”），而不能自动归纳并编写成一个**具有逻辑控制能力的可重用 Skill（技能）**。
    *   **无法动态装载与执行 (Tool Use)**：在 [tool.rs](file:///Users/shafreeck/Codes/Morphz/morphz/src/tool.rs) 中，Morphz 规划的 `yao-lang`（一种类 Lisp 的中文 S-Expression DSL 脚本，可编译为 WASM 并运行于 WASM 沙箱，安全隔离且极其轻量）**完全没有落地实现**。目前大模型根本不具备“加载一个 Wasm 技能文件并执行它”的工具接口，也没有“编写并持久化一个 WASM 技能”的编译器闭环，导致图谱中的知识无法被 Agent 动态加载为它的新工具。
*   **Hermes 的做法 (Curator Self-evolution)**：
    *   当 Hermes 解决完一个高难度复杂任务后，`Curator` 协程会总结出一个具体的 Python 脚本技能。
    *   该技能会被存储在 `skills/` 目录下，并进行白盒 AST 静态语法树拦截（`ast_audit`，防止敏感 API 提权与 FFI 注入）。
    *   在下次遇到类似场景时，该技能会通过 RAG 自动召回并作为动态 Tool 挂载，大模型能直接通过 Tool Call 调用该 AI 自创的技能文件，实现心智和能力的自主演进。

---

## 3. 重构落地路线图

为解决上述两大缺失，对 Morphz 进行底层重构的设计建议如下：

```
                              [ EventHistory (Badger/SQLite) ]
                                            │
               ┌────────────────────────────┴────────────────────────────┐
               ▼                                                         ▼
[ 1. 状态快照机制 (Snapshot) ]                                 [ 3. Curator 技能提取协程 ]
• 每 N 步对 context_state 做 JSON 归档                                    • 分析 Event 提炼 yao-lang DSL 脚本
• 启动时: 加载最新 Snapshot + 重放增量 Event                              • 写入 skills/ 技能物理库
               │                                                         │
               ▼                                                         ▼
[ 2. 冷热缓存分离 (Prefix Cache) ]                              [ 4. WASM 技能加载执行器 ]
• System Prompt 保持 100% 静态冷轨                                      • 引入 wasmtime-rust 运行沙箱
• 心智状态 + graph_anchors 转为 User 增量热轨                            • 提供 (run_wasm_skill path args) 工具
```

### 3.1 上下文与缓存优化重构
1.  **引入快照（Snapshot）表**：
    In SQLite 建立 `session_snapshots` 表（字段：`session_id`, `step`, `snapshot_data_lisp`, `created_at`）。
    每当会话步数达到 10 的倍数时，在 `store.append` 事件流之后，自动将当前的 `context_state` 序列化为 SExpr 字符串存入该快照表。
    在 `handle_chat_event` 时，Orchestrator 首先加载最新的 Snapshot，然后仅从该 Snapshot 所属的 Step 之后开始查询 EventStore 进行增量 Fold 计算，将 CPU 重算复杂度由 $O(N)$ 降为常数级 $O(10)$。
2.  **前缀缓存保护（冷热双轨）**：
    重构大模型请求结构：
    *   **冷轨（System Prompt）**：只包含角色设定、SExpr 状态机的运作规则与 5 大原子原语工具定义（字元级冻结）。
    *   **热轨（前置 Message 注入）**：将计算好的 `(graph_anchors ...)` 与 `(variables ...)` 等大脑 Context 拆出来，作为独立的 `user` 角色消息，紧接在 System Prompt 之后呈现，或者仅作为大模型可选调用的工具返回结果，避免每一次微小的变量演算彻底毁掉 Prefix Cache。

### 3.2 yao-lang & WASM 技能闭环落地
1.  **实现 `yao-compiler` 与 AST 静态审计**：
    在 Rust 端实现一个简单的解析编译器，将类 Lisp 的 `yao-lang` 代码编译为轻量级 WASM 字节码（或者先通过 Rust 进行白盒 AST 白名单过滤）。
2.  **引入 WASM 虚拟机运行时 (Yao-VM)**：
    利用 `wasmtime` crate 嵌入 WASM 运行时。大模型被赋予 `run_skill(path, arguments)` 工具。该工具读取 `skills/` 目录下的 `.wasm` 文件，并送入宿主进程内嵌入的 WASM 沙箱中执行。
    *   **安全隔离**：WASM 天然被剥夺一切系统调用和网络权限，比 Docker 更为轻量，实现微秒级冷启动并解决安全隐患。
3.  **技能写入工具（SkillWriter）**：
    当 Curator 提炼出通用解法时，生成一段 `yao-lang` 代码，通过 `write_skill` 工具写入物理存储，供下一次会话通过 RAG 自动召回，挂载在 `run_skill` 的可用列表里。
