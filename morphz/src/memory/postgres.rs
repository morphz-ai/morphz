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
    ContextActivationCausalitySnapshot, ContextCapabilityBindingMutation,
    ContextCapabilityBindingRecord, ContextCapabilityBindingStore, ContextCognitiveClock,
    ContextEncodingProjectionSnapshot, ContextExecutionResourcesSnapshot,
    ContextRuntimeDirectoryRequest, ContextRuntimeDirectorySnapshot,
    ContextRuntimeSchedulerSnapshot, ContextRuntimeSessionExclusions, ContextRuntimeSnapshotStore,
    EventAppend, EventStore, MindProjectionCommit, MindProjectionHead, MindProjectionRecord,
    MindProjectionStore, MindSnapshotRecord, NewMindProjection, NewObjective, NewRuntimeTimer,
    NewThread, NewWorkAssignment, ObjectiveCompletionIntent, ObjectiveMutation,
    ObjectiveReadinessCounts, ObjectiveRecord, ObjectiveRecoveryCursor, ObjectiveStatus,
    ObjectiveStore, ObjectiveWaitCondition, ProviderAccountAffinityRecord,
    ProviderAccountStateMutation, ProviderAccountStateRecord, ProviderAccountStateStore,
    ProviderAccountStatus, ProviderModelCatalogRecord, ProviderModelCatalogStore,
    ProviderRefreshLeaseRecord, ProviderRouteAccountStateRecord, QueryFilter, RecallDocument,
    RecallDocumentKind, RecallDocumentSearchRequest, RecallIndexAudit, RecallIndexCapability,
    RecallProjectionBatch, RecallProjectionStore, RecallSearchHit, RuntimeTimerKind,
    RuntimeTimerRecord, RuntimeTimerStatus, SessionAttentionUpdate, SessionProjectionMutation,
    SessionProjectionStore, StorageMaintenanceReport, StorageMaintenanceStore, TimerStore,
    TransientStorageRetention, WorkAssignmentCreateResult, WorkAssignmentMutation,
    WorkAssignmentMutationResult, WorkAssignmentRecord, WorkAssignmentStatus, WorkAssignmentStore,
};
use crate::observability::Observability;
use crate::scheduler::{
    objective_wait_dependency_key, stable_scheduler_dependency_id, SchedulerDependencyKind,
    SchedulerDependencyOwnerKind,
};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::pool::PoolConnection;
use sqlx::postgres::{PgConnectOptions, PgConnection, PgListener, PgPoolOptions, PgRow};
use sqlx::{ConnectOptions, Connection, PgPool, Postgres, QueryBuilder, Row};
use std::future::Future;
use std::sync::Arc;
use tokio::sync::Notify;

type StoreError = Box<dyn std::error::Error + Send + Sync>;

// Stable database-scoped lock for schema installation. It is held on a
// dedicated connection so a Store configured with a one-connection pool can
// still migrate without deadlocking itself.
const SCHEMA_MIGRATION_LOCK: i64 = 0x4D4F_5250_485A_0001_i64;
const THREAD_SIGNAL_NOTIFY_CHANNEL: &str = "morphz_thread_signal_change";
const EDGE_COMMAND_NOTIFY_CHANNEL: &str = "morphz_edge_command_change";

mod action_group;
mod activation;
mod agent_provider;
mod approval;
mod delegation;
mod delivery;
mod edge;
mod execution;
mod plan_execution;
mod schedule;
mod scheduler;
mod session;
mod target;
mod thread;
mod thread_group;

pub struct PostgresStore {
    pool: PgPool,
    observability: Arc<Observability>,
    edge_command_notify: Arc<Notify>,
    thread_signal_notify: Arc<Notify>,
}

impl PostgresStore {
    pub async fn new(database_url: &str, max_connections: u32) -> Result<Self, StoreError> {
        Self::new_with_observability(
            database_url,
            max_connections,
            Arc::new(Observability::default()),
        )
        .await
    }

    pub async fn new_with_observability(
        database_url: &str,
        max_connections: u32,
        observability: Arc<Observability>,
    ) -> Result<Self, StoreError> {
        let options = database_url
            .parse::<PgConnectOptions>()?
            // As with SQLite, query events are dormant unless an explicit
            // `sqlx::query=trace` subscriber is installed. Tests and service
            // diagnostics can therefore count physical round trips without
            // changing Store semantics.
            .log_statements(log::LevelFilter::Trace);
        let migration_connect_started = std::time::Instant::now();
        let migration_lock = PgConnection::connect_with(&options).await;
        observability.record_storage_connection(
            "postgres",
            "migration_lock",
            migration_connect_started.elapsed(),
            if migration_lock.is_ok() {
                "ok"
            } else {
                "error"
            },
        );
        let mut migration_lock = migration_lock?;
        sqlx::query("SELECT pg_advisory_lock($1)")
            .bind(SCHEMA_MIGRATION_LOCK)
            .execute(&mut migration_lock)
            .await?;
        let pool_connect_started = std::time::Instant::now();
        let pool = PgPoolOptions::new()
            .max_connections(max_connections.max(1))
            // Keep pool admission observable without producing normal service
            // noise: an explicit TRACE subscriber can measure every acquire,
            // while slow waits remain visible at WARN in production logs.
            .acquire_time_level(log::LevelFilter::Trace)
            .acquire_slow_level(log::LevelFilter::Warn)
            .acquire_slow_threshold(std::time::Duration::from_millis(100))
            .connect_with(options)
            .await;
        observability.record_storage_connection(
            "postgres",
            "pool_startup",
            pool_connect_started.elapsed(),
            if pool.is_ok() { "ok" } else { "error" },
        );
        let pool = pool?;
        let store = Self {
            pool,
            observability,
            edge_command_notify: Arc::new(Notify::new()),
            thread_signal_notify: Arc::new(Notify::new()),
        };
        let migrations = async {
            store.ensure_schema_migrations().await?;
            store
                .run_versioned_migration(
                    "20260718_01_supported_capabilities",
                    store.migrate_supported_capabilities(),
                )
                .await?;
            // Session Sandbox persistence shipped after the original
            // directory migration had already been recorded by production
            // databases. Keep the upgrade in its own immutable migration:
            // editing migrate_supported_capabilities() only helps fresh
            // databases and leaves existing deployments without the column.
            store
                .run_versioned_migration(
                    "20260830_01_session_sandbox_mode",
                    store.migrate_session_sandbox_mode(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260901_01_session_permission_mode",
                    store.migrate_session_permission_mode(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260902_01_session_default_target",
                    store.migrate_session_default_target(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260826_01_work_assignments",
                    store.migrate_work_assignments(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260826_02_work_assignment_leases",
                    store.migrate_work_assignment_leases(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260815_03_session_projection_sequences",
                    store.migrate_session_projection_sequences(),
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
                    "20260816_02_edge_command_notifications",
                    edge::migrate_edge_command_notifications(&store.pool),
                )
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
                    "20260730_01_thread_groups",
                    thread_group::migrate(&store.pool),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260803_01_attached_parent_thread_supervision",
                    thread_group::migrate_attached_supervision_to_parent_threads(&store.pool),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260718_05_activations",
                    activation::migrate(&store.pool),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260816_01_thread_signal_notifications",
                    activation::migrate_thread_signal_notifications(&store.pool),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260831_03_scheduler_latency_fast_path_pending_signal",
                    activation::migrate_latency_fast_paths(&store.pool),
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
                .run_versioned_migration(
                    "20260731_01_scheduler_dependencies",
                    scheduler::migrate(&store.pool),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260731_02_objective_wait_dependencies",
                    scheduler::backfill_objective_wait_dependencies(&store.pool),
                )
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
                    "20260820_02_principal_context_encounters",
                    store.migrate_principal_context_encounters(),
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
                    "20260730_01_context_token_budget",
                    store.migrate_context_token_budget(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260801_01_provider_accounts",
                    store.migrate_provider_accounts(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260901_01_agent_provider_bindings",
                    agent_provider::migrate(&store.pool),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260725_01_recall_segmented_index",
                    store.resegment_recall_documents(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260815_01_recall_whole_document_index",
                    store.migrate_recall_whole_document_index(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260815_02_recall_whole_document_event_backfill",
                    store.enqueue_recall_whole_document_event_backfill(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260820_01_tool_call_history",
                    store.migrate_tool_call_history(),
                )
                .await?;
            // These indexes were introduced after the component migrations
            // above had already shipped. Keep them in a new migration so an
            // existing PostgreSQL deployment receives the same hot-path
            // indexes as a newly-created database.
            store
                .run_versioned_migration(
                    "20260815_04_sql_performance_indexes",
                    store.migrate_sql_performance_indexes(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260816_03_directory_domain_constraints",
                    store.migrate_directory_domain_constraints(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260816_04_core_domain_constraints",
                    store.migrate_core_domain_constraints(),
                )
                .await?;
            store
                .run_versioned_migration(
                    "20260816_05_bounded_read_model",
                    store.migrate_bounded_read_model(),
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
        store.start_database_change_listener(database_url).await?;
        Ok(store)
    }

    pub(super) async fn acquire_observed(
        &self,
        operation: &'static str,
    ) -> Result<PoolConnection<Postgres>, StoreError> {
        let started = std::time::Instant::now();
        let connection = self.pool.acquire().await;
        self.observability.record_storage_pool_acquire(
            "postgres",
            operation,
            started.elapsed(),
            if connection.is_ok() { "ok" } else { "error" },
        );
        connection.map_err(Into::into)
    }

    async fn start_database_change_listener(&self, database_url: &str) -> Result<(), StoreError> {
        let schema = sqlx::query_scalar::<_, String>("SELECT current_schema()")
            .fetch_one(&self.pool)
            .await?;
        let mut listener = PgListener::connect(database_url).await?;
        listener.listen(THREAD_SIGNAL_NOTIFY_CHANNEL).await?;
        listener.listen(EDGE_COMMAND_NOTIFY_CHANNEL).await?;
        let thread_signal_notify = Arc::downgrade(&self.thread_signal_notify);
        let edge_command_notify = Arc::downgrade(&self.edge_command_notify);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    notification = listener.recv() => match notification {
                        Ok(notification) => {
                            // PostgreSQL channels are database-scoped. The
                            // payload keeps independent Morphz schemas from
                            // waking and querying each other's queues.
                            if notification.payload() != schema {
                                continue;
                            }
                            let notify = match notification.channel() {
                                THREAD_SIGNAL_NOTIFY_CHANNEL => thread_signal_notify.upgrade(),
                                EDGE_COMMAND_NOTIFY_CHANNEL => edge_command_notify.upgrade(),
                                _ => None,
                            };
                            if let Some(notify) = notify {
                                // `notify_one` retains a permit if a consumer
                                // is between waits, closing commit-before-wait
                                // races without making NOTIFY authoritative.
                                notify.notify_one();
                            } else if thread_signal_notify.upgrade().is_none()
                                && edge_command_notify.upgrade().is_none()
                            {
                                break;
                            }
                        }
                        Err(error) => {
                            tracing::warn!(
                                %error,
                                event_code = "memory.postgres.scheduler_listener.receive_failed",
                                "PostgreSQL scheduler notification listener failed; bounded durable recovery remains active"
                            );
                            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        }
                    },
                    _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {
                        if thread_signal_notify.upgrade().is_none()
                            && edge_command_notify.upgrade().is_none()
                        {
                            break;
                        }
                    }
                }
            }
        });
        Ok(())
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

    async fn migrate_session_sandbox_mode(&self) -> Result<(), StoreError> {
        sqlx::query("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sandbox_mode TEXT")
            .execute(&self.pool)
            .await?;
        add_and_validate_postgres_check(
            &self.pool,
            "sessions",
            "sessions_sandbox_mode_domain",
            "sandbox_mode IN ('workspace-write', 'danger-full-access')",
        )
        .await?;
        Ok(())
    }

    async fn migrate_session_permission_mode(&self) -> Result<(), StoreError> {
        sqlx::query("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS permission_mode TEXT")
            .execute(&self.pool)
            .await?;
        add_and_validate_postgres_check(
            &self.pool,
            "sessions",
            "sessions_permission_mode_domain",
            "permission_mode IN ('request_approval', 'auto_review', 'full_access')",
        )
        .await?;
        Ok(())
    }

    async fn migrate_session_default_target(&self) -> Result<(), StoreError> {
        sqlx::query("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS default_target_id TEXT")
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn migrate_bounded_read_model(&self) -> Result<(), StoreError> {
        for statement in [
            r#"ALTER TABLE thread_activations
               ADD COLUMN IF NOT EXISTS admission_rank SMALLINT NOT NULL DEFAULT 3
               CHECK(admission_rank BETWEEN 0 AND 4)"#,
            r#"UPDATE thread_activations AS activation
               SET admission_rank = CASE
                 WHEN event.type = 'user_message' THEN 0
                 WHEN activation.trigger_kind = 'chat/thread_completion_ready' THEN 1
                 WHEN event.objective_id IS NOT NULL
                   OR event.payload ? 'objective_evaluation_id'
                   OR left(event.topic, 10) = 'objective/' THEN 2
                 WHEN event.payload @> '{"runtime_maintenance": true}'::jsonb
                   OR event.topic IN ('runtime/context_maintenance', 'chat/context_maintenance') THEN 4
                 ELSE 3
               END
               FROM events AS event
               WHERE event.id = activation.trigger_event_id"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_activations_admission_queue
               ON thread_activations(admission_rank, created_at, id)
               WHERE status = 'queued'"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_action_groups_running_recovery
               ON action_groups(created_at, id) WHERE status = 'running'"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_delegations_parent_context_updated
               ON delegations(parent_context_id, updated_at DESC, id)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_delegations_child_context_updated
               ON delegations(child_context_id, updated_at DESC, id)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_delegations_status
               ON delegations(status, updated_at, id)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_delegations_active_updated
               ON delegations(updated_at, id)
               WHERE status IN ('queued', 'running')"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_attention_ack_context_sequence
               ON attention_acknowledgements(context_id, event_sequence, key)"#,
        ] {
            sqlx::query(statement).execute(&self.pool).await?;
        }
        Ok(())
    }

    async fn migrate_provider_accounts(&self) -> Result<(), StoreError> {
        for statement in [
            r#"CREATE TABLE IF NOT EXISTS provider_account_states (
                account_id TEXT PRIMARY KEY,
                revision BIGINT NOT NULL CHECK(revision >= 0),
                status TEXT NOT NULL,
                cooldown_until TEXT,
                last_error_kind TEXT,
                last_used_at TEXT,
                updated_at TEXT NOT NULL
            )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_provider_account_states_status
                ON provider_account_states(status, cooldown_until, last_used_at)"#,
            r#"CREATE TABLE IF NOT EXISTS provider_route_account_states (
                route_id TEXT NOT NULL,
                account_id TEXT NOT NULL,
                revision BIGINT NOT NULL CHECK(revision >= 0),
                status TEXT NOT NULL,
                cooldown_until TEXT,
                last_error_kind TEXT,
                last_used_at TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(route_id, account_id)
            )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_provider_route_account_states_status
                ON provider_route_account_states(route_id, status, cooldown_until, last_used_at)"#,
            r#"UPDATE provider_account_states
                SET status = 'ready',
                    cooldown_until = NULL,
                    last_error_kind = NULL
                WHERE status IN ('rate_limited', 'quota_exhausted', 'cooldown')"#,
            r#"CREATE TABLE IF NOT EXISTS provider_account_affinities (
                route_id TEXT NOT NULL,
                scope_key TEXT NOT NULL,
                account_id TEXT NOT NULL,
                revision BIGINT NOT NULL CHECK(revision >= 0),
                updated_at TEXT NOT NULL,
                PRIMARY KEY(route_id, scope_key)
            )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_provider_account_affinities_account
                ON provider_account_affinities(account_id, updated_at)"#,
            r#"CREATE TABLE IF NOT EXISTS provider_refresh_leases (
                account_id TEXT PRIMARY KEY,
                generation BIGINT NOT NULL CHECK(generation > 0),
                owner_id TEXT NOT NULL,
                lease_expires_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"#,
            r#"CREATE TABLE IF NOT EXISTS provider_model_catalog (
                provider_instance_id TEXT NOT NULL,
                auth_account_id TEXT NOT NULL,
                physical_model TEXT NOT NULL,
                adapter_id TEXT NOT NULL,
                adapter_version TEXT NOT NULL,
                protocol TEXT NOT NULL,
                source TEXT NOT NULL,
                observed_at TEXT NOT NULL,
                PRIMARY KEY(provider_instance_id, auth_account_id, physical_model)
            )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_provider_model_catalog_observed
                ON provider_model_catalog(provider_instance_id, observed_at DESC, physical_model)"#,
        ] {
            sqlx::query(statement).execute(&self.pool).await?;
        }
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
                status TEXT NOT NULL DEFAULT 'active'
                    CONSTRAINT agents_status_domain
                    CHECK(status IN ('active', 'archived')),
                root_context_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"#,
            r#"CREATE TABLE IF NOT EXISTS cognitive_contexts (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL REFERENCES agents(id),
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active'
                    CONSTRAINT cognitive_contexts_status_domain
                    CHECK(status IN ('active', 'archived')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                seed_context_id TEXT,
                seed_context_version BIGINT,
                seed_snapshot_hash TEXT,
                seed_projection TEXT,
                requested_hard_token_limit BIGINT,
                token_budget_revision BIGINT NOT NULL DEFAULT 0
                    CONSTRAINT cognitive_contexts_token_budget_revision_nonnegative
                    CHECK(token_budget_revision >= 0)
            )"#,
            r#"CREATE TABLE IF NOT EXISTS context_capability_bindings (
                context_id TEXT NOT NULL REFERENCES cognitive_contexts(id) ON DELETE CASCADE,
                capability_id TEXT NOT NULL,
                enabled BOOLEAN NOT NULL,
                revision BIGINT NOT NULL CHECK(revision >= 1),
                updated_at TEXT NOT NULL,
                PRIMARY KEY(context_id, capability_id)
            )"#,
            r#"CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL REFERENCES agents(id),
                context_id TEXT NOT NULL REFERENCES cognitive_contexts(id),
                parent_session_id TEXT,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active'
                    CONSTRAINT sessions_status_domain
                    CHECK(status IN ('active', 'archived')),
                model_alias TEXT,
                reasoning_effort TEXT,
                permission_mode TEXT
                    CONSTRAINT sessions_permission_mode_domain
                    CHECK(permission_mode IN ('request_approval', 'auto_review', 'full_access')),
                sandbox_mode TEXT
                    CONSTRAINT sessions_sandbox_mode_domain
                    CHECK(sandbox_mode IN ('workspace-write', 'danger-full-access')),
                default_target_id TEXT,
                context_sharing TEXT NOT NULL DEFAULT 'shared'
                    CONSTRAINT sessions_context_sharing_domain
                    CHECK(context_sharing IN ('shared', 'isolated')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_activity_at TEXT NOT NULL,
                attention_state TEXT NOT NULL DEFAULT 'active'
                    CONSTRAINT sessions_attention_state_domain
                    CHECK(attention_state IN ('active', 'retired')),
                attention_revision BIGINT NOT NULL DEFAULT 0
                    CONSTRAINT sessions_attention_revision_nonnegative
                    CHECK(attention_revision >= 0),
                attention_reason TEXT,
                attention_changed_at TEXT,
                attention_event_id TEXT,
                mount_kind TEXT NOT NULL
                    CONSTRAINT sessions_mount_kind_domain CHECK(mount_kind IN (
                    'existing_context', 'new_blank_context',
                    'new_context_from_mind', 'delegation_projection'
                    ))
            )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_sessions_context_activity
               ON sessions(context_id, last_activity_at DESC, id)"#,
            r#"ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model_alias TEXT"#,
            r#"ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reasoning_effort TEXT"#,
            r#"ALTER TABLE sessions ADD COLUMN IF NOT EXISTS permission_mode TEXT"#,
            r#"ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sandbox_mode TEXT"#,
            r#"ALTER TABLE sessions ADD COLUMN IF NOT EXISTS default_target_id TEXT"#,
            r#"ALTER TABLE sessions ADD COLUMN IF NOT EXISTS context_sharing TEXT NOT NULL DEFAULT 'shared'"#,
            r#"CREATE TABLE IF NOT EXISTS work_assignments (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                external_id TEXT NOT NULL,
                agent_id TEXT NOT NULL REFERENCES agents(id),
                context_id TEXT NOT NULL REFERENCES cognitive_contexts(id) ON DELETE CASCADE,
                session_id TEXT NOT NULL REFERENCES sessions(id),
                role TEXT NOT NULL,
                request_id TEXT,
                objective_id TEXT,
                counterparty_id TEXT,
                summary TEXT NOT NULL,
                input_json TEXT NOT NULL,
                output_json TEXT,
                status TEXT NOT NULL CHECK(status IN (
                    'queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'
                )),
                status_reason TEXT,
                lease_expires_at TEXT NOT NULL,
                revision BIGINT NOT NULL CHECK(revision >= 1),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(kind, external_id, role, context_id)
            )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_work_assignments_context_status_updated
               ON work_assignments(context_id, status, updated_at DESC, id)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_work_assignments_agent_kind_updated
               ON work_assignments(agent_id, kind, updated_at DESC, id)"#,
            r#"CREATE TABLE IF NOT EXISTS principals (
                id TEXT PRIMARY KEY,
                provider_id TEXT NOT NULL,
                assurance TEXT NOT NULL,
                display_name TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_principals_id_lower
               ON principals(lower(id) text_pattern_ops)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_principals_display_name_lower
               ON principals(lower(display_name) text_pattern_ops)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_principals_provider_id_lower
               ON principals(lower(provider_id) text_pattern_ops)"#,
            r#"CREATE TABLE IF NOT EXISTS session_principal_bindings (
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
                bound_at TEXT NOT NULL,
                unbound_at TEXT,
                PRIMARY KEY(session_id, principal_id)
            )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_session_principal_bindings_principal
               ON session_principal_bindings(principal_id, unbound_at, session_id)"#,
            r#"CREATE TABLE IF NOT EXISTS principal_context_encounters (
                context_id TEXT NOT NULL REFERENCES cognitive_contexts(id) ON DELETE CASCADE,
                principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
                encounter_id TEXT NOT NULL UNIQUE,
                first_event_id TEXT NOT NULL,
                first_session_id TEXT NOT NULL,
                first_seen_at TEXT NOT NULL,
                PRIMARY KEY(context_id, principal_id)
            )"#,
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
            r#"CREATE INDEX IF NOT EXISTS idx_pg_events_session_topic_sequence
               ON events(session_id, topic, sequence DESC)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_events_topic_sequence
               ON events(topic, sequence)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_events_context_topic_time
               ON events(context_id, topic, timestamp, sequence)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_events_context_session_topic_thread_time
               ON events(context_id, session_id, topic, thread_id, timestamp, sequence)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_events_activation_topic_sequence
               ON events(activation_id, topic, sequence)"#,
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
                session_id TEXT,
                event_sequence BIGINT NOT NULL
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
                generation BIGINT NOT NULL DEFAULT 1 CHECK(generation >= 1),
                status TEXT NOT NULL,
                status_reason TEXT,
                wait_condition_json JSONB,
                completion_intent_json JSONB,
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
            r#"CREATE INDEX IF NOT EXISTS idx_pg_objectives_coordinator_status
               ON objectives(coordinator_session_id, status)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_objectives_delivery_status
               ON objectives(delivery_session_id, status)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_objectives_recovery
               ON objectives(status, evaluation_lease_expires_at, updated_at)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_objectives_recoverable_created
               ON objectives(created_at, id)
               WHERE status IN ('active', 'paused', 'blocked')
                  OR active_evaluation_id IS NOT NULL"#,
            r#"ALTER TABLE objectives
               ADD COLUMN IF NOT EXISTS initiating_principal_id TEXT"#,
            r#"ALTER TABLE objectives
               ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1"#,
            r#"ALTER TABLE objectives
               ADD COLUMN IF NOT EXISTS completion_intent_json JSONB"#,
        ] {
            sqlx::query(statement).execute(&self.pool).await?;
        }
        Ok(())
    }

    async fn migrate_work_assignments(&self) -> Result<(), StoreError> {
        for statement in [
            r#"CREATE TABLE IF NOT EXISTS work_assignments (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                external_id TEXT NOT NULL,
                agent_id TEXT NOT NULL REFERENCES agents(id),
                context_id TEXT NOT NULL REFERENCES cognitive_contexts(id) ON DELETE CASCADE,
                session_id TEXT NOT NULL REFERENCES sessions(id),
                role TEXT NOT NULL,
                request_id TEXT,
                objective_id TEXT,
                counterparty_id TEXT,
                summary TEXT NOT NULL,
                input_json TEXT NOT NULL,
                output_json TEXT,
                status TEXT NOT NULL CHECK(status IN (
                    'queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'
                )),
                status_reason TEXT,
                lease_expires_at TEXT NOT NULL,
                revision BIGINT NOT NULL CHECK(revision >= 1),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(kind, external_id, role, context_id)
            )"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_work_assignments_context_status_updated
               ON work_assignments(context_id, status, updated_at DESC, id)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_work_assignments_agent_kind_updated
               ON work_assignments(agent_id, kind, updated_at DESC, id)"#,
        ] {
            sqlx::query(statement).execute(&self.pool).await?;
        }
        Ok(())
    }

    async fn migrate_work_assignment_leases(&self) -> Result<(), StoreError> {
        for statement in [
            r#"ALTER TABLE work_assignments
               ADD COLUMN IF NOT EXISTS lease_expires_at TEXT"#,
            r#"UPDATE work_assignments
               SET lease_expires_at = updated_at
               WHERE lease_expires_at IS NULL"#,
            r#"ALTER TABLE work_assignments
               ALTER COLUMN lease_expires_at SET NOT NULL"#,
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
                 search_term_keys TEXT[] NOT NULL DEFAULT '{}',
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
            "ALTER TABLE recall_documents ADD COLUMN IF NOT EXISTS search_term_keys TEXT[] NOT NULL DEFAULT '{}'",
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

    /// Removes the temporary physical chunk layer while preserving every
    /// bounded previews remain a query concern rather than a storage limit.
    async fn migrate_recall_whole_document_index(&self) -> Result<(), StoreError> {
        const PAGE: i64 = 250;
        let mut tx = self.pool.begin().await?;
        let chunks_exist = sqlx::query_scalar::<_, bool>(
            "SELECT to_regclass('recall_document_chunks') IS NOT NULL",
        )
        .fetch_one(&mut *tx)
        .await?;
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
            .fetch_all(&mut *tx)
            .await?;
            if page.is_empty() {
                break;
            }
            let first = &page[0];
            let last = &page[page.len() - 1];
            let mut legacy_by_document =
                std::collections::HashMap::<(String, String, String), Vec<String>>::new();
            if chunks_exist {
                let chunk_rows = sqlx::query(
                    r#"SELECT context_id, document_kind, document_id, searchable_text
                       FROM recall_document_chunks
                       WHERE (context_id, document_kind, document_id) >= ($1, $2, $3)
                         AND (context_id, document_kind, document_id) <= ($4, $5, $6)
                       ORDER BY context_id, document_kind, document_id, chunk_index"#,
                )
                .bind(first.get::<String, _>("context_id"))
                .bind(first.get::<String, _>("document_kind"))
                .bind(first.get::<String, _>("document_id"))
                .bind(last.get::<String, _>("context_id"))
                .bind(last.get::<String, _>("document_kind"))
                .bind(last.get::<String, _>("document_id"))
                .fetch_all(&mut *tx)
                .await?;
                for row in chunk_rows {
                    legacy_by_document
                        .entry((
                            row.get("context_id"),
                            row.get("document_kind"),
                            row.get("document_id"),
                        ))
                        .or_default()
                        .push(row.get("searchable_text"));
                }
            }
            for row in &page {
                let context_id = row.get::<String, _>("context_id");
                let document_kind = row.get::<String, _>("document_kind");
                let document_id = row.get::<String, _>("document_id");
                let stored = row.get::<String, _>("searchable_text");
                let key = (
                    context_id.clone(),
                    document_kind.clone(),
                    document_id.clone(),
                );
                let searchable_text = legacy_by_document
                    .remove(&key)
                    .filter(|chunks| !chunks.is_empty())
                    .map(|chunks| crate::memory::lexical::merge_legacy_recall_chunks(&chunks))
                    .unwrap_or_else(|| crate::memory::segment_recall_text(&stored));
                let retired = row.get::<bool, _>("retired");
                let search_term_keys =
                    crate::memory::lexical::recall_term_keys(searchable_text.split_whitespace());
                sqlx::query(
                    r#"UPDATE recall_documents
                       SET searchable_text = $1, search_term_keys = $2, state_hash = $3
                       WHERE context_id = $4 AND document_kind = $5 AND document_id = $6"#,
                )
                .bind(&searchable_text)
                .bind(&search_term_keys)
                .bind(crate::memory::recall_state_hash(&searchable_text, retired))
                .bind(&context_id)
                .bind(&document_kind)
                .bind(&document_id)
                .execute(&mut *tx)
                .await?;
            }
            cursor = Some((
                last.get("context_id"),
                last.get("document_kind"),
                last.get("document_id"),
            ));
        }
        // Historical Frame projections cannot be repaired from persisted Events alone.
        // Re-derive them from the authoritative current Mind before retiring
        // the temporary chunk table.
        let mind_rows = sqlx::query("SELECT context_id, state_json FROM mind_projections")
            .fetch_all(&mut *tx)
            .await?;
        for row in mind_rows {
            let context_id = row.get::<String, _>("context_id");
            let state = match serde_json::from_value::<crate::orchestrator::context::MindState>(
                row.get::<JsonValue, _>("state_json"),
            ) {
                Ok(state) => state,
                Err(error) => {
                    tracing::warn!(event_code = "memory.postgres.legacy_mind_projection_decode_failed", %context_id, error = %error, "Legacy Mind Projection could not be reconstructed as a cognitive frame; retaining the collapsed Recall Frame projection");
                    continue;
                }
            };
            sqlx::query(
                "DELETE FROM recall_documents WHERE context_id = $1 AND document_kind = 'frame'",
            )
            .bind(&context_id)
            .execute(&mut *tx)
            .await?;
            for document in
                crate::orchestrator::context::all_frame_recall_documents(&context_id, &state)
            {
                upsert_recall_document_in_tx(&mut tx, &document).await?;
            }
        }
        sqlx::query("DROP INDEX IF EXISTS idx_pg_recall_chunks_tsv")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DROP TABLE IF EXISTS recall_document_chunks")
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    async fn enqueue_recall_whole_document_event_backfill(&self) -> Result<(), StoreError> {
        if sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = '20260805_02_recall_chunk_event_backfill'",
        )
        .fetch_one(&self.pool)
        .await?
            > 0
        {
            return Ok(());
        }
        let now = now_text();
        sqlx::query(
            r#"INSERT INTO recall_projection_outbox
               (context_id, document_kind, document_id, generation, document_json,
                status, attempts, available_at, claimed_by, claim_expires_at,
                last_error, created_at, updated_at)
               SELECT e.context_id, 'event', e.id, GREATEST(e.sequence, 1),
                      jsonb_build_object('retired', COALESCE(d.retired, FALSE)),
                      'pending', 0, $1, NULL, NULL, NULL, $1, $1
               FROM events e
               LEFT JOIN recall_documents d
                 ON d.context_id = e.context_id AND d.document_kind = 'event'
                AND d.document_id = e.id
               WHERE e.context_id IS NOT NULL
                 AND e.topic IN (
                   'chat/user_message', 'chat/reply', 'chat/tool_output',
                   'chat/file_change', 'chat/outbound_message',
                   'chat/context_tx_committed', 'runtime/thread_result',
                   'runtime/delegation_result'
                 )
               ON CONFLICT(context_id, document_kind, document_id) DO NOTHING"#,
        )
        .bind(&now)
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
            r#"CREATE INDEX IF NOT EXISTS idx_pg_attention_ack_context_sequence
               ON attention_acknowledgements(context_id, event_sequence, key)"#,
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
            r#"CREATE INDEX IF NOT EXISTS idx_pg_principals_id_lower
               ON principals(lower(id) text_pattern_ops)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_principals_display_name_lower
               ON principals(lower(display_name) text_pattern_ops)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_principals_provider_id_lower
               ON principals(lower(provider_id) text_pattern_ops)"#,
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

    async fn migrate_principal_context_encounters(&self) -> Result<(), StoreError> {
        sqlx::query(
            r#"CREATE TABLE IF NOT EXISTS principal_context_encounters (
                context_id TEXT NOT NULL REFERENCES cognitive_contexts(id) ON DELETE CASCADE,
                principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
                encounter_id TEXT NOT NULL UNIQUE,
                first_event_id TEXT NOT NULL,
                first_session_id TEXT NOT NULL,
                first_seen_at TEXT NOT NULL,
                PRIMARY KEY(context_id, principal_id)
            )"#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"INSERT INTO principal_context_encounters
               (context_id, principal_id, encounter_id, first_event_id, first_session_id, first_seen_at)
               SELECT first_event.context_id,
                      first_event.principal_id,
                      'principal_encounter_' || first_event.id,
                      first_event.id,
                      first_event.session_id,
                      first_event.timestamp
               FROM (
                   SELECT DISTINCT ON (context_id, payload->>'principal_id')
                          context_id, payload->>'principal_id' AS principal_id,
                          id, session_id, timestamp
                   FROM events
                   WHERE topic = 'chat/user_message'
                     AND context_id IS NOT NULL
                     AND session_id IS NOT NULL
                     AND jsonb_typeof(payload->'principal_id') = 'string'
                   ORDER BY context_id, payload->>'principal_id', sequence
               ) first_event
               ON CONFLICT(context_id, principal_id) DO NOTHING"#,
        )
        .execute(&self.pool)
        .await?;
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

    async fn migrate_context_token_budget(&self) -> Result<(), StoreError> {
        for statement in [
            "ALTER TABLE cognitive_contexts ADD COLUMN IF NOT EXISTS requested_hard_token_limit BIGINT",
            "ALTER TABLE cognitive_contexts ADD COLUMN IF NOT EXISTS token_budget_revision BIGINT NOT NULL DEFAULT 0",
            "ALTER TABLE cognitive_contexts DROP CONSTRAINT IF EXISTS cognitive_contexts_requested_hard_token_limit_check",
            "ALTER TABLE cognitive_contexts ADD CONSTRAINT cognitive_contexts_requested_hard_token_limit_check CHECK (requested_hard_token_limit IS NULL OR requested_hard_token_limit > 0)",
            "ALTER TABLE cognitive_contexts DROP CONSTRAINT IF EXISTS cognitive_contexts_token_budget_revision_check",
            "ALTER TABLE cognitive_contexts ADD CONSTRAINT cognitive_contexts_token_budget_revision_check CHECK (token_budget_revision >= 0)",
        ] {
            sqlx::query(statement).execute(&self.pool).await?;
        }
        Ok(())
    }

    /// Builds the lexical Recall index.
    ///
    /// The Runtime segments text before storage. PostgreSQL indexes the
    /// complete document's fixed-width term keys with its built-in GIN array
    /// operator class: no extension is required, CJK terms remain exact after
    /// candidate verification, and neither document nor term length leaks a
    /// PostgreSQL index limit into the Recall data model.
    async fn ensure_recall_search_acceleration(&self) -> Result<(), StoreError> {
        if let Err(error) = sqlx::query(
            r#"CREATE INDEX IF NOT EXISTS idx_pg_recall_documents_terms
               ON recall_documents USING GIN (search_term_keys)"#,
        )
        .execute(&self.pool)
        .await
        {
            tracing::warn!(
                error = %error,
                event_code = "memory.postgres.recall_index_create_failed",
                "PostgreSQL could not create the Recall full-text index; Recall is limited to exact document-ID queries"
            );
            return Ok(());
        }
        // The substring index this replaces is dead weight once queries match
        // whole segmented terms.
        for index in [
            "idx_pg_recall_documents_trgm",
            "idx_pg_recall_documents_tsv",
            "idx_pg_recall_chunks_tsv",
        ] {
            if let Err(error) = sqlx::query(&format!("DROP INDEX IF EXISTS {index}"))
                .execute(&self.pool)
                .await
            {
                tracing::warn!(event_code = "memory.postgres.legacy_recall_index_drop_failed", %index, error = %error, "PostgreSQL could not remove a legacy Recall index");
            }
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
            r#"INSERT INTO session_projections
               (event_id, context_id, session_id, event_sequence)
               SELECT id, context_id, session_id, sequence
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
                     AND left(COALESCE(payload->>'text', ''), 22) <> 'Tool execution failed:'
                     AND left(COALESCE(payload->>'text', ''), 24) <> 'Tool execution rejected:'
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

    async fn migrate_tool_call_history(&self) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        let active_tool_calls = r#"e.topic = 'chat/assistant_call'
            AND jsonb_typeof(e.payload->'tool_calls') = 'array'
            AND jsonb_array_length(e.payload->'tool_calls') > 0
            AND NOT EXISTS (
                SELECT 1
                FROM mind_projections m,
                     jsonb_array_elements_text(
                         COALESCE(m.state_json->'retired', '[]'::jsonb)
                     ) retired(event_id)
                WHERE m.context_id = e.context_id AND retired.event_id = e.id
            )"#;
        sqlx::query(&format!(
            r#"INSERT INTO session_projections
               (event_id, context_id, session_id, event_sequence)
               SELECT e.id, e.context_id, e.session_id, e.sequence
               FROM events e
               WHERE e.context_id IS NOT NULL AND e.session_id IS NOT NULL
                 AND {active_tool_calls}
               ON CONFLICT(event_id) DO NOTHING"#,
        ))
        .execute(&mut *tx)
        .await?;

        let now = now_text();
        sqlx::query(&format!(
            r#"INSERT INTO recall_projection_outbox
               (context_id, document_kind, document_id, generation, document_json,
                status, attempts, available_at, claimed_by, claim_expires_at,
                last_error, created_at, updated_at)
               SELECT e.context_id, 'event', e.id, GREATEST(e.sequence, 1),
                      jsonb_build_object('retired', FALSE),
                      'pending', 0, $1, NULL, NULL, NULL, $1, $1
               FROM events e
               WHERE e.context_id IS NOT NULL AND {active_tool_calls}
               ON CONFLICT(context_id, document_kind, document_id) DO NOTHING"#,
        ))
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    async fn migrate_session_projection_sequences(&self) -> Result<(), StoreError> {
        sqlx::query(
            "ALTER TABLE session_projections ADD COLUMN IF NOT EXISTS event_sequence BIGINT",
        )
        .execute(&self.pool)
        .await?;
        loop {
            let updated = sqlx::query(
                r#"WITH page AS (
                     SELECT event_id FROM session_projections
                     WHERE event_sequence IS NULL
                     ORDER BY event_id
                     LIMIT 1000
                   )
                   UPDATE session_projections projection
                   SET event_sequence = events.sequence
                   FROM events, page
                   WHERE projection.event_id = page.event_id
                     AND events.id = projection.event_id"#,
            )
            .execute(&self.pool)
            .await?
            .rows_affected();
            if updated == 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
        sqlx::query(
            r#"CREATE INDEX IF NOT EXISTS idx_pg_session_projections_context_session_sequence
               ON session_projections(context_id, session_id, event_sequence)"#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query("ALTER TABLE session_projections ALTER COLUMN event_sequence SET NOT NULL")
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn migrate_sql_performance_indexes(&self) -> Result<(), StoreError> {
        for statement in [
            r#"CREATE INDEX IF NOT EXISTS idx_pg_threads_context_open_created
               ON threads(context_id, created_at, id) WHERE status = 'open'"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_threads_open_updated
               ON threads(updated_at, id) WHERE status = 'open'"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_activations_context_active_created
               ON thread_activations(context_id, created_at, id)
               WHERE status IN ('queued', 'running')"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_activations_active_updated
               ON thread_activations(updated_at, id)
               WHERE status IN ('queued', 'running')"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_execution_jobs_context_active_created
               ON execution_jobs(context_id, created_at, id)
               WHERE status IN ('queued', 'waiting_approval', 'running')"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_execution_jobs_tool_status
               ON execution_jobs(tool_name, status, created_at, id)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_plan_executions_wait_kind
               ON plan_executions(pending_kind, status, lease_expires_at, created_at, id)"#,
            r#"CREATE INDEX IF NOT EXISTS idx_pg_execution_targets_kind_provider_status
               ON execution_targets(kind, provider_node_id, status, updated_at, id)"#,
        ] {
            sqlx::query(statement).execute(&self.pool).await?;
        }
        Ok(())
    }

    /// Installs the same directory-domain invariants enforced by SQLite on
    /// existing PostgreSQL databases. Constraints are added NOT VALID first so
    /// the schema change takes only a brief metadata lock; VALIDATE then scans
    /// existing rows without blocking concurrent writes.
    async fn migrate_directory_domain_constraints(&self) -> Result<(), StoreError> {
        for (table, constraint, expression) in [
            (
                "agents",
                "agents_status_domain",
                "status IN ('active', 'archived')",
            ),
            (
                "cognitive_contexts",
                "cognitive_contexts_status_domain",
                "status IN ('active', 'archived')",
            ),
            (
                "cognitive_contexts",
                "cognitive_contexts_token_budget_revision_nonnegative",
                "token_budget_revision >= 0",
            ),
            (
                "sessions",
                "sessions_status_domain",
                "status IN ('active', 'archived')",
            ),
            (
                "sessions",
                "sessions_attention_state_domain",
                "attention_state IN ('active', 'retired')",
            ),
            (
                "sessions",
                "sessions_context_sharing_domain",
                "context_sharing IN ('shared', 'isolated')",
            ),
            (
                "sessions",
                "sessions_attention_revision_nonnegative",
                "attention_revision >= 0",
            ),
            (
                "sessions",
                "sessions_mount_kind_domain",
                "mount_kind IN ('existing_context', 'new_blank_context', 'new_context_from_mind', 'delegation_projection')",
            ),
        ] {
            sqlx::query(&format!(
                r#"DO $$
                   BEGIN
                     IF NOT EXISTS (
                       SELECT 1 FROM pg_constraint
                       WHERE conname = '{constraint}'
                         AND conrelid = '{table}'::regclass
                     ) THEN
                       ALTER TABLE {table}
                         ADD CONSTRAINT {constraint} CHECK ({expression}) NOT VALID;
                     END IF;
                   END
                   $$"#,
            ))
            .execute(&self.pool)
            .await?;
            sqlx::query(&format!(
                "ALTER TABLE {table} VALIDATE CONSTRAINT {constraint}"
            ))
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    /// Brings PostgreSQL's persisted Runtime domains in line with SQLite.
    ///
    /// The Rust decoders already reject values outside these domains, but a
    /// database constraint is the last line of defence for manual SQL,
    /// partially-upgraded deployments, and future write paths. Historical
    /// Activation spellings are canonicalized before validation; no business
    /// record is discarded by this migration.
    async fn migrate_core_domain_constraints(&self) -> Result<(), StoreError> {
        for statement in [
            r#"UPDATE threads
               SET kind = CASE kind
                   WHEN 'dialogue' THEN 'dialogue_turn'
                   WHEN 'work' THEN 'execution'
                   WHEN 'objective' THEN 'execution'
                   WHEN 'delegation' THEN 'execution'
                   ELSE kind
               END,
                   status = CASE status
                   WHEN 'active' THEN 'open'
                   WHEN 'waiting' THEN 'open'
                   ELSE status
               END
               WHERE kind IN ('dialogue', 'work', 'objective', 'delegation')
                  OR status IN ('active', 'waiting')"#,
            r#"UPDATE thread_activations
               SET status = 'completed'
               WHERE status IN ('waiting_tool', 'waiting_external', 'succeeded')"#,
        ] {
            sqlx::query(statement).execute(&self.pool).await?;
        }

        for (table, constraint, expression) in [
            (
                "signal_outbox",
                "signal_outbox_status_domain",
                "status IN ('pending', 'materialized', 'discarded')",
            ),
            (
                "runtime_timers",
                "runtime_timers_generation_nonnegative",
                "generation >= 0",
            ),
            (
                "runtime_timers",
                "runtime_timers_kind_domain",
                "kind IN ('schedule', 'objective_wait', 'objective_lease', 'background_wake', 'thread_wait', 'activation_lease', 'delivery_flush')",
            ),
            (
                "runtime_timers",
                "runtime_timers_status_domain",
                "status IN ('pending', 'claimed', 'fired', 'cancelled')",
            ),
            (
                "objectives",
                "objectives_revision_positive",
                "revision >= 1",
            ),
            (
                "objectives",
                "objectives_status_domain",
                "status IN ('active', 'paused', 'blocked', 'completed', 'cancelled', 'failed')",
            ),
            (
                "objectives",
                "objectives_continuation_sequence_nonnegative",
                "continuation_sequence >= 0",
            ),
            (
                "objectives",
                "objectives_tokens_used_nonnegative",
                "tokens_used >= 0",
            ),
            (
                "objectives",
                "objectives_time_used_seconds_nonnegative",
                "time_used_seconds >= 0",
            ),
            ("threads", "threads_revision_positive", "revision >= 1"),
            (
                "threads",
                "threads_generation_positive",
                "generation >= 1",
            ),
            (
                "threads",
                "threads_kind_domain",
                "kind IN ('dialogue_turn', 'execution', 'delivery')",
            ),
            (
                "threads",
                "threads_status_domain",
                "status IN ('open', 'completed', 'failed', 'cancelled')",
            ),
            (
                "threads",
                "threads_control_state_domain",
                "control_state IN ('active', 'paused')",
            ),
            (
                "threads",
                "threads_lifetime_domain",
                "lifetime IN ('attached', 'durable', 'disposable')",
            ),
            (
                "threads",
                "threads_supervisor_kind_domain",
                "supervisor_kind IN ('thread', 'evaluation', 'objective', 'runtime', 'none', 'legacy')",
            ),
            (
                "threads",
                "threads_supervision_generation_positive",
                "supervision_generation >= 1",
            ),
            (
                "threads",
                "threads_delivery_status_domain",
                "delivery_status IN ('none', 'pending', 'deferred', 'delivered')",
            ),
            (
                "thread_activations",
                "thread_activations_revision_positive",
                "revision >= 1",
            ),
            (
                "thread_activations",
                "thread_activations_generation_positive",
                "generation >= 1",
            ),
            (
                "thread_activations",
                "thread_activations_trigger_sequence_nonnegative",
                "trigger_sequence >= 0",
            ),
            (
                "thread_activations",
                "thread_activations_status_domain",
                "status IN ('queued', 'running', 'completed', 'cancelled', 'failed')",
            ),
            (
                "execution_jobs",
                "execution_jobs_revision_positive",
                "revision >= 1",
            ),
            (
                "execution_jobs",
                "execution_jobs_status_domain",
                "status IN ('queued', 'waiting_approval', 'running', 'succeeded', 'failed', 'cancelled', 'lost')",
            ),
            (
                "execution_jobs",
                "execution_jobs_retry_safety_domain",
                "retry_safety IN ('idempotent', 'reconcile_required', 'at_most_once')",
            ),
            (
                "action_groups",
                "action_groups_revision_positive",
                "revision >= 1",
            ),
            (
                "action_groups",
                "action_groups_status_domain",
                "status IN ('running', 'settled', 'cancelled', 'lost')",
            ),
            (
                "action_group_members",
                "action_group_members_status_domain",
                "status IN ('pending', 'succeeded', 'failed', 'cancelled', 'lost', 'skipped')",
            ),
            (
                "action_group_members",
                "action_group_members_result_invariant",
                "(status = 'pending' AND result_event_id IS NULL) OR (status <> 'pending' AND result_event_id IS NOT NULL)",
            ),
            (
                "approval_requests",
                "approval_requests_revision_positive",
                "revision >= 1",
            ),
            (
                "approval_requests",
                "approval_requests_status_domain",
                "status IN ('pending_auto', 'pending_human', 'allowed', 'denied', 'cancelled')",
            ),
        ] {
            add_and_validate_postgres_check(&self.pool, table, constraint, expression).await?;
        }

        add_and_validate_postgres_foreign_key(
            &self.pool,
            "sessions",
            "sessions_parent_session_fk",
            "FOREIGN KEY (parent_session_id) REFERENCES sessions(id)",
        )
        .await?;
        Ok(())
    }
}

async fn add_and_validate_postgres_check(
    pool: &PgPool,
    table: &str,
    constraint: &str,
    expression: &str,
) -> Result<(), StoreError> {
    add_and_validate_postgres_constraint(pool, table, constraint, &format!("CHECK ({expression})"))
        .await
}

async fn add_and_validate_postgres_foreign_key(
    pool: &PgPool,
    table: &str,
    constraint: &str,
    definition: &str,
) -> Result<(), StoreError> {
    add_and_validate_postgres_constraint(pool, table, constraint, definition).await
}

async fn add_and_validate_postgres_constraint(
    pool: &PgPool,
    table: &str,
    constraint: &str,
    definition: &str,
) -> Result<(), StoreError> {
    // Every caller supplies compile-time identifiers and SQL fragments. Keep
    // the helper private so dynamic/user input can never reach this DDL.
    sqlx::query(&format!(
        r#"DO $$
           BEGIN
             IF NOT EXISTS (
               SELECT 1 FROM pg_constraint
               WHERE conname = '{constraint}'
                 AND conrelid = '{table}'::regclass
             ) THEN
               ALTER TABLE {table}
                 ADD CONSTRAINT {constraint} {definition} NOT VALID;
             END IF;
           END
           $$"#,
    ))
    .execute(pool)
    .await?;
    sqlx::query(&format!(
        "ALTER TABLE {table} VALIDATE CONSTRAINT {constraint}"
    ))
    .execute(pool)
    .await?;
    Ok(())
}

fn provider_account_state_from_pg_row(
    row: &PgRow,
) -> Result<ProviderAccountStateRecord, StoreError> {
    Ok(ProviderAccountStateRecord {
        account_id: row.get("account_id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        status: ProviderAccountStatus::parse(&row.get::<String, _>("status"))?,
        cooldown_until: row
            .get::<Option<String>, _>("cooldown_until")
            .map(|value| parse_time(&value))
            .transpose()?,
        last_error_kind: row.get("last_error_kind"),
        last_used_at: row
            .get::<Option<String>, _>("last_used_at")
            .map(|value| parse_time(&value))
            .transpose()?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
    })
}

fn provider_route_account_state_from_pg_row(
    row: &PgRow,
) -> Result<ProviderRouteAccountStateRecord, StoreError> {
    Ok(ProviderRouteAccountStateRecord {
        route_id: row.get("route_id"),
        account_id: row.get("account_id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        status: ProviderAccountStatus::parse(&row.get::<String, _>("status"))?,
        cooldown_until: row
            .get::<Option<String>, _>("cooldown_until")
            .map(|value| parse_time(&value))
            .transpose()?,
        last_error_kind: row.get("last_error_kind"),
        last_used_at: row
            .get::<Option<String>, _>("last_used_at")
            .map(|value| parse_time(&value))
            .transpose()?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
    })
}

fn provider_account_affinity_from_pg_row(
    row: &PgRow,
) -> Result<ProviderAccountAffinityRecord, StoreError> {
    Ok(ProviderAccountAffinityRecord {
        route_id: row.get("route_id"),
        scope_key: row.get("scope_key"),
        account_id: row.get("account_id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
    })
}

fn provider_refresh_lease_from_pg_row(
    row: &PgRow,
) -> Result<ProviderRefreshLeaseRecord, StoreError> {
    Ok(ProviderRefreshLeaseRecord {
        account_id: row.get("account_id"),
        generation: u64::try_from(row.get::<i64, _>("generation"))?,
        owner_id: row.get("owner_id"),
        lease_expires_at: parse_time(&row.get::<String, _>("lease_expires_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
    })
}

fn provider_model_catalog_from_pg_row(
    row: &PgRow,
) -> Result<ProviderModelCatalogRecord, StoreError> {
    Ok(ProviderModelCatalogRecord {
        provider_instance_id: row.get("provider_instance_id"),
        auth_account_id: row.get("auth_account_id"),
        physical_model: row.get("physical_model"),
        adapter_id: row.get("adapter_id"),
        adapter_version: row.get("adapter_version"),
        protocol: row.get("protocol"),
        source: row.get("source"),
        observed_at: parse_time(&row.get::<String, _>("observed_at"))?,
    })
}

#[async_trait::async_trait]
impl ProviderModelCatalogStore for PostgresStore {
    async fn replace_provider_model_catalog(
        &self,
        provider_instance_id: &str,
        auth_account_id: &str,
        adapter_id: &str,
        adapter_version: &str,
        protocol: &str,
        source: &str,
        physical_models: &[String],
        observed_at: DateTime<Utc>,
    ) -> Result<Vec<ProviderModelCatalogRecord>, StoreError> {
        if provider_instance_id.trim().is_empty() || auth_account_id.trim().is_empty() {
            return Err("Provider Instance 与 Auth Account ID 不能为空".into());
        }
        let mut models = physical_models
            .iter()
            .map(|model| model.trim().to_string())
            .filter(|model| !model.is_empty())
            .collect::<Vec<_>>();
        models.sort();
        models.dedup();
        let observed_at = observed_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "DELETE FROM provider_model_catalog WHERE provider_instance_id = $1 AND auth_account_id = $2",
        )
        .bind(provider_instance_id)
        .bind(auth_account_id)
        .execute(&mut *tx)
        .await?;
        for model in &models {
            sqlx::query(
                r#"INSERT INTO provider_model_catalog
                   (provider_instance_id, auth_account_id, physical_model, adapter_id,
                    adapter_version, protocol, source, observed_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"#,
            )
            .bind(provider_instance_id)
            .bind(auth_account_id)
            .bind(model)
            .bind(adapter_id)
            .bind(adapter_version)
            .bind(protocol)
            .bind(source)
            .bind(&observed_at)
            .execute(&mut *tx)
            .await?;
        }
        let rows = sqlx::query(
            r#"SELECT * FROM provider_model_catalog
               WHERE provider_instance_id = $1 AND auth_account_id = $2
               ORDER BY physical_model"#,
        )
        .bind(provider_instance_id)
        .bind(auth_account_id)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        rows.iter()
            .map(provider_model_catalog_from_pg_row)
            .collect()
    }

    async fn list_provider_model_catalog(
        &self,
    ) -> Result<Vec<ProviderModelCatalogRecord>, StoreError> {
        let rows = sqlx::query(
            r#"SELECT * FROM provider_model_catalog
               ORDER BY provider_instance_id, auth_account_id, physical_model"#,
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(provider_model_catalog_from_pg_row)
            .collect()
    }
}

#[async_trait::async_trait]
impl ProviderAccountStateStore for PostgresStore {
    async fn get_provider_account_state(
        &self,
        account_id: &str,
    ) -> Result<Option<ProviderAccountStateRecord>, StoreError> {
        let row = sqlx::query("SELECT * FROM provider_account_states WHERE account_id = $1")
            .bind(account_id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref()
            .map(provider_account_state_from_pg_row)
            .transpose()
    }

    async fn put_provider_account_state(
        &self,
        account_id: &str,
        expected_revision: Option<u64>,
        status: ProviderAccountStatus,
        cooldown_until: Option<DateTime<Utc>>,
        last_error_kind: Option<&str>,
        mark_used: bool,
    ) -> Result<ProviderAccountStateRecord, StoreError> {
        if account_id.trim().is_empty() {
            return Err("Provider Account ID 不能为空".into());
        }
        let mut tx = self.pool.begin().await?;
        let current = sqlx::query(
            "SELECT revision FROM provider_account_states WHERE account_id = $1 FOR UPDATE",
        )
        .bind(account_id)
        .fetch_optional(&mut *tx)
        .await?;
        let current_revision = current
            .as_ref()
            .map(|row| u64::try_from(row.get::<i64, _>("revision")))
            .transpose()?;
        if expected_revision.is_some() && expected_revision != current_revision {
            return Err(format!(
                "Provider Account '{account_id}' revision 冲突：期望 {:?}，当前 {:?}",
                expected_revision, current_revision
            )
            .into());
        }
        let next_revision = current_revision.unwrap_or_default().saturating_add(1);
        let now = now_text();
        let cooldown =
            cooldown_until.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        let row = sqlx::query(
            r#"INSERT INTO provider_account_states
               (account_id, revision, status, cooldown_until, last_error_kind, last_used_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $6)
               ON CONFLICT(account_id) DO UPDATE SET
                 revision = EXCLUDED.revision,
                 status = EXCLUDED.status,
                 cooldown_until = EXCLUDED.cooldown_until,
                 last_error_kind = EXCLUDED.last_error_kind,
                 last_used_at = CASE WHEN $7 THEN EXCLUDED.last_used_at ELSE provider_account_states.last_used_at END,
                 updated_at = EXCLUDED.updated_at
               RETURNING *"#,
        )
        .bind(account_id)
        .bind(i64::try_from(next_revision)?)
        .bind(status.as_str())
        .bind(cooldown)
        .bind(last_error_kind)
        .bind(now)
        .bind(mark_used)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        provider_account_state_from_pg_row(&row)
    }

    async fn compare_and_set_provider_account_state(
        &self,
        account_id: &str,
        expected_revision: Option<u64>,
        status: ProviderAccountStatus,
        cooldown_until: Option<DateTime<Utc>>,
        last_error_kind: Option<&str>,
        mark_used: bool,
    ) -> Result<ProviderAccountStateRecord, StoreError> {
        if account_id.trim().is_empty() {
            return Err("Provider Account ID 不能为空".into());
        }
        let now = now_text();
        let cooldown =
            cooldown_until.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        let row = if let Some(expected_revision) = expected_revision {
            sqlx::query(
                r#"UPDATE provider_account_states SET
                     revision = revision + 1,
                     status = $1,
                     cooldown_until = $2,
                     last_error_kind = $3,
                     last_used_at = CASE WHEN $4 THEN $5 ELSE last_used_at END,
                     updated_at = $5
                   WHERE account_id = $6 AND revision = $7
                   RETURNING *"#,
            )
            .bind(status.as_str())
            .bind(cooldown)
            .bind(last_error_kind)
            .bind(mark_used)
            .bind(&now)
            .bind(account_id)
            .bind(i64::try_from(expected_revision)?)
            .fetch_optional(&self.pool)
            .await?
        } else {
            sqlx::query(
                r#"INSERT INTO provider_account_states
                   (account_id, revision, status, cooldown_until, last_error_kind, last_used_at, updated_at)
                   VALUES ($1, 1, $2, $3, $4, $5, $5)
                   ON CONFLICT(account_id) DO NOTHING
                   RETURNING *"#,
            )
            .bind(account_id)
            .bind(status.as_str())
            .bind(cooldown)
            .bind(last_error_kind)
            .bind(&now)
            .fetch_optional(&self.pool)
            .await?
        };
        let Some(row) = row else {
            return Err(format!(
                "Provider Account '{account_id}' revision 冲突：期望 {:?}",
                expected_revision
            )
            .into());
        };
        provider_account_state_from_pg_row(&row)
    }

    async fn get_provider_route_account_state(
        &self,
        route_id: &str,
        account_id: &str,
    ) -> Result<Option<ProviderRouteAccountStateRecord>, StoreError> {
        let row = sqlx::query(
            "SELECT * FROM provider_route_account_states WHERE route_id = $1 AND account_id = $2",
        )
        .bind(route_id)
        .bind(account_id)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref()
            .map(provider_route_account_state_from_pg_row)
            .transpose()
    }

    async fn compare_and_set_provider_route_account_state(
        &self,
        route_id: &str,
        account_id: &str,
        mutation: ProviderAccountStateMutation,
    ) -> Result<ProviderRouteAccountStateRecord, StoreError> {
        if route_id.trim().is_empty() || account_id.trim().is_empty() {
            return Err("Model Route 与 Provider Account ID 不能为空".into());
        }
        let ProviderAccountStateMutation {
            expected_revision,
            status,
            cooldown_until,
            last_error_kind,
            mark_used,
        } = mutation;
        let now = now_text();
        let cooldown =
            cooldown_until.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        let row = if let Some(expected_revision) = expected_revision {
            sqlx::query(
                r#"UPDATE provider_route_account_states SET
                     revision = revision + 1,
                     status = $1, cooldown_until = $2, last_error_kind = $3,
                     last_used_at = CASE WHEN $4 THEN $5 ELSE last_used_at END,
                     updated_at = $5
                   WHERE route_id = $6 AND account_id = $7 AND revision = $8
                   RETURNING *"#,
            )
            .bind(status.as_str())
            .bind(cooldown)
            .bind(last_error_kind.as_deref())
            .bind(mark_used)
            .bind(&now)
            .bind(route_id)
            .bind(account_id)
            .bind(i64::try_from(expected_revision)?)
            .fetch_optional(&self.pool)
            .await?
        } else {
            sqlx::query(
                r#"INSERT INTO provider_route_account_states
                   (route_id, account_id, revision, status, cooldown_until,
                    last_error_kind, last_used_at, updated_at)
                   VALUES ($1, $2, 1, $3, $4, $5, $6, $6)
                   ON CONFLICT(route_id, account_id) DO NOTHING
                   RETURNING *"#,
            )
            .bind(route_id)
            .bind(account_id)
            .bind(status.as_str())
            .bind(cooldown)
            .bind(last_error_kind.as_deref())
            .bind(&now)
            .fetch_optional(&self.pool)
            .await?
        };
        let Some(row) = row else {
            return Err(format!(
                "Model Route '{route_id}' 的 Provider Account '{account_id}' revision 冲突：期望 {:?}",
                expected_revision
            )
            .into());
        };
        provider_route_account_state_from_pg_row(&row)
    }

    async fn delete_provider_account_records(&self, account_id: &str) -> Result<bool, StoreError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM provider_route_account_states WHERE account_id = $1")
            .bind(account_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM provider_account_affinities WHERE account_id = $1")
            .bind(account_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM provider_refresh_leases WHERE account_id = $1")
            .bind(account_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM provider_model_catalog WHERE auth_account_id = $1")
            .bind(account_id)
            .execute(&mut *tx)
            .await?;
        let deleted = sqlx::query("DELETE FROM provider_account_states WHERE account_id = $1")
            .bind(account_id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
            > 0;
        tx.commit().await?;
        Ok(deleted)
    }

    async fn get_provider_account_affinity(
        &self,
        route_id: &str,
        scope_key: &str,
    ) -> Result<Option<ProviderAccountAffinityRecord>, StoreError> {
        let row = sqlx::query(
            "SELECT * FROM provider_account_affinities WHERE route_id = $1 AND scope_key = $2",
        )
        .bind(route_id)
        .bind(scope_key)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref()
            .map(provider_account_affinity_from_pg_row)
            .transpose()
    }

    async fn put_provider_account_affinity(
        &self,
        route_id: &str,
        scope_key: &str,
        account_id: &str,
    ) -> Result<ProviderAccountAffinityRecord, StoreError> {
        let row = sqlx::query(
            r#"INSERT INTO provider_account_affinities
               (route_id, scope_key, account_id, revision, updated_at)
               VALUES ($1, $2, $3, 1, $4)
               ON CONFLICT(route_id, scope_key) DO UPDATE SET
                 account_id = EXCLUDED.account_id,
                 revision = provider_account_affinities.revision + 1,
                 updated_at = EXCLUDED.updated_at
               RETURNING *"#,
        )
        .bind(route_id)
        .bind(scope_key)
        .bind(account_id)
        .bind(now_text())
        .fetch_one(&self.pool)
        .await?;
        provider_account_affinity_from_pg_row(&row)
    }

    async fn claim_provider_refresh_lease(
        &self,
        account_id: &str,
        owner_id: &str,
        lease_expires_at: DateTime<Utc>,
    ) -> Result<Option<ProviderRefreshLeaseRecord>, StoreError> {
        let now = Utc::now();
        if lease_expires_at <= now {
            return Err("Provider Refresh lease 必须在未来".into());
        }
        let mut tx = self.pool.begin().await?;
        let current =
            sqlx::query("SELECT * FROM provider_refresh_leases WHERE account_id = $1 FOR UPDATE")
                .bind(account_id)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(row) = &current {
            let existing = provider_refresh_lease_from_pg_row(row)?;
            if existing.lease_expires_at > now && existing.owner_id != owner_id {
                return Ok(None);
            }
        }
        let generation = current
            .as_ref()
            .map(|row| u64::try_from(row.get::<i64, _>("generation")))
            .transpose()?
            .unwrap_or_default()
            .saturating_add(1);
        let row = sqlx::query(
            r#"INSERT INTO provider_refresh_leases
               (account_id, generation, owner_id, lease_expires_at, updated_at)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT(account_id) DO UPDATE SET
                 generation = EXCLUDED.generation,
                 owner_id = EXCLUDED.owner_id,
                 lease_expires_at = EXCLUDED.lease_expires_at,
                 updated_at = EXCLUDED.updated_at
               RETURNING *"#,
        )
        .bind(account_id)
        .bind(i64::try_from(generation)?)
        .bind(owner_id)
        .bind(lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .bind(now_text())
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Some(provider_refresh_lease_from_pg_row(&row)?))
    }

    async fn release_provider_refresh_lease(
        &self,
        account_id: &str,
        generation: u64,
        owner_id: &str,
    ) -> Result<bool, StoreError> {
        let result = sqlx::query(
            "DELETE FROM provider_refresh_leases WHERE account_id = $1 AND generation = $2 AND owner_id = $3",
        )
        .bind(account_id)
        .bind(i64::try_from(generation)?)
        .bind(owner_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }
}

fn parse_work_assignment_status(value: &str) -> Result<WorkAssignmentStatus, StoreError> {
    Ok(match value {
        "queued" => WorkAssignmentStatus::Queued,
        "running" => WorkAssignmentStatus::Running,
        "succeeded" => WorkAssignmentStatus::Succeeded,
        "failed" => WorkAssignmentStatus::Failed,
        "cancelled" => WorkAssignmentStatus::Cancelled,
        "interrupted" => WorkAssignmentStatus::Interrupted,
        other => return Err(format!("unknown Work Assignment status: {other}").into()),
    })
}

fn work_assignment_from_pg_row(row: &PgRow) -> Result<WorkAssignmentRecord, StoreError> {
    Ok(WorkAssignmentRecord {
        id: row.get("id"),
        kind: row.get("kind"),
        external_id: row.get("external_id"),
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        session_id: row.get("session_id"),
        role: row.get("role"),
        request_id: row.get("request_id"),
        objective_id: row.get("objective_id"),
        counterparty_id: row.get("counterparty_id"),
        summary: row.get("summary"),
        input: serde_json::from_str(&row.get::<String, _>("input_json"))?,
        output: row
            .get::<Option<String>, _>("output_json")
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        status: parse_work_assignment_status(&row.get::<String, _>("status"))?,
        status_reason: row.get("status_reason"),
        lease_expires_at: DateTime::parse_from_rfc3339(&row.get::<String, _>("lease_expires_at"))?
            .with_timezone(&Utc),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        created_at: DateTime::parse_from_rfc3339(&row.get::<String, _>("created_at"))?
            .with_timezone(&Utc),
        updated_at: DateTime::parse_from_rfc3339(&row.get::<String, _>("updated_at"))?
            .with_timezone(&Utc),
    })
}

#[async_trait::async_trait]
impl WorkAssignmentStore for PostgresStore {
    async fn create_work_assignment(
        &self,
        assignment: NewWorkAssignment,
    ) -> Result<WorkAssignmentCreateResult, StoreError> {
        for (field, value) in [
            ("id", assignment.id.as_str()),
            ("kind", assignment.kind.as_str()),
            ("external_id", assignment.external_id.as_str()),
            ("agent_id", assignment.agent_id.as_str()),
            ("context_id", assignment.context_id.as_str()),
            ("session_id", assignment.session_id.as_str()),
            ("role", assignment.role.as_str()),
            ("summary", assignment.summary.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(format!("Work Assignment {field} must not be empty").into());
            }
        }
        let now = now_text();
        let input_json = serde_json::to_string(&assignment.input)?;
        let created = sqlx::query(
            r#"INSERT INTO work_assignments
               (id, kind, external_id, agent_id, context_id, session_id, role,
                request_id, objective_id, counterparty_id, summary, input_json,
                output_json, status, status_reason, lease_expires_at, revision, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                       NULL, $13, NULL, $14, 1, $15, $15)
               ON CONFLICT(id) DO NOTHING"#,
        )
        .bind(&assignment.id)
        .bind(&assignment.kind)
        .bind(&assignment.external_id)
        .bind(&assignment.agent_id)
        .bind(&assignment.context_id)
        .bind(&assignment.session_id)
        .bind(&assignment.role)
        .bind(&assignment.request_id)
        .bind(&assignment.objective_id)
        .bind(&assignment.counterparty_id)
        .bind(&assignment.summary)
        .bind(&input_json)
        .bind(assignment.status.as_str())
        .bind(
            assignment
                .lease_expires_at
                .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
        )
        .bind(&now)
        .execute(&self.pool)
        .await?
        .rows_affected()
            == 1;
        let record = self
            .get_work_assignment(&assignment.id)
            .await?
            .ok_or("Work Assignment insert did not produce a record")?;
        let same_contract = record.kind == assignment.kind
            && record.external_id == assignment.external_id
            && record.agent_id == assignment.agent_id
            && record.context_id == assignment.context_id
            && record.session_id == assignment.session_id
            && record.role == assignment.role
            && record.request_id == assignment.request_id
            && record.objective_id == assignment.objective_id
            && record.counterparty_id == assignment.counterparty_id
            && record.summary == assignment.summary
            && record.input == assignment.input;
        if !same_contract {
            return Err(format!(
                "Work Assignment identity '{}' is occupied by a different contract",
                assignment.id
            )
            .into());
        }
        Ok(WorkAssignmentCreateResult { record, created })
    }

    async fn get_work_assignment(
        &self,
        id: &str,
    ) -> Result<Option<WorkAssignmentRecord>, StoreError> {
        let row = sqlx::query("SELECT * FROM work_assignments WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(work_assignment_from_pg_row).transpose()
    }

    async fn list_context_work_assignments(
        &self,
        context_id: &str,
        kind: Option<&str>,
        include_terminal: bool,
        limit: usize,
    ) -> Result<Vec<WorkAssignmentRecord>, StoreError> {
        let mut builder: QueryBuilder<'_, Postgres> =
            QueryBuilder::new("SELECT * FROM work_assignments WHERE context_id = ");
        builder.push_bind(context_id);
        if let Some(kind) = kind {
            builder.push(" AND kind = ");
            builder.push_bind(kind);
        }
        if !include_terminal {
            builder.push(" AND status IN ('queued', 'running')");
        }
        builder.push(" ORDER BY updated_at DESC, id LIMIT ");
        builder.push_bind(i64::try_from(limit.max(1))?);
        let rows = builder.build().fetch_all(&self.pool).await?;
        rows.iter().map(work_assignment_from_pg_row).collect()
    }

    async fn list_agent_work_assignments(
        &self,
        agent_id: &str,
        kind: Option<&str>,
        include_terminal: bool,
        limit: usize,
    ) -> Result<Vec<WorkAssignmentRecord>, StoreError> {
        let mut builder: QueryBuilder<'_, Postgres> =
            QueryBuilder::new("SELECT * FROM work_assignments WHERE agent_id = ");
        builder.push_bind(agent_id);
        if let Some(kind) = kind {
            builder.push(" AND kind = ");
            builder.push_bind(kind);
        }
        if !include_terminal {
            builder.push(" AND status IN ('queued', 'running')");
        }
        builder.push(" ORDER BY updated_at DESC, id LIMIT ");
        builder.push_bind(i64::try_from(limit.max(1))?);
        let rows = builder.build().fetch_all(&self.pool).await?;
        rows.iter().map(work_assignment_from_pg_row).collect()
    }

    async fn update_work_assignment(
        &self,
        id: &str,
        mutation: WorkAssignmentMutation,
    ) -> Result<WorkAssignmentMutationResult, StoreError> {
        let output_json = mutation
            .output
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let row = sqlx::query(
            r#"UPDATE work_assignments SET
                 status = $1, output_json = COALESCE($2, output_json), status_reason = $3,
                 revision = revision + 1, updated_at = $4
               WHERE id = $5 AND revision = $6 AND status IN ('queued', 'running')
               RETURNING *"#,
        )
        .bind(mutation.status.as_str())
        .bind(output_json)
        .bind(&mutation.status_reason)
        .bind(now_text())
        .bind(id)
        .bind(i64::try_from(mutation.expected_revision)?)
        .fetch_optional(&self.pool)
        .await?;
        if let Some(row) = row {
            return Ok(WorkAssignmentMutationResult::Updated(
                work_assignment_from_pg_row(&row)?,
            ));
        }
        Ok(match self.get_work_assignment(id).await? {
            Some(current) => WorkAssignmentMutationResult::Conflict(current),
            None => WorkAssignmentMutationResult::NotFound,
        })
    }
}

fn postgres_snapshot_component<T>(row: &PgRow, column: &str) -> Result<T, StoreError>
where
    T: serde::de::DeserializeOwned,
{
    Ok(serde_json::from_value(row.get::<JsonValue, _>(column))?)
}

#[async_trait::async_trait]
impl ContextRuntimeSnapshotStore for PostgresStore {
    fn storage_backend_name(&self) -> &'static str {
        "postgres"
    }

    async fn read_context_runtime_directory_snapshot(
        &self,
        request: &ContextRuntimeDirectoryRequest,
    ) -> Result<Option<ContextRuntimeDirectorySnapshot>, StoreError> {
        let request = request.clone().normalized();
        let context_id = request.context_id.as_str();
        let active_session_id = request.active_session_id.as_str();
        let active_after = request.active_after.to_rfc3339();
        let max_full_sessions = i64::try_from(request.max_full_sessions)?;
        let max_metadata_sessions = i64::try_from(request.max_metadata_sessions)?;
        let principal_ids = request.session_filter.principal_ids.clone();
        // PostgreSQL gives one MVCC snapshot to the complete statement. Every
        // aggregate therefore describes one real directory state without a
        // client-driven BEGIN + seven sequential protocol round trips.
        let row = sqlx::query(
            r#"WITH
               scoped_sessions AS MATERIALIZED (
                 SELECT s.*
                 FROM sessions s
                 WHERE s.context_id = $1
                   AND (
                     $6::text[] IS NULL
                     OR EXISTS (
                       SELECT 1
                       FROM session_principal_bindings visible_binding
                       WHERE visible_binding.session_id = s.id
                         AND visible_binding.unbound_at IS NULL
                         AND visible_binding.principal_id = ANY($6::text[])
                     )
                   )
               ),
               active_policy AS (
                 SELECT COALESCE(
                   bool_or(context_sharing = 'isolated') FILTER (WHERE id = $2),
                   FALSE
                 ) AS current_is_isolated
                 FROM scoped_sessions
               ),
               classified_sessions AS MATERIALIZED (
                 SELECT s.*,
                   CASE
                     WHEN s.id = $2 THEN NULL
                     WHEN policy.current_is_isolated OR s.context_sharing = 'isolated'
                       THEN 'isolated'
                     WHEN s.status = 'archived' THEN 'archived'
                     WHEN s.attention_state = 'retired' THEN 'retired'
                     WHEN s.last_activity_at < $3 THEN 'outside_window'
                     ELSE NULL
                   END AS exclusion_reason
                 FROM scoped_sessions s
                 CROSS JOIN active_policy policy
               ),
               full_session_ids AS MATERIALIZED (
                 SELECT id
                 FROM classified_sessions
                 WHERE exclusion_reason IS NULL
                 ORDER BY CASE WHEN id = $2 THEN 0 ELSE 1 END,
                          last_activity_at DESC, id
                 LIMIT $4
               ),
               metadata_candidate_ids AS MATERIALIZED (
                 SELECT s.id, s.last_activity_at
                 FROM classified_sessions s
                 CROSS JOIN active_policy policy
                 WHERE NOT EXISTS (
                         SELECT 1 FROM full_session_ids selected_full
                         WHERE selected_full.id = s.id
                       )
                   AND NOT (
                     s.id <> $2
                     AND (policy.current_is_isolated OR s.context_sharing = 'isolated')
                   )
                   AND (
                     EXISTS (
                       SELECT 1 FROM thread_activations activation
                       WHERE activation.session_id = s.id
                         AND activation.status IN ('queued', 'running')
                     )
                     OR EXISTS (
                       SELECT 1 FROM objectives objective
                       WHERE objective.context_id = $1
                         AND objective.coordinator_session_id = s.id
                         AND objective.status IN ('active', 'paused', 'blocked')
                     )
                   )
               ),
               metadata_session_ids AS MATERIALIZED (
                 SELECT id
                 FROM metadata_candidate_ids
                 ORDER BY last_activity_at DESC, id
                 LIMIT $5
               ),
               selected_session_ids AS MATERIALIZED (
                 SELECT id, 0::smallint AS projection_order FROM full_session_ids
                 UNION ALL
                 SELECT id, 1::smallint AS projection_order FROM metadata_session_ids
               ),
               session_selection_counts AS (
                 SELECT
                   COUNT(*) FILTER (WHERE exclusion_reason = 'archived') AS archived,
                   COUNT(*) FILTER (WHERE exclusion_reason = 'retired') AS retired,
                   COUNT(*) FILTER (WHERE exclusion_reason = 'isolated') AS isolated,
                   COUNT(*) FILTER (WHERE exclusion_reason = 'outside_window') AS outside_window,
                   GREATEST(
                     COUNT(*) FILTER (WHERE exclusion_reason IS NULL) - $4,
                     0
                   ) AS over_count,
                   GREATEST(
                     (SELECT COUNT(*) FROM metadata_candidate_ids) - $5,
                     0
                   ) AS metadata_over_count
                 FROM classified_sessions
               )
               SELECT
                 to_jsonb(c) AS context_json,
                 COALESCE(
                   (SELECT to_jsonb(clock)
                    FROM context_cognitive_clocks clock
                    WHERE clock.context_id = c.id),
                   jsonb_build_object(
                     'context_id', c.id, 'tick', 0,
                     'last_signal_batch_id', NULL, 'revision', 0
                   )
                 ) AS cognitive_clock_json,
                 COALESCE(
                   (SELECT (to_jsonb(projection) - 'state_json')
                             || jsonb_build_object(
                                  'state', projection.state_json,
                                  'head_event_id', head.head_event_id
                                )
                    FROM mind_projections projection
                    JOIN context_heads head ON head.context_id = projection.context_id
                    WHERE projection.context_id = c.id
                      AND projection.revision = head.revision
                      AND projection.state_hash = head.projection_hash),
                   'null'::jsonb
                 ) AS mind_json,
                 (SELECT revision FROM context_heads WHERE context_id = c.id)
                   AS mind_head_revision,
                 (SELECT projection_hash FROM context_heads WHERE context_id = c.id)
                   AS mind_head_hash,
                 (SELECT revision FROM mind_projections WHERE context_id = c.id)
                   AS mind_projection_revision,
                 (SELECT state_hash FROM mind_projections WHERE context_id = c.id)
                   AS mind_projection_hash,
                 COALESCE(
                   (SELECT jsonb_agg(to_jsonb(s)
                                     ORDER BY selected.projection_order,
                                              s.last_activity_at DESC, s.id)
                    FROM selected_session_ids selected
                    JOIN scoped_sessions s ON s.id = selected.id),
                   '[]'::jsonb
                 ) AS sessions_json,
                 (SELECT jsonb_build_object(
                    'archived', archived,
                    'retired', retired,
                    'isolated', isolated,
                    'outside_window', outside_window,
                    'over_count', over_count,
                    'metadata_over_count', metadata_over_count
                  ) FROM session_selection_counts) AS session_exclusions_json,
                 COALESCE(
                   (SELECT jsonb_agg(
                      (to_jsonb(o) - 'wait_condition_json' - 'completion_intent_json')
                      || jsonb_build_object(
                           'wait_condition', o.wait_condition_json,
                           'completion_intent', o.completion_intent_json
                         )
                      ORDER BY o.updated_at DESC, o.id
                    )
                    FROM objectives o
                    WHERE o.context_id = c.id
                      AND o.status IN ('active', 'paused', 'blocked')
                      AND (
                        $6::text[] IS NULL
                        OR EXISTS (
                          SELECT 1 FROM selected_session_ids selected
                          WHERE selected.id = o.coordinator_session_id
                             OR selected.id = o.delivery_session_id
                        )
                      )),
                   '[]'::jsonb
                 ) AS objectives_json,
                 COALESCE(
                   (SELECT jsonb_agg(item ORDER BY updated_at DESC, id)
                    FROM (
                      SELECT w.id, w.updated_at,
                        (to_jsonb(w) - 'input_json' - 'output_json')
                        || jsonb_build_object(
                             'input', w.input_json::jsonb,
                             'output', CASE WHEN w.output_json IS NULL
                               THEN NULL ELSE w.output_json::jsonb END
                           ) AS item
                      FROM work_assignments w
                      WHERE w.context_id = c.id
                        AND w.status IN ('queued', 'running')
                        AND (
                          $6::text[] IS NULL
                          OR EXISTS (
                            SELECT 1 FROM selected_session_ids selected
                            WHERE selected.id = w.session_id
                          )
                        )
                      ORDER BY w.updated_at DESC, w.id
                      LIMIT 32
                    ) bounded_assignments),
                   '[]'::jsonb
                 ) AS work_assignments_json,
                 COALESCE(
                   (SELECT jsonb_agg(to_jsonb(binding) ORDER BY binding.capability_id)
                    FROM context_capability_bindings binding
                    WHERE binding.context_id = c.id),
                   '[]'::jsonb
                 ) AS capability_bindings_json,
                 COALESCE(
                   (SELECT jsonb_agg(to_jsonb(activation)
                                     ORDER BY activation.created_at, activation.id)
                    FROM thread_activations activation
                    WHERE activation.context_id = c.id
                      AND activation.status IN ('queued', 'running')
                      AND (
                        $6::text[] IS NULL
                        OR EXISTS (
                          SELECT 1 FROM selected_session_ids selected
                          WHERE selected.id = activation.session_id
                        )
                      )),
                   '[]'::jsonb
                 ) AS active_activations_json,
                 COALESCE(
                   (SELECT jsonb_agg(to_jsonb(binding)
                                     ORDER BY binding.session_id, binding.principal_id)
                    FROM session_principal_bindings binding
                    JOIN selected_session_ids selected ON selected.id = binding.session_id
                    WHERE binding.unbound_at IS NULL),
                   '[]'::jsonb
                 ) AS principal_bindings_json
               FROM cognitive_contexts c
               WHERE c.id = $1"#,
        )
        .bind(context_id)
        .bind(active_session_id)
        .bind(active_after)
        .bind(max_full_sessions)
        .bind(max_metadata_sessions)
        .bind(principal_ids)
        .fetch_optional(&self.pool)
        .await?;

        let Some(row) = row else {
            return Ok(None);
        };
        let head_revision = row.get::<Option<i64>, _>("mind_head_revision");
        let projection_revision = row.get::<Option<i64>, _>("mind_projection_revision");
        let mind = match (head_revision, projection_revision) {
            (None, None) => None,
            (Some(head_revision), Some(projection_revision)) => {
                let head_hash = row
                    .get::<Option<String>, _>("mind_head_hash")
                    .ok_or("Context Head 缺少 projection_hash")?;
                let projection_hash = row
                    .get::<Option<String>, _>("mind_projection_hash")
                    .ok_or("Mind Projection 缺少 state_hash")?;
                if head_revision != projection_revision || head_hash != projection_hash {
                    return Err(format!(
                        "Context '{context_id}' 的 Mind Projection head/hash/revision 不一致"
                    )
                    .into());
                }
                Some(
                    postgres_snapshot_component::<Option<MindProjectionRecord>>(&row, "mind_json")?
                        .ok_or("一致的 Mind Projection 没有返回投影内容")?,
                )
            }
            _ => return Err(format!("Context '{context_id}' 的 Mind Projection 不完整").into()),
        };
        ContextRuntimeDirectorySnapshot::from_components(
            postgres_snapshot_component(&row, "context_json")?,
            postgres_snapshot_component(&row, "cognitive_clock_json")?,
            mind,
            postgres_snapshot_component::<ContextRuntimeSessionExclusions>(
                &row,
                "session_exclusions_json",
            )?,
            postgres_snapshot_component(&row, "sessions_json")?,
            postgres_snapshot_component(&row, "objectives_json")?,
            postgres_snapshot_component(&row, "work_assignments_json")?,
            postgres_snapshot_component(&row, "capability_bindings_json")?,
            postgres_snapshot_component(&row, "active_activations_json")?,
            postgres_snapshot_component(&row, "principal_bindings_json")?,
        )
        .map(Some)
    }

    async fn read_context_runtime_scheduler_snapshot(
        &self,
        context_id: &str,
        delivery_thread_ids: &[String],
        recent_terminal_limit: usize,
        group_limit: usize,
    ) -> Result<ContextRuntimeSchedulerSnapshot, StoreError> {
        let recent_terminal_limit = i64::try_from(recent_terminal_limit)?;
        let group_limit = i64::try_from(group_limit)?;
        let row = sqlx::query(
            r#"WITH
               delivery_ids(id) AS (
                 SELECT unnest($2::text[])
               ),
               active_ids AS (
                 SELECT id, 0::SMALLINT AS projection_bucket,
                        created_at AS order_time, id AS order_id
                 FROM threads
                 WHERE context_id = $1 AND status = 'open'
               ),
               delivery_projection_ids AS (
                 SELECT thread.id, 1::SMALLINT AS projection_bucket,
                        ''::TEXT AS order_time, thread.id AS order_id
                 FROM threads thread
                 JOIN delivery_ids requested ON requested.id = thread.id
                 WHERE thread.context_id = $1
                   AND thread.delivery_status IN ('pending', 'deferred')
                   AND NOT EXISTS (
                     SELECT 1 FROM active_ids active WHERE active.id = thread.id
                   )
               ),
               recent_candidates AS (
                 SELECT id, updated_at
                 FROM threads
                 WHERE context_id = $1
                   AND status IN ('completed', 'failed', 'cancelled')
                 ORDER BY updated_at DESC, id
                 LIMIT $3
               ),
               recent_projection_ids AS (
                 SELECT thread.id, 2::SMALLINT AS projection_bucket,
                        thread.updated_at AS order_time, thread.id AS order_id
                 FROM recent_candidates recent
                 JOIN threads thread ON thread.id = recent.id
                 WHERE thread.delivery_status NOT IN ('pending', 'deferred')
                   AND NOT EXISTS (
                     SELECT 1 FROM active_ids active WHERE active.id = thread.id
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM delivery_projection_ids delivery
                     WHERE delivery.id = thread.id
                   )
               ),
               projected_ids AS (
                 SELECT * FROM active_ids
                 UNION ALL SELECT * FROM delivery_projection_ids
                 UNION ALL SELECT * FROM recent_projection_ids
               ),
               projected_group_ids(id) AS (
                 SELECT DISTINCT thread.thread_group_id
                 FROM projected_ids projected
                 JOIN threads thread ON thread.id = projected.id
                 WHERE thread.thread_group_id IS NOT NULL
                 ORDER BY thread.thread_group_id
                 LIMIT $4
               ),
               thread_rows AS (
                 SELECT projected.projection_bucket, projected.order_time,
                        projected.order_id,
                   (to_jsonb(thread) - ARRAY[
                     'status', 'lifetime', 'supervisor_kind', 'supervisor_id',
                     'supervision_generation', 'origin_evaluation_id',
                     'parent_thread_id', 'thread_group_id',
                     'completion_contract_json'
                   ]::TEXT[])
                   || jsonb_build_object(
                     'lifecycle', thread.status,
                     'supervision', jsonb_build_object(
                       'lifetime', thread.lifetime,
                       'supervisor_kind', thread.supervisor_kind,
                       'supervisor_id', thread.supervisor_id,
                       'generation', thread.supervision_generation,
                       'origin_evaluation_id', thread.origin_evaluation_id,
                       'parent_thread_id', thread.parent_thread_id,
                       'thread_group_id', thread.thread_group_id,
                       'completion_contract', thread.completion_contract_json
                     )
                   ) AS value
                 FROM projected_ids projected
                 JOIN threads thread ON thread.id = projected.id
               ),
               group_rows AS (
                 SELECT group_record.created_at, group_record.id,
                   (to_jsonb(group_record) - ARRAY[
                     'completion_contract_json', 'terminal_summary_json'
                   ]::TEXT[])
                   || jsonb_build_object(
                     'completion_contract', group_record.completion_contract_json,
                     'terminal_summary', group_record.terminal_summary_json
                   ) AS value
                 FROM projected_group_ids selected
                 JOIN thread_groups group_record ON group_record.id = selected.id
                 WHERE group_record.context_id = $1
               ),
               member_rows AS (
                 SELECT member.group_id, member.ordinal, member.thread_id,
                        to_jsonb(member) AS value
                 FROM projected_group_ids selected
                 JOIN thread_group_members member ON member.group_id = selected.id
               ),
               outcome_rows AS (
                 SELECT member.group_id, member.ordinal, outcome.created_at,
                   (to_jsonb(outcome) - ARRAY[
                     'outcome_id', 'event_id', 'artifact_refs_json',
                     'evidence_refs_json', 'check_results_json',
                     'unresolved_failures_json'
                   ]::TEXT[])
                   || jsonb_build_object(
                     'id', outcome.outcome_id,
                     'result_event_id', outcome.event_id,
                     'artifact_refs', outcome.artifact_refs_json,
                     'evidence_refs', outcome.evidence_refs_json,
                     'check_results', outcome.check_results_json,
                     'unresolved_failures', outcome.unresolved_failures_json
                   ) AS value
                 FROM projected_group_ids selected
                 JOIN thread_group_members member ON member.group_id = selected.id
                 JOIN thread_outcomes outcome ON outcome.thread_id = member.thread_id
               ),
               schedule_rows AS (
                 SELECT COALESCE(schedule.not_before, schedule.created_at) AS due_at,
                        schedule.id,
                   (to_jsonb(schedule) - 'dependency_thread_ids_json')
                   || jsonb_build_object(
                     'dependency_thread_ids', schedule.dependency_thread_ids_json
                   ) AS value
                 FROM active_ids active
                 JOIN schedules schedule ON schedule.thread_id = active.id
                 WHERE schedule.status = 'queued'
               ),
               signal_rows AS (
                 SELECT signal.sequence, signal.id, to_jsonb(signal) AS value
                 FROM projected_ids projected
                 JOIN thread_signals signal ON signal.thread_id = projected.id
                 WHERE signal.status = 'pending'
               )
               SELECT
                 COALESCE((SELECT jsonb_agg(value ORDER BY
                   projection_bucket, order_time,
                   CASE WHEN projection_bucket = 2 THEN order_id END DESC,
                   CASE WHEN projection_bucket != 2 THEN order_id END)
                   FROM thread_rows), '[]'::jsonb) AS threads_json,
                 COALESCE((SELECT jsonb_agg(value ORDER BY created_at, id)
                   FROM group_rows), '[]'::jsonb) AS thread_groups_json,
                 COALESCE((SELECT jsonb_agg(value ORDER BY group_id, ordinal, thread_id)
                   FROM member_rows), '[]'::jsonb) AS thread_group_members_json,
                 COALESCE((SELECT jsonb_agg(value ORDER BY group_id, ordinal, created_at)
                   FROM outcome_rows), '[]'::jsonb) AS thread_outcomes_json,
                 COALESCE((SELECT jsonb_agg(value ORDER BY due_at, id)
                   FROM schedule_rows), '[]'::jsonb) AS schedules_json,
                 COALESCE((SELECT jsonb_agg(value ORDER BY sequence, id)
                   FROM signal_rows), '[]'::jsonb) AS thread_signals_json"#,
        )
        .bind(context_id)
        .bind(delivery_thread_ids)
        .bind(recent_terminal_limit)
        .bind(group_limit)
        .fetch_one(&self.pool)
        .await?;

        ContextRuntimeSchedulerSnapshot::from_components(
            postgres_snapshot_component(&row, "threads_json")?,
            postgres_snapshot_component(&row, "thread_groups_json")?,
            postgres_snapshot_component(&row, "thread_group_members_json")?,
            postgres_snapshot_component(&row, "thread_outcomes_json")?,
            postgres_snapshot_component(&row, "schedules_json")?,
            postgres_snapshot_component(&row, "thread_signals_json")?,
        )
    }

    async fn read_context_activation_causality_snapshot(
        &self,
        context_id: &str,
        activation_id: &str,
        root_turn_id: &str,
        trigger_event_id: &str,
    ) -> Result<ContextActivationCausalitySnapshot, StoreError> {
        let row = sqlx::query(
            r#"WITH first_activation AS (
                 SELECT trigger_event_id, trigger_sequence
                 FROM thread_activations
                 WHERE context_id = $1 AND root_turn_id = $3
                 ORDER BY created_at, id
                 LIMIT 1
               ),
               activation_signal_rows AS (
                 SELECT link.ordinal, to_jsonb(signal) AS value
                 FROM activation_signals link
                 JOIN thread_signals signal ON signal.id = link.signal_id
                 WHERE link.activation_id = $2
               )
               SELECT
                 COALESCE((SELECT jsonb_agg(value ORDER BY ordinal)
                   FROM activation_signal_rows), '[]'::jsonb)
                   AS activation_signals_json,
                 COALESCE((SELECT
                   (to_jsonb(thread) - ARRAY[
                     'status', 'lifetime', 'supervisor_kind', 'supervisor_id',
                     'supervision_generation', 'origin_evaluation_id',
                     'parent_thread_id', 'thread_group_id',
                     'completion_contract_json'
                   ]::TEXT[])
                   || jsonb_build_object(
                     'lifecycle', thread.status,
                     'supervision', jsonb_build_object(
                       'lifetime', thread.lifetime,
                       'supervisor_kind', thread.supervisor_kind,
                       'supervisor_id', thread.supervisor_id,
                       'generation', thread.supervision_generation,
                       'origin_evaluation_id', thread.origin_evaluation_id,
                       'parent_thread_id', thread.parent_thread_id,
                       'thread_group_id', thread.thread_group_id,
                       'completion_contract', thread.completion_contract_json
                     )
                   )
                   FROM threads thread
                   WHERE thread.context_id = $1 AND thread.root_turn_id = $3),
                   'null'::jsonb) AS thread_json,
                 COALESCE((SELECT jsonb_build_object(
                   'id', event.id, 'sequence', event.sequence,
                   'timestamp', event.timestamp, 'actor', event.actor,
                   'type', event.type, 'topic', event.topic,
                   'payload', event.payload
                 ) FROM events event
                 WHERE event.context_id = $1 AND event.id = $4), 'null'::jsonb)
                   AS trigger_event_json,
                 COALESCE((SELECT jsonb_build_object(
                   'id', event.id, 'sequence', event.sequence,
                   'timestamp', event.timestamp, 'actor', event.actor,
                   'type', event.type, 'topic', event.topic,
                   'payload', event.payload
                 ) FROM events event
                 WHERE event.context_id = $1 AND event.id = $3), 'null'::jsonb)
                   AS direct_root_event_json,
                 COALESCE((SELECT jsonb_build_object(
                   'id', event.id, 'sequence', event.sequence,
                   'timestamp', event.timestamp, 'actor', event.actor,
                   'type', event.type, 'topic', event.topic,
                   'payload', event.payload
                 ) FROM first_activation first
                 JOIN events event ON event.id = first.trigger_event_id
                 WHERE event.context_id = $1), 'null'::jsonb)
                   AS first_trigger_event_json,
                 COALESCE(
                   (SELECT event.sequence FROM events event
                    WHERE event.context_id = $1 AND event.id = $3),
                   (SELECT trigger_sequence FROM first_activation)
                 ) AS root_sequence"#,
        )
        .bind(context_id)
        .bind(activation_id)
        .bind(root_turn_id)
        .bind(trigger_event_id)
        .fetch_one(&self.pool)
        .await?;
        let direct_root_event =
            postgres_snapshot_component::<Option<Event>>(&row, "direct_root_event_json")?;
        let first_trigger_event =
            postgres_snapshot_component::<Option<Event>>(&row, "first_trigger_event_json")?;
        let root_sequence = row
            .get::<Option<i64>, _>("root_sequence")
            .map(u64::try_from)
            .transpose()?;
        ContextActivationCausalitySnapshot::from_components(
            postgres_snapshot_component(&row, "activation_signals_json")?,
            postgres_snapshot_component(&row, "thread_json")?,
            postgres_snapshot_component(&row, "trigger_event_json")?,
            direct_root_event.or(first_trigger_event),
            root_sequence,
        )
    }

    async fn read_context_execution_resources_snapshot(
        &self,
        context_id: &str,
        principal_id: Option<&str>,
        target_limit: usize,
        authorization_limit: usize,
    ) -> Result<ContextExecutionResourcesSnapshot, StoreError> {
        let target_limit = i64::try_from(target_limit)?;
        let authorization_limit = i64::try_from(authorization_limit)?;
        let row = sqlx::query(
            r#"WITH
               background_job_rows AS (
                 SELECT job.created_at, job.id,
                   (to_jsonb(job) - ARRAY['request_json', 'result_refs_json']::TEXT[])
                   || jsonb_build_object(
                     'request', job.request_json,
                     'result_refs', job.result_refs_json
                   ) AS value
                 FROM execution_jobs job
                 WHERE job.context_id = $1 AND job.tool_name = 'exec/background'
                   AND job.status IN ('queued', 'waiting_approval', 'running')
               ),
               target_rows AS (
                 SELECT target.updated_at, target.id,
                   (to_jsonb(target) - ARRAY['capabilities_json', 'metadata_json']::TEXT[])
                   || jsonb_build_object(
                     'capabilities', target.capabilities_json,
                     'metadata', target.metadata_json
                   ) AS value
                 FROM execution_targets target
                 WHERE (($2::TEXT IS NULL AND target.owner_principal_id IS NULL)
                    OR ($2::TEXT IS NOT NULL AND (
                      target.owner_principal_id IS NULL OR target.owner_principal_id = $2
                    )))
                 ORDER BY target.updated_at DESC, target.id
                 LIMIT $3
               ),
               authorization_rows AS (
                 SELECT auth.updated_at, auth.id, to_jsonb(auth) AS value
                 FROM execution_target_authorizations auth
                 WHERE $2::TEXT IS NOT NULL
                   AND auth.owner_principal_id = $2
                 ORDER BY auth.updated_at DESC, auth.id
                 LIMIT $4
               )
               SELECT
                 COALESCE((SELECT jsonb_agg(value ORDER BY created_at, id)
                   FROM background_job_rows), '[]'::jsonb) AS background_jobs_json,
                 COALESCE((SELECT jsonb_agg(value ORDER BY updated_at DESC, id)
                   FROM target_rows), '[]'::jsonb) AS execution_targets_json,
                 COALESCE((SELECT jsonb_agg(value ORDER BY updated_at DESC, id)
                   FROM authorization_rows), '[]'::jsonb) AS target_authorizations_json"#,
        )
        .bind(context_id)
        .bind(principal_id)
        .bind(target_limit)
        .bind(authorization_limit)
        .fetch_one(&self.pool)
        .await?;
        ContextExecutionResourcesSnapshot::from_components(
            postgres_snapshot_component(&row, "background_jobs_json")?,
            postgres_snapshot_component(&row, "execution_targets_json")?,
            postgres_snapshot_component(&row, "target_authorizations_json")?,
        )
    }
}

impl crate::memory::RuntimeStore for PostgresStore {
    fn worker_coordination_mode(&self) -> crate::memory::WorkerCoordinationMode {
        crate::memory::WorkerCoordinationMode::SharedLeases
    }

    fn storage_pool_metrics(&self) -> Option<crate::memory::StoragePoolMetricsSnapshot> {
        Some(crate::memory::StoragePoolMetricsSnapshot {
            backend: "postgres".to_string(),
            size: self.pool.size(),
            idle: self.pool.num_idle(),
            max_connections: self.pool.options().get_max_connections(),
        })
    }
}

fn context_capability_binding_from_pg_row(
    row: &PgRow,
) -> Result<ContextCapabilityBindingRecord, StoreError> {
    Ok(ContextCapabilityBindingRecord {
        context_id: row.get("context_id"),
        capability_id: row.get("capability_id"),
        enabled: row.get("enabled"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        updated_at: DateTime::parse_from_rfc3339(&row.get::<String, _>("updated_at"))?
            .with_timezone(&Utc),
    })
}

#[async_trait::async_trait]
impl ContextCapabilityBindingStore for PostgresStore {
    async fn list_context_capability_bindings(
        &self,
        context_id: &str,
    ) -> Result<Vec<ContextCapabilityBindingRecord>, StoreError> {
        let rows = sqlx::query(
            "SELECT context_id, capability_id, enabled, revision, updated_at \
             FROM context_capability_bindings WHERE context_id = $1 ORDER BY capability_id",
        )
        .bind(context_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(context_capability_binding_from_pg_row)
            .collect()
    }

    async fn get_context_capability_binding(
        &self,
        context_id: &str,
        capability_id: &str,
    ) -> Result<Option<ContextCapabilityBindingRecord>, StoreError> {
        let row = sqlx::query(
            "SELECT context_id, capability_id, enabled, revision, updated_at \
             FROM context_capability_bindings WHERE context_id = $1 AND capability_id = $2",
        )
        .bind(context_id)
        .bind(capability_id)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref()
            .map(context_capability_binding_from_pg_row)
            .transpose()
    }

    async fn update_context_capability_binding(
        &self,
        context_id: &str,
        capability_id: &str,
        enabled: bool,
        expected_revision: u64,
    ) -> Result<ContextCapabilityBindingMutation, StoreError> {
        if capability_id.trim().is_empty() {
            return Err("capability_id must not be empty".into());
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let changed = if expected_revision == 0 {
            sqlx::query(
                "INSERT INTO context_capability_bindings \
                 (context_id, capability_id, enabled, revision, updated_at) \
                 SELECT $1, $2, $3, 1, $4 WHERE EXISTS \
                 (SELECT 1 FROM cognitive_contexts WHERE id = $1) \
                 ON CONFLICT(context_id, capability_id) DO NOTHING \
                 RETURNING context_id, capability_id, enabled, revision, updated_at",
            )
            .bind(context_id)
            .bind(capability_id)
            .bind(enabled)
            .bind(&now)
            .fetch_optional(&self.pool)
            .await?
        } else {
            sqlx::query(
                "UPDATE context_capability_bindings SET enabled = $1, revision = revision + 1, updated_at = $2 \
                 WHERE context_id = $3 AND capability_id = $4 AND revision = $5 \
                 RETURNING context_id, capability_id, enabled, revision, updated_at",
            )
            .bind(enabled)
            .bind(&now)
            .bind(context_id)
            .bind(capability_id)
            .bind(i64::try_from(expected_revision)?)
            .fetch_optional(&self.pool)
            .await?
        };
        if let Some(row) = changed.as_ref() {
            return Ok(ContextCapabilityBindingMutation::Updated(
                context_capability_binding_from_pg_row(row)?,
            ));
        }
        if let Some(current) = self
            .get_context_capability_binding(context_id, capability_id)
            .await?
        {
            return Ok(ContextCapabilityBindingMutation::Conflict(current));
        }
        let context_exists =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM cognitive_contexts WHERE id = $1")
                .bind(context_id)
                .fetch_one(&self.pool)
                .await?
                > 0;
        if context_exists {
            return Err(format!(
                "Context capability binding revision conflict: expected {expected_revision}, current 0"
            )
            .into());
        }
        Ok(ContextCapabilityBindingMutation::NotFound)
    }
}

#[async_trait::async_trait]
impl StorageMaintenanceStore for PostgresStore {
    async fn prune_transient_storage(
        &self,
        policy: TransientStorageRetention,
    ) -> Result<StorageMaintenanceReport, StoreError> {
        if policy.batch_limit == 0 {
            return Ok(StorageMaintenanceReport::default());
        }
        let limit = i64::try_from(policy.batch_limit)?;
        let outbox_cutoff = policy
            .resolved_signal_outbox_before
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let credentials_cutoff = policy
            .expired_edge_credentials_before
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        let outbox = sqlx::query(
            r#"DELETE FROM signal_outbox
               WHERE event_id IN (
                 SELECT event_id FROM signal_outbox
                 WHERE status IN ('materialized', 'discarded')
                   AND resolved_at IS NOT NULL AND resolved_at <= $1
                 ORDER BY resolved_at, event_id LIMIT $2
               )"#,
        )
        .bind(&outbox_cutoff)
        .bind(limit)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        let pairing_codes = sqlx::query(
            r#"DELETE FROM execution_node_pairing_codes
               WHERE code_hash IN (
                 SELECT code_hash FROM execution_node_pairing_codes
                 WHERE expires_at <= $1
                 ORDER BY expires_at, code_hash LIMIT $2
               )"#,
        )
        .bind(&credentials_cutoff)
        .bind(limit)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        let challenges = sqlx::query(
            r#"DELETE FROM execution_node_challenges
               WHERE id IN (
                 SELECT id FROM execution_node_challenges
                 WHERE expires_at <= $1
                 ORDER BY expires_at, id LIMIT $2
               )"#,
        )
        .bind(&credentials_cutoff)
        .bind(limit)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        tx.commit().await?;
        Ok(StorageMaintenanceReport {
            resolved_signal_outbox_deleted: outbox,
            expired_pairing_codes_deleted: pairing_codes,
            expired_challenges_deleted: challenges,
        })
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
        "thread_wait" => RuntimeTimerKind::ThreadWait,
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
    let completion_intent = row
        .get::<Option<JsonValue>, _>("completion_intent_json")
        .map(serde_json::from_value::<ObjectiveCompletionIntent>)
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
        generation: u64::try_from(row.get::<i64, _>("generation"))?,
        status: parse_objective_status(&row.get::<String, _>("status"))?,
        status_reason: row.get("status_reason"),
        wait_condition,
        completion_intent,
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
    let document = crate::memory::canonicalize_recall_document(document.clone());
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

struct EventAppendInTx {
    inserted: bool,
    sequence: i64,
}

async fn append_event_with_sequence_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    event: &Event,
) -> Result<EventAppendInTx, StoreError> {
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
    let inserted_sequence = sqlx::query_scalar::<_, i64>(
        r#"INSERT INTO events
           (id, timestamp, actor, type, topic, context_id, session_id,
            thread_id, activation_id, root_turn_id, objective_id, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT(id) DO NOTHING
           RETURNING sequence"#,
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
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(sequence) = inserted_sequence {
        if let Some(context_id) = context_id {
            project_attention_acknowledgement_in_tx(
                tx,
                event,
                context_id,
                u64::try_from(sequence)?,
            )
            .await?;
            enqueue_event_recall_in_tx(tx, event, context_id, false).await?;
        }
        project_observation_in_tx(tx, event).await?;
        return Ok(EventAppendInTx {
            inserted: true,
            sequence,
        });
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
    Ok(EventAppendInTx {
        inserted: false,
        sequence: existing.get("sequence"),
    })
}

async fn append_event_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    event: &Event,
) -> Result<bool, StoreError> {
    Ok(append_event_with_sequence_in_tx(tx, event).await?.inserted)
}

async fn upsert_recall_document_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    document: &RecallDocument,
) -> Result<(), StoreError> {
    let document = crate::memory::canonicalize_recall_document(document.clone());
    let search_term_keys =
        crate::memory::lexical::recall_term_keys(document.searchable_text.split_whitespace());
    sqlx::query(
        r#"INSERT INTO recall_documents
           (context_id, document_kind, document_id, revision, searchable_text,
            search_term_keys, preview, retired, updated_sequence, state_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT(context_id, document_kind, document_id) DO UPDATE SET
             revision = EXCLUDED.revision,
             searchable_text = EXCLUDED.searchable_text,
             search_term_keys = EXCLUDED.search_term_keys,
             preview = EXCLUDED.preview,
             retired = EXCLUDED.retired,
             updated_sequence = EXCLUDED.updated_sequence,
             state_hash = EXCLUDED.state_hash
           WHERE EXCLUDED.document_kind = 'frame'
              OR EXCLUDED.updated_sequence >= recall_documents.updated_sequence"#,
    )
    .bind(&document.context_id)
    .bind(document.document_kind.as_str())
    .bind(&document.document_id)
    .bind(i64::try_from(document.revision)?)
    .bind(&document.searchable_text)
    .bind(&search_term_keys)
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
        r#"INSERT INTO session_projections
           (event_id, context_id, session_id, event_sequence)
           SELECT $1, $2, $3, sequence FROM events WHERE id = $1
           ON CONFLICT(event_id) DO NOTHING"#,
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

/// PostgreSQL counterpart of SQLite's direct internal scheduler delivery.
/// The caller owns the transaction which appended `event`, so no durable
/// internal state is ever represented by an eventually interpreted Outbox
/// row.
async fn append_direct_thread_signal_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    event: &Event,
    thread_id: &str,
) -> Result<bool, StoreError> {
    let thread = sqlx::query(
        "SELECT generation, initiating_principal_id, status FROM threads WHERE id = $1 FOR SHARE",
    )
    .bind(thread_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| format!("Direct Thread Signal 目标 Thread '{thread_id}' 不存在"))?;
    let status: String = thread.get("status");
    let signal_id = crate::memory::stable_thread_signal_id(&event.id);
    let explicit_parent_activation_id = event
        .payload
        .get("parent_activation_id")
        .and_then(JsonValue::as_str)
        .map(ToOwned::to_owned);
    let causal_activation_id = event
        .payload
        .get("activation_id")
        .and_then(JsonValue::as_str)
        .map(ToOwned::to_owned);
    let parent_activation_id = if explicit_parent_activation_id.is_some() {
        explicit_parent_activation_id
    } else if let Some(candidate) = causal_activation_id {
        sqlx::query_scalar::<_, i64>(
            "SELECT 1::BIGINT FROM thread_activations WHERE id = $1 LIMIT 1",
        )
        .bind(&candidate)
        .fetch_optional(&mut **tx)
        .await?
        .map(|_| candidate)
    } else {
        None
    };
    if let Some(existing) = sqlx::query(
        "SELECT id, thread_id, parent_activation_id FROM thread_signals WHERE event_id = $1",
    )
    .bind(&event.id)
    .fetch_optional(&mut **tx)
    .await?
    {
        let existing_id: String = existing.get("id");
        let existing_thread_id: String = existing.get("thread_id");
        if existing_id != signal_id || existing_thread_id != thread_id {
            return Err(format!(
                "Direct Thread Signal Event '{}' 已路由到不同 Signal/Thread",
                event.id
            )
            .into());
        }
        let existing_parent_activation_id: Option<String> = existing.get("parent_activation_id");
        if let Some(parent_activation_id) = parent_activation_id.as_deref() {
            match existing_parent_activation_id.as_deref() {
                Some(existing) if existing != parent_activation_id => {
                    return Err(format!(
                        "Direct Thread Signal Event '{}' 已绑定不同 parent Activation",
                        event.id
                    )
                    .into());
                }
                None => {
                    sqlx::query(
                        "UPDATE thread_signals SET parent_activation_id = $1 WHERE id = $2 AND parent_activation_id IS NULL",
                    )
                    .bind(parent_activation_id)
                    .bind(&signal_id)
                    .execute(&mut **tx)
                    .await?;
                }
                Some(_) => {}
            }
        }
        return Ok(false);
    }
    if matches!(status.as_str(), "completed" | "failed" | "cancelled") {
        return Err(format!(
            "Direct Thread Signal 不能投递到已终结 Thread '{thread_id}' ({status})"
        )
        .into());
    }
    let sequence: i64 = sqlx::query_scalar("SELECT sequence FROM events WHERE id = $1")
        .bind(&event.id)
        .fetch_one(&mut **tx)
        .await?;
    let thread_generation: i64 = thread.get("generation");
    let principal_id: Option<String> = thread.get("initiating_principal_id");
    let inserted = sqlx::query(
        r#"INSERT INTO thread_signals
           (id, thread_id, thread_generation, event_id, principal_id, sequence, kind,
            parent_activation_id, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
           ON CONFLICT DO NOTHING"#,
    )
    .bind(&signal_id)
    .bind(thread_id)
    .bind(thread_generation)
    .bind(&event.id)
    .bind(&principal_id)
    .bind(sequence)
    .bind(&event.topic)
    .bind(&parent_activation_id)
    .bind(
        event
            .timestamp
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
    )
    .execute(&mut **tx)
    .await?;
    let stored = sqlx::query(
        "SELECT id, thread_id, thread_generation, sequence, kind, parent_activation_id FROM thread_signals WHERE event_id = $1",
    )
    .bind(&event.id)
    .fetch_one(&mut **tx)
    .await?;
    if stored.get::<String, _>("id") != signal_id
        || stored.get::<String, _>("thread_id") != thread_id
        || stored.get::<i64, _>("thread_generation") != thread_generation
        || stored.get::<i64, _>("sequence") != sequence
        || stored.get::<String, _>("kind") != event.topic
        || stored.get::<Option<String>, _>("parent_activation_id") != parent_activation_id
    {
        return Err(format!(
            "Event '{}' 已被不同的 Direct Thread Signal route 占用",
            event.id
        )
        .into());
    }
    sqlx::query(
        r#"UPDATE signal_outbox SET status = 'discarded', signal_id = $1, resolved_at = $2
           WHERE event_id = $3 AND status != 'discarded'"#,
    )
    .bind(&signal_id)
    .bind(now_text())
    .bind(&event.id)
    .execute(&mut **tx)
    .await?;
    Ok(inserted.rows_affected() == 1)
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
        self.append_batch(vec![EventAppend { event }]).await
    }

    async fn append_to_thread(&self, event: Event, thread_id: &str) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        append_event_in_tx(&mut tx, &event).await?;
        append_direct_thread_signal_in_tx(&mut tx, &event, thread_id).await?;
        tx.commit().await?;
        Ok(())
    }

    async fn append_batch(&self, entries: Vec<EventAppend>) -> Result<(), StoreError> {
        if entries.is_empty() {
            return Ok(());
        }
        let mut tx = self.pool.begin().await?;
        for entry in &entries {
            append_event_in_tx(&mut tx, &entry.event).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    async fn query(&self, filter: QueryFilter) -> Result<Vec<Event>, StoreError> {
        let forward_by_sequence = filter.after_sequence.is_some();
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
        if !filter.topics.is_empty() {
            builder.push(" AND topic IN (");
            let mut separated = builder.separated(", ");
            for topic in &filter.topics {
                separated.push_bind(topic);
            }
            builder.push(")");
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
            builder.push(" ORDER BY sequence DESC");
        } else if forward_by_sequence {
            builder.push(" ORDER BY sequence ASC");
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
            r#"SELECT event_id, event_sequence, context_id, key, source_kind, source_id,
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
                    event_sequence: u64::try_from(row.get::<i64, _>("event_sequence"))?,
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

    async fn get_attention_acknowledgement(
        &self,
        context_id: &str,
        key: &str,
    ) -> Result<Option<AttentionAcknowledgementRecord>, StoreError> {
        sqlx::query(
            r#"SELECT event_id, event_sequence, context_id, key, source_kind, source_id,
                      source_revision, acknowledged_by, rationale, acknowledged_at
               FROM attention_acknowledgements
               WHERE context_id = $1 AND key = $2"#,
        )
        .bind(context_id)
        .bind(key)
        .fetch_optional(&self.pool)
        .await?
        .map(|row| {
            Ok(AttentionAcknowledgementRecord {
                event_id: row.get("event_id"),
                event_sequence: u64::try_from(row.get::<i64, _>("event_sequence"))?,
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
        .transpose()
    }

    async fn list_attention_acknowledgements_bounded(
        &self,
        context_id: &str,
        limit: usize,
    ) -> Result<Vec<AttentionAcknowledgementRecord>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            r#"SELECT event_id, event_sequence, context_id, key, source_kind, source_id,
                      source_revision, acknowledged_by, rationale, acknowledged_at
               FROM attention_acknowledgements
               WHERE context_id = $1
               ORDER BY acknowledged_at DESC, event_sequence DESC
               LIMIT $2"#,
        )
        .bind(context_id)
        .bind(i64::try_from(limit)?)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(AttentionAcknowledgementRecord {
                    event_id: row.get("event_id"),
                    event_sequence: u64::try_from(row.get::<i64, _>("event_sequence"))?,
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

    async fn list_attention_acknowledgements_after(
        &self,
        context_id: &str,
        after_event_sequence: u64,
        limit: usize,
    ) -> Result<Vec<AttentionAcknowledgementRecord>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            r#"SELECT event_id, event_sequence, context_id, key, source_kind, source_id,
                      source_revision, acknowledged_by, rationale, acknowledged_at
               FROM attention_acknowledgements
               WHERE context_id = $1 AND event_sequence > $2
               ORDER BY event_sequence, key
               LIMIT $3"#,
        )
        .bind(context_id)
        .bind(i64::try_from(after_event_sequence)?)
        .bind(i64::try_from(limit)?)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(AttentionAcknowledgementRecord {
                    event_id: row.get("event_id"),
                    event_sequence: u64::try_from(row.get::<i64, _>("event_sequence"))?,
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
                    WHERE indexname = 'idx_pg_recall_documents_terms'
                  )"#,
    )
    .fetch_one(pool)
    .await?;
    Ok(RecallIndexCapability {
        mode: if indexed {
            crate::memory::LexicalSearchMode::PostgresGinSegmented
        } else {
            crate::memory::LexicalSearchMode::ExactDocumentOnly
        },
        indexed,
        unicode_normalization: "nfkc+lowercase".to_string(),
        segmenter: crate::memory::RECALL_SEGMENTER.to_string(),
        detail: if indexed {
            "PostgreSQL GIN term-array index over whole Runtime-segmented documents".to_string()
        } else {
            "PostgreSQL Recall index unavailable; exact Recall document id only".to_string()
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
        RecallDocumentKind::Frame => Ok(Some(crate::memory::canonicalize_recall_document(
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
    // Lock the exact generation before materializing it. A plain MVCC
    // `SELECT EXISTS` allowed a newer generation to be enqueued and projected
    // between this check and the document upsert; Frame documents deliberately
    // permit same-recency replacement, so that race could let the older worker
    // become the last writer. The row lock serializes generation replacement
    // with this finish transaction, matching SQLite's Writer boundary.
    let current = sqlx::query_scalar::<_, i64>(
        r#"SELECT 1::BIGINT FROM recall_projection_outbox
           WHERE context_id = $1 AND document_kind = $2 AND document_id = $3
             AND generation = $4 AND status = 'processing' AND claimed_by = $5
           FOR UPDATE"#,
    )
    .bind(&claim.context_id)
    .bind(claim.document_kind.as_str())
    .bind(&claim.document_id)
    .bind(i64::try_from(claim.generation)?)
    .bind(&claim.claim_token)
    .fetch_optional(&mut **tx)
    .await?
    .is_some();
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
        self.query_recall_documents(RecallDocumentSearchRequest {
            context_id: context_id.to_string(),
            normalized_query: Some(normalized_query.to_string()),
            start_time: None,
            end_time: None,
            before_sequence: None,
            limit,
        })
        .await
    }

    async fn query_recall_documents(
        &self,
        request: RecallDocumentSearchRequest,
    ) -> Result<Vec<RecallSearchHit>, StoreError> {
        if request
            .start_time
            .zip(request.end_time)
            .is_some_and(|(start, end)| start >= end)
        {
            return Err("Recall start_time 必须早于 end_time".into());
        }
        let limit = request.limit.clamp(1, 100);
        let candidate_limit = (limit.saturating_mul(8)).clamp(64, 512);
        let capability = postgres_recall_capability(&self.pool).await?;
        // The index stores Runtime-segmented terms, so the query is segmented
        // the same way and matched whole. A quoted query asks for adjacency;
        // ordinary queries use web-search OR syntax to build a broad candidate
        // set, followed by backend-independent coverage ranking.
        let normalized_query = request
            .normalized_query
            .as_deref()
            .map(str::trim)
            .filter(|query| !query.is_empty());
        let (requested, phrase) = normalized_query
            .map(crate::memory::recall_phrase_request)
            .unwrap_or(("", false));
        let terms = crate::memory::segment_recall_terms(requested);
        let mut seen = std::collections::HashSet::new();
        let distinct_terms = terms
            .iter()
            .filter(|term| seen.insert(term.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        let term_keys =
            crate::memory::lexical::recall_term_keys(distinct_terms.iter().map(String::as_str));
        let segmented_query = terms.join(" ");
        let chronological = request.start_time.is_some()
            || request.end_time.is_some()
            || request.before_sequence.is_some()
            || normalized_query.is_none();
        let start_time = request
            .start_time
            .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        let end_time = request
            .end_time
            .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        let rows = if capability.indexed && !terms.is_empty() {
            let mut query = QueryBuilder::<Postgres>::new(
                r#"SELECT d.document_kind, d.document_id, d.revision, d.retired,
                          d.preview, d.searchable_text, "#,
            );
            query.push("d.updated_sequence, e.timestamp, CASE WHEN d.document_id = ");
            query.push_bind(normalized_query.unwrap_or_default());
            query.push(" THEN 1000000.0::double precision ELSE 1.0::double precision END AS score");
            query.push(
                r#" FROM recall_documents d
                   LEFT JOIN events e ON d.document_kind = 'event'
                    AND e.id = d.document_id AND e.context_id = d.context_id
                   WHERE d.context_id = "#,
            );
            query.push_bind(&request.context_id);
            query.push(" AND d.search_term_keys ");
            query.push(if phrase { " @> " } else { " && " });
            query.push_bind(&term_keys);
            if phrase {
                query.push(" AND strpos(' ' || d.searchable_text || ' ', ");
                query.push_bind(format!(" {segmented_query} "));
                query.push(") > 0");
            }
            if let Some(start_time) = &start_time {
                query.push(" AND d.document_kind = 'event' AND e.timestamp >= ");
                query.push_bind(start_time);
            }
            if let Some(end_time) = &end_time {
                query.push(" AND d.document_kind = 'event' AND e.timestamp < ");
                query.push_bind(end_time);
            }
            if let Some(before_sequence) = request.before_sequence {
                query.push(" AND d.updated_sequence < ");
                query.push_bind(i64::try_from(before_sequence)?);
            }
            if chronological {
                query.push(" ORDER BY d.updated_sequence DESC, d.document_id ASC");
            } else {
                query.push(" ORDER BY (d.document_id = ");
                query.push_bind(normalized_query.unwrap_or_default());
                query.push(") DESC, d.updated_sequence DESC, d.document_id ASC");
            }
            query.push(" LIMIT ");
            query.push_bind(i64::try_from(candidate_limit)?);
            query.build().fetch_all(&self.pool).await?
        } else if normalized_query.is_none() {
            let mut query = QueryBuilder::<Postgres>::new(
                r#"SELECT d.document_kind, d.document_id, d.revision, d.retired,
                          d.preview, d.searchable_text, d.updated_sequence, e.timestamp,
                          1.0::double precision AS score
                   FROM recall_documents d
                   JOIN events e ON e.id = d.document_id AND e.context_id = d.context_id
                   WHERE d.context_id = "#,
            );
            query.push_bind(&request.context_id);
            query.push(" AND d.document_kind = 'event'");
            if let Some(start_time) = &start_time {
                query.push(" AND e.timestamp >= ");
                query.push_bind(start_time);
            }
            if let Some(end_time) = &end_time {
                query.push(" AND e.timestamp < ");
                query.push_bind(end_time);
            }
            if let Some(before_sequence) = request.before_sequence {
                query.push(" AND d.updated_sequence < ");
                query.push_bind(i64::try_from(before_sequence)?);
            }
            query.push(" ORDER BY d.updated_sequence DESC, d.document_id ASC LIMIT ");
            query.push_bind(i64::try_from(limit)?);
            query.build().fetch_all(&self.pool).await?
        } else {
            let normalized_query = normalized_query.unwrap_or_default();
            let mut query = QueryBuilder::<Postgres>::new(
                r#"SELECT d.document_kind, d.document_id, d.revision, d.retired, d.preview,
                          d.searchable_text, d.updated_sequence, e.timestamp,
                          CASE WHEN d.document_id = "#,
            );
            query.push_bind(normalized_query);
            query.push(
                r#" THEN 1000000.0 ELSE 1.0::double precision END AS score
                   FROM recall_documents d
                   LEFT JOIN events e ON d.document_kind = 'event'
                    AND e.id = d.document_id AND e.context_id = d.context_id
                   WHERE d.context_id = "#,
            );
            query.push_bind(&request.context_id);
            query.push(" AND d.document_id = ");
            query.push_bind(normalized_query);
            if let Some(start_time) = &start_time {
                query.push(" AND d.document_kind = 'event' AND e.timestamp >= ");
                query.push_bind(start_time);
            }
            if let Some(end_time) = &end_time {
                query.push(" AND d.document_kind = 'event' AND e.timestamp < ");
                query.push_bind(end_time);
            }
            if let Some(before_sequence) = request.before_sequence {
                query.push(" AND d.updated_sequence < ");
                query.push_bind(i64::try_from(before_sequence)?);
            }
            query.push(" ORDER BY d.updated_sequence DESC, d.document_id ASC LIMIT ");
            query.push_bind(i64::try_from(limit)?);
            query.build().fetch_all(&self.pool).await?
        };
        let candidates = rows
            .into_iter()
            .map(|row| {
                let searchable_text = row.get::<String, _>("searchable_text");
                Ok(crate::memory::RecallSearchCandidate {
                    searchable_text: searchable_text.clone(),
                    hit: RecallSearchHit {
                        document_kind: pg_recall_kind(&row.get::<String, _>("document_kind"))?,
                        document_id: row.get("document_id"),
                        revision: u64::try_from(row.get::<i64, _>("revision"))?,
                        retired: row.get("retired"),
                        score: row.get("score"),
                        preview: if terms.is_empty() {
                            row.get("preview")
                        } else {
                            crate::memory::recall_match_preview(
                                &searchable_text,
                                &terms,
                                &row.get::<String, _>("preview"),
                            )
                        },
                        updated_sequence: u64::try_from(row.get::<i64, _>("updated_sequence"))?,
                        occurred_at: row
                            .get::<Option<String>, _>("timestamp")
                            .map(|timestamp| parse_time(&timestamp))
                            .transpose()?,
                    },
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        let mut matches = crate::memory::rank_recall_candidates(
            candidates,
            &terms,
            phrase,
            normalized_query.unwrap_or_default(),
            if chronological {
                candidate_limit
            } else {
                limit
            },
        );
        if chronological {
            matches.sort_by(|left, right| {
                right
                    .updated_sequence
                    .cmp(&left.updated_sequence)
                    .then_with(|| left.document_id.cmp(&right.document_id))
            });
            matches.truncate(limit);
        }
        Ok(matches)
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
        // The rebuild input was assembled before this transaction. Preserve
        // transactional Outbox intents committed after that snapshot so the
        // derived index converges to current Event/Mind state. Reapplying an
        // older intent is safe because document sequence and Outbox generation
        // fencing reject stale overwrites.
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
    initiating_principal_id, stated_objective, revision, generation, status, status_reason, wait_condition_json, completion_intent_json, active_evaluation_id,
    evaluation_lease_expires_at, continuation_sequence, token_budget, tokens_used,
    time_used_seconds, created_at, updated_at
    FROM objectives"#;

pub(super) async fn validate_new_objective(
    store: &PostgresStore,
    objective: &NewObjective,
) -> Result<(String, Option<i64>), StoreError> {
    let stated_objective = validate_stated_objective(&objective.stated_objective)?.to_string();
    let context_agent =
        sqlx::query_scalar::<_, String>("SELECT agent_id FROM cognitive_contexts WHERE id = $1")
            .bind(&objective.context_id)
            .fetch_optional(&store.pool)
            .await?
            .ok_or_else(|| format!("Objective Context '{}' 不存在", objective.context_id))?;
    let coordinator = sqlx::query("SELECT agent_id, context_id FROM sessions WHERE id = $1")
        .bind(&objective.coordinator_session_id)
        .fetch_optional(&store.pool)
        .await?
        .ok_or_else(|| {
            format!(
                "Objective 协调 Session '{}' 不存在",
                objective.coordinator_session_id
            )
        })?;
    let delivery = sqlx::query("SELECT agent_id, context_id FROM sessions WHERE id = $1")
        .bind(&objective.delivery_session_id)
        .fetch_optional(&store.pool)
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
                .fetch_optional(&store.pool)
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
    Ok((
        stated_objective,
        objective.token_budget.map(i64::try_from).transpose()?,
    ))
}

pub(super) async fn insert_new_objective_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    objective: &NewObjective,
    stated_objective: &str,
    token_budget: Option<i64>,
) -> Result<(), StoreError> {
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
    .bind(token_budget)
    .bind(&now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn objective_wait_dependency_generation_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    kind: SchedulerDependencyKind,
    dependency_id: &str,
    fallback_generation: u64,
) -> Result<u64, StoreError> {
    if kind != SchedulerDependencyKind::ThreadGroup {
        return Ok(fallback_generation.max(1));
    }
    let generation =
        sqlx::query_scalar::<_, i64>("SELECT generation FROM thread_groups WHERE id = $1")
            .bind(dependency_id)
            .fetch_optional(&mut **tx)
            .await?
            .unwrap_or(1);
    Ok(u64::try_from(generation)?)
}

async fn insert_objective_wait_dependency_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    objective_id: &str,
    objective_generation: u64,
    wait: &ObjectiveWaitCondition,
    fallback_dependency_generation: u64,
    now: &str,
    source: &str,
) -> Result<(), StoreError> {
    let (kind, dependency_id) = objective_wait_dependency_key(wait);
    let dependency_generation = objective_wait_dependency_generation_in_tx(
        tx,
        kind,
        &dependency_id,
        fallback_dependency_generation,
    )
    .await?;
    let id = stable_scheduler_dependency_id(
        SchedulerDependencyOwnerKind::Objective,
        objective_id,
        objective_generation,
        kind,
        &dependency_id,
        dependency_generation,
    );
    sqlx::query(
        r#"INSERT INTO scheduler_dependencies
           (id, owner_kind, owner_id, owner_generation,
            dependency_kind, dependency_id, dependency_generation,
            required, status, metadata_json, created_at, updated_at)
           VALUES ($1, 'objective', $2, $3, $4, $5, $6,
                   TRUE, 'pending', $7, $8, $8)
           ON CONFLICT(id) DO NOTHING"#,
    )
    .bind(id)
    .bind(objective_id)
    .bind(i64::try_from(objective_generation)?)
    .bind(kind.as_str())
    .bind(dependency_id)
    .bind(i64::try_from(dependency_generation)?)
    .bind(serde_json::json!({"source": source, "wait": wait}))
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn cancel_objective_wait_dependencies_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    objective_id: &str,
    objective_generation: u64,
    now: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        r#"UPDATE scheduler_dependencies
           SET status = 'cancelled', updated_at = $1
           WHERE owner_kind = 'objective' AND owner_id = $2
             AND owner_generation = $3 AND status = 'pending'"#,
    )
    .bind(now)
    .bind(objective_id)
    .bind(i64::try_from(objective_generation)?)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[async_trait::async_trait]
impl ObjectiveStore for PostgresStore {
    async fn create_objective(
        &self,
        objective: NewObjective,
    ) -> Result<ObjectiveRecord, StoreError> {
        let (stated_objective, token_budget) = validate_new_objective(self, &objective).await?;
        let mut tx = self.pool.begin().await?;
        insert_new_objective_in_tx(&mut tx, &objective, &stated_objective, token_budget).await?;
        tx.commit().await?;
        self.get_objective(&objective.id)
            .await?
            .ok_or_else(|| "Objective 创建后无法读取".into())
    }

    async fn create_objective_with_events(
        &self,
        objective: NewObjective,
        events: Vec<Event>,
    ) -> Result<ObjectiveRecord, StoreError> {
        let (stated_objective, token_budget) = validate_new_objective(self, &objective).await?;
        let mut tx = self.pool.begin().await?;
        insert_new_objective_in_tx(&mut tx, &objective, &stated_objective, token_budget).await?;
        for event in &events {
            append_event_in_tx(&mut tx, event).await?;
        }
        tx.commit().await?;
        self.get_objective(&objective.id)
            .await?
            .ok_or_else(|| "Objective 与初始化事件提交后无法读取".into())
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

    async fn list_objectives_by_ids(
        &self,
        context_id: &str,
        objective_ids: &[String],
    ) -> Result<Vec<ObjectiveRecord>, StoreError> {
        let mut records = Vec::new();
        for objective_ids in objective_ids.chunks(500) {
            let mut query = QueryBuilder::<Postgres>::new(OBJECTIVE_SELECT);
            query.push(" WHERE context_id = ").push_bind(context_id);
            query.push(" AND id IN (");
            {
                let mut values = query.separated(", ");
                for objective_id in objective_ids {
                    values.push_bind(objective_id);
                }
            }
            query.push(") ORDER BY updated_at DESC, id");
            records.extend(
                query
                    .build()
                    .fetch_all(&self.pool)
                    .await?
                    .iter()
                    .map(objective_from_row)
                    .collect::<Result<Vec<_>, _>>()?,
            );
        }
        records.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(records)
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
                "{OBJECTIVE_SELECT} WHERE context_id = $1 AND status IN ('active', 'paused', 'blocked') ORDER BY updated_at DESC"
            )
        };
        let rows = sqlx::query(&sql)
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(objective_from_row).collect()
    }

    async fn list_session_objectives(
        &self,
        context_id: &str,
        session_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ObjectiveRecord>, StoreError> {
        let lifecycle = if include_terminal {
            ""
        } else {
            " AND status IN ('active', 'paused', 'blocked')"
        };
        let rows = sqlx::query(&format!(
            "{OBJECTIVE_SELECT} WHERE context_id = $1 AND (coordinator_session_id = $2 OR delivery_session_id = $2){lifecycle} ORDER BY updated_at DESC"
        ))
        .bind(context_id)
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(objective_from_row).collect()
    }

    async fn list_context_objectives_bounded(
        &self,
        context_id: &str,
        include_terminal: bool,
        limit: usize,
    ) -> Result<Vec<ObjectiveRecord>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let predicate = if include_terminal {
            "context_id = $1"
        } else {
            "context_id = $1 AND status IN ('active', 'paused', 'blocked')"
        };
        let rows = sqlx::query(&format!(
            "{OBJECTIVE_SELECT} WHERE {predicate} ORDER BY updated_at DESC, id LIMIT $2"
        ))
        .bind(context_id)
        .bind(i64::try_from(limit)?)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(objective_from_row).collect()
    }

    async fn count_context_objective_readiness(
        &self,
        context_id: &str,
        now: DateTime<Utc>,
    ) -> Result<ObjectiveReadinessCounts, StoreError> {
        let now = now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let row = sqlx::query(
            r#"SELECT
                 COUNT(*) AS live_objectives,
                 COALESCE(SUM(CASE WHEN objective.status = 'active'
                   AND NOT (
                     objective.active_evaluation_id IS NOT NULL
                     AND objective.evaluation_lease_expires_at IS NOT NULL
                     AND objective.evaluation_lease_expires_at > $1
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM scheduler_dependencies dependency
                     WHERE dependency.owner_kind = 'objective'
                       AND dependency.owner_id = objective.id
                       AND dependency.owner_generation = objective.generation
                       AND dependency.required = TRUE
                       AND dependency.status = 'pending'
                   ) THEN 1 ELSE 0 END), 0) AS runnable_objectives,
                 COALESCE(SUM(CASE WHEN objective.status = 'active' AND (
                   (objective.active_evaluation_id IS NOT NULL
                    AND objective.evaluation_lease_expires_at IS NOT NULL
                    AND objective.evaluation_lease_expires_at > $1)
                   OR EXISTS (
                     SELECT 1 FROM scheduler_dependencies dependency
                     WHERE dependency.owner_kind = 'objective'
                       AND dependency.owner_id = objective.id
                       AND dependency.owner_generation = objective.generation
                       AND dependency.required = TRUE
                       AND dependency.status = 'pending'
                   )
                 ) THEN 1 ELSE 0 END), 0) AS waiting_objectives
               FROM objectives objective
               WHERE objective.context_id = $2
                 AND objective.status IN ('active', 'paused', 'blocked')"#,
        )
        .bind(now)
        .bind(context_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(ObjectiveReadinessCounts {
            live_objectives: usize::try_from(row.get::<i64, _>("live_objectives"))?,
            runnable_objectives: usize::try_from(row.get::<i64, _>("runnable_objectives"))?,
            waiting_objectives: usize::try_from(row.get::<i64, _>("waiting_objectives"))?,
        })
    }

    async fn list_recoverable_objectives(&self) -> Result<Vec<ObjectiveRecord>, StoreError> {
        let rows = sqlx::query(&format!(
            "{OBJECTIVE_SELECT} WHERE status IN ('active', 'paused', 'blocked') OR active_evaluation_id IS NOT NULL ORDER BY updated_at"
        ))
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(objective_from_row).collect()
    }

    async fn list_recoverable_objectives_bounded(
        &self,
        limit: usize,
    ) -> Result<Vec<ObjectiveRecord>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(&format!(
            "{OBJECTIVE_SELECT} WHERE status IN ('active', 'paused', 'blocked') OR active_evaluation_id IS NOT NULL ORDER BY updated_at DESC LIMIT $1"
        ))
        .bind(i64::try_from(limit)?)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(objective_from_row).collect()
    }

    async fn list_recoverable_objectives_for_contexts(
        &self,
        context_ids: &[String],
        limit: usize,
    ) -> Result<Vec<ObjectiveRecord>, StoreError> {
        if context_ids.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let mut query: QueryBuilder<'_, Postgres> = QueryBuilder::new(OBJECTIVE_SELECT);
        query.push(
            " WHERE (status IN ('active', 'paused', 'blocked') OR active_evaluation_id IS NOT NULL) AND context_id IN (",
        );
        let mut separated = query.separated(", ");
        for context_id in context_ids {
            separated.push_bind(context_id);
        }
        separated.push_unseparated(") ORDER BY updated_at DESC, id LIMIT ");
        query.push_bind(i64::try_from(limit)?);
        query
            .build()
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(objective_from_row)
            .collect()
    }

    async fn list_recoverable_objectives_page(
        &self,
        after: Option<&ObjectiveRecoveryCursor>,
        limit: usize,
    ) -> Result<Vec<ObjectiveRecord>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut query: QueryBuilder<'_, Postgres> = QueryBuilder::new(OBJECTIVE_SELECT);
        query.push(
            " WHERE (status IN ('active', 'paused', 'blocked') OR active_evaluation_id IS NOT NULL)",
        );
        if let Some(after) = after {
            let created_at = after
                .created_at
                .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
            query
                .push(" AND (created_at > ")
                .push_bind(created_at.clone())
                .push(" OR (created_at = ")
                .push_bind(created_at)
                .push(" AND id > ")
                .push_bind(after.id.clone())
                .push("))");
        }
        query
            .push(" ORDER BY created_at, id LIMIT ")
            .push_bind(i64::try_from(limit)?);
        query
            .build()
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(objective_from_row)
            .collect()
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
               completion_intent_json = NULL,
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

    async fn amend_objective_with_signal(
        &self,
        id: &str,
        expected_revision: u64,
        stated_objective: &str,
        event: &Event,
        thread: &NewThread,
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
        let expected_root =
            crate::memory::objective_primary_execution_root_id(id, current.generation);
        if event.payload.get("context_id").and_then(JsonValue::as_str)
            != Some(current.context_id.as_str())
            || event.payload.get("session_id").and_then(JsonValue::as_str)
                != Some(current.coordinator_session_id.as_str())
            || event
                .payload
                .get("objective_id")
                .and_then(JsonValue::as_str)
                != Some(id)
            || event
                .payload
                .get("objective_generation")
                .and_then(JsonValue::as_u64)
                != Some(current.generation)
            || event
                .payload
                .get("objective_revision")
                .and_then(JsonValue::as_u64)
                != Some(expected_revision.saturating_add(1))
            || event
                .payload
                .get("root_turn_id")
                .and_then(JsonValue::as_str)
                != Some(expected_root.as_str())
            || thread.root_turn_id != expected_root
            || thread.context_id != current.context_id
            || thread.session_id != current.coordinator_session_id
        {
            return Err(format!("Objective '{id}' amendment Event 路由不一致").into());
        }
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            r#"UPDATE objectives SET stated_objective = $1,
               completion_intent_json = NULL,
               revision = revision + 1, updated_at = $2
               WHERE id = $3 AND revision = $4
                 AND status NOT IN ('completed', 'failed', 'cancelled')"#,
        )
        .bind(stated_objective)
        .bind(now_text())
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
        let thread = thread::ensure_thread_in_tx(&mut tx, thread).await?;
        append_event_in_tx(&mut tx, event).await?;
        append_direct_thread_signal_in_tx(&mut tx, event, &thread.id).await?;
        tx.commit().await?;
        Ok(ObjectiveMutation::Updated(
            self.get_objective(id)
                .await?
                .ok_or("Objective amendment + Signal 提交后无法读取")?,
        ))
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
        let wait_condition_json = wait_condition
            .as_ref()
            .map(serde_json::to_value)
            .transpose()?;
        let resume_new_generation =
            current.status != ObjectiveStatus::Active && status == ObjectiveStatus::Active;
        let next_generation = current.generation + u64::from(resume_new_generation);
        let wait_changed = resume_new_generation
            || current.status != status
            || current.wait_condition != wait_condition;
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            r#"UPDATE objectives
               SET status = $1, status_reason = $2, wait_condition_json = $3,
                   completion_intent_json = NULL,
                   generation = generation + $4,
                   revision = revision + 1, updated_at = $5
               WHERE id = $6 AND revision = $7"#,
        )
        .bind(status.as_str())
        .bind(reason)
        .bind(wait_condition_json)
        .bind(if resume_new_generation { 1_i64 } else { 0_i64 })
        .bind(&now)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 1 {
            if wait_changed {
                cancel_objective_wait_dependencies_in_tx(&mut tx, id, current.generation, &now)
                    .await?;
            }
            if wait_changed && status == ObjectiveStatus::Active {
                if let Some(wait) = wait_condition.as_ref() {
                    insert_objective_wait_dependency_in_tx(
                        &mut tx,
                        id,
                        next_generation,
                        wait,
                        expected_revision + 1,
                        &now,
                        "objective_state_transition",
                    )
                    .await?;
                }
            }
            tx.commit().await?;
            return Ok(ObjectiveMutation::Updated(
                self.get_objective(id)
                    .await?
                    .ok_or("Objective 状态更新后无法读取")?,
            ));
        }
        tx.rollback().await?;
        Ok(match self.get_objective(id).await? {
            Some(current) => ObjectiveMutation::Conflict { current },
            None => ObjectiveMutation::NotFound,
        })
    }

    async fn prepare_objective_completion(
        &self,
        id: &str,
        expected_revision: u64,
        evaluation_id: &str,
        activation_id: &str,
        reason: &str,
        evidence_refs: &[String],
    ) -> Result<ObjectiveMutation, StoreError> {
        let evaluation_id = evaluation_id.trim();
        let activation_id = activation_id.trim();
        let reason = reason.trim();
        if evaluation_id.is_empty() || activation_id.is_empty() || reason.is_empty() {
            return Err("Objective 完成意图必须包含 Evaluation、Activation 与原因".into());
        }
        let Some(current) = self.get_objective(id).await? else {
            return Ok(ObjectiveMutation::NotFound);
        };
        let same_intent = current.completion_intent.as_ref().is_some_and(|intent| {
            intent.evaluation_id == evaluation_id
                && intent.activation_id == activation_id
                && intent.reason == reason
                && intent.evidence_refs == evidence_refs
        });
        if same_intent {
            return Ok(ObjectiveMutation::Updated(current));
        }
        if current.revision != expected_revision
            || current.status != ObjectiveStatus::Active
            || current.wait_condition.is_some()
            || current.active_evaluation_id.as_deref() != Some(evaluation_id)
            || current.completion_intent.is_some()
        {
            return Ok(ObjectiveMutation::Conflict { current });
        }
        let intent = ObjectiveCompletionIntent {
            evaluation_id: evaluation_id.to_string(),
            activation_id: activation_id.to_string(),
            reason: reason.to_string(),
            evidence_refs: evidence_refs.to_vec(),
            requested_at: Utc::now(),
        };
        let result = sqlx::query(
            r#"UPDATE objectives
               SET completion_intent_json = $1, revision = revision + 1, updated_at = $2
               WHERE id = $3 AND revision = $4 AND status = 'active'
                 AND wait_condition_json IS NULL AND completion_intent_json IS NULL
                 AND active_evaluation_id = $5"#,
        )
        .bind(serde_json::to_value(&intent)?)
        .bind(
            intent
                .requested_at
                .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
        )
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .bind(evaluation_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ObjectiveMutation::Updated(
                self.get_objective(id)
                    .await?
                    .ok_or("Objective 完成意图提交后无法读取")?,
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
            || current.completion_intent.is_some()
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
                 AND NOT EXISTS (
                   SELECT 1 FROM scheduler_dependencies dependency
                   WHERE dependency.owner_kind = 'objective'
                     AND dependency.owner_id = objectives.id
                     AND dependency.owner_generation = objectives.generation
                     AND dependency.required = TRUE AND dependency.status = 'pending'
                 )
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

    async fn claim_objective_interrupt_evaluation(
        &self,
        id: &str,
        expected_revision: u64,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
        pending_dependency_id: &str,
    ) -> Result<ObjectiveMutation, StoreError> {
        if evaluation_id.trim().is_empty() || pending_dependency_id.trim().is_empty() {
            return Err("Objective interrupt claim 必须包含 Evaluation 与 dependency ID".into());
        }
        let Some(current) = self.get_objective(id).await? else {
            return Ok(ObjectiveMutation::NotFound);
        };
        if current.revision != expected_revision
            || current.status != ObjectiveStatus::Active
            || current.completion_intent.is_some()
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
                 AND EXISTS (
                   SELECT 1 FROM scheduler_dependencies dependency
                   WHERE dependency.id = $6
                     AND dependency.owner_kind = 'objective'
                     AND dependency.owner_id = objectives.id
                     AND dependency.owner_generation = $7
                     AND dependency.required = TRUE AND dependency.status = 'pending'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM scheduler_dependencies dependency
                   WHERE dependency.owner_kind = 'objective'
                     AND dependency.owner_id = objectives.id
                     AND dependency.owner_generation = $7
                     AND dependency.required = TRUE AND dependency.status = 'pending'
                     AND dependency.id <> $6
                 )
                 AND (active_evaluation_id IS NULL OR evaluation_lease_expires_at <= $3)"#,
        )
        .bind(evaluation_id)
        .bind(lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .bind(&now)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .bind(pending_dependency_id)
        .bind(i64::try_from(current.generation)?)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ObjectiveMutation::Updated(
                self.get_objective(id)
                    .await?
                    .ok_or("Objective interrupt Evaluation 租约提交后无法读取")?,
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
        thread: &NewThread,
    ) -> Result<ObjectiveMutation, StoreError> {
        if evaluation_id.trim().is_empty() {
            return Err("Objective Evaluation ID 不能为空".into());
        }
        let Some(current) = self.get_objective(id).await? else {
            return Ok(ObjectiveMutation::NotFound);
        };
        if current.revision != expected_revision
            || current.status != ObjectiveStatus::Active
            || current.completion_intent.is_some()
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
        let event_root_turn_id = event
            .payload
            .get("root_turn_id")
            .and_then(JsonValue::as_str);
        if event_context_id != Some(current.context_id.as_str())
            || event_session_id != Some(current.coordinator_session_id.as_str())
            || event_objective_id != Some(id)
            || event_evaluation_id != Some(evaluation_id)
            || event_root_turn_id != Some(thread.root_turn_id.as_str())
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
                 AND NOT EXISTS (
                   SELECT 1 FROM scheduler_dependencies dependency
                   WHERE dependency.owner_kind = 'objective'
                     AND dependency.owner_id = objectives.id
                     AND dependency.owner_generation = objectives.generation
                     AND dependency.required = TRUE AND dependency.status = 'pending'
                 )
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
        let thread = thread::ensure_thread_in_tx(&mut tx, thread).await?;
        append_event_in_tx(&mut tx, event).await?;
        append_direct_thread_signal_in_tx(&mut tx, event, &thread.id).await?;
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

    async fn renew_objective_interrupt_evaluation(
        &self,
        id: &str,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
        pending_dependency_id: &str,
    ) -> Result<ObjectiveMutation, StoreError> {
        if evaluation_id.trim().is_empty() || pending_dependency_id.trim().is_empty() {
            return Err("Objective interrupt renew 必须包含 Evaluation 与 dependency ID".into());
        }
        if lease_expires_at <= Utc::now() {
            return Err("Objective Evaluation 续租时间必须在未来".into());
        }
        let Some(current) = self.get_objective(id).await? else {
            return Ok(ObjectiveMutation::NotFound);
        };
        let result = sqlx::query(
            r#"UPDATE objectives
               SET evaluation_lease_expires_at = $1, updated_at = $2
               WHERE id = $3 AND status = 'active' AND active_evaluation_id = $4
                 AND EXISTS (
                   SELECT 1 FROM scheduler_dependencies dependency
                   WHERE dependency.id = $5
                     AND dependency.owner_kind = 'objective'
                     AND dependency.owner_id = objectives.id
                     AND dependency.owner_generation = $6
                     AND dependency.required = TRUE AND dependency.status = 'pending'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM scheduler_dependencies dependency
                   WHERE dependency.owner_kind = 'objective'
                     AND dependency.owner_id = objectives.id
                     AND dependency.owner_generation = $6
                     AND dependency.required = TRUE AND dependency.status = 'pending'
                     AND dependency.id <> $5
                 )"#,
        )
        .bind(lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .bind(now_text())
        .bind(id)
        .bind(evaluation_id)
        .bind(pending_dependency_id)
        .bind(i64::try_from(current.generation)?)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ObjectiveMutation::Updated(
                self.get_objective(id)
                    .await?
                    .ok_or("Objective interrupt Evaluation 续租后无法读取")?,
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
                   completion_intent_json = NULL,
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
            r#"SELECT projection.event_sequence AS sequence, e.id, e.timestamp,
                      e.actor, e.type, e.topic, e.payload
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
        builder.push(") ORDER BY projection.event_sequence ASC");
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

    async fn read_context_encoding_projection_snapshot(
        &self,
        context_id: &str,
        session_ids: &[String],
        include_context_wide: bool,
    ) -> Result<ContextEncodingProjectionSnapshot, StoreError> {
        let mut builder = QueryBuilder::<Postgres>::new(
            r#"SELECT snapshot.row_kind, snapshot.event_sequence,
                      snapshot.event_id, snapshot.event_timestamp,
                      snapshot.event_actor, snapshot.event_type,
                      snapshot.event_topic, snapshot.event_payload,
                      snapshot.mind_context_id, snapshot.mind_revision,
                      snapshot.mind_state_json, snapshot.mind_state_hash,
                      snapshot.mind_head_event_id, snapshot.mind_updated_at
               FROM (
                 SELECT 0 AS sort_key, 'mind'::TEXT AS row_kind,
                        NULL::BIGINT AS event_sequence,
                        NULL::TEXT AS event_id, NULL::TEXT AS event_timestamp,
                        NULL::TEXT AS event_actor, NULL::TEXT AS event_type,
                        NULL::TEXT AS event_topic, NULL::JSONB AS event_payload,
                        projection.context_id AS mind_context_id,
                        projection.revision AS mind_revision,
                        projection.state_json AS mind_state_json,
                        projection.state_hash AS mind_state_hash,
                        head.head_event_id AS mind_head_event_id,
                        projection.updated_at AS mind_updated_at
                 FROM mind_projections projection
                 JOIN context_heads head ON head.context_id = projection.context_id
                 WHERE projection.context_id = "#,
        );
        builder.push_bind(context_id);
        builder.push(
            r#" AND projection.revision = head.revision
                   AND projection.state_hash = head.projection_hash
                 UNION ALL
                 SELECT 1 AS sort_key, 'event'::TEXT AS row_kind,
                        e.sequence AS event_sequence, e.id AS event_id,
                        e.timestamp AS event_timestamp, e.actor AS event_actor,
                        e.type AS event_type, e.topic AS event_topic,
                        e.payload AS event_payload,
                        NULL::TEXT AS mind_context_id,
                        NULL::BIGINT AS mind_revision,
                        NULL::JSONB AS mind_state_json,
                        NULL::TEXT AS mind_state_hash,
                        NULL::TEXT AS mind_head_event_id,
                        NULL::TEXT AS mind_updated_at
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
        builder.push(") ) snapshot ORDER BY snapshot.sort_key, snapshot.event_sequence ASC");
        let rows = builder.build().fetch_all(&self.pool).await?;
        let mut mind = None;
        let mut events = Vec::with_capacity(rows.len().saturating_sub(1));
        for row in rows {
            match row.get::<String, _>("row_kind").as_str() {
                "mind" => {
                    mind = Some(MindProjectionRecord {
                        context_id: row
                            .get::<Option<String>, _>("mind_context_id")
                            .ok_or("Mind Projection snapshot 缺少 context_id")?,
                        revision: u64::try_from(
                            row.get::<Option<i64>, _>("mind_revision")
                                .ok_or("Mind Projection snapshot 缺少 revision")?,
                        )?,
                        state: row
                            .get::<Option<JsonValue>, _>("mind_state_json")
                            .ok_or("Mind Projection snapshot 缺少 state_json")?,
                        state_hash: row
                            .get::<Option<String>, _>("mind_state_hash")
                            .ok_or("Mind Projection snapshot 缺少 state_hash")?,
                        head_event_id: row.get("mind_head_event_id"),
                        updated_at: parse_time(
                            &row.get::<Option<String>, _>("mind_updated_at")
                                .ok_or("Mind Projection snapshot 缺少 updated_at")?,
                        )?,
                    });
                }
                "event" => events.push(Event {
                    id: row
                        .get::<Option<String>, _>("event_id")
                        .ok_or("Context Encoding snapshot Event 缺少 id")?,
                    sequence: Some(u64::try_from(
                        row.get::<Option<i64>, _>("event_sequence")
                            .ok_or("Context Encoding snapshot Event 缺少 sequence")?,
                    )?),
                    timestamp: parse_time(
                        &row.get::<Option<String>, _>("event_timestamp")
                            .ok_or("Context Encoding snapshot Event 缺少 timestamp")?,
                    )?,
                    actor: row
                        .get::<Option<String>, _>("event_actor")
                        .ok_or("Context Encoding snapshot Event 缺少 actor")?,
                    event_type: row
                        .get::<Option<String>, _>("event_type")
                        .ok_or("Context Encoding snapshot Event 缺少 type")?,
                    topic: row
                        .get::<Option<String>, _>("event_topic")
                        .ok_or("Context Encoding snapshot Event 缺少 topic")?,
                    payload: serde_json::from_value(
                        row.get::<Option<JsonValue>, _>("event_payload")
                            .ok_or("Context Encoding snapshot Event 缺少 payload")?,
                    )?,
                }),
                other => {
                    return Err(format!("未知 Context Encoding snapshot row kind '{other}'").into())
                }
            }
        }
        Ok(ContextEncodingProjectionSnapshot { mind, events })
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

    async fn list_mind_projection_heads(
        &self,
        context_ids: &[String],
    ) -> Result<Vec<MindProjectionHead>, StoreError> {
        if context_ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            r#"SELECT p.context_id, p.revision, p.updated_at
               FROM mind_projections p
               JOIN context_heads h ON h.context_id = p.context_id
                 AND h.revision = p.revision
                 AND h.projection_hash = p.state_hash
               WHERE p.context_id = ANY($1)
               ORDER BY p.updated_at DESC, p.context_id"#,
        )
        .bind(context_ids)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| {
                Ok(MindProjectionHead {
                    context_id: row.get("context_id"),
                    revision: u64::try_from(row.get::<i64, _>("revision"))?,
                    updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
                })
            })
            .collect()
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
