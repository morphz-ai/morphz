# Morphz 最底层核心架构方案 (Context 快照、冷热缓存与三层工具哲学)

> [!WARNING]
> 本文中的固定 Context Schema、自动 Fold/Compaction 和 `eval set/push/pop` 属于早期方案，已被 [Agent-Owned Context v1](./morphz_agent_owned_context_design.md) 取代。现阶段以稳定 ID Frames、版本化 `context_tx` 与显式 `recall` 为准。

本方案对 Morphz 的三个最底层核心技术方向进行深度设计，建立一套自洽、优雅且具备无限扩展潜力的智能体底座。

---

## 1. 核心问题细化与设计抉择

### 1.1 Context 求值持久化：Snapshot 快照 + 增量 Event 折叠重演
*   **设计抉择**：
    经过深度评估，我们选择**方案 A（Snapshot 快照 + 增量 Event 重放）**作为 Context 的持久化机制。
*   **架构契合度分析**：
    *   **符合无状态 Agent 哲学**：`AGENTS.md` 规定“共享的 Context 状态是通过 Fold 算子基于底层的不可变 EventHistory 进行动态求值投射出来的”。若直接原地持久化最新状态（思路 B），不仅违背了事件投射的哲学，更让 Context 失去了“时间旅行与无损回滚”的能力。
    *   **容错与审计优势**：S-Expression 的修改提案（`TYPE_PROPOSAL`）完全记录在不可变的 EventStore 中。如果大模型在 Attempt 过程中调用了错误的演算，或者写入了脏状态，控制面可以通过在 EventStore 中撤销/忽略最近的 Proposal，并从前一个快照开始重新 Fold 重演，即可实现无损的状态回滚，保证了系统的鲁棒性。
*   **工程设计**：
    1.  **快照表定义**：在 SQLite 中维护 `context_snapshots` 表，保存 `(session_id, step, snapshot_data_lisp)`。
    2.  **触发快照**：每当 Fold 演算的 `step` 递增到 10 的倍数时，在 tokio 异步线程中将当前的 `context_state.to_string()` 作为快照归档。
    3.  **增量 Fold**：当 Orchestrator 唤醒时，首先查询 `get_latest_snapshot` 还原为基础 `context_state`，然后执行 `store.query` 仅获取 `step > snapshot.step` 的增量事件进行增量重演。

### 1.2 Prefix Cache（前缀缓存）的黄金排布序列
为了最大化守护 API 厂商的前缀缓存，我们将发送给模型的 Messages 重新进行“冷热双轨”排序，将所有易变动内容强行推至 Prompt 尾部：

```
┌────────────────────────────────────────────────────────┐
│ 1. 绝对静轨 (System Prompt: 智能体角色定义 + 5原子原语定义) │ 100% 缓存命中
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│ 2. 相对静轨 (前置 user 消息: 图谱动态召回 the graph_anchors) │ 跨 Attempt 缓存稳定
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│ 3. 动态热轨 (尾部变轨消息: 当前 variables、todo_stack)      │ 每轮变动，不影响前缀
└────────────────────────────────────────────────────────┘
```

1.  **第一段：绝对静轨（冻结 System Prompt 与 API 字段）**：
    包含大模型角色设定与 S-Expression 状态机的语法规则说明。
    *   **缓存优化细节**：5 个元工具的 Schema 参数定义通过云端 API 的 `tools` 结构化字段传送，大模型提供商会自动将其并入前缀缓存头部（绝对冷轨）。因此，**工具的参数描述绝对不需要重复写入 System Prompt 纯文本正文中**，防范了 Prompt 的臃肿，确保缓存的极致干净。
2.  **第二段：相对静轨（前置 `user` 召回消息）**：
    将从 `GraphMemory` 检索出的长期记忆和 Skill 提示（即 `(graph_anchors ...)`），作为单独的 user 消息紧跟在 System Prompt 后。
3.  **第三段：动态变轨（尾部消息）**：
    将高频变动的 `(variables ...)`，`(todo_stack ...)`，以及最近的 `(turns ...)` 对话历史作为请求体的**最后几条消息**发送。即使变量或 To-Do 每一步都在变，由于其位于最尾部，不会破坏前面 System 消息与记忆消息的前缀缓存。

---

## 2. 工具 (Tool) 与技能 (Skill) 的哲学层设计

“车不是 5 个 native工具简单能组合出来的。车是工具，开车是技能。” 
为了解决“大模型如何制造和使用高阶工具”的命题，我们从哲学层面将 Morphz 的工具与技能划分为三个清晰的层级：

```
┌────────────────────────────────────────────────────────────────────────┐
│ Level 2: 心智技能 (Cognitive Skills)                                    │
│ • "开车" ➔ 表现为 SKILL.md 说明与心智 To-Do 宏规划                       │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ (Lisp 状态机演算 eval 驱动)
┌──────────────────────────────────▼─────────────────────────────────────┐
│ Level 1: 具象物理工具 (Physical Tools)                                  │
│ • "汽车" ➔ 运行在 L3 沙箱中的外部软件工具 (如 Playwright, curl, git)     │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ (由 exec/write 原语驱动)
┌──────────────────────────────────▼─────────────────────────────────────┐
│ Level 0: 元原语 (Meta-Primitives)                                       │
│ • "手和脚" ➔ 内置写死的 5 个元能力 (read, write, eval, exec, spawn)     │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Level 0: 元原语 (Meta-Primitives)
*   **定义**：智能体与生俱来的“生物学功能”（如人类的手、脚、眼、脑）。
*   **实现**：内置在 Morphz 控制面底座中的 5 大核心原子工具：
    *   `read` / `write`：眼与手（输入输出能力）。
    *   `exec`：肌肉行为（物理执行力）。
    *   `eval`：脑部自省（状态机演算）。
    *   `spawn`：克隆与分工（并发与边界隔离）。
*   **特征**：保持高度纯净与自洽，**不为任何具体的外部工具做定制或扩充**。

### 2.2 Level 1: 具象物理工具 (Physical Tools)
*   **定义**：跑在 L3 执行沙箱环境中的外部实体（如“汽车”）。它们拥有自己的运行指令与控制接口。
*   **例子**：`Playwright` 浏览器控制、`curl` 网络请求库、`sqlite3` 数据库。
*   **执行方式**：大模型不需要感知它们是否被注册为 native 接口，大模型直接利用元原语 **`exec`**（跑 `python3 check.py`，跑 `curl http://...`），去操纵这些具象工具。

### 2.3 Level 2: 心智技能 (Cognitive Skills)
*   **定义**：**“开车”的动作指南与规划控制流程**。它是教大模型如何操纵具象工具去解决问题的一套心智控制逻辑。
*   **构成**：
    *   `SKILL.md`：前台的自然语言说明，教 LLM 原理和注意事项。
    *   `macro`：后台由 `(begin (push ...) (set ...))` 组成的 Lisp 心智宏指令。
*   **执行与闭环**：
    1.  大模型诊断出问题，从 `(graph_anchors)` 或物理目录发现相关技能。
    2.  大模型调用元原语 **`read`** 读取 `SKILL.md`。
    3.  大模型通过调用元原语 **`eval`**，将 `SKILL.md` 中配套的心智宏 `macro` 写入状态机。
    4.  宏展开后，大模型的 `todo_stack` 中**自动被注入了操纵具象工具的子步骤 To-Do**。
    5.  大模型遵照 To-Do，利用 **`exec`** 原子原语去具体操纵 L1 层面的外部具象工具（如跑 Playwright 脚本），完成闭环。

---

## 3. Proposed Changes

### [NEW] [snapshot.rs](file:///Users/shafreeck/Codes/Morphz/morphz/src/memory/snapshot.rs)
在 `SqliteStore` 中实现快照存储与查询：
*   表初始化：`CREATE TABLE IF NOT EXISTS context_snapshots (session_id TEXT, step INTEGER, snapshot_data TEXT, PRIMARY KEY (session_id, step))`。
*   函数：`save_snapshot(session_id, step, snapshot_data)`。
*   函数：`get_latest_snapshot(session_id) -> Option<(step, snapshot_data)>`。

### [MODIFY] [orchestrator.rs](file:///Users/shafreeck/Codes/Morphz/morphz/src/orchestrator/orchestrator.rs)
*   **增量 Fold 改造**：修改 `handle_chat_event`（行 197 起），首先调用 `get_latest_snapshot`。如果存在快照，将其还原为 `context_state` 的初始状态，并在查询 Event 时限制 `step > snapshot.step`，执行增量 Event 重放。
*   **快照归档**：在每次 Fold 演算结束后，若最新 `step` 为 10 的倍数，在 tokio 异步线程中调用 `save_snapshot` 进行快照存储。
*   **Prefix Cache 双轨排序**：重新组织发送给模型的 Messages 数组，确保绝对静轨的 System Prompt 置前，动态的 variables 与 todo_stack 作为单独消息置后。

---

## 4. 安全机制设计共识 (Security & Sandbox Policy)
经过与设计者 Review 确认，目前达成以下底层共识：
1.  **安全隔离预留接口即可**：现阶段我们不急着草草糊一个粗暴的宿主命令行白名单过滤或复杂的 SExpr 动态审计。所有的命令隔离防护仅在物理执行层（`Environment` 接口）中保留适配扩展槽，供后续进行深度、严密的安全沙箱体系设计。
2.  **当前阶段目标**：第一阶段仅保证最基础的传统标准 Skill（Markdown 配置说明文件 + 本地 exec 执行脚本）的动态加载、文本阅读发现和 LLM 原子调用闭环。
