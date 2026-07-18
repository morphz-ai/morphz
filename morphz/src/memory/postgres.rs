//! PostgreSQL service-store foundation.
//!
//! This module is growing from the Context transaction authority outward:
//! immutable Events, Mind Projection/head CAS, snapshots, Session attention,
//! physical Timer leases and Objective evaluation leases already have complete
//! PostgreSQL semantics. The Runtime does not select this backend yet; it
//! becomes selectable only after the remaining scheduler control-plane traits
//! pass the shared Store conformance suite.

use crate::event::Event;
use crate::memory::{
    EventAppend, EventStore, MindProjectionCommit, MindProjectionRecord, MindProjectionStore,
    MindSnapshotRecord, NewMindProjection, NewObjective, NewRuntimeTimer, ObjectiveMutation,
    ObjectiveRecord, ObjectiveStatus, ObjectiveStore, ObjectiveWaitCondition, QueryFilter,
    RuntimeTimerKind, RuntimeTimerRecord, RuntimeTimerStatus, SessionAttentionUpdate, TimerStore,
};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::postgres::{PgPoolOptions, PgRow};
use sqlx::{PgPool, Postgres, QueryBuilder, Row};

type StoreError = Box<dyn std::error::Error + Send + Sync>;

mod approval;
mod execution;
mod session;

pub struct PostgresStore {
    pool: PgPool,
}

impl PostgresStore {
    pub async fn new(database_url: &str, max_connections: u32) -> Result<Self, StoreError> {
        let pool = PgPoolOptions::new()
            .max_connections(max_connections.max(1))
            .connect(database_url)
            .await?;
        let store = Self { pool };
        store.migrate_supported_capabilities().await?;
        execution::migrate(&store.pool).await?;
        approval::migrate(&store.pool).await?;
        Ok(store)
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    async fn migrate_supported_capabilities(&self) -> Result<(), StoreError> {
        // Phase 4 introduces only tables whose complete atomic semantics are
        // implemented below. Scheduler tables will be added together with
        // their Store traits, not as decorative schema.
        for statement in [
            r#"CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                root_context_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"#,
            r#"CREATE TABLE IF NOT EXISTS cognitive_contexts (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL REFERENCES agents(id),
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                seed_context_id TEXT,
                seed_context_version BIGINT,
                seed_snapshot_hash TEXT,
                seed_projection TEXT
            )"#,
            r#"CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL REFERENCES agents(id),
                context_id TEXT NOT NULL REFERENCES cognitive_contexts(id),
                parent_session_id TEXT,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_activity_at TEXT NOT NULL,
                attention_state TEXT NOT NULL DEFAULT 'active',
                attention_revision BIGINT NOT NULL DEFAULT 0,
                attention_reason TEXT,
                attention_changed_at TEXT,
                attention_event_id TEXT,
                mount_kind TEXT NOT NULL
            )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_sessions_context_activity
               ON sessions(context_id, last_activity_at DESC, id)"#,
            r#"CREATE TABLE IF NOT EXISTS events (
                sequence BIGSERIAL PRIMARY KEY,
                id TEXT NOT NULL UNIQUE,
                timestamp TEXT NOT NULL,
                actor TEXT NOT NULL,
                type TEXT NOT NULL,
                topic TEXT NOT NULL,
                context_id TEXT,
                session_id TEXT,
                payload JSONB NOT NULL
            )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_events_context_sequence
               ON events(context_id, sequence)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_events_session_sequence
               ON events(session_id, sequence)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_events_topic_sequence
               ON events(topic, sequence)"#,
            r#"CREATE TABLE IF NOT EXISTS signal_outbox (
                event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL
            )"#,
            r#"CREATE TABLE IF NOT EXISTS context_heads (
                context_id TEXT PRIMARY KEY REFERENCES cognitive_contexts(id) ON DELETE CASCADE,
                revision BIGINT NOT NULL,
                projection_hash TEXT NOT NULL,
                head_event_id TEXT,
                updated_at TEXT NOT NULL
            )"#,
            r#"CREATE TABLE IF NOT EXISTS mind_projections (
                context_id TEXT PRIMARY KEY REFERENCES cognitive_contexts(id) ON DELETE CASCADE,
                revision BIGINT NOT NULL,
                state_json JSONB NOT NULL,
                state_hash TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"#,
            r#"CREATE TABLE IF NOT EXISTS mind_snapshots (
                id TEXT PRIMARY KEY,
                context_id TEXT NOT NULL REFERENCES cognitive_contexts(id) ON DELETE CASCADE,
                revision BIGINT NOT NULL,
                state_json JSONB NOT NULL,
                state_hash TEXT NOT NULL,
                head_event_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(context_id, revision)
            )"#,
            r#"CREATE TABLE IF NOT EXISTS runtime_timers (
                id TEXT PRIMARY KEY,
                generation BIGINT NOT NULL,
                kind TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                due_at TEXT NOT NULL,
                status TEXT NOT NULL,
                payload_json JSONB NOT NULL,
                claimed_by TEXT,
                claim_expires_at TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                fired_at TEXT
            )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_runtime_timers_due
               ON runtime_timers(status, due_at, claim_expires_at, id)"#,
            r#"CREATE TABLE IF NOT EXISTS objectives (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL REFERENCES agents(id),
                context_id TEXT NOT NULL REFERENCES cognitive_contexts(id),
                coordinator_session_id TEXT NOT NULL REFERENCES sessions(id),
                delivery_session_id TEXT NOT NULL REFERENCES sessions(id),
                parent_objective_id TEXT REFERENCES objectives(id),
                source_event_id TEXT NOT NULL,
                stated_objective TEXT NOT NULL,
                revision BIGINT NOT NULL,
                status TEXT NOT NULL,
                status_reason TEXT,
                wait_condition_json JSONB,
                active_evaluation_id TEXT,
                evaluation_lease_expires_at TEXT,
                continuation_sequence BIGINT NOT NULL DEFAULT 0,
                token_budget BIGINT,
                tokens_used BIGINT NOT NULL DEFAULT 0,
                time_used_seconds BIGINT NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_objectives_context_status_updated
               ON objectives(context_id, status, updated_at DESC)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_objectives_recovery
               ON objectives(status, evaluation_lease_expires_at, updated_at)"#,
        ] {
            sqlx::query(statement).execute(&self.pool).await?;
        }
        Ok(())
    }

    /// Adds the smallest immutable causal Thread/Activation fixture required
    /// by the cross-backend Execution Job conformance suite.
    #[doc(hidden)]
    pub async fn bootstrap_execution_causality_for_conformance(
        &self,
        thread_id: &str,
        activation_id: &str,
    ) -> Result<(), StoreError> {
        execution::bootstrap_causality(
            &self.pool,
            "conformance-agent",
            "conformance-context",
            "conformance-session",
            thread_id,
            activation_id,
        )
        .await
    }
}

fn now_text() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)
}

fn parse_time(value: &str) -> Result<DateTime<Utc>, StoreError> {
    Ok(DateTime::parse_from_rfc3339(value)?.with_timezone(&Utc))
}

fn projection_from_row(row: &PgRow) -> Result<MindProjectionRecord, StoreError> {
    Ok(MindProjectionRecord {
        context_id: row.get("context_id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))
            .map_err(|_| "Mind Projection revision 不能为负数")?,
        state: row.get("state_json"),
        state_hash: row.get("state_hash"),
        head_event_id: row.get("head_event_id"),
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
    })
}

fn timer_from_row(row: &PgRow) -> Result<RuntimeTimerRecord, StoreError> {
    let kind = match row.get::<String, _>("kind").as_str() {
        "schedule" => RuntimeTimerKind::Schedule,
        "objective_wait" => RuntimeTimerKind::ObjectiveWait,
        "objective_lease" => RuntimeTimerKind::ObjectiveLease,
        "background_wake" => RuntimeTimerKind::BackgroundWake,
        "activation_lease" => RuntimeTimerKind::ActivationLease,
        "delivery_flush" => RuntimeTimerKind::DeliveryFlush,
        other => return Err(format!("未知 Runtime Timer kind: {other}").into()),
    };
    let status = match row.get::<String, _>("status").as_str() {
        "pending" => RuntimeTimerStatus::Pending,
        "claimed" => RuntimeTimerStatus::Claimed,
        "fired" => RuntimeTimerStatus::Fired,
        "cancelled" => RuntimeTimerStatus::Cancelled,
        other => return Err(format!("未知 Runtime Timer status: {other}").into()),
    };
    Ok(RuntimeTimerRecord {
        id: row.get("id"),
        generation: u64::try_from(row.get::<i64, _>("generation"))
            .map_err(|_| "Runtime Timer generation 不能为负数")?,
        kind,
        owner_id: row.get("owner_id"),
        due_at: parse_time(&row.get::<String, _>("due_at"))?,
        status,
        payload: row.get("payload_json"),
        claimed_by: row.get("claimed_by"),
        claim_expires_at: row
            .get::<Option<String>, _>("claim_expires_at")
            .as_deref()
            .map(parse_time)
            .transpose()?,
        last_error: row.get("last_error"),
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
        fired_at: row
            .get::<Option<String>, _>("fired_at")
            .as_deref()
            .map(parse_time)
            .transpose()?,
    })
}

fn parse_objective_status(value: &str) -> Result<ObjectiveStatus, StoreError> {
    match value {
        "active" => Ok(ObjectiveStatus::Active),
        "paused" => Ok(ObjectiveStatus::Paused),
        "blocked" => Ok(ObjectiveStatus::Blocked),
        "completed" => Ok(ObjectiveStatus::Completed),
        "cancelled" => Ok(ObjectiveStatus::Cancelled),
        "failed" => Ok(ObjectiveStatus::Failed),
        other => Err(format!("未知 Objective 状态: {other}").into()),
    }
}

fn objective_from_row(row: &PgRow) -> Result<ObjectiveRecord, StoreError> {
    let wait_condition = row
        .get::<Option<JsonValue>, _>("wait_condition_json")
        .map(serde_json::from_value::<ObjectiveWaitCondition>)
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
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        status: parse_objective_status(&row.get::<String, _>("status"))?,
        status_reason: row.get("status_reason"),
        wait_condition,
        active_evaluation_id: row.get("active_evaluation_id"),
        evaluation_lease_expires_at: row
            .get::<Option<String>, _>("evaluation_lease_expires_at")
            .as_deref()
            .map(parse_time)
            .transpose()?,
        continuation_sequence: u64::try_from(row.get::<i64, _>("continuation_sequence"))?,
        token_budget: row
            .get::<Option<i64>, _>("token_budget")
            .map(u64::try_from)
            .transpose()?,
        tokens_used: u64::try_from(row.get::<i64, _>("tokens_used"))?,
        time_used_seconds: u64::try_from(row.get::<i64, _>("time_used_seconds"))?,
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
    })
}

fn validate_stated_objective(stated_objective: &str) -> Result<&str, StoreError> {
    let stated_objective = stated_objective.trim();
    if stated_objective.is_empty() {
        return Err("Objective 目标不能为空".into());
    }
    if stated_objective.chars().count() > 1_000_000 {
        return Err("Objective 目标超过 1,000,000 字符上限".into());
    }
    Ok(stated_objective)
}

async fn get_projection<'e, E>(
    executor: E,
    context_id: &str,
) -> Result<Option<MindProjectionRecord>, StoreError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query(
        r#"SELECT projection.context_id, projection.revision,
                  projection.state_json, projection.state_hash,
                  head.head_event_id, projection.updated_at
           FROM mind_projections projection
           JOIN context_heads head ON head.context_id = projection.context_id
           WHERE projection.context_id = $1
             AND projection.revision = head.revision
             AND projection.state_hash = head.projection_hash"#,
    )
    .bind(context_id)
    .fetch_optional(executor)
    .await?
    .as_ref()
    .map(projection_from_row)
    .transpose()
}

async fn append_event_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    event: &Event,
) -> Result<bool, StoreError> {
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
        r#"INSERT INTO events
           (id, timestamp, actor, type, topic, context_id, session_id, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT(id) DO NOTHING"#,
    )
    .bind(&event.id)
    .bind(&timestamp)
    .bind(&event.actor)
    .bind(&event.event_type)
    .bind(&event.topic)
    .bind(context_id)
    .bind(session_id)
    .bind(JsonValue::Object(event.payload.clone()))
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() == 1 {
        return Ok(true);
    }
    let existing = sqlx::query(
        r#"SELECT timestamp, actor, type, topic, context_id, session_id, payload
           FROM events WHERE id = $1"#,
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
        && existing.get::<JsonValue, _>("payload") == JsonValue::Object(event.payload.clone());
    if !same {
        return Err(format!("Event ID '{}' 已被不同内容占用", event.id).into());
    }
    Ok(false)
}

async fn append_signal_outbox_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    event: &Event,
) -> Result<(), StoreError> {
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
    sqlx::query(
        r#"INSERT INTO signal_outbox (event_id, status, created_at)
           VALUES ($1, 'pending', $2) ON CONFLICT(event_id) DO NOTHING"#,
    )
    .bind(&event.id)
    .bind(
        event
            .timestamp
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_snapshot_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    projection: &NewMindProjection,
    head_event_id: &str,
    created_at: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        r#"INSERT INTO mind_snapshots
           (id, context_id, revision, state_json, state_hash, head_event_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT(context_id, revision) DO UPDATE SET
             id = EXCLUDED.id,
             state_json = EXCLUDED.state_json,
             state_hash = EXCLUDED.state_hash,
             head_event_id = EXCLUDED.head_event_id,
             created_at = EXCLUDED.created_at"#,
    )
    .bind(format!(
        "mind_snapshot_{}_{}",
        projection.context_id, projection.revision
    ))
    .bind(&projection.context_id)
    .bind(i64::try_from(projection.revision)?)
    .bind(&projection.state)
    .bind(&projection.state_hash)
    .bind(head_event_id)
    .bind(created_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn requires_snapshot(event: &Event, revision: u64) -> bool {
    revision.is_multiple_of(64)
        || event
            .payload
            .get("changes")
            .and_then(JsonValue::as_array)
            .is_some_and(|changes| {
                changes.iter().any(|change| {
                    matches!(
                        change.get("operation").and_then(JsonValue::as_str),
                        Some("checkpoint" | "rollback")
                    )
                })
            })
}

#[async_trait::async_trait]
impl EventStore for PostgresStore {
    async fn append(&self, event: Event) -> Result<(), StoreError> {
        self.append_batch(vec![EventAppend {
            event,
            signal_outbox: false,
        }])
        .await
    }

    async fn append_with_signal_outbox(&self, event: Event) -> Result<(), StoreError> {
        self.append_batch(vec![EventAppend {
            event,
            signal_outbox: true,
        }])
        .await
    }

    async fn append_batch(&self, entries: Vec<EventAppend>) -> Result<(), StoreError> {
        if entries.is_empty() {
            return Ok(());
        }
        let mut tx = self.pool.begin().await?;
        for entry in &entries {
            append_event_in_tx(&mut tx, &entry.event).await?;
            if entry.signal_outbox {
                append_signal_outbox_in_tx(&mut tx, &entry.event).await?;
            }
        }
        tx.commit().await?;
        Ok(())
    }

    async fn query(&self, filter: QueryFilter) -> Result<Vec<Event>, StoreError> {
        let mut builder = QueryBuilder::<Postgres>::new(
            "SELECT sequence, id, timestamp, actor, type, topic, payload FROM events WHERE TRUE",
        );
        if let Some(event_id) = filter.event_id {
            builder.push(" AND id = ").push_bind(event_id);
        }
        if let Some(sequence) = filter.sequence {
            builder
                .push(" AND sequence = ")
                .push_bind(i64::try_from(sequence).unwrap_or(i64::MAX));
        }
        if let Some(context_id) = filter.context_id {
            builder.push(" AND context_id = ").push_bind(context_id);
        }
        if let Some(session_id) = filter.session_id {
            builder.push(" AND session_id = ").push_bind(session_id);
        } else if !filter.session_ids.is_empty() {
            builder.push(" AND (");
            if filter.include_context_wide {
                builder.push("session_id IS NULL OR ");
            }
            builder.push("session_id IN (");
            let mut separated = builder.separated(", ");
            for session_id in &filter.session_ids {
                separated.push_bind(session_id);
            }
            builder.push("))");
        } else if filter.include_context_wide {
            builder.push(" AND session_id IS NULL");
        }
        if let Some(after) = filter.after_sequence {
            builder
                .push(" AND sequence > ")
                .push_bind(i64::try_from(after).unwrap_or(i64::MAX));
        }
        if let Some(start) = filter.start_time {
            builder
                .push(" AND timestamp >= ")
                .push_bind(start.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        }
        if let Some(end) = filter.end_time {
            builder
                .push(" AND timestamp <= ")
                .push_bind(end.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
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
            for event_type in &filter.types {
                separated.push_bind(event_type);
            }
            builder.push(")");
        }
        if let Some(topic) = filter.topic {
            if topic != "*" {
                if let Some(prefix) = topic.strip_suffix("/*") {
                    builder
                        .push(" AND topic LIKE ")
                        .push_bind(format!("{prefix}/%"));
                } else {
                    builder.push(" AND topic = ").push_bind(topic);
                }
            }
        }
        for topic in filter.excluded_topics {
            if topic == "*" {
                builder.push(" AND FALSE");
            } else if let Some(prefix) = topic.strip_suffix("/*") {
                builder
                    .push(" AND topic NOT LIKE ")
                    .push_bind(format!("{prefix}/%"));
            } else {
                builder.push(" AND topic != ").push_bind(topic);
            }
        }
        if let Some(search) = filter.search_query {
            builder
                .push(" AND (payload::text ILIKE ")
                .push_bind(format!("%{search}%"))
                .push(" OR topic ILIKE ")
                .push_bind(format!("%{search}%"))
                .push(")");
        }
        let latest_k = filter.latest_k;
        if latest_k.is_some() {
            builder.push(" ORDER BY timestamp DESC, sequence DESC");
        } else {
            builder.push(" ORDER BY timestamp ASC, sequence ASC");
        }
        if let Some(limit) = latest_k.or(filter.top_k) {
            builder
                .push(" LIMIT ")
                .push_bind(i64::try_from(limit).unwrap_or(i64::MAX));
        }
        let rows = builder.build().fetch_all(&self.pool).await?;
        let mut events = rows
            .into_iter()
            .map(|row| {
                let payload = row.get::<JsonValue, _>("payload");
                Ok(Event {
                    id: row.get("id"),
                    sequence: u64::try_from(row.get::<i64, _>("sequence")).ok(),
                    timestamp: parse_time(&row.get::<String, _>("timestamp"))?,
                    actor: row.get("actor"),
                    event_type: row.get("type"),
                    topic: row.get("topic"),
                    payload: payload
                        .as_object()
                        .cloned()
                        .ok_or("PostgreSQL Event payload 必须是 JSON object")?,
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        if latest_k.is_some() {
            events.reverse();
        }
        Ok(events)
    }
}

const OBJECTIVE_SELECT: &str = r#"SELECT id, agent_id, context_id,
    coordinator_session_id, delivery_session_id, parent_objective_id, source_event_id,
    stated_objective, revision, status, status_reason, wait_condition_json, active_evaluation_id,
    evaluation_lease_expires_at, continuation_sequence, token_budget, tokens_used,
    time_used_seconds, created_at, updated_at
    FROM objectives"#;

#[async_trait::async_trait]
impl ObjectiveStore for PostgresStore {
    async fn create_objective(
        &self,
        objective: NewObjective,
    ) -> Result<ObjectiveRecord, StoreError> {
        let stated_objective = validate_stated_objective(&objective.stated_objective)?;
        let context_agent = sqlx::query_scalar::<_, String>(
            "SELECT agent_id FROM cognitive_contexts WHERE id = $1",
        )
        .bind(&objective.context_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| format!("Objective Context '{}' 不存在", objective.context_id))?;
        let coordinator = sqlx::query("SELECT agent_id, context_id FROM sessions WHERE id = $1")
            .bind(&objective.coordinator_session_id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| {
                format!(
                    "Objective 协调 Session '{}' 不存在",
                    objective.coordinator_session_id
                )
            })?;
        let delivery = sqlx::query("SELECT agent_id, context_id FROM sessions WHERE id = $1")
            .bind(&objective.delivery_session_id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| {
                format!(
                    "Objective 交付 Session '{}' 不存在",
                    objective.delivery_session_id
                )
            })?;
        if context_agent != objective.agent_id
            || coordinator.get::<String, _>("agent_id") != objective.agent_id
            || delivery.get::<String, _>("agent_id") != objective.agent_id
            || coordinator.get::<String, _>("context_id") != objective.context_id
            || delivery.get::<String, _>("context_id") != objective.context_id
        {
            return Err("Objective 的 Agent/Context/Session 路由不一致".into());
        }
        if let Some(parent_id) = objective.parent_objective_id.as_deref() {
            let parent_agent =
                sqlx::query_scalar::<_, String>("SELECT agent_id FROM objectives WHERE id = $1")
                    .bind(parent_id)
                    .fetch_optional(&self.pool)
                    .await?
                    .ok_or_else(|| format!("父 Objective '{parent_id}' 不存在"))?;
            if parent_agent != objective.agent_id {
                return Err(format!(
                    "父 Objective '{parent_id}' 属于 Agent '{parent_agent}'，不能挂到 Agent '{}'",
                    objective.agent_id
                )
                .into());
            }
        }
        let now = now_text();
        sqlx::query(
            r#"INSERT INTO objectives
               (id, agent_id, context_id, coordinator_session_id, delivery_session_id,
                parent_objective_id, source_event_id, stated_objective, revision, status,
                wait_condition_json, active_evaluation_id, evaluation_lease_expires_at,
                continuation_sequence, token_budget, tokens_used, time_used_seconds,
                created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'active',
                       NULL, NULL, NULL, 0, $9, 0, 0, $10, $10)"#,
        )
        .bind(&objective.id)
        .bind(&objective.agent_id)
        .bind(&objective.context_id)
        .bind(&objective.coordinator_session_id)
        .bind(&objective.delivery_session_id)
        .bind(&objective.parent_objective_id)
        .bind(&objective.source_event_id)
        .bind(stated_objective)
        .bind(objective.token_budget.map(i64::try_from).transpose()?)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.get_objective(&objective.id)
            .await?
            .ok_or_else(|| "Objective 创建后无法读取".into())
    }

    async fn get_objective(&self, id: &str) -> Result<Option<ObjectiveRecord>, StoreError> {
        sqlx::query(&format!("{OBJECTIVE_SELECT} WHERE id = $1"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(objective_from_row)
            .transpose()
    }

    async fn list_context_objectives(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ObjectiveRecord>, StoreError> {
        let sql = if include_terminal {
            format!("{OBJECTIVE_SELECT} WHERE context_id = $1 ORDER BY updated_at DESC")
        } else {
            format!(
                "{OBJECTIVE_SELECT} WHERE context_id = $1 AND status NOT IN ('completed', 'cancelled', 'failed') ORDER BY updated_at DESC"
            )
        };
        let rows = sqlx::query(&sql)
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(objective_from_row).collect()
    }

    async fn list_recoverable_objectives(&self) -> Result<Vec<ObjectiveRecord>, StoreError> {
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
    ) -> Result<ObjectiveMutation, StoreError> {
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
        let result = sqlx::query(
            r#"UPDATE objectives SET stated_objective = $1,
               revision = revision + 1, updated_at = $2
               WHERE id = $3 AND revision = $4"#,
        )
        .bind(stated_objective)
        .bind(now_text())
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
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
    ) -> Result<ObjectiveMutation, StoreError> {
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
        let wait_condition = wait_condition.map(serde_json::to_value).transpose()?;
        let result = sqlx::query(
            r#"UPDATE objectives
               SET status = $1, status_reason = $2, wait_condition_json = $3,
                   revision = revision + 1, updated_at = $4
               WHERE id = $5 AND revision = $6"#,
        )
        .bind(status.as_str())
        .bind(reason)
        .bind(wait_condition)
        .bind(now_text())
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
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
    ) -> Result<ObjectiveMutation, StoreError> {
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
        let now = now_text();
        let result = sqlx::query(
            r#"UPDATE objectives
               SET active_evaluation_id = $1, evaluation_lease_expires_at = $2,
                   continuation_sequence = continuation_sequence + 1,
                   revision = revision + 1, updated_at = $3
               WHERE id = $4 AND revision = $5 AND status = 'active'
                 AND wait_condition_json IS NULL
                 AND (active_evaluation_id IS NULL OR evaluation_lease_expires_at <= $3)"#,
        )
        .bind(evaluation_id)
        .bind(lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .bind(&now)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
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
    ) -> Result<ObjectiveMutation, StoreError> {
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
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            r#"UPDATE objectives
               SET active_evaluation_id = $1, evaluation_lease_expires_at = $2,
                   continuation_sequence = continuation_sequence + 1,
                   revision = revision + 1, updated_at = $3
               WHERE id = $4 AND revision = $5 AND status = 'active'
                 AND wait_condition_json IS NULL
                 AND (active_evaluation_id IS NULL OR evaluation_lease_expires_at <= $3)"#,
        )
        .bind(evaluation_id)
        .bind(lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .bind(&now)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(match self.get_objective(id).await? {
                Some(current) => ObjectiveMutation::Conflict { current },
                None => ObjectiveMutation::NotFound,
            });
        }
        append_event_in_tx(&mut tx, event).await?;
        append_signal_outbox_in_tx(&mut tx, event).await?;
        tx.commit().await?;
        Ok(ObjectiveMutation::Updated(
            self.get_objective(id)
                .await?
                .ok_or("Objective Evaluation + Signal 提交后无法读取")?,
        ))
    }

    async fn record_objective_evaluation_usage(
        &self,
        id: &str,
        evaluation_id: &str,
        prompt_tokens_used: u64,
    ) -> Result<ObjectiveMutation, StoreError> {
        let result = sqlx::query(
            r#"UPDATE objectives
               SET tokens_used = tokens_used + $1, updated_at = $2
               WHERE id = $3 AND status = 'active' AND active_evaluation_id = $4"#,
        )
        .bind(i64::try_from(prompt_tokens_used)?)
        .bind(now_text())
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

    async fn finish_objective_evaluation(
        &self,
        id: &str,
        evaluation_id: &str,
        tokens_used: u64,
        time_used_seconds: u64,
    ) -> Result<ObjectiveMutation, StoreError> {
        let Some(current) = self.get_objective(id).await? else {
            return Ok(ObjectiveMutation::NotFound);
        };
        if current.active_evaluation_id.as_deref() != Some(evaluation_id) {
            return Ok(ObjectiveMutation::Conflict { current });
        }
        let result = sqlx::query(
            r#"UPDATE objectives
               SET active_evaluation_id = NULL, evaluation_lease_expires_at = NULL,
                   tokens_used = tokens_used + $1,
                   time_used_seconds = time_used_seconds + $2,
                   revision = revision + 1, updated_at = $3
               WHERE id = $4 AND revision = $5 AND active_evaluation_id = $6"#,
        )
        .bind(i64::try_from(tokens_used)?)
        .bind(i64::try_from(time_used_seconds)?)
        .bind(now_text())
        .bind(id)
        .bind(i64::try_from(current.revision)?)
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
}

#[async_trait::async_trait]
impl TimerStore for PostgresStore {
    async fn upsert_runtime_timer(
        &self,
        timer: NewRuntimeTimer,
    ) -> Result<RuntimeTimerRecord, StoreError> {
        if timer.id.trim().is_empty() || timer.owner_id.trim().is_empty() {
            return Err("Runtime Timer id/owner_id 不能为空".into());
        }
        let now = now_text();
        sqlx::query(
            r#"INSERT INTO runtime_timers
               (id, generation, kind, owner_id, due_at, status, payload_json,
                created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $7)
               ON CONFLICT(id) DO UPDATE SET
                 generation = EXCLUDED.generation,
                 kind = EXCLUDED.kind,
                 owner_id = EXCLUDED.owner_id,
                 due_at = EXCLUDED.due_at,
                 status = 'pending',
                 payload_json = EXCLUDED.payload_json,
                 claimed_by = NULL,
                 claim_expires_at = NULL,
                 last_error = NULL,
                 updated_at = EXCLUDED.updated_at,
                 fired_at = NULL
               WHERE EXCLUDED.generation > runtime_timers.generation
                  OR (EXCLUDED.generation = runtime_timers.generation
                      AND runtime_timers.status = 'cancelled')"#,
        )
        .bind(&timer.id)
        .bind(i64::try_from(timer.generation)?)
        .bind(timer.kind.as_str())
        .bind(&timer.owner_id)
        .bind(
            timer
                .due_at
                .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
        )
        .bind(&timer.payload)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.get_runtime_timer(&timer.id)
            .await?
            .ok_or_else(|| format!("Runtime Timer '{}' upsert 后不存在", timer.id).into())
    }

    async fn get_runtime_timer(&self, id: &str) -> Result<Option<RuntimeTimerRecord>, StoreError> {
        sqlx::query("SELECT * FROM runtime_timers WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(timer_from_row)
            .transpose()
    }

    async fn list_runtime_timers(
        &self,
        status: Option<RuntimeTimerStatus>,
    ) -> Result<Vec<RuntimeTimerRecord>, StoreError> {
        let rows = if let Some(status) = status {
            sqlx::query("SELECT * FROM runtime_timers WHERE status = $1 ORDER BY due_at, id")
                .bind(status.as_str())
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query("SELECT * FROM runtime_timers ORDER BY due_at, id")
                .fetch_all(&self.pool)
                .await?
        };
        rows.iter().map(timer_from_row).collect()
    }

    async fn next_runtime_timer_due_at(&self) -> Result<Option<DateTime<Utc>>, StoreError> {
        let due_at = sqlx::query_scalar::<_, Option<String>>(
            r#"SELECT MIN(CASE WHEN status = 'pending' THEN due_at ELSE claim_expires_at END)
               FROM runtime_timers
               WHERE status = 'pending'
                  OR (status = 'claimed' AND claim_expires_at IS NOT NULL)"#,
        )
        .fetch_one(&self.pool)
        .await?;
        due_at.as_deref().map(parse_time).transpose()
    }

    async fn claim_due_runtime_timers(
        &self,
        now: DateTime<Utc>,
        claim_token: &str,
        claim_expires_at: DateTime<Utc>,
        limit: usize,
    ) -> Result<Vec<RuntimeTimerRecord>, StoreError> {
        if claim_token.trim().is_empty() {
            return Err("Runtime Timer claim token 不能为空".into());
        }
        if limit == 0 {
            return Ok(Vec::new());
        }
        let now = now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let expires = claim_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        // SKIP LOCKED is the cross-worker ownership boundary. Competing
        // workers never wait behind or double-claim the same timer row.
        let rows = sqlx::query(
            r#"WITH due AS (
                 SELECT id FROM runtime_timers
                 WHERE (status = 'pending' AND due_at <= $1)
                    OR (status = 'claimed' AND claim_expires_at <= $1)
                 ORDER BY CASE WHEN status = 'pending' THEN due_at ELSE claim_expires_at END, id
                 FOR UPDATE SKIP LOCKED
                 LIMIT $2
               )
               UPDATE runtime_timers timer
               SET status = 'claimed', claimed_by = $3,
                   claim_expires_at = $4, updated_at = $1
               FROM due
               WHERE timer.id = due.id
               RETURNING timer.*"#,
        )
        .bind(&now)
        .bind(i64::try_from(limit)?)
        .bind(claim_token)
        .bind(&expires)
        .fetch_all(&self.pool)
        .await?;
        let mut records = rows
            .iter()
            .map(timer_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        records.sort_by(|left, right| {
            left.due_at
                .cmp(&right.due_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(records)
    }

    async fn complete_runtime_timer(
        &self,
        id: &str,
        generation: u64,
        claim_token: &str,
    ) -> Result<bool, StoreError> {
        let now = now_text();
        let result = sqlx::query(
            r#"UPDATE runtime_timers
               SET status = 'fired', claimed_by = NULL, claim_expires_at = NULL,
                   last_error = NULL, updated_at = $1, fired_at = $1
               WHERE id = $2 AND generation = $3
                 AND status = 'claimed' AND claimed_by = $4"#,
        )
        .bind(&now)
        .bind(id)
        .bind(i64::try_from(generation)?)
        .bind(claim_token)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    async fn retry_runtime_timer(
        &self,
        id: &str,
        generation: u64,
        claim_token: &str,
        due_at: DateTime<Utc>,
        error: Option<&str>,
    ) -> Result<bool, StoreError> {
        let error = error.map(|value| value.chars().take(10_000).collect::<String>());
        let result = sqlx::query(
            r#"UPDATE runtime_timers
               SET status = 'pending', due_at = $1, claimed_by = NULL,
                   claim_expires_at = NULL, last_error = $2, updated_at = $3
               WHERE id = $4 AND generation = $5
                 AND status = 'claimed' AND claimed_by = $6"#,
        )
        .bind(due_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .bind(error)
        .bind(now_text())
        .bind(id)
        .bind(i64::try_from(generation)?)
        .bind(claim_token)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    async fn cancel_runtime_timer(&self, id: &str) -> Result<bool, StoreError> {
        let result = sqlx::query(
            r#"UPDATE runtime_timers
               SET status = 'cancelled', claimed_by = NULL,
                   claim_expires_at = NULL, updated_at = $1
               WHERE id = $2 AND status = 'pending'"#,
        )
        .bind(now_text())
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }
}

#[async_trait::async_trait]
impl MindProjectionStore for PostgresStore {
    async fn get_mind_projection(
        &self,
        context_id: &str,
    ) -> Result<Option<MindProjectionRecord>, StoreError> {
        let projection = get_projection(&self.pool, context_id).await?;
        if projection.is_none() {
            let row = sqlx::query(
                r#"SELECT EXISTS(SELECT 1 FROM context_heads WHERE context_id = $1) AS head,
                          EXISTS(SELECT 1 FROM mind_projections WHERE context_id = $1) AS projection"#,
            )
            .bind(context_id)
            .fetch_one(&self.pool)
            .await?;
            if row.get::<bool, _>("head") || row.get::<bool, _>("projection") {
                return Err(format!(
                    "Context '{context_id}' 的 Mind Projection 不完整或 head/hash/revision 不一致"
                )
                .into());
            }
        }
        Ok(projection)
    }

    async fn get_latest_mind_snapshot(
        &self,
        context_id: &str,
    ) -> Result<Option<MindSnapshotRecord>, StoreError> {
        let row = sqlx::query(
            r#"SELECT id, context_id, revision, state_json, state_hash,
                      head_event_id, created_at
               FROM mind_snapshots WHERE context_id = $1
               ORDER BY revision DESC LIMIT 1"#,
        )
        .bind(context_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            Ok(MindSnapshotRecord {
                id: row.get("id"),
                context_id: row.get("context_id"),
                revision: u64::try_from(row.get::<i64, _>("revision"))
                    .map_err(|_| "Mind Snapshot revision 不能为负数")?,
                state: row.get("state_json"),
                state_hash: row.get("state_hash"),
                head_event_id: row.get("head_event_id"),
                created_at: parse_time(&row.get::<String, _>("created_at"))?,
            })
        })
        .transpose()
    }

    async fn initialize_mind_projection(
        &self,
        projection: NewMindProjection,
    ) -> Result<MindProjectionRecord, StoreError> {
        let revision = i64::try_from(projection.revision)?;
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        let context = sqlx::query("SELECT id FROM cognitive_contexts WHERE id = $1 FOR UPDATE")
            .bind(&projection.context_id)
            .fetch_optional(&mut *tx)
            .await?;
        if context.is_none() {
            return Err(format!("Context '{}' 不存在", projection.context_id).into());
        }
        let counts = sqlx::query(
            r#"SELECT (SELECT COUNT(*) FROM context_heads WHERE context_id = $1) AS heads,
                      (SELECT COUNT(*) FROM mind_projections WHERE context_id = $1) AS projections"#,
        )
        .bind(&projection.context_id)
        .fetch_one(&mut *tx)
        .await?;
        let heads = counts.get::<i64, _>("heads");
        let projections = counts.get::<i64, _>("projections");
        if heads != projections {
            return Err(format!(
                "Context '{}' 的 Mind Projection 仅存在部分记录，拒绝自动修补",
                projection.context_id
            )
            .into());
        }
        if heads == 0 {
            sqlx::query(
                r#"INSERT INTO context_heads
                   (context_id, revision, projection_hash, head_event_id, updated_at)
                   VALUES ($1, $2, $3, $4, $5)"#,
            )
            .bind(&projection.context_id)
            .bind(revision)
            .bind(&projection.state_hash)
            .bind(&projection.head_event_id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                r#"INSERT INTO mind_projections
                   (context_id, revision, state_json, state_hash, updated_at)
                   VALUES ($1, $2, $3, $4, $5)"#,
            )
            .bind(&projection.context_id)
            .bind(revision)
            .bind(&projection.state)
            .bind(&projection.state_hash)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        let installed = get_projection(&mut *tx, &projection.context_id)
            .await?
            .ok_or("安装后的 PostgreSQL Mind Projection 不完整")?;
        tx.commit().await?;
        Ok(installed)
    }

    async fn commit_mind_projection_transaction(
        &self,
        event: &Event,
        attention_updates: &[SessionAttentionUpdate],
        expected_revision: u64,
        next_projection: NewMindProjection,
    ) -> Result<MindProjectionCommit, StoreError> {
        if next_projection.head_event_id.as_deref() != Some(event.id.as_str()) {
            return Err(
                "Mind Projection head_event_id 必须指向本次 Context transaction Event".into(),
            );
        }
        if next_projection.revision != expected_revision.saturating_add(1) {
            return Err("Mind Projection 下一 revision 必须等于 expected_revision + 1".into());
        }
        if event.payload.get("context_id").and_then(JsonValue::as_str)
            != Some(next_projection.context_id.as_str())
        {
            return Err("Context transaction Event 与 Mind Projection 的 context_id 不一致".into());
        }
        let expected = i64::try_from(expected_revision)?;
        let next = i64::try_from(next_projection.revision)?;
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        let head = sqlx::query(
            r#"UPDATE context_heads SET revision = $1, projection_hash = $2,
                      head_event_id = $3, updated_at = $4
               WHERE context_id = $5 AND revision = $6"#,
        )
        .bind(next)
        .bind(&next_projection.state_hash)
        .bind(&event.id)
        .bind(&now)
        .bind(&next_projection.context_id)
        .bind(expected)
        .execute(&mut *tx)
        .await?;
        if head.rows_affected() != 1 {
            tx.rollback().await?;
            let current = sqlx::query_scalar::<_, i64>(
                "SELECT revision FROM context_heads WHERE context_id = $1",
            )
            .bind(&next_projection.context_id)
            .fetch_optional(&self.pool)
            .await?
            .map(u64::try_from)
            .transpose()?;
            return Ok(MindProjectionCommit::Conflict {
                current_revision: current,
            });
        }
        let materialized = sqlx::query(
            r#"UPDATE mind_projections SET revision = $1, state_json = $2,
                      state_hash = $3, updated_at = $4
               WHERE context_id = $5 AND revision = $6"#,
        )
        .bind(next)
        .bind(&next_projection.state)
        .bind(&next_projection.state_hash)
        .bind(&now)
        .bind(&next_projection.context_id)
        .bind(expected)
        .execute(&mut *tx)
        .await?;
        if materialized.rows_affected() != 1 {
            return Err(format!(
                "Context '{}' 的 Mind Projection revision 与 head 不一致",
                next_projection.context_id
            )
            .into());
        }
        for update in attention_updates {
            let changed = sqlx::query(
                r#"UPDATE sessions SET attention_state = $1, attention_revision = attention_revision + 1,
                          attention_reason = $2, attention_changed_at = $3, attention_event_id = $4,
                          updated_at = $3
                   WHERE id = $5 AND context_id = $6 AND attention_revision = $7"#,
            )
            .bind(update.state.as_str())
            .bind(&update.reason)
            .bind(update.changed_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
            .bind(&update.event_id)
            .bind(&update.session_id)
            .bind(&update.context_id)
            .bind(i64::try_from(update.expected_revision)?)
            .execute(&mut *tx)
            .await?;
            if changed.rows_affected() != 1 {
                return Err(format!(
                    "Session '{}' attention revision 冲突或 Context 不匹配",
                    update.session_id
                )
                .into());
            }
        }
        append_event_in_tx(&mut tx, event).await?;
        if requires_snapshot(event, next_projection.revision) {
            insert_snapshot_in_tx(&mut tx, &next_projection, &event.id, &now).await?;
        }
        let committed = get_projection(&mut *tx, &next_projection.context_id)
            .await?
            .ok_or("提交后 PostgreSQL Mind Projection 不完整")?;
        tx.commit().await?;
        Ok(MindProjectionCommit::Committed {
            projection: committed,
        })
    }

    async fn commit_mind_seed_projection(
        &self,
        event: &Event,
        source_context_id: &str,
        source_version: u64,
        snapshot_hash: &str,
        projection_kind: &str,
        next_projection: NewMindProjection,
    ) -> Result<MindProjectionCommit, StoreError> {
        if next_projection.revision != 0
            || next_projection.head_event_id.as_deref() != Some(event.id.as_str())
        {
            return Err("Seed Mind Projection revision/head_event_id 非法".into());
        }
        if event.payload.get("context_id").and_then(JsonValue::as_str)
            != Some(next_projection.context_id.as_str())
        {
            return Err("Seed Event 与 Mind Projection 的 context_id 不一致".into());
        }
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        let head = sqlx::query(
            r#"UPDATE context_heads SET projection_hash = $1, head_event_id = $2, updated_at = $3
               WHERE context_id = $4 AND revision = 0 AND head_event_id IS NULL"#,
        )
        .bind(&next_projection.state_hash)
        .bind(&event.id)
        .bind(&now)
        .bind(&next_projection.context_id)
        .execute(&mut *tx)
        .await?;
        if head.rows_affected() != 1 {
            tx.rollback().await?;
            let current = sqlx::query_scalar::<_, i64>(
                "SELECT revision FROM context_heads WHERE context_id = $1",
            )
            .bind(&next_projection.context_id)
            .fetch_optional(&self.pool)
            .await?
            .map(u64::try_from)
            .transpose()?;
            return Ok(MindProjectionCommit::Conflict {
                current_revision: current,
            });
        }
        let projection = sqlx::query(
            r#"UPDATE mind_projections SET state_json = $1, state_hash = $2, updated_at = $3
               WHERE context_id = $4 AND revision = 0"#,
        )
        .bind(&next_projection.state)
        .bind(&next_projection.state_hash)
        .bind(&now)
        .bind(&next_projection.context_id)
        .execute(&mut *tx)
        .await?;
        if projection.rows_affected() != 1 {
            return Err("Seed Mind Projection 与 Context head 不一致".into());
        }
        let context = sqlx::query(
            r#"UPDATE cognitive_contexts SET seed_context_id = $1, seed_context_version = $2,
                      seed_snapshot_hash = $3, seed_projection = $4, updated_at = $5
               WHERE id = $6 AND seed_context_id IS NULL"#,
        )
        .bind(source_context_id)
        .bind(i64::try_from(source_version)?)
        .bind(snapshot_hash)
        .bind(projection_kind)
        .bind(&now)
        .bind(&next_projection.context_id)
        .execute(&mut *tx)
        .await?;
        if context.rows_affected() != 1 {
            return Err("目标 Context 已存在 seed provenance，拒绝覆盖".into());
        }
        append_event_in_tx(&mut tx, event).await?;
        insert_snapshot_in_tx(&mut tx, &next_projection, &event.id, &now).await?;
        let committed = get_projection(&mut *tx, &next_projection.context_id)
            .await?
            .ok_or("Seed 提交后 PostgreSQL Mind Projection 不完整")?;
        tx.commit().await?;
        Ok(MindProjectionCommit::Committed {
            projection: committed,
        })
    }
}
