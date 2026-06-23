# 为什么选择 SQLite + LanceDB 混合架构，而非只用 LanceDB？

在重新评估底座数据库选型时，一个非常自然且尖锐的问题是：**既然 LanceDB 如此强大（支持高性能向量与全文检索），为什么我们不直接用 LanceDB 来承载 Morphz 的所有数据，而是非要搞一个复杂的“双轨混合架构”？**

本篇文档站在资深系统工程师的视角，从**数据模型、读写负载模式以及系统健壮性**三个维度，对“只用 LanceDB”在架构上的缺陷进行深度剖析，阐述为什么“混合架构”才是工业级智能体的最优解。

---

## 1. 关系模型 (SQL/CTE) vs 扁平列式向量模型 (Columnar)

这是决定不使用单一向量库的最核心的技术分水岭。

### 1.1 SQLite：强图谱关系与多表关联（图递归漫游的基石）
*   **多表 JOIN 与关系表达**：
    在 Morphz 的 `GraphMemory` 中，图谱不仅仅是顶点（Nodes），更核心的是**边（Edges）**所承载的关系拓扑（如 A 节点 `depends_on` B 节点，B 节点 `resolves` C 问题）。我们需要根据不同关系的权重（Weight）、活跃时间（Last Accessed）进行高频的过滤和复杂的关联查询。
*   **CTE 递归查询（Common Table Expressions）**：
    在 [sqlite.rs#L574](file:///Users/shafreeck/Codes/Morphz/morphz/src/memory/sqlite.rs#L574) 的 `query_path` 中，我们为了在图谱中做多步拓扑漫游扩散（Graph Walk），运行了极其复杂的 SQL 递归查询（`WITH RECURSIVE path...`）。
*   **只用 LanceDB 的灾难**：
    LanceDB 本质上是基于 **Apache Arrow** 格式的**列式（Columnar）数据存储**。列式存储天生**不支持多表 JOIN**，更**不支持递归 CTE 图寻路**。如果只用 LanceDB，我们必须在 Rust 控制面用纯 Rust 语言去手写递归图寻路和内存 Join 逻辑。这不仅会导致控制面代码极其臃肿和易错，内存中的图遍历在面对复杂关系时还会带来极高的时间复杂度，彻底破坏系统的高效性。

---

## 2. Row 追加时序流 (时序写) vs 列式批量落盘 (列式写)

### 2.1 读写负载模式的本质冲突
*   **EventStore 的时序追加流**：
    `EventHistory` 是极高频、单行追加（Row-oriented append-only）的时序流。每一个动作、每一次 LLM 决策、甚至高频的临时脑状态同步，都在实时写库。
*   **SQLite 的单行极速追加**：
    SQLite 作为典型的行存数据库，在 WAL（Write-Ahead Logging）模式下，对零碎的单行追加优化到了极致。单写连接池下可以轻松达到每秒数万次的 Row 级 append，且对系统开销极低。
*   **LanceDB 列式存储的“写入放大”噩梦**：
    列式存储的优势是“大批量写入极快，单行写入极慢”。如果我们要把高频零碎的 Event 消息一条一条写进 LanceDB，它每次都要去重构它的列数据段（Segments）并重新索引其 Tantivy 全文检索分片，这会造成灾难性的**磁盘写入放大（Write Amplification）**与 I/O 阻塞，甚至会引起高频的文件锁冲突，导致控制面发生卡顿。

---

## 3. 事务 (ACID) 与状态安全性

*   **SQLite 的工业级事务**：
    SQLite 的事务机制经历了数十亿设备的实战打磨。即使在物理设备遭遇突然断电或操作系统崩溃的极端情况下，其 WAL 日志机制也能 100% 保证数据库文件不会损坏。这对于保存智能体最核心的 Context 脑快照（Snapshots）和不可变的 Event 流至关重要。
*   **LanceDB 的事务限制**：
    虽然 LanceDB 提供了底层的并发写入安全，但它主要面向大数据分析和近邻搜索，并不提供传统关系型数据库那种强 ACID 关系多表联合事务机制，不适合承载系统的核心业务状态。

---

## 4. 结论：工业分层哲学的融合

资深系统工程师的数据库选型，从来不是“找一个全能的巨无霸”，而是**“让专业的东西做专业的事，在物理层进行合理的职责拆分（Separation of Concerns）”**：

| 特性 | SQLite (关系行存轨) | LanceDB (AI 向量/检索轨) |
| :--- | :--- | :--- |
| **擅长领域** | 高频时序追加、强关系图查询（CTE）、ACID 多表事务。 | 百万级向量 ANN 检索（IVF-PQ）、高性能 Tantivy 全文检索、Rerank 混合召回。 |
| **承载内容** | `EventStore`、`Context Snapshots`、实体关系的物理边（Edges）。 | 实体的语义向量、属性文本、文档正文。 |

**SQLite + LanceDB 的混合双轨架构**，既用 SQLite 完美的稳定性与图计算能力守住了 Morphz 的“身体（时序与关系）”，又用 LanceDB 的极速近邻和 Tantivy 的高性能全文搜索引擎装上了 Morphz 的“眼睛（快速语义召回）”，这才是一个兼具部署零摩擦与生产级高性能的优雅底座。
