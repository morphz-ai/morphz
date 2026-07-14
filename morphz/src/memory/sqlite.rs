use crate::config::MemoryConfig;
use crate::event::Event;
use crate::memory::{
    AgentBootstrapRecord, AgentRecord, CognitiveContextRecord, DelegationRecord, DelegationStatus,
    EvaluationWorkItemMutation, EvaluationWorkItemRecord, EvaluationWorkItemStatus, EventStore,
    MessageClaim, NewAgent, NewCognitiveContext, NewDelegation, NewEvaluationWorkItem,
    NewObjective, NewSession, ObjectiveMutation, ObjectiveRecord, ObjectiveStatus, ObjectiveStore,
    ObjectiveWaitCondition, QueryFilter, ReplyCommit, SessionAttentionState,
    SessionAttentionUpdate, SessionMountKind, SessionRecord, SessionStatus, SessionStore,
    SessionUpdate,
};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{QueryBuilder, Row, SqlitePool};

pub struct SqliteStore {
    pool: SqlitePool,
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
        CREATE INDEX IF NOT EXISTS idx_events_session_time ON events(session_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_context_time ON events(context_id, timestamp);

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
            attention_state TEXT NOT NULL DEFAULT 'active' CHECK(attention_state IN ('active', 'retired')),
            attention_revision INTEGER NOT NULL DEFAULT 0 CHECK(attention_revision >= 0),
            attention_reason TEXT,
            attention_changed_at TEXT,
            attention_event_id TEXT,
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

        CREATE TABLE IF NOT EXISTS objectives (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            context_id TEXT NOT NULL,
            coordinator_session_id TEXT NOT NULL,
            delivery_session_id TEXT NOT NULL,
            parent_objective_id TEXT,
            source_event_id TEXT NOT NULL,
            stated_objective TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision >= 1),
            status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'blocked', 'completed', 'cancelled', 'failed')),
            status_reason TEXT,
            wait_condition_json TEXT,
            active_evaluation_id TEXT,
            evaluation_lease_expires_at TEXT,
            continuation_sequence INTEGER NOT NULL DEFAULT 0 CHECK(continuation_sequence >= 0),
            token_budget INTEGER,
            tokens_used INTEGER NOT NULL DEFAULT 0 CHECK(tokens_used >= 0),
            time_used_seconds INTEGER NOT NULL DEFAULT 0 CHECK(time_used_seconds >= 0),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(context_id) REFERENCES cognitive_contexts(id),
            FOREIGN KEY(coordinator_session_id) REFERENCES sessions(id),
            FOREIGN KEY(delivery_session_id) REFERENCES sessions(id),
            FOREIGN KEY(parent_objective_id) REFERENCES objectives(id)
        );
        CREATE INDEX IF NOT EXISTS idx_objectives_context_status_updated
            ON objectives(context_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_objectives_coordinator_status
            ON objectives(coordinator_session_id, status);

        CREATE TABLE IF NOT EXISTS session_message_requests (
            session_id TEXT NOT NULL,
            client_message_id TEXT NOT NULL,
            event_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(session_id, client_message_id),
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS evaluation_work_items (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            agent_id TEXT NOT NULL,
            context_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            trigger_event_id TEXT NOT NULL UNIQUE,
            trigger_sequence INTEGER NOT NULL CHECK(trigger_sequence >= 0),
            trigger_kind TEXT NOT NULL,
            parent_work_item_id TEXT,
            root_turn_id TEXT NOT NULL,
            context_snapshot_version INTEGER,
            status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'waiting_tool', 'waiting_external', 'completed', 'cancelled', 'failed')),
            claimed_by TEXT,
            lease_expires_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(parent_work_item_id) REFERENCES evaluation_work_items(id)
        );
        CREATE INDEX IF NOT EXISTS idx_evaluation_work_items_session_status
            ON evaluation_work_items(session_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_evaluation_work_items_context_status
            ON evaluation_work_items(context_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_evaluation_work_items_lease
            ON evaluation_work_items(status, lease_expires_at);
        CREATE INDEX IF NOT EXISTS idx_evaluation_work_items_root_turn
            ON evaluation_work_items(root_turn_id, updated_at);

        CREATE TABLE IF NOT EXISTS evaluation_replies (
            session_id TEXT NOT NULL,
            root_turn_id TEXT NOT NULL,
            disposition TEXT NOT NULL,
            event_id TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            PRIMARY KEY(session_id, root_turn_id),
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        "#;

        sqlx::query(ddl).execute(&pool).await?;

        let mount_columns = sqlx::query("PRAGMA table_info(session_mounts)")
            .fetch_all(&pool)
            .await?;
        let mount_columns = mount_columns
            .iter()
            .map(|row| row.get::<String, _>("name"))
            .collect::<std::collections::HashSet<_>>();
        for (name, definition) in [
            (
                "attention_state",
                "TEXT NOT NULL DEFAULT 'active' CHECK(attention_state IN ('active', 'retired'))",
            ),
            (
                "attention_revision",
                "INTEGER NOT NULL DEFAULT 0 CHECK(attention_revision >= 0)",
            ),
            ("attention_reason", "TEXT"),
            ("attention_changed_at", "TEXT"),
            ("attention_event_id", "TEXT"),
        ] {
            if !mount_columns.contains(name) {
                sqlx::query(&format!(
                    "ALTER TABLE session_mounts ADD COLUMN {name} {definition}"
                ))
                .execute(&pool)
                .await?;
            }
        }

        // Objective reasons were originally present only in the immutable
        // event ledger. Keep the current-state projection self-contained for
        // product surfaces while preserving those source events.
        let objective_columns = sqlx::query("PRAGMA table_info(objectives)")
            .fetch_all(&pool)
            .await?;
        if !objective_columns
            .iter()
            .any(|row| row.get::<String, _>("name") == "status_reason")
        {
            sqlx::query("ALTER TABLE objectives ADD COLUMN status_reason TEXT")
                .execute(&pool)
                .await?;
            backfill_objective_status_reasons(&pool).await?;
        }

        Ok(Self { pool })
    }
}

async fn backfill_objective_status_reasons(
    pool: &SqlitePool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let events = sqlx::query(
        "SELECT payload FROM events WHERE type = 'objective_control' AND topic = 'objective/updated' ORDER BY timestamp",
    )
    .fetch_all(pool)
    .await?;
    for row in events {
        let payload = serde_json::from_str::<JsonValue>(&row.get::<String, _>("payload"))?;
        let Some(objective_id) = payload.get("objective_id").and_then(JsonValue::as_str) else {
            continue;
        };
        let Some(reason) = payload.get("reason").and_then(JsonValue::as_str) else {
            continue;
        };
        sqlx::query("UPDATE objectives SET status_reason = ? WHERE id = ?")
            .bind(reason)
            .bind(objective_id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

fn parse_session_status(value: &str) -> SessionStatus {
    match value {
        "archived" => SessionStatus::Archived,
        _ => SessionStatus::Active,
    }
}

fn parse_session_attention_state(value: &str) -> SessionAttentionState {
    match value {
        "retired" => SessionAttentionState::Retired,
        _ => SessionAttentionState::Active,
    }
}

fn parse_evaluation_work_item_status(
    value: &str,
) -> Result<EvaluationWorkItemStatus, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "queued" => Ok(EvaluationWorkItemStatus::Queued),
        "running" => Ok(EvaluationWorkItemStatus::Running),
        "waiting_tool" => Ok(EvaluationWorkItemStatus::WaitingTool),
        "waiting_external" => Ok(EvaluationWorkItemStatus::WaitingExternal),
        "completed" => Ok(EvaluationWorkItemStatus::Completed),
        "cancelled" => Ok(EvaluationWorkItemStatus::Cancelled),
        "failed" => Ok(EvaluationWorkItemStatus::Failed),
        other => Err(format!("未知 Evaluation Work Item 状态：'{other}'").into()),
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

fn parse_objective_status(
    value: &str,
) -> Result<ObjectiveStatus, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "active" => Ok(ObjectiveStatus::Active),
        "paused" => Ok(ObjectiveStatus::Paused),
        "blocked" => Ok(ObjectiveStatus::Blocked),
        "completed" => Ok(ObjectiveStatus::Completed),
        "cancelled" => Ok(ObjectiveStatus::Cancelled),
        "failed" => Ok(ObjectiveStatus::Failed),
        other => Err(format!("未知 Objective 状态：'{other}'").into()),
    }
}

fn sqlite_u64(
    row: &sqlx::sqlite::SqliteRow,
    column: &str,
) -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
    let value = row.get::<i64, _>(column);
    u64::try_from(value).map_err(|_| format!("Objective 字段 '{column}' 不能为负数").into())
}

fn sqlite_optional_u64(
    row: &sqlx::sqlite::SqliteRow,
    column: &str,
) -> Result<Option<u64>, Box<dyn std::error::Error + Send + Sync>> {
    row.get::<Option<i64>, _>(column)
        .map(|value| {
            u64::try_from(value).map_err(|_| format!("Objective 字段 '{column}' 不能为负数"))
        })
        .transpose()
        .map_err(Into::into)
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
        attention_state: parse_session_attention_state(&row.get::<String, _>("attention_state")),
        attention_revision: u64::try_from(row.get::<i64, _>("attention_revision"))
            .expect("Session attention revision 不能为负数"),
        attention_reason: row.get("attention_reason"),
        attention_changed_at: row
            .get::<Option<String>, _>("attention_changed_at")
            .map(|value| parse_time(&value)),
        attention_event_id: row.get("attention_event_id"),
    }
}

fn evaluation_work_item_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<EvaluationWorkItemRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(EvaluationWorkItemRecord {
        id: row.get("id"),
        revision: sqlite_u64(row, "revision")?,
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        session_id: row.get("session_id"),
        trigger_event_id: row.get("trigger_event_id"),
        trigger_sequence: sqlite_u64(row, "trigger_sequence")?,
        trigger_kind: row.get("trigger_kind"),
        parent_work_item_id: row.get("parent_work_item_id"),
        root_turn_id: row.get("root_turn_id"),
        context_snapshot_version: sqlite_optional_u64(row, "context_snapshot_version")?,
        status: parse_evaluation_work_item_status(&row.get::<String, _>("status"))?,
        claimed_by: row.get("claimed_by"),
        lease_expires_at: row
            .get::<Option<String>, _>("lease_expires_at")
            .map(|value| parse_time(&value)),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    })
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

fn objective_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<ObjectiveRecord, Box<dyn std::error::Error + Send + Sync>> {
    let wait_condition = row
        .get::<Option<String>, _>("wait_condition_json")
        .map(|json| serde_json::from_str::<ObjectiveWaitCondition>(&json))
        .transpose()?;
    Ok(ObjectiveRecord {
        id: row.get("id"),
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        coordinator_session_id: row.get("coordinator_session_id"),
        delivery_session_id: row.get("delivery_session_id"),
        parent_objective_id: row.get("parent_objective_id"),
        source_event_id: row.get("source_event_id"),
        stated_objective: row.get("stated_objective"),
        revision: sqlite_u64(row, "revision")?,
        status: parse_objective_status(&row.get::<String, _>("status"))?,
        status_reason: row.get("status_reason"),
        wait_condition,
        active_evaluation_id: row.get("active_evaluation_id"),
        evaluation_lease_expires_at: row
            .get::<Option<String>, _>("evaluation_lease_expires_at")
            .as_deref()
            .map(parse_time),
        continuation_sequence: sqlite_u64(row, "continuation_sequence")?,
        token_budget: sqlite_optional_u64(row, "token_budget")?,
        tokens_used: sqlite_u64(row, "tokens_used")?,
        time_used_seconds: sqlite_u64(row, "time_used_seconds")?,
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    })
}

async fn append_event_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event: &Event,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let payload = serde_json::to_string(&event.payload)?;
    let timestamp = event
        .timestamp
        .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    let session_id = event.payload.get("session_id").and_then(JsonValue::as_str);
    let context_id = event
        .payload
        .get("context_id")
        .and_then(JsonValue::as_str)
        .or(session_id);
    sqlx::query(
        "INSERT INTO events (id, timestamp, actor, type, topic, context_id, session_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&event.id)
    .bind(timestamp)
    .bind(&event.actor)
    .bind(&event.event_type)
    .bind(&event.topic)
    .bind(context_id)
    .bind(session_id)
    .bind(payload)
    .execute(&mut **tx)
    .await?;
    Ok(())
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
            r#"SELECT s.id, s.agent_id, s.context_id, s.parent_session_id, s.title, s.status,
                      s.created_at, s.updated_at, s.last_activity_at,
                      sm.attention_state, sm.attention_revision, sm.attention_reason,
                      sm.attention_changed_at, sm.attention_event_id
               FROM sessions s
               JOIN session_mounts sm ON sm.session_id = s.id AND sm.unmounted_at IS NULL
               WHERE s.id = ?"#,
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
            sqlx::query(r#"SELECT s.id, s.agent_id, s.context_id, s.parent_session_id, s.title, s.status,
                                      s.created_at, s.updated_at, s.last_activity_at,
                                      sm.attention_state, sm.attention_revision, sm.attention_reason,
                                      sm.attention_changed_at, sm.attention_event_id
                               FROM sessions s
                               JOIN session_mounts sm ON sm.session_id = s.id AND sm.unmounted_at IS NULL
                               ORDER BY s.last_activity_at DESC, s.id ASC"#)
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query(r#"SELECT s.id, s.agent_id, s.context_id, s.parent_session_id, s.title, s.status,
                                      s.created_at, s.updated_at, s.last_activity_at,
                                      sm.attention_state, sm.attention_revision, sm.attention_reason,
                                      sm.attention_changed_at, sm.attention_event_id
                               FROM sessions s
                               JOIN session_mounts sm ON sm.session_id = s.id AND sm.unmounted_at IS NULL
                               WHERE s.status = 'active'
                               ORDER BY s.last_activity_at DESC, s.id ASC"#)
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
            sqlx::query(r#"SELECT s.id, s.agent_id, s.context_id, s.parent_session_id, s.title, s.status,
                                      s.created_at, s.updated_at, s.last_activity_at,
                                      sm.attention_state, sm.attention_revision, sm.attention_reason,
                                      sm.attention_changed_at, sm.attention_event_id
                               FROM sessions s
                               JOIN session_mounts sm ON sm.session_id = s.id AND sm.unmounted_at IS NULL
                               WHERE s.context_id = ?
                               ORDER BY s.last_activity_at DESC, s.id ASC"#)
                .bind(context_id)
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query(r#"SELECT s.id, s.agent_id, s.context_id, s.parent_session_id, s.title, s.status,
                                      s.created_at, s.updated_at, s.last_activity_at,
                                      sm.attention_state, sm.attention_revision, sm.attention_reason,
                                      sm.attention_changed_at, sm.attention_event_id
                               FROM sessions s
                               JOIN session_mounts sm ON sm.session_id = s.id AND sm.unmounted_at IS NULL
                               WHERE s.context_id = ? AND s.status = 'active'
                               ORDER BY s.last_activity_at DESC, s.id ASC"#)
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

    async fn update_session_attention(
        &self,
        update: SessionAttentionUpdate,
    ) -> Result<Option<SessionRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let expected_revision = i64::try_from(update.expected_revision)
            .map_err(|_| "Session attention revision 超出 SQLite INTEGER 范围")?;
        let changed_at = update
            .changed_at
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE session_mounts
               SET attention_state = ?, attention_revision = attention_revision + 1,
                   attention_reason = ?, attention_changed_at = ?, attention_event_id = ?
               WHERE session_id = ? AND context_id = ? AND unmounted_at IS NULL
                 AND attention_revision = ?"#,
        )
        .bind(update.state.as_str())
        .bind(update.reason)
        .bind(changed_at)
        .bind(update.event_id)
        .bind(&update.session_id)
        .bind(update.context_id)
        .bind(expected_revision)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Ok(None);
        }
        self.get_session(&update.session_id).await
    }

    async fn commit_context_transaction(
        &self,
        event: &Event,
        attention_updates: &[SessionAttentionUpdate],
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut tx = self.pool.begin().await?;
        for update in attention_updates {
            let expected_revision = i64::try_from(update.expected_revision)
                .map_err(|_| "Session attention revision 超出 SQLite INTEGER 范围")?;
            let changed_at = update
                .changed_at
                .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
            let result = sqlx::query(
                r#"UPDATE session_mounts
                   SET attention_state = ?, attention_revision = attention_revision + 1,
                       attention_reason = ?, attention_changed_at = ?, attention_event_id = ?
                   WHERE session_id = ? AND context_id = ? AND unmounted_at IS NULL
                     AND attention_revision = ?"#,
            )
            .bind(update.state.as_str())
            .bind(&update.reason)
            .bind(changed_at)
            .bind(&update.event_id)
            .bind(&update.session_id)
            .bind(&update.context_id)
            .bind(expected_revision)
            .execute(&mut *tx)
            .await?;
            if result.rows_affected() != 1 {
                return Err(format!(
                    "Session '{}' attention revision 冲突或 Context mount 不存在",
                    update.session_id
                )
                .into());
            }
        }
        append_event_in_transaction(&mut tx, event).await?;
        tx.commit().await?;
        Ok(())
    }

    async fn ensure_evaluation_work_item(
        &self,
        work_item: NewEvaluationWorkItem,
    ) -> Result<EvaluationWorkItemRecord, Box<dyn std::error::Error + Send + Sync>> {
        let trigger_sequence = i64::try_from(work_item.trigger_sequence)
            .map_err(|_| "Work Item trigger sequence 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"INSERT OR IGNORE INTO evaluation_work_items
               (id, revision, agent_id, context_id, session_id, trigger_event_id,
                trigger_sequence, trigger_kind, parent_work_item_id, root_turn_id,
                status, created_at, updated_at)
               VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)"#,
        )
        .bind(&work_item.id)
        .bind(&work_item.agent_id)
        .bind(&work_item.context_id)
        .bind(&work_item.session_id)
        .bind(&work_item.trigger_event_id)
        .bind(trigger_sequence)
        .bind(&work_item.trigger_kind)
        .bind(&work_item.parent_work_item_id)
        .bind(&work_item.root_turn_id)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        let row = sqlx::query("SELECT * FROM evaluation_work_items WHERE trigger_event_id = ?")
            .bind(&work_item.trigger_event_id)
            .fetch_one(&self.pool)
            .await?;
        let existing = evaluation_work_item_from_row(&row)?;
        if existing.context_id != work_item.context_id
            || existing.session_id != work_item.session_id
            || existing.root_turn_id != work_item.root_turn_id
        {
            return Err(format!(
                "Trigger Event '{}' 已被不同 Evaluation Work Item 占用",
                work_item.trigger_event_id
            )
            .into());
        }
        Ok(existing)
    }

    async fn get_evaluation_work_item(
        &self,
        id: &str,
    ) -> Result<Option<EvaluationWorkItemRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query("SELECT * FROM evaluation_work_items WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(evaluation_work_item_from_row).transpose()
    }

    async fn list_context_evaluation_work_items(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<EvaluationWorkItemRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = if include_terminal {
            sqlx::query(
                "SELECT * FROM evaluation_work_items WHERE context_id = ? ORDER BY created_at, id",
            )
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT * FROM evaluation_work_items WHERE context_id = ? AND status NOT IN ('completed', 'cancelled', 'failed') ORDER BY created_at, id",
            )
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?
        };
        rows.iter().map(evaluation_work_item_from_row).collect()
    }

    async fn update_evaluation_work_item(
        &self,
        id: &str,
        expected_revision: u64,
        status: EvaluationWorkItemStatus,
        claimed_by: Option<&str>,
        lease_expires_at: Option<DateTime<Utc>>,
        context_snapshot_version: Option<u64>,
    ) -> Result<EvaluationWorkItemMutation, Box<dyn std::error::Error + Send + Sync>> {
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Work Item revision 超出 SQLite INTEGER 范围")?;
        let context_snapshot_version = context_snapshot_version
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "Context snapshot version 超出 SQLite INTEGER 范围")?;
        let lease_expires_at =
            lease_expires_at.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE evaluation_work_items
               SET revision = revision + 1, status = ?, claimed_by = ?,
                   lease_expires_at = ?,
                   context_snapshot_version = COALESCE(?, context_snapshot_version),
                   updated_at = ?
               WHERE id = ? AND revision = ?"#,
        )
        .bind(status.as_str())
        .bind(claimed_by)
        .bind(lease_expires_at)
        .bind(context_snapshot_version)
        .bind(now)
        .bind(id)
        .bind(expected_revision)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(EvaluationWorkItemMutation::Updated(
                self.get_evaluation_work_item(id)
                    .await?
                    .ok_or("Work Item 更新后无法读取")?,
            ));
        }
        Ok(match self.get_evaluation_work_item(id).await? {
            Some(current) => EvaluationWorkItemMutation::Conflict { current },
            None => EvaluationWorkItemMutation::NotFound,
        })
    }

    async fn commit_evaluation_reply(
        &self,
        root_turn_id: &str,
        event: &Event,
    ) -> Result<ReplyCommit, Box<dyn std::error::Error + Send + Sync>> {
        let session_id = event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("Reply Event 缺少 session_id")?;
        let disposition = event
            .payload
            .get("disposition")
            .and_then(JsonValue::as_str)
            .unwrap_or("deliver");
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            "INSERT OR IGNORE INTO evaluation_replies (session_id, root_turn_id, disposition, event_id, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(session_id)
        .bind(root_turn_id)
        .bind(disposition)
        .bind(&event.id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 0 {
            let existing = sqlx::query(
                "SELECT event_id FROM evaluation_replies WHERE session_id = ? AND root_turn_id = ?",
            )
            .bind(session_id)
            .bind(root_turn_id)
            .fetch_one(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(ReplyCommit::Existing {
                event_id: existing.get("event_id"),
            });
        }
        append_event_in_transaction(&mut tx, event).await?;
        let activity_at = event
            .timestamp
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query("UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ?")
            .bind(&activity_at)
            .bind(&activity_at)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(ReplyCommit::Committed)
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
                .bind(&timestamp)
                .bind(&event.actor)
                .bind(&event.event_type)
                .bind(&event.topic)
                .bind(event_context_id)
                .bind(session_id)
                .bind(payload)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ?")
                .bind(&timestamp)
                .bind(&timestamp)
                .bind(session_id)
                .execute(&mut *tx)
                .await?;
            let mount = sqlx::query(
                "SELECT attention_state, attention_revision FROM session_mounts WHERE session_id = ? AND context_id = ? AND unmounted_at IS NULL",
            )
            .bind(session_id)
            .bind(event_context_id)
            .fetch_one(&mut *tx)
            .await?;
            if mount.get::<String, _>("attention_state") == "retired" {
                let restore_event_id = format!("runtime_session_restored_{}", event.id);
                sqlx::query(
                    r#"UPDATE session_mounts
                       SET attention_state = 'active', attention_revision = attention_revision + 1,
                           attention_reason = 'new directed user message',
                           attention_changed_at = ?, attention_event_id = ?
                       WHERE session_id = ? AND context_id = ? AND unmounted_at IS NULL
                         AND attention_state = 'retired'"#,
                )
                .bind(&timestamp)
                .bind(&restore_event_id)
                .bind(session_id)
                .bind(event_context_id)
                .execute(&mut *tx)
                .await?;
                let restore = Event {
                    id: restore_event_id,
                    sequence: None,
                    timestamp: event.timestamp,
                    actor: "Runtime-SessionAttention".to_string(),
                    event_type: "runtime_control".to_string(),
                    topic: "runtime/session_restored".to_string(),
                    payload: [
                        (
                            "context_id".to_string(),
                            serde_json::json!(event_context_id),
                        ),
                        ("session_id".to_string(), serde_json::json!(session_id)),
                        ("trigger_event_id".to_string(), serde_json::json!(event.id)),
                        (
                            "trigger_kind".to_string(),
                            serde_json::json!("user_message"),
                        ),
                        (
                            "attention_revision".to_string(),
                            serde_json::json!(mount.get::<i64, _>("attention_revision") + 1),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                };
                append_event_in_transaction(&mut tx, &restore).await?;
            }
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

const OBJECTIVE_SELECT: &str = r#"SELECT id, agent_id, context_id,
    coordinator_session_id, delivery_session_id, parent_objective_id, source_event_id,
    stated_objective, revision, status, status_reason, wait_condition_json, active_evaluation_id,
    evaluation_lease_expires_at, continuation_sequence, token_budget, tokens_used,
    time_used_seconds, created_at, updated_at
    FROM objectives"#;

fn validate_stated_objective(
    stated_objective: &str,
) -> Result<&str, Box<dyn std::error::Error + Send + Sync>> {
    let stated_objective = stated_objective.trim();
    if stated_objective.is_empty() {
        return Err("Objective 目标不能为空".into());
    }
    if stated_objective.chars().count() > 1_000_000 {
        return Err("Objective 目标超过 1,000,000 字符上限".into());
    }
    Ok(stated_objective)
}

#[async_trait::async_trait]
impl ObjectiveStore for SqliteStore {
    async fn create_objective(
        &self,
        objective: NewObjective,
    ) -> Result<ObjectiveRecord, Box<dyn std::error::Error + Send + Sync>> {
        let stated_objective = validate_stated_objective(&objective.stated_objective)?;
        let context = self
            .get_context(&objective.context_id)
            .await?
            .ok_or_else(|| format!("Objective Context '{}' 不存在", objective.context_id))?;
        let coordinator = self
            .get_session(&objective.coordinator_session_id)
            .await?
            .ok_or_else(|| {
                format!(
                    "Objective 协调 Session '{}' 不存在",
                    objective.coordinator_session_id
                )
            })?;
        let delivery = self
            .get_session(&objective.delivery_session_id)
            .await?
            .ok_or_else(|| {
                format!(
                    "Objective 交付 Session '{}' 不存在",
                    objective.delivery_session_id
                )
            })?;
        if context.agent_id != objective.agent_id
            || coordinator.agent_id != objective.agent_id
            || delivery.agent_id != objective.agent_id
            || coordinator.context_id != objective.context_id
            || delivery.context_id != objective.context_id
        {
            return Err("Objective 的 Agent/Context/Session 路由不一致".into());
        }
        if let Some(parent_id) = objective.parent_objective_id.as_deref() {
            let parent = self
                .get_objective(parent_id)
                .await?
                .ok_or_else(|| format!("父 Objective '{parent_id}' 不存在"))?;
            if parent.agent_id != objective.agent_id {
                return Err(format!(
                    "父 Objective '{parent_id}' 属于 Agent '{}'，不能挂到 Agent '{}'",
                    parent.agent_id, objective.agent_id
                )
                .into());
            }
        }
        let token_budget = objective
            .token_budget
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "Objective token budget 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"INSERT INTO objectives
               (id, agent_id, context_id, coordinator_session_id, delivery_session_id,
                parent_objective_id, source_event_id, stated_objective, revision, status,
                wait_condition_json, active_evaluation_id, evaluation_lease_expires_at,
                continuation_sequence, token_budget, tokens_used, time_used_seconds,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', NULL, NULL, NULL, 0, ?, 0, 0, ?, ?)"#,
        )
        .bind(&objective.id)
        .bind(&objective.agent_id)
        .bind(&objective.context_id)
        .bind(&objective.coordinator_session_id)
        .bind(&objective.delivery_session_id)
        .bind(&objective.parent_objective_id)
        .bind(&objective.source_event_id)
        .bind(stated_objective)
        .bind(token_budget)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.get_objective(&objective.id)
            .await?
            .ok_or_else(|| "Objective 创建后无法读取".into())
    }

    async fn get_objective(
        &self,
        id: &str,
    ) -> Result<Option<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query(&format!("{OBJECTIVE_SELECT} WHERE id = ?"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(objective_from_row).transpose()
    }

    async fn list_context_objectives(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let sql = if include_terminal {
            format!("{OBJECTIVE_SELECT} WHERE context_id = ? ORDER BY updated_at DESC")
        } else {
            format!(
                "{OBJECTIVE_SELECT} WHERE context_id = ? AND status NOT IN ('completed', 'cancelled', 'failed') ORDER BY updated_at DESC"
            )
        };
        let rows = sqlx::query(&sql)
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(objective_from_row).collect()
    }

    async fn list_recoverable_objectives(
        &self,
    ) -> Result<Vec<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = sqlx::query(&format!(
            "{OBJECTIVE_SELECT} WHERE status IN ('active', 'paused', 'blocked') OR active_evaluation_id IS NOT NULL ORDER BY updated_at"
        ))
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(objective_from_row).collect()
    }

    async fn edit_objective(
        &self,
        id: &str,
        expected_revision: u64,
        stated_objective: &str,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>> {
        let stated_objective = validate_stated_objective(stated_objective)?;
        let Some(current) = self.get_objective(id).await? else {
            return Ok(ObjectiveMutation::NotFound);
        };
        if current.revision != expected_revision {
            return Ok(ObjectiveMutation::Conflict { current });
        }
        if current.status.is_terminal() {
            return Err(format!("终态 Objective '{id}' 不能再修改目标").into());
        }
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Objective revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            "UPDATE objectives SET stated_objective = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
        )
        .bind(stated_objective)
        .bind(now)
        .bind(id)
        .bind(expected_revision)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ObjectiveMutation::Updated(
                self.get_objective(id)
                    .await?
                    .ok_or("Objective 更新后无法读取")?,
            ));
        }
        Ok(match self.get_objective(id).await? {
            Some(current) => ObjectiveMutation::Conflict { current },
            None => ObjectiveMutation::NotFound,
        })
    }

    async fn update_objective_state(
        &self,
        id: &str,
        expected_revision: u64,
        status: ObjectiveStatus,
        wait_condition: Option<ObjectiveWaitCondition>,
        reason: Option<&str>,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>> {
        let Some(current) = self.get_objective(id).await? else {
            return Ok(ObjectiveMutation::NotFound);
        };
        if current.revision != expected_revision {
            return Ok(ObjectiveMutation::Conflict { current });
        }
        if !current.status.can_transition_to(status) {
            return Err(format!(
                "Objective '{id}' 不允许从 '{}' 迁移到 '{}'",
                current.status.as_str(),
                status.as_str()
            )
            .into());
        }
        if status != ObjectiveStatus::Active && wait_condition.is_some() {
            return Err("只有 active Objective 可以携带等待条件".into());
        }
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Objective revision 超出 SQLite INTEGER 范围")?;
        let wait_condition_json = wait_condition
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE objectives
               SET status = ?, status_reason = ?, wait_condition_json = ?,
                   revision = revision + 1, updated_at = ?
               WHERE id = ? AND revision = ?"#,
        )
        .bind(status.as_str())
        .bind(reason)
        .bind(wait_condition_json)
        .bind(now)
        .bind(id)
        .bind(expected_revision)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ObjectiveMutation::Updated(
                self.get_objective(id)
                    .await?
                    .ok_or("Objective 状态更新后无法读取")?,
            ));
        }
        Ok(match self.get_objective(id).await? {
            Some(current) => ObjectiveMutation::Conflict { current },
            None => ObjectiveMutation::NotFound,
        })
    }

    async fn claim_objective_evaluation(
        &self,
        id: &str,
        expected_revision: u64,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>> {
        if evaluation_id.trim().is_empty() {
            return Err("Objective Evaluation ID 不能为空".into());
        }
        let Some(current) = self.get_objective(id).await? else {
            return Ok(ObjectiveMutation::NotFound);
        };
        if current.revision != expected_revision
            || current.status != ObjectiveStatus::Active
            || current.wait_condition.is_some()
            || current
                .evaluation_lease_expires_at
                .is_some_and(|expires_at| expires_at > Utc::now())
        {
            return Ok(ObjectiveMutation::Conflict { current });
        }
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Objective revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let lease_expires_at = lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE objectives
               SET active_evaluation_id = ?, evaluation_lease_expires_at = ?,
                   continuation_sequence = continuation_sequence + 1,
                   revision = revision + 1, updated_at = ?
               WHERE id = ? AND revision = ? AND status = 'active'
                 AND wait_condition_json IS NULL
                 AND (active_evaluation_id IS NULL OR evaluation_lease_expires_at <= ?)"#,
        )
        .bind(evaluation_id)
        .bind(lease_expires_at)
        .bind(&now)
        .bind(id)
        .bind(expected_revision)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ObjectiveMutation::Updated(
                self.get_objective(id)
                    .await?
                    .ok_or("Objective Evaluation 租约提交后无法读取")?,
            ));
        }
        Ok(match self.get_objective(id).await? {
            Some(current) => ObjectiveMutation::Conflict { current },
            None => ObjectiveMutation::NotFound,
        })
    }

    async fn finish_objective_evaluation(
        &self,
        id: &str,
        evaluation_id: &str,
        tokens_used: u64,
        time_used_seconds: u64,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>> {
        let Some(current) = self.get_objective(id).await? else {
            return Ok(ObjectiveMutation::NotFound);
        };
        if current.active_evaluation_id.as_deref() != Some(evaluation_id) {
            return Ok(ObjectiveMutation::Conflict { current });
        }
        let revision = i64::try_from(current.revision)
            .map_err(|_| "Objective revision 超出 SQLite INTEGER 范围")?;
        let tokens_used = i64::try_from(tokens_used)
            .map_err(|_| "Objective token 增量超出 SQLite INTEGER 范围")?;
        let time_used_seconds = i64::try_from(time_used_seconds)
            .map_err(|_| "Objective time 增量超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE objectives
               SET active_evaluation_id = NULL, evaluation_lease_expires_at = NULL,
                   tokens_used = tokens_used + ?, time_used_seconds = time_used_seconds + ?,
                   revision = revision + 1, updated_at = ?
               WHERE id = ? AND revision = ? AND active_evaluation_id = ?"#,
        )
        .bind(tokens_used)
        .bind(time_used_seconds)
        .bind(now)
        .bind(id)
        .bind(revision)
        .bind(evaluation_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ObjectiveMutation::Updated(
                self.get_objective(id)
                    .await?
                    .ok_or("Objective Evaluation 结束后无法读取")?,
            ));
        }
        Ok(match self.get_objective(id).await? {
            Some(current) => ObjectiveMutation::Conflict { current },
            None => ObjectiveMutation::NotFound,
        })
    }

    async fn record_objective_evaluation_usage(
        &self,
        id: &str,
        evaluation_id: &str,
        prompt_tokens_used: u64,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>> {
        let prompt_tokens_used = i64::try_from(prompt_tokens_used)
            .map_err(|_| "Objective token 增量超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE objectives
               SET tokens_used = tokens_used + ?, updated_at = ?
               WHERE id = ? AND status = 'active' AND active_evaluation_id = ?"#,
        )
        .bind(prompt_tokens_used)
        .bind(now)
        .bind(id)
        .bind(evaluation_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ObjectiveMutation::Updated(
                self.get_objective(id)
                    .await?
                    .ok_or("Objective Evaluation 记账后无法读取")?,
            ));
        }
        Ok(match self.get_objective(id).await? {
            Some(current) => ObjectiveMutation::Conflict { current },
            None => ObjectiveMutation::NotFound,
        })
    }
}

fn parse_time(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .expect("Morphz 数据库时间戳必须是 RFC3339")
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::QueryFilter;
    use std::collections::HashMap;
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
    async fn incomplete_event_schema_is_rejected() {
        let tmp_file = NamedTempFile::new().unwrap();
        let url = format!("sqlite://{}", tmp_file.path().display());
        let incomplete_pool = SqlitePool::connect(&url).await.unwrap();
        sqlx::query(
            "CREATE TABLE events (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, topic TEXT NOT NULL, payload TEXT NOT NULL)",
        )
        .execute(&incomplete_pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO events (id, timestamp, actor, type, topic, payload) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("incomplete-event")
        .bind(Utc::now().to_rfc3339())
        .bind("fixture")
        .bind("user_message")
        .bind("chat/user_message")
        .bind(r#"{"session_id":"incomplete-session","text":"hello"}"#)
        .execute(&incomplete_pool)
        .await
        .unwrap();
        incomplete_pool.close().await;

        let result = SqliteStore::new(tmp_file.path().to_str().unwrap()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn events_do_not_implicitly_create_session_registry_entries() {
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
        let session = reopened.get_session("mounted-session").await.unwrap();
        assert!(session.is_none());
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
    async fn objectives_persist_wait_state_and_enforce_revisioned_lifecycle() {
        let tmp_file = NamedTempFile::new().unwrap();
        let db_path = tmp_file.path().to_path_buf();
        let store = SqliteStore::new(db_path.to_str().unwrap()).await.unwrap();
        store
            .create_agent_bundle(
                NewAgent {
                    id: "agent-objective".to_string(),
                    title: "Objective Agent".to_string(),
                    root_context_id: "context-objective".to_string(),
                },
                NewCognitiveContext {
                    id: "context-objective".to_string(),
                    agent_id: "agent-objective".to_string(),
                    title: "Objective Context".to_string(),
                },
                NewSession {
                    id: "session-objective".to_string(),
                    agent_id: "agent-objective".to_string(),
                    context_id: "context-objective".to_string(),
                    parent_session_id: None,
                    title: "Objective Session".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();

        let created = store
            .create_objective(NewObjective {
                id: "objective-1".to_string(),
                agent_id: "agent-objective".to_string(),
                context_id: "context-objective".to_string(),
                coordinator_session_id: "session-objective".to_string(),
                delivery_session_id: "session-objective".to_string(),
                parent_objective_id: None,
                source_event_id: "user-event-1".to_string(),
                stated_objective: "完成一项可恢复的长程工作".to_string(),
                token_budget: Some(256_000),
            })
            .await
            .unwrap();
        assert_eq!(created.status, ObjectiveStatus::Active);
        assert_eq!(created.revision, 1);

        let waiting = store
            .update_objective_state(
                "objective-1",
                1,
                ObjectiveStatus::Active,
                Some(ObjectiveWaitCondition::ToolTask {
                    task_id: "task-1".to_string(),
                }),
                Some("等待后台任务完成"),
            )
            .await
            .unwrap();
        let ObjectiveMutation::Updated(waiting) = waiting else {
            panic!("expected an updated Objective");
        };
        assert_eq!(waiting.revision, 2);
        assert_eq!(waiting.status_reason.as_deref(), Some("等待后台任务完成"));
        assert_eq!(
            waiting.wait_condition,
            Some(ObjectiveWaitCondition::ToolTask {
                task_id: "task-1".to_string()
            })
        );

        let stale = store
            .edit_objective("objective-1", 1, "这个写入必须因修订号过期而失败")
            .await
            .unwrap();
        assert!(matches!(
            stale,
            ObjectiveMutation::Conflict {
                current: ObjectiveRecord { revision: 2, .. }
            }
        ));

        let paused = store
            .update_objective_state(
                "objective-1",
                2,
                ObjectiveStatus::Paused,
                None,
                Some("等待使用者决定"),
            )
            .await
            .unwrap();
        let ObjectiveMutation::Updated(paused) = paused else {
            panic!("expected a paused Objective");
        };
        assert_eq!(paused.status, ObjectiveStatus::Paused);
        assert_eq!(paused.status_reason.as_deref(), Some("等待使用者决定"));
        assert!(paused.wait_condition.is_none());
        assert!(store
            .update_objective_state(
                "objective-1",
                3,
                ObjectiveStatus::Completed,
                None,
                Some("不允许从暂停直接完成"),
            )
            .await
            .is_err());

        let resumed = store
            .update_objective_state(
                "objective-1",
                3,
                ObjectiveStatus::Active,
                None,
                Some("使用者要求继续"),
            )
            .await
            .unwrap();
        let ObjectiveMutation::Updated(resumed) = resumed else {
            panic!("expected a resumed Objective");
        };
        assert_eq!(resumed.revision, 4);
        let completed = store
            .update_objective_state(
                "objective-1",
                4,
                ObjectiveStatus::Completed,
                None,
                Some("验收完成"),
            )
            .await
            .unwrap();
        assert!(matches!(
            completed,
            ObjectiveMutation::Updated(ObjectiveRecord {
                status: ObjectiveStatus::Completed,
                revision: 5,
                ..
            })
        ));
        assert!(store
            .update_objective_state(
                "objective-1",
                5,
                ObjectiveStatus::Active,
                None,
                Some("终态不可恢复"),
            )
            .await
            .is_err());
        assert!(store
            .list_context_objectives("context-objective", false)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .list_context_objectives("context-objective", true)
                .await
                .unwrap()
                .len(),
            1
        );

        store
            .create_objective(NewObjective {
                id: "objective-usage".to_string(),
                agent_id: "agent-objective".to_string(),
                context_id: "context-objective".to_string(),
                coordinator_session_id: "session-objective".to_string(),
                delivery_session_id: "session-objective".to_string(),
                parent_objective_id: None,
                source_event_id: "user-event-usage".to_string(),
                stated_objective: "验证 Evaluation 成本按租约隔离记账".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let claimed = store
            .claim_objective_evaluation(
                "objective-usage",
                1,
                "evaluation-usage",
                Utc::now() + chrono::Duration::minutes(1),
            )
            .await
            .unwrap();
        assert!(matches!(claimed, ObjectiveMutation::Updated(_)));
        let accounted = store
            .record_objective_evaluation_usage("objective-usage", "evaluation-usage", 123)
            .await
            .unwrap();
        assert!(matches!(
            accounted,
            ObjectiveMutation::Updated(ObjectiveRecord {
                revision: 2,
                tokens_used: 123,
                ..
            })
        ));
        assert!(matches!(
            store
                .record_objective_evaluation_usage("objective-usage", "another-evaluation", 999)
                .await
                .unwrap(),
            ObjectiveMutation::Conflict { .. }
        ));
        let completed_with_lease = store
            .update_objective_state(
                "objective-usage",
                2,
                ObjectiveStatus::Completed,
                None,
                Some("usage 验收完成"),
            )
            .await
            .unwrap();
        assert!(matches!(
            completed_with_lease,
            ObjectiveMutation::Updated(ObjectiveRecord {
                revision: 3,
                tokens_used: 123,
                status: ObjectiveStatus::Completed,
                active_evaluation_id: Some(_),
                ..
            })
        ));
        let finished = store
            .finish_objective_evaluation("objective-usage", "evaluation-usage", 0, 3)
            .await
            .unwrap();
        assert!(matches!(
            finished,
            ObjectiveMutation::Updated(ObjectiveRecord {
                revision: 4,
                tokens_used: 123,
                time_used_seconds: 3,
                status: ObjectiveStatus::Completed,
                active_evaluation_id: None,
                ..
            })
        ));

        store.pool.close().await;
        drop(store);
        let restarted = SqliteStore::new(db_path.to_str().unwrap()).await.unwrap();
        let recovered = restarted
            .get_objective("objective-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.status, ObjectiveStatus::Completed);
        assert_eq!(recovered.status_reason.as_deref(), Some("验收完成"));
        assert_eq!(recovered.token_budget, Some(256_000));
        assert!(restarted
            .list_recoverable_objectives()
            .await
            .unwrap()
            .is_empty());
    }
}
