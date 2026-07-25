//! PostgreSQL service-store foundation.
//!
//! This module is growing from the Context transaction authority outward:
//! immutable Events, Mind Projection/head CAS, snapshots, Session attention,
//! physical Timer leases, scheduler control-plane state and Objective
//! evaluation leases have complete PostgreSQL semantics. Selection remains an
//! explicit product configuration; merely defining a PostgreSQL URL never
//! changes the active backend.

use crate::event::Event;
use crate::memory::{
    causal_payload_string, AttentionAcknowledgementRecord, CognitiveClockStore,
    ContextCognitiveClock, EventAppend, EventStore, MindProjectionCommit, MindProjectionRecord,
    MindProjectionStore, MindSnapshotRecord, NewMindProjection, NewObjective, NewRuntimeTimer,
    ObjectiveMutation, ObjectiveRecord, ObjectiveStatus, ObjectiveStore, ObjectiveWaitCondition,
    QueryFilter, RecallDocument, RecallDocumentKind, RecallIndexAudit, RecallIndexCapability,
    RecallProjectionBatch, RecallProjectionStore, RecallSearchHit, RuntimeTimerKind,
    RuntimeTimerRecord, RuntimeTimerStatus, SessionAttentionUpdate, SessionProjectionMutation,
    SessionProjectionStore, TimerStore,
};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::postgres::{PgConnection, PgPoolOptions, PgRow};
use sqlx::{Connection, PgPool, Postgres, QueryBuilder, Row};
use std::future::Future;

type StoreError = Box<dyn std::error::Error + Send + Sync>;

// Stable database-scoped lock for schema installation. It is held on a
// dedicated connection so a Store configured with a one-connection pool can
// still migrate without deadlocking itself.
const SCHEMA_MIGRATION_LOCK: i64 = 0x4D4F_5250_485A_0001_i64;

mod action_group;
mod activation;
mod approval;
mod delegation;
mod delivery;
mod edge;
mod execution;
mod plan_execution;
mod schedule;
mod session;
mod target;
mod thread;

pub struct PostgresStore {
    pool: PgPool,
}

impl PostgresStore {
    pub async fn new(database_url: &str, max_connections: u32) -> Result<Self, StoreError> {
        let mut migration_lock = PgConnection::connect(database_url).await?;
        sqlx::query("SELECT pg_advisory_lock($1)")
            .bind(SCHEMA_MIGRATION_LOCK)
            .execute(&mut migration_lock)
            .await?;
        let pool = PgPoolOptions::new()
            .max_connections(max_connections.max(1))
            .connect(database_url)
            .await?;
        let store = Self { pool };
        let migrations = async {
            store.ensure_schema_migrations().await?;
            store
                .run_versioned_migration(
                    "20260718_01_supported_capabilities",
                    store.migrate_supported_capabilities(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260719_01_session_projections",
                    store.migrate_session_projections(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260720_01_recall_projection",
                    store.migrate_recall_projection(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260723_01_recall_outbox_attention_projection",
                    store.migrate_recall_outbox_attention_projection(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260720_02_cognitive_clock",
                    store.migrate_cognitive_clock(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260718_02_execution_jobs",
                    execution::migrate(&store.pool),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260721_01_execution_targets",
                    target::migrate(&store.pool),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260721_04_execution_target_authorizations",
                    target::migrate(&store.pool),
                )
                .await?;
            store
                .run_versioned_migration("20260721_02_edge_execution", edge::migrate(&store.pool))
                .await?;
            store
                .run_versioned_migration(
                    "20260721_03_edge_device_identity",
                    edge::migrate(&store.pool),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260719_02_action_groups",
                    action_group::migrate(&store.pool),
                )
                .await?;
            store
                .run_versioned_migration("20260718_03_approvals", approval::migrate(&store.pool))
                .await?;
            store
                .run_versioned_migration("20260718_04_threads", thread::migrate(&store.pool))
                .await?;
            store
                .run_versioned_migration(
                    "20260718_05_activations",
                    activation::migrate(&store.pool),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260726_01_plan_executions",
                    plan_execution::migrate(&store.pool),
                )
                .await?;
            store
                .run_versioned_migration("20260718_06_schedules", schedule::migrate(&store.pool))
                .await?;
            store
                .run_versioned_migration("20260718_07_delivery", delivery::migrate(&store.pool))
                .await?;
            store
                .run_versioned_migration(
                    "20260718_08_delegations",
                    delegation::migrate(&store.pool),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260720_03_principal_identity",
                    store.migrate_principal_identity(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260724_01_event_causal_projection",
                    store.migrate_event_causal_projection(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260725_01_recall_segmented_index",
                    store.resegment_recall_documents(),
                )
                .await?;
            // Index creation is retried outside the versioned migration so a
            // deployment that failed to build it once recovers on a later
            // start without editing migration history.
            store.ensure_recall_search_acceleration().await?;
            Ok::<(), StoreError>(())
        }
        .await;
        let unlock = sqlx::query("SELECT pg_advisory_unlock($1)")
            .bind(SCHEMA_MIGRATION_LOCK)
            .execute(&mut migration_lock)
            .await;
        migrations?;
        unlock?;
        Ok(store)
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    async fn ensure_schema_migrations(&self) -> Result<(), StoreError> {
        sqlx::query(
            r#"CREATE TABLE IF NOT EXISTS schema_migrations (
                version TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL
            )"#,
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn run_versioned_migration<F>(
        &self,
        version: &str,
        migration: F,
    ) -> Result<(), StoreError>
    where
        F: Future<Output = Result<(), StoreError>>,
    {
        if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM schema_migrations WHERE version = $1")
            .bind(version)
            .fetch_one(&self.pool)
            .await?
            > 0
        {
            return Ok(());
        }
        migration.await?;
        sqlx::query(
            "INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2) ON CONFLICT(version) DO NOTHING",
        )
        .bind(version)
        .bind(now_text())
        .execute(&self.pool)
        .await?;
        Ok(())
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
            r#"CREATE TABLE IF NOT EXISTS principals (
                id TEXT PRIMARY KEY,
                provider_id TEXT NOT NULL,
                assurance TEXT NOT NULL,
                display_name TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"#,
            r#"CREATE TABLE IF NOT EXISTS session_principal_bindings (
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
                bound_at TEXT NOT NULL,
                unbound_at TEXT,
                PRIMARY KEY(session_id, principal_id)
            )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_session_principal_bindings_principal
               ON session_principal_bindings(principal_id, unbound_at, session_id)"#,
            r#"CREATE TABLE IF NOT EXISTS events (
                sequence BIGSERIAL PRIMARY KEY,
                id TEXT NOT NULL UNIQUE,
                timestamp TEXT NOT NULL,
                actor TEXT NOT NULL,
                type TEXT NOT NULL,
                topic TEXT NOT NULL,
                context_id TEXT,
                session_id TEXT,
                thread_id TEXT,
                activation_id TEXT,
                root_turn_id TEXT,
                objective_id TEXT,
                payload JSONB NOT NULL
            )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_events_context_sequence
               ON events(context_id, sequence)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_events_session_sequence
               ON events(session_id, sequence)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_events_topic_sequence
               ON events(topic, sequence)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_events_context_topic_time
               ON events(context_id, topic, timestamp, sequence)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_events_context_session_topic_thread_time
               ON events(context_id, session_id, topic, thread_id, timestamp, sequence)"#,
            r#"CREATE TABLE IF NOT EXISTS event_causal_projection_backfills (
                context_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                topic TEXT NOT NULL,
                completed_at TEXT NOT NULL,
                PRIMARY KEY(context_id, session_id, thread_id, topic)
            )"#,
            r#"CREATE TABLE IF NOT EXISTS session_projections (
                event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
                context_id TEXT NOT NULL,
                session_id TEXT
            )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_session_projections_context_session
               ON session_projections(context_id, session_id, event_id)"#,
            r#"CREATE TABLE IF NOT EXISTS schema_migrations (
                version TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL
            )"#,
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
                initiating_principal_id TEXT,
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
            r#"ALTER TABLE objectives
               ADD COLUMN IF NOT EXISTS initiating_principal_id TEXT"#,
        ] {
            sqlx::query(statement).execute(&self.pool).await?;
        }
        Ok(())
    }

    async fn migrate_recall_projection(&self) -> Result<(), StoreError> {
        sqlx::query(
            r#"CREATE TABLE IF NOT EXISTS recall_documents (
                 context_id TEXT NOT NULL REFERENCES cognitive_contexts(id) ON DELETE CASCADE,
                 document_kind TEXT NOT NULL CHECK(document_kind IN ('event', 'frame')),
                 document_id TEXT NOT NULL,
                 revision BIGINT NOT NULL CHECK(revision >= 0),
                 searchable_text TEXT NOT NULL,
                 preview TEXT NOT NULL,
                 retired BOOLEAN NOT NULL,
                 updated_sequence BIGINT NOT NULL CHECK(updated_sequence >= 0),
                 state_hash TEXT NOT NULL,
                 PRIMARY KEY(context_id, document_kind, document_id)
               )"#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"CREATE INDEX IF NOT EXISTS idx_pg_recall_documents_context_updated
               ON recall_documents(context_id, updated_sequence DESC, document_id)"#,
        )
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn migrate_recall_outbox_attention_projection(&self) -> Result<(), StoreError> {
        for statement in [
            r#"CREATE INDEX IF NOT EXISTS idx_pg_events_context_topic_time
               ON events(context_id, topic, timestamp, sequence)"#,
            r#"CREATE TABLE IF NOT EXISTS recall_projection_outbox (
                 context_id TEXT NOT NULL,
                 document_kind TEXT NOT NULL CHECK(document_kind IN ('event', 'frame')),
                 document_id TEXT NOT NULL,
                 generation BIGINT NOT NULL CHECK(generation > 0),
                 document_json JSONB NOT NULL,
                 status TEXT NOT NULL CHECK(status IN ('pending', 'processing')),
                 attempts BIGINT NOT NULL DEFAULT 0 CHECK(attempts >= 0),
                 available_at TEXT NOT NULL,
                 claimed_by TEXT,
                 claim_expires_at TEXT,
                 last_error TEXT,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 PRIMARY KEY(context_id, document_kind, document_id)
               )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_recall_outbox_ready
               ON recall_projection_outbox(status, available_at, claim_expires_at, updated_at)"#,
            r#"CREATE TABLE IF NOT EXISTS attention_acknowledgements (
                 context_id TEXT NOT NULL,
                 key TEXT NOT NULL,
                 event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
                 event_sequence BIGINT NOT NULL,
                 source_kind TEXT NOT NULL,
                 source_id TEXT NOT NULL,
                 source_revision BIGINT NOT NULL CHECK(source_revision >= 0),
                 acknowledged_by TEXT NOT NULL,
                 rationale TEXT,
                 acknowledged_at TEXT NOT NULL,
                 PRIMARY KEY(context_id, key)
               )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_attention_ack_context_time
               ON attention_acknowledgements(context_id, acknowledged_at DESC, event_sequence DESC)"#,
            r#"INSERT INTO attention_acknowledgements
               (context_id, key, event_id, event_sequence, source_kind, source_id,
                source_revision, acknowledged_by, rationale, acknowledged_at)
               SELECT context_id, payload->>'key', id, sequence,
                      payload->>'source_kind', payload->>'source_id',
                      (payload->>'source_revision')::BIGINT,
                      payload->>'acknowledged_by', payload->>'rationale', timestamp
               FROM events
               WHERE topic = 'runtime/attention_acknowledged'
                 AND context_id IS NOT NULL AND payload->>'key' IS NOT NULL
               ON CONFLICT(context_id, key) DO UPDATE SET
                 event_id = EXCLUDED.event_id,
                 event_sequence = EXCLUDED.event_sequence,
                 source_kind = EXCLUDED.source_kind,
                 source_id = EXCLUDED.source_id,
                 source_revision = EXCLUDED.source_revision,
                 acknowledged_by = EXCLUDED.acknowledged_by,
                 rationale = EXCLUDED.rationale,
                 acknowledged_at = EXCLUDED.acknowledged_at
               WHERE EXCLUDED.event_sequence > attention_acknowledgements.event_sequence"#,
        ] {
            sqlx::query(statement).execute(&self.pool).await?;
        }
        Ok(())
    }

    async fn migrate_cognitive_clock(&self) -> Result<(), StoreError> {
        sqlx::query(
            r#"CREATE TABLE IF NOT EXISTS context_cognitive_clocks (
                 context_id TEXT PRIMARY KEY REFERENCES cognitive_contexts(id) ON DELETE CASCADE,
                 tick BIGINT NOT NULL CHECK(tick >= 0),
                 last_signal_batch_id TEXT UNIQUE,
                 revision BIGINT NOT NULL CHECK(revision >= 0)
               )"#,
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Add the Principal directory and causal identity columns in a new
    /// versioned migration. Several owning tables predate identity support;
    /// editing their original migrations would not upgrade an existing
    /// PostgreSQL deployment whose migration versions are already recorded.
    async fn migrate_principal_identity(&self) -> Result<(), StoreError> {
        for statement in [
            r#"CREATE TABLE IF NOT EXISTS principals (
                 id TEXT PRIMARY KEY,
                 provider_id TEXT NOT NULL,
                 assurance TEXT NOT NULL,
                 display_name TEXT,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
               )"#,
            r#"CREATE TABLE IF NOT EXISTS session_principal_bindings (
                 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                 principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
                 bound_at TEXT NOT NULL,
                 unbound_at TEXT,
                 PRIMARY KEY(session_id, principal_id)
               )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_session_principal_bindings_principal
               ON session_principal_bindings(principal_id, unbound_at, session_id)"#,
            r#"ALTER TABLE IF EXISTS threads
               ADD COLUMN IF NOT EXISTS initiating_principal_id TEXT"#,
            r#"ALTER TABLE IF EXISTS thread_activations
               ADD COLUMN IF NOT EXISTS initiating_principal_id TEXT"#,
            r#"ALTER TABLE IF EXISTS thread_signals
               ADD COLUMN IF NOT EXISTS principal_id TEXT"#,
            r#"ALTER TABLE IF EXISTS execution_jobs
               ADD COLUMN IF NOT EXISTS initiating_principal_id TEXT"#,
            r#"ALTER TABLE IF EXISTS objectives
               ADD COLUMN IF NOT EXISTS initiating_principal_id TEXT"#,
            r#"ALTER TABLE IF EXISTS delegations
               ADD COLUMN IF NOT EXISTS initiating_principal_id TEXT"#,
        ] {
            sqlx::query(statement).execute(&self.pool).await?;
        }
        Ok(())
    }

    /// Project stable causal route identifiers into indexed Event columns.
    /// Payload is still the immutable source of truth; this projection avoids
    /// JSON substring scans when a caller already knows a Thread or
    /// Activation identifier.
    async fn migrate_event_causal_projection(&self) -> Result<(), StoreError> {
        for statement in [
            "ALTER TABLE events ADD COLUMN IF NOT EXISTS thread_id TEXT",
            "ALTER TABLE events ADD COLUMN IF NOT EXISTS activation_id TEXT",
            "ALTER TABLE events ADD COLUMN IF NOT EXISTS root_turn_id TEXT",
            "ALTER TABLE events ADD COLUMN IF NOT EXISTS objective_id TEXT",
            "CREATE INDEX IF NOT EXISTS idx_pg_events_context_session_topic_thread_time \
             ON events(context_id, session_id, topic, thread_id, timestamp, sequence)",
            "CREATE INDEX IF NOT EXISTS idx_pg_events_context_thread_time \
             ON events(context_id, thread_id, timestamp, sequence)",
            "CREATE TABLE IF NOT EXISTS event_causal_projection_backfills (\
             context_id TEXT NOT NULL, session_id TEXT NOT NULL, thread_id TEXT NOT NULL, \
             topic TEXT NOT NULL, completed_at TEXT NOT NULL, \
             PRIMARY KEY(context_id, session_id, thread_id, topic))",
            // QueryFilter's `topic/*` syntax is a deterministic prefix, not
            // a substring search. `text_pattern_ops` keeps that narrow
            // `LIKE 'prefix/%'` predicate indexable under every PostgreSQL
            // locale instead of depending on the database default collation.
            "CREATE INDEX IF NOT EXISTS idx_pg_events_context_topic_prefix_time \
             ON events(context_id, topic text_pattern_ops, timestamp, sequence)",
            "CREATE INDEX IF NOT EXISTS idx_pg_events_context_session_topic_prefix_time \
             ON events(context_id, session_id, topic text_pattern_ops, timestamp, sequence)",
        ] {
            sqlx::query(statement).execute(&self.pool).await?;
        }
        Ok(())
    }

    /// Builds the lexical Recall index.
    ///
    /// The Runtime segments text before it is stored, so PostgreSQL's own
    /// full-text search over the `simple` configuration is exact here: it only
    /// has to split the stored terms on whitespace. That removes both the
    /// `pg_trgm` three-character floor, which silently dropped short CJK
    /// words, and the `CREATE EXTENSION` privilege a managed deployment often
    /// cannot grant — `tsvector` is core PostgreSQL.
    async fn ensure_recall_search_acceleration(&self) -> Result<(), StoreError> {
        if let Err(error) = sqlx::query(
            r#"CREATE INDEX IF NOT EXISTS idx_pg_recall_documents_tsv
               ON recall_documents USING GIN (to_tsvector('simple', searchable_text))"#,
        )
        .execute(&self.pool)
        .await
        {
            tracing::warn!(
                error = %error,
                "PostgreSQL 无法创建 Recall 全文索引，Recall 仅允许精确文档 ID 查询"
            );
            return Ok(());
        }
        // The substring index this replaces is dead weight once queries match
        // whole segmented terms.
        if let Err(error) = sqlx::query("DROP INDEX IF EXISTS idx_pg_recall_documents_trgm")
            .execute(&self.pool)
            .await
        {
            tracing::warn!(error = %error, "PostgreSQL 无法回收旧的 pg_trgm Recall 索引");
        }
        Ok(())
    }

    /// Rewrites stored Recall documents under the current Runtime segmenter.
    ///
    /// Documents are read in bounded pages. Stored text is already NFKC-folded
    /// and lowercased, and both operations are idempotent, so re-deriving from
    /// it yields exactly what the write path would produce.
    async fn resegment_recall_documents(&self) -> Result<(), StoreError> {
        const PAGE: i64 = 500;
        let mut cursor: Option<(String, String, String)> = None;
        loop {
            let page = match &cursor {
                Some((context_id, document_kind, document_id)) => sqlx::query(
                    r#"SELECT context_id, document_kind, document_id, searchable_text, retired
                       FROM recall_documents
                       WHERE (context_id, document_kind, document_id) > ($1, $2, $3)
                       ORDER BY context_id, document_kind, document_id
                       LIMIT $4"#,
                )
                .bind(context_id)
                .bind(document_kind)
                .bind(document_id)
                .bind(PAGE),
                None => sqlx::query(
                    r#"SELECT context_id, document_kind, document_id, searchable_text, retired
                       FROM recall_documents
                       ORDER BY context_id, document_kind, document_id
                       LIMIT $1"#,
                )
                .bind(PAGE),
            }
            .fetch_all(&self.pool)
            .await?;
            if page.is_empty() {
                break;
            }
            for row in &page {
                let stored = row.get::<String, _>("searchable_text");
                let segmented = crate::memory::segment_recall_text(&stored);
                if segmented == stored {
                    continue;
                }
                let retired = row.get::<bool, _>("retired");
                sqlx::query(
                    r#"UPDATE recall_documents SET searchable_text = $1, state_hash = $2
                       WHERE context_id = $3 AND document_kind = $4 AND document_id = $5"#,
                )
                .bind(&segmented)
                .bind(crate::memory::recall_state_hash(&segmented, retired))
                .bind(row.get::<String, _>("context_id"))
                .bind(row.get::<String, _>("document_kind"))
                .bind(row.get::<String, _>("document_id"))
                .execute(&self.pool)
                .await?;
            }
            let last = &page[page.len() - 1];
            cursor = Some((
                last.get::<String, _>("context_id"),
                last.get::<String, _>("document_kind"),
                last.get::<String, _>("document_id"),
            ));
        }
        Ok(())
    }

    async fn migrate_session_projections(&self) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"INSERT INTO session_projections (event_id, context_id, session_id)
               SELECT id, context_id, session_id
               FROM events
               WHERE context_id IS NOT NULL
                 AND (session_id IS NOT NULL
                      OR (topic = 'chat/context_observation'
                          AND payload->>'context_wide' = 'true'))
                 AND type IN ('user_message', 'tool_output', 'agent_call', 'exception', 'file_change')
                 AND topic NOT IN ('chat/assistant_call', 'chat/progress', 'chat/no_reply',
                                   'chat/context_inspect', 'chat/context_tx_committed',
                                   'chat/runtime_error')
                 AND left(topic, 8) <> 'runtime/'
                 AND NOT (
                     type = 'tool_output'
                     AND payload->>'tool_name' = 'context_tx'
                     AND left(COALESCE(payload->>'text', ''), 5) <> '执行失败:'
                     AND left(COALESCE(payload->>'text', ''), 5) <> '执行拒绝:'
                 )
               ON CONFLICT(event_id) DO NOTHING"#,
        )
        .execute(&mut *tx)
        .await?;
        let projections = sqlx::query("SELECT state_json FROM mind_projections")
            .fetch_all(&mut *tx)
            .await?;
        for row in projections {
            let state = row.get::<JsonValue, _>("state_json");
            if let Some(retired) = state.get("retired").and_then(JsonValue::as_array) {
                for event_id in retired.iter().filter_map(JsonValue::as_str) {
                    sqlx::query("DELETE FROM session_projections WHERE event_id = $1")
                        .bind(event_id)
                        .execute(&mut *tx)
                        .await?;
                }
            }
        }
        tx.commit().await?;
        Ok(())
    }
}

impl crate::memory::RuntimeStore for PostgresStore {
    fn worker_coordination_mode(&self) -> crate::memory::WorkerCoordinationMode {
        crate::memory::WorkerCoordinationMode::SharedLeases
    }
}

fn now_text() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)
}

fn parse_time(value: &str) -> Result<DateTime<Utc>, StoreError> {
    // Morphz writes RFC 3339 timestamps, but the first PostgreSQL Execution
    // Target migration used `CURRENT_TIMESTAMP::text`, whose stable server
    // representation uses a space separator and may use an hour-only offset
    // (for example `2026-07-22 01:01:28.08005+00`). Accept that legacy value
    // so existing databases remain readable while all new writes stay RFC
    // 3339.
    let parsed = DateTime::parse_from_rfc3339(value)
        .or_else(|_| DateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f%#z"))?;
    Ok(parsed.with_timezone(&Utc))
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
        initiating_principal_id: row.get("initiating_principal_id"),
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

/// Observe Context Head and Mind Projection in one PostgreSQL statement.
/// Under READ COMMITTED, a JOIN followed by a separate existence query can
/// see two different committed snapshots and falsely report corruption while
/// another Runtime is atomically installing the pair.
async fn get_projection_consistent(
    pool: &PgPool,
    context_id: &str,
) -> Result<Option<MindProjectionRecord>, StoreError> {
    let row = sqlx::query(
        r#"SELECT h.context_id AS head_context_id,
                  h.revision AS head_revision,
                  h.projection_hash AS head_projection_hash,
                  p.context_id AS projection_context_id,
                  p.context_id, p.revision, p.state_json, p.state_hash,
                  h.head_event_id, p.updated_at
           FROM (SELECT 1) anchor
           LEFT JOIN context_heads h ON h.context_id = $1
           LEFT JOIN mind_projections p ON p.context_id = $1"#,
    )
    .bind(context_id)
    .fetch_one(pool)
    .await?;
    let head_context_id = row.get::<Option<String>, _>("head_context_id");
    let projection_context_id = row.get::<Option<String>, _>("projection_context_id");
    match (head_context_id, projection_context_id) {
        (None, None) => Ok(None),
        (Some(_), Some(_)) => {
            let head_revision = row
                .get::<Option<i64>, _>("head_revision")
                .ok_or("Context Head 缺少 revision")?;
            let projection_revision = row
                .get::<Option<i64>, _>("revision")
                .ok_or("Mind Projection 缺少 revision")?;
            let head_hash = row
                .get::<Option<String>, _>("head_projection_hash")
                .ok_or("Context Head 缺少 projection_hash")?;
            let projection_hash = row
                .get::<Option<String>, _>("state_hash")
                .ok_or("Mind Projection 缺少 state_hash")?;
            if head_revision != projection_revision || head_hash != projection_hash {
                return Err(format!(
                    "Context '{context_id}' 的 Mind Projection head/hash/revision 不一致"
                )
                .into());
            }
            projection_from_row(&row).map(Some)
        }
        _ => Err(format!("Context '{context_id}' 的 Mind Projection 不完整").into()),
    }
}

async fn project_attention_acknowledgement_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    event: &Event,
    context_id: &str,
    sequence: u64,
) -> Result<(), StoreError> {
    if event.topic != "runtime/attention_acknowledged" {
        return Ok(());
    }
    let key = event
        .payload
        .get("key")
        .and_then(JsonValue::as_str)
        .ok_or("attention acknowledgement 缺少 key")?;
    let source_kind = event
        .payload
        .get("source_kind")
        .and_then(JsonValue::as_str)
        .ok_or("attention acknowledgement 缺少 source_kind")?;
    let source_id = event
        .payload
        .get("source_id")
        .and_then(JsonValue::as_str)
        .ok_or("attention acknowledgement 缺少 source_id")?;
    let source_revision = event
        .payload
        .get("source_revision")
        .and_then(JsonValue::as_u64)
        .ok_or("attention acknowledgement 缺少 source_revision")?;
    let acknowledged_by = event
        .payload
        .get("acknowledged_by")
        .and_then(JsonValue::as_str)
        .ok_or("attention acknowledgement 缺少 acknowledged_by")?;
    sqlx::query(
        r#"INSERT INTO attention_acknowledgements
           (context_id, key, event_id, event_sequence, source_kind, source_id,
            source_revision, acknowledged_by, rationale, acknowledged_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT(context_id, key) DO UPDATE SET
             event_id = EXCLUDED.event_id,
             event_sequence = EXCLUDED.event_sequence,
             source_kind = EXCLUDED.source_kind,
             source_id = EXCLUDED.source_id,
             source_revision = EXCLUDED.source_revision,
             acknowledged_by = EXCLUDED.acknowledged_by,
             rationale = EXCLUDED.rationale,
             acknowledged_at = EXCLUDED.acknowledged_at
           WHERE EXCLUDED.event_sequence > attention_acknowledgements.event_sequence"#,
    )
    .bind(context_id)
    .bind(key)
    .bind(&event.id)
    .bind(i64::try_from(sequence)?)
    .bind(source_kind)
    .bind(source_id)
    .bind(i64::try_from(source_revision)?)
    .bind(acknowledged_by)
    .bind(event.payload.get("rationale").and_then(JsonValue::as_str))
    .bind(
        event
            .timestamp
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn enqueue_recall_document_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    document: &RecallDocument,
) -> Result<(), StoreError> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    let document = crate::memory::bound_recall_document(document.clone());
    sqlx::query(
        r#"INSERT INTO recall_projection_outbox
           (context_id, document_kind, document_id, generation, document_json,
            status, attempts, available_at, created_at, updated_at)
           VALUES ($1, $2, $3, 1, $4, 'pending', 0, $5, $5, $5)
           ON CONFLICT(context_id, document_kind, document_id) DO UPDATE SET
             generation = recall_projection_outbox.generation + 1,
             document_json = EXCLUDED.document_json,
             status = 'pending', attempts = 0,
             available_at = EXCLUDED.available_at,
             claimed_by = NULL, claim_expires_at = NULL, last_error = NULL,
             updated_at = EXCLUDED.updated_at"#,
    )
    .bind(&document.context_id)
    .bind(document.document_kind.as_str())
    .bind(&document.document_id)
    .bind(serde_json::to_value(&document)?)
    .bind(&now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn enqueue_event_recall_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    event: &Event,
    context_id: &str,
    retired: bool,
) -> Result<(), StoreError> {
    if !crate::memory::event_has_recall_value(event) {
        return Ok(());
    }
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    sqlx::query(
        r#"INSERT INTO recall_projection_outbox
           (context_id, document_kind, document_id, generation, document_json,
            status, attempts, available_at, created_at, updated_at)
           VALUES ($1, 'event', $2, 1, $3, 'pending', 0, $4, $4, $4)
           ON CONFLICT(context_id, document_kind, document_id) DO UPDATE SET
             generation = recall_projection_outbox.generation + 1,
             document_json = EXCLUDED.document_json,
             status = 'pending', attempts = 0,
             available_at = EXCLUDED.available_at,
             claimed_by = NULL, claim_expires_at = NULL, last_error = NULL,
             updated_at = EXCLUDED.updated_at"#,
    )
    .bind(context_id)
    .bind(&event.id)
    .bind(serde_json::json!({ "retired": retired }))
    .bind(&now)
    .execute(&mut **tx)
    .await?;
    Ok(())
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
    let thread_id = causal_payload_string(event, "thread_id");
    let activation_id = causal_payload_string(event, "activation_id");
    let root_turn_id = causal_payload_string(event, "root_turn_id");
    let objective_id = causal_payload_string(event, "objective_id");
    let inserted = sqlx::query(
        r#"INSERT INTO events
           (id, timestamp, actor, type, topic, context_id, session_id,
            thread_id, activation_id, root_turn_id, objective_id, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT(id) DO NOTHING"#,
    )
    .bind(&event.id)
    .bind(&timestamp)
    .bind(&event.actor)
    .bind(&event.event_type)
    .bind(&event.topic)
    .bind(context_id)
    .bind(session_id)
    .bind(thread_id)
    .bind(activation_id)
    .bind(root_turn_id)
    .bind(objective_id)
    .bind(JsonValue::Object(event.payload.clone()))
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() == 1 {
        if let Some(context_id) = context_id {
            let sequence = u64::try_from(
                sqlx::query_scalar::<_, i64>("SELECT sequence FROM events WHERE id = $1")
                    .bind(&event.id)
                    .fetch_one(&mut **tx)
                    .await?,
            )?;
            project_attention_acknowledgement_in_tx(tx, event, context_id, sequence).await?;
            enqueue_event_recall_in_tx(tx, event, context_id, false).await?;
        }
        project_observation_in_tx(tx, event).await?;
        return Ok(true);
    }
    let existing = sqlx::query(
        r#"SELECT sequence, timestamp, actor, type, topic, context_id, session_id, payload
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
    // Idempotent replay must not re-enqueue an already projected Event.
    Ok(false)
}

async fn upsert_recall_document_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    document: &RecallDocument,
) -> Result<(), StoreError> {
    sqlx::query(
        r#"INSERT INTO recall_documents
           (context_id, document_kind, document_id, revision, searchable_text, preview,
            retired, updated_sequence, state_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT(context_id, document_kind, document_id) DO UPDATE SET
             revision = EXCLUDED.revision,
             searchable_text = EXCLUDED.searchable_text,
             preview = EXCLUDED.preview,
             retired = EXCLUDED.retired,
             updated_sequence = EXCLUDED.updated_sequence,
             state_hash = EXCLUDED.state_hash
           WHERE EXCLUDED.updated_sequence >= recall_documents.updated_sequence"#,
    )
    .bind(&document.context_id)
    .bind(document.document_kind.as_str())
    .bind(&document.document_id)
    .bind(i64::try_from(document.revision)?)
    .bind(&document.searchable_text)
    .bind(&document.preview)
    .bind(document.retired)
    .bind(i64::try_from(document.updated_sequence)?)
    .bind(&document.state_hash)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn event_has_projection_route(event: &Event) -> bool {
    event
        .payload
        .get("context_id")
        .and_then(JsonValue::as_str)
        .is_some()
        && (event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .is_some()
            || (event.topic == "chat/context_observation"
                && event
                    .payload
                    .get("context_wide")
                    .and_then(JsonValue::as_bool)
                    == Some(true)))
}

async fn project_observation_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    event: &Event,
) -> Result<(), StoreError> {
    if !crate::event::is_context_observation(event) || !event_has_projection_route(event) {
        return Ok(());
    }
    let context_id = event
        .payload
        .get("context_id")
        .and_then(JsonValue::as_str)
        .expect("event_has_projection_route 已验证 context_id");
    let session_id = event.payload.get("session_id").and_then(JsonValue::as_str);
    sqlx::query(
        r#"INSERT INTO session_projections (event_id, context_id, session_id)
           VALUES ($1, $2, $3) ON CONFLICT(event_id) DO NOTHING"#,
    )
    .bind(&event.id)
    .bind(context_id)
    .bind(session_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn stored_event_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    event_id: &str,
    context_id: &str,
) -> Result<Option<Event>, StoreError> {
    let row = sqlx::query(
        r#"SELECT sequence, id, timestamp, actor, type, topic, payload
           FROM events WHERE id = $1 AND context_id = $2"#,
    )
    .bind(event_id)
    .bind(context_id)
    .fetch_optional(&mut **tx)
    .await?;
    row.map(|row| {
        let payload = row.get::<JsonValue, _>("payload");
        Ok(Event {
            id: row.get("id"),
            sequence: u64::try_from(row.get::<i64, _>("sequence")).ok(),
            timestamp: parse_time(&row.get::<String, _>("timestamp"))?,
            actor: row.get("actor"),
            event_type: row.get("type"),
            topic: row.get("topic"),
            payload: serde_json::from_value(payload)?,
        })
    })
    .transpose()
}

async fn mutate_session_projection_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    context_id: &str,
    mutation: &SessionProjectionMutation,
) -> Result<(), StoreError> {
    for event_id in &mutation.retired_event_ids {
        sqlx::query("DELETE FROM session_projections WHERE event_id = $1 AND context_id = $2")
            .bind(event_id)
            .bind(context_id)
            .execute(&mut **tx)
            .await?;
        if let Some(event) = stored_event_in_tx(tx, event_id, context_id).await? {
            enqueue_event_recall_in_tx(tx, &event, context_id, true).await?;
        }
    }
    for event_id in &mutation.restored_event_ids {
        if let Some(event) = stored_event_in_tx(tx, event_id, context_id).await? {
            project_observation_in_tx(tx, &event).await?;
            enqueue_event_recall_in_tx(tx, &event, context_id, false).await?;
        }
    }
    Ok(())
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
        if !filter.event_ids.is_empty() {
            builder.push(" AND id IN (");
            let mut separated = builder.separated(", ");
            for event_id in &filter.event_ids {
                separated.push_bind(event_id);
            }
            builder.push(")");
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
        if let Some(before) = filter.before_sequence {
            builder
                .push(" AND sequence < ")
                .push_bind(i64::try_from(before).unwrap_or(i64::MAX));
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
        if let Some(thread_id) = filter.thread_id {
            builder.push(" AND thread_id = ").push_bind(thread_id);
        }
        if let Some(activation_id) = filter.activation_id {
            builder
                .push(" AND activation_id = ")
                .push_bind(activation_id);
        }
        if let Some(root_turn_id) = filter.root_turn_id {
            builder.push(" AND root_turn_id = ").push_bind(root_turn_id);
        }
        if let Some(objective_id) = filter.objective_id {
            builder.push(" AND objective_id = ").push_bind(objective_id);
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

    async fn backfill_causal_projection_for_thread(
        &self,
        context_id: &str,
        session_id: &str,
        thread_id: &str,
        topic: &str,
    ) -> Result<(), StoreError> {
        // Legacy payloads are source records. The mutable Event columns are a
        // query projection and are filled lazily once per inspected Thread so
        // a Dashboard poll never falls back to JSON/substring scans.
        //
        // Callers invoke this before every read, because a Thread that spans
        // the projection upgrade has both projected and legacy rows and a
        // non-empty query is therefore no evidence that the fill already ran.
        // Settle that common case with a keyed read so a poll never opens a
        // write transaction once the Thread has been filled.
        let filled = sqlx::query_scalar::<_, bool>(
            r#"SELECT EXISTS(
                 SELECT 1 FROM event_causal_projection_backfills
                 WHERE context_id = $1 AND session_id = $2 AND thread_id = $3 AND topic = $4
               )"#,
        )
        .bind(context_id)
        .bind(session_id)
        .bind(thread_id)
        .bind(topic)
        .fetch_one(&self.pool)
        .await?;
        if filled {
            return Ok(());
        }
        let mut tx = self.pool.begin().await?;
        let claimed = sqlx::query(
            r#"INSERT INTO event_causal_projection_backfills
               (context_id, session_id, thread_id, topic, completed_at)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT DO NOTHING"#,
        )
        .bind(context_id)
        .bind(session_id)
        .bind(thread_id)
        .bind(topic)
        .bind(now_text())
        .execute(&mut *tx)
        .await?;
        if claimed.rows_affected() == 0 {
            tx.rollback().await?;
            return Ok(());
        }
        sqlx::query(
            r#"UPDATE events
               SET thread_id = COALESCE(
                       thread_id,
                       payload->>'thread_id',
                       payload #>> '{route,thread_id}'
                   ),
                   activation_id = COALESCE(
                       activation_id,
                       payload->>'activation_id',
                       payload #>> '{route,activation_id}'
                   ),
                   root_turn_id = COALESCE(
                       root_turn_id,
                       payload->>'root_turn_id',
                       payload #>> '{route,root_turn_id}'
                   ),
                   objective_id = COALESCE(
                       objective_id,
                       payload->>'objective_id',
                       payload #>> '{route,objective_id}'
                   )
               WHERE context_id = $1 AND session_id = $2 AND topic = $3
                 AND thread_id IS NULL
                 AND COALESCE(
                       payload->>'thread_id',
                       payload #>> '{route,thread_id}'
                   ) = $4"#,
        )
        .bind(context_id)
        .bind(session_id)
        .bind(topic)
        .bind(thread_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    async fn list_attention_acknowledgements(
        &self,
        context_id: &str,
    ) -> Result<Vec<AttentionAcknowledgementRecord>, StoreError> {
        let rows = sqlx::query(
            r#"SELECT event_id, context_id, key, source_kind, source_id,
                      source_revision, acknowledged_by, rationale, acknowledged_at
               FROM attention_acknowledgements
               WHERE context_id = $1
               ORDER BY acknowledged_at DESC, event_sequence DESC"#,
        )
        .bind(context_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(AttentionAcknowledgementRecord {
                    event_id: row.get("event_id"),
                    context_id: row.get("context_id"),
                    key: row.get("key"),
                    source_kind: row.get("source_kind"),
                    source_id: row.get("source_id"),
                    source_revision: u64::try_from(row.get::<i64, _>("source_revision"))?,
                    acknowledged_by: row.get("acknowledged_by"),
                    rationale: row.get("rationale"),
                    acknowledged_at: parse_time(&row.get::<String, _>("acknowledged_at"))?,
                })
            })
            .collect()
    }
}

fn pg_recall_kind(value: &str) -> Result<RecallDocumentKind, StoreError> {
    match value {
        "event" => Ok(RecallDocumentKind::Event),
        "frame" => Ok(RecallDocumentKind::Frame),
        other => Err(format!("未知 Recall document kind: {other}").into()),
    }
}

async fn postgres_recall_capability(pool: &PgPool) -> Result<RecallIndexCapability, StoreError> {
    let indexed = sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS(
                    SELECT 1 FROM pg_indexes
                    WHERE indexname = 'idx_pg_recall_documents_tsv'
                  )"#,
    )
    .fetch_one(pool)
    .await?;
    Ok(RecallIndexCapability {
        mode: if indexed {
            crate::memory::LexicalSearchMode::PostgresTsvectorSegmented
        } else {
            crate::memory::LexicalSearchMode::ExactDocumentOnly
        },
        indexed,
        unicode_normalization: "nfkc+lowercase".to_string(),
        segmenter: crate::memory::RECALL_SEGMENTER.to_string(),
        detail: if indexed {
            "PostgreSQL pg_trgm GIN index over Runtime-segmented terms".to_string()
        } else {
            "PostgreSQL pg_trgm unavailable; exact Recall document id only".to_string()
        },
    })
}

#[derive(Debug)]
struct PgRecallOutboxClaim {
    context_id: String,
    document_kind: RecallDocumentKind,
    document_id: String,
    generation: u64,
    document_json: JsonValue,
    claim_token: String,
}

async fn claim_pg_recall_outbox(
    pool: &PgPool,
    worker_id: &str,
    limit: usize,
) -> Result<Vec<PgRecallOutboxClaim>, StoreError> {
    let now = Utc::now();
    let now_text = now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    let lease_text =
        (now + chrono::Duration::seconds(30)).to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    let mut tx = pool.begin().await?;
    let rows = sqlx::query(
        r#"SELECT context_id, document_kind, document_id, generation, document_json
           FROM recall_projection_outbox
           WHERE (status = 'pending' AND available_at <= $1)
              OR (status = 'processing' AND claim_expires_at <= $1)
           ORDER BY updated_at ASC, context_id, document_kind, document_id
           LIMIT $2
           FOR UPDATE SKIP LOCKED"#,
    )
    .bind(&now_text)
    .bind(i64::try_from(limit.clamp(1, 64))?)
    .fetch_all(&mut *tx)
    .await?;
    let mut claims = Vec::with_capacity(rows.len());
    for (index, row) in rows.into_iter().enumerate() {
        let context_id = row.get::<String, _>("context_id");
        let kind_text = row.get::<String, _>("document_kind");
        let document_id = row.get::<String, _>("document_id");
        let generation = u64::try_from(row.get::<i64, _>("generation"))?;
        let claim_token = format!("{worker_id}:{now_text}:{index}");
        sqlx::query(
            r#"UPDATE recall_projection_outbox
               SET status = 'processing', claimed_by = $1, claim_expires_at = $2, updated_at = $3
               WHERE context_id = $4 AND document_kind = $5 AND document_id = $6
                 AND generation = $7"#,
        )
        .bind(&claim_token)
        .bind(&lease_text)
        .bind(&now_text)
        .bind(&context_id)
        .bind(&kind_text)
        .bind(&document_id)
        .bind(i64::try_from(generation)?)
        .execute(&mut *tx)
        .await?;
        claims.push(PgRecallOutboxClaim {
            context_id,
            document_kind: pg_recall_kind(&kind_text)?,
            document_id,
            generation,
            document_json: row.get("document_json"),
            claim_token,
        });
    }
    tx.commit().await?;
    Ok(claims)
}

async fn materialize_pg_recall_claim(
    pool: &PgPool,
    claim: &PgRecallOutboxClaim,
) -> Result<Option<RecallDocument>, StoreError> {
    match claim.document_kind {
        RecallDocumentKind::Frame => Ok(Some(crate::memory::bound_recall_document(
            serde_json::from_value(claim.document_json.clone())?,
        ))),
        RecallDocumentKind::Event => {
            let Some(row) = sqlx::query(
                r#"SELECT sequence, id, timestamp, actor, type, topic, payload
                   FROM events WHERE id = $1 AND context_id = $2"#,
            )
            .bind(&claim.document_id)
            .bind(&claim.context_id)
            .fetch_optional(pool)
            .await?
            else {
                return Ok(None);
            };
            let payload = row.get::<JsonValue, _>("payload");
            let event = Event {
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
            };
            if !crate::memory::event_has_recall_value(&event) {
                return Ok(None);
            }
            let retired = claim
                .document_json
                .get("retired")
                .and_then(JsonValue::as_bool)
                .unwrap_or(false);
            Ok(Some(crate::memory::event_recall_document_with_retired(
                &event,
                &claim.context_id,
                event.sequence.unwrap_or_default(),
                retired,
            )))
        }
    }
}

async fn finish_pg_recall_claim(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    claim: &PgRecallOutboxClaim,
    document: Option<&RecallDocument>,
) -> Result<bool, StoreError> {
    let current = sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS(
             SELECT 1 FROM recall_projection_outbox
             WHERE context_id = $1 AND document_kind = $2 AND document_id = $3
               AND generation = $4 AND status = 'processing' AND claimed_by = $5
           )"#,
    )
    .bind(&claim.context_id)
    .bind(claim.document_kind.as_str())
    .bind(&claim.document_id)
    .bind(i64::try_from(claim.generation)?)
    .bind(&claim.claim_token)
    .fetch_one(&mut **tx)
    .await?;
    if !current {
        return Ok(false);
    }
    if let Some(document) = document {
        upsert_recall_document_in_tx(tx, document).await?;
    }
    sqlx::query(
        r#"DELETE FROM recall_projection_outbox
           WHERE context_id = $1 AND document_kind = $2 AND document_id = $3
             AND generation = $4 AND claimed_by = $5"#,
    )
    .bind(&claim.context_id)
    .bind(claim.document_kind.as_str())
    .bind(&claim.document_id)
    .bind(i64::try_from(claim.generation)?)
    .bind(&claim.claim_token)
    .execute(&mut **tx)
    .await?;
    Ok(true)
}

#[async_trait::async_trait]
impl CognitiveClockStore for PostgresStore {
    async fn get_context_cognitive_clock(
        &self,
        context_id: &str,
    ) -> Result<ContextCognitiveClock, StoreError> {
        let row = sqlx::query(
            "SELECT tick, last_signal_batch_id, revision FROM context_cognitive_clocks WHERE context_id = $1",
        )
        .bind(context_id)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(row) => Ok(ContextCognitiveClock {
                context_id: context_id.to_string(),
                tick: u64::try_from(row.get::<i64, _>("tick"))?,
                last_signal_batch_id: row.get("last_signal_batch_id"),
                revision: u64::try_from(row.get::<i64, _>("revision"))?,
            }),
            None => Ok(ContextCognitiveClock {
                context_id: context_id.to_string(),
                tick: 0,
                last_signal_batch_id: None,
                revision: 0,
            }),
        }
    }
}

#[async_trait::async_trait]
impl RecallProjectionStore for PostgresStore {
    async fn recall_index_capability(&self) -> Result<RecallIndexCapability, StoreError> {
        postgres_recall_capability(&self.pool).await
    }

    async fn search_recall_documents(
        &self,
        context_id: &str,
        normalized_query: &str,
        limit: usize,
    ) -> Result<Vec<RecallSearchHit>, StoreError> {
        let limit = i64::try_from(limit.clamp(1, 100))?;
        let capability = postgres_recall_capability(&self.pool).await?;
        // The index stores Runtime-segmented terms, so the query is segmented
        // the same way and matched whole. `plainto_tsquery` and
        // `phraseto_tsquery` treat their argument as literal text rather than
        // tsquery syntax, so an Agent query can never become an operator
        // expression. A quoted query asks for adjacency instead of `AND`.
        let (requested, phrase) = crate::memory::recall_phrase_request(normalized_query);
        let terms = crate::memory::segment_recall_terms(requested);
        let segmented_query = terms.join(" ");
        let tsquery = if phrase {
            "phraseto_tsquery"
        } else {
            "plainto_tsquery"
        };
        let rows = if capability.indexed && !terms.is_empty() {
            sqlx::query(&format!(
                r#"SELECT document_kind, document_id, revision, retired, preview,
                          updated_sequence,
                          CASE WHEN document_id = $2 THEN 1000000.0
                               ELSE ts_rank(to_tsvector('simple', searchable_text),
                                            {tsquery}('simple', $3))::double precision
                          END AS score
                   FROM recall_documents
                   WHERE context_id = $1
                     AND to_tsvector('simple', searchable_text) @@ {tsquery}('simple', $3)
                   ORDER BY (document_id = $2) DESC,
                            ts_rank(to_tsvector('simple', searchable_text),
                                    {tsquery}('simple', $3)) DESC,
                            updated_sequence DESC, document_id ASC
                   LIMIT $4"#
            ))
            .bind(context_id)
            .bind(normalized_query)
            .bind(&segmented_query)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                r#"SELECT document_kind, document_id, revision, retired, preview,
                          updated_sequence,
                          CASE WHEN document_id = $2 THEN 1000000.0 ELSE 1.0 END AS score
                   FROM recall_documents
                   WHERE context_id = $1 AND document_id = $2
                   ORDER BY (document_id = $2) DESC, updated_sequence DESC, document_id ASC
                   LIMIT $3"#,
            )
            .bind(context_id)
            .bind(normalized_query)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?
        };
        rows.into_iter()
            .map(|row| {
                Ok(RecallSearchHit {
                    document_kind: pg_recall_kind(&row.get::<String, _>("document_kind"))?,
                    document_id: row.get("document_id"),
                    revision: u64::try_from(row.get::<i64, _>("revision"))?,
                    retired: row.get("retired"),
                    score: row.get("score"),
                    preview: row.get("preview"),
                    updated_sequence: u64::try_from(row.get::<i64, _>("updated_sequence"))?,
                })
            })
            .collect()
    }

    async fn replace_recall_documents(
        &self,
        context_id: &str,
        documents: &[RecallDocument],
    ) -> Result<RecallIndexAudit, StoreError> {
        if documents
            .iter()
            .any(|document| document.context_id != context_id)
        {
            return Err("Recall rebuild document 属于错误的 Context".into());
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM recall_projection_outbox WHERE context_id = $1")
            .bind(context_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM recall_documents WHERE context_id = $1")
            .bind(context_id)
            .execute(&mut *tx)
            .await?;
        for document in documents {
            upsert_recall_document_in_tx(&mut tx, document).await?;
        }
        tx.commit().await?;
        self.inspect_recall_index(context_id).await
    }

    async fn inspect_recall_index(&self, context_id: &str) -> Result<RecallIndexAudit, StoreError> {
        let rows = sqlx::query(
            r#"SELECT document_kind, COUNT(*) AS count
               FROM recall_documents WHERE context_id = $1 GROUP BY document_kind"#,
        )
        .bind(context_id)
        .fetch_all(&self.pool)
        .await?;
        let mut event_documents = 0;
        let mut frame_documents = 0;
        for row in rows {
            match row.get::<String, _>("document_kind").as_str() {
                "event" => event_documents = u64::try_from(row.get::<i64, _>("count"))?,
                "frame" => frame_documents = u64::try_from(row.get::<i64, _>("count"))?,
                _ => {}
            }
        }
        Ok(RecallIndexAudit {
            context_id: context_id.to_string(),
            capability: postgres_recall_capability(&self.pool).await?,
            event_documents,
            frame_documents,
        })
    }

    async fn project_recall_outbox_batch(
        &self,
        worker_id: &str,
        limit: usize,
    ) -> Result<RecallProjectionBatch, StoreError> {
        let claims = claim_pg_recall_outbox(&self.pool, worker_id, limit).await?;
        let mut result = RecallProjectionBatch {
            claimed: claims.len(),
            ..RecallProjectionBatch::default()
        };
        for claim in claims {
            match materialize_pg_recall_claim(&self.pool, &claim).await {
                Ok(document) => {
                    let mut tx = self.pool.begin().await?;
                    if finish_pg_recall_claim(&mut tx, &claim, document.as_ref()).await? {
                        if document.is_some() {
                            result.projected += 1;
                        } else {
                            result.skipped += 1;
                        }
                    } else {
                        result.skipped += 1;
                    }
                    tx.commit().await?;
                }
                Err(error) => {
                    let attempts = sqlx::query_scalar::<_, i64>(
                        r#"SELECT attempts FROM recall_projection_outbox
                           WHERE context_id = $1 AND document_kind = $2 AND document_id = $3
                             AND generation = $4 AND claimed_by = $5"#,
                    )
                    .bind(&claim.context_id)
                    .bind(claim.document_kind.as_str())
                    .bind(&claim.document_id)
                    .bind(i64::try_from(claim.generation)?)
                    .bind(&claim.claim_token)
                    .fetch_optional(&self.pool)
                    .await?
                    .unwrap_or(0);
                    let now = Utc::now();
                    let backoff_secs = 1_i64 << u32::try_from(attempts.clamp(0, 6))?;
                    sqlx::query(
                        r#"UPDATE recall_projection_outbox
                           SET status = 'pending', attempts = attempts + 1,
                               available_at = $1, claimed_by = NULL, claim_expires_at = NULL,
                               last_error = $2, updated_at = $3
                           WHERE context_id = $4 AND document_kind = $5 AND document_id = $6
                             AND generation = $7 AND claimed_by = $8"#,
                    )
                    .bind(
                        (now + chrono::Duration::seconds(backoff_secs))
                            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
                    )
                    .bind(error.to_string())
                    .bind(now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
                    .bind(&claim.context_id)
                    .bind(claim.document_kind.as_str())
                    .bind(&claim.document_id)
                    .bind(i64::try_from(claim.generation)?)
                    .bind(&claim.claim_token)
                    .execute(&self.pool)
                    .await?;
                    result.failed += 1;
                }
            }
        }
        Ok(result)
    }
}

const OBJECTIVE_SELECT: &str = r#"SELECT id, agent_id, context_id,
    coordinator_session_id, delivery_session_id, parent_objective_id, source_event_id,
    initiating_principal_id, stated_objective, revision, status, status_reason, wait_condition_json, active_evaluation_id,
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
                parent_objective_id, source_event_id, initiating_principal_id, stated_objective, revision, status,
                wait_condition_json, active_evaluation_id, evaluation_lease_expires_at,
                continuation_sequence, token_budget, tokens_used, time_used_seconds,
                created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 'active',
                       NULL, NULL, NULL, 0, $10, 0, 0, $11, $11)"#,
        )
        .bind(&objective.id)
        .bind(&objective.agent_id)
        .bind(&objective.context_id)
        .bind(&objective.coordinator_session_id)
        .bind(&objective.delivery_session_id)
        .bind(&objective.parent_objective_id)
        .bind(&objective.source_event_id)
        .bind(&objective.initiating_principal_id)
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

    async fn renew_objective_evaluation(
        &self,
        id: &str,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
    ) -> Result<ObjectiveMutation, StoreError> {
        if evaluation_id.trim().is_empty() {
            return Err("Objective Evaluation ID 不能为空".into());
        }
        if lease_expires_at <= Utc::now() {
            return Err("Objective Evaluation 续租时间必须在未来".into());
        }
        let result = sqlx::query(
            r#"UPDATE objectives
               SET evaluation_lease_expires_at = $1, updated_at = $2
               WHERE id = $3 AND status = 'active' AND wait_condition_json IS NULL
                 AND active_evaluation_id = $4"#,
        )
        .bind(lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .bind(now_text())
        .bind(id)
        .bind(evaluation_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ObjectiveMutation::Updated(
                self.get_objective(id)
                    .await?
                    .ok_or("Objective Evaluation 续租后无法读取")?,
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
impl SessionProjectionStore for PostgresStore {
    async fn query_session_projections(
        &self,
        context_id: &str,
        session_ids: &[String],
        include_context_wide: bool,
    ) -> Result<Vec<Event>, StoreError> {
        let mut builder = QueryBuilder::<Postgres>::new(
            r#"SELECT e.sequence, e.id, e.timestamp, e.actor, e.type, e.topic, e.payload
               FROM session_projections projection
               JOIN events e ON e.id = projection.event_id
               WHERE projection.context_id = "#,
        );
        builder.push_bind(context_id);
        builder.push(" AND (");
        if include_context_wide {
            builder.push("projection.session_id IS NULL");
            if !session_ids.is_empty() {
                builder.push(" OR ");
            }
        }
        if !session_ids.is_empty() {
            builder.push("projection.session_id IN (");
            let mut separated = builder.separated(", ");
            for session_id in session_ids {
                separated.push_bind(session_id);
            }
            builder.push(")");
        } else if !include_context_wide {
            builder.push("FALSE");
        }
        builder.push(") ORDER BY e.sequence ASC");
        builder
            .build()
            .fetch_all(&self.pool)
            .await?
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
                    payload: serde_json::from_value(payload)?,
                })
            })
            .collect()
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
        get_projection_consistent(&self.pool, context_id).await
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
            for document in &projection.recall_documents {
                enqueue_recall_document_in_tx(&mut tx, document).await?;
            }
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
        session_projection: &SessionProjectionMutation,
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
        mutate_session_projection_in_tx(&mut tx, &next_projection.context_id, session_projection)
            .await?;
        for document in &next_projection.recall_documents {
            enqueue_recall_document_in_tx(&mut tx, document).await?;
        }
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
        for document in &next_projection.recall_documents {
            enqueue_recall_document_in_tx(&mut tx, document).await?;
        }
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

#[cfg(test)]
mod tests {
    use super::parse_time;

    #[test]
    fn parses_legacy_postgres_timestamp_text_and_rfc3339() {
        let legacy = parse_time("2026-07-22 01:01:28.08005+00").unwrap();
        let canonical = parse_time("2026-07-22T01:01:28.080050Z").unwrap();

        assert_eq!(legacy, canonical);
    }
}
