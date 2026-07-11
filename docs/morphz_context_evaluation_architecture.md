# Morphz 反应式记忆机制与上下文求值架构设计

> [!WARNING]
> 本文记录的是早期“由 Runtime 自动评分、召回和压缩 Context”的设计探索，不再代表 Morphz 的 Context 核心方向。当前设计以 [Agent-Owned Context：由 LLM 自主管理的心智上下文](./morphz_agent_owned_context_design.md) 为准：Runtime 提供机制、边界和恢复能力，LLM 通过 SExpr DSL 掌握 Context 的语义维护权。

本设计文档旨在规范 `Morphz` 智能体框架中关于**记忆管理、关系提取与上下文（Context）动态求值**的顶层设计，解决传统 Agent 框架在长任务中面临的“时序遗忘”、“注意力污染”与“上下文膨胀”等硬伤。

---

## 1. 核心设计愿景 (Vision)

Morphz 将智能体的上下文与记忆视为一个**“可以被求值的动态计算图”**，而非静态的文本历史。其核心愿景为：
- **物理事实（EventHistory）**与**工作记忆（Context）**彻底解耦。
- 保证底层数据的**不可变性与可追溯性**。
- 提供多 Agent 视角的**“视口隔离（Viewport Isolation）”**，每个 Agent 只消费对其任务求值出的精简 Prompt。

---

## 2. 三层记忆模型概念

Morphz 将记忆划分为清晰的三层逻辑结构：

```
                              ┌────────────────────────────────────────┐
                              │     外部世界 / 物理状态 / 用户交互       │
                              └───────────────────┬────────────────────┘
                                                  │ (Append WAL Log)
                                                  ▼
                              ┌────────────────────────────────────────┐
                              │  1. EventHistory (情境记忆 / Episodic)   │
                              │  - 不可变的、纯时序的物理事实流水账       │
                              └───────────────────┬────────────────────┘
                                                  │ (异步实体关联提取)
                                                  ▼
                              ┌────────────────────────────────────────┐
                              │  2. GraphMemory (语义记忆 / Semantic)    │
                              │  - 实体与关系的网络 (文件/错误/偏好/技能) │
                              └───────────────────┬────────────────────┘
                                                  │ (求值算子投影)
                                                  ▼
                              ┌────────────────────────────────────────┐
                              │  3. Context (工作记忆 / Working)       │
                              │  - 面向当前 LLM 推理步骤的精简 Prompt    │
                              └────────────────────────────────────────┘
```

---

### 2.1 EventHistory (事件历史)
- **定位**：系统底层的 WAL (Write-Ahead Log)，是绝对不可变的物理事实流。
- **数据结构**：
  - `ID`: 唯一标识（通常为 UUID 或自增 ID）。
  - `Timestamp`: 毫秒级时间戳。
  - `Actor`: 事件触发者（User, Agent-A, System-L3-Sandbox 等）。
  - `Type`: 事件类型（`UserMessage`, `ToolCall`, `ToolOutput`, `FileModify`, `Exception`）。
  - `Payload`: 原始数据（文本、文件差异、命令输出等）。

### 2.2 GraphMemory (图记忆)
- **定位**：从事件历史中提炼出的**语义知识网络**。它不记录具体的对话流水账，只记录“谁与谁有什么关系”。
- **节点类型 (Nodes)**：
  - `Task`: 任务目标与子任务。
  - `File`: 代码库中的文件。
  - `Entity`: 变量、类、符号、用户配置项。
  - `Skill`: 可调用的 API/动态代码模块。
  - `Error`: 运行期捕获的错误与异常。
- **边类型 (Edges / Relationships)**：
  - `DependsOn` (依赖关系，如 File-A 依赖 File-B)
  - `ModifiedBy` (修改关系，如 Task-1 修改了 File-A)
  - `TriggeredBy` (触发关系，如 Error-X 被 Tool-Y 触发)
  - `AssociatedWith` (语义关联)

### 2.3 Context (工作上下文)
- **定位**：求值引擎的**最终投影产物**。它是当前推理步骤（Attempt）中，LLM 唯一能看到并消费的 Prompt 内容（包含系统指令、近期对话、关联代码片段等）。

---

## 3. 求值引擎 (Evaluation Engine) 设计

求值引擎负责将 `EventHistory` 和 `GraphMemory` 进行实时计算，输出最终的 `Context`。

```
【EventHistory】────────┐
                       ├─► 【求值引擎 (Go/Rust)】 ─► 【视口投影】 ─► 【Context Prompt】
【GraphMemory】────────┘            ▲
                                   │
                           【当前任务/意图/Agent】
```

### 3.1 求值算子 (Evaluation Operators)
求值不是靠 LLM 模糊检索，而是通过以下三个确定性的工程算子进行加权计算：

1.  **时序衰减算子 (Temporal Decay Operator, $W_t$)**：
    - 距离当前时间越近的事件，权重越高。采用指数衰减公式：
      \[W_t(e) = e^{-\lambda \Delta t}\]
      *(其中 $\Delta t$ 为事件发生至今的时间差，$\lambda$ 为衰减常数。)*
2.  **拓扑关联算子 (Topological Affinity Operator, $W_g$)**：
    - 计算 GraphMemory 中，与当前操作实体（如当前报错的文件）的图距离。
    - 距离为 1 的实体权重设为 1.0；距离为 2 的实体权重设为 0.4；大于 3 的实体被截断（权重为 0）。
3.  **意图对齐算子 (Intent Alignment Operator, $W_i$)**：
    - 根据当前执行 Agent 的分工职责（如 Backend Agent）及当前子任务描述，过滤掉无关类型的事件。

### 3.2 最终求值公式 (Context Scoring)
对于系统中的任何记忆候选元素 $x$（可能是一个事件，或者一个文件实体），其在当前 Context 中的重要性评分为：
\[Score(x) = \alpha \cdot W_t(x) + \beta \cdot W_g(x) + \gamma \cdot W_i(x)\]
求值引擎将评分前 $N$ 位的元素提取出来，并按照**预设的 Prompt 模板**渲染为最终发送给 LLM 的 Context 文本。

---

## 4. 记忆压实与遗忘机制 (Compaction & Forgetting)

为了防止 `EventHistory` 和 `GraphMemory` 膨胀导致的性能雪崩，系统必须具备类似数据库的日志压实与垃圾回收机制。

```
┌──────────────────────────────────────┐
│       EventHistory (1000条事件)      │
└──────────────────┬───────────────────┘
                   │
                   ▼ (后台异步 Compactor 运行)
┌──────────────────────────────────────┐
│  State Snapshot (快照) + 关系合并     │ (清除无用垃圾尝试，只保留最终状态)
└──────────────────────────────────────┘
```

### 4.1 压实策略 (Compaction)
- **快照合并（Snapshotting）**：每隔 $M$ 个事件，后台协程自动将这一段时序历史折叠（Fold）成一个 State快照，并将原始的细粒度 Event 归档或删除。
- **尝试剪枝（Attempt Pruning）**：AI 在尝试过程中写错的代码、产生的临时错误事件，一旦该 Attempt 被宣告失败并回滚，对应的临时 Event 节点和 Graph 边将被直接物理删除，避免脏污染。

### 4.2 遗忘规则 (Forgetting Rules)
- **无关联实体回收**：如果一个 GraphMemory 中的实体（如一个不再存在的临时变量）的度数（Degree）为 0，且在 10 分钟内无任何事件关联，垃圾回收器（GC）将其物理抹除。

---

## 5. 工程实现可行性方案 (Go 语言)

我们采用 **Go 语言** 实现控制面的内存图与事件流存储，提供高并发和低延迟表现。

### 5.1 核心数据结构定义

```go
package memory

import "time"

// EventType 定义事件的物理类型
type EventType string

const (
	EventUserMessage EventType = "user_message"
	EventAgentCall   EventType = "agent_call"
	EventToolOutput  EventType = "tool_output"
	EventFileChange  EventType = "file_change"
	EventError       EventType = "error"
)

// Event 对应情境记忆中的一条不可变事件
type Event struct {
	ID        string                 `json:"id"`
	Timestamp time.Time              `json:"timestamp"`
	Actor     string                 `json:"actor"`
	Type      EventType              `json:"type"`
	Payload   map[string]interface{} `json:"payload"`
}

// NodeType 定义图记忆的节点类型
type NodeType string

const (
	NodeFile   NodeType = "file"
	NodeSymbol NodeType = "symbol"
	NodeTask   NodeType = "task"
	NodeError  NodeType = "error"
)

// GraphNode 图记忆中的节点
type GraphNode struct {
	ID         string                 `json:"id"`
	Type       NodeType               `json:"type"`
	Properties map[string]interface{} `json:"properties"`
	CreatedAt  time.Time              `json:"created_at"`
}

// EdgeRelation 图边的关系类型
type EdgeRelation string

const (
	RelationDependsOn   EdgeRelation = "depends_on"
	RelationModifiedBy  EdgeRelation = "modified_by"
	RelationTriggeredBy EdgeRelation = "triggered_by"
)

// GraphEdge 图记忆中的关联边
type GraphEdge struct {
	FromID   string       `json:"from_id"`
	ToID     string       `json:"to_id"`
	Relation EdgeRelation `json:"relation"`
	Weight   float64      `json:"weight"`
}

// Evaluator 求值引擎接口
type Evaluator interface {
	// Evaluate 根据当前的任务及 Agent 视图，对全局的 Memory 进行求值，输出 Context Payload
	Evaluate(currentAgent string, currentTaskID string, limit int) (*ContextPayload, error)
}

// ContextPayload 求值投射结果
type ContextPayload struct {
	TaskContext   string   `json:"task_context"`   // 当前任务树概览
	ActiveFiles   []string `json:"active_files"`   // 关联的文件实体及内容
	RecentHistory []Event  `json:"recent_history"` // 经过时序加权过滤的近期事件
}
```

---

## 6. 与 OpenClaw / Hermes 的架构级差异

| 评估维度 | Hermes / OpenClaw | Morphz (本设计) |
| :--- | :--- | :--- |
| **上下文本质** | 纯时序的 Chat 历史 (死数据) | 反应式计算图投影出的动态视图 (活数据) |
| **多 Agent 隔离度** | 差。所有 Agent 堆在同一个共享大 Session 中 | 优。共享物理记忆，但求值出独立的视口 Context |
| **长任务自愈能力** | 差。随着 Token 膨胀，注意力失焦而崩溃 | 强。图谱关联与时序衰减机制，精准抓取跨时空上下文 |
| **调试与审计** | 极难。黑盒运行，无法溯源 | 极易。基于只增不减的事实流，支持时空回溯调试 |
