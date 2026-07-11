use crate::config::MemoryConfig;
use crate::event::Event;
use crate::memory::{Edge, EventStore, GraphStore, Node, QueryFilter};
use arrow_array::Array;
use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use lancedb::query::{ExecutableQuery, QueryBase};
use serde_json::Value as JsonValue;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{QueryBuilder, Row, SqlitePool};
use std::collections::HashMap;
use std::sync::Arc;

pub struct SqliteStore {
    pool: SqlitePool,
    vector_dim: i32,
    schema: Arc<arrow_schema::Schema>,
    lance_table: lancedb::Table,
    /// 基于模型元数据的向量过滤阈值（替代硬编码的 dim==256 判断）
    pub vector_filter_threshold: f32,
    fts_search_limit: usize,
    cte_path_width_limit: usize,
}

impl SqliteStore {
    pub async fn new(db_path: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Self::new_with_config(db_path, &MemoryConfig::default()).await
    }

    pub async fn new_with_config(
        db_path: &str,
        config: &MemoryConfig,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(std::time::Duration::from_secs(5)); // 5秒锁重试

        // 启用连接池并发，利用 WAL 模式的单写多读优势。
        let pool = SqlitePoolOptions::new()
            .max_connections(config.sqlite_pool_size.max(1))
            .connect_with(options)
            .await?;

        // 启用外键约束，以支持 ON DELETE CASCADE 级联删除
        sqlx::query("PRAGMA foreign_keys = ON;")
            .execute(&pool)
            .await?;

        // 初始化建表 DDL
        let ddl = r#"
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            actor TEXT NOT NULL,
            type TEXT NOT NULL,
            topic TEXT NOT NULL,
            session_id TEXT,
            payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_topic ON events(topic);

        CREATE TABLE IF NOT EXISTS graph_nodes (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            properties TEXT NOT NULL,
            embedding BLOB,
            is_permanent INTEGER DEFAULT 0,
            last_accessed TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS graph_edges (
            id TEXT PRIMARY KEY,
            from_node TEXT NOT NULL,
            to_node TEXT NOT NULL,
            type TEXT NOT NULL,
            properties TEXT NOT NULL,
            weight REAL DEFAULT 1.0,
            is_permanent INTEGER DEFAULT 0,
            last_accessed TEXT NOT NULL,
            FOREIGN KEY(from_node) REFERENCES graph_nodes(id) ON DELETE CASCADE,
            FOREIGN KEY(to_node) REFERENCES graph_nodes(id) ON DELETE CASCADE,
            UNIQUE(from_node, to_node, type)
        );
        CREATE INDEX IF NOT EXISTS idx_edges_from ON graph_edges(from_node);
        CREATE INDEX IF NOT EXISTS idx_edges_to ON graph_edges(to_node);

        -- 模型元数据表：记录嵌入模型、维度、相似度阈值（消除硬编码的 dim 启发式判断）
        CREATE TABLE IF NOT EXISTS model_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- 创建 FTS5 全文检索虚拟表，使用外部内容表指向 graph_nodes
        CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts USING fts5(
            id UNINDEXED,
            label,
            properties_text,
            content="graph_nodes",
            content_rowid="rowid"
        );

        -- Trigger: Insert
        CREATE TRIGGER IF NOT EXISTS graph_nodes_ai AFTER INSERT ON graph_nodes BEGIN
            INSERT INTO graph_nodes_fts(rowid, id, label, properties_text) 
            VALUES (new.rowid, new.id, new.label, new.properties);
        END;

        -- Trigger: Delete
        CREATE TRIGGER IF NOT EXISTS graph_nodes_ad AFTER DELETE ON graph_nodes BEGIN
            INSERT INTO graph_nodes_fts(graph_nodes_fts, rowid, id, label, properties_text) 
            VALUES('delete', old.rowid, old.id, old.label, old.properties);
        END;

        -- Trigger: Update
        CREATE TRIGGER IF NOT EXISTS graph_nodes_au AFTER UPDATE ON graph_nodes BEGIN
            INSERT INTO graph_nodes_fts(graph_nodes_fts, rowid, id, label, properties_text) 
            VALUES('delete', old.rowid, old.id, old.label, old.properties);
            INSERT INTO graph_nodes_fts(rowid, id, label, properties_text) 
            VALUES (new.rowid, new.id, new.label, new.properties);
        END;
        "#;

        sqlx::query(ddl).execute(&pool).await?;

        // v1 migration：旧 events 表没有 session_id 物理列。Context Engine 必须能按
        // session 精确查询，不能每轮加载全局事件后在 Rust 中过滤。
        let columns = sqlx::query("PRAGMA table_info(events)")
            .fetch_all(&pool)
            .await?;
        let has_session_id = columns
            .iter()
            .any(|row| row.get::<String, _>("name") == "session_id");
        if !has_session_id {
            sqlx::query("ALTER TABLE events ADD COLUMN session_id TEXT")
                .execute(&pool)
                .await?;
        }
        sqlx::query(
            "UPDATE events SET session_id = json_extract(payload, '$.session_id') WHERE session_id IS NULL",
        )
        .execute(&pool)
        .await?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_events_session_time ON events(session_id, timestamp)",
        )
        .execute(&pool)
        .await?;

        // 初始化 LanceDB
        // 根据 db_path 计算出独占的 lancedb 目录，保证单元测试完全隔离并防止并发写冲突
        let lance_dir = if db_path == "morphz.db" {
            let home = std::env::var("HOME").unwrap_or_default();
            std::path::Path::new(&home)
                .join(".morphz")
                .join("lancedb")
                .to_string_lossy()
                .to_string()
        } else {
            format!("{}_lancedb", db_path)
        };

        let _ = tokio::fs::create_dir_all(&lance_dir).await;
        let lance_conn = lancedb::connect(&lance_dir).execute().await?;

        // 动态判定向量维数
        let vector_dim = if std::path::Path::new("models/bge-small-zh-1.5").exists() {
            512
        } else {
            256
        };

        // 根据模型类型设定向量过滤阈值，并持久化到元数据表
        let (model_name, vector_filter_threshold) = if vector_dim == 512 {
            ("bge-small-zh-1.5", config.vector_filter_threshold_high)
        } else {
            ("hashing-ngram-256", config.vector_filter_threshold_low)
        };
        let now_str = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        for (key, value) in [
            ("embedding_model", model_name.to_string()),
            ("embedding_dim", vector_dim.to_string()),
            (
                "vector_filter_threshold",
                vector_filter_threshold.to_string(),
            ),
        ] {
            sqlx::query(
                r#"INSERT INTO model_metadata (key, value, updated_at) VALUES (?, ?, ?)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"#,
            )
            .bind(key)
            .bind(&value)
            .bind(&now_str)
            .execute(&pool)
            .await?;
        }

        // 构造 Schema
        let schema = Arc::new(arrow_schema::Schema::new(vec![
            arrow_schema::Field::new("id", arrow_schema::DataType::Utf8, false),
            arrow_schema::Field::new(
                "vector",
                arrow_schema::DataType::FixedSizeList(
                    Arc::new(arrow_schema::Field::new(
                        "item",
                        arrow_schema::DataType::Float32,
                        true,
                    )),
                    vector_dim,
                ),
                false,
            ),
        ]));

        let table = match lance_conn.open_table("graph_nodes_vector").execute().await {
            Ok(t) => t,
            Err(_) => {
                let empty_batch = arrow_array::RecordBatch::new_empty(schema.clone());
                lance_conn
                    .create_table("graph_nodes_vector", empty_batch)
                    .execute()
                    .await?
            }
        };

        Ok(Self {
            pool,
            vector_dim,
            schema,
            lance_table: table,
            vector_filter_threshold,
            fts_search_limit: config.fts_search_limit,
            cte_path_width_limit: config.cte_path_width_limit,
        })
    }
}

// 辅助编解码方法
fn encode_embedding(vec: &Option<Vec<f32>>) -> Option<Vec<u8>> {
    vec.as_ref().map(|v| {
        let mut buf = Vec::with_capacity(v.len() * 4);
        for &f in v {
            buf.extend_from_slice(&f.to_le_bytes());
        }
        buf
    })
}

fn decode_embedding(buf: &[u8]) -> Option<Vec<f32>> {
    if buf.is_empty() || !buf.len().is_multiple_of(4) {
        return None;
    }
    let vec: Option<Vec<f32>> = buf
        .chunks_exact(4)
        .map(|chunk| {
            let bytes: [u8; 4] = chunk.try_into().ok()?;
            Some(f32::from_le_bytes(bytes))
        })
        .collect();
    vec
}

fn parse_time(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| {
            // 兼容其他可能非 RFC3339 的标准格式
            Utc::now()
        })
}

/// 转义 LanceDB 查询中的单引号，防止 SQL 注入
fn escape_lance_id(id: &str) -> String {
    id.replace('\'', "''")
}

#[async_trait::async_trait]
impl EventStore for SqliteStore {
    async fn append(&self, ev: Event) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let payload_str = serde_json::to_string(&ev.payload)?;
        let time_str = ev
            .timestamp
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let session_id = ev
            .payload
            .get("session_id")
            .and_then(|value| value.as_str());

        sqlx::query("INSERT INTO events (id, timestamp, actor, type, topic, session_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(&ev.id)
            .bind(&time_str)
            .bind(&ev.actor)
            .bind(&ev.event_type)
            .bind(&ev.topic)
            .bind(session_id)
            .bind(&payload_str)
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    async fn query(
        &self,
        filter: QueryFilter,
    ) -> Result<Vec<Event>, Box<dyn std::error::Error + Send + Sync>> {
        let mut builder = QueryBuilder::new(
            "SELECT id, timestamp, actor, type, topic, payload FROM events WHERE 1=1",
        );

        if let Some(session_id) = filter.session_id {
            builder.push(" AND session_id = ");
            builder.push_bind(session_id);
        }

        if let Some(st) = filter.start_time {
            builder.push(" AND timestamp >= ");
            builder.push_bind(st.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        }
        if let Some(et) = filter.end_time {
            builder.push(" AND timestamp <= ");
            builder.push_bind(et.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        }

        if !filter.actors.is_empty() {
            builder.push(" AND actor IN (");
            let mut separated = builder.separated(", ");
            for actor in &filter.actors {
                separated.push_bind(actor);
            }
            builder.push(")");
        }

        if !filter.types.is_empty() {
            builder.push(" AND type IN (");
            let mut separated = builder.separated(", ");
            for t in &filter.types {
                separated.push_bind(t);
            }
            builder.push(")");
        }

        if let Some(topic) = filter.topic {
            if topic != "*" {
                if topic.ends_with("/*") {
                    let prefix = &topic[..topic.len() - 2];
                    builder.push(" AND topic LIKE ");
                    builder.push_bind(format!("{}/%", prefix));
                } else {
                    builder.push(" AND topic = ");
                    builder.push_bind(topic);
                }
            }
        }

        if let Some(search_query) = filter.search_query {
            builder.push(" AND (payload LIKE ");
            builder.push_bind(format!("%{}%", search_query));
            builder.push(" OR topic LIKE ");
            builder.push_bind(format!("%{}%", search_query));
            builder.push(")");
        }

        // 强制按时间戳升序排序，并在时间戳相同时按 rowid 物理插入顺序升序
        builder.push(" ORDER BY timestamp ASC, rowid ASC");

        if let Some(top_k) = filter.top_k {
            builder.push(" LIMIT ");
            builder.push_bind(top_k as i64);
        }

        let query = builder.build();
        let rows = query.fetch_all(&self.pool).await?;

        let mut events = Vec::new();
        for row in rows {
            let id: String = row.get("id");
            let timestamp_str: String = row.get("timestamp");
            let actor: String = row.get("actor");
            let event_type: String = row.get("type");
            let topic: String = row.get("topic");
            let payload_str: String = row.get("payload");

            let payload: serde_json::Map<String, JsonValue> = serde_json::from_str(&payload_str)?;
            let timestamp = parse_time(&timestamp_str);

            events.push(Event {
                id,
                timestamp,
                actor,
                event_type,
                topic,
                payload,
            });
        }

        Ok(events)
    }
}

#[async_trait::async_trait]
impl GraphStore for SqliteStore {
    async fn add_node(&self, node: Node) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let properties_str = serde_json::to_string(&node.properties)?;
        let embedding_blob = encode_embedding(&node.embedding);
        let is_perm = if node.is_permanent { 1 } else { 0 };
        let last_acc_str = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);

        let query = r#"
            INSERT INTO graph_nodes (id, label, properties, embedding, is_permanent, last_accessed)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                label=excluded.label,
                properties=excluded.properties,
                embedding=coalesce(excluded.embedding, graph_nodes.embedding),
                is_permanent=excluded.is_permanent,
                last_accessed=excluded.last_accessed
        "#;

        sqlx::query(query)
            .bind(&node.id)
            .bind(&node.label)
            .bind(&properties_str)
            .bind(&embedding_blob)
            .bind(is_perm)
            .bind(&last_acc_str)
            .execute(&self.pool)
            .await?;

        // 同步写入/更新 LanceDB 向量数据
        if let Some(ref emb) = node.embedding {
            let _ = self
                .lance_table
                .delete(&format!("id = '{}'", escape_lance_id(&node.id)))
                .await;

            use arrow_array::{FixedSizeListArray, Float32Array, RecordBatch, StringArray};

            let ids = StringArray::from(vec![node.id.as_str()]);
            let val_array = Float32Array::from(emb.clone());
            let values_ref: Arc<dyn arrow_array::Array> = Arc::new(val_array);
            let item_field = Arc::new(arrow_schema::Field::new(
                "item",
                arrow_schema::DataType::Float32,
                true,
            ));
            let list_array =
                FixedSizeListArray::try_new(item_field, self.vector_dim, values_ref, None)?;

            let batch = RecordBatch::try_new(
                self.schema.clone(),
                vec![Arc::new(ids), Arc::new(list_array)],
            )?;

            self.lance_table.add(batch).execute().await?;
        } else {
            let _ = self
                .lance_table
                .delete(&format!("id = '{}'", escape_lance_id(&node.id)))
                .await;
        }

        Ok(())
    }

    async fn add_edge(&self, edge: Edge) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let properties_str = serde_json::to_string(&edge.properties)?;
        let is_perm = if edge.is_permanent { 1 } else { 0 };
        let last_acc_str = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);

        let query = r#"
            INSERT INTO graph_edges (id, from_node, to_node, type, properties, weight, is_permanent, last_accessed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                properties=excluded.properties,
                weight=excluded.weight,
                is_permanent=excluded.is_permanent,
                last_accessed=excluded.last_accessed
        "#;

        sqlx::query(query)
            .bind(&edge.id)
            .bind(&edge.from_node)
            .bind(&edge.to_node)
            .bind(&edge.edge_type)
            .bind(&properties_str)
            .bind(edge.weight)
            .bind(is_perm)
            .bind(&last_acc_str)
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    async fn delete_node(&self, id: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query("DELETE FROM graph_nodes WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;

        // 从 LanceDB 中删除对应的向量记录
        let _ = self
            .lance_table
            .delete(&format!("id = '{}'", escape_lance_id(id)))
            .await;

        Ok(())
    }

    async fn delete_edge(
        &self,
        from_node: &str,
        to_node: &str,
        edge_type: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query("DELETE FROM graph_edges WHERE from_node = ? AND to_node = ? AND type = ?")
            .bind(from_node)
            .bind(to_node)
            .bind(edge_type)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn get_node(&self, id: &str) -> Result<Node, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query("SELECT id, label, properties, embedding, is_permanent, last_accessed FROM graph_nodes WHERE id = ?")
            .bind(id)
            .fetch_one(&self.pool)
            .await?;

        let id: String = row.get("id");
        let label: String = row.get("label");
        let properties_str: String = row.get("properties");
        let embedding_blob: Option<Vec<u8>> = row.get("embedding");
        let is_perm: i32 = row.get("is_permanent");
        let last_acc_str: String = row.get("last_accessed");

        let properties: HashMap<String, JsonValue> = serde_json::from_str(&properties_str)?;
        let embedding = embedding_blob.and_then(|b| decode_embedding(&b));
        let is_permanent = is_perm == 1;
        let last_accessed = parse_time(&last_acc_str);

        // 自动更新活跃状态
        let new_last_acc = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query("UPDATE graph_nodes SET last_accessed = ? WHERE id = ?")
            .bind(&new_last_acc)
            .bind(&id)
            .execute(&self.pool)
            .await?;

        Ok(Node {
            id,
            label,
            properties,
            embedding,
            is_permanent,
            last_accessed,
        })
    }

    async fn get_neighbors(
        &self,
        id: &str,
    ) -> Result<(Vec<Node>, Vec<Edge>), Box<dyn std::error::Error + Send + Sync>> {
        // 1. 查询相关的边
        let edge_rows = sqlx::query("SELECT id, from_node, to_node, type, properties, weight, is_permanent, last_accessed FROM graph_edges WHERE from_node = ? OR to_node = ?")
            .bind(id)
            .bind(id)
            .fetch_all(&self.pool)
            .await?;

        let mut edges = Vec::new();
        for row in edge_rows {
            let eid: String = row.get("id");
            let from_node: String = row.get("from_node");
            let to_node: String = row.get("to_node");
            let edge_type: String = row.get("type");
            let properties_str: String = row.get("properties");
            let weight: f64 = row.get("weight");
            let is_perm: i32 = row.get("is_permanent");
            let last_acc_str: String = row.get("last_accessed");

            let properties = serde_json::from_str(&properties_str)?;
            edges.push(Edge {
                id: eid,
                from_node,
                to_node,
                edge_type,
                properties,
                weight,
                is_permanent: is_perm == 1,
                last_accessed: parse_time(&last_acc_str),
            });
        }

        // 2. 查询相关的所有邻居节点（排重）
        let node_query = r#"
            SELECT id, label, properties, embedding, is_permanent, last_accessed FROM graph_nodes WHERE id IN (
                SELECT to_node FROM graph_edges WHERE from_node = ? AND to_node != ?
                UNION
                SELECT from_node FROM graph_edges WHERE to_node = ? AND from_node != ?
            )
        "#;
        let node_rows = sqlx::query(node_query)
            .bind(id)
            .bind(id)
            .bind(id)
            .bind(id)
            .fetch_all(&self.pool)
            .await?;

        let mut nodes = Vec::new();
        for row in node_rows {
            let nid: String = row.get("id");
            let label: String = row.get("label");
            let properties_str: String = row.get("properties");
            let embedding_blob: Option<Vec<u8>> = row.get("embedding");
            let is_perm: i32 = row.get("is_permanent");
            let last_acc_str: String = row.get("last_accessed");

            let properties = serde_json::from_str(&properties_str)?;
            let embedding = embedding_blob.and_then(|b| decode_embedding(&b));

            nodes.push(Node {
                id: nid,
                label,
                properties,
                embedding,
                is_permanent: is_perm == 1,
                last_accessed: parse_time(&last_acc_str),
            });
        }

        // 3. 自动将本次访问涉及到的点与边批量更新 last_accessed 时间戳（消除 N+1 查询）
        let new_last_acc = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        if !edges.is_empty() {
            let mut builder = QueryBuilder::new("UPDATE graph_edges SET last_accessed = ");
            builder.push_bind(&new_last_acc);
            builder.push(" WHERE id IN (");
            let mut sep = builder.separated(", ");
            for edge in &edges {
                sep.push_bind(&edge.id);
            }
            builder.push(")");
            builder.build().execute(&self.pool).await?;
        }

        if !nodes.is_empty() {
            let mut builder = QueryBuilder::new("UPDATE graph_nodes SET last_accessed = ");
            builder.push_bind(&new_last_acc);
            builder.push(" WHERE id IN (");
            let mut sep = builder.separated(", ");
            for node in &nodes {
                sep.push_bind(&node.id);
            }
            builder.push(")");
            builder.build().execute(&self.pool).await?;
        }

        sqlx::query("UPDATE graph_nodes SET last_accessed = ?1 WHERE id = ?2")
            .bind(&new_last_acc)
            .bind(id)
            .execute(&self.pool)
            .await?;

        Ok((nodes, edges))
    }

    async fn search_nodes_by_text(
        &self,
        text: &str,
    ) -> Result<Vec<Node>, Box<dyn std::error::Error + Send + Sync>> {
        let lower_text = text.to_lowercase();

        // 1. 尝试使用工业级 FTS5 全文检索 (BM25打分排序)
        let cleaned_match_text = text.replace(['"', '*', '\''], " ");
        let fts5_query = r#"
            SELECT n.id, n.label, n.properties, n.embedding, n.is_permanent, n.last_accessed 
            FROM graph_nodes_fts f
            JOIN graph_nodes n ON f.rowid = n.rowid
            WHERE graph_nodes_fts MATCH ? 
            ORDER BY bm25(graph_nodes_fts) ASC 
            LIMIT ?
        "#;

        if let Ok(rows) = sqlx::query(fts5_query)
            .bind(&cleaned_match_text)
            .bind(self.fts_search_limit as i64)
            .fetch_all(&self.pool)
            .await
        {
            if !rows.is_empty() {
                let mut nodes = Vec::new();
                for row in rows {
                    let nid: String = row.get("id");
                    let label: String = row.get("label");
                    let properties_str: String = row.get("properties");
                    let embedding_blob: Option<Vec<u8>> = row.get("embedding");
                    let is_perm: i32 = row.get("is_permanent");
                    let last_acc_str: String = row.get("last_accessed");

                    let properties = serde_json::from_str(&properties_str)?;
                    let embedding = embedding_blob.and_then(|b| decode_embedding(&b));

                    nodes.push(Node {
                        id: nid,
                        label,
                        properties,
                        embedding,
                        is_permanent: is_perm == 1,
                        last_accessed: parse_time(&last_acc_str),
                    });
                }
                return Ok(nodes);
            }
        }

        // 2. 降级兜底：FTS5 查询报错或零召回时使用传统的 LIKE 匹配
        let query = "SELECT id, label, properties, embedding, is_permanent, last_accessed FROM graph_nodes WHERE ? LIKE '%' || id || '%'";
        let rows = sqlx::query(query)
            .bind(&lower_text)
            .fetch_all(&self.pool)
            .await?;

        let mut nodes = Vec::new();
        for row in rows {
            let nid: String = row.get("id");
            let label: String = row.get("label");
            let properties_str: String = row.get("properties");
            let embedding_blob: Option<Vec<u8>> = row.get("embedding");
            let is_perm: i32 = row.get("is_permanent");
            let last_acc_str: String = row.get("last_accessed");

            let properties = serde_json::from_str(&properties_str)?;
            let embedding = embedding_blob.and_then(|b| decode_embedding(&b));

            nodes.push(Node {
                id: nid,
                label,
                properties,
                embedding,
                is_permanent: is_perm == 1,
                last_accessed: parse_time(&last_acc_str),
            });
        }
        Ok(nodes)
    }

    async fn search_nodes_by_embedding(
        &self,
        query_embedding: &[f32],
        top_k: usize,
    ) -> Result<Vec<Node>, Box<dyn std::error::Error + Send + Sync>> {
        if query_embedding.is_empty() {
            return Ok(Vec::new());
        }

        // 1. 使用 LanceDB 进行向量搜索
        let results = self
            .lance_table
            .query()
            .nearest_to(query_embedding)?
            .limit(top_k)
            .execute()
            .await?
            .try_collect::<Vec<arrow_array::RecordBatch>>()
            .await?;

        let mut matched_ids = Vec::new();
        for batch in results {
            if let Ok(idx) = batch.schema().index_of("id") {
                let col = batch.column(idx);
                let id_array = col
                    .as_any()
                    .downcast_ref::<arrow_array::StringArray>()
                    .ok_or("Failed to downcast id column to StringArray")?;
                for i in 0..id_array.len() {
                    matched_ids.push(id_array.value(i).to_string());
                }
            }
        }

        if matched_ids.is_empty() {
            return Ok(Vec::new());
        }

        // 2. 根据 matched_ids 批量主键查询
        let mut builder = sqlx::QueryBuilder::new("SELECT id, label, properties, embedding, is_permanent, last_accessed FROM graph_nodes WHERE id IN (");
        let mut separated = builder.separated(", ");
        for id in &matched_ids {
            separated.push_bind(id);
        }
        builder.push(")");

        let rows = builder.build().fetch_all(&self.pool).await?;

        // 3. 重建 Nodes 列表，维持 matched_ids 排序顺序
        let mut node_map = HashMap::new();
        for row in rows {
            let id: String = row.get("id");
            let label: String = row.get("label");
            let properties_str: String = row.get("properties");
            let embedding_blob: Option<Vec<u8>> = row.get("embedding");
            let is_perm: i32 = row.get("is_permanent");
            let last_acc_str: String = row.get("last_accessed");

            let properties = serde_json::from_str(&properties_str)?;
            let embedding = embedding_blob.and_then(|b| decode_embedding(&b));

            node_map.insert(
                id.clone(),
                Node {
                    id,
                    label,
                    properties,
                    embedding,
                    is_permanent: is_perm == 1,
                    last_accessed: parse_time(&last_acc_str),
                },
            );
        }

        let mut nodes = Vec::new();
        // Phase 2.2: 使用从模型元数据中读取的阈值替代硬编码的 dim==256 判断
        let threshold = self.vector_filter_threshold;
        for id in &matched_ids {
            if let Some(node) = node_map.remove(id) {
                if let Some(ref emb) = node.embedding {
                    let sim = cosine_similarity(query_embedding, emb);
                    if sim >= threshold {
                        nodes.push(node);
                    }
                } else {
                    nodes.push(node);
                }
            }
        }

        Ok(nodes)
    }

    async fn get_all_nodes_and_edges(
        &self,
    ) -> Result<(Vec<Node>, Vec<Edge>), Box<dyn std::error::Error + Send + Sync>> {
        let node_rows = sqlx::query(
            "SELECT id, label, properties, embedding, is_permanent, last_accessed FROM graph_nodes",
        )
        .fetch_all(&self.pool)
        .await?;

        let mut nodes = Vec::new();
        for row in node_rows {
            let nid: String = row.get("id");
            let label: String = row.get("label");
            let properties_str: String = row.get("properties");
            let embedding_blob: Option<Vec<u8>> = row.get("embedding");
            let is_perm: i32 = row.get("is_permanent");
            let last_acc_str: String = row.get("last_accessed");

            let properties = serde_json::from_str(&properties_str)?;
            let embedding = embedding_blob.and_then(|b| decode_embedding(&b));

            nodes.push(Node {
                id: nid,
                label,
                properties,
                embedding,
                is_permanent: is_perm == 1,
                last_accessed: parse_time(&last_acc_str),
            });
        }

        let edge_rows = sqlx::query("SELECT id, from_node, to_node, type, properties, weight, is_permanent, last_accessed FROM graph_edges")
            .fetch_all(&self.pool)
            .await?;

        let mut edges = Vec::new();
        for row in edge_rows {
            let eid: String = row.get("id");
            let from_node: String = row.get("from_node");
            let to_node: String = row.get("to_node");
            let edge_type: String = row.get("type");
            let properties_str: String = row.get("properties");
            let weight: f64 = row.get("weight");
            let is_perm: i32 = row.get("is_permanent");
            let last_acc_str: String = row.get("last_accessed");

            let properties = serde_json::from_str(&properties_str)?;

            edges.push(Edge {
                id: eid,
                from_node,
                to_node,
                edge_type,
                properties,
                weight,
                is_permanent: is_perm == 1,
                last_accessed: parse_time(&last_acc_str),
            });
        }

        Ok((nodes, edges))
    }

    async fn query_path(
        &self,
        start_node_id: &str,
        max_depth: usize,
    ) -> Result<(Vec<Node>, Vec<Edge>), Box<dyn std::error::Error + Send + Sync>> {
        let node_query = r#"
            WITH RECURSIVE path(node_id, depth) AS (
                SELECT ?, 0
                UNION
                SELECT e.to_node, p.depth + 1
                FROM (
                    SELECT from_node, to_node, 
                           ROW_NUMBER() OVER(PARTITION BY from_node ORDER BY weight DESC) as rn
                    FROM graph_edges
                ) e
                JOIN path p ON e.from_node = p.node_id
                WHERE p.depth < ? AND e.rn <= ?
            )
            SELECT n.id, n.label, n.properties, n.embedding, n.is_permanent, n.last_accessed
            FROM path p
            JOIN graph_nodes n ON p.node_id = n.id;
        "#;

        let node_rows = sqlx::query(node_query)
            .bind(start_node_id)
            .bind(max_depth as i32)
            .bind(self.cte_path_width_limit as i64)
            .fetch_all(&self.pool)
            .await?;

        let mut nodes = Vec::new();
        for row in node_rows {
            let nid: String = row.get("id");
            let label: String = row.get("label");
            let properties_str: String = row.get("properties");
            let embedding_blob: Option<Vec<u8>> = row.get("embedding");
            let is_perm: i32 = row.get("is_permanent");
            let last_acc_str: String = row.get("last_accessed");

            let properties = serde_json::from_str(&properties_str)?;
            let embedding = embedding_blob.and_then(|b| decode_embedding(&b));

            nodes.push(Node {
                id: nid,
                label,
                properties,
                embedding,
                is_permanent: is_perm == 1,
                last_accessed: parse_time(&last_acc_str),
            });
        }

        let edge_query = r#"
            WITH RECURSIVE path(node_id, depth) AS (
                SELECT ?, 0
                UNION
                SELECT e.to_node, p.depth + 1
                FROM (
                    SELECT from_node, to_node, 
                           ROW_NUMBER() OVER(PARTITION BY from_node ORDER BY weight DESC) as rn
                    FROM graph_edges
                ) e
                JOIN path p ON e.from_node = p.node_id
                WHERE p.depth < ? AND e.rn <= ?
            )
            SELECT e.id, e.from_node, e.to_node, e.type, e.properties, e.weight, e.is_permanent, e.last_accessed
            FROM graph_edges e
            WHERE e.from_node IN (SELECT node_id FROM path)
              AND e.to_node IN (SELECT node_id FROM path);
        "#;

        let edge_rows = sqlx::query(edge_query)
            .bind(start_node_id)
            .bind(max_depth as i32)
            .bind(self.cte_path_width_limit as i64)
            .fetch_all(&self.pool)
            .await?;

        let mut edges = Vec::new();
        for row in edge_rows {
            let eid: String = row.get("id");
            let from_node: String = row.get("from_node");
            let to_node: String = row.get("to_node");
            let edge_type: String = row.get("type");
            let properties_str: String = row.get("properties");
            let weight: f64 = row.get("weight");
            let is_perm: i32 = row.get("is_permanent");
            let last_acc_str: String = row.get("last_accessed");

            let properties = serde_json::from_str(&properties_str)?;

            edges.push(Edge {
                id: eid,
                from_node,
                to_node,
                edge_type,
                properties,
                weight,
                is_permanent: is_perm == 1,
                last_accessed: parse_time(&last_acc_str),
            });
        }

        // 3. 将所经过的点和边全部标记为活跃状态（批量更新消除 N+1）
        let new_last_acc = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        if !edges.is_empty() {
            let mut builder = QueryBuilder::new("UPDATE graph_edges SET last_accessed = ");
            builder.push_bind(&new_last_acc);
            builder.push(" WHERE id IN (");
            let mut sep = builder.separated(", ");
            for edge in &edges {
                sep.push_bind(&edge.id);
            }
            builder.push(")");
            builder.build().execute(&self.pool).await?;
        }
        if !nodes.is_empty() {
            let mut builder = QueryBuilder::new("UPDATE graph_nodes SET last_accessed = ");
            builder.push_bind(&new_last_acc);
            builder.push(" WHERE id IN (");
            let mut sep = builder.separated(", ");
            for node in &nodes {
                sep.push_bind(&node.id);
            }
            builder.push(")");
            builder.build().execute(&self.pool).await?;
        }

        Ok((nodes, edges))
    }

    async fn bulk_upsert_in_transaction(
        &self,
        nodes: Vec<Node>,
        edges: Vec<Edge>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // 使用 SQLite 事务包裹批量写入，保证原子性：任一节点/边写入失败则全部回滚
        let mut tx = self.pool.begin().await?;
        let now_str = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);

        for node in &nodes {
            let properties_str = serde_json::to_string(&node.properties)?;
            let embedding_blob = encode_embedding(&node.embedding);
            let is_perm = if node.is_permanent { 1 } else { 0 };

            sqlx::query(
                r#"INSERT INTO graph_nodes (id, label, properties, embedding, is_permanent, last_accessed)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                       label=excluded.label,
                       properties=excluded.properties,
                       embedding=coalesce(excluded.embedding, graph_nodes.embedding),
                       is_permanent=excluded.is_permanent,
                       last_accessed=excluded.last_accessed"#,
            )
            .bind(&node.id)
            .bind(&node.label)
            .bind(&properties_str)
            .bind(&embedding_blob)
            .bind(is_perm)
            .bind(&now_str)
            .execute(&mut *tx)
            .await?;
        }

        for edge in &edges {
            let properties_str = serde_json::to_string(&edge.properties)?;
            let is_perm = if edge.is_permanent { 1 } else { 0 };

            sqlx::query(
                r#"INSERT INTO graph_edges (id, from_node, to_node, type, properties, weight, is_permanent, last_accessed)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                       properties=excluded.properties,
                       weight=excluded.weight,
                       is_permanent=excluded.is_permanent,
                       last_accessed=excluded.last_accessed"#,
            )
            .bind(&edge.id)
            .bind(&edge.from_node)
            .bind(&edge.to_node)
            .bind(&edge.edge_type)
            .bind(&properties_str)
            .bind(edge.weight)
            .bind(is_perm)
            .bind(&now_str)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;

        // LanceDB 向量数据在事务外异步写入（LanceDB 自身无分布式事务支持）
        for node in nodes {
            if let Some(ref emb) = node.embedding {
                let _ = self
                    .lance_table
                    .delete(&format!("id = '{}'", escape_lance_id(&node.id)))
                    .await;
                use arrow_array::{FixedSizeListArray, Float32Array, RecordBatch, StringArray};
                let ids = StringArray::from(vec![node.id.as_str()]);
                let val_array = Float32Array::from(emb.clone());
                let values_ref: Arc<dyn arrow_array::Array> = Arc::new(val_array);
                let item_field = Arc::new(arrow_schema::Field::new(
                    "item",
                    arrow_schema::DataType::Float32,
                    true,
                ));
                let list_array =
                    FixedSizeListArray::try_new(item_field, self.vector_dim, values_ref, None)?;
                let batch = RecordBatch::try_new(
                    self.schema.clone(),
                    vec![Arc::new(ids), Arc::new(list_array)],
                )?;
                self.lance_table.add(batch).execute().await?;
            }
        }

        Ok(())
    }

    async fn decay_and_prune(
        &self,
        decay_factor: f64,
        threshold: f64,
        inactive_seconds: i64,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut tx = self.pool.begin().await?;

        // 1. 突触弱化
        sqlx::query("UPDATE graph_edges SET weight = weight * ? WHERE is_permanent = 0")
            .bind(decay_factor)
            .execute(&mut *tx)
            .await?;

        // 2. 延迟清理
        let cutoff_time = (Utc::now() - chrono::Duration::seconds(inactive_seconds))
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);

        sqlx::query(
            "DELETE FROM graph_edges WHERE is_permanent = 0 AND weight < ? AND last_accessed < ?",
        )
        .bind(threshold)
        .bind(&cutoff_time)
        .execute(&mut *tx)
        .await?;

        // 3. 孤立节点物理擦除
        let prune_nodes_sql = r#"
            DELETE FROM graph_nodes 
            WHERE is_permanent = 0 
              AND last_accessed < ? 
              AND id NOT IN (
                  SELECT from_node FROM graph_edges
                  UNION
                  SELECT to_node FROM graph_edges
              )
        "#;
        sqlx::query(prune_nodes_sql)
            .bind(&cutoff_time)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        Ok(())
    }
}

#[allow(dead_code)]
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::QueryFilter;
    use tempfile::NamedTempFile;

    #[tokio::test]
    async fn test_sqlite_event_store() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();

        let mut payload = serde_json::Map::new();
        payload.insert("key".to_string(), serde_json::json!("value"));
        payload.insert("session_id".to_string(), serde_json::json!("session-a"));

        let ev = Event::new(
            "ev_1".to_string(),
            "actor_1".to_string(),
            "type_1".to_string(),
            "chat/topic_1".to_string(),
            payload,
        );

        store.append(ev).await.unwrap();

        let filter = QueryFilter {
            session_id: Some("session-a".to_string()),
            topic: Some("chat/*".to_string()),
            ..Default::default()
        };

        let results = store.query(filter).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "ev_1");
        assert_eq!(
            results[0].payload.get("key").unwrap().as_str().unwrap(),
            "value"
        );

        let other_session = store
            .query(QueryFilter {
                session_id: Some("session-b".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(other_session.is_empty());
    }

    #[tokio::test]
    async fn test_event_schema_migrates_and_backfills_session_id() {
        let tmp_file = NamedTempFile::new().unwrap();
        let url = format!("sqlite://{}", tmp_file.path().display());
        let legacy_pool = SqlitePool::connect(&url).await.unwrap();
        sqlx::query(
            "CREATE TABLE events (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, topic TEXT NOT NULL, payload TEXT NOT NULL)",
        )
        .execute(&legacy_pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO events (id, timestamp, actor, type, topic, payload) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("legacy-event")
        .bind(Utc::now().to_rfc3339())
        .bind("legacy")
        .bind("user_message")
        .bind("chat/user_message")
        .bind(r#"{"session_id":"legacy-session","text":"hello"}"#)
        .execute(&legacy_pool)
        .await
        .unwrap();
        legacy_pool.close().await;

        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let events = store
            .query(QueryFilter {
                session_id: Some("legacy-session".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "legacy-event");
    }

    #[tokio::test]
    async fn test_sqlite_graph_store() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();

        let mut emb1 = vec![0.0; store.vector_dim as usize];
        emb1[0] = 1.0;
        let mut emb2 = vec![0.0; store.vector_dim as usize];
        emb2[1] = 1.0;

        let node1 = Node {
            id: "node_1".to_string(),
            label: "Concept".to_string(),
            properties: HashMap::new(),
            embedding: Some(emb1),
            is_permanent: false,
            last_accessed: Utc::now(),
        };

        let node2 = Node {
            id: "node_2".to_string(),
            label: "Concept".to_string(),
            properties: HashMap::new(),
            embedding: Some(emb2),
            is_permanent: false,
            last_accessed: Utc::now(),
        };

        store.add_node(node1).await.unwrap();
        store.add_node(node2).await.unwrap();

        let edge = Edge {
            id: "edge_12".to_string(),
            from_node: "node_1".to_string(),
            to_node: "node_2".to_string(),
            edge_type: "related".to_string(),
            properties: HashMap::new(),
            weight: 1.0,
            is_permanent: false,
            last_accessed: Utc::now(),
        };

        store.add_edge(edge).await.unwrap();

        let (nodes, edges) = store.get_neighbors("node_1").await.unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].id, "node_2");
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].id, "edge_12");

        let mut search_emb = vec![0.0; store.vector_dim as usize];
        search_emb[0] = 1.0;

        // 测试向量余弦搜索
        let results = store
            .search_nodes_by_embedding(&search_emb, 5)
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "node_1");
    }
}
