//! Optional Graph/Vector/Embedding extension for Morphz.
//!
//! The core Runtime does not depend on this crate. This extension deliberately
//! reuses the historical `graph_nodes`, `graph_edges`, and `model_metadata`
//! SQLite tables so disabling it never destroys existing data.

use chrono::{DateTime, Utc};
use morphz::extension::{ExtensionError, RecallCandidate, RecallProvider, RecallRequest};
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub properties: HashMap<String, JsonValue>,
    pub embedding: Option<Vec<f32>>,
    pub is_permanent: bool,
    pub last_accessed: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphEdge {
    pub id: String,
    pub from_node: String,
    pub to_node: String,
    pub edge_type: String,
    #[serde(default)]
    pub properties: HashMap<String, JsonValue>,
    pub weight: f64,
    pub is_permanent: bool,
    pub last_accessed: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct VectorMemoryConfig {
    pub database_path: String,
    pub sqlite_pool_size: u32,
    pub search_limit: usize,
    pub similarity_threshold: f32,
}

impl VectorMemoryConfig {
    pub fn for_database(database_path: impl Into<String>) -> Self {
        Self {
            database_path: database_path.into(),
            ..Self::default()
        }
    }
}

impl Default for VectorMemoryConfig {
    fn default() -> Self {
        Self {
            database_path: "morphz.db".to_string(),
            sqlite_pool_size: 4,
            search_limit: 5,
            similarity_threshold: 0.45,
        }
    }
}

#[async_trait::async_trait]
pub trait EmbeddingProvider: Send + Sync {
    fn id(&self) -> &'static str;

    async fn embed(&self, text: &str) -> Result<Vec<f32>, ExtensionError>;
}

#[derive(Default)]
pub struct HashingEmbeddingProvider;

#[async_trait::async_trait]
impl EmbeddingProvider for HashingEmbeddingProvider {
    fn id(&self) -> &'static str {
        "hashing-ngram-256"
    }

    async fn embed(&self, text: &str) -> Result<Vec<f32>, ExtensionError> {
        Ok(local_hashing_embedding(text))
    }
}

pub struct OpenAiCompatibleEmbeddingProvider {
    http: HttpClient,
    base_url: String,
    api_key: String,
    model: String,
}

impl OpenAiCompatibleEmbeddingProvider {
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Result<Self, ExtensionError> {
        Ok(Self {
            http: HttpClient::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()?,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            model: model.into(),
        })
    }
}

#[derive(Serialize)]
struct EmbeddingRequest<'a> {
    model: &'a str,
    input: &'a str,
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingData>,
}

#[derive(Deserialize)]
struct EmbeddingData {
    embedding: Vec<f32>,
}

#[async_trait::async_trait]
impl EmbeddingProvider for OpenAiCompatibleEmbeddingProvider {
    fn id(&self) -> &'static str {
        "openai-compatible"
    }

    async fn embed(&self, text: &str) -> Result<Vec<f32>, ExtensionError> {
        let response = self
            .http
            .post(format!("{}/embeddings", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&EmbeddingRequest {
                model: &self.model,
                input: text,
            })
            .send()
            .await?
            .error_for_status()?;
        response
            .json::<EmbeddingResponse>()
            .await?
            .data
            .into_iter()
            .next()
            .map(|entry| entry.embedding)
            .ok_or_else(|| "Embedding 接口返回空 data".into())
    }
}

#[cfg(feature = "local-bge")]
pub struct LocalBgeEmbeddingProvider {
    store: executor::ModelStore,
}

#[cfg(feature = "local-bge")]
impl LocalBgeEmbeddingProvider {
    pub fn load() -> Result<Self, ExtensionError> {
        Ok(Self {
            store: executor::load_model()?,
        })
    }
}

#[cfg(feature = "local-bge")]
#[async_trait::async_trait]
impl EmbeddingProvider for LocalBgeEmbeddingProvider {
    fn id(&self) -> &'static str {
        "bge-small-zh-1.5"
    }

    async fn embed(&self, text: &str) -> Result<Vec<f32>, ExtensionError> {
        executor::compute_embedding(&self.store, text)
    }
}

#[derive(Clone)]
pub struct SqliteVectorMemory {
    pool: SqlitePool,
    config: VectorMemoryConfig,
    embeddings: Arc<dyn EmbeddingProvider>,
}

impl SqliteVectorMemory {
    pub async fn open(
        config: VectorMemoryConfig,
        embeddings: Arc<dyn EmbeddingProvider>,
    ) -> Result<Self, ExtensionError> {
        let options = SqliteConnectOptions::new()
            .filename(&config.database_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(std::time::Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(config.sqlite_pool_size.max(1))
            .connect_with(options)
            .await?;
        sqlx::query("PRAGMA foreign_keys = ON;")
            .execute(&pool)
            .await?;
        initialize_legacy_compatible_schema(&pool).await?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        for (key, value) in [
            ("embedding_provider", embeddings.id().to_string()),
            (
                "vector_filter_threshold",
                config.similarity_threshold.to_string(),
            ),
        ] {
            sqlx::query(
                "INSERT INTO model_metadata (key, value, updated_at) VALUES (?, ?, ?) \
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            )
            .bind(key)
            .bind(value)
            .bind(&now)
            .execute(&pool)
            .await?;
        }
        Ok(Self {
            pool,
            config,
            embeddings,
        })
    }

    pub async fn upsert_text_node(
        &self,
        id: impl Into<String>,
        label: impl Into<String>,
        properties: HashMap<String, JsonValue>,
        is_permanent: bool,
    ) -> Result<GraphNode, ExtensionError> {
        let id = id.into();
        let label = label.into();
        let semantic_text = format!("{} {}", label, serde_json::to_string(&properties)?);
        let embedding = self.embeddings.embed(&semantic_text).await?;
        let node = GraphNode {
            id,
            label,
            properties,
            embedding: Some(embedding),
            is_permanent,
            last_accessed: Utc::now(),
        };
        self.upsert_node(&node).await?;
        Ok(node)
    }

    pub async fn upsert_node(&self, node: &GraphNode) -> Result<(), ExtensionError> {
        sqlx::query(
            "INSERT INTO graph_nodes (id, label, properties, embedding, is_permanent, last_accessed) \
             VALUES (?, ?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET label=excluded.label, properties=excluded.properties, \
             embedding=COALESCE(excluded.embedding, graph_nodes.embedding), \
             is_permanent=excluded.is_permanent, last_accessed=excluded.last_accessed",
        )
        .bind(&node.id)
        .bind(&node.label)
        .bind(serde_json::to_string(&node.properties)?)
        .bind(encode_embedding(node.embedding.as_deref()))
        .bind(i64::from(node.is_permanent))
        .bind(node.last_accessed.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn upsert_edge(&self, edge: &GraphEdge) -> Result<(), ExtensionError> {
        sqlx::query(
            "INSERT INTO graph_edges \
             (id, from_node, to_node, type, properties, weight, is_permanent, last_accessed) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(from_node, to_node, type) DO UPDATE SET \
             id=excluded.id, properties=excluded.properties, weight=excluded.weight, \
             is_permanent=excluded.is_permanent, last_accessed=excluded.last_accessed",
        )
        .bind(&edge.id)
        .bind(&edge.from_node)
        .bind(&edge.to_node)
        .bind(&edge.edge_type)
        .bind(serde_json::to_string(&edge.properties)?)
        .bind(edge.weight)
        .bind(i64::from(edge.is_permanent))
        .bind(edge.last_accessed.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_node(&self, id: &str) -> Result<Option<GraphNode>, ExtensionError> {
        let row = sqlx::query(
            "SELECT id, label, properties, embedding, is_permanent, last_accessed \
             FROM graph_nodes WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(node_from_row).transpose()
    }

    pub async fn get_neighbors(
        &self,
        id: &str,
    ) -> Result<(Vec<GraphNode>, Vec<GraphEdge>), ExtensionError> {
        let node_rows = sqlx::query(
            "SELECT id, label, properties, embedding, is_permanent, last_accessed \
             FROM graph_nodes WHERE id IN (\
               SELECT to_node FROM graph_edges WHERE from_node = ? \
               UNION SELECT from_node FROM graph_edges WHERE to_node = ?\
             )",
        )
        .bind(id)
        .bind(id)
        .fetch_all(&self.pool)
        .await?;
        let edge_rows = sqlx::query(
            "SELECT id, from_node, to_node, type, properties, weight, is_permanent, last_accessed \
             FROM graph_edges WHERE from_node = ? OR to_node = ?",
        )
        .bind(id)
        .bind(id)
        .fetch_all(&self.pool)
        .await?;
        Ok((
            node_rows
                .iter()
                .map(node_from_row)
                .collect::<Result<_, _>>()?,
            edge_rows
                .iter()
                .map(edge_from_row)
                .collect::<Result<_, _>>()?,
        ))
    }

    pub async fn all(&self) -> Result<(Vec<GraphNode>, Vec<GraphEdge>), ExtensionError> {
        let nodes = sqlx::query(
            "SELECT id, label, properties, embedding, is_permanent, last_accessed FROM graph_nodes",
        )
        .fetch_all(&self.pool)
        .await?
        .iter()
        .map(node_from_row)
        .collect::<Result<Vec<_>, _>>()?;
        let edges = sqlx::query(
            "SELECT id, from_node, to_node, type, properties, weight, is_permanent, last_accessed FROM graph_edges",
        )
        .fetch_all(&self.pool)
        .await?
        .iter()
        .map(edge_from_row)
        .collect::<Result<Vec<_>, _>>()?;
        Ok((nodes, edges))
    }

    pub async fn search_text(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<GraphNode>, ExtensionError> {
        let limit = limit.max(1);
        let fts_rows = sqlx::query(
            "SELECT n.id, n.label, n.properties, n.embedding, n.is_permanent, n.last_accessed \
             FROM graph_nodes_fts f JOIN graph_nodes n ON f.rowid = n.rowid \
             WHERE graph_nodes_fts MATCH ? ORDER BY bm25(graph_nodes_fts) LIMIT ?",
        )
        .bind(query)
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await;
        let rows = match fts_rows {
            Ok(rows) => rows,
            Err(_) => {
                sqlx::query(
                    "SELECT id, label, properties, embedding, is_permanent, last_accessed \
                 FROM graph_nodes WHERE label LIKE ? OR properties LIKE ? LIMIT ?",
                )
                .bind(format!("%{query}%"))
                .bind(format!("%{query}%"))
                .bind(limit as i64)
                .fetch_all(&self.pool)
                .await?
            }
        };
        rows.iter().map(node_from_row).collect()
    }

    pub async fn search_vector(
        &self,
        query_embedding: &[f32],
        limit: usize,
    ) -> Result<Vec<(GraphNode, f32)>, ExtensionError> {
        if query_embedding.is_empty() {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            "SELECT id, label, properties, embedding, is_permanent, last_accessed \
             FROM graph_nodes WHERE embedding IS NOT NULL",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut scored = rows
            .iter()
            .map(node_from_row)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter_map(|node| {
                let score = cosine_similarity(query_embedding, node.embedding.as_deref()?);
                (score >= self.config.similarity_threshold).then_some((node, score))
            })
            .collect::<Vec<_>>();
        scored.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(Ordering::Equal));
        scored.truncate(limit.max(1));
        Ok(scored)
    }
}

#[async_trait::async_trait]
impl RecallProvider for SqliteVectorMemory {
    fn id(&self) -> &'static str {
        "morphz-memory-vector"
    }

    async fn recall(&self, request: RecallRequest) -> Result<Vec<RecallCandidate>, ExtensionError> {
        let limit = if request.limit == 0 {
            self.config.search_limit
        } else {
            request.limit
        };
        let embedding = self.embeddings.embed(&request.query).await?;
        let mut seen = HashSet::new();
        let mut candidates = Vec::new();
        for (node, score) in self.search_vector(&embedding, limit).await? {
            if !matches_scope(&node, &request) || !seen.insert(node.id.clone()) {
                continue;
            }
            candidates.push(candidate_from_node(node, Some(score)));
        }
        if candidates.len() < limit {
            for node in self.search_text(&request.query, limit).await? {
                if !matches_scope(&node, &request) || !seen.insert(node.id.clone()) {
                    continue;
                }
                candidates.push(candidate_from_node(node, None));
                if candidates.len() == limit {
                    break;
                }
            }
        }
        Ok(candidates)
    }
}

fn matches_scope(node: &GraphNode, request: &RecallRequest) -> bool {
    let context_matches = request.context_id.as_ref().is_none_or(|expected| {
        node.properties
            .get("context_id")
            .and_then(JsonValue::as_str)
            .is_none_or(|actual| actual == expected)
    });
    let session_matches = request.session_id.as_ref().is_none_or(|expected| {
        node.properties
            .get("session_id")
            .and_then(JsonValue::as_str)
            .is_none_or(|actual| actual == expected)
    });
    context_matches && session_matches
}

fn candidate_from_node(node: GraphNode, score: Option<f32>) -> RecallCandidate {
    let mut metadata = node.properties;
    metadata.insert("label".to_string(), json!(node.label));
    RecallCandidate {
        id: node.id,
        text: serde_json::to_string(&metadata).unwrap_or_default(),
        score,
        metadata,
    }
}

async fn initialize_legacy_compatible_schema(pool: &SqlitePool) -> Result<(), ExtensionError> {
    sqlx::query(
        r#"
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
        CREATE TABLE IF NOT EXISTS model_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts USING fts5(
            id UNINDEXED,
            label,
            properties_text,
            content='graph_nodes',
            content_rowid='rowid'
        );
        CREATE TRIGGER IF NOT EXISTS graph_nodes_ai AFTER INSERT ON graph_nodes BEGIN
            INSERT INTO graph_nodes_fts(rowid, id, label, properties_text)
            VALUES (new.rowid, new.id, new.label, new.properties);
        END;
        CREATE TRIGGER IF NOT EXISTS graph_nodes_ad AFTER DELETE ON graph_nodes BEGIN
            INSERT INTO graph_nodes_fts(graph_nodes_fts, rowid, id, label, properties_text)
            VALUES ('delete', old.rowid, old.id, old.label, old.properties);
        END;
        CREATE TRIGGER IF NOT EXISTS graph_nodes_au AFTER UPDATE ON graph_nodes BEGIN
            INSERT INTO graph_nodes_fts(graph_nodes_fts, rowid, id, label, properties_text)
            VALUES ('delete', old.rowid, old.id, old.label, old.properties);
            INSERT INTO graph_nodes_fts(rowid, id, label, properties_text)
            VALUES (new.rowid, new.id, new.label, new.properties);
        END;
        "#,
    )
    .execute(pool)
    .await?;
    // The historical FTS table names its JSON column `properties_text` while
    // the external content table names it `properties`. SQLite's `rebuild`
    // command assumes identical names and therefore fails on the legacy
    // schema. Re-index explicitly so old databases remain readable without a
    // destructive table migration.
    sqlx::query(
        "INSERT OR REPLACE INTO graph_nodes_fts(rowid, id, label, properties_text) \
         SELECT rowid, id, label, properties FROM graph_nodes",
    )
    .execute(pool)
    .await?;
    Ok(())
}

fn node_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<GraphNode, ExtensionError> {
    Ok(GraphNode {
        id: row.get("id"),
        label: row.get("label"),
        properties: serde_json::from_str(&row.get::<String, _>("properties"))?,
        embedding: row
            .get::<Option<Vec<u8>>, _>("embedding")
            .as_deref()
            .and_then(decode_embedding),
        is_permanent: row.get::<i64, _>("is_permanent") != 0,
        last_accessed: parse_time(&row.get::<String, _>("last_accessed")),
    })
}

fn edge_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<GraphEdge, ExtensionError> {
    Ok(GraphEdge {
        id: row.get("id"),
        from_node: row.get("from_node"),
        to_node: row.get("to_node"),
        edge_type: row.get("type"),
        properties: serde_json::from_str(&row.get::<String, _>("properties"))?,
        weight: row.get("weight"),
        is_permanent: row.get::<i64, _>("is_permanent") != 0,
        last_accessed: parse_time(&row.get::<String, _>("last_accessed")),
    })
}

fn parse_time(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

fn encode_embedding(vector: Option<&[f32]>) -> Option<Vec<u8>> {
    vector.map(|vector| {
        vector
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    })
}

fn decode_embedding(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return None;
    }
    bytes
        .chunks_exact(4)
        .map(|chunk| Some(f32::from_le_bytes(chunk.try_into().ok()?)))
        .collect()
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> f32 {
    if left.is_empty() || left.len() != right.len() {
        return 0.0;
    }
    let (mut dot, mut left_norm, mut right_norm) = (0.0, 0.0, 0.0);
    for (left, right) in left.iter().zip(right) {
        dot += left * right;
        left_norm += left * left;
        right_norm += right * right;
    }
    if left_norm == 0.0 || right_norm == 0.0 {
        0.0
    } else {
        dot / (left_norm.sqrt() * right_norm.sqrt())
    }
}

pub fn local_hashing_embedding(text: &str) -> Vec<f32> {
    const DIMENSION: usize = 256;
    let normalized = text
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || ('\u{4e00}'..='\u{9fff}').contains(&character)
                || matches!(character, '(' | ')')
            {
                character
            } else {
                ' '
            }
        })
        .collect::<String>();
    let mut vector = vec![0.0; DIMENSION];
    let mut add = |term: &[u8]| {
        let hash = term.iter().fold(0_u32, |hash, byte| {
            hash.wrapping_mul(31).wrapping_add(u32::from(*byte))
        });
        vector[hash as usize % DIMENSION] += 1.0;
    };
    for word in normalized.split_whitespace() {
        add(word.as_bytes());
        let chars = word.chars().collect::<Vec<_>>();
        for window in chars.windows(2) {
            add(window.iter().collect::<String>().as_bytes());
        }
    }
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in &mut vector {
            *value /= norm;
        }
    }
    vector
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[tokio::test]
    async fn extension_reopens_legacy_tables_and_recalls_without_lancedb() {
        let file = NamedTempFile::new().unwrap();
        let config = VectorMemoryConfig::for_database(file.path().to_string_lossy());
        let memory = SqliteVectorMemory::open(config.clone(), Arc::new(HashingEmbeddingProvider))
            .await
            .unwrap();
        let mut properties = HashMap::new();
        properties.insert("context_id".to_string(), json!("context-a"));
        memory
            .upsert_text_node("n1", "Morphz context runtime", properties, true)
            .await
            .unwrap();
        drop(memory);

        let reopened = SqliteVectorMemory::open(config, Arc::new(HashingEmbeddingProvider))
            .await
            .unwrap();
        let recalled = reopened
            .recall(RecallRequest {
                query: "context runtime".to_string(),
                limit: 5,
                context_id: Some("context-a".to_string()),
                session_id: None,
            })
            .await
            .unwrap();
        assert_eq!(recalled.len(), 1);
        assert_eq!(recalled[0].id, "n1");
        assert!(reopened
            .config
            .database_path
            .ends_with(file.path().file_name().unwrap().to_str().unwrap()));
    }

    #[test]
    fn hashing_embedding_is_deterministic_and_normalized() {
        let first = local_hashing_embedding("Morphz 上下文");
        let second = local_hashing_embedding("Morphz 上下文");
        assert_eq!(first, second);
        let norm = first.iter().map(|value| value * value).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 0.0001);
    }
}
