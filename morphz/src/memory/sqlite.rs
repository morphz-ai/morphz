use crate::config::MemoryConfig;
use crate::event::Event;
use crate::memory::{
    ActivationOutcomeCommit, AgentBootstrapRecord, AgentRecord, CognitiveContextRecord,
    DelegationRecord, DelegationStatus, DeliveryStatus, EventStore, MessageClaim, NewAgent,
    NewCognitiveContext, NewDelegation, NewObjective, NewScheduledIntent, NewSession,
    NewThreadActivation, NewThreadSignal, NewWorkThread, ObjectiveMutation, ObjectiveRecord,
    ObjectiveStatus, ObjectiveStore, ObjectiveWaitCondition, QueryFilter, ScheduledIntentRecord,
    ScheduledIntentStatus, SessionAttentionState, SessionAttentionUpdate, SessionMountKind,
    SessionRecord, SessionStatus, SessionStore, SessionUpdate, SignalOutboxRecord,
    SignalOutboxStatus, ThreadActivationMutation, ThreadActivationRecord, ThreadActivationStatus,
    ThreadLifecycle, ThreadSignalRecord, ThreadSignalStatus, WorkThreadKind, WorkThreadMutation,
    WorkThreadRecord,
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

        // Morphz is not yet released, so the Scheduler Kernel adopts its
        // canonical domain name directly. SQLite rewrites existing foreign
        // key targets during ALTER TABLE, preserving local development data.
        let has_legacy_activations = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'evaluation_work_items'",
        )
        .fetch_one(&pool)
        .await?
            > 0;
        let has_thread_activations = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'thread_activations'",
        )
        .fetch_one(&pool)
        .await?
            > 0;
        if has_legacy_activations && has_thread_activations {
            return Err(
                "SQLite 同时存在 evaluation_work_items 与 thread_activations，拒绝猜测迁移来源"
                    .into(),
            );
        }
        if has_legacy_activations {
            sqlx::query("ALTER TABLE evaluation_work_items RENAME TO thread_activations")
                .execute(&pool)
                .await?;
        }
        if has_legacy_activations || has_thread_activations {
            let activation_columns = sqlx::query("PRAGMA table_info(thread_activations)")
                .fetch_all(&pool)
                .await?
                .into_iter()
                .map(|row| row.get::<String, _>("name"))
                .collect::<std::collections::HashSet<_>>();
            if activation_columns.contains("parent_work_item_id")
                && !activation_columns.contains("parent_activation_id")
            {
                sqlx::query(
                    "ALTER TABLE thread_activations RENAME COLUMN parent_work_item_id TO parent_activation_id",
                )
                .execute(&pool)
                .await?;
            }
        }

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

        CREATE TABLE IF NOT EXISTS signal_outbox (
            event_id TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK(status IN ('pending', 'materialized', 'discarded')),
            signal_id TEXT,
            created_at TEXT NOT NULL,
            resolved_at TEXT,
            FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
            FOREIGN KEY(signal_id) REFERENCES thread_signals(id)
        );
        CREATE INDEX IF NOT EXISTS idx_signal_outbox_status_created
            ON signal_outbox(status, created_at, event_id);

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

        CREATE TABLE IF NOT EXISTS thread_activations (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            agent_id TEXT NOT NULL,
            context_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            trigger_event_id TEXT NOT NULL UNIQUE,
            trigger_sequence INTEGER NOT NULL CHECK(trigger_sequence >= 0),
            trigger_kind TEXT NOT NULL,
            parent_activation_id TEXT,
            root_turn_id TEXT NOT NULL,
            context_snapshot_version INTEGER,
            status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
            claimed_by TEXT,
            lease_expires_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(parent_activation_id) REFERENCES thread_activations(id)
        );
        CREATE INDEX IF NOT EXISTS idx_thread_activations_session_status
            ON thread_activations(session_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_thread_activations_context_status
            ON thread_activations(context_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_thread_activations_lease
            ON thread_activations(status, lease_expires_at);
        CREATE INDEX IF NOT EXISTS idx_thread_activations_root_turn
            ON thread_activations(root_turn_id, updated_at);

        CREATE TABLE IF NOT EXISTS evaluation_outcomes (
            work_item_id TEXT NOT NULL PRIMARY KEY,
            session_id TEXT NOT NULL,
            disposition TEXT NOT NULL,
            event_id TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            FOREIGN KEY(work_item_id) REFERENCES thread_activations(id) ON DELETE CASCADE,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS work_threads (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            agent_id TEXT NOT NULL,
            context_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            root_turn_id TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL CHECK(kind IN ('dialogue', 'work', 'objective', 'delegation', 'delivery')),
            status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'failed', 'cancelled')),
            executor_kind TEXT NOT NULL,
            executor_id TEXT,
            result_text TEXT,
            result_event_id TEXT,
            delivery_status TEXT NOT NULL DEFAULT 'none' CHECK(delivery_status IN ('none', 'pending', 'deferred', 'delivered')),
            delivery_event_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_work_threads_context_status
            ON work_threads(context_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_work_threads_session_delivery
            ON work_threads(session_id, delivery_status, updated_at);

        CREATE TABLE IF NOT EXISTS thread_signals (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            event_id TEXT NOT NULL UNIQUE,
            sequence INTEGER NOT NULL CHECK(sequence >= 0),
            kind TEXT NOT NULL,
            parent_activation_id TEXT,
            status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'acknowledged')),
            created_at TEXT NOT NULL,
            claimed_at TEXT,
            acknowledged_at TEXT,
            FOREIGN KEY(thread_id) REFERENCES work_threads(id) ON DELETE CASCADE,
            FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
            FOREIGN KEY(parent_activation_id) REFERENCES thread_activations(id)
        );
        CREATE INDEX IF NOT EXISTS idx_thread_signals_thread_status_sequence
            ON thread_signals(thread_id, status, sequence, id);

        CREATE TABLE IF NOT EXISTS activation_signals (
            activation_id TEXT NOT NULL,
            signal_id TEXT NOT NULL UNIQUE,
            ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
            PRIMARY KEY(activation_id, ordinal),
            FOREIGN KEY(activation_id) REFERENCES thread_activations(id) ON DELETE CASCADE,
            FOREIGN KEY(signal_id) REFERENCES thread_signals(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_activation_signals_signal
            ON activation_signals(signal_id);

        CREATE TABLE IF NOT EXISTS scheduled_intents (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            thread_id TEXT NOT NULL,
            source_turn_id TEXT NOT NULL,
            intent TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued', 'dispatched', 'completed', 'cancelled')),
            not_before TEXT,
            interval_seconds INTEGER CHECK(interval_seconds IS NULL OR interval_seconds > 0),
            dependency_thread_ids_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(thread_id) REFERENCES work_threads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_scheduled_intents_due
            ON scheduled_intents(status, not_before, created_at);

        CREATE TABLE IF NOT EXISTS work_thread_outcomes (
            thread_id TEXT PRIMARY KEY,
            root_turn_id TEXT NOT NULL UNIQUE,
            work_item_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            disposition TEXT NOT NULL,
            event_id TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            FOREIGN KEY(thread_id) REFERENCES work_threads(id) ON DELETE CASCADE,
            FOREIGN KEY(work_item_id) REFERENCES thread_activations(id) ON DELETE CASCADE,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        "#;

        sqlx::query(ddl).execute(&pool).await?;
        // v1 Scheduler Kernel no longer persists `waiting` as Thread state.
        // Existing rows are a one-way data migration to lifecycle=open; phase
        // is derived from Signal, Activation, Schedule and Job facts.
        sqlx::query("UPDATE work_threads SET status = 'active' WHERE status = 'waiting'")
            .execute(&pool)
            .await?;
        sqlx::query(
            "UPDATE thread_activations SET status = 'completed' WHERE status IN ('waiting_tool', 'waiting_external')",
        )
        .execute(&pool)
        .await?;
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

fn parse_thread_activation_status(
    value: &str,
) -> Result<ThreadActivationStatus, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "queued" => Ok(ThreadActivationStatus::Queued),
        "running" => Ok(ThreadActivationStatus::Running),
        "waiting_tool" | "waiting_external" | "completed" | "succeeded" => {
            Ok(ThreadActivationStatus::Succeeded)
        }
        "cancelled" => Ok(ThreadActivationStatus::Cancelled),
        "failed" => Ok(ThreadActivationStatus::Failed),
        other => Err(format!("未知 Thread Activation 状态：'{other}'").into()),
    }
}

fn thread_activation_status_storage(status: ThreadActivationStatus) -> &'static str {
    match status {
        ThreadActivationStatus::Queued => "queued",
        ThreadActivationStatus::Running => "running",
        ThreadActivationStatus::Succeeded => "completed",
        ThreadActivationStatus::Cancelled => "cancelled",
        ThreadActivationStatus::Failed => "failed",
    }
}

fn parse_thread_signal_status(
    value: &str,
) -> Result<ThreadSignalStatus, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "pending" => Ok(ThreadSignalStatus::Pending),
        "claimed" => Ok(ThreadSignalStatus::Claimed),
        "acknowledged" => Ok(ThreadSignalStatus::Acknowledged),
        other => Err(format!("未知 Thread Signal 状态：'{other}'").into()),
    }
}

fn parse_work_thread_kind(
    value: &str,
) -> Result<WorkThreadKind, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "dialogue" => Ok(WorkThreadKind::Dialogue),
        "work" => Ok(WorkThreadKind::Work),
        "objective" => Ok(WorkThreadKind::Objective),
        "delegation" => Ok(WorkThreadKind::Delegation),
        "delivery" => Ok(WorkThreadKind::Delivery),
        other => Err(format!("未知 Work Thread kind：'{other}'").into()),
    }
}

fn parse_thread_lifecycle(
    value: &str,
) -> Result<ThreadLifecycle, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        // Old rows used active/waiting to mix lifecycle and scheduler phase.
        // Both represent the same non-terminal lifecycle fact.
        "active" | "waiting" | "open" => Ok(ThreadLifecycle::Open),
        "completed" => Ok(ThreadLifecycle::Completed),
        "failed" => Ok(ThreadLifecycle::Failed),
        "cancelled" => Ok(ThreadLifecycle::Cancelled),
        other => Err(format!("未知 Thread lifecycle：'{other}'").into()),
    }
}

fn parse_delivery_status(
    value: &str,
) -> Result<DeliveryStatus, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "none" => Ok(DeliveryStatus::None),
        "pending" => Ok(DeliveryStatus::Pending),
        "deferred" => Ok(DeliveryStatus::Deferred),
        "delivered" => Ok(DeliveryStatus::Delivered),
        other => Err(format!("未知 Work Thread delivery status：'{other}'").into()),
    }
}

fn parse_scheduled_intent_status(
    value: &str,
) -> Result<ScheduledIntentStatus, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "queued" => Ok(ScheduledIntentStatus::Queued),
        "dispatched" => Ok(ScheduledIntentStatus::Dispatched),
        "completed" => Ok(ScheduledIntentStatus::Completed),
        "cancelled" => Ok(ScheduledIntentStatus::Cancelled),
        other => Err(format!("未知 Scheduled Intent status：'{other}'").into()),
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

fn thread_activation_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<ThreadActivationRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(ThreadActivationRecord {
        id: row.get("id"),
        revision: sqlite_u64(row, "revision")?,
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        session_id: row.get("session_id"),
        trigger_event_id: row.get("trigger_event_id"),
        trigger_sequence: sqlite_u64(row, "trigger_sequence")?,
        trigger_kind: row.get("trigger_kind"),
        parent_activation_id: row.get("parent_activation_id"),
        root_turn_id: row.get("root_turn_id"),
        context_snapshot_version: sqlite_optional_u64(row, "context_snapshot_version")?,
        status: parse_thread_activation_status(&row.get::<String, _>("status"))?,
        claimed_by: row.get("claimed_by"),
        lease_expires_at: row
            .get::<Option<String>, _>("lease_expires_at")
            .map(|value| parse_time(&value)),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    })
}

fn thread_signal_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<ThreadSignalRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(ThreadSignalRecord {
        id: row.get("id"),
        thread_id: row.get("thread_id"),
        event_id: row.get("event_id"),
        sequence: sqlite_u64(row, "sequence")?,
        kind: row.get("kind"),
        parent_activation_id: row.get("parent_activation_id"),
        status: parse_thread_signal_status(&row.get::<String, _>("status"))?,
        created_at: parse_time(&row.get::<String, _>("created_at")),
        claimed_at: row
            .get::<Option<String>, _>("claimed_at")
            .map(|value| parse_time(&value)),
        acknowledged_at: row
            .get::<Option<String>, _>("acknowledged_at")
            .map(|value| parse_time(&value)),
    })
}

fn work_thread_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<WorkThreadRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(WorkThreadRecord {
        id: row.get("id"),
        revision: sqlite_u64(row, "revision")?,
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        session_id: row.get("session_id"),
        root_turn_id: row.get("root_turn_id"),
        kind: parse_work_thread_kind(&row.get::<String, _>("kind"))?,
        lifecycle: parse_thread_lifecycle(&row.get::<String, _>("status"))?,
        executor_kind: row.get("executor_kind"),
        executor_id: row.get("executor_id"),
        result_text: row.get("result_text"),
        result_event_id: row.get("result_event_id"),
        delivery_status: parse_delivery_status(&row.get::<String, _>("delivery_status"))?,
        delivery_event_id: row.get("delivery_event_id"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    })
}

fn scheduled_intent_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<ScheduledIntentRecord, Box<dyn std::error::Error + Send + Sync>> {
    let dependency_thread_ids =
        serde_json::from_str::<Vec<String>>(&row.get::<String, _>("dependency_thread_ids_json"))?;
    Ok(ScheduledIntentRecord {
        id: row.get("id"),
        revision: sqlite_u64(row, "revision")?,
        thread_id: row.get("thread_id"),
        source_turn_id: row.get("source_turn_id"),
        intent: row.get("intent"),
        status: parse_scheduled_intent_status(&row.get::<String, _>("status"))?,
        not_before: row
            .get::<Option<String>, _>("not_before")
            .map(|value| parse_time(&value)),
        interval_seconds: sqlite_optional_u64(row, "interval_seconds")?,
        dependency_thread_ids,
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

fn signal_outbox_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<SignalOutboxRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(SignalOutboxRecord {
        event_id: row.get("event_id"),
        status: match row.get::<String, _>("status").as_str() {
            "pending" => SignalOutboxStatus::Pending,
            "materialized" => SignalOutboxStatus::Materialized,
            "discarded" => SignalOutboxStatus::Discarded,
            value => return Err(format!("未知 Signal Outbox 状态: {value}").into()),
        },
        signal_id: row.get("signal_id"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        resolved_at: row
            .get::<Option<String>, _>("resolved_at")
            .as_deref()
            .map(parse_time),
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

async fn append_event_idempotent_in_transaction(
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
    let inserted = sqlx::query(
        "INSERT OR IGNORE INTO events (id, timestamp, actor, type, topic, context_id, session_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&event.id)
    .bind(&timestamp)
    .bind(&event.actor)
    .bind(&event.event_type)
    .bind(&event.topic)
    .bind(context_id)
    .bind(session_id)
    .bind(&payload)
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() == 1 {
        return Ok(());
    }
    let existing = sqlx::query(
        "SELECT timestamp, actor, type, topic, context_id, session_id, payload FROM events WHERE id = ?",
    )
    .bind(&event.id)
    .fetch_one(&mut **tx)
    .await?;
    let same = existing.get::<String, _>("timestamp") == timestamp
        && existing.get::<String, _>("actor") == event.actor
        && existing.get::<String, _>("type") == event.event_type
        && existing.get::<String, _>("topic") == event.topic
        && existing.get::<Option<String>, _>("context_id").as_deref() == context_id
        && existing.get::<Option<String>, _>("session_id").as_deref() == session_id
        && existing.get::<String, _>("payload") == payload;
    if !same {
        return Err(format!("Event ID '{}' 已被不同内容占用", event.id).into());
    }
    Ok(())
}

async fn append_signal_outbox_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event: &Event,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if event
        .payload
        .get("session_id")
        .and_then(JsonValue::as_str)
        .is_none()
        || event
            .payload
            .get("context_id")
            .and_then(JsonValue::as_str)
            .is_none()
    {
        return Err(format!(
            "Signal Outbox Event '{}' 缺少 context_id/session_id 路由",
            event.id
        )
        .into());
    }
    let created_at = event
        .timestamp
        .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    sqlx::query(
        "INSERT OR IGNORE INTO signal_outbox (event_id, status, created_at) VALUES (?, 'pending', ?)",
    )
    .bind(&event.id)
    .bind(created_at)
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
        .bind(&now)
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

    async fn claim_thread_signal_batch(
        &self,
        signal: NewThreadSignal,
        activation: NewThreadActivation,
        max_signals: usize,
    ) -> Result<Option<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if max_signals == 0 {
            return Err("Thread Signal batch 上限必须大于 0".into());
        }
        let sequence = i64::try_from(signal.sequence)
            .map_err(|_| "Thread Signal sequence 超出 SQLite INTEGER 范围")?;
        let max_signals = i64::try_from(max_signals)
            .map_err(|_| "Thread Signal batch 上限超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;

        // This first write serializes competing claims under SQLite WAL. The
        // immutable Event has already crossed the Ledger boundary before the
        // Orchestrator asks the scheduler to materialize its mailbox Signal.
        sqlx::query(
            r#"INSERT OR IGNORE INTO thread_signals
               (id, thread_id, event_id, sequence, kind, parent_activation_id,
                status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)"#,
        )
        .bind(&signal.id)
        .bind(&signal.thread_id)
        .bind(&signal.event_id)
        .bind(sequence)
        .bind(&signal.kind)
        .bind(&signal.parent_activation_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        let stored_signal = sqlx::query("SELECT * FROM thread_signals WHERE event_id = ?")
            .bind(&signal.event_id)
            .fetch_one(&mut *tx)
            .await?;
        let stored_signal = thread_signal_from_row(&stored_signal)?;
        if stored_signal.thread_id != signal.thread_id {
            return Err(format!("Event '{}' 已路由到不同 Thread Signal", signal.event_id).into());
        }

        if let Some(outbox) = sqlx::query("SELECT * FROM signal_outbox WHERE event_id = ?")
            .bind(&stored_signal.event_id)
            .fetch_optional(&mut *tx)
            .await?
        {
            let outbox = signal_outbox_from_row(&outbox)?;
            if outbox.status == SignalOutboxStatus::Materialized
                && outbox.signal_id.as_deref() != Some(stored_signal.id.as_str())
            {
                return Err(format!(
                    "Signal Outbox Event '{}' 已物化为不同 Signal",
                    stored_signal.event_id
                )
                .into());
            }
            sqlx::query(
                r#"UPDATE signal_outbox
                   SET status = 'materialized', signal_id = ?, resolved_at = ?
                   WHERE event_id = ? AND status = 'pending'"#,
            )
            .bind(&stored_signal.id)
            .bind(&now)
            .bind(&stored_signal.event_id)
            .execute(&mut *tx)
            .await?;
        }

        if let Some(row) = sqlx::query(
            r#"SELECT ew.* FROM activation_signals links
               JOIN thread_activations ew ON ew.id = links.activation_id
               WHERE links.signal_id = ?"#,
        )
        .bind(&stored_signal.id)
        .fetch_optional(&mut *tx)
        .await?
        {
            let existing = thread_activation_from_row(&row)?;
            tx.commit().await?;
            return Ok(Some(existing));
        }

        let thread = sqlx::query("SELECT * FROM work_threads WHERE id = ?")
            .bind(&signal.thread_id)
            .fetch_one(&mut *tx)
            .await?;
        let thread = work_thread_from_row(&thread)?;
        if thread.agent_id != activation.agent_id
            || thread.context_id != activation.context_id
            || thread.session_id != activation.session_id
            || thread.root_turn_id != activation.root_turn_id
        {
            return Err(format!(
                "Thread Signal '{}' 与 Activation route 不一致",
                stored_signal.id
            )
            .into());
        }

        // One-way adoption for durable Activations created before explicit
        // Thread Signals existed. The matching trigger Event is unambiguous;
        // attaching it here avoids creating a second Activation or stranding
        // the recovered plan behind its own queued row.
        if let Some(row) = sqlx::query(
            r#"SELECT * FROM thread_activations
               WHERE root_turn_id = ? AND trigger_event_id = ?
                 AND status IN ('queued', 'running') LIMIT 1"#,
        )
        .bind(&thread.root_turn_id)
        .bind(&stored_signal.event_id)
        .fetch_optional(&mut *tx)
        .await?
        {
            let existing = thread_activation_from_row(&row)?;
            sqlx::query(
                "INSERT OR IGNORE INTO activation_signals (activation_id, signal_id, ordinal) VALUES (?, ?, 0)",
            )
            .bind(&existing.id)
            .bind(&stored_signal.id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "UPDATE thread_signals SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'pending'",
            )
            .bind(&now)
            .bind(&stored_signal.id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(Some(existing));
        }

        // queued/running are the only Activation states that own Thread
        // single-flight. Historical waiting_* rows represent a completed
        // model activation waiting on a new physical Signal and must not block
        // its successor.
        let active = sqlx::query(
            "SELECT id FROM thread_activations WHERE root_turn_id = ? AND status IN ('queued', 'running') LIMIT 1",
        )
        .bind(&thread.root_turn_id)
        .fetch_optional(&mut *tx)
        .await?;
        if active.is_some() {
            tx.commit().await?;
            return Ok(None);
        }

        let pending = sqlx::query(
            r#"SELECT * FROM thread_signals
               WHERE thread_id = ? AND status = 'pending'
               ORDER BY sequence, id LIMIT ?"#,
        )
        .bind(&thread.id)
        .bind(max_signals)
        .fetch_all(&mut *tx)
        .await?;
        if pending.is_empty() {
            tx.commit().await?;
            return Ok(None);
        }
        let primary = thread_signal_from_row(&pending[0])?;
        let trigger_sequence = i64::try_from(primary.sequence)
            .map_err(|_| "Activation trigger sequence 超出 SQLite INTEGER 范围")?;
        sqlx::query(
            r#"INSERT INTO thread_activations
               (id, revision, agent_id, context_id, session_id, trigger_event_id,
                trigger_sequence, trigger_kind, parent_activation_id, root_turn_id,
                status, created_at, updated_at)
               VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)"#,
        )
        .bind(&activation.id)
        .bind(&activation.agent_id)
        .bind(&activation.context_id)
        .bind(&activation.session_id)
        .bind(&primary.event_id)
        .bind(trigger_sequence)
        .bind(&primary.kind)
        .bind(&primary.parent_activation_id)
        .bind(&activation.root_turn_id)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        for (ordinal, row) in pending.iter().enumerate() {
            let pending_signal = thread_signal_from_row(row)?;
            let ordinal = i64::try_from(ordinal)
                .map_err(|_| "Activation Signal ordinal 超出 SQLite INTEGER 范围")?;
            sqlx::query(
                "INSERT INTO activation_signals (activation_id, signal_id, ordinal) VALUES (?, ?, ?)",
            )
            .bind(&activation.id)
            .bind(&pending_signal.id)
            .bind(ordinal)
            .execute(&mut *tx)
            .await?;
            let claimed = sqlx::query(
                "UPDATE thread_signals SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'pending'",
            )
            .bind(&now)
            .bind(&pending_signal.id)
            .execute(&mut *tx)
            .await?;
            if claimed.rows_affected() != 1 {
                return Err(format!(
                    "Thread Signal '{}' 在 Activation claim 中发生并发冲突",
                    pending_signal.id
                )
                .into());
            }
        }
        tx.commit().await?;
        self.get_thread_activation(&activation.id).await
    }

    async fn list_signal_outbox(
        &self,
        status: SignalOutboxStatus,
        limit: usize,
    ) -> Result<Vec<SignalOutboxRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let limit =
            i64::try_from(limit).map_err(|_| "Signal Outbox 查询上限超出 SQLite INTEGER 范围")?;
        let rows = sqlx::query(
            r#"SELECT outbox.* FROM signal_outbox outbox
               JOIN events ON events.id = outbox.event_id
               WHERE outbox.status = ?
               ORDER BY events.rowid, outbox.event_id
               LIMIT ?"#,
        )
        .bind(status.as_str())
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(signal_outbox_from_row).collect()
    }

    async fn discard_signal_outbox(
        &self,
        event_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE signal_outbox
               SET status = 'discarded', resolved_at = ?
               WHERE event_id = ? AND status = 'pending'"#,
        )
        .bind(now)
        .bind(event_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    async fn list_context_thread_signals(
        &self,
        context_id: &str,
        status: Option<ThreadSignalStatus>,
    ) -> Result<Vec<ThreadSignalRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = if let Some(status) = status {
            sqlx::query(
                r#"SELECT signals.* FROM thread_signals signals
                   JOIN work_threads threads ON threads.id = signals.thread_id
                   WHERE threads.context_id = ? AND signals.status = ?
                   ORDER BY signals.sequence, signals.id"#,
            )
            .bind(context_id)
            .bind(status.as_str())
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                r#"SELECT signals.* FROM thread_signals signals
                   JOIN work_threads threads ON threads.id = signals.thread_id
                   WHERE threads.context_id = ?
                   ORDER BY signals.sequence, signals.id"#,
            )
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?
        };
        rows.iter().map(thread_signal_from_row).collect()
    }

    async fn list_activation_signals(
        &self,
        activation_id: &str,
    ) -> Result<Vec<ThreadSignalRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = sqlx::query(
            r#"SELECT signals.* FROM activation_signals links
               JOIN thread_signals signals ON signals.id = links.signal_id
               WHERE links.activation_id = ? ORDER BY links.ordinal"#,
        )
        .bind(activation_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(thread_signal_from_row).collect()
    }

    async fn next_pending_thread_signal(
        &self,
        thread_id: &str,
    ) -> Result<Option<ThreadSignalRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query(
            r#"SELECT * FROM thread_signals WHERE thread_id = ? AND status = 'pending'
               ORDER BY sequence, id LIMIT 1"#,
        )
        .bind(thread_id)
        .fetch_optional(&self.pool)
        .await?
        .as_ref()
        .map(thread_signal_from_row)
        .transpose()
    }

    async fn ensure_thread_activation(
        &self,
        work_item: NewThreadActivation,
    ) -> Result<ThreadActivationRecord, Box<dyn std::error::Error + Send + Sync>> {
        let trigger_sequence = i64::try_from(work_item.trigger_sequence)
            .map_err(|_| "Thread Activation trigger sequence 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"INSERT OR IGNORE INTO thread_activations
               (id, revision, agent_id, context_id, session_id, trigger_event_id,
                trigger_sequence, trigger_kind, parent_activation_id, root_turn_id,
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
        .bind(&work_item.parent_activation_id)
        .bind(&work_item.root_turn_id)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        let row = sqlx::query("SELECT * FROM thread_activations WHERE trigger_event_id = ?")
            .bind(&work_item.trigger_event_id)
            .fetch_one(&self.pool)
            .await?;
        let existing = thread_activation_from_row(&row)?;
        if existing.context_id != work_item.context_id
            || existing.session_id != work_item.session_id
            || existing.root_turn_id != work_item.root_turn_id
        {
            return Err(format!(
                "Trigger Event '{}' 已被不同 Thread Activation 占用",
                work_item.trigger_event_id
            )
            .into());
        }
        Ok(existing)
    }

    async fn get_thread_activation(
        &self,
        id: &str,
    ) -> Result<Option<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query("SELECT * FROM thread_activations WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(thread_activation_from_row).transpose()
    }

    async fn list_context_thread_activations(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = if include_terminal {
            sqlx::query(
                "SELECT * FROM thread_activations WHERE context_id = ? ORDER BY created_at, id",
            )
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT * FROM thread_activations WHERE context_id = ? AND status NOT IN ('completed', 'cancelled', 'failed') ORDER BY created_at, id",
            )
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?
        };
        rows.iter().map(thread_activation_from_row).collect()
    }

    async fn update_thread_activation(
        &self,
        id: &str,
        expected_revision: u64,
        status: ThreadActivationStatus,
        claimed_by: Option<&str>,
        lease_expires_at: Option<DateTime<Utc>>,
        context_snapshot_version: Option<u64>,
    ) -> Result<ThreadActivationMutation, Box<dyn std::error::Error + Send + Sync>> {
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Thread Activation revision 超出 SQLite INTEGER 范围")?;
        let context_snapshot_version = context_snapshot_version
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "Context snapshot version 超出 SQLite INTEGER 范围")?;
        let lease_expires_at =
            lease_expires_at.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            r#"UPDATE thread_activations
               SET revision = revision + 1, status = ?, claimed_by = ?,
                   lease_expires_at = ?,
                   context_snapshot_version = COALESCE(?, context_snapshot_version),
                   updated_at = ?
               WHERE id = ? AND revision = ?"#,
        )
        .bind(thread_activation_status_storage(status))
        .bind(claimed_by)
        .bind(lease_expires_at)
        .bind(context_snapshot_version)
        .bind(&now)
        .bind(id)
        .bind(expected_revision)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 1 {
            if status.is_terminal() {
                sqlx::query(
                    r#"UPDATE thread_signals
                       SET status = 'acknowledged', acknowledged_at = ?
                       WHERE id IN (
                         SELECT signal_id FROM activation_signals WHERE activation_id = ?
                       ) AND status = 'claimed'"#,
                )
                .bind(&now)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            }
            let row = sqlx::query("SELECT * FROM thread_activations WHERE id = ?")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
            let updated = thread_activation_from_row(&row)?;
            tx.commit().await?;
            return Ok(ThreadActivationMutation::Updated(updated));
        }
        tx.commit().await?;
        Ok(match self.get_thread_activation(id).await? {
            Some(current) => ThreadActivationMutation::Conflict { current },
            None => ThreadActivationMutation::NotFound,
        })
    }

    async fn commit_activation_outcome(
        &self,
        work_item_id: &str,
        event: &Event,
    ) -> Result<ActivationOutcomeCommit, Box<dyn std::error::Error + Send + Sync>> {
        let session_id = event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("Evaluation outcome Event 缺少 session_id")?;
        let disposition = event
            .payload
            .get("disposition")
            .and_then(JsonValue::as_str)
            .unwrap_or("deliver");
        let root_turn_id = event
            .payload
            .get("root_turn_id")
            .and_then(JsonValue::as_str)
            .ok_or("Evaluation outcome Event 缺少 root_turn_id")?;
        let thread_id = event
            .payload
            .get("work_thread_id")
            .and_then(JsonValue::as_str)
            .ok_or("Evaluation outcome Event 缺少 work_thread_id")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            "INSERT INTO work_thread_outcomes (thread_id, root_turn_id, work_item_id, session_id, disposition, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(root_turn_id) DO NOTHING",
        )
        .bind(thread_id)
        .bind(root_turn_id)
        .bind(work_item_id)
        .bind(session_id)
        .bind(disposition)
        .bind(&event.id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 0 {
            let existing =
                sqlx::query("SELECT event_id FROM work_thread_outcomes WHERE root_turn_id = ?")
                    .bind(root_turn_id)
                    .fetch_one(&mut *tx)
                    .await?;
            tx.commit().await?;
            return Ok(ActivationOutcomeCommit::Existing {
                event_id: existing.get("event_id"),
            });
        }
        let result_text = event.payload.get("text").and_then(JsonValue::as_str);
        let (delivery_status, delivery_event_id) = match event.topic.as_str() {
            "chat/reply" => ("delivered", Some(event.id.as_str())),
            "runtime/thread_result" => ("pending", None),
            _ => ("none", None),
        };
        let terminal = sqlx::query(
            r#"UPDATE work_threads
               SET revision = revision + 1,
                   status = 'completed',
                   result_text = COALESCE(?, result_text),
                   result_event_id = ?,
                   delivery_status = ?,
                   delivery_event_id = ?,
                   updated_at = ?
               WHERE id = ? AND root_turn_id = ? AND session_id = ?
                 AND status NOT IN ('completed', 'failed', 'cancelled')"#,
        )
        .bind(result_text)
        .bind(&event.id)
        .bind(delivery_status)
        .bind(delivery_event_id)
        .bind(&now)
        .bind(thread_id)
        .bind(root_turn_id)
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
        if terminal.rows_affected() != 1 {
            return Err(format!(
                "Evaluation outcome 无法原子提交 Work Thread '{}' 终态",
                thread_id
            )
            .into());
        }
        if let Some(covers) = event.payload.get("covers").and_then(JsonValue::as_array) {
            for thread_id in covers.iter().filter_map(JsonValue::as_str) {
                let updated = sqlx::query(
                    "UPDATE work_threads SET revision = revision + 1, delivery_status = 'delivered', delivery_event_id = ?, updated_at = ? WHERE id = ? AND session_id = ? AND delivery_status IN ('pending', 'deferred')",
                )
                .bind(&event.id)
                .bind(&now)
                .bind(thread_id)
                .bind(session_id)
                .execute(&mut *tx)
                .await?;
                if updated.rows_affected() != 1 {
                    return Err(format!(
                        "Delivery outcome 无法覆盖 Thread '{}'：它不属于当前 Session、已被交付或不是 pending/deferred",
                        thread_id
                    )
                    .into());
                }
            }
        }
        if let Some(covers) = event
            .payload
            .get("defer_covers")
            .and_then(JsonValue::as_array)
        {
            for thread_id in covers.iter().filter_map(JsonValue::as_str) {
                sqlx::query(
                    "UPDATE work_threads SET revision = revision + 1, delivery_status = 'deferred', updated_at = ? WHERE id = ? AND session_id = ? AND delivery_status = 'pending'",
                )
                .bind(&now)
                .bind(thread_id)
                .bind(session_id)
                .execute(&mut *tx)
                .await?;
            }
        }
        sqlx::query(
            "INSERT OR IGNORE INTO evaluation_outcomes (work_item_id, session_id, disposition, event_id, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(work_item_id)
        .bind(session_id)
        .bind(disposition)
        .bind(&event.id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
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
        Ok(ActivationOutcomeCommit::Committed)
    }

    async fn ensure_work_thread(
        &self,
        thread: NewWorkThread,
    ) -> Result<WorkThreadRecord, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"INSERT OR IGNORE INTO work_threads
               (id, revision, agent_id, context_id, session_id, root_turn_id,
                kind, status, executor_kind, executor_id, delivery_status,
                created_at, updated_at)
               VALUES (?, 1, ?, ?, ?, ?, ?, 'active', ?, ?, 'none', ?, ?)"#,
        )
        .bind(&thread.id)
        .bind(&thread.agent_id)
        .bind(&thread.context_id)
        .bind(&thread.session_id)
        .bind(&thread.root_turn_id)
        .bind(thread.kind.as_str())
        .bind(&thread.executor_kind)
        .bind(&thread.executor_id)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        let row = sqlx::query("SELECT * FROM work_threads WHERE root_turn_id = ?")
            .bind(&thread.root_turn_id)
            .fetch_one(&self.pool)
            .await?;
        let existing = work_thread_from_row(&row)?;
        if existing.context_id != thread.context_id
            || existing.session_id != thread.session_id
            || existing.agent_id != thread.agent_id
        {
            return Err(format!(
                "Root Turn '{}' 已被不同 Work Thread 占用",
                thread.root_turn_id
            )
            .into());
        }
        Ok(existing)
    }

    async fn get_work_thread(
        &self,
        id: &str,
    ) -> Result<Option<WorkThreadRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query("SELECT * FROM work_threads WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(work_thread_from_row)
            .transpose()
    }

    async fn get_work_thread_by_root(
        &self,
        root_turn_id: &str,
    ) -> Result<Option<WorkThreadRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query("SELECT * FROM work_threads WHERE root_turn_id = ?")
            .bind(root_turn_id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(work_thread_from_row)
            .transpose()
    }

    async fn list_context_work_threads(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<WorkThreadRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = if include_terminal {
            sqlx::query("SELECT * FROM work_threads WHERE context_id = ? ORDER BY created_at, id")
                .bind(context_id)
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query("SELECT * FROM work_threads WHERE context_id = ? AND status NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at, id")
                .bind(context_id)
                .fetch_all(&self.pool)
                .await?
        };
        rows.iter().map(work_thread_from_row).collect()
    }

    async fn update_work_thread(
        &self,
        id: &str,
        expected_revision: u64,
        kind: Option<WorkThreadKind>,
        lifecycle: Option<ThreadLifecycle>,
        result_text: Option<&str>,
        result_event_id: Option<&str>,
        delivery_status: Option<DeliveryStatus>,
        delivery_event_id: Option<&str>,
    ) -> Result<WorkThreadMutation, Box<dyn std::error::Error + Send + Sync>> {
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Work Thread revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE work_threads
               SET revision = revision + 1,
                   kind = COALESCE(?, kind),
                   status = COALESCE(?, status),
                   result_text = COALESCE(?, result_text),
                   result_event_id = COALESCE(?, result_event_id),
                   delivery_status = COALESCE(?, delivery_status),
                   delivery_event_id = COALESCE(?, delivery_event_id),
                   updated_at = ?
               WHERE id = ? AND revision = ?"#,
        )
        .bind(kind.map(WorkThreadKind::as_str))
        // The physical column is retained until the one-way schema rebuild,
        // but its value now stores lifecycle only.
        .bind(lifecycle.map(|value| match value {
            ThreadLifecycle::Open => "active",
            other => other.as_str(),
        }))
        .bind(result_text)
        .bind(result_event_id)
        .bind(delivery_status.map(DeliveryStatus::as_str))
        .bind(delivery_event_id)
        .bind(now)
        .bind(id)
        .bind(expected_revision)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(WorkThreadMutation::Updated(
                self.get_work_thread(id)
                    .await?
                    .ok_or("Work Thread 更新后无法读取")?,
            ));
        }
        Ok(match self.get_work_thread(id).await? {
            Some(current) => WorkThreadMutation::Conflict { current },
            None => WorkThreadMutation::NotFound,
        })
    }

    async fn ensure_scheduled_intent(
        &self,
        intent: NewScheduledIntent,
    ) -> Result<ScheduledIntentRecord, Box<dyn std::error::Error + Send + Sync>> {
        let interval_seconds = intent
            .interval_seconds
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "Scheduled Intent interval 超出 SQLite INTEGER 范围")?;
        let not_before = intent
            .not_before
            .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        let dependencies = serde_json::to_string(&intent.dependency_thread_ids)?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"INSERT OR IGNORE INTO scheduled_intents
               (id, revision, thread_id, source_turn_id, intent, status,
                not_before, interval_seconds, dependency_thread_ids_json,
                created_at, updated_at)
               VALUES (?, 1, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)"#,
        )
        .bind(&intent.id)
        .bind(&intent.thread_id)
        .bind(&intent.source_turn_id)
        .bind(&intent.intent)
        .bind(not_before)
        .bind(interval_seconds)
        .bind(dependencies)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        let row = sqlx::query("SELECT * FROM scheduled_intents WHERE id = ?")
            .bind(&intent.id)
            .fetch_one(&self.pool)
            .await?;
        scheduled_intent_from_row(&row)
    }

    async fn get_scheduled_intent(
        &self,
        id: &str,
    ) -> Result<Option<ScheduledIntentRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query("SELECT * FROM scheduled_intents WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(scheduled_intent_from_row)
            .transpose()
    }

    async fn commit_schedule_transaction(
        &self,
        threads: &[NewWorkThread],
        intents: &[NewScheduledIntent],
    ) -> Result<Vec<ScheduledIntentRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        for thread in threads {
            sqlx::query(
                r#"INSERT OR IGNORE INTO work_threads
                   (id, revision, agent_id, context_id, session_id, root_turn_id,
                    kind, status, executor_kind, executor_id, delivery_status,
                    created_at, updated_at)
                   VALUES (?, 1, ?, ?, ?, ?, ?, 'active', ?, ?, 'none', ?, ?)"#,
            )
            .bind(&thread.id)
            .bind(&thread.agent_id)
            .bind(&thread.context_id)
            .bind(&thread.session_id)
            .bind(&thread.root_turn_id)
            .bind(thread.kind.as_str())
            .bind(&thread.executor_kind)
            .bind(&thread.executor_id)
            .bind(&now)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        for intent in intents {
            let target = sqlx::query("SELECT status FROM work_threads WHERE id = ?")
                .bind(&intent.thread_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| format!("Scheduled Intent '{}' 的目标 Thread 不存在", intent.id))?;
            let target_status: String = target.get("status");
            if matches!(target_status.as_str(), "failed" | "cancelled") {
                return Err(format!(
                    "Scheduled Intent '{}' 不能写入状态为 '{}' 的 Thread",
                    intent.id, target_status
                )
                .into());
            }
            let interval_seconds = intent
                .interval_seconds
                .map(i64::try_from)
                .transpose()
                .map_err(|_| "Scheduled Intent interval 超出 SQLite INTEGER 范围")?;
            let not_before = intent
                .not_before
                .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
            let dependencies = serde_json::to_string(&intent.dependency_thread_ids)?;
            sqlx::query(
                r#"INSERT INTO scheduled_intents
                   (id, revision, thread_id, source_turn_id, intent, status,
                    not_before, interval_seconds, dependency_thread_ids_json,
                    created_at, updated_at)
                   VALUES (?, 1, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO NOTHING"#,
            )
            .bind(&intent.id)
            .bind(&intent.thread_id)
            .bind(&intent.source_turn_id)
            .bind(&intent.intent)
            .bind(not_before)
            .bind(interval_seconds)
            .bind(dependencies)
            .bind(&now)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        let mut records = Vec::with_capacity(intents.len());
        for intent in intents {
            records.push(
                self.get_scheduled_intent(&intent.id)
                    .await?
                    .ok_or_else(|| format!("Scheduled Intent '{}' 提交后不存在", intent.id))?,
            );
        }
        Ok(records)
    }

    async fn list_scheduled_intents(
        &self,
        thread_id: Option<&str>,
        status: Option<ScheduledIntentStatus>,
    ) -> Result<Vec<ScheduledIntentRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = match (thread_id, status) {
            (Some(thread_id), Some(status)) => {
                sqlx::query("SELECT * FROM scheduled_intents WHERE thread_id = ? AND status = ? ORDER BY COALESCE(not_before, created_at), id")
                    .bind(thread_id)
                    .bind(status.as_str())
                    .fetch_all(&self.pool)
                    .await?
            }
            (Some(thread_id), None) => {
                sqlx::query("SELECT * FROM scheduled_intents WHERE thread_id = ? ORDER BY COALESCE(not_before, created_at), id")
                    .bind(thread_id)
                    .fetch_all(&self.pool)
                    .await?
            }
            (None, Some(status)) => {
                sqlx::query("SELECT * FROM scheduled_intents WHERE status = ? ORDER BY COALESCE(not_before, created_at), id")
                    .bind(status.as_str())
                    .fetch_all(&self.pool)
                    .await?
            }
            (None, None) => {
                sqlx::query("SELECT * FROM scheduled_intents ORDER BY COALESCE(not_before, created_at), id")
                    .fetch_all(&self.pool)
                    .await?
            }
        };
        rows.iter().map(scheduled_intent_from_row).collect()
    }

    async fn claim_scheduled_intent(
        &self,
        id: &str,
        expected_revision: u64,
        next_not_before: Option<DateTime<Utc>>,
    ) -> Result<Option<ScheduledIntentRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Scheduled Intent revision 超出 SQLite INTEGER 范围")?;
        let next_not_before =
            next_not_before.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        let next_status = if next_not_before.is_some() {
            ScheduledIntentStatus::Queued
        } else {
            ScheduledIntentStatus::Dispatched
        };
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            "UPDATE scheduled_intents SET revision = revision + 1, status = ?, not_before = COALESCE(?, not_before), updated_at = ? WHERE id = ? AND revision = ? AND status = 'queued'",
        )
        .bind(next_status.as_str())
        .bind(next_not_before)
        .bind(now)
        .bind(id)
        .bind(expected_revision)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Ok(None);
        }
        let row = sqlx::query("SELECT * FROM scheduled_intents WHERE id = ?")
            .bind(id)
            .fetch_one(&self.pool)
            .await?;
        Ok(Some(scheduled_intent_from_row(&row)?))
    }

    async fn commit_scheduled_dispatch(
        &self,
        id: &str,
        expected_revision: u64,
        next_not_before: Option<DateTime<Utc>>,
        event: &Event,
    ) -> Result<Option<ScheduledIntentRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Scheduled Intent revision 超出 SQLite INTEGER 范围")?;
        let next_not_before =
            next_not_before.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        let next_status = if next_not_before.is_some() {
            ScheduledIntentStatus::Queued
        } else {
            ScheduledIntentStatus::Dispatched
        };
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            "UPDATE scheduled_intents SET revision = revision + 1, status = ?, not_before = COALESCE(?, not_before), updated_at = ? WHERE id = ? AND revision = ? AND status = 'queued'",
        )
        .bind(next_status.as_str())
        .bind(next_not_before)
        .bind(&now)
        .bind(id)
        .bind(expected_revision)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 0 {
            tx.rollback().await?;
            return Ok(None);
        }
        append_event_in_transaction(&mut tx, event).await?;
        append_signal_outbox_in_transaction(&mut tx, event).await?;
        tx.commit().await?;
        self.get_scheduled_intent(id).await
    }

    async fn commit_thread_delivery(
        &self,
        thread_ids: &[String],
        event: &Event,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        if thread_ids.is_empty() {
            return Err("Thread delivery 至少覆盖一个 thread_id".into());
        }
        let session_id = event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("Thread delivery Event 缺少 session_id")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        for thread_id in thread_ids {
            let result = sqlx::query(
                "UPDATE work_threads SET revision = revision + 1, delivery_status = 'delivered', delivery_event_id = ?, updated_at = ? WHERE id = ? AND session_id = ? AND delivery_status IN ('pending', 'deferred')",
            )
            .bind(&event.id)
            .bind(&now)
            .bind(thread_id)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
            if result.rows_affected() != 1 {
                tx.rollback().await?;
                return Ok(false);
            }
        }
        append_event_in_transaction(&mut tx, event).await?;
        tx.commit().await?;
        Ok(true)
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
            append_signal_outbox_in_transaction(&mut tx, event).await?;
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

    async fn commit_delegation_result(
        &self,
        id: &str,
        event: &Event,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let mut tx = self.pool.begin().await?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        // The first statement must be a write. Starting with SELECT creates a deferred read
        // snapshot which cannot always be upgraded while the child Activation is committing its
        // terminal outcome, yielding SQLITE_BUSY instead of honoring busy_timeout.
        let updated = sqlx::query(
            r#"UPDATE delegations
               SET status = 'completed', result_event_id = ?, updated_at = ?
               WHERE id = ? AND status IN ('queued', 'running')"#,
        )
        .bind(&event.id)
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            let exists =
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM delegations WHERE id = ?")
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await?
                    > 0;
            tx.commit().await?;
            return if exists {
                Ok(false)
            } else {
                Err(format!("Delegation '{id}' 不存在").into())
            };
        }
        let row = sqlx::query(
            "SELECT id, agent_id, parent_context_id, parent_session_id, child_context_id, child_session_id, task, success_when, context_scope, status, result_event_id, created_at, updated_at FROM delegations WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        let delegation = delegation_from_row(&row);
        let event_context_id = event.payload.get("context_id").and_then(JsonValue::as_str);
        let event_session_id = event.payload.get("session_id").and_then(JsonValue::as_str);
        if event_context_id != Some(delegation.parent_context_id.as_str())
            || event_session_id != Some(delegation.parent_session_id.as_str())
        {
            tx.rollback().await?;
            return Err(
                format!("Delegation '{id}' 结果 Event 路由到错误的父 Context/Session").into(),
            );
        }
        append_event_idempotent_in_transaction(&mut tx, event).await?;
        append_signal_outbox_in_transaction(&mut tx, event).await?;
        tx.commit().await?;
        Ok(true)
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

    async fn claim_objective_evaluation_with_signal(
        &self,
        id: &str,
        expected_revision: u64,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
        event: &Event,
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
        let event_context_id = event.payload.get("context_id").and_then(JsonValue::as_str);
        let event_session_id = event.payload.get("session_id").and_then(JsonValue::as_str);
        let event_objective_id = event
            .payload
            .get("objective_id")
            .and_then(JsonValue::as_str);
        let event_evaluation_id = event
            .payload
            .get("objective_evaluation_id")
            .and_then(JsonValue::as_str);
        if event_context_id != Some(current.context_id.as_str())
            || event_session_id != Some(current.coordinator_session_id.as_str())
            || event_objective_id != Some(id)
            || event_evaluation_id != Some(evaluation_id)
        {
            return Err(format!("Objective '{id}' continuation Event 路由不一致").into());
        }
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Objective revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let lease_expires_at = lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        let updated = sqlx::query(
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
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(match self.get_objective(id).await? {
                Some(current) => ObjectiveMutation::Conflict { current },
                None => ObjectiveMutation::NotFound,
            });
        }
        append_event_idempotent_in_transaction(&mut tx, event).await?;
        append_signal_outbox_in_transaction(&mut tx, event).await?;
        tx.commit().await?;
        Ok(ObjectiveMutation::Updated(
            self.get_objective(id)
                .await?
                .ok_or("Objective Evaluation + Signal 提交后无法读取")?,
        ))
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
        let mut tx = self.pool.begin().await?;
        append_event_idempotent_in_transaction(&mut tx, &ev).await?;
        tx.commit().await?;
        Ok(())
    }

    async fn append_with_signal_outbox(
        &self,
        ev: Event,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut tx = self.pool.begin().await?;
        append_event_idempotent_in_transaction(&mut tx, &ev).await?;
        append_signal_outbox_in_transaction(&mut tx, &ev).await?;
        tx.commit().await?;
        Ok(())
    }

    async fn query(
        &self,
        filter: QueryFilter,
    ) -> Result<Vec<Event>, Box<dyn std::error::Error + Send + Sync>> {
        let mut builder = QueryBuilder::new(
            "SELECT rowid AS event_sequence, id, timestamp, actor, type, topic, payload FROM events WHERE 1=1",
        );

        if let Some(event_id) = filter.event_id {
            builder.push(" AND id = ");
            builder.push_bind(event_id);
        }

        if let Some(sequence) = filter.sequence {
            builder.push(" AND rowid = ");
            builder.push_bind(i64::try_from(sequence).unwrap_or(i64::MAX));
        }

        if let Some(context_id) = filter.context_id {
            builder.push(" AND context_id = ");
            builder.push_bind(context_id);
        }

        if let Some(session_id) = filter.session_id {
            builder.push(" AND session_id = ");
            builder.push_bind(session_id);
        }

        if let Some(after_sequence) = filter.after_sequence {
            builder.push(" AND rowid > ");
            builder.push_bind(i64::try_from(after_sequence).unwrap_or(i64::MAX));
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

        for topic in filter.excluded_topics {
            if topic == "*" {
                builder.push(" AND 0=1");
            } else if topic.ends_with("/*") {
                let prefix = &topic[..topic.len() - 2];
                builder.push(" AND topic NOT LIKE ");
                builder.push_bind(format!("{}/%", prefix));
            } else {
                builder.push(" AND topic != ");
                builder.push_bind(topic);
            }
        }

        if let Some(search_query) = filter.search_query {
            builder.push(" AND (payload LIKE ");
            builder.push_bind(format!("%{}%", search_query));
            builder.push(" OR topic LIKE ");
            builder.push_bind(format!("%{}%", search_query));
            builder.push(")");
        }

        let latest_k = filter.latest_k;
        if latest_k.is_some() {
            // Limit the tail in SQLite, then restore chronological order below.
            builder.push(" ORDER BY timestamp DESC, rowid DESC");
        } else {
            // 强制按时间戳升序排序，并在时间戳相同时按 rowid 物理插入顺序升序
            builder.push(" ORDER BY timestamp ASC, rowid ASC");
        }

        if let Some(top_k) = latest_k.or(filter.top_k) {
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

        if latest_k.is_some() {
            events.reverse();
        }

        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::QueryFilter;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tempfile::NamedTempFile;

    #[tokio::test]
    async fn migrates_legacy_evaluation_work_items_into_thread_activations() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_str().unwrap();
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query(
            r#"CREATE TABLE evaluation_work_items (
                id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL,
                agent_id TEXT NOT NULL,
                context_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                trigger_event_id TEXT NOT NULL UNIQUE,
                trigger_sequence INTEGER NOT NULL,
                trigger_kind TEXT NOT NULL,
                parent_work_item_id TEXT,
                root_turn_id TEXT NOT NULL,
                context_snapshot_version INTEGER,
                status TEXT NOT NULL,
                claimed_by TEXT,
                lease_expires_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE evaluation_outcomes (
                work_item_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                disposition TEXT NOT NULL,
                event_id TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                FOREIGN KEY(work_item_id) REFERENCES evaluation_work_items(id) ON DELETE CASCADE
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"INSERT INTO evaluation_work_items
               (id, revision, agent_id, context_id, session_id, trigger_event_id,
                trigger_sequence, trigger_kind, parent_work_item_id, root_turn_id,
                status, created_at, updated_at)
               VALUES ('legacy-activation', 1, 'agent', 'context', 'session',
                       'event', 7, 'chat/tool_output', NULL, 'root',
                       'waiting_tool', ?, ?)"#,
        )
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let store = SqliteStore::new(path).await.unwrap();
        let migrated = store
            .get_thread_activation("legacy-activation")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(migrated.status, ThreadActivationStatus::Succeeded);
        let columns = sqlx::query("PRAGMA table_info(thread_activations)")
            .fetch_all(&store.pool)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get::<String, _>("name"))
            .collect::<std::collections::HashSet<_>>();
        assert!(columns.contains("parent_activation_id"));
        assert!(!columns.contains("parent_work_item_id"));
        let legacy_table = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'evaluation_work_items'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(legacy_table, 0);
        let outcome_foreign_keys = sqlx::query("PRAGMA foreign_key_list(evaluation_outcomes)")
            .fetch_all(&store.pool)
            .await
            .unwrap();
        assert!(outcome_foreign_keys
            .iter()
            .any(|row| row.get::<String, _>("table") == "thread_activations"));
    }

    #[tokio::test]
    async fn test_sqlite_event_store() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );

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
    async fn signal_outbox_survives_the_event_to_signal_crash_window() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_str().unwrap();
        let store = Arc::new(SqliteStore::new(path).await.unwrap());
        store
            .create_context(NewCognitiveContext {
                id: "outbox-context".to_string(),
                agent_id: "outbox-agent".to_string(),
                title: "Outbox Context".to_string(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: "outbox-session".to_string(),
                agent_id: "outbox-agent".to_string(),
                context_id: "outbox-context".to_string(),
                parent_session_id: None,
                title: "Outbox Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let event = Event::new(
            "outbox-event".to_string(),
            "fixture".to_string(),
            crate::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            [
                (
                    "context_id".to_string(),
                    serde_json::json!("outbox-context"),
                ),
                (
                    "session_id".to_string(),
                    serde_json::json!("outbox-session"),
                ),
                (
                    "client_message_id".to_string(),
                    serde_json::json!("outbox-client-message"),
                ),
                ("text".to_string(), serde_json::json!("continue")),
            ]
            .into_iter()
            .collect(),
        );
        assert_eq!(
            store
                .claim_message("outbox-session", "outbox-client-message", &event)
                .await
                .unwrap(),
            MessageClaim::Accepted
        );
        let pending = store
            .list_signal_outbox(SignalOutboxStatus::Pending, 16)
            .await
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].event_id, event.id);

        // Simulate a process crash after the user Event transaction committed
        // but before EventBus could invoke the Orchestrator.
        store.pool.close().await;
        drop(store);
        let store = Arc::new(SqliteStore::new(path).await.unwrap());
        assert_eq!(
            store
                .list_signal_outbox(SignalOutboxStatus::Pending, 16)
                .await
                .unwrap()
                .len(),
            1
        );
        let stored_event = store
            .query(QueryFilter {
                event_id: Some(event.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .pop()
            .unwrap();
        let sequence = stored_event.sequence.unwrap();
        let thread = store
            .ensure_work_thread(NewWorkThread {
                id: "outbox-thread".to_string(),
                agent_id: "outbox-agent".to_string(),
                context_id: "outbox-context".to_string(),
                session_id: "outbox-session".to_string(),
                root_turn_id: event.id.clone(),
                kind: WorkThreadKind::Dialogue,
                executor_kind: "self".to_string(),
                executor_id: None,
            })
            .await
            .unwrap();
        let activation = store
            .claim_thread_signal_batch(
                NewThreadSignal {
                    id: "outbox-signal".to_string(),
                    thread_id: thread.id,
                    event_id: event.id.clone(),
                    sequence,
                    kind: event.topic.clone(),
                    parent_activation_id: None,
                },
                NewThreadActivation {
                    id: "outbox-activation".to_string(),
                    agent_id: "outbox-agent".to_string(),
                    context_id: "outbox-context".to_string(),
                    session_id: "outbox-session".to_string(),
                    trigger_event_id: event.id.clone(),
                    trigger_sequence: sequence,
                    trigger_kind: event.topic.clone(),
                    parent_activation_id: None,
                    root_turn_id: event.id.clone(),
                },
                32,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(activation.id, "outbox-activation");
        assert!(store
            .list_signal_outbox(SignalOutboxStatus::Pending, 16)
            .await
            .unwrap()
            .is_empty());
        let materialized = store
            .list_signal_outbox(SignalOutboxStatus::Materialized, 16)
            .await
            .unwrap();
        assert_eq!(materialized.len(), 1);
        assert_eq!(materialized[0].signal_id.as_deref(), Some("outbox-signal"));

        // Re-appending the same routed Event cannot reopen the handoff.
        store
            .append_with_signal_outbox(event.clone())
            .await
            .unwrap();
        assert!(store
            .list_signal_outbox(SignalOutboxStatus::Pending, 16)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn signal_outbox_rejects_unroutable_events_atomically() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let event = Event::new(
            "unroutable-outbox-event".to_string(),
            "fixture".to_string(),
            crate::event::TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            serde_json::Map::new(),
        );
        assert!(store
            .append_with_signal_outbox(event.clone())
            .await
            .is_err());
        assert!(store
            .query(QueryFilter {
                event_id: Some(event.id),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty());

        let discarded = Event::new(
            "discarded-outbox-event".to_string(),
            "fixture".to_string(),
            crate::event::TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            [
                ("context_id".to_string(), serde_json::json!("context")),
                ("session_id".to_string(), serde_json::json!("session")),
            ]
            .into_iter()
            .collect(),
        );
        store
            .append_with_signal_outbox(discarded.clone())
            .await
            .unwrap();
        assert!(store.discard_signal_outbox(&discarded.id).await.unwrap());
        assert!(!store.discard_signal_outbox(&discarded.id).await.unwrap());
        assert_eq!(
            store
                .list_signal_outbox(SignalOutboxStatus::Discarded, 16)
                .await
                .unwrap()[0]
                .event_id,
            discarded.id
        );
    }

    #[tokio::test]
    async fn thread_signals_are_claimed_in_one_bounded_ordered_activation_batch() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        store
            .create_context(NewCognitiveContext {
                id: "signal-context".to_string(),
                agent_id: "signal-agent".to_string(),
                title: "Signal Context".to_string(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: "signal-session".to_string(),
                agent_id: "signal-agent".to_string(),
                context_id: "signal-context".to_string(),
                parent_session_id: None,
                title: "Signal Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let thread = store
            .ensure_work_thread(NewWorkThread {
                id: "signal-thread".to_string(),
                agent_id: "signal-agent".to_string(),
                context_id: "signal-context".to_string(),
                session_id: "signal-session".to_string(),
                root_turn_id: "signal-root".to_string(),
                kind: WorkThreadKind::Work,
                executor_kind: "self".to_string(),
                executor_id: None,
            })
            .await
            .unwrap();

        for event_id in ["signal-event-1", "signal-event-2", "signal-event-3"] {
            store
                .append(Event::new(
                    event_id.to_string(),
                    "fixture".to_string(),
                    crate::event::TYPE_TOOL_OUTPUT.to_string(),
                    "chat/tool_output".to_string(),
                    [
                        (
                            "context_id".to_string(),
                            serde_json::json!("signal-context"),
                        ),
                        (
                            "session_id".to_string(),
                            serde_json::json!("signal-session"),
                        ),
                        ("root_turn_id".to_string(), serde_json::json!("signal-root")),
                    ]
                    .into_iter()
                    .collect(),
                ))
                .await
                .unwrap();
        }
        let events = store
            .query(QueryFilter {
                context_id: Some("signal-context".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        let sequence = |event_id: &str| {
            events
                .iter()
                .find(|event| event.id == event_id)
                .and_then(|event| event.sequence)
                .unwrap()
        };
        let signal = |index: usize| NewThreadSignal {
            id: format!("signal-{index}"),
            thread_id: thread.id.clone(),
            event_id: format!("signal-event-{index}"),
            sequence: sequence(&format!("signal-event-{index}")),
            kind: "chat/tool_output".to_string(),
            parent_activation_id: None,
        };
        let activation = |index: usize| NewThreadActivation {
            id: format!("activation-{index}"),
            agent_id: "signal-agent".to_string(),
            context_id: "signal-context".to_string(),
            session_id: "signal-session".to_string(),
            trigger_event_id: format!("signal-event-{index}"),
            trigger_sequence: sequence(&format!("signal-event-{index}")),
            trigger_kind: "chat/tool_output".to_string(),
            parent_activation_id: None,
            root_turn_id: "signal-root".to_string(),
        };

        let first = store
            .claim_thread_signal_batch(signal(1), activation(1), 32)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.trigger_event_id, "signal-event-1");
        let first_signals = store.list_activation_signals(&first.id).await.unwrap();
        assert_eq!(first_signals.len(), 1);
        assert_eq!(first_signals[0].id, "signal-1");
        assert_eq!(first_signals[0].status, ThreadSignalStatus::Claimed);

        assert!(store
            .claim_thread_signal_batch(signal(2), activation(2), 32)
            .await
            .unwrap()
            .is_none());
        assert!(store
            .claim_thread_signal_batch(signal(3), activation(3), 32)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .list_context_thread_signals("signal-context", Some(ThreadSignalStatus::Pending))
                .await
                .unwrap()
                .len(),
            2
        );

        let completed = store
            .update_thread_activation(
                &first.id,
                first.revision,
                ThreadActivationStatus::Succeeded,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        assert!(matches!(completed, ThreadActivationMutation::Updated(_)));
        assert_eq!(
            store.list_activation_signals(&first.id).await.unwrap()[0].status,
            ThreadSignalStatus::Acknowledged
        );

        let batched = store
            .claim_thread_signal_batch(signal(2), activation(2), 32)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(batched.trigger_event_id, "signal-event-2");
        let claimed = store.list_activation_signals(&batched.id).await.unwrap();
        assert_eq!(
            claimed
                .iter()
                .map(|signal| signal.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["signal-event-2", "signal-event-3"]
        );
        assert!(claimed
            .iter()
            .all(|signal| signal.status == ThreadSignalStatus::Claimed));

        let batched = match store
            .update_thread_activation(
                &batched.id,
                batched.revision,
                ThreadActivationStatus::Succeeded,
                None,
                None,
                None,
            )
            .await
            .unwrap()
        {
            ThreadActivationMutation::Updated(updated) => updated,
            other => panic!("unexpected activation mutation: {other:?}"),
        };
        assert!(batched.status.is_terminal());

        for event_id in ["signal-event-4", "signal-event-5"] {
            store
                .append_with_signal_outbox(Event::new(
                    event_id.to_string(),
                    "fixture".to_string(),
                    crate::event::TYPE_TOOL_OUTPUT.to_string(),
                    "chat/tool_output".to_string(),
                    [
                        (
                            "context_id".to_string(),
                            serde_json::json!("signal-context"),
                        ),
                        (
                            "session_id".to_string(),
                            serde_json::json!("signal-session"),
                        ),
                        ("root_turn_id".to_string(), serde_json::json!("signal-root")),
                    ]
                    .into_iter()
                    .collect(),
                ))
                .await
                .unwrap();
        }
        let later = store
            .query(QueryFilter {
                context_id: Some("signal-context".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        let later_sequence = |event_id: &str| {
            later
                .iter()
                .find(|event| event.id == event_id)
                .and_then(|event| event.sequence)
                .unwrap()
        };
        let sequence_4 = later_sequence("signal-event-4");
        let sequence_5 = later_sequence("signal-event-5");
        let left_store = Arc::clone(&store);
        let right_store = Arc::clone(&store);
        let left = tokio::spawn(async move {
            left_store
                .claim_thread_signal_batch(
                    NewThreadSignal {
                        id: "signal-4".to_string(),
                        thread_id: "signal-thread".to_string(),
                        event_id: "signal-event-4".to_string(),
                        sequence: sequence_4,
                        kind: "chat/tool_output".to_string(),
                        parent_activation_id: None,
                    },
                    NewThreadActivation {
                        id: "activation-4".to_string(),
                        agent_id: "signal-agent".to_string(),
                        context_id: "signal-context".to_string(),
                        session_id: "signal-session".to_string(),
                        trigger_event_id: "signal-event-4".to_string(),
                        trigger_sequence: sequence_4,
                        trigger_kind: "chat/tool_output".to_string(),
                        parent_activation_id: None,
                        root_turn_id: "signal-root".to_string(),
                    },
                    1,
                )
                .await
                .unwrap()
        });
        let right = tokio::spawn(async move {
            right_store
                .claim_thread_signal_batch(
                    NewThreadSignal {
                        id: "signal-5".to_string(),
                        thread_id: "signal-thread".to_string(),
                        event_id: "signal-event-5".to_string(),
                        sequence: sequence_5,
                        kind: "chat/tool_output".to_string(),
                        parent_activation_id: None,
                    },
                    NewThreadActivation {
                        id: "activation-5".to_string(),
                        agent_id: "signal-agent".to_string(),
                        context_id: "signal-context".to_string(),
                        session_id: "signal-session".to_string(),
                        trigger_event_id: "signal-event-5".to_string(),
                        trigger_sequence: sequence_5,
                        trigger_kind: "chat/tool_output".to_string(),
                        parent_activation_id: None,
                        root_turn_id: "signal-root".to_string(),
                    },
                    1,
                )
                .await
                .unwrap()
        });
        let (left, right) = tokio::join!(left, right);
        let claimed_count = [left.unwrap(), right.unwrap()]
            .into_iter()
            .filter(Option::is_some)
            .count();
        assert_eq!(claimed_count, 1, "Thread Activation 必须 single-flight");
        assert!(store
            .list_signal_outbox(SignalOutboxStatus::Pending, 16)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .list_signal_outbox(SignalOutboxStatus::Materialized, 16)
                .await
                .unwrap()
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn event_queries_bound_tail_incremental_reads_and_exclusions_in_sql() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let base = Utc::now();
        for (index, topic) in [
            "chat/user_message",
            "chat/context_inspect",
            "chat/tool_output",
            "chat/reply",
        ]
        .into_iter()
        .enumerate()
        {
            let mut event = Event::new(
                format!("bounded-{index}"),
                "fixture".to_string(),
                "fixture".to_string(),
                topic.to_string(),
                [(
                    "session_id".to_string(),
                    serde_json::json!("bounded-session"),
                )]
                .into_iter()
                .collect(),
            );
            event.timestamp = base + chrono::Duration::seconds(index as i64);
            store.append(event).await.unwrap();
        }

        let cognitive = store
            .query(QueryFilter {
                session_id: Some("bounded-session".to_string()),
                topic: Some("chat/*".to_string()),
                excluded_topics: vec!["chat/context_inspect".to_string()],
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(
            cognitive
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec!["bounded-0", "bounded-2", "bounded-3"]
        );

        let tail = store
            .query(QueryFilter {
                session_id: Some("bounded-session".to_string()),
                latest_k: Some(2),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(
            tail.iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec!["bounded-2", "bounded-3"]
        );

        let second_sequence = cognitive[1].sequence.unwrap();
        let incremental = store
            .query(QueryFilter {
                session_id: Some("bounded-session".to_string()),
                after_sequence: Some(second_sequence),
                top_k: Some(1),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(incremental.len(), 1);
        assert_eq!(incremental[0].id, "bounded-3");
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
        let misrouted_result = Event::new(
            "misrouted-result-event".to_string(),
            "sub-agent".to_string(),
            crate::event::TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            [
                ("context_id".to_string(), serde_json::json!("context-child")),
                ("session_id".to_string(), serde_json::json!("session-child")),
            ]
            .into_iter()
            .collect(),
        );
        assert!(store
            .commit_delegation_result("delegation-1", &misrouted_result)
            .await
            .is_err());
        assert_eq!(
            store
                .get_delegation("delegation-1")
                .await
                .unwrap()
                .unwrap()
                .status,
            DelegationStatus::Queued
        );
        assert!(store
            .query(QueryFilter {
                event_id: Some(misrouted_result.id),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty());
        let result_event = Event::new(
            "result-event".to_string(),
            "sub-agent".to_string(),
            crate::event::TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            [
                ("context_id".to_string(), serde_json::json!("context-root")),
                ("session_id".to_string(), serde_json::json!("session-root")),
                (
                    "delegation_id".to_string(),
                    serde_json::json!("delegation-1"),
                ),
            ]
            .into_iter()
            .collect(),
        );
        assert!(store
            .commit_delegation_result("delegation-1", &result_event)
            .await
            .unwrap());
        assert!(!store
            .commit_delegation_result("delegation-1", &result_event)
            .await
            .unwrap());
        let completed = store.get_delegation("delegation-1").await.unwrap().unwrap();
        assert_eq!(completed.result_event_id.as_deref(), Some("result-event"));
        assert!(store
            .list_signal_outbox(SignalOutboxStatus::Pending, 16)
            .await
            .unwrap()
            .iter()
            .any(|entry| entry.event_id == "result-event"));

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
    async fn objective_claim_and_continuation_outbox_commit_atomically() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        store
            .create_agent_bundle(
                NewAgent {
                    id: "objective-outbox-agent".to_string(),
                    title: "Objective Outbox Agent".to_string(),
                    root_context_id: "objective-outbox-context".to_string(),
                },
                NewCognitiveContext {
                    id: "objective-outbox-context".to_string(),
                    agent_id: "objective-outbox-agent".to_string(),
                    title: "Objective Outbox Context".to_string(),
                },
                NewSession {
                    id: "objective-outbox-session".to_string(),
                    agent_id: "objective-outbox-agent".to_string(),
                    context_id: "objective-outbox-context".to_string(),
                    parent_session_id: None,
                    title: "Objective Outbox Session".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .create_objective(NewObjective {
                id: "objective-outbox".to_string(),
                agent_id: "objective-outbox-agent".to_string(),
                context_id: "objective-outbox-context".to_string(),
                coordinator_session_id: "objective-outbox-session".to_string(),
                delivery_session_id: "objective-outbox-session".to_string(),
                parent_objective_id: None,
                source_event_id: "objective-outbox-source".to_string(),
                stated_objective: "prove atomic continuation".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let event = |event_id: &str, evaluation_id: &str| {
            Event::new(
                event_id.to_string(),
                "objective-supervisor".to_string(),
                crate::event::TYPE_TOOL_OUTPUT.to_string(),
                "chat/tool_output".to_string(),
                [
                    (
                        "context_id".to_string(),
                        serde_json::json!("objective-outbox-context"),
                    ),
                    (
                        "session_id".to_string(),
                        serde_json::json!("objective-outbox-session"),
                    ),
                    (
                        "objective_id".to_string(),
                        serde_json::json!("objective-outbox"),
                    ),
                    (
                        "objective_evaluation_id".to_string(),
                        serde_json::json!(evaluation_id),
                    ),
                ]
                .into_iter()
                .collect(),
            )
        };
        let continuation = event("objective-continuation-event", "objective-evaluation");
        let claimed = store
            .claim_objective_evaluation_with_signal(
                "objective-outbox",
                1,
                "objective-evaluation",
                Utc::now() + chrono::Duration::minutes(1),
                &continuation,
            )
            .await
            .unwrap();
        assert!(matches!(
            claimed,
            ObjectiveMutation::Updated(ObjectiveRecord { revision: 2, .. })
        ));
        assert_eq!(
            store
                .list_signal_outbox(SignalOutboxStatus::Pending, 16)
                .await
                .unwrap()[0]
                .event_id,
            continuation.id
        );

        let stale = event("stale-objective-continuation", "stale-evaluation");
        assert!(matches!(
            store
                .claim_objective_evaluation_with_signal(
                    "objective-outbox",
                    1,
                    "stale-evaluation",
                    Utc::now() + chrono::Duration::minutes(1),
                    &stale,
                )
                .await
                .unwrap(),
            ObjectiveMutation::Conflict { .. }
        ));
        assert!(store
            .query(QueryFilter {
                event_id: Some(stale.id),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty());
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
