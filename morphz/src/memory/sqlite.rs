use crate::event::Event;
use crate::memory::{Edge, EventStore, GraphStore, Node, QueryFilter};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{QueryBuilder, Row, SqlitePool};
use std::collections::HashMap;

pub struct SqliteStore {
    pool: SqlitePool,
}

impl SqliteStore {
    pub async fn new(db_path: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal);

        // 限制最大连接数为 1，以与 Go 端保持一致，规避 database is locked 竞争
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
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
        "#;

        sqlx::query(ddl).execute(&pool).await?;

        Ok(Self { pool })
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
    if buf.is_empty() || buf.len() % 4 != 0 {
        return None;
    }
    let vec = buf
        .chunks_exact(4)
        .map(|chunk| {
            let bytes = chunk.try_into().unwrap();
            f32::from_le_bytes(bytes)
        })
        .collect();
    Some(vec)
}

fn parse_time(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| {
            // 兼容其他可能非 RFC3339 的标准格式
            Utc::now()
        })
}

#[async_trait::async_trait]
impl EventStore for SqliteStore {
    async fn append(&self, ev: Event) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let payload_str = serde_json::to_string(&ev.payload)?;
        let time_str = ev
            .timestamp
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);

        sqlx::query("INSERT INTO events (id, timestamp, actor, type, topic, payload) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(&ev.id)
            .bind(&time_str)
            .bind(&ev.actor)
            .bind(&ev.event_type)
            .bind(&ev.topic)
            .bind(&payload_str)
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    async fn query(&self, filter: QueryFilter) -> Result<Vec<Event>, Box<dyn std::error::Error + Send + Sync>> {
        let mut builder = QueryBuilder::new("SELECT id, timestamp, actor, type, topic, payload FROM events WHERE 1=1");

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
        Ok(())
    }

    async fn delete_edge(&self, from_node: &str, to_node: &str, edge_type: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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

    async fn get_neighbors(&self, id: &str) -> Result<(Vec<Node>, Vec<Edge>), Box<dyn std::error::Error + Send + Sync>> {
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

        // 3. 自动将本次访问涉及到的点与边，更新 last_accessed 时间戳
        let new_last_acc = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        for edge in &edges {
            sqlx::query("UPDATE graph_edges SET last_accessed = ? WHERE id = ?")
                .bind(&new_last_acc)
                .bind(&edge.id)
                .execute(&self.pool)
                .await?;
        }
        for node in &nodes {
            sqlx::query("UPDATE graph_nodes SET last_accessed = ? WHERE id = ?")
                .bind(&new_last_acc)
                .bind(&node.id)
                .execute(&self.pool)
                .await?;
        }
        sqlx::query("UPDATE graph_nodes SET last_accessed = ? WHERE id = ?")
            .bind(&new_last_acc)
            .bind(id)
            .execute(&self.pool)
            .await?;

        Ok((nodes, edges))
    }

    async fn search_nodes_by_text(&self, text: &str) -> Result<Vec<Node>, Box<dyn std::error::Error + Send + Sync>> {
        let lower_text = text.to_lowercase();
        // Go: WHERE ? LIKE '%' || id || '%'
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

    async fn search_nodes_by_embedding(&self, query_embedding: &[f32], top_k: usize) -> Result<Vec<Node>, Box<dyn std::error::Error + Send + Sync>> {
        if query_embedding.is_empty() {
            return Ok(Vec::new());
        }

        let rows = sqlx::query("SELECT id, label, properties, embedding, is_permanent, last_accessed FROM graph_nodes WHERE embedding IS NOT NULL")
            .fetch_all(&self.pool)
            .await?;

        let mut candidates = Vec::new();
        for row in rows {
            let nid: String = row.get("id");
            let label: String = row.get("label");
            let properties_str: String = row.get("properties");
            let embedding_blob: Option<Vec<u8>> = row.get("embedding");
            let is_perm: i32 = row.get("is_permanent");
            let last_acc_str: String = row.get("last_accessed");

            let properties = serde_json::from_str(&properties_str)?;
            let embedding = embedding_blob.and_then(|b| decode_embedding(&b));

            if let Some(ref emb) = embedding {
                let sim = cosine_similarity(query_embedding, emb);
                let threshold = if query_embedding.len() == 256 { 0.45 } else { 0.70 };
                if sim >= threshold {
                    candidates.push((
                        Node {
                            id: nid,
                            label,
                            properties,
                            embedding,
                            is_permanent: is_perm == 1,
                            last_accessed: parse_time(&last_acc_str),
                        },
                        sim,
                    ));
                }
            }
        }

        candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let res = candidates
            .into_iter()
            .take(top_k)
            .map(|c| c.0)
            .collect();

        Ok(res)
    }

    async fn get_all_nodes_and_edges(&self) -> Result<(Vec<Node>, Vec<Edge>), Box<dyn std::error::Error + Send + Sync>> {
        let node_rows = sqlx::query("SELECT id, label, properties, embedding, is_permanent, last_accessed FROM graph_nodes")
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

    async fn query_path(&self, start_node_id: &str, max_depth: usize) -> Result<(Vec<Node>, Vec<Edge>), Box<dyn std::error::Error + Send + Sync>> {
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
                WHERE p.depth < ? AND e.rn <= 50
            )
            SELECT n.id, n.label, n.properties, n.embedding, n.is_permanent, n.last_accessed
            FROM path p
            JOIN graph_nodes n ON p.node_id = n.id;
        "#;

        let node_rows = sqlx::query(node_query)
            .bind(start_node_id)
            .bind(max_depth as i32)
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
                WHERE p.depth < ? AND e.rn <= 50
            )
            SELECT e.id, e.from_node, e.to_node, e.type, e.properties, e.weight, e.is_permanent, e.last_accessed
            FROM graph_edges e
            WHERE e.from_node IN (SELECT node_id FROM path)
              AND e.to_node IN (SELECT node_id FROM path);
        "#;

        let edge_rows = sqlx::query(edge_query)
            .bind(start_node_id)
            .bind(max_depth as i32)
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

        // 3. 将所经过的点和边全部标记为活跃状态（突触加强）
        let new_last_acc = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        for edge in &edges {
            sqlx::query("UPDATE graph_edges SET last_accessed = ? WHERE id = ?")
                .bind(&new_last_acc)
                .bind(&edge.id)
                .execute(&self.pool)
                .await?;
        }
        for node in &nodes {
            sqlx::query("UPDATE graph_nodes SET last_accessed = ? WHERE id = ?")
                .bind(&new_last_acc)
                .bind(&node.id)
                .execute(&self.pool)
                .await?;
        }

        Ok((nodes, edges))
    }

    async fn decay_and_prune(&self, decay_factor: f64, threshold: f64, inactive_seconds: i64) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut tx = self.pool.begin().await?;

        // 1. 突触弱化
        sqlx::query("UPDATE graph_edges SET weight = weight * ? WHERE is_permanent = 0")
            .bind(decay_factor)
            .execute(&mut *tx)
            .await?;

        // 2. 延迟清理
        let cutoff_time = (Utc::now() - chrono::Duration::seconds(inactive_seconds))
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);

        sqlx::query("DELETE FROM graph_edges WHERE is_permanent = 0 AND weight < ? AND last_accessed < ?")
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
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap()).await.unwrap();

        let mut payload = serde_json::Map::new();
        payload.insert("key".to_string(), serde_json::json!("value"));

        let ev = Event::new(
            "ev_1".to_string(),
            "actor_1".to_string(),
            "type_1".to_string(),
            "chat/topic_1".to_string(),
            payload,
        );

        store.append(ev).await.unwrap();

        let filter = QueryFilter {
            topic: Some("chat/*".to_string()),
            ..Default::default()
        };

        let results = store.query(filter).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "ev_1");
        assert_eq!(results[0].payload.get("key").unwrap().as_str().unwrap(), "value");
    }

    #[tokio::test]
    async fn test_sqlite_graph_store() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap()).await.unwrap();

        let node1 = Node {
            id: "node_1".to_string(),
            label: "Concept".to_string(),
            properties: HashMap::new(),
            embedding: Some(vec![1.0, 0.0]),
            is_permanent: false,
            last_accessed: Utc::now(),
        };

        let node2 = Node {
            id: "node_2".to_string(),
            label: "Concept".to_string(),
            properties: HashMap::new(),
            embedding: Some(vec![0.0, 1.0]),
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

        // 测试向量余弦搜索
        let results = store.search_nodes_by_embedding(&[1.0, 0.0], 5).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "node_1");
    }
}
