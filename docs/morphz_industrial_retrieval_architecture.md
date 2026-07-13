# Morphz 工业级检索与记忆底座架构重构设计方案

> 历史设计记录：本文中的内置向量实现已迁至可选 Extension，文中 Core 源码位置和默认依赖不再有效；当前产品边界见 [产品化架构收口 v1](./morphz_productization_architecture_v1.md)。

在目前的实现中，三层记忆系统的物理检索层存在多处严重的“Demo 级玩具化”设计缺陷。对于一个高并发、低延迟、长任务运行的工业级智能体系统，现有的实现不仅存在灾难性的性能隐患，更无法支撑海量上下文的秒级收敛。

本文站在资深系统工程师的视角，对现有实现进行深度痛点剖析，并提供一套高并发、低延迟、高召回精度的工业级重构落地方案。

---

## 1. 核心缺陷深度剖析与性能雪崩分析

### 1.1 O(N) 内存余弦相似度计算：内存与 CPU 的双重灾难
*   **现有实现问题**：
    在 [sqlite.rs#L468](file:///Users/shafreeck/Codes/Morphz/morphz/src/memory/sqlite.rs#L468) 中，向量检索是通过 `SELECT ... WHERE embedding IS NOT NULL` 将数据库中**所有带有嵌入向量的节点记录全量拉取到 Rust 内存中**，并在控制面进程中循环计算余弦相似度并排序。
*   **性能瓶颈与雪崩分析**：
    *   **IO 与反序列化开销**：随着智能体运行，图谱节点数达到 $10^5$ 级别时，每次 LLM 调用都需要从磁盘拉取数千条 BLOB 数据，通过 SQL 驱动进行解析并反序列化为 Rust 的 `Node` 结构体，这会造成极大的内存抖动和 CPU 周期消耗。
    *   **时延激增**：余弦计算的复杂度为 $\mathcal{O}(N \cdot D)$（其中 $D$ 为 512 维的 Embedding 大小），在大数据量下会导致控制面 TTFT（首字延迟）呈指数级上升，彻底拖垮智能体的实时决策能力。
    *   **高并发冲突**：由于目前 SQLite 的连接池为了规避 Race Condition 被强行限制为最大连接数 1，这种全表扫描的大查询会长时间占用唯一的数据库链接，导致并发的子智能体（Spawn 产生的协程）陷入严重的死锁与等待竞争。

### 1.2 `%LIKE%` 退化模糊匹配：索引击穿与全表扫描
*   **现有实现问题**：
    在 [sqlite.rs#L433](file:///Users/shafreeck/Codes/Morphz/morphz/src/memory/sqlite.rs#L433) 中，分词匹配使用的是 `WHERE ? LIKE '%' || id || '%'`。
*   **性能瓶颈与雪崩分析**：
    *   **索引完全失效**：SQLite 的 B-Tree 索引在处理前后置通配符（如 `LIKE '%text%'`）时无法生效，强制引擎退化为**全表物理扫描**。
    *   **无语义理解与相关性评分**：LIKE 属于粗暴的字符包含匹配，无法提取词根，不支持同义词，且无法计算词频和相关性分值（如 BM25 算法），导致召回的内容纯属“噪音匹配”，污染了大模型的 Context 视口。

---

## 2. 工业级存储与检索层重构方案

为了彻底扭转“玩具级”的性能缺陷，我们将物理检索底座进行以下两项深度重构：

```
                    [ 混合物理检索底座 (SQLite 3 + WAL) ]
                                      │
           ┌──────────────────────────┴──────────────────────────┐
           ▼                                                     ▼
[ 1. 向量近邻搜索加速 (ANN) ]                              [ 2. 毫秒级全文检索 (FTS5) ]
• 方案 A: 静态链接 sqlite-vec 向量扩展                       • 创建虚表 graph_nodes_fts USING fts5
• 方案 B: 进程内嵌入式 HNSW 内存索引                         • 启用 Porter 词干解析与 BM25 相关性评级
• 检索复杂度: O(log N) 代替全表扫描                         • 基于 Trigger 触发器实现物理表与虚表实时同步
```

### 2.1 方案一：嵌入式 HNSW 向量索引（适合极速内嵌）
*   **实现原理**：
    在 Rust 控制面中嵌入 `hnsw_rs` 或 `space-lib` 库。进程启动时，执行 `SELECT id, embedding FROM graph_nodes WHERE embedding IS NOT NULL` 将向量数据一次性加载到内存中，并构建起一个 **HNSW（Hierarchical Navigable Small World）** 图索引。
*   **数据变动同步**：
    *   写入节点时，除了调用 `sqlx` 写入数据库，同步向内存中的 HNSW 索引插入该向量。
    *   物理删除节点时，同步在 HNSW 中剔除该向量。
*   **性能提升**：
    向量近邻搜索复杂度直接从 $\mathcal{O}(N)$ 降到 $\mathcal{O}(\log N)$。一次 $10^5$ 规模的检索在 CPU 单线程下仅需不到 1 毫秒，彻底免去磁盘 IO 与反序列化瓶颈。

### 2.2 方案二：SQLite FTS5 全文检索引擎（原生虚表召回）
*   **实现原理**：
    启用 SQLite 内置的 **FTS5** (Full-Text Search 5) 扩展。
*   **建表 DDL**：
    ```sql
    -- 创建 FTS5 虚拟表，只索引文本字段
    CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts USING fts5(
        id,
        label,
        properties_text,
        content="graph_nodes",  -- 外部表内容绑定
        content_rowid="rowid"
    );
    ```
*   **数据一致性（Triggers）**：
    在 SQLite 中建立三个触发器，在 `graph_nodes` 表发生 Insert, Update, Delete 时自动同步数据到 FTS5 虚拟表中，保证一致性：
    ```sql
    CREATE TRIGGER IF NOT EXISTS graph_nodes_ai AFTER INSERT ON graph_nodes BEGIN
        INSERT INTO graph_nodes_fts(rowid, id, label, properties_text) VALUES (new.rowid, new.id, new.label, json_extract(new.properties, '$.name'));
    END;
    
    CREATE TRIGGER IF NOT EXISTS graph_nodes_ad AFTER DELETE ON graph_nodes BEGIN
        INSERT INTO graph_nodes_fts(graph_nodes_fts, rowid, id, label, properties_text) VALUES('delete', old.rowid, old.id, old.label, json_extract(old.properties, '$.name'));
    END;
    
    CREATE TRIGGER IF NOT EXISTS graph_nodes_au AFTER UPDATE ON graph_nodes BEGIN
        INSERT INTO graph_nodes_fts(graph_nodes_fts, rowid, id, label, properties_text) VALUES('delete', old.rowid, old.id, old.label, json_extract(old.properties, '$.name'));
        INSERT INTO graph_nodes_fts(rowid, id, label, properties_text) VALUES (new.rowid, new.id, new.label, json_extract(new.properties, '$.name'));
    END;
    ```
*   **高效查询**：
    在 `search_nodes_by_text` 中摒弃 `LIKE`，直接使用 `MATCH` 语法，并利用 BM25 算法按相关度打分倒序返回：
    ```sql
    SELECT n.id, n.label, n.properties, n.embedding, n.is_permanent, n.last_accessed 
    FROM graph_nodes_fts f
    JOIN graph_nodes n ON f.rowid = n.rowid
    WHERE graph_nodes_fts MATCH ? 
    ORDER BY bm25(graph_nodes_fts) ASC 
    LIMIT ?;
    ```

---

## 3. SQLite 高并发读写分离重构 (WAL 极致利用)

目前的代码中为了规避 `database is locked` 将连接池最大数设为了 1（行 22），这在高并发 Spawn 子智能体时会导致严重读写排队。
*   **工业级连接池配置**：
    在 WAL 模式下，SQLite 完美支持**单写多读并发**。我们应该将连接池分离为读连接池与写连接池：
    1.  **写连接池**：最大连接数强制设为 1，确保串行写入，避免任何 `SQLITE_BUSY` 写写冲突。
    2.  **读连接池**：最大连接数设为 `CPU 核心数 * 2`，启用快照隔离，使得高频的大模型检索（读操作）能够与状态更新（写操作）完全并发进行，彻底消除锁竞争。
