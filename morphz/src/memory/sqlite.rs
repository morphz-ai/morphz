use crate::config::MemoryConfig;
use crate::event::Event;
use crate::memory::{
    AgentBootstrapRecord, AgentRecord, CognitiveContextRecord, DelegationRecord, DelegationStatus,
    Edge, EventStore, GraphStore, MessageClaim, NewAgent, NewCognitiveContext, NewDelegation,
    NewSession, Node, QueryFilter, SessionMountKind, SessionRecord, SessionStatus, SessionStore,
    SessionUpdate,
};
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
            context_id TEXT,
            session_id TEXT,
            payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_topic ON events(topic);

        CREATE TABLE IF NOT EXISTS agents (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
            root_context_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cognitive_contexts (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            seed_context_id TEXT,
            seed_context_version INTEGER,
            seed_snapshot_hash TEXT,
            seed_projection TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_contexts_agent_updated
            ON cognitive_contexts(agent_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            context_id TEXT NOT NULL,
            parent_session_id TEXT,
            title TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_activity_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_agent_activity
            ON sessions(agent_id, last_activity_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);

        CREATE TABLE IF NOT EXISTS session_mounts (
            session_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            context_id TEXT NOT NULL,
            mount_kind TEXT NOT NULL,
            mounted_at TEXT NOT NULL,
            unmounted_at TEXT,
            PRIMARY KEY(session_id, generation),
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_session_mounts_context
            ON session_mounts(context_id, unmounted_at);

        CREATE TABLE IF NOT EXISTS delegations (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            parent_context_id TEXT NOT NULL,
            parent_session_id TEXT NOT NULL,
            child_context_id TEXT NOT NULL,
            child_session_id TEXT NOT NULL,
            task TEXT NOT NULL,
            success_when TEXT,
            context_scope TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
            result_event_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_delegations_parent
            ON delegations(parent_session_id, updated_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_delegations_child
            ON delegations(child_session_id);

        CREATE TABLE IF NOT EXISTS session_message_requests (
            session_id TEXT NOT NULL,
            client_message_id TEXT NOT NULL,
            event_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(session_id, client_message_id),
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

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

        let context_columns = sqlx::query("PRAGMA table_info(cognitive_contexts)")
            .fetch_all(&pool)
            .await?;
        for (name, definition) in [
            ("seed_context_id", "TEXT"),
            ("seed_context_version", "INTEGER"),
            ("seed_snapshot_hash", "TEXT"),
            ("seed_projection", "TEXT"),
        ] {
            if !context_columns
                .iter()
                .any(|row| row.get::<String, _>("name") == name)
            {
                sqlx::query(&format!(
                    "ALTER TABLE cognitive_contexts ADD COLUMN {name} {definition}"
                ))
                .execute(&pool)
                .await?;
            }
        }

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
        let has_context_id = columns
            .iter()
            .any(|row| row.get::<String, _>("name") == "context_id");
        if !has_context_id {
            sqlx::query("ALTER TABLE events ADD COLUMN context_id TEXT")
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
        sqlx::query(
            "UPDATE events SET context_id = COALESCE(json_extract(payload, '$.context_id'), session_id) WHERE context_id IS NULL",
        )
        .execute(&pool)
        .await?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_events_context_time ON events(context_id, timestamp)",
        )
        .execute(&pool)
        .await?;

        // Backfill product-level Session identities for databases created before
        // Session Registry v1. Context attachment is intentionally one-to-one in
        // this version; the separate column preserves the future shared/COW seam.
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"INSERT OR IGNORE INTO sessions
               (id, agent_id, context_id, parent_session_id, title, status, created_at, updated_at, last_activity_at)
               SELECT session_id, 'default-agent', COALESCE(MIN(context_id), session_id), NULL, session_id, 'active',
                      MIN(timestamp), MAX(timestamp), MAX(timestamp)
               FROM events
               WHERE session_id IS NOT NULL AND session_id != ''
               GROUP BY session_id"#,
        )
        .execute(&pool)
        .await?;
        sqlx::query(
            r#"INSERT OR IGNORE INTO cognitive_contexts
               (id, agent_id, title, status, created_at, updated_at)
               SELECT context_id, agent_id, context_id, 'active', MIN(created_at), MAX(updated_at)
               FROM sessions
               GROUP BY context_id, agent_id"#,
        )
        .execute(&pool)
        .await?;
        sqlx::query(
            r#"INSERT OR IGNORE INTO agents
               (id, title, status, root_context_id, created_at, updated_at)
               SELECT agent_id, agent_id, 'active', MIN(id), MIN(created_at), MAX(updated_at)
               FROM cognitive_contexts
               GROUP BY agent_id"#,
        )
        .execute(&pool)
        .await?;
        sqlx::query(
            r#"INSERT OR IGNORE INTO session_mounts
               (session_id, generation, context_id, mount_kind, mounted_at, unmounted_at)
               SELECT id, 1, context_id, 'existing_context', created_at, NULL
               FROM sessions"#,
        )
        .execute(&pool)
        .await?;
        // `events` can be empty, but retaining this bind-worthy value here makes
        // the migration timestamp policy explicit for future schema additions.
        let _migration_time = now;

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

fn parse_session_status(value: &str) -> SessionStatus {
    match value {
        "archived" => SessionStatus::Archived,
        _ => SessionStatus::Active,
    }
}

fn parse_delegation_status(value: &str) -> DelegationStatus {
    match value {
        "running" => DelegationStatus::Running,
        "completed" => DelegationStatus::Completed,
        "failed" => DelegationStatus::Failed,
        "cancelled" => DelegationStatus::Cancelled,
        _ => DelegationStatus::Queued,
    }
}

fn agent_from_row(row: &sqlx::sqlite::SqliteRow) -> AgentRecord {
    AgentRecord {
        id: row.get("id"),
        title: row.get("title"),
        status: parse_session_status(row.get::<String, _>("status").as_str()),
        root_context_id: row.get("root_context_id"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    }
}

fn delegation_from_row(row: &sqlx::sqlite::SqliteRow) -> DelegationRecord {
    DelegationRecord {
        id: row.get("id"),
        agent_id: row.get("agent_id"),
        parent_context_id: row.get("parent_context_id"),
        parent_session_id: row.get("parent_session_id"),
        child_context_id: row.get("child_context_id"),
        child_session_id: row.get("child_session_id"),
        task: row.get("task"),
        success_when: row.get("success_when"),
        context_scope: row.get("context_scope"),
        status: parse_delegation_status(row.get::<String, _>("status").as_str()),
        result_event_id: row.get("result_event_id"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    }
}

fn session_from_row(row: &sqlx::sqlite::SqliteRow) -> SessionRecord {
    SessionRecord {
        id: row.get("id"),
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        parent_session_id: row.get("parent_session_id"),
        title: row.get("title"),
        status: parse_session_status(row.get::<String, _>("status").as_str()),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
        last_activity_at: parse_time(&row.get::<String, _>("last_activity_at")),
    }
}

fn context_from_row(row: &sqlx::sqlite::SqliteRow) -> CognitiveContextRecord {
    CognitiveContextRecord {
        id: row.get("id"),
        agent_id: row.get("agent_id"),
        title: row.get("title"),
        status: parse_session_status(row.get::<String, _>("status").as_str()),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
        seed_context_id: row.get("seed_context_id"),
        seed_context_version: row
            .get::<Option<i64>, _>("seed_context_version")
            .and_then(|version| u64::try_from(version).ok()),
        seed_snapshot_hash: row.get("seed_snapshot_hash"),
        seed_projection: row.get("seed_projection"),
    }
}

#[async_trait::async_trait]
impl SessionStore for SqliteStore {
    async fn create_agent_bundle(
        &self,
        agent: NewAgent,
        root_context: NewCognitiveContext,
        initial_session: NewSession,
    ) -> Result<AgentBootstrapRecord, Box<dyn std::error::Error + Send + Sync>> {
        if agent.id != root_context.agent_id
            || agent.id != initial_session.agent_id
            || agent.root_context_id != root_context.id
            || root_context.id != initial_session.context_id
            || initial_session.parent_session_id.is_some()
            || initial_session.mount_kind != SessionMountKind::NewBlankContext
        {
            return Err("Agent Bootstrap 的 Agent/Root Context/Initial Session 路由不一致".into());
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO agents (id, title, status, root_context_id, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)",
        )
        .bind(&agent.id)
        .bind(&agent.title)
        .bind(&agent.root_context_id)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO cognitive_contexts (id, agent_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
        )
        .bind(&root_context.id)
        .bind(&root_context.agent_id)
        .bind(&root_context.title)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"INSERT INTO sessions
               (id, agent_id, context_id, parent_session_id, title, status, created_at, updated_at, last_activity_at)
               VALUES (?, ?, ?, NULL, ?, 'active', ?, ?, ?)"#,
        )
        .bind(&initial_session.id)
        .bind(&initial_session.agent_id)
        .bind(&initial_session.context_id)
        .bind(&initial_session.title)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO session_mounts (session_id, generation, context_id, mount_kind, mounted_at, unmounted_at) VALUES (?, 1, ?, 'new_blank_context', ?, NULL)",
        )
        .bind(&initial_session.id)
        .bind(&initial_session.context_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(AgentBootstrapRecord {
            agent: self
                .get_agent(&agent.id)
                .await?
                .ok_or("Agent Bootstrap 提交后无法读取 Agent")?,
            root_context: self
                .get_context(&root_context.id)
                .await?
                .ok_or("Agent Bootstrap 提交后无法读取 Root Context")?,
            initial_session: self
                .get_session(&initial_session.id)
                .await?
                .ok_or("Agent Bootstrap 提交后无法读取 Initial Session")?,
        })
    }

    async fn create_agent(
        &self,
        agent: NewAgent,
    ) -> Result<AgentRecord, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            "INSERT INTO agents (id, title, status, root_context_id, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)",
        )
        .bind(&agent.id)
        .bind(&agent.title)
        .bind(&agent.root_context_id)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.get_agent(&agent.id)
            .await?
            .ok_or_else(|| "Agent 创建后无法读取".into())
    }

    async fn ensure_agent(
        &self,
        agent: NewAgent,
    ) -> Result<AgentRecord, Box<dyn std::error::Error + Send + Sync>> {
        if let Some(existing) = self.get_agent(&agent.id).await? {
            if existing.root_context_id != agent.root_context_id {
                return Err(format!(
                    "Agent '{}' 的 Root Context 已是 '{}'，不能改为 '{}'",
                    agent.id, existing.root_context_id, agent.root_context_id
                )
                .into());
            }
            return Ok(existing);
        }
        match self.create_agent(agent.clone()).await {
            Ok(created) => Ok(created),
            Err(_) => self
                .get_agent(&agent.id)
                .await?
                .ok_or_else(|| "并发创建 Agent 失败".into()),
        }
    }

    async fn get_agent(
        &self,
        id: &str,
    ) -> Result<Option<AgentRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query(
            "SELECT id, title, status, root_context_id, created_at, updated_at FROM agents WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(agent_from_row))
    }

    async fn list_agents(
        &self,
        include_archived: bool,
    ) -> Result<Vec<AgentRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = if include_archived {
            sqlx::query("SELECT id, title, status, root_context_id, created_at, updated_at FROM agents ORDER BY updated_at DESC")
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query("SELECT id, title, status, root_context_id, created_at, updated_at FROM agents WHERE status = 'active' ORDER BY updated_at DESC")
                .fetch_all(&self.pool)
                .await?
        };
        Ok(rows.iter().map(agent_from_row).collect())
    }

    async fn create_context(
        &self,
        context: NewCognitiveContext,
    ) -> Result<CognitiveContextRecord, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            "INSERT INTO cognitive_contexts (id, agent_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
        )
        .bind(&context.id)
        .bind(&context.agent_id)
        .bind(&context.title)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.get_context(&context.id)
            .await?
            .ok_or_else(|| "Context 创建后无法读取".into())
    }

    async fn ensure_context(
        &self,
        context: NewCognitiveContext,
    ) -> Result<CognitiveContextRecord, Box<dyn std::error::Error + Send + Sync>> {
        if let Some(existing) = self.get_context(&context.id).await? {
            if existing.agent_id != context.agent_id {
                return Err(format!(
                    "Context '{}' 已属于 Agent '{}'，不能重新挂载到 '{}'",
                    context.id, existing.agent_id, context.agent_id
                )
                .into());
            }
            return Ok(existing);
        }
        match self.create_context(context.clone()).await {
            Ok(created) => Ok(created),
            Err(_) => self
                .get_context(&context.id)
                .await?
                .ok_or_else(|| "并发创建 Context 失败".into()),
        }
    }

    async fn get_context(
        &self,
        id: &str,
    ) -> Result<Option<CognitiveContextRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query(
            "SELECT id, agent_id, title, status, created_at, updated_at, seed_context_id, seed_context_version, seed_snapshot_hash, seed_projection FROM cognitive_contexts WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(context_from_row))
    }

    async fn list_contexts(
        &self,
        include_archived: bool,
    ) -> Result<Vec<CognitiveContextRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = if include_archived {
            sqlx::query("SELECT id, agent_id, title, status, created_at, updated_at, seed_context_id, seed_context_version, seed_snapshot_hash, seed_projection FROM cognitive_contexts ORDER BY updated_at DESC")
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query("SELECT id, agent_id, title, status, created_at, updated_at, seed_context_id, seed_context_version, seed_snapshot_hash, seed_projection FROM cognitive_contexts WHERE status = 'active' ORDER BY updated_at DESC")
                .fetch_all(&self.pool)
                .await?
        };
        Ok(rows.iter().map(context_from_row).collect())
    }

    async fn set_context_seed(
        &self,
        context_id: &str,
        source_context_id: &str,
        source_version: u64,
        snapshot_hash: &str,
        projection: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let source_version = i64::try_from(source_version)
            .map_err(|_| "Context seed version 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            "UPDATE cognitive_contexts SET seed_context_id = ?, seed_context_version = ?, seed_snapshot_hash = ?, seed_projection = ?, updated_at = ? WHERE id = ?",
        )
        .bind(source_context_id)
        .bind(source_version)
        .bind(snapshot_hash)
        .bind(projection)
        .bind(now)
        .bind(context_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            return Err(format!("目标 Context '{}' 不存在", context_id).into());
        }
        Ok(())
    }

    async fn create_session(
        &self,
        session: NewSession,
    ) -> Result<SessionRecord, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let context = self
            .get_context(&session.context_id)
            .await?
            .ok_or_else(|| format!("父 Context '{}' 不存在", session.context_id))?;
        if context.agent_id != session.agent_id {
            return Err(format!(
                "Session '{}' 的 Agent '{}' 与 Context '{}' 的 Agent '{}' 不一致",
                session.id, session.agent_id, session.context_id, context.agent_id
            )
            .into());
        }
        if let Some(parent_id) = session.parent_session_id.as_deref() {
            let parent = self
                .get_session(parent_id)
                .await?
                .ok_or_else(|| format!("父 Session '{}' 不存在", parent_id))?;
            if parent.context_id != session.context_id {
                return Err(format!(
                    "父 Session '{}' 属于 Context '{}'，不能作为 Context '{}' 内 Session 的父级",
                    parent_id, parent.context_id, session.context_id
                )
                .into());
            }
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"INSERT INTO sessions
               (id, agent_id, context_id, parent_session_id, title, status, created_at, updated_at, last_activity_at)
               VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)"#,
        )
        .bind(&session.id)
        .bind(&session.agent_id)
        .bind(&session.context_id)
        .bind(&session.parent_session_id)
        .bind(&session.title)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO session_mounts (session_id, generation, context_id, mount_kind, mounted_at, unmounted_at) VALUES (?, 1, ?, ?, ?, NULL)",
        )
        .bind(&session.id)
        .bind(&session.context_id)
        .bind(session.mount_kind.as_str())
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.get_session(&session.id)
            .await?
            .ok_or_else(|| "Session 创建后无法读取".into())
    }

    async fn ensure_session(
        &self,
        session: NewSession,
    ) -> Result<SessionRecord, Box<dyn std::error::Error + Send + Sync>> {
        if let Some(existing) = self.get_session(&session.id).await? {
            if existing.context_id != session.context_id || existing.agent_id != session.agent_id {
                return Err(format!(
                    "Session '{}' 已挂载到 Agent '{}'/Context '{}'，拒绝重新路由到 Agent '{}'/Context '{}'",
                    session.id,
                    existing.agent_id,
                    existing.context_id,
                    session.agent_id,
                    session.context_id
                )
                .into());
            }
            return Ok(existing);
        }
        match self.create_session(session.clone()).await {
            Ok(created) => Ok(created),
            Err(_) => self
                .get_session(&session.id)
                .await?
                .ok_or_else(|| "并发创建 Session 失败".into()),
        }
    }

    async fn get_session(
        &self,
        id: &str,
    ) -> Result<Option<SessionRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query(
            "SELECT id, agent_id, context_id, parent_session_id, title, status, created_at, updated_at, last_activity_at FROM sessions WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(session_from_row))
    }

    async fn list_sessions(
        &self,
        include_archived: bool,
    ) -> Result<Vec<SessionRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = if include_archived {
            sqlx::query("SELECT id, agent_id, context_id, parent_session_id, title, status, created_at, updated_at, last_activity_at FROM sessions ORDER BY last_activity_at DESC")
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query("SELECT id, agent_id, context_id, parent_session_id, title, status, created_at, updated_at, last_activity_at FROM sessions WHERE status = 'active' ORDER BY last_activity_at DESC")
                .fetch_all(&self.pool)
                .await?
        };
        Ok(rows.iter().map(session_from_row).collect())
    }

    async fn list_context_sessions(
        &self,
        context_id: &str,
        include_archived: bool,
    ) -> Result<Vec<SessionRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = if include_archived {
            sqlx::query("SELECT id, agent_id, context_id, parent_session_id, title, status, created_at, updated_at, last_activity_at FROM sessions WHERE context_id = ? ORDER BY last_activity_at DESC")
                .bind(context_id)
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query("SELECT id, agent_id, context_id, parent_session_id, title, status, created_at, updated_at, last_activity_at FROM sessions WHERE context_id = ? AND status = 'active' ORDER BY last_activity_at DESC")
                .bind(context_id)
                .fetch_all(&self.pool)
                .await?
        };
        Ok(rows.iter().map(session_from_row).collect())
    }

    async fn update_session(
        &self,
        id: &str,
        update: SessionUpdate,
    ) -> Result<Option<SessionRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if update.title.is_none() && update.status.is_none() {
            return self.get_session(id).await;
        }
        let existing = match self.get_session(id).await? {
            Some(existing) => existing,
            None => return Ok(None),
        };
        let title = update.title.unwrap_or(existing.title);
        let status = update.status.unwrap_or(existing.status);
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query("UPDATE sessions SET title = ?, status = ?, updated_at = ? WHERE id = ?")
            .bind(title)
            .bind(status.as_str())
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await?;
        self.get_session(id).await
    }

    async fn touch_session(
        &self,
        id: &str,
        at: DateTime<Utc>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let at = at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query("UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ?")
            .bind(&at)
            .bind(&at)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn claim_message(
        &self,
        session_id: &str,
        client_message_id: &str,
        event: &Event,
    ) -> Result<MessageClaim, Box<dyn std::error::Error + Send + Sync>> {
        let session = self
            .get_session(session_id)
            .await?
            .ok_or_else(|| format!("Session '{}' 不存在", session_id))?;
        let event_session_id = event
            .payload
            .get("session_id")
            .and_then(|value| value.as_str())
            .ok_or("用户消息缺少 session_id")?;
        let event_context_id = event
            .payload
            .get("context_id")
            .and_then(|value| value.as_str())
            .ok_or("用户消息缺少 context_id")?;
        if event_session_id != session_id || event_context_id != session.context_id {
            return Err(format!(
                "消息路由与 Session Registry 不一致：请求 Session='{}'，Event Session='{}'，Event Context='{}'，Registry Context='{}'",
                session_id, event_session_id, event_context_id, session.context_id
            )
            .into());
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            "INSERT OR IGNORE INTO session_message_requests (session_id, client_message_id, event_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(session_id)
        .bind(client_message_id)
        .bind(&event.id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 1 {
            let payload = serde_json::to_string(&event.payload)?;
            let timestamp = event
                .timestamp
                .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
            sqlx::query("INSERT INTO events (id, timestamp, actor, type, topic, context_id, session_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                .bind(&event.id)
                .bind(timestamp)
                .bind(&event.actor)
                .bind(&event.event_type)
                .bind(&event.topic)
                .bind(event_context_id)
                .bind(session_id)
                .bind(payload)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Ok(MessageClaim::Accepted);
        }
        let existing = sqlx::query(
            "SELECT event_id FROM session_message_requests WHERE session_id = ? AND client_message_id = ?",
        )
        .bind(session_id)
        .bind(client_message_id)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(MessageClaim::Existing {
            event_id: existing.get("event_id"),
        })
    }

    async fn create_delegation(
        &self,
        delegation: NewDelegation,
    ) -> Result<DelegationRecord, Box<dyn std::error::Error + Send + Sync>> {
        let parent = self
            .get_session(&delegation.parent_session_id)
            .await?
            .ok_or_else(|| format!("父 Session '{}' 不存在", delegation.parent_session_id))?;
        let child = self
            .get_session(&delegation.child_session_id)
            .await?
            .ok_or_else(|| format!("子 Session '{}' 不存在", delegation.child_session_id))?;
        if parent.context_id != delegation.parent_context_id
            || child.context_id != delegation.child_context_id
            || parent.agent_id != delegation.agent_id
            || child.agent_id != delegation.agent_id
        {
            return Err("Delegation 的 Agent/Context/Session 路由不一致".into());
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"INSERT INTO delegations
               (id, agent_id, parent_context_id, parent_session_id, child_context_id, child_session_id,
                task, success_when, context_scope, status, result_event_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?)"#,
        )
        .bind(&delegation.id)
        .bind(&delegation.agent_id)
        .bind(&delegation.parent_context_id)
        .bind(&delegation.parent_session_id)
        .bind(&delegation.child_context_id)
        .bind(&delegation.child_session_id)
        .bind(&delegation.task)
        .bind(&delegation.success_when)
        .bind(&delegation.context_scope)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.get_delegation(&delegation.id)
            .await?
            .ok_or_else(|| "Delegation 创建后无法读取".into())
    }

    async fn get_delegation(
        &self,
        id: &str,
    ) -> Result<Option<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query(
            "SELECT id, agent_id, parent_context_id, parent_session_id, child_context_id, child_session_id, task, success_when, context_scope, status, result_event_id, created_at, updated_at FROM delegations WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(delegation_from_row))
    }

    async fn get_delegation_by_child_session(
        &self,
        child_session_id: &str,
    ) -> Result<Option<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query(
            "SELECT id, agent_id, parent_context_id, parent_session_id, child_context_id, child_session_id, task, success_when, context_scope, status, result_event_id, created_at, updated_at FROM delegations WHERE child_session_id = ?",
        )
        .bind(child_session_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(delegation_from_row))
    }

    async fn list_delegations(
        &self,
    ) -> Result<Vec<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = sqlx::query(
            "SELECT id, agent_id, parent_context_id, parent_session_id, child_context_id, child_session_id, task, success_when, context_scope, status, result_event_id, created_at, updated_at FROM delegations ORDER BY updated_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(delegation_from_row).collect())
    }

    async fn update_delegation_status(
        &self,
        id: &str,
        status: DelegationStatus,
        result_event_id: Option<&str>,
    ) -> Result<Option<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            "UPDATE delegations SET status = ?, result_event_id = COALESCE(?, result_event_id), updated_at = ? WHERE id = ?",
        )
        .bind(status.as_str())
        .bind(result_event_id)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Ok(None);
        }
        self.get_delegation(id).await
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
        let context_id = ev
            .payload
            .get("context_id")
            .and_then(|value| value.as_str())
            .or(session_id);

        let result = sqlx::query("INSERT OR IGNORE INTO events (id, timestamp, actor, type, topic, context_id, session_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(&ev.id)
            .bind(&time_str)
            .bind(&ev.actor)
            .bind(&ev.event_type)
            .bind(&ev.topic)
            .bind(context_id)
            .bind(session_id)
            .bind(&payload_str)
            .execute(&self.pool)
            .await?;

        if result.rows_affected() == 0 {
            let existing = sqlx::query(
                "SELECT timestamp, actor, type, topic, context_id, session_id, payload FROM events WHERE id = ?",
            )
            .bind(&ev.id)
            .fetch_one(&self.pool)
            .await?;
            let same = existing.get::<String, _>("timestamp") == time_str
                && existing.get::<String, _>("actor") == ev.actor
                && existing.get::<String, _>("type") == ev.event_type
                && existing.get::<String, _>("topic") == ev.topic
                && existing.get::<Option<String>, _>("context_id").as_deref() == context_id
                && existing.get::<Option<String>, _>("session_id").as_deref() == session_id
                && existing.get::<String, _>("payload") == payload_str;
            if !same {
                return Err(format!("Event ID '{}' 已被不同内容占用", ev.id).into());
            }
        }

        Ok(())
    }

    async fn query(
        &self,
        filter: QueryFilter,
    ) -> Result<Vec<Event>, Box<dyn std::error::Error + Send + Sync>> {
        let mut builder = QueryBuilder::new(
            "SELECT rowid AS event_sequence, id, timestamp, actor, type, topic, payload FROM events WHERE 1=1",
        );

        if let Some(context_id) = filter.context_id {
            builder.push(" AND context_id = ");
            builder.push_bind(context_id);
        }

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
            let sequence: i64 = row.get("event_sequence");
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
                sequence: u64::try_from(sequence).ok(),
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
        let session = store
            .get_session("legacy-session")
            .await
            .unwrap()
            .expect("legacy Event 应回填 Session Registry");
        assert_eq!(session.context_id, "legacy-session");
        assert_eq!(session.agent_id, "default-agent");
    }

    #[tokio::test]
    async fn session_backfill_preserves_an_explicit_context_route() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        store
            .append(Event::new(
                "routed-event".to_string(),
                "eval".to_string(),
                "tool_output".to_string(),
                "chat/tool_output".to_string(),
                [
                    (
                        "context_id".to_string(),
                        serde_json::json!("shared-context"),
                    ),
                    (
                        "session_id".to_string(),
                        serde_json::json!("mounted-session"),
                    ),
                    ("text".to_string(), serde_json::json!("seed")),
                ]
                .into_iter()
                .collect(),
            ))
            .await
            .unwrap();
        store.pool.close().await;
        drop(store);

        let reopened = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let session = reopened
            .get_session("mounted-session")
            .await
            .unwrap()
            .expect("Event route should backfill the Session registry");
        assert_eq!(session.context_id, "shared-context");
    }

    #[tokio::test]
    async fn session_registry_persists_lifecycle_and_message_idempotency() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        store
            .create_context(NewCognitiveContext {
                id: "context-api-1".to_string(),
                agent_id: "agent-main".to_string(),
                title: "共享认知 Context".to_string(),
            })
            .await
            .unwrap();

        let created = store
            .create_session(NewSession {
                id: "session-api-1".to_string(),
                agent_id: "agent-main".to_string(),
                context_id: "context-api-1".to_string(),
                parent_session_id: None,
                title: "第一条会话".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        assert_eq!(created.context_id, "context-api-1");
        assert_eq!(created.status, SessionStatus::Active);

        let event_1 = Event::new(
            "event-1".to_string(),
            "user".to_string(),
            crate::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            vec![
                ("context_id".to_string(), serde_json::json!("context-api-1")),
                ("session_id".to_string(), serde_json::json!("session-api-1")),
                ("text".to_string(), serde_json::json!("first")),
            ]
            .into_iter()
            .collect(),
        );
        let event_2 = Event::new(
            "event-2".to_string(),
            "user".to_string(),
            crate::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            vec![
                ("context_id".to_string(), serde_json::json!("context-api-1")),
                ("session_id".to_string(), serde_json::json!("session-api-1")),
                ("text".to_string(), serde_json::json!("duplicate")),
            ]
            .into_iter()
            .collect(),
        );
        let first = store
            .claim_message("session-api-1", "client-1", &event_1)
            .await
            .unwrap();
        let duplicate = store
            .claim_message("session-api-1", "client-1", &event_2)
            .await
            .unwrap();
        assert_eq!(first, MessageClaim::Accepted);
        assert_eq!(
            duplicate,
            MessageClaim::Existing {
                event_id: "event-1".to_string()
            }
        );
        assert_eq!(
            store
                .query(QueryFilter {
                    session_id: Some("session-api-1".to_string()),
                    ..QueryFilter::default()
                })
                .await
                .unwrap()
                .len(),
            1
        );

        let archived = store
            .update_session(
                "session-api-1",
                SessionUpdate {
                    title: Some("已完成".to_string()),
                    status: Some(SessionStatus::Archived),
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(archived.title, "已完成");
        assert_eq!(archived.status, SessionStatus::Archived);
        assert!(store.list_sessions(false).await.unwrap().is_empty());
        assert_eq!(store.list_sessions(true).await.unwrap().len(), 1);

        drop(store);
        let restarted = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(
            restarted
                .get_session("session-api-1")
                .await
                .unwrap()
                .unwrap()
                .status,
            SessionStatus::Archived
        );
    }

    #[tokio::test]
    async fn agent_bootstrap_mounts_and_delegations_are_persistent_and_auditable() {
        let tmp_file = NamedTempFile::new().unwrap();
        let db_path = tmp_file.path().to_path_buf();
        let store = SqliteStore::new(db_path.to_str().unwrap()).await.unwrap();

        let bootstrap = store
            .create_agent_bundle(
                NewAgent {
                    id: "agent-lifecycle".to_string(),
                    title: "Lifecycle Agent".to_string(),
                    root_context_id: "context-root".to_string(),
                },
                NewCognitiveContext {
                    id: "context-root".to_string(),
                    agent_id: "agent-lifecycle".to_string(),
                    title: "Root".to_string(),
                },
                NewSession {
                    id: "session-root".to_string(),
                    agent_id: "agent-lifecycle".to_string(),
                    context_id: "context-root".to_string(),
                    parent_session_id: None,
                    title: "Initial".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        assert_eq!(bootstrap.agent.root_context_id, "context-root");

        let collision = store
            .create_agent_bundle(
                NewAgent {
                    id: "agent-lifecycle".to_string(),
                    title: "Duplicate".to_string(),
                    root_context_id: "context-should-not-exist".to_string(),
                },
                NewCognitiveContext {
                    id: "context-should-not-exist".to_string(),
                    agent_id: "agent-lifecycle".to_string(),
                    title: "Never committed".to_string(),
                },
                NewSession {
                    id: "session-should-not-exist".to_string(),
                    agent_id: "agent-lifecycle".to_string(),
                    context_id: "context-should-not-exist".to_string(),
                    parent_session_id: None,
                    title: "Never committed".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await;
        assert!(collision.is_err());
        assert!(store
            .get_context("context-should-not-exist")
            .await
            .unwrap()
            .is_none());
        assert!(store
            .get_session("session-should-not-exist")
            .await
            .unwrap()
            .is_none());

        store
            .create_context(NewCognitiveContext {
                id: "context-child".to_string(),
                agent_id: "agent-lifecycle".to_string(),
                title: "Delegated".to_string(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: "session-child".to_string(),
                agent_id: "agent-lifecycle".to_string(),
                context_id: "context-child".to_string(),
                parent_session_id: None,
                title: "Sub Agent".to_string(),
                mount_kind: SessionMountKind::DelegationProjection,
            })
            .await
            .unwrap();
        let delegation = store
            .create_delegation(NewDelegation {
                id: "delegation-1".to_string(),
                agent_id: "agent-lifecycle".to_string(),
                parent_context_id: "context-root".to_string(),
                parent_session_id: "session-root".to_string(),
                child_context_id: "context-child".to_string(),
                child_session_id: "session-child".to_string(),
                task: "verify lifecycle".to_string(),
                success_when: Some("done".to_string()),
                context_scope: "current_session".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(delegation.status, DelegationStatus::Queued);
        let completed = store
            .update_delegation_status(
                "delegation-1",
                DelegationStatus::Completed,
                Some("result-event"),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(completed.result_event_id.as_deref(), Some("result-event"));

        let mounts =
            sqlx::query("SELECT session_id, mount_kind FROM session_mounts ORDER BY session_id")
                .fetch_all(&store.pool)
                .await
                .unwrap()
                .into_iter()
                .map(|row| {
                    (
                        row.get::<String, _>("session_id"),
                        row.get::<String, _>("mount_kind"),
                    )
                })
                .collect::<HashMap<_, _>>();
        assert_eq!(
            mounts.get("session-root").map(String::as_str),
            Some("new_blank_context")
        );
        assert_eq!(
            mounts.get("session-child").map(String::as_str),
            Some("delegation_projection")
        );

        drop(store);
        let restarted = SqliteStore::new(db_path.to_str().unwrap()).await.unwrap();
        assert_eq!(restarted.list_agents(false).await.unwrap().len(), 1);
        assert_eq!(
            restarted
                .get_delegation("delegation-1")
                .await
                .unwrap()
                .unwrap()
                .status,
            DelegationStatus::Completed
        );
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
